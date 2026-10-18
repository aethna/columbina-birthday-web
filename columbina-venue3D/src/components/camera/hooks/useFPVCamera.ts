import { useEffect, useRef, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Bone, Group, Vector3, Quaternion, Euler, MathUtils, Object3D } from 'three';
import { useControls } from 'leva';
import { useGameStore } from '../../../core/store/gameStore';

interface UseFPVCameraOptions {
  characterRef: React.MutableRefObject<Group | null> | null;
  boneName: string;
  enabled: boolean;
  /**
   * 按住 ALT 期间为 true（用户 m05698）：停掉鼠标/触摸驱动的扭头。
   *
   * ⚠️ 只该冻结**输入**，不能把它并进 `enabled` —— FPV 下相机是每一帧
   * `camera.position.copy(头骨世界坐标)` 贴上去的，`enabled=false` 会让相机
   * 变成无头苍蝇停在原地。所以这里只门控两个输入回调。
   */
  freezeLook: boolean;
}

export function useFPVCamera({
  characterRef,
  boneName,
  enabled,
  freezeLook,
}: UseFPVCameraOptions) {
  const { camera } = useThree();
  const isMobile = useGameStore((state) => state.isMobile);

  const targetBone = useRef<Bone | undefined>(undefined);
  
  const pcTargetRotation = useRef({ x: 0, y: 0 });
  
  const mobileRotation = useRef({ x: 0, y: 0 });
  
  const currentRotation = useRef({ x: 0, y: 0 });
  
  const lastTouchRef = useRef<{ x: number, y: number } | null>(null);

  /** 探针用的计数器：进了多少个 mousemove / 其中多少个真正写了目标角。 */
  const moveCount = useRef(0);
  const wroteCount = useRef(0);

  const { vec3, quat, quatOffset, quatBone, quatLookForward, modelCorrectionQuat, dummyEuler, mouseQuat, offsetVec } = useMemo(() => ({
    vec3: new Vector3(),
    quat: new Quaternion(),
    quatOffset: new Quaternion(),
    quatBone: new Quaternion(),
    quatLookForward: new Quaternion(),
    modelCorrectionQuat: new Quaternion().setFromEuler(new Euler(0, Math.PI, 0, 'YXZ')),
    dummyEuler: new Euler(),
    mouseQuat: new Quaternion(),
    offsetVec: new Vector3(), // Reuse for camera offset
  }), []);

  const config = useControls('FPV Settings', {
    rotateX: { value: -90, min: -180, max: 180, step: 1 },
    rotateY: { value: -90, min: -180, max: 180, step: 1 },
    rotateZ: { value: 0, min: -180, max: 180, step: 1 },
    offsetX: { value: 0, min: -2, max: 2, step: 0.01 },
    offsetY: { value: 0.5, min: -2, max: 2, step: 0.01 },
    offsetZ: { value: -0.2, min: -2, max: 2, step: 0.01 },
    headBodySmoothing: { value: 0.97, min: 0, max: 1, step: 0.01 },
    mouseRotationSmoothing: { value: 0.1, min: 0.01, max: 1, step: 0.01 },
    touchSensitivity: { value: 0.005, min: 0.001, max: 0.02, step: 0.001 },
  }, { collapsed: true });

  /**
   * 无头验收探针：把这条链路的**中间量**全暴露出来。
   *
   * 为什么必须看中间量：FPV 的扭头上游到下游有四站 ——
   *   ① window 的 mousemove 有没有收到          → `moves`
   *   ② 收到后有没有写目标角（`freezeLook` 门控）→ `targetDeg`
   *   ③ `useFrame` 里的 lerp 有没有把当前角追上去 → `currentDeg`
   *   ④ 当前角有没有真的写进相机四元数（有没有被 `camera-controls` 的
   *      每帧 `update()` 覆盖成 `lookAt`）        → 与 `window.__cam.pose()` 对照
   * 只看「相机转没转」这一条，四站里任何一站断了都是同一个现象，
   * 分不清是「没收到事件」还是「写了被覆盖」，就会去改错的地方。
   */
  useEffect(() => {
    const w = window as unknown as { __fpv?: unknown };
    w.__fpv = {
      moves: () => moveCount.current,
      wrote: () => wroteCount.current,
      frames: () => useFrameCount.current,
      targetDeg: () => ({
        x: +MathUtils.radToDeg(pcTargetRotation.current.x).toFixed(3),
        y: +MathUtils.radToDeg(pcTargetRotation.current.y).toFixed(3),
      }),
      currentDeg: () => ({
        x: +MathUtils.radToDeg(currentRotation.current.x).toFixed(3),
        y: +MathUtils.radToDeg(currentRotation.current.y).toFixed(3),
      }),
      /** 监听此刻到底挂没挂（`enabled && !isMobile`）。 */
      attached: () => enabled && !isMobile,
      boneFound: () => !!targetBone.current,
    };
    return () => { delete w.__fpv; };
  }, [enabled, isMobile]);

  useEffect(() => {
    if (!enabled || isMobile) return;

    const onMouseMove = (e: MouseEvent) => {
      moveCount.current++;
      // 光标自由期间不更新目标角。注意这里是「不写目标」而不是「清目标」：
      // `useFrame` 里的 lerp 会自然停在最后一次写入的角度上，松手后不会突然甩头。
      if (freezeLook) return;

      const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
      const ndcY = (e.clientY / window.innerHeight) * 2 - 1;

      pcTargetRotation.current.x = MathUtils.degToRad(MathUtils.mapLinear(ndcX, -1, 1, 150, -150));
      pcTargetRotation.current.y = MathUtils.degToRad(MathUtils.mapLinear(ndcY, -1, 1, 90, -30));
      wroteCount.current++;
    };

    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, [enabled, isMobile, freezeLook]);

  // 触摸那一路不挂 `freezeLook`：ALT 是物理键盘上的键，手机上没有它，
  // 加了也只是永远为 false 的死分支。
  useEffect(() => {
    if (!enabled || !isMobile) return;

    const isValidTouchArea = (t: Touch) => {
      const isJoystickArea = (t.clientX < window.innerWidth * 0.4) && (t.clientY > window.innerHeight * 0.4);
      const isSideBarArea = (t.clientX > window.innerWidth * 0.85) && (t.clientY < window.innerHeight * 0.2);
      return !isJoystickArea && !isSideBarArea;
    };

    const onTouchStart = (e: TouchEvent) => {
      for (let i = 0; i < e.touches.length; i++) {
        const t = e.touches[i];
        if (isValidTouchArea(t)) {
          lastTouchRef.current = { x: t.clientX, y: t.clientY };
          break;
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();

      let activeTouch: Touch | null = null;
      
      for (let i = 0; i < e.touches.length; i++) {
        const t = e.touches[i];
        if (isValidTouchArea(t)) {
          activeTouch = t;
          break;
        }
      }

      if (activeTouch && lastTouchRef.current) {
        const deltaX = activeTouch.clientX - lastTouchRef.current.x;
        const deltaY = activeTouch.clientY - lastTouchRef.current.y;

        mobileRotation.current.x -= deltaX * config.touchSensitivity;
        mobileRotation.current.y -= deltaY * config.touchSensitivity;

        mobileRotation.current.y = MathUtils.clamp(mobileRotation.current.y, -Math.PI / 3, Math.PI / 3);

        lastTouchRef.current = { x: activeTouch.clientX, y: activeTouch.clientY };
      }
    };

    const onTouchEnd = () => {
      lastTouchRef.current = null;
    };

    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [enabled, isMobile, config.touchSensitivity]);

  const useFrameCount = useRef(0);

  const boneNameCandidates = useMemo(
    () => Array.from(new Set([boneName, '頭', '首', 'head', 'Head'])),
    [boneName],
  );

  useFrame((_state, delta) => {
    useFrameCount.current++;
    if (!enabled || !characterRef?.current) return;

    if (!targetBone.current || !isBoneAttached(targetBone.current, characterRef.current)) {
      targetBone.current = findHeadBone(characterRef.current, boneNameCandidates);
    }

    if (targetBone.current) {
      characterRef.current.updateMatrixWorld(true);

      targetBone.current.getWorldPosition(vec3);
      targetBone.current.getWorldQuaternion(quatBone);

      characterRef.current.getWorldQuaternion(quatLookForward);
      quatLookForward.multiply(modelCorrectionQuat);

      dummyEuler.set(
        MathUtils.degToRad(config.rotateX),
        MathUtils.degToRad(config.rotateY),
        MathUtils.degToRad(config.rotateZ),
        'YXZ'
      );
      quatOffset.setFromEuler(dummyEuler);
      quatBone.multiply(quatOffset);
      
      /* `headBodySmoothing` 默认 0.97 ⇒ 这里其实是「97% 用身体朝向、3% 用头部朝向」。
       * 数值本身是刻意的（头部抖动几乎被压掉），只是名字容易被读成「头部权重」。
       * 它每帧都是从同一个 bone 四元数重新插值，**不累积**，因此与帧率无关，保持原样。 */
      quat.copy(quatBone).slerp(quatLookForward, config.headBodySmoothing);

      if (isMobile) {
        currentRotation.current.x = mobileRotation.current.x;
        currentRotation.current.y = mobileRotation.current.y;
      } else {
        /* 帧率无关的平滑。原写法 `lerp(target, current, smoothing)` 在数值上等于
         * 「每帧把 current 拉到离 target 90%」（smoothing=0.1），方向没错，但**没有 dt**：
         * 144 Hz 下的收敛速度是 60 Hz 的 2.4 倍，低帧率时又会显得发飘 —— 同一套
         * 手感参数在不同机器上表现不同。这里把「每帧保留比例」换成
         * `smoothing^(dt*60)`：60 Hz（dt=1/60）时 keep = 0.1，**与旧行为逐值相等**，
         * 其它帧率自动补偿。dt 再夹到 0.1 s，避免切标签页回来后一次跳到目标。 */
        const dt = Math.min(delta, 0.1);
        const keep = Math.pow(config.mouseRotationSmoothing, dt * 60);
        currentRotation.current.x = MathUtils.lerp(
          pcTargetRotation.current.x,
          currentRotation.current.x,
          keep
        );
        currentRotation.current.y = MathUtils.lerp(
          pcTargetRotation.current.y,
          currentRotation.current.y,
          keep
        );
      }

      dummyEuler.set(currentRotation.current.y, currentRotation.current.x, 0, 'YXZ');
      mouseQuat.setFromEuler(dummyEuler);
      quat.multiply(mouseQuat);

      // Reuse offsetVec instead of creating new Vector3
      offsetVec.set(config.offsetX, config.offsetY, config.offsetZ);
      offsetVec.applyQuaternion(quat);
      vec3.add(offsetVec);

      camera.position.copy(vec3);
      camera.quaternion.copy(quat);

      camera.updateMatrixWorld(true)
    }
  });
}

function isBoneAttached(bone: Object3D, characterRoot: Object3D): boolean {
  let ancestor: Object3D | null = bone.parent;
  while (ancestor) {
    if (ancestor === characterRoot) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

function findBone(character: Group, name: string): Bone | undefined {
  const found = character.getObjectByName(name);
  if (found && found instanceof Bone) {
    return found;
  }
  return undefined;
}

/**
 * 按**候选名列表**找头骨，返回第一个命中的。
 *
 * ⚠️ 为什么必须给候选而不是单个名字：本项目的角色是 MMD PMX 模型，
 *    骨骼名是**日文**（`頭` / `首`），而 drei/R3F 生态里的通用写法是
 *    `'head'`。`CameraViewControl` 的缺省值长期是 `'head'`，
 *    `getObjectByName` 找不到就返回 `undefined`，而 `useFrame` 里那段
 *    相机跟随被 `if (targetBone.current)` 整个罩住 —— **不报错、不打印，
 *    相机只是静静地停在初始位**，看起来像「FPV 坏了」而不是「骨名写错了」。
 *
 * 优先 `頭`：PMX 里 `首` 是**脖子**下段，`頭` 才是头。二者都存在，
 * 用错的那个会让相机挂在脖子上、且随脖子骨骼的微小旋转晃动。
 */
function findHeadBone(character: Group, candidates: string[]): Bone | undefined {
  for (const n of candidates) {
    const b = findBone(character, n);
    if (b) return b;
  }
  return undefined;
}
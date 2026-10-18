import { useGameStore, CameraMode, selectFreezeLook } from '../../core/store/gameStore';
import { CameraControls } from '@react-three/drei';
import { useFPVCamera } from './hooks/useFPVCamera';
import { useFollowCamera } from './hooks/useFollowCamera';
import { useCallback, useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';

type Props = {
  boneName?: string;
};

export const CAMERA_POSITION = new THREE.Vector3(-4, 2, -0.5);
export const CAMERA_LOOKAT = new THREE.Vector3(0, 1, 0);

export function CameraViewControl({ boneName = '頭' }: Props) {
  const cameraMode = useGameStore((state) => state.cameraMode);
  const characterRef = useGameStore((state) => state.characterRef);
  const isGameLoaded = useGameStore((state) => state.isGameStarted);
  const isControlEnabled = useGameStore((state) => state.isControlEnabled);
  const setControlEnabled = useGameStore((state) => state.setControlEnabled);
  // ★ 视角冻结 = 「按住 ALT」（用户 m05698，临时想点界面）**或**「互动界面占着鼠标」
  //   （用户 m00002）。两者做的是同一件事，所以合成一个值，三个入口一起吃：
  //   FPV 鼠标扭头 / Follow 拖拽旋转 / Detached 的 CameraControls 拖拽。
  //   合成规则与理由见 `core/store/gameStore.ts` 的 `selectFreezeLook`。
  const freezeLook = useGameStore(selectFreezeLook);

  const controlsRef = useRef<CameraControls>(null);

  useFPVCamera({
    characterRef,
    boneName,
    enabled: cameraMode === CameraMode.FPV && isControlEnabled,
    freezeLook,
  });

  useFollowCamera({
    characterRef,
    controlsRef,
    enabled: cameraMode === CameraMode.Follow && isControlEnabled,
    freezeLook,
  });

  const resetCamera = useCallback((earlyStop: boolean = true) => {
    if (!characterRef?.current || !controlsRef.current) return Promise.resolve();

    const charPos = characterRef.current.position;
    const pos = charPos.clone().add(CAMERA_POSITION);
    const lookAt = charPos.clone().add(CAMERA_LOOKAT);

    const originalThreshold = controlsRef.current.restThreshold;
    controlsRef.current.restThreshold = earlyStop ? 0.05 : originalThreshold;

    return controlsRef.current.setLookAt(
      pos.x, pos.y, pos.z,
      lookAt.x, lookAt.y, lookAt.z,
      true
    ).then(() => {
      if (controlsRef.current) {
        controlsRef.current.restThreshold = originalThreshold;
      }
    });
  }, [characterRef]);

  // initial sequence, reset camera to back
  useEffect(() => {
    if (isGameLoaded && !isControlEnabled) {
      document.body.style.cursor = 'wait';

      let isMounted = true;

      resetCamera(true).then(() => {
        if (isMounted) {
          setControlEnabled(true);
          document.body.style.cursor = 'default';
        }
      });

      return () => {
        isMounted = false;
        document.body.style.cursor = 'default';
      };
    }
  }, [isGameLoaded, isControlEnabled, resetCamera, setControlEnabled]);

  useEffect(() => {
    if (isControlEnabled && cameraMode !== CameraMode.FPV) {
      resetCamera(false);
    }
  }, [cameraMode, isControlEnabled, resetCamera]);

  /**
   * 无头验收探针：读**相机自身**的位置/朝向与指针锁状态。
   *
   * 为什么不能靠 `read_image` 看截图判断「视角有没有被冻结」：
   * ALT 冻的是**输入**，画面在两种情况下几乎一模一样 —— 尤其静止时，
   * 相机本来就不动。唯一能分辨的是「合成一堆 mousemove 之后相机有没有转」，
   * 那就必须把相机的数值读出来，而且要在 motion 之前/之后各读一次做差。
   *
   * 读的是真实相机（`useThree().camera`），不是 `controlsRef` 的自报值 ——
   * 自报值在 `enabled=false` 时依然会变，证明不了什么。
   */
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const w = window as unknown as { __cam?: unknown };
    w.__cam = {
      /** 相机世界坐标 + 欧拉角（度），以及指针是否被锁。 */
      pose: () => {
        const p = camera.position;
        const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
        const st = useGameStore.getState();
        return {
          x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4),
          pitch: +THREE.MathUtils.radToDeg(e.x).toFixed(3),
          yaw: +THREE.MathUtils.radToDeg(e.y).toFixed(3),
          locked: document.pointerLockElement !== null,
          mode: cameraMode,
          ctrl: isControlEnabled,
          // ★ 合成值（ALT ∨ 互动占用），不是裸的 `isCursorFree` —— 验收脚本要能
          //   一眼看出「冻结到底生效了没有」，不该再自己 OR 一遍。
          freeze: selectFreezeLook(st),
          // ⚠️ FPV 的**鼠标**扭头在设备被判成移动端时整条不挂（走触摸那一路）。
          //    无头浏览器里 `matchMedia('(pointer: coarse)')` 可能为真，那样
          //    「FPV 不转」是**探针不可达**而不是代码 bug —— 必须把这个值带出来分辨。
          mobile: st.isMobile,
        };
      },
      /**
       * 合成一次鼠标移动。一次性派发在 `document.body` 上、`bubbles:true` ——
       * 事件会依次冒泡到 document（`useFollowCamera` 的旋转监听）再冒到 window
       * （`useFPVCamera` 的扭头监听），一趟把两条路都喂到，且只喂一次。
       *
       * ⚠️ `movementX/Y` 在 MouseEvent 上只读，构造参数里给了也无效，
       *    只能用 `defineProperty` 覆盖实例属性。
       * ⚠️ FPV 那条路读的是**绝对坐标** `clientX/Y`（不是 movement），所以调用方
       *    必须让它逐次变化，喂同一个坐标等于只写了一次目标角。
       */
      nudge: (dx: number, dy: number, cx = 900, cy = 200) => {
        const ev = new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, clientX: cx, clientY: cy,
        });
        Object.defineProperty(ev, 'movementX', { value: dx });
        Object.defineProperty(ev, 'movementY', { value: dy });
        document.body.dispatchEvent(ev);
        return true;
      },
      /**
       * 合成一次真正的**指针拖拽**。
       *
       * 为什么 `nudge` 不够：Detached 模式的拖拽由 `camera-controls` 自己处理，
       * 它挂的是 `pointerdown`(canvas) / `pointermove`(document) / `pointerup`(document)
       * —— 而且是**独立于 `mousemove` 的另一套事件**。`nudge` 只发 mousemove，
       * 那边一个字节都收不到，于是「拖不动」会被误读成「冻结生效了」。
       *
       * 顺序也不能省：`onPointerDown` 会往 `_activePointers` 里推一个指针，
       * `onPointerMove` 要按 `pointerId` 去里面找；没有 down 就直接 move，
       * `_findPointerById` 返回 undefined，事件被静默丢弃。
       */
      drag: (dx: number, dy: number, steps = 8) => {
        const canvas = gl.domElement;
        const base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0 };
        const mk = (type: string, buttons: number, cx: number, cy: number) => {
          const ev = new PointerEvent(type, { ...base, buttons, clientX: cx, clientY: cy });
          return ev;
        };
        canvas.dispatchEvent(mk('pointerdown', 1, 500, 300));
        for (let i = 1; i <= steps; i++) {
          const ev = mk('pointermove', 1, 500 + i * 12, 300);
          Object.defineProperty(ev, 'movementX', { value: dx / steps });
          Object.defineProperty(ev, 'movementY', { value: dy / steps });
          document.dispatchEvent(ev);
        }
        document.dispatchEvent(mk('pointerup', 0, 500 + steps * 12, 300));
        return true;
      },
    };
    return () => { delete w.__cam; };
  }, [camera, gl, cameraMode, isControlEnabled]);

  return (
    <CameraControls
      ref={controlsRef}
      makeDefault
      enabled={cameraMode !== CameraMode.FPV && isControlEnabled && !freezeLook}
      minDistance={2}
      maxDistance={20}
      maxPolarAngle={Math.PI / 2}
      smoothTime={isControlEnabled ? 0.1 : 1}
    />
  );
}

// src/ui/components/hooks/useFollowCamera.ts
import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { CameraControls } from '@react-three/drei';
import { Group } from 'three';
import { CAMERA_POSITION, CAMERA_LOOKAT } from '../CameraViewControl';
import { useGameStore, CameraMode, selectFreezeLook } from '../../../core/store/gameStore';
import { useGameStore2 } from '../../../core/game/questStore';

interface UseFollowCameraProps {
  characterRef: React.MutableRefObject<Group | null> | null;
  controlsRef: React.MutableRefObject<CameraControls | null>; 
  enabled: boolean;
  /**
   * 按住 ALT 期间为 true（用户 m05698）：解指针锁、停拖拽旋转。
   *
   * ⚠️ 只该冻结**输入**，不该冻结 `useFrame` 的跟随 —— 否则按着 ALT 走动时
   * 镜头会脱离角色、站在原地被落下。所以这个标志不进 `enabled`，
   * 而是单独门控 `onMove` 与指针锁那一段。
   */
  freezeLook: boolean;
}

/* ==================================================================
 * ★ 2026-10-18 用户任务4：关闭相册 / 收起合影后，把指针**在同一次用户手势里**要回来
 * ==================================================================
 *
 * ── 为什么不能只靠 `useFollowCamera` 里那个 effect ─────────────────────
 * 那条 effect 挂在 `freezeLook` 的**变化**上，而 `freezeLook` 来自 zustand：
 *   点击 ✕ / 按 F、Esc  ⇒  `closeAlbum()` / `closePhoto()`  ⇒  React 重渲染
 *   ⇒  `PointerHold` 的 effect cleanup 才 `releasePointer()`  ⇒  再下一次渲染
 *   ⇒  `useFollowCamera` 的 effect 才跑 `requestPointerLock()`。
 * 也就是说请求锁的那一刻**已经不在 keydown/click 的手势窗口里**了。Chrome 对
 * `requestPointerLock` 有「需要 transient activation」的判定（尤其是刚被 Esc 解除过锁
 * 的那个 1.25 s 冷却窗口），于是请求被拒 —— 而玩家的观感是：
 *   · 光标一直露着，点哪儿都不进 FPS 视角（任务4 症状①）；
 *   · `freezeLook` 已是 false，裸 `mousemove` 的 `rotate()` 和 drei 的
 *     `<CameraControls enabled>` 同时重新吃鼠标，镜头被鼠标拖着走、跟随基准被拽离角色
 *     （症状②「镜头不跟角色」）；
 *   · `selectMoveFrozen` 只看 `pointerHolds`，相册关掉后集合已空 ⇒ 角色照常能走
 *     （症状③「人走出画面」）。
 * 三件事同源：**「关闭」只做了「解冻」，没有做「把指针交还」**。
 * 所以要把请求锁搬回 handler 里 —— 这里就是那个入口，由 `AlbumView` / `PhotoView`
 * 在 `closeAlbum()` / `closePhoto()` 之后**同步**调用。
 *
 * ── 为什么这里自己判断一遍条件，而不是直接用 `selectFreezeLook` ────────────
 * 因为调用时机太早：`PointerHold` 的 `releasePointer('album')` 还在 effect cleanup 里排队，
 * 此刻 `pointerHolds` **仍然**含 'album'，`selectFreezeLook` 必然为 true ⇒ 直接 bail。
 * 所以这里读的是**同步已经生效**的那几个开关（`albumOpen` / `photo` / `dialog` /
 * `writingIndex` 都由这次 `set()` 立刻改好）。也正因如此，`isCursorFree` 必须读：
 * 玩家按着 ALT 关相册时他要的就是光标，不能又把锁抢回去。
 */
export function requestPointerLockNow(): void {
    const g = useGameStore.getState();
    /* FPV 模式本来就不锁：`useFPVCamera` 用 `clientX / innerWidth` 的**绝对坐标**算朝向，
       锁上之后 clientX 冻住 ⇒ 视角直接转不动（见 `useFPVCamera.ts` 顶部注释）。 */
    if (g.cameraMode !== CameraMode.Follow) return;
    if (!g.isControlEnabled) return;
    // ALT 还按着 = 玩家主动要光标，别抢
    if (g.isCursorFree) return;

    const q = useGameStore2.getState();
    // 还压着别的全屏界面（合影叠相册、对话叠合影…）⇒ 等最后一层关掉时再要锁
    if (q.albumOpen || q.photo !== null || q.dialog !== null || q.writingIndex >= 0) return;

    // 这里拿不到 `gl.domElement`（不在 R3F 树里），全场景只有 R3F 那一块画布
    const canvas = document.querySelector('canvas');
    if (!canvas || document.pointerLockElement === canvas) return;

    try {
        /* 现代 Chrome 返回 Promise；老实现返回 void。
           失败**不在这里重试**：`useFollowCamera` 里那条重试链知道 Chrome 的
           1.25 s 冷却窗口该怎么排，交给它，免得两处各排一套定时器互相打架。 */
        const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === 'function') p.catch(() => { /* 交给重试链 */ });
    } catch {
        /* 同步抛错（老浏览器 / 无手势）：同上，重试链会接住 */
    }
}

export function useFollowCamera({
  characterRef,
  controlsRef,
  enabled,
  freezeLook,
}: UseFollowCameraProps) {
  const { gl } = useThree();

  useEffect(() => {
    if (!enabled) return;
    
    const onMove = (e: MouseEvent) => {
      // 光标自由期间不吃 movementX/Y —— 否则鼠标一移画面就跟着疯转
      if (freezeLook) return;
      controlsRef.current?.rotate(-e.movementX * 0.002, -e.movementY * 0.002, true);
    };

    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [enabled, freezeLook, controlsRef]);

  // Handle Pointer Lock
  useEffect(() => {
    if (!enabled) return;
    const canvas = gl.domElement;
    let retryTimer = 0;
    /** 核对「请求到底成没成」的定时器 —— 有些环境 requestPointerLock 返回 void 且静默失败。 */
    let verifyTimer = 0;
    /** 已经发出过几次请求（给 `window.__lock` 探针读数用）。 */
    let tries = 0;
    /** 最后一次失败的原因原文 —— 真机排查「为什么锁不上」只有这一个线索。 */
    let lastError = '';
    let gestureArmed = false;
    /** 手势兜底最多武装几次：环境彻底不允许锁（iframe 没给 allow、串流环境等）时
     *  别每按一次键都再排 4 个定时器去撞墙。 */
    let gestureArms = 0;

    /* ★ 2026-10-18 用户任务4：重试链 + 手势兜底。
     *
     * 旧实现失败一次就 `console.warn` 收摊，之后除了「点画布」再无补救机会 ——
     * 玩家关掉相册后既不点画布也不按 ALT（谁会在关相册后再点一下画面？），
     * 就会长期停在「光标露着」的状态里，也就是用户报的那三条症状（见文件中间的
     * `requestPointerLockNow` 长注释）。这里补两层：
     *   ① 冷却窗口过后多试几次（1300 / 1700 / 2200 ms，都排在 Chrome 的 ~1.25 s 之外）；
     *   ② 全失败后**武装一次手势兜底**：下一次 pointerdown / keydown 时再要一次锁
     *      —— 那是唯一确定带用户手势的时机，玩家随手一点就回到 FPS 视角。
     */
    const RETRY_DELAYS = [1300, 1700, 2200] as const;

    /** 此刻是否「本来就不该锁」——状态要在**调用时**读，不能闭包捕获旧值。 */
    const frozenNow = () => selectFreezeLook(useGameStore.getState());

    const disarmGesture = () => {
      if (!gestureArmed) return;
      gestureArmed = false;
      window.removeEventListener('pointerdown', onAnyPress, true);
      window.removeEventListener('keydown', onAnyPress, true);
    };

    const armGesture = () => {
      if (gestureArmed) return;
      if (++gestureArms > 3) return;
      gestureArmed = true;
      // 捕获阶段：比画布上的 click、比 UI 按钮都先跑；锁上后自己摘掉
      window.addEventListener('pointerdown', onAnyPress, true);
      window.addEventListener('keydown', onAnyPress, true);
    };

    function onAnyPress() {
      disarmGesture();
      void requestLock(0);
    }

    function scheduleRetry(next: number) {
      if (next >= RETRY_DELAYS.length) {
        // 重试链用完 —— 不能收摊，否则「光标露在外面」会一直挂着
        armGesture();
        return;
      }
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => { void requestLock(next + 1); }, RETRY_DELAYS[next]);
    }

    async function requestLock(attempt: number) {
      if (document.pointerLockElement === canvas) { disarmGesture(); return; }
      // 冻结期间（ALT / 任意全屏界面）绝不抢指针，否则会和 PointerHold 打架
      if (frozenNow()) return;
      tries += 1;
      try {
        await canvas.requestPointerLock();
        /* ★ 2026-10-18 任务4：**别把「await 没抛错」当成「锁上了」**。
           实测（无头 Edge）`requestPointerLock()` 返回 void、既不 resolve 也不 reject，
           `await` 直接过去 —— 旧写法于是认为成功、再也不重试，光标就永远露着。
           所以这里隔一拍自己核对一次 `pointerLockElement`，没锁上就接着排重试。 */
        window.clearTimeout(verifyTimer);
        verifyTimer = window.setTimeout(() => {
          if (document.pointerLockElement === canvas) disarmGesture();
          else scheduleRetry(attempt);
        }, 260);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        scheduleRetry(attempt);
      }
    }

    // 锁真的拿回来的那一刻收掉兜底监听（成功路径的确认点）
    const onLockChange = () => {
      if (document.pointerLockElement === canvas) disarmGesture();
    };
    document.addEventListener('pointerlockchange', onLockChange);

    // 点画布也补一次（原本就有，真机上这是最自然也最可靠的一路）
    const handleClick = () => { void requestLock(0); };
    canvas.addEventListener('click', handleClick);

    if (freezeLook) {
      // ALT 按下：把指针交还给系统（浏览器只在**未锁定**时才显示光标）。
      // 不在这里 return —— 上面的 click 监听要留着，玩家解冻后点画面仍能重新锁定。
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    } else {
      // Initial lock attempt / ALT 松手后恢复锁定
      void requestLock(0);
    }

    /* ★ 2026-10-18 任务4 探针：真机试玩时用它回答「到底请求了几次、为什么被拒」。
       `yaw` 之类在 `__cam.pose()`，这里只管锁本身。 */
    const w = window as unknown as {
      __lock?: {
        tries: () => number;
        armed: () => boolean;
        held: () => boolean;
        err: () => string;
      };
    };
    w.__lock = {
      tries: () => tries,
      armed: () => gestureArmed,
      held: () => document.pointerLockElement === canvas,
      err: () => lastError,
    };

    return () => {
      window.clearTimeout(retryTimer);
      window.clearTimeout(verifyTimer);
      disarmGesture();
      document.removeEventListener('pointerlockchange', onLockChange);
      canvas.removeEventListener('click', handleClick);
      delete w.__lock;
      // Only exit if we are the one holding the lock
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
    };
  }, [enabled, freezeLook, gl.domElement]);

  useFrame(() => {
    if (!enabled || !controlsRef.current || !characterRef?.current) return;
    
    const { x, y, z } = characterRef.current.position;
    controlsRef.current.moveTo(x, y + 1.0, z, true);
  });
}

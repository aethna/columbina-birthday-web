import { create } from 'zustand';
import { Group } from 'three';
import { AudioListener } from 'three/webgpu';
import * as THREE from 'three/webgpu';

export enum CameraMode {
  Follow  = 0,
  FPV = 1,
  Detached = 2,
}

interface GameState {
  // ===== Camera State =====
  cameraMode: CameraMode;
  setCameraMode: (mode: CameraMode) => void;
  toggleCameraMode: () => void;
  
  // ===== Character State =====
  characterRef: React.MutableRefObject<Group | null> | null;
  setCharacterRef: (ref: React.MutableRefObject<Group | null> | null) => void;

  activeTargets: string[];
  setActiveTargets: (targets: string[]) => void;

  readyStatus: Record<string, boolean>;
  setComponentReady: (id: string, isReady: boolean) => void;

  isSceneReady: () => boolean;

  isGameStarted: boolean;
  setIsGameStarted: (loaded: boolean) => void;

  isSoundOn: boolean;
  setIsSoundOn: (isSoundOn: boolean) => void;

  audioListener: AudioListener | null;
  setAudioListener: (listener: THREE.AudioListener) => void;

  isMobile: boolean;
  setIsMobile: (isMobile: boolean) => void;

  quality: 'low' | 'high';
  toggleQuality: () => void;

  isControlEnabled: boolean; 
  setControlEnabled: (enabled: boolean) => void;

  /* ★ 按住 ALT 期间为 true（用户 m05698）：把鼠标指针交还给系统（可点 UI），
     同时冻结**所有**由鼠标驱动的转视角入口。放 store 而不是模块单例，是因为
     `<CameraControls enabled>` 是 React prop，必须触发重渲染才能改。 */
  isCursorFree: boolean;
  setCursorFree: (free: boolean) => void;

  /* ★★ 互动期间的**指针占用集**（用户 m00002，2026-10-17）：任何「需要鼠标点」
     的界面出现时，往里塞一个来源名（`letter` / `dialog` / `photo` / `album` /
     `interact`），界面关掉再摘掉。

     为什么是**集合**而不是布尔：来源会重叠 —— 写完信收进信封的同一帧可能就弹出
     NPC 对话，合影收起后可能立刻进相册。布尔值在这种接力处会被后一个来源的
     「释放」误清成 false，指针瞬间收回去、视角又能被鼠标拖动。引用计数天然免疫。

     为什么放 store：`<CameraControls enabled>` 是 React prop，必须重渲染才能改；
     而且 UI 层要靠它决定 `document.body.style.cursor`。 */
  pointerHolds: string[];
  /** 占住指针。幂等（同一个来源重复调用不会叠加计数）—— React 18 严格模式会双跑 effect。 */
  holdPointer: (who: string) => void;
  /** 释放指针。幂等。 */
  releasePointer: (who: string) => void;

  // ===== WebGPU State =====
  gpuError: string | null;
  setGpuError: (error: string | null) => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  // ===== Camera State =====
  cameraMode: CameraMode.Follow,
  setCameraMode: (mode) => set({ cameraMode: mode }),
  toggleCameraMode: () => set((state) => ({
    cameraMode: (state.cameraMode + 1) % 3
  })),
  
  // ===== Character State =====
  characterRef: null,
  setCharacterRef: (ref) => set({ characterRef: ref }),

  activeTargets: [],
  setActiveTargets: (targets) => set({ activeTargets: targets }),

  readyStatus: {},
  setComponentReady: (id, isReady) => set((state) => ({
    readyStatus: { ...state.readyStatus, [id]: isReady }
  })),

  isSceneReady: () => {
    const { activeTargets, readyStatus } = get();
    if (activeTargets.length === 0) return false;
    return activeTargets.every((target) => readyStatus[target] === true);
  },

  isGameStarted: false,
  setIsGameStarted: (loaded) => set({ isGameStarted: loaded }),

  isSoundOn: false,
  setIsSoundOn: (isSoundOn) => set({ isSoundOn: isSoundOn }),

  audioListener: null,
  setAudioListener: (listener) => set({ audioListener: listener }),

  isMobile: false,
  setIsMobile: (isMobile) => set({ isMobile: isMobile }),

  quality: 'high',
  toggleQuality: () => set((state) => ({ quality: state.quality === 'high' ? 'low' : 'high' })),

  isControlEnabled: false,
  setControlEnabled: (enabled) => set({ isControlEnabled: enabled }),

  isCursorFree: false,
  setCursorFree: (free) => set({ isCursorFree: free }),

  pointerHolds: [],
  holdPointer: (who) => set((s) => (
    s.pointerHolds.includes(who) ? s : { pointerHolds: [...s.pointerHolds, who] }
  )),
  releasePointer: (who) => set((s) => (
    s.pointerHolds.includes(who) ? { pointerHolds: s.pointerHolds.filter((x) => x !== who) } : s
  )),

  // ===== WebGPU State =====
  gpuError: null,
  setGpuError: (error) => set({ gpuError: error }),
}));

/**
 * 「视角冻结」合成值 —— 两条来源取并集：
 *   · `isCursorFree`：玩家按住 ALT（用户 m05698），临时想点一下界面；
 *   · `pointerHolds`：互动界面占着鼠标（用户 m00002）。
 *
 * 为什么不用 `useGameStore((s) => s.isCursorFree || s.pointerHolds.length > 0)`：
 * 那种写法每次求值都返回新布尔（其实布尔是原始值，问题不在这），真正的问题是
 * **选择器散落在各文件里**，改动语义要满仓库找。这里集中成一个选择器，
 * `CameraViewControl` 只 import 它。
 *
 * 注意它**不**表示「人物也不能动」—— 按 ALT 时玩家仍然可以走动（见
 * `useFollowCamera.ts` 顶部注释：冻的只是输入，跟随相机照旧）。人物移动的
 * 冻结走 `selectMoveFrozen`。
 */
export const selectFreezeLook = (s: GameState): boolean =>
  s.isCursorFree || s.pointerHolds.length > 0;

/**
 * 「人物移动冻结」—— **只有互动占用**才冻结，ALT 不冻。
 *
 * 为什么 ALT 不冻：m05698 那版就是「按住 ALT 也能继续走」，玩家靠它边走边点
 * 界面（点完松手接着走）。若把 ALT 也算进来，按 ALT 的那一刻人就钉住了，
 * 与上一版行为不一致。
 */
export const selectMoveFrozen = (s: GameState): boolean => s.pointerHolds.length > 0;

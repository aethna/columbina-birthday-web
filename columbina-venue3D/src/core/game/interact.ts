/**
 * 互动系统 —— 「走到跟前 → 弹出提示 → 按 F 触发」。
 *
 * ── 为什么用「注册表 + 每帧挑最近的」而不是射线检测 ────────────────
 * 本作所有互动对象都是**位置已知的定点**（书桌、信箱、采集点、NPC），
 * 坐标全部来自 `core/game/layout.ts` 那唯一真值。用「水平距离最近且在
 * `radius` 内」判定，比从相机打射线稳得多 —— 不受相机模式（跟随/第一人称/
 * 三脚架）、地形起伏、道具包围盒精度影响，也不会因为鼠标没对准而失效。
 * 而且它天然支持「一次只有一个可互动目标」，不会出现两个提示打架。
 *
 * ── 为什么状态放纯模块对象而不是 zustand ──────────────────────────
 * 与 `ui/minimapState.ts` 同一个理由：**每帧都写**。进 store 会触发 React
 * 每秒重渲染 60 次，而 HUD 提示只需要在**目标切换时**变。
 * 所以 `interactState` 是纯对象，DOM 侧用 rAF 自己读自己画；
 * 真正需要驱动 React 的那件事（任务进度、对话框）走 `questStore`（zustand），
 * 那是**低频**的状态变更。
 *
 * ── F 键 ─────────────────────────────────────────────────────────
 * 用 `keydown` + `e.repeat` 过滤（按住不放不会连发）。**不用**
 * `core/input/controls.ts` 的 `InputSystem.isPressed()` —— 那是电平式（持续为真），
 * 做「按一下触发一次」还得自己做边沿检测，反而更绕。
 *
 * ── 互动期间占住鼠标指针（用户 m00002，2026-10-17）────────────────
 * 用户的逐字要求里专门点名了这一类：「当哥伦比娅与地图互动点 / NPC 以及做其他
 * 互动时（F 键互动），一样禁用鼠标转动视角功能和人物移动功能。当互动结束后释放」。
 *
 * 两级处理：
 *   · 互动**打开了界面**（对话 / 信纸 / 合影 / 相册）⇒ 界面自己的占用会一直挂着，
 *     由 `core/input/PointerHold.tsx` 按面板状态管理，与本文件无关；
 *   · 互动**没有界面**（采集点、寄信这类点了就完事的）⇒ 这里自己占一小段时间
 *     （`INTERACT_HOLD_MS`），覆盖「瞬移到位 + 相机跟随 + Toast 弹出」那几帧。
 *
 * 为什么用**定时释放**而不是「占住不放」：采集点一共 13 个，每采一个都要走过去按 F。
 * 占住不放会让玩家按完 F 就再也走不动（直到手动解除），那是把「禁用移动」变成了
 * 「卡死」。定时窗口既能兑现「互动期间别乱转」，又不会让人失去控制权。
 */
import { useGameStore } from '../store/gameStore';

export interface Interactable {
    /** 唯一 id，例如 `desk` / `mailbox` / `npc:lyney` / `point:rose:0`。 */
    id: string;
    /** 提示标题，例如「窗前的书桌」。 */
    label: string;
    /** 提示副标题（每次调用都重新求值，好显示「x/11」这种动态计数）。 */
    hint: () => string;
    /** 世界 XZ。 */
    x: number;
    z: number;
    /** 判定半径（米）。缺省用 `layout.REACH`。 */
    radius?: number;
    /** 当前是否可互动（任务阶段不对就返回 false，提示直接不出现）。 */
    enabled: () => boolean;
    /** 按下 F 时执行。 */
    onUse: () => void;
    /** 是否要在地面上画一圈发光标识（书桌/信箱/NPC/采集点都要）。 */
    glow?: boolean;
    /** 发光标识的颜色（`#rrggbb`）。 */
    glowColor?: string;
}

const reg = new Map<string, Interactable>();

/** 注册一个可互动对象。返回注销函数 —— 在 `useEffect` 里 `return unregister` 即可。 */
export function registerInteractable(it: Interactable): () => void {
    reg.set(it.id, it);
    return () => {
        reg.delete(it.id);
    };
}

/** 当前所有已注册对象（给「发光标识」组件遍历用）。 */
export function allInteractables(): Interactable[] {
    return [...reg.values()];
}

/** 按 id 取（给发光标识组件用）。 */
export function getInteractable(id: string): Interactable | undefined {
    return reg.get(id);
}

/**
 * HUD 读的那份状态。`id === null` 表示「附近没有可互动的东西」。
 * DOM 侧每帧读，只在值变化时重绘。
 */
export const interactState = {
    id: null as string | null,
    label: '',
    hint: '',
    /** 触发计数 —— 用来让 DOM 侧知道「刚刚按了一次 F」。 */
    fired: 0,
    ready: false,
};

/** 每帧由 `InteractSystem` 调用：挑出离玩家最近、且在判定圈内的那个。 */
export function updateNearest(px: number, pz: number): void {
    let best: Interactable | null = null;
    let bestD2 = Infinity;
    for (const it of reg.values()) {
        if (!it.enabled()) continue;
        const dx = it.x - px;
        const dz = it.z - pz;
        const d2 = dx * dx + dz * dz;
        const r = it.radius ?? 2.6;
        if (d2 > r * r) continue;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = it;
        }
    }
    const id = best ? best.id : null;
    if (id === interactState.id) {
        /* 目标没变：只刷新 hint（可能从「x/10」变成「x/11」）。 */
        if (best) interactState.hint = best.hint();
        interactState.ready = true;
        return;
    }
    interactState.id = id;
    interactState.label = best ? best.label : '';
    interactState.hint = best ? best.hint() : '';
    interactState.ready = true;
}

/** 按下 F：触发当前目标。 */
export function fireInteract(): boolean {
    const id = interactState.id;
    if (!id) return false;
    const it = reg.get(id);
    if (!it || !it.enabled()) return false;
    interactState.fired++;
    /* ★ 互动期间占住指针 + 冻住移动（见文件头那一节）。放在 onUse **之前**：
       例如书桌 `onUse` 会先 `teleport` 玩家、再打开信纸；若等 onUse 之后再占，
       传送那一帧 player 仍可被 WASD 拽走，会出现「点到书桌前却被推开」的抖动。 */
    holdInteract();
    it.onUse();
    /* 触发后立刻刷新一次 hint（任务阶段可能刚变）。 */
    updateNearest(it.x, it.z);
    return true;
}

/**
 * 一次性 F 互动的占用时长（毫秒）。
 *
 * 取 1 s 的依据：`teleport` 是瞬时的，但相机是**阻尼跟随**（`useFollowCamera` 的
 * `moveTo(..., true)` 走 `smoothTime`），加上 Toast（`TOAST_MS = 2600`）弹出来的
 * 头几帧 —— 1 s 足够把「刚按完 F 那一瞬间画面还在动」的窗口盖住。
 * 太长会变成「按完还得等一秒才能走路」，玩家会觉得按键失灵。
 */
const INTERACT_HOLD_MS = 1000;
/** 占用集里的来源名。与 `PointerHold.tsx` 的四个（letter/dialog/photo/album）并列。 */
const INTERACT_HOLD = 'interact';

let interactHoldTimer = 0;

/** 占住指针 + 冻住移动，`INTERACT_HOLD_MS` 后自动释放。重复调用会**续期**。 */
export function holdInteract(): void {
    const st = useGameStore.getState();
    st.holdPointer(INTERACT_HOLD);
    window.clearTimeout(interactHoldTimer);
    interactHoldTimer = window.setTimeout(() => {
        interactHoldTimer = 0;
        useGameStore.getState().releasePointer(INTERACT_HOLD);
    }, INTERACT_HOLD_MS);
}

/** 立刻释放（给无头验收和「打开界面时接管」用）。 */
export function releaseInteractHold(): void {
    window.clearTimeout(interactHoldTimer);
    interactHoldTimer = 0;
    useGameStore.getState().releasePointer(INTERACT_HOLD);
}

/** 主动清掉当前目标（例如打开对话框时，避免对话框和 F 提示同时出现）。 */
export function clearNearest(): void {
    interactState.id = null;
    interactState.label = '';
    interactState.hint = '';
}

let listening = false;

/** 挂 F 键监听。幂等 —— 重复调用只挂一次。 */
export function startInteractKey(): void {
    if (listening) return;
    listening = true;
    window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.code === 'KeyF') {
            /* 有输入框聚焦时不要抢键（例如调试用的 URL 输入框）。 */
            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
            if (fireInteract()) e.preventDefault();
        }
    });
}

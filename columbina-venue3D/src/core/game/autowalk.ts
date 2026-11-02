/**
 * 自动寻路（用户 m02037 任务5）—— 「点任务列表里的某一条，人物自己走过去」。
 *
 * ── 为什么单独一个模块、而不是塞进 `questStore` ────────────────────
 *   · 目标点解析要读**互动注册表**（`core/game/interact.ts` 的 `getInteractable`，
 *     `radius` / `enabled` 都在那儿），而 `interact.ts` 已经 import 了 `gameStore`；
 *     塞进 store 会绕出一圈 `store ↔ interact` 的循环 import；
 *   · 每帧都要推进（卡住检测、绕行角度），进 zustand 就是每秒 60 次重渲染 ——
 *     和 `interactState` / `minimapState` 同一个理由，**纯模块对象 + 订阅回调**。
 *
 * ── 为什么不在 `controls.ts` 里加一套「自动移动」────────────────────
 *   `core/input/controls.ts` 的 `keyBindings` 是**电平式**（按住为真）；
 *   自动寻路是「持续一段时间的意图」，而且必须**绕过**玩家输入（由 UI 触发）。
 *   所以这里只吐「每帧期望的世界方向」，真正的位移仍由 `MmdCharacter.tsx`
 *   的 `useFrame` 执行 —— 树/桌/船的推出、贴地、收尾动画全部照旧生效，
 *   这也是卡片要求的「不新写移动系统」。
 *
 * ── 目标解析为什么不另写一份「下一步该去哪」────────────────────────
 *   每一条任务行 → 一个**已注册的互动点 id**，规则与 `GameInteract` 注册时一一对应：
 *       talk 委托        → `npc:${q.targetNpc}`（交付/接取都在那个人身上）
 *       采集/到访委托    → `point:${pointId}:${i}`（挑离玩家最近的**可用**实例）
 *       写邀请函总览行   → `desk`（写完 11 封则 `mailbox`）
 *       宴会总览行       → `cake`
 *   互动点 id 的半径、可用性、文案都由注册表给，不在这里抄第二份。
 *   只有这样，到达判定才与「按 F 的提示」**天然是同一个圈**。
 */
import { QNUM, QSTR } from '../utils/query';
import { useGameStore } from '../store/gameStore';
import { QUESTS } from './copy';
import { getInteractable, type Interactable } from './interact';
import { REACH, pointXZ } from './layout';
import { useGameStore2 } from './questStore';
import { guideState } from '../../ui/guideState';

/**
 * 总开关（`?autowalk=0`）。
 *
 * ⚠️ 参数名与 `MmdCharacter.tsx:530` 的 `AUTOWALK`（`?autowalk=<速度>`，
 * 无头诊断用的「原地/直线自动走」）**同名**。那个是**数字**、缺省 0；
 * 这里是**开关**、缺省开。两者的缺省值互相兼容（`?autowalk=0` 既关掉诊断走、
 * 也关掉本功能），但传 `?autowalk=1.4` 会同时打开两者 —— 这是历史包袱，
 * 所以另留了一个无歧义别名 `?nav=0`。新代码请用 `?nav=0`。
 */
export const NAV_ON = QSTR('autowalk') !== '0' && QSTR('nav') !== '0';

/** 走路速度（米/秒）。比 `WALK_SPEED`(3.26) 慢一点：玩家点了寻路是在「看」她走。 */
const NAV_SPEED = QNUM('navspeed', 1.9)!;

/** 到达判定：离目标中心这么近就停 —— 用互动半径减 0.7 m，
 *  保证停下来时一定已经在「按 F」的圈内（否则还得手动挪两步才出提示）。 */
const STOP_MARGIN = 0.7;

/** 卡住检测窗口：每 600 ms 看一次位移，< 0.05 m 判卡。 */
const STUCK_WIN_MS = 600;
const STUCK_MIN_M = 0.05;
/** 侧向绕行持续时长（±45° 交替）。 */
const DETOUR_MS = 900;
/** 连续受阻到这个时长就放弃（≈ 3 个检测窗口）。 */
const GIVEUP_MS = 1800;

export interface NavTarget {
    /** 触发它的任务行 id（`q1`…`q14` / `q_letter` / `q_cake`），用于 UI 高亮。 */
    questId: string;
    /** 互动注册表里的 id，例如 `npc:lyney` / `point:rose:1`。 */
    interactId: string;
    label: string;
    x: number;
    z: number;
    /** 停下来时离中心的目标距离（米）。 */
    stopDist: number;
    radius: number;
}

export const navState: {
    target: NavTarget | null;
    /** 诊断读数：已走秒数 / 绕行剩余 / 累计受阻 / 最后结果 */
    walkSec: number;
    detourMs: number;
    detourSide: 1 | -1;
    blockedMs: number;
    lastResult: string;
    /** 起点（诊断用：验收要「起点 → 终点」） */
    fromX: number;
    fromZ: number;
    /** 卡住检测的窗口游标（对玩家不可见，纯内部） */
    winMs: number;
    winX: number;
    winZ: number;
    /** 触发过几次侧向绕行（验收「卡住能绕」的读数） */
    detours: number;
} = {
    target: null,
    walkSec: 0,
    detourMs: 0,
    detourSide: 1,
    blockedMs: 0,
    lastResult: '',
    fromX: 0,
    fromZ: 0,
    winMs: 0,
    winX: 0,
    winZ: 0,
    detours: 0,
};

/* ── 订阅：UI（任务列表的「自动寻路中」）需要重渲染，useFrame 不需要 ── */
const listeners = new Set<() => void>();

export function subscribeNav(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function notify(): void {
    for (const fn of listeners) {
        try { fn(); } catch { /* 单个订阅者抛错不该打断寻路 */ }
    }
}

/** 当前正在自动走向哪条任务行（`null` = 没在走）。UI 直接读这个。 */
export function navActiveId(): string | null {
    return navState.target?.questId ?? null;
}

function playerPos(): { x: number; z: number } | null {
    const c = useGameStore.getState().characterRef?.current;
    return c ? { x: c.position.x, z: c.position.z } : null;
}

function toast(text: string, sub: string): void {
    // ms 用缺省 2.6 s：寻路提示是过路信息，不该一直占屏
    useGameStore2.getState().showToast(text, sub);
}

/** 把任务行 id 解析成一个已注册的互动点。解析不出来返回 null。 */
export function resolveNavTarget(questId: string): NavTarget | null {
    const st = useGameStore2.getState();
    const pos = playerPos() ?? { x: 0, z: 0 };

    let itId: string | null = null;
    let label = '';
    let q = QUESTS.find((x) => x.id === questId);

    /* 三条流程总览行（`questLines` 里的非委托行）—— 与 `GameLayer` 的
     * 「小地图指引」同源：写邀请函→书桌/信箱，宴会→蛋糕台。 */
    if (!q) {
        if (questId === 'q_letter') {
            itId = st.lettersReady ? 'mailbox' : 'desk';
            label = st.lettersReady ? '林间信箱' : '窗前的书桌';
        } else if (questId === 'q_cake') {
            itId = 'cake';
            label = '蛋糕台';
        } else if (questId === 'q_quests') {
            const next = QUESTS.find((x) => !st.delivered.includes(x.id));
            if (!next) return null;
            q = next;
        } else {
            return null;
        }
    }

    if (q) {
        if (q.kind === 'talk' && q.targetNpc) {
            itId = `npc:${q.targetNpc}`;
        } else if (q.pointId) {
            /* 采集点：同一个 pointId 有多个实例（`rose×3` / `litter×5`）。
             * 挑**离玩家最近、且当前可用**的那个 —— 已采走 / 委托没接的都会被
             * `enabled()` 过滤掉，与地上哪些点还能按 F 完全一致。 */
            const spots = pointXZ(q.pointId);
            let bestD = Infinity;
            for (let i = 0; i < spots.length; i++) {
                const id = `point:${q.pointId}:${i}`;
                const it = getInteractable(id);
                if (!it || !it.enabled()) continue;
                const d = Math.hypot(it.x - pos.x, it.z - pos.z);
                if (d < bestD) { bestD = d; itId = id; }
            }
            if (!itId) return null;
        }
    }

    if (!itId) return null;
    const it: Interactable | undefined = getInteractable(itId);
    if (it) {
        const radius = it.radius ?? REACH;
        return {
            questId,
            interactId: itId,
            label: label || it.label,
            x: it.x,
            z: it.z,
            radius,
            stopDist: Math.max(0.8, radius - STOP_MARGIN),
        };
    }

    /* 兜底：注册表里没有（例如 NPC 还没加载完 / 阶段不对）。
     * 用 `ui/guideState.ts` 的当前指引目标 —— 卡片要求「复用这套 target 解析」，
     * 它就是小地图箭头指的那个点。 */
    const g = guideState.target;
    if (g) {
        return {
            questId,
            interactId: '',
            label: g.label,
            x: g.x,
            z: g.z,
            radius: REACH,
            stopDist: Math.max(0.8, REACH - STOP_MARGIN),
        };
    }
    return null;
}

export function startNav(t: NavTarget): void {
    const pos = playerPos();
    navState.target = t;
    navState.walkSec = 0;
    navState.detourMs = 0;
    navState.detourSide = 1;
    navState.blockedMs = 0;
    navState.lastResult = '';
    navState.fromX = pos?.x ?? 0;
    navState.fromZ = pos?.z ?? 0;
    navState.winMs = 0;
    navState.winX = pos?.x ?? 0;
    navState.winZ = pos?.z ?? 0;
    notify();
}

/**
 * 停止自动行走。
 * `reason`：`user`（再点一次/按方向键）/ `arrived` / `failed` / `replaced`。
 * 到达与失败会弹提示；用户主动取消不弹（他自己知道）。
 */
export function stopNav(reason: 'user' | 'arrived' | 'failed' | 'replaced' = 'user'): void {
    const t = navState.target;
    if (!t) return;
    navState.target = null;
    navState.detourMs = 0;
    navState.blockedMs = 0;
    navState.lastResult = reason;
    if (reason === 'arrived') toast('已到达', t.label);
    if (reason === 'failed') toast('寻路失败', '路上被挡住了，靠近些再点一次');
    notify();
}

/**
 * UI 点击入口（toggle）。返回 `true` = 已开始走向该行，`false` = 刚被取消 / 无法前往。
 * 同一条再点一次取消（卡片第 4 条验收）。
 */
export function toggleAutowalk(questId: string): boolean {
    if (!NAV_ON) return false;
    if (navState.target?.questId === questId) {
        stopNav('user');
        return false;
    }
    const t = resolveNavTarget(questId);
    if (!t) {
        toast('暂时找不到目标', '先靠近一点，或等人物加载完');
        return false;
    }
    startNav(t);
    return true;
}

/** 外部（GameLayer 打开对话/合影时、任务完成时）无条件取消。 */
export function cancelNav(): void {
    if (navState.target) stopNav('replaced');
}

/**
 * 每帧推进一步 —— 由 `MmdCharacter.tsx` 的 `useFrame` 调用。
 *
 * 返回本帧的**世界方向单位向量**与速度；返回 `null` 表示「这一帧不该由寻路驱动」
 * （没目标 / 刚好到点 / 判定失败 —— 后两者已经在内部处理完并通知 UI）。
 *
 * 卡住处理（卡片要求）：位置 0.6 s 内移动 < 0.05 m 判卡 →
 * 方向偏到 ±45° 交替绕行 0.9 s → 累计受阻 1.8 s 仍卡则放弃。
 */
export function navStep(px: number, pz: number, dt: number): { dx: number; dz: number; speed: number } | null {
    const t = navState.target;
    if (!t) return null;

    const dx = t.x - px;
    const dz = t.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist <= t.stopDist) {
        stopNav('arrived');
        return null;
    }

    navState.walkSec += dt;
    navState.winMs += dt * 1000;
    if (navState.winMs >= STUCK_WIN_MS) {
        const moved = Math.hypot(px - navState.winX, pz - navState.winZ);
        navState.winMs = 0;
        navState.winX = px;
        navState.winZ = pz;
        if (moved < STUCK_MIN_M) {
            navState.blockedMs += STUCK_WIN_MS;
            if (navState.blockedMs >= GIVEUP_MS) {
                stopNav('failed');
                return null;
            }
            /* 第一次左右各绕一次，之后交替 —— 对称绕行能出来，单侧绕可能一直撞同一棵树。 */
            navState.detourSide = navState.detourSide === 1 ? -1 : 1;
            navState.detourMs = DETOUR_MS;
            navState.detours++;
        } else {
            navState.blockedMs = 0;
        }
    }
    if (navState.detourMs > 0) navState.detourMs = Math.max(0, navState.detourMs - dt * 1000);

    const base = Math.atan2(dx, dz);
    const ang = base + (navState.detourMs > 0 ? navState.detourSide * (Math.PI / 4) : 0);
    return { dx: Math.sin(ang), dz: Math.cos(ang), speed: NAV_SPEED };
}

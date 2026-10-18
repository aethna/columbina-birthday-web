/**
 * 小地图「当前任务目标」的共享状态 —— 和 `ui/minimapState.ts` 同一个理由：
 * 它每帧被 `ui/MiniMap.tsx` 的 rAF 读，进 React store 就会白白触发重渲染。
 *
 * 为什么是 `{ target }` 这层可变容器，而不是直接导出 `const guideState = null`：
 * `export const` 的绑定本身不可重新赋值，外部就没法把目标清成 null
 * （任务做完 / 切换任务时要收掉箭头和文字）。套一层容器，`setGuide(null)` 才真的能「关掉」指引。
 *
 * 坐标系与 `minimapState` 完全一致：世界 -Z = 北，世界 +X = 东。
 */
export interface GuideTarget {
    /** 小地图下方那一行字，例如「书桌」「林间信箱」 */
    label: string;
    /** 目标世界坐标（米） */
    x: number;
    z: number;
}

export const guideState: { target: GuideTarget | null } = { target: null };

/**
 * 设置当前指引目标。传 `null` = 没有任务目标，小地图不画箭头也不写文字
 * （画面回到「没有指引」的样子）。
 *
 * 由 `components/game/GameLayer.tsx` 在任务推进时调用；小地图只负责读。
 */
export function setGuide(t: GuideTarget | null): void {
    guideState.target = t;
}

/* ════════════════════════════════════════════════════════════════════════════
 * ★ 2026-10-18 用户 m00863 任务3：世界内委托箭头「当前选中的那一条」
 *
 * 为什么另起一个容器、而不复用上面的 `guideState.target`：
 *   `target` 是**小地图自动算出来的下一步**（写邀请函 → 书桌，寄信 → 信箱…），
 *   由 `GameLayer` 在状态变化时写。箭头要的是**玩家亲手点选的那一条委托**，
 *   两者会在同一帧里指向不同地方（例如玩家点了 q7，而小地图仍指向最近的采集点）。
 *   挤进同一个字段，就会出现「点一下任务行，小地图指引也跟着跳」的串味 bug。
 *
 * 为什么放在模块级可变容器、而不是 QuestList 的 useState / zustand：
 *   ① `QuestArrow` 每帧都要读它（见 `QuestArrow.tsx` 的 useFrame），
 *     进 React store 会为了一个数字触发整棵 UI 重渲染 —— 和 `minimapState` 同一个理由；
 *   ② `core/game/questStore.ts` 此刻有别的 agent 在并行改（本轮硬性禁写），
 *      选中态只服务 UI，本来也不属于游戏状态机。
 *   约定：**只由 `ui/QuestList.tsx` 写**，`QuestArrow` 只读。
 * ════════════════════════════════════════════════════════════════════════════ */
export const questArrowState: { questId: string | null } = { questId: null };

/** 选中/取消某条委托的箭头（`null` = 全部收起）。 */
export function setQuestArrow(questId: string | null): void {
    questArrowState.questId = questId;
}

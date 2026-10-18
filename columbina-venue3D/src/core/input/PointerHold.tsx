/**
 * PointerHold.tsx —— 互动期间**强制呼出鼠标指针**，同时冻结视角与人物移动（用户 m00002）。
 *
 * ── 要解决的四个场景 ─────────────────────────────────────────────────────
 * 用户逐字：「在所有需要鼠标按键互动的情况下（比如邀请函切下一张，哥伦比娅与 NPC
 * 互动，收起合影等），强制唤起鼠标指针，并同时禁用鼠标转动视角功能和人物移动功能。
 * 当互动结束后，释放鼠标指针，解锁视角转动与人物移动。备注：当哥伦比娅与地图互动点 /
 * NPC 以及做其他互动时（F 键互动），一样禁用鼠标转动视角功能和人物移动功能。」
 *
 * 翻译成状态条件（全部读 `questStore`，那是这些界面的唯一真值）：
 *   · `writingIndex >= 0` ⇒ 信纸在显示（点一下切下一张 / 收进信封）
 *   · `dialog !== null`   ⇒ 对话框在显示（点一下翻页）
 *   · `photo !== null`    ⇒ 合影/相片全屏（点一下收起）
 *   · `albumOpen`         ⇒ 相册全屏（点缩略图放大）
 * F 键互动那一类（书桌 / 信箱 / 采集点 / 蛋糕）**没有界面对应**，所以不由这里管 ——
 * 它在 `core/game/interact.ts` 的 `fireInteract()` 里自己占一小段时间，理由见那边注释。
 *
 * ── 为什么用「占用集」而不是布尔 ─────────────────────────────────────
 * 上述条件是**会重叠**的：写完信收进信封的同一帧就可能弹出 NPC 对话；收起合影之后
 * 玩家可能立刻点开相册。用布尔值时，后者的「释放」会把前者还没用完的冻结一起清掉，
 * 指针瞬间收回去、视角又能被鼠标拖动。`pointerHolds` 是集合，天然免疫这种接力。
 *
 * ── 和 ALT（m05698）的关系 ───────────────────────────────────────────
 * 两者做的是同一件事（交还光标 + 冻视角），只是触发源不同：ALT 是「玩家临时想点
 * 一下界面」，这里是「界面自己要求」。所以 `freezeLook` 取两者的**并集**
 * （`gameStore.selectFreezeLook`），而 ALT 抬起时若互动仍在进行，冻结不会被误解除。
 *
 * 但**人物移动**只被互动冻结（`selectMoveFrozen`）：按 ALT 时玩家仍能边走边点，
 * 这是 m05698 那一版就有的行为（见 `useFollowCamera.ts` 顶部注释），不能退化。
 *
 * ── 为什么挂在 App 顶层 ─────────────────────────────────────────────
 * 与 `<CursorKey/>` 同一个理由：`?cam=` 调试参数会让 `CameraViewControl` 整个不挂载，
 * 而 UI 界面照样会出现，冻结不能跟着消失。本组件只挂订阅、返回 null。
 */
import { useEffect } from 'react';
import { useGameStore, selectFreezeLook, selectMoveFrozen } from '../store/gameStore';
import { useGameStore2 } from '../game/questStore';
import { input } from './controls';

/** 把一个「界面是否开着」的布尔量接到 `pointerHolds` 上。 */
function useHoldPointer(who: string, active: boolean) {
    useEffect(() => {
        if (!active) return;
        // ⚠️ 用 getState() 而不是 hook 取函数：函数引用在 zustand 里恒定，
        //    但这样写能避免把它塞进依赖数组（effect 只该被 active 驱动）。
        useGameStore.getState().holdPointer(who);
        return () => useGameStore.getState().releasePointer(who);
    }, [who, active]);
}

export function PointerHold() {
    /* 四个会吃鼠标的界面。选择器返回布尔 —— zustand 用 Object.is 比较，
       所以这里只有在「开/关」那一刻才重渲染，不是每帧。 */
    const letterOpen = useGameStore2((s) => s.writingIndex >= 0);
    const dialogOpen = useGameStore2((s) => s.dialog !== null);
    const photoOpen = useGameStore2((s) => s.photo !== null);
    const albumOpen = useGameStore2((s) => s.albumOpen);

    useHoldPointer('letter', letterOpen);
    useHoldPointer('dialog', dialogOpen);
    useHoldPointer('photo', photoOpen);
    useHoldPointer('album', albumOpen);

    /** 人物移动的总闸（只有互动会拉下）。 */
    const moveFrozen = useGameStore(selectMoveFrozen);

    useEffect(() => {
        input.setLocked(moveFrozen);
        // 卸载时务必解锁：热更新（HMR）会把组件拆了重建，
        // 不解锁的话一次热更就会让 WASD 永久失灵，看起来像「代码把走路改坏了」。
        return () => { input.setLocked(false); };
    }, [moveFrozen]);

    /**
     * 无头验收探针。为什么单独开一个：`window.__cursor` 归 `CursorKey` 管，
     * 它读的是 ALT 那一半；这里暴露的是「互动那一半」和最终合成值，
     * 脚本必须能分辨「冻结是 ALT 引起的」还是「界面引起的」。
     */
    const freezeLook = useGameStore(selectFreezeLook);
    useEffect(() => {
        const w = window as unknown as {
            __hold?: {
                holds: () => string[];
                freezeLook: () => boolean;
                moveFrozen: () => boolean;
                inputLocked: () => boolean;
            };
        };
        w.__hold = {
            holds: () => [...useGameStore.getState().pointerHolds],
            freezeLook: () => selectFreezeLook(useGameStore.getState()),
            moveFrozen: () => selectMoveFrozen(useGameStore.getState()),
            inputLocked: () => input.isLocked(),
        };
        return () => { delete w.__hold; };
    }, [freezeLook]);

    return null;
}

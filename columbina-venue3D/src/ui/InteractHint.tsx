/**
 * InteractHint —— 屏幕底部中央的「按 F」提示条。
 *
 * ── 为什么用 rAF 轮询而不是让 interact.ts 推进 React ─────────────────
 * `interactState` 是**每帧**被 `updateNearest()` 重写的纯模块对象（见 `core/game/interact.ts`
 * 文件头「为什么状态放纯模块对象」）。把它接进 zustand 会让整个 HUD 每秒重渲染 60 次，
 * 而这里真正会变的东西只有「最近的可互动目标」—— 玩家走两步才换一次。
 * 所以自己开 rAF 读，**只在三个字段真的变了才 setState**，其余帧一次 React 都不进。
 *
 * 30 fps 够用：这是「走到跟前才出现」的提示，不是跟手的光标。省一半 CPU。
 *
 * ── 为什么绝对不挂 onClick（用户 m02646 逐字）──────────────────────
 * 「除了我明确说明的可以点击鼠标外，其余所有功能全部指定只能按 F 键」，
 * 而用户明确点名了「和 NPC 互动只能用 F 键不能用鼠标」。
 * 这个组件是**纯提示**：一个字的交互都没有。鼠标点它必须直接穿到 3D 画布上，
 * 否则玩家想在 NPC 面前转个视角都会被这条提示挡住。
 * 触发逻辑在 `core/game/interact.ts` 的全局 KeyF 监听里，与这里无关。
 */
import { useEffect, useState } from 'react';
import { interactState } from '../core/game/interact';

/** 与 interactState 对齐的一份快照 —— 只放要渲染的字段。 */
interface HintSnap {
    id: string | null;
    label: string;
    hint: string;
}

const EMPTY: HintSnap = { id: null, label: '', hint: '' };

export function InteractHint() {
    const [snap, setSnap] = useState<HintSnap>(EMPTY);

    useEffect(() => {
        let raf = 0;
        let last = -1e9;
        /** 上一帧真正渲染过的值。跟它比，不跟 state 比 —— 闭包里读不到最新 state。 */
        let prev: HintSnap = EMPTY;

        const tick = () => {
            raf = requestAnimationFrame(tick);
            const now = performance.now();
            if (now - last < 33) return; // ~30 fps
            last = now;

            const id = interactState.id;
            const label = id ? interactState.label : '';
            const hint = id ? interactState.hint : '';

            // 三个字段都没动就直接跳过 —— 这是「不每秒重渲染 60 次」的全部秘密
            if (id === prev.id && label === prev.label && hint === prev.hint) return;

            prev = { id, label, hint };
            setSnap(prev);
        };

        tick();
        return () => cancelAnimationFrame(raf);
    }, []);

    const on = snap.id !== null;

    return (
        <div
            style={{
                position: 'fixed',
                left: '50%',
                bottom: 88,
                transform: `translateX(-50%) translateY(${on ? 0 : 8}px)`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                padding: '9px 16px 10px',
                borderRadius: 12,
                background: 'rgba(12,14,22,0.62)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
                border: '1px solid rgba(255,255,255,0.10)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.42)',

                // 出现/消失：淡入淡出 + 轻微上浮。隐藏时连指针事件也一起关掉。
                opacity: on ? 1 : 0,
                visibility: on ? 'visible' : 'hidden',
                pointerEvents: 'none',
                transition: 'opacity 0.18s ease, transform 0.18s ease, visibility 0s linear 0.18s',
                userSelect: 'none',
                zIndex: 30,
            }}
        >
            {/* 第一行：目标名（例如「窗前的书桌」） */}
            <div
                style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: '#ffffff',
                    textShadow: '0 2px 6px rgba(0,0,0,0.6)',
                    whiteSpace: 'nowrap',
                }}
            >
                {snap.label}
            </div>

            {/* 第二行：【F】圆角小方框 + 副标题（动态计数，例如「邀请函 3/11」） */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 24,
                        height: 24,
                        border: '1px solid rgba(255,255,255,0.5)',
                        borderRadius: 5,
                        color: '#ffffff',
                        fontSize: 13,
                        fontWeight: 700,
                        lineHeight: 1,
                        // 纯 CSS 画的键帽，不引图片 —— 一个 24px 的方框不值得多一个网络请求
                        boxShadow: 'inset 0 -2px 0 rgba(255,255,255,0.14)',
                    }}
                >
                    F
                </span>
                <span style={{ fontSize: 13, color: '#e8d8a8', whiteSpace: 'nowrap' }}>
                    {snap.hint}
                </span>
            </div>
        </div>
    );
}

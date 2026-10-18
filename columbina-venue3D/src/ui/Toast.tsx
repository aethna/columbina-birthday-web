/**
 * Toast —— 屏幕中央偏上的文字提示（「已拍照 / 相册里可以查看」这类）。
 *
 * ── 为什么这里绝对不吃点击（pointerEvents:'none'）────────────────────
 * 提示可能在任何时候冒出来，包括玩家正要去点右下角的拍照按钮、或正要去点场景里某个 NPC。
 * 只要它吃掉一次点击，玩家就会觉得「按钮坏了」。所以这一层必须完全透明于鼠标事件。
 *
 * ── 为什么自己不调 clearToast ────────────────────────────────────────
 * 显示时长是**业务**决定的（拍照提示 2 秒、切蛋糕提示可能要 4 秒），不该由这个纯展示组件拍板。
 * 调用方负责 `showToast` 和稍后的 `clearToast`；本组件只负责「出现时淡入」。
 *
 * ── 为什么淡入要用两层 requestAnimationFrame ─────────────────────────
 * 新提示到来时 opacity 得先回到 0 再升到 1，否则从 0.9 到 1 的差值太小，看不出淡入。
 * 但 React 会在同一个批次里把「置 0」和「置 1」合并成一次提交 —— 浏览器只看到最终值 1，
 * transition 根本不会触发。所以：第一帧只负责让 opacity:0 真正**画上屏**，
 * 第二帧才改成 1。少一层就会出现「有时有淡入、有时直接蹦出来」的闪烁。
 */
import { useEffect, useState } from 'react';
import { useGameStore2 } from '../core/game/questStore';

/** 淡入时长，和下面 transition 里的数字必须是同一个值。 */
const FADE_MS = 180;

export function Toast() {
    const toast = useGameStore2((s) => s.toast);

    const [opacity, setOpacity] = useState(0);

    useEffect(() => {
        // 没有提示就没必要起动画（组件此时 return null，也画不出来）
        if (!toast) return;

        setOpacity(0);

        let raf2 = 0;
        // 第一帧：把 opacity:0 画上屏
        const raf1 = requestAnimationFrame(() => {
            // 第二帧：改成 1，transition 这才会真的跑起来
            raf2 = requestAnimationFrame(() => setOpacity(1));
        });

        return () => {
            cancelAnimationFrame(raf1);
            cancelAnimationFrame(raf2);
        };
        // 依赖整个 toast 对象：引用一变（新提示）就重播淡入，哪怕文字恰好相同
    }, [toast]);

    if (!toast) return null;

    return (
        <div
            style={{
                position: 'fixed',
                left: '50%',
                top: '26%',
                transform: 'translate(-50%, 0)',
                zIndex: 65,
                textAlign: 'center',
                // 见文件头：提示层永远不吃点击
                pointerEvents: 'none',
                userSelect: 'none',
                opacity,
                transition: `opacity ${FADE_MS}ms ease-out`,
            }}
        >
            <div
                style={{
                    fontSize: 21,
                    lineHeight: 1.4,
                    color: '#f2e9d8',
                    letterSpacing: 1,
                    textShadow: '0 2px 12px rgba(0,0,0,0.9)',
                }}
            >
                {toast.text}
            </div>

            {/* 副文字是可选的（showToast 的 sub 参数可省）。空串同样不渲染，
                否则会多出一块 8px 的空白，让提示看起来没有垂直居中 */}
            {toast.sub ? (
                <div
                    style={{
                        marginTop: 8,
                        fontSize: 14,
                        lineHeight: 1.5,
                        color: 'rgba(220,228,245,0.75)',
                        textShadow: '0 2px 10px rgba(0,0,0,0.85)',
                    }}
                >
                    {toast.sub}
                </div>
            ) : null}
        </div>
    );
}

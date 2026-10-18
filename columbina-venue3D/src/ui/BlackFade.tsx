/**
 * BlackFade —— 全黑过渡幕（换阶段用）+ 载入进度条。
 *
 * ── 为什么这一层**必须**吃点击（pointerEvents:'auto'）────────────────
 * 它出现的时候正是场景在换阶段（切蛋糕 → 合影 → 会场重排），玩家看不见画面。
 * 如果点击能穿透，玩家盲点就会触发身后 NPC 的互动、甚至拖转相机，
 * 等黑幕散去会发现视角已经被自己搅乱了。宁可短暂「无响应」，也不要误操作。
 *
 * ── 为什么只做淡入，退场交给 store ──────────────────────────────────
 * 退场要等动画播完才能卸载，那就得在组件里留一个「正在退场」的临时态，
 * 于是出现两处真值（store 的 fade 和本地的 fadingOut），迟早不同步。
 * 约定：调用方把 `fade` 设回 null，本组件立刻 return null —— 一步到位。
 *
 * ── 为什么进度条用 transition 而不是自己跑动画帧 ────────────────────
 * 进度条是**装饰**：真正在加载的是场景资源，它不会回报百分比。
 * 用 CSS transition 让浏览器在合成线程上补间，即使主线程正忙着编译着色器也不会卡顿。
 * 自己写 rAF 反而会在主线程卡住时一起僵死 —— 那正是最需要它动的时候。
 *
 * ── 为什么重置和淡入都等两帧 ────────────────────────────────────────
 * 同 `Toast.tsx`：React 会把「置 0」和「置 1」合并成一次提交，浏览器只看到最终值，
 * transition 不触发。第一帧负责把 0 画上屏，第二帧才改成终值。
 */
import { useEffect, useState } from 'react';
import { useGameStore2 } from '../core/game/questStore';

/** 进度条补间时长。 */
const BAR_MS = 1100;
/** 整块黑幕的淡入时长，和下面 transition 里的数字必须一致。 */
const FADE_MS = 200;

export function BlackFade() {
    const fade = useGameStore2((s) => s.fade);

    /** 黑幕不透明度：0 → 1 淡入。 */
    const [opacity, setOpacity] = useState(0);
    /** 进度条是否已经推到 100%。 */
    const [filled, setFilled] = useState(false);

    useEffect(() => {
        // 没有过渡就不起动画（组件此时 return null，画不出来）
        if (!fade) return;

        setOpacity(0);
        setFilled(false);

        let raf2 = 0;
        // 第一帧：把 opacity:0 / width:0% 真正画上屏
        const raf1 = requestAnimationFrame(() => {
            // 第二帧：改成终值，两条 transition 这才会跑起来
            raf2 = requestAnimationFrame(() => {
                setOpacity(1);
                setFilled(true);
            });
        });

        return () => {
            cancelAnimationFrame(raf1);
            cancelAnimationFrame(raf2);
        };
        // 依赖整个 fade 对象：引用一变（换阶段）就重播淡入 + 重跑进度条
    }, [fade]);

    if (!fade) return null;

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: '#05060a',
                zIndex: 90, // 全场最高：过渡期间压住相册(70)/Toast(65)/所有 UI
                pointerEvents: 'auto', // 见文件头：过渡期间就是要挡住误操作
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                userSelect: 'none',
                opacity,
                transition: `opacity ${FADE_MS}ms ease-out`,
            }}
        >
            <div
                style={{
                    fontSize: 22,
                    lineHeight: 1.5,
                    color: '#e8e2d4',
                    letterSpacing: 2,
                    textAlign: 'center',
                    textShadow: '0 2px 14px rgba(0,0,0,0.9)',
                }}
            >
                {fade.title}
            </div>

            <div
                style={{
                    marginTop: 10,
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: 'rgba(200,210,230,0.7)',
                    letterSpacing: 1,
                    textAlign: 'center',
                }}
            >
                {fade.sub}
            </div>

            {/* 进度条 */}
            <div
                style={{
                    marginTop: 26,
                    width: 'min(360px, 60vw)',
                    height: 4,
                    borderRadius: 2,
                    background: 'rgba(255,255,255,0.12)',
                    overflow: 'hidden',
                }}
            >
                <div
                    style={{
                        width: filled ? '100%' : '0%',
                        height: '100%',
                        borderRadius: 2,
                        background: '#e8d8a8',
                        boxShadow: '0 0 12px rgba(232,216,168,0.5)',
                        transition: `width ${BAR_MS}ms ease-out`,
                    }}
                />
            </div>

            <div
                style={{
                    marginTop: 12,
                    fontSize: 12,
                    letterSpacing: 1,
                    color: 'rgba(200,210,230,0.5)',
                }}
            >
                载入中…
            </div>
        </div>
    );
}

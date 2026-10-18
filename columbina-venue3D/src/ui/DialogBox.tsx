/**
 * DialogBox —— 屏幕底部的**纯文字**对话框。
 *
 * 用户原话：「玩家和NPC对话时，对话框设计为纯文字即可，按鼠标/F键翻下一页。」
 * 所以这里**没有立绘、没有头像、没有打字机音效** —— 只有说话人名字 + 一行台词 + 一个翻页提示。
 *
 * ── 为什么 F 键要走捕获阶段（这是本文件唯一的坑）─────────────────────
 * `core/game/interact.ts` 的 `startInteractKey()` 在 **window 冒泡阶段**监听了 KeyF，
 * 一旦命中就 `fireInteract()` —— 那会把玩家刚说上话的 NPC 又触发一次。
 * 而对话框翻页用的也是 F。两个监听器同在 window 上时，
 * **捕获阶段一定先于冒泡阶段执行**（window 是捕获链的第一个节点、冒泡链的最后一个），
 * 所以这里用 `addEventListener('keydown', h, true)` + `stopPropagation()`，
 * 把事件在到达 interact.ts 之前就截住。`preventDefault()` 顺带挡掉浏览器默认行为。
 *
 * 只在这两个条件都成立时才截：① 对话框正开着（组件挂载了才有效）；
 * ② 焦点不在输入框里（沿用 interact.ts 的同款判断，免得以后加调试输入框时抢键）。
 *
 * ── 为什么鼠标可以翻页而别的组件不行 ────────────────────────────────
 * 用户 m02646 收紧成「除了我明确说明的可以点击鼠标外，其余全部只能按 F 键」，
 * 而对话框翻页正是他明确列出的例外之一（「按鼠标/F键翻下一页」）。
 * 所以 `onClick` / `onWheel` 保留，其余三个 UI 组件一律不挂鼠标事件。
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import { NPCS } from '../core/game/copy';
import { useGameStore2 } from '../core/game/questStore';

/**
 * npc id → 中文名。模块级建一次：对话框每次翻页都重渲染，
 * 没必要在渲染里 `NPCS.find()`（14 个 NPC 里线性找，翻一页找一次）。
 *
 * 用显式循环而不是 `Object.fromEntries(NPCS.map(n => [n.id, n.name]))`：
 * 后者 `map` 推出来的是 `string[][]` 而不是元组数组，会落到 `fromEntries` 的
 * `any` 重载上，类型就丢了。这里要的是一个确定能查的 `Record<string, string>`。
 */
const NPC_NAME: Record<string, string> = {};
for (const n of NPCS) NPC_NAME[n.id] = n.name;

/** 台词样式统一走这里。行高 1.9 是给中文长句留的呼吸位，17px 保证「纯文字」也读得舒服。 */
const LINE: CSSProperties = {
    fontSize: 17,
    lineHeight: 1.9,
    color: '#ffffff',
    textShadow: '0 2px 8px rgba(0,0,0,0.55)',
    // 台词长短不定，但对话框高度别跟着跳 —— 玩家视线在屏幕底部，跳一次就要重新找一次
    minHeight: 64,
};

export function DialogBox() {
    const dialog = useGameStore2((s) => s.dialog);
    const nextDialogLine = useGameStore2((s) => s.nextDialogLine);

    /* 滚轮翻页的节流闸（见 `onWheel` 的注释）。
       用 ref 而不是 state：这个值不参与渲染，进 state 只会多一次无用重渲染；
       而且 state 是异步生效的，同一帧里连发的 wheel 事件读到的还是旧值。 */
    const wheelAtRef = useRef(0);

    useEffect(() => {
        // 没对话时不挂监听 —— 空转的 keydown 处理器没必要存在
        if (!dialog) return;

        const onKey = (e: KeyboardEvent) => {
            if (e.repeat || e.code !== 'KeyF') return;
            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;

            // 捕获阶段截胡：preventDefault 挡浏览器默认，stopPropagation 挡住 interact.ts 的冒泡监听
            e.preventDefault();
            e.stopPropagation();
            nextDialogLine();
        };

        // 第三个参数 true = 捕获阶段，这是「F 只翻页、不误触互动」的关键，别改
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [dialog, nextDialogLine]);

    if (!dialog) return null;

    const total = dialog.lines.length;
    // line 越界时兜底成最后一行 —— 状态机不该出现这种情况，但显示空白比报错强
    const idx = Math.min(Math.max(dialog.line, 0), total - 1);
    const text = dialog.lines[idx] ?? '';
    const isLast = idx >= total - 1;
    const speaker = NPC_NAME[dialog.npc] ?? dialog.npc;

    return (
        <div
            style={{
                position: 'fixed',
                left: '8%',
                right: '8%',
                bottom: '6%',
                pointerEvents: 'auto', // UI.tsx 根节点是 none，这里显式打开才能接住点击/滚轮
                userSelect: 'none',
                zIndex: 40, // 压在 InteractHint(30) 之上：对话时不该再看见「按 F」提示条
            }}
        >
            {/* 进场：从下方滑入 + 淡入。keyframes 写在组件里，不污染全局样式表 */}
            <style>{`
                @keyframes dlgIn {
                    from { opacity: 0; transform: translateY(18px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
                @keyframes dlgBlink {
                    0%, 55%   { opacity: 1; }
                    70%, 100% { opacity: 0.18; }
                }
            `}</style>

            <div
                onClick={nextDialogLine}
                /* ⚠️ 滚轮翻页的三个保险（2026-10-17 修）：
                   ① **阈值** —— 触控板/某些鼠标一"格"只有 ±1~3，且会先来一串 deltaY≈0 的
                      过渡事件；原来的 `if (e.deltaY > 0)` 连 0.0001 都算「向下滚」。
                      现在要求一次真正的滚动信号（|deltaY| ≥ 8，取绝对值和 deltaMode 无关的量级）。
                   ② **节流** —— 触控板惯性滚动会在一秒内发几十个 wheel 事件，
                      原来每一个都翻一页 ⇒ **一滑就直接翻到底并把对话关掉**（实测投诉）。
                      现在 260 ms 内只认第一个。
                   ③ **preventDefault** —— 挡住浏览器把这次滚动当成页面滚动/缩放（缩放会改变
                      布局，让对话框跳位）。React 的 wheel 监听是可取消的，这里能生效。 */
                onWheel={(e) => {
                    if (Math.abs(e.deltaY) < 8) return;  // ① 阈值：忽略惯性尾部的零碎事件
                    const now = performance.now();
                    if (now - wheelAtRef.current < 260) return;  // ② 节流
                    wheelAtRef.current = now;
                    e.preventDefault();  // ③ 别让浏览器顺带滚页面
                    // 向下滚 = 下一页；向上滚不倒退（台词是线性的，回头没有意义）
                    if (e.deltaY > 0) nextDialogLine();
                }}
                style={{
                    position: 'relative',
                    padding: '18px 22px 22px',
                    borderRadius: 12,
                    background: 'rgba(12,14,22,0.82)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
                    cursor: 'pointer',
                    animation: 'dlgIn 0.26s ease-out both',
                }}
            >
                {/* 说话人：左上角小名牌。悬在边框上，视觉上把「谁在说」和「说了什么」分开 */}
                <div
                    style={{
                        position: 'absolute',
                        top: -13,
                        left: 18,
                        padding: '2px 12px',
                        borderRadius: 8,
                        background: 'rgba(20,24,36,0.96)',
                        border: '1px solid rgba(232,216,168,0.32)',
                        color: '#e8d8a8',
                        fontSize: 14,
                        fontWeight: 700,
                        letterSpacing: 0.5,
                        lineHeight: 1.6,
                    }}
                >
                    {speaker}
                </div>

                {/* 台词正文 —— 纯文字，没有立绘 */}
                <div style={LINE}>{text}</div>

                {/* 右下角翻页提示 */}
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: 6,
                        marginTop: 6,
                    }}
                >
                    <span
                        style={{
                            color: '#e8d8a8',
                            fontSize: 13,
                            lineHeight: 1,
                            animation: 'dlgBlink 1.15s ease-in-out infinite',
                        }}
                    >
                        ▼
                    </span>
                    <span style={{ fontSize: 12, color: '#9aa6bd' }}>
                        {isLast ? '点击 / F 结束' : '点击 / F 继续'}
                    </span>
                </div>

                {/* 页码：多行台词时给个「还剩多少」的进度感，也方便调试对不上文案的情况 */}
                {total > 1 && (
                    <div
                        style={{
                            position: 'absolute',
                            right: 22,
                            top: 14,
                            fontSize: 11,
                            color: 'rgba(154,166,189,0.75)',
                        }}
                    >
                        {idx + 1} / {total}
                    </div>
                )}
            </div>
        </div>
    );
}

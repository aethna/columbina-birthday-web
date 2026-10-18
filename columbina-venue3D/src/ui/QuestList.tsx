/**
 * QuestList —— 屏幕右侧的任务列表（可点选）。
 *
 * ── 为什么现在能点、能滚（★ 2026-10-18 用户 m00863 任务2/任务3）──────
 * 老版本这里钉死 `pointerEvents: 'none'`，理由是用户更早说过「除明确点名的两处，
 * 其余全走 F 键」。代价是 `overflowY: 'auto'` 成了**死代码**：滚轮事件直接穿透到
 * 画布，玩家根本滚不动这块面板。于是当时用「未完成最多 4 条 + 折一行计数」来兜底，
 * 委托阶段 15 条待办（1 总览 + 14 条委托）被折成 4 条 + 一句「还有 11 项未完成」——
 * 用户看到的正是这行「11 项」，以为后面的委托永远看不到了（任务2 的真实根因）。
 *
 * 本轮用户明确要求「点委托 → 世界里出箭头」，所以**列表行获得点击权**；
 * 既然要点击，就顺手把滚动也打开：整个面板只在**正文区**开放指针事件
 * （`pointerEvents: 'auto'` 只给滚动容器，不覆盖面板四周的空白），
 * 面板之外的画布拖拽照旧不受影响。这是用户本轮点名的例外，不是把 F 键规则作废。
 *
 * ── 为什么取整个 store 而不是选择器切片 ──────────────────────────────
 * 契约里 `questLines(s)` 的入参就是**整个** GameState。如果在选择器里调它，
 * 每次返回的都是新数组，zustand 的 `Object.is` 比较永远不等 —— React 会报
 * "The result of getSnapshot should be cached to avoid an infinite loop" 并疯狂重渲染。
 * 所以这里直接订阅整个 store（对象引用只在 `set` 时变），再用 useMemo 派生。
 * questStore 的变更全是低频玩家操作，这样最省心。
 *
 * ── 为什么从 top: 118px 起 ──────────────────────────────────────────
 * `ui/SideBar.tsx` 占了右上角 `top:10 / right:10` 的两个圆形按钮：
 * 每个约 44px 高（24px 图标 + 10px×2 内边距 + 边），加 10px 间距 → 底边落在 y≈108。
 * 所以从 118 起排，两块面板之间留 10px 呼吸位。
 *
 * ── 高度为什么是 `calc(100vh - 240px)` ──────────────────────────────
 * 老的 `calc(100vh - 150px)` 会让面板底边压到右下角的 `PhotoBar`（zIndex 55，
 * 贴底 14px、高约 44px，实际占到离底 ~58px）。现在面板要高到能滚 14 条委托，
 * 必须把这 58px + 12px 间隙让出来：240 = 118(顶部起点) + 39(标题区) + 58 + 间隙。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { questLines, useGameStore2 } from '../core/game/questStore';
import { QUESTS } from '../core/game/copy';
import { setQuestArrow } from './guideState';

/** 面板底色统一走这里，改主题色只改一处。 */
const CARD: CSSProperties = {
    background: 'rgba(12,14,22,0.62)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 10,
    padding: '10px 12px 12px',
    color: '#e6ebf5',
    fontSize: 13,
    lineHeight: 1.5,
    boxShadow: '0 6px 22px rgba(0,0,0,0.38)',
};

const MUTED: CSSProperties = { color: '#9aa6bd' };

/** 进度徽章：金色描边小胶囊，和 InteractHint 的「按 F」是同一套强调色。 */
const BADGE: CSSProperties = {
    flex: '0 0 auto',
    fontSize: 11,
    lineHeight: 1.45,
    color: '#e8d8a8',
    border: '1px solid rgba(232,216,168,0.34)',
    borderRadius: 6,
    padding: '0 6px',
    whiteSpace: 'nowrap',
};

/**
 * 滚动条样式（★ 2026-10-18 任务2）。
 *
 * 为什么非写不可：本轮 bug 的表象就是「用户不知道列表下面还有东西」。
 * 只加 `overflowY: 'auto'` 是不够的 —— 半透明深色面板上的原生滚动条默认几乎看不见，
 * 用户仍然会以为列表被截断了。所以把滚动条做成金色、加粗到 8px、轨道也留一点底色，
 * 让「还能往下滚」这件事**肉眼可见**。
 * 内联 style 写不了 `::-webkit-scrollbar`，只能挂一个 <style>；同时保留
 * `scrollbar-color/scrollbar-width` 给 Firefox / 新版 Chromium。
 */
const SCROLLBAR_CSS = `
.quest-scroll { scrollbar-width: thin; scrollbar-color: rgba(232,216,168,0.55) rgba(255,255,255,0.07); }
.quest-scroll::-webkit-scrollbar { width: 8px; }
.quest-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.06); border-radius: 4px; }
.quest-scroll::-webkit-scrollbar-thumb { background: rgba(232,216,168,0.55); border-radius: 4px; }
.quest-scroll::-webkit-scrollbar-thumb:hover { background: rgba(232,216,168,0.82); }
`;

export function QuestList() {
    // 无选择器订阅整个 store —— 理由见文件头（questLines 的入参就是整个 GameState）
    const s = useGameStore2();
    const lines = useMemo(() => questLines(s), [s]);

    const pending = lines.filter((l) => !l.done);
    const done = lines.filter((l) => l.done);

    /* ★ 2026-10-18 任务2：这里原来有 PENDING_MAX=4 / DONE_MAX=3 的截断。
     * 现在正文区可滚动，**一条都不折**：14 条委托全部列出，靠滚动看，
     * 也不再有「还有 N 项未完成」这种把信息藏起来的写法。
     * 已完成行本来就只有 3 条（委托逐条完成后直接从 lines 里被过滤掉了），不截也不会撑爆。 */

    /* 可点选的只有 `q1~q14`；`q_letter / q_quests / q_cake` 是流程总览行，点了没有意义。 */
    const questIds = useMemo(() => new Set(QUESTS.map((q) => q.id)), []);

    /* 当前箭头指向哪条委托。null = 全部收起。
     * 为什么用 useState 而不是直接读 `questArrowState`：本组件要点亮选中行，
     * 必须触发重渲染；模块级容器是给 `QuestArrow` 每帧读的，两边的用法正好互补。 */
    const [arrowId, setArrowId] = useState<string | null>(null);
    const [hoverId, setHoverId] = useState<string | null>(null);
    const [canScroll, setCanScroll] = useState(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    /* 选中态同步到模块容器 —— `QuestArrow` 在 useFrame 里读它，不经过 React。 */
    useEffect(() => {
        setQuestArrow(arrowId);
    }, [arrowId]);

    /* 组件卸载（例如整块 UI 被换掉）时把箭头收掉，免得留下一个指向空气的箭头。 */
    useEffect(() => () => setQuestArrow(null), []);

    /* 选中的那条交付完成后箭头会自动隐藏（见 QuestArrow），选中高亮也得跟着灭；
     * 这里顺手把本地状态清掉，免得玩家再点同名行时出现「点了却像没点」的错觉。 */
    const deliveredKey = s.delivered.join('|');
    useEffect(() => {
        if (arrowId && s.delivered.includes(arrowId)) setArrowId(null);
    }, [arrowId, deliveredKey, s.delivered]);

    /* 内容超高才显示「滚动查看全部」。
     * 用 ResizeObserver 会更稳，但这里行数变化必然伴随 re-render（lines 变），
     * 再挂一个 window resize 监听兜住窗口缩放就够了，别为一行提示加观察器。 */
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const measure = () => setCanScroll(el.scrollHeight - el.clientHeight > 4);
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [lines, arrowId]);

    /** 点同一条 = 收起；点另一条 = 切过去（单选，不是多选）。 */
    const toggleArrow = (id: string) => {
        setArrowId((cur) => (cur === id ? null : id));
    };

    return (
        <div
            style={{
                position: 'fixed',
                right: 12,
                top: 118,
                width: 264,
                // 面板四周保持穿透：只有下面那个滚动容器接管指针（见文件头）
                pointerEvents: 'none',
                userSelect: 'none',
                zIndex: 20, // 低于 SideBar 的 50，保证工具按钮永远压在最上面
            }}
        >
            <style>{SCROLLBAR_CSS}</style>
            <div style={CARD}>
                {/* 标题 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                        style={{
                            width: 3,
                            height: 12,
                            borderRadius: 2,
                            background: '#e8d8a8',
                            opacity: 0.85,
                        }}
                    />
                    <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>任务</span>
                    {canScroll && (
                        <span style={{ marginLeft: 'auto', fontSize: 11, ...MUTED }}>
                            滚动查看全部 ▾
                        </span>
                    )}
                </div>

                {/* 正文滚动区：唯一开放指针事件的地方 */}
                <div
                    ref={scrollRef}
                    className="quest-scroll"
                    style={{
                        marginTop: 6,
                        maxHeight: 'calc(100vh - 240px)',
                        overflowY: 'auto',
                        overflowX: 'hidden', // 只纵向滚；否则长标题会横着溢出，多出一条横向滚动条
                        pointerEvents: 'auto', // 只有这里接管鼠标：行可点、滚轮可滚
                        paddingRight: 4,
                        scrollbarWidth: 'thin',
                        scrollbarColor: 'rgba(232,216,168,0.55) rgba(255,255,255,0.07)',
                    }}
                >
                    {/* 未完成 */}
                    {pending.map((l) => {
                        const clickable = questIds.has(l.id);
                        const selected = arrowId === l.id;
                        const hovered = hoverId === l.id;
                        return (
                            <div
                                key={l.id}
                                onClick={clickable ? () => toggleArrow(l.id) : undefined}
                                onMouseEnter={clickable ? () => setHoverId(l.id) : undefined}
                                onMouseLeave={clickable ? () => setHoverId(null) : undefined}
                                title={clickable ? '点击在世界中标出目标；再点一次取消' : undefined}
                                style={{
                                    marginTop: 6,
                                    padding: '5px 6px',
                                    borderRadius: 7,
                                    cursor: clickable ? 'pointer' : 'default',
                                    /* 选中 = 金色左边条 + 淡金色底；和徽章/BADGE 同一支强调色，
                                     * 不再引入新颜色。 */
                                    background: selected
                                        ? 'rgba(232,216,168,0.14)'
                                        : hovered
                                            ? 'rgba(255,255,255,0.05)'
                                            : 'transparent',
                                    boxShadow: selected ? 'inset 2px 0 0 #e8d8a8' : 'none',
                                    transition: 'background 120ms linear',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                    <span
                                        style={{
                                            flex: '1 1 auto',
                                            fontWeight: 600,
                                            color: selected ? '#f3e6bf' : '#cfd6e6',
                                        }}
                                    >
                                        {l.title}
                                    </span>
                                    <span style={BADGE}>{l.progress}</span>
                                </div>
                                <div style={{ ...MUTED, fontSize: 12, marginTop: 2 }}>{l.desc}</div>
                            </div>
                        );
                    })}

                    {/* 已完成：每条压成一行（灰 + 删除线 + ✓）。
                        委托完成后已从 lines 里过滤掉，剩下 q_letter/q_quests/q_cake 三条。 */}
                    {done.length > 0 && (
                        <div
                            style={{
                                marginTop: 10,
                                paddingTop: 8,
                                borderTop: '1px solid rgba(255,255,255,0.08)',
                            }}
                        >
                            {done.map((l) => (
                                <div
                                    key={l.id}
                                    style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}
                                >
                                    <span style={{ flex: '0 0 auto', color: '#e8d8a8', fontSize: 12 }}>✓</span>
                                    <span
                                        style={{
                                            flex: '1 1 auto',
                                            fontSize: 12,
                                            color: '#8a93a8',
                                            textDecoration: 'line-through',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {l.title}
                                    </span>
                                    <span style={{ flex: '0 0 auto', fontSize: 11, color: '#8a93a8' }}>
                                        {l.progress}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

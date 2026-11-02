/**
 * M 键大地图 —— 全屏世界地图。
 *
 * 用户 m01512：「我们既然是地图种子，那么进入页面之后，整个地图哪里有什么就已经确定了，
 * 剩下的就是玩家走到哪，渲染规划好的景观。也因为这个原因，可以加入按 M 键显示大地图功能。」
 *
 * 所以这张图**不是**「走过才画出来」的探索图，而是把种子函数直接画出来 ——
 * 一进游戏就是完整的。玩家位置只是叠在上面的一枚指针。
 *
 * ── 视野分两档（★ 2026-11-02 第五十六轮，用户 m01743）──────────────────
 * 用户看过上一版后原话：「我要的不是地图中的地图，是在地图上显示就行。而且我之前做过，
 * 委托 NFC 整个地图分散，怎么还会挤在会场？」—— 两件事都要回应：
 *
 * ① **不再有「图中图」**。上一版在右下角另开一格「会场放大 ±78 m」来放 NPC，
 *    那是地图套地图，撤掉。现在 NPC 点直接画在**这张地图上**。
 *
 * ② **为什么整图上他们看着挤、以及怎么解决**：委托期 15 个 NPC 的真实落点由
 *    `NpcCrowd.npcStandSpots()` 决定，半径 **12–58 m**（按面积均匀散开，不是站成一圈），
 *    而世界是 **768 m** ⇒ 在整图上他们只占中心 **48 px** 的一小团。这不是位置算错，
 *    是尺度：会场草坪半径才 62 m（`core/worldRegions.ts`）。想在小地图上分辨谁在哪，
 *    唯一诚实的办法是**把视野收到会场**，而不是把点画得更大（那样位置就是假的）。
 *
 *    所以本组件有 `venue` / `world` 两档视野，按 **V** 切换：
 *      · `venue`（缺省）= 会场 ±80 m，每 texel 0.25 m，15 人一目了然；
 *      · `world`         = 全世界 768 m，每 texel 2.4 m，看整体地形与月球坑。
 *    两档都是**一张地图**，只是相机远近不同 —— 不是两张图拼在一起。
 *
 * ── 实现要点 ──────────────────────────────────────────────────────────
 * · 地图内容由 `core/worldMapBake.ts` 烘到离屏 canvas 并**常驻**（`bakes`），
 *   每次开图/切视野再贴到可见 canvas 上（修 BUG 的关键，见下）；
 * · `venue` 视角按 0.25 m/texel **单独重烘一块**（`bakeMapRegion`），
 *   不是把 2.4 m/texel 的整图拉大 10 倍（那样是马赛克）；只在第一次切过去时烘，约 0.5 s；
 * · 指针/坐标每帧用 rAF 更新，走的是 `ui/minimapState.ts`（和左上角小地图同一个数据源，
 *   不进 zustand —— 否则每秒 60 次 React 重渲染）；
 * · 世界是**环面**（`WORLD_SIZE = 768`），所以坐标行仍折回基本域 `[0, 768)`。
 *
 * ── 第五十六轮修掉的 BUG ───────────────────────────────────────────────
 * 「第一次开有图，关了再开一片空白」。根因是 `if (!open) return null` 会把 canvas 从
 * DOM 上卸掉，再开时是一张全新的空 canvas，而当时的 `startedRef` 早已是 true
 * （组件没卸载，只是子节点没了）⇒ effect 直接早退，新 canvas 永远没人画。
 * 现在烘焙结果存在离屏 canvas 里，每次 open 都 `drawImage` 贴一次。
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { bakeMapRegion, bakeWorldMapAsync, MAP_RES, VENUE_MAP_RES } from '../core/worldMapBake';
import { WORLD_SIZE } from '../core/worldWrap';
import { minimapState } from './minimapState';
import { getNpcMarks, npcMarkLayout, subscribeNpcMarks } from './npcMapState';
import { QNUM, QSTR } from '../core/utils/query';

/** DOM 里的显示边长（px）。太大在小屏上放不下，所以用 `min(76vh, 76vw)` 夹一下。 */
const BOX = 640;

/** 会场视野的半宽（米）。15 个 NPC 落在 r = 12–58 m，草坪半径 62 m，80 给边缘留余量。 */
const VENUE_HALF_M = 80;

type ViewId = 'venue' | 'world';

interface ViewSpec {
    /** 视野半宽（米）。 */
    half: number;
    /** 烘这张视野用的分辨率。 */
    res: number;
    /** 标题行。 */
    title: string;
    /** 每 texel 多少米（给用户看的「每格」）。 */
    cell: string;
}

const VIEWS: Record<ViewId, ViewSpec> = {
    venue: {
        half: VENUE_HALF_M,
        res: VENUE_MAP_RES,
        title: `会场 · 半径 ${VENUE_HALF_M} m`,
        cell: `${((VENUE_HALF_M * 2) / VENUE_MAP_RES).toFixed(2)} m`,
    },
    world: {
        half: WORLD_SIZE / 2,
        res: MAP_RES,
        title: `世界种子平面 ${WORLD_SIZE} × ${WORLD_SIZE} m`,
        cell: `${(WORLD_SIZE / MAP_RES).toFixed(1)} m`,
    },
};

/** 世界坐标 → 当前视野内的百分比（视野左/上是 `-half`）。 */
const pctOf = (v: number, half: number) => ((v + half) / (half * 2)) * 100;

export function WorldMap() {
    // ?map=1 一进页面就把地图摊开（无头截图脚本要用；平时按 M 开）
    const [open, setOpen] = useState(() => QNUM('map', 0)! > 0);
    // ?mapview=world 一进来就用整图视野（缺省是会场视野）
    /* ★ 2026-11-02 第五十七轮：NPC 已撒到 r 70~250 m，缺省必须看**整图**才找得到人；
     *   会场视野改成按 V 才切过去的近景。`?mapview=venue` 可强制一进来就用会场视野。 */
    const [view, setView] = useState<ViewId>(() => (QSTR('mapview') === 'venue' ? 'venue' : 'world'));
    const [progress, setProgress] = useState(0);
    const [baked, setBaked] = useState(false);

    /** 两档视野各自的烘焙结果（离屏 canvas，常驻）。见文件头「修掉的 BUG」。 */
    const bakes = useRef<Partial<Record<ViewId, HTMLCanvasElement>>>({});
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const markerRef = useRef<HTMLDivElement | null>(null);
    const coordRef = useRef<HTMLDivElement | null>(null);

    /** NPC 位置（`GameLayer` 写、本组件读）。没有 NPC 的阶段是空数组。 */
    const marks = useSyncExternalStore(subscribeNpcMarks, getNpcMarks);
    const markLayout = npcMarkLayout();

    /* ── 名字避让（第五十六轮）──
     * 会场视野里相邻 NPC 常只隔 3~8 px（空/派蒙 是同一站位偏出 0.6 m 的一对），
     * 光按序号奇偶上下错开仍会叠字（用户 m01811 截图上 派蒙/琳妮特、那维莱特/香菱 都压在一起）。
     * 这里做一次**贪心排布**：每个名字按「右侧、左侧、再上下推」的顺序试位置，
     * 取第一个与已占矩形（含所有圆点）都不相交的；全撞就退回第一个能放进框里的。
     * 坐标用地图像素（BOX = 640），与实际显示尺寸成比例，缩窗口也不会错位。 */
    const labelPlan = useMemo(() => {
        const plan = new Map<string, { side: 'left' | 'right'; dy: number }>();
        if (marks.length === 0) return plan;
        type R = { x0: number; y0: number; x1: number; y1: number };
        const taken: R[] = [];
        const NAME_H = 12;
        const nameW = (s: string) => s.length * 10 + 2; // 10 px 字号，CJK 一字约 10 px
        const hit = (b: R) =>
            taken.some((o) => b.x0 < o.x1 + 1 && b.x1 + 1 > o.x0 && b.y0 < o.y1 + 1 && b.y1 + 1 > o.y0);
        const halfNow = VIEWS[view].half;
        const cxOf = (x: number) => (pctOf(x, halfNow) / 100) * BOX;
        const cyOf = (z: number) => (pctOf(z, halfNow) / 100) * BOX;
        // 圆点先占位：8 px 见方，中心对齐点
        for (const m of marks) {
            const cx = cxOf(m.x), cy = cyOf(m.z);
            taken.push({ x0: cx - 4, y0: cy - 4, x1: cx + 4, y1: cy + 4 });
        }
        const DYS = [-7, 5, -19, 17];
        for (const m of marks) {
            const cx = cxOf(m.x), cy = cyOf(m.z);
            const w = nameW(m.name);
            let chosen: { side: 'left' | 'right'; dy: number; box: R } | null = null;
            let fallback: { side: 'left' | 'right'; dy: number; box: R } | null = null;
            for (const dy of DYS) {
                for (const side of (['right', 'left'] as const)) {
                    const x0 = side === 'right' ? cx + 8 : cx - 8 - w;
                    const box: R = { x0, y0: cy + dy, x1: x0 + w, y1: cy + dy + NAME_H };
                    if (box.x0 < 1 || box.x1 > BOX - 1) continue;
                    if (!hit(box)) { chosen = { side, dy, box }; break; }
                    if (!fallback) fallback = { side, dy, box };
                }
                if (chosen) break;
            }
            const pick = chosen ?? fallback;
            if (pick) { taken.push(pick.box); plan.set(m.id, { side: pick.side, dy: pick.dy }); }
        }
        return plan;
    }, [marks, view]);

    const spec = VIEWS[view];
    const half = spec.half;

    /* ── 探针（无头验收用，与 `__game` / `__npc` 同一套约定）─────────────
     * `ink()` 是「关了再开还显示不显示」的机器判据：读可见 canvas 里非空像素占比，
     * BUG 复现时它是 0（空白 canvas），修好后应接近 1。 */
    const openRef = useRef(open);
    openRef.current = open;
    const bakedRef = useRef(baked);
    bakedRef.current = baked;
    const viewRef = useRef<ViewId>(view);
    viewRef.current = view;
    useEffect(() => {
        const w = window as unknown as { __map?: unknown };
        w.__map = {
            open: () => openRef.current,
            baked: () => bakedRef.current,
            view: () => viewRef.current,
            layout: () => npcMarkLayout(),
            marks: () => getNpcMarks().map((m) => ({ id: m.id, name: m.name, x: m.x, z: m.z })),
            /** 可见 canvas 的「有内容像素」占比（0–1）。空白 = 0。 */
            ink: () => {
                const c = canvasRef.current;
                if (!c) return -1;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                if (!ctx) return -1;
                const d = ctx.getImageData(0, 0, c.width, c.height).data;
                let on = 0;
                const total = c.width * c.height;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] > 0 && (d[i] | d[i + 1] | d[i + 2]) !== 0) on++;
                }
                return total ? on / total : 0;
            },
            bakeMs: () => (window as unknown as { __mapBakeMs?: unknown }).__mapBakeMs ?? null,
        };
        return () => { delete w.__map; };
    }, []);

    /* ── M 键开合 / V 键切视野 / Esc 关 ── */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.repeat) return;
            const k = e.key.toLowerCase();
            if (k === 'm') { setOpen((v) => !v); }
            else if (k === 'v' && open) { setView((v) => (v === 'venue' ? 'world' : 'venue')); }
            else if (k === 'escape' && open) { setOpen(false); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    /* ── 每次打开 / 换视野：有常驻副本就贴，没有就烘 ── */
    useEffect(() => {
        if (!open) return;
        const c = canvasRef.current;
        if (!c) return;
        const blit = (src: HTMLCanvasElement) => {
            c.width = src.width;
            c.height = src.height;
            const ctx = c.getContext('2d');
            if (!ctx) return;
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, c.width, c.height);
            ctx.drawImage(src, 0, 0);
        };
        const cached = bakes.current[view];
        if (cached) {
            /* ★ 关掉再开：canvas 是新的空元素，必须重贴一次。这就是 BUG 的修法。 */
            blit(cached);
            setBaked(true);
            setProgress(1);
            return;
        }
        setBaked(false);
        if (view === 'world') {
            const buf = document.createElement('canvas');
            const cancel = bakeWorldMapAsync(
                buf,
                (p) => setProgress(p),
                () => {
                    bakes.current.world = buf;
                    blit(buf);
                    setBaked(true);
                    setProgress(1);
                },
            );
            return cancel;
        }
        /* 会场视野：同步烘一块 640²（0.25 m/texel），约 0.5 s，一次性。 */
        const buf = document.createElement('canvas');
        bakeMapRegion(buf, 0, 0, VENUE_HALF_M, VENUE_MAP_RES);
        bakes.current.venue = buf;
        blit(buf);
        setBaked(true);
        setProgress(1);
        return;
    }, [open, view]);

    /* ── 指针 / 坐标：rAF 直改 DOM，不触发 React 重渲染 ── */
    useEffect(() => {
        if (!open) return;
        let raf = 0;
        const step = () => {
            const st = minimapState;
            const h = VIEWS[viewRef.current].half;
            const mx = markerRef.current;
            if (mx) {
                /* 用百分比而不是 px：地图盒子的实际边长是 `min(640px, 76vh, 76vw)`，
                 * 写死 640 会在小屏/窗口变小时把指针推歪。
                 * 会场视野下玩家可能站在视野外（月球坑）⇒ 贴到边上并变淡，用方向暗示位置。 */
                const rawX = pctOf(st.x, h);
                const rawZ = pctOf(st.z, h);
                const off = rawX < 2 || rawX > 98 || rawZ < 2 || rawZ > 98;
                mx.style.display = 'block';
                mx.style.left = `${Math.min(98, Math.max(2, rawX))}%`;
                mx.style.top = `${Math.min(98, Math.max(2, rawZ))}%`;
                mx.style.opacity = off ? '0.4' : '1';
                // 地图上：+X 向右、+Z 向下 ⇒ 与屏幕坐标同向，不用翻转。
                // `yaw` 定义：0 = 正北（世界 -Z），顺时针为正 ⇒ CSS 的 rotate 就是它。
                mx.style.transform = `translate(-50%, -50%) rotate(${st.yaw}rad)`;
            }
            const cd = coordRef.current;
            if (cd) {
                const wx = ((st.x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
                const wz = ((st.z % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
                const outX = Math.abs(st.x) > h || Math.abs(st.z) > h;
                cd.textContent = `X ${st.x.toFixed(0)}  Z ${st.z.toFixed(0)}　`
                    + `（环面格 ${wx.toFixed(0)}, ${wz.toFixed(0)} / ${WORLD_SIZE}）　`
                    + `${st.hour.toFixed(1)} 时　${st.region === 'moon' ? '月球' : '会场'}`
                    + (outX ? '　·　你在当前视野外（按 V 看整图）' : '');
            }
            raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [open]);

    if (!open) return null;

    const other: ViewId = view === 'venue' ? 'world' : 'venue';
    const px = (v: number) => pctOf(v, half);
    const insideView = (v: number) => v >= 0 && v <= 100;

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 30,
            background: 'rgba(6, 10, 14, 0.86)',
            backdropFilter: 'blur(3px)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
            color: '#dfe7e4',
            fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
        }}>
            <div style={{ fontSize: 15, letterSpacing: 2, opacity: 0.75, marginBottom: 10 }}>
                大地图 · {spec.title}（每格 {spec.cell}）
                {marks.length > 0 && (
                    <span style={{ marginLeft: 12, color: '#ffd9a8' }}>
                        NPC {marks.length} 人{markLayout === 'seat' ? '（宴会）' : '（委托）'}
                    </span>
                )}
                {marks.length === 0 && <span style={{ marginLeft: 12, opacity: 0.65 }}>NPC 未入场</span>}
                {!baked && <span style={{ marginLeft: 14, color: '#9bcaba' }}>
                    正在烘焙 {Math.round(progress * 100)}%
                </span>}
            </div>

            {/* 地图本体：canvas 按像素放大，用一个 aspect 盒把点/指针盖在上面 */}
            <div style={{
                position: 'relative',
                width: `min(${BOX}px, 76vh, 76vw)`,
                aspectRatio: '1 / 1',
                border: '1px solid rgba(155, 202, 186, 0.35)',
                borderRadius: 6,
                overflow: 'hidden',
                boxShadow: '0 18px 60px rgba(0,0,0,0.6)',
            }}>
                <canvas
                    ref={canvasRef}
                    width={spec.res}
                    height={spec.res}
                    style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated' }}
                />

                {/* 区域标注（视野外的自动不画） */}
                {insideView(px(0)) && insideView(px(0)) && (
                    <Label left={px(0)} top={px(0)} text="会场" tone="#ffd9a8" />
                )}
                {insideView(px(-196)) && (
                    <Label left={px(0)} top={px(-196)} text="月球" tone="#cfd6e6" />
                )}

                {/* ── NPC 位置（直接画在这张地图上，不是另开一格）── */}
                {marks.map((m) => {
                    const left = px(m.x);
                    const top = px(m.z);
                    if (!insideView(left) || !insideView(top)) return null;
                    /* 名字只在会场视野里画：整图上 15 个人只占中心 48 px，
                     * 名字必然叠成一团，画了反而看不清点在哪。 */
                    /* 两个视野都画名字：NPC 撒开之后整图上人和人隔 100~200 px，名字放得开
                     *（避让见上面的 labelPlan）。 */
                    const showName = true;
                    /* 名字位置由上面的 `labelPlan` 贪心算出（避让圆点与别的名字）。 */
                    const slot = labelPlan.get(m.id);
                    const nameStyle: CSSProperties = {
                        position: 'absolute', top: slot ? slot.dy : -14,
                        fontSize: 10, lineHeight: '11px', whiteSpace: 'nowrap',
                        color: '#f6ead6',
                        textShadow: '0 0 4px #000, 0 1px 2px #000',
                    };
                    if (slot ? slot.side === 'left' : m.x <= 0) nameStyle.right = 8;
                    else nameStyle.left = 8;
                    return (
                        <div
                            key={m.id}
                            data-npc={m.id}
                            style={{
                                position: 'absolute',
                                left: `${left}%`,
                                top: `${top}%`,
                                width: 0, height: 0,
                            }}
                        >
                            <div style={{
                                position: 'absolute', left: -4, top: -4,
                                width: 8, height: 8, borderRadius: 4,
                                background: '#ffd9a8',
                                boxShadow: '0 0 0 1px rgba(0,0,0,0.9), 0 0 6px rgba(255,217,168,0.85)',
                            }} />
                            {showName && <div style={nameStyle}>{m.name}</div>}
                        </div>
                    );
                })}

                {/* 玩家指针（一个朝上的三角形，用 CSS border 画） */}
                <div
                    ref={markerRef}
                    style={{
                        position: 'absolute', left: '50%', top: '50%', width: 0, height: 0,
                        willChange: 'transform',
                    }}
                >
                    <div style={{
                        position: 'absolute', left: -7, top: -9,
                        width: 0, height: 0,
                        borderLeft: '7px solid transparent',
                        borderRight: '7px solid transparent',
                        borderBottom: '16px solid #6ee7ff',
                        filter: 'drop-shadow(0 0 5px rgba(110,231,255,0.9))',
                    }} />
                </div>
            </div>

            <div ref={coordRef} style={{
                marginTop: 10, fontSize: 13, opacity: 0.8, fontVariantNumeric: 'tabular-nums',
            }} />

            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.55, lineHeight: 1.7, textAlign: 'center' }}>
                <span style={{ display: 'inline-block', width: 12, height: 12, background: '#93372c', verticalAlign: -2, marginRight: 4 }} />林地
                <span style={{ display: 'inline-block', width: 12, height: 12, background: '#6e363c', verticalAlign: -2, margin: '0 4px 0 14px' }} />密林
                <span style={{ display: 'inline-block', width: 12, height: 12, background: '#8f3c1a', verticalAlign: -2, margin: '0 4px 0 14px' }} />会场
                <span style={{ display: 'inline-block', width: 12, height: 12, background: '#8a8a92', verticalAlign: -2, margin: '0 4px 0 14px' }} />月球
                <span style={{ display: 'inline-block', width: 12, height: 12, background: '#c8a06a', verticalAlign: -2, margin: '0 4px 0 14px' }} />石板路
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: '#ffd9a8', verticalAlign: -0.5, margin: '0 4px 0 14px' }} />NPC
                <span style={{ display: 'inline-block', width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderBottom: '9px solid #6ee7ff', verticalAlign: -1, margin: '0 4px 0 14px' }} />你
                <div style={{ marginTop: 4 }}>
                    再按 <b>M</b> 或 <b>Esc</b> 关闭　·　按 <b>V</b> 切到「{VIEWS[other].title}」
                </div>
            </div>
        </div>
    );
}

/** 地图上的文字标注（位置由调用方按当前视野算好，视野外的由调用方不渲染）。 */
function Label({ left, top, text, tone }: { left: number; top: number; text: string; tone: string }) {
    return (
        <div style={{
            position: 'absolute',
            left: `${left}%`, top: `${top}%`,
            transform: 'translate(-50%, -50%)',
            fontSize: 13, fontWeight: 700, letterSpacing: 1,
            color: tone, textShadow: '0 0 6px rgba(0,0,0,0.95), 0 1px 2px rgba(0,0,0,1)',
            pointerEvents: 'none', userSelect: 'none',
        }}>{text}</div>
    );
}

/**
 * M 键大地图 —— 全屏世界地图。
 *
 * 用户 m01512：「我们既然是地图种子，那么进入页面之后，整个地图哪里有什么就已经确定了，
 * 剩下的就是玩家走到哪，渲染规划好的景观。也因为这个原因，可以加入按 M 键显示大地图功能。」
 *
 * 所以这张图**不是**「走过才画出来」的探索图，而是把种子函数直接画出来 ——
 * 一进游戏就是完整的。玩家位置只是叠在上面的一枚指针。
 *
 * 实现要点：
 * · 地图内容由 `core/worldMapBake.ts` 分帧烘到一张 320×320 的 canvas，**只烘一次**，缓存着；
 * · 指针/坐标每帧用 rAF 更新，走的是 `ui/minimapState.ts`（和左上角小地图同一个数据源，
 *   不进 zustand —— 否则每秒 60 次 React 重渲染）；
 * · 世界是**环面**（`WORLD_SIZE = 768`），所以指针坐标要折回基本域 `[0, 768)`。
 */

import { useEffect, useRef, useState } from 'react';
import { bakeWorldMapAsync, MAP_RES, MAP_M_PER_PX, toMapPx } from '../core/worldMapBake';
import { WORLD_SIZE } from '../core/worldWrap';
import { minimapState } from './minimapState';
import { QNUM } from '../core/utils/query';

/** DOM 里的显示边长（px）。太大在小屏上放不下，所以用 `min(76vh, 76vw)` 夹一下。 */
const BOX = 640;

export function WorldMap() {
    // ?map=1 一进页面就把地图摊开（无头截图脚本要用；平时按 M 开）
    const [open, setOpen] = useState(() => QNUM('map', 0)! > 0);
    const [progress, setProgress] = useState(0);
    const [baked, setBaked] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const markerRef = useRef<HTMLDivElement | null>(null);
    const coordRef = useRef<HTMLDivElement | null>(null);
    /** 烘过一次就留着，开关地图不再重算。 */
    const startedRef = useRef(false);

    /* ── M 键开合 ── */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.repeat) return;
            const k = e.key.toLowerCase();
            if (k === 'm') { setOpen((v) => !v); }
            else if (k === 'escape' && open) { setOpen(false); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    /* ── 第一次打开时开始烘 ── */
    useEffect(() => {
        if (!open || startedRef.current) return;
        const c = canvasRef.current;
        if (!c) return;
        startedRef.current = true;
        const cancel = bakeWorldMapAsync(
            c,
            (p) => setProgress(p),
            () => { setBaked(true); setProgress(1); },
        );
        return cancel;
    }, [open]);

    /* ── 指针 / 坐标：rAF 直改 DOM，不触发 React 重渲染 ── */
    useEffect(() => {
        if (!open) return;
        let raf = 0;
        const step = () => {
            const st = minimapState;
            const mx = markerRef.current, cd = coordRef.current;
            if (mx) {
                const px = (toMapPx(st.x) / MAP_RES) * BOX;
                const pz = (toMapPx(st.z) / MAP_RES) * BOX;
                // 地图上：+X 向右、+Z 向下 ⇒ 与屏幕坐标同向，不用翻转。
                // `yaw` 定义：0 = 正北（世界 -Z），顺时针为正 ⇒ CSS 的 rotate 就是它。
                mx.style.transform = `translate(${px}px, ${pz}px) rotate(${st.yaw}rad)`;
            }
            if (cd) {
                const wx = ((st.x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
                const wz = ((st.z % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
                cd.textContent = `X ${st.x.toFixed(0)}  Z ${st.z.toFixed(0)}　`
                    + `（环面格 ${wx.toFixed(0)}, ${wz.toFixed(0)} / ${WORLD_SIZE}）　`
                    + `${st.hour.toFixed(1)} 时　${st.region === 'moon' ? '月球' : '会场'}`;
            }
            raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [open]);

    if (!open) return null;

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
                大地图 · 世界种子平面（{WORLD_SIZE} × {WORLD_SIZE} m，每格 {MAP_M_PER_PX.toFixed(1)} m）
                {!baked && <span style={{ marginLeft: 14, color: '#9bcaba' }}>
                    正在烘焙 {Math.round(progress * 100)}%
                </span>}
            </div>

            {/* 地图本体：canvas 按像素放大，用一个 aspect 盒把指针盖在上面 */}
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
                    width={MAP_RES}
                    height={MAP_RES}
                    style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated' }}
                />

                {/* 区域标注 */}
                <Label x={0} z={0} text="会场" tone="#ffd9a8" />
                <Label x={0} z={-196} text="月球" tone="#cfd6e6" />

                {/* 玩家指针（一个朝上的三角形，用 CSS border 画） */}
                <div
                    ref={markerRef}
                    style={{
                        position: 'absolute', left: 0, top: 0, width: 0, height: 0,
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
                <div style={{ marginTop: 4 }}>
                    再按 <b>M</b> 或 <b>Esc</b> 关闭　·　地图按种子函数生成，进游戏时就已经是完整的
                </div>
            </div>
        </div>
    );
}

/** 地图上的文字标注（坐标是**世界坐标**，环面折回后定位）。 */
function Label({ x, z, text, tone }: { x: number; z: number; text: string; tone: string }) {
    const left = (toMapPx(x) / MAP_RES) * 100;
    const top = (toMapPx(z) / MAP_RES) * 100;
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

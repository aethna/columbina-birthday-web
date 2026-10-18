/**
 * MiniMap —— 左上角小地图 + 方向指示。
 *
 * ── 为什么是「纯 DOM canvas + 每帧重画」──────────────────────────────
 * 世界是无限的（草和地面都是跟着相机跳格的跑步机），但**分区是有限的圆盘**：
 * 会场 r=62、月球 r=120@(0,-170)、浅海 r=120@(170,0)。
 * 所以小地图只要画「三个圆盘 + 玩家点 + 朝向」就够了 —— 不需要瓦片、不需要流式。
 *
 * 数据从 `ui/minimapState.ts` 读（由 `components/MiniMapProbe.tsx` 在 Canvas 内每帧写）。
 * 用 rAF 自己驱动，30 fps 够了：小地图比主画面慢一半，肉眼完全看不出来，CPU 省一半。
 *
 * ── 坐标系 ──────────────────────────────────────────────────────────
 * **北朝上、世界固定**（不是跟着玩家转）。玩家永远是画布正中的白点，
 * 外加一个扇形视锥表示相机朝向。这样「月球在哪个方向」一眼就能读出来 ——
 * 这是「方向指示」真正要回答的问题。世界 -Z = 北，世界 +X = 东。
 *
 * ── 任务指引（用户追加需求）────────────────────────────────────────
 * 用户原话：「（这里应有指引。可以在小地图指引书桌位置，书桌可以有发光点标识，后续委托指引同样）」。
 * 所以除了「我在哪」，小地图还要回答「**接下来该往哪走**」：
 * 目标在视野内就画一个脉动的金环（发光点标识），超出视野就把金三角夹在圆边指着它，
 * 再在下方补一行「→ 书桌」。目标从 `ui/guideState.ts` 读 ——
 * 同样走纯模块对象，因为它也是被 rAF 每帧读的，进 React store 只会白白重渲染。
 * 由 `components/game/GameLayer.tsx` 决定当前目标是哪个并调用 `setGuide(...)`，
 * 小地图不认识任务系统，只负责「给我一个坐标，我把它画出来」。
 */
import { useEffect, useRef } from 'react';
import { REGIONS } from '../core/worldRegions';
import { minimapState } from './minimapState';
import { guideState } from './guideState';

const SIZE = 168;          // 圆形地图的 CSS 边长
const HUD_H = 30;          // 下面那两行字的预留高度
const GUIDE_H = 20;        // 第三行「→ 书桌」单独占的高度
const VIEW_R = 90;         // 圆边代表的世界半径（米）—— 站在会场刚好能看见月球边缘
const PAD = 6;
/** 任务指引专用色：跟 HUD 的冷白/浅蓝刻意拉开，扫一眼就知道「这是任务，不是背景信息」 */
const GUIDE_GOLD = '#e8d8a8';

const REGION_LABEL: Record<string, string> = {
    venue: '会场',
    moon: '月球',
};

/** `#rrggbb` → `rgba(...)`。小地图的颜色直接借区域自己的地面色，天然对得上主画面。 */
function hexA(hex: string, a: number): string {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    if (!Number.isFinite(n)) return `rgba(255,255,255,${a})`;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function MiniMap() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        // 总高 = 圆盘 SIZE + 原有两行读数 HUD_H + 指引行 GUIDE_H。
        // 加高只加在**最下面**：圆形地图仍在 (0,0)-(SIZE,SIZE) 内，
        // 所以上面的「会场/月球」区域标签、四向刻度、玩家点全部不受影响，
        // 原来 HUD_H 那两行的 y 也一个字没动 —— 只是 canvas 底部多出 20px。
        const H = SIZE + HUD_H + GUIDE_H;
        canvas.width = SIZE * dpr;
        canvas.height = H * dpr;

        const cx = SIZE / 2;
        const cy = SIZE / 2;
        const R = SIZE / 2 - PAD;
        const s = R / VIEW_R;

        let raf = 0;
        let last = -1e9;

        const draw = () => {
            raf = requestAnimationFrame(draw);
            const now = performance.now();
            if (now - last < 33) return;   // ~30 fps
            last = now;

            const st = minimapState;
            if (!st.ready) return;
            const px = st.x;
            const pz = st.z;

            // 世界 → 画布：北（世界 -Z）朝上 ⇒ z 越大越靠下
            const mx = (wx: number) => cx + (wx - px) * s;
            const my = (wz: number) => cy + (wz - pz) * s;

            // ── 任务指引的几何，先算一次 ──────────────────────────────
            // 两个绘制点（环在 clip 内、箭头在 clip 外）都要用，所以在这里统一算好。
            // 投影**直接复用上面那套 mx/my**，不另推一套公式 —— 否则小地图上
            // 的指引点和地形会慢慢对不上（两套换算迟早会写歪）。
            const gt = guideState.target;
            let gtx = 0;
            let gty = 0;
            let gdist = 0;
            let gpulse = 0;
            if (gt) {
                gtx = mx(gt.x);
                gty = my(gt.z);
                gdist = Math.hypot(gtx - cx, gty - cy);
                // 相位 0~1：半径 5~9 px 呼吸。用 performance.now() 而不是帧计数，
                // 这样掉帧时脉动也不会变慢，节奏始终一致。
                gpulse = 0.5 + 0.5 * Math.sin(now * 0.004);
            }
            // 留 3px 余量：环本身有半径，贴边会被圆裁掉一半，看着像画错了
            const gInView = !!gt && gdist <= R - 3;

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, SIZE, H);

            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, R, 0, Math.PI * 2);
            ctx.clip();

            ctx.fillStyle = 'rgba(6, 10, 16, 0.78)';
            ctx.fillRect(0, 0, SIZE, SIZE);

            // 50 米网格：给「走多远」一个尺子
            ctx.strokeStyle = 'rgba(150, 185, 220, 0.11)';
            ctx.lineWidth = 1;
            const G = 50;
            for (let x = Math.floor((px - VIEW_R) / G) * G; x <= px + VIEW_R; x += G) {
                const gx = Math.round(mx(x)) + 0.5;
                ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, SIZE); ctx.stroke();
            }
            for (let z = Math.floor((pz - VIEW_R) / G) * G; z <= pz + VIEW_R; z += G) {
                const gy = Math.round(my(z)) + 0.5;
                ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(SIZE, gy); ctx.stroke();
            }

            // 三个区域圆盘
            for (const d of REGIONS) {
                const rx = mx(d.cx);
                const ry = my(d.cz);
                const rr = d.r * s;
                ctx.beginPath();
                ctx.arc(rx, ry, rr, 0, Math.PI * 2);
                ctx.fillStyle = hexA(d.ground, 0.32);
                ctx.fill();
                ctx.strokeStyle = hexA(d.ground, 0.85);
                ctx.lineWidth = 1.4;
                ctx.stroke();

                // 圆心在视野里才写名字，免得贴着边缘糊一半
                if (rx > 16 && rx < SIZE - 16 && ry > 12 && ry < SIZE - 12) {
                    ctx.font = '600 10px system-ui, "Microsoft YaHei", sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    const label = REGION_LABEL[d.id] ?? d.id;
                    ctx.fillStyle = 'rgba(0,0,0,0.55)';
                    ctx.fillText(label, rx + 0.7, ry + 0.7);
                    ctx.fillStyle = 'rgba(235,245,255,0.95)';
                    ctx.fillText(label, rx, ry);
                }
            }

            // 边缘暗角：让「世界还没走到」这件事有观感
            const vig = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
            vig.addColorStop(0, 'rgba(0,0,0,0)');
            vig.addColorStop(1, 'rgba(0,0,0,0.55)');
            ctx.fillStyle = vig;
            ctx.fillRect(0, 0, SIZE, SIZE);

            // ── 任务目标：在视野内 → 脉动金环（发光点标识）──────────────
            // 放在暗角**之后**画：暗角会把靠近圆边的目标压暗，而任务点恰恰
            // 经常在边上 —— 先画就白画了。所以指引永远是最亮的一层。
            if (gt && gInView) {
                // 外圈光晕：给「发光」一点体积，不然只是个几何圆
                ctx.beginPath();
                ctx.arc(gtx, gty, 9 + gpulse * 5, 0, Math.PI * 2);
                ctx.fillStyle = hexA(GUIDE_GOLD, 0.10 + 0.10 * gpulse);
                ctx.fill();

                // 脉动环：半径 5~9 呼吸
                ctx.beginPath();
                ctx.arc(gtx, gty, 5 + gpulse * 4, 0, Math.PI * 2);
                ctx.strokeStyle = GUIDE_GOLD;
                ctx.lineWidth = 2;
                ctx.stroke();

                // 内点：环心实心，保证在任何地形色上都读得出「这里有个点」
                ctx.beginPath();
                ctx.arc(gtx, gty, 2.2, 0, Math.PI * 2);
                ctx.fillStyle = GUIDE_GOLD;
                ctx.fill();
                ctx.strokeStyle = 'rgba(20,26,38,0.85)';
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            // 视锥（相机朝向）：yaw 的零点是北，画布角度零点是东 ⇒ 减 90°
            const a0 = st.yaw - Math.PI / 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, R * 0.42, a0 - 0.55, a0 + 0.55);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255,255,255,0.16)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.30)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // 玩家
            ctx.beginPath();
            ctx.arc(cx, cy, 3.4, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = 'rgba(20,30,45,0.9)';
            ctx.lineWidth = 1.2;
            ctx.stroke();

            ctx.restore();

            // 外圈 + 四向刻度
            ctx.beginPath();
            ctx.arc(cx, cy, R, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(180, 212, 245, 0.55)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.font = '700 9px system-ui, "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const marks: [string, number, number, string][] = [
                ['北', cx, PAD + 7, '#ff7d6b'],
                ['南', cx, SIZE - PAD - 7, 'rgba(210,228,250,0.75)'],
                ['东', SIZE - PAD - 7, cy, 'rgba(210,228,250,0.75)'],
                ['西', PAD + 7, cy, 'rgba(210,228,250,0.75)'],
            ];
            for (const [t, tx, ty, col] of marks) {
                ctx.fillStyle = col;
                ctx.fillText(t, tx, ty);
            }

            // ── 任务目标：在视野外 → 夹在圆边上的金色三角箭头 ──────────
            // 为什么不用「脉动环 + 裁切」：目标离得远时环会被圆裁掉，只剩一道弧，
            // 看不出方向。箭头是「目标在那个方位、还要走很远」的正确表达。
            // 画在 clip 之外（已经 restore），否则贴在边缘的三角会被圆切平。
            if (gt && !gInView) {
                // 从玩家指向目标的方向 —— 和视锥用同一套画布角度（东为 0、顺时针为正）
                const ang = Math.atan2(gty - cy, gtx - cx);
                // 半径再收 11px：让 9px 的三角完整落在圆内，不压到外圈刻度
                const ar = R - 11;
                const ax = cx + Math.cos(ang) * ar;
                const ay = cy + Math.sin(ang) * ar;
                const dx = Math.cos(ang);
                const dy = Math.sin(ang);
                // 垂直方向，用来张开三角的两个后角（后角间距正好 9px）
                const ox = -dy;
                const oy = dx;

                ctx.beginPath();
                ctx.moveTo(ax + dx * 5.5, ay + dy * 5.5);
                ctx.lineTo(ax - dx * 3.5 + ox * 4.5, ay - dy * 3.5 + oy * 4.5);
                ctx.lineTo(ax - dx * 3.5 - ox * 4.5, ay - dy * 3.5 - oy * 4.5);
                ctx.closePath();
                // 先描深色边：浅色地形（月球灰白、会场亮地砖）上纯金色会糊掉
                ctx.strokeStyle = 'rgba(20,26,38,0.9)';
                ctx.lineWidth = 1.6;
                ctx.stroke();
                ctx.fillStyle = GUIDE_GOLD;
                ctx.fill();
            }

            // ── 下面两行读数 ──
            const label = REGION_LABEL[st.region] ?? st.region;
            const hh = Math.floor(st.hour) % 24;
            const mm = Math.floor((st.hour % 1) * 60);
            const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.font = '600 11px system-ui, "Microsoft YaHei", sans-serif';
            ctx.fillStyle = 'rgba(235,245,255,0.95)';
            ctx.fillText(`${label}  x${px.toFixed(0)} z${pz.toFixed(0)}`, 2, SIZE + 2);

            // 另外两个区域还有多远 —— 「方向指示」真正要回答的问题
            const others = REGIONS
                .filter((d) => d.id !== st.region)
                .map((d) => ({ d, dist: Math.hypot(d.cx - px, d.cz - pz) - d.r }))
                .sort((a, b) => a.dist - b.dist);
            const hint = others
                .map((o) => `${REGION_LABEL[o.d.id]}${o.dist <= 0 ? '到了' : `${o.dist.toFixed(0)}m`}`)
                .join(' · ');
            ctx.font = '500 10px system-ui, "Microsoft YaHei", sans-serif';
            ctx.fillStyle = 'rgba(180,208,238,0.85)';
            ctx.fillText(hint, 2, SIZE + 15);

            ctx.textAlign = 'right';
            ctx.font = '600 11px system-ui, "Microsoft YaHei", sans-serif';
            ctx.fillStyle = st.dayness > 0.35 ? '#ffd884' : '#9fc4f0';
            ctx.fillText(clock, SIZE - 2, SIZE + 2);

            // ── 第三行：任务指引文字 ─────────────────────────────────
            // 画在 HUD_H 之下（y = SIZE + HUD_H + 2 = 200），**单独占 20px 的条**，
            // 和上面「会场 x0 z0」/「月球 170m」两行完全错开，不抢位置。
            // 居中：文字是这一行的主角，左对齐会跟上面的坐标读数连成一片。
            if (gt) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.font = '12px system-ui, "Microsoft YaHei", sans-serif';
                const gtext = `→ ${gt.label}`;
                // 先描深色边再填色：小地图下方的背景是 3D 场景（可能很亮），
                // 纯金色文字直接填会看不清 —— 描边保证任何背景上都读得出来。
                ctx.strokeStyle = 'rgba(0,0,0,0.85)';
                ctx.lineWidth = 3;
                ctx.lineJoin = 'round';
                ctx.strokeText(gtext, cx, SIZE + HUD_H + 2);
                ctx.fillStyle = GUIDE_GOLD;
                ctx.fillText(gtext, cx, SIZE + HUD_H + 2);
            }
        };

        draw();
        return () => cancelAnimationFrame(raf);
    }, []);

    return (
        <div style={{
            position: 'absolute',
            left: 16,
            top: 16,
            pointerEvents: 'none',
            userSelect: 'none',
            filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.45))',
        }}>
            <canvas
                ref={canvasRef}
                style={{ width: SIZE, height: SIZE + HUD_H + GUIDE_H, display: 'block' }}
            />
        </div>
    );
}

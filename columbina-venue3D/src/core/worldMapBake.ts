/**
 * M 键大地图 —— 世界纹理烘焙器。
 *
 * ## 为什么用 CPU 逐 texel 烘、而不是 GPU 离屏渲染
 * `路线A-webgpu/_logs/森林规划调研.md` 第 6 节建议「GPU 离屏烘 768² 再读回」。
 * 实际做的时候发现 WebGPU 下 `readRenderTargetPixels` 是**异步**的，
 * 而且烘一次就要一张 768² 的 RT，为了「按 M 才看一眼」的 UI 不值当。
 *
 * 改走 CPU 之后，**分帧渐进**就变得很自然：把行切成小批，用 `setTimeout(0)` 一批一批填，
 * 地图会从左上角「长」出来，主线程一秒都不卡。
 *
 * ⚠️ 这里**只调用 CPU 那套函数**（`worldHeightCPU` / `forestWeight` / `onPath` …），
 *    不碰 GPU。所以它天然和游戏里的地形、植被、路网一致 —— 这正是「地图种子确定了
 *    整个地图哪里有什么」那句话的字面实现：**地图不是画出来的，是把种子函数画出来**。
 *
 * ## 分辨率
 * `MAP_RES = 320` ⇒ 一格 `WORLD_SIZE / 320 = 2.4 m`。
 * 一个 texel 要跑一次 `worldHeightCPU`（它内部有 FBM + 丘陵 + 环形山 + 区域权重），
 * 实测整张图约 0.3~0.6 s，分 20 批填完。再高就会卡得看得出来，再低路网会断线。
 */

import { WORLD_SIZE, tdiff } from './worldWrap';
import { worldHeightCPU, forestWeight, regionWeights, REGION_BY_ID } from './worldRegions';
import { forestDensity, onPath } from './forest';

/** 烘焙分辨率（正方形，覆盖整个 `WORLD_SIZE`）。 */
export const MAP_RES = 320;
/** 每 texel 代表多少米。 */
export const MAP_M_PER_PX = WORLD_SIZE / MAP_RES;

/**
 * 把世界坐标折进地图的基本域并换算成像素。
 *
 * ⚠️ **不是直接 `mod W`** —— 那样会场（世界原点 0,0）会正好落在**地图左上角**，
 * 被边框切掉一半（实机截图里「场」字是半个的）。所以先把原点平移到
 * `WORLD_SIZE/2`：会场落到地图正中，月球（0,-196）落到中上偏左，
 * 而地图的「接缝」被推到离会场 384 m 的边上 —— 那里正是基础 FBM 不周期
 * 造成 ≤0.3 m 高差的地方，本来就该藏起来。
 */
const MAP_SHIFT = WORLD_SIZE / 2;

export function toMapPx(v: number): number {
    const w = (((v + MAP_SHIFT) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
    return (w / WORLD_SIZE) * MAP_RES;
}

/* ── 调色板（与游戏里的地面色同族，见 `core/shaders/worldHeight.ts`） ──
 * ⚠️ 对比度要**故意给足**：地图是俯视缩略图，不是照片。
 *    第一版照搬了游戏里的地面色（稀疏 #93372c / 密林 #6e363c），
 *    两者只差 8% 亮度，实机截图整张图是一片看不出结构的红 —— 林窗、密林全糊了。
 *    现在稀疏用亮得多的 #b06848、密林用 #54282e，林分结构一眼可辨。 */
const C_FOREST_OPEN: [number, number, number] = [176, 104, 72];  // 疏林 / 林窗
const C_FOREST_DEEP: [number, number, number] = [84, 40, 46];    // 密林
const C_VENUE: [number, number, number] = [178, 96, 44];         // 会场草坪（比森林亮，才认得出这是一块『场地』）
const C_VENUE_PLAZA: [number, number, number] = [238, 208, 162]; // 会场中心的石台
const C_MOON: [number, number, number] = [196, 196, 206];        // 月壤（亮，才看得出环形山）
const C_MOON_DARK: [number, number, number] = [96, 96, 112];     // 环形山内
const C_PATH: [number, number, number] = [214, 178, 122];        // 土黄小路

function mix3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
    const u = t < 0 ? 0 : t > 1 ? 1 : t;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/**
 * 烘一张世界高度图（`MAP_RES²` 个 `Float32Array` 值，米）。
 * 单独一步是因为着色要用**邻居**算坡度，高度必须先全部就位。
 */
export function bakeHeights(): Float32Array {
    const N = MAP_RES;
    const out = new Float32Array(N * N);
    const step = WORLD_SIZE / N;
    for (let j = 0; j < N; j++) {
        const z = (j + 0.5) * step;
        const row = j * N;
        for (let i = 0; i < N; i++) {
            out[row + i] = worldHeightCPU((i + 0.5) * step, z);
        }
    }
    return out;
}

/**
 * 把高度 + 区域 + 植被 + 路网画进一张 `ImageData`。
 *
 * @param heights `bakeHeights()` 的结果
 * @param y0/y1   只画 `[y0, y1)` 这些行（分帧用）
 */
export function paintRows(heights: Float32Array, img: ImageData, y0: number, y1: number): void {
    const N = MAP_RES;
    const step = WORLD_SIZE / N;
    const d = img.data;
    const venue = REGION_BY_ID.venue, moon = REGION_BY_ID.moon;

    for (let j = y0; j < y1; j++) {
        const z = (j + 0.5) * step;
        for (let i = 0; i < N; i++) {
            const x = (i + 0.5) * step;
            const k = j * N + i;
            const o = k * 4;

            /* ① 底：按区域上色 */
            const w = regionWeights(x, z);
            const fw = 1 - Math.max(w.venue, w.moon); // 「无主地带」的强度
            let c: [number, number, number];
            if (w.venue > w.moon) {
                // 会场中心是石台，外圈是草坪
                const dv = Math.hypot(tdiff(x, venue.cx), tdiff(z, venue.cz));
                c = mix3(C_VENUE_PLAZA, C_VENUE, Math.min(1, dv / 26));
            } else {
                c = mix3(C_MOON_DARK, C_MOON, Math.max(0, Math.min(1, (heights[k] + 6) / 12)));
            }
            if (fw > 0) {
                // 无主地带：林分密度越高的地方越深（就像从空中看树冠层）
                const dens = forestDensity(x, z);
                const forestFloor = mix3(C_FOREST_OPEN, C_FOREST_DEEP, (dens - 0.7) / 0.3);
                c = mix3(c, forestFloor, fw);
            }

            /* ② 光照：用左/上邻居差分当坡度，光从西北上方来 —— 山脊亮、沟里暗 */
            const hL = heights[j * N + (i > 0 ? i - 1 : i)];
            const hU = heights[(j > 0 ? j - 1 : j) * N + i];
            const dx = (heights[k] - hL) / step;
            const dz = (heights[k] - hU) / step;
            // 光照系数 0.55 ~ 1.35
            const lit = 1 + (dx * 0.34 + dz * 0.34);
            const L = lit < 0.45 ? 0.45 : lit > 1.45 ? 1.45 : lit;

            /* ③ 路网：`onPath` 是等值线，画成浅土黄 */
            // ⚠️ 给 0.72 会把路画成一张盖满全图的迷宫（实机截图上林分结构全被压住）。
            //    石板路在游戏里只有约 3 m 宽，是**点缀**不是主体，地图上压低到 0.42。
            const pathMix = onPath(x, z) ? 0.42 : 0;

            /* ④ 森林覆盖：`forestWeight` 内（场地附近）不画树点，
                   真正的「林地」用密度场抖出来的一片深色来暗示；
                   这里简单地在密林处再压暗 12%，让林窗看得出来 */
            const dark = fw > 0.02 ? 1 - 0.12 * (forestDensity(x, z) - 0.7) / 0.3 : 1;

            let r = c[0] * L * dark, g = c[1] * L * dark, b = c[2] * L * dark;
            if (pathMix > 0) {
                r = r + (C_PATH[0] - r) * pathMix;
                g = g + (C_PATH[1] - g) * pathMix;
                b = b + (C_PATH[2] - b) * pathMix;
            }
            d[o] = r < 0 ? 0 : r > 255 ? 255 : r;
            d[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
            d[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
            d[o + 3] = 255;
        }
    }
}

/**
 * 烘焙到 `canvas`。
 *
 * ⚠️ **必须同步一口气烘完**，不能像第一版那样切成小批用 `setTimeout(0)` 分帧：
 * 无头浏览器（以及被切到后台的标签页）会把 `setTimeout` 节流到 1 次/秒甚至 1 次/分钟，
 * 结果实机截图里 20 秒过去地图才长出 5%。分帧的「不卡」是假的 ——
 * 实测整张图（320²）= 高度 90 ms + 上色 40 ms，**一次性烘完根本感觉不到**。
 *
 * @returns 取消函数（组件卸载时调；同步实现下是空操作，保留签名免得调用方改）
 */
export function bakeWorldMapAsync(
    canvas: HTMLCanvasElement,
    onProgress: (p: number) => void,
    onDone: () => void,
): () => void {
    const N = MAP_RES;
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d');
    if (!ctx) { onDone(); return () => { }; }

    const t0 = performance.now();
    const heights = bakeHeights();
    const t1 = performance.now();
    const img = ctx.createImageData(N, N);
    paintRows(heights, img, 0, N);
    ctx.putImageData(img, 0, 0);
    const t2 = performance.now();

    (window as any).__mapBakeMs = {
        res: N, heights: +(t1 - t0).toFixed(1), paint: +(t2 - t1).toFixed(1), total: +(t2 - t0).toFixed(1),
    };
    onProgress(1);
    onDone();
    return () => { };
}

/**
 * 拍照 —— 把当前画面抓成 PNG dataURL 存进相册（用户 m02820：合影功能常态化）。
 *
 * ── 为什么不用 `canvas.toDataURL()` 直接抓 ────────────────────────────
 * 场景跑在 **WebGPURenderer** 上（不是 WebGL）。WebGPU 的交换链纹理只在「当前任务」
 * 内有效，present 之后就作废；`toDataURL()` 各浏览器对 WebGPU canvas 的支持程度不一，
 * 实测有拿到空图的风险。
 * 稳妥路径是 `2D canvas.drawImage(webgpuCanvas, ...)` —— 这是规范里明确允许的
 * 「把一个 canvas 画到另一个 canvas」，浏览器内部会做一次 readback，
 * 顺带还能在这一步把尺寸缩到相册够用的分辨率（不缩的话每张 PNG 都是 1~3 MB，
 * 存十几张就把内存吃光）。
 *
 * ── 为什么要等一帧 ───────────────────────────────────────────────────
 * 拍照按钮是 DOM 上的点击事件，此刻画面可能刚被 R3F 重绘过、也可能还没。
 * 用 `requestAnimationFrame` 推到下一帧再抓，拿到的就是「已经画完」的那一帧。
 * （R3F 自己的渲染循环也是 rAF，注册得比我们早 ⇒ 同一帧里它先跑，我们后跑。）
 *
 * ── 为什么要挂一个空组件进 Canvas ───────────────────────────────────
 * 页面上不止一个 canvas（小地图 `MiniMap.tsx` 也是 canvas），
 * `document.querySelector('canvas')` 会抓错。所以在 Canvas 内部用
 * `useThree(s => s.gl).domElement` 把「真正的 3D 画布」登记到模块变量里。
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useGameStore2 } from '../../core/game/questStore';

/** 存进相册的宽度上限（px）。够看清楚，又不至于每张好几 MB。 */
const MAX_W = 960;

/**
 * JPEG 质量。0.82 是「肉眼看不出压缩痕迹」与「体积够小」的折中点。
 *
 * ★ 为什么用 JPEG 而不是 PNG（2026-10-15 改）：
 *   原来是 `toDataURL('image/png')` —— **无损**格式，960px 宽的 3D 场景截图
 *   每张 1~3 MB。60 张上限 ≈ **120 MB 常驻内存**，而且每张都是 base64 字符串
 *   （比二进制再大 33%），全部压在 zustand store 里，移动端会直接崩。
 *   同一帧换 JPEG q=0.82 大约 120~260 KB，**降到约 1/10**，
 *   而相册只是给人看「当时拍了什么」，不需要无损。
 */
const JPEG_Q = 0.82;

/** 真正的 3D 画布，由 `<PhotoSnap/>` 在 Canvas 内部登记。 */
let canvasEl: HTMLCanvasElement | null = null;
/** 上一次抓到的 dataURL 长度，给探针 `window.__photo.last()` 用（0 = 还没抓过）。 */
let lastLen = 0;

/**
 * 抓一帧。返回 dataURL；失败返回 `null`。
 *
 * 失败的两个已知情形：
 *   ① `<PhotoSnap/>` 还没挂上（`canvasEl` 是 null）—— 只在首帧之前可能发生；
 *   ② 浏览器拒绝从 WebGPU canvas readback（跨源/被策略拦），`drawImage` 抛异常。
 */
function grab(): string | null {
    if (!canvasEl) return null;
    const w = canvasEl.width;
    const h = canvasEl.height;
    if (w <= 0 || h <= 0) return null;

    const scale = Math.min(1, MAX_W / w);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));

    const ctx = out.getContext('2d');
    if (!ctx) return null;
    try {
        ctx.drawImage(canvasEl, 0, 0, out.width, out.height);
    } catch {
        /* 抓不到就老老实实说抓不到，别把一张空白图塞进相册 */
        return null;
    }

    /* ★ 先试 JPEG。`toDataURL('image/jpeg', q)` 在极老的环境下可能返回
     *   `data:image/png...`（浏览器忽略不认识的格式时回落），那时体积没省下来
     *   —— 但功能正常，不当作失败。 */
    try {
        return out.toDataURL('image/jpeg', JPEG_Q);
    } catch {
        /* 极少数环境 JPEG 编码器不可用，退回 PNG 至少保证功能可用 */
        try {
            return out.toDataURL('image/png');
        } catch {
            return null;
        }
    }
}

/**
 * 拍一张照，存进相册。**同步返回「有没有排上队」**（真正的抓取在下一帧完成）。
 *
 * 之所以不返回 Promise：调用方是 UI 的点击处理，它只关心「要不要弹『已拍照』提示」。
 * 等抓到再弹提示会慢半拍；而抓失败是极罕见情况，不值得为它把 UI 做成异步。
 */
export function snapPhoto(): boolean {
    if (!canvasEl) return false;
    requestAnimationFrame(() => {
        const url = grab();
        if (!url) return;
        lastLen = url.length;
        useGameStore2.getState().addShot(url);
    });
    return true;
}

/**
 * 挂在 `<Canvas>` 内部的空组件 —— 只做两件事：
 *   ① 把 R3F 的 canvas 元素登记给 `snapPhoto()`；
 *   ② 暴露 `window.__photo` 探针（无头出图时用它验证拍照真的抓到了东西）。
 */
export function PhotoSnap() {
    const gl = useThree((s) => s.gl);

    useEffect(() => {
        const el = (gl as unknown as { domElement?: HTMLCanvasElement }).domElement ?? null;
        canvasEl = el;

        /* 探针：`snap` 主动拍一张，`count` 相册张数，`last` 最近一张的字节数。
         * 无头验收时 eval `JSON.stringify({n: window.__photo.count(), l: window.__photo.last()})`
         * 就能判断「点了拍照按钮之后相册里是不是真的多了一张、而且不是空图」。 */
        (window as unknown as { __photo?: unknown }).__photo = {
            snap: () => snapPhoto(),
            count: () => useGameStore2.getState().shots.length,
            last: () => lastLen,
        };

        return () => {
            if (canvasEl === el) canvasEl = null;
        };
    }, [gl]);

    return null;
}

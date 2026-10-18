/**
 * PostFX —— 全局后处理：**ACES tone mapping + Bloom + 丁达尔光（体积光柱）**。
 *
 * 用户 m02225 的原话：「最关键的是全局 ACES tone mapping + bloom 还没做，都做」
 * 素材库的 `索引.html` 第六节也把这条列成「三个能立刻提升画质的细节」之一：
 * 「**色调映射选 ACES**（`ACESFilmicToneMapping`）—— 默认线性输出会把高光切得很难看」。
 *
 * ── 为什么这一步这么重要 ────────────────────────────────────────────────
 * 没有 tone mapping 时，渲染器把线性值直接裁到 [0,1]：任何 >1 的像素都变成纯白，
 * 高光里**所有层次一次性丢失**（草尖、水面粼光、月面受光坡都会糊成一片死白）。
 * ACES 是一条「S 形」曲线，把 >1 的部分**压回**而不是切掉。
 * 官方 `acesFilmicToneMapping` 的实测（曝光 1.0）：
 *     输入 0.18 → 0.213    0.36 → 0.44    1.0 → **0.76**    3.0 → **0.93**
 * ⇒ 高光平滑滚落，亮部开始有「层次」。这是让画面显「贵」最省事的一步。
 *
 * ── 接法照抄官方 `examples/webgpu_postprocessing_bloom.html` ─────────────
 *   import { pass } from 'three/tsl';
 *   import { bloom } from 'three/addons/tsl/display/BloomNode.js';
 *   const scenePass = pass( scene, camera );
 *   const scenePassColor = scenePass.getTextureNode( 'output' );
 *   const bloomPass = bloom( scenePassColor );
 *   renderPipeline.outputNode = scenePassColor.add( bloomPass );
 *
 * ── ★ 丁达尔光（用户 m02642 给的教程：BV1C9VmzZEZZ「【blender】丁达尔光森林教程」）──
 * Blender 那边靠「体积雾 cube + 聚光灯 + Voronoi/ColorRamp 打散强度 + 遮光板」。
 * 我们在 WebGPU 实时管线里做不了 raymarch 体积散射（每像素几十次采样，代价太高），
 * 改用**屏幕空间径向模糊** —— three 自带官方实现
 * `three/addons/tsl/display/radialBlur.js`，它的文档原话就是：
 *   「producing simple faked lighting effects also known as **light shafts**」。
 * 三步：
 *   ① 按亮度把画面里的**亮部**抠出来（太阳盘、亮天、被照亮的雾）—— 阈值以上的部分；
 *   ② 以**太阳的屏幕坐标**为中心做径向模糊（32 次采样、逐步衰减）；
 *   ③ 乘太阳色加回画面。
 * 树冠遮住太阳时，亮部只能从枝叶缝隙漏出来 ⇒ 沿「像素→太阳」的方向被拉成一条条
 * 光柱，就是教程里那束光。**这不是体积散射，是屏幕空间的假光柱**，但视觉上很像，
 * 而且成本只有一次全屏模糊。
 * 开关：`?rays=0` 关 / `?raysstr=` 强度 / `?raysth=` 亮度门槛 / `?raysdecay=` / `?rayscount=`。
 *
 * ── ⚠️ R3F 的接管方式 ──────────────────────────────────────────────────
 * `useFrame(cb, 1)` 用的是**正** priority ⇒ R3F **不再自动渲染**，
 * 必须在回调里自己把画面画出来。这里写成 `pp ? pp.render() : gl.render(scene, camera)`
 * —— 后处理任何一步挂了都退回直出，**不会黑屏**。
 *
 * ⚠️ `PostProcessing.render()` 内部会先把 `renderer.toneMapping` 临时设成 `NoToneMapping`
 * 跑完各 pass，最后再用保存下来的值做输出转换 ⇒ 我们设的 `ACESFilmicToneMapping`
 * 会被正确地应用在最后一步（见 `three.webgpu.js` 的 `PostProcessing.render`）。
 */
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { float, int, pass, uniform, vec3, vec4 } from 'three/tsl';
// @ts-expect-error three 的 examples 没有随包发 .d.ts
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
// @ts-expect-error three 的 examples 没有随包发 .d.ts
import { radialBlur } from 'three/addons/tsl/display/radialBlur.js';
import { QNUM } from '../core/utils/query';
import { uSunColor, uSunDir } from '../core/shaders/uniforms';

/** `?pp=0` 整个后处理退化成直出（A/B 对照 + 出问题时的保命开关） */
const PP_ON = QNUM('pp', 1)! > 0;
/** `?bloom=0` 只留 ACES，不加辉光 */
const BLOOM_ON = QNUM('bloom', 1)! > 0;
/** 辉光强度。官方 GUI 范围 0~3，默认 1.0；我们只想要「亮处微微溢光」 */
const BLOOM_STRENGTH = QNUM('bloomstr', 0.45)!;
/** 辉光半径。越大越糊成一片 */
const BLOOM_RADIUS = QNUM('bloomrad', 0.45)!;
/** 辉光阈值：只有比它亮的像素才发光。
 *  ⚠️ 这一步在**线性空间、tone mapping 之前**做 ⇒ 太阳盘（几十）会发光、
 *  受光地面（0.3~1）不会。
 *
 *  ★★ 用户 m04061 第③条「远处树冠 + 雾，雾像是在自发光」的真根因就在这里
 *     （2026-10-14 实测，`_tools/spec-raysab.json` + `_tools/_rays_cmp5.py`）：
 *     正午森林机位下，**雾墙本身在线性空间就有 0.45~0.66**（= sRGB 约 180~207），
 *     旧默认 0.90 让大量像素越过高通软肩 ⇒ 被 bloom 的 5 级 mip 高斯糊成一片
 *     过曝白光：上部横带「>0.6 线性亮度」的像素从 **0.16% 炸到 43.98%**，
 *     均亮 0.377→0.491（`_tools/_rays_cmp2.py` 的实测表）。
 *     关掉 bloom 后雾退回薄荷青、树冠层次与纵深感全部回来。
 *     ⇒ 默认阈值抬到 **1.15**：雾墙峰值 0.66 远在肩下，只有真正的高光
 *        （太阳盘、水面粼光、受光岩面）才溢光；`?bloomth=` 可覆盖回旧值。
 *     ⚠️ 别再往下调：0.90 是「雾墙整片发光」那条线。
 *     ⚠️ 阈值也别抬太高：本场景线性亮度上限就是 1.0（白纸），抬到 1.15 以上
 *        bloom 会**整个失效**（连太阳盘都不溢光了）—— 想更强的高光请调
 *        `?bloomstr=`（强度）而不是阈值。 */
const BLOOM_THRESHOLD = QNUM('bloomth', 1.15)!;
/** 高通的软肩宽度。three 的实现是 `smoothstep(th, th + smoothWidth, lum)`
 *  （`BloomNode.js:358`）；官方默认 0.01 在阈值附近几乎是硬切。
 *  0.10 让过渡柔和，代价是「略低于阈值」的像素也有一点点辉光。
 *  ⚠️ 软肩会被阈值一起抬走：阈值 1.15 + 肩 0.10 ⇒ 有效门槛 1.25，
 *  线性 1.0 封顶 ⇒ 现在 bloom 实际上只对**太阳盘**生效（见 `_bloom_hi.py`
 *  的实测：地面/天空带 >1.0 的像素都是 0.000%）。这是「雾不再自发光」
 *  的必要代价 —— 真想让雾里也有一层柔光，应该走 emissive/雾色而不是 bloom。 */
const BLOOM_SMOOTH_WIDTH = QNUM('bloomsw', 0.10)!;
/** ACES 的曝光。官方示例用 `Math.pow(value, 4.0)` 做滑杆，这里直接给线性值 */
const EXPOSURE = QNUM('exposure', 1.0)!;

/* ── 丁达尔光 ───────────────────────────────────────────────────────── */
/** `?rays=0` 关掉光柱 */
const RAYS_ON = QNUM('rays', 1)! > 0;
/** 光柱叠加强度。太大整片天会糊成白 */
const RAYS_STRENGTH = QNUM('raysstr', 0.85)!;
/** 亮度门槛。⚠️ 这个数是在**线性空间**里比的，别拿 sRGB 直觉来估：
 *  实测本场景正午的出图（sRGB 0~255）—— 天空 (102,121,140)、雾墙 (140,134,137)、
 *  近处暗地面 (68,56,59)；换成线性亮度分别约 **0.15 / 0.24 / 0.045**。
 *  最初按 sRGB 直觉写了 0.55 ⇒ 整个画面只有太阳盘（线性上万）能进遮罩，
 *  光柱细得看不见（实测只有 1.6% 像素变化，且全挤在画面底部）。
 *  0.08 让「天空 + 亮雾」整片进遮罩，光柱才拉得开。 */
const RAYS_THRESHOLD = QNUM('raysth', 0.08)!;
/** 每次采样的衰减。官方建议 0.95 上下；越接近 1 光柱越长越亮 */
const RAYS_DECAY = QNUM('raysdecay', 0.955)!;
/** 采样次数（官方范围 16~64）。32 次在 1080p 上约 0.4 ms */
const RAYS_COUNT = Math.max(8, Math.min(64, Math.round(QNUM('rayscount', 32)!)));
/** 模糊的曝光增益（官方默认 5）。它只作用于「亮部」这一路，不影响主画面 */
const RAYS_EXPOSURE = QNUM('raysexp', 4.0)!;
/** 平滑阶跃（与 `core/worldRegions.ts` 的 `smoothstep01` 同式） */
function sstep(e0: number, e1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

export function PostFX() {
    const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer & {
        render: (s: THREE.Scene, c: THREE.Camera) => void;
    };
    const scene = useThree((s) => s.scene);
    const camera = useThree((s) => s.camera);

    /** 太阳在屏幕上的 uv（径向模糊的中心）。**必须是 TSL uniform 节点**，
     *  写成普通 `{value}` 对象再 `float(...)` 包一层会把当前的 0 烘成常量。 */
    const raysCenter = useMemo(() => uniform(new THREE.Vector2(0.5, 0.5)), []);
    /** 光柱总权重：太阳在地平线上 × 在画面里 × 白天 */
    const raysWeight = useMemo(() => uniform(0), []);

    const pp = useMemo(() => {
        if (!PP_ON) return null;
        try {
            const pipeline: any = new (THREE as any).PostProcessing(gl);
            const scenePass: any = (pass as any)(scene, camera);
            const color: any = scenePass.getTextureNode('output');
            let out: any = color;
            if (BLOOM_ON) {
                const b: any = (bloom as any)(color);
                /* 官方示例里三个都是 `uniform`，要改 `.value`（不是直接赋值） */
                b.threshold.value = BLOOM_THRESHOLD;
                b.strength.value = BLOOM_STRENGTH;
                b.radius.value = BLOOM_RADIUS;
                /* `smoothWidth` 是高通的软肩（见 `BloomNode.js:358`
                   `smoothstep(threshold, threshold + smoothWidth, luminance)`）。
                   官方默认 0.01 几乎等于硬切；抬到 0.10 让「刚过阈值」的像素
                   平滑进入辉光，不会在阈值线上出现一条亮边。 */
                b.smoothWidth.value = BLOOM_SMOOTH_WIDTH;
                out = color.add(b);
            }
            if (RAYS_ON) {
                /* ① 亮部抠图：lum 超过门槛的部分留原色，其余归零。
                       ⚠️ 必须用 `.max(0).min(1)` 这种最基础的算子 —— TSL 里
                       `clamp`/`saturate` 在不同小版本上签名有出入，这里不冒险。 */
                const lum = color.rgb.dot(vec3(0.2126, 0.7152, 0.0722));
                const lit = lum.sub(float(RAYS_THRESHOLD)).max(float(0.0)).min(float(1.0));
                const src = color.rgb.mul(lit).mul(uSunColor);
                /* ② 以太阳屏幕坐标为圆心做径向模糊。
                       `radialBlur` 内部走 `convertToTexture` ⇒ 这里可以喂表达式，
                       它会自己开一张离屏 RT（成本 = 一次全屏 + 32 次采样）。 */
                const shafts: any = (radialBlur as any)(vec4(src, float(1.0)), {
                    center: raysCenter,
                    weight: float(0.85),
                    decay: float(RAYS_DECAY),
                    count: int(RAYS_COUNT),
                    exposure: float(RAYS_EXPOSURE),
                });
                /* ⚠️ `radialBlur` 内部最后一步是 `color = mix(blur, base * 2, 0.5)`
                   —— 它**已经把原像素加回来了**（等价于 `base + 0.5 * blur`）。
                   我们只要光柱，必须把 base 减掉，否则亮天会被平白加亮一倍。 */
                const shaftsOnly = shafts.rgb.sub(src);
                /* ③ 按总权重加回画面（raysWeight 每帧在 useFrame 里算） */
                out = out.add(shaftsOnly.mul(float(RAYS_STRENGTH)).mul(raysWeight));
            }
            pipeline.outputNode = out;
            return pipeline;
        } catch (e) {
            console.warn('[postfx] 后处理建图失败，退回直出（不会黑屏）：', e);
            return null;
        }
    }, [gl, scene, camera, raysCenter, raysWeight]);

    /* ★ 全局 ACES tone mapping。
       注意：即使 `pp` 为 null（?pp=0 或建图失败）也照样设 —— 那是纯渲染器路径，
       渲染器自己会应用。 */
    useEffect(() => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = EXPOSURE;
        return () => {
            gl.toneMapping = THREE.NoToneMapping;
            gl.toneMappingExposure = 1;
        };
    }, [gl]);

    const probe = useMemo(() => new THREE.Vector3(), []);
    const fwd = useMemo(() => new THREE.Vector3(), []);

    useFrame(() => {
        if (RAYS_ON) {
            /* ⚠️ 曾经的 bug：用 `probe.z < 1` 判断「太阳在不在镜头前」。
               `project()` 把**超过远裁剪面**的点算成 NDC z = 1（会饱和！），
               而太阳本来就在无穷远、我故意放在 4000 m ⇒ 永远 z = 1 ⇒ 恒判「在背后」
               ⇒ `raysWeight` 恒 0，光柱一次都没出来过。
               正解：用**前方向与太阳方向的点积**判前后，与距离无关。
               投影点也改放到 500 m（方向不变，但 z 落在远裁剪面内）。 */
            const sd = uSunDir.value as unknown as THREE.Vector3;
            camera.getWorldDirection(fwd);
            const front = fwd.dot(sd) > 0 ? 1 : 0;
            probe.copy(sd).normalize().multiplyScalar(500).add(camera.position).project(camera);
            const sx = probe.x * 0.5 + 0.5;
            const sy = probe.y * 0.5 + 0.5;
            raysCenter.value.set(sx, sy);
            const d = Math.hypot(sx - 0.5, sy - 0.5);
            const nearFrame = 1 - sstep(0.55, 1.25, d);
            /* 白天因子：与 `core/sky/sunCycle.ts:123` 的 `dayness` 同式
               （`smoothstep(-2, 10, elevDeg)`），保证夜里（uSunDir 指向月亮）
               不会从月亮拉出光柱。 */
            const elevDeg = Math.asin(Math.max(-1, Math.min(1, sd.y))) * (180 / Math.PI);
            const dayness = sstep(-2, 10, elevDeg);
            raysWeight.value = front * nearFrame * dayness;
            /* 调试口（跟 `window.__dsh` 一个路子）：光柱的中心/权重/z。
               z > 1 = 太阳在镜头背后。 */
            (window as any).__rays = { x: +sx.toFixed(4), y: +sy.toFixed(4), w: +raysWeight.value.toFixed(4), z: +probe.z.toFixed(3) };
        }
        if (pp) pp.render();
        else gl.render(scene, camera);
    }, 1);

    return null;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 月坑浅水 · 水面网格 + TSL 材质
 *
 * 几何（task-25 起）：**坑缘外的一圈水平水环**（`POND_R_IN 25.5 ~ POND_R_OUT 33`，宽 7.5 m），
 *       顶点高度一律 = `waterState.POND_WATER_Y`（asset 的 task-24 在平地上挖了 0.32 m 环槽，
 *       水面比槽底高 ≈0.30 m ⇒ 一整圈**水平**的水面）。坑内 `r ≤ 25` 只有花与飞船，没有水。
 *       旧方案（`'sheet'`，贴地形抬升）保留在 `waterState.SURFACE_MODE`，`?watermode=sheet` 可回放。
 *
 * ── 2026-10-21 用户反馈2：「水体很差」──────────────────────────────────────
 * 上一版是「纯色深蓝 + 3 圈假涟漪」：没有法线细节、没有天空反射、没有镜面高光、
 * 没有岸边泡沫 ⇒ 读起来像一块**不透明的蓝色塑料板**。这一版把删海前
 * `_tmp_preview/SeaWater_deleted.tsx` 里**已用像素证据验证过**的那套搬回来：
 *   ① 两层反向漂移的**法线贴图** ⇒ 表面有真实起伏，不再是一块平色；
 *   ② **菲涅尔 + 天空色**（`uSkyHorizon/uSkyTop`）⇒ 掠射角自然变亮，颜色来自本项目
 *      自己的夜空 uniform，不是写死的灰蓝；
 *   ③ **太阳/月亮镜面 glint**（180 次幂）⇒ 波光闪点，这是「像水」最强的单一线索；
 *   ④ **岸边泡沫**：内外两条水线各一条窄带，用程序化噪声打碎；
 *   ⑤ 保留跟着人走的环形涟漪（`waterState` 的 uniform），并把它接进法线扰动。
 *
 * ⚠️ 必须继续用 `MeshBasicNodeMaterial`（不受光）。理由有像素证据：本项目 WebGPU 管线里
 *    `MeshStandardNodeMaterial` 的 `normalNode` / `roughnessNode` / `opacityNode` 三个槽
 *    **全部不生效**（只 `colorNode` 生效），材质会退化成一块不受光的不透板；而掠射角
 *    菲涅尔反射率→1，天空/月光会把整片水洗成灰白。所以这里**自己算光照**：
 *    法线贴图 → 自己算 N、V、L → 自己合成天空反射与高光。
 *
 * 硬约束（task-20）：
 * · 不改 `Terrain.tsx` 的材质（task-19 的 scope），这里是一块**独立的贴地薄片**。
 * · 不动船位/碰撞：水面只是画上去的，`worldHeightCPU` 一个字节都没改。
 * · 接 `visRadius.ts`：以坑心为锚点做 `R_VIS` 剔除（60 m 回望时整块水不提交）。
 * · `?craterwater=0` 整体关掉 ⇒ 回到 task-19 的暗蓝地面。
 * ══════════════════════════════════════════════════════════════════════════════ */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import {
    float, vec2, vec3, vec4, length, smoothstep, mix, positionWorld, positionLocal,
    cameraPosition, fract, max, min, abs, dot, texture, normalize, sin, clamp, mul,
    mx_fractal_noise_float, mx_worley_noise_float,
} from 'three/tsl';
import { useVisGate } from '../../core/world/visRadius';
import { QNUM } from '../../core/utils/query';
import {
    EDGE_FADE, POND_CX, POND_CZ, POND_DEPTH, POND_DEPTH_MAX, POND_R_IN, POND_R_OUT,
    pondWaterY, RIPPLE_COUNT, RIPPLE_MAX_R, RIPPLE_SPEED, SURFACE_MODE, WATER_ON,
    pondMaskAt, tickWaterTime, uWaterContact, uWaterPlayer, uWaterTime, uWaterVel, waterYAt,
} from '../../core/world/waterState';
import { uSkyHorizon, uSkyTop, uStarIntensity, uSunColor, uSunDir } from '../../core/shaders/uniforms';
import { worldHeightCPU } from '../../core/worldRegions';

/* ── 0. 外观常数 ─────────────────────────────────────────────────────────── */

/** 深水底色 / 近岸浅色 / 泡沫白。线性空间由 `THREE.Color` 统一转换。
 *  task-25 第二轮（Lead 采样验收）：上一版的屏幕像素是「灰蓝」(73,78,99) —— R 与 G 只差 5，
 *  读起来像月光下的水泥地。目标 = R 30~45 / G 55~70 / B 100~120（B ≥ 2×R、偏靛蓝）。
 *  所以底色的**蓝通道基本不动、红通道砍到 1/2.5**：`#0f2b4d` → `#062450`。
 *
 *  ── 2026-10-22 用户反馈4：「整体过亮偏冰蓝，读作冰面/乳白」──────────────────
 *  修法（见 `_logs/briefs/water-refs.md` §4 与 §移植）：深蓝要**靠压掉反射项**，
 *  不是靠加深底色 —— 底色本来就是 #04275f，屏幕上发白全部来自「加法」：
 *    · `C_SHEEN #7fa6c8` × `fres^3.2` × `SKY_REFL 0.55`：掠射角 fres→1 时**加 0.55 的浅青**，
 *      这是把水面洗成冰蓝的第一大项 ⇒ 乘子改深蓝 `#24486e`、幂次 3.2→5.0、
 *      `SKY_REFL` 缺省 0.55→0.14；
 *    · `skyCol × 0.35` 是**平铺整片**的加法 ⇒ 0.35→0.06；
 *    · `amb 0.020/0.035/0.070` 在夜里也是平铺加法 ⇒ 砍到 1/3 且更偏蓝；
 *    · `glint × 5.0` 按 180 次幂扫过整片水 ⇒ 2.4。 */
const C_DEEP = new THREE.Color('#04275f');
const C_SHALLOW = new THREE.Color('#0a3568');
const C_FOAM = new THREE.Color('#cfe6f2');
/** 掠射高光的**月光色**：偏冷，但 2026-10-22 起从浅青 `#7fa6c8` 改成深蓝 `#24486e`。
 *  ⚠️ 不用 `uSkyHorizon`（#0d1522）做乘子：它太暗，乘出来只有 0.02 的增量，
 *     水面退化成一块平色塑料板（第一版实测）。所以仍然是单独一个色，只是不再那么亮。 */
const C_SHEEN = new THREE.Color('#24486e');

/** 不透明度：浅滩更透（能看到槽底）、深处更实（藏住槽底的暗色）。
 *  2026-10-22：整体上移（0.66/0.93 → 0.80/0.97）—— 原来水深 0.3 m 的槽底透上来，
 *  和 `C_FOAM` 的加法叠成乳白。不透明度越高，「深蓝底色」越压得住底下的亮地形。 */
const OP_MIN = 0.80;
const OP_MAX = 0.97;

/** ★ 无头调参用的开关（决定「水面读起来像不像水」）：
 *  `?wop=` 整体不透明度倍率；`?wside=0` 把 `DoubleSide` 换成 `FrontSide`；
 *  `?wnorm=` 法线强度；`?wglint=` 镜面强度；`?wfoam=` 泡沫强度。
 *  缺省值 = 交付值。
 *
 *  ── 2026-10-22 第四轮反馈：三处缺省值被重定 ───────────────────────────────
 *  · `NORMAL_TILE 2.6 → 9.0`：**格状白点阵的第一嫌疑**。两层法线 `uvA = xz/2.6`、
 *    `uvB = xz/2.13`，尺度比 2.13 ⇒ 两套同源图案以接近 2 倍的周期叠加，
 *    在 60~80 px 的间距上读出「两方向排布的椭圆亮斑」。
 *    改法照 three.js `Water.getNoise`（`src/objects/Water.js`）：**四层尺度互不成整数比**、
 *    **流速各异**、**最粗一层 ≥40 m/tile**。这里取 9.0 / 27.5 / 91 / 233 m，比值
 *    27.5/9=3.06、91/27.5=3.31、233/91=2.56 —— 都不是 2:1，也不是整数比。
 *    9.0 这一层在 1000 px 屏上是「每米 ~0.11 个周期」，即 9 m 才重复一次，7.5 m 宽的
 *    环带里**看不到一次以上重复**。
 *  · `FOAM_W 0.55 → 0.28`：岸带要 ≤0.6 m（验收），0.28 m 的半宽 ⇒ 全宽 0.56 m。
 *  · `SKY_REFL 0.55 → 0.14`：见 `C_SHEEN` 的注释。 */
const WOP = QNUM('wop', 1)!;
const WSIDE = QNUM('wside', 1)!;
const NORMAL_STRENGTH = QNUM('wnorm', 0.55)!;
const NORMAL_TILE = QNUM('wtile', 9.0)!;
const GLINT_GAIN = QNUM('wglint', 1)!;
/* ⚠️ 2026-10-22（t17 第七段）：0.34 → **1.0**。
   旧值 0.34 是「颜色/不透明度都乘它」，泡沫永远到不了白色；
   现在它是**总闸**（`foamA = foamShape * FOAM_STRENGTH`），具体浓淡由 `foamShape` 内部决定：
   `max(foamLine*0.80, foamLace*0.55) × (0.42 + foamTex*0.58)`。
   保持可调 ⇒ `?wfoam=0` 仍然能完全关掉泡沫做 A/B 对照。 */
const FOAM_STRENGTH = QNUM('wfoam', 1.0)!;
const FOAM_W = QNUM('wfoamw', 0.22)!;
/* 2026-10-22 t15：0.65（周期 1.54 m）⇒ worley 一个格子就是一块大白斑，岸线读作浮冰。
   ⚠️ 2026-10-22 t19（修 t12 的 F5 类漂移）：注释此前写「1.15」，**代码缺省是 5.0**。
   t17 把岸带拆成 `foamLine`（确定性水线）+ `foamLace`（噪声碎沫）之后，`FOAM_TILE` 只作用在
   `foamLace` 那一项上 ⇒ 5.0（周期 0.2 m）是碎沫尺度，不再是整条带的尺度，两者不矛盾。
   以后改这个常数请同时改这句，别再让注释和代码分叉。 */
const FOAM_TILE = QNUM('wfoamtile', 5.0)!;
/* ⚠️ 2026-10-22 t19（修 t12 的 F5）：**以代码为准 = 缺省 0.42**。
   历史：r1 是 0.55 → r2 压到 0.14（当时为了让水面沉下去）→ r2 末又回到 0.42（0.14 让掠射角
   完全没有反射带）。`_logs/t4/water-evidence.md` 里写的「0.55→0.14」是 r2 中途的值，已过期；
   复核请读这一行，不要读证据文档里的旧描述。 */
const SKY_REFL = QNUM('wsky', 0.42)!;
/* 环境反射总增益（`?wrefl=0` 可整体关掉做 A/B）。2026-10-22 t15 新增。 */
const REFL_GAIN = QNUM('wrefl', 1.0)!;
/** ★ 2026-10-22 第二轮修复：米级以下细法线（近景波光）。
 *  上一版最细一层 9 m/tile，几米视距下斜率≈0 ⇒ 近景读作磨砂面。
 *  2.2 m/tile、权重 0.22，只负责近处波光；与四层主结构的比值 4.09/12.5/41.4/106 都不是整数比。 */
const FINE_TILE = QNUM('wfinetile', 2.2)!;
const FINE_WEIGHT = QNUM('wfine', 0.22)!;

/* ★ 2026-10-21 用户反馈3「人物模型和水体的物理碰撞很差」新增的两项：
 *  `?wcontact=`  脚踝接触白沫强度（0 = 关掉，做 A/B）
 *  `?wwake=`     行进尾迹强度（朝速度方向拖长的 V 形白沫） */
const CONTACT_GAIN = QNUM('wcontact', 1)!;
const WAKE_GAIN = QNUM('wwake', 0.75)!;
/** 接触白沫半径（米）：略大于脚长，读作「水被脚踝推开」。
 *  旧版涟漪最大 2.6 m，比人还大，读作「水里扔了块石头」。 */
const CONTACT_R = QNUM('wcontactr', 0.30)!;
/** 尾迹半宽 / 半长（米）。人走过去水面上留一道短暂的扰动。
 *  ⚠️ 2026-10-22 第三轮（t1）：半长保持 2.1 **不动** —— 实测过 1.35 一次，
 *  结果尾迹在速度 1.09 m/s 时只剩 0.67 m，掠射机位几乎看不见，属于过度矫正。
 *  真正让白条横跨画面的是**前向未截断**（见下方 ②），不是长度。 */
const WAKE_W = QNUM('wwakew', 0.55)!;
const WAKE_L = QNUM('wwakel', 2.1)!;
/** 尾迹允许越到脚点**前方**的铅头长度（米）= 本轮「白条」的直接修复项。
 *  旧码在 `along > 0`（身前）处权重恒为 1 ⇒ 尾迹沿速度正方向无限延伸。
 *  现在 `foreDist > WAKE_LEAD` 即归零；`?wwakelead=` 可调
 *  （⚠️ `QNUM` 把 ≤0 当无效值，要彻底关尾迹请用 `?wwake=0`）。 */
const WAKE_LEAD = QNUM('wwakelead', 0.18)!;

const NUM_ANG = 160;
const NUM_RAD = 48;

/* 法线贴图（512×512 **RGBA** PNG，由 `waternormals.jpg`（three.js 官方 1024²，MIT，
 *  `cdn.jsdelivr.net/gh/mrdoob/three.js@dev/examples/textures/waternormals.jpg`）降采样 + 重新单位化而来）。
 *  ⚠️ 2026-10-22 t19（修 t12 的 F6）：下面提到的 `normal8.png` / `foam8.png` **磁盘上都不存在**，
 *     `git log --all -S` 也无记录（它们是 2026-10-21 那版临时产物，已随重写清掉）。
 *     保留这段是为了记住「为什么换素材」的判据，**不要去追这两个文件**，也不要照它去加载。
 *  为什么换掉原来的 `normal8.png`：两者像素统计几乎一致（σ 13.3 vs 13.4、3×3 分块 σ 1.4 vs 1.4），
 *  但原图的**自相关沿 +x 在 34 px 处有 0.149 的峰**、沿 +y 在 175 px 有峰 —— 即它本身带方向性
 *  周期。官图是同一族的 Perlin 云（用 9 m 平铺时自相关峰落在 690 px，画面上看不到），
 *  且是 three.js `Water.getNoise` 的配套素材（t1 调研 §3），比我们自己截的图可信。
 *  ⚠️ 必须是 **RGBA**：本项目 WebGPU 管线对 JPEG 的 `RGBFormat` 会直接报
 *     `Unsupported texture type with RGBFormat` 并让整个材质消失（森林踩过这个坑）。
 *  ⚠️ 法线是**数据**不是颜色 ⇒ `colorSpace = NoColorSpace`，否则会被 sRGB 解码扭歪。 */
let _normalTex: THREE.Texture | null = null;
function normalTex(): THREE.Texture {
    if (_normalTex) return _normalTex;
    const t = new THREE.TextureLoader().load('/textures/water/waternormals.png');
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    _normalTex = t;
    return t;
}

/* ── 1. 几何：水平环带 ───────────────────────────────────────────────────── */

/**
 * `'plane'` 模式下的水面高度 = `waterState.POND_WATER_Y`（= `worldRegions.POND_WATER_Y`，
 * asset 按新环槽地形算的「平地高度 − 0.02」）。这里**不自己算**，避免出现第二份水面高度真值。
 */
function planeWaterY(): number {
    return pondWaterY();
}

function buildSurface(): THREE.BufferGeometry {
    /* 平面模式只多铺 0.8 m 淡出带：环带已经站在坑缘外的平地上，铺太宽会盖到坑缘脊上。
       贴地形模式沿用 1.0 m + EDGE_FADE（要跟着坡走）。 */
    const pad = SURFACE_MODE === 'plane' ? 0.8 : EDGE_FADE + 1.0;
    const rIn = Math.max(0, POND_R_IN - pad);
    const rOut = POND_R_OUT + pad;
    const planeY = SURFACE_MODE === 'plane' ? planeWaterY() : 0;
    const count = (NUM_ANG + 1) * (NUM_RAD + 1);
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    let p = 0;
    let q = 0;
    for (let j = 0; j <= NUM_RAD; j++) {
        const r = rIn + ((rOut - rIn) * j) / NUM_RAD;
        for (let i = 0; i <= NUM_ANG; i++) {
            const a = (i / NUM_ANG) * Math.PI * 2;
            const x = POND_CX + r * Math.cos(a);
            const z = POND_CZ + r * Math.sin(a);
            const y = SURFACE_MODE === 'plane' ? planeY : waterYAt(x, z);
            pos[p++] = x - POND_CX; // 局部坐标：mesh 挂在坑心，方便 culling/包围盒
            pos[p++] = y;
            pos[p++] = z - POND_CZ;
            uv[q++] = i / NUM_ANG;
            uv[q++] = j / NUM_RAD;
        }
    }
    const idx: number[] = [];
    for (let j = 0; j < NUM_RAD; j++) {
        for (let i = 0; i < NUM_ANG; i++) {
            const a = j * (NUM_ANG + 1) + i;
            const b = a + 1;
            const c = a + (NUM_ANG + 1);
            const d = c + 1;
            idx.push(a, c, b, b, c, d);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
}

/* ── 2. 材质 ─────────────────────────────────────────────────────────────── */

/** 泡沫打碎用的**噪声**（`-1..1`）。
 *
 *  ⚠️ 2026-10-22（第四轮反馈）**替换掉原来的三层不可分离正弦**（3.1/2.7、7.3/−5.1、13.7/11.3）。
 *     那三条正弦的波长比是 2.35 / 1.87，都在 2 倍附近 ⇒ 三条叠起来在屏幕上读出**两方向
 *     排布的亮点阵**（用户 1:1 判读：柔和椭圆亮斑沿两方向排成格，间距 60~80 px）。
 *     「不可分离」只保证了它不是 `sin(x)·sin(y)` 的方格，**并不保证不成周期**；
 *     低频打碎带 + 中频条纹，只要频率比接近整数就一定有格。
 *
 *  ✅ 换成 MaterialX 的分形噪声（three/tsl 的 `mx_fractal_noise_float`，Perlin 基，
 *     3 个八度、lacunarity 2.0）—— 它是**真噪声**，频谱连续，不会有周期性亮点。
 *     `mx_*` 的输入是**格点单位**（一个整数步 ≈ 1 个噪声单元），所以这里把米直接喂进去，
 *     `v * 0.8` 表示「一个噪声单元 ≈ 1.25 m」，对岸带和尾迹都是合适的尺度。 */
function laceNoise(v: any): any {
    return mx_fractal_noise_float(vec3(v.x, v.y, float(0.0)).mul(float(0.8)), 3, 2.0, 0.5)
        .mul(float(0.7))
        .add(mx_worley_noise_float(vec3(v.x, v.y, float(3.7)).mul(float(2.1)), 2.0)
            .sub(float(0.5)).mul(float(0.6)));
}

function buildMaterial(): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;          // 与飞船/石头的前后关系交给 transparent 排序
    m.side = WSIDE > 0 ? THREE.DoubleSide : THREE.FrontSide;
    m.fog = true;

    /* ── 顶点波：只做**观感**的 ±2 cm 起伏，让水平面不是一块数学平面。
       ⚠️⚠️ 绝不参与 `waterYAt()` / 碰撞 / 探针 —— 水面高度的唯一真值仍然是
       `waterState.pondWaterY()`。这里位移的是**渲染网格的顶点**，物理一个字节没动。
       振幅 2 cm 相对 7.5 m 宽的环带 = 0.27%，读作「液面在轻轻起伏」，不会露出槽底。
       三列不可分离正弦（项目里反复强调：可分离乘积 = 点阵感）。
       ⚠️ `positionNode` 是**局部**坐标（mesh 挂在坑心）⇒ 必须用 `positionLocal`，
          用 `positionWorld` 会把坑心偏移再叠一次，整块水飞出去。 */
    const tw = uWaterTime;
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const wave = sin(wx.mul(0.83).add(wz.mul(0.47)).add(tw.mul(0.75))).mul(0.010)
        .add(sin(wx.mul(-1.37).add(wz.mul(1.09)).add(tw.mul(1.15))).mul(0.006))
        .add(sin(wx.mul(2.11).add(wz.mul(-1.83)).add(tw.mul(1.65))).mul(0.004));
    m.positionNode = vec3(positionLocal.x, positionLocal.y.add(wave), positionLocal.z);

    /* ── 环带遮罩（片元版）：与 CPU 侧 `pondMaskAt` 同一条式子 ⇒ 边缘淡出对得上。 */
    const center = vec2(POND_CX, POND_CZ);
    const rel = positionWorld.xz.sub(center);
    const r = length(rel);
    const edge = Math.max(1e-3, EDGE_FADE);
    const inn = smoothstep(float(POND_R_IN - edge), float(POND_R_IN), r);
    const out = float(1.0).sub(smoothstep(float(POND_R_OUT - edge), float(POND_R_OUT), r));
    const mask = inn.mul(out);

    /* 径向归一化 0（内缘）→ 1（外缘）。环槽底是平的，真实水深在整条带上几乎一样，
       所以这里用「两端浅、中间深」的观感曲线，而不是去采样 GPU 地形高度（贵且没必要）。 */
    const radT = clamp(r.sub(float(POND_R_IN)).div(float(POND_R_OUT - POND_R_IN)), float(0), float(1));
    const depthT = smoothstep(float(0.0), float(0.30), radT)
        .mul(float(1.0).sub(smoothstep(float(0.62), float(1.0), radT)));

    /* ── ① 四层异缩放法线贴图（2026-10-22：两层 → 四层，去点阵）────────────────
     *  旧版只有两层：`uvA = xz / 2.6`、`uvB = xz / (2.6*0.47) = xz / 2.13`。
     *  两层的尺度比是 **2.13 ≈ 2**，同一张 512² 法线在两套 UV 下各自成周期，
     *  叠加后在画面上就是「两方向排布的椭圆亮斑」（用户 1:1 判读：间距 60~80 px、
     *  在 1000 px 高的取景里 ≈ 2.6 m / 62 px ⇒ 正好对上 2.6 m 的平铺周期）。
     *
     *  改法照 three.js `Water.getNoise`：**四个互不成整数比的尺度 + 四套不同流速**，
     *  最粗一层 ≥ 40 m/tile（这里 91 / 233 m）。四层法线各自 512² 采样，
     *  再**按强度加权求和**（不是等权平均）—— 粗层权重大、给低频大起伏，
     *  细层权重小、只提供打光闪点，这样既没有可辨认的格，也不至于糊成一片。
     *  ⚠️ 每层必须带各自的偏移相位（否则 4 层 xz 同源，在原点附近相位一致会叠出一个亮核）。
     *  ⚠️ 采样时用 `textureSampleLevel`（= TSL 的 `texture(tex, uv, level)`）会禁止 mip 自动选择；
     *     这里 UV 是**线性函数**没有分支，自动导数有效，所以直接用 `texture(tex, uv)` 即可，
     *     否则远景会闪。 */
    const t = uWaterTime;
    const nTex = normalTex();
    /** 每层：平铺米数 / 流速(uv 单位每秒) / 权重。四个尺度比 3.06 / 3.31 / 2.56，都不是整数比。 */
    const N_LAYERS: Array<[number, [number, number], number]> = [
        [9.0, [0.0130, 0.0090], 0.30],
        [27.5, [-0.0062, 0.0071], 0.28],
        [91.0, [0.0021, -0.0016], 0.26],
        [233.0, [-0.0009, -0.0005], 0.16],
    ];
    const tileMul = float(NORMAL_TILE / 9.0);
    let tilt = vec3(0.0, 0.0, 0.0);
    for (let i = 0; i < N_LAYERS.length; i++) {
        const [tile, flow, wgt] = N_LAYERS[i];
        /* 第一层的米数由 `?wtile=` 缩放，其余三层跟着同比例走，保持互不成整数比的关系。 */
        const sc = float(tile).mul(tileMul);
        const uv = positionWorld.xz.div(sc)
            .add(vec2(t.mul(flow[0]), t.mul(flow[1])))
            .add(vec2(i * 0.317, i * 0.713));
        const n = texture(nTex, uv).rgb.mul(2.0).sub(1.0);
        tilt = tilt.add(vec3(n.x, float(0.0), n.y).mul(float(wgt)));
    }
    /* ── ①b 米级以下细法线（2026-10-22 第二轮修复）─────────────────────────────
     *  上一版把最细一层定在 9 m/tile，在 1.6 m 眼高、3 m 视距下相位差不到 1/3 个周期
     *  ⇒ 斜率接近 0，近景水面读作磨砂/雾面（t8 实测 `fine_std = 0.958`）。
     *  这里**补一层 2.2 m/tile**，只服务近景波光：
     *    · 权重 0.22，小到不至于把 4 层异缩放结构推翻，也不至于重新出现可辨认的平铺格；
     *    · 2.2 m 与上面四层（9 / 27.5 / 91 / 233）的比值 4.09 / 12.5 / 41.4 / 106，
     *      都不接近整数比 —— 万一两层在同一处对齐也不会叠出规则亮斑；
     *    · 流速按「贴图每秒平移」折算：底图 512² 铺满 2.2 m ⇒ 1 m/s 的漂移 =
     *      512/2.2 = 232.7 uv/s，与水波 1~2 m/s 的量级吻合；
     *    · 第三维偏移 `z = 7.3` 与另四层（由 `i*0.317` 推出的 0 / 1 / 2 / 3）错开。
     *  ⚠️ 只加在最前面（`tilt` 的第一项），不加新的循环，代价约 1 次纹理采样。 */
    {
        const uvF = positionWorld.xz.div(float(FINE_TILE))
            .add(vec2(t.mul(0.62), t.mul(-0.41)))
            .add(vec2(0.271, 0.912));
        const nF = texture(nTex, uvF).rgb.mul(2.0).sub(1.0);
        tilt = tilt.add(vec3(nF.x, float(0.0), nF.y).mul(float(FINE_WEIGHT)));
    }
    tilt = tilt.mul(float(NORMAL_STRENGTH));

    /* ── 跟着人走的环形涟漪：接进法线扰动，让它真的「推」水面而不是只变亮 ── */
    const p = uWaterPlayer;
    const dpv = positionWorld.xz.sub(vec2(p.x, p.y));
    const dp = length(dpv);
    let ring = float(0.0);
    for (let i = 0; i < RIPPLE_COUNT; i++) {
        const ph = fract(t.mul(float(RIPPLE_SPEED)).add(float(i / RIPPLE_COUNT)));
        const rad = ph.mul(float(RIPPLE_MAX_R));
        /* ⚠️ 2026-10-22 第三轮（t1）：带宽 0.22~0.42 m → 0.13~0.26 m。
           宽环 + 2.6 m 半径叠起来读作「横跨画面的同心巨环」，收窄后是三圈细涟漪。 */
        const w = float(0.13).add(ph.mul(0.13));
        const band = float(1.0).sub(smoothstep(float(0.0), w, abs(dp.sub(rad))));
        ring = ring.add(band.mul(float(1.0).sub(ph)));
    }
    ring = min(ring.mul(p.w), float(1.0));
    /* 涟漪方向 = 由玩家指向外的径向单位向量；没有它，扰动只是一层静态噪声。 */
    const dpDir = dpv.div(max(dp, float(1e-3)));
    /* ★ t1：法线扰动强度 0.40 → 0.22（强度减半口径，见 ③ 泡沫 alpha 同步减半）。 */
    const tiltAll = tilt.add(vec3(dpDir.x, float(0.0), dpDir.y).mul(ring.mul(0.22)));

    /* ── ★★ 脚踝接触白沫 + 行进尾迹（2026-10-21 反馈3）──────────────────────
       为什么需要它：水面是 `depthWrite = false` 的半透明片，**本身没有任何接触线索**。
       人站在水里时，除了（已修好的）涟漪之外画面上一片平静 ⇒ 读作「站在玻璃板上」。
       这里加两样东西，都是**纯渲染**，不碰物理：
         ① 脚踝一圈白沫：以接触点为心、半径 `CONTACT_R` 的环带，用同一套 `laceNoise`
            打碎（否则是规整的圆圈），并乘接触水深（站在浅水边缘自然变淡）。
         ② 尾迹：沿**速度反方向**拖长的椭圆 V 形，只在真正移动时出现。
       ⚠️ 两者都用 `uWaterContact` / `uWaterVel`，是 CPU 侧每帧喂进来的**当前值**，
          不是材质里自己猜的位置 —— 否则会和角色脱节。 */
    const cpos = uWaterContact;
    const contactOn = cpos.z;
    const contactDepth = cpos.w;
    const cv = positionWorld.xz.sub(vec2(cpos.x, cpos.y));
    const cdist = length(cv);

    /* ① 脚踝搅起的碎沫：**实心衰减盘**，不是空心圆环。
       ⚠️ 两版都被否掉了，记在这里免得再走一遍：
          · 第一版 `contactW = 0.16 + depth*0.55` 配 `CONTACT_R 0.42` ⇒ 环带覆盖
            cdist ∈ [0.095, 0.745]，出图是**1.5 m 直径的发光白盘**，比人还宽。
          · 第二版收窄成 0.09~0.16 窄带 + 半径 0.30 ⇒ 变成**一圈完美空心光环**，
            读作「脚下一盏环形灯」。空心是关键错误：真实涉水是脚边被搅起的一团
            白沫，中心也浑，不是一圈几何圆。
       现在用 `1 - smoothstep(0, CONTACT_R, cdist)` 做**实心**径向衰减，再乘一层
       高频 lace（0.45~0.95，阈值偏高）把圆盘打碎成几块不规则的白沫 ⇒ 既不是盘
       也不是环。 */
    /* ⚠️ 2026-10-22（t19，修 t12 的 F1）：**盘心实心**就是这个版本的病根。
       `contactDisk.mul(0.46)` 是**加**在阈值输入里的：盘心 disk=1 ⇒ 输入 ≥ 0.46 > 下界 0.44
       ⇒ **盘心恒饱和为 1，噪声压不住**，只有盘缘才被噪声打碎。
       1:1 裁块实测（`_tmp_preview/t19_feet1to1.jpg`）：脚周是一团光滑白雾，零颗粒结构。
       修法：径向从「加性偏置」改成「乘性包络」，让噪声独自决定哪里有沫 ⇒
         contact = smoothstep(lo,hi,laceMix) × envelope² × contactOn × gain
       双频 lace（3.4 / 9.1 周期）避免单一周期的规则颗粒；`envelope²` 让边缘早收敛，
       不拖毛边到 0.30 m 外；中心也会被噪声打出洞 ⇒ 读作碎沫，不是一盘白油。 */
    const contactDisk = float(1.0).sub(smoothstep(float(0.0), float(CONTACT_R), cdist));
    const contactEnv = contactDisk.mul(contactDisk);
    const contactLaceA = laceNoise(positionWorld.xz.mul(float(3.4)).add(vec2(t.mul(0.07), t.mul(-0.05))))
        .mul(0.5).add(0.5);
    const contactLaceB = laceNoise(positionWorld.xz.mul(float(9.1)).add(vec2(t.mul(-0.13), t.mul(0.11))))
        .mul(0.5).add(0.5);
    const contactLace = contactLaceA.mul(0.62).add(contactLaceB.mul(0.38));
    const contact = smoothstep(float(0.40), float(0.70), contactLace)
        .mul(contactEnv).mul(contactOn).mul(float(CONTACT_GAIN));

    /* ② 尾迹：把「到接触点的位移」投到速度方向 / 垂直方向，得到沿运动方向拉长的椭圆。
         速度归零时 `vlen` 很小 ⇒ 尾迹自然消失（不需要额外的时间衰减）。
       ⚠️⚠️ 2026-10-22 第三轮（t1）**白条/光柱的病灶就在下面**：
         旧码 `wakeBehind = 1 - smoothstep(0, wakeLen, max(along*-1, 0))`。
         人物沿速度方向前进时 `along > 0` ⇒ `max(along*-1, 0)` 恒等于 0
         ⇒ `wakeBehind` 在**整个身前半平面**恒为 1：尾迹被画到人前面去了；
         `wakeSpread` 里同一个表达式同病 ⇒ 越往前收得越窄，最后收成一条
         0.30 m 半宽、**无限长**的亮线 = 用户图一图二的「横跨画面的连续白条」。
         修法：前向只留 `WAKE_LEAD` 的铅头（`1 - smoothstep(0, WAKE_LEAD, foreDist)`），
         与身后的 `wakeBack` 相乘 ⇒ 身前 0.18 m 之外权重恒为 0；
         横向展开量改用 `backDist`，身前不再有 V 形收窄。 */
    const vel2 = vec2(uWaterVel.x, uWaterVel.y);
    const vlen = length(vel2);
    const vdir = vel2.div(max(vlen, float(1e-3)));
    const crel = positionWorld.xz.sub(vec2(cpos.x, cpos.y));
    const along = dot(crel, vdir);          // + = 前方（还没走到），- = 身后
    const across = abs(dot(crel, vec2(vdir.y.mul(-1.0), vdir.x)));
    const backDist = max(along.mul(-1.0), float(0.0));
    const foreDist = max(along, float(0.0));
    /* 只画在**身后**（`along < 0`），并把长度按速度缩放：慢慢走尾迹短。 */
    const wakeLen = float(WAKE_L).mul(clamp(vlen.div(float(2.2)), float(0.25), float(1.0)));
    const wakeBack = float(1.0).sub(smoothstep(float(0.0), wakeLen, backDist));
    /* ★ t1 前向截断：`foreDist > WAKE_LEAD` 立刻归零 ⇒ 白条不再长到人之前。 */
    const wakeFore = float(1.0).sub(smoothstep(float(0.0), float(WAKE_LEAD), foreDist));
    const wakeBehind = wakeBack.mul(wakeFore);
    const wakeSide = float(1.0).sub(smoothstep(float(0.0), float(WAKE_W), across));
    /* 越靠近身后中心越亮，往外张成一个 V：横向容差随**身后**距离变宽。 */
    const wakeSpread = float(WAKE_W).mul(float(0.55).add(backDist.div(wakeLen).mul(1.5)));
    const wakeV = float(1.0).sub(smoothstep(float(0.0), wakeSpread, across));
    const wakeBand = wakeBehind.mul(wakeSide.mul(0.35).add(wakeV.mul(0.65)));
    /* ★ t1：单频 lace → 双频（1.5 / 6.7 周期），阈值 0.32~0.82
       ⇒ 连续亮条变「一串碎沫 + 短 V」，不再是一条实线（0.36/0.86 实测过一轮，
       速度 1.09 m/s 时尾迹整体掉到看不出，属过度矫正）。 */
    const wakeLaceA = laceNoise(positionWorld.xz.mul(float(1.5)).add(vec2(t.mul(0.11), t.mul(-0.09))))
        .mul(0.5).add(0.5);
    const wakeLaceB = laceNoise(positionWorld.xz.mul(float(6.7)).add(vec2(t.mul(-0.17), t.mul(0.21))))
        .mul(0.5).add(0.5);
    const wakeLace = wakeLaceA.mul(0.62).add(wakeLaceB.mul(0.38));
    const wakeShape = smoothstep(float(0.32), float(0.82), wakeLace.mul(0.62).add(wakeBand.mul(0.62)));
    const wake = wakeShape.mul(contactOn)
        .mul(clamp(vlen.div(float(1.1)), float(0.0), float(1.0)))
        .mul(float(WAKE_GAIN));

    const N = normalize(vec3(tiltAll.x, float(1.0), tiltAll.z));
    const V = normalize(cameraPosition.sub(positionWorld));

    /* ── ② 菲涅尔 + 掠射高光 ─────────────────────────────────────────────── */
    /* ⚠️ 乘子用 `C_SHEEN`，**不能**用 `uSkyHorizon`：本项目是月夜，天空色 #0d1522 太暗，
       乘出来只有 0.02 的增量 ⇒ 屏幕上完全看不见，水面就是一块平色塑料板（第一版实测）。
       `uSkyTop/uSkyHorizon` 只用来给暗部一点点环境色调，不承担亮度。
       ── 2026-10-22：幂次 3.2 → 5.0，乘子换成深蓝 `#24486e`，增益 `SKY_REFL` 0.55 → 0.14。
       掠射角（相机几乎贴着水面看，本项目绝大多数机位都是这样）`fres → 1`，
       旧参数等于给整片水**加 0.55 的浅青** ⇒ 屏幕上是冰蓝乳白。现在最坏情况只加 0.14×深蓝。 */
    const fres = float(1.0).sub(max(dot(N, V), float(0.0))).pow(float(3.4));
    const sheen = vec3(C_SHEEN.r, C_SHEEN.g, C_SHEEN.b);
    const skyCol = mix(uSkyHorizon, uSkyTop, float(0.30));

    /* ── ②b 月光长条反射（2026-10-22 第二轮修复）─────────────────────────────
     *  上一版的 glint 是 `pow(dot(R, V), 180) × 5`：180 次幂只让**几乎正对**的波峰亮，
     *  掠射角下（相机贴水面看）这种波峰一条都没有 ⇒ 屏幕上完全看不到月光。
     *  t8 判据要的是「窄而亮的长条，不是整体提亮」，所以改成**两层**：
     *    · 宽层 `pow(·, 22)`：掠射时水面法线只要把视线折到月亮方向附近就点亮，
     *      形成一条沿视线方向的**拉长亮带**（真实水面就是这样：风把高光拉成柱）；
     *    · 窄层 `pow(·, 120)`：偶发的强波峰闪点，叠在亮带中间。
     *  ⚠️ 两个都乘 `fres` 的 sqrt —— 掠射权重更大但**不整体加亮**（`fres` 本身已经
     *     在 `sheen` 那一项里承担了「越平视越亮」）；垂直俯视时反射几乎归零。
     *  ⚠️ 增益 `GLINT_GAIN` 保持 1，倍率写死在这里，`?wglint=0` 仍可整体关掉做 A/B。 */
    const L = normalize(uSunDir);
    const Rf = N.mul(dot(N, L).mul(2.0)).sub(L);
    const rv = max(dot(Rf, V), float(0.0));
    /* ⚠️ 2026-10-22（t15 lead 隔离实测）：原 `pow(22) × 0.85` **宽到整片水面都满足**，
       在掠射机位糊成一团白（用 `?wglint=0` 关掉后白亮区消失、波纹结构保留，确证来源）。
       真实水面的月光高光是被波浪打碎的星点/窄长条 ⇒ 靠高次幂 + 法线抖动，不靠低次幂铺满。
       收窄：宽瓣 22 → 90（增益 0.85 → 0.70），窄瓣 120 → 420（增益 2.2 → 1.6）。 */
    const glintWide = rv.pow(float(90.0)).mul(float(0.70));
    const glintSharp = rv.pow(float(420.0)).mul(float(1.6));
    const glint = glintWide.add(glintSharp)
        .mul(fres.sqrt())
        .mul(float(GLINT_GAIN))
        .mul(uSunColor);

    /* ── ②c 月光天环境反射（2026-10-22 t15 lead）─────────────────────────────
     *  ⚠️ 为什么必须有这一项：在此之前 `N` 只参与 `fres` 与 `glint`，而两项都被压到很低
     *  （`sheen` 是深蓝 #24486e × `SKY_REFL 0.34`，`glint` 只在极窄波峰亮）⇒ **波浪在颜色上
     *  留不下任何痕迹**。出图实测：俯视、掠射都是一块平滑的蓝色渐变，波纹 / 反射带 /
     *  月光长条全部看不到，数字指标全过却读不出是水（t8 判的就是这一条）。
     *  修法不是「把水面整体调亮」（那是第一版冰蓝乳白的来源），而是补上**方向性反射**：
     *    `Rdir = 2(N·V)N − V`（反射视线），天光亮度由 `Rdir` 方向决定（地平线上方亮、
     *    天顶暗），再叠一个月亮方向的高次幂亮斑。N 的微扰直接改变 `Rdir` ⇒ 改变颜色
     *    ⇒ 波峰波谷出明暗，这才是水面该有的结构。
     *  物理上也对：真实水面掠射角几乎全反射、垂直俯视几乎只看见水体本色，Schlick 正好给
     *  这个角度响应（`F0 = 0.02`，90° 掠射趋近 1）。所以**俯视仍然偏平是对的**，
     *  验收要看掠射机位。 */
    const NdV = max(dot(N, V), float(0.0));
    const Fres = float(0.02).add(
        float(0.98).mul(float(1.0).sub(NdV).pow(float(5.0))),
    );
    const Rdir = N.mul(NdV.mul(2.0)).sub(V);
    /* 天光：`Rdir.y` 越小（越贴地平线）越亮，天顶方向压暗 —— 与真实夜空梯度一致。 */
    const rUp = clamp(Rdir.y, float(0.0), float(1.0));
    const skyEnv = mix(
        vec3(0.030, 0.052, 0.095),
        vec3(0.052, 0.086, 0.145),
        float(1.0).sub(rUp.pow(float(0.65))),
    );
    /* 月亮在反射方向上的映像：`pow(·, 90)` 很窄 ⇒ 只有波峰把视线折到月亮方向时才亮，
       于是沿水面拉出一条**被波浪打碎的长条**，而不是一块均匀亮斑。 */
    const moonDot = max(dot(Rdir, L), float(0.0));
    const moonImg = uSunColor.mul(moonDot.pow(float(90.0)).mul(float(1.35)));
    const reflTerm = skyEnv.add(moonImg).mul(Fres).mul(float(REFL_GAIN));

    /* ── ④ 岸边泡沫：内外两条水线各一条**窄且会被打碎**的带 ─────────────────
     *  ⚠️⚠️ 第一版把噪声频率开到 `FOAM_TILE 3.4`（周期 ≈0.3 m）—— 环带只有 7.5 m 宽、
     *  在 1000 px 屏上每米约 20 px，0.3 m 的图案落不到 2 个像素上 ⇒ **严重走样**，
     *  出图是一片规则的小方块（`w_close1.png` 放大后像马赛克）。
     *
     *  ⚠️⚠️ 2026-10-22 第四轮反馈「岸边一条很宽的纯白带像积雪」的根因（两条，都已改）：
     *    a) **宽度**：`FOAM_W = 0.55`，而 `foamInner` 是 `1 - smoothstep(0, 0.55, d)`，
     *       `foamBand = max(内, 外)` ⇒ 带宽是 **0.55 m**，不是「半宽 0.55」；再叠上
     *       `mask` 的 0.8 m 淡出带与水面不透明度，屏幕上读作一条 ~1 m 的实心白条。
     *       现在 `FOAM_W = 0.28`（全宽 0.28 m、外面还套一层 0.28→0.56 m 的碎沫尾巴），
     *       验收要求 ≤0.6 m 有富余。
     *    b) **实心**：`smoothstep(0.30, 0.86, lace*0.62 + foamBand*0.52)`。静止时
     *       `lace ∈ [0,1]`，只要 `lace > 0.42`，`lace*0.62 + 0.52 ≥ 0.78` 就已经在
     *       smoothstep 的 0.86 附近 ⇒ 带内**约 58% 的像素直接顶到 1.0**，视觉上就是纯白实心。
     *       现在是 `smoothstep(0.52, 1.02, lace*0.72 + foamBand*0.44)`：带中心
     *       (`foamBand = 1`) 需要 `lace > 0.80` 才过阈值 ⇒ 只有**零星几簇**碎沫，
     *       多数地方透出水色；`foamBand` 权重降低后，远处淡出更早。
     *    ⚠️ 2026-10-22 **第二轮**：上面这一调治过矫了 —— t8 实测近景**一个泡沫像素都没有**，
     *       岸带读作「消失」而不是「收窄」。按修复卡「把阈值上界从 1.02 降下来」改成
     *       `smoothstep(0.30, 0.86, lace*0.78 + foamBand*0.56)`：带心需要 `lace > 0.564`
     *       才过阈值 ⇒ 带内约 **26% 的像素出泡沫**（是"碎沫"，不是旧版 58% 的实心白条）。
     *       band 权重 0.44→0.56 让泡沫更贴近水线、远处更快淡出；亮线宽度仍由下面的
     *       `FOAM_W 0.28` 决定，与阈值无关 ⇒ 岸带宽度不受影响（仍 ≤0.6 m）。
     *  泡沫颜色也从 `C_FOAM`（#cfe6f2，接近纯白）降到 0.62 混合，避免 ACES + Bloom
     *  再把白条推亮。
     */
    const foamInner = float(1.0).sub(smoothstep(float(0.0), float(FOAM_W), r.sub(float(POND_R_IN))));
    const foamOuter = float(1.0).sub(smoothstep(float(0.0), float(FOAM_W), float(POND_R_OUT).sub(r)));
    const foamBand = max(foamInner, foamOuter);
    /* ⚠️ 2026-10-22（t17，修 t16 的 F2）：**噪声周期必须小于岸带宽度**。
        旧 `FOAM_TILE 1.15` ⇒ 周期 0.87 m，而岸带半宽只有 0.28 m，带内连半个周期都没有，
        `lace` 退化成常数 ⇒ 输出是一条沿带均匀的平滑渐变（t16 实测带内高通 std 仅 0.22、
        4× 放大是干净渐变），读作"白雾"而不是泡沫。
        现在 12.0 ⇒ 周期 ≈0.083 m，带内约 3.4 格；再叠一层 3.1 的粗倍频做块状分组：
        单倍频高频只是砂纸，两倍频才有"团 + 碎"的层次。两层的流速与相位都不同，
        避免两层在同一处同步成规则纹。 */
    const lace = laceNoise(positionWorld.xz.mul(float(FOAM_TILE)).add(vec2(t.mul(0.045), t.mul(-0.038))))
        .mul(0.5).add(0.5);
    const laceCoarse = laceNoise(positionWorld.xz.mul(float(1.5)).add(vec2(t.mul(-0.031), t.mul(0.026))))
        .mul(0.5).add(0.5);
    /* ⚠️ 2026-10-22（t17 第三段）：**先阈值纹理，再乘带权重**。
        上一版是 `smoothstep(0.80,1.10, lace*0.85 + coarse*0.22 + foamBand*0.45)`：
        带心 `foamBand=1` 已垫 0.45，噪声只需再多 0.35 就过阈值 ⇒ 覆盖率过高，
        3× 目视是满屏雪花点。现在纹理项单独判：`lace*0.62 + coarse*0.38` 均值 0.5，
        门槛 [0.58, 0.92] ⇒ 带心约 40% 面积有沫、且大部分是半透 ⇒ **团之间透水**；
        带权重后乘 ⇒ 外缘自然稀疏，不需要再靠 `foamBand` 进阈值。 */
    const foamTex = smoothstep(
        float(0.46), float(0.88),
        lace.mul(0.62).add(laceCoarse.mul(0.38)),
    );
    /* ⚠️ 2026-10-22（t17 第五段）：**岸线必须有，碎沫交给噪声**。
        上一版整条岸带全靠 `foamTex` 过阈值决定有没有沫 ⇒ 带只 0.22 m 宽、噪声周期 0.2 m，
        任何阈值都只能二选一：要么几乎没有（实测带内三通道>120 = 0.12%），要么满屏雪花。
        拆成两项：`foamLine` 是距水线 0.6~7.5 cm 的确定亮线（与噪声无关），
        `foamLace` 是衰减半径 0.30 m 的噪声碎沫。两者取 max，既有连续的湿岸线，又有团块与洞。 */
    const dEdgeW = min(r.sub(float(POND_R_IN)), float(POND_R_OUT).sub(r));
    /* 硬门：水面之内才允许有泡沫。泡沫不乘 `mask`（见下方 op 注释），
       不设这道门 `dEdge` 会被钳到 0，pad 区整片变白。 */
    const inWater = smoothstep(float(-0.015), float(0.015), dEdgeW);
    const dEdge = max(dEdgeW, float(0.0));
    /* ⚠️ 2026-10-22（t17 第六段）：噪声同时扰动**线宽**与**浓度**。
        上一版 `1 - smoothstep(0.006, 0.075, dEdge)` 是纯几何线：宽度恒定、亮度恒定，
        沿整段弧一模一样 ⇒ 1:1 目视读作「描边」。现在下界 0.4~2.6 cm、上界 5.2~10.7 cm
        随 `lace` 起伏（边缘毛糙），浓度 `0.42 + foamTex*0.58`（保底 0.42 ⇒ 岸线仍连续）。 */
    const foamLine = float(1.0).sub(smoothstep(
        float(0.004).add(lace.mul(0.022)),
        float(0.052).add(lace.mul(0.055)),
        dEdge,
    ))
        .mul(float(0.42).add(foamTex.mul(0.58)))
        .mul(inWater);
    const foamLace = foamTex
        .mul(float(1.0).sub(smoothstep(float(0.030), float(0.300), dEdge)))
        .mul(inWater);
    const foamShape = max(foamLine.mul(0.80), foamLace.mul(0.55));
    /* ⚠️ 2026-10-22（t17 第二段，修 t16 F1）：**覆盖度与强度分成两个量**。
        `foam` 含 `FOAM_STRENGTH(0.34)`，覆盖度拉满也只有 0.34；外缘 `mask→0` 时
        `op = foam*0.62 = 0.21` ⇒ 79% 透出深色岩砂 ⇒ 外岸带读作"没有"（t16 实测
        最大通道 (15,27,57)）。内岸看不见这个问题，只因那里 `mask≈1` 已经垫了 0.8 的不透明度。
        现在 `foamA` 是**纯覆盖度 0~1**，单独驱动不透明度；`foam` 只留给探针读数与颜色。 */
    /* 2026-10-22（t17 第五段）：`foamTex.mul(foamBand)` → `foamShape`。
       距离权重已经并入 `foamShape`（foamLine/foamLace 各自按 dEdge 衰减），
       再乘一次 `foamBand` 会把两个衰减叠起来，等于把泡沫又压回看不见。 */
    const foamA = foamShape.mul(float(FOAM_STRENGTH));
    const foam = foamA;   // 强度已并入 foamA，不要再乘一次（否则被平方）

    /* ── ⑤ 合成 ───────────────────────────────────────────────────────────── */
    const body = mix(
        vec3(C_SHALLOW.r, C_SHALLOW.g, C_SHALLOW.b),
        vec3(C_DEEP.r, C_DEEP.g, C_DEEP.b),
        depthT,
    );
    /* 环境光下限：夜里也要能看出「这是液体」。`uStarIntensity` 越低（越接近白天）越亮。
       2026-10-22：整体乘 1/3 并更偏蓝 —— 这一项是**平铺整片**的加法，
       原来 0.020/0.035/0.070 在夜间（`uStarIntensity≈1` ⇒ 系数 0.35）也有 0.007/0.012/0.025，
       加上底色本身的 B 分量后 R 与 B 的比值被压不下去。
       ── 第二轮：0.013/0.028/0.066（≈上一版的 2.2×）。俯视时 B≈90 在 ACES 后不到 7 尼特，
       整片水读作「黑洞」；抬高**只抬三通道等比的暗部地板**，不改色相，B/R 仍远大于 2。 */
    const amb = vec3(0.013, 0.028, 0.066)
        .mul(float(0.35).add(float(1.0).sub(uStarIntensity).mul(0.65)));

    const water = body.mul(0.92)
        .add(amb)
        .add(sheen.mul(fres.mul(float(SKY_REFL))))
        .add(skyCol.mul(float(0.06)))
        .add(glint)
        /* ★ t15：方向性环境反射（波浪结构的唯一来源，见 ②c 注释）。 */
        .add(reflTerm)
        /* ⚠️ 2026-10-22（t17，修 t16 的 F1）：0.62 → 0.92。外缘 `mask→0`，泡沫没有水色垫底，
           它必须自己把水线画出来。 */
        .add(vec3(C_FOAM.r, C_FOAM.g, C_FOAM.b).mul(foamA.mul(0.85)))
        /* ★ t1：同心涟漪的泡沫色 0.20 → 0.10（强度减半口径；半径/带宽同步收窄见上）。 */
        .add(vec3(C_FOAM.r, C_FOAM.g, C_FOAM.b).mul(ring.mul(0.10)))
        /* ★ 反馈3：脚踝白沫与尾迹用**同一个泡沫色**，但强度单独给 —— 它们是「接触证据」，
           比岸边泡沫更该在夜里看得见（岸边泡沫只在水线，人站在水中间时完全没有参考）。 */
        /* t19：0.50 → 0.95。换成乘性包络后接触区覆盖面积明显变小（噪声会打洞），
           必须提高颜色增益才回到「看得见但碎」的水平；实测 0.62 时脚边几乎归零（过度矫正）。 */
        .add(vec3(C_FOAM.r, C_FOAM.g, C_FOAM.b).mul(contact.mul(0.95)))
        .add(vec3(C_FOAM.r, C_FOAM.g, C_FOAM.b).mul(wake.mul(0.58)));

    m.colorNode = vec4(water, float(1.0));

    /* 泡沫不乘 `mask`：`mask` 在外缘恰好归零，而泡沫正该出现在那条水线上。
       泡沫带宽本身就落在环带内，不会溢出到干地。
       2026-10-22：`foam.mul(0.55)` → 0.30，泡沫自带的「增不透明」也跟着收窄，
       否则窄带里仍然会被推成一块实白。 */
    const op = mix(float(OP_MIN), float(OP_MAX), depthT).mul(mask)
        /* ⚠️ 2026-10-22（t17，修 t16 的 F1）：0.30 → 0.62。旧值 ⇒ 外岸带不透明度只有
           0.34×0.30 ≈ 0.10，叠在深色岩砂上读作"没有"（t16 实测外岸三通道>120 占比 0.0000%）。 */
        .add(foamA.mul(0.92))
        /* ★ t1：涟漪 alpha 0.04 → 0.02（减半）。 */
        .add(ring.mul(0.02))
        .add(contact.mul(0.70))
        .add(wake.mul(0.26));
    m.opacityNode = min(op.mul(float(WOP)), float(0.97));

    return m;
}

/* ── 3. 组件 ─────────────────────────────────────────────────────────────── */

export function CraterWater(): JSX.Element | null {
    const ref = useRef<THREE.Mesh>(null);
    /* 与其它子系统同一套可见半径：锚点 = 坑心，60 m 回望时整块水不提交。 */
    useVisGate(ref, POND_CX, POND_CZ);

    const geo = useMemo(() => (WATER_ON ? buildSurface() : null), []);
    const mat = useMemo(() => (WATER_ON ? buildMaterial() : null), []);

    useFrame((state) => {
        tickWaterTime(state.clock.elapsedTime);
    });

    if (!WATER_ON || !geo || !mat) return null;
    return (
        <mesh
            ref={ref}
            name="crater-water"
            geometry={geo}
            material={mat}
            position={[POND_CX, 0, POND_CZ]}
            frustumCulled={false}
            renderOrder={2}
        />
    );
}

/* 无头探针：几何/材质是否真的建出来了（`?craterwater=0` 时是 false）。 */
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__craterWater = () => ({
        on: WATER_ON,
        mode: SURFACE_MODE,
        rIn: POND_R_IN,
        rOut: POND_R_OUT,
        depth: POND_DEPTH,
        depthMax: POND_DEPTH_MAX,
        waterYPlane: +pondWaterY().toFixed(3),
        center: [POND_CX, POND_CZ],
        maskAtMid: +pondMaskAt(POND_CX + (POND_R_IN + POND_R_OUT) / 2, POND_CZ).toFixed(3),
        waterYAtMid: +waterYAt(POND_CX + (POND_R_IN + POND_R_OUT) / 2, POND_CZ).toFixed(3),
        groundAtMid: +worldHeightCPU(POND_CX + (POND_R_IN + POND_R_OUT) / 2, POND_CZ).toFixed(3),
        /* 新版外观参数（便于无头 A/B 时核对用的是哪一组） */
        normalStrength: NORMAL_STRENGTH,
        normalTile: NORMAL_TILE,
        normalLayers: 4,
        fineTile: FINE_TILE,
        fineWeight: FINE_WEIGHT,
        glintGain: GLINT_GAIN,
        foamStrength: FOAM_STRENGTH,
        foamW: FOAM_W,
        skyRefl: SKY_REFL,
        opMin: OP_MIN,
        opMax: OP_MAX,
        sheen: '#' + C_SHEEN.getHexString(),
        deep: '#' + C_DEEP.getHexString(),
    });
}









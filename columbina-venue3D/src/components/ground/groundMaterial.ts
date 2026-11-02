/**
 * 月坑土壤 / 岩石材质（t6）—— 真实 PBR 贴图 + 真正驱动镜面的 roughness。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么要有这个目录（用户追加任务 5：「月坑的土壤材质观感一般。去找土壤，
 * 岩石，之类的素材」）
 *
 * 现状（`_logs/briefs/ground-refs.md` §1，t2 调研）：
 *   · `GroundMaps.rough` 三套贴图全被加载、`Terrain.tsx` 里**零消费者** ⇒
 *     `mat.roughness = 1.0` 是个常数，所有像素一样平；
 *   · 反照率四层全都取自 `moon_dusted_01` / `moon_meteor_01`（同一种尘），
 *     法线三层也全是 `moon_dusted_01` ⇒ 整片月面是「一种材料、一个尺度」；
 *   · 坑底（`craterFloorWeightNode`）只叠了反照率土纹，**没有自己的法线与粗糙度**
 *     ⇒ 坑内「会场化松软月壤」和坑外「月海玄武岩」在物理上无从区分。
 *
 * 本目录做三件事（全部只影响着色，**不进高度链**，`getWorldHeight()` 一字不改）：
 *   ① `loadGroundPBR()` —— 按 t2 §3.2 的视觉复核结论取素材：
 *        基底（软、低对比）      `moon_flat_macro_01`  diff/nor_gl/rough
 *        近景颗粒（中对比、含砾）`moon_macro_01`       diff/nor_gl/rough
 *        暗斑/小碎石（稀疏引用）  `rocks_ground_06`     diff/rough
 *      三套都是 Poly Haven CC0，已转 **RGBA PNG**（RGB JPEG 会触发
 *      `Unsupported texture type with RGBFormat. 1009` ⇒ 整个材质消失）。
 *   ② `groundLayerNodes()` —— 把「坑内软月壤」与「坑外月海玄武岩」做成两套**材料**：
 *        坑内（`craterFloorWeightNode`，会场化松软土）：近景颗粒是 `moon_macro_01`，
 *             小尺度、低坡度、粗糙度靠近 1（无镜面波瓣，尘面）；
 *        坑外（`wMoon`）：基底是 `moon_flat_macro_01`，中尺度，伴一层 ≤0.15 权重的
 *             `rocks_ground_06` 暗斑（月海玄武岩的碎石疙瘩）。
 *   ③ `groundRoughNode()` —— 真正接到 `mat.roughnessNode` 上的粗糙度，
 *      值域 `mix(0.55, 1.0, r)`（月壤真实 roughness 0.90–1.0，见 `ground-refs.md` §3）。
 *
 * ⚠️⚠️ 尺度纪律（t2 §3 的算术，**这是不出高频闪的关键**）：
 *   地形顶点量化是 **0.625 m**（`Terrain.tsx` 的 `segments = area / 0.625`）。
 *   任何一层贴图的「一个纹素对应的地面尺寸」必须 ≥ 该层顶点间距的若干分之一，
 *   否则法线在相邻顶点之间随机跳 ⇒ 相机一动就闪。
 *   1024 px 铺 T 米 ⇒ 纹素 = T/1024 m：
 *     T = 2.9  m ⇒ 2.8 mm/texel（顶点 0.625 m ⇒ 一层只采到 220 纹素，安全）
 *     T = 0.9  m ⇒ 0.9 mm/texel（坑底旧值：2K 铺 0.9 m 曾是 0.44 mm）
 *   最细那层保持 **3.0 m**（t2 §4 的「坑底三层撤 0.9 m」），并且**不新增 <2.9 m 的层**
 *   （`ground-refs.md` §5 禁行项：0.62 m 实测出方格瓷砖 `F3_low.png`）。
 *
 * ⚠️ 本项目 WebGPU 管线里 `MeshStandardNodeMaterial` 的 `normalNode` 是**生效的**
 *   （`Terrain.tsx` 已经在用）；`roughnessNode` 本轮首次接线，所以留了
 *   `?groundrough=0` 这个 A/B 开关（回到 `mat.roughness = 1.0` 的老行为）——
 *   「参数打印正确 ≠ 功能生效」，判据必须是同机位像素差 + 目视。
 * ════════════════════════════════════════════════════════════════════════════
 */
import * as THREE from 'three/webgpu'
import { vec2, vec3, float, mix, texture, dot, length, min, max } from 'three/tsl'
import { QNUM } from '../../core/utils/query'
import {
    moonShadeWeightNode,
    craterFloorWeightNode,
} from '../../core/shaders/worldHeight'

/* ⚠️⚠️ 临时诊断开关（t6 定位 RGBFormat 1009 用，**出图后必须删**）：
 *   ?gfile=1 把所有贴图改指到 _probe/ 下同名的**改动前磁盘副本**。
 *   存在的理由：5181 上的 vite 对所有**已加载过的**模块给的是旧编译结果，
 *   改了 GroundMaps/Terrain 的加载路径也不会生效；而全新的 URL 参数是**新代码路径**，
 *   可以带上一套不同的贴图 URL ⇒ 用同一份旧模块做「换一张图会不会再报 1009」的对照实验。
 *   ?gfile=2 只对 legacy 三套（moon_*_01 / _meteor_）改指副本，其它不变。
 */
const GFILE = QNUM('gfile', 0)!

/* ══════════════════════════════════════════════════════════════════════════
 *  开关（缺省 = 交付值；留 URL 参数是为了 A/B 可复现）
 * ══════════════════════════════════════════════════════════════════════════ */

/** ⚠️ **缺省 0（关闭）** —— 2026-10-22 t6 收尾裁定。
 *  新 PBR 土壤材质（Poly Haven `moon_dusted_01` / `moon_macro_01` / `moon_flat_macro_01` /
 *  `rocks_ground_06`）在**坑底机位**上会把整片地面压到接近全黑，而且连蓝喇叭花一起消失
 *  （`cam=0,8,-190 look=0,0,-198`：`?gsoil=1` mean 17.9 / 暗像素 85.7%，`?gsoil=0`
 *  mean 115.3 / 暗像素 1.1%）。
 *  已排除：法线层（`?gsoiln=0` 无变化）、`rocks` 法线代理（`?grocksn=0` 无变化）、
 *  粗糙度（`?groundrough=0` 无变化）、贴图格式（11 张实测全是 `RGBAFormat 1023 /
 *  UnsignedByteType 1009`）、`lumNormalized` 常数（4 张 albedo 实测线性均值
 *  0.1908 / 0.1845 / 0.2273 / 0.2549，与硬编码值逐位相同）、shader 编译（无报错）。
 *  ⇒ 病根在 `groundAlbedoFactor()` 的 `inside`/`outside` 组合上，**未定位完**。
 *  宁可不发，也不发一个把会场压黑的新材质：缺省关，管线留在 `?gsoil=1` 后面。 */
const GSOIL_ON = QNUM('gsoil', 0)! > 0
/** `?groundrough=0`：不接 `roughnessNode`，退回 `mat.roughness = 1.0`。
 *  **验收判据就是它** —— 缺省与 `0` 的近景 1:1 若像素差≈0，说明 roughness 没生效。 */
const GROUND_ROUGH_ON = QNUM('groundrough', 1)! > 0
/** `?grock=`：坑外月海那层 `rocks_ground_06` 暗斑的权重上限。t2 §4 要求 ≤0.15。 */
const GROCK_W = QNUM('grock', 0.13)!
/** `?gnear=`：坑内 `moon_macro_01` 近景颗粒层强度。 */
const GNEAR_W = QNUM('gnear', 0.55)!
/** `?gbase=`：坑外 `moon_flat_macro_01` 基底层的强度。 */
const GBASE_W = QNUM('gbase', 0.45)!
/** `?groughlo=`：粗糙度下限。月壤 0.90~1.0，但**全是 0.9x 就等于没有变化**，
 *  所以映射到 `mix(0.55, 1.0, r)` —— 让 r 的 0.86~0.99 实际张成 0.55~1.0，
 *  镜面强度在「湿一点的尘」到「完全干燥的尘」之间可见地变化（见 t2 §3）。 */
const GROUGH_LO = QNUM('groughlo', 0.55)!
/** `?groughhi=`：粗糙度上限。 */
const GROUGH_HI = QNUM('groughhi', 1.0)!
/** `?grocksn=`：`rocks_ground_06` 反照率差分当凹凸代理的系数。
 *  缺省 **0.018**（= 目标扰动 p99 0.12 ÷ 实测梯度 p99 6.7，见 `groundNormalPerturb` 注释）。
 *  这个数字是**从实测反推的**，不是拍的：同一条链上取 0.60 会得到 4.0 的扰动，
 *  把法线压平、整片地面黑掉且不报错。`?grocksn=0` 可完全关掉这条代理。 */
const GROCKS_N = QNUM('grocksn', 0.018)!
/** `?gsoiln=`：整套地法线层的强度倍率（在 `M_NORMAL_STRENGTH` 之后再乘一次）。
 *  缺省 1。**留这个开关是为了「法线是不是元凶」永远能一次 A/B 验证**。 */
const GSOIL_N = QNUM('gsoiln', 1.0)!

/* ══════════════════════════════════════════════════════════════════════════
 *  素材（Poly Haven CC0，已转 RGBA PNG）
 * ══════════════════════════════════════════════════════════════════════════ */

const DIR = '/textures/ground'

/** 一套 PBR 贴图的运行时状态。`null` = 还在加载或加载失败（调用方要能吃 null）。 */
export interface GroundPBRSet {
    key: string
    albedo: THREE.Texture
    normal: THREE.Texture | null
    rough: THREE.Texture
    /** 反照率的**线性空间**亮度均值（three 的 `texture()` 返回线性值，所以用它归一化）。
     *  数值来自 `_logs/briefs/_tmp/ground_dl/stats.json`（全分辨率算），
     *  由 `_tools/_t6_conv.py` 写入，不在运行期统计。 */
    lumMean: number
    /** 一张贴图铺多少米（见文件头的尺度纪律）。 */
    tile: number
}

export interface GroundPBR {
    /** 坑外月海基底：软、低对比、无大结构。 */
    base: GroundPBRSet
    /** 近景颗粒：中对比、含砾石点，用于坑内松软月壤 + 坑外近景。 */
    near: GroundPBRSet
    /** 碎石暗斑：只取反照率/粗糙度，小权重混在月海区。 */
    rocks: GroundPBRSet
}

/* 线性亮度均值（Rec.709，sRGB→linear 之后）。由 `_tools/_t6_conv.py` 的 `gray` 字段给出。
 * ⚠️ 归一化只除**亮度**、不除逐通道均值（t2 §3：逐通道除会让色温一起被抹平，
 *    月壤的暖色调 R>G>B 是「太空风化红化」的物理特征，必须保留）。 */
const LUM_FLAT = 0.2273
const LUM_MACRO = 0.1845
const LUM_ROCKS = 0.2549

const loader = new THREE.TextureLoader()

function loadTex(url: string, srgb: boolean): Promise<THREE.Texture> {
    if (GFILE && (GFILE === 1 || url.indexOf('moon_dusted_01_') >= 0 || url.indexOf('moon_meteor_01_') >= 0)) {
        url = url.replace('/textures/ground/', '/textures/ground/_probe/a_')
    }
    console.log('[ground] tex', url)
    return loader.loadAsync(url).then((t) => {
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.RepeatWrapping
        /* 各向异性 8：颗粒层铺到 3 m 时，掠射角下的地面纹素会挤成一条，
           开到 8 能保住「远处那一层细颗粒」不糊成一片灰。 */
        t.anisotropy = 8
        /* ⚠️ 法线/粗糙度是**数据贴图**，必须留在 NoColorSpace；
           ⚠️⚠️ 本项目 `R_VIS = 40` 的渲染距离语义（t4）要求 40 m 外退化成裸基底，
           但**贴图采样本身不需要**在这里处理距离，`renderFadeNode` 由调用方乘。 */
        if (srgb) t.colorSpace = THREE.SRGBColorSpace
        t.needsUpdate = true
        return t
    })
}

function loadSet(key: string, files: { diff: string; nor?: string; rough: string }, lumMean: number, tile: number): Promise<GroundPBRSet> {
    const jobs: Promise<THREE.Texture>[] = [
        loadTex(`${DIR}/${files.diff}`, true),
        loadTex(`${DIR}/${files.rough}`, false),
    ]
    if (files.nor) jobs.push(loadTex(`${DIR}/${files.nor}`, false))
    return Promise.all(jobs).then((ts) => ({
        key,
        albedo: ts[0],
        rough: ts[1],
        normal: files.nor ? ts[2] : null,
        lumMean,
        tile,
    }))
}

/* ★ 单例 + 「加载中就复用同一个 Promise」：`Terrain` 的 `useMemo` 依赖这个对象，
   每次重建材质都重新加载一遍会在切场景时产生 3×6 MB 的重复下载。 */
let _pbr: Promise<GroundPBR> | null = null

/** 装载三套 PBR。失败时 **reject**（调用方退回老路径），不静默吞掉。 */
export function loadGroundPBR(): Promise<GroundPBR> {
    if (_pbr) return _pbr
    _pbr = Promise.all([
        /* 坑外基底：`moon_flat_macro_01`（t2 §3.2 视觉复核的「首选基底」）。
           铺 **17.7 m**：1024 px ⇒ 17.3 mm/texel，跟地形顶点 0.625 m 差 36 倍，
           不会在顶点之间跳；这一层只给「大尺度柔和起伏」，不是颗粒层。 */
        loadSet('flat', {
            diff: 'moon_flat_macro_01_diff_1k.png',
            nor: 'moon_flat_macro_01_nor_gl_1k.png',
            rough: 'moon_flat_macro_01_rough_1k.png',
        }, LUM_FLAT, 17.7),
        /* 近景颗粒：`moon_macro_01`（t2 §3.2「近景颗粒层改成它」）。
           铺 **3.0 m**：1024 px ⇒ 2.9 mm/texel；法线斜率均值 0.19（比旧 `moon_dusted` 的
           0.19 同量级但分布更宽，p99 0.50），这是「看得见颗粒」的那一层。
           ⚠️ 3.0 m ≥ 0.625 m 顶点间距的 4.8 倍 ⇒ 安全（t2 §3 的算术）。 */
        loadSet('macro', {
            diff: 'moon_macro_01_diff_1k.png',
            nor: 'moon_macro_01_nor_gl_1k.png',
            rough: 'moon_macro_01_rough_1k.png',
        }, LUM_MACRO, 3.0),
        /* 碎石暗斑：`rocks_ground_06`。t2 §3.2 说它**不能当整面基底**（地表的碎石形状
           会读成「铺了小石子」+ 大块重复），但**当稀疏暗斑可以**。
           铺 **17.7 m**（= 与基底层同尺度）：1024 px 铺 17.7 m ⇒ 一层里最大那块岩
           约 19 cm（t2 §3 的算术），正好是「月海玄武岩的疙瘩」而不是「一堆石子」。 */
        loadSet('rocks', {
            diff: 'rocks_ground_06_diff_1k.png',
            rough: 'rocks_ground_06_rough_1k.png',
        }, LUM_ROCKS, 17.7),
    ]).then(([base, near, rocks]) => {
        console.log(
            `[ground] PBR ready: flat(tile ${base.tile} m) macro(tile ${near.tile} m) rocks(tile ${rocks.tile} m)` +
            ` · rough consumers=${GROUND_ROUGH_ON ? 'on' : 'off'} gsoil=${GSOIL_ON ? 'on' : 'off'}`,
        )
        return { base, near, rocks }
    }).catch((err) => {
        /* 失败要响（第四轮反馈 3 的同一条判据）：材质会退回老路径，
           所以必须在 Console 上留下可定位的一行。 */
        console.error('[ground] PBR 贴图加载失败，退回旧月壤路径（不需重载页面也能看到这行）：', err)
        _pbr = null
        throw err
    })
    return _pbr
}

/** 是否整块启用（`?gsoil=0` 时调用方直接用老路径）。 */
export const GROUND_SOIL_ON = GSOIL_ON
/** 是否把 roughness 接到 `mat.roughnessNode`（`?groundrough=0` 时调用方用 `mat.roughness = 1`）。 */
export const GROUND_ROUGH_ENABLED = GROUND_ROUGH_ON

/* ══════════════════════════════════════════════════════════════════════════
 *  采样工具
 * ══════════════════════════════════════════════════════════════════════════ */

/** 与 `Terrain.tsx` 的 `rotUV` **同一个公式**（同一张图叠多层必须各转一个角度，
 *  否则方向性结构（沙纹/纹理走向）同向叠加 ⇒ 木纹 / 刷痕）。
 *  ⚠️ 本文件不 import `Terrain.tsx`（那是组件文件，会拖进 React），所以这里留一份；
 *    两边的公式必须一致，改一个要改另一个。 */
function rotUV(uv: any, deg: number, off: [number, number]): any {
    const a = (deg * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    return vec2(
        uv.x.mul(float(c)).sub(uv.y.mul(float(s))),
        uv.x.mul(float(s)).add(uv.y.mul(float(c))),
    ).add(vec2(off[0], off[1]))
}

const LUMA = vec3(0.2126, 0.7152, 0.0722)

/** 取一张反照率的**亮度**，并除以它自己的线性亮度均值 ⇒ 「均值 = 1 的斑驳」，
 *  只保留变化、不改整体明暗（区域底色说了算）。 */
function lumNormalized(tex: THREE.Texture, uv: any, lumMean: number): any {
    const c = texture(tex, uv).rgb
    return dot(c, LUMA).div(float(lumMean))
}

/* ══════════════════════════════════════════════════════════════════════════
 *  反照率层：坑内 / 坑外两套材料
 * ══════════════════════════════════════════════════════════════════════════ */

/** 采样法线贴图并还原成切空间 (−1..1)。**贴图缺失时返回零扰动量**而不是把
 *  `undefined` 递给 `texture()`。
 *  ⚠️ 这是本轮踩过的真雷：`rocks_ground_06` **没有 nor 图**（Poly Haven 那套只有 diff/rough/arm），
 *    `texture(undefined)` 会建出内部格式为 `undefined` 的纹理节点，WebGPU 在装机时
 *    报 `Unsupported texture type with RGBFormat. 1009`，**整个地形材质消失**
 *    （不是变暗，是没了）。症状极难定位：控制台只有一行与「你哪里写错」无关的格式告警。 */
function normalSample(tex: THREE.Texture | null, uv: any): any {
    if (!tex) return vec3(0, 0, 0)
    return texture(tex, uv).rgb.mul(float(2)).sub(float(1))
}

/**
 * 返回一个**乘在区域底色上**的反照率因子（均值 ≈ 1）。
 *
 * @param xz    世界 XZ（`vec2`）
 * @param wMoon 调用方算好的月壤外观权重（`moonShadeWeightNode`），避免重复求值
 *
 * 分层（t2 §4 的指令 + 尺度纪律）：
 *   坑外 `wMoon`：`moon_flat_macro_01` @17.7 m（软基底）+ `rocks_ground_06` @17.7 m 的
 *                **暗斑**（≤0.13，同一尺度 ⇒ 不会出「贴了两套图」的鬼影）
 *   坑内 `cf`  ：`moon_macro_01` @3.0 m（近期颗粒/砾石）+ `moon_flat_macro_01` @7.0 m
 *                （柔和起伏，与 3.0 m 取无理数比 2.33 打散重复）
 * 坑壁 `cw`   ：作为过渡，把坑内/坑外两套按 `craterWallWeightNode` 之间插值。
 *
 * ⚠️ **40 m 语义**：本函数**不乘** `renderFade`。调用方（`Terrain.tsx`）把它塞进已有的
 *     `.mul(renderFade)` 链条里 —— t4 的「40 m 外裸基底」必须原样保留。
 */
export function groundAlbedoFactor(xz: any, pbr: GroundPBR, wMoon: any): any {
    const cf = craterFloorWeightNode(xz)
    /* ── 坑外：月海玄武岩 ─────────────────────────────────────────── */
    const bA = lumNormalized(pbr.base.albedo, rotUV(xz.div(float(pbr.base.tile)), 11.3, [0.21, 0.57]), pbr.base.lumMean)
    const rA = lumNormalized(pbr.rocks.albedo, rotUV(xz.div(float(pbr.rocks.tile)), 67.9, [0.73, 0.31]), pbr.rocks.lumMean)
    /* 暗斑只在贴图**暗**的地方压下去（`1 - r` ⇒ r<1 时才 >0），且方向单一（只压不提）：
       碎石在月海上是「藏在尘里的暗疙瘩」，不是与尘同亮的另一种灰。 */
    const rockDark = float(1).sub(rA).max(float(0)).mul(float(GROCK_W))
    const outside = bA.mul(float(1).add(float(GBASE_W).mul(bA.sub(float(1)))))
        .sub(rockDark)

    /* ── 坑内：会场化松软月壤 ─────────────────────────────────────── */
    const nA = lumNormalized(pbr.near.albedo, rotUV(xz.div(float(pbr.near.tile)), 0, [0, 0]), pbr.near.lumMean)
    const nB = lumNormalized(pbr.base.albedo, rotUV(xz.div(float(pbr.near.tile * 2.33)), -38.7, [0.41, 0.83]), pbr.base.lumMean)
    const inside = mix(float(1), nA, float(GNEAR_W)).mul(mix(float(1), nB, float(0.30)))

    /* ── 坑壁过渡 + 只活在月面 ───────────────────────────────────── */
    /* 用 `?craterwall=0` 那条支路时 `cf` 与坑壁权重是同一个量，所以直接以 `cf` 插值即可；
       其余地方（会场、森林）`wMoon = 0` ⇒ 因子恒 1 ⇒ **零回归**。
       ⚠️ `craterWallWeightNode` 在这里**不消费**：它与 `cf` 的分工（颜色 vs 月壤退场）
          是 `Terrain.tsx` 那一层的事，本模块只管「坑内材料 vs 坑外材料」。 */
    const soil = mix(outside, inside, cf)
    return mix(float(1), soil, wMoon)
}

/* ══════════════════════════════════════════════════════════════════════════
 *  法线层：坑内 / 坑外两套
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 世界空间的法线扰动量 `(nx, 0, ny)`（未归一化，由调用方加到 `vNormal` 上再归一化）。
 *
 * 切片空间 → 世界：(nx, ny, nz) 映射成 (nx, 0, ny)。地形面是 XZ 平面、法线朝 +Y，
 * 切向 +X/+Y 就是世界 +X/+Z —— 与 `Terrain.tsx` 里老的三层贴图是**同一条映射**，
 * 所以新层和老层叠加不会互相抵消。
 *
 * 分层（**每层转角互不相同**，否则同向叠加出规则条纹）：
 *   坑外：`moon_flat_macro_01` @17.7 m（中尺度柔和）+ `rocks_ground_06` 提供的小碎石起伏
 *        （本层没有 nor 贴图 ⇒ 用它的**反照率高频**当凹凸代理，权重压到 0.15 以内）
 *   坑内：`moon_macro_01` @3.0 m（颗粒）+ `moon_flat_macro_01` @7.0 m（起伏）
 *
 * ⚠️ 尺度：最细 3.0 m（1024 px ⇒ 2.9 mm/texel），**不引入 <2.9 m 的层**。
 * ⚠️ `renderFade` 由调用方乘（t4 的 40 m 语义）。
 */
export function groundNormalPerturb(xz: any, pbr: GroundPBR): any {
    const cf = craterFloorWeightNode(xz)

    /* 坑外：基底法线（中尺度）+ 碎石高频代理（反照率偏离自身 3×3 邻域太贵，
       这里改用「暗斑的梯度方向」的廉价代理：把反照率当高度做一次差分）。
       ⚠️ 差分步长 0.05 m **小于** 3 m 层的纹素 2.9 mm 的 17 倍，是安全的；
          但**必须比 rocks 层的纹素（17.3 mm）大**才有意义 ⇒ 取 0.05 m（≈3 纹素）。 */
    const nBase = normalSample(pbr.base.normal, rotUV(xz.div(float(pbr.base.tile)), 0, [0, 0]))
    const e = float(0.05)
    const rH = (q: any): any => dot(texture(pbr.rocks.albedo, rotUV(q.div(float(pbr.rocks.tile)), 67.9, [0.73, 0.31])).rgb, LUMA)
    const r0 = rH(xz)
    const rdx = rH(xz.add(vec2(e, float(0)))).sub(r0).div(e)
    const rdz = rH(xz.add(vec2(float(0), e))).sub(r0).div(e)
    /* ⚠️⚠️ 本轮踩过的**第二个真雷**，比 RGBFormat 更隐蔽（画面不报错，直接黑屏）：
        `dL/de` 出来的量级是 **p99 ≈ 6.7 /m**（反照率在 0.05 m 内就能差 1/3）。
        × 0.60 之后扰动 ≈ 4.0 —— 而老的三层法线贴图扰动模长只有 ≈ 0.12（p99 0.40
        × 权重 0.30），再乘 `M_NORMAL_STRENGTH = 0.32` ⇒ 实际加到法线上的只有 ≈ 0.04。
        **4.0 是老量的 100 倍**：`n.normalize()` 之后 Y 分量被压到 ≈ 0.02（法线几乎平躺），
        整片地面进入掠射 ⇒ 天空/无光照乘 0 ⇒ **画面全黑但没有任何报错**。
        ⇒ 系数必须与 `macro` 法线的实测量级对齐：目标扰动 p99 ≈ 0.12 ⇒ `0.12 / 6.7 ≈ 0.018`，
           再乘一个可随时归零的开关（`?grocksn=`），缺省 0.018。
       ⚠️ 这也说明「用反照率差分当凹凸代理」在物理上是错的（反照率不是高度），
          它只能当**极低权重**的补充，不能当主起伏。 */
    const rN = vec3(rdx.negate(), float(0), rdz.negate()).mul(float(GROCKS_N))
    const outside = vec3(nBase.x, float(0), nBase.y).mul(float(0.75)).add(rN)

    /* 坑内：颗粒 @3.0 m（主）+ 起伏 @7.0 m（辅） */
    const nNear = normalSample(pbr.near.normal, rotUV(xz.div(float(pbr.near.tile)), 0, [0, 0]))
    const nIn = normalSample(pbr.base.normal, rotUV(xz.div(float(pbr.near.tile * 2.33)), -38.7, [0.41, 0.83]))
    /* 内层两套法线的实测 p99 分别是 0.39 / 0.035 ⇒ 0.62/0.30 的配比把内层扰动
       做成 ≈ 0.25，比外层（≈0.09）明显更「毛」，这正是「松软月壤 vs 月海」的
       手感差别。⚠️ 两者都不许超过 PERTURB_MAX（见下）。 */
    const inside = vec3(nNear.x, float(0), nNear.y).mul(float(0.45))
        .add(vec3(nIn.x, float(0), nIn.y).mul(float(0.30)))

    /* ⚠️⚠️ 总闸：**法线扰动必须是「在 +Y 上的一小段倾斜」，不能是任意大向量。**
       调用方拿到之后只会 `add` 到 (0,1,0) 再 `normalize()`；一旦扰动模长接近或超过 1，
       归一化后的 Y 分量就趋近 0，地面变成「平躺的镜子」⇒ 掠射 ⇒ 全黑（本轮已踩两次）。
       这里把 XZ 分量的模长**整体**压到 PERTURB_MAX 以内（按比例缩，不改方向），
       于是「哪个权重写大了」永远不会变成黑屏，最坏只是这一层变弱。
       量级依据：老三层法线给到调用方的实际是 0.12 × 0.32 ≈ 0.04，
       这里取 0.25（约 6 倍，足够看出「颗粒」），仍远小于 1（安全边界 4 倍余量）。 */
    const PERTURB_MAX = 0.25
    const v = mix(outside, inside, cf).mul(float(GSOIL_N))
    const xzLen = length(vec2(v.x, v.z))
    /* `min(1, max/len)` 而不是 `step`：连续、不产生环形硬边。len=0 时除零由 max 兜住。 */
    const scale = min(float(1), float(PERTURB_MAX).div(max(xzLen, float(1e-5))))
    return v.mul(scale)
}

/* ══════════════════════════════════════════════════════════════════════════
 *  粗糙度：真正驱动镜面
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * `mat.roughnessNode` 的取值。值域 `mix(GROUGH_LO, GROUGH_HI, r)`。
 *
 * ⚠️ 为什么不是直接用 `r`：三套图的 rough 实测均值 0.86~0.96、**标准差极小**
 *    （`moon_dusted_01` p10/p50/p90 = 0.965/0.973/0.980），直接用等于一个常数，
 *    镜面强度不会变 ⇒ 这正是改前「观感一般」的一半原因。
 *    映射到 `mix(0.55, 1.0, r)` 后，同一张图的 0.86~0.99 张成 0.55~1.0，
 *    差别才落到可见区间（t2 §3「roughness 必须给消费者」）。
 *
 * 坑内（松软、更干、几乎无波瓣）把粗糙度再抬一点，坑外（月海玄武岩，有碎石、
 *   局部有薄尘覆盖）保留下限 —— 这是「坑内坑外可区分」在**光照**上的那一半
 *   （反照率那一半在 `groundAlbedoFactor`）。
 */
export function groundRoughValue(xz: any, pbr: GroundPBR): any {
    const cf = craterFloorWeightNode(xz)
    const rOut = dot(texture(pbr.base.rough, rotUV(xz.div(float(pbr.base.tile)), 0, [0, 0])).rgb, LUMA)
    const rIn = dot(texture(pbr.near.rough, rotUV(xz.div(float(pbr.near.tile)), 21.7, [0.11, 0.83])).rgb, LUMA)
    /* 碎石层粗糙度更低一点点（岩石本身比尘光滑）—— 和暗斑同一块地方，
       于是「暗 → 略亮一点的镜面」在光照下能读出来，这是岩石感的来源之一。 */
    const rRock = dot(texture(pbr.rocks.rough, rotUV(xz.div(float(pbr.rocks.tile)), 67.9, [0.73, 0.31])).rgb, LUMA)
    const out = mix(rOut, rRock, float(GROCK_W))
    const r = mix(out, rIn, cf)
    return mix(float(GROUGH_LO), float(GROUGH_HI), r)
}


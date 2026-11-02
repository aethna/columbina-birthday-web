import * as THREE from 'three/webgpu'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import {
    Fn,
    vec2,
    vec3,
    vec4,
    float,
    mix,
    positionLocal,
    modelWorldMatrix,
    cameraViewMatrix,
    cameraPosition,
    varying,
    smoothstep,
    length,
    dot,
    clamp,
    texture,
    mx_noise_float,
    sin,
    attribute,
} from 'three/tsl'
/* ⚠️ t6：TSL 的 `uniform` 在本文件里必须走这个别名 —— 同时从 `three/tsl` 与
   `useGrassUniforms` 那条链间接导入同名符号时，esbuild 打包会把裸 `uniform(...)`
   留成未绑定标识符，浏览器抛 ReferenceError 整站白屏（本轮实测过，见环带材质处注释）。 */
import { uniform as tslUniform } from 'three/tsl'
import { DEFAULT_GRASS_AREA_SIZE } from './grass/core/config'
import {
    getWorldHeight,
    regionGroundColorNode,
    groundGrainNode,
    detailPerturbNode,
    detailStrengthNode,
    detailFadeNode,
    grainFadeNode,
    renderFadeNode,
    renderFadeCPU,
    renderFadeReport,
    /* t3: distance fade of the bright far floor (color + geometry), see worldHeight.ts */
    groundFadeNode,
    groundGeomFadeNode,
    groundFadeCPU,
    groundGeomFadeCPU,
    groundFadeReport,
    /* t6：`__gfade('all').edge` / `.ring` 用到。漏掉这一行时 `vite build` 仍 exit 0，
       但打包后是未绑定裸名 ⇒ 浏览器 ReferenceError（与 `uniform` 那个坑同类）。 */
    groundFadeEdgeReport,
    GROUND_FADE_ON,
    GROUND_FADE_TRANSPARENT,
    moonShadeWeightNode,
    craterFloorWeightNode,
    craterBlueWeightNode,
} from '../core/shaders/worldHeight'
import { REGION_BY_ID, CRATER_GRAIN_ON, worldHeightCPU } from '../core/worldRegions'
import { loadMoonRegolith, loadMoonMeteor, type GroundMaps } from '../core/textures/groundMaps'
/* ★ t6（第四轮追加任务 5）：月坑土壤 / 岩石的真实 PBR 层。
   本模块只出「材料因子」，**内部不乘 renderFade** —— t4 的 40 m 语义由下面
   每一处 `.mul(renderFade)` 原样保留（见 t6 接线处的逐行说明）。 */
import {
    loadGroundPBR,
    groundAlbedoFactor,
    groundNormalPerturb,
    groundRoughValue,
    GROUND_SOIL_ON,
    GROUND_ROUGH_ENABLED,
    type GroundPBR,
} from './ground/groundMaterial'
import { uTime } from '../core/shaders/uniforms'
import { getTerrainNormal } from '../core/shaders/terrainHelpers'
import { uTerrainColor, uVacuumNight, uSunDir, uSkyHorizon } from '../core/shaders/uniforms'
/* t3: GROUND_FOG_COLOR is the groundFog paint color (GCOLOR), written every frame
   by WorldController from dayness. Venue/forest beyond 40 m is already painted
   with it, so fading the far floor toward it lets the fog take over seamlessly. */
import { GROUND_FOG_COLOR } from '../core/shaders/groundFog'
/* t6 复核修正：环带草簇初值取会场草 palette（与真草同一份真值） */
import { VENUE } from '../core/venuePalette'
import { useGridSnapping } from '../core/utils/gridSnapping'
import { QNUM } from '../core/utils/query'
/* t6 环带草簇：材质直接从草材质那一份参数里取基色/尖端色/叶形，
   保证「盖地板用的草」和「真草」是同一套配色，不会出现两种绿。 */
import { useGrassUniforms } from './grass/hooks/useGrassUniforms'

/* 地表细节的两级开关（A/B 对照用；判据「参数打印正确 ≠ 功能生效」）。
 * 颗粒只改反照率、微观法线只改光照，都不进高度 ⇒ 关掉它们道具的位置一模一样。 */
const GRAIN_ON = QNUM('grain', 1)! > 0 ? 1 : 0
const DETAIL_ON = QNUM('detail', 1)! > 0 ? 1 : 0
/* `?caustic=` / `?watery=` / `?water=`（浅海焦散、水位线、深水染色）与 `SeaWater.tsx`
 * 于 2026-10-11 随「删海」全部删除（用户 m05607）。 */

/* ★ 真实月壤贴图（Poly Haven CC0）的两级开关。
 * `?mdetail=0` 退回「纯色 + 程序化颗粒」的老样子（A/B 对照）；
 * `?mnormal=` 调法线贴图强度（0 也能关，贴图照旧只走反照率）。 */
const M_DETAIL = QNUM('mdetail', 1)! > 0 ? 1 : 0
/** 月面小撞击坑贴图层开关（用户 m05344「月壤能不能再真实点」）。`?mc=0` 关。 */
const MC_ON = QNUM('mc', 1)! > 0
const M_NORMAL_STRENGTH = QNUM('mnormal', 0.32)!
/* ★★ 法线三层（2.9 m / 17.7 m / 84.0 m）的权重。
 * 原来 0.55 / 0.28 / 0.24（和 1.07）偏「近处最重」，结果近景地面被高频法线打成
 * 一层**密密麻麻的碎褶**（`ZOOM_ME_base.png`：像揉皱的锡箔/粗砂纸），用户 m04456
 * 报的「地面像波浪/沙纹」主要就是它 —— 用 `?mnormal=0` 关掉后高频细节从 1.50 MB
 * 掉到 0.93 MB，整片变干净。
 * 真实月壤在 1~10 m 尺度是**极其平整的尘毯**，微法线应该弱而平缓。所以把重心从
 * 「最近最重」翻到「最远最重」：大尺度给柔和的起伏，近处只留一点点颗粒感。 */
const NW_NEAR = QNUM('nwnear', 0.30)!
const NW_MID = QNUM('nwmid', 0.30)!
const NW_FAR = QNUM('nwfar', 0.40)!

/* ★★★ 月海 / 月陆（mare / highland）大尺度反照率差 —— 「远看像不像月球」就靠这一条。
 *
 * 真实数据：月海是**玄武岩熔岩填充**，反照率约 **0.07**；月陆是**斜长岩高地**，约 **0.13**
 * —— 差近 2 倍。这个 2 倍差是肉眼在几十公里外就能认出月球形状的唯一原因
 * （环形山本身的起伏在 240 m 视距内只占几个像素）。
 *
 * 之前只有 `moon_dusted_01` 的 13.7 / 59 / 237 m 三层平铺，那三层都是**同一种尘**，
 * 均值都在 1 附近 ⇒ 整片月面在远处是**一块均匀灰**，没有任何「图案」。
 * 这里用两层低频 `mx_noise_float`（主频 `MARE_SCALE` 米 + 2.7 倍频）造出月海/月陆的
 * 斑块。**注意颜色也要跟着分**：月海偏冷偏蓝（钛铁矿），月陆偏暖偏中性。
 *
 * 只按 `wMoon` 混入 ⇒ **会场与浅海零回归**。 */
const MARE_ON = QNUM('mare', 1)! > 0 ? 1 : 0
/** ★★ 2026-10-23 第九轮（用户反馈 5）：坑底（花海地板）的大尺度明暗斑块。
 *  参考 `公用区\背景素材\素材\花海.png` 的地面实测：低频斑块 std/mean 0.167、
 *  亮度 p95/p05 = 2.03 ⇒ 几十米尺度 ±17% 的明暗。上面三层细纹最粗只有 11 m，
 *  在那个尺度上是「平的」，所以坑底读起来仍是一整片均匀暗蓝。
 *  `?craterpatch=0` 逐位回到第九轮之前。 */
const CRATER_PATCH_ON = QNUM('craterpatch', 1)! > 0
/** 斑块增益。三路 sin 权重和 = 1.0，`patchSig ∈ [-1, 1]`。
 *  缺省 **1.30** 是从屏幕像素标定出来的（作用在最终色上，不再被光照/ACES 吃掉）：
 *  `k=0` CV 0.0833 → `0.90` 0.1243 → `1.30` **0.1426** → `1.70` 0.1515，
 *  参考图 `花海.png` 实测 **0.167**；1.30 与 1.70 肉眼已难分，取前者避免暗块过重。
 *  色相全程稳定在 219.5±0.2°（参考图 218.8°）。 */
const CRATER_PATCH_GAIN = QNUM('craterpatchk', 1.30)!
/** 乘子钳位。`1 ± GAIN` 会越界到 -0.3 / 1.9，不钳会出现「一块全黑一块过曝」。
 *  钳太紧等于把幅度砍掉：`±0.38`（0.62/1.38）时地面低频 CV 只到 0.1125，离
 *  参考图 0.167 差一截 ⇒ 放到 `±0.55`（0.45/1.55），仍不足以让暗块读成黑斑。 */
const CRATER_PATCH_LO = QNUM('craterpatchlo', 0.45)!
const CRATER_PATCH_HI = QNUM('craterpatchhi', 1.55)!
/** 主频波长（米）。**240 m 视距下至少要能看到 1~2 块完整斑**，否则等于没有。
 *  ⚠️ 最初给 260 m，实测在 `cam=0,26,-20&look=0,-8,-170` 那张里整个月球区
 *     是**一块均匀灰**，看不出任何斑块 —— 260 m 比可视范围还大。 */
const MARE_SCALE = QNUM('marescale', 120)!
/** 月海（暗）与月陆（亮）的倍率。0.74 / 1.20 均值约 0.97，整体明暗基本不变。 */
const MARE_DARK = QNUM('maredark', 0.74)!
const MARE_LIGHT = QNUM('marelight', 1.20)!

/* ★★★ 月球反射 BRDF：**Lommel-Seeliger + 冲日增亮**（用户 m02901「月壤不行」）。
 *
 * `月球写实渲染资源调研.md` 第 0 节与第 324 行的结论，逐字：
 *   「**标准 PBR 渲月球是错的**（oddurs 原话：非常不对）。月壤**没有镜面波瓣**，
 *     且**冲日时变亮（opposition surge）**。」
 *   「**先把光照模型换成 Oren-Nayar 或 Lommel-Seeliger** —— 这一步对『像不像月球』
 *     的贡献远大于把高程分辨率翻倍。标准 PBR 会一直看着不对劲，你会误以为是
 *     几何问题而在几何上白花时间。」
 *
 * 我们选了 Lommel-Seeliger（`moon-rover` 用的那条，比 Oren-Nayar 便宜一档）：
 *      L_LS = A/π · μ0/(μ0+μ)        对照 Lambert  L = A/π · μ0
 * ⇒ **不用改 three 的光照管线**，只要在 `colorNode`（= 反照率）上乘 `1/(μ0+μ)`，
 *    Lambert 的 μ0 就被抵消掉了。μ0 = N·L、μ = N·V。
 *   掠射角 μ→0 时分母只剩 μ0 ⇒ 亮度**不趋零** —— 这才是月球那张
 *   「边缘和中心一样亮的平盘」，而不是一个被斜光照亮的灰球。
 *   （之前 `roughness = 1.0` 只解决了「没有镜面波瓣」这一半，Lambert 这一半没动。）
 *
 * 再叠一条**冲日增亮**：相位角 α 越小越亮，`1 + surge · max(dot(L,V),0)^8`。
 * 真实月球满月比上弦月亮约 2 倍，这一步就是那 2 倍。
 *
 * 旋钮：`?ls=0` 整个关掉（A/B 对照）、`?lsurge=` 冲日强度、`?lsgain=` 明度补偿。
 *
 * ⚠️ **归一化常数必须改**（第一版踩过这个坑，`LS_low_on.png` 整片爆白）：
 *   Lambert  `I = A/π · μ0`  ⇒ 系数 **1/π ≈ 0.318**
 *   LS       `I = A/4 · μ0/(μ0+μ)` ⇒ 系数 **1/4 = 0.250**
 *   两个定律的**绝对**系数不同 ⇒ 正确的「乘在 Lambert 上的倍数」是
 *       **(1/4)/(1/π) / (μ0+μ) = 0.785 / (μ0+μ)**
 *   不是 1.0。第一版写成 `1 × 1.7`，等于把月面整体抬到 2.2 倍，再叠上
 *   「掠射视角 μ→0 时 LS 比 Lambert 亮 8 倍」这条**本来就是 LS 的核心性质**，
 *   就成了低太阳下的一片白。另外再给 `ls` 一个上限兜底。 */
const MOON_LS_ON = QNUM('ls', 1)! > 0 ? 1 : 0
/* ★ 第十轮 t6(b)：淡出目标色的「暖色保持」旋钮。
 *   `?gfadewarm=` 强度（0 = 关，逐位回到纯蓝雾色目标）、`?gfadews=`/`?gfadewe=` 起止距离、
 *   `?gfadewg=` 暖色增益（乘在原色上，<=1 ⇒ 只会更暗，不会更亮）。 */
/* ⚠️ 第十轮 t6 第二次修正后（颜色带 47→53），这一段**不再是回红的主力**：
 *   可见像素（camDist < 44）的颜色权重已经是 0，圈里看到的就是原色本身。
 *   保留它是为了 44 m 之后那半圈：那里 alpha 已经 0，改动不可见，
 *   但万一以后有人把 `?gfadegb` 调大，暖色目标仍然让目标色偏红褐而不是雾蓝。
 *   缺省 `?gfadewarm=0`：不改变任何像素（只在 A/B 时需要手动开）。 */
const GROUND_FADE_WARM = QNUM('gfadewarm', 0)!
const GROUND_FADE_WARM_START = QNUM('gfadews', 44)!
const GROUND_FADE_WARM_END = QNUM('gfadewe', 53)!
const GROUND_FADE_WARM_GAIN = QNUM('gfadewg', 1.0)!
/* ★ t6 复核修正（dev-review）：环带草簇的初值直接取会场草 palette，不依赖 `useFrame` 同步。
 *   原实现把初值写成旧色调 (0.35,0.12,0.05)/(0.75,0.5,0.3)，靠每帧从 `useGrassUniforms`
 *   覆盖成红褐；复核实测默认画面环带只有 B−R=−2.6（中性灰），说明同步没兜住。
 *   这里与 `VENUE.grass.base/tip` 同一份真值 ⇒ 首帧即红褐，且 `?tip/?base` 的 URL 覆盖
 *   仍会在下一帧通过 `useFrame` 生效（保留下方同步逻辑，不动它）。
 *   A/B：`?gring=0` 关掉整层即可逐位回到改前。 */
const GRASS_BASE_HEX = VENUE.grass.base
const GRASS_TIP_HEX = VENUE.grass.tip
const MOON_SURGE = QNUM('lsurge', 0.30)!
const MOON_LS_GAIN = QNUM('lsgain', 0.95)!
const MOON_LS_CAP = QNUM('lscap', 3.2)!

/* ★ t3（round-3 反馈 4）：40 m 外裸基底的颜色淡出目标色。
 *   会场 / 森林 = 各自的 `fog.color`（`GROUND_FOG_COLOR` 那条插值）；
 *   月球（真空、无雾）= `uSkyHorizon × 这个系数`，即「按比例压暗」而不是压成天空。
 * 缺省 1（= 就是 uSkyHorizon 本身）。attempt-3 用过 0.62「按比例压暗」，实测
 * 会在 x30 z25 机位做出一条**比天空更亮的白带**：0.38 的目标色不透明度去和更亮的
 * 区域基色混合，中间色比两端都亮（41 px 段 R 升到 +19，比改前的 +11 更显眼）。
 * 结论：淡出目标色**不允许亮于它要贴合的背景**；月区没有雾接着远景，唯一既不出
 * 白带又不物理错误的值就是地平线色本身。
 * `?gmoonsky=0.62` 可复现旧的「白带」版本做 A/B，`?gmoonsky=0` = 月球不压色。
 * ⚠️ 这个开关的**文档/开关表在 worldHeight.ts 的 GROUND_FADE 注释块里**
 *    （搜 `?gmoonsky=`，约 :876 一带）；常量本体只有这一处，改缺省值改这里。 */
const GMOON_SKY = QNUM('gmoonsky', 1.0)!

/* ═══ 第十轮 t6：边缘草簇（盖住「露地板」的那一圈）的形状常数 ══════════════════
 * 只影响 `?gring` 那一层，与地表材质无关，所以放在模块级（不随渲染重建）。 */
/** 单簇草叶的横向尺度（m）。一簇 = 5 株叶片，横向铺开 ≈ 0.46 m。 */
const EDGE_CLUMP_W = 0.46
/** 每簇的叶片数（5 株 × 3 顶点，非索引三角形）。 */
const EDGE_BLADES = 5

/* 深水染色 `?water=`、真实沙地 `?sand= ?sandb= ?sandshore=` 于 2026-10-11 随「删海」
 * 全部删除（用户 m05607）。原来的三张沙贴图（`coast_sand_01` / `damp_beach_sand` /
 * `coast_sand_rocks_02`）只在浅海区生效，删海后是死代码，`core/textures/groundMaps.ts`
 * 里的三个 loader 一并删掉。 */


export function Terrain({
    grassAreaSize = DEFAULT_GRASS_AREA_SIZE,
    cullCamera
}: {
    grassAreaSize?: number
    cullCamera?: THREE.PerspectiveCamera
}) {
    const { camera: defaultCamera } = useThree()
    const cameraToUse = cullCamera || defaultCamera
    
    const meshRef = useRef<THREE.Mesh>(null)

    /* ═══ 第十轮 t6（用户：「边缘的草叶太稀疏，露地板了，用草叶盖住」）═══════════
     *
     * 先分清两件事，别把它们混成一个：
     *   ① **草的实例密度没变** —— 圆盘 80×80 m 上 1024² 根，间距 0.078 m
     *      ⇒ 163.8 株/m²（`grass/core/config.ts` 的 `DEFAULT_BLADES_PER_AXIS /
     *      DEFAULT_GRASS_AREA_SIZE`）。所以这不是"加密"能解决的问题。
     *   ② 真正的缺口在 **圆盘的最外一圈**：`grassMaterial.ts:87-88` 的
     *      `GRASS_EDGE_FADE_IN/OUT = 30/40` 把 30→40 m 的叶片**高度**压到 0
     *      （40 m 时 height × 0），而草叶宽度只有毫米级 ⇒ 36 m 处叶片仍然挺立、
     *      39.5 m 处已经贴地成一条线，那一圈就成了**光的红褐地板**。
     *      叠加 `groundFadeNode` 36 m 起压雾色（见 worldHeight.ts 的 t6 注释），
     *      露出来的地带正好被染成偏蓝的灰 —— 也就是用户圈出来的那条"蓝地板"。
     *
     * 为什么修在 Terrain 而不是改 `GRASS_EDGE_FADE_*`：
     *   草盘半径 40 m 是**世界可见半径 `R_VIS` 的唯一定义方**
     *   （`core/world/visRadius.ts` 文件头：树 / 会场 / 远处道具全部按 40 m 剔除）。
     *   把草盘放大到 44 m 会让「地上有草」和「树在 40 m 处一刀消失」两个口径分裂，
     *   而把 IN 外移（30→36）等于让草在圆盘边缘**突然断头**，重新出现
     *   `NT_eye` 那条硬弧。所以草材质一个字不动，覆盖放在这片**我们自己拥有**的
     *   地形节点上：在草叶已经压平的那一圈（37→44 m）铺 `RING_SEGS` 个
     *   贴地草簇，把红褐地板盖掉；36 m 之后地面不再被压成雾蓝（颜色带搬到 40→44，
     *   见 `worldHeight.ts` 的 t6 注释）⇒ 这一圈的基底重新是红褐的。
     *
     * 0 回归：第一个环带从 37 m 起、权重 `smoothstep(37,38.4)`，38.4 m 之后才满
     * ⇒ 会场本体（长桌/蛋糕/NPC 全在 15 m 内）与所有近景机位逐位不变；
     * `?gring=0` 整层不挂、`?gringw=0` 权重归零，都能逐位回到改前。
     * 判据（探针可读，不靠眼睛）：`__gfade('all').rings` 给出每带的
     * `[r0,r1]` / 簇数 / 簇间距 / 相邻簇间距 ≤ 簇宽×几个，见 `ringReport()`。 */
    /* ★ 第十轮 t6 第二次调密：原 `gap=1.12 / step=2.3` 只出 3 行 × 227 = 681 簇，
     *   实测环带仍成片露地板（草叶宽只有毫米级、簇宽 0.46 m，相邻簇之间 1.12 m
     *   ⇒ 空隙 0.66 m，比簇本身还宽 1.4 倍）。这里收到 `gap=0.55`（≈ 一个簇宽）、
     *   `step=1.15`（径向每 1.15 m 一行，共 6 行）⇒ 462 × 6 = **2772 簇**
     *   （密度 ×4.07、径向 ×2），空隙压到 0.09 m，视觉上连成一片。
     *   顶点总量 2772 × 5 株 × 3 = 41 580，一个节点一次上传，可忽略。
     *   要更密：`?gringgap=0.3&gringstep=0.8`；要回稀疏：`?gringgap=1.12&gringstep=2.3`。 */
    const RING_GAP = QNUM('gringgap', 0.55)!          // 相邻草簇间距（m）
    const RING_STEP = QNUM('gringstep', 1.15)!        // 沿半径方向每一带的间距（m）
    /* ★★★ 2026-10-24（十二轮任务3）：**缺省关**。
     *
     * 用户反馈3（`公用区\10月24日反馈3.png`）：「会场范围出现一圈异常刷新的草」，
     * 圈出来的正是一圈**闭合的、由 4~6 条同心弧叠成的草墙**。
     *
     * 根因就是本层：`RING_SEGS` 一条带 r 37→44 m、`RING_STEP` 1.15 m
     * ⇒ `rows = round(7 / 1.15) = 6` 行，每行是一整圈 462 簇 ⇒ 高空俯视时
     * 就是 6 条同心弧（与反馈图逐条吻合）。它之所以**读起来像"异常刷新"**：
     *   ① 真草在 `GRASS_EDGE_FADE_IN/OUT = 30/40` 之间高度被压到 0，
     *      36 m 以外基本看不见 ⇒ 本层是**唯一**还立着的草，孤零零一圈；
     *   ② `RING_H` 缺省 1.8 ⇒ 叶高 0.36–1.12 m，比周围渐隐的真草高一个量级；
     *   ③ 环内外都是一片灰白的雾色地面 ⇒ 视觉上就是"凭空冒出来的一圈草"。
     *
     * 结论：这不是"刷新 bug"、也不是 LOD 抖动，是**我们自己加的一层静态草簇**。
     * 用户要的是它消失，所以缺省值 1 → **0**（整层不挂、不产生任何几何）。
     * 机制与参数全部保留：`?gring=1` 立刻逐位回到第十轮 t6 那套
     * （`?gring=0` 从来就是它的回滚旋钮，见 `:266` 的注释）。 */
    const RING_SEGS: { r0: number; r1: number; gap: number; step: number }[] =
        QNUM('gring', 0)! > 0 ? [{ r0: 37.0, r1: 44.0, gap: RING_GAP, step: RING_STEP }] : [];
    const RING_W = QNUM('gringw', 1)!                 // 整体权重（0 = 视同不存在）
    /* 叶高倍率：见 `hK` 处注释。缺省 1.8 ⇒ 0.36–1.12 m，与真草 0.4/0.8 同量级。 */
    const RING_H = QNUM('gringh', 1.8)!

    /** 环带权重：内侧 `smoothstep(r0, r0+1.4)` 起、外侧 `1-smoothstep(r1-1.0, r1)` 收。
     *  两侧都软进软出 ⇒ 不会在内缘画出一条硬弧（这正是本卡要修的毛病）。 */
    const ringWeightCPU = (d: number, s: { r0: number; r1: number; w: number }) => {
        const ramp = (a: number, b: number) => {
            const t = Math.min(Math.max((d - a) / Math.max(b - a, 1e-4), 0), 1)
            return t * t * (3 - 2 * t)
        }
        return ramp(s.r0, s.r0 + 1.4) * (1 - ramp(s.r1 - 1.0, s.r1)) * s.w
    }

    /** 每条环带的**几何读数**：簇数、簇间距、每 10 m² 的簇数、簇距/簇宽比。
     *  纯 CPU 镜像，用的是和 GPU 侧同一组 `RING_SEGS` ⇒ 探针不可能和 GPU 漂。
     *  ⚠️ 不要把 `RING_SEGS` 读成 `useEffect([])` 的闭包 —— 探针只挂一次，
     *     闭包会把首帧的值固化。这里显式作为参数传进去。 */
    const ringReport = (
        d: number, segs: { r0: number; r1: number; gap: number; step: number }[], w: number,
    ) => {
        const out: any[] = []
        let inBand = false
        for (const s of segs) {
            const rows = Math.max(1, Math.round((s.r1 - s.r0) / s.step))
            const circ = 2 * Math.PI * ((s.r0 + s.r1) / 2)
            const perRow = Math.max(1, Math.round(circ / s.gap))
            const area = Math.PI * (s.r1 * s.r1 - s.r0 * s.r0)
            const clumps = rows * perRow
            out.push({
                r0: s.r0, r1: s.r1,
                rows, perRow, clumps,
                clumpWidth: Number(EDGE_CLUMP_W.toFixed(3)),
                gap: s.gap,
                gapPerWidth: Number((s.gap / EDGE_CLUMP_W).toFixed(3)),
                clumpsPer10m2: Number(((clumps / area) * 10).toFixed(3)),
                weightHere: Number(ringWeightCPU(d, { ...s, w }).toFixed(4)),
            })
            if (d >= s.r0 && d < s.r1) inBand = true
        }
        return { segs: out, inBand, weightHere: Number(ringWeightCPU(d, { r0: segs[0]?.r0 ?? 0, r1: segs[0]?.r1 ?? 0, w }).toFixed(4)) }
    }

    /* ★ 真实月壤贴图：异步加载，加载完再重建材质。
       ⚠️ 必须在 `useMemo` 之外用 state —— TSL 的 `texture()` 要在**建 node graph 时**
          就拿到贴图对象，没法事后塞进已经建好的图里。
       加载失败就退回程序化颗粒（`maps = null`），不会白屏。 */
    const [maps, setMaps] = useState<GroundMaps | null>(null)
    useEffect(() => {
        let alive = true
        loadMoonRegolith()
            .then((m) => { if (alive) setMaps(m) })
            .catch((err) => console.warn('[terrain] 月壤贴图加载失败，退回程序化颗粒：', err))
        return () => { alive = false }
    }, [])

    /* ★★ 第二张月壤贴图：Poly Haven `moon_meteor_01` —— **带迷你撞击坑**的月壤。
       用户 m05344「月壤能不能再真实点？」。真实月面最好认的特征就是「大大小小的坑」，
       而 `moon_dusted_01` 只有一片均匀的尘（三层同源 ⇒ 怎么叠都是同一种斑）。
       把 `moon_meteor_01` 铺到 **31.5 m** 的宏观尺度上，它自带的迷你坑就变成
       几米级的月面小坑，**零几何成本**（不动 `worldHeightCPU` ⇒ 没有 CPU/GPU 失配风险）。
       加载失败只是少一层纹理，不白屏。 */
    const [macro, setMacro] = useState<GroundMaps | null>(null)
    useEffect(() => {
        let alive = true
        loadMoonMeteor()
            .then((m) => { if (alive) setMacro(m) })
            .catch((err) => console.warn('[terrain] 月面小坑贴图加载失败（只是少一层，不影响）：', err))
        return () => { alive = false }
    }, [])

    /* 三张沙地贴图（干 / 湿 / 岸线碎石）于 2026-10-11 随「删海」删除（用户 m05607）。 */
    // TEMPDBG

    /* ★★ t6（第四轮追加任务 5「月坑的土壤材质观感一般。去找土壤，岩石，之类的素材」）：
       Poly Haven `moon_flat_macro_01` / `moon_macro_01` / `rocks_ground_06` 三套 PBR
       （已完成 RGBA PNG 转换，见 `components/ground/groundMaterial.ts` 文件头）。
       加载失败 ⇒ `pbr = null` ⇒ 下面三处接线全部跳过，退回改前那套（不会白屏），
       且 `loadGroundPBR()` 里已经打了 `[ground] ... 失败` 的 console.error（失败要响）。
       ⚠️ 必须在 `useMemo` 之外用 state：TSL 的 `texture()` 建图时就要拿到贴图对象。 */
    const [pbr, setPbr] = useState<GroundPBR | null>(null)
    useEffect(() => {
        if (!GROUND_SOIL_ON) return
        let alive = true
        loadGroundPBR()
            .then((m) => { if (alive) setPbr(m) })
            .catch(() => { /* 已在 loadGroundPBR 里 console.error，这里只保证不白屏 */ })
        return () => { alive = false }
    }, [])

    /* 分段数跟着面积走，保持约 0.625 m 一个格子。
       ⚠️ 原来固定 128 段，是因为面积固定 80 m；现在面积可调（`?area=`），
       固定 128 段会让 200 m 的地面变成 1.56 m 一个格子，环形山边缘会变成折线。 */
    const segments = useMemo(
        () => Math.max(64, Math.min(512, Math.round(grassAreaSize / 0.625))),
        [grassAreaSize],
    )
    
    /* ══════════════════════════════════════════════════════════════════════
     * ★★ 2026-10-20 task-9：地形的「跳格」必须落在**顶点格边**上。
     *    用户：「月球坑最顶端的坑壁，只要视角移动就会像波浪一样翻滚。」
     *
     * 根因（这是几何侧的那一半，法线侧见 `core/shaders/terrainHelpers.ts`）：
     *   · 草地的无限循环要求整块地面跟相机跳格，跳格步长 = `grassAreaSize/80*...`
     *     = **0.15625 m**（`core/utils/gridSnapping.ts:39-41`）；
     *   · 但地形网格本身是 `grassAreaSize / segments` = **0.625 m** 一格
     *     （下面 `segments` 那段注释）。
     *   · 0.15625 **除不尽** 0.625 的整数倍关系（0.625/0.15625 = 4，其实除得尽，
     *     但 `snappedX` 是 `k*0.15625` 里**任意**一个，所以顶点落到世界坐标上的
     *     位置**每 0.15625 m 就换一套**）。
     *   · 顶点位置变了 ⇒ 同一个坑壁在网格上被**重新采样**，顶点高度/法线跟着换 ⇒
     *     坑壁的明暗纹路在 5.4 m 波长的锯齿上整体「流动」，看起来就是翻滚的波浪。
     *
     * 修法（不改坑形、不加平滑）：把跳格位置**量化到顶点格边**（0.625 m 的整数倍）。
     *   这样无论相机走多远，顶点永远落在同一套世界坐标格点上 ——
     *   地面网格在世界空间里是**静止**的，坑壁的采样点不再变，明暗自然也不动。
     *   视觉上零代价：被采样的仍是同一张世界高度场，只是采样格点了固定下来
     *   （极端情况下地图边缘会多/少一圈 0.625 m 的顶点，肉眼不可见）。
     *
     * `?tsnap=0` 回到旧行为（跳 0.15625），用于 A/B 出图。
     * ══════════════════════════════════════════════════════════════════════ */
    const TERRAIN_SNAP_ON = QNUM('tsnap', 1)! > 0
    const cellSize = grassAreaSize / segments

    // Use grid snapping hook
    useGridSnapping({
        camera: cameraToUse,
        grassAreaSize,
        onSnap: ({ snappedX, snappedZ }) => {
            if (meshRef.current) {
                const qx = TERRAIN_SNAP_ON ? Math.round(snappedX / cellSize) * cellSize : snappedX
                const qz = TERRAIN_SNAP_ON ? Math.round(snappedZ / cellSize) * cellSize : snappedZ
                meshRef.current.position.set(qx, 0, qz)
                meshRef.current.updateMatrixWorld(true)
            }
        },
    })

    /**
     * ⭐ UV 旋转 + 平移。**同一张贴图叠多层时，如果每层方向都一样，
     * 贴图里那些「有方向的」结构（`moon_dusted_01` 的 nor_gl 就带着一片方向性沙纹）
     * 会层层叠在同一个朝向上 ⇒ 肉眼看就是**木纹 / 刷痕**，不是月壤
     * （`FIX_noon_close.png` 里那片从左到右的波纹就是这么来的，用户 m03192 说的「像波浪」有它一份）。
     * 给每层转一个互不相干的角度（0° / 47.3° / −33.1° / 71.5° …），
     * 方向性就被抹平成**各向同性**的颗粒 —— 这才是月壤的样子。
     * 角度是常量，cos/sin 在 CPU 上算好，GPU 侧只多两次乘加。
     */
    const rotUV = (uv: any, deg: number, off: [number, number]): any => {
        const a = (deg * Math.PI) / 180
        const c = Math.cos(a)
        const s = Math.sin(a)
        return vec2(
            uv.x.mul(float(c)).sub(uv.y.mul(float(s))),
            uv.x.mul(float(s)).add(uv.y.mul(float(c))),
        ).add(vec2(off[0], off[1]))
    }

    // Create material with terrain functions (uses global uniforms from core/shaders/uniforms)
    const material = useMemo(() => {
        /* ★ 世界高度（分区版）：会场是原来的 FBM，走进月球/浅海换成环形山与盆地。
           见 `core/shaders/worldHeight.ts`（GPU 侧）与 `core/worldRegions.ts`（CPU 侧，道具摆位用）。 */
        const terrainHeight = getWorldHeight()
        /* 解析法线：对同一套高度函数做三次差分。
           地形面是按世界坐标求高的，所以这里求出来的就是**世界坐标、Y 朝上**的法线。 */
        const terrainNormal = getTerrainNormal(terrainHeight)

        /* ★ 月面小撞击坑贴图层（用户 m05344）的开关：`?mc=0` 关掉，用来 A/B 出图。
           `mc` 同时要求贴图加载成功（异步），所以是 state × 开关的与。 */
        const mc = macro && MC_ON ? macro : null

        /* ★★ 地面必须受光 —— 这是「写实」的第一个硬条件。
           ⚠️ 原来是 `MeshBasicNodeMaterial`，**完全不受光**：地面是一片均匀的纯色，
           形状只能从地平线剪影看出来。后果：站到月球上，
           一个 46 m 半径、7.5 m 深的环形山在画面上**根本看不见**，
           只有地面边缘的锯齿剪影在提示「那里有起伏」。
           换成 MeshStandardNodeMaterial，配合 <DirectionalLight>（太阳仰角约 22°），
           坑壁才有明暗。 */
        const vNormal = varying(vec3(0.0, 1.0, 0.0))

        const mat = new THREE.MeshStandardNodeMaterial()
        mat.side = THREE.DoubleSide
        /* t3: alphaTest is the second half of the old fake fade. Pre-change there was
           only alphaTest=0.5 and NO transparent, so opacityNode's smooth alpha never
           blended and was merely discarded below 0.5 => hard cut at ~71.2 m.
           attempt-3: keep alphaTest=0.5 (opaque pass, zero reorder => the 40 m inner
           region stays bit-identical) and instead place the cut where the COLOR fade
           has not started yet, so both sides of the cut carry the same color.
           Actual numbers with the shipped endpoints (gfadega/gb = 40/44, gfadea/b = 42/46)
           and area=160 (half = 80 => groundGeomFadeNode clamps a = min(40, 44*0.9) = 39.6,
           b = 44): alpha 1-smoothstep(39.6,44,d) crosses alphaTest 0.5 at **41.8 m**, and
           the color weight smoothstep(42,46,41.8) there is exactly **0** (41.8 < 42).
           Alpha reaches 0 at 44 m, where the color weight is 0.5; 46 m is fully painted.
           See groundGeomFadeNode / GROUND_FADE_GA/GB in worldHeight.ts. That hides the
           edge without paying the transparent-pass cost.
           ?gfadetr=1 switches back to the real-transparent path (alphaTest ~0.01);
           ?gfade=0 / ?rvis=0 restores the pre-change values exactly. */
        mat.alphaTest = GROUND_FADE_ON && GROUND_FADE_TRANSPARENT ? 0.01 : 0.5
        if (GROUND_FADE_ON && GROUND_FADE_TRANSPARENT) mat.transparent = true
        /* 月壤/沙土都没有镜面波瓣（调研报告结论：标准 PBR 渲月球是错的，
           月壤几乎无镜面反射）。roughness 拉到 1 就没有高光。
           ★ t6：下面紧接着用 `mat.roughnessNode` 把它**按粗糙度贴图逐像素**改写；
           没有接上的分支（`?groundrough=0` 或贴图没加载完）仍然是常数 1.0（= 改前）。 */
        mat.roughness = 1.0
        mat.metalness = 0.0

        /* 地面配色按世界坐标分区：会场是红褐月沙，月球转灰蓝月壤，浅海转沙底。
           注意用**世界坐标**采样 —— 地形面跟着相机跳格，用局部坐标颜色会跟着跑。
           ★ 再乘一层「反照率颗粒」（`?grain=0` 可关）：纯色地面看起来像打磨过的塑料，
             月壤的细颗粒、沙底的波纹条带都靠它。只动着色，不动高度 ⇒ 道具不会浮。 */
        mat.colorNode = Fn(() => {
            const worldPos = modelWorldMatrix.mul(vec4(positionLocal, float(1.0))).xyz
            const worldXZ = vec2(worldPos.x, worldPos.z)
            /* ★★ 2026-10-21 第四轮反馈 4b：「草地之外的地板也渲染了」。
               用户要 Minecraft 语义 ⇒ **渲染距离（`R_VIS = 40 m`）之外只留裸基底**：
               下面每一个「细节层」都乘 `renderFade`（40 m 内 = 1、45 m 外 = 0），
               而 `regionGroundColorNode` 的区域基色**不乘** —— 它就是那层裸基底。
               不接 `renderFade` 的三样：区域基色、地形高度、雾。 */
            const renderFade = renderFadeNode(length(worldPos.sub(cameraPosition)))
            let base = regionGroundColorNode(worldXZ, uTerrainColor)
            // 反照率颗粒用「远淡出」（140 m）而不是法线那条（60 m）：
            // mottle 是 1.8 m 尺度，远处不会闪，正好用来填草场外那一圈秃地。
            /* ⚠️ 4b：`grainFadeNode` 的 20→140 m 缓坡本来就是为了「填 40~80 m 的秃地」，
               而那正是用户这次要求**去掉**的东西 ⇒ 现在再乘一道 `renderFade`，
               40 m 外颗粒归零；`grainFadeNode` 保留只为让边界不出现硬缝。 */
            const fade = grainFadeNode(length(worldPos.sub(cameraPosition)))
            const grain = mix(
                float(1.0),
                groundGrainNode(worldXZ),
                fade.mul(float(GRAIN_ON)).mul(renderFade),
            )
            /* 浅海的水下焦散 / 沙滩干湿沙 / 深水染色三块于 2026-10-11 随「删海」全部删除
               （用户 m05607）。它们的开关 `?caustic= ?watery= ?sand= ?sandb= ?water=` 一并作废。 */
            /* ★★ 真实月壤贴图（Poly Haven `moon_dusted_01`，CC0 真实月壤扫描）。
               做法是「**只取斑驳、不取明暗**」：贴图逐通道除以自己的均值 ⇒ 得到均值 = 1 的
               变化量，乘在区域底色上，整体明暗仍然由区域底色决定。
               两层平铺（2.6 m 与 11.2 m，比例取无理数 4.31）打散重复感。
               按月球权重淡入 ⇒ **会场与浅海一点不受影响**（零回归的硬要求）。 */
            let rock: any = vec3(1.0)
            if (maps) {
                /* ★★★ 三层平铺（13.7 m / 59 m / 237 m，比例取无理数打散重复感）。
                   ⚠️ 原来只有 2.6 m 与 11.2 m 两层 —— 2K 贴图铺在 2.6 m 上，
                   一个纹素只有 1.3 mm，10 米外就是**亚像素**，整片地糊成
                   「电视雪花」，读不出任何结构（`V4_moon_close.png` 就是这么来的）。
                   现在最粗那层 237 m 给出大尺度色斑、把「一片均匀灰」打散，
                   最细那层 13.7 m 仍然看得见扫描本身的颗粒。 */
                const A = float(13.7)
                /* ⚠️ 三层**各转一个角度**（0° / 47.3° / −18.7°）见 `rotUV` 的说明：
                   不转的话三层方向一致 ⇒ 木纹。 */
                const l0 = texture(maps.albedo, rotUV(worldXZ.div(A), 0, [0, 0]))
                const l1 = texture(
                    maps.albedo,
                    rotUV(worldXZ.div(A.mul(float(4.31))), 47.3, [0.37, 0.19]),
                )
                const l2 = texture(
                    maps.albedo,
                    rotUV(worldXZ.div(A.mul(float(17.3))), -18.7, [0.11, 0.73]),
                )
                const avg = (() => {
                    /* ★★★ 第四层：`moon_meteor_01` 的**小撞击坑**，铺 31.5 m（= A × 2.3）。
                       它和前三层不是同一张图 —— 前三层都是 `moon_dusted_01`（一片均匀的尘），
                       这一层自带迷你撞击坑，铺到 31.5 m 就变成几米级的月面小坑。
                       四个权重的和必须恰好是 1，否则 `variation` 的均值会偏离 1，
                       整片月面会整体变亮或变暗（`variation` 的物理含义就是「均值 = 1 的斑驳」）。 */
                    let a2: any = l0.rgb.mul(float(mc ? 0.42 : 0.50))
                        .add(l1.rgb.mul(float(mc ? 0.24 : 0.30)))
                        .add(l2.rgb.mul(float(mc ? 0.16 : 0.20)))
                    if (mc) {
                        const l3 = texture(
                            mc.albedo,
                            rotUV(worldXZ.div(A.mul(float(2.3))), -61.4, [0.53, 0.29]),
                        )
                        a2 = a2.add(l3.rgb.mul(float(0.18)))
                    }
                    return a2
                })()
                const variation = avg.div(vec3(maps.mean[0], maps.mean[1], maps.mean[2]))
                const wMoon = moonShadeWeightNode(worldXZ)
                /* 4b：月壤扫描贴图同样属于「渲染距离内的细节」，40 m 外归零（裸基底＝区域基色）。 */
                rock = mix(vec3(1.0), variation, wMoon.mul(float(M_DETAIL)).mul(renderFade))
                /* ══ t6 接线①（反照率）：坑内 / 坑外两套真实 PBR 材料 ══════════════
                   位置刻意放在老四层 `rock` **之后**、mare 斑块**之前**：
                     · 老四层已按 `moon_dusted_01` 的逐通道均值归一化（只保留斑驳、
                       不改整体明暗）⇒ 新层再乘上去不会把整体亮度推离标定值；
                     · mare 斑块是「月海/月陆」的大尺度明暗，属于**更大一层**，
                       必须压在新材料之上（它是这颗月球的「图案」，不该被材料盖掉）。
                   ⚠️ 40 m 语义：`groundAlbedoFactor()` **内部不乘** renderFade，
                      这里把 `wMoon.mul(M_DETAIL).mul(renderFade)` 原样重复一遍 ——
                      与上一行 `rock` 的淡出因子**逐项相同**，所以 40 m 外新老材料
                      同时归零，裸基底（`regionGroundColorNode` 的区域基色）一点不变。 */
                if (pbr && GROUND_SOIL_ON) {
                    const soil = groundAlbedoFactor(worldXZ, pbr, wMoon)
                    rock = rock.mul(mix(vec3(1.0), vec3(soil), wMoon.mul(float(M_DETAIL)).mul(renderFade)))
                }
                /* ★★★ 月海/月陆斑块（见文件上方 `MARE_ON` 那段）：
                   在**已经归一化的 `rock` 上再乘一层大尺度明暗**，所以不会跟贴图打架。 */
                if (MARE_ON) {
                    const mp = vec3(worldXZ.x, float(0.0), worldXZ.y).div(float(MARE_SCALE))
                    const n1 = mx_noise_float(mp, float(1.0))
                    const n2 = mx_noise_float(
                        mp.mul(float(2.7)).add(vec3(13.1, 4.3, 0.0)),
                        float(1.0),
                    )
                    const mareN = n1.mul(float(0.70)).add(n2.mul(float(0.30)))
                    /* 阈值不对称：月海比月陆少见（真实月球约 1:4），所以窗口往亮侧偏。 */
                    const highland = smoothstep(float(-0.30), float(0.18), mareN)
                    const mareTint = mix(
                        /* 月海：暗，且偏冷偏蓝（富钛玄武岩） */
                        vec3(MARE_DARK, MARE_DARK * 0.97, MARE_DARK * 1.07),
                        /* 月陆：亮，略偏暖（斜长岩） */
                        vec3(MARE_LIGHT, MARE_LIGHT * 1.01, MARE_LIGHT * 0.93),
                        highland,
                    )
                    rock = rock.mul(mix(vec3(1.0), mareTint, wMoon.mul(renderFade)))
                }
            }
            /* 沙滩（干/湿/碎石三层）与「深水变蓝」染色于 2026-10-11 随「删海」全部删除
               （用户 m05607）。连同 `?sand= ?sandb= ?water= ?watery=` 四个 URL 开关。
               ⚠️ 留一条教训：`waterDepth = 水位 − 地形高度` 这种「按水位算」的项**必须乘所在
               区域的权重**，否则别的区域地形只要低于水位线就会被当成海底（月球坑底 −7.5 m
               曾被整片染成深海蓝）。删海之后这条链路整个消失了。 */
            /* ★★ 2026-10-20 task-23（用户 m02431「长喇叭花的地面不要纯色，需要一些类似土地的纹理」）
               坑底（花岛 + 水环以下）叠一层**真实土壤扫描**的土纹：
                 · 用同一张 `moon_dusted_01` albedo（`maps.albedo`），3.4 m 与 13.7 m 两层平铺；
                 · 只取「斑驳、不取明暗」：亮度除以自己的均值 ⇒ 均值 1 的变化量，
                   所以暗蓝底色一点不变，只多出 ±16% 的明暗纹理；
                 · 蓝通道系数 1.22 / 红 0.86 ⇒ 亮斑略偏冷，**不会把地面染回红褐**；
                 · 只乘 `craterFloorWeightNode`（花岛 + 水下整片），坑外逐位不变。
               ⚠️ 为什么不用 `mx_noise_float`：本项目 colorNode 里它实测恒为 0
                  （四版程序噪声 A/B 全是 `pixel diff max = 1`），见 `worldHeight.ts` 同名注释。
               开关：`?cratergrain=0` ⇔ `CRATER_GRAIN_ON = false` ⇒ 逐位回 task-19 的纯色。 */
            if (maps && CRATER_GRAIN_ON) {
                /* ⚠️ 临时探针（t6 定位「坑底被漂成纯白」用，出图后必须删）：
                   `?grainprobe=k` 时把整段土纹按 (1-k) 回落 + k 强制 k。 */
                const GP = QNUM('grainprobe', -1)!
                /* 三层平铺（0.9 m / 3 m / 11 m）：贴图是 2K 扫描，铺得越大一个纹素越小，
                   10 m 外就落到亚像素、mipmap 直接抹平；但铺得越小，远处会退化成高频噪点。
                   所以近处 0.9 m（看得清的土粒/碎屑，5 m 内有效）、中景 3 m（土色斑块）、
                   远景 11 m（大块干湿深浅）。 */
                const sA = texture(maps.albedo, rotUV(worldXZ.div(float(0.9)), 21.7, [0.11, 0.83]))
                const sB = texture(maps.albedo, rotUV(worldXZ.div(float(3.0)), 47.3, [0.53, 0.29]))
                const sC = texture(maps.albedo, rotUV(worldXZ.div(float(11.0)), 71.9, [0.77, 0.61]))
                const LUMA = vec3(0.2126, 0.7152, 0.0722)
                /* 权重比 0.4 : 0.9 : 1.2（归一后 0.16 / 0.36 / 0.48）：细层只给颗粒感，
                   明暗层次主要由 3 m 与 11 m 两层给 ⇒ 地面是「大片明暗 + 细颗粒」，
                   而不是满屏等大的噪点（lead 2026-10-20 复审意见 2）。 */
                const lumS = dot(sA.rgb, LUMA)
                    .mul(float(0.16))
                    .add(dot(sB.rgb, LUMA).mul(float(0.36)))
                    .add(dot(sC.rgb, LUMA).mul(float(0.48)))
                /* ⚠️ `maps.mean` 是 **sRGB 字节均值**（0~1），而 `texture()` 取样返回的是
                   **线性**值（同一张 0.47 的 sRGB 灰在线性里约 0.19）。两者直接比会让
                   `dev` 系统性偏 -0.6，整片地面被压暗 ~22%（实测 ON 33/35/43 vs OFF
                   43/50/66）。所以先把均值 luma 反 gamma 到线性再比。 */
                const s2l = (v: number): number =>
                    v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
                const mL = float(
                    0.2126 * s2l(maps.mean[0]) +
                        0.7152 * s2l(maps.mean[1]) +
                        0.0722 * s2l(maps.mean[2]),
                )
                const dev = clamp(lumS.sub(mL).div(mL), float(-1.0), float(1.0))
                /* 4b：坑底月壤的三档扫描贴图也是「渲染距离内的细节」⇒ 40 m 外归零，
                   坑底远处只剩 `regionGroundColorNode` 的暗蓝基色。 */
                const cf = craterFloorWeightNode(worldXZ).mul(renderFade)
                /* ① 乘法层：三通道乘同一个系数 ⇒ 色相（暗蓝）严格不变，只出「土色深浅」。
                   ⚠️ 别按通道给不同系数（0.92/1.0/1.12）：kS 为负时蓝通道塌得比红快，
                   整片地面会从暗蓝翻成土黄褐（实测 meanRGB 从 50/58/74 掉到 45/43/35）。
                   乘子钳到 [0.35, 2.2]，避免暗纹素把地面压成黑块。 */
                base = base.mul(clamp(float(1.0).add(dev.mul(cf).mul(float(2.80))), float(0.35), float(2.2)))
                /* ② 加性层：夜景里地面本身很暗（发光点 ≈ 30/255），纯乘法只有 ±6 级、易被
                   夜色吃掉；实测 `?cratergrain=0` 与 ON 的肉眼差几乎为零。
                   所以再叠一层**符号跟随 dev** 的冷色偏置：亮斑加、暗斑减、均值 ≈ 0
                   （整体亮度不掉），幅度 (0.030/0.040/0.055) 线性 ≈ 显示 ±6/±8/±11 级。 */
                base = base.add(vec3(float(0.060), float(0.078), float(0.085)).mul(dev).mul(cf))
                if (GP >= 0) base = mix(base, vec3(float(GP)), float(0.35))
            }
            const rgb = base.mul(grain).mul(rock)
            /* ★★ 真空夜（月球区的夜）：星光 + 地球反照下的配色。
               两条真实的物理/生理效应缺一不可：
                 ① 星光照度 0.002 lux vs 日光 1e5 lux ⇒ **强度**已由灯那边压掉
                    （`DirectionalLight.tsx` 的 `uVacuumNight` + VACUUM_INTENSITY）；
                 ② **浦肯野漂移**：暗视觉（视杆细胞）峰值在 507 nm，弱光下红色先黑掉
                    ⇒ 世界整体**去彩 + 偏冷蓝**。这一条只能在这里做。
               做法：抽出亮度 → 乘冷蓝三通道增益 → 按强度混回去。
               `uVacuumNight` 已含「相机在不在月球区」，再乘逐像素的月球权重
               ⇒ 只有月球那一片变色，远处的会场/浅海不受影响。 */
            const lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722))
            const nightRGB = vec3(lum).mul(vec3(0.55, 0.80, 1.35))
            const wMoon = moonShadeWeightNode(worldXZ)
            const nightW = uVacuumNight.mul(wMoon)
            /* ★★★ 月球 Lommel-Seeliger（推导见文件上方 `MOON_LS_ON` 那段）。
               放的位置很关键：**在夜色混完之后**。
                 · 夜里 μ0 → 0，Lambert 本来就是 0，补偿因子乘上去还是 0，不会把夜景提亮；
                 · `lum` 用的是**未补偿**的 `rgb` ⇒ 月球夜景与改造前逐字一致（零回归的硬要求）。
               光照在**观察空间**做，所以 L 与 V 都经 `cameraViewMatrix` 转过去，
               与顶点阶段 `vNormal.assign(terrainNormal(...).transformDirection(cameraViewMatrix))`
               是同一个空间。V 用 `cameraPosition - worldPos` 现算，避开未确认的 `positionView` 导出。 */
            if (QNUM('envprobe', 0) === 1) { const sc: any = (globalThis as any).__dshScene; if (sc) { sc.environment = null; } }
            const shaded = mix(rgb, nightRGB, nightW)
            /* ★★★ 月坑地面大尺度明暗（第九轮用户反馈 5：「看 `花海.png`，
               那个地面并不是纯色，有明暗变化有纹理」）。
               参考图实测地面亮度 **p95/p05 = 2.03**、32 px 格均值 **std/mean = 0.167**
               —— 也就是几十米尺度上有 ±17% 的明暗起伏。现有那三层扫描贴图
               （0.9 / 3.0 / 11.0 m）全在细尺度，最粗只到 11 m，这个尺度上是平的。

               ⚠️ **必须作用在最终色 `shaded` 上，不是 albedo `base`** —— 这是本条的
               第二次踩坑：写在 albedo 里时（`base.mul(...)`），后面要经过光照 ×
               Moon-LS × ACES 色调映射，高光段被压缩 ⇒ 实测 ±17% 的 albedo 调制只
               剩下 **±1.4%** 的屏幕亮度差（diff 图能看到完整斑块形状，但肉眼几乎
               分辨不出）。渲染管线末端才是「屏幕上看到的亮度」。
               `?craterpatch=0` 逐位回到第九轮之前的观感。
               色相不变：三通道乘同一个标量。 */
            const shadedP = CRATER_PATCH_ON
                ? mix(
                      shaded,
                      shaded.mul(
                          clamp(
                              float(1.0).add(
                                  sin(worldXZ.x.mul(float(0.42)).add(worldXZ.y.mul(float(0.19))))
                                      .mul(float(0.50))
                                      .add(
                                          sin(
                                              worldXZ.x
                                                  .mul(float(-0.15))
                                                  .add(worldXZ.y.mul(float(0.21)).add(float(1.7))),
                                          ).mul(float(0.31)),
                                      )
                                      .add(
                                          sin(
                                              worldXZ.x
                                                  .mul(float(0.055))
                                                  .sub(worldXZ.y.mul(float(0.098)).add(float(4.3))),
                                          ).mul(float(0.19)),
                                      )
                                      .mul(float(CRATER_PATCH_GAIN)),
                              ),
                              float(CRATER_PATCH_LO),
                              float(CRATER_PATCH_HI),
                          ),
                      ),
                      craterBlueWeightNode(worldXZ),
                  )
                : shaded
            if (QNUM('terrprobe', 0) === 1) { (globalThis as any).__tp1 = (globalThis as any).__tp1 ? (globalThis as any).__tp1 + 1 : 1 }
            if (QNUM('terrprobe', 0) === 1) return vec4(vec3(0.0, 8.0, 0.0), float(1.0))
            /* t3 (round-3 feedback 4): the bright far floor. MUST be applied to the
               FINAL color, not to base (albedo): albedo is still multiplied by
               lighting/ACES afterwards (moon-night pixels end at 5-17), so lerping
               albedo yields a lit-dim intermediate, not the fog color.
               mat.outputNode is unusable (replaces resultNode, bypasses fog) and
               emissiveNode only ADDS light. Target = mix(GROUND_FOG_COLOR,
               uSkyHorizon * GMOON_SKY, wMoon): venue/forest dissolve into the
               ground fog that already paints that range; the moon region (vacuum,
               no fog) is pushed onto the real horizon color
               (see GMOON_SKY above for why the coefficient is 1.0). */
            const camDist = length(worldPos.sub(cameraPosition))
            const gfade = groundFadeNode(camDist)
            /* 目标色（三个区域各接各的雾）：
                 · 会场 / 森林：跟自己的 `fog.color`（`sky.fogColor` → `FOREST_FOG_COLOR`）
                   对齐，也就是跟 `WorldController` 每帧写进 `fog.color` 的是同一条插值；
                 · 月球：真空、`fog.far` 被推到 1e9，没有东西接地面 ⇒ 用 `uSkyHorizon`
                   （真空地平线色），乘 `?gmoonsky=`（缺省 1.0 = 就是地平线色本身）。
                   为什么不是 62%：淡出目标色**不允许亮于它要贴合的背景**。0.62 的目标
                   只有地平线的 62% 亮度，它和「更亮的区域基色」按权重混合时会得到比
                   两端都亮的中间色（实测 R 194 的死白带，比改前的 196 亮地板还显眼）。
                   取 1.0 之后中间色必然落在 [基色, 地平线] 之间，单调压暗，不会反亮。
               ⚠️ 不能改写 `regionGroundColorNode`（ALBEDO 层）：albedo 后面还要乘光照
               / 夜景 / ACES，月球夜间 albedo→雾色只会得到一个「被照暗的中间色」，
               不是目标色。必须作用在**最终色**上（这也就是为什么挂在 return 之前）。 */
            const gfadeTarget2 = mix(
                GROUND_FOG_COLOR.toVec3(),
                /* 月球：地平线色 × 亮度系数（`?gmoonsky=`，缺省 1.0 = 地平线色本身）。 */
                uSkyHorizon.mul(float(GMOON_SKY)),
                wMoon,
            )
            /* ★★★ 第十轮 t6(b)：切边那一圈必须仍是**红**的，不能交给蓝雾色。
             *
             * 为什么光搬颜色带不够（实测，不是推测）：
             *   `gfade` 用的是 **camDist = |worldPos - cameraPosition|**（到相机的距离），
             *   不是径向半径；而 `mat.opacityNode` 的切边用的是 `length(positionLocal.xy)`
             *   （径向半径）。两者只在相机贴近地面中心时才近似相等。
             *   玩家平视机位（y≈1.9 m）实测：径向 36→44 m 那一圈可见像素的 camDist
             *   只有 **36.0~40.2 m**（alphaTest 0.5 在 40.0 m 把外侧全裁掉）。
             *   ⇒ 颜色带搬到 `40 -> 44` 之后，那一圈 `gfade` 只到
             *     smoothstep(40,44,40.2) ≈ 0.008，等于没压 ⇒ 最后一圈仍是**没压过的原色**，
             *     而原色在 38~40 m 读数上是 (146,148,149) 的灰蓝 —— 正是用户圈的「变蓝」。
             *   （30~36 m 段确实回红了：(160,157,155) → (156,140,134)，但那不是切边那一圈。）
             *
             * 改法：把淡出目标色本身往**地面原色**拉 —— `gfadeWarm` 在切边附近 = 1，
             *   远到 44 m 以外才降到 0，于是：
             *     · 40 m 内的最后一圈：mix(原色, 原色, gfade) = **原色**，与近处地面同色相；
             *     · 44 m 以外：恢复成原来的蓝雾色目标（那里 alpha 已经是 0，看不见）；
             *     · 亮度铁律（`Terrain.tsx:620-623`）：`c.mul(...)` 只会**压暗或持平**，
             *       不会把目标抬亮 ⇒ 不会重新出现 R194 死白带。
             *   `?gfadewarm=0` 逐位回到「目标色 = 纯雾色」的旧行为（A/B 用）。 */
            const gfadeWarm = GROUND_FADE_WARM > 0
                ? float(1.0).sub(
                      camDist
                          .sub(float(GROUND_FADE_WARM_START))
                          .div(float(Math.max(GROUND_FADE_WARM_END - GROUND_FADE_WARM_START, 1e-3)))
                          .clamp(0.0, 1.0),
                  ).mul(float(GROUND_FADE_WARM))
                : float(0.0)
            const withGfade = (c: any) => {
                if (!GROUND_FADE_ON) return c
                /* 暖色目标：原色 × 暖色保持系数（只乘不加大，色相留在红褐一侧）。 */
                const warmT = mix(gfadeTarget2, c.mul(float(GROUND_FADE_WARM_GAIN)), gfadeWarm)
                return mix(c, warmT, gfade)
            }
            if (!MOON_LS_ON) return vec4(withGfade(shadedP), float(1.0))
            const Lv = cameraViewMatrix.transformDirection(uSunDir).normalize()
            const Vv = cameraViewMatrix.transformDirection(cameraPosition.sub(worldPos)).normalize()
            const mu0 = dot(vNormal, Lv).max(float(0.0))
            const mu = dot(vNormal, Vv).max(float(0.0))
            // 分母下限 0.05：μ0→0（背光面）时 Lambert 也是 0，乘积仍是 0，不会炸。
            // 再给 ls 一个上限（`?lscap=`）：掠射视角 μ→0 时 1/(μ0+μ) 会到 10 以上，
            // 那是 LS 的**物理性质**（月面整盘均匀发亮），但我们的曝光是按 Lambert 标定的，
            // 所以必须留个兜底，否则低太阳下整片爆白。
            const ls = float(1.0).div(mu0.add(mu).max(float(0.05))).min(float(MOON_LS_CAP))
            // 冲日增亮：相位角越小越亮（`dot(L,V)` 越接近 1）。真实月球满月比上弦月亮约 2 倍。
            const surge = float(1.0).add(
                dot(Lv, Vv).max(float(0.0)).pow(float(8.0)).mul(float(MOON_SURGE)),
            )
            const brdf = ls.mul(float(MOON_LS_GAIN)).mul(surge)
            /* 只乘在**月球权重**上：`mix(1, brdf, wMoon)` ⇒ 会场与浅海逐字不变。 */
            return vec4(withGfade(shadedP.mul(mix(vec3(1.0), vec3(brdf), wMoon))), float(1.0))
        })()

        /* 顶点阶段：位移 + 法线一起算。
           法线每个顶点要多求 3 次高度（6 个环形山 × 3 次差分），
           放到顶点阶段（240 m 地面 = 384×384 ≈ 15 万顶点）比逐像素便宜得多。 */
        mat.positionNode = Fn(() => {
            const localPos = positionLocal
            const worldPos = modelWorldMatrix.mul(vec4(localPos, float(1.0))).xyz
            const h = terrainHeight(worldPos.xz)
            /* 世界坐标法线 → 观察空间。`normalNode` 这一路（`setupNormal()`）要的就是观察空间法线，
               与 three 自己那句 `normalView.transformDirection(cameraViewMatrix)` 是同一个变换。 */
            vNormal.assign(terrainNormal(worldPos.xz).transformDirection(cameraViewMatrix))
            const displacedPos = vec3(localPos.x, localPos.y, localPos.z.add(h))
            return vec4(displacedPos, float(1.0))
        })()

        /* ★ 微观法线：地表必须有「颗粒」才不像塑料。
           在**片元阶段**对 `detailReliefNode` 做一次有限差分，得到世界空间的扰动向量，
           再经 `cameraViewMatrix.transformDirection` 转到观察空间加到 `vNormal` 上
           （`normalNode` 要的就是观察空间法线，与顶点阶段那条判据是同一条）。
           距离淡出写在里面：20 m 内满、60 m 外归零，否则远处会糊成一片电视雪花。 */
        mat.normalNode = Fn(() => {
            const worldPos = modelWorldMatrix.mul(vec4(positionLocal, float(1.0))).xyz
            const worldXZ = vec2(worldPos.x, worldPos.z)
            /* 4b：法线扰动同样只属于「渲染距离内」。40 m 外地面读作平基底 ⇒
               微观起伏与真实法线贴图都要退化成常量，否则远处地面依然是「有颗粒的地板」。 */
            const renderFade = renderFadeNode(length(worldPos.sub(cameraPosition)))
            const fade = detailFadeNode(length(worldPos.sub(cameraPosition)))
            const strength = detailStrengthNode(worldXZ).mul(fade).mul(renderFade).mul(float(DETAIL_ON))
            const perturb = detailPerturbNode(worldXZ, strength)
            let n: any = vNormal.add(cameraViewMatrix.transformDirection(perturb))
            /* ⚠️ 第二十六轮 T1-I4 修：`wMoon` 原声明在下面 `if (maps) { … }` **块内**
             *  （原 `:899`），但 `if (pbr && GROUND_SOIL_ON) { … }` 那个**另一个**块
             *  也要用它（原 `:916 .mul(wMoon)`）⇒ 越界，`ReferenceError: wMoon is not defined`。
             *  它只依赖 `worldXZ`，两处要的是**同一个值**，所以提到两个块外面来算一次。
             *  `?gsoil=1` 才会走到那条分支（`GROUND_SOIL_ON` 缺省 0），所以这颗哑弹
             *  一直没炸 —— 是 `tsc --noEmit` 把它找出来的。 */
            const wMoon = moonShadeWeightNode(worldXZ)
            /* ★ 真实法线贴图（Poly Haven `moon_dusted_01` 的 `nor_gl`，CC0）。
               地形面是 XZ 平面、法线朝 +Y ⇒ 切线空间的 (nx, ny, nz) 映射成世界扰动
               (nx, 0, ny)（切向 +X/+Y 就是世界 +X/+Z）。
               三张 nor_gl 的 R/G 通道均值都精确 ≈ 0.500 ⇒ 分布已居中，直接 `tex*2-1`
               归一化即可，不需要整体重映射（要加凹凸感只调 `?mnormal=`）。
               按月球权重淡入 ⇒ 会场零影响。 */
            if (maps) {
                /* ★★★ 三层法线（2.9 m / 17.7 m / 84 m），每层转一个不同角度。
                   单层法线只在一个距离段有效：太细则远处闪成噪点，太粗则近处是一块塑料。
                   三层叠起来才能「近处有颗粒、中景有起伏、远处有明暗」。 */
                /* ⚠️⚠️ 2026-10-09 试过在 2.9 m 下面再加一层 **0.62 m** 的细颗粒法线
                   （想给脚下做出「沙砾」感）—— **撤掉了**：2K 贴图铺到 0.62 m 时
                   一个纹素只有 0.3 mm，中景（10~30 m）会拼成一片肉眼可见的**方格瓷砖**
                   （`F3_low.png` 中下部那一格格方块），比原来那片柔和波纹更出戏。
                   ⇒ 近处的颗粒感应该由 albedo/normal 在**合理尺度**上给，
                   而不是靠把同一张 2K 图铺得越来越密；真要更细得换更细的素材。
                   ⚠️ 三层各自的旋转角**必须互不相同**，否则同向叠加会出规则条纹。 */
                const tNear = texture(maps.normal, rotUV(worldXZ.div(float(2.9)), 0, [0, 0])).rgb
                const tMid = texture(
                    maps.normal,
                    rotUV(worldXZ.div(float(17.7)), -33.1, [0.53, 0.29]),
                ).rgb
                const tFar = texture(
                    maps.normal,
                    rotUV(worldXZ.div(float(84.0)), 71.5, [0.19, 0.61]),
                ).rgb
                /* ⚠️ 权重 2026-10-09 跟着 `detailStrengthNode` 一起调：
                   程序噪声（Perlin 波纹）压到配角（月球 0.42→0.16），颗粒感交给真实贴图
                   —— 所以真贴图这几层要**提上去**。只压程序噪声不提贴图，地面会变平。
                   ★★★ 2026-10-10：加了第四层（`moon_meteor_01` 的**坑缘法线**）之后，
                   前三层各乘 0.82，**总权重的和仍然保持 1.0** ——
                   不然整片月面的法线强度会凭空涨 20%，中景会开始闪。 */
                const kW = mc ? 0.82 : 1.0
                let nxyz: any = tNear.mul(float(2.0)).sub(float(1.0)).mul(float(NW_NEAR * kW))
                    .add(tMid.mul(float(2.0)).sub(float(1.0)).mul(float(NW_MID * kW)))
                    .add(tFar.mul(float(2.0)).sub(float(1.0)).mul(float(NW_FAR * kW)))
                if (mc) {
                    /* 这一层的旋转角 118.7° 必须和前三层（0 / −33.1 / 71.5）都不同，
                       否则同向叠加会出规则条纹。 */
                    const tMac = texture(
                        mc.normal,
                        rotUV(worldXZ.div(float(31.5)), 118.7, [0.29, 0.83]),
                    ).rgb
                    nxyz = nxyz.add(tMac.mul(float(2.0)).sub(float(1.0)).mul(float(0.18)))
                }
                /* `wMoon` 已提到 `if (maps)` 外面（见上方注释），这里不再重复声明。 */
                const worldPerturb = vec3(nxyz.x, float(0), nxyz.y)
                    .mul(float(M_NORMAL_STRENGTH))
                    .mul(wMoon)
                    /* 4b：真实法线贴图在渲染距离外归零 —— 裸基底是平的。 */
                    .mul(renderFade)
                n = n.add(cameraViewMatrix.transformDirection(worldPerturb))
            }
            /* ══ t6 接线②（法线）：坑内松软月壤 / 坑外月海玄武岩两套起伏 ══════════
               · 坑内：`moon_macro_01` @3.0 m（颗粒）+ `moon_flat_macro_01` @7.0 m（起伏）
               · 坑外：`moon_flat_macro_01` @17.7 m（中尺度）+ 碎石高频代理
               ⚠️ 40 m 语义：乘 `wMoon · renderFade · M_NORMAL_STRENGTH`，
                  与上面老法线层**同一组淡出因子**（t4 的裸基底是平的）。
               ⚠️ `?gsoil=0` 时整段跳过 ⇒ 逐位回到改前。 */
            if (pbr && GROUND_SOIL_ON) {
                const soilN = groundNormalPerturb(worldXZ, pbr)
                    .mul(float(M_NORMAL_STRENGTH))
                    .mul(wMoon)
                    .mul(renderFade)
                n = n.add(cameraViewMatrix.transformDirection(soilN))
            }
            return n.normalize()
        })()

/* ══ t6 接线③（粗糙度）：让 rough 贴图**真正驱动镜面** ══════════════════════
           改前三套 `*_rough_*` 全部被加载、**零消费者**（`mat.roughness = 1.0` 是常数），
           这是 t2 §1 认定「观感一般」的一半原因。
           取值 `mix(0.55, 1.0, r)`（见 `groundMaterial.ts: groundRoughValue` 的说明：
           原图 rough 的标准差极小，直接用等于常数）。
           ⚠️ 再乘一道 `max(wMoon, 1e-4)`：月面外（会场 / 森林）权重 0 ⇒ 粗糙度退回 1.0
               （= 改前的老地面行为，零回归）；`max` 只是避免 0 乘出完全光滑的塑料。
           ⚠️ `?groundrough=0` 或贴图未加载 ⇒ 不接这一条，`mat.roughness = 1.0` 照旧。
           ⚠️ **不乘 renderFade**：镜面波瓣是材料属性，不是「细节层」；40 m 外的裸基底
               仍要读作同一块地（远处地面本来就没有法线细节，粗糙度再变会读成「地上有水」）。
           ⚠️⚠️ 接这一条的前置条件是贴图必须 **RGBA PNG**：本轮实测
               `core/textures/groundMaps.ts` 原来加载的是 `*_2k.jpg`（RGB JPEG），
               改前它没炸只是因为 rough 图**从未被采样**；一旦接上 roughnessNode，
               WebGPU 给这张 RGB 纹理分不出格式 ⇒ `Unsupported texture type with RGBFormat. 1009`
               ⇒ 整个地形材质消失（不是变暗）。已用 `_tools/_t6_legacy.py` 把三套就地转成 RGBA PNG。 */
        if (pbr && GROUND_SOIL_ON && GROUND_ROUGH_ENABLED) {
            mat.roughnessNode = Fn(() => {
                const worldPos = modelWorldMatrix.mul(vec4(positionLocal, float(1.0))).xyz
                const worldXZ = vec2(worldPos.x, worldPos.z)
                const wMoon = moonShadeWeightNode(worldXZ)
                const r = groundRoughValue(worldXZ, pbr)
                /* ⚠️ 第二十六轮 T1-I4 修：原来是 `max(wMoon, float(1e-4))`，
                 *  但本文件 `from 'three/tsl'` 的导入清单里**没有 `max`** ⇒ `ReferenceError`。
                 *  TSL 惯用写法是节点方法（同文件 `:809` `.max(float(0.0))`、
                 *  `:815` `.max(float(0.05))`），改成 `.max()` 不新增导入。 */
                return mix(float(1.0), r, wMoon.max(float(1e-4)))
            })()
        }

        /* 边缘：往外交接给天空。
           ⚠️ 原来是 `1 - step(radius, dist)` —— 那是**硬切**，地形在半径处一刀断，
           会场那边靠树环和雾挡住了看不出；无缝大地图里那是一条很扎眼的地平线直边。 */
        /* t3: the fade band moves from 0.78/0.5 * half (~62.4-80 m, effectively a hard
           cut at 71.2 m via alphaTest) to absolute 40-46 m, independent of ?area=;
           only when ?area= < 92 m is it clamped inside the mesh so the edge never
           rests cut-in-mid-air. dist = length(positionLocal.xy): the mesh center is
           the camera's grid cell (useGridSnapping, cell 0.625 m), so it approximates
           the camera's horizontal distance within <1 m.
           attempt-4: this alpha curve is NOT blended by default; alphaTest=0.5 cuts it
           at the **41.8 m** crossing (alpha = 1-smoothstep(39.6,44,d)). The color band
           (42->46 m) has weight exactly 0 there (41.8 is before the band starts), so the
           cut has the same color on both sides; alpha hits 0 at 44 m, where the color
           weight is 0.5, and the color is fully painted at 46 m.
           (attempt-3 moved the cut well past the color band on purpose; that left a
           visibly brighter strip because the outer half of the ring was half-faded
           yet still opaque.)
           40 m 内颜色权重恒为 0（见 worldHeight.ts 的端点注释），近处逐位不变。 */
        mat.opacityNode = Fn(() => {
            /* CPU 手算过一次：取 alpha 的 0.5 交叉点 + 颜色权重 ≥0.9，字面写成
               0.1 + 0.8*alpha 会把交叉点往后挪 1.6 m、颜色权重多 2 个百分点，
               却要多一条独立公式；不值得。保持 alpha 直读。 */
            const dist = length(positionLocal.xy)
            if (GROUND_FADE_ON) return groundGeomFadeNode(dist, grassAreaSize * 0.5)
            const rOuter = float(grassAreaSize * 0.5)
            const rInner = rOuter.mul(float(0.78))
            return float(1.0).sub(smoothstep(rInner, rOuter, dist))
        })()

        return mat
    }, [maps, macro, pbr])

    /* ★★ t21：40 m 退化（`?rvis`）的**确定性探针** `window.__vis(r)` ★★
       为什么不再用像素 A/B：这台场景三处都不满足（机位没分辨力 / 月面离开会场后
       无照明 mean RGB 5~17 / 有草时同 URL 两帧噪声 6.70 > 效应 6.36），两次读数
       给出相反答案（t13: 5.14×「有退化」，t21: 0.83「无退化」）。
       详见 `_logs/t4/t26-rvis-apparatus.md` 与 `_logs/t4/t21-40m-geom-evidence.md`。

       探针口径（不引入第二份公式）：`renderFadeCPU()` 与 GPU 侧的 `renderFadeNode()`
       共用 `worldHeight.ts` 里同一组模块级常数（`RENDER_R/IN/OUT/ON`），
       所以改 `?rvfade` / `?rvis` 时读数会跟着变，不会出现「探针说一套、GPU 跑另一套」。

       用法（CDP `eval` 或控制台）：
         __vis(39)→≈1   __vis(41)→0.5   __vis(45)→0
         __vis('all')  → 一次返回全部采样点 + 端点 + 开关状态
       这是只读探针，不改变任何渲染行为。 */
    useEffect(() => {
        const sample = (r: number) => {
            const d = typeof r === 'number' && Number.isFinite(r) ? r : NaN
            return Number.isFinite(d) ? renderFadeCPU(d) : null
        }
        const probe = (r?: number | string) => {
            const rep = renderFadeReport()
            if (r === 'all' || r === undefined) {
                const pts = [0, 10, 20, 30, 35, rep.bandStart, (rep.bandStart + rep.bandEnd) / 2, rep.bandEnd, 47, 60, 120]
                return {
                    ...rep,
                    samples: pts.map((d) => ({ d, w: Number(renderFadeCPU(d).toFixed(6)) })),
                    note: '细节层合成权重；1=全细节，0=裸基底。与 GPU 共用同一组常数。',
                }
            }
            return { r, w: sample(r) }
        }
        ;(window as unknown as { __vis?: unknown }).__vis = probe
        /* t3: __gfade(d) / __gfade('all') - deterministic readout of this fade.
           Shares the same constants as the GPU (groundFadeCPU / groundGeomFadeCPU),
           so changing ?gfade/?gfadea/?gfadeb/?rvis moves both together. */
        const probeG = (r?: number | string) => {
            const rep = groundFadeReport()
            const half = grassAreaSize * 0.5
            if (r === 'all' || r === undefined) {
                const pts = [0, 20, 38, 40, 44, 48, 50, 53, 56, 58, 64, 70, 80, 120, 200]
                return {
                    ...rep,
                    half,
                    edge: groundFadeEdgeReport(half),
                    /* t6：环带草簇的几何读数（簇数 / 簇距 / 每 10 m² 簇数）。 */
                    rings: {
                        on: RING_SEGS.length > 0 && RING_W > 0,
                        weight: RING_W,
                        gap: RING_GAP,
                        step: RING_STEP,
                        segs: RING_SEGS.map((s) => ringReport(s.r0, RING_SEGS, RING_W).segs[0]),
                    },
                    samples: pts.map((d) => ({
                        d,
                        color: Number(groundFadeCPU(d).toFixed(6)),
                        opacity: Number(groundGeomFadeCPU(d, half).toFixed(6)),
                    })),
                }
            }
            /* 单点读数顺带把「这一点的草盖比」也报出来，方便逐距离验环带。 */
            const d = typeof r === 'number' && Number.isFinite(r) ? r : NaN
            return Number.isFinite(d)
                ? {
                      r: d,
                      color: Number(groundFadeCPU(d).toFixed(6)),
                      opacity: Number(groundGeomFadeCPU(d, half).toFixed(6)),
                      ring: ringReport(d, RING_SEGS, RING_W),
                  }
                : null
        }
        ;(window as unknown as { __gfade?: unknown }).__gfade = probeG
        return () => {
            delete (window as unknown as { __vis?: unknown }).__vis
            delete (window as unknown as { __gfade?: unknown }).__gfade
        }
    }, [])

    /* ═══ t6：环带草簇的几何 + 材质 ═══════════════════════════════════════════
     * 为什么是「贴地草簇」而不是把真草复制一份：
     *   真草是 compute shader 按 1024² 网格撒的，只覆盖 radius<40 的圆；它已经在那儿了，
     *   缺的只是**高度**（30→40 m 被 `GRASS_EDGE_FADE` 压平）。再叠一层真草会双倍
     *   draw call、还会和跳格搬家打架。这里要的只是「视觉上盖住红褐地板」，
     *   一个静态草簇层最便宜也最可控：位置固定、每簇 5 株、共 ~5 k 簇 ≈ 25 k 三角形。
     *
     * 坐标系：地形本体是 `rotation=[-PI/2,0,0]` 的局部平面，所以本层也用同一个旋转，
     *   簇的 xz 按**世界坐标**撒、高度用 `getWorldHeight()`（与地形顶点同一份真值）⇒
     *   草簇根永远贴在地面上，不会像 `y=0` 那样在丘陵上浮空/埋土。
     *
     * 颜色：直接从 `useGrassUniforms()` 的 `uBaseColor / uTipColor` 取（同一份
     *   `VENUE.grass.base/tip`）⇒ 这一层和真草同色，不存在两种绿。
     *
     * 抖动：`smoothstep` 噪声做**高度抖动**（0.3~1.0 倍），而不是改密度 ——
     *   密度一旦是常数，远处看起来就是一块地毯；高矮不一才像草。 */
    /* 颜色/叶形参数：直接复用草材质那一份（`useGrassUniforms`），       
       保证「盖地板用的草」和「真草」同色，不会出现两种绿。 */
    const grassUniforms = useGrassUniforms()

    /** 环带草簇网格。只在环带常数或草参数变化时重建（URL 参数只读，实际上一次构建到底）。 */
    const ringMesh = useMemo(() => {
        /* ── 顶点表：每一带 × 每簇 `EDGE_BLADES` 株，每株 1 个三角形 ── */
        const pos: number[] = []
        const bt: number[] = []      // 「根部→尖端」插值参数（0 / 1）
        let seed = 0x9e3779b9
        const rnd = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0
            return seed / 4294967296
        }
        let clumps = 0
        for (const s of RING_SEGS) {
            const rows = Math.max(1, Math.round((s.r1 - s.r0) / s.step))
            for (let ri = 0; ri < rows; ri++) {
                const rr = s.r0 + (ri + 0.5) * ((s.r1 - s.r0) / rows)
                const circ = 2 * Math.PI * rr
                const perRow = Math.max(1, Math.round(circ / s.gap))
                for (let ci = 0; ci < perRow; ci++) {
                    /* 黄金角错位：相邻环带不共线，远看不会出现放射状条纹。 */
                    const ang = (ci / perRow) * Math.PI * 2 + ri * 2.39996
                    const cx = Math.cos(ang) * rr
                    const cz = Math.sin(ang) * rr
                    /* 根部贴地：高度取 **CPU 真值 `worldHeightCPU()`**（`core/worldRegions.ts`，
                       与 GPU `getWorldHeight()` 逐项对应）。
                       ⚠️⚠️ 不能用 `getWorldHeight(cx, cz)` —— 那是 `core/shaders/worldHeight.ts`
                       导出的 **TSL 节点工厂**（无参调用返回节点、把节点塞进 `pos.push()` 会得到
                       NaN 顶点 ⇒ 整圈三角形不可见，屏幕上一点变化都没有，读数 0% 变化，
                       极难 debug：几何数、簇数、探针全都正常）。本轮实测踩到了这个。 */
                    const gy = worldHeightCPU(cx, cz)
                    /* 内缘外缘都软进出（`ringWeightCPU`），簇高也跟着渐起：
                       内缘处≈0、1.4 m 后满高 ⇒ 不在本层自己的内缘画一条硬弧。 */
                    const w = ringWeightCPU(rr, { ...s, w: RING_W })
                    /* ★ 第十轮 t6 复核修正（dev-review）：原来 hK 上限只有 1.0，
                       叶高 0.20–0.62 m，在 37–44 m 平视下只剩 2–3 个像素 ⇒ 几何正常
                       （探针 41640 顶点 / 0 NaN / visible / bsR=43.7 全部通过）但画面上
                       根本看不出来，等于没盖。这里乘 `EDGE_H_SCALE`（缺省 1.8）把整层
                       拔到 0.36–1.12 m，与真草（`uBladeHeightMin/Max` 0.4/0.8）同量级，
                       远看才成一片而不是一圈像素噪点。
                       旋钮：`?gringh=3` 更高、`?gringh=0.5` 半高、`?gringh=1` 回原口径。 */
                    const hK = (0.35 + 0.65 * rnd()) * w * RING_H
                    clumps++
                    for (let b = 0; b < EDGE_BLADES; b++) {
                        const oa = rnd() * Math.PI * 2
                        const oR = (rnd() - 0.5) * EDGE_CLUMP_W
                        const bx = cx + Math.cos(oa) * oR
                        const bz = cz + Math.sin(oa) * oR
                        const h = (0.20 + 0.42 * rnd()) * hK
                        const wHalf = 0.014 + 0.018 * rnd()
                        const yaw = rnd() * Math.PI
                        const dx = Math.cos(yaw) * wHalf
                        const dz = Math.sin(yaw) * wHalf
                        /* 根部高度要按**偏移后**的 (bx,bz) 再取一次，否则斜坡上整簇悬空/埋土。 */
                        const gyb = ri === 0 && b === 0 ? gy : worldHeightCPU(bx, bz)
                        /* ⚠️⚠️ 顶点必须是**局部坐标 (x, y, z_local)**，不是世界 (x, h, z)：
                           `mesh.rotation.x = -π/2` 之后，局部 (x, y, z) → 世界 (x, z, -y)。
                           所以「世界高度 h」要写进**局部 z**，而世界 z 写进**局部 y**。
                           写成 (bx, gy, bz) 会让整圈草躺进地平面以下（本轮实测：
                           草覆盖 0% 变化、环带网格看不见，就是这个错）。 */
                        pos.push(bx - dx, bz - dz, gyb, bx + dx, bz + dz, gyb, bx, bz, gyb + h)
                        bt.push(0, 0, 0, 0, 0, 0, 1, 1, 1)
                    }
                }
            }
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        geo.setAttribute('bladeT', new THREE.Float32BufferAttribute(bt, 1))
        geo.computeVertexNormals()

        const mat = new THREE.MeshStandardNodeMaterial()
        mat.side = THREE.DoubleSide
        mat.roughness = 0.9
        mat.metalness = 0.0
        /* ★★ 第十轮 t6 复核修正（dev-review 实测环带呈青蓝 B−R=+77）。
         *   根因**不是** palette：`VENUE.grass.base/tip` 取到的确实是红褐 #7a3418/#e07038。
         *   是**线性雾**把这个位置的红褐染成了青蓝 —— 37→44 m 正好压在
         *   `?ffog` 那条线性雾的中段（near 26 / far 46），雾权重约 50–80%，
         *   红褐被拉到与天空地平同色的 #c4f7f0 系。
         *   实测判据：`?fog=0` 下同批环带像素 (161,140,135) B−R=−26.4 B>R=10%（红褐），
         *   开雾时 (168,181,190) B−R=+22.8 B>R=100%（青蓝）—— 只差一个雾开关。
         *   所以这里关掉雾参与，与 `PhysicalSky.tsx:93` / `Stars.tsx:96` /
         *   `GroundMist.tsx:74` 同一套做法（那三处同样是不该被雾刷的远景元素）。
         *   ⚠️ 关雾后这一层不再随 `?fog` 变，但它的可见区只有 37→44 m 这一圈，
         *   而该圈的地面本身已经被 `groundFadeNode` 压成同色 ⇒ 不会出现"草比地亮"的缝。 */
        mat.fog = false
        /* 根部色 → 尖端色：这两个 uniform 每帧从草材质同步，注释见下方 `useFrame`。
           ⚠️ 这里**必须**用 `tslUniform`（模块顶部的显式别名），不能用裸 `uniform` ——
              本文件同时从 `three/tsl` 和 `./grass/hooks/useGrassUniforms` 那条链间接
              导入同名符号，esbuild 在打包时把这两处 `uniform(...)` 留成了未绑定的裸名，
              浏览器报 `ReferenceError: uniform is not defined`，整站白屏（本轮实测）。
              别名只在这一处用，不与任何重命名冲突。
           ★ 第十轮 t6 复核（dev-review 指出）：初值原来写死成 (0.35,0.12,0.05)/(0.75,0.5,0.3)
              这组旧色调，靠 `useFrame` 每帧覆盖成 VENUE 红褐。复核实测默认画面里环带像素
              只有 B−R=−2.6（中性灰），说明同步链路没把红褐写进来。
              现在**初值直接取 `VENUE.grass.base/tip`**（与真草同一份真值），
              哪怕 `useFrame` 一帧都没跑，这一层也已经是红褐色，不再有"先蓝后红"的窗口。 */
        const vBase = new THREE.Color(GRASS_BASE_HEX)
        const vTip = new THREE.Color(GRASS_TIP_HEX)
        const uBase = tslUniform(new THREE.Vector3(vBase.r, vBase.g, vBase.b))
        const uTip = tslUniform(new THREE.Vector3(vTip.r, vTip.g, vTip.b))
        mat.colorNode = Fn(() => {
            const t = attribute('bladeT', 'float')
            return vec4(mix(uBase, uTip, t), float(1))
        })()
        ;(mat as unknown as { userData: unknown }).userData = { uBase, uTip }

        const mesh = new THREE.Mesh(geo, mat)
        /* 与地形本体同一个变换：局部平面 → 水平地面（见 `return` 里的 `<mesh>`）。 */
        mesh.rotation.set(-Math.PI / 2, 0, 0)
        /* 这层是一圈贴地薄三角形，紧包围盒先天扁；平视时容易整层被剔掉 ⇒ 关剔除。 */
        mesh.frustumCulled = false
        mesh.userData.clumps = clumps
        return mesh
    }, [RING_SEGS, RING_W, grassUniforms])

    /* 每帧把草材质的最终 base/tip 色同步进环带材质。
       ⚠️ 不能在 `useMemo` 里直接读 `grassUniforms.uniforms.material.uBaseColor.value` ——
          leva 的 effect 在首帧之后才写值，首帧读到的是 `vec3(0)`。
       ⚠️ 也不能靠 `useEffect(..., [grassUniforms])` —— 那个对象引用稳定；
          这里走 `useFrame` 是因为它每帧都跑，且只写 6 个 float，成本可忽略。 */
    useFrame(() => {
        const m = grassUniforms?.uniforms?.material
        const ud = (ringMesh.material as unknown as { userData?: any })?.userData
        if (!m || !ud) return
        const b: any = m.uBaseColor.value
        const t: any = m.uTipColor.value
        ud.uBase.value.set(b.x ?? b.r ?? 0, b.y ?? b.g ?? 0, b.z ?? b.b ?? 0)
        ud.uTip.value.set(t.x ?? t.r ?? 0, t.y ?? t.g ?? 0, t.z ?? t.b ?? 0)
    })
    /* `name="terrain"` 是给 `_tools` 的 CDP `eval` 探针用的 —— 把 GPU 地形顶点取回来，
       与 `core/baseHeightCPU.ts` 的 JS 版逐点比对（CPU/GPU 一致性验收）。
       ⚠️ 别把一条 JSX 花括号注释塞在 `return (` 和 `<mesh>` 之间 —— JSX 顶层不能有两个
       并列表达式，babel 会报 `Unexpected token, expected ","`（本轮踩过，页面直接 500）。
       ⚠️⚠️ 更坑的是：那条注释的收尾符本身就含注释结束符 —— 写进「块注释」里会把块注释
       提前关掉，于是报 `Missing semicolon`（同一个坑本轮踩了两次，判据见 AGENT.md 坑 38）。 */
    return (
        <>
            {/* High segment count is needed for smooth FBM terrain to match grass density */}
            <mesh ref={meshRef} name="terrain" rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[grassAreaSize, grassAreaSize, segments, segments]} />
                <primitive object={material} attach="material" />
            </mesh>
            {/* t6：边缘草簇（盖住草盘最外圈那块露出来的地板）。`?gring=0` 不挂。 */}
            {RING_SEGS.length > 0 && RING_W > 0 && (
                <primitive object={ringMesh} name="terrain-edge-grass" />
            )}
        </>
    )
}

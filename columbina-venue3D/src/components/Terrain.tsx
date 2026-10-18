import * as THREE from 'three/webgpu'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'
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
    texture,
    mx_noise_float,
} from 'three/tsl'
import { DEFAULT_GRASS_AREA_SIZE } from './grass/core/config'
import {
    getWorldHeight,
    regionGroundColorNode,
    groundGrainNode,
    detailPerturbNode,
    detailStrengthNode,
    detailFadeNode,
    grainFadeNode,
    regionWeightNode,
} from '../core/shaders/worldHeight'
import { REGION_BY_ID } from '../core/worldRegions'
import { loadMoonRegolith, loadMoonMeteor, type GroundMaps } from '../core/textures/groundMaps'
import { uTime } from '../core/shaders/uniforms'
import { getTerrainNormal } from '../core/shaders/terrainHelpers'
import { uTerrainColor, uVacuumNight, uSunDir } from '../core/shaders/uniforms'
import { useGridSnapping } from '../core/utils/gridSnapping'
import { QNUM } from '../core/utils/query'

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
const MOON_SURGE = QNUM('lsurge', 0.30)!
const MOON_LS_GAIN = QNUM('lsgain', 0.95)!
const MOON_LS_CAP = QNUM('lscap', 3.2)!

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

    /* 分段数跟着面积走，保持约 0.625 m 一个格子。
       ⚠️ 原来固定 128 段，是因为面积固定 80 m；现在面积可调（`?area=`），
       固定 128 段会让 200 m 的地面变成 1.56 m 一个格子，环形山边缘会变成折线。 */
    const segments = useMemo(
        () => Math.max(64, Math.min(512, Math.round(grassAreaSize / 0.625))),
        [grassAreaSize],
    )
    
    // Use grid snapping hook
    useGridSnapping({
        camera: cameraToUse,
        grassAreaSize,
        onSnap: ({ snappedX, snappedZ }) => {
            if (meshRef.current) {
                meshRef.current.position.set(snappedX, 0, snappedZ)
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
        mat.alphaTest = 0.5
        /* 月壤/沙土都没有镜面波瓣（调研报告结论：标准 PBR 渲月球是错的，
           月壤几乎无镜面反射）。roughness 拉到 1 就没有高光。 */
        mat.roughness = 1.0
        mat.metalness = 0.0

        /* 地面配色按世界坐标分区：会场是红褐月沙，月球转灰蓝月壤，浅海转沙底。
           注意用**世界坐标**采样 —— 地形面跟着相机跳格，用局部坐标颜色会跟着跑。
           ★ 再乘一层「反照率颗粒」（`?grain=0` 可关）：纯色地面看起来像打磨过的塑料，
             月壤的细颗粒、沙底的波纹条带都靠它。只动着色，不动高度 ⇒ 道具不会浮。 */
        mat.colorNode = Fn(() => {
            const worldPos = modelWorldMatrix.mul(vec4(positionLocal, float(1.0))).xyz
            const worldXZ = vec2(worldPos.x, worldPos.z)
            let base = regionGroundColorNode(worldXZ, uTerrainColor)
            // 反照率颗粒用「远淡出」（140 m）而不是法线那条（60 m）：
            // mottle 是 1.8 m 尺度，远处不会闪，正好用来填草场外那一圈秃地。
            const fade = grainFadeNode(length(worldPos.sub(cameraPosition)))
            const grain = mix(float(1.0), groundGrainNode(worldXZ), fade.mul(float(GRAIN_ON)))
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
                const wMoon = regionWeightNode(worldXZ, REGION_BY_ID.moon)
                rock = mix(vec3(1.0), variation, wMoon.mul(float(M_DETAIL)))
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
                    rock = rock.mul(mix(vec3(1.0), mareTint, wMoon))
                }
            }
            /* 沙滩（干/湿/碎石三层）与「深水变蓝」染色于 2026-10-11 随「删海」全部删除
               （用户 m05607）。连同 `?sand= ?sandb= ?water= ?watery=` 四个 URL 开关。
               ⚠️ 留一条教训：`waterDepth = 水位 − 地形高度` 这种「按水位算」的项**必须乘所在
               区域的权重**，否则别的区域地形只要低于水位线就会被当成海底（月球坑底 −7.5 m
               曾被整片染成深海蓝）。删海之后这条链路整个消失了。 */
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
            const wMoon = regionWeightNode(worldXZ, REGION_BY_ID.moon)
            const nightW = uVacuumNight.mul(wMoon)
            /* ★★★ 月球 Lommel-Seeliger（推导见文件上方 `MOON_LS_ON` 那段）。
               放的位置很关键：**在夜色混完之后**。
                 · 夜里 μ0 → 0，Lambert 本来就是 0，补偿因子乘上去还是 0，不会把夜景提亮；
                 · `lum` 用的是**未补偿**的 `rgb` ⇒ 月球夜景与改造前逐字一致（零回归的硬要求）。
               光照在**观察空间**做，所以 L 与 V 都经 `cameraViewMatrix` 转过去，
               与顶点阶段 `vNormal.assign(terrainNormal(...).transformDirection(cameraViewMatrix))`
               是同一个空间。V 用 `cameraPosition - worldPos` 现算，避开未确认的 `positionView` 导出。 */
            const shaded = mix(rgb, nightRGB, nightW)
            if (!MOON_LS_ON) return vec4(shaded, float(1.0))
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
            return vec4(shaded.mul(mix(vec3(1.0), vec3(brdf), wMoon)), float(1.0))
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
            const fade = detailFadeNode(length(worldPos.sub(cameraPosition)))
            const strength = detailStrengthNode(worldXZ).mul(fade).mul(float(DETAIL_ON))
            const perturb = detailPerturbNode(worldXZ, strength)
            let n: any = vNormal.add(cameraViewMatrix.transformDirection(perturb))
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
                const wMoon = regionWeightNode(worldXZ, REGION_BY_ID.moon)
                const worldPerturb = vec3(nxyz.x, float(0), nxyz.y)
                    .mul(float(M_NORMAL_STRENGTH))
                    .mul(wMoon)
                n = n.add(cameraViewMatrix.transformDirection(worldPerturb))
            }
            return n.normalize()
        })()

        /* 边缘：往外交接给天空。
           ⚠️ 原来是 `1 - step(radius, dist)` —— 那是**硬切**，地形在半径处一刀断，
           会场那边靠树环和雾挡住了看不出；无缝大地图里那是一条很扎眼的地平线直边。 */
        mat.opacityNode = Fn(() => {
            const dist = length(positionLocal.xy)
            const rOuter = float(grassAreaSize * 0.5)
            const rInner = rOuter.mul(float(0.78))
            return float(1.0).sub(smoothstep(rInner, rOuter, dist))
        })()

        return mat
    }, [maps, macro])

    /* `name="terrain"` 是给 `_tools` 的 CDP `eval` 探针用的 —— 把 GPU 地形顶点取回来，
       与 `core/baseHeightCPU.ts` 的 JS 版逐点比对（CPU/GPU 一致性验收）。
       ⚠️ 别把一条 JSX 花括号注释塞在 `return (` 和 `<mesh>` 之间 —— JSX 顶层不能有两个
       并列表达式，babel 会报 `Unexpected token, expected ","`（本轮踩过，页面直接 500）。
       ⚠️⚠️ 更坑的是：那条注释的收尾符本身就含注释结束符 —— 写进「块注释」里会把块注释
       提前关掉，于是报 `Missing semicolon`（同一个坑本轮踩了两次，判据见 AGENT.md 坑 38）。 */
    return (
        // High segment count is needed for smooth FBM terrain to match grass density
        <mesh ref={meshRef} name="terrain" rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[grassAreaSize, grassAreaSize, segments, segments]} />
            <primitive object={material} />
        </mesh>
    )
}

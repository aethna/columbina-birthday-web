/**
 * 地表真实贴图（Poly Haven，全部 CC0 可商用）。
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────
 * 用户 2026-10-08 的原话：「不是让你去搜索现成的建模资源么？总不能写实海面、
 * 月球风格地貌，全网没有能用的，一定要你从头建模？」
 * 之前月球地表是**纯色 + 程序化噪声颗粒**，确实一眼假。这里换成真实扫描贴图。
 *
 * Poly Haven 的 `moon_*` 系列是**真实月壤/月面扫描**（NASA 数据重制），CC0，可以直接商用。
 * 每张的贴图键固定为 `diff` / `nor_gl` / `rough`，都取 2k JPG（一张 2k 约 1~5 MB）。
 *
 * ── 归一化：为什么要有 `mean` ─────────────────────────────────────────
 * 贴图要**乘**在区域底色上。直接乘会把整体明暗也带进去（月壤贴图均值只有 0.466 sRGB，
 * 整片地会暗掉一半）。所以先除以贴图自己的逐通道均值 ⇒ 得到「均值 = 1 的斑驳」，
 * **只保留变化、不改变整体明暗**，区域底色说了算。
 * 均值由 `_tools` 侧用 PIL 统计（256×256 双线性采样，与全分辨率复核误差 ±0.0005）：
 *   moon_dusted_01  R 0.4950 / G 0.4686 / B 0.4295
 * ⚠️ **必须逐通道**除，不能用单灰度 —— 这张贴图偏暖灰（R>G>B），统一除法会把色偏拉平。
 *
 * ── normal 的强度 ────────────────────────────────────────────────────
 * 三张法线的 R/G 均值都精确 ≈ 0.500（0.4999~0.5031）⇒ 分布已居中，
 * `normalize(tex*2-1)` 直接可用，**不需要整体重映射**，要加凹凸感只调缩放系数。
 */
import * as THREE from 'three/webgpu'

export interface GroundMaps {
    /** 反照率（sRGB 编码贴图） */
    albedo: THREE.Texture
    /** 切线空间法线（OpenGL 约定，线性数据贴图） */
    normal: THREE.Texture
    /** 粗糙度（灰度，线性数据贴图） */
    rough: THREE.Texture
    /** 反照率贴图的逐通道均值（sRGB 编码值的算术平均），用于归一化 */
    mean: [number, number, number]
    /** 反照率贴图的**灰度均值（线性空间）**。用途与 `mean` 不同：
     *  `mean` 是逐通道相除 ⇒ 得到「均值 = 1 的斑驳」，**只保留变化**（给月面用，底色由区域色决定）；
     *  `gray` 是整体相除 ⇒ 得到「灰度均值 = 1，但**保留真实色相**」（给沙子用，沙子的颜色本身要保留）。
     *  ⚠️ 必须是**线性空间**的均值 —— three 的 `texture()` 返回的是 sRGB 解码后的线性值。 */
    gray: number
    /** **一张贴图铺多少米**（世界坐标）。决定颗粒的物理尺度 */
    tile: number
}

const loader = new THREE.TextureLoader()

function loadTex(url: string, srgb: boolean): Promise<THREE.Texture> {
    return loader.loadAsync(url).then((t) => {
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.RepeatWrapping
        t.anisotropy = 8
        // 数据贴图（法线/粗糙度）保持默认 NoColorSpace，绝不能标成 sRGB
        if (srgb) t.colorSpace = THREE.SRGBColorSpace
        t.needsUpdate = true
        return t
    })
}

/** 月球月壤 —— Poly Haven `moon_dusted_01`（真实月壤扫描，2k，CC0）。
 *  `tile = 2.6 m`：2k 贴图铺 2.6 m ⇒ 一个纹素 ≈ 1.3 mm，近看有颗粒、远看有斑驳。 */
export function loadMoonRegolith(): Promise<GroundMaps> {
    const dir = '/textures/ground'
    return Promise.all([
        loadTex(`${dir}/moon_dusted_01_diff_2k.jpg`, true),
        loadTex(`${dir}/moon_dusted_01_nor_gl_2k.jpg`, false),
        loadTex(`${dir}/moon_dusted_01_rough_2k.jpg`, false),
    ]).then(([albedo, normal, rough]) => ({
        albedo,
        normal,
        rough,
        mean: [0.4950, 0.4686, 0.4295] as [number, number, number],
        gray: 0.1908,
        tile: 2.6,
    }))
}

/** 带小坑的月壤 —— Poly Haven `moon_meteor_01`（有迷你撞击坑）。留给「坑缘附近」用。 */
export function loadMoonMeteor(): Promise<GroundMaps> {
    const dir = '/textures/ground'
    return Promise.all([
        loadTex(`${dir}/moon_meteor_01_diff_2k.jpg`, true),
        loadTex(`${dir}/moon_meteor_01_nor_gl_2k.jpg`, false),
        loadTex(`${dir}/moon_meteor_01_rough_2k.jpg`, false),
    ]).then(([albedo, normal, rough]) => ({
        albedo,
        normal,
        rough,
        mean: [0.4981, 0.4709, 0.4313] as [number, number, number],
        gray: 0.1918,
        tile: 1.4,
    }))
}


/* ===== 浅海沙地（`coast_sand_01` / `damp_beach_sand` / `coast_sand_rocks_02`）
 *  与 `loadSand()` / `loadDrySand()` / `loadWetSand()` / `loadCoastRocks()`
 *  于 2026-10-11 随「删海」整块删除（用户 m05607）。
 *  `GroundMaps.gray` 字段暂时保留 —— 将来森林地表若要「保留真实色相」的归一化会用到它。 */

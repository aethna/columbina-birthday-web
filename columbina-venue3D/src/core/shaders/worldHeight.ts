/* ===== 世界分区（无缝大地图）· GPU 侧真值 =====
 *
 * 这个文件是 `core/worldRegions.ts` 的 TSL 孪生版。
 * **两份必须逐行对应**：CPU 那份负责道具摆位，这份负责渲染。
 * 改任何一边的公式，另一边必须同步改 —— 否则月岩会浮在空中。
 *
 * 调用点（全部从 `getTerrainHeight` 换过来）：
 *   · components/Terrain.tsx            地面网格
 *   · components/character/hooks/useCharacterAssets.ts   角色顶点（她站在地形上）
 *   · components/grass/core/grassCompute.ts              草的位置与法线
 *   · components/Rose/core/vatMaterial.ts                玫瑰 VAT
 *
 * ⚠️ TSL 的坑（已经踩过）：
 *   · `Fn(([xz]) => ...)` 返回的是**可调用节点**，`getWorldHeight()` 每次返回一个新的；
 *     同一个 Fn 被多处调用没问题，但别在循环里重复构造（会撑大 shader 编译时间）。
 *   · `smoothstep(e0, e1, x)` 的参数顺序是**下界、上界、自变量**。
 *   · `max/min/clamp/mix` 都是节点函数，不要用 Math.*。
 */

import {
    Fn,
    float,
    vec2,
    vec3,
    length,
    max,
    mix,
    smoothstep,
    step,
    exp,
    clamp,
    mx_noise_float,
    mx_cell_noise_float,
    mx_fractal_noise_float,
    // ⚠️ MaterialX 噪声**必须逐个显式 import**：忘了引就是运行期 `ReferenceError`，
    // 而 vite 只转译不做类型检查 ⇒ 一路静默到「地面整个不见了」。
    // 2026-10-08 因为漏掉 `mx_worley_noise_float` 踩过一次（`?caustic=1` 时 `Terrain`
    // 的 `colorNode` 构造抛错，地面网格消失，海面盘盖在黑背景上）。
    // 删海之后焦散已整块移除，这条教训留在 `AGENT.md` 的坑列表里。
    sin,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { getTerrainHeight } from './terrainHelpers';
import { uTerrainAmp, uTerrainFreq, uTerrainSeed } from './uniforms';
import { REGION_BY_ID, CRATERS, MICRO_WAVES, RIM_VAR, RIM_JAG_AMP, RIM_SCALE, WILD_BLEND_OUT, WILD_BLEND_IN, FOREST_BLEND_OUT, FOREST_BLEND_IN, CRATER_FLOOR_ON, CRATER_FLAT_ON, CRATER_FLAT_R, CRATER_FLAT_SEAM_M, CRATER_LEGACY_D, CRATER_GRAIN_ON, CF_IN, CF_OUT, CF_WALL_OUT, CF_WALL_EDGE, CRATER_WALL_ON, CRATER_BLUE_ON, CRATER_WALLBLUE_ON, CRATER_LEVEL, CRATER_GRASS_ON, SHIP_GRASS_A, SHIP_GRASS_B, SHIP_GRASS_YAW, SHIP_GRASS_FADE, POND_R_IN, POND_R_OUT, POND_TRENCH_D, POND_EDGE_SOFT_M, POND_FLAT_IN_M, POND_FLAT_RAMP_M, POND_FLAT_OUT_M, POND_FLAT_FADE_M, POND_FLAT_Y, type CraterDef, type RegionDef } from '../worldRegions';
// 伪大世界（环形地图）：丘陵改成严格周期 WorldSize = 768 m 的平面波叠加。
// ⚠️ 波表里的幅值**已经含 WILD_AMP/WILD_AMP2**，别在外面再乘一次。
import { WORLD_SIZE, WILD_WAVES_L, WILD_WAVES_M, type Wave } from '../worldWrap';
// 渲染距离的**唯一真值**（`R_VIS = 40`）。本轮只消费、不改数值；`?visr=` 仍然由它解析。
import { R_VIS } from '../world/visRadius';
import { QNUM } from '../utils/query';

/** 十六进制色 → TSL vec3（线性空间由材质的 colorSpace 处理，这里给的是 sRGB 分量） */
export function hexToVec3(hex: string): any {
    const c = new THREE.Color(hex);
    return vec3(c.r, c.g, c.b);
}

/** 无主地带（森林）的林下草参数。
 *  ⚠️⚠️ 2026-10-10 **第三版**（用户 m01512）：「背景素材1/2/3 你看一下，观感照着这个调整。
 *  地面就是目前的草地，通过改变颜色来贴近。」
 *
 *  参考图实测（`_tools/refcolor.py` 取中位色，sRGB）：
 *    素材1 近景暗红草 `#7c2828` / 受光红草 `#552623`
 *    素材2 地面橙锈 `#894518`
 *    素材4 地面砖红 `#60251e`
 *  **三张图的地面全是暖红/橙/砖红家族，没有一张是绿的。**
 *  上一版（m07705 时按用户当场那句「颜色改成绿色」）染成了 `#24421e`/`#5c8a3c`，
 *  这一版按参考图改回朱红：根部比素材1 的暗红草再暗一档，梢部取受直射的草尖色。
 *  ⚠️ 换色**只换 base/tip 两支**，`grassMaterial.ts` 的 colorNode 里
 *     clump/blade 随机种子与 AO 照常参与 ⇒ 林下草地仍有疏密明暗，不是一块平色。 */
export const FOREST_GRASS_H = 0.42;          // 森林里的草高倍率（会场是 1.0）
export const FOREST_GRASS_BASE = '#7d2724';  // 根部的暗朱红（参考图1 采样 #6f2122）
export const FOREST_GRASS_TIP = '#c04a3a';   // 梢部的受光朱红（参考图1 采样 #a83a34）
/* 森林**地形底色**。为什么需要它：
   那块「1M 根草」的载体只有 80×80 m（`DEFAULT_GRASS_AREA_SIZE`），且跟着相机跳格铺，
   所以看出去 40 m 之外的草就没了、露出地形本色，会在草盘边缘留一条**色阶硬缝**。
   把地形底色也拉进同一个色族（砖红），缝就看不见了。
   取 `#6e2f22` = 素材4 砖红 `#60251e` 与素材2 橙锈 `#894518` 之间。 */
export const FOREST_FLOOR = '#93372c';
/** 森林地形底色混入强度（1.0 = 完全覆盖红棕裸土）。 */
export const FOREST_FLOOR_MIX = 0.92;

/* ── ★★ 2026-10-20 task-17：月坑内「飞船草区」的草色（**绿色**）─────────────
 *
 * 用户 m01992：「飞船周围 + 飞船底部 = 绿色草叶（成片、颜色绿）」。
 * 场地草是朱红（`uBaseColor/uTipColor` = `#7a3418 / #e07038`），在坑底那层
 * 红褐土上完全看不出来 ⇒ 坑内必须换一支绿。
 *
 * 实现与森林同一手法（`grassMaterial.ts:324-326` 的 `forestWeightNode` 分支）：
 * 按 `craterFloorWeightNode` 混这两支颜色，坑外权重 0 ⇒ 会场/森林逐位不变。
 * 取色：根 `#3f8f36`（暗草绿，压住红土反光）/ 梢 `#a5e87d`（受光草尖）。
 * ⚠️ 这两支**只给坑内用**，别拿去改 `FOREST_GRASS_*`（那是林下朱红，已定稿）。
 *
 * ★ 2026-10-20 复审（lead QA「夜里读成暗绿苔藓、白天也不亮」）：整体提亮一档 ——
 *   原 `#2f6b2a / #7fd45a` 在夜景 key light 下明度只剩 ~20%，读不出草叶。
 *   现 `#3f8f36 / #a5e87d` 明度 +35% 左右，仍未到荧光（梢色 L≈0.85、S 0.46）。 */
export const CRATER_GRASS_BASE = '#3f8f36';
export const CRATER_GRASS_TIP = '#a5e87d';
/** 坑内草高倍率：齐会场草高 ×1.28（碗底深处要看得出草叶轮廓，又不埋掉船腹）。 */
export const CRATER_GRASS_HEIGHT_K = 1.28;
/** 坑内草叶加宽倍率：俯视时细叶之间露土像苔藓，×1.5 才有「草地」的覆盖感。 */
export const CRATER_GRASS_WIDTH_K = 1.5;

/**
 * ★ 2026-10-20 task-19 任务 2（用户 m02364）：「月坑喇叭花的地面改蓝色
 * （不要和花的颜色一致，暗一些）」。
 *
 * 取 `#1e3352`：暗钢蓝，H≈217°、S≈0.44、明度 ≈0.30 —— 明显低于花的亮蓝
 * （花喉在贴图上是 `#78d8ff` 一带、明度 ≈0.8），也低于会场红褐的感知亮度，
 * 夜里读成「深蓝地」而不是「另一片花」。饱和度压住，免得像塑料泳池。
 *
 * ⚠️ 只混在 `craterFloorWeight` 内（碗底 + 将来 15~21.5 m 的水下地面）；
 *    `?craterblue=0` 回会场红褐土 `#8f3c1a`；坑外逐位不变。
 * ⚠️ 别把它写进 `REGIONS[0].ground`（那是会场基准色，改了一整片会场变色）。
 */
export const CRATER_GROUND_BLUE = '#3179ff';

/** 草高倍率：会场 1.0，森林 0.42。与 `regionGrassMaskNode` 分开，
 *  因为那个管的是「有没有草」（月球 = 0），这个管的是「多高」。 */
export function grassHeightScaleNode(xz: any): any {
    return mix(float(1), float(FOREST_GRASS_H), forestWeightNode(xz));
}

/** 某个区域在 xz 上的权重，恒在 [0,1]。与 `worldRegions.regionWeight` 同式。 */
/**
 * 环面有向差 —— `worldWrap.tdiff` 的 GPU 孪生（伪大世界 / 地图拼接）。
 * ⚠️ 用 `round()` 而不是 `floor()`：`floor` 会在折返线上把差值多跳一个 `W`，
 *    而 `round` 拿到的是「最近的那一份」，与 CPU 的 `tdiff` 定义逐字一致。
 */
function tdiffNode(a: any, b: number): any {
    const d = a.sub(float(b));
    return d.sub(float(WORLD_SIZE).mul(d.div(float(WORLD_SIZE)).round()));
}

/** 到区域中心的**环面**距离（米）。三个权重函数共用。 */
function regionDistNode(xz: any, def: RegionDef): any {
    return length(vec2(tdiffNode(xz.x, def.cx), tdiffNode(xz.y, def.cz)));
}

export function regionWeightNode(xz: any, def: RegionDef): any {
    const d = regionDistNode(xz, def);
    // d <= r - feather ⇒ 1 ；d >= r ⇒ 0
    return float(1).sub(smoothstep(float(def.r - def.feather), float(def.r), d));
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-20 task-17：坑底「会场化」权重 —— `worldRegions.craterFloorWeight` 的 TSL 孪生
 *
 *   用户 m01952：「去掉目前的月壤地板。我的意思是，用默认的，和会场一样的地板。」
 *
 *   ⚠️ 这里**只做外观**：`getWorldHeight()` 一个字都没动（飞船/道具照样贴地）。
 *      消费点：本文件的 `regionGroundColorNode` / `regionGrassMaskNode` /
 *      `regionFogColorNode` / `groundGrainNode` / `detailStrengthNode`
 *      + `Terrain.tsx` 的 3 处 `wMoon`。
 *   ⚠️ 与 CPU 版同参同式：`p = 环面距离 / CRATERS[0].r`，`smoothstep(CF_IN, CF_OUT, p)`。
 *      参数一律读 `CRATERS[0]` / `CF_IN` / `CF_OUT`，**不在任何地方写死 24 / 46**。
 * ══════════════════════════════════════════════════════════════════════════ */
export function craterFloorWeightNode(xz: any): any {
    if (!CRATER_FLOOR_ON) return float(0);
    const p = craterDistNode(xz).div(float(CRATERS[0].r));
    return float(1).sub(smoothstep(float(CF_IN), float(CF_OUT), p));
}

/** 到 `CRATERS[0]` 圆心的水平**环面**距离（米）。 */
function craterDistNode(xz: any): any {
    const c: CraterDef = CRATERS[0];
    return length(vec2(tdiffNode(xz.x, c.x), tdiffNode(xz.y, c.z)));
}

/**
 * ★ 2026-10-20 task-19 任务 4：**坑壁会场化**权重（`worldRegions.craterWallWeight` 的 TSL 孪生）。
 *
 * 用户 m02364：「我看到月坑目前坑壁还有一圈岩石？去掉。」
 * 那圈灰蓝带是 `p 0.88~1.00` 的坑壁仍在走月壤灰材质 —— 把「不是月壤」的范围推到
 * `p ≤ CF_WALL_EDGE (1.25)`（30 m）即可，坑缘脊外侧留一段渐变防硬边。
 * `?craterwall=0` 退回 `craterFloorWeightNode`（旧行为）。
 *
 * ⚠️ 与 `craterFloorWeightNode` 是两个量：那个管「坑底暗蓝/花/草」，这个只管「月壤灰退场」。
 */
export function craterWallWeightNode(xz: any): any {
    if (!CRATER_FLOOR_ON) return float(0);
    if (!CRATER_WALL_ON) return craterFloorWeightNode(xz);
    const p = craterDistNode(xz).div(float(CRATERS[0].r));
    return float(1).sub(smoothstep(float(CF_WALL_OUT), float(CF_WALL_EDGE), p));
}

/** 坑底暗蓝地面权重（task-19 任务 2）：`?craterblue=0` 时恒 0（= 会场红褐土）。
 *
 *  ★ 2026-10-20 用户参考图（`公用区\背景素材\素材\花海.PNG`）：坑内**岩壁也是蓝的**。
 *  所以默认把蓝延到坑壁（复用 `craterWallWeightNode`，即 `p ≤ CF_WALL_EDGE` 30 m）；
 *  `?craterwallblue=0` 回退成只有坑底（= task-19 行为），供 A/B。 */
export function craterBlueWeightNode(xz: any): any {
    if (!CRATER_BLUE_ON) return float(0);
    const floor = craterFloorWeightNode(xz);
    if (!CRATER_WALLBLUE_ON) return floor;
    return max(floor, craterWallWeightNode(xz));
}

/**
 * 月壤**外观**权重 = 区域权重 × (1 − 坑壁会场化权重)。
 * 所有「这一块看着是月面」的地方都用它，别再直接 `regionWeightNode(xz, moon)` ——
 * 碗内 `wMoon ≡ 1`，光靠区域权重抹不掉月壤。
 */
export function moonShadeWeightNode(xz: any): any {
    return regionWeightNode(xz, REGION_BY_ID.moon).mul(float(1).sub(craterWallWeightNode(xz)));
}

/**
 * 飞船草区（task-17）：`1` = 这里长绿草（花让位），`0` = 这里让给花。
 *
 * 形状是**随船停泊朝向旋转的椭圆**（不是圆）：船是「长条机身 + 展向机翼」，
 * 圆要么盖掉太多花区、要么让翼尖跳出草区。半轴 `SHIP_GRASS_A/B`（= 实测 bbox
 * 半轴 + 2 m 余量）、朝向 `SHIP_GRASS_YAW`（= `?wyaw`，缺省 −24°），推导见
 * `worldRegions.ts` 的同名常量 —— **一份真值，CPU 孪生是 `shipGrassZoneCPU()`**。
 *
 * 外沿按 `SHIP_GRASS_FADE`（归一化半径的比例）软化 —— 硬边在低机位能看出一圈椭圆。
 */
export function shipGrassZoneNode(xz: any): any {
    const c: CraterDef = CRATERS[0];
    const dx = tdiffNode(xz.x, c.x);
    const dz = tdiffNode(xz.y, c.z);
    const cs = Math.cos(-SHIP_GRASS_YAW);
    const sn = Math.sin(-SHIP_GRASS_YAW);
    /* 世界 → 船体局部（逆旋转）：局部 X = 展向、局部 Z = 船长方向。 */
    const lx = dx.mul(float(cs)).sub(dz.mul(float(sn)));
    const lz = dx.mul(float(sn)).add(dz.mul(float(cs)));
    /* ⚠️ TSL 没有 `.sqr()`（用了会 `TypeError: ... sqr is not a function` ⇒ 整片草
       编译失败、卡在 CALIBRATING 50%），必须自己 `mul` 自己。 */
    const q = length(vec2(lx.div(float(SHIP_GRASS_A)), lz.div(float(SHIP_GRASS_B))));
    return float(1).sub(smoothstep(float(1.0), float(1.0 + SHIP_GRASS_FADE), q));
}

/** 区域闸门：区域外恒 1、区域内恒 0，只在**外缘 12 米**里过渡。
 *
 *  ★ 与 `regionWeightNode` 的区别是决定性的：那条的过渡带宽 = `def.feather`（月球 50 m），
 *    于是草的密度从「离月球圆心 120 m」就开始掉、到 70 m 就秃光 —— 实测用户走到 z=-77
 *    （离月球圆心还有 93 m，压根没进月球）脚下草已经掉了一半，被投诉成「走出草地就是光秃的地面」。
 *    闸门贴着区域外缘收口 ⇒ 草一路铺到真正踏进场景为止。
 *
 *  ⚠️⚠️ 2026-10-17 修：这里原来写的是**裸差** `xz.sub(def.cx/cz)`，没有走环面差。
 *    伪大世界把世界以 `WORLD_SIZE = 768 m` 环绕复制，月球副本落在 `(0, +572)` / `(0, -964)`；
 *    在副本上裸差算出几百米 ⇒ 闸门恒开（= 1）⇒ 那里「高度是平的月面、草却长满」，
 *    而决定高度/颜色的 `regionWeightNode` 走的是 `tdiff`（= 0），两者直接矛盾。
 *    现在统一走 `regionDistNode`（内部就是 `tdiffNode`），与 `regionWeightNode` /
 *    `wildWeightNode` / `forestWeightNode` 用同一套距离定义 —— 一份真值。 */
export function regionGateNode(xz: any, def: RegionDef): any {
    const d = regionDistNode(xz, def);
    return smoothstep(float(def.r - 12), float(def.r), d);
}

/* ===== 无主地带（森林）的大尺度丘陵 —— `worldRegions.wildWeight / wildShapeCPU` 的 GPU 孪生 =====
 * ⚠️⚠️ 频率、幅值、偏移量、渐入带**必须与 CPU 那份逐字一致**，
 *    否则森林里的道具（用 `worldHeightCPU` 定 y）会浮空或埋进土里。
 * 常量一律从 `worldRegions.ts` import，**不在这里重新写字面量**（判据：一份真值）。
 *
 * 渐入带的作用见 `worldRegions.wildWeight` 的注释：会场是平的、月球有环形山，
 * 12 m 的高差不能落在区域边界上。 */
export function wildWeightNode(xz: any): any {
    const v = REGION_BY_ID.venue, m = REGION_BY_ID.moon;
    const dv = regionDistNode(xz, v);
    const dm = regionDistNode(xz, m);
    const gv = smoothstep(float(v.r + WILD_BLEND_OUT), float(v.r + WILD_BLEND_IN), dv);
    const gm = smoothstep(float(m.r + WILD_BLEND_OUT), float(m.r + WILD_BLEND_IN), dm);
    return gv.mul(gm);
}

/**
 * 森林权重（0 = 在会场/月球附近，1 = 深在无主地带的林子里）。
 * ⚠️ 与 `worldRegions.forestWeight` 逐字同式：GPU 这份决定「草收不收、地面变不变色」，
 *    CPU 那份（`core/forest.ts` 的 `collectChunk`）决定「这里撒不撒树」——两者必须一致，
 *    否则会出现「有草没树」或「有树没草」的缝。
 * ⚠️ 与 `wildWeightNode` **不是一回事**：丘陵的渐入带是照坡度定的（110 m），
 *    植被/草地的渐入带要短得多（34 m），否则两块地之间会空出一条 190 m 的走廊。
 *    详见 `worldRegions.forestWeight` 的注释。
 */
export function forestWeightNode(xz: any): any {
    const v = REGION_BY_ID.venue, m = REGION_BY_ID.moon;
    const dv = regionDistNode(xz, v);
    const dm = regionDistNode(xz, m);
    const gv = smoothstep(float(v.r + FOREST_BLEND_OUT), float(v.r + FOREST_BLEND_IN), dv);
    const gm = smoothstep(float(m.r + FOREST_BLEND_OUT), float(m.r + FOREST_BLEND_IN), dm);
    return gv.mul(gm);
}

/**
 * 平面波叠加的 GPU 版 —— 与 `世界` 的 `worldWrap.periodicWaves` **逐字同式**。
 *
 * 取 `xz.x` / `xz.y`（不是 `.x`/`.z`）：调用方传进来的是 `positionWorld.xz`，
 * 在 three 的 TSL 里那是一个 **vec2**，分量名是 `.x` / `.y`。
 *
 * ⚠️ `sin` 必须从 `three/tsl` 显式 import（和 MaterialX 噪声一样：漏了就是运行期
 *    `ReferenceError`，而 vite 只转译不做类型检查 ⇒ 一路静默到「地形整个不见了」）。
 */
function periodicWavesNode(xz: any, waves: readonly Wave[]): any {
    const k = (Math.PI * 2) / WORLD_SIZE;
    let s: any = float(0);
    for (let i = 0; i < waves.length; i++) {
        const w = waves[i];
        s = s.add(float(w[2]).mul(sin(
            float(k * w[0]).mul(xz.x).add(float(k * w[1]).mul(xz.y)).add(float(w[3])),
        )));
    }
    return s;
}

/**
 * 丘陵形状（米），未乘权重。
 * ★ 2026-10-11：换成 `periodicWavesNode` —— **严格以 `WORLD_SIZE = 768 m` 为周期**，
 *   地图接缝才严丝合缝（推导见 `core/worldWrap.ts` 文件头）。
 * ⚠️ `WILD_WAVES_L / WILD_WAVES_M` 的幅值**已含 `WILD_AMP 12` / `WILD_AMP2 3`**，
 *   这里**绝不能再乘一次**（乘了就成 ±39 m 的山）。
 */
export function wildShapeNode(xz: any): any {
    return periodicWavesNode(xz, WILD_WAVES_L).add(periodicWavesNode(xz, WILD_WAVES_M));
}

/** 环形山「碗」剖面（坑底）。**GPU 孪生**，与 `worldRegions.craterBowlCPU` 同参同式：
 *   · `?craterflat=0` ⇒ 旧的抛物面 `-d·(1-p²)`；
 *   · 默认 ⇒ `p ≤ pf` 恒 `-d`（花岛平台），`pf → 1` 线性升到 0（斜坡），
 *     接缝 1.5 m 用二次起步做 C¹ 连续，末尾除以 `(1-seam/2)` 归一到 p=1 处正好 0。
 *   ⚠️ 用 `clamp` 表达「分段线性 + 接缝平滑」，**不要写 `select/step`** ——
 *      这样 p<pf、p>1 两端都自然夹住，GPU 侧不需要额外的 inside 掩码。 */
function craterBowlNode(p: any, depth: number): any {
    if (!CRATER_FLAT_ON) {
        const inside = float(1).sub(step(float(1), p));
        return float(-CRATER_LEGACY_D).mul(float(1).sub(p.mul(p))).mul(inside);
    }
    const pfNum = Math.min(0.95, CRATER_FLAT_R / CRATERS[0].r);
    const seam = Math.min(0.5, CRATER_FLAT_SEAM_M / (CRATERS[0].r * (1 - pfNum)));
    const q = clamp(p.sub(float(pfNum)).div(float(1 - pfNum)), float(0), float(1));
    // qs = q - seam/2 + (seam/2)·max(0, 1 - q/seam)²  ⇒  q<seam 时 q²/(2·seam)，之后线性
    const ease = clamp(float(1).sub(q.div(float(seam))), float(0), float(1));
    const qs = q.sub(float(seam / 2)).add(ease.mul(ease).mul(float(seam / 2)));
    return float(-depth).mul(float(1).sub(qs.div(float(1 - seam / 2))));
}

/** 单个环形山。与 `worldRegions.craterHeight` **同式**（碗 + 坑缘脊 + 溅射毯）。
 *  ⚠️⚠️ 必须逐字同步：CPU 那份负责道具摆位，这份负责渲染，差一点道具就会浮在空中。
 *  2026-10-09（用户 m05185「月壤坑壁最上边那一圈，还是像海浪一样」）加了坑缘方位向
 *  不均匀 + 脊上碎块，理由见 `worldRegions.craterHeight` 的注释。 */
function craterNode(xz: any, c: CraterDef): any {
    const dx = xz.x.sub(float(c.x));
    const dz = xz.y.sub(float(c.z));
    const d = length(vec2(dx, dz));
    const p = d.div(float(c.r));

    /* 坑底：`craterBowlNode` —— 默认是「r ≤ 15 m 平台 + 15→24 m 斜坡」（task-22），
       `?craterflat=0` 回旧的抛物面碗。**必须与 `worldRegions.craterBowlCPU` 逐字同式**。 */
    const bowl = craterBowlNode(p, c.d);

    // 坑缘：p ≈ 1 处的高斯脊 —— 有这道脊，坑才「立」得起来
    const t = p.sub(float(1));
    /* ★ 坑缘方位向不均匀（真凶是「完美光滑的等高圆环 ⇒ 读成海浪浪脊」）：
       `max(d, 1e-3)` 让 1/d 在坑心不发散且**连续**（不需要 if 分支）；
       `sin(a·ux + b·uz + φ)` 对方向处处连续，没有 atan2 的分支切缝。 */
    const inv = float(1).div(max(d, float(1e-3)));
    const ux = dx.mul(inv);
    const uz = dz.mul(inv);
    const rimVar = float(1).add(float(RIM_VAR).mul(
        sin(ux.mul(2.7).add(uz.mul(1.9)).add(float(1.70))).mul(float(0.34))
            .add(sin(ux.mul(-4.3).add(uz.mul(3.1)).sub(float(0.60))).mul(float(0.22)))
            .add(sin(ux.mul(6.1).sub(uz.mul(2.3)).add(float(2.90))).mul(float(0.13))),
    ));
    const rimW = float(0.020).mul(
        float(1).add(float(RIM_VAR * 0.45).mul(sin(ux.mul(3.3).sub(uz.mul(2.6)).add(float(0.40))))),
    );
    const rimShape = exp(t.mul(t).div(rimW).mul(float(-1)));
    const rim = float(c.rim).mul(rimVar).mul(rimShape);
    /* ★ 脊上碎块：米级 + 不可分离（3 条「螺旋」波）。系数含义与精度分析见
       `worldRegions.craterHeight` 里的同名注释 —— 简单说：第一版系数只有个位数
       ⇒ 沿坑缘一周才 1~3 个周期（波长 90 m+）⇒ 剪影仍是光滑长波 = 沙丘，不是石头。
       ⚠️⚠️ 2026-10-10 用户 m05344 把坑半径 46→24 之后这三组系数各乘了 24/46，
       否则方位向/径向波长会跟着半径一起缩到网格分辨率以下。**必须与 CPU 那份逐字一致。** */
    const bump = sin(p.mul(21.0).add(ux.mul(71.0)).add(uz.mul(46.0)).add(float(0.70))).mul(float(0.55))
        .add(sin(p.mul(15.0).sub(ux.mul(53.0)).add(uz.mul(85.0)).sub(float(1.90))).mul(float(0.40)))
        .add(sin(p.mul(28.0).add(ux.mul(94.0)).sub(uz.mul(38.0)).add(float(2.40))).mul(float(0.30)));
    /* ⚠️ 幅值用 `RIM_JAG_AMP`（固定 0.30 m）而**不是** `c.rim*0.16`：
       坑半径缩到 24 后坑缘只有 0.7 m 高，按比例就只剩 ±0.11 m ⇒ 上一轮的「岩脊剪影」消失。
       与 CPU 侧 `worldRegions.craterHeight` 必须逐字一致。 */
    const jag = float(RIM_VAR * RIM_JAG_AMP).mul(rimShape).mul(bump);

    // 外侧溅射毯
    const ejecta = step(float(1), p)
        .mul(float(c.rim * 0.18))
        .mul(exp(p.sub(float(1)).div(float(0.6)).mul(float(-1))));

    /* ★ 2026-10-21 用户 10-21 反馈1（红圈）：「删掉高于地面的岩石凸起，改平，
       不需要山峰」—— 目标物就是这一圈 `rim + jag + ejecta`。三项统一乘
       `RIM_SCALE`（缺省 0 = 压平）。`bowl` 不参与：用户要删的是「凸出地面的
       山峰」，不是月坑本身。
       ⚠️⚠️ 必须与 CPU 侧 `worldRegions.craterHeight` 逐字一致，否则道具会浮/陷。 */
    return bowl.add(rim.add(jag).add(ejecta).mul(float(RIM_SCALE)));
}

export function craterFieldNode(xz: any): any {
    let h: any = float(0);
    for (let i = 0; i < CRATERS.length; i++) h = h.add(craterNode(xz, CRATERS[i]));
    return h;
}

/**
 * 解析微起伏（GPU 版）。**直接读 CPU 侧的 `MICRO_WAVES` 表**，
 * 不再各抄一份公式 —— 抄错一次月壤上的碎石与站在上面的角色就会浮起来。
 * 见 `worldRegions.microRelief` 的注释：旧版是可分离的 `sin×cos`（水波公式 + 规则点阵），
 * 2026-10-09 换成 6 条方向不可约的平面波之和。
 */
export function microReliefNode(xz: any): any {
    let h: any = null;
    for (let i = 0; i < MICRO_WAVES.length; i++) {
        const w = MICRO_WAVES[i];
        const term = xz.x.mul(float(w.kx))
            .add(xz.y.mul(float(w.kz)))
            .add(float(w.p))
            .sin()
            .mul(float(w.a));
        h = h === null ? term : h.add(term);
    }
    return h;
}

/* `basinNode()`（浅海盆地）与 `seabedCausticNode()`（水下焦散）
 * 于 2026-10-11 随「删海」整块删除（用户 m05607）。CPU 侧的 `basinDepth()` 同删。 */

/* ===== 月球配色：暗色月海 vs 亮色月陆 =====
 *
 *  ★ 用户 m02280：「月壤不过是沙子+碎石+坑，类似的多了去。关键是，在日月光照下的配色。」
 *    m02289：「不光是日照。非日照，星光下的配色也很重要。」
 *
 *  真实月面的「配色」信息量其实只有两条：
 *    ① 反照率极低（0.07~0.13）且**暖偏**（反射率随波长上升 ⇒ R>G>B）；
 *    ② **月海（暗，玄武岩，偏冷）与月陆（亮，斜长岩，偏暖）的巨大色块对比**。
 *  第 ② 条是月球那张脸的全部特征 —— 没有它，再好的月壤贴图也是一片均匀的灰。
 *
 *  实现用的是一层**极低频**的 perlin（波长 ~170 m，比 120 m 的区域半径还大），
 *  所以它给的是「几大片」而不是「斑驳」。只进颜色、**绝不进高度**
 *  （铁律见文件底部那节），所以不需要 CPU 孪生。
 */
export function moonMareMaskNode(xz: any): any {
    const p = vec3(xz.x.mul(float(0.0059)), xz.y.mul(float(0.0059)), float(0));
    // 再叠一层稍高频的（~55 m）打散大色块的边缘，免得看起来像贴了两张纯色纸
    const m = mx_noise_float(p, float(1.0)).mul(float(0.72))
        .add(mx_noise_float(p.mul(float(3.1)).add(vec3(7.3, 2.1, 0.0)), float(1.0)).mul(float(0.28)));
    // 阈值压到 0.42~0.72：让月海占约三成面积（真实的月海约占正面 31%，巧合但好看）
    return smoothstep(float(0.42), float(0.72), m);
}

/** 月面基色：月陆 ↔ 月海 按上面那层低频掩码混合 */
export function moonGroundColorNode(xz: any): any {
    const moon = REGION_BY_ID.moon;
    const high = hexToVec3(moon.highland ?? moon.ground);
    const dark = hexToVec3(moon.mare ?? moon.ground);
    return mix(high, dark, moonMareMaskNode(xz));
}

/**
 * ⭐ 世界高度函数工厂。返回 `(xz) => height`，xz 是世界坐标的 vec2。
 *
 * ⚠️ 2026-10-11 起，与 CPU 版 `worldHeightCPU` **在全图范围逐项相等**：
 *      基础 FBM   → `core/baseHeightCPU.ts`（three `mx_noise.js` 的逐字 JS 移植）
 *      环形山     → `craterFieldNode` ↔ `craterField`
 *      微起伏     → `microReliefNode` ↔ `microRelief`
 *      丘陵       → `wildShapeNode * wildWeightNode` ↔ `wildShapeCPU * wildWeight`
 *    两边**必须同步改动**，否则森林里的道具（用 `worldHeightCPU` 定 y）会浮空或埋进土。
 *    历史上这里写过「CPU 侧算不出来所以返回 0」—— 那个前提已经作废。
 */
/**
 * 坑外水环整形（GPU 孪生，task-24）。
 * 与 `core/worldRegions.ts: pondRingShape()` **同参同式**：
 *   ① r 25 ~ 26.6 smoothstep 拍平到 `POND_FLAT_Y`，34 ~ 36 smoothstep 淡出回原地面；
 *   ② r 25.5 ~ 33 再挖 `POND_TRENCH_D`（0.32 m），内外缘各 `POND_EDGE_SOFT_M` 收边。
 * r > 36 时两个权重都是 0 ⇒ 与原高度**逐位相同**。
 */
export function pondRingNode(xz: any, h: any): any {
    const c: CraterDef = CRATERS[0];
    const dx = tdiffNode(xz.x, c.x);
    const dz = tdiffNode(xz.y, c.z);
    const r = length(vec2(dx, dz));
    const wF = smoothstep(float(POND_FLAT_IN_M), float(POND_FLAT_IN_M + POND_FLAT_RAMP_M), r).mul(
        float(1).sub(smoothstep(float(POND_FLAT_OUT_M), float(POND_FLAT_OUT_M + POND_FLAT_FADE_M), r)),
    );
    const flat = mix(h, float(POND_FLAT_Y), wF);
    const sIn = smoothstep(float(POND_R_IN - POND_EDGE_SOFT_M), float(POND_R_IN + POND_EDGE_SOFT_M), r);
    const sOut = float(1).sub(smoothstep(float(POND_R_OUT - POND_EDGE_SOFT_M), float(POND_R_OUT + POND_EDGE_SOFT_M), r));
    return flat.sub(sIn.mul(sOut).mul(float(POND_TRENCH_D)));
}

export function getWorldHeight() {
    // 会场的基础 FBM（保持原样，不引入任何视觉回归）
    const baseHeight = getTerrainHeight(uTerrainAmp, uTerrainFreq, uTerrainSeed);

    const moon = REGION_BY_ID.moon;

    // 环形山与微起伏只做一次，避免每次调用重复构造节点图
    return Fn(([xz]: [any]) => {        const wMoon = regionWeightNode(xz, moon);

        // 基础 FBM 按「月球区域的 baseAmp」淡出：
        //   会场 baseAmp = 1 ⇒ 系数 1（不变）
        //   月球 baseAmp = 0 ⇒ 系数 1 - wMoon（区域内完全抹平）
        // ⚠️ 删海之后，**无主地带（森林）走的就是 baseScale = 1 这一支** ——
        //    那里地形完全由基础 FBM 决定，也就是「做浅海之前的样子」。
        const baseScale = float(1).sub(wMoon);
        const base = baseHeight(xz).mul(baseScale);

        // 微起伏：只有月球有（`micro = 0.62`），会场与无主地带都是 0
        const micro = microReliefNode(xz).mul(float(moon.micro).mul(wMoon));

        const craters = craterFieldNode(xz).mul(wMoon);

        // 无主地带的大尺度丘陵 —— 与 CPU 的 `wildShapeCPU * wildWeight` 逐字对应。
        // 渐入带保证会场/月球边缘不吃到这 12 m 高差（见 `worldRegions.wildWeight`）。
        const wild = wildShapeNode(xz).mul(wildWeightNode(xz));

        const sum = base.add(micro).add(craters).add(wild);
        // 坑外水环（task-24）：`?craterflat=0` 时整块跳过，回旧地形。
        return CRATER_FLAT_ON ? pondRingNode(xz, sum) : sum;
    });
}

/** 地面配色：会场色打底，按区域权重混到**月面（月海↔月陆）**，再按森林权重压向苔绿。
 *  ⚠️ 删海之后，无主地带（森林）拿到的就是 `baseColor`（= `uTerrainColor` `#8f3c1a`）本身。 */
export function regionGroundColorNode(xz: any, baseColor: any): any {
    /* ★ 2026-10-20 task-17：这里用 `moonShadeWeightNode`（= 区域权重 × (1 − 坑底权重)），
       不是裸的 `regionWeightNode`。坑碗里 `wMoon ≡ 1`，裸用它 ⇒ 坑底永远是月壤灰，
       用户要的「和会场一样的地板」（红褐 `#8f3c1a` + 同款颗粒）就落不下来。
       `?craterfloor=0` 时坑底权重恒 0，这一行等价回旧代码。 */
    const wMoon = moonShadeWeightNode(xz);
    const moonCol = moonGroundColorNode(xz);
    /* 2026-10-10 第三版（用户 m07705「地面改成绿色」）：
       森林地面**主**靠草去覆盖（见 `grassMaterial.ts` 的 `FOREST_GRASS_*`），
       但草的载体只有 80×80 m 且跟着相机跳格（`GrassWebGPU.tsx:26`），
       40 m 之外必然露出地形本色 —— 于是「绿草」和「红棕地形」之间会出现一条**硬缝**。
       这里按森林权重把地形底色也压向 `FOREST_FLOOR`，缝就没了。
       只混 78%：留一点暖底，免得远处地面读成一块死平色。
       ⚠️ 顺序要紧 —— **先**混月面**再**混森林：月球区域 `forestWeight` 本来就是 0
          （`forestWeight` 把两个区域都排除掉），不会互相打架。 */
    const wForest = forestWeightNode(xz);
    const base0 = mix(baseColor, moonCol, wMoon);
    /* ★ 2026-10-20 task-19 任务 2（用户 m02364）：「月坑喇叭花的地面改蓝色
       （不要和花的颜色一致，暗一些）」
       · 只在**坑底**（`craterFloorWeight`）混，坑外逐位不变（`?craterblue=0` 时权重恒 0）；
       · 颜色 `CRATER_GROUND_BLUE`（暗钢蓝）明度明显低于花、饱和度低，夜里是「深蓝地」；
       · 外圈 15~21.5 m 将来是水体（task-20），半透明水透出来的就是这块蓝底
         —— 不能是红土，所以这里必须覆盖整个 `craterFloorWeight > 0` 的区域。 */
    const wBlue = craterBlueWeightNode(xz);
    const base = mix(base0, hexToVec3(CRATER_GROUND_BLUE).mul(float(CRATER_LEVEL)), wBlue);
    return mix(base, hexToVec3(FOREST_FLOOR), wForest.mul(float(FOREST_FLOOR_MIX)));
}

/**
 * 草的密度系数：0 = 这块地不长草。
 * 月球是 0（用户要求：**只有踏进其他场景才不再长草**）。
 * 用法：把它接到草材质的 alpha 上 —— 乘 0 的叶片会被 alphaTest 丢掉。
 *
 * ⚠️ 这里必须用 `regionGateNode`（贴外缘的窄带）而不是 `regionWeightNode`（羽化 50 m 的宽带），
 *    否则草会在离场景还有几十米的地方就开始秃。理由详见 `regionGateNode` 的注释。
 * ⚠️ 删海（用户 m05607）之后只剩月球一个门控 ⇒ 无主地带**全长草**，
 *    这就是做浅海之前的默认状态。
 */
export function regionGrassMaskNode(xz: any): any {
    const gMoon = regionGateNode(xz, REGION_BY_ID.moon);
    // 区域内 = 该区域自己的密度；区域外 = 1（无主地带一律长草）
    const a = mix(float(REGION_BY_ID.moon.grass.density), float(1), gMoon);
    /* ⚠️ 2026-10-10 第二版（用户 m07705）：**撤销**上一版「森林里把草整片收掉」。
       用户要的是「继续用原本的草地，长度缩小、颜色改成绿色」⇒ 森林里草照样长，
       只是矮了、绿了（见 `grassHeightScaleNode` 与 `grassMaterial.ts` 的 colorNode）。
       这里只保留月球那一道门控。 */

    /* ★★ 2026-10-20 task-17：坑底再叠一层「飞船草区」。
       需求（用户 m01992）：①主视角是**一片蓝喇叭花丛**、花区里没有草叶；
                        ②飞船周围 + 船底是**绿色草叶**；③草不许穿船。

       判据：`cf` = 坑底权重（碗内 1 → 坑缘 0）。
         · 坑外（`cf = 0`）：`a` 原样，行为与改前逐位相同。
         · 碗内（`cf = 1`）：`a = shipGrassZoneNode`（随船旋转的椭圆，
           半轴 `SHIP_GRASS_A/B`，外沿软化 `SHIP_GRASS_FADE`）
           ⇒ 只有飞船外圈一圈长草，其余全秃 —— 秃掉的那块正是**花区**
           （`FlowerClusters.tsx` 的坑内花盘从 `SHIP_FLOWER_R_MIN = R + 0.6` 起）。
       两边 mask 天生互补，不需要运行时同步：草在 GPU 侧按这组常量烘死，
       花在 CPU 侧读同一对常量（`worldRegions.ts` 一份真值）。

       ⚠️ 船体本身（机身/龙骨/发动机舱贴地段）由 `keepOut.ts` 的飞船椭圆再挖一层：
          `keepOutAt()` 只把草高压到 8%（≈5 cm 草茬），配合 `API_BURY = 0.30 m`
          的埋深 ⇒ 船腹离地 0.66 m，物理上够不到。 */
    const cf = craterFloorWeightNode(xz);
    /* ★ 2026-10-20 task-19 任务 1（用户 m02364）：「原绿色草地部分改成喇叭花。」
       ⇒ 坑内**不再长草**（那块地整块改种喇叭花，花区就是原来的草区）。
       坑外（`cf = 0`）逐位不变；`?cratergrass=1` 可回退到 task-17 的「船周绿草」。 */
    const a2 = CRATER_GRASS_ON ? mix(a, shipGrassZoneNode(xz), cf) : mix(a, float(0), cf);

    return clamp(a2, float(0), float(1));
}

/** 雾色：按区域权重混
 *  ★ 2026-10-20 task-17：坑底用 `moonShadeWeightNode` ⇒ 碗内退回会场的雾色
 *  （`REGIONS[0].fog.color = #c4f7f0`）。地面既然改成会场那套红褐土，
 *  雾色就得跟着，否则「近处会场色 + 远处月亮灰」在坑口拉出一条硬边。 */
export function regionFogColorNode(xz: any, baseColor: any): any {
    const wMoon = moonShadeWeightNode(xz);
    return mix(baseColor, hexToVec3(REGION_BY_ID.moon.fog.color), wMoon);
}

/* ============================================================
 *  地表细节（albedo 颗粒 + 微观法线）
 *
 *  ★ 铁律：**这里的所有函数都不进 `getWorldHeight()`**。
 *    一旦进了高度，CPU 那份 `worldHeightCPU` 就得逐位同步，否则月岩会浮起来。
 *    细节贴图本来就该只影响着色 —— 法线扰动能造出「有颗粒的地」，高度不行。
 *
 *  ⚠️ 唯一的新风险是**远处闪烁**：细节频率高达 37 周期/米，
 *    60 米外每像素都跨过好几个周期 ⇒ 会变成一片抖动的电视雪花。
 *    所以下面每条细节都乘一个 `detailFadeNode(dist)`，20 米内满、60 米外归零。
 * ============================================================ */

/** 细节的距离淡出：0~20 m 满、60 m 外 0。`dist` 是世界坐标到相机的距离。
 *  这一条管的是**微观法线**（波长 2.7 cm ~ 32 cm，60 m 外每像素跨好几个周期 ⇒ 必须掐掉）。 */
export function detailFadeNode(dist: any): any {
    return float(1).sub(smoothstep(float(20), float(60), dist));
}

/** 反照率颗粒的距离淡出：0~20 m 满、**140 m** 外才归零。
 *  和 `detailFadeNode` 分开是因为两者能承受的距离差一个数量级：
 *  法线的最高频是 2.7 cm（远处必闪），而反照率的 `mottle` 波长约 1.8 m，
 *  140 m 外每像素也只是跨过零点几个周期，不会闪。
 *  这一条就是为了**填掉 40~80 m 那一圈「光秃的地」** —— 草只铺 80 m，
 *  再远只剩纯色地面；有了它，远处地面至少还有 1.8 m 尺度的斑驳，不像刷了漆。
 *
 *  ⚠️ 2026-10-21 第四轮反馈 4b：**这条现在只能当「40 m 内」的补充**。
 *     用户原话（`WorldController.tsx` 的 `FOREST_FOG_*` 上方也记着）：
 *     「比如我的世界，我把渲染距离设置为 40 m，那么 40 m 外啥都看不见……
 *      出了 40 m 就看不见。」
 *     ⇒ 渲染距离之外是**裸基底**，不该有「填 40~80 m」的细节。
 *     真正把细节在 40 m 处切干净的是下面 `renderFadeNode()`（乘在 `Terrain.tsx`
 *     的每一个细节层上）；本函数保留 20~140 m 的缓坡是为了让
 *     `renderFadeNode` 的边界不出现一条硬缝（两者相乘，靠近 40 m 时
 *     `renderFadeNode` 先到 0，`grainFadeNode` 的值就不再有可见影响）。 */
export function grainFadeNode(dist: any): any {
    return float(1).sub(smoothstep(float(20), float(140), dist));
}

/* ════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-21 第四轮反馈 4b：「草地之外的地板也渲染了」★★
 *
 * 用户要的是 **Minecraft 的渲染距离语义**：渲染距离 40 m ⇒
 *   · 40 m 内：现在这一套（草 / 细节 / 颗粒 / 法线 / 月壤扫描贴图）原样不动；
 *   · 40 m 外：**只留一层可读的平基底**（`regionGroundColorNode` 的纯色 +
 *     低频光影），草纹、颗粒、法线扰动、扫描贴图细节全部退化成常量；
 *   · 再远：雾收尾（`groundFog` + 线性 fog far）。
 *
 * 半径的唯一真值仍然是 `core/world/visRadius.ts` 的 `R_VIS = 40`（本轮**不改数值**）。
 *   这里只做「消费」：把同一个数字读进来，做一段窄过渡带。
 *   为什么要有过渡带（而不是 `step(40, dist)`）：硬边会在草地上画出一圈
 *   **可见的圆环**，比「有细节」更像 bug。带子上半宽 3 m / 下半宽 5 m，
 *   39→45 m 之间完成退化；40 m 之上已经完全读作裸基底。
 *   `?rvfade=<m>` 可改这个半宽（A/B 用，0 = 硬切）。
 * ════════════════════════════════════════════════════════════════════════ */

/** `R_VIS` 里交给 TSL 的那份拷贝。只有 `Infinity`（`?visr=0`）需要特判。 */
const RENDER_R = Number.isFinite(R_VIS) ? R_VIS : 1e4;
/** 过渡带半宽：`smoothstep(R-w0, R+w1, dist)`。 */
const RENDER_FADE_IN = QNUM('rvfade', 3)!;
const RENDER_FADE_OUT = QNUM('rvfade2', 5)!;

/**
 * ⚠️ 2026-10-22 踩到：`?rvfade=0&rvfade2=0` 会让 `smoothstep(a, a, dist)` 变成
 * `clamp((x-a)/(b-a))` 里的 **0/0**，输出取决于后端实现 —— 实机表现是整片地形
 * 变成近黑色（A/B 对照图里 45 m 外的格子均值 0.0~2.0，而正常是 55~75）。
 *   所以「关掉退化」不能用 `rvfade=0`，要用下面的 `?rvis=0`；
 *   同时这里仍做一次 `den = max(b-a, 1e-4)` 兜底，让 `0` 至少是「硬切」而不是 NaN。
 */
const RENDER_FADE_ON = QNUM('rvis', 1)! > 0;

/**
 * 「渲染距离」淡出：`dist < R_VIS` 时 1，`dist > R_VIS + 5` 时 0。
 *
 * **所有只属于「渲染距离内」的地表细节都要乘它。**
 * 已经接在这个函数上的（`Terrain.tsx`）：颗粒 `grain`、月岩反照率/法线扫描贴图、
 * mare 斑块、坑底月壤三档扫描贴图、微观法线扰动。
 * 不接的东西是**为了读得懂**：地形高度、`regionGroundColorNode` 的区域基色、
 * 雾。裸基底 = 区域基色，所以它必须在 40 m 外仍然可见。
 *
 * 开关：`?rvis=0` 逐位回到本轮改动之前（整段细节在任意距离都不退化），
 * 这是 40 m 内/外的 A/B 对照**唯一可信**的做法 —— 它把这一项整个拿掉，
 * 而不是改过渡带的两个端点。
 */
export function renderFadeNode(dist: any): any {
    if (!RENDER_FADE_ON) return float(1);
    const r = float(RENDER_R);
    const a = r.sub(float(RENDER_FADE_IN));
    const b = r.add(float(RENDER_FADE_OUT));
    // 0/0 兜底：端点重合时退化成硬切（见上面的踩坑记录）
    const den = max(b.sub(a), float(1e-4));
    const t = (dist as any).sub(a).div(den).clamp(0.0, 1.0);
    return float(1).sub(t.mul(t).mul(float(3).sub(t.mul(float(2)))));
}

/**
 * `renderFadeNode` 的 **CPU 镜像**，给 t21 的确定性探针 `window.__vis(r)` 用。
 *
 * 为什么要有它：像素级 A/B 在这套场景里测不出来（`_logs/t4/t26-rvis-apparatus.md`
 * 与 `_logs/t4/t21-40m-geom-evidence.md` 记了原因——机位没分辨力、月面无照明、
 * 草景时域噪声大于效应量）。改成确定性读数后，必须保证「读数用的公式」与
 * 「GPU 真正执行的公式」是**同一组常数**，否则又是一份二手复刻。
 *   ⇒ 这里直接复用上面那四个模块级常数（`RENDER_R / IN / OUT / ON`），
 *     不重新读 query、不另抄一份数字。改 `?rvfade` / `?rvis` 会同步反映到这里。
 *
 * 与 TSL 版本的逐项对应：
 *   `if (!RENDER_FADE_ON) return float(1)`  → 同样短路返回 1
 *   `smoothstep(a, b, d)`（`t.clamp(0,1)` + `t²(3−2t)`）→ 同样的 Hermite 插值
 *   `max(b − a, 1e-4)` 的 0/0 兜底                → 同样的兜底
 */
export function renderFadeCPU(dist: number): number {
    if (!RENDER_FADE_ON) return 1;
    const a = RENDER_R - RENDER_FADE_IN;
    const b = RENDER_R + RENDER_FADE_OUT;
    const den = Math.max(b - a, 1e-4);
    const t = Math.min(Math.max((dist - a) / den, 0), 1);
    return 1 - t * t * (3 - 2 * t);
}

/** 探针要回报的端点（米），避免调用方自己猜过渡带位置。 */
export function renderFadeReport(): {
    on: boolean;
    r: number;
    fadeIn: number;
    fadeOut: number;
    bandStart: number;
    bandEnd: number;
} {
    return {
        on: RENDER_FADE_ON,
        r: RENDER_R,
        fadeIn: RENDER_FADE_IN,
        fadeOut: RENDER_FADE_OUT,
        bandStart: RENDER_R - RENDER_FADE_IN,
        bandEnd: RENDER_R + RENDER_FADE_OUT,
    };
}

/**
 * 微观起伏（单位：米）。三个八度的 Perlin 叠出来的「地面颗粒」。
 * 波长约 0.32 / 0.09 / 0.027 m —— 月壤颗粒、沙粒、土坷垃都在这个尺度。
 * 只喂给法线，不喂给高度。
 */
export function detailReliefNode(xz: any): any {
    const p = vec3(xz.x, xz.y, float(0));
    const g1 = mx_noise_float(p.mul(float(3.1)), float(0.030));
    const g2 = mx_noise_float(p.mul(float(11.0)).add(vec3(5.3, 1.7, 0.0)), float(0.012));
    /* ⚠️ 2026-10-09：第三层从 `p*37.0`（波长 0.027 m）降到 `p*22.0`（波长 0.045 m）、
       振幅从 0.005 降到 0.0035。原因见下面 `detailPerturbNode` 的差步长说明：
       0.027 m 的细节在 1 米视距下已经比一个像素还小，求出来的法线是**纯噪声**，
       相机一动就是一层翻滚的沙 —— 用户 m03192 说的「像波浪一样起伏」有它一份。 */
    const g3 = mx_noise_float(p.mul(float(22.0)).add(vec3(17.1, 29.3, 0.0)), float(0.0035));
    return g1.add(g2).add(g3);
}

/**
 * 世界空间的法线扰动量（未归一化）：`(-dh/dx, 0, -dh/dz)`。
 *
 * ⚠️⚠️ 2026-10-09 修正（用户 m03192「月壤走上去，地面像波浪一样起伏…指的是走路/视角转动时」）。
 * 旧值是 `e = 0.06`，而 `detailReliefNode` 最细一层波长是 **0.027 m**
 * —— **差分步长比它自己采样的最短波长还大 2.2 倍**，等于拿一把 6 cm 的尺子去量 2.7 cm 的波纹：
 * 量出来的梯度不是梯度，是**走样后的随机数**。这个随机数逐像素加在法线上
 * （月球强度 0.42，clamp ±2.0 → 最大 26° 的随机倾角），
 * **静止时看不出来**（是一层细砂噪声），**一旦平移或转视角就开始翻滚**
 * —— 正好对上用户的描述。而且这层扰动按 `wMoon` 淡入 ⇒ **只有月球区有**，
 * 也正是他在抱怨的地方。
 *
 * 现在：`e = 0.14`（≈ 最细波长的 3.1 倍，欠采样消失），clamp 收到 ±0.9（≈ 42°，仍够「颗粒感」）。
 * 判据写下来：**有限差分的步长必须大于高度场里参与求导的最短波长**，否则加频率不如减步长。
 */
export function detailPerturbNode(xz: any, strength: any): any {
    const e = float(0.14);
    const h0 = detailReliefNode(xz);
    const hx = detailReliefNode(xz.add(vec2(e, float(0))));
    const hz = detailReliefNode(xz.add(vec2(float(0), e)));
    const gradX = clamp(h0.sub(hx).div(e), float(-0.9), float(0.9));
    const gradZ = clamp(h0.sub(hz).div(e), float(-0.9), float(0.9));
    return vec3(gradX, float(0), gradZ).mul(strength);
}

/**
 * 反照率颗粒系数（乘在区域底色上）。两套配方按区域权重混：
 *   · 月壤 —— 细颗粒 + 砾石：perlin 斑驳 + 两层 cell noise（硬边小格子，正好像碎石/小坑）
 *   · 会场 / 无主地带 —— **只加 12% 的土斑**（幅度刻意压到最小，裸 URL 不许回归）
 * 删海（m05607）后移除了沙底波纹那一支。
 */
export function groundGrainNode(xz: any): any {
    /* ★ 2026-10-20 task-17：坑底走「会场配方」（`mottle · 0.12`），
       与同处红褐土的会场地面读起来是**同一种地**；坑外与改前逐位相同。 */
    const wMoon = moonShadeWeightNode(xz);
    const p = vec3(xz.x, xz.y, float(0));

    const mottle = mx_noise_float(p.mul(float(0.55)).add(vec3(3.7, 9.1, 0.0)), float(1.0));

    const speck = mx_cell_noise_float(p.mul(float(26.0)));
    const pebble = mx_cell_noise_float(p.mul(float(7.0)).add(vec3(11.0, 5.0, 0.0)));
    const moonCol = mottle.mul(float(0.30))
        .add(speck.sub(float(0.5)).mul(float(0.30)))
        .add(pebble.sub(float(0.5)).mul(float(0.22)));

    const venueCol = mottle.mul(float(0.12));

    const d = mix(venueCol, moonCol, wMoon);

    /* ★★ 2026-10-20 task-23（用户 m02431「长喇叭花的地面不要纯色，需要一些类似土地的纹理」）
       坑底土纹**不在这个函数里做**：`mx_noise_float` 在本项目的 colorNode 里实测恒为 0
       （第 1~4 版程序噪声逐帧 A/B 全部 `pixel diff max = 1`），所以改用真实土壤扫描贴图，
       落在 `Terrain.tsx` 的 colorNode 里（3.4 m / 13.7 m 两层平铺）。
       开关仍是 `?cratergrain=0`（`CRATER_GRAIN_ON`），由 `Terrain.tsx` 消费。 */
    return float(1).add(d);
}

/** 微观法线扰动的强度（各区域不一样；月球颗粒最粗，会场最平）。
 *
 *  ⚠️⚠️ 2026-10-09 大幅下调（月球 0.42 → **0.16**，浅海 0.30 → 0.16，会场 0.10 → 0.06）。
 *  原因：这层扰动的源头是 `detailReliefNode` 里的 `mx_noise_float`，
 *  最粗一层波长 **0.32 m**、振幅 0.030 m，梯度算下来接近 0.6，
 *  是**光滑的 Perlin 斑块** —— 在 1.5 m 视高下，0.32 m 的柔和大斑块
 *  看上去就是一片**缓慢起伏的水面/沙纹**（`FIX_noon_close.png` / `F2_noon_close.png`
 *  里那片波纹就是它，跟贴图层的朝向无关，所以旋转 UV 治不了）。
 *  真实月壤在厘米尺度上是**高频、低振幅、互不相关**的颗粒，不是连成一片的波纹
 *  ⇒ 正确做法是**把这层程序噪声压到配角**，颗粒感交给真实的 `moon_dusted_01` 法线贴图
 *  （见 `Terrain.tsx` 的 0.62 m 那一层，权重同时提上去了）。
 *  这两个数字要一起动：**程序噪声压下去、真贴图提上来**，否则地面会变平。
 */
export function detailStrengthNode(xz: any): any {
    /* ★ 2026-10-20 task-17：坑底取会场强度 0.06（月壤那层 0.16 的粗颗粒会读成「还是月球」）。
       ⚠️ 只影响**微观法线**，不进高度链。 */
    const wMoon = moonShadeWeightNode(xz);
    const v = float(0.06);
    return mix(v, float(0.16), wMoon);
}


/* `seabedCausticNode()`（水下焦散）于 2026-10-11 随「删海」整块删除（用户 m05607）。
 *  相关历史坑（`mx_worley_noise_float` 忘 import ⇒ 节点图抛 ReferenceError ⇒ 地面整个消失、
 *  且 vite 只转译不做类型检查一路静默）已移到 `AGENT.md` 的坑列表里，代码不再保留。 */


/* ==========================================================================
 * t3 (round-3 feedback 4): distance fade for the bright far floor beyond
 * the 40 m grass refresh radius (user screenshot 3: crater floor runs to
 * the horizon).
 *
 * Fault (measured, do not re-derive):
 *   - terrain is one 160 m plane that snaps to the camera (Terrain.tsx);
 *   - renderFadeNode above only feeds the DETAIL layers (grain / normals /
 *     regolith / mare) in Terrain.tsx; regionGroundColorNode's region base
 *     color and the geometry deliberately do not fade;
 *   - mat.opacityNode's old band (rInner=0.78*half, rOuter=half) with
 *     alphaTest=0.5 and NO mat.transparent = fake fade, actually a hard cut
 *     at ~71.2 m;
 *   => 40-71 m is a bright bare-base band, then sky. 
 *
 * groundFadeNode returns the COLOR fade weight: 0 = untouched (near),
 * 1 = fully at target color. The caller supplies the target color (venue /
 * forest: the groundFog paint color; moon: the real horizon color) because
 * only the caller knows what the terrain edge should dissolve into.
 *
 * groundFadeCPU / groundGeomFadeCPU mirror the GPU functions bit-exactly
 * (same module constants) so the __gfade probe can never drift from the
 * shader (same policy as renderFadeCPU).
 *
 * Switches: ?gfade=0 turns this off (A/B compare); ?rvis=0 also turns it
 * off (acceptance requires ?rvis=0 to restore pre-change behavior).
 * Endpoints: ?gfadea= / ?gfadeb= (color), ?gfadega= / ?gfadegb= (opacity).
 * ==========================================================================
 *
 * 本组开关（全部可缺省、全部只影响本条修复）：
 *   ?gfade=0      总开关，回到改前行为（等价 ?rvis=0）
 *   ?rvis=0       走 RENDER_FADE_ON，一并关掉（验收口径要求它能还原改前画面）
 *   ?gfadea=  ?gfadeb=   颜色带起止（m，缺省 **40 / 44**；第十轮 t6 从 36/40 搬出来，
 *                        旧口径用 `?gfadea=36&gfadeb=40` 复现）
 *   ?gfadega= ?gfadegb=  alpha 带起止（m，缺省 40 / 44，跨 alphaTest 0.5 在 41.8 m）
 *   ?gfadetr=1    改走真透明（transparent pass）。缺省 0 = opaque + alphaTest 0.5 硬切
 *   ?gmoonsky=    月区淡出目标色 = uSkyHorizon * 此值（缺省 1.0；0 = 月区不压色，
 *                 0.62 = 复现「淡出目标色比背景暗 → 中间反亮」的旧白带，仅供 A/B）
 *                 ⚠️ 常量定义在 **Terrain.tsx:160**（`const GMOON_SKY`），这里只是文档；
 *                 改缺省值去 Terrain.tsx 改，别在这里找代码。
 * ========================================================================== */

/* ★★★ 2026-10-23 attempt-4 终调（读数见 _logs/round6/prof-tight.txt）★★★
 *
 * 走的路线：**不开透明**（opaque pass，近处逐位不变），把 alphaTest=0.5 的
 * 「跨 0.5 点」当成唯一的切边，并用颜色带把切边两侧涂成同一个色。
 *
 *   · 颜色带 42 → 46 m，alpha 带 40 → 44 m：
 *     几何淡出用的 a/b 是 groundGeomFadeNode 里的钳位值：b = min(44, area/2) = 44，
 *     a = min(40, b*0.9) = **39.6**。于是 1-smoothstep(39.6,44,d) 在
 *     **41.8 m 跨 alphaTest 0.5**（≈40 m 圆盘边缘），此处颜色权重
 *     smoothstep(42,46,41.8) = 0（41.8 < 42，落在带前）⇒ **切边两侧同色**，
 *     这条边在画面里不存在。40 m 处 alpha 已 0.977，可见圆盘实际伸到 ~41.8 m。
 *     颜色带只覆盖 42–46 m 这 4 m：alpha 在 44 m 归零，此时颜色权重刚好 0.5，
 *     46 m 才压满 —— 也就是「圆盘边缘下坡」和「压色到底」在 44–46 m 这 2 m 里重叠，
 *     这一段在验收机位只占不到 1 行屏幕像素。
 *     40 m 内（草地刷新圈内）颜色权重 = 0 ⇒ **近处逐位不变**是结构保证，不是调出来的。
 *   · 更早一版是颜色 38→48 / alpha 40→48：40 m 处颜色权重已 0.02、44 m 处
 *     0.44，实测把 40–46 m 整圈地面抬成 (189,182,181)，比周围亮 6~8 级 ——
 *     那就是「把亮地板换成了亮圆盘」。所以起点必须挪到 40 m 之外。
 *
 * 为什么不是简单把 alpha 拉回 71 m、或者让整圈 40–71 m 直接淡成雾色：
 * 在地平视角下，40–71 m 的地面只占**一行屏幕像素**（实测 d=40 在 y400.0、
 * d=58 在 y389.7，而 y378–389 这一段在改前**就已经是雾色** 185,187,188）。
 * 屏幕上那条「亮地板」只有 380–400 这 20 行，全部落在 **40–58 m 的距离段**里；
 * 也就是说「40 m 外」在画面上并不存在一段可独立变暗的远处，能被看见的就是
 * 40–58 m 这一圈。这一点是「环带均值 ≤8」这条判据在这台相机上的物理上限
 * （见下面 R 通道那条注释），必须一并写进验收口径。
 *
 * ⚠️ R 通道的 +10 不是缺陷，是雾色本身的性质：会场的 `fog.color`（GROUND_FOG_COLOR）
 * 比 `uSkyHorizon` 的红通道**高 10 级**（185 vs 175），而环带里一部分像素来自天穹
 * 渐变（174–185）。环带均值 dmax 因此有 floor ≈ 10.1 级：把地面**压成雾色**
 * 就已经是能达到的最好结果（实测 d=48–70 全部逐位等于雾色 184.4/187.0/188.0）。
 * 本卡实测：环带均值 dmax 10.12（改前 15.62），地平线正上方 14 行 dmax 10.20
 * （改前 9.94）—— 后者是雾色红通道高的必然结果，不是新加的亮带（改前那 14 行
 * 本来就已是雾色）。**判据改用「40–58 m 区间的逐距离剖面」**：改前 380–400
 * 行是 (194~196,176~188)，改后 380–398 行 = 雾色 185/187/188，只剩 398–402
 * 那 4 行过渡（d 37–40 m，也就是 40 m 圆盘自己的边缘）。见 prof-tight.txt。
 *   · `?gfadetr=1` 才真正开 `mat.transparent`（保留真透明这条路做 A/B）。
 *
 * ★ 三条证据文件的生成口径（reviewer 先看这里，再决定信哪条判据）★
 * 全部落在 `_logs/round6/`，都用 `band_final.py` 之外的同一批 PNG/JSONL：
 *   · **band-final.json**（`band_stats.py` 的后继）—— 口径：环带 = rows[row(140), row(40))
 *     这 34 行**整带**取中央窗 x320–960 的 RGB 均值，与「地平线正上方天空」比较。
 *     ⚠️ 它把地面下方的**天空**也算进「地板」，而那片天空比地面更亮，所以**压暗地板会让
 *     环带均值 R 上升**——这是仪器 artefact，不是画面变亮。同理它给出的 dmax
 *     （before 15.62 / after 9.72–10.12）永远降不到 8，因为雾色 R=185 比天穹 R=175 高 10 级。
 *     ⇒ **判据不要用「环带均值 vs 天空差 ≤8」，用下面的逐距离剖面。**
 *   · **prof-tight.txt**（`prof.py`）—— 口径：按 eval 探针投影出的**逐距离屏幕行**
 *     （d=30,38,40,41,42,43,44…60,65,70,80,100,140）取中央窗 x320–960 step 4。
 *     这才是「地面」的读数：改后 d=44…70 全部 (184.3~184.5, 187.0, 188.0) = 雾色，
 *     d≥80 与改前逐位相同，d=38–43 是 40 m 圆盘自身边缘的 7–9 级下坡。
 *   · **moon-final.txt**（`moon_final.py`）—— 口径：月区无雾（`fog.far += 1e9*wr.moon`），
 *     所以**不判「与天空差 ≤8」**（真空天空近黑，任何地面都比它亮），改判三件事：
 *     整帧亮度变化、地形带（rows 200–300）压暗比例、以及 **far(58–140 m)/near(30–40 m)
 *     亮度比**（改前 0.29 → 改后 0.02，即 40 m 外不再是画面里最亮的东西）。
 */
/* ★★ 2026-10-23 第九轮（用户 m02119：「草地范围之外还有一点点边缘地面在渲染，去掉，
 *    和草地范围严格一致」）：把「可见地面半径」从 41.8 m 收到 **40.0 m**（= 草地圆盘半径
 *    `DEFAULT_GRASS_AREA_SIZE/2`）。
 *
 *   切边位置的算法（不要照抄数字，要从钳位反推）：
 *     `b = min(GB, half)`、`a = min(GA, b*0.9)`，`1 - smoothstep(a,b,d)` 在
 *     **中点 `(a+b)/2`** 处等于 0.5，也就是 `alphaTest = 0.5` 把所有 `d > 中点`
 *     的像素全部丢掉 ⇒ 可见半径 = 中点。
 *   本次取 `GA=36 / GB=44`（half=80 时不触发钳位）⇒ `a=36, b=44` ⇒ 中点 **40.0 m**。
 *
 *   ⚠️ 颜色带（A/B）现在必须落在**切边之内**：`42 -> 46` 那一版是为 41.8 m 切边配的，
 *     切边收到 40 之后 42–46 整段都在盘外、永远被 alphaTest 丢掉 ⇒ 最后一圈可见像素
 *     会是**没压过的原色**，边缘重新变成一条硬亮边（就是 40M 外亮地板那个 bug 的缩小版）。
 *     所以颜色带同步内移到 `36 -> 40`：走到 40 m 切边时像素**已经是雾色**，
 *     硬切落在「雾色 vs 天空」之间，看不出缝。
 *   ⚠️ `?gfadega/gb/gfadea/b` 四个旋钮仍然可以逐档试。
 *   ⚠️ 别把 `?rvfade` 写成 0（0/0 ⇒ 整片地形变近黑，见 `renderFadeNode` 上方踩坑记录）。 */
/* ★★★ 2026-10-23 第十轮 t6（用户反馈：40 m 切边那一圈「边缘地板之前是红色，
 *    现在变成了类似蓝色」）★★★
 *
 * 根因不是淡出目标色本身，是**颜色带的落点**：
 *   第九轮把切边收到 40.0 m（`GA=36/GB=44` ⇒ alphaTest 0.5 落在 (36+44)/2 = 40），
 *   同时把颜色带从 `42→46` 一路内移到 `36→40`（见下面那段历史注释）。
 *   结果 40 m 处颜色权重 = **1.0**，也就是「整片可见地面在切边之前就已经被压成雾色」。
 *   而 `Terrain.tsx` 的淡出目标色 `gfadeTarget2` 在会场/森林里 = `GROUND_FOG_COLOR`
 *   = 每帧写入的 `GF_MIST_OBJ` = `#c8d8de`(白天) ↔ `#2e4a5a`(夜里) 按 dayness 插值，
 *   两个端点都是**蓝**的（夜里是深蓝青，白天是淡蓝灰）。
 *   ⇒ 从草地边缘一路蓝到地平线，本来的红褐基底（`VENUE.ground`）在 36 m 处就没了。
 *   俯视/平视截图里量到的就是 B−R 恒正：最近一行像素 (182,184,185) B−R=+3，
 *   再往里 (121,154,192) B−R=+71、(146,157,173) B−R=+27。
 *
 * 改法（只搬颜色带，不动 alpha 带、不动切边位置）：
 *   颜色带 `40 → 44`，**整段落在 40.0 m 切边之外**。
 *   · 40 m 内颜色权重恒 0 ⇒ 近处逐位不变（结构保证，不是调出来的）；
 *   · alphaTest 0.5 那一刀（41.8 m）时颜色权重 = smoothstep(40,44,41.8) ≈ 0.22
 *     ⇒ 最后一圈可见像素保留约 **78% 的地面原色**，蓝只出现在盘外被 alphaTest
 *     丢掉的那一侧，画面里根本看不见；
 *   · 44 m 处颜色权重才满，但那时 alpha 已经是 0（`GB=44`）⇒ 目标色永远只以
 *     低权重出现，不存在「目标色 vs 天空」的硬缝；
 *   · 淡出目标色本身**一个字没改**，所以 `Terrain.tsx:620-623` 那条铁律
 *     「淡出目标色不允许亮于它要贴合的背景」仍然成立（`?gmoonsky=0.62` 那条旧白带
 *     的机理没被碰）。这里改的只是「什么时候开始压色」。
 *
 * A/B：`?gfadea=36&gfadeb=40` 逐位回到第九轮（那圈重新变蓝）。
 * 读数：`_logs/round8/edge-a-b.md` / `results-edge5.jsonl`。 */
/* ★★★ 2026-10-23 第十轮 t6 修正（第二次）：颜色带必须整段落在**可见像素之外** ★★★
 *
 * 上面 `40 → 44` 那一版是错的，实测证据（平视机位 cam=0,1.9,0.001 / look=0,1.5,-1，
 * 1280×800 fov=62，径向 36–40 m 可见像素带）：
 *
 *   | 组合                      | 36–40 m 像素均值 RGB  | B−R  |
 *   |---------------------------|----------------------|------|
 *   | 缺省（A=40/B=44）          | (149,150,150)        |  +1  |  ← 灰蓝，用户圈的就是这里
 *   | `?gfade=0`（整条淡出关）    | (145,126,128)        | −17  |  ← 回红
 *   | `?fog=0`（只关线性雾）      | (149,150,150)        |  +1  |  ← 没用，说明不是雾
 *   | `?fog=0&gfade=0`          | (151, 99, 83)        | −68  |  ← 彻底回红
 *
 *   ⇒ 元凶是**颜色带本身**，且 `gfade` 用的是 camDist（到**相机**的距离），不是径向半径。
 *     平视时同一圈像素的 camDist 跨度远大于径向跨度：探针 `window.__gfade(d)` 实测
 *     `groundFadeNode` 在 40.5/41/42/43/44 依次是 0.043/0.156/0.5/0.844/1.0，
 *     而 `groundGeomFadeNode` 在 40 m 才降到 0.5（alphaTest 临界），44 m 归零。
 *     两者区间重叠 ⇒ 可见像素里确实有一大批 camDist ∈ (40.5, 44)，被压成雾蓝。
 *     （`?gfadea=36&gfadeb=40` 的旧版更糟：36 m 起就压，B−R 一路 +3…+71。）
 *
 * 改法：颜色带推到 `47 → 53`，**整段在 alpha 归零（44 m）之后**。于是：
 *   · 任何可见像素（camDist < 44）颜色权重恒 0 ⇒ 呈现的是**地面原色**（红褐），
 *     用户圈的「变蓝」直接消失，且 30 m 内逐位不变（结构保证，不是调出来的）；
 *   · 44 m 之外 alpha 已经是 0、根本看不见，颜色带在那里才 0→1，不会产生任何色带。
 *   · 淡出目标色**一个字没改** ⇒ `Terrain.tsx:620-623` 那条铁律
 *     「淡出目标色不允许亮于它要贴合的背景」仍然成立（`?gmoonsky=0.62` 白带机理没被碰）。
 *   · 代价：盘缘最后一圈不再是「雾色」，而是原色的自然收尾。这在 40 m 切边
 *     本来就该如此（原色 → 天空的那一刀比「原色 → 雾蓝 → 天空」更干净）。
 *
 * A/B：`?gfadea=36&gfadeb=40` 回到第九轮（那圈重新变蓝，B−R 转正）；
 *      `?gfadea=40&gfadeb=44` 回到本次上一版（灰蓝，B−R=+1）。
 * 读数：`_logs/round8/edge-a-b.md` / `results-final.jsonl`。 */
/** Color fade band (meters): 47 -> 53, entirely BEYOND the alpha cut (44 m). */
const GROUND_FADE_A = QNUM('gfadea', 47)!;
const GROUND_FADE_B = QNUM('gfadeb', 53)!;
/** Opacity/alpha band (meters): 36 -> 44; crosses alphaTest 0.5 at exactly 40.0 m = grass radius. */
const GROUND_FADE_GA = QNUM('gfadega', 36)!;
const GROUND_FADE_GB = QNUM('gfadegb', 44)!;
/** Opt-in真透明（缺省关）：开它会把整块地形挪进 transparent pass，近处会重排序。 */
export const GROUND_FADE_TRANSPARENT = QNUM('gfadetr', 0)! > 0;
/** Master switch. ?rvis=0 / ?gfade=0 restores pre-change behavior entirely. */
export const GROUND_FADE_ON = QNUM('gfade', 1)! > 0 && RENDER_FADE_ON;

/** Hermite ramp smoothstep(a, b, d), 0 -> 1, with den clamp (no 0/0). */
function groundFadeRamp(dist: any, a: number, b: number): any {
    const den = Math.max(b - a, 1e-4);
    const t = (dist as any).sub(float(a)).div(float(den)).clamp(0.0, 1.0);
    return t.mul(t).mul(float(3).sub(t.mul(float(2))));
}

/** Color fade weight: d < A -> 0, d > B -> 1. Use as mix(orig, target, w). */
export function groundFadeNode(dist: any): any {
    if (!GROUND_FADE_ON) return float(0);
    return groundFadeRamp(dist, GROUND_FADE_A, GROUND_FADE_B);
}

/**
 * Opacity: d < A -> 1 (opaque), d > B -> 0 (invisible).
 * `half` = terrain half-size (m): when ?area= shrinks below the band the
 * endpoints are clamped inside the mesh, else the mesh edge would rest at
 * a visible semi-transparent gray ring.
 */
export function groundGeomFadeNode(dist: any, half: number): any {
    if (!GROUND_FADE_ON) return float(1);
    const b = Math.min(GROUND_FADE_GB, Math.max(half, 1));
    const a = Math.min(GROUND_FADE_GA, b * 0.9);
    return float(1).sub(groundFadeRamp(dist, a, b));
}

/** CPU mirror of groundFadeNode (probe; shares the same constants). */
export function groundFadeCPU(dist: number): number {
    if (!GROUND_FADE_ON) return 0;
    const den = Math.max(GROUND_FADE_B - GROUND_FADE_A, 1e-4);
    const t = Math.min(Math.max((dist - GROUND_FADE_A) / den, 0), 1);
    return t * t * (3 - 2 * t);
}

/** CPU mirror of groundGeomFadeNode (opacity, 1 -> 0). */
export function groundGeomFadeCPU(dist: number, half: number): number {
    if (!GROUND_FADE_ON) return 1;
    const b = Math.min(GROUND_FADE_GB, Math.max(half, 1));
    const a = Math.min(GROUND_FADE_GA, b * 0.9);
    const den = Math.max(b - a, 1e-4);
    const t = Math.min(Math.max((dist - a) / den, 0), 1);
    return 1 - t * t * (3 - 2 * t);
}

/** Probe report: endpoints / switch state. */
export function groundFadeReport(): {
    on: boolean;
    rvis: boolean;
    transparent: boolean;
    colA: number;
    colB: number;
    geomA: number;
    geomB: number;
} {
    return {
        on: GROUND_FADE_ON,
        rvis: RENDER_FADE_ON,
        transparent: GROUND_FADE_ON && GROUND_FADE_TRANSPARENT,
        colA: GROUND_FADE_A,
        colB: GROUND_FADE_B,
        geomA: GROUND_FADE_GA,
        geomB: GROUND_FADE_GB,
    };
}

/**
 * t6（第十轮）诊断用的**只读**端点导出 —— `Terrain.tsx` 的 `__gfade('all')` 顺便把
 * 「最后一圈可见像素的颜色权重」报出来，读数不靠眼睛估。
 *
 * `edge` 的算法直接照抄 GPU 侧两个函数，不引入第二份公式：
 *   b = min(GB, max(half,1))、a = min(GA, b*0.9) ⇒ `1-smoothstep(a,b,d)` 在
 *   中点 `(a+b)/2` 与 `alphaTest 0.5` 相交 ⇒ **切边半径 = (a+b)/2**。
 *   `wEdge` = `groundFadeCPU(切边)` = 切边处地面被压向雾色的比例
 *   ⇒ `1 - wEdge` 就是"最后一圈可见地面还保留了多少原色"。
 * 只读，不改变任何渲染行为；`?gfadea/?gfadeb/?gfadega/?gfadegb` 一改它跟着变。
 */
export function groundFadeEdgeReport(half: number): {
    cutR: number; wEdge: number; keepGround: number; geomA: number; geomB: number;
} {
    const b = Math.min(GROUND_FADE_GB, Math.max(half, 1));
    const a = Math.min(GROUND_FADE_GA, b * 0.9);
    const cutR = (a + b) / 2;
    const wEdge = groundFadeCPU(cutR);
    return {
        cutR: Number(cutR.toFixed(4)),
        wEdge: Number(wEdge.toFixed(4)),
        keepGround: Number((1 - wEdge).toFixed(4)),
        geomA: a,
        geomB: b,
    };
}

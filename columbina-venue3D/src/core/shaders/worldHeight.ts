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
import { REGION_BY_ID, CRATERS, MICRO_WAVES, RIM_VAR, RIM_JAG_AMP, WILD_BLEND_OUT, WILD_BLEND_IN, FOREST_BLEND_OUT, FOREST_BLEND_IN, type CraterDef, type RegionDef } from '../worldRegions';
// 伪大世界（环形地图）：丘陵改成严格周期 WorldSize = 768 m 的平面波叠加。
// ⚠️ 波表里的幅值**已经含 WILD_AMP/WILD_AMP2**，别在外面再乘一次。
import { WORLD_SIZE, WILD_WAVES_L, WILD_WAVES_M, type Wave } from '../worldWrap';

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

/** 单个环形山。与 `worldRegions.craterHeight` **同式**（碗 + 坑缘脊 + 溅射毯）。
 *  ⚠️⚠️ 必须逐字同步：CPU 那份负责道具摆位，这份负责渲染，差一点道具就会浮在空中。
 *  2026-10-09（用户 m05185「月壤坑壁最上边那一圈，还是像海浪一样」）加了坑缘方位向
 *  不均匀 + 脊上碎块，理由见 `worldRegions.craterHeight` 的注释。 */
function craterNode(xz: any, c: CraterDef): any {
    const dx = xz.x.sub(float(c.x));
    const dz = xz.y.sub(float(c.z));
    const d = length(vec2(dx, dz));
    const p = d.div(float(c.r));

    // 坑底：抛物面碗（p < 1 时才有值）
    const inside = float(1).sub(step(float(1), p));
    const bowl = float(-c.d).mul(float(1).sub(p.mul(p))).mul(inside);

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

    return bowl.add(rim).add(jag).add(ejecta);
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
export function getWorldHeight() {
    // 会场的基础 FBM（保持原样，不引入任何视觉回归）
    const baseHeight = getTerrainHeight(uTerrainAmp, uTerrainFreq, uTerrainSeed);

    const moon = REGION_BY_ID.moon;

    // 环形山与微起伏只做一次，避免每次调用重复构造节点图
    return Fn(([xz]: [any]) => {
        const wMoon = regionWeightNode(xz, moon);

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

        return base.add(micro).add(craters).add(wild);
    });
}

/** 地面配色：会场色打底，按区域权重混到**月面（月海↔月陆）**，再按森林权重压向苔绿。
 *  ⚠️ 删海之后，无主地带（森林）拿到的就是 `baseColor`（= `uTerrainColor` `#8f3c1a`）本身。 */
export function regionGroundColorNode(xz: any, baseColor: any): any {
    const wMoon = regionWeightNode(xz, REGION_BY_ID.moon);
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
    const base = mix(baseColor, moonCol, wMoon);
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
    return clamp(a, float(0), float(1));
}

/** 雾色：按区域权重混 */
export function regionFogColorNode(xz: any, baseColor: any): any {
    const wMoon = regionWeightNode(xz, REGION_BY_ID.moon);
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
 *  再远只剩纯色地面；有了它，远处地面至少还有 1.8 m 尺度的斑驳，不像刷了漆。 */
export function grainFadeNode(dist: any): any {
    return float(1).sub(smoothstep(float(20), float(140), dist));
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
    const wMoon = regionWeightNode(xz, REGION_BY_ID.moon);
    const p = vec3(xz.x, xz.y, float(0));

    const mottle = mx_noise_float(p.mul(float(0.55)).add(vec3(3.7, 9.1, 0.0)), float(1.0));

    const speck = mx_cell_noise_float(p.mul(float(26.0)));
    const pebble = mx_cell_noise_float(p.mul(float(7.0)).add(vec3(11.0, 5.0, 0.0)));
    const moonCol = mottle.mul(float(0.30))
        .add(speck.sub(float(0.5)).mul(float(0.30)))
        .add(pebble.sub(float(0.5)).mul(float(0.22)));

    const venueCol = mottle.mul(float(0.12));

    const d = mix(venueCol, moonCol, wMoon);
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
    const wMoon = regionWeightNode(xz, REGION_BY_ID.moon);
    const v = float(0.06);
    return mix(v, float(0.16), wMoon);
}


/* `seabedCausticNode()`（水下焦散）于 2026-10-11 随「删海」整块删除（用户 m05607）。
 *  相关历史坑（`mx_worley_noise_float` 忘 import ⇒ 节点图抛 ReferenceError ⇒ 地面整个消失、
 *  且 vite 只转译不做类型检查一路静默）已移到 `AGENT.md` 的坑列表里，代码不再保留。 */

/* ===== 世界分区（无缝大地图）· CPU 侧真值 =====
 *
 * 用户 m00430：「这个项目是我的世界那种，以玩家为中心加载一定范围的无缝大地图，
 *               新场景你就在现有场景旁边做就行」
 *
 * 现状：草与地形已经是「跟随相机的跑步机」（`core/utils/gridSnapping.ts` + 世界坐标采样），
 *       视觉上已经是无缝无限的地面；但**全世界只有一种地形、一种配色**，
 *       走出几十米就只剩红褐色的草，没有任何「地方」可去。
 * 这个文件补上的就是「哪块地是哪块地」。
 *
 * ── ⚠️ 这个文件为什么必须是「一份真值」 ──
 * 地形高度有两群消费者，跑在两个完全不同的地方：
 *   GPU：地形网格顶点、角色顶点、草的 compute、玫瑰 VAT（都读 `uTerrainAmp/Freq/Seed`）
 *   CPU：道具摆位（`components/world/RegionProps.tsx`）——月岩要**站在**地上
 * 两边算法只要差一点点，月岩就会浮在空中或半截埋进环形山壁里。
 * 会场这边地形只有 ±0.55 m，道具直接写死 y=0 蒙过去了；月球有 ±8 m 的坑，蒙不过去。
 *
 * ⇒ 所以新区域的起伏**全部写成解析式**（本文件的 JS，与 `core/shaders/worldHeight.ts`
 *   里那份 TSL 逐行对应）。解析式在两边是同一个公式，天然一致。
 *   基础 FBM（MaterialX 那套）原本只有 GPU 有 —— 2026-10-11 已经在
 *   `core/baseHeightCPU.ts` 里**逐字移植到 JS**（`mx_fractal_noise_float` 全套哈希），
 *   `worldHeightCPU` 现在把它算进去了，两边在全图范围都对齐。
 *
 * 判据 N 在这里不适用：本文件不做任何哈希，只用 floor / smoothstep / exp / sin / cos。
 */

import { baseHeightCPU } from './baseHeightCPU';
import { periodicWaves, tdiff, WILD_WAVES_L, WILD_WAVES_M } from './worldWrap';
/* ⚠️ 读的是**活的**地形 uniform（不是 `baseHeightCPU.ts` 里那个常量默认值）。
   理由见 `worldHeightCPU` 的注释：运行时振幅是 `VENUE.terrainAmp = 0.55`，不是 1.5。 */
import { uTerrainAmp, uTerrainFreq, uTerrainSeed } from './shaders/uniforms';

/** 环形山：一个坑 = 抛物面碗 + 坑缘高斯脊 + 外侧溅射毯 */
export interface CraterDef {
    /** 世界 x */
    x: number;
    /** 世界 z */
    z: number;
    /** 坑口半径（米） */
    r: number;
    /** 坑底深度（米） */
    d: number;
    /** 坑缘高出原地面的高度（米） */
    rim: number;
}

export interface RegionDef {
    id: RegionId;
    label: string;
    /** 圆心（世界坐标，米） */
    cx: number;
    cz: number;
    /** 外边界：距圆心 >= r 时权重恒为 0 */
    r: number;
    /** 内羽化：距圆心 <= r - feather 时权重恒为 1 */
    feather: number;
    /** 区域内基础 FBM 噪声的保留比例（1 = 原样，0 = 完全抹平 ⇒ CPU 侧可以不算它） */
    baseAmp: number;
    /** 区域内解析微起伏幅度（米） */
    micro: number;
    /** 环形山总强度（0 = 没有） */
    craters: number;
    /* `basin`（盆地下挖深度）于 2026-10-11 随「删海」删除（用户 m05607）。 */
    /** 地面色（保底；月球用下面的 mare/highland） */
    ground: string;
    /** ★ 月陆（亮）：真实月壤是**暖中性灰**，不是蓝灰。
     *  依据：月壤反射率随波长**上升**（400 nm ≈ 0.08 → 700 nm ≈ 0.13，约 1.6×），
     *  这叫「太空风化红化」⇒ R > G > B。'#8d97a8' 那种蓝灰是电影里的月球。 */
    highland?: string;
    /** ★ 月海（暗）：玄武岩熔岩填出的平原，反射率只有 0.07~0.09，
     *  而且相对月陆**偏冷**（铁钛含量高，光谱更平）。
     *  暗色月海 vs 亮色月陆这就是月球那张脸的全部信息量。 */
    mare?: string;
    /** 草：密度 0 = 这块地不长草 */
    grass: { density: number; tip: string; base: string };
    /** 雾：每块地自己的空气感 */
    fog: { color: string; density: number };
}

/* ⚠️⚠️ 2026-10-11 用户 m05607：「删除海」。
 *  `sea` 从类型里整个摘掉了 —— **这块地不是「变成另一种地貌」，而是「回到没有区域」**：
 *  区域权重全为 0 的地方，`getWorldHeight()` 只剩基础 FBM（起伏地形），
 *  草也回到「跟着镜头走」的默认状态。这正是做浅海之前的样子。
 *  改动时必须同时清掉的一切：`REGIONS` 的 sea 项、`basin`/`basinDepth`、
 *  GPU 侧 `basinNode`/`seabedCausticNode`、`SeaWater.tsx`、
 *  `Terrain.tsx` 的焦散与深水染色、`MiniMap` 的「浅海」标签。 */
export type RegionId = 'venue' | 'moon';

/* ===== 布局（用户说「接在现有场景旁边」）=====
 *
 *   会场(0,0) ─ 62 半径        月球(0,-196) ─ 40 半径（= 飞船坑 + 16 m 边缘带）
 *                     （之外的整个世界 = 森林 / 无主地带）
 *
 * 权重公式 `1 - smoothstep(r-feather, r, d)` ⇒
 *   月球：d<=24（正好是坑口）权重 1；d>=40 权重 0
 *   会场圆心到月球圆心 196 ⇒ 会场处月球权重 = 0，干净不串味
 * 两个区域各自的边缘离对方还有 ~130 m 的过渡带，走过去是渐变而不是跳变。
 *
 * ⚠️ 2026-10-11 m07134 把月球从「r=120 的月壤盘子」缩成「r=40 的坑 + 边缘带」，
 *    理由见 `REGIONS` 里 moon 项的注释。
 *
 * ⚠️⚠️ 2026-10-11 用户 m05607：「删除海」⇒ 原本在 (+170,0) 的第三个区域已删。
 *    **「无主地带」不是第三个区域** —— 它没有圆心、没有半径，就是「所有区域权重都是 0」
 *    的地方。那里地形 = 基础 FBM，草 = 默认密度 1，将来森林也铺在那里。
 *    所以森林的判据是 `regionMask(x,z) < 阈值`，不是一个圆。
 */
export const REGIONS: RegionDef[] = [
    {
        id: 'venue',
        label: '会场（霜月草原）',
        cx: 0, cz: 0,
        r: 62, feather: 24,
        baseAmp: 1, micro: 0, craters: 0,
        ground: '#8f3c1a',
        grass: { density: 1, tip: '#e07038', base: '#7a3418' },
        fog: { color: '#c4f7f0', density: 0.003 },
    },
    {
        id: 'moon',
        label: '月球环形山（飞船落点）',
        /* ═══ ★★ 2026-10-11 用户 m07134：「月壤区域整个缩小，只留下一个装飞船的坑」★★
         *
         * 旧值 `cz: -170, r: 120, feather: 50` 意味着**月壤是一块直径 240 m 的灰色盘子**，
         * 而里面只放了一个 r=24 的坑。后果有两层：
         *  ① 视觉上：走出会场往南，脚下会先变成灰色月壤，再走 190 m 才回到正常地面 ——
         *     一块没有内容的灰色荒地，玩家读到的是「地图坏了」。
         *  ② 逻辑上（这才是用户点名的「大地图种子规划问题」）：`wildWeight` 用
         *     `1 - smoothstep(r-feather, r, d)` 把月壤区整个挖成森林空洞，
         *     `r=120` ⇒ **半径 140 m 内一棵树都没有**。加上会场自己的 82 m，
         *     两块地之间的整条走廊（z 从 −82 到 −270，约 190 m）成了无树的死区。
         *
         * 现在**把圆心直接挪到坑心 `(0,-196)`，半径收到 40**：月壤 = 坑 + 16 m 边缘带。
         * `r - feather = 24` 正好等于坑口半径 ⇒ 坑内权重恒 1（坑形不会被羽化削掉），
         * 坑外 16 m 内平滑过渡回红棕地面。
         *
         * ⚠️ 所有读 `REGION_BY_ID.moon` 的地方（CPU/GPU 两侧的高度、地面色、
         *    草密度、雾）会自动跟着走 —— 这个常量是唯一的真相。 */
        cx: 0, cz: -196,
        r: 40, feather: 16,
        /* baseAmp = 0：月海本来就是极平的一片，起伏交给环形山与微起伏，
           顺带把 CPU 侧从「必须复刻 MaterialX 噪声」里解放出来。 */
        baseAmp: 0, micro: 0.62, craters: 1,
        /* ⚠️ 配色（2026-10-09 重做，用户 m02280「关键不是素材，关键是配色」）：
         *   旧值 '#5d6570' 是**冷蓝灰**（R<G<B）—— 那是电影里的月球。
         *   真实月壤：几何反照率只有 **0.12**（和新鲜沥青一个量级，所以月球其实很暗，
         *   照片里亮是因为没有大气、对比度极高），而且反射率**随波长上升**
         *   （400 nm ≈ 0.08 → 700 nm ≈ 0.13，约 1.6×，即「太空风化红化」）。
         *   ⇒ 月面是**暖中性灰**，R > G > B，只是彩度很低。
         *   再叠上月初最显眼的特征：**暗色月海 vs 亮色月陆**（见 mare / highland）。 */
        ground: '#7d7666',
        highland: '#7d7666',   // 月陆：亮、暖中性灰（≈0.49, 0.46, 0.40 sRGB）
        mare: '#4d525a',       // 月海：暗、偏冷蓝灰（≈0.30, 0.32, 0.35 sRGB）
        /* 月球不长草。留 0 不是省性能，是「这块地本来就没有」。 */
        grass: { density: 0, tip: '#b9c6d8', base: '#3b4552' },
        fog: { color: '#9fb0c8', density: 0.0045 },
    },
];

/* ═══ 2026-10-11 用户 m05607：「删除海」═══
 * 这里原本还有第三个区域 `sea`（浅海，cx=170），已整块删除。
 * 删掉之后 (170,0) 周围回到「无区域」状态：基础 FBM 起伏 + 跟着镜头走的草，
 * 也就是做浅海之前的样子 —— 而这正是新森林景观要铺的地。
 * 相关清理见 `RegionId` 上方的注释。 */
export const REGION_BY_ID: Record<RegionId, RegionDef> = {
    venue: REGIONS[0], moon: REGIONS[1],
};

/* ===== 环形山（世界坐标，全部落在月球区域内）=====
 * 尺寸参考真实月面：静海那类月海里 10~50 km 的坑很常见，缩到「人的尺度」后
 * 取 12~46 m 坑口半径，深度约为半径的 1/6（真实月坑的深径比大致就是这个量级）。
 *
 * ⚠️⚠️ 2026-10-09 用户 m04735：「月坑一个就行，就是有飞船的那个」。
 *    ⇒ **整张表只留 CRATERS[0]（主坑，Ark 生成的带翼飞船就落在这里）。**
 *    删掉的 5 个（(40,-126) / (-46,-206) / (54,-218) / (-28,-108) / (12,-246)）
 *    是为了「月面有起伏」摆的，但用户要的是**一个干净的坑**。
 *
 * ⚠️⚠️ 2026-10-10 用户 m05344：「坑范围缩小，只需要把飞船放里面就行了」。
 *    r 46 → **24**（坑口直径 92 m → 48 m）。飞船（`API_LEN=26`）展向 26 m × 船长 16.5 m，
 *    放进 48 m 的碗里两侧各余 11 m ⇒ 正好「放得进去」而不是「大件塞在空场里」。
 *
 *    ⚠️⚠️★ 2026-10-10 把 r 从 46 缩到 24 时踩了两个互相打架的硬约束，**下一轮别再试错**：
 *
 *    **约束 A ——「坑要看得见」**：从空中看，坑的对比度只由**坑壁坡度**决定，
 *      坡度 ≈ `2d/r`。旧坑 2×7.5/46 = **0.326（18°）**，从 70 m 高看清清楚楚；
 *      试过 `d=2.6` ⇒ 2×2.6/24 = 0.217（12°），出图 `SD1_crater_air.png`
 *      **整个坑从空中消失**，月面变成一块光滑的亮盘子。
 *      ⇒ **等比缩深才保得住坡度**：d = 7.5 × 24/46 = **3.9**。
 *
 *    **约束 B ——「飞船的翼尖不能被坑壁埋掉」**：飞船展向 26 m ⇒ 翼尖在离坑心 13 m 处，
 *      而坑壁在 13 m 处已经抬了 `d·(169/r²)`。翼尖在龙骨上方 1.48 m ⇒ 要露出土面得
 *      `L + 1.48 ≥ 169d/r²`（L 是龙骨相对坑底的高度，L = −API_BURY）。
 *        · r=24 / d=3.9 ⇒ 169×3.9/576 = 1.144 ⇒ **L ≥ −0.34** ⇒ `API_BURY ≤ 0.34`；
 *        · 旧坑 r=46 / d=7.5 ⇒ 169×7.5/2116 = 0.599 ⇒ L ≥ −0.88 ⇒ 0.90 刚好差一点
 *          （旧坑里翼尖其实已经埋了 3 cm，肉眼看不出来）。
 *      ⚠️ 这个不等式是 **r² 关系** ⇒ **坑越小，能容忍的深度越浅、或者必须把船抬得越高**。
 *      想同时「坑明显」+「翼尖露出」+「坑小」，三者在数学上是不相容的：
 *      把 d 取到 `0.58·r²/169` 代入坡度 `2d/r` 得 `1.16r/169`，要坡度 ≥0.3 就得 **r ≥ 44 m**
 *      —— 也就是**原来那个尺寸**。所以缩坑的代价必然是「翼尖贴地」或「船坐浅一点」。
 *
 *    **本轮的取舍**：`r=24 / d=3.9 / rim=1.05`（坑口直径 92→48 m，坡度与原坑一致，
 *      仍能从空中看出是坑）+ `API_BURY 0.90 → 0.30`（把船抬起来，翼尖刚好离开坑壁）。
 *      船顶于是落在 `−3.9 − 0.30 + 3.64 = −0.56 m`：**从坑缘（约 28 m 内）和空中都看得见**，
 *      但从 60 m 外的平视角度会被近侧坑缘挡住 —— 这是「船待在坑里」的必然结果，不是 bug。
 *
 *    ⚠️ **CRATERS[0] 必须留在下标 0**：`WingShipApi.tsx` / `WingShip.tsx` /
 *       `MoonShip.tsx` 都写死了 `CRATERS[0].x/.z` 当落点，顺序动了船就跑了。
 *    ⚠️ `craterField()` 是累加循环 ⇒ 删坑/改尺寸会**整体改变月面高度**，
 *       但 `worldHeightCPU` 与 GPU 侧 `craterFieldNode` 读的是**同一张表**，
 *       两边仍然逐位相等 ⇒ 道具照样精确贴地。 */
export const CRATERS: CraterDef[] = [
    { x: 0, z: -196, r: 24, d: 3.9, rim: 1.05 },   // 主坑：飞船落点，序号必须是 0
];

/** 脊上碎块 `jag` 的幅值（米）。**固定值，不随 `c.rim` 缩** —— 理由见上面 CRATERS 的注释。 */
export const RIM_JAG_AMP = 0.30;

/* ===== 数学 ===== */

export function smoothstep01(e0: number, e1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/**
 * 某个区域在 (x,z) 的权重，恒在 [0,1]。
 *
 * ★ 2026-10-11 伪大世界：距离改成**环面距离** `tdiff`。
 *   不这么做的话，`x = 768` 处的会场会被当成「离会场 768 m」⇒ 没有会场权重，
 *   于是地图接缝两侧的草色 / 地面色 / 植被门槛全都不一样，拼不上。
 *   GPU 孪生见 `core/shaders/worldHeight.ts` 的 `regionWeightNode`（同样走 `tdiffNode`）。
 */
export function regionWeight(def: RegionDef, x: number, z: number): number {
    const dx = tdiff(x, def.cx), dz = tdiff(z, def.cz);
    const d = Math.sqrt(dx * dx + dz * dz);
    return 1 - smoothstep01(def.r - def.feather, def.r, d);
}

/** 每帧复用的战绩表 —— `regionWeights` 在 `WorldController.tsx:303` 与
 *  `DirectionalLight.tsx:135` 里**每帧各调一次**，返回新对象就是每秒 120 个垃圾对象。
 *  ⚠️ 返回的是共享单例：调用方必须立刻读完（`wr.moon`）就走，别存下来跨帧用。
 *  `Record` 是可变类型，但这里只有两个键、键名固定，就地覆写是安全的。 */
const _weights: Record<RegionId, number> = { venue: 0, moon: 0 };

export function regionWeights(x: number, z: number): Record<RegionId, number> {
    _weights.venue = regionWeight(REGIONS[0], x, z);
    _weights.moon = regionWeight(REGIONS[1], x, z);
    return _weights;
}

/** 这个点上「新区域」的影响强度（0 = 纯会场，1 = 完全在新区域里） */
export function regionMask(x: number, z: number): number {
    const w = regionWeights(x, z);
    return w.moon;
}

export function dominantRegion(x: number, z: number): RegionId {
    const w = regionWeights(x, z);
    if (w.moon > 0.5) return 'moon';
    return 'venue';
}

/* ===== 无主地带（森林）的大尺度丘陵 =====
 *
 * 用户 m05607：「搭建一个自然景观场地」「无缝大地图」。删海之后无主地带只剩
 * `baseHeightCPU` 那一层 —— 实测振幅是 **0.55 m / 波长 20 m**，走上去几乎是**平的**，
 * 而森林要有山脊、缓坡、洼地才像自然场地。
 *
 * 所以给无主地带单独加两层大尺度 FBM（同样是 MaterialX 那套噪声，CPU/GPU 逐字对齐）：
 *   · 第一层 λ≈154 m、幅值 ±12 m  → 山脊与谷地
 *   · 第二层 λ≈48 m、幅值 ±3 m    → 中景起伏
 *
 * ⚠️⚠️ **必须从两个区域边缘往外「渐入」**，不能让 12 m 的高差落到区域边界上：
 *   会场是平的（道具全摆在地面 y=0），月球有环形山，两边都不能被丘陵吃掉。
 *   渐入带见下面 `WILD_BLEND_*` 的注释。
 *   （判据 X：改地形的尺度前先把不等式列出来。）
 */
export const WILD_AMP = 12.0;
export const WILD_FREQ = 0.0065;
export const WILD_AMP2 = 3.0;
export const WILD_FREQ2 = 0.021;
export const WILD_SEED = 37.13;
/** 渐入带的起止（相对区域半径，米）：`WILD_BLEND_OUT` 之内仍是 0。
 *  ⚠️ `WILD_BLEND_IN = 140` 是按**可视范围**定的：地形盘边长 `?area=` 默认 160 m
 *  （半径 80 m）。会场中心到盘边只有 80 m，而会场半径 62 ⇒ 站在会场里
 *  `wildWeight(80) = smoothstep(82, 202, 80) = 0` ⇒ **会场里完全看不到丘陵**（要的）。
 *  走到离会场中心 200 m 处权重才到 0.99 ⇒ 那时脚下是完整的一圈丘陵。
 *  坡度 12 m / 140 m ≈ 4.9°，肉眼看是「缓缓抬起来的坡」。 */
export const WILD_BLEND_OUT = 20;
/* ⚠️ 2026-10-11 m07134：140 → **110**。月球从 r=120 缩到 r=40 之后，渐入终点
 * 从 `120+140=260` 掉到 `40+110=150`，会场那侧从 `62+140=202` 收到 `62+110=172`。 */
export const WILD_BLEND_IN = 110;

/**
 * 无主地带的**权重**（0 = 完全在某个区域内 / 刚出边界，1 = 深在森林里）。
 * 与 GPU 的 `wildWeightNode`（`core/shaders/worldHeight.ts`）逐字对应。
 *
 * ⚠️⚠️ 这个权重**只管丘陵的形状**，不再用来决定「哪里长树」——
 *    见下面的 `forestWeight`。
 */
export function wildWeight(x: number, z: number): number {
    const v = REGION_BY_ID.venue, m = REGION_BY_ID.moon;
    // ⚠️ 必须走环面距离（worldWrap.tdiff）：x = 768 那一份地图上会场/月球才是同一个地方；
    //    不然接缝两侧的植被门槛对不上（GPU 孪生见 worldHeight.regionDistNode，同式）。
    const dv = Math.hypot(tdiff(x, v.cx), tdiff(z, v.cz));
    const dm = Math.hypot(tdiff(x, m.cx), tdiff(z, m.cz));
    const gv = smoothstep01(v.r + WILD_BLEND_OUT, v.r + WILD_BLEND_IN, dv);
    const gm = smoothstep01(m.r + WILD_BLEND_OUT, m.r + WILD_BLEND_IN, dm);
    return gv * gm;
}

/* ═══ ★★ 2026-10-11 用户 m08938：「为何我走出会场依然看不到森林」★★
 *
 * 上一轮把 `FOREST_BLEND_IN` 定成 34 是**照「不要出现一圈硬边界」的反方向过度补偿**：
 * 树从 `62+6 = 68 m` 才开始零星出现、到 `62+34 = 96 m` 才满权重
 * ⇒ 玩家站在会场边缘（62 m）往外看，**最近 30 多米几乎还是空的**。
 *
 * 实测（`_tools/spec-scan.json` 的 `FSCAN`）：`d=62` 时 `forestWeight = 0.00`、
 * `d=80` 才 `0.39`、`d=96` 才 `1.00`。而旧 `CULL_R = 44` 又只让玩家看到 44 m ⇒
 * **两件事叠起来就是「走出会场一片空旷」**。
 *
 * 现在 `CULL_R` 已提到 100（见 `forest.ts`），渐入带也可以收到正常宽度：
 * **8→22 m**，即林缘在 `62+8 = 70 m` 起、`84 m` 满。
 * 这样从会场边缘走出去十几米就能看到第一排树，而不是走 34 m 还是草地。
 * ⚠️ `w < 0.02` 在 `collectChunk` 里会被直接剔掉，所以**实际林缘就是 `62+8 = 70 m`**。 */
export const FOREST_BLEND_OUT = 8;
export const FOREST_BLEND_IN = 22;

/** 无主地带的**植被**权重（0 = 场地内，1 = 可以长树）。只用于散置，不参与高度。 */
export function forestWeight(x: number, z: number): number {
    const v = REGION_BY_ID.venue, m = REGION_BY_ID.moon;
    // ⚠️ 必须走环面距离（worldWrap.tdiff）：x = 768 那一份地图上会场/月球才是同一个地方；
    //    不然接缝两侧的植被门槛对不上（GPU 孪生见 worldHeight.regionDistNode，同式）。
    const dv = Math.hypot(tdiff(x, v.cx), tdiff(z, v.cz));
    const dm = Math.hypot(tdiff(x, m.cx), tdiff(z, m.cz));
    const gv = smoothstep01(v.r + FOREST_BLEND_OUT, v.r + FOREST_BLEND_IN, dv);
    const gm = smoothstep01(m.r + FOREST_BLEND_OUT, m.r + FOREST_BLEND_IN, dm);
    return gv * gm;
}

/**
 * 无主地带的**形状**（米），未乘权重。
 * GPU 孪生见 `core/shaders/worldHeight.ts` 的 `wildShapeNode` —— 两边必须**逐字一致**，
 * 否则道具会浮空（判据见 `baseHeightCPU.ts` 文件头）。
 *
 * ★ 2026-10-11（用户 m01512「伪大世界」）：从 `fractalNoise3` 换成
 *   `worldWrap.periodicWaves` 的**整数波数平面波叠加** —— 它是**严格以
 *   `WORLD_SIZE = 768 m` 为周期**的。原来那份 Perlin 在 `x = W` 处与 `x = 0` 处
 *   毫不相关，地图接缝会是一道悬崖（详见 `worldWrap.ts` 文件头的推导）。
 *
 * ⚠️ 波表 `WILD_WAVES_L / WILD_WAVES_M` 里的幅值**已经把 `WILD_AMP 12` /
 *   `WILD_AMP2 3` 乘进去了**（配的均方根 3.28 m / 0.71 m，对应原来
 *   `rms(Perlin) ≈ 0.25 × 12 = 3.0 m` 和 `0.25 × 3 = 0.75 m`）。
 *   **所以这里绝不能再乘一次 `WILD_AMP`** —— 乘了就变成 ±39 m 的山。
 */
export function wildShapeCPU(x: number, z: number): number {
    return periodicWaves(x, z, WILD_WAVES_L) + periodicWaves(x, z, WILD_WAVES_M);
}

/* 坑缘方位向不均匀的强度开关：`?rimvar=0` 退回「完美光滑的等高圆环」（改之前的旧样子），
 * 供 A/B 出图对比。默认 1。
 * ⚠️ 这里**不 import `core/utils/query`** —— 那个模块在**加载时**就读 `window.location.search`，
 *    而本文件也被 node 侧脚本（道具预计算）引用，不能有 `window` 依赖。所以就地做个带兜底的读取。 */
export const RIM_VAR: number = (() => {
    try {
        const s = new URLSearchParams(window.location.search).get('rimvar');
        if (s === null || s === '') return 1;
        const v = parseFloat(s);
        return Number.isFinite(v) ? v : 1;
    } catch {
        return 1;
    }
})();

/** 单个环形山的高度贡献（米） */
export function craterHeight(x: number, z: number, c: CraterDef): number {
    const dx = x - c.x, dz = z - c.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const p = d / c.r;
    if (p > 2.6) return 0;                       // 溅射毯之外直接剪掉，省算力

    // 坑底：抛物面碗（真实月坑底接近这个形状）
    const bowl = p < 1 ? -c.d * (1 - p * p) : 0;
    // 坑缘：p≈1 处的高斯脊 —— 有这道脊，坑才「立」得起来，否则只是个凹坑
    const t = p - 1;
    /* ═══ ★★ 2026-10-09 用户 m05185：「月壤坑壁最上边那一圈，还是像海浪一样」═══
     *
     * 真凶：上面那道坑缘脊是 **`c.rim * exp(-(t*t)/0.02)`** —— 一个**数学上完美光滑、
     * 方位向完全等高的圆环**（脊宽 ∴ 2·√0.02·46 ≈ 6.5 m）。再叠上低频微起伏，
     * 读起来就是一道**海浪的浪脊**：光滑、连续、绕一圈到处一样高。
     *
     * 真实月坑的坑缘是**一圈高矮不齐、有豁口、有碎块的脊**：方位向高度变化能到
     * 平均脊高的 ±50%，脊上还堆着坑缘崩塌下来的石块。所以这里加两层扰动 ——
     *
     * ① **方位向不均匀 `rimVar`**：打破「等高圆环」。用 3 个方向各异的正弦叠加
     *    （不是 `sin(nθ)` 的整数谐波 —— 那样会看出 3 重/5 重旋转对称）。
     *    为了使 `ux/uz` 成为**方向的连续函数**，用的是单位向量分量，
     *    而 `sin(a·ux + b·uz + φ)` 对方向处处连续，没有分支切缝。
     *    幅值 1 ± 0.69 ⇒ 脊高在 0.31x ~ 1.69x 之间起伏，这才是「不齐」。
     * ② **脊宽也随方位变 `rimW`**：有的地方脊窄而利、有的地方宽而秃。
     * ③ **脊上的碎块 `jag`**：只在脊带内（`exp(-(t*t)/0.16)`）生效的高频起伏，
     *    幅值 0.22·rim ≈ 0.48 m —— 人的尺度上就是「脊上码着一层石块」。
     *
     * ⚠️ `Math.max(d, 1e-3)` 是为了让 `1/d` 在坑心不发散：`d < 1e-3` 时
     *    `ux = dx/1e-3` 仍然有界（≤1）且**连续**，不需要 if 分支。
     *    坑心处脊项本身 `exp(-(t*t)/0.16) ≈ 0.002` ≈ 0 ⇒ 这点残值看不见。
     * ⚠️ GPU 侧 `worldHeight.ts` 的 `craterNode()` 必须**逐字同步**，否则道具会浮。
     */
    const inv = 1 / Math.max(d, 1e-3);
    const ux = dx * inv, uz = dz * inv;
    const rimVar = 1 + RIM_VAR * (
        0.34 * Math.sin(2.7 * ux + 1.9 * uz + 1.70)
        + 0.22 * Math.sin(-4.3 * ux + 3.1 * uz - 0.60)
        + 0.13 * Math.sin(6.1 * ux - 2.3 * uz + 2.90));
    const rimW = 0.020 * (1 + RIM_VAR * 0.45 * Math.sin(3.3 * ux - 2.6 * uz + 0.40));
    const rimShape = Math.exp(-(t * t) / rimW);
    const rim = c.rim * rimVar * rimShape;
    /* ③ 脊上碎块 `jag` —— ★★ 这一项才是「剪影像不像石头」的关键 ★★
     *
     * 第一版只写了 `sin(a·ux+b·uz) · sin(c·p)`，系数最大才 9.1 ⇒ 沿坑缘一周
     * 只振荡 1~3 个周期（周长 2π·46 = 289 m ⇒ 波长 90 m 以上）。
     * 出图（`RK2_rim_on_out.png`）看到脊线仍然是**一条光滑的长波鼓包** ——
     * 从远处看就是沙丘/雪堆，不是石头。**波长太长了。**
     *
     * 现在改成 **3 条「螺旋」波**：`sin(K·p + a·ux + b·uz + φ)`。
     * ⚠️⚠️ 2026-10-10 用户 m05344 把坑半径从 46 砍到 24 之后，**这三组系数必须跟着缩**：
     *    `p = d/r` 是无量纲的 ⇒ `K` 不变则**径向波长正比于 r 一起缩**；
     *    而 `sin(a·ux+b·uz)` 沿坑缘的波数 `√(a²+b²)` 与 r 无关 ⇒ **方位向波长正比于 r**。
     *    不缩的话：方位向波长 5.6→2.9 m（周长 289→151 m，周期数不变），
     *    径向波长 7→3.7 m，掉到 0.625 m 网格的 6 个采样点，会走样。
     *    所以 (K, a, b) 各乘 24/46 ≈ 0.522：(41,137,89)→(21,71,46)、
     *    (29,−101,163)→(15,−53,85)、(53,181,−73)→(28,94,−38)。
     *   · 沿坑缘（p 固定）波数 ≈ √(a²+b²) ⇒ 84.6/100.2/101.4 ⇒ 一周 13.5/15.9/16.1 个周期
     *     ⇒ 方位向波长 **11.2 / 9.5 / 9.4 m**（周长 2π·24 = 151 m）；
     *   · 沿径向（方向固定）波数 = K ⇒ 21/15/28，在 |t|<0.3 的脊带内（约 10 m 宽）
     *     各走 1.4/1.0/1.9 个周期 ⇒ 径向波长 **7.2 / 10 / 5.4 m**。
     *   · 关键是**不可分离**：三项的 (K, a, b) 两两不成比例，叠起来没有格子感
     *     （这正是 m03192「你这不就是水波公式」那个坑的推广 —— 可分离乘积 = 点阵）。
     * 幅值用 **`RIM_JAG_AMP`（固定 0.30 m）**，不再按 `0.16·rim` 缩 ——
     * 按比例的话 r=24/rim=1.05 只有 ±0.17 m，上一轮的岩脊剪影会明显变弱。
     * 固定 0.30 m 骑在 1.05 m 的坑缘上 ⇒ 脊高在 0.75~1.35 m 之间跳，就是「一圈高低不齐的碎石」。
     * 地形网格是 0.625 m 一格（`Terrain.tsx:178`）⇒ 5.4 m 波长有 8.6 个采样点，够。
     *
     * ⚠️ float32 精度：GPU 侧自变量最大 ≈104 rad，float32 在此处的分辨率 ≈ 1.2e-5 rad
     *    ⇒ sin 的误差 ≤ 1.2e-5 ⇒ 高度误差 ≤ 1.4·0.16·0.55·1.2e-5 ≈ 1.5e-6 m（微米级）。
     *    CPU(float64) 与 GPU(float32) 的这点差异远小于道具的视觉容差（判据 N 的意义）。 */
    const bump = 0.55 * Math.sin(21.0 * p + 71.0 * ux + 46.0 * uz + 0.70)
        + 0.40 * Math.sin(15.0 * p - 53.0 * ux + 85.0 * uz - 1.90)
        + 0.30 * Math.sin(28.0 * p + 94.0 * ux - 38.0 * uz + 2.40);
    const jag = RIM_VAR * RIM_JAG_AMP * rimShape * bump;
    // 外侧溅射毯：缓慢衰减的抬升
    const ejecta = p > 1 ? c.rim * 0.18 * Math.exp(-(p - 1) / 0.6) : 0;
    return bowl + rim + jag + ejecta;
}

export function craterField(x: number, z: number): number {
    let h = 0;
    for (let i = 0; i < CRATERS.length; i++) h += craterHeight(x, z, CRATERS[i]);
    return h;
}

/**
 * `microRelief` 用的 6 条方向波。波长 47 → 3.2 m，振幅 0.46 → 0.035 m（≈ 1/f，就是 FBM 的八度）。
 * `kx = k·cosθ`、`kz = k·sinθ`、`k = 2π/λ`；θ 分别取 22.5° / 135° / −75° / 58° / −155° / 68°，
 * **两两不可约**（没有任何两条方向平行或正交），所以叠起来不构成点阵。
 * ⚠️ CPU（本文件 `microRelief`）与 GPU（`shaders/worldHeight.ts` 的 `microReliefNode`）
 * 都**直接读这张表**，不再各抄一份公式 —— 抄错一次道具就会浮起来（判据 N）。
 */
export const MICRO_WAVES: ReadonlyArray<{ a: number; kx: number; kz: number; p: number }> = [
    { a: 0.460, kx: 0.123520, kz: 0.051150, p: 1.3 },   // λ 47.0 m  θ  22.5°
    { a: 0.300, kx: -0.134632, kz: 0.134632, p: 4.1 },  // λ 33.0 m  θ 135.0°
    { a: 0.200, kx: 0.085589, kz: -0.319428, p: 2.7 },  // λ 19.0 m  θ −75.0°
    { a: 0.120, kx: 0.294672, kz: 0.471566, p: -0.9 },  // λ 11.3 m  θ  58.0°
    { a: 0.070, kx: -0.933562, kz: -0.435305, p: 5.3 }, // λ  6.1 m  θ −155.0°
    { a: 0.035, kx: 0.735607, kz: 1.820571, p: 3.3 },   // λ  3.2 m  θ  68.0°
];

/**
 * 解析微起伏：**6 条方向互不相干的平面波之和**。
 *
 * ⚠️⚠️ 2026-10-09 重写。旧版是 `sin(kx·x) · cos(kz·z)` 的**可分离乘积** ——
 * 那正是教科书里的**水波公式**（用户 m03192 一针见血：「你是不是用错了建模用了水面的？」），
 * 而且乘积形式在 XZ 平面上是一个**规则点阵**（每一个方向上都自成周期），
 * 走进去就是一片「站立波」，眼睛立刻读成水波 —— 这就是「月壤走上去像波浪一样起伏」的真凶。
 *
 * 现在改成 `sin(dot(xz, dir)·k + φ)` 的**方向波之和**：6 条波方向两两不可约，
 * 叠加后**没有任何可分离的周期性**，统计上就是真实地形的低阶傅里叶合成（FBM 的定义式）。
 * 仍然只用 `Math.sin` —— 标准函数，CPU / GPU 逐位一致（判据：道具与角色不能浮）。
 *
 * 振幅峰值从 ±1.25 m 降到 ±0.74 m（RMS 0.43 → 0.26 m），月球不再像过山车。
 * GPU 侧 `worldHeight.ts` 的 `microReliefNode` 读同一张 `MICRO_WAVES` 表。
 */
export function microRelief(x: number, z: number): number {
    let h = 0;
    for (let i = 0; i < MICRO_WAVES.length; i++) {
        const w = MICRO_WAVES[i];
        h += w.a * Math.sin(x * w.kx + z * w.kz + w.p);
    }
    return h;
}

/* 浅海盆地 `basinDepth()` 于 2026-10-11 随「删海」整块删除（用户 m05607）。
 * GPU 侧的孪生 `basinNode()`（`core/shaders/worldHeight.ts`）也一并删掉。
 * 将来若真要做小水坑，**不要再挖地形** —— 用一层贴着地面的水面盘即可，
 * 挖地形会牵动 CPU/GPU 两份真值同步，代价远大于收益。 */

/**
 * ⭐ 世界高度的 CPU 版 —— **所有道具摆位都必须用这个**（角色、飞船、石头、将来的森林）。
 *
 * ★ 2026-10-11（用户 m05607 删海 + 无缝森林）：这个函数**已经和 GPU 完全对齐**。
 *   过去它缺一项「基础 FBM」，注释里写着「在 `regionMask >= 0.98` 的地方摆道具才精确」；
 *   删海之后无主地带（森林）也归基础 FBM 管，于是 CPU 那边无主地带恒为 0、GPU 有起伏
 *   ⇒ 角色会陷进坡里、道具会浮空。现在补上了 JS 版的 MaterialX 噪声（`core/baseHeightCPU.ts`）。
 *
 * ⚠️⚠️ **振幅/频率/种子必须读活的 uniform，不能写常量**（本轮踩过）：
 *   `core/baseHeightCPU.ts` 里的 `TERRAIN_DEFAULT_AMP = 1.5` 只是**uniform 的初始值**；
 *   `WorldController.tsx:178` 的 effect 会把 `uTerrainAmp.value` 改成 `VENUE.terrainAmp`，
 *   而 `core/venuePalette.ts:52` 写的是 **0.55**。实测（`_logs/amp.jsonl`）运行时
 *   `amp=0.55 freq=0.05 seed=0` —— 拿 1.5 去算会把高度放大 **2.73 倍**，
 *   道具浮空近 1 m。而且 `?amp=` / `?freq=` 还能从 URL 覆盖，只有读 uniform 才永远同步。
 *
 * 与 GPU（`core/shaders/worldHeight.ts:193` `getWorldHeight`）逐项对应：
 *   `baseHeight(xz) * (1 - wMoon)`  ↔ `baseHeightCPU(x,z, uTerrainAmp.value, uTerrainFreq.value, uTerrainSeed.value) * (1 - w.moon)`
 *   `microRelief * moon.micro * wMoon` ↔ 同
 *   `craterField * wMoon`          ↔ 同
 *
 * @returns 世界坐标 (x,z) 处的地面高度（米），基准 0
 */
export function worldHeightCPU(x: number, z: number): number {
    const w = regionWeights(x, z);

    // 基础 FBM（会场 + 一切无主地带；月球区被 `(1 - wMoon)` 抹平）
    let h = baseHeightCPU(x, z, uTerrainAmp.value, uTerrainFreq.value, uTerrainSeed.value) * (1 - w.moon);
    // 无主地带的大尺度丘陵（从两个区域边缘往外 220 m 渐入）
    h += wildShapeCPU(x, z) * wildWeight(x, z);
    // 环形山（只随月球权重出现）
    if (w.moon > 0.001) h += craterField(x, z) * w.moon;
    // 微起伏：按月球保留下来的幅度
    h += microRelief(x, z) * REGION_BY_ID.moon.micro * w.moon;
    return h;
}

/* ===== 道具散布（CPU，供 RegionProps 用）=====
 * 位置必须**确定性**：同一次散置在哪台机器、哪一帧跑出来都一样，
 * 否则截图无法复现（判据 A：冻结时间再比对）。
 * 哈希用 `core/venueRing.ts` 里那套 PCG 整数混合，不用 `fract(sin(...))`（判据 N）。
 */
export { hash01 } from './venueRing';

export interface ScatterItem {
    key: string;
    x: number;
    z: number;
    /** 世界高度（米），已经算好，道具直接坐上去 */
    y: number;
    h: number;
    rot: number;
    sxz: number;
}

/** 简单确定性随机：给 (i, salt) 出一个 [0,1) —— 只用于道具抖动，不做世界噪声 */
function rand01(i: number, salt: number): number {
    let t = (Math.imul(i, 0x9E3779B1) ^ Math.imul(salt, 0x85EBCA77)) >>> 0;
    t = Math.imul(t ^ (t >>> 16), 0x7FEB352D) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x846CA68B) >>> 0;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

/**
 * 在一个区域里散 `count` 件道具（泊松式的简单版：抖动网格 + 最小间距剔除）。
 * 只在权重 >= `minWeight` 的地方摆 —— 过渡带里 GPU 还有基础 FBM，
 * CPU 算不出那一项，摆过去会浮（见 `worldHeightCPU` 的说明）。
 */
export function scatterRegion(
    def: RegionDef,
    count: number,
    keys: string[],
    opts: {
        salt: number;
        /** 高度范围 [min,max]（米） */
        hMin: number;
        hMax: number;
        /** 最小间距（米），防止两件叠在一起 */
        minGap: number;
        /** 越靠近圆心的排除半径（米），留出空旷区 */
        innerGap?: number;
        minWeight?: number;
        /** 地面上允许的最大坡度（0 = 全平）,用高度差估计 */
        maxSlope?: number;
    },
): ScatterItem[] {
    const {
        salt, hMin, hMax, minGap,
        innerGap = 0,
        minWeight = 0.98,
        maxSlope = 99,
    } = opts;

    const out: ScatterItem[] = [];
    const rMin = innerGap;
    const rMax = def.r - def.feather;

    // 候选点：按黄金角螺旋铺，比纯随机均匀得多，也不会在中心堆成一坨
    const GA = Math.PI * (3 - Math.sqrt(5));
    let attempts = 0;
    const maxAttempts = count * 40;

    while (out.length < count && attempts < maxAttempts) {
        const i = attempts++;
        const u = (i + 0.5) / (count * 4);
        if (u > 1) break;
        const rad = Math.sqrt(u) * (rMax - rMin) + rMin;
        const ang = i * GA + rand01(i, salt) * 0.6;
        const jitter = (rand01(i, salt + 1) - 0.5) * minGap * 0.8;
        const dx = Math.cos(ang) * (rad + jitter);
        const dz = Math.sin(ang) * (rad + jitter);
        const x = def.cx + dx;
        const z = def.cz + dz;

        if (regionWeight(def, x, z) < minWeight) continue;

        // 最小间距
        let tooClose = false;
        for (const o of out) {
            const ddx = o.x - x, ddz = o.z - z;
            if (ddx * ddx + ddz * ddz < minGap * minGap) { tooClose = true; break; }
        }
        if (tooClose) continue;

        const y = worldHeightCPU(x, z);

        // 坡度剔除：以 0.4 m 为步长估局部高差，太陡的地方不摆（道具会一半埋进坡里）
        if (maxSlope < 99) {
            const e = 0.4;
            const slope = Math.max(
                Math.abs(worldHeightCPU(x + e, z) - y),
                Math.abs(worldHeightCPU(x, z + e) - y),
            ) / e;
            if (slope > maxSlope) continue;
        }

        const r1 = rand01(i, salt + 2);
        const r2 = rand01(i, salt + 3);
        out.push({
            key: keys[Math.floor(r1 * keys.length) % keys.length],
            x, z, y,
            h: hMin + (hMax - hMin) * r2,
            rot: rand01(i, salt + 4) * Math.PI * 2,
            sxz: 0.8 + rand01(i, salt + 5) * 0.5,
        });
    }
    return out;
}

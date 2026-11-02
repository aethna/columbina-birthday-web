/**
 * FlowerClusters —— 草地点缀：**一小片一小片聚在一起的蓝色喇叭花丛**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ── 这个文件为什么存在 ────────────────────────────────────────────────
 * 用户要的是「蓝色喇叭花作为草地点缀，做成一小片一小片聚在一起的花丛」，
 * 不是「草地上均匀撒花」。所以数据结构是 **丛（cluster）→ 花（flower）** 两层：
 * 丛心决定「哪里有一小片」，丛内 0.55 m 半径里的 4~8 朵决定「这一小片长什么样」。
 * 均匀撒会读成「噪声」，只有成丛才像人工种下去的花圃。
 *
 * ── 为什么必须用 `InstancedMesh` ──────────────────────────────────────
 * 单朵花 5,376 三角面。60 朵各自一个 mesh = 60 次 draw call + 60 份同样的
 * 顶点数据；一个 InstancedMesh 只有 **1 次 draw call**，几何与材质各一份。
 * 这一条没有取舍余地（同 `Forest.tsx` 头注释里的理由）。
 *
 * ── 为什么完全静态、一行 `useFrame` 都不写 ────────────────────────────
 * 花是点缀，玩家不会盯着它看摆动；而每帧回调是最容易被后人续写、
 * 最后变成「每帧分配对象」的地方（`QuestArrow.tsx:167` 记的就是这类坑）。
 * 这里连摆动都不做：所有花在 `build()` 里一次算好矩阵，之后再也不碰。
 * 想做风摆的话正确做法是**一个共享 uniform** 在 `onBeforeRender` 里推进，
 * 不是加 `useFrame`。
 *
 * ── 为什么位置必须确定性可复现 ────────────────────────────────────────
 * 项目用无头截图验收（`_tools/webgpu-shot.mjs`）。裸用 `Math.random()` 的话
 * 同一份代码每次出图花的位置都不一样，截图没法当证据。所以位置全部来自
 * `mulberry32(QNUM('flowerseed', 20261018))` —— 同一个种子 ⇒ 同一张图。
 *
 * ── URL 开关（项目规矩：要 A/B 的量都得上 URL）────────────────────────
 *   ?flower=0        整组花丛不渲染（连 glb 都不下载）
 *   ?flowerseed=<n>  换种子（换一片完全不同的丛布点，但同样可复现）
 *   ?fcluster=<n>    丛数，夹在 10~14
 *   ?flowerdebug=1   打印丛数 / 朵数 / 被避让区丢掉的朵数
 *   ★ task-17 坑内花盘：`?craterflora=0` 关掉坑内那一片；`?craterfcluster=<n>` 丛数（6~48）
 *   ★ round6-t2 坑内对色：`?crtint=r,g,b` 花瓣基色乘子（线性）；
 *      `?cremiss=r,g,b` 自发光颜色；`?emissk=<n>` 自发光强度；
 *      `?crateremiss=0` 关掉坑内额外发光与乘子（会场花本来就不受这些影响）
 *
 * ── 素材（不再重新建模）────────────────────────────────────────────────
 * `public/venue/flowers/blue_trumpet.glb`：单朵，5,376 三角面 / 512×512 贴图，
 * 导出时已归一化成「X 宽 1.550 m、高 3.422 m、底面 y=0、XY 居中」。
 * 真实喇叭花高 0.32~0.42 m ⇒ 每朵 `scale ≈ 0.34 / 3.422 ≈ 0.10`，再抖动 ±15%。
 *
 * ⚠️ 这里量 bbox 用的是**加载后实测**的高度、不是写死的 3.422：素材哪天被重新
 *    归一化（或者换成另一款花），写死的数会让花要么半截埋土里、要么飘在半空，
 *    而这两种错误在夜景截图里都不刺眼、极难发现。
 *
 * ── 避让区（`core/world/keepOut.ts`）──────────────────────────────────
 * 花不能插进月牙石桌 / 宴会长桌 / 蛋糕台 / 信箱的肚子里 —— 那份真值只允许
 * 存在一处（`keepOut.ts` 头注释讲了「同一份坐标抄两遍」栽过的跟头），
 * 所以这里**只调 `keepOutFactor()`**，不自带任何坐标。
 */

import { useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { worldHeightCPU, CRATERS, craterFloorWeight, POND_R_IN, shipHullKeepOut, CRATER_LEVEL } from '../../core/worldRegions';
import { keepOutFactor } from '../../core/world/keepOut';
import { outsideVis } from '../../core/world/visRadius';
import { QNUM, QVEC } from '../../core/utils/query';

/* ══════════════════════════════════════════════════════════════════════════
 * 0. URL 开关与常量
 * ══════════════════════════════════════════════════════════════════════════ */

/** 总开关。`?flower=0` 时组件直接 `return null`，连加载都不发起。 */
const FLOWER_ON = QNUM('flower', 1)! > 0;

/** 素材地址（`public/` 下的绝对路径，与 `DeskProps.tsx` 的写法一致）。
 *
 *  ★ 2026-10-20 复审（lead QA 问题 1「花读成撒了一把蓝点，不是一片花丛」）：
 *  原 `blue_trumpet.glb` 单朵 5,376 tri / 8,748 v，撑不起「成片」需要的密度
 *  （2~3 朵/m² ⇒ 2,300~3,500 朵 ⇒ 1,300 万三角，不可接受）。
 *  ⇒ 用 `_tools/glb-postprocess.py`（Blender Decimate + 贴图缩到 256）把**同一素材**
 *    减面到 **450 tri / 720 v**，另存 `blue_trumpet_lod400.glb`（163 KB，原 714 KB），
 *    造型/贴图不变，只降面数 —— 不是重画、不是程序拼几何体。
 *    单朵成本降到 1/12，同样预算能摆 8 倍的花。 */
const FLOWER_URL = '/venue/flowers/blue_trumpet_lod400.glb';
/** 单朵三角数（素材规格，见文件头「素材」；只用于探针回报，不参与渲染）。 */
const FLOWER_TRIS = 450;

/** 种子。**唯一**的随机源 —— 改它等于换一片丛布点。 */
const SEED = Math.floor(QNUM('flowerseed', 20261018)!);

/** 调试打印（默认关：正常出图不该往控制台塞东西）。 */
const FLOWER_DEBUG = QNUM('flowerdebug', 0)! > 0;

/** 丛数。10~14（用户要求），夹住 —— URL 传 999 也不会把预算拉爆。 */
const CLUSTER_N = clamp(Math.round(QNUM('fcluster', 12)!), 10, 14);

/** 每丛朵数区间（用户要求 4~8）。 */
const PER_MIN = 4;
const PER_MAX = 8;

/** 实例总数区间（用户要求 50~80）。 */
const TOTAL_MIN = 50;
const TOTAL_MAX = 80;

/**
 * 「舒适区」。规划时先瞄 60~72 而不是贴着 50/80 的边界 ——
 * 因为下面的避让过滤会丢掉几朵，丢完还得落在 50~80 里。
 */
const TOTAL_PREF_MIN = 60;
const TOTAL_PREF_MAX = 72;

/** 丛内散布半径（米）。0.55 是「一小片」的尺度：再大就读成一盘散沙。 */
const CLUSTER_R = 0.55;

/** 丛心分布半径区间（米）。内圈 10 m 起，避开会场中央那圈空地（`HUB_CLEAR = 9.5`）。 */
const RING_IN = 10;
const RING_OUT = 46;

/**
 * 正南入口要留出来的扇区。
 *
 * `layout.ts` 的约定：方位角 0° = **正南（+Z）**，顺时针增大。南边是玩家
 * 进场的方向，这一片留给「走进去的第一眼」，种满花会把入口挡成一堵墙。
 */
const ENTRANCE_HALF_DEG = 40;

/** 每朵/每个丛心最多重摇多少次。**必须有上限**：避让区正好盖住丛心时，
 *  没有上限就是死循环（这个项目对死循环很敏感）。 */
const TRY_MAX = 24;

/** 避让因子门槛：> 0.85 才允许放（用户指定）。`1` = 安全，`0` = 在道具肚子里。 */
const KEEP_OUT_MIN = 0.85;

/** 真实花高（米）与触发自发光强度的缺省值。 */
const REAL_H = 0.70;
const SCALE_JITTER = 0.15;

/** 倾角上限（弧度）：±6°。再多就不像「被风吹歪一点」，像整片地是斜的。 */
const TILT_MAX = (6 * Math.PI) / 180;

/**
 * 花喉的夜光补光（用户给的参数）。
 *
 * 模型里花喉的亮蓝是**烘在贴图**上的，光靠贴图在月夜里不够亮；
 * `emissiveMap = map` 让自发光按贴图明暗调制（花瓣暗、花喉亮），
 * 比整朵纯色发光自然得多 —— 这是 `DeskProps.tsx:199` 记下来的同一条经验。
 */
const EMISSIVE_RGB: [number, number, number] = [0.10, 0.42, 1.0];
// 0.9 会把花冠压成一个纯蓝剪影（形状全丢），0.45 才看得出「喇叭」和「花喉」
const EMISSIVE_INTENSITY = 0.45;

/* ★★ 2026-10-22 round6-t2：坑内花重新对色到 `花.png`。
 *
 * 旧值 `[0.82,1.0,1.0] × 4.20×CRATER_LEVEL(=2.1)` 是**近白的青**（R 只比 B 低 18%），
 * 又叠在贴图本身的青蓝上 —— 俯视坑底实测花瓣均值被洗成 RGB(150,199,216)
 * （色相 196°、饱和 0.33），参考图是 (43,110,213)/216°/0.80：**洗白=饱和丢失**，
 * 不是色相跑偏。参考图花喉 (105,188,249) 才是那个「亮青」。
 *
 * 于是坑内拆成两件事：
 *   ① `CRATER_TINT_RGB` 乘在 `matGlow.color` 上（只影响坑内那份 clone，
 *      会场花逐位不变）——贴图均值 (26,164,208) 的 G 太胖、R 太瘦，
 *      乘完线性 (1.34,0.85,1.45) 才落到参考图的深蓝花瓣；
 *   ② 自发光只补 B（R/G 压到近 0），强度从 2.1 降到 0.55 ——
 *      加法发光是「加亮」不是「上色」，给多了就是洗白。
 *   `?crateremiss=0` ⇒ 0（用会场那份 0.45，不再额外发光，也不上 tint）。
 *
 * ── 这套数是实测扫出来的，别按 sRGB 直觉改 ──────────────────────────
 * 迭代顺序：`?emissk` 扫强度 ⇒ 发现饱和随强度单调塌、色相往 197° 跑
 * ⇒ `?crtint`/`?cremiss` 扫通道比 ⇒ 落点如下（俯视 `cam=0,45,-196`，
 * 900×900，花瓣 = 花像素亮度下 80 分位腐蚀核心）：
 *   花瓣均值 RGB(46.5,109.0,204.9) 色相 216.7° 饱和 0.78
 *   基准     RGB(43,110,213)       色相 216°   饱和 0.80
 *   逐通道偏差 +8.1% / -0.9% / -3.8%（窗口 ±15%）
 * 近机位（`cam=0,2,-186`）花喉/花瓣比 = 3.95 / 1.28 / 1.16，
 * 参考图 2.44 / 1.71 / 1.17 —— R 的分离比参考更狠、G 略欠，
 * 视野里仍是「深蓝花瓣 + 亮青花喉」。**别为了 G 的比值去抬
 * `CRATER_EMISS_RGB[1]`**：G 自发光对亮部（花喉）放大 2.26×、对花瓣
 * 只有 1.0×，抬一点花瓣色相就从 216° 掉到 204°（实测 g/h/m 三组都这样），
 * 深蓝先塌、对比反而更假。 */
const CRATER_EMISS_RGB: [number, number, number] = QVEC('cremiss', [0.22, 0.14, 1.0]);
// 1.10 × CRATER_LEVEL(=0.5 默认) = 0.55，是上面那组实测的落点。
// 保留「跟着 CRATER_LEVEL 一起动」的语义（?craterlevel 仍是统一亮度旋钮）。
const CRATER_EMISS_BASE = 1.10 * CRATER_LEVEL;
const CRATER_EMISS_INT = QNUM('crateremiss', 1)! > 0 ? (QNUM('emissk') ?? CRATER_EMISS_BASE) : 0;
/** 坑内花的基色乘子（线性）。只给 `matGlow`，会场花不受影响。`?crtint=r,g,b` 可调。 */
const CRATER_TINT_RGB: [number, number, number] = QVEC('crtint', [1.34, 0.85, 1.45]);

/** 贴地下沉量（米）。地形是起伏的、花又是「平底」的，稍微压进土里 1 cm
 *  比在坡上露出一条缝好看；这个量级也远小于花高，看不出被埋。 */
const SINK = 0.01;

/* ── ★★ 2026-10-20 task-17：月坑里那一片蓝喇叭花（用户 m01992）──────────
 *
 * 用户原话（m02364 任务 1）：「原绿色草地部分改成喇叭花。」
 * ⇒ 2026-10-20 二轮：**花与草对调**。原来的船周绿草椭圆整块改种喇叭花，
 *   花从外环 `r 6~20.12` 收回到**内圈 `r ≤ POND_R_IN (15)`**，外圈 `15~21.5`
 *   让给水体（task-20，render）。坑内现在**一根草都不长**（`regionGrassMaskNode`
 *   的坑底分支归零），所以不再需要「花避开草区」这条判据。
 *
 * 坑内面积：`π·15² = 706.9 m²`，减掉飞船机身 keep-out 椭圆（`π·6.13·11.40 ≈ 219.6`）
 * ⇒ 可种面积 ≈ **487 m²**；按 3 朵/m² ⇒ ≈1,460 朵。
 * 丛数/丛径按「可种面积」算：44 丛 × π·1.7² ≈ 399 m²（覆盖 ≈82%），丛内 ~3.6 朵/m²。 */
const CRATER_FLORA_ON = QNUM('craterflora', 1)! > 0;
/* ★ 2026-10-20 二轮（用户 m02364 任务 1）：花改种在船周内圈。
 *   旧（task-17）：72 丛 × 44~52 朵 = 3,428 朵铺环带 r 6~20.12（≈1,159 m²）⇒ 2.96 朵/m²。
 *   ★ 2026-10-20 task-19 第三稿（lead QA「还是几串蓝葡萄，不是一片」）：
 *   网格步长 3.0 → 2.4（相邻丛重叠 ≈1 m，连成带），丛心上限 72，每丛 30~38 朵 ⇒
 *   实测约 2,4xx 朵、覆盖面积 π(1.7²)×丛数 超过可用月牙 ⇒ 40 m 俯视读成一片；
 *   总三角 ≈1.1 M（单朵 450 tri），网格数 ≈ 丛数 + 12（会场）。 */
const CF_CLUSTER_N = clamp(Math.round(QNUM('craterfcluster', 90)!), 6, 200);
const CF_PER_MIN = 34;
const CF_PER_MAX = 42;
/** 坑内丛心网格步长（米）：2.4 ⇒ 相邻丛心重叠约 1.0 m（丛径 3.4），连成片而不是一颗颗圆斑。 */
const CF_CLUSTER_STEP = 2.4;
/** 坑内丛内散布（米）：内圈比原来的环带宽裕，1.7 m 的丛既能连成片又留得下缝。 */
const CF_CLUSTER_R = 2.60;
/** 坑内单朵放大系数：40 m 俯视单朵只有几个像素，1.25 才读得成「喇叭花」而不是蓝点。 */
const CF_SCALE_K = 1.45;
/** 坑底权重门槛：> 0.90 才放（= 离坑口还有一段，花不爬到斜坡上）。 */
const CF_FLOOR_MIN = 0.90;
/** 坑内花区外半径（米）= 水体常量 `POND_R_IN`：花不外溢到水面里（task-20 的环带）。 */
const CF_R_OUT = POND_R_IN;

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 小工具
 * ══════════════════════════════════════════════════════════════════════════ */

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 带种子的伪随机（mulberry32）。
 *
 * 为什么不用 `Math.random()`：无头截图验收要靠它复现同一张图（见文件头）。
 * 为什么是 mulberry32 而不是更花哨的：它只要 32 位状态、常数时间、
 * 分布对「撒点」这种用途完全够，而且实现短到可以人眼验一遍。
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ── 矩阵拼装用的临时对象 ────────────────────────────────────────────────
 * 模块级复用，`build()` 里循环几十次也不新建对象。
 * （即使挪进 `useFrame` 也不会每帧分配 —— 前提是**别**在循环里 new。） */
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scl = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 布点（纯函数：同样的种子 ⇒ 同样的结果）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 一个丛心。`n` 是规划朵数，过滤丢掉后会比它少。 */
interface ClusterPlan {
    cx: number;
    cz: number;
    n: number;
}

/** 一朵花的最终落位（世界坐标 + 朝向 + 缩放）。 */
interface FlowerSpot {
    x: number;
    y: number;
    z: number;
    yaw: number;
    tiltX: number;
    tiltZ: number;
    scale: number;
}

/**
 * 摇丛心。
 *
 * 方位为什么是「均匀铺满 + 抖动」而不是纯随机：纯随机会扎堆成一两坨、
 * 中间一大片空；纯均匀又会读成「一圈等距的路灯」。先按 (i+0.5)/N 铺，
 * 再叠 ±14° 抖动，是这两者的折中。
 *
 * 半径为什么是 `t²` 而不是 `t`：`t²` 让内圈密、外圈疏。玩家视线主要落在
 * 近处，远处稀一点更自然，也更省实例预算。
 */
function planClusters(rnd: () => number): ClusterPlan[] {
    const out: ClusterPlan[] = [];
    const start = THREE.MathUtils.degToRad(ENTRANCE_HALF_DEG);
    const span = THREE.MathUtils.degToRad(360 - ENTRANCE_HALF_DEG * 2);
    const jitterHalf = THREE.MathUtils.degToRad(14);

    for (let i = 0; i < CLUSTER_N; i++) {
        for (let k = 0; k < TRY_MAX; k++) {
            const a = start + ((i + 0.5) / CLUSTER_N) * span + (rnd() - 0.5) * jitterHalf * 2;
            const t = rnd();
            const r = RING_IN + (RING_OUT - RING_IN) * t * t;
            /* `layout.ts` 的极角约定就是这个：x = sin(a)·r、z = cos(a)·r（0° = +Z）。 */
            const x = Math.sin(a) * r;
            const z = Math.cos(a) * r;
            /* 丛心自己也要过避让区：丛心坐在石桌肚子里的话，丛内 4~8 朵
               每一朵都得靠重摇逃生，最后大半被丢 —— 直接换一个丛心更省事。 */
            if (keepOutFactor(x, z) <= KEEP_OUT_MIN) continue;
            out.push({ cx: x, cz: z, n: 0 });
            break;
        }
    }
    return out;
}

/**
 * 规划每丛几朵，并把总数拉进「舒适区」。
 *
 * 上拉/下拉都是**有界循环**（`n * 8` 次），并且只在区间内动——
 * 满打满算每丛 4~8 朵，这一点由循环里的 `PER_MIN/PER_MAX` 判断兜住。
 */
function planCounts(n: number, rnd: () => number): number[] {
    const counts = new Array<number>(n);
    for (let i = 0; i < n; i++) counts[i] = PER_MIN + Math.floor(rnd() * (PER_MAX - PER_MIN + 1));

    let total = counts.reduce((a, b) => a + b, 0);
    for (let g = 0; total < TOTAL_PREF_MIN && g < n * 8; g++) {
        const i = g % n;
        if (counts[i] < PER_MAX) { counts[i]++; total++; }
    }
    for (let g = 0; total > TOTAL_PREF_MAX && g < n * 8; g++) {
        const i = g % n;
        if (counts[i] > PER_MIN) { counts[i]--; total--; }
    }
    return counts;
}

/** 在丛心附近摇一朵花。摇不到（避让区占了）返回 `null`，调用方少一朵了事。 */
function rollOne(cx: number, cz: number, rnd: () => number): FlowerSpot | null {
    for (let k = 0; k < TRY_MAX; k++) {
        /* `sqrt` 让点在圆盘里**均匀**分布；不取 sqrt 的话会明显往圆心堆。 */
        const rr = CLUSTER_R * Math.sqrt(rnd());
        const aa = rnd() * Math.PI * 2;
        const x = cx + Math.cos(aa) * rr;
        const z = cz + Math.sin(aa) * rr;

        /* 用户要求：`keepOutFactor > 0.85` 才允许放，否则花会插进石桌/长桌里。 */
        if (keepOutFactor(x, z) <= KEEP_OUT_MIN) continue;

        const s = 1 + (rnd() - 0.5) * 2 * SCALE_JITTER;
        return {
            x,
            /* 贴地高度必须现取：`worldHeightCPU` 只对会场中心（r ≲ 9.5 m）返回 0，
               而花丛在 r = 10~46 m，写死 y = 0 会整片浮空或埋进土里
               （同 `CollectProps.tsx:755` 的理由）。 */
            y: worldHeightCPU(x, z) - SINK,
            z,
            yaw: rnd() * Math.PI * 2,
            tiltX: (rnd() - 0.5) * 2 * TILT_MAX,
            tiltZ: (rnd() - 0.5) * 2 * TILT_MAX,
            scale: s,
        };
    }
    return null;
}

/** 全部布点的结果（顺带把统计量带出来，给调试与探针用）。 */
function planAll(): { spots: FlowerSpot[]; clusters: ClusterPlan[]; dropped: number } {
    const rnd = mulberry32(SEED);

    const clusters = planClusters(rnd);
    if (!clusters.length) return { spots: [], clusters, dropped: 0 };

    const counts = planCounts(clusters.length, rnd);
    const spots: FlowerSpot[] = [];
    let dropped = 0;

    for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        for (let k = 0; k < counts[i]; k++) {
            const s = rollOne(c.cx, c.cz, rnd);
            if (s) { spots.push(s); c.n++; } else dropped++;
        }
    }

    /* 兜底：过滤丢掉的如果让总数掉到 50 以下，往各丛补几朵（每丛仍 ≤ 8）。
       两趟就够 —— 每趟最多补到 50，补不满说明避让区真的占着那片地，认了。 */
    for (let pass = 0; pass < 2 && spots.length < TOTAL_MIN; pass++) {
        let added = 0;
        for (const c of clusters) {
            if (spots.length >= TOTAL_MIN) break;
            if (c.n >= PER_MAX) continue;
            const s = rollOne(c.cx, c.cz, rnd);
            if (s) { spots.push(s); c.n++; added++; }
        }
        if (!added) break;
    }

    /* 上限兜底：规划已经压在 72 以内，这里只是防「以后有人调大 PER_MAX」时静默超预算。 */
    if (spots.length > TOTAL_MAX) {
        dropped += spots.length - TOTAL_MAX;
        spots.length = TOTAL_MAX;
    }
    return { spots, clusters, dropped };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2b. 月坑花盘（task-17）—— 与场会环带完全独立的一套布点
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 坑内丛心：黄金角螺旋铺满**内圈圆盘** `r ≤ CF_R_OUT (= POND_R_IN = 15 m)`。
 *
 * 为什么是黄金角（≈137.5°）：它是最均匀的无周期铺法，读起来像「自然长的一片」；
 * `t = sqrt((i + 0.5) / N)` 把点铺到**面积**上均匀（直接线性取 r 会全挤在圆心）。
 *
 * task-19：从原来的环带（r 6~20.12）改成圆盘 —— 用户「原绿色草地部分改成喇叭花」，
 * 外圈 15~21.5 交给水体（task-20），所以这里必须硬性把 r 卡在 15 以内。
 */
function planCraterClusters(rnd: () => number): ClusterPlan[] {
    const out: ClusterPlan[] = [];
    const c0 = CRATERS[0];
    /* ★ 2026-10-20 task-19 第二稿：**网格扫描**而不是黄金角螺旋。
       原因：内圈可种区是一条**月牙**（飞船机身椭圆几乎横贯 r≤15 的圆盘），
       螺旋布点会大量落在 keepOut 椭圆里被丢掉 —— 上一版 44 个丛心只活了 24 个，
       40 m 俯视里读成「几串蓝葡萄」。改成扫格：先铺满候选格再逐个过 filter，
       既保证月牙里每个角落都被试到，又天然均匀（每个候选外加 ±1.35 m 抖动，避免网格感）。 */
    const step = CF_CLUSTER_STEP;
    const rMax = Math.max(0.5, CF_R_OUT - CF_CLUSTER_R);
    const rings = Math.ceil(rMax / step) + 1;
    /* ★★ 2026-10-20 task-27：**先收全候选、再洗牌取 N 个**。
       原来的写法是行优先扫描（`iy` 由 −rings 到 +rings）+ 收满 `CF_CLUSTER_N` 就 `break`，
       结果 66 个丛心全落在 z 最小（俯视的「上/左上」）的那几行里，坑的下半圈一朵都没有 ——
       用户/lead 在 40 m 俯视图里看到的就是「花只占坑的左上约 40%，边界是一条直线」。
       洗牌后取 N 个 ⇒ 360° 均匀，且仍是确定性（同一 `SEED` 同一结果）。 */
    const cand: { x: number; z: number }[] = [];
    for (let iy = -rings; iy <= rings; iy++) {
        for (let ix = -rings; ix <= rings; ix++) {
            const gx = ix * step, gz = iy * step;
            if (Math.hypot(gx, gz) > rMax) continue;
            const jx = (rnd() - 0.5) * step * 0.9;
            const jz = (rnd() - 0.5) * step * 0.9;
            const x = c0.x + gx + jx;
            const z = c0.z + gz + jz;
            if (Math.hypot(x - c0.x, z - c0.z) > rMax) continue;
            /* ① 坑底权重（花不爬斜坡）② 飞船**机身/龙骨投影**（`shipHullKeepOut`，4.2 × 11.8 m）。
               ⚠️ 这里**故意不用** `keepOutFactor()` 的飞船槽 —— 那条是按草高定的 6.13 × 11.40，
               `> 0.85` 等于要求 q > 1.36，禁区涨到 8.3 × 15.5 m，比整个圆盘还大（见 `worldRegions.ts` 注释）。 */
            if (craterFloorWeight(x, z) < CF_FLOOR_MIN) continue;
            if (shipHullKeepOut(x, z)) continue;
            cand.push({ x, z });
        }
    }
    for (let i = cand.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = cand[i];
        cand[i] = cand[j];
        cand[j] = t;
    }
    const take = Math.min(CF_CLUSTER_N, cand.length);
    for (let i = 0; i < take; i++) out.push({ cx: cand[i].x, cz: cand[i].z, n: 0 });
    return out;
}

/** 坑内丛心附近摇一朵。摇不到（避让区/坑沿/水面）返回 `null`。 */
function rollOneCrater(cx: number, cz: number, rnd: () => number): FlowerSpot | null {
    const c0 = CRATERS[0];
    for (let k = 0; k < TRY_MAX; k++) {
        const rr = CF_CLUSTER_R * Math.sqrt(rnd());
        const aa = rnd() * Math.PI * 2;
        const x = cx + Math.cos(aa) * rr;
        const z = cz + Math.sin(aa) * rr;

        if (craterFloorWeight(x, z) < CF_FLOOR_MIN) continue;
        /* 硬性卡内圈半径：花不外溢到水体环带（用户 m02364 任务 1、task-19 卡片）。 */
        if (Math.hypot(x - c0.x, z - c0.z) > CF_R_OUT) continue;
        if (shipHullKeepOut(x, z)) continue;

        const s = (1 + (rnd() - 0.5) * 2 * SCALE_JITTER) * CF_SCALE_K;
        return {
            x,
            y: worldHeightCPU(x, z) - SINK,
            z,
            yaw: rnd() * Math.PI * 2,
            tiltX: (rnd() - 0.5) * 2 * TILT_MAX,
            tiltZ: (rnd() - 0.5) * 2 * TILT_MAX,
            scale: s,
        };
    }
    return null;
}

function planCraterAll(): { spots: FlowerSpot[]; clusters: ClusterPlan[]; dropped: number } {
    if (!CRATER_FLORA_ON) return { spots: [], clusters: [], dropped: 0 };

    /* 种子错开：同一颗种子派生会场与坑内两套布点，但**从不同位置开始**，
       否则两片的第一个丛心会落在同一个随机数上（观感上没人看得出，但没必要）。 */
    const rnd = mulberry32((SEED ^ 0x9e3779b9) >>> 0);

    const clusters = planCraterClusters(rnd);
    if (!clusters.length) return { spots: [], clusters, dropped: 0 };

    const spots: FlowerSpot[] = [];
    let dropped = 0;
    for (const c of clusters) {
        const want = CF_PER_MIN + Math.floor(rnd() * (CF_PER_MAX - CF_PER_MIN + 1));
        for (let k = 0; k < want; k++) {
            const s = rollOneCrater(c.cx, c.cz, rnd);
            if (s) { spots.push(s); c.n++; } else dropped++;
        }
    }
    return { spots, clusters, dropped };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 装配（glb → 一个 InstancedMesh）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 建好之后**由本组件独占**的 GPU 资源（几何/材质/贴图各一份，所有丛共享）。 */
interface Assets {
    geo: THREE.BufferGeometry;
    mat: THREE.MeshStandardMaterial;
    /** 材质上挂着的贴图（clone 是浅拷贝，贴图对象仍是共享引用 —— 但这份 glb
     *  只被这里加载过，所以由这里负责释放，不会误伤别人）。 */
    textures: THREE.Texture[];
    baseScale: number;
    /** 月坑专用「亮一档」材质（task-19 任务3：喇叭花自发光）；`?crateremiss=0` 时为 null。 */
    matGlow: THREE.MeshStandardMaterial | null;
}

/** 一片花丛的装配结果：`ims` 里每个网格 = 一丛（可见性按丛剔除）。 */
interface Built {
    group: THREE.Group;
    ims: THREE.InstancedMesh[];
    assets: Assets;
}

/** 材质上可能挂贴图的槽位（收集起来统一释放，别漏）。 */
const TEX_SLOTS = [
    'map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap',
    'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap',
] as const;

/**
 * 取第一个网格的几何体 + 材质。
 *
 * 这个 glb 是「1 网格 / 1 图元 / 1 材质」（`nodes[0].name = MoonTable`、
 * POSITION+NORMAL+TEXCOORD_0、16128 索引），所以不需要 `mergeGeometries`，
 * 直接拿那一份就是单次 draw call 的几何。
 */
function pickMesh(root: THREE.Object3D): THREE.Mesh | null {
    let found: THREE.Mesh | null = null;
    root.traverse((o) => {
        if (found) return;
        const m = o as THREE.Mesh;
        if (m.isMesh) found = m;
    });
    return found;
}

/**
 * 装配一份**共享资源**：几何 + 材质 + 贴图。
 *
 * ★ task-17：几何/材质/贴图从这里开始只建**一份**，各丛的 InstancedMesh 共用。
 *   原因：按丛拆网格做可见性剔除（task-15 的 `R_VIS` 40 m）会把网格数从 2 涨到 ~48，
 *   如果每一份都 clone 材质和贴图，就是 48 份 512² 贴图上传，纯浪费显存。
 */
function prepareAssets(gltfRoot: THREE.Object3D): Assets | null {
    gltfRoot.updateMatrixWorld(true);

    const mesh = pickMesh(gltfRoot);
    if (!mesh || !mesh.geometry) {
        console.warn('[flower-clusters] glb 里没有可用的网格，本次不摆花丛');
        return null;
    }

    /* 几何体烘进世界系：`clone()` 之后这份就归我们了。
       即使这个 glb 的节点无变换（实测如此），也不能省这一步 ——
       换个素材、节点上带一个 −90°X 的话，花就会躺在地上。 */
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);

    /* 重新归一化：底面落到 y = 0、XZ 居中。素材本来就已经是归一化的，
       这里再量一次是**防御**（见文件头「量 bbox 而不是写死 3.422」）。 */
    geo.computeBoundingBox();
    const bb0 = geo.boundingBox ?? new THREE.Box3();
    geo.translate(
        -(bb0.min.x + bb0.max.x) / 2,
        -bb0.min.y,
        -(bb0.min.z + bb0.max.z) / 2,
    );
    geo.computeBoundingBox();
    const modelH = Math.max(1e-6, (geo.boundingBox?.max.y ?? 1));
    const baseScale = REAL_H / modelH;
    geo.computeBoundingSphere();

    /* 材质：clone 一份再用 —— 原材质属于 gltf 场景，动它等于动「共享模板」，
       而且不 clone 也没法在卸载时只释放自己这一份（同 `DeskProps.tsx:166` 的理由） */
    const srcMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!srcMat) {
        geo.dispose();
        console.warn('[flower-clusters] glb 网格没有材质，本次不摆花丛');
        return null;
    }
    const mat = (srcMat as THREE.MeshStandardMaterial).clone() as THREE.MeshStandardMaterial;

    /* 夜光：花喉的亮蓝在贴图上已经烘好了，这里只补一点自发光把蓝「抬」起来。
       `emissiveMap = map` ⇒ 自发光强度按贴图明暗走（花瓣暗、花喉亮），
       比整朵纯色发光自然得多。 */
    if (mat.emissive) {
        mat.emissive.setRGB(EMISSIVE_RGB[0], EMISSIVE_RGB[1], EMISSIVE_RGB[2]);
        mat.emissiveMap = mat.map;
        mat.emissiveIntensity = EMISSIVE_INTENSITY;
    }
    mat.needsUpdate = true;

    /* ★ 2026-10-20 task-19（用户 m02364 任务 3「喇叭花加自发光」）：
       月坑那片花要**亮一档**，会场那片保持原样（lead 要求坑外逐位不变）⇒
       单独 clone 一份 `matGlow` 只给坑内实例用。`?crateremiss=0` 时整个不建。 */
    let matGlow: THREE.MeshStandardMaterial | null = null;
    if (CRATER_EMISS_INT > 0) {
        matGlow = mat.clone() as THREE.MeshStandardMaterial;
        /* 基色乘子：把贴图那个青蓝拉到参考图的深蓝花瓣（见 `CRATER_TINT_RGB`）。
           乘在 `color` 上是**材质级**的，贴图本身不动 ⇒ 会场那朵仍然用原色。 */
        matGlow.color.setRGB(CRATER_TINT_RGB[0], CRATER_TINT_RGB[1], CRATER_TINT_RGB[2]);
        if (matGlow.emissive) {
            matGlow.emissive.setRGB(
                CRATER_EMISS_RGB[0],
                CRATER_EMISS_RGB[1],
                CRATER_EMISS_RGB[2],
            );
            matGlow.emissiveMap = matGlow.map;
            matGlow.emissiveIntensity = CRATER_EMISS_INT;
        }
        matGlow.needsUpdate = true;
    }

    const textures: THREE.Texture[] = [];
    const seen = new Set<THREE.Texture>();
    for (const key of TEX_SLOTS) {
        const t = mat[key] as THREE.Texture | null | undefined;
        if (t && !seen.has(t)) { seen.add(t); textures.push(t); }
    }

    return { geo, mat, matGlow, textures, baseScale };
}

/**
 * 一个网格 = 一丛（或一组）实例。矩阵建一次就不再改。
 *
 * 包围球必须按**实例**重算：几何体自带的包围球只有模型那么大（原点附近），
 * 实例却铺在几十米外 —— 不重算的话相机一转整片花就被视锥剔掉，表现是「花一闪一闪」。
 * 这比 `Forest.tsx:271` 那种直接 `frustumCulled=false` 更省。
 */
function makeInstances(a: Assets, spots: FlowerSpot[], name: string, glow = false): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(a.geo, glow && a.matGlow ? a.matGlow : a.mat, spots.length);
    im.name = name;
    // 本项目不开阴影（AGENT.md），显式关掉：免得哪天开了阴影才发现花在投影
    im.castShadow = false;
    im.receiveShadow = false;
    // 矩阵建完就不再改：静态用法，省掉驱动的重传判断
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        _pos.set(s.x, s.y, s.z);
        /* 先 yaw 再倾：`YXZ` 顺序下倾角是绕**花自己的**局部轴，
           这样每朵往哪边歪都不会跟着世界轴走（看着才像被风吹歪）。 */
        _euler.set(s.tiltX, s.yaw, s.tiltZ, 'YXZ');
        _quat.setFromEuler(_euler);
        const k = a.baseScale * s.scale;
        _scl.set(k, k, k);
        _mat.compose(_pos, _quat, _scl);
        im.setMatrixAt(i, _mat);
    }
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    return im;
}

/** 装配一片花丛：`groups` 每项 = 一丛（`cx/cz` 是丛心，用于按丛做可见性剔除）。 */
function build(
    gltfRoot: THREE.Object3D,
    groups: { cx: number; cz: number; spots: FlowerSpot[] }[],
    prefix: string,
    glow = false,
): Built | null {
    const a = prepareAssets(gltfRoot);
    if (!a) return null;

    const group = new THREE.Group();
    group.name = prefix;

    const ims: THREE.InstancedMesh[] = [];
    for (const g of groups) {
        if (!g.spots.length) continue;
        const im = makeInstances(a, g.spots, `${prefix}-im-${ims.length}`, glow);
        /* 丛心挂到 userData 上：`useFrame` 里按它判 `outsideVis`（不额外存一份表，
           免得网格与坐标表错位）。 */
        im.userData.clusterX = g.cx;
        im.userData.clusterZ = g.cz;
        im.userData.instanceCount = g.spots.length;
        group.add(im);
        ims.push(im);
    }
    if (!ims.length) {
        a.geo.dispose();
        for (const t of a.textures) t.dispose();
        a.mat.dispose();
        a.matGlow?.dispose();
        return null;
    }
    return { group, ims, assets: a };
}

/**
 * 释放本组件独占的 GPU 资源。
 *
 * ⚠️ 只释放**这一次挂载自己建出来的**东西：几何/材质/贴图全部来自本次
 *    `GLTFLoader` 的产物，没有任何缓存模板；重挂载会重新 load 一份新的。
 *    这正是 `DeskProps.tsx:518` 那个坑的反面 —— 那边清理里不能 dispose，
 *    是因为它释放的是**跨挂载共享的 `CACHE` 模板**，第二次挂载会拿到空 buffer。
 *    这里没有共享模板，所以按用户要求逐个释放，不给「资源泄漏」留口子。
 */
function disposeBuilt(b: Built): void {
    // 先摘出场景树再释放：避免释放后还有一帧拿它去提交空的 GPU buffer
    b.group.parent?.remove(b.group);
    for (const im of b.ims) im.dispose();   // 实例矩阵缓冲（几何/材质是共享的，下面单独放）
    b.assets.geo.dispose();
    for (const t of b.assets.textures) t.dispose();
    b.assets.mat.dispose();
    b.assets.matGlow?.dispose();
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 组件
 * ══════════════════════════════════════════════════════════════════════════ */

/** 探针数据（`_tools/webgpu-shot.mjs --eval` 可以读 `window.__flowers()`）。 */
let LAST_STATS: Record<string, unknown> = {};

/** 装配结果（会场 + 坑内两片合在一个根节点下，各自按丛挂 `InstancedMesh`）。 */
interface Assembly {
    root: THREE.Group;
    parts: Built[];
    ims: THREE.InstancedMesh[];
}

/**
 * 把「扁平的朵列表」切回「按丛」的分组。
 * 切不开（有人动过补花兜底、`c.n` 之和 ≠ 朵数）时退回**单网格**，
 * 丛心取质心 —— 宁可剔除粒度变粗，也不能让花错位或整片消失。
 */
function toGroups(
    spots: FlowerSpot[],
    clusters: ClusterPlan[],
): { cx: number; cz: number; spots: FlowerSpot[] }[] {
    const sum = clusters.reduce((a, c) => a + c.n, 0);
    if (sum === spots.length) {
        const out: { cx: number; cz: number; spots: FlowerSpot[] }[] = [];
        let k = 0;
        for (const c of clusters) {
            if (!c.n) continue;
            out.push({ cx: c.cx, cz: c.cz, spots: spots.slice(k, k + c.n) });
            k += c.n;
        }
        return out;
    }
    let sx = 0;
    let sz = 0;
    for (const s of spots) { sx += s.x; sz += s.z; }
    const n = Math.max(1, spots.length);
    return [{ cx: sx / n, cz: sz / n, spots }];
}

export function FlowerClusters({ visible = true }: { visible?: boolean }) {
    const [asm, setAsm] = useState<Assembly | null>(null);
    const camera = useThree((s) => s.camera);

    /* ★ task-15/17：**按丛**做可见半径剔除（`core/world/visRadius.ts` 是唯一真值）。
       为什么按丛而不是整片：会场花丛铺在半径 10~46 m 的环上，整片算包围球时
       半径 46 m ⇒ 相机在 60 m 外仍判「未超距」，`render` 实测那边还提交
       `62 实例 / 333,312 三角`，是远处未剔除三角的最大漏项。
       为什么只改 `visible` 不 unmount：重建要重新规划 + 解析 glb，来回过 40 m 边界会卡。 */
    useFrame(() => {
        if (!asm) return;
        const camX = camera.position.x;
        const camZ = camera.position.z;
        for (const im of asm.ims) {
            im.visible = !outsideVis(im.userData.clusterX, im.userData.clusterZ, camX, camZ);
        }
    });

    useEffect(() => {
        if (!FLOWER_ON) return;

        /* 规划是纯函数、同步的：先算好「该在哪摆多少朵」，
           再去加载模型。这样加载慢的时候控制台里也能先看到件数。 */
        const { spots, clusters, dropped } = planAll();
        /* ★ task-17：坑内花盘（与草互补 mask，见常量区注释）。规划失败/关掉时为空。 */
        const crater = planCraterAll();
        if (!spots.length && !crater.spots.length) {
            console.warn('[flower-clusters] 一个花丛都没摆出来（避让区占满了？），跳过加载');
            return;
        }

        let cancelled = false;
        let made: Built | null = null;
        let madeCrater: Built | null = null;

        const loader = new GLTFLoader();
        loader.load(
            FLOWER_URL,
            (gltf) => {
                /* 卸载（或 StrictMode 的「挂载→清理→再挂载」）后才回来的：
                   什么都别建，也别 setState —— 建了就是一份没人释放的泄漏。 */
                if (cancelled) return;
                try {
                    /* 每片按**丛**拆网格：可见性剔除的粒度就是丛（见 `useFrame`）。 */
                    made = spots.length
                        ? build(gltf.scene, toGroups(spots, clusters), 'flower-clusters')
                        : null;
                    madeCrater = crater.spots.length
                        ? build(gltf.scene, toGroups(crater.spots, crater.clusters), 'flower-clusters-crater', true)
                        : null;
                } catch (e) {
                    // 装配阶段的意外同样吞掉：宁可草地上没有花，也不能白屏
                    console.warn('[flower-clusters] 装配失败，本次不摆花丛:', e);
                    return;
                }
                const parts = [made, madeCrater].filter((b): b is Built => !!b);
                if (!parts.length) return;

                /* 一个根节点管可见性开关（`visible` prop），两片各自带自己的丛网格。 */
                const root = new THREE.Group();
                root.name = 'flower-clusters';
                const ims: THREE.InstancedMesh[] = [];
                for (const p of parts) {
                    root.add(p.group);
                    ims.push(...p.ims);
                }

                /* ★ 2026-10-20 task-27：把坑内丛心按 8 个方位扇区统计一遍，放在
                   `__flowers()` 里给探针看 —— 「花只长在一半」这种问题必须先分清
                   是**布点不均**还是**渲染剔除**，否则只能靠猜（lead 明确要求）。 */
                const craterSectors = [0, 0, 0, 0, 0, 0, 0, 0];
                let cxMin = Infinity, cxMax = -Infinity, czMin = Infinity, czMax = -Infinity;
                for (const c of crater.clusters) {
                    const ang = Math.atan2(c.cx - CRATERS[0].x, c.cz - CRATERS[0].z);
                    const k = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 8) % 8;
                    craterSectors[k]++;
                    cxMin = Math.min(cxMin, c.cx);
                    cxMax = Math.max(cxMax, c.cx);
                    czMin = Math.min(czMin, c.cz);
                    czMax = Math.max(czMax, c.cz);
                }
                LAST_STATS = {
                    clusters: clusters.length,
                    count: spots.length,
                    dropped,
                    perCluster: clusters.map((c) => c.n),
                    scale: REAL_H,
                    seed: SEED,
                    /* 坑内花盘（task-17）：丛数 / 朵数 / 丢弃 / 环带半径 */
                    craterClusters: crater.clusters.length,
                    craterCount: crater.spots.length,
                    craterDropped: crater.dropped,
                    craterRing: [0, +CF_R_OUT.toFixed(2)],
                    /* task-27 诊断：8 扇区丛数（0 扇区从 +Z 起、逆时针）+ 坐标范围 */
                    craterSectors,
                    craterBounds: crater.clusters.length
                        ? [+cxMin.toFixed(2), +cxMax.toFixed(2), +czMin.toFixed(2), +czMax.toFixed(2)]
                        : [],
                    /* 按丛剔除：网格数 = 剔除粒度（每帧只改 visible） */
                    meshes: ims.length,
                    tris: spots.length * FLOWER_TRIS + crater.spots.length * FLOWER_TRIS,
                };
                if (FLOWER_DEBUG) {
                    console.info(
                        `[flower-clusters] 会场 ${clusters.length} 丛 / ${spots.length} 朵 / 丢弃 ${dropped} 朵`
                        + `｜坑内 ${crater.clusters.length} 丛 / ${crater.spots.length} 朵 / 丢弃 ${crater.dropped} 朵`
                        + `（内圈 r <= ${CF_R_OUT.toFixed(2)} m，外圈让给水体）`
                        + `｜共 ${ims.length} 个丛网格｜种子 ${SEED}`,
                    );
                }

                /* `setState` 触发一次重渲染把 `<primitive>` 挂进场景 ——
                   这是整个组件唯一的 React 状态变化，之后不会再有。 */
                setAsm({ root, parts, ims });
            },
            undefined,
            (e) => {
                /* 加载失败：`console.warn` + 安静地不渲染任何东西。
                   **不抛错**：一个点缀不该让整场生日会因为网络闪断白屏。 */
                console.warn(`[flower-clusters] 载入失败（${FLOWER_URL}），本次不摆花丛:`, e);
            },
        );

        return () => {
            cancelled = true;
            for (const p of [madeCrater, made]) if (p) disposeBuilt(p);
            made = null;
            madeCrater = null;
        };
    }, []);

    if (!FLOWER_ON || !asm) return null;

    /* `visible={false}` 时**只关 group**，不卸载 InstancedMesh ——
       卸载会重新走一遍「规划 + 下载 + 装配」，而不可见的子树本来就不发 draw call。
       （同 `DeskProps.tsx:539` 对信箱的处理。） */
    return <primitive object={asm.root} visible={visible} />;
}

/* 探针：给无头截图脚本读「到底摆了几丛几朵」。 */
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__flowers = () => LAST_STATS;
}

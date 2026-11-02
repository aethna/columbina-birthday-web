/**
 * forest.ts —— 无主地带（森林）的**种子式**散置（用户 m05607 的方案 B）。
 *
 * ── 方案 B 是什么 ───────────────────────────────────────────────────
 * 用户原文：「另一个是随机地图种子，类似于我的世界。当玩家首次进入时，生成一个
 * 固定的大地图，玩家走到哪里，渲染到哪里。」⇒ **全局种子 + 纯函数散置**：
 * 同一个 (x,z) 在**任何时刻、任何玩家、任何刷新**都长出同一棵树。
 * 所以这里没有任何 `Math.random()`，全走 `pcg()` 的整数哈希（判据 N）。
 *
 * ── 为什么是「抖动网格」而不是「按区域撒点」 ────────────────────────
 * 森林要能**走进去**：树距不能像纯随机那样一半挤成一堆、一半空着。
 * 抖动网格（每格出一个点、点在格内随机）天然给出「不挤不空」的分布，
 * 而且**格子在全局编号**，所以相邻 chunk 之间不会重不漏。
 *
 * ── 高度从哪来 ─────────────────────────────────────────────────────
 * `y = worldHeightCPU(x, z)`。2026-10-11 起 CPU 与 GPU 两张高度图**全图逐项相等**
 * （见 `core/shaders/worldHeight.ts` 的 `getWorldHeight` 注释与 `core/baseHeightCPU.ts`），
 * 所以道具精确贴地，不浮不埋。
 *
 * ── 不碰会场与月球 ─────────────────────────────────────────────────
 * 出件概率一律乘 `forestWeight(x,z)`（场地内恒 0，出边界 6~34 m 内淡入）。
 * 会场有自己那圈 26 棵树的 `venueRing`，月球有 `RegionProps` 的碎石，
 * 两者都不该被森林糊掉。
 */
import { worldHeightCPU, forestWeight, smoothstep01 } from './worldRegions';
import { periodicWaves, wrapIndex, DENS_WAVES_L, DENS_WAVES_M, PATH_WAVES, MUSH_WAVES, WORLD_SIZE } from './worldWrap';
import { QNUM } from './utils/query';
import { R_VIS, VISR_ON } from './world/visRadius';

/** 全世界共用的种子（`?fseed=` 可覆盖）。同一颗种子 ⇒ 同一片森林。 */
export const DEFAULT_FOREST_SEED = 20261011;

/** 每个 chunk 的边长（米）。相机每走过这么多米就重算一次。 */
export const CHUNK = 32;
/** ★★ 2026-10-20 task-7（用户）：「渲染距离太大，显卡压力大。太远的东西不要渲染。
 *  渲染范围截止到草地刷新范围，之外的随着摄像机移动渲染。」★★
 *
 *  `?far=` 视距倍率（缺省 1）。A/B 用：`?far=2` ≈ 回到旧值（104 m），`?far=0.8` 更省。
 *  下面所有半径都乘它 ⇒ 一个开关就能整组缩放，不用改代码。 */
export const FAR_MULT = QNUM('far', 1)!;

/** 森林**自己的**剔除半径基准（米，`?far=` 之前）。
 *
 *  ★★★ 2026-10-21 反馈4：**与 `R_VIS` 解耦，40 → 96** ★★★
 *
 *  用户本轮原话：「森林消失了，从会场走到月坑中间一个树都没有。」
 *  实测（`_logs/t21/sweep.jsonl` + `layer.jsonl`，相机沿 z 从 -40 走到 -150）：
 *    · `window.__forest.total` = 190~517，其中**树只有 15~40 个实例**，
 *      而一棵树按材质拆「枝/干/叶」× 双叶色会占 2~3 个实例 ⇒ **真实树数仅 11~23 棵**；
 *    · 俯视机位（`_logs/t21/aerial.png`，cam=0,60,-110 垂直向下）整个 40 m 圆里
 *      数得出 **约 8 个树冠** —— 这不是「材质坏了」，是**树本来就没几个**；
 *    · 手算复核：树层 `cell 9.0 / p 0.62 / forestDensity≈0.81` ⇒ 62 棵/公顷，
 *      40 m 圆（5027 m²）理论 31 棵，再经 `FAR_TIERS` 的远距稀疏只剩 **6.7 棵**。
 *
 *  ⇒ 40 m 这个数是 task-15 从「用户 10-20 反馈3 画的红线」直接搬过来的，
 *    但那条红线的语义是**「草地刷新的边界」**（`grass/core/config.ts` 的
 *    `DEFAULT_GRASS_AREA_SIZE / 2 = 40`），不是「树只能长到 40 m」。
 *    把森林半径钉死在草盘边缘，等于让「草看不见了」和「森林消失了」同时发生 ——
 *    正是用户这次投诉的观感。
 *
 * ★★★ 2026-10-21 反馈4 最终口径：**渲染距离就是 40 m，不改** ★★★
 *  用户澄清了红线的语义（原话）：「比如我的世界，我把渲染距离设置为 40 m，
 *  那么 40 m 外啥都看不见，但是角色走到哪里，地图上该有的东西进了 40 m 就会
 *  渲染出来，出了 40 m 就看不见。」
 *  ⇒ 40 m 是**流式渲染的边界**，不是「森林的预算上限」。之前两轮都读错了：
 *    · task-15 读成「40 m 外一律不渲染」⇒ 半径对了，但没管 40 m 内够不够；
 *    · 本轮前一次读成「40 m 太近了，要抬到 96」⇒ 把用户要的渲染距离直接拆了。
 *  真正的问题是**40 m 圆内根本没几棵树**（下面 `FAR_TIERS` 的注释有手算），
 *  所以修法只能是「半径 40 m 不动，把 40 m 内的密度和抽稀曲线改对」。
 *
 *  性能实测（`_logs/t21/fps.jsonl`，同机位采 120 帧取中位数）：
 *    `far=1`（CULL_R 40，517 实例）→ 中位 **5.5 ms**；
 *    `far=2.5`（CULL_R 100，2707 实例）→ 中位 **5.5 ms**；
 *    `far=4.4`（CULL_R 175，8560 实例）→ 中位 **5.7 ms**。
 *  实例数 ×16.5、帧耗时只 +0.2 ms ⇒ 半径本身几乎免费；
 *  但**用户要的是 40 m**，所以这条实测只用来否决「密度提上去会掉帧」的担心，
 *  不用来论证「半径应该更大」。
 *
 *  `?fcull=<m>` 可直接改（A/B 用）；`?far=` 仍是乘子。 */
const CULL_R_BASE = VISR_ON ? R_VIS : 52;

/** 以相机所在 chunk 为中心，向四周扩这么多圈。
 *  **必须比 `CULL_R` 宽一圈**：相机落在自己 chunk 的任意位置，最坏单侧只剩 `RING*CHUNK` 米。
 *  ⇒ 直接从 `CULL_R` 推（`ceil(CULL_R/CHUNK)`），别再手写数字：
 *  ⚠️ 2026-10-11 `CULL_R` 44→100 时忘了同步 `RING`，视野里缺过一整条树带。 */
export const RING = Math.max(1, Math.ceil((CULL_R_BASE * FAR_MULT) / CHUNK));

/** 道具生成的**硬上限**半径（米）。超出这个距离一件都不再生成。
 *
 *  ⚠️⚠️ 2026-10-11 用户 m08938：「我依然很疑惑，为何我走出会场依然看不到森林。
 *    这不是树长什么样的问题，这是你地图规划有问题。」
 *    实测根因（`_tools/spec-scan.json` 的 `SC_count`，站在 (200,0) 森林正中央）：
 *      `forestWeight = 1.00`、`forestDensity = 0.81`、有效阈值 `th = 0.76` —— **地图规划是对的**；
 *      但 `collectForest` 数出来 `trees = 159`、`nearTree = 2.1 m`、`farTree = 43.9 m`
 *      ⇒ **所有树都挤在相机 44 m 之内**，`farTree` 正好顶死在旧的 `CULL_R = 44` 上。
 *    再叠加两个口径：草盘半径 40 m、会场排除带 `r=62+34 = 96 m` ⇒
 *      **96 m 的排除带配 44 m 的视野，中间 52 m 是绝对空白**，所以「走出会场看不到森林」。
 *
 *  旧值 44 是 2026-10-10 照「草地圆盘半径 40 m」定的，理由是省显卡 + 远处有雾糊着。
 *  **那个理由现在两条都不成立了**：
 *    ① 雾已改成 `FOREST_FOG_NEAR = 42 / FAR = 70`（`WorldController.tsx`），只盖到 70 m；
 *    ② 程序化树把三角数从 42861 降到 2300~8100（见 `FOREST_ASSETS` 上面的长注释）
 *       ⇒ 铺满一屏的代价掉了一个数量级，`TREE_LOD_R` 那种两档 LOD 已经不必要。
 *
 *  ★ 现在改成**近密远疏的三段式**（下面 `FAR_TIERS`），`CULL_R` 只是最外那道墙。
 *  预算：44 m 时实测 159 棵树 / 8.6M 三角（全场），按面积外推
 *    90 m ⇒ ~665 棵 / ~36M 三角。会场带草的基线是 98.7M（20.4 ms）⇒ 可以接受。
 *  ⚠️ 外圈**必须降密度**，否则 140 m 处会到 ~87M 三角，比整个会场还贵。 */
export const CULL_R = CULL_R_BASE * FAR_MULT;
/* ★★ 2026-10-20 task-7 改回「跟着草地刷新范围走」：100 → **52 × `?far=`**。
 *   理由（用户这次的诉求就是省显卡）：100 m 那一圈的**面积是 40 m 内的 6.25 倍**，
 *   而它在屏幕上只占几十像素；`_logs/perf_t7_before.jsonl` 实测森林里 5441 个实例 /
 *   55.9M 三角。收到 52 m 后面积只剩 27%。
 *   配套改动（缺一不可，否则 52 m 处就是一条「树突然没了」的硬边）：
 *     · `FAR_TIERS` 改成**按 `CULL_R` 的比例**，最外圈保留率压到 7%，边界前先稀疏；
 *     · `WorldController.tsx` 的森林雾 near/far 42/70 → 28/52（雾比树早一步到位）；
 *     · `RING` 由 `CULL_R` 推导（9×9 chunk → 5×5），CPU 侧也少扫 3 倍的 chunk。
 *   `?far=` 整组缩放 ⇒ `?far=1.92` 可完整回到旧的 100 m 口径做对照。
 *
 * ★ 2026-10-20 **task-15 再收一档：52 → 40（= `R_VIS`，草盘边缘）**。
 *   52 是 task-7 拍的折中（「40 m 再放 12 m 余量」），但用户 10-20 反馈3 把红线
 *   （= 草盘边缘 40 m）画在图上、明确说「那之外不该有任何渲染」⇒ 那 12 m 的余量本身就是 bug。
 *   现在 `R_VIS` 由 `core/world/visRadius.ts` 统一给出，森林、区域道具、船、会场道具共用同一份。
 *
 * ★★★ 2026-10-21 反馈4：**40 m 不变，改 40 m 内的密度** ★★★
 *  上面 task-15 那条（52 → 40）方向是**对的**，用户本轮澄清红线的意思就是
 *  「渲染距离 = 40 m，走到哪渲染到哪」（原话见 `CULL_R_BASE` 上的注释）。
 *  中间有一版误判成「40 m 太近，抬到 96」，已撤回 —— 那是把**密度问题**
 *  当成**半径问题**去解。森林继续消费 `R_VIS`，与草盘、区域道具同一份口径。 */

/**
 * ★ 近密远疏的三段式（用户 m08938「走出会场看不到森林」的修法）。
 *
 * 为什么不直接铺满：面积按 r² 涨，100 m 之外那一圈的面积是 60 m 内的 2.8 倍，
 * 而它在屏幕上只占几十个像素。**远处降密度**是这件事的正解 ——
 * 开源那套（Minecraft multi-noise / 100kTrees 的四叉树 + 泊松盘）也都是这么做的：
 * 远处只需要「读起来是森林」，不需要每一棵都在。
 *
 * `far` 之后按 `inner²/d²` 稀疏化：`d = 2×inner` 时剩 25%、`d = 3×inner` 时剩 11%。
 * 用确定性 PCG 决定留不留，所以同一棵树在任何机位都稳定存在（不会闪）。
 * ⚠️ 必须用**未折回的 (gi,gj) 之外的新盐**，不能复用已有的通道，
 *    否则会跟出件概率耦合、在密集处反而更容易被剔掉。
 *
 * ★★★ 2026-10-21 反馈4 最终口径：**40 m 半径下重算抽稀曲线** ★★★
 *  旧表 `0.45/0.55 → 0.72/0.26 → 0.90/0.07` 配 40 m 半径的实际含义是：
 *  40 × 0.45 = **18 m 就开始抽稀**，0.72 = 28.8 m 只剩 26%，0.90 = 36 m 只剩 7%。
 *  40 m 圆内理论 31 棵被抽到只剩 **~14 棵**，18 m 之外几乎全空 ——
 *  用户站在林子里看到的就是「近处几棵、再远一片草地」。
 *
 *  新表：**保留率几乎不动，只把抽稀推到 40 m 的外沿**：
 *    0 ~ 30 m（0.75R）满密度 —— 这是玩家实际看到、走进去的主视野；
 *    30 ~ 36 m（0.90R）保留 72%；
 *    36 ~ 40 m 保留 45%，交给雾在 40 m 处收满。
 *  这样 40 m 圆内理论 130 棵/ha × 5027 m² ≈ **65 棵**，抽稀后 ~54 棵，
 *  平均可见树距 ~9 m，读起来是「林子」而不是「几棵树」。
 *  边界处 45% 的稀疏正好被雾吃掉，不会出现硬边。
 *
 *  ⚠️ 为什么不做成 1.0 全程满密度：40 m 是最外一帧就整片消失的位置，
 *     边界前的稀疏是「雾接管」的缓冲；完全满密度会让树在雾还没到位时突然消失。 */
const FAR_TIERS: readonly { inner: number; keep: number }[] = [
    { inner: 0, keep: 1.0 },
    { inner: 0.75, keep: 1.0 },
    { inner: 0.90, keep: 0.72 },
    { inner: 0.97, keep: 0.45 },
];

/** 按到相机的水平距离给一个保留率（0~1）。用于 `collectChunk` 的远距稀疏化。
 *  ⚠️ `inner` 是**比例**（task-7 起），乘 `CULL_R` 才是米 ⇒ `?far=` 缩放时稀疏圈跟着走，
 *     不会出现「`?far=2` 时 55 m 内突然不稀疏了」这种口径分裂。 */
export function distanceKeep(d2: number): number {
    for (let i = FAR_TIERS.length - 1; i >= 0; i--) {
        const t = FAR_TIERS[i];
        if (d2 >= t.inner * t.inner * CULL_R * CULL_R) return t.keep;
    }
    return 1.0;
}

/** 一个待实例化的道具。GLB 已归一化成「高度 = 1、底面贴地」⇒ `h` 直接是米。 */
export interface ForestProp {
    key: string;
    x: number;
    z: number;
    y: number;
    rot: number;
    h: number;
    /** 水平非均匀缩放（0.78~1.28）。和 `h` 配合出「同一种树、不同胖瘦」的错觉。 */
    sxz: number;
    /** 叶色编号：0 = 钴蓝 `#5984c4`，1 = 青绿 `#147e91`。非树叶件恒 0。 */
    tint: number;
}

/**
 * 素材表。`h` 是**基准高度（米）**，实例化时再乘 0.72~1.38 的随机。
 *
 * ⚠️ 为什么只有 3 种树（用户 m05690/m05695 的指示）：
 *   「现有的树木模型，高点/矮点/剪掉某些枝条/增加枝条，那不就是不同的树么？
 *    弄点不一样的叶子不就行了」「弄很多不同种类的树木模型，可能还会增加GPU负担」
 *   ⇒ **靠非均匀缩放 + 两种叶色 + 旋转出多样性**，不下载一堆树种。
 *
 * ⚠️ 三角数（`_tools/glbinfo.py` 实测，`--tris` 目标写在下面对应的 job 里）：
 *   f_tree_a 12700 / f_conifer 10409 / f_tree_c 42861 / f_boulder 3000 上下
 *   ⚠️ `f_tree_b`（jacaranda, 57375 三角）**不进森林**：Blender 的 COLLAPSE 抽面在
 *      alpha 叶片上会「收敛」——一轮之后再也压不下去（2.4M → 57k 就到底了），
 *      拿去铺森林一屏就是几百万三角。它留作以后单点的「主角树」。
 *
 * ⚠️⚠️ **`h` 的语义由素材自己的长宽比决定**：GLB 是「高度归一化成 1」导出的，
 *   所以 `h` = **Y 方向的实际尺寸（米）**，其余两个方向按各自比例跟着缩放。
 *   对树是「树高」，对**倒木 / 碎石堆 / 苔藓块**却是「厚度」——
 *   例：`f_deadtree` 的包围盒是 `10.64 × 1.00 × 0.96`（一根横躺的树干），
 *   `h = 0.38` 出来才是「4 米长、0.38 米粗」的倒木；给 4.4 会得到一根 **46 米长的巨木**。
 *   下面的数字是拿 `_tools/spec-foresttree.json` 探针实测的包围盒反推的。
 *
 * ⚠️ **`f_conifer`（fir_sapling_medium）不在表里**：它的包围盒是 `10.5 × 1.0 × 0.56`
 *   —— 那是 Poly Haven 的**一套 3 棵小杉木、彼此隔 10 米摆成一排**的「套装」模型，
 *   按件实例化会变成「一次画 3 棵、彼此隔 48 米」。要单人用得上 `--pick` 拆件，
 *   暂时先不用（`路线A-webgpu\public\forest\real\f_conifer.glb` 文件本身保留）。
 */
/* ═══ ★★ 2026-10-11 用户 m07134：「你把树干切成一块块的了」—— 真因是**减面把树枝碾成了板条** ★★
 *
 * 现场：`_tools/ph-blender.py` 的 `decimate()` 用的是 `DECIMATE` + `COLLAPSE`
 *   + `use_collapse_triangulate`，而且预算是**按叶/枝干的份额**分的
 *   （`--leaf-budget 0.60` ⇒ 枝干只拿 40%）。`island_tree_03` 的原始枝干是
 *   **655,222 三角**，打进 14000×0.40 = 5600 的预算里 ⇒ 一棵树的全部枝干只剩几百三角，
 *   细圆柱被塌缩成**扁平的薄片**（近景看就是「浅褐色的大板条」）。
 *
 * 验证：把 `f_tree_a` 的预算提到 **60000**（枝干 24000）重导后，枝条恢复成圆的，
 *   树冠立刻读成一整团（出图 `TB_mid` 对比 `ISO_a`）。
 *
 * 但 60000 三角 × 一屏 160 棵 = 960 万，太贵 ⇒ **两档 LOD**：
 *   近处（`lodR` 米以内）用高模，远处换成低模。树是「远看轮廓、近看枝条」的典型物件。
 *   两档都由 Blender **归一化成高度 1、底面 y=0**，所以 `refill` 里的实例矩阵完全一样，
 *   换 LOD 只是换了一个槽位，不会有跳变。
 *
 * ⚠️ 判据：**`--tris` 对这种「细长杆件」是残酷的**。低模只适合远处，近处一定要给够。
 */
export const TREE_LOD_R = 34.0;

/* ═══ ★★ 2026-10-11 用户 m07431：「树干依然被切的乱七八糟，不行你就去下载不同树的模型吧」★★
 *
 * 结论：**Poly Haven 的树根本救不回来**，问题不在减面，在源几何。
 *   现场隔离出图（`GL_onlytree` / `GL_solo_a`）证明：只留 `f_tree_a` 时，
 *   满屏就是**弯折的浅褐色扁平带子** —— `island_tree_03` 的枝干压根就是「纸片条的树」；
 *   `tree_small_02` 的枝干是贴树皮图的卡片（源贴图全 JPG、无 alpha，见判据 AB）。
 *   加 `--min-tris` 只能让它「不那么烂」，不可能变回圆柱。
 *
 * ⇒ 改为**自己生成**（`_tools/treegen.py`）：
 *   顶点骨架 + Blender **Skin 修改器**蒙成真三维圆柱 + 叶片卡片，
 *   每个物种一套参数（`oak / tall / pine / bushy / spire`），
 *   叶片贴图是**程序化生成的黑底叶图集**（`_tools/leaftile.py` → `public/forest/tex/leaf_atlas.png`）。
 *
 * 副产品：三角数从 **42861（f_tree_c）/ 60000（f_tree_a 高模）** 降到 **2300~8100**，
 *   一屏 160 棵树的预算直接掉一个数量级 ⇒ **不需要 LOD 了**（`TREE_LOD_R` 保留给以后）。
 *   `f_tree_a*` / `f_tree_b` / `f_tree_c` 三个旧 GLB 已从 `public/forest/real` 删除。
 */
export const FOREST_ASSETS: Record<string, { url: string; h: number; leafy?: boolean; proc?: string; lodLo?: string; lodR?: number }> = {
    f_oak: { url: '/forest/real/p_oak.glb', h: 12.0, leafy: true },
    f_tall: { url: '/forest/real/p_tall.glb', h: 16.0, leafy: true },
    /* m02475（用户）：「剩下 6 种（针叶两类、垂枝、团冠、伞形、灌木）还是分叉形，是故意留着
     * 做高低错落的。——可以。但是，这种就需要去找现成的树叶模型，而不是自己用程序画」
     * ⇒ 这 6 种全部换成 **Poly Haven 的现成模型**（CC0 免署名），只走 `_tools/ph-blender.py`
     *   减面 + 贴图降到 512 + 归一化到高度 1.0（运行时按 `h` 缩放到世界米）。
     *   参考图那种「光杆 + 顶端冠球」的主角仍是 `f_oak` / `f_tall`（程序化，参数可调）。
     *   高度按模型真实比例给：pine 20.4 m / fir 18.9 m / jacaranda 19.5 m /
     *   tree_small 4.6 m / island_tree_03 2.6 m / shrub_02_a 2.2 m。 */
    /* ★★ 2026-10-24 用户（12 轮任务1）：「黄色圈出来的树，这种树不好看，去掉地图上所有这个样式的树」。
     *  指认对象 = **针叶两类**（`ph_pine` / `ph_spire`）：光杆 + 横向细枝 + 大块黑色三角叶片，
     *  见 `公用区\10月24日反馈1.png` 黄圈。判据：与 `_tmp_preview\r12\trees\ph_pine.png`
     *  逐形比对（同一棵：直干、横枝、薄片三角叶），与程序化 `p_oak`/`p_tall`（光杆+顶端冠球）
     *  和其余四种（垂枝/团冠/伞形/灌木）都不同款。
     *  ⇒ **整个 key 从资产表删除**（连带 GLB 不再加载、`treeCollide` 不再注册碰撞），
     *    而不是只从池子里摘 —— 池子里摘掉后若哪天有人手工 `push` 回去还会复活。
     *  ⚠️ 想回滚：把这两行加回来，并把 `LAYERS[0].pool` 末尾补上 `'f_pine', 'f_spire'`。 */
    f_bushy: { url: '/forest/real/ph_bushy.glb', h: 3.6, leafy: true },
    f_umbrella: { url: '/forest/real/ph_umbrella.glb', h: 11.0, leafy: true },
    f_weeping: { url: '/forest/real/ph_weeping.glb', h: 5.0, leafy: true },
    f_blob: { url: '/forest/real/ph_blob.glb', h: 5.4, leafy: true },
    f_shrub_a: { url: '/forest/real/f_shrub_a.glb', h: 0.55 },
    f_shrub_b: { url: '/forest/real/f_shrub_b.glb', h: 0.90 },
    f_shrub_c: { url: '/forest/real/f_shrub_c.glb', h: 1.20 },
    f_grass_a: { url: '/forest/real/f_grass_a.glb', h: 0.30 },
    f_grass_b: { url: '/forest/real/f_grass_b.glb', h: 0.44 },
    f_flower_a: { url: '/forest/real/f_flower_a.glb', h: 0.55 },
    f_flower_b: { url: '/forest/real/f_flower_b.glb', h: 0.30 },
    f_flower_c: { url: '/forest/real/f_flower_c.glb', h: 0.34 },
    f_flower_d: { url: '/forest/real/f_flower_d.glb', h: 0.45 },
    f_flower_e: { url: '/forest/real/f_flower_e.glb', h: 0.40 },
    f_rock_a: { url: '/forest/real/f_rock_a.glb', h: 0.55 },
    f_rock_b: { url: '/forest/real/f_rock_b.glb', h: 0.42 },
    f_rock_c: { url: '/forest/real/f_rock_c.glb', h: 0.45 },
    f_boulder: { url: '/forest/real/f_boulder.glb', h: 1.40 },
    f_rockmoss: { url: '/forest/real/f_rockmoss.glb', h: 0.28 },
    f_moss: { url: '/forest/real/f_moss.glb', h: 0.22 },
    f_pebbles: { url: '/forest/real/f_pebbles.glb', h: 0.12 },
    f_deadtree: { url: '/forest/real/f_deadtree.glb', h: 0.38 },
    f_stump: { url: '/forest/real/f_stump.glb', h: 0.62 },
    f_branches: { url: '/forest/real/f_branches.glb', h: 0.40 },
    f_roots: { url: '/forest/real/f_roots.glb', h: 0.30 },

    /* ── 程序化素材（`core/forestProc.ts`，`url` 空串表示不走 GLB）─────
     * 用户要的清单里有「蘑菇」，但 **Poly Haven 一件蘑菇都没有**
     * （521 个模型里没有 mushroom / fungus / toadstool），
     * 蘑菇形状又极简 ⇒ 直接造，颜色也正好由我们对齐参考图。
     * 石板路同理：Poly Haven 的 `stone_01` 是天然石块，切不出「铺好的石板」。 */
    f_mush_a: { url: '', h: 0.42, proc: 'mush_a' },
    f_mush_b: { url: '', h: 0.19, proc: 'mush_b' },
    f_slab: { url: '', h: 0.13, proc: 'slab' },
};

/**
 * 散置层。`cell` 是抖动网格的格距（米）、`p` 是每格出件概率、
 * `gMin/gMax` 是**在素材基准高度上的倍率**（判据：别把倍率当米用 —— 踩过一次，见 `collectChunk`）。
 *
 * 密度排序（踩过一遍才定下来的口径）：树最稀、草与花最密 —— 真实森林里
 * 眼睛看到的是「一层草 + 一层花 + 偶尔一丛灌木」，树是骨架不是填满画面的东西。
 */
interface Layer {
    id: number;
    cell: number;
    p: number;
    /** 高度倍率区间（乘 `FOREST_ASSETS[key].h`） */
    gMin: number;
    gMax: number;
    pool: string[];
    /** > 0 的层要做坡度检查（陡坡上不长草/花，但可以倒着枯木） */
    maxSlope: number;
    leafy?: boolean;
    /** 出件概率是否乘**林分密度场** `forestDensity(x,z)`（见那一段的长注释）。
     *  乔木/灌木/花草要（要做疏密），石板/蘑菇不要（它们由 `gate` 决定位置）。 */
    dens?: boolean;
    /** 额外准入判据（在抖动格坐标算出来之后调用，参数是**世界坐标 x/z**）。
     *  蘑菇要成簇、石板要沿路，都不是「每格等概率」能表达的。 */
    gate?: (x: number, z: number) => boolean;
}

/* ── 两条额外的地形场 ───────────────────────────────────────────────
 * 都用 `fractalNoise3`（`core/baseHeightCPU.ts`，与 GPU 同源的 Perlin），
 * 所以样貌只取决于坐标、与 `?fseed=` 无关的**地貌**是固定的（判据 N）。 */

/** 石板路的中心线：取噪声的**等值线族**（`n = k * PATH_STEP`），而不是只取零线。
 *
 *  ⚠️ 第一版只取 `|n| < 0.013` 一条零等值线，结果**玩家 74 m 视野内根本没有路**
 *  （实测 (250,50) 周围 140 m 见方里最小的 |n| = 0.0187 > 0.013），
 *  出图上石板一件都没有。原因：零等值线是**孤立的闭合环**，一个局部区域里
 *  有没有全看运气。改成「整族等值线」之后，路网间距 ≈ `PATH_STEP / |∇n|`
 *  ≈ 0.22 / 0.0063 ≈ **35 m**、带宽 ≈ **2.9 m** ⇒ 走到哪都能撞上小路。 */
const PATH_STEP = 0.22;
const PATH_HALF = 0.009;

function pathNoise(x: number, z: number): number {
    // ★ 伪大世界：从 fractalNoise3 换成严格以 WORLD_SIZE 为周期的平面波叠加
    //   （波数 n = round(768 · 0.0042) = 3，与原「λ ≈ 183 m」一致）。
    //   ⚠️ 石板路靠**等值线**取路，幅度必须与原 fbm 的典型 ±0.6 相当，
    //      给小了整张图只剩一两条路（见 worldWrap.PATH_WAVES 的注释）。
    return periodicWaves(x, z, PATH_WAVES);
}

/** 这一点是否踩在石板路上。 */
export function onPath(x: number, z: number): boolean {
    const n = pathNoise(x, z) / PATH_STEP;
    return Math.abs(n - Math.round(n)) < PATH_HALF / PATH_STEP;
}

/** 蘑菇只在「菌丝块」里冒出来：另一张噪声的正值区，斑块直径 ≈ 40 m。
 *  蘑菇在真实森林里就是成簇的 —— 散着长反而假。 */
function mushroomNoise(x: number, z: number): number {
    // ★ 伪大世界：周期化（波数 n = round(768 · 0.021) = 16 ⇒ λ ≈ 48 m，与原一致）
    return periodicWaves(x, z, MUSH_WAVES);
}

export function onMushroomPatch(x: number, z: number): boolean {
    return mushroomNoise(x, z) > 0.24;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ★★ 林分密度场（stratified density field）★★
 *
 * ⚠️⚠️ 2026-10-11 用户 m01512：「我发现你对于森林地图的规划有问题。有些地方有很密集的树，
 *    有些地方完全没有只有草地。这是你地图种子的问题。」
 *
 * **成因（`路线A-webgpu/_logs/森林规划调研.md` 子 agent 调研，19 条文献）**：
 *    原来的出件判据是 `const r0 = pcg(...); if (r0 > L.p) continue;` ——
 *    **每格独立的白噪声阈值**。而二维方格「点渗流」的临界阈值是 **p_c = 0.592746**
 *    （Stauffer & Aharony《Introduction to Percolation Theory》1992 p.17；MathWorld
 *    "Site Percolation Threshold"）。树层原来取 `p = 0.62`，**刚好越过临界点**：
 *    · 占据格会连成**巨大的贯通簇**（连片密林）；
 *    · 空区也连成片（22 m 见方的大空地成片出现）；
 *    · 临界点附近**涨落发散**，同一个 p 在不同地方表现差得极远。
 *    ⇒ 「密一片、空一片」是**相变临界区**的必然产物，**调 p 治不了**（调到哪一边都难看）。
 *
 * **修法：把概率从「独立白噪声」换成「空间连续的密度场」。**
 *  · 密度 `D(x,z) ∈ [DENSITY_MIN, 1]` 由两层 fbm 决定 ⇒ 疏密沿地图**平滑**变化，
 *    空区变成「有形状的林间空地」（像真实森林的林窗 / 林间草地），而不是随机砸出的洞；
 *  · 每层再乘自己的基准概率 ⇒ `p_eff = L.p * D`。
 *
 * ⚠️ **绝对不要再写「权重相乘归零」** —— 本项目已经栽过一次：
 *    `core/worldRegions.ts` 的 `forestWeight` 曾经把两个区域的排除权相乘，
 *    结果会场与月球之间空出 **190 m 完全无树**的走廊（同一条用户抱怨）。
 *    所以这里的 `DENSITY_MIN` 是**下限**（永不为 0），不是渐隐。
 *
 * ⚠️ 真实森林的分层（研究结论）：乔木层控制**郁闭度**、灌木层补**厚度**、
 *    草本层铺**地被**。三层各自有密度场，所以「树稀的地方草和灌木照样密」，
 *    站在空地里也不会觉得是秃地。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 密度场下限。0.70 ⇒ 最稀的林分也有基准概率的 70%（**不是 0**）。 */
export const DENSITY_MIN = 0.70;

const densCache = new Map<number, number>();

/** 4 m 量化缓存的密度场。λ 最小的一层也有 ≈50 m，4 m 量化看不出来。 */
/** ⚠️ 导出给大地图烘焙用（core/worldMapBake.ts）。 */
export function forestDensity(x: number, z: number): number {
    const qx = Math.round(x * 0.25);
    const qz = Math.round(z * 0.25);
    const key = (qx * 73856093) ^ (qz * 19349663);
    const hit = densCache.get(key);
    if (hit !== undefined) return hit;

    // 大尺度（λ ≈ 190 m）：这一片是密林还是疏林
    const big = periodicWaves(x, z, DENS_WAVES_L);
    // 中尺度（λ ≈ 51 m）：林窗 / 林间空地
    const mid = periodicWaves(x, z, DENS_WAVES_M);
    const n = big * 0.72 + mid * 0.28;
    const v = DENSITY_MIN + (1 - DENSITY_MIN) * smoothstep01(-0.32, 0.32, n);
    densCache.set(key, v);
    return v;
}

/** 换种子时要清缓存（`collectForest` 里调）。 */
export function resetForestDensityCache(): void {
    densCache.clear();
}

const LAYERS: Layer[] = [
    /* 骨架：树。**决定「像不像森林」的只有这一层** —— 第一版 cell 13 / p 0.52
     *  换算下来 1 棵 / 325 m²（74 m 视距内才 53 棵），空中看是一片稀树草原，
     *  完全不是用户要的「无缝森林」。现在 cell 9 ⇒ 1 棵 / 130 m² 上下，
     *  树距 ≈ 9.5 m 而树冠宽 ≈ 10 m ⇒ 冠层开始互相搭接，抬头能连成一片。
     *  ⚠️ 代价必须从「看不见的地方」省：草/碎石/巨石各砍一半（见下面几条）。 */
    /* 树种配比：`oak` 是主体（圆冠、中等高度），`tall` 撑高度层次，
     *  `pine` / `spire` 是两种针叶（塔形，给森林加纵向节奏），`bushy` 是小乔木当林下木。
     *  ⚠️ 全部由 `_tools/treegen.py` 程序化生成（骨架 + Skin 修改器 = 真圆柱枝干），
     *    叶片贴图是 `public/forest/tex/leaf_atlas.png`（黑底，前端按亮度现抠）。
     *    三角数 11000~63000 / 棵 ⇒ 不需要 LOD。
     * ⚠️⚠️ `p` 是**基准**概率；真正生效的是 `p * forestDensity(x,z)`
     *    （`dens: true`，密度场下限 0.70）。所以这里写的是「最密处的概率」。
     * m09435（用户 m09235 之后）：参考图 4 是**公园式疏林** —— 树干看得见、能穿好几排、
     *    冠与冠之间有天空。原来 `cell 6.2 / p 0.94` 合出来是「6.2 m 网格上 2/3 的格子有树」
     *    ⇒ 站在林子里四周全是树干，读成密林不是疏林。`cell` 放到 9.0 并把 `p` 压到 0.62，
     *    平均间距从 ~7.6 m 拉到 ~11.5 m。`gMin/gMax` 也放宽，让「疏密对比」更明显。 */
    /* ★★★ 2026-10-21 反馈4：`cell 9.0 / p 0.62` → **`cell 7.0 / p 0.75`** ★★★
     *  上面 m09435 那次「公园式疏林」的调整是针对**会场附近**观感做的，
     *  但它同时把**整张地图**的树砍到了 62 棵/公顷。用户这次要的是
     *  「从会场走到月坑中间有森林」—— 62 棵/公顷 × 40 m 可见圆 = 只有 6.7 棵，
     *  这个密度在 1.7 m 眼高下读不成森林，读成荒原（实测见 `CULL_R_BASE` 注释）。
     *  `cell 7.0 / p 0.75` ⇒ 130 棵/公顷，平均树距 ≈ 8.8 m，
     *  冠幅 8~10 m ⇒ 冠层互相搭接、抬头能连片，但仍能穿过 2~3 排看到天光
     *  （比 `cell 6.2 / p 0.94` 那次「四周全是树干」的密林要疏）。
     *  三角预算：96 m 圆 ≈ 343 棵 × ~5000 tri ≈ 1.7M tri，远低于草基线的 98.7M。 */
    // m02502（用户）：**森林主体 = 参考图那种「光杆 + 顶端冠球」**（`f_oak` / `f_tall`），
    //   其余六种只做多样性补充，**数量不能压过本体** ⇒ 池子里给光杆树 15/21（≈71%），
    //   六种补充各占 1 条（各 ≈4.8%），是远处偶尔冒出来的点缀，不是主角。
    { id: 1, cell: 7.0, p: 0.75, gMin: 0.62, gMax: 1.55, pool: [
        'f_oak', 'f_oak', 'f_oak', 'f_oak', 'f_oak',
        'f_tall', 'f_tall', 'f_tall', 'f_tall', 'f_tall',
        'f_oak', 'f_oak', 'f_oak', 'f_tall', 'f_tall',
        /* ★ 2026-10-24（12 轮任务1）：摘掉 `f_pine` / `f_spire` —— 用户点名不要那种针叶样式。
         *   池子由 21 条降到 19 条，光杆树占比 15/19 ≈ 79%（原来 71%），森林主体更统一。 */
        'f_umbrella', 'f_weeping', 'f_blob', 'f_bushy',
    ], maxSlope: 0.85, leafy: true, dens: true },
    // 中层：灌木（森林的「厚度」主要靠它，别吝啬）
    { id: 2, cell: 5.0, p: 0.70, gMin: 0.62, gMax: 1.35, pool: ['f_shrub_a', 'f_shrub_b', 'f_shrub_c'], maxSlope: 1.10, dens: true },
    // 地被：草丛（调稀一半，把预算让给树；会场的 100 万根草另外算）
    { id: 3, cell: 2.9, p: 0.78, gMin: 0.60, gMax: 1.40, pool: ['f_grass_a', 'f_grass_b'], maxSlope: 1.40, dens: true },
    // 花
    { id: 4, cell: 5.0, p: 0.40, gMin: 0.60, gMax: 1.35, pool: ['f_flower_a', 'f_flower_b', 'f_flower_c', 'f_flower_d', 'f_flower_e'], maxSlope: 1.20, dens: true },
    // 石头
    { id: 5, cell: 9.5, p: 0.40, gMin: 0.45, gMax: 1.70, pool: ['f_rock_a', 'f_rock_b', 'f_rock_c', 'f_rockmoss'], maxSlope: 1.80, dens: true },
    // 巨石（少而大；单件 26k 三角，是全场最贵的素材，压密度）
    { id: 6, cell: 24.0, p: 0.22, gMin: 0.70, gMax: 1.60, pool: ['f_boulder'], maxSlope: 1.60 },
    /* 苔藓 / 碎石（贴地薄层）。`f_pebbles` 单件 3000 三角且糊在脚下看不见
     *  ⇒ 概率往苔藓偏，总量砍到 1/3。 */
    { id: 7, cell: 5.0, p: 0.55, gMin: 0.55, gMax: 1.30, pool: ['f_moss', 'f_moss', 'f_pebbles'], maxSlope: 1.50, dens: true },
    /* 枯木（最稀）。
     * ⚠️ 2026-10-11 用户 m07134：「切树枝而不是切树干，你把树干切成一块块的了」
     *   ⇒ **`f_deadtree`（`dead_tree_trunk`）与 `f_branches`（`dry_branches_medium_01`）
     *      从这一层里摘掉**。它们按 `h` 缩放后是 4 m 长的**躺在草地上的原木/断枝**，
     *      一片林子里撒几十根，读起来就是「树干被切成一截一截丢在地上」。
     *   ⇒ 只留**立着的树桩**与**露出地面的树根**：都是「原地长出来的」，不是「被砍断丢下的」。 */
    { id: 8, cell: 24.0, p: 0.16, gMin: 0.70, gMax: 1.25, pool: ['f_stump'], maxSlope: 1.90 },
    /* 蘑菇（程序化素材，Poly Haven 没有）。只在 `onMushroomPatch` 的菌丝块里长，
     *  格距取 2.2 m ⇒ 一块里就是一丛，而不是地里到处冒。 */
    { id: 9, cell: 2.2, p: 0.40, gMin: 0.75, gMax: 1.30, pool: ['f_mush_a', 'f_mush_b', 'f_mush_b'], maxSlope: 1.20, gate: onMushroomPatch },
    /* 石板路（程序化切石）。沿 `onPath` 的零等值带铺，格距 1.15 m 略小于石板
     *  直径 0.92 m ⇒ 相邻石板会互相压边，看着是「铺」出来的而不是「摆」出来的。
     *  坡度上限压到 0.55：石板是刚性的，我们不做沿坡旋转，太陡会翘边。 */
    { id: 10, cell: 1.15, p: 1.00, gMin: 0.90, gMax: 1.18, pool: ['f_slab'], maxSlope: 0.55, gate: onPath },
];

/** 整数哈希 → [0,1)。三输入 PCG，确定性（**不要**换成 `fract(sin())`，判据 N）。 */
function pcg(a: number, b: number, c: number): number {
    let h = (0x9e3779b9 ^ Math.imul(a | 0, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35) ^ Math.imul(c | 0, 0x27d4eb2f)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}

/** 世界高度在场点上的梯度模长（用来拒绝陡坡）。中心差分，步长 1.6 m。 */
function slopeAt(x: number, z: number, h0: number): number {
    const d = 1.6;
    const dx = (worldHeightCPU(x + d, z) - worldHeightCPU(x - d, z)) / (2 * d);
    const dz = (worldHeightCPU(x, z + d) - worldHeightCPU(x, z - d)) / (2 * d);
    return Math.hypot(dx, dz);
}

/** 一个 chunk 内的全部候选点。`push` 收集通过的件。 */
function collectChunk(cx: number, cz: number, seed: number, camX: number, camZ: number, push: (p: ForestProp) => void): void {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const cull2 = CULL_R * CULL_R;

    for (const L of LAYERS) {
        // 只遍历**格原点落在本 chunk 内**的格子 —— 相邻 chunk 不会重复出件
        //（点会因抖动溢出格到隔壁 chunk 一点点，但它是被格原点所在的那个 chunk 拥有的）
        const giLo = Math.floor(x0 / L.cell), giHi = Math.floor((x0 + CHUNK - 1e-6) / L.cell);
        const gjLo = Math.floor(z0 / L.cell), gjHi = Math.floor((z0 + CHUNK - 1e-6) / L.cell);

        /* ★★ 伪大世界（用户 m01512）—— 地图拼接的核心就这三行 ★★
           所有随机数只看**折回后**的格子索引 (wgi, wgj)，而位置仍然用未折回的 (gi, gj)。
           于是格子 (gi, gj) 与 (gi + NCI, gj + NCJ) 生成的**是同一件东西**，
           只是位置正好差一个 WORLD_SIZE ⇒ 走出边界就从另一边接上，不需要传送。

           NCI = round(WORLD_SIZE / L.cell)：每层**各自**以约 768 m 为周期。
           各层周期相差不到 0.5%（6.2×124 = 768.8 vs 2.9×265 = 768.5），
           合起来的重复感反而更弱 —— 比强行让所有 cell 都整除 768 更划算
           （那要求把 6.2 改成 6、2.9 改成 3，等于重调一遍全部配比）。 */
        const NCI = Math.max(1, Math.round(WORLD_SIZE / L.cell));


        for (let gi = giLo; gi <= giHi; gi++) {
            for (let gj = gjLo; gj <= gjHi; gj++) {
                const wgi = wrapIndex(gi, NCI), wgj = wrapIndex(gj, NCI);
                const x = (gi + pcg(seed + L.id * 977, wgi, wgj)) * L.cell;
                const z = (gj + pcg(seed + L.id * 1319, wgi, wgj)) * L.cell;

                /* ★★ 出件概率 = 基准 × 林分密度场 ★★
                   ⚠️ 原来这里是 `if (pcg(...) > L.p) continue;` —— 独立白噪声阈值。
                   p 越过二维方格点渗流阈值 0.592746 之后，占据格会连成贯通大簇、
                   空区也连成大片，就是用户说的「密一片、空一片」（见 `forestDensity` 的长注释）。
                   现在乘上空间连续的 `forestDensity(x,z) ∈ [0.70, 1]`，
                   疏密沿地图平滑变化，空地是有形状的林窗。 */
                const th = L.dens ? L.p * forestDensity(x, z) : L.p;
                if (pcg(seed + L.id * 101, wgi, wgj) > th) continue;

                if (L.gate && !L.gate(x, z)) continue;

                const ddx = x - camX, ddz = z - camZ;
                const d2 = ddx * ddx + ddz * ddz;
                if (d2 > cull2) continue;

                /* ★ 近密远疏（用户 m08938）：越过 `FAR_TIERS` 的阈值之后按确定性 PCG 抽稀。
                 *   ⚠️ 盐用 `97531`，是这层**没用过**的通道 —— 复用别的盐会跟出件概率耦合。
                 *   ⚠️ 放在 `cull2` 之后、`forestWeight` 之前：这几步都能 `continue`，
                 *      先做最便宜的平方比较。 */
                const keep = distanceKeep(d2);
                if (keep < 1.0 && pcg(seed + L.id * 97531, wgi, wgj) > keep) continue;

                // 会场 / 月球之内不出件；边缘按权重淡出（不出现一圈硬边界）
                // ⚠️ 用 `forestWeight`（渐入带 6→34 m）而不是 `wildWeight`（20→110 m）：
                //    后者是照丘陵坡度定的，拿来做植被门槛会让两块场地之间空出 190 m 的无树走廊
                //    —— 就是 m07134「人物走远后，只剩草地」那件事。
                const w = forestWeight(x, z);
                if (w < 0.02) continue;
                if (pcg(seed + L.id * 7919, wgi, wgj) > Math.min(1, w * 1.7)) continue;

                const y = worldHeightCPU(x, z);
                if (L.maxSlope > 0 && slopeAt(x, z, y) > L.maxSlope) continue;

                const r3 = pcg(seed + L.id * 4321, wgi, wgj);
                const r4 = pcg(seed + L.id * 6151, wgi, wgj);
                const r5 = pcg(seed + L.id * 8123, wgi, wgj);
                if (!L.pool.length) continue;
                let key = L.pool[Math.min(L.pool.length - 1, Math.floor(r3 * L.pool.length))];
                /* 距离 LOD：`lodR` 以外换成低模（两档几何完全相同、只是三角数不同，
                 * 且都归一化成高度 1，所以实例矩阵不用改，换 LOD 不会有跳变）。
                 * 用平方比较，省一次 sqrt。 */
                {
                    const hd = FOREST_ASSETS[key];
                    if (hd?.lodLo) {
                        const lr = hd.lodR ?? TREE_LOD_R;
                        if (ddx * ddx + ddz * ddz > lr * lr) key = hd.lodLo;
                    }
                }
                /* ⚠️⚠️ 这里必须乘素材的**基准高度**（`FOREST_ASSETS[key].h`，米）。
                 * 2026-10-11 第一版漏了这一乘：`gMin/gMax` 是**倍率**（0.6~1.4），
                 * 直接当米用 ⇒ 树高变成 1.1 米，整片森林的树都埋在草里看不见，
                 * 出图上「一棵树都没有」，查了半天才发现是量纲错了。 */
                const base = FOREST_ASSETS[key]?.h ?? 1.0;

                push({
                    key,
                    x, z, y,
                    rot: r4 * Math.PI * 2,
                    h: base * (L.gMin + r5 * (L.gMax - L.gMin)),
                    sxz: 0.78 + pcg(seed + L.id * 9151, wgi, wgj) * 0.50,
                    // 叶色：同一棵树在**两种颜色之间按位置定**，所以一片林子里两色混长
                    tint: L.leafy ? (pcg(seed + L.id * 3571, wgi, wgj) < 0.5 ? 0 : 1) : 0,
                });
            }
        }
    }
}

/**
 * 收集以相机为中心的整圈森林道具。
 *
 * @param camX/camZ 相机世界坐标（和草一样按**相机**而不是角色铺，见 `gridSnapping`）
 * @param seed     森林种子
 * @param push     每件回调（顺序不保证稳定，调用方自己按 key 分桶）
 * @returns 出件总数（仅用于日志）
 */
export function collectForest(camX: number, camZ: number, seed: number, push: (p: ForestProp) => void): number {
    // 每轮重填清一次密度场缓存（它只跟坐标有关，一轮内复用；跨轮清掉免得无限涨）
    resetForestDensityCache();
    const ccx = Math.floor(camX / CHUNK);
    const ccz = Math.floor(camZ / CHUNK);
    let n = 0;
    const wrapped = (p: ForestProp) => { n++; push(p); };
    for (let cx = ccx - RING; cx <= ccx + RING; cx++) {
        for (let cz = ccz - RING; cz <= ccz + RING; cz++) {
            collectChunk(cx, cz, seed, camX, camZ, wrapped);
        }
    }
    return n;
}

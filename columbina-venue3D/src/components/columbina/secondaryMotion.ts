/* ===== 头发 / 裙摆 / 袖饰：Verlet 弹簧骨（spring bone / 动态骨骼） =====
 *
 * 解决用户 m06469 问题 2 与 m09585 任务 1：「走路时衣服、头发是固定的，固定就会穿模」。
 *
 * ## 为什么不用加载器自带的物理（三条路全部实测判死）
 * `@yohawing/three-mmd-loader@0.8.4` 给了三种 `physics` 取值，全部不可用：
 *
 *  1. `'external'`（Bullet wasm）
 *     - `public/mmd/mmd_bullet.wasm` 是 **ALLOW_MEMORY_GROWTH=0** 的构建，Memory 段
 *       `min=1024 max=1024` 页 = **64 MB 死上限**，`_emscripten_resize_heap` 直接
 *       `abort("OOM")`。把它 patch 成能长之后，堆一增长 `HEAPF32` 视图就 detach
 *       （`feedBodies` 抛 `TypedArray.prototype.set on a detached ArrayBuffer`）。
 *     - 且实测 **单步 150~290 ms**（607 刚体 / 956 关节）—— 60 fps 需要 16 ms/步，差一个数量级。
 *     - 另外它有个**坐标系陷阱**：`dist/runtime/physics.js:341-353` 抽的是
 *       `bone.matrixWorld`（真·世界矩阵），而 PMX 的刚体/关节是**模型网格单位、以模型原点为基准**。
 *       一旦给角色加了缩放（我们 `CHAR_H / 20.52 = 0.07895`），刚体坐标就差 12.66 倍 ⇒ 一步炸开。
 *       这个坑用 `pushModelSpace()` 在 `MmdCharacter.tsx` 里绕过了，但前两条已经足够判死。
 *
 *  2. `'stateful-spring'`（内置纯 JS 弹簧）
 *     - ★ `dist/runtime/core.js:451-473` `stepStatefulSpringPhysics()` **只写 `bone.position`，
 *       从不碰 `bone.quaternion`**：
 *         `translation = (bone.position.x, bone.position.y, -bone.position.z)` → `simulation.step()`
 *         → `bone.position.set(t[0], t[1], -t[2])`
 *       而头发/裙摆是**纯旋转驱动**的骨架（609 根骨，名字 `Skirt_*` / `Bone_Hair*`），
 *       位移对它们没有任何视觉作用 —— 于是等于**把这些骨推回静止位置**，外观就是「钉死」。
 *       这正是用户看到的现象（实测 742 根骨里 687 根四元数 60 帧不变）。
 *     - ★ `dist/three/index.js:165-170` `canCreateImplicitMmdAnimRuntime()` 里有
 *       `&& this.options.runtime?.physics !== "stateful-spring"` ⇒ 选它还会**关掉快的
 *       WASM 运行时**，退回慢的 JS `DefaultMmdRuntime`。
 *
 *  3. `'none'` —— 不跑任何物理（我们真正要的底座：`physics:'none'` 才能拿到
 *     快的 WASM `MmdAnimRuntime`）。
 *
 * ## 所以自己写：VRM SpringBone / Unity DynamicBone 那一套
 * 参考实现思路（公开算法，非抄代码）：Unity `DynamicBone.UpdateParticles()`、
 * VRM 1.0 `Vrm10InstanceSpringBone`、以及 Godot/Unreal 里同名实现。
 *
 * 每根物理骨一个 **Verlet 粒子**（就是这根骨的骨头位置）：
 *
 *     free  = p + (p - p_prev) * keep + g * dt²          // 惯性 + 重力
 *     dir   = normalize(free - 父骨原点)                  // 朝父骨原点收
 *     dir   = lerp(dir, 静止方向, 1 - e^{-k·dt})          // 回正弹簧
 *     dir   = clampAngle(静止方向, dir, limit)            // 限角（MMD 关节实测 ±20°）
 *     p     = 父骨原点 + dir * 骨长
 *     R     = fromUnitVectors(静止方向, dir)              // 世界空间偏转
 *     骨.quaternion = 父世界朝向⁻¹ · R · 父世界朝向 · 动画局部四元数
 *
 * 关键点：
 *  ① **静止方向 = 父骨当前世界朝向 × 骨头在父空间的局部方向**。
 *     骨头位置只由父骨决定，所以这条链天然按层级传播（父先算，子读父的新朝向）。
 *  ② 写回时乘的是**动画局部四元数**（`model.update(t)` 刚写的值），
 *     所以物理是「在动画姿态之上叠加一个世界空间偏转」，**不会丢掉动画**。
 *  ③ 站立不动时 `free → p`、`dir → 静止方向`，一切回到动画姿态，**不会漂**。
 *  ④ 与帧率无关：`1 - e^{-k·dt}` 是指数衰减的精确解，`dt` 夹在 [1/240, 1/30]。
 *  ⑤ 不碰 wasm、不依赖外部资源、没有循环回绕问题（无跨周期的内部相位）。
 *
 * 代价：不是真布料 —— 没有自碰撞、也没跟腿做碰撞检测。
 * 在「她会走会转身，头发裙摆要跟着甩」这个目标上，弹簧骨的性价比远高于 Bullet。
 *
 * ★ ⑥ 必须显式加「风」，否则往前走对布料完全没有影响：
 *   Verlet 粒子存的是**世界坐标**。角色整体平移时，粒子和它的父骨原点被平移了
 *   **同一个向量**，`free - 父骨原点` 不变 ⇒ 刚性位移产生的偏转恰好为 0。
 *   这在物理上是对的（匀速平动没有加速度），但游戏里裙子要「被走路的风吹到身后」，
 *   所以把角色世界速度 v 变成一个反向的风力加速度 `-v · wind` 加进积分里。
 *   代价：这是**唯象**的（不是真的空气动力学），`wind` 大了裙子会像被鼓风机吹。
 */

import * as THREE from 'three/webgpu';
import { QNUM } from '../../core/utils/query';

/** 一套弹簧骨 */
export interface SecondaryRig {
    /** 按层级排序（父一定在子之前）的骨骼 */
    bones: THREE.Bone[];
    n: number;
    /** 每根骨在本列表里的父骨下标；`-1` = 父骨不在名单里（链根） */
    parentIdx: Int32Array;
    /** 每根骨原点在**父空间**的局部位置（恒定，从不改写） */
    headLocal: Float32Array;
    /** 每根骨原点相对父骨原点的**世界距离**（米，含模型缩放） */
    restLen: Float32Array;
    /** 每根骨原点在**父空间**的单位方向（恒定） */
    restDirLocal: Float32Array;
    /** ★ t16：每帧求解后**实际生效**的静止目标方向（世界坐标，单位向量）。
     *  供 `measureSleevePose()` 判「袖子朝哪飘」。必须存世界方向、不能从 `particle`
     *  反推 —— 粒子位里含 `carry`/风按行走方向加的偏置，与走向有关，会污染判据。 */
    restDirWorld: Float32Array;
    /** ★ 十四轮：本帧**未经侧摆**的静止目标方向（世界坐标，单位向量）。
     *  写回旋转时用它算侧摆增量，避免「推 `_vRest` 又被回正弹簧吃回」。
     *  全 0 = 该骨本帧没走侧摆通道 ⇒ 走原路径，逐位不变。 */
    sideBaseDir: Float32Array;
    /** 每根骨**本帧动画**写下的局部四元数（物理的锚点，每帧刷新） */
    animLocal: THREE.Quaternion[];
    /** Verlet 粒子世界位置（当前 / 上一帧） */
    particle: Float32Array;
    particlePrev: Float32Array;
    /** 每根骨的参数 */
    limit: Float32Array;      // 限角（弧度）
    stiffness: Float32Array;  // 回正刚度（1/秒）
    keep: Float32Array;       // 速度保留系数 = 1 - 阻尼
    /** 全局重力（米/秒²，正值向下） */
    gravity: number;
    /** ★ 风阻增益（1/s）：角色世界速度 × 这个数 = 吹向身后的风加速度（米/秒²） */
    wind: number;
    /** 前侧布片（`axisSel===0 && axisSign>0`）吃多少风。缺省 0 —— 见 `SecondaryOptions.windFront` */
    windFront: number;
    /** 裙摆最下摆吃多少风（0..1）。缺省 0.10 —— 见 `SecondaryOptions.windHem` */
    windHem: number;
    /** 裙摆高度过渡窗口（**占裙摆自身竖直跨度的比例**，0=最底、1=最上）。
     *  `<= hemHi` 的下摆按 `windHem` 折风、`>= hemHi` 不折 —— 见 `SecondaryOptions.windHem` */
    hemLo: number;
    hemHi: number;
    /** 裙摆下摆最大前倾角（弧度）。`<= 0` 关 —— 见 `SecondaryOptions.hemFwdDeg` */
    hemFwdAmp: number;
    /** 诊断：本帧下摆通道真正作用的骨数 / 平均高度权重 */
    hemN: number;
    hemW: number;
    /** 裙摆下摆骨（`Skirt_*` 里不属于袖布、且竖直位置落在下摆窗口内的那些）。见 `windHem` */
    hemSel: Uint8Array;
    /** 每根下摆骨的**高度权重**（0=最底满额，1=到窗口上界归零），构建期算好 */
    hemWgt: Float32Array;
    /** 下摆通道的速度归一量（0..1），与侧摆/外撑同一口径 */
    hemAmt: number;
    _hemRootPrev: Float32Array;
    /* ── ★★★ 落脚脉冲（用户 m07388「每一步的脚落地，衣摆和头发都会整体向上
     *   和向四周飘一下……循环往复」）───────────────────────────────────────
     *
     * 参考视频实测（`_tools\hem_pulse_probe2.py` + `_tools\fold_pulse.py`，
     * `_logs\hemref\p2_side.jsonl`，侧视 60fps、541 帧）：
     *   · 落脚周期 **1.163 s/单步**（地面蓝色涟漪峰值 t=3.23/4.40/5.57/6.73/7.88/9.05，
     *     interval 1.163±0.007）；频谱主峰 0.887 Hz、次峰 1.774 Hz(=2×) ⇒ 每步一次脉冲。
     *   · 相位折叠（phase 0 = 涟漪出现）：
     *       `dH`（下摆离地）pp **46.5 px**，峰值落在 phase **0.98**（≈ 落脚瞬间）；
     *       `dHair`（发梢离地）pp **73.3 px**，峰值同样在 phase **0.98**；
     *       `hemW`（下摆横向跨度）pp **84.8 px**（均值 125.4，+67.6%），峰值 **phase 0.65**
     *       —— 比垂直抬升晚 **0.65 步 ≈ 0.76 s**。
     *   · 像素→米：白裙包围盒高 239 px ≈ 1.62 m ⇒ 6.8 mm/px。
     *     于是下摆垂直 pp ≈ 0.32 m、头发 ≈ 0.50 m、横向跨度 ≈ 0.58 m。
     *
     * ★ 为什么以前完全没有这个动作（结构性根因）：本文件里所有通道
     *   （`flareAmt` / `sideAmt` / `hemAmt` / `sideOsc`）都只由**角色水平速度**驱动，
     *   与「脚落地的时刻」**没有任何锁相关系** ⇒ 匀速走路时它们都是常数，
     *   所以每步落地时不会有一次性脉冲。
     *
     * ★ 实现要点：衣摆/头发是**下垂**的链（骨方向≈−Y）。「整体向上」和「向四周」
     *   其实是**同一个旋转**：把骨方向从竖直向下朝「该骨的径向外侧」转开 θ 角，
     *   竖直分量变小（= 抬高）、水平分量变大（= 外扩）。所以只用一个角度就够了，
     *   不需要分别做「升」和「张」。转轴 = `径向水平方向 × up`（见逐骨那段）。
     *   两个不同包络的角度叠加：
     *     `landLiftAmp`   —— 紧跟落脚（上升 0.04 步、衰减 0.35 步），对应 `dH/dHair`；
     *     `landSpreadAmp` —— 滞后 0.65 步的高斯包，对应 `hemW` 的晚峰。
     *
     * ★ 权重 `landWgt`：按**各组自己的**竖直跨度取「最低 `landHi` 比例满额」，
     *   裙摆与头发各自归一（两者绝对高度差太多，共用一个 span 会把头发全打到 0）。
     *   ⚠️ 用**相对**比例而不是绝对高度 —— 与 `hemWgt` 同一个理由（换缩放/换姿势不失效）。
     *
     * 回滚：`?secland=-1`（或 0）⇒ `landLiftAmp = landSpreadAmp = 0`
     *   ⇒ 逐骨那段整块跳过、`landN` 恒 0，与改动前**逐位一致**。 */
    /** 本帧的落脚脉冲强度（0..1，两个包络的较大值），仅诊断用 */
    landPulse: number;
    /** 「抬高」包络的最大角（弧度）。`<= 0` = 整条通道关闭 */
    landLiftAmp: number;
    /** 「外扩」包络的最大角（弧度）。`<= 0` = 该包络关闭 */
    landSpreadAmp: number;
    /** 头发相对裙摆的额外增益（参考视频 `dHair` pp 是 `dH` 的 1.58×，缺省 1.35） */
    landHairK: number;
    /** ★ 第四十二轮：头发骨尾**世界 Y 绝对底限**（`?hairfloor=`，0 = 关闭，逐位回滚）。
     *  理由（用户 m10457 / m11243）：「走路时头发最低落点穿模，抬高低点即可」。
     *  与 `landLiftAmp` 的差别：那是**高斯脉冲**，脉冲之间归零 ⇒ 低点从来没被抬过；
     *  这里给一个**常量底限**，任何时刻骨尾低于它就补抬，只作用于头发。 */
    hairFloor: number;
    /** 每根骨的落脚权重（0 = 不吃，1 = 满额），构建期算好。裙摆与头发各自归一 */
    landWgt: Float32Array;
    /** 外扩专用权重（**反高度梯度**：裙摆上段满额、下段降到 `spBias`）。见分类块注释 */
    landSpreadWgt: Float32Array;
    /** 外扩权重的下段偏置（缺省 0.25）：下摆最末一截也微张，不至于死贴 */
    landSpBias: number;
    /** 本帧真正被落脚脉冲转动的骨数 / 平均角度（诊断：与「参数没读进来」区分） */
    landN: number;
    landDeg: number;
    /** 构建期实际建起来的落脚骨数（0 ⇒ 分类没命中，与「幅度为 0」可区分） */
    _landN: number;
    /** 本帧真正把落脚增量叠进写回旋转的骨数（诊断；回滚时恒 0） */
    landApplied: number;
    /* 两条包络的相位/宽度（一步的比例），构建期从 `SecondaryOptions` 定下 */
    _landLiftPh: number;
    _landSpreadPh: number;
    _landLiftW: number;
    _landLiftD: number;
    _landSpreadW: number;
    /** 本帧两条包络各自的强度（0..1，诊断用；`landPulse = max(两者)`） */
    _landLiftE: number;
    _landSpreadE: number;
    /** ★ 第二十二轮：**头发专用的两条包络**（相位相对步态错开 `hairPh`）。
     *  用户：「头发扬起到落下并非完全和步态阶段重合，实际是和步态错开几拍」。
     *  裙摆仍用 `_landLiftE/_landSpreadE`，头发用这两个 ⇒ 两条独立时间线。 */
    _hairLiftE: number;
    _hairSpreadE: number;
    /** ★ 头发相位相对步态的偏移（步内相位单位；负 = 提前扬起。缺省 −0.25） */
    hairPh: number;
    /** ★ 第二十二轮：**起步脉冲**用的时间轴（秒）。
     *  调用点写：起步后经过的秒数；站定/停步时写 **−1**（表示"不在起步期"）。
     *  用途：`_hairLiftE` 叠一个 `exp(-startT/0.45)`，保证「开始走那一下头发一定先扬」
     *  —— 只靠相位偏移不够，因为起步瞬间周期性包络可能正好在谷里。 */
    startT: number;
    /** 起步脉冲的当前值（诊断） */
    _hairKick: number;
    /** ★ 本帧**未经落脚脉冲**的静止目标方向（世界单位向量）。
     *  与 `sideBaseDir` 同一套用法：写回时用「基准 → 最终」算增量四元数左乘上去，
     *  免得被回正弹簧/限角/碰撞吃掉（见 `sideBaseDir` 的长注释与十四轮教训）。
     *  全 0 = 该骨本帧没走落脚通道 ⇒ 走原路径，逐位不变。 */
    landBaseDir: Float32Array;
    /* ★ 第四十二轮：头发底限的「施加前方向」，写回时用它算增量四元数 */
    floorBaseDir: Float32Array;
    /** ★★★ **步态相位**（0..1 整循环 = 两步；0 与 0.5 各是一脚落地）。
     *  由调用点在**推进播放头之后**写进来 —— 用 `dist/STRIDE` 的模而不是墙钟，
     *  于是「脚步落地」与「衣摆脉冲」天然同锁，定格出图也能逐位复现。
     *  不写（保持 NaN）⇒ 落脚脉冲整块不跑 ⇒ 与改动前逐位一致。 */
    stepPhase: number;
    /** ★ 第二十二轮：**起步渐入权重**（0..1）。调用点每帧写进来。
     *  0 = 刚起步/站定 ⇒ 三条布料通道的幅度乘 0（不跑）；
     *  1 = 正常走路 ⇒ 满幅。中间是 0.35 s 的线性斜坡。
     *  用途：硬开关会让起步那一帧布料"啪一下"出现（用户提到「格外注意开始走的那一下」）。
     *  ⚠️ 只乘**幅度**，不改相位的供给条件（站定仍喂 NaN，见 `stepPhase` 的注释）。 */
    gaitW: number;
    /* ── ★★★ 第二十一轮：整片布（披风 / 带）「左右同向飘」──────────────────
     *  用户原话（m01984）：「披风这块布运动时应该是**一个整体** —— 飘动时两半
     *  向**同一方向**（左/右）飘，而不是各走各的方向。同样情况（两块布但运动同向）
     *  的还有**带**。」
     *
     *  为什么旧通道做不到：侧摆/外扩/落脚脉冲全部用**每根骨自己的径向**
     *  （`radial = 骨原点 − 体轴`）决定朝哪边转。披风与带是**左右各一片**：
     *  左片径向朝左、右片朝右 ⇒ 两片必然**反向**张开（实测 corr −0.95 = 各走各的）。
     *
     *  做法：所有片骨绕**同一条轴**（角色前后轴 `_vFwd`）转**同一个角**
     *  `pieceAmp × pieceOsc`。轴与符号都与骨无关 ⇒ 左右两半一起朝同一侧摆。
     *  相位跟步态走（一个循环左右各荡一次）：`sin(2π·步内相位 + piecePh)`。
     *
     *  ⚠️ 分片必须按**材质**、不能按骨名：本模型 `Skirt_0_1` 一个名字有 20 个实例
     *  （546 根 `Skirt_*` 里 92 个重名）。材质归属见 `collectPieceSel()`。
     *  ⚠️ **`pieceBaseDir` 必须每帧清零** —— 见逐骨循环里那段备忘。 */
    /** 片 1 = 披风（材质名含 `披风`、不含 `披风饰`） */
    pieceSel: Uint8Array;
    /** 片 2 = 带（材质名含 `带`） */
    ribbonSel: Uint8Array;
    /** 整片摆动的最大角（弧度）。`<= 0` = 关闭 */
    pieceAmp: number;
    /** ★ 第二十九轮：带（编号8）吃 piece 通道的系数。0 = 不吃（= 步态V3 行为）。 */
    pieceWRib: number;
    piecePh: number;
    /** 本帧被整片通道转过的骨数 / 平均角（诊断） */
    pieceN: number;
    pieceDegNow: number;
    /** 本帧真正把整片增量叠进写回旋转的骨数（诊断；关闭时恒 0） */
    pieceApplied: number;
    /** ★ 整片布「未整片摆动之前」的静止方向（世界单位向量）。
     *  与 `sideBaseDir`/`landBaseDir` **同一套用法**：写回时用它算增量四元数左乘，
     *  免得被回正弹簧/限角/碰撞吃掉。全 0 = 该骨本帧没走整片通道 ⇒ 走原路径。 */
    pieceBaseDir: Float32Array;
    /** 构建期选中的披风骨数 / 带骨数（诊断。⚠️ 必须挂在 rig 上：
     *  `updateSecondary` 是独立函数，看不到 `createSecondaryMotion` 的局部变量）。 */
    pieceCapeN: number;
    pieceRibbonN: number;

    /* ── ★★★ 第二十二轮：披肩（编号4）「**整片一起摆**」──────────────────────
     *  用户原话：「cloth_map_view.jpg 中编号4 你确实是向前摆动了，但是**只有最下部分摆动**。
     *  这布料是一个整体，不是上面不动下面往前动。而且**摆动幅度有点大**。」
     *
     *  为什么原来只有下部分动：披肩的骨挂在手臂父链上 ⇒ 被算进「袖骨」那一组，
     *  而袖子的推量带**高度减推** `hw = 1 − sideHiK·(1 − hn)`（`sideHiK` 缺省 0.55，
     *  低于 `sideHiLo` 的骨只推 45%）。这本来是防「袖子撞裙摆」的设计，
     *  但对披肩不成立 —— 披肩是一片布，上段不动就变成"下面被拽着走"。
     *
     *  做法：独立一片（`shawlSel`），**不用任何高度权重**（整片同权 1.0），
     *  绕前后轴 `_vFwd` 转同一个角，幅度另给旋钮（`?secshawl=`，可单独降）。
     *  ⚠️ 必须每帧清零 `shawlBaseDir`（第二十轮那条硬规矩）。 */
    shawlSel: Uint8Array;
    /** 披肩整片摆动的最大角（弧度）。`<= 0` = 关闭（披肩回到袖子通道里按老样子动） */
    shawlAmp: number;
    /** 披肩摆动的相位（0..1 整圈；缺省与披风一致 = 0） */
    shawlPh: number;
    shawlN: number;
    shawlDegNow: number;
    shawlApplied: number;
    /** 披肩「未摆动之前」的静止方向（世界单位向量），写回时算增量四元数用 */
    shawlBaseDir: Float32Array;
    /* ★ 第二十八轮：披肩**刚性整片**（编号4「整片一起飘」）。
     *  `shawlRigid` 0/1 开关，`shawlRigidAmp` 是弧度（已除 DEG）。 */
    shawlRigid: number;
    shawlRigidAmp: number;
    /** 片根骨下标（构建期算，-1 = 没有披肩）。刚性整片以它为驱动源。 */
    shawlRoot: number;
    /** 每骨相对片根的**站定偏移**四元数（n*4，xyzw）。第一帧采一次，之后不变。 */
    shawlOff: Float32Array;
    /** 每骨的**第一帧方向**（n*3，角色空间）。整片刚性摆动的基准形状。 */
    shawlBase: Float32Array;
    /** 0 = 偏移还没采到；1 = 可用。 */
    shawlOffOk: number;
    /** ★ 第二十九轮：披肩**整片前移**角（弧度）。0 = 关。 */
    shawlPush: number;
    /** 前移方向符号（±1），几何约定要实测。 */
    shawlPushSign: number;
    /** 走路时叠加在 前移角 上的小幅摆动（弧度）。 */
    shawlPushOsc: number;
    /** 本帧实际前移角（诊断用）。 */
    shawlPushDegNow: number;
    /** 本帧前移生效骨数（诊断用）。 */
    shawlPushN: number;
    /** 构建期选中的披肩骨数（诊断） */
    shawlBones: number;
    /**
     * ★★★ 第二十四轮 v3：每根布料骨属于哪一类布（**构建期算一次**）。
     *  0 = 其它 / 1 = 头发 / 2 = 披风 / 3 = 带 / 4 = 披肩 / 5 = 裙 / 6 = 袖
     *
     *  为什么必须单独存：`auditClash` 的分组只认 `driveSel` 与 `/Skirt/`，
     *  **头发不进任何一组** ⇒ 「头发穿进裙/披风」从来没有读数（用户 m02740 指出，
     *  看图确实明显，但账本上是 0）。有了这张表才能量。
     *  判法与 `collectPieceSel` 同源：材质名优先（`pieceSel/ribbonSel/shawlSel`），
     *  头发按骨名 `Hair|髪`，裙按 `/Skirt/` 且不是片布、不是袖。
     */
    matGroup: Uint8Array;

    /** ★ 第二十六轮 T1-I3：逐碰撞体的腿/身缩放倍率（缺省 1）。
     *  这个数组从第二十四轮起就在 `:1612` 建、`:2527` 塞进 rig 字面量、
     *  `:929` **读**，但一直没写进 `SecondaryRig` 接口 ⇒ `strict` 下
     *  TS2339（读）+ TS2353（字面量多字段）。补上接口即消。
     *  ⚠️ 只是补类型声明，运行期行为一个字节不变。 */
    colMul: Float32Array;

    /** ★ 第二十五轮：三片布的刚度乘数（诊断用；缺省 1） */
    stiffCape: number;
    stiffRibbon: number;
    stiffShawl: number;
    /** ★ 第二十五轮 C：一致化强度（四片，诊断用） */
    netCape: number;
    netRibbon: number;
    netShawl: number;
    netSkirt: number;
    /** ★ 第二十五轮 C：本帧每条骨的**解算方向**（世界单位向量），供子骨做一致化 */
    solDir: Float32Array;
    /** ★ 第二十五轮 C：每骨的一致化强度（0 = 不走）。
     *  父骨下标用上面第 77 行那个 `parentIdx` —— 第二十六轮 T1-I4 修：
     *  这里原先**又声明了一遍** `parentIdx: Int32Array;`，是同一个数组，
     *  `tsc` 报 `TS2300 Duplicate identifier 'parentIdx'`。 */
    netA: Float32Array;
    /** ★ 第二十六轮：**同片**父骨下标（−1 = 本片最根 / 不走一致化）。
     *  `?secnet*=` 只许混这个，混 `parentIdx` 会把披肩拉平成「翅膀」。 */
    netParent: Int32Array;
    /** ★ 第二十五轮 C：本帧真被一致化的骨数 */
    netN: number;
    /** ★ 第二十五轮 D：压住飘动（见 `SecondaryOptions.holdCape`） */
    holdCape: number;
    holdRibbon: number;
    holdShawl: number;
    holdSkirt: number;
    /** 站定姿态方向（运行期自采，用于朝它混合）；未采到时全 0 = 不走 */
    holdDir: Float32Array;
    /** 每骨的压住强度（0 = 不走） */
    holdA: Float32Array;
    /** 站定姿态是否采过（未采到时 hold 通道整段不执行） */
    holdReady: boolean;
    /** ★ 第三十二轮 c：站定采样**累加器** —— 见 `holdDir` 注释里的抖动根因。 */
    holdSum: Float32Array;
    /** 已累加的站定帧数（到 `HOLD_AVG_N` 后用平均方向）。 */
    holdFrames: number;
    /** 本帧真被压住的骨数 */
    holdN: number;    /* ── ★★★ 第二十四轮 v3：头发径向让位（`?hairsep=`）────────────────────
     *  实测（`_tools/hairradial.js`，5181）：1.0 m 高度处**头发半径 0.230 m、
     *  裙半径 0.227 m** —— 两者占同一空间 ⇒ `hairClash` 最近距离 0.3 mm（已互穿）。
     *  已有的 `?secrepel=` 按骨棒最短距离推，方向可能是竖直的，对这里无效（扫了 4 档）。
     *  本通道换成**径向分层**：只推头发，布料一根都不动。 */
    /** ★ 第二十四轮 v4：弹簧刚度/限角的乘数（原值，供探针核对，见 `SecondaryOptions.stiffK`） */
    stiffK: number;
    limitK: number;
    kHair: number;
    kSkirt: number;
    kOther: number;
    /** ★ 本帧刚度均值（每帧从 `stiff[]` 重算，证明乘数真的进了数组而不只是常量） */
    stiffMean: number;
    /** 头发让位的目标间隙（米，`?hairsep=`，缺省 0.02；`0` 关） */
    hairSep: number;
    /** 每根头发骨的「同高度带布骨」邻居区间（CSR；不在高度带的头发为空区间） */
    hairSepStart: Int32Array;
    hairSepList: Int32Array;
    /** 本帧真正让位的头发骨数（诊断） */
    hairSepN: number;
    /** 本帧累计让位角（度，诊断） */
    hairSepDeg: number;
    /** ★ 头发让位的**增量基准**（世界单位向量）—— 与 `shawlBaseDir`/`landBaseDir` 同一套用法。
     *  ⚠️ 必须每帧清零（第二十轮那条硬规矩）。
     *  为什么需要它：只改 `_vRest` 时，`dx/dy/dz` 在本骨段更早处已定稿，改的只是**下一帧**的
     *  目标，而下一帧弹簧又拉回去 ⇒ 稳态几乎不动的实测证据见 `hairsep` 的注释。 */
    hairBaseDir: Float32Array;
    /** 本帧真正把头发增量叠进写回旋转的骨数（诊断） */
    hairApplied: number;
    /** ★ 第四十四轮：`?hairsolve=` 开关的落点（1 = 头发**不**走二次运动解算 = 纯动画姿态）。
     *  放 rig 上而不是直接读 `opts`：热循环在 `updateSecondary()` 里，那里拿不到 `opts` 作用域。 */
    hairSolveOff: number;
    hairFloorAnim: number;
    /** 本帧因「纯动画」被早退掉的头发骨数（诊断：证明分支真的执行了，别又静默不跑） */
    hairAnimOnly: number;
    /**
     * ★★★ 第二十四轮：四片布（1袖 / 4披肩 / 6披风 / 8带）的**总幅度乘数**。
     *  已经乘进 `pieceAmp` / `shawlAmp` / `sideAmp` / `sideOscAmp` 四条幅度里，
     *  这里只留一份**原值**给探针核对「URL 参数真的读进来了」——
     *  「参数打印正确 ≠ 功能生效」这条坑本文件踩过 3 次（见第 1600 行那段注释）。
     */
    clothAmp: number;

    /* ── ★★★ 第二十一轮：裙子被大腿「顶起来往前飘」────────────────────────
     *  用户原话（m01984）：「编号3 裙。裙最下部在大腿位置，走路时会被大腿
     *  **顶起来往前飘**；如果不往前飘就会穿模大腿。」
     *
     *  做法：真裙摆里落在 **thigh 高度带**、且位于身体**前侧**的那一段，
     *  按「大腿前摆量」朝**前**转 `thighAmp × thighAmt × 前侧权重`。
     *  每迈一步、同侧大腿抬起时，前面那片裙摆就主动向前让开 ——
     *  既是用户描述的动作，也是防穿模的正解（布先让开，而不是等碰撞体硬推）。 */
    /** 裙摆 thigh 高度带的选择 + 前后侧权重 */
    thighSel: Uint8Array;
    thighWgt: Float32Array;
    /** thigh 前顶的**符号**（±1）。必须挂在 rig 上（`updateSecondary` 看不到局部常量）。 */
    thighSign: number;
    /** thigh 通道最大角（弧度）。`<= 0` = 关闭 */
    thighAmp: number;
    /** 本帧的 thigh 驱动量（0..1，已按运行时包络归一；站定恒 0） */
    thighAmt: number;
    /** ★ 分侧驱动量（诊断 + 逐骨验收用）。`thighAmt` 是两者的 max，
     *  而左右裙骨各自只在同侧腿抬起时前顶 ⇒ 验收必须按侧配对，不能拿 max 求相关。 */
    amtL: number;
    amtR: number;
    _thighMinL: number;
    _thighMaxL: number;
    _thighMinR: number;
    _thighMaxR: number;
    /** 本帧被 thigh 通道转过的骨数 / 平均角（诊断） */
    thighN: number;
    thighDeg: number;
    thighApplied: number;
    /** ★ thigh 驱动量的**运行时自标定包络**（`raw` 的 min/max，慢落快升）。
     *  为什么必须自标定：大腿方向在「绑定姿势」与「站立姿势」下本来就有常偏，
     *  直接 `raw/0.45` 会在站定时给出 **1.0**（实测症状：站着也在把裙摆往前顶）。 */
    _thighMin: number;
    _thighMax: number;
    /** ★ thigh 通道「未前顶之前」的静止方向（世界单位向量）—— 同 `pieceBaseDir` */
    thighBaseDir: Float32Array;

    /* ── ★ 碰撞体（PMX 自带的 34 个 `mode === 'static'` 刚体）──
     * 这是「穿模」的真正解药：弹簧骨只会跟着父骨摆，腿从裙子里穿出来它是不管的，
     * 只有把腿做成胶囊、把布料粒子推出去，裙子才会被腿顶开。
     *
     * ★★ 判据 R（用户 m11046 任务2）：**「写了碰撞」≠「碰撞生效」**。
     *    三个会让碰撞悄悄失效的坑，都已修掉：
     *    ① `colSlack`（旧名 `colSkip`）曾是「第一帧只要碰到就**永久**屏蔽」——
     *       裙摆骨架本来就贴着腿建模，于是这些骨×腿对被永远豁免，腿扫过来也不顶。
     *       现在改成**松弛量**：允许它停在「静置时本来就有的那点插深」，
     *       但一旦比静置更深就立刻推出去。
     *    ② 推出后要按骨长把方向归一化，这一步会把推出的成果**吃回去**；
     *       现在迭代 `iterations` 次直到不再穿透。
     *    ③ PMX 的静止刚体是给物理引擎用的**粗代理**，比可见网格细一圈
     *       （实测胸 7.1 cm、髋 6.8 cm、大腿 7.1 cm 半径）。
     *       `colScale`（`?seccols=`，缺省 1.35）把半径放大到贴住可见表面。
     */
    /** 碰撞体挂在哪根骨上（就是发丝/裙摆该躲开的那根骨：头、胸、腰、肩、臂、腿） */
    colBone: THREE.Bone[];
    colN: number;
    /** 碰撞体中心在**宿主骨局部空间**的位置（初始化时用世界矩阵反解，PMX 原始单位） */
    colLocal: Float32Array;
    /** 半径（PMX 原始单位；运行时乘世界缩放） */
    colR: Float32Array;
    /** 胶囊圆柱段半长（PMX 原始单位；球体为 0） */
    colHalf: Float32Array;
    /** 胶囊轴在**宿主骨局部空间**的单位向量（球体无意义） */
    colAxis: Float32Array;
    /** PMX 原始数据（每体 6 个 float：中心 xyz + 欧拉 xyz），初始化那一帧才反解到骨局部空间 */
    colPmx: Float32Array;
    /** 形状（0 球 / 1 盒 / 2 胶囊） */
    colShape: Uint8Array;
    /** ★ 每根骨 × 每个碰撞体的**松弛量**（米；`n × colN`）
     *  = 初始化那一帧本来就插进去的深度。比它更深才算「腿扫过来了」，才推出去。
     *  0 = 静置时没碰到 ⇒ 永远生效（与旧的「永久屏蔽」语义相反）。 */
    colSlack: Float32Array;
    /** ★ 碰撞体半径放大系数（贴住可见网格；`?seccols=`） */
    colScale: number;
    /** ★ 单对允许的最大静置嵌入深度（米；`?secslackmax=`，缺省 0.015）。
     *  穿模深度因此有了硬上界：任何一对都不可能比它更深还留在原地。 */
    slackMax: number;
    /** ★ 推出迭代次数（`?seciter=`）；1 = 旧行为 */
    iterations: number;
    /** ★★ 碰撞检测的**骨棒采样点数**（`?secrod=`，缺省 4；`1` = 只测骨尾 = 旧行为）
     *
     *  背景（用户 m13789「走路时前面衣料和袖子穿模。还没修」）：
     *  旧版每根弹簧骨**只把骨尾那一个点**拿去和身体胶囊比对（见 `updateSecondary`
     *  里 `pen = R - dd` 那一段）。可是布料是一片**面**：网格顶点挂在骨链上，
     *  相邻两根骨的骨尾之间是一整条四边形带。腿扫过来时，胶囊完全可以**从两根骨
     *  之间穿过**——此时每一根骨的骨尾都还在胶囊外面（`maxPenVis = 0`，
     *  见 `_logs/walkcollide.jsonl`），面却被扎穿了。这就是「判据说没穿、眼睛说穿了」。
     *
     *  这里改成沿「父骨原点 → 骨尾」的骨棒取 `rodSamples` 个点（`s = 0.5 … 1.0`，
     *  靠骨头的头端不测：头端钉在父骨上，推不出去）一起测，取最深的那个来推。
     *  推动量按 `1/s` 放大（把 `s` 处的采样点推到胶囊表面，骨尾要推得更远），
     *  再交给原来的「按骨长归位 + 迭代」收敛。
     *
     *  为什么 `s` 从 0.5 起步：`1/s` 的放大倍数，`s` 越小越离谱（头端附近要靠骨尾
     *  的旋转去顶开，物理上顶不动），所以只保护「骨棒后半段 + 骨尾」。
     */
    rodSamples: number;
    /* ── ★★★ 布-布斥力（`?secrepel=`，用户 m15017「布-布斥力你做一个我看看效果」）──────
     *  背景：这个求解器原本**只**做「布料 × 身体胶囊」，**布片与布片之间没有任何排斥**。
     *  `clashAudit` 量到的现状（走路 3.2 s、每 40 ms 一次）：不同组骨棒最近 **0.17 mm**、
     *  每个相位都有 **94~165 对**骨棒在 2 cm 以内 —— 长袖叠裙摆、裙片互相叠时只能直接穿过去。
     *
     *  做法：给每根弹簧骨预建一张**静态邻接表**（`repelStart` / `repelList`，CSR 结构）：
     *  在**静止姿势**下骨尾距离 < `repelCut`（缺省 22 cm）、且两者在骨链上相隔 > 3 跳
     *  （同一个骨链上的相邻骨本来就贴着，不能互斥）的骨对才收进来。
     *
     *  每帧在「身体碰撞 + 方向性约束」之后跑一遍：对 `j < i` 的邻居（`j` 的骨尾本帧
     *  已定稿、`particle[j]` 就是它最终位置），把 `i` 的骨尾沿「互相远离」方向推开
     *  `(repelD − d)/2`，再把方向重新归一化（骨长不变）。
     *  只推一半 + 只推 `j < i` 这一侧 ⇒ 等价于「每帧各让一半」，但没有顺序依赖，
     *  也不用重建整条链的世界矩阵。多帧下来两侧会各自让开。
     *  `repelW`（`?secrepelw=`）是整体强度，`0` 或 `repelD = 0` 就完全关掉。
     */
    /** 斥力作用距离（米；`?secrepel=`，缺省 0.010，0 = 关） */
    repelD: number;
    /** 建表用的**当前帧**距离上限（米；`?secrepelcut=`，缺省 0.06）。
     *  注意这里比的是**双向点到线段**距离（与 `auditClash` 同一判据），靠得比它更近的
     *  骨对才进邻接表 ⇒ 每帧只测几百到几千对。 */
    repelCut: number;
    /** 斥力强度（`?secrepelw=`，缺省 1） */
    repelW: number;
    /** 邻接表每隔几帧重建一次（`?secrepelevery=`，缺省 8） */
    repelEvery: number;
    /** 距离下次重建还有几帧 */
    repelNext: number;
    /** 当前邻接表里的骨对总数（探针用） */
    repelCount: number;
    /** CSR：第 i 根骨的邻居在 `repelList` 里的区间是 `[repelStart[i], repelStart[i + 1])` */
    repelStart: Int32Array;
    repelList: Int32Array;
    /** 建表用的临时数组（避免每 8 帧产生垃圾） */
    _rHead: Float32Array;
    _rTail: Float32Array;
    repelDeg: Int32Array;
    repelFill: Int32Array;
    /** 建表时收集的候选对（`[i0,j0,i1,j1,…]`，容量 `n*n/8`，一次分配复用） */
    repelPairsRaw: Int32Array;
    /** 邻接表是否已建好 */
    repelReady: boolean;
    /** 上一帧被推开的骨数 / 最大单根推开量（米）—— 探针用 */
    repelHits: number;
    repelMax: number;
    /* ── ★★ 方向性约束：用户 m11933 ──────────────────────────────────────────
     *  用户原话：「原神里哥伦比娅走路时，身后衣服头发正常摆动，**身前的衣服基本不摆动，
     *            自然下垂飘动，甚至会向前摆动（被腿走路时顶起来，会向前摆动一下）**」。
     *
     *  ★ 先搜再做（用户 m11937）：这不是我们独有的问题，业界有两个成熟解法，都指向同一个
     *    结论——**「悬挂件不许朝身体方向摆」是一条方向性硬约束，不能只靠碰撞**：
     *
     *    ① MagicaCloth（Unity）的 **Surface Penetration / Collider Penetration**：
     *       「Surface penetration constraints let you set the distance that particles can
     *        penetrate in the specified axes (XYZ) … each particle is restricted so that it
     *        cannot penetrate more than a certain amount in the negative Z direction」。
     *       https://magicasoft.jp/en/prevent-penetration-2/
     *    ② Maya 裙摆 rig 的「前後左右に分解して制御」（C&R Creative Studios）：
     *       「前部分のスカートの骨は、足がキャラクター後方に回ったとしても、真下の向きより
     *        も後ろ側に動いてほしくないし、右側のスカートも同様に左側へ挙動してほしくない」
     *       —— 做法就是把驱动量按**前后 / 左右两个平面**分解成权重再混合。
     *       https://3d.crdg.jp/tech/archives/231
     *
     *  统一成一句话：**每根悬挂骨只允许「离开身体」的方向自由摆动，朝身体方向最多偏
     *  `axisTol`。** 前侧骨（在身体前方）⇒ 不许比动画方向更靠后；
     *  后侧骨 ⇒ 不许比动画方向更靠前（于是走路的惯性把它甩到身后 = 正常摆动）；
     *  左侧骨 ⇒ 不许越过中线到右侧，反之亦然。
     *
     *  与碰撞的分工：碰撞管「腿扫过来把裙子顶开」（会把前襟**向前**推，正是用户要的
     *  「被腿顶起来向前摆动一下」），方向性约束管「风和惯性不许把前襟吹到身后」。
     *  两者方向一致，不冲突，所以约束放在碰撞之后当最后一道。
     */
    /** 角色朝向在**骨架根局部空间**的单位向量（由「左足首 → 左つま先」自标定，不依赖参数） */
    fwdLocal: Float32Array;
    /** 角色侧向在骨架根局部空间（= up × fwd） */
    sideLocal: Float32Array;
    /** 每根骨受约束的轴：0 = 前后轴，1 = 左右轴，2 = 不受约束 */
    axisSel: Uint8Array;
    /** 该骨**绑定姿势**的悬挂方向在受约束轴上的分量（诊断用：解释为什么 `fr` 会是负的） */
    restAxis: Float32Array;
    /** 「离开身体」的那个方向（+1 = 该轴正方向朝外，−1 = 负方向朝外） */
    axisSign: Float32Array;
    /** 朝身体方向允许偏出的量（该轴的分量；= sin(antiDeg)）。0 = 完全不许偏 */
    axisTol: number;
    /** 是否**真的应用**约束（`?secanti=-1` 关）。关掉时分类仍然算出来，供 A/B 对照测量 */
    antiOn: boolean;
    /** 诊断：本帧被约束修正过的骨数 */
    antiHits: number;
    /** 诊断：本帧最大的约束修正角（度）。> 0 才说明约束真的起了作用 */
    antiMaxDeg: number;

    /* ── ★★ 肢体驱动的「向前摆」（用户 m12638 / m12655）──────────────────────────
     *  用户口径（原话）：
     *    「走路时，胳膊，腿会向前摆动，所以，身前的衣服，袖子一定是跟随着向前摆动的，
     *      否则一定穿模。袖子跟着胳膊前后摆，而身前的衣服一定是向前摆——原地来回」
     *    「身前的衣服，当手和腿向前时，身前的衣服提前向前摆，当手和腿向后时，衣服回到原地。
     *      向前到原地，在两者之间来回摆动」
     *
     *  即：前侧悬挂件的正确运动是 **单向的** ——「向前 ←→ 回原地」之间来回，
     *  **永远不到原地之后**。而驱动它的不是风、不是惯性，是**腿和胳膊的向前摆动**。
     *
     *  做法：每帧量出「大腿/上臂的世界朝向相对它绑定姿势向前摆了多少」，
     *  把它换算成一个**绕侧向轴的旋转**，加在 `_vRest`（弹簧目标 + 限角基准）上。
     *  腿向前 ⇒ 目标方向被压向前 ⇒ 前襟真的向前摆；腿向后 ⇒ 驱动量 0 ⇒
     *  弹簧把布片拉回动画方向（= 原地），方向性约束再兜住「不许更靠后」。
     *
     *  分类 `driveSel`：
     *    0 = 不驱动
     *    1 = **胳膊驱动**（父链经过 `左/右腕|ひじ|手首`）—— 袖子/护腕一类，
     *        必须完全跟着胳膊前后摆，所以**同时豁免方向性约束**（否则胳膊向前摆、
     *        袖子被约束卡住 ⇒ 胳膊从袖子里穿出来，正是用户说的「否则一定穿模」）
     *    2 = **腿驱动的前侧件**（体位分类里 `axisSel === 0 && axisSign > 0`）—— 前襟/前裙
     */
    /** 每根骨的驱动分类：0 无 / 1 胳膊驱动 / 2 前侧（腿驱动） */
    driveSel: Uint8Array;
    /** 最大驱动角（弧度）。`?secdrive=0` 关 */
    driveAmp: number;
    /**
     * ★★ 相位超前（秒）—— 用户 m12822：「当手和腿向前时，身前的衣服和袖子等衣料，
     * **提前**向前运动，不必一定要等手和腿驱动」。
     * 做法：`驱动量 = clamp(当前摆幅 + 超前秒数 × 摆幅变化率)`（一阶预测 `x(t+τ)`）。
     * 腿还在往回撤、但已经开始加速向前时，超前项就已经 > 0 ⇒ 布片**先动**；
     * 腿开始往回摆时驱动量**先归零** ⇒ 布片提前回原地。`?secdrivelead=0` 关（纯跟随）。
     */
    driveLead: number;
    /** 内部：诊断/超前用的滤波后摆幅变化率与上一帧摆幅（[0]=腿 [1]=臂） */
    _driveRate: Float32Array;
    _drivePrev: Float32Array;
    drivePrevInit: boolean;
    /** 内部诊断：[左足,右足,左腕,右腕] 四个关节的**原始**前后摆量（未归一、未取 max） */
    _limbSwing: Float32Array;
    /**
     * 内部：摆幅的**自标定包络**（[0]=腿 [1]=臂）。
     * ★ 为什么不写死除数：第一版用「肥腿摆幅 ≈ sin27° = 0.45」当除数，实测这条动作
     *   腿的 `max(左,右)` 恒在 [0.30, 0.62] 之间（两腿的摆量都带一个正向偏置，
     *   永远不同时为负），**从来不掉到 0.45 以下** ⇒ 除以 0.45 之后长期饱和在 1，
     *   驱动量被钉死在满值（前襟被恒定全力前压，不随腿摆动）。
     *   改成包络跟踪：**快落慢升**地记住观测到的 min/max，把摆量线性归一到 0..1。
     *   自适应 ⇒ 换角色/换动作/调 `?pace=` 都不用重新定标；
     *   站住不动时包络收拢成一点 ⇒ 驱动量自动归 0（前襟回原地）。
     */
    _limbMin: Float32Array;
    _limbMax: Float32Array;
    /** 诊断：本帧腿驱动量 0..1（无头脚本读它确认驱动真的在跑） */
    driveFwd: number;
    /** 诊断：本帧胳膊驱动量 0..1 */
    driveArm: number;
    /** 诊断：本帧被驱动的骨数 */
    driveN: number;
    /**
     * 诊断：**未经超前**的原始摆幅 0..1（腿 / 臂）。
     * `driveFwd − driveRaw > 0` ⇔ 超前项真的在把驱动往**前**推（也就是说布片比手脚先动）。
     * 验收脚本靠 `driveRaw` 与 `frontMin` 的互相关求出「布片领先手脚多少毫秒」。
     */
    driveRaw: number;
    driveArmRaw: number;
    /** 内部：驱动旋转用的临时四元数 */
    _qDrive: THREE.Quaternion;
    /** 内部：腿/臂的绑定姿势朝向在「前后轴」上的分量（自标定基准） */
    /**
     * ★★ 2026-10-21 用户反馈1：「袖子在走路时和衣服穿模，解决方案，袖子走路时位置向外延申，
     *   避开衣服」。`flareAmp` 是**向外撑开的最大角度（弧度）**，`?secflare=<度>` 调
     *   （缺省 16；`?secflare=-1` 关掉做 A/B）。
     *   只作用于 `driveSel === 1`（父链经过 `左/右腕|ひじ|手首` 的袖子/臂饰那一组）。
     *   量与**角色水平速度**成正比（站定自动归 0，不需要额外的状态机）。
     */
    flareAmp: number;
    /** 内部：本帧的撑开量 0..1（= 水平速度 / `flareSpeed`，已夹到 0..1） */
    flareAmt: number;
    /**
     * 诊断：本帧**实际采用**的水平速度（m/s）—— `max(|vx,vz| 传入值, 骨架根世界位移速度)`。
     * 见 `updateSecondary` 里「兜底：速度信号缺失时不撑」那段。
     */
    flareSpd: number;
    /* ── ★★★ 侧向摆动（用户 m18305「袖子向两侧飘」）────────────────────────
     *  与上面那套**外撑**（`flare*`）是两条独立通道：
     *    flare  = 把静止目标方向朝身体外侧「偏一个固定角度」，跟手掌高低的摆动无关；
     *    side   = 跟着**手掌相对肩膀的左右摆**把袖子朝外荡，并且把前后摆动压掉。
     *  `?secside=-1` ⇒ `sideAmp = 0` ⇒ 运行期整段不跑，逐位回到改前行为。 */
    /** 侧向摆动类别标记（`driveSel === 1` 的那些骨 = 袖子本体） */
    secdriveSel: Uint8Array;
    /** 侧向摆动最大角（弧度）。`?secside=<度>`，缺省 60（本文件 `sideDegRaw` 的兜底与之同值）；`<= 0` 关 */
    sideAmp: number;
    /** 侧向摆满值的水平速度基准（m/s，`?secsidespd=`，缺省 0.9） */
    sideSpeed: number;
    /** 诊断：本帧的侧向摆动量 0..1（速度 smoothstep，站定 = 0） */
    sideAmt: number;
    /** 诊断：本帧被侧向摆动的袖骨数 */
    sideN: number;
    /** ★ 十四轮：本帧把侧摆增量真正叠进写回旋转的骨数（≈ sideN；回滚时恒 0）。
     *  与 `sideN` 分开计数是为了分清「通道算出来了」和「几何真被推动了」。 */
    sideApplied: number;
    /** 诊断：构建期标记的侧向骨数 */
    sideBones: number;
    /** ★ 侧摆时压掉前后摆的比例（0..1），由 `SecondaryOptions.sideFrontKill` 构建期写入。
     *  必须放**这里**：求解器每帧从 `rig` 读它（`const sideKill = rig.sideFrontKill`），
     *  只放在 options 局部量上会读到 `undefined` ⇒ `Math.min(1, undefined) = NaN`
     *  ⇒ 整条侧向通道被 NaN 静默吞掉（踩过）。 */
    sideFrontKill: number;
    /** ★ t16：侧摆里**不随速度归零**的静态份额（0..1），由 `SecondaryOptions.sideStandK`
     *  构建期写入。理由同上一行的 `sideFrontKill`：逐帧路径 `const sideStandK = rig.sideStandK`，
     *  只放 options 局部量会读到 `undefined` ⇒ NaN。缺省 0.55 ⇒ 站定也张开 55% 幅度。 */
    sideStandK: number;
    /** ★ t20 诊断：`sideArm` 里每根关节被捕获时的**世界 y**（米），与 `sideArm` 同序。
     *  只用来给 `?secsidehlo=` / `?secsidehhi=` 做标定，求解器不读它。 */
    sideArmY?: number[];
    /** ★★★ t20：近裙摆减推量。袖骨**节点高度**（父骨世界原点 y，米）落在
     *  `[sideHiLo, sideHiHi]` 区间时线性加权，最低处推量 × `(1 - sideHiK)`；
     *  `sideHiK = 0` ⇒ 逐位回到 t16 的满推（回滚用）。
     *  缺省 `sideHiLo = 0.90`（裙摆上沿附近）/ `sideHiHi = 1.35`（腰线之上满推）/
     *  `sideHiK = 0.55`；对应 `?secsideh=` / `?secsidehlo=` / `?secsidehhi=`。
     *  ★ 为什么这三项必须在 rig 上：逐帧路径要读，只放 options 会读到 `undefined` ⇒ NaN（踩过）。 */
    sideHiK: number;
    sideHiLo: number;
    sideHiHi: number;
    /** ★★★ 十七轮（用户 m12388）：侧展角的**往复振幅**（弧度）。
     *  原话：「袖子侧展其实我们已经做了 8°，不过没有随着摆臂而向外摆动……
     *  可以随着行走时摆臂动作，加入一定角度的往复运动，比如 8° 到 10° 再到 8°」。
     *  ⇒ 侧展角 = 基准 `sideAmp` + `sideOscAmp × 相位`，相位来自该侧前臂在前后轴上的投影。
     *  `?secsideosc=`（度，缺省 2）；`<= 0` ⇒ 关，逐位回到十六轮的常量侧展（可回滚）。 */
    sideOscAmp: number;
    /** 往复相位的参考幅值（前臂前后投影的典型峰值，`?secsideoscref=`，缺省 0.35）。 */
    sideOscRef: number;
    /** 诊断：每侧本帧的摆臂相位（−1..+1，+ = 该侧手臂向前摆）。
     *  ★ 十七轮修：由**两臂之差**得到 ⇒ 两侧恒反相（`ph[0] === -ph[1]`）。 */
    sideOscPh: Float32Array;
    /** ★ 十七轮：本帧的**摆动量** `(dL−dR)/2/ref` 夹到 ±1（已扣掉静态直流偏置）。 */
    sideOscSwing: number;
    /** ★ 十七轮：慢速均值追踪器（扣直流用），时间常数 ~1.4 s */
    sideOscDc: number;
    /** ★ 十七轮：残差包络（自动增益用），上升瞬时、衰减 ~0.6/s，下限 0.05 */
    sideOscEnv: number;
    /** ★ 十七轮诊断：扣掉直流后的残差（相位真正的来源） */
    sideOscR: Float32Array;
    /** ★ 十七轮诊断：左右两侧**原始**前臂前后投影（含直流偏置，仅供查表）。 */
    sideOscRaw: Float32Array;
    /** 诊断：本帧被往复调制的骨数 */
    sideOscN: number;
    /** 诊断用：非空时逐骨明细追加到这里（`?secrows=1` 打开） */
    sideRows?: Array<[number, number, number]>;
    /** 诊断：本帧手掌相对肩膀的侧向偏移（米，+ = 该骨自己那一侧向外） */
    sideRoll: number;
    _sideDbgW?: number;
    _sideDbgRoll?: number;
    _sideDbgAmt?: number;
    _sideDbgSd?: number;
    /** ★ t20：本帧该骨的高度权重（1 = 满推，越小 = 越靠近裙摆） */
    _sideDbgH?: number;
    /** ★ t20 标定：本帧算 `hw` 用的 `_vHead.y`（场景世界坐标） */
    _sideDbgHy?: number;
    _sideDbgDeg?: number;
    _sideDbgSel1?: number;
    _sideDbgHit?: number;
    _sideDbgKids?: number;
    _sideDbgNames?: string;
    /** 诊断：本帧侧摆角的均值（度） */
    sideDeg: number;
    /** ★ 第二十六轮 T1-I4 修：沿角色前进方向的「带势」系数（`SecondaryOptions.carry`
     *  的落盘值，`:2691` 解构、`MmdCharacter.tsx:3905` 读出）。
     *  以前只在运行期塞进 rig 字面量、接口没写 ⇒ 重排字面量就会静默变 undefined。 */
    carry: number;
    /** ★ 第二十六轮 T1-I4 修：**动画姿势**下的静止方向（世界单位向量，每骨 3 个分量）。
     *  `restDirWorld − animDirWorld` = 「求解器把骨骼挪了多少」，`:3391` 写入、
     *  `measureSleevePose` / `measureHem` 读（`:5068`、`:5097`）。补接口声明。 */
    animDirWorld: Float32Array;
    /** ★ 第二十六轮 T1-I4 修：每骨左右标记（0 = 左、1 = 右、255 = 不适用），
     *  构建期按骨名 `^左` / `_L$` / `^右` / `_R$` 打（`:2061-2062`），`:3594` 与
     *  `:5138` 读。补接口声明。 */
    sideOf: Uint8Array;
    /** ★ 第二十六轮 T1-I4 修：前后展（flare）通道的**上一帧前向投影**缓存
     *  （每骨一个，构建期填 `NaN` = 未初始化）。用来算「这一帧往前甩了多少」，
     *  旧值写成 `NaN` 是为了让首帧的差分为 NaN 从而被跳过（不产生假的脉冲）。
     *  以前只在 rig 字面量里出现、接口没声明 ⇒ `TS2353`。 */
    _flareFront: Float32Array;
    /** 侧向摆动要量的胳膊关节（打包：`[左 …左, 右 …右]`，边长见 `sideSideN`） */
    sideArm: THREE.Object3D[];
    /** 两侧各自的关节根数（`[左, 右]`；0 = 该侧没抓全） */
    sideSideN: number[];
    /** 内部：每一侧「肩→肘」「肘→腕」的**本帧**侧向分量与上一帧缓存（量侧向摆速） */
    _sideRollS: Float32Array;
    _sideRollE: Float32Array;
    /** 内部：侧向摆动通道自己的「上一帧骨架根水平位置」（与外撑那条各自独立，互不偷状态） */
    _flareRootPrev2: Float32Array;
    /** 内部：上一帧骨架根的世界水平位置（[x, z]；`NaN` = 还没记过） */
    _flareRootPrev: Float32Array;
    /** 诊断：本帧被撑开的袖骨数（无头脚本读它确认真的生效） */
    flareN: number;
    /** 诊断：**静态**属于袖子（`driveSel === 1`）的骨数。构建期算一次，不随帧变。 */
    flareBones: number;
    /** 诊断：本帧袖骨撑开角的**平均**（度）。`>= 0` 恒成立，`0` = 没有一根被撑 */
    flareDeg: number;
    /**
     * 诊断（米级取证）：本帧被撑开的袖骨**离体轴（骨架根竖直轴）的水平距离**均值，单位米。
     * 外撑生效 ⇒ 同一相位下这个数随 `?secflare=` 单调变大。`0` = 本帧没有骨被撑。
     */
    flareOlMean: number;
    /** 诊断（米级取证）：同上，取本帧最大值（米）。 */
    flareOlMax: number;
    /**
     * 诊断（米级取证，**外撑净贡献**）：本帧袖骨「带外撑」与「不带外撑」两种求解下
     * 位置的欧氏距离均值，单位米。它才是「袖子往外多走了多少」的判据
     * —— 随 `?secflare=` 单调变大。`0` = 没开外撑或没有袖骨参与。
     */
    flareShiftMean: number;
    /** 诊断（米级取证）：同上，本帧最大值（米）。 */
    flareShiftMax: number;
    /** 诊断：参与 `flareShift*` 统计的袖骨根数。 */
    flareShiftN: number;
    /** 撑开速度基准（m/s，`?secflarespd=`）—— 诊断用，DevStamp 要显示 */
    flareSpeed: number;
    /**
     * 诊断：本帧袖骨的**平均前摆相位**权重 0..1。
     * 走路时手臂一前一后，这个数必然随步态周期上下走（≈0.55 ↔ 1.0）；
     * 站定时恒为基准值 ⇒ 可以直接拿来证明「撑开量随相位变，而不是只随速度」。
     */
    flarePhase: number;
    /** 诊断：本帧袖骨的**平均贴体风险闸** 0..1（袖子离体轴越近越接近 1，越远越接近 0.4 下限） */
    flareRisk: number;
    _limbRef: Float32Array;
    /** 内部：肢体关节（[左足,左ひざ],[右足,右ひざ],[左腕,左ひじ],[右腕,右ひじ]），每帧读世界位置 */
    limbA: Array<THREE.Bone | null>;
    limbB: Array<THREE.Bone | null>;
    /** 是否启用碰撞 */
    collide: boolean;
    /** 运行时：世界空间的碰撞体缓存（每帧算一次，不随骨变） */
    _cWorld: Float32Array;
    _cAxis: Float32Array;
    _cR: Float32Array;
    _cHalf: Float32Array;
    /** 骨架最顶端。每帧先从它做一次全树 `updateWorldMatrix` */
    root: THREE.Bone;
    /** 第一帧直接吸附到动画姿态，避免从原点甩过来 */
    primed: boolean;
    /** 诊断：本帧所有物理骨里最大的「偏离动画方向」角（度）。这是「真的在动」的定量证据 */
    devDeg: number;
    /** 本帧 `updateSecondary` 的耗时（毫秒）—— 判断 573 根骨 × 34 碰撞体扛不扛得住 */
    lastMs: number;
    /** 诊断：均值 */
    meanDevDeg: number;
    /** 诊断：衰减峰值（无头脚本只读得到一个瞬间，用衰减峰值才不会恰好采到谷值） */
    peakDevDeg: number;
    info: {
        total: number; hair: number; cloth: number; bones: number;
        gravity: number; stiffness: number; wind: number; excluded: number;
        colliders: number; skips: number; collide: boolean;
    };
}

const DEG = 180 / Math.PI;

/* 模块级临时量 —— 每帧 600 根骨，绝不能在里面 new */
const _vHead = new THREE.Vector3();
const _vDir = new THREE.Vector3();
const _vRest = new THREE.Vector3();
const _vFree = new THREE.Vector3();
const _vAxis = new THREE.Vector3();
const _mRot = new THREE.Matrix4();
const _qParent = new THREE.Quaternion();
/* ★ t16：袖向姿态读数用的欧拉临时量（只被 `measureSleevePose` 使用，不进求解循环） */
const _eulPose = new THREE.Euler(0, 0, 0, 'YXZ');
const _qR = new THREE.Quaternion();
/* ★ 第二十六轮 c：链一致化用的四元数 + 三个方向临时量。
 *  为什么单独开：`_vRest` / `_vDir` / `_qR` 在同一帧里被反复改写，
 *  借来算 `qNet` 会把求解器的量污染掉（同型坑已踩 8 次）。 */
const _qNet = new THREE.Quaternion();
/* ★ 第三十二轮 e：替换 animLocal 用的临时四元数（模块级，避免每骨 alloc）。 */
const _vNetA = new THREE.Vector3();
const _vNetB = new THREE.Vector3();
const _vNetT = new THREE.Vector3();
/* ★ 十四轮：侧摆增量四元数 + 它的两个端点方向（世界空间） */
const _qSide = new THREE.Quaternion();
const _vSideBase = new THREE.Vector3();
const _vSideNow = new THREE.Vector3();
const _qW = new THREE.Quaternion();
const _mInv = new THREE.Matrix4();
const _mRoot = new THREE.Matrix4();
const _vScale = new THREE.Vector3();
const _eEuler = new THREE.Euler();
const _vCol = new THREE.Vector3();
const _vCap = new THREE.Vector3();
/* 方向性约束用（任务2）：角色朝向 / 侧向在世界空间的单位向量 */
const _qRoot = new THREE.Quaternion();
const _vFwd = new THREE.Vector3();
const _vSide = new THREE.Vector3();
/* 肢体驱动用（用户 m12638 / m12655）：一个肢体方向临时量 */
const _vLimb = new THREE.Vector3();
/* ★★★ 侧向摆动（用户 m18305）用的临时量：刻意**不复用** `_vSide` / `_vHead`，
 *  免得与上面那些求解器私有量互相污染（那两个在逐骨循环里已经被反复改写）。 */
const _vArmS = new THREE.Vector3();
/** 水平前进轴（`_vFwd` 去掉 y 后归一化）—— 侧向摆绕它转，见逐骨那段注释 */
const _vFwdFlat = new THREE.Vector3();
const _vArmE = new THREE.Vector3();
const _vArmW = new THREE.Vector3();
/* ★ 2026-10-21 反馈1「袖子走路时向外延」用的两个临时量 */
const _vOut = new THREE.Vector3();
const _vRootPos = new THREE.Vector3();
/** ★★★ 落脚脉冲：把骨方向从「竖直向下」朝 `_vLandAxis` 外侧转开时用的临时量。
 *  `_vLandRad` = 该骨水平径向（世界 XZ，单位化）；`_vLandAxis` = 转轴 = up × 径向；
 *  `_qLand` = 这一次旋转的四元数；`_vLandBase`/`_vLandNow` = 写回增量用的基准/终值。 */
const _vLandRad = new THREE.Vector3();
const _vLandAxis = new THREE.Vector3();
const _qLand = new THREE.Quaternion();
const _vLandBase = new THREE.Vector3();
const _vLandNow = new THREE.Vector3();
/* ★ 第二十一轮：整片布（披风/带）与 thigh 前顶共用的临时量。
 *  ⚠️ 与 `_qLand`/`_vLandBase` 同一套写法：一个四元数 + 基准/终值各一个向量。
 *  `_qPiece` 同时被「整片布」和「thigh」两段用**不安全**（两段都在逐骨循环里），
 *  所以 thigh 用自己的 `_qThigh`。 */
const _qPiece = new THREE.Quaternion();
const _vPieceBase = new THREE.Vector3();
const _vPieceNow = new THREE.Vector3();
const _qThigh = new THREE.Quaternion();
const _vThighBase = new THREE.Vector3();
const _vThighNow = new THREE.Vector3();

/** 初始化：把 PMX 的静止刚体从「模型空间」反解到「宿主骨局部空间」 */
function initColliders(rig: SecondaryRig): void {
    const { colN, colBone, colLocal, colAxis, colPmx, colShape, colR, colHalf,
        colSlack, slackMax, n, bones, restLen, restDirLocal, _cWorld, _cAxis, _cR, _cHalf } = rig;
    _mRoot.copy(rig.root.matrixWorld);
    _vScale.setFromMatrixScale(_mRoot);
    const S = (_vScale.x + _vScale.y + _vScale.z) / 3 || 1;

    for (let j = 0; j < colN; j++) {
        const b = colBone[j];
        _mInv.copy(b.matrixWorld).invert();
        // 中心：模型空间 → 世界 → 骨局部
        _vCol.set(colPmx[j * 6], colPmx[j * 6 + 1], colPmx[j * 6 + 2]).applyMatrix4(_mRoot).applyMatrix4(_mInv);
        colLocal[j * 3] = _vCol.x; colLocal[j * 3 + 1] = _vCol.y; colLocal[j * 3 + 2] = _vCol.z;
        // 轴：模型空间的 (0,1,0) 经欧拉旋转 → 世界 → 骨局部方向
        _eEuler.set(colPmx[j * 6 + 3], colPmx[j * 6 + 4], colPmx[j * 6 + 5], 'XYZ');
        _vCap.set(0, 1, 0).applyEuler(_eEuler).transformDirection(_mRoot).transformDirection(_mInv);
        colAxis[j * 3] = _vCap.x; colAxis[j * 3 + 1] = _vCap.y; colAxis[j * 3 + 2] = _vCap.z;
        if (colShape[j] === 0 || colShape[j] === 1) { colAxis[j * 3] = 0; colAxis[j * 3 + 1] = 0; colAxis[j * 3 + 2] = 0; }
    }

    // ★ 第一帧记下每个碰撞体的世界球/胶囊，用来算「静置时本来就插进去多少」
    stepColliders(rig);
    let slackPairs = 0;
    for (let i = 0; i < n; i++) {
        const b = bones[i];
        const parent = b.parent;
        if (!parent) continue;
        const L = restLen[i];
        if (L < 1e-6) continue;
        _vHead.setFromMatrixPosition(parent.matrixWorld);
        _qParent.setFromRotationMatrix(_mRot.extractRotation(parent.matrixWorld));
        _vRest.set(restDirLocal[i * 3], restDirLocal[i * 3 + 1], restDirLocal[i * 3 + 2]).applyQuaternion(_qParent);
        const tx = _vHead.x + _vRest.x * L, ty = _vHead.y + _vRest.y * L, tz = _vHead.z + _vRest.z * L;
        for (let j = 0; j < colN; j++) {
            const R = _cR[j];
            if (R <= 1e-6) continue;
            // 到胶囊轴的最近点
            const dx = tx - _cWorld[j * 3], dy = ty - _cWorld[j * 3 + 1], dz = tz - _cWorld[j * 3 + 2];
            const H = _cHalf[j];
            let t = 0;
            if (H > 0) t = Math.max(-H, Math.min(H, dx * _cAxis[j * 3] + dy * _cAxis[j * 3 + 1] + dz * _cAxis[j * 3 + 2]));
            const ex = dx - _cAxis[j * 3] * t, ey = dy - _cAxis[j * 3 + 1] * t, ez = dz - _cAxis[j * 3 + 2] * t;
            const dd = Math.hypot(ex, ey, ez);
            // ★ 松弛量 = 静置时本来就插进去的深度（不是「永久屏蔽」！）
            const pen = R - dd;
            if (pen > 1e-4) {
                // 只保护「确实嵌在里面」的：留 5 mm 余量，避免把贴着的也算进去。
                // ★★ 而且必须**封顶**：静置量是拿「第一帧」量出来的，若那一帧恰好是
                //   迈步姿势，某根前襟骨的尾巴可能正好落在放大的大腿胶囊里很深，
                //   于是这一对**永远**不会被推出去（实测最深 3.7 cm，肉眼可见）。
                //   封顶之后每对最多允许嵌 `slackMax` 米，穿模深度就有了硬上界。
                const raw = Math.max(0, pen - 0.005);
                colSlack[i * colN + j] = Math.min(raw, slackMax);
                if (colSlack[i * colN + j] > 0) slackPairs++;
            }
        }
    }
    rig.info.skips = slackPairs;
    void colLocal;
}

/** 每帧算一次碰撞体的世界表示（挂在骨头上，跟着动画走） */
function stepColliders(rig: SecondaryRig): void {
    const { colN, colBone, colLocal, colAxis, colR, colHalf, colScale,
        _cWorld, _cAxis, _cR, _cHalf } = rig;
    if (colN === 0) return;
    _vScale.setFromMatrixScale(rig.root.matrixWorld);
    const S = (_vScale.x + _vScale.y + _vScale.z) / 3 || 1;
    for (let j = 0; j < colN; j++) {
        _mInv.copy(colBone[j].matrixWorld);
        _vCol.set(colLocal[j * 3], colLocal[j * 3 + 1], colLocal[j * 3 + 2]).applyMatrix4(_mInv);
        _cWorld[j * 3] = _vCol.x; _cWorld[j * 3 + 1] = _vCol.y; _cWorld[j * 3 + 2] = _vCol.z;
        _vCap.set(colAxis[j * 3], colAxis[j * 3 + 1], colAxis[j * 3 + 2]).transformDirection(_mInv);
        _cAxis[j * 3] = _vCap.x; _cAxis[j * 3 + 1] = _vCap.y; _cAxis[j * 3 + 2] = _vCap.z;
        _cR[j] = colR[j] * S * colScale * (rig.colMul?.[j] ?? 1);
        _cHalf[j] = colHalf[j] * S;
    }
}

/** 层级深度：保证父骨先于子骨被处理 */
function depthOf(o: THREE.Object3D): number {
    let d = 0;
    let p: THREE.Object3D | null = o.parent;
    while (p) { d++; p = p.parent; }
    return d;
}

/** 判断 `o` 的子树里有没有「动画（VMD）自己驱动的骨」 */
function hasAnimatedDescendant(root: THREE.Object3D, skip: Set<string>): boolean {
    const stack: THREE.Object3D[] = [...root.children];
    while (stack.length) {
        const o = stack.pop()!;
        if (skip.has(o.name)) return true;
        for (const c of o.children) stack.push(c);
    }
    return false;
}

/**
 * 从 `mesh.userData.mmdPhysics.rigidBodies` 反推「哪些骨是物理驱动的」。
 *
 * ⚠️ **绝对不要用骨骼名的正则去猜** —— 这只模型的骨名是观海从原神模型转出来的，
 * 命名没有任何统一规则：头发是 `Bone_Hair11_L`、袖套是 `Bone_ArmLets01_R`、
 * 而占最大头的裙摆 465 根叫 `Skirt_0_0` … `Skirt_20_12`。只有刚体表是权威的。
 *
 * 两道过滤：
 *  ① 刚体 `mode === 'static'`（静止刚体，34 个）跳过 —— 它们本来就不动；
 *  ② ★ **子树里含 VMD 驱动骨的骨骼整根排除**。这条是**结构判据**，不是名字正则：
 *     `左ひじ` 的子树里有 `左手首`（VMD 有轨道）⇒ 剔除，胳膊不会被物理拽变形；
 *     而 `Skirt_*` / `Bone_Hair*` 的子树里全是自己的链，一根动画骨都没有 ⇒ 保留。
 *
 * @param skip 动画自己会驱动的骨名（VMD 轨道里的）
 */
export function collectSecondaryBones(
    mesh: THREE.SkinnedMesh,
    skip: Set<string>,
): { bones: THREE.Bone[]; hair: number; cloth: number; excluded: number } {
    const out: THREE.Bone[] = [];
    const seen = new Set<THREE.Bone>();
    const skel: any = (mesh as any).skeleton;
    const all: THREE.Bone[] = skel?.bones ?? [];
    const phys: any = (mesh.userData as any)?.mmdPhysics;
    const bodies: any[] = phys?.rigidBodies ?? [];
    let hair = 0, cloth = 0, excluded = 0;

    for (const rb of bodies) {
        if (!rb || rb.mode === 'static') continue;
        const bi = rb.boneIndex;
        if (typeof bi !== 'number' || bi < 0 || bi >= all.length) continue;
        const b = all[bi];
        if (!b || seen.has(b)) continue;
        if (skip.has(b.name)) continue;
        if (!b.parent) continue;
        if (hasAnimatedDescendant(b, skip)) { excluded++; continue; }
        seen.add(b);
        if (/^Bone_/.test(b.name)) hair++; else cloth++;
        out.push(b);
    }

    // 父在前 —— 子骨读父骨**这一帧刚算出来的**世界朝向
    out.sort((a, b) => depthOf(a) - depthOf(b));
    return { bones: out, hair, cloth, excluded };
}

export interface SecondaryOptions {
    /** 回正刚度（1/秒）：越大越硬、跟得越紧。头发 8~14、裙摆 4~8 */
    stiffness?: number;
    /** 限角（度）：相对「动画方向」最多偏出去多少。MMD 关节表实测 ±20° */
    limitDeg?: number;
    /** 重力（米/秒²）。0 = 关掉重力，只留惯性 */
    gravity?: number;
    /** 阻尼（0~1，每帧速度保留 1-drag）。VRM 默认 0.4 */
    drag?: number;
    /** ★ 风阻增益（1/s）：把角色世界速度变成吹向身后的风力加速度。0 = 关掉走路带风 */
    wind?: number;
    /** ★★ 前侧布片（`axisSel===0 && axisSign>0`，即前襟/身前那几片）吃多少风。
     *  缺省 **0** —— 用户 m14400 原话：「走路时前方衣摆依然是向后摆动的，而不是向前」。
     *  机理：`wind` 把角色速度变成**吹向身后**的风（`_tools` 实测 `frontMin` 会因此变负、
     *  即前襟被吹到身体后面去）；而走路时前襟**应该**被前摆的腿顶着向前。
     *  ⇒ 前侧那一组不吃这股风，只由 `?secdrive=`（腿驱动）与动画本身决定。
     *  `?secwindfront=1` 恢复旧行为（前后一视同仁）。 */
    windFront?: number;
    /** ★★★ 裙摆**最下摆**吃多少风（0..1，`?sechemwind=`，缺省 **0.10**）。
     *
     *  用户 m11430 任务3：「图三我圈出来的衣料，最下摆那部分走路时不要往后飘，
     *  自然垂落略微向前摆就行。」
     *
     *  机理：`wind` 造的是吹向**身后**的风 ⇒ 裙摆越低的那几节被吹得越远。
     *  实测（`_logs/round16/hem3.jsonl`，`?autowalk=1.446` 真走路，取 `裙` 材质最低
     *  那批骨的世界 z 偏移中位数，角色前向 = +Z）：静止 −0.24 m → 走路 −0.48 m，
     *  即裙摆下摆被往后吹了 **0.24 m**；而把 `secondary=0` 关掉时同一姿势是 −0.37 m。
     *  ⇒ 老的风力在下摆上贡献约 0.11 m 的后飘，就是要削掉的那部分。
     *  这里按**骨节点世界高度**做过渡：低于 `hemLo` 只吃 `windHem` 份额，高于 `hemHi`
     *  `windHem` 份额，高于 `hemHi`
     *  完全不受影响（见 `hemLo/hemHi` 的注释），渐变段避免出现折线。 */
    windHem?: number;
    /** ★ 第二十六轮 T1-I4 修：下摆窗口上界（**占裙摆自身竖直跨度的比例**）。
     *
     *  ⚠️ 这个字段以前**只写在 `SecondaryRig` 里、没写进 `SecondaryOptions`** ——
     *  而 `createSecondaryMotion` 是 `opts.hemHi ?? 0.45` 读的（`:1464`），
     *  `MmdCharacter.tsx:2792` 也一直在传 `hemHi: SEC_HEM_HI`。
     *  两处都没报错（运行期靠对象字面量侥幸），但 `tsc` 一开就暴露：
     *  `TS2353 'hemHi' does not exist in type 'SecondaryOptions'`。
     *  ⇒ 说明 `?sechemhi=` 这个旋钮**从来没有生效过**，一直走缺省 0.45。
     *  现在补上声明，旋钮真正接通（缺省值不变，未传参时行为与改前逐位相同）。 */
    hemHi?: number;
    /** ★ 第二十六轮 T1-I4 修：`?secrows=1` 的逐骨明细收集表（诊断用）。
     *
     *  与 `hemHi` 同病：`:2557 sideRows: opts.sideRows` 一直在读，接口里没声明，
     *  `MmdCharacter.tsx` 也一直在传。补上声明后 `?secrows=` 才真的能收到数据。 */
    sideRows?: Array<[number, number, number]>;
    /** ★★★ 裙摆下摆的最大**向前**倾角（度，`?sechemfwd=`，缺省 **4**；`<= 0` 关）。
     *
     *  用户 m11430 任务3 的后半句「自然垂落**略微向前摆**就行」。
     *  做法与 `driveDeg` 同一套：绕侧向轴把 `_vRest` 转 `−角度`（负角 = 向前，
     *  见 `drive` 那段注释的符号说明），按高度加权 —— 最底下满额，往上线性衰减到 0。
     *  ⚠️ 只在**走起来**时施加（静止垂落不该前倾），速度归一与侧摆同一口径。 */
    hemFwdDeg?: number;
    /** ★★★ **落脚脉冲**（度，`?secland=`，缺省 **9**；`<= 0` 关）。
     *
     *  这是「每一步脚落地，衣摆和头发整体向上 + 向四周飘一下」那条动作。
     *  详见 `SecondaryRig.landPulse` 上方的长注释（参考视频读数 / 机理 / 回滚）。
     *  两条包络各有自己的幅度旋钮：
     *    `?seclandlift=`  （度，缺省 = 本值）紧跟落脚的抬高分量，对应 `dH/dHair`；
     *    `?seclandspread=`（度，缺省 = 本值 × 0.75）滞后 0.65 步的外扩分量，对应 `hemW`。
     *  ⚠️ 参考视频里横向跨度 pp 84.8 px 换算约 0.58 m，比垂直 0.32 m 更大 ⇒
     *     视觉上「向四周张」比「抬高」更显眼，所以 `spread` 给的是**同一量级**的角度，
     *     靠 `landHi`（高度权重窗口）让最下摆吃满、上摆衰减。
     *  `?landhi=`      （0..1，缺省 0.45）下摆/头发「最低多少比例」吃满额；
     *  `?landlandph=`  （0..1，缺省 0.98）抬高包络的峰值相位（相对落脚）；
     *  `?landspreadph=`（0..1，缺省 0.65）外扩包络的峰值相位（相对落脚）；
     *  `?landliftw=`   （0..1，缺省 0.04）抬高包络的上升宽度（占一步）；
     *  `?landliftd=`   （0..1，缺省 0.35）抬高包络的衰减宽度（占一步）；
     *  `?landspreadw=` （0..1，缺省 0.30）外扩包络的高斯宽度（占一步）。 */
    landDeg?: number;
    /** 抬高包络最大角（度）；`undefined` ⇒ 取 `landDeg` */
    landLiftDeg?: number;
    /** 外扩包络最大角（度）；`undefined` ⇒ 取 `landDeg × 0.75` */
    landSpreadDeg?: number;
    /** 下摆/头发高度权重窗口（0..1，占各自竖直跨度）。缺省 0.45 */
    landHi?: number;
    /** 头发相对裙摆的额外增益。缺省 **1.35**（参考视频 `dHair` pp 是 `dH` 的 1.58×） */
    landHairK?: number;
    /** 外扩权重的下段偏置（0..1，缺省 **0.25**）。外扩权重按**反高度梯度**分布：
     *  裙摆上段满额、下段降到本值。0 = 下摆最末一截完全不吃外扩。 */
    landSpBias?: number;
    /** 抬高包络峰值相位（0..1 步）。缺省 **0.0** —— 参考视频 `dHair`（干净信号）峰在落脚那一帧 */
    landLiftPh?: number;
    /** 外扩包络峰值相位（0..1 步）。缺省 **0.62** —— 参考视频 `hemW` 峰在 b15 */
    landSpreadPh?: number;
    /** 抬高包络上升宽度（0..1 步）。缺省 0.05 */
    landLiftW?: number;
    /** 抬高包络衰减宽度（0..1 步）。缺省 **0.12** —— `dHair` 在 4 个桶（≈0.17 步）内衰完 */
    landLiftD?: number;
    /** 外扩包络高斯宽度（0..1 步）。缺省 0.30 */
    landSpreadW?: number;
    /** ★★★ 角色位移补偿系数（0..1，缺省 **1** = 全补）。
     *
     *  背景（用户 m14400「走路时前方衣摆依然是向后摆动的」的**真正**根因）：
     *  这个求解器是**世界坐标** Verlet —— 粒子存的是世界点，每帧只把「骨头的世界位置」
     *  当作锚点。角色以 v 前进时，粒子不动、锚点跑了，回正弹簧就得把它拖过去，
     *  于是产生稳态落后 `lag ≈ v / 刚度`（v=1.446 m/s、刚度 7.5/s ⇒ 约 0.19 m，
     *  再加阻尼项实测 0.30 m）。**这跟 `?secwind=` 那股风无关**：把
     *  `?secwindfront=0`（前襟完全不吃风）跑同一条路，`frontMin` 仍从 −0.298 只变到 −0.286。
     *  ⇒ 把角色这一帧的位移 (vx·d, vz·d) **同时**补进 `particle` 与 `particlePrev`
     *  （两个都补 ⇒ 不引入任何速度），等价于**在角色的移动坐标系里解算**：
     *  布料不再因为「她往前走」而被凭空拖到身后；想让衣摆/头发有拖尾感，
     *  用 `?secwind=`（显式风）去调，而不是靠这个副作用。
     *  `?secframe=0` 恢复旧行为做 A/B。 */
    carry?: number;
    /** ★ 是否用 PMX 自带的静止刚体做碰撞体（顶点穿模的解药）。缺省开 */
    collide?: boolean;
    /** ★ 碰撞体半径放大系数（PMX 的静止刚体是粗代理，比可见网格细）。缺省 1.35 */
    colScale?: number;
    /** ★★★ **腿**刚体的额外放大系数（`?seccolsleg=`，缺省 2.0）。
     *  PMX 刚体贴的是骨轴，布片是面、可以离骨轴几厘米 ⇒ 只按 `colScale` 推不够，
     *  腿会从裙子/长袖里穿出来。只放大 `/(足|ひざ|足首)D$/` 那十几个刚体，
     *  上身/手臂保持 `colScale`（避免整条裙子被吹胀）。判据与实测见
     *  `createSecondaryMotion` 里 `colMul` 的注释。 */
    colScaleLeg?: number;
    /** ★ 单对允许的最大静置嵌入深度（米）。缺省 0.015 —— 穿模深度的硬上界 */
    slackMax?: number;
    /** ★ 推出迭代次数（按骨长归一化会把推出的成果吃回去，故需迭代）。缺省 3 */
    iterations?: number;
    /** ★★ 碰撞要检测「骨棒上几个采样点」而不是只测骨尾。缺省 4，`?secrod=`；`1` = 旧行为。
     *  见 `SecondaryRig.rodSamples` 上的长注释（用户 m13789「走路时前面衣料穿模」）。 */
    rodSamples?: number;
    /** ★★★ 布-布斥力距离（米；`?secrepel=`，缺省 0.010，`0` = 关）。
     *  见 `SecondaryRig.repelD` 上的长注释（用户 m15017「布-布斥力你做一个我看看效果」）。 */
    repel?: number;
    /** ★ 建邻接表时的静止距离上限（米；`?secrepelcut=`，缺省 0.22）。
     *  只在静止姿势下互相靠近到这个距离以内的骨对才会被纳入斥力检测。 */
    repelCut?: number;
    /** ★ 斥力强度（0..2；`?secrepelw=`，缺省 1）。 */
    repelW?: number;
    /** ★ 邻接表重建周期（帧；`?secrepelevery=`，缺省 8）。 */
    repelEvery?: number;
    /**
     * ★★★ 第二十四轮 v4：**弹簧刚度总乘数**（`?secstiffk=`，缺省 **1**）。
     *
     *  用户 m03115：「我关了参数布料走起来还在飘」。实测确认：
     *  `?clothamp=0` 只关得掉那 4 条**叠加**通道，底下弹簧求解器仍有 9~12° 滞后角
     *  （披风 9.16° / 带 9.92° / 披肩 11.95° / 裙 9.09°，见 `stiffK` 上方长注释）。
     *
     *  ⚠️ 这是**乘数**不是绝对值：不覆盖已定案的 `stiffness=11 / drag=0.32`，
     *     `=1` 逐位回滚；`>1` 更硬更不飘、`<1` 更软更飘。
     */
    stiffK?: number;
    /** ★ 第二十四轮 v4：限角乘数（`?seclimitk=`，缺省 1）。弹簧再硬也会顶到限角，
     *  与 `stiffK` 一起调才能把「几乎不动」做到位。 */
    limitK?: number;
    /** ★ 第二十四轮 v4：**分片**刚度乘数 —— 头发（`?secstiffhair=`，缺省 1） */
    stiffHair?: number;
    /** ★ 分片：裙（`?secstiffskirt=`，缺省 1）。实测裙 8.93→8.25° 对刚度不敏感，
     *  但「带」9.65→11.39° 反而更飘 ⇒ 各片最优值不同，必须分开调。 */
    stiffSkirt?: number;
    /** ★ 分片：其它布（披风/带/披肩/袖，`?secstiffother=`，缺省 1） */
    stiffOther?: number;
    /** ★ 方向性约束的容差（度）：悬挂骨朝**身体方向**最多偏出去多少。
     *  `0` = 完全不许朝身体方向偏；缺省 8。设 `-1` 关闭整条约束。
     *  见 `SecondaryRig.fwdLocal` 上方的长注释（用户 m11933 / 先搜再做 m11937）。*/
    antiDeg?: number;
    /** ★ 肢体驱动的最大角度（度）。缺省 18；`?secdrive=-1` 关掉（A/B 对照用） */
    driveDeg?: number;
    /** 相位超前（秒），见 `SecondaryRig.driveLead`。缺省 0.10 s，`?secdrivelead=` 可调，0 = 纯跟随 */
    driveLead?: number;
    /** ★ 是否把头发也纳入方向性约束（缺省否：用户的定义只针对衣服） */
    antiHair?: boolean;
    /** ★ 第四十四轮：头发是否交给二次运动解算（`?hairsolve=`，缺省 **0 = 不解算**）。
     *  `0` = 头发**完全由 MMD 动画关键帧决定** —— 这就是 `公用区\哥伦比娅步态复刻_第五版`
     *        的头发姿态，也是 V3 存档里 `if (!antiHair && /Hair|髪|髪2/.test(...)) continue;`
     *        的默认行为（V3 从根本不解算头发）。
     *  `1` = 恢复解算（第四十二轮 `?hairfloor=`、第二十四轮 `?hairsep=` 只在 `1` 下有意义）。
     *  用户 m11683：「其实就是 公用区\哥伦比娅步态复刻_第五版 这里面的头发姿态」。 */
    hairSolve?: boolean;
    /** 上限，防止弱机上一次性处理几百根 */
    /**
     * ★★ 袖子向外撑开的最大角度（度），见 `SecondaryRig.flareAmp`。
     *  缺省 **16**；`?secflare=-1` 关掉、`?secflare=0` 也当关。
     *  背景（用户 2026-10-21 反馈1）：「袖子在走路时，和衣服穿模，解决方案，袖子走路时
     *  位置向外延申，避开衣服」。`?secdrive=` 让袖子跟着胳膊**前后**摆，但没管**侧向**——
     *  胳膊往前摆时袖子仍然贴着前襟，两片布在 2 cm 以内就只能互相插过去。
     *  这条按「离身体中线越远越安全」直接给一个侧向偏置，绕开布-布斥力那套重活。
     */
    flareDeg?: number;
    /** ★ 撑开量达到满值所需的水平速度（m/s），缺省 0.9（走路 1.446 m/s 时已经是满值） */
    flareSpeed?: number;
    /**
     * ★★★ **袖子侧向摆动**的最大角（度，`?secside=`，缺省 **60**；`<= 0` 关，`-1` 也关）。
     *
     * 用户 m18305（第七项修复）：「现在的袖子是随着手臂摆动**前后**运动……我看了游戏内实机，
     * 实际上，袖子的摆动方向是**向两侧**，人物走起来以后，袖子是向两侧飘而不是前后。
     * 这也改善了袖子和衣服穿模的问题。因为袖子向两侧飘就不会碰到衣服。」
     *
     * 与 `flareDeg`（上面那条）的分工：`flareDeg` 是**静态偏置** —— 把静止目标
     * 朝身体外侧偏一个固定角度，跟手掌上下摆动无关；`sideDeg` 是**摆动** ——
     * 跟着「手掌相对肩膀的左右摆」把袖子朝外荡。改装前袖子那 0.36 m 沿前后轴的
     * 位移几乎全部来自胳膊的前后摆（实测 X/Z = 0.103/0.358 m），这条把它换成侧向。
     */
    sideDeg?: number;
    /** ★ 侧摆达到满值所需的水平速度（m/s），缺省 0.9（走路 1.446 m/s 已是满值） */
    sideSpeed?: number;
    /**
     * ★ 侧向摆同时**压掉前后摆**的比例（0..1，`?secsidekill=`，缺省 0.35）。
     *  为 0 时只剩「侧向荡」、前后不动；为 1 时目标方向里的前后分量被完全抹掉。
     */
    sideFrontKill?: number;
    /** ★ t16：侧摆的静态份额（0..1，`?secsidestand=`，缺省 0.55）。见 `SecondaryRig.sideStandK`。 */
    sideStandK?: number;
    /** ★★ t20：近裙摆减推量（见 `SecondaryRig.sideHiK` 的注释）。
     *  `sideHiK` 缺省 0.55；`<= 0` ⇒ 关闭（逐位回到 t16 的满推，可回滚）。 */
    sideHiK?: number;
    /** 满推高度下界（米，缺省 0.90）：袖骨原点低于此 ⇒ 推量 × (1 - sideHiK)。 */
    sideHiLo?: number;
    /** 满推高度上界（米，缺省 1.35）：高于此 ⇒ 推量 × 1。 */
    sideHiHi?: number;
    /**
     * ★★★ 十七轮（用户 m12388）：「袖子侧展已经做了 8°，但没有随着摆臂向外摆动——
     *  可以随着行走时摆臂动作，加入一定角度的往复运动，比如 8° → 10° → 8°」。
     *  ⇒ 侧展角不再是常量，而是在基准值上叠加一个**跟摆臂同相位的往复量**，
     *  振幅就是这个参数（度，`?secsideosc=`，缺省 2；`<= 0` 关 = 逐位回到十六轮的常量行为）。
     *  为什么加在**角度**上而不是位置上：基准 8° 已经由 `?secside=` 定标过，
     *  叠加角度才不会破坏「走起来恒定向两侧张开多少」这个已验收的量。
     */
    sideOscDeg?: number;
    /** 往复量的相位参考幅值（`?secsideoscref=`，缺省 0.35）：前臂方向在前后轴上的
     *  投影除它再夹到 ±1 —— 走路摆臂时实测峰值约 0.35~0.5。 */
    sideOscRef?: number;
    /**
     * ★★★ 第二十一轮：「**整片布同向飘**」的最大角（度，`?secpiece=`，缺省 **12**；
     *  `<= 0` 关）。定案依据见 `MmdCharacter.tsx` 的 `SEC_PIECE` 注释
     *  （双判据：左右同向 corr ≥ 0.7 **且** 不乱掀裙 `lowMax` 不涨）。
     */
    pieceDeg?: number;
    /** 带吃 piece 通道的系数，缺省 0（回滚步态V3）。 */
    pieceWRib?: number;
    /** 整片摆动的相位（0..1 步内；缺省 0 = 落脚时荡到一侧）。`?secpieceph=` */
    piecePh?: number;
    /**
     * ★★★ 第二十四轮 v3：**头发径向让位**的目标间隙（米，`?hairsep=`，缺省 **0.02**；
     *  `0` 关）。见 `SecondaryRig.hairSep`。
     *
     *  用户 m02740：「你看图的时候没发现头发穿模衣服了吗？」
     *  实测（`_tools/hairradial.js`）：1.0 m 高度处头发半径 **0.230 m**、
     *  裙半径 **0.227 m** —— 两者占同一空间，`hairClash` 最近 **0.3 mm**。
     */
    hairSep?: number;
    /**
     * ★★★ 第二十二轮：披肩（编号4）**整片摆动**的最大角（度，`?secshawl=`，
     *  缺省 **5**）。用户原话：「这布料是一个整体，不是上面不动下面往前动。
     *  而且摆动幅度有点大。」
     *  ⇒ 独立一片、**整片同权**（不走袖子的高度减推），幅度单列且偏小。
     *  这与披风/带的 `?secpiece=`（12°）是两个独立旋钮，互不影响。
     */
    shawlDeg?: number;
    /** 披肩摆动的相位（0..1 整圈；缺省 0 = 与披风同相，一起朝同一侧）`?secshawlph=` */
    shawlPh?: number;
    /** ★ 第二十八轮：披肩刚性整片（缺省 1）。`?secshawlrigid=0` 退回逐骨解算。 */
    shawlRigid?: number;
    /** 刚性整片的摆幅（度，缺省 10）。**不乘 clothAmp** —— 见 `shawlOscR` 注释。 */
    shawlRigidAmp?: number;
    /** ★ 第二十九轮：披肩整片前移（度）。0 = 关。 */
    shawlPush?: number;
    shawlPushSign?: number;
    /** 走路时叠加的小幅摆动（度）。 */
    shawlPushOsc?: number;
    /**
     * ★★★ 第二十四轮：**四片布的总幅度乘数**（`?clothamp=`，缺省 **1**）。
     *
     *  用户原话：「有些布料的运动幅度太大了，cloth_map_view.jpg 中的编号 1、4、6、8。
     *  这几个布料缩小运动（摆动）幅度。准备一个参数，缩不同的程度我实机对比再定。」
     *
     *  一处管四片（编号对照 `_tmp_preview/r16/cloth_map_view.jpg`）：
     *    1 袖   → `sideAmp`（侧向张开角）**和** `sideOscAmp`（摆臂往复量）
     *    4 披肩 → `shawlAmp`
     *    6 披风 ┐
     *    8 带   ┘ → 同一个 `pieceAmp`（带另有 0.65 的轻量化系数，比例不变）
     *
     *  ⚠️ 这是**乘数**不是绝对值：`?clothamp=0.5` ⇒ 上面四个幅度各减半，
     *     而 `?secpiece=` / `?secshawl=` / `?secside=` 这些单通道旋钮仍然照常生效
     *     （最终幅度 = 单通道值 × clothAmp）。
     *  ⚠️ 缺省 **1** ⇒ 不传参时与第二十三轮逐位一致（可回滚）。
     *  ⚠️ `<= 0` ⇒ 四条通道全部关掉（等于 `?secpiece=-1&secshawl=-1&secside=-1`）。
     */
    clothAmp?: number;
    /**
     * ★★★ 第二十五轮：**三片布各自的弹簧刚度乘数**（缺省都是 **1** = 逐位回滚）。
     *
     *  用户 m03364：「cloth_map_view.jpg 中 8 号布料飘的太大，单独调。」
     *  `?secstiffk=` 是**全局**乘数，一调四片一起变；这三条是**分片**的，
     *  因为在同一刚度下各片的滞后量本来就差很多（实测 `dev` 口径根本不同）。
     *
     *  · `?secstiffcape=`   → 材质组 2 = **6 披风**
     *  · `?secstiffribbon=` → 材质组 3 = **8 带**（用户点名要单独调的那片）
     *  · `?secstiffshawl=`  → 材质组 4 = **4 披肩**
     *
     *  ⚠️ 与 `?secstiffother=`（按「不是头发也不是裙」这一刀切）不冲突：
     *     那一条乘在 `stiff[i]` 初值上，这三条乘在 `matGroup` 建好**之后**，
     *     两者相乘。不传任一条时都是 1 ⇒ 精确回滚。
     *  ⚠️ 量程 [0.05, 20]，与 `?secstiffk=` 同量程。
     */
    stiffCape?: number;
    stiffRibbon?: number;
    stiffShawl?: number;
    /**
     * ★★★ 第二十五轮 C：**布料链一致化强度** α（0..1，缺省 **0** = 关 = 逐位回滚）。
     *
     *  问题（用户 m03364，`clothamp=0&secstiffk=20`）：
     *    「6 号布料应该是两半是一个整体，同时往左右循环飘，目前是分开各飘各的」
     *    「4 号布料尾部飘很大，上面几乎不动，需要整体飘」
     *    「8 号布料飘的太大，单独调」
     *
     *  根因：链式求解的滞后是**累积**的 —— 下垂链上每一节都吃到上面所有节的误差，
     *  于是「梢部摆得最大、根部几乎不动」是必然结果，**不是参数能调平的**
     *  （实测披肩 下 11.76° / 中 3.58° / 上 2.74°，比值 4.29；
     *    `?secstiffk=` 从 1 扫到 20 只把整体压低，梯度不变）。
     *
     *  机制：主循环是**父先子后**，处理第 i 根骨时父骨解算方向已定稿。
     *  把本骨方向朝父骨方向混合：`dir ← normalize((1−α)·dir + α·dir_parent)`。
     *  · α = 0 ⇒ 逐位不变（缺省）
     *  · α → 1 ⇒ 整条链方向一致 = 一片布**像刚性体一样整体转**
     *  · 顺带把梢部相对根部的乱甩压掉 ⇒ 8 带的可见摆幅下降
     *
     *  `?secnetcape=` 2 披风 / `?secnetribbon=` 3 带 / `?secnetshawl=` 4 披肩 / `?secnetskirt=` 5 裙
     */
    netCape?: number;
    netRibbon?: number;
    netShawl?: number;
    netSkirt?: number;
    /**
     * ★★★ 第二十五轮 D：**压住飘动**强度 β（0..1，缺省 **0** = 关 = 逐位回滚）。
     *
     *  为什么需要（实测）：`clothamp=0&secstiffk=20` 下 8 带位移 pp 均 **0.1801 m**；
     *  给带单独加刚度 `?secstiffribbon=` 1 → 3 → 8 得 **0.1801 → 0.1508 → 0.1514**
     *  （**3 到 8 不再下降**）⇒ 到地板了。地板 = 刚度∞ ⇒ `dir ≡ restDir`（**动画方向**）
     *  ⇒ 骨尾位移 = **MMD 动画自己的裙骨关键帧**。刚度这条路已走到底。
     *
     *  机制：把本骨方向朝**站定姿态**方向 `holdDir` 混合：
     *      `dir ← normalize((1−β)·dir + β·holdDir)`
     *  · β = 0 ⇒ 逐位不变
     *  · β → 1 ⇒ 布料钉在站立姿态，不再随动画摆 ⇒ 位移必然 → 0
     *
     *  `holdDir` 运行期自采：站定（`stepPhase` 非数）时每帧把 `_vRest` 存进去。
     *
     *  `?secholdcape=` 2 披风 / `?secholdribbon=` 3 带 / `?secholdshawl=` 4 披肩 / `?secholdskirt=` 5 裙
     */
    holdCape?: number;
    holdRibbon?: number;
    holdShawl?: number;
    holdSkirt?: number;
    /**
     * ★★★ 第二十一轮：「裙子被大腿**顶起来往前飘**」的最大角
     *  （度，`?secthigh=`，缺省 **28**；`<= 0` 关）。定案依据见
     *  `MmdCharacter.tsx` 的 `SEC_THIGH` 注释。
     */
    thighDeg?: number;
    /** thigh 高度带的下界（**占裙摆自身竖直跨度的比例**，缺省 0.30）`?secthighlo=` */
    thighLo?: number;
    /** thigh 高度带的上界（同上，缺省 0.65）`?secthighhi=` */
    thighHi?: number;
    /**
     * thigh 前顶的**符号**（`?secthsign=`，缺省 **+1**；±1 只有两种）。
     *  ⚠️ 必须实测，不能凭公式猜：几何上「绕侧向轴转负角 = 向前」对**朝 −Z 建模**的
     *  MMD 骨骼成立，但本模型的裙骨朝向与 `fwdLocal` 的相对关系要量过才知道。
     */
    thighSign?: number;
    maxBones?: number;
}

/**
 * ★★★ 第二十一轮：按**材质名**反查「哪些骨属于哪片布」。
 *
 * 材质名才是唯一可靠的归属：`披风 / 披风饰 / 带 / 裙 / 袖 / 披肩 / 髮` 各是一片。
 * 实测（`_tools/matdump.js` + `__mmd.mmdMaterials()`，本模型 26 个材质）：
 *    `披风` 77 骨 / `披风饰` 37 / `带` 74 / `裙` 124 / `袖` 89 / `披肩` 37
 *
 * ❗️ 三条必须遵守的（全都是踩过的）：
 *   ① **不能按骨名扩散**。本模型 `Skirt_0_1` 一个名字就有 20 个实例
 *      （546 根 `Skirt_*` 里 92 个重名）。第一版建了「骨名 → 布料骨下标**数组**」
 *      再 `for (const li of locals) out[li] = id` ⇒ 材质命中的名字被扩散到所有同名骨，
 *      实测选骨从真实的 **200 根**膨胀到 **479 根**，导致「本该只动披风」的通道
 *      把整圈裙摆也转了 ⇒ 下摆被掀到 **1.12 m**（腰高）= 用户说的「到处乱飘」。
 *      ✅ 正确做法：材质 group 里读到的是 **skeleton 骨下标 `bi`**，直接用
 *      `allBones[bi]` 取到**同一个对象**，再按**对象同一性**（`===`）在 `bones[]` 里
 *      找它的下标。同一性由对象身份保证，与名字无关，天然不扩散。
 *   ② `geometry.groups` 的 `start/count` 是**索引缓冲区**位置，不是顶点号。
 *      必须先 `vi = index.array[j]` 再读 `skinIndex[vi * itemSize + k]`。
 *   ③ 同一段几何会被两套 group 覆盖（本体 + 描边），`materialIndex` 可能越界
 *      ⇒ 组要跳过而不是崩。
 */
function collectPieceSel(mesh: THREE.SkinnedMesh, n: number, bones: THREE.Bone[]): Uint8Array {
    const out = new Uint8Array(n);          // 0 = 不是片类布，1 = 披风，2 = 带
    try {
        const g = (mesh as any).geometry as THREE.BufferGeometry | undefined;
        const idx = g?.index;
        const si = g?.attributes?.skinIndex as THREE.BufferAttribute | undefined;
        const sw = g?.attributes?.skinWeight as THREE.BufferAttribute | undefined;
        const groups = g?.groups;
        if (!g || !idx || !si || !sw || !groups) return out;
        const rawMats: any = (mesh as any).material;
        const mats: any[] = Array.isArray(rawMats) ? rawMats : [rawMats];
        const itemSize = (si as any).itemSize || 4;
        const iArr = (idx as any).array as ArrayLike<number>;
        const siArr = (si as any).array as ArrayLike<number>;
        const swArr = (sw as any).array as ArrayLike<number>;
        /* ★ 对象 → 布料骨下标（唯一性靠对象身份，不靠名字）。见上面 ①。 */
        const allBones: THREE.Bone[] = ((mesh as any).skeleton?.bones ?? []) as THREE.Bone[];
        const objToLocal = new Map<THREE.Bone, number>();
        for (let i = 0; i < n; i++) if (bones[i]) objToLocal.set(bones[i], i);
        for (const gr of groups) {
            const m = mats[gr.materialIndex as number];
            const mn: string = m?.userData?.mmdMaterial?.name || '';
            if (!mn) continue;
            let id = 0;
            if (mn.indexOf('披风') >= 0 && mn.indexOf('披风饰') < 0) id = 1;
            else if (mn.indexOf('带') >= 0) id = 2;
            /* ★ 第二十二轮：片 3 = 披肩（材质名含 `披肩`、不含 `披肩饰`）。
             *  用户：「编号4 你确实是向前摆动了，但是只有最下部分摆动。这布料是一个整体，
             *  不是上面不动下面往前动。」⇒ 需要一条**整片同权**的独立通道
             *  （不能走袖子的 `hw` 高度减推，那正是"只有下部分动"的来源）。 */
            else if (mn.indexOf('披肩') >= 0 && mn.indexOf('披肩饰') < 0) id = 3;
            if (!id) continue;
            const end = Math.min((gr.start as number) + (gr.count as number), iArr.length);
            for (let j = gr.start as number; j < end; j++) {
                const vi = iArr[j];
                if (vi == null) continue;
                for (let k = 0; k < itemSize; k++) {
                    if (!(swArr[vi * itemSize + k] >= 0.15)) continue;
                    const b = allBones[siArr[vi * itemSize + k]];
                    if (!b) continue;
                    const li = objToLocal.get(b);
                    if (li === undefined) continue;
                    out[li] = id;
                }
            }
        }
    } catch (e) {
        /* 材质表读不到就整条通道关闭（不影响其它通道） */
        if (typeof console !== 'undefined') console.warn('[secpiece] 材质反查失败，整片通道关闭：', e);
        out.fill(0);
    }
    return out;
}

/** 收集 PMX 里 `mode === 'static'` 的刚体 —— 它们就是「布料该躲开的身体」 */
function collectColliders(mesh: THREE.SkinnedMesh): { bones: THREE.Bone[]; shape: number[]; size: number[][]; pos: number[][]; rot: number[][] } {
    const skel: any = (mesh as any).skeleton;
    const all: THREE.Bone[] = skel?.bones ?? [];
    const bodies: any[] = ((mesh.userData as any)?.mmdPhysics?.rigidBodies) ?? [];
    const bones: THREE.Bone[] = [];
    const shape: number[] = [];
    const size: number[][] = [];
    const pos: number[][] = [];
    const rot: number[][] = [];
    for (const rb of bodies) {
        if (!rb || rb.mode !== 'static') continue;
        const bi = rb.boneIndex;
        if (typeof bi !== 'number' || bi < 0 || bi >= all.length) continue;
        const b = all[bi];
        if (!b) continue;
        bones.push(b);
        shape.push(rb.shape === 'sphere' ? 0 : rb.shape === 'box' ? 1 : 2);
        size.push(rb.size ?? [0.1, 0, 0]);
        pos.push(rb.position ?? [0, 0, 0]);
        rot.push(rb.rotation ?? [0, 0, 0]);
    }
    return { bones, shape, size, pos, rot };
}

export function createSecondaryMotion(
    mesh: THREE.SkinnedMesh,
    skip: Set<string>,
    opts: SecondaryOptions = {},
): SecondaryRig {
    const stiffness = opts.stiffness ?? 7.5;
    const limitDeg = opts.limitDeg ?? 22;
    /* ★★★ 第二十四轮 v4：弹簧刚度/限角的**乘数**（见 `SecondaryOptions.stiffK`）。
     *  ⚠️ 必须在下面 `stiff[i]` / `limit[i]` 的赋值**之前**取，否则乘不进去
     *     （本文件踩过「常量顺序错 ⇒ 静默不生效」，见第 1600 行那段注释）。 */
    const stiffK = Math.max(0.05, Math.min(20, opts.stiffK ?? 1));
    const limitK = Math.max(0.01, Math.min(5, opts.limitK ?? 1));
    const kHair = Math.max(0.05, Math.min(20, opts.stiffHair ?? 1));
    const kSkirt = Math.max(0.05, Math.min(20, opts.stiffSkirt ?? 1));
    const kOther = Math.max(0.05, Math.min(20, opts.stiffOther ?? 1));
    const gravity = opts.gravity ?? 9.8;
    const drag = Math.min(0.95, Math.max(0, opts.drag ?? 0.25));
    const wind = Math.max(0, opts.wind ?? 6);
    const windFront = Math.max(0, Math.min(2, opts.windFront ?? 0));   // 前侧布片的风力系数，见 windFront 的注释
    /* ★★★ 裙摆最下摆不吃那股「吹向身后」的风（用户 m11430 任务3）。见 `windHem` 注释。 */
    const windHem = Math.max(0, Math.min(1, opts.windHem ?? 0.10));
    /* 高度过渡窗口 —— **按裙骨自身的竖直跨度做相对量**，不写死世界 y。
     * 理由：本模型骨架根在世界 y≈0.25，`Skirt_*` 世界高度实测跨 [0.40, 1.80]，
     * 但换姿势/换缩放后绝对高度会漂，写死死值会在别处失灵。
     * 语义：`hemHi` = 「占裙摆竖直跨度多少比例以内算下摆」，`hemLo` 恒为底端。
     * 取 0.45 ⇒ 最低 45% 那一段（含 `Skirt_12..16`）参与，越往上权重线性归零。 */
    const hemLo = 0;
    const hemHi = Math.max(hemLo + 1e-3, opts.hemHi ?? 0.45);
    /* ★★★ 裙摆下摆略微前倾（用户 m11430 任务3 后半句）。见 `hemFwdDeg` 注释。 */
    const hemFwdAmp = (opts.hemFwdDeg ?? 4) > 0 ? Math.min(20, opts.hemFwdDeg ?? 4) / DEG : 0;
    /* ── ★★★ 落脚脉冲（用户 m07388 / 参考视频实测）──────────────────────────
     *  见 `SecondaryRig.landPulse` 上方的长注释。`?secland=-1`（或 0）关掉整条通道。
     *  `landLiftAmp` / `landSpreadAmp` 是两个**独立的**包络幅度 ——
     *  参考视频里垂直抬升（`dH` pp 46.5 px）与外扩（`hemW` pp 84.8 px）峰相位不同
     *  （0.98 vs 0.65 步），不能合成一个包络。 */
    const landDegRaw = opts.landDeg ?? 9;
    /* ★ 上限 30° → 60°：参考视频的下摆垂直脉冲 pp ≈ 0.31 m，而逐骨旋转的竖直位移是
     *  `L·(1−cosθ)` 的二阶小量（L≈0.62 m）⇒ 30° 只够 0.14 m（实测 `lowY.pp` 0.077→0.218），
     *  要够到 0.31 m 必须允许更大角度。60° 是「布片朝径向外侧翻起」仍算合理姿态的上限，
     *  再大就会让裙摆横着戳出去。 */
    const landTry = landDegRaw > 0 ? Math.min(60, landDegRaw) / DEG : 0;
    const landLiftAmp = landTry > 0
        ? (opts.landLiftDeg !== undefined
            ? (opts.landLiftDeg > 0 ? Math.min(60, opts.landLiftDeg) / DEG : 0)
            : landTry)
        : 0;
    const landSpreadAmp = landTry > 0
        ? (opts.landSpreadDeg !== undefined
            ? (opts.landSpreadDeg > 0 ? Math.min(60, opts.landSpreadDeg) / DEG : 0)
            : landTry * 0.75)
        : 0;
    /* 高度权重窗口：与 `hemHi` 同语义、但**裙摆与头发各自归一**（见 `landWgt` 的注释）。 */
    const landHi = Math.max(0.02, Math.min(1, opts.landHi ?? 0.45));
    /* 头发增益：参考视频 `dHair` pp 73.3 px ÷ `dH` pp 46.5 px = 1.58×。
     * 但头发骨长（1.27–2.27 m）本来就比裙摆（0.61–0.68 m）长 2–3 倍，同角度下会动更多，
     * 所以不能直接用 1.58 当增益；实测 30° 时头发 `lowY` 只有裙摆的 0.83×（径向力臂短，
     * 发根贴中轴），补到 1.35 后发梢 0.17 m vs 裙摆 0.29 m，比例才接近参考的 1.58×。 */
    const landHairK = Math.max(0.1, Math.min(4, opts.landHairK ?? 1.35));
    /* ★ 第四十二轮：头发骨尾世界 Y 底限（米）。`<= 0` = 整条通道关闭。 */
    const hairFloor = Math.max(0, Math.min(2.2, opts.hairFloor ?? 0));
    /** 外扩权重的下段偏置（0 = 下摆最末一截完全不吃外扩；缺省 0.25） */
    const spBias = Math.max(0, Math.min(1, opts.landSpBias ?? 0.25));
    /* 两条包络的相位/宽度（单位 = 一步的比例）。数值全部来自**逐桶相位折叠**读数
     *  （`_tools\ref_shape2.py` 对 `_logs\hemref\p2_side.jsonl` 的 6 个强涟漪峰切步、
     *  24 桶归一化，b0 = 落脚那一帧）：
     *   · **头发 `dHair` 是全表最干净的信号**（掩膜边界稳定，不受地面涟漪干扰）：
     *     b0 = 最高（norm 1.00）→ b4 就落到 0.04 → b5–b21 全程贴底 → b22 回升。
     *     ⇒ **抬升在落脚那一帧瞬时到顶，然后 4 个桶（≈0.17 步 ≈0.20 s）内衰减完**。
     *   · `h`（发顶→下摆包围盒高）同样 b0 最大、b4 最小，同相位、独立佐证。
     *   · `hemW`（裙摆剪影宽）：b2 触底（norm 0.00）→ 单调涨到 **b15 = 0.625 步**取满
     *     （1.00）→ 回落 ⇒ 外扩峰在 **0.62**、对称高斯。
     *  ⚠️ `dH`（下摆离地）在 b0 与 b23 有**假峰**：`dH = glowY − ymax`，而落脚处地面涟漪
     *     最亮最宽 ⇒ `glowY` 被拉高、读数失真。**别拿 b0/b23 的 `dH` 定相位**。
     *  ⚠️ 早前注释写的 `landLiftPh = 0.19` 是错的（那个数出自被上身污染过的 `h`），
     *     已按干净信号改回 **0.0**；`landLiftD` 也从 0.35 收紧到 0.12 才是「4 桶衰完」。 */
    const landLiftPh = Math.max(0, Math.min(1, opts.landLiftPh ?? 0.0));
    const landSpreadPh = Math.max(0, Math.min(1, opts.landSpreadPh ?? 0.62));
    const landLiftW = Math.max(0.005, Math.min(0.5, opts.landLiftW ?? 0.05));
    const landLiftD = Math.max(0.02, Math.min(0.9, opts.landLiftD ?? 0.12));
    const landSpreadW = Math.max(0.02, Math.min(0.9, opts.landSpreadW ?? 0.30));
    const carry = Math.max(0, Math.min(1, opts.carry ?? 1));           // 角色位移补偿，见 carry 的注释
    const collide = opts.collide ?? true;
    const colScale = Math.max(0.1, opts.colScale ?? 1.35);
    const colScaleLeg = Math.max(0.1, opts.colScaleLeg ?? 2.0);
    const slackMax = Math.max(0, opts.slackMax ?? 0.015);
    const iterations = Math.max(1, Math.min(8, Math.round(opts.iterations ?? 3)));
    const rodSamples = Math.max(1, Math.min(8, Math.round(opts.rodSamples ?? 4)));
    const repelD = Math.max(0, Math.min(0.20, opts.repel ?? 0.010));
    const repelCut = Math.max(0.005, Math.min(0.5, opts.repelCut ?? 0.06));
    const repelW = Math.max(0, Math.min(2, opts.repelW ?? 1));
    const repelEvery = Math.max(1, Math.min(60, Math.round(opts.repelEvery ?? 8)));
    const maxBones = opts.maxBones ?? 600;

    const { bones: all, hair, cloth, excluded } = collectSecondaryBones(mesh, skip);
    const bones = all.slice(0, Math.max(1, maxBones));
    const n = bones.length;

    const parentIdx = new Int32Array(n).fill(-1);
    const headLocal = new Float32Array(n * 3);
    const restLen = new Float32Array(n);
    const restDirLocal = new Float32Array(n * 3);
    const animLocal: THREE.Quaternion[] = new Array(n);
    const particle = new Float32Array(n * 3);
    const particlePrev = new Float32Array(n * 3);
    const limit = new Float32Array(n);
    const stiff = new Float32Array(n);
    const keep = new Float32Array(n);

    // 父骨在本列表里的下标。**必须真的沿 parent 链找** —— MMD 骨树中间夹着空 Object3D，
    // 而且被 `skip` 掉的骨（上半身、首…）正好是很多链的根。
    const idxOf = new Map<THREE.Object3D, number>();
    bones.forEach((b, i) => idxOf.set(b, i));

    for (let i = 0; i < n; i++) {
        const b = bones[i];
        let p: THREE.Object3D | null = b.parent;
        while (p) {
            const k = idxOf.get(p);
            if (k !== undefined) { parentIdx[i] = k; break; }
            p = p.parent;
        }
        const lx = b.position.x, ly = b.position.y, lz = b.position.z;
        headLocal[i * 3] = lx; headLocal[i * 3 + 1] = ly; headLocal[i * 3 + 2] = lz;
        const len = Math.hypot(lx, ly, lz);
        restLen[i] = len;
        if (len > 1e-6) {
            restDirLocal[i * 3] = lx / len;
            restDirLocal[i * 3 + 1] = ly / len;
            restDirLocal[i * 3 + 2] = lz / len;
        } else {
            restDirLocal[i * 3 + 1] = 1;
        }
        animLocal[i] = b.quaternion.clone();

        // 头发硬一点、裙摆软一点；袖饰/披风居中
        const isHair = /Hair/.test(b.name);
        const isSkirt = /Skirt/.test(b.name);
        /* ★ 第二十四轮 v4：限角乘 `limitK`、刚度乘「全局 × 分片」两级。
         *  片类系数（1.5 / 1.0 / 0.9 与 1.4 / 0.75 / 1.0）一个都没动 ——
         *  那些是历史实测定案的相对配比，这里只在外层加乘数。 */
        limit[i] = ((isHair ? limitDeg * 1.5 : isSkirt ? limitDeg : limitDeg * 0.9) / DEG) * limitK;
        stiff[i] = (isHair ? stiffness * 1.4 * kHair
            : isSkirt ? stiffness * 0.75 * kSkirt
                : stiffness * kOther) * stiffK;
        keep[i] = 1 - (isHair ? drag * 0.6 : isSkirt ? drag * 1.15 : drag);
    }

    // 爬到骨骼树的最顶端
    let root: THREE.Object3D | null = bones[0] ?? null;
    while (root && root.parent) root = root.parent;

    // ── ★ 碰撞体：把 PMX 的静止刚体原样搬过来（形状/尺寸/位置/朝向全都现成） ──
    const C = collide ? collectColliders(mesh) : { bones: [], shape: [], size: [], pos: [], rot: [] };
    const colN = C.bones.length;
    const colBone = C.bones;
    const colLocal = new Float32Array(colN * 3);
    const colR = new Float32Array(colN);
    const colHalf = new Float32Array(colN);
    const colAxis = new Float32Array(colN * 3);
    const colPmx = new Float32Array(colN * 6);
    const colShape = new Uint8Array(colN);
    for (let j = 0; j < colN; j++) {
        const s = C.size[j];
        if (C.shape[j] === 0) {              // 球
            colR[j] = s[0]; colHalf[j] = 0;
        } else if (C.shape[j] === 1) {       // 盒 → 用外接球近似
            colR[j] = 0.5 * Math.max(s[0], s[1], s[2]); colHalf[j] = 0;
        } else {                             // 胶囊（MMD 的 size = [半径, 圆柱长, 0]）
            colR[j] = s[0]; colHalf[j] = 0.5 * s[1];
        }
        colShape[j] = C.shape[j];
        const p = C.pos[j], r = C.rot[j];
        colPmx[j * 6] = p[0]; colPmx[j * 6 + 1] = p[1]; colPmx[j * 6 + 2] = p[2];
        colPmx[j * 6 + 3] = r[0]; colPmx[j * 6 + 4] = r[1]; colPmx[j * 6 + 5] = r[2];
        colAxis[j * 3 + 1] = 1;              // 先填模型空间的 Y 轴，初始化时再转到骨局部空间
    }
    /* ★★★ 腿骨碰撞体单独放大（`?seccolsleg=`，缺省 2.0）—— 用户 m14756 的判据。
     *  为什么需要它：PMX 的静止刚体是**贴骨轴**的粗代理，而布片是**面** —— 网格可以
     *  离自己的骨轴好几厘米。只把骨轴推出 `colScale×R` 并不保证**网格**离开**可见的腿**。
     *  实测（真实步速连走 2.6 s、`?secframe=1&stance=0`）：`?seccols=1.35` 时
     *  `Skirt_1_0⇠D` 骨棒最深插进原始半径 **47.5 mm**（6 对/帧、57/70 帧 >5 mm）；
     *  `?seccols=2.0` 起 `maxPenVis = 0`（0 对）。但全局放大到 2.0 会把上身/袖子的
     *  代理一起吹胀（裙摆被顶得外扩），所以只放大**腿**那几个刚体
     *  （宿主骨名匹配 `/(足|ひざ|足首)D$/`），上身的 1.35 保持不变。 */
    const colMul = new Float32Array(colN);
    for (let j = 0; j < colN; j++) {
        const nm = ((colBone[j].userData as { mmdBoneName?: string })?.mmdBoneName) ?? colBone[j].name;
        colMul[j] = /(足|ひざ|足首)D$/.test(nm) ? colScaleLeg : 1;
    }

    /* ── ★★ 方向性约束的坐标系自标定（用户 m11933 / 先搜再做 m11937）────────────
     *  目的：知道每根悬挂骨「在身体的哪一侧」，才能在**角色朝向坐标系**里禁止它朝身体方向摆。
     *  ★ MMD 骨没有静止旋转（rest rotation 恒为单位四元数）⇒ 绑定姿势下把 `bone.position`
     *    沿父链累加就是绝对位置。所以不需要读任何 matrixWorld（MMD 骨 `matrixAutoUpdate`
     *    为 false，`updateWorldMatrix()` 也不重算 `matrix`，读矩阵会拿到绑定姿势的陷阱见判据 P）。
     *  朝向用「左足首 → 左つま先」的水平分量自标定（脚尖指向角色正面），不依赖任何 URL 参数。
     */
    const antiDegRaw = opts.antiDeg ?? 8;
    // ★ `?secanti=-1` = 关；`?secanti=0` = **最严格**（完全不许朝身体方向偏）。
    //   所以「是否启用」与「容差多大」必须是两个量，否则 0 会被当成关闭，
    //   而 `antiStat()` 在关掉时也拿不到分类 ⇒ A/B 的对照组无从测量。
    const antiOn = antiDegRaw >= 0;
    const antiDeg = Math.min(89, Math.max(0, antiDegRaw));
    const antiHair = opts.antiHair ?? false;
    const hairSolve = opts.hairSolve ?? false;
    const axisTol = Math.sin(antiDeg / DEG);
    const fwdLocal = new Float32Array([0, 0, 1]);
    const sideLocal = new Float32Array([1, 0, 0]);
    const axisSel = new Uint8Array(n).fill(2);
    const axisSign = new Float32Array(n);
    const restAxis = new Float32Array(n);
    // ★ 肢体驱动（用户 m12638 / m12655）：`?secdrive=<度>`，缺省 18；`?secdrive=-1` 关
    const driveDegRaw = opts.driveDeg ?? 18;
    const driveAmp = driveDegRaw > 0 ? Math.min(60, driveDegRaw) / DEG : 0;
    // 相位超前：0..0.5 s（走路周期 1.567 s，超前半个周期已经把下一步的摆幅算进来了，再多就是猜）
    const driveLead = Math.max(0, Math.min(0.5, opts.driveLead ?? 0.10));
    /* ★★ 袖子向外撑开（用户 2026-10-21 反馈1）。`<= 0` 当关（含 `?secflare=-1` 与 0）。 */
    const flareDegRaw = opts.flareDeg ?? 16;
    const flareAmp = flareDegRaw > 0 ? Math.min(60, flareDegRaw) / DEG : 0;
    const flareSpeed = Math.max(0.05, opts.flareSpeed ?? 0.9);
    const driveSel = new Uint8Array(n);
    /* ★★★ 侧向摆动（用户 m18305「袖子向两侧飘」）的专属分类位。
     *  `?secside=<度>`（缺省 60，与 `MmdCharacter.tsx` 的 `SEC_SIDE` 同值）是**侧向**摆的幅度；`<= 0` 关（含 `-1`）。
     *  开关为 0 时下面既不标 `secdriveSel`、运行期那段也不跑 ⇒ 逐位回到改前行为。 */
    const secdriveSel = new Uint8Array(n);
    /** 真正被标为侧向摆动的骨数（分类后填，见下面袖骨筛选） */
    let _nSideBones = 0;
    /* ★★★ 裙摆下摆通道（用户 m11430 任务3）：选骨表 + 高度权重，构建期算一次。
     *  `hemSel` = 属于下摆的 Skirt 骨；`hemWgt` = 0(最底满额)..1(窗口上界归零)。 */
    const hemSel = new Uint8Array(n);
    const hemWgt = new Float32Array(n);
    let _nHemBones = 0;
    /** ★ 落脚脉冲真正作用的骨数（分类后填，见 `SecondaryRig.landPulse`） */
    let _nLandBones = 0;
    /* ★ 落脚脉冲的骨权重表。⚠️ 必须声明在 `if (true) {` 分类块**外面** ——
     *  分类块在 `return` 之前就结束了，写在里面外面看不见（会静默变成 undefined）。 */
    const landWgt = new Float32Array(n);
    /* ★ 外扩专用权重（**反高度梯度**：上段满额、下段归零），见分类块里 `landSpreadWgt` 的注释。
     *  与 `landWgt`（抬升用，下段满额）分工：抬升转下段、外扩转上段，两者角度分别乘各自的权重。 */
    const landSpreadWgt = new Float32Array(n);
    /* ── ★★★ 第二十一轮：整片布（披风/带）与 thigh 前顶 ────────────────────
     *  两者 `<= 0` 即关 ⇒ 逐位回到本轮改动前（可回滚旋钮）。 */
    /* ★★★ 第二十四轮：四片布总幅度乘数（`?clothamp=`，缺省 1）。见 `SecondaryOptions.clothAmp`。
     *  ⚠️ 必须在下面四条幅度**之前**取，否则乘不进去（本文件踩过「常量顺序错 ⇒ 静默不生效」）。 */
    const clothAmp = Math.max(0, opts.clothAmp ?? 1);
    const pieceDegRaw = opts.pieceDeg ?? 12;
    /* 6披风 / 8带：乘 clothAmp（带另有 0.65 轻量化系数，在逐骨那段，比例不受影响） */
    const pieceAmp = pieceDegRaw > 0 ? (Math.min(45, pieceDegRaw) / DEG) * clothAmp : 0;
    /* ★ 第二十九轮（用户 m06677「8号布料回滚步态V3」）：
     *  V3 的 secondaryMotion.ts 里根本没有 piece 通道（`pieceSel` 0 处命中），
     *  所以「回滚 8号」= 带不吃 piece 通道。缺省 0；披风仍是 1。
     *  想恢复第二十五轮口径：`?secpiecewrib=0.65`。 */
    const pieceWRib = Math.max(0, Math.min(2, opts.pieceWRib ?? 0));
    const piecePh = opts.piecePh ?? 0;
    const thighDegRaw = opts.thighDeg ?? 28;
    const thighAmp = thighDegRaw > 0 ? Math.min(60, thighDegRaw) / DEG : 0;
    const thighLoK = Math.min(0.98, Math.max(0, opts.thighLo ?? 0.30));
    const thighHiK = Math.max(thighLoK + 0.01, Math.min(1, opts.thighHi ?? 0.65));
    const thighSign = (opts.thighSign ?? 1) < 0 ? -1 : 1;
    /** 片归属表（0/1/2/3）。★ 即使 `pieceAmp <= 0` 也照样建表（只读的一次性代价），
     *  留着才能在同一批骨上做「开/关」的逐骨 A/B。 */
    const pieceId = collectPieceSel(mesh, n, bones);
    const pieceSel = new Uint8Array(n);
    const ribbonSel = new Uint8Array(n);
    /** ★ 第二十二轮：披肩（材质 `披肩`）单独一片，走**整片同权**通道 */
    const shawlSel = new Uint8Array(n);
    let _nPiece = 0, _nRibbon = 0, _nShawl = 0;
    for (let i = 0; i < n; i++) {
        if (pieceId[i] === 1) { pieceSel[i] = 1; _nPiece++; }
        else if (pieceId[i] === 2) { ribbonSel[i] = 1; _nRibbon++; }
        else if (pieceId[i] === 3) { shawlSel[i] = 1; _nShawl++; }
    }
    /** 裙摆 thigh 带选择 + 前后侧权重（构建期算一次） */
    const thighSel = new Uint8Array(n);
    const thighWgt = new Float32Array(n);
    let _nThigh = 0;

    /* ★★★ 第二十四轮 v3：每根骨属于哪类布（见 `SecondaryRig.matGroup`）。
     *  ⚠️ 顺序即优先级：片布（材质确证）> 头发 > 裙 > 其它。
     *     披肩已从袖骨组摘掉，所以 `secdriveSel===1` 在这里是纯袖。 */
    const matGroup = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const nm = bones[i].name || '';
        if (pieceSel[i] === 1) matGroup[i] = 2;
        else if (ribbonSel[i] === 1) matGroup[i] = 3;
        else if (shawlSel[i] === 1) matGroup[i] = 4;
        else if (/Hair|髪/.test(nm)) matGroup[i] = 1;
        else if (secdriveSel[i] === 1) matGroup[i] = 6;
        else if (/Skirt/i.test(nm)) matGroup[i] = 5;
    }

    /* ★★★ 第二十五轮 C：一致化表（每骨 α + 父骨下标）。见 `SecondaryOptions.netCape`。
     *  `netA[i] > 0` 的骨才走那条分支 ⇒ 全 0 时下面的代码整段不执行，逐位回滚。 */
    const netA = new Float32Array(n);
    {
        const kNC = Math.max(0, Math.min(1, opts.netCape ?? 0));
        const kNR = Math.max(0, Math.min(1, opts.netRibbon ?? 0));
        const kNS = Math.max(0, Math.min(1, opts.netShawl ?? 0));
        const kNK = Math.max(0, Math.min(1, opts.netSkirt ?? 0));
        /* ⚠️ `parentIdx` 复用 `:1481` 那份（沿 parent 链上溯、跳过不在骨表里的骨），
         *  比「只看直接 parent」对 —— MMD 骨树中间夹着空 Object3D。不要重新声明。 */
        for (let i = 0; i < n; i++) {
            const g = matGroup[i];
            netA[i] = g === 2 ? kNC : g === 3 ? kNR : g === 4 ? kNS : g === 5 ? kNK : 0;
        }
    }
    /* ★★★ 第二十六轮：**片内父骨表**（`?secnet*=` 只能混同一片布的父骨）──────────
     *  真根因（`_logs/round26/u26b.jsonl`）：`?secnetshawl=0.7` 让 4 号披肩站定
     *  姿态的竖直增量 `dU` 中位从 **−0.0516（垂落）翻成 +0.0116（水平）**，
     *  即用户说的「飞成翅膀又一动不动」。原因不是参数太大，是**混错了父骨**：
     *  披肩骨挂在手臂父链上（§1.21 已查明），`parentIdx` 上溯命中的第一个骨
     *  是**水平伸出的袖骨** ⇒ 整片被拉平并冻住。
     *  ⇒ 一致化改成「片内」：只沿父链找 **同 `matGroup`** 的祖先。
     *  本片最根的一根找不到同片父骨 ⇒ `-1` ⇒ 它保持自己的解算方向（不走一致化）。
     *  ⚠️ 全 0 时下面仍整段不执行，与改动前逐位一致。 */
    const netParent = new Int32Array(n).fill(-1);
    {
        let anyNet = false;
        for (let i = 0; i < n; i++) if (netA[i] > 0) { anyNet = true; break; }
        if (anyNet) {
            for (let i = 0; i < n; i++) {
                if (netA[i] <= 0) continue;
                const g = matGroup[i];
                /* ⚠️ 必须逐跳上溯：MMD 骨树中间夹空 Object3D，且被 skip 的骨
                 *    （上半身、首…）正好是很多链的根，一跳不够。 */
                let p = parentIdx[i];
                let guard = 0;
                while (p >= 0 && guard++ < 64) {
                    if (matGroup[p] === g) { netParent[i] = p; break; }
                    p = parentIdx[p];
                }
            }
        }
    }
    /* ★★★ 第二十五轮 D：压住飘动的表（见 `SecondaryOptions.holdCape`）。 */
    const holdA = new Float32Array(n);
    {
        const kHC = Math.max(0, Math.min(1, opts.holdCape ?? 0));
        const kHR = Math.max(0, Math.min(1, opts.holdRibbon ?? 0));
        const kHS = Math.max(0, Math.min(1, opts.holdShawl ?? 0));
        const kHK = Math.max(0, Math.min(1, opts.holdSkirt ?? 0));
        for (let i = 0; i < n; i++) {
            const g = matGroup[i];
            holdA[i] = g === 2 ? kHC : g === 3 ? kHR : g === 4 ? kHS : g === 5 ? kHK : 0;
        }
    }

    /* ★★★ 第二十五轮：**三片布各自的刚度乘数**（见 `SecondaryOptions.stiffCape` 的注释）。
     *  ⚠️ 位置必须在 `matGroup` 建好之后、`keep[i]` 与求解循环之前。
     *     `stiff[i]` 的初值在上面的循环里已经乘过 `stiffK × kHair/kSkirt/kOther`，
     *     这里再乘一次「分片」的，两级乘数互不改写 ⇒ 任一条为 1 时该片逐位不变。 */
    {
        const kCape = Math.max(0.05, Math.min(20, opts.stiffCape ?? 1));
        const kRib = Math.max(0.05, Math.min(20, opts.stiffRibbon ?? 1));
        const kShw = Math.max(0.05, Math.min(20, opts.stiffShawl ?? 1));
        if (kCape !== 1 || kRib !== 1 || kShw !== 1) {
            for (let i = 0; i < n; i++) {
                const g = matGroup[i];
                if (g === 2) stiff[i] *= kCape;
                else if (g === 3) stiff[i] *= kRib;
                else if (g === 4) stiff[i] *= kShw;
            }
        }
    }

    /* ★★★ 第二十四轮 v3：头发径向让位 —— 邻接表（见 `SecondaryRig.hairSep`）。
     *  ⚠️ 只在**静止姿势**下按高度建表：`|Δy| < 0.25 m` 的布骨才算「可能挡到这一绺头发」。
     *     不按径向预筛（半径是运行期要判的量），也不按左右侧筛（头发会甩到另一侧）。 */
    const hairSep = Math.max(0, Math.min(0.15, opts.hairSep ?? 0.02));
    const hairSepStart = new Int32Array(n + 1);
    let hairSepList = new Int32Array(0);
    if (hairSep > 0) {
        const BAND = 0.25;
        /** 每根头发骨的邻居下标（先收数组，最后摊平成 CSR） */
        const acc: number[][] = [];
        let total = 0;
        for (let i = 0; i < n; i++) {
            if (matGroup[i] !== 1) { acc.push([]); continue; }
            const hy0 = bones[i].matrixWorld.elements[13];
            const nb: number[] = [];
            for (let j = 0; j < n; j++) {
                const gj = matGroup[j];
                if (gj < 2 || gj > 6) continue;          // 只要布（披风/带/披肩/裙/袖）
                const jy0 = bones[j].matrixWorld.elements[13];
                if (Math.abs(jy0 - hy0) > BAND) continue;
                nb.push(j);
            }
            acc.push(nb);
            total += nb.length;
        }
        hairSepList = new Int32Array(Math.max(total, 1));
        let k = 0;
        for (let i = 0; i < n; i++) {
            hairSepStart[i] = k;
            for (const j of acc[i]) hairSepList[k++] = j;
        }
        hairSepStart[n] = k;
    }

    /* ★ 第二十二轮：披肩整片通道的常量（见 `SecondaryRig.shawlAmp` 的注释）。
     *  幅度单列（缺省 5°，比披风/带的 12° 小）—— 用户说「摆动幅度有点大」。 */
    const shawlDegRaw = opts.shawlDeg ?? 5;
    /* 4披肩：乘 clothAmp */
    const shawlAmp = shawlDegRaw > 0 ? (Math.min(45, shawlDegRaw) / DEG) * clothAmp : 0;
    const shawlPh = opts.shawlPh ?? 0;
    /* ★ 第二十八轮：披肩刚性整片。摆幅**故意不乘 `clothAmp`** ——
     *  用户常在 `?clothamp=0` 下工作，那条乘数会把这一条一起关掉，
     *  结果又回到「只有下部分动」。 */
    const shawlRigid = (opts.shawlRigid ?? 1) > 0 ? 1 : 0;
    const shawlRigidAmp = Math.max(0, Math.min(60, opts.shawlRigidAmp ?? 10)) / DEG;
    /* ★ 第二十九轮：披肩整片前移。量程 [0,75] 度；符号单独给。 */
    const shawlPush = Math.max(0, Math.min(75, opts.shawlPush ?? 0)) / DEG;
    const shawlPushSign = (opts.shawlPushSign ?? 1) >= 0 ? 1 : -1;
    const shawlPushOsc = Math.max(0, Math.min(30, opts.shawlPushOsc ?? 2)) / DEG;
    /* ★ 片根骨：披肩里**第一根**（父骨不在披肩集合内的那一根更好，但构建期
     *  这里只要一个稳定代表即可 —— 它对所有骨用同一个驱动方向）。 */
    let _shawlRoot = -1;
    for (let i = 0; i < n; i++) if (shawlSel[i] === 1) { _shawlRoot = i; break; }

    const sideDegRaw = opts.sideDeg ?? 60;
    /* 1袖（静态侧张）：**不再乘 clothAmp** —— 这是「位置」，不是「飘动幅度」。
     *  踩过的坑（第三十五轮实测）：`?clothamp=0` 是调布料时最常用的隔离档，
     *  而这里原本乘 `clothAmp` ⇒ 0 时整条侧向通道直接不跑（176 根袖骨
     *  `sideN=0`，相对站定净外移 +0.007 m，与关掉逐位一致），用户看不到任何变化。
     *  现在取 `max(clothAmp, 0.35)`：clothamp≥0.35 时**逐位不变**（0.35 是历史缺省，
     *  第三十五轮 +0.125 m 的标定就是在它下面量的）；clothamp<0.35 时保底按 0.35 给，
     *  因为袖片横向离开躯干是静态位移，不该被「飘动总幅度」一票否决。 */
    const sideClothGain = Math.max(clothAmp, 0.35);
    const sideAmp = sideDegRaw > 0 ? (Math.min(60, sideDegRaw) / DEG) * sideClothGain : 0;
    const sideSpeed = Math.max(0.05, opts.sideSpeed ?? 0.9);
    /* ★ 侧摆时压掉前后摆的比例（缺省 0.35，见 `sideFrontKill` 的注释） */
    const sideFrontKill = Math.min(1, Math.max(0, opts.sideFrontKill ?? 0.35));
    /* ★ t16 侧摆静态份额（缺省 0.55，见 `sideStandK` 的注释） */
    const sideStandK = Math.min(1, Math.max(0, opts.sideStandK ?? 0.55));
    /* ★★★ t20 近裙摆减推量（见 `SecondaryRig.sideHiK`）。缺省 0.55 / 0.90 / 1.35。 */
    /* ★★★ t20 实测结论（决定缺省值）：**近裙摆减推量默认关（`k = 0`）**。
     *  扫过的档位（`?secclock=1.6`，X/Z 两走向各 3 帧）：
     *    k=0    X: x=0.25473 minDist=0.02068 u1=0 ／ Z: x=0.25978 minDist=0.04104 u1=0
     *    k=0.2  X: x=0.24719 minDist=0.02170 u1=0 ／ Z: x=0.24855 minDist=0.04898 u1=0
     *    k=0.35 X: x=0.25220 minDist=0.02231 u1=0 ／ Z: x=0.22644 minDist=0.05128 u1=0
     *    k=0.55 X: x=0.22998 minDist=0.01879 u1=0 ／ Z: x=0.22273 minDist=0.05985 u1=0
     *  ⇒ 减推量对净距的改善在噪声量级（0.021→0.022 m），却把侧向外移压掉 5~13%。
     *  原因：排除 `*錘` 端点骨后，真正参与判据的袖骨只有 `Bone_ArmLets01_*` / `02_*`
     *  四根，它们**全都**贴着裙摆上沿，按高度加权等于整体削推 —— 没有「只削最低那根」的
     *  空间。所以机制保留（`?secsideh=` 可开、可标定），缺省关，保住侧向优势。 */
    const sideHiK = Math.min(1, Math.max(0, opts.sideHiK ?? 0));
    /* ★★★ t20 标定实测（**现场量出来的，不是推算的**）：
     *  在真正做侧摆的那个循环里，`_vHead.y`（袖骨父骨世界原点）实测 **1.50 ~ 1.53**
     *  （`?secside=26` 三组一致）；而构建期 `sideArm` 抓到的关节 y 报 15.58 —— 两者
     *  差约 10 倍，是**两次采样时机不同**（构建期在 `scene.scale` 生效前采的）。
     *  所以一律用**运行期**的 `_vHead.y` 标定，窗口按 1.50 / 1.58 取。 */
    const sideHiLo = opts.sideHiLo ?? 1.50;
    const sideHiHi = Math.max(sideHiLo + 1e-3, opts.sideHiHi ?? 1.58);
    /* ★★★ 十七轮（用户 m12388）：侧展角的往复量（见 `SecondaryRig.sideOscAmp`）。
     *  `?secsideosc=`（度，缺省 2）；`<= 0` 关 ⇒ 逐位回到十六轮的常量侧展。
     *  `?secsideoscref=`（缺省 0.35）= 前臂前后投影的典型峰值，拿去归一成 −1..+1 的相位。 */
    const sideOscRaw = opts.sideOscDeg ?? 2;
    /* 1袖（随摆臂的往复量）：同 `sideAmp`，走 `sideClothGain`（同步解耦 clothAmp） */
    const sideOscAmp = sideOscRaw > 0 ? (Math.min(12, sideOscRaw) / DEG) * sideClothGain : 0;
    const sideOscRef = Math.max(0.05, opts.sideOscRef ?? 0.35);
    /** ★ 十七轮：每根袖骨属于哪一侧（0 = 左 / 1 = 右 / 255 = 认不出，不参与往复） */
    const sideOf = new Uint8Array(n).fill(255);
    /** 侧向摆动要量的胳膊关节：每侧 3 根（肩 / 肘 / 腕），最多 2 侧 */
    const sideArm: THREE.Object3D[] = [];
    /** 每一侧的关节根数（`[左, 右]`；`0` = 该侧没抓全，不参与） */
    const sideSideN = [0, 0];
    /** ★ t20 标定：`sideArm` 每根关节捕获时的世界 y（米），与 `sideArm` 同序 */
    const sideArmY: number[] = [];
    let flareBones = 0;
    const _limbRef = new Float32Array([NaN, NaN, NaN, NaN]);
    const limbA: Array<THREE.Bone | null> = [null, null, null, null];
    const limbB: Array<THREE.Bone | null> = [null, null, null, null];
    if (true) {
        const allBones: THREE.Bone[] = ((mesh as any).skeleton?.bones ?? []) as THREE.Bone[];
        const rootObj = (root ?? bones[0]) as THREE.Object3D;
        /** 绑定姿势下，该骨**相对骨架根**的绝对位置（PMX 单位）。沿父链累加 `position` */
        const bindOf = (b: THREE.Object3D | null): THREE.Vector3 | null => {
            if (!b) return null;
            const v = new THREE.Vector3();
            let p: THREE.Object3D | null = b;
            let guard = 0;
            while (p && p !== rootObj && guard++ < 64) {
                v.x += p.position.x; v.y += p.position.y; v.z += p.position.z;
                p = p.parent;
            }
            return v;
        };
        const pick = (cands: string[]): THREE.Bone | null => {
            for (const nm of cands) { const b = allBones.find((x) => x.name === nm); if (b) return b; }
            for (const nm of cands) { const b = allBones.find((x) => x.name.indexOf(nm) >= 0); if (b) return b; }
            return null;
        };
        const ankle = pick(['左足首', '左足首D', '左足首EX', 'LeftAnkle']);
        const toe = pick(['左つま先', '左つま先EX', '左足先EX', 'LeftToe']);
        const ctr = pick(['センター', 'Center', '全ての親', '下半身', 'LowerBody']);
        const aA = bindOf(ankle), aT = bindOf(toe), aC = bindOf(ctr);
        if (aA && aT) {
            let fx = aT.x - aA.x, fz = aT.z - aA.z;
            const fl = Math.hypot(fx, fz);
            if (fl > 1e-4) {
                fx /= fl; fz /= fl;
                fwdLocal[0] = fx; fwdLocal[1] = 0; fwdLocal[2] = fz;
                // side = up × fwd，up = (0,1,0) ⇒ (fz, 0, −fx)
                sideLocal[0] = fz; sideLocal[1] = 0; sideLocal[2] = -fx;
                // ★ 阈值 0.5 PMX 单位 ≈ 3.7 cm：比这更靠近中线的骨（脊背正中、后脑长发）不分类
                const MINOFF = 0.5;
                for (let i = 0; i < n; i++) {
                    if (!antiHair && /Hair|髪|髪2/.test(bones[i].name)) continue;
                    const off = bindOf(bones[i]);
                    if (!off) continue;
                    if (aC) { off.x -= aC.x; off.y -= aC.y; off.z -= aC.z; }
                    const fr = off.x * fwdLocal[0] + off.y * fwdLocal[1] + off.z * fwdLocal[2];
                    const lr = off.x * sideLocal[0] + off.y * sideLocal[1] + off.z * sideLocal[2];
                    if (Math.abs(fr) >= Math.abs(lr)) {
                        if (Math.abs(fr) > MINOFF) { axisSel[i] = 0; axisSign[i] = fr > 0 ? 1 : -1; }
                    } else if (Math.abs(lr) > MINOFF) {
                        axisSel[i] = 1; axisSign[i] = lr > 0 ? 1 : -1;
                    }
                    // ★ MMD 骨没有静止旋转 ⇒ 骨骼在绑定姿势下的局部轴与骨架根同向，
                    //   所以 `restDirLocal` 直接就是「根局部空间」里的悬挂方向。
                    const ax = axisSel[i] === 0 ? fwdLocal : axisSel[i] === 1 ? sideLocal : null;
                    if (ax) {
                        restAxis[i] = restDirLocal[i * 3] * ax[0]
                            + restDirLocal[i * 3 + 1] * ax[1]
                            + restDirLocal[i * 3 + 2] * ax[2];
                    }
                }
            }
        }

        /* ── ★★ 肢体驱动分类（用户 m12638 / m12655）───────────────────────────
         *  ① **胳膊驱动**：父链里出现 `左/右腕`、`左/右ひじ`、`左/右手首`（本模型确实
         *     用日文名，见 PMX 骨名表）⇒ 袖子、护腕、臂饰一类。它们必须**原样跟着胳膊
         *     前后摆**，否则胳膊从袖子里穿出来 —— 用户原话「否则一定穿模」。
         *     所以这一类**同时豁免方向性约束**（`driveSel===1` 在约束里被跳过）。
         *  ② **前侧件（腿驱动）**：体位分类已经是 `axisSel===0 && axisSign>0`
         *     （绑定姿势下挂在身体前方），只有它们接受腿的向前驱动。
         *     后侧件（`axisSign<0`）与左右件（`axisSel===1`）不驱动。
         *
         * ★★ 2026-10-21 修（袖子外撑 `?secflare=`）：**分类必须是构建期的事**，
         *   而且不能只由 `driveAmp > 0` 把门 —— 缺省 `?secdrive=-1`（驱动已回滚关闭）
         *   时 `driveAmp === 0`，于是 `driveSel` 全 0，`?secflare=` 那一段一行都不执行
         *   （实测 `flareN` 恒 0、DevStamp 上「袖骨 0 根」）——「参数打印正确 ≠ 功能生效」。
         *   现在只要**驱动或外撑任一开启**就分类；驱动本身仍由 `driveAmp > 0` 把门。
         *   本块只在 `createSecondaryMotion` 里跑一次，不进逐帧路径。
         */
        /* ⚠️ 门控必须同时看 `sideAmp`：侧向摆动（`?secside=`，缺省 60°）也要用这份
         *   `driveSel===1` 分类。只看 `driveAmp || flareAmp` 时，若有人把
         *  `?secflare=-1&secdrive=-1` 一起关掉做回滚，侧摆会跟着一起失效。 */
        if (driveAmp > 0 || flareAmp > 0 || sideAmp > 0) {
            const armRe = /^(左|右)(腕|ひじ|手首)/;
            /* ★★★ `?secskin=1` 诊断（用户 m18305 第七项修复的取证）——
             *  「满足 `armRe` 就算袖子」这条判据在真实模型上**几乎没命中袖子本体**。
             *  实测（本模型 573 骨）：`driveSel===1` 的 176 根里
             *    裙摆族 `Skirt_0..11` × 14 = 154 根（父链经 `左腕/左肩` 上去 ⇒ 被误当袖套），
             *    真臂饰 `Bone_ArmLets01/02_{L,R}{,錘}` 只有 22 根。
             *  原因：这套 PMX 的裙子布片**挂在上臂下**，只按骨名父链分类分不开。
             *  这里只在 `?secskin=1` 时逐骨打一次表（构建期，不进逐帧路径），
             *  不改变任何行为 —— 缺省一行都不执行。 */
            if (QNUM('secskin', 0)! > 0) {
                const tbl: string[] = [];
                for (let i2 = 0; i2 < n && tbl.length < 400; i2++) {
                    let p2: THREE.Object3D | null = bones[i2].parent;
                    let g4 = 0; let hit2 = '-';
                    while (p2 && p2 !== rootObj && g4++ < 12) { if (armRe.test(p2.name)) { hit2 = p2.name; break; } p2 = p2.parent; }
                    let ch = ''; let q2: THREE.Object3D | null = bones[i2].parent; let g5 = 0;
                    while (q2 && q2 !== rootObj && g5++ < 12) { ch = q2.name + '<' + ch; q2 = q2.parent; }
                    tbl.push(bones[i2].name + ' | arm=' + hit2 + ' | ' + ch);
                }
                // eslint-disable-next-line no-console
                (window as unknown as { __secskin?: string[] }).__secskin = tbl;
                console.log('[secskin] ' + tbl.join('\n[secskin] '));
            }
            for (let i = 0; i < n; i++) {
                let p: THREE.Object3D | null = bones[i].parent;
                let g2 = 0;
                while (p && p !== rootObj && g2++ < 12) {
                    if (armRe.test(p.name)) { driveSel[i] = 1; break; }
                    p = p.parent;
                }
                if (driveSel[i] === 0 && axisSel[i] === 0 && axisSign[i] > 0) driveSel[i] = 2;
                /* ★★★ 用户 m18305 第七项修复：「袖子的摆动方向向两侧，不随手臂前后」。
                 *  这一组就是**袖子本体的布片**（臂套 / 袖口 / 臂饰）。前后那一支
                 *  （上面 `_vSide` 那段）要给 `secdriveSel` 用，所以单独标出来；
                 *  改动前这里**没有这个变量**，行为因此与改前逐位一致。 */
                /* 旧路径（driveSel===1 全组）**不再**写 secdriveSel —— 见下面袖骨筛选。
                 *  保留这行只在「无 ArmLets 命名」的兜底里回填。 */
            }
            /* ★★★ 真正的袖骨（用户 m18305 第七项修复）─────────────────────────
             *  `driveSel===1` **不等于袖子**：`?secskin=1` 逐骨打表实测本模型 573 骨里
             *  该组 176 根 = 裙摆族 `Skirt_0..11` × 14（154 根）+ 真臂饰
             *  `Bone_ArmLets01/02_{L,R}{,錘}`（22 根 —— 其中 8 个独立骨，其余是同骨多
             *  材质/同名的附加项）。裙摆布片之所以命中，是因为这套 PMX 的裙子**挂在上臂
             *  骨下面**（`Skirt_x_y ← 左腕 ← 左肩C …`），只按父链分类分不开。
             *  ⇒ 侧向摆动只能作用在**骨名是臂饰/袖子**的那些骨上，并且**排除 `/Skirt/`**；
             *    否则「袖子向两侧飘」实际会把裙子往外掀。 */
            const sleeveRe = /(ArmLets|Sleeve|袖)/i;
            /* ★★★ 十四轮（用户 m02277 第三次反馈「袖子的部位你之前的修改没变化」）——
             *  **真正的根因在这条判据上，不在幅度、不在方向。**
             *
             *  实测（页面探针，`?seclock=1.6&secvelx=1.446&secside=60`）：
             *    `window.__secSideBones` = **8**  —— 侧摆只作用在 8 根骨上；
             *  这 8 根是 `Bone_ArmLets01/02_{L,R}`，皮肤权重合计 **882**（占全模型
             *  55943 的 1.6%）。而**挂腕的袖布**是 `Skirt_*` 命名：
             *    父链含 `腕/ひじ/手首` 的 Skirt 骨 = **168 根**，权重合计 **1128**
             *    （比 ArmLets 那 882 还多），y 高度 1.05~1.58 m（手垂下时的袖口位置）。
             *  上一行 `&& !/Skirt/i.test(nm)` 把这一整族**全排除了** —— 于是无论怎么
             *  抬 `?secside=`、怎么改推的方向，动的始终只是那 1.6% 的臂饰，袖布本体
             *  一动不动。这就是「改了没变化」的算术原因（前两轮改的是幅度和方向，
             *  两者都作用在被排除后的残集上）。
             *
             *  为什么可以纳入：`driveSel===1` 的判据是**父链**命中 `/^(左|右)(腕|ひじ|手首)/`，
             *  真正的裙子（挂 `下半身/上半身`）根本不满足它 —— 实测 UPPERBODY 那组
             *  Skirt 权重 13734 全部 `driveSel!==1`，不进这个循环。所以「Skirt 且
             *  driveSel===1」的**只有袖布**，纳入不会把裙子往外掀（t16 当初担心的
             *  是 driveSel 全量，不是这一支）。
             *
             *  回滚：`?secskirt=0` 恢复成只认 ArmLets 的旧行为（8 根）。 */
            const _inclSkirt = QNUM('secskirt', 1)! > 0;
            const _armChainRe = /腕|ひじ|手首/;
            for (let i = 0; i < n; i++) {
                if (driveSel[i] !== 1) continue;
                const nm = bones[i].name || '';
                if (sleeveRe.test(nm) && !/Skirt/i.test(nm)) { secdriveSel[i] = 1; continue; }
                if (_inclSkirt && /Skirt/i.test(nm)) {
                    /* driveSel 已经把「父链含腕」验过了；这里再确认一次是为了
                     * 不依赖上面那段 armRe 的具体写法（换模型时也稳）。 */
                    let p3: THREE.Object3D | null = bones[i].parent;
                    let g6 = 0;
                    while (p3 && p3 !== rootObj && g6++ < 12) {
                        if (_armChainRe.test(p3.name || '')) { secdriveSel[i] = 1; break; }
                        p3 = p3.parent;
                    }
                }
            }
            /* 兜底：若这份模型没有 `ArmLets/Sleeve/袖` 命名的骨（换模型时），
             * 就退回原来的「driveSel===1 全部当袖骨」，至少不会一根都不动。 */
            let _anyArm = 0;
            for (let i = 0; i < n; i++) if (driveSel[i] === 1 && secdriveSel[i] === 1) _anyArm++;
            if (_anyArm === 0) for (let i = 0; i < n; i++) if (driveSel[i] === 1) secdriveSel[i] = 1;
            /* ★★★ 十七轮（用户 m12388）：给每根袖骨标上「属于哪一侧的胳膊」——
             *  往复相位是**按侧**算的（左臂前摆时右臂后摆），不能全角色共用一个相位，
             *  否则两侧袖子的往复会互相抵消，看起来和常量侧展没区别。
             *  判法：沿父链找第一个名字以 `左`/`右` 开头（或 `_L`/`_R` 结尾）的对象。
             *  实测本模型袖骨父链是 `Skirt_* ← 左腕 ← 左肩C ← 左肩 ← …`，一定命中。
             *  `0 = 左`、`1 = 右`、`-1 = 认不出`（认不出的骨不参与往复，保持常量侧展）。 */
            for (let i = 0; i < n; i++) {
                if (secdriveSel[i] !== 1) continue;
                let p4: THREE.Object3D | null = bones[i].parent;
                let g7 = 0;
                while (p4 && g7++ < 12) {
                    const nm4 = p4.name || '';
                    if (/^左/.test(nm4) || /_L$/.test(nm4)) { sideOf[i] = 0; break; }
                    if (/^右/.test(nm4) || /_R$/.test(nm4)) { sideOf[i] = 1; break; }
                    p4 = p4.parent;
                }
            }
            /* ★ 侧向骨数必须是**这一组自己的数**，不能借用 `flareBones`。
             *  踩过：rig 里写 `sideBones: flareBones` 让读数恒等于外撑组的 176 根，
             *  看上去「侧摆作用面很大」，实际只作用在 ArmLets 那 8 根上，误导判读。 */
            for (let i = 0; i < n; i++) if (secdriveSel[i] === 1) _nSideBones++;
            (window as unknown as { __secSideBones?: number }).__secSideBones = _nSideBones;
            /* ★★★ 第二十二轮：**披肩不进袖骨组**（放在这里是因为 `shawlSel` 在上面才建好）。
             *
             *  用户原话：「编号4 你确实是向前摆动了，但是只有最下部分摆动。这布料是一个整体，
             *  不是上面不动下面往前动。而且摆动幅度有点大。」
             *
             *  根因：披肩的骨挂在手臂父链上 ⇒ 命中上面的「袖骨」分类，
             *  于是吃袖子的**高度减推** `hw = 1 − sideHiK·(1 − hn)`（`sideHiK` 缺省 0.55，
             *  低于 `sideHiLo` 的骨只推 45%）⇒ 上段几乎不动、下段被拽着走。
             *  修法：把它从这一组摘出去，改走独立的**整片同权**通道（`shawlSel` / `?secshawl=`）。
             *  ⚠️ 必须摘干净 —— 留在两组里会被**同时**驱动，幅度叠加上段仍被减推，等于没修。 */
            for (let i = 0; i < n; i++) {
                if (shawlSel[i] === 1 && secdriveSel[i] === 1) { secdriveSel[i] = 0; _nSideBones--; }
            }
            /* ★★★ t16（队长 t10 根因问题 3）：袖骨限角必须放行 ------------------------
             *  限角在更前面的 `limit[i]` 里按 `limitDeg * 0.9`（22° × 0.9 = **19.8°**）
             *  分给「非头发非裙摆」的一切布片。侧摆设定 26° **大于** 19.8° ⇒ 弹簧每帧
             *  把超出的部分拉回，稳态外移被限角吃掉 —— 这是「设了 26° 只看到 0.15°」
             *  的另一半原因（另一半是 `w` 乘了速度标量，见逐骨那段）。
             *  ⇒ 对 `secdriveSel===1` 这 8 根袖骨单独放行到 `max(limitDeg, sideDegRaw) * 1.15`
             *    （26 × 1.15 ≈ 29.9°），留 4° 以上余量。
             *  ⚠️ 时序：`limit[]` 在本块**之前**就写好了（分类要用 `axisSel`，而 `axisSel`
             *     与 `limit` 同一段构建），所以这里改 `limit` 是**生效**的，不需要回头再跑一遍。
             *  ⚠️ 只动袖骨，头发/裙摆/前襟的限角一个数都没变（回滚 `?secside=-1` 时
             *     `sideAmp===0` ⇒ 本块整段不执行 ⇒ 与改动前逐位一致）。 */
            if (sideAmp > 0) {
                for (let i = 0; i < n; i++) {
                    if (secdriveSel[i] !== 1) continue;
                    const want = Math.max(limitDeg, sideDegRaw) * 1.15 / DEG;
                    if (limit[i] < want) limit[i] = want;
                }
            }
        }

        /* ── ★★★ 裙摆**最下摆**通道（用户 m11430 任务3）───────────────────────
         *  「图三我圈出来的衣料，最下摆那部分走路时不要往后飘，自然垂落略微向前摆。」
         *
         *  ① 选骨：`Skirt_*` 命名、且**不属于袖布**（`secdriveSel!==1`）。
         *     实测本模型 `Skirt_*` 共 413 根，其中父链经 `腕/ひじ/手首` 的 176 根是袖布
         *     （见上一段），剩下 237 根才是真裙摆；这 237 根的世界 y 跨 [0.398, 1.800]。
         *  ② 高度权重 `hemWgt`：`Skirt` 竖直跨度里**最低的那 `hemHi` 比例**满额
         *     （权重 1 = 打折最多），往上线性归零。用**相对**比例而不是绝对高度，
         *     换缩放/换姿势都不会失灵（踩过 `BARK_AO_TOP` 按米制写死导致整树压暗的坑）。
         *  ③ 效果：`updateSecondary` 的 Verlet 段按这个权重把 `wind` 折掉
         *     （见下面 `wf` 的写法），并在 `_vRest` 上按同权重叠一点**向前**的倾角。
         *  回滚：`?sechemwind=` 与 `?sechemfwd=`；两项都 <= 0 时本块只建表不生效，
         *        `hemN` 恒 0，与改动前逐位一致。 */
        let _hemTot = 0;
        if (windHem < 1 || hemFwdAmp > 0) {
            /* 先扫两遍：①找竖直跨度 ②按跨度算权重 */
            let hMin = Infinity, hMax = -Infinity;
            for (let i = 0; i < n; i++) {
                if (secdriveSel[i] === 1) continue;
                if (!/Skirt/i.test(bones[i].name || '')) continue;
                hemSel[i] = 1;
                _vHead.setFromMatrixPosition(bones[i].matrixWorld);
                if (_vHead.y < hMin) hMin = _vHead.y;
                if (_vHead.y > hMax) hMax = _vHead.y;
            }
            const span = (hMax > hMin) ? (hMax - hMin) : 1;
            const cutY = hMin + span * hemHi;
            for (let i = 0; i < n; i++) {
                if (hemSel[i] !== 1) continue;
                _vHead.setFromMatrixPosition(bones[i].matrixWorld);
                /* 0 = 最底（满额），1 = 到 cutY 及以上（归零） */
                const t = Math.min(1, Math.max(0, (_vHead.y - hMin) / Math.max(1e-6, cutY - hMin)));
                hemWgt[i] = 1 - t;
                if (hemWgt[i] > 0.01) _hemTot++;
            }
            if (typeof window !== 'undefined' && /[?&]sechemdbg=1/.test(location.search)) {
                (window as unknown as { __secHem?: object }).__secHem = {
                    n: _hemTot, hMin, hMax, span, cutY, hemHi,
                    windHem, hemFwdDeg: hemFwdAmp * DEG,
                };
                console.log('[sechem] 下摆骨 ' + _hemTot + ' 根  y[' + hMin.toFixed(3) + ',' + hMax.toFixed(3) + '] cut=' + cutY.toFixed(3));
            }
        }
        _nHemBones = _hemTot;

        /* ── ★★★ 落脚脉冲的高度权重表（见 `SecondaryRig.landPulse`）───────────
         *  选骨：**裙摆 + 头发**（落脚时两者一起上抬，参考视频实测同相位、
         *        头发幅度 1.58×，两条链都吃）。
         *  ★★★ 第二十五轮：选骨判据改成 **材质组**（`matGroup` 1=头发 / 5=裙），
         *    不再用 `/Skirt/i` 骨名 —— 本模型四片布同名，见下面 `hit` 处的长注释。
         *  ⚠️ 袖布（`secdriveSel===1`）排除 —— 袖子已经由侧摆/外撑两条通道管着，
         *    再加一份落脚角会和它们打架（实测袖子本来就贴裙摆，是穿模的来源）。
         *  ⚠️ 权重必须**分组各自归一**：裙摆世界 y 跨 [0.40,1.80]、头发跨 [1.4,2.2]，
         *    若共用一个 span，`cutY` 会落在头发中段 ⇒ 整块头发权重被打到 0
         *    （踩过同类坑：`BARK_AO_TOP` 按米制写死导致整树压暗）。
         *    这里用「该组自己的竖直跨度里最低 landHi 比例」满额，往上线性归零。 */
        let _landTot = 0, _landHair = 0, _landSkirt = 0;
        if (landLiftAmp > 0 || landSpreadAmp > 0) {
            /* ① 分组收集（两组各自算 min/max） */
            for (let g = 0; g < 2; g++) {
                const isHairG = g === 1;
                let gMin = Infinity, gMax = -Infinity;
                for (let i = 0; i < n; i++) {
                    if (secdriveSel[i] === 1) continue;
                    /* ★★★ 第二十五轮：判据从「骨名含 Skirt」换成「材质组 matGroup」。
                     *  根因（`_tools/namecheck.js` 实测，用户 URL `clothamp=0&secstiffk=20`）：
                     *  本模型**四片布共用 `Skirt_*` 骨名** —— 披风 57 根、带 143 根、
                     *  披肩 72 根、裙 274 根，名字全是 `Skirt_*`。
                     *  旧判据 `/Skirt/i.test(nm)` 于是把披风 25 根、带 30 根、披肩 14 根
                     *  也塞进了「落脚脉冲」。这条通道有两个致命特性：
                     *    ① 转轴 = `up × 径向` ⇒ 左右两半**必然反向**
                     *       （实测披风左右侧向位移相关 **−0.3062** = 用户说的「各飘各的」）；
                     *    ② 权重 = **高度梯度**（`landWgt` 上段 0 → 下段 1）
                     *       ⇒ 披肩下段 **19.36°** / 中段 7.07° / 上段 **3.20°**（比值 **6.05**
                     *       = 用户说的「尾部飘很大、上面几乎不动」）。
                     *  再加上 8 带也跟着吃满幅度（均 20.81° / 峰 52.85°）= 用户说的
                     *  「8 号飘得太大」。
                     *  ⇒ **三个问题是同一个根因。**
                     *  ✅ 改用 `matGroup`（材质名判据，第二十四轮 v3 已建好）：
                     *     `1` 头发 / `5` 裙。披风(2)/带(3)/披肩(4) 从此不进落脚脉冲，
                     *     它们只走各自的整片通道 + 弹簧固有滞后。 */
                    const hit = isHairG ? (matGroup[i] === 1) : (matGroup[i] === 5);
                    if (!hit) continue;
                    _vHead.setFromMatrixPosition(bones[i].matrixWorld);
                    if (_vHead.y < gMin) gMin = _vHead.y;
                    if (_vHead.y > gMax) gMax = _vHead.y;
                }
                if (!(gMax > gMin)) continue;
                /* ★ 头发**整头一起抬**（参考视频：发梢 pp 73.3 px = 裙摆的 1.58×，
                 *  且整束头发同相位上扬，不是只有发梢动）⇒ 头发组直接**满额 1.0**。
                 *  裙摆组用用户给的 `landHi`：只抬最下摆那一段，裙腰不该跟着上浮。
                 *  ⚠️ 踩过的坑：第一版给头发也用 `landHi=0.45` 的高度窗口，结果 27 根
                 *  头发骨只有 6 根命中（`Bone_Hair*` 竖直跨度大、绝大多数节点挤在顶部，
                 *  权重被算成 0）—— 现象是「裙摆在飘、头发纹丝不动」。 */
                const gHi = isHairG ? 1.0 : landHi;
                const gSpan2 = gMax - gMin;
                const gCut = gMin + gSpan2 * gHi;
                for (let i = 0; i < n; i++) {
                    if (secdriveSel[i] === 1) continue;
                    /* ★★★ 第二十五轮：判据从「骨名含 Skirt」换成「材质组 matGroup」。
                     *  根因（`_tools/namecheck.js` 实测，用户 URL `clothamp=0&secstiffk=20`）：
                     *  本模型**四片布共用 `Skirt_*` 骨名** —— 披风 57 根、带 143 根、
                     *  披肩 72 根、裙 274 根，名字全是 `Skirt_*`。
                     *  旧判据 `/Skirt/i.test(nm)` 于是把披风 25 根、带 30 根、披肩 14 根
                     *  也塞进了「落脚脉冲」。这条通道有两个致命特性：
                     *    ① 转轴 = `up × 径向` ⇒ 左右两半**必然反向**
                     *       （实测披风左右侧向位移相关 **−0.3062** = 用户说的「各飘各的」）；
                     *    ② 权重 = **高度梯度**（`landWgt` 上段 0 → 下段 1）
                     *       ⇒ 披肩下段 **19.36°** / 中段 7.07° / 上段 **3.20°**（比值 **6.05**
                     *       = 用户说的「尾部飘很大、上面几乎不动」）。
                     *  再加上 8 带也跟着吃满幅度（均 20.81° / 峰 52.85°）= 用户说的
                     *  「8 号飘得太大」。
                     *  ⇒ **三个问题是同一个根因。**
                     *  ✅ 改用 `matGroup`（材质名判据，第二十四轮 v3 已建好）：
                     *     `1` 头发 / `5` 裙。披风(2)/带(3)/披肩(4) 从此不进落脚脉冲，
                     *     它们只走各自的整片通道 + 弹簧固有滞后。 */
                    const hit = isHairG ? (matGroup[i] === 1) : (matGroup[i] === 5);
                    if (!hit) continue;
                    _vHead.setFromMatrixPosition(bones[i].matrixWorld);
                    /* 头发不吃高度梯度（见上），裙摆按高度线性归零 */
                    const t = isHairG ? 0
                        : Math.min(1, Math.max(0, (_vHead.y - gMin) / Math.max(1e-6, gCut - gMin)));
                    const w = 1 - t;
                    if (w > landWgt[i]) landWgt[i] = w;   // 两组不重叠，取大只为稳妥
                    /* ★★★ 外扩权重 `landSpreadWgt`：**与抬升权重的梯度相反** ——
                     *  上段满额、下段归零。理由是几何：一片下垂的裙摆要「向四周张开」，
                     *  必须把**上段**（裙腰附近）朝外转，整片布像伞骨一样张出去；
                     *  只转下段（本来的 `landWgt`，最下摆 w=1.00）只会让最末那截布
                     *  朝外翻个小边，`maxR`（剪影半宽）几乎不动 —— 这正是实测
                     *  「lowY pp 0.27 但 maxR pp 只有 0.05」的直接原因。
                     *  反梯度：`tUp = (y−gMin)/(gMax−gMin)`，上段 tUp→1 ⇒ 权重→1。
                     *  ⚠️ 下段仍保留一点（`spBias`，缺省 0.25）让最末一截也微张，
                     *     否则下摆边缘会显得「死板地贴着上段走」。 */
                    if (!isHairG) {
                        const tUp = Math.min(1, Math.max(0, (_vHead.y - gMin) / Math.max(1e-6, gSpan2)));
                        const ws = spBias + (1 - spBias) * tUp;
                        if (ws > landSpreadWgt[i]) landSpreadWgt[i] = ws;
                    } else {
                        /* 头发整束张（发根到发梢都吃），与抬升同口径 */
                        if (1 > landSpreadWgt[i]) landSpreadWgt[i] = 1;
                    }
                    if (w > 0.01) { _landTot++; if (isHairG) _landHair++; else _landSkirt++; }
                }
            }
            if (typeof window !== 'undefined' && /[?&]seclanddbg=1/.test(location.search)) {
                /* 诊断：把「名字里像头发」的骨名列出来 —— 用来判断是正则没覆盖、
                 *  还是模型里头发骨本来就这么少（`/^Bone_/` 计 27 根里混着饰品骨）。 */
                const _names: string[] = [];
                const _boneAll: string[] = [];
                const _skirtL: string[] = [];
                for (let i = 0; i < n; i++) {
                    const nm = bones[i].name || '';
                    if (/^Bone_/.test(nm)) _boneAll.push(nm + (landWgt[i] > 0.01 ? '*' : ''));
                    if (/Hair|髪|髮|毛|Kami/i.test(nm)) _names.push(nm + (landWgt[i] > 0.01 ? '*' : ''));
                    /* ★ 裙摆骨名清单（带权重与骨长）——臂/袖骨也叫 `Skirt_*`，
                     *  光看名字分不出哪根是裙、哪根是袖，只能靠这条表挑采样骨。 */
                    if (/Skirt/i.test(nm) && landWgt[i] > 0.01) {
                        _vHead.setFromMatrixPosition(bones[i].matrixWorld);
                        _skirtL.push(nm + '|w' + landWgt[i].toFixed(2) + '|y' + _vHead.y.toFixed(2)
                            + '|L' + (restLen[i] || 0).toFixed(2));
                    }
                }
                (window as unknown as { __secLand?: object }).__secLand = {
                    n: _landTot, hair: _landHair, skirt: _landSkirt, landHi,
                    liftDeg: landLiftAmp * DEG, spreadDeg: landSpreadAmp * DEG,
                    liftPh: landLiftPh, spreadPh: landSpreadPh,
                    hairNames: _names, boneAll: _boneAll, skirtList: _skirtL,
                };
                console.log('[secland] 落脚脉冲骨 ' + _landTot + ' 根（裙 ' + _landSkirt
                    + ' / 发 ' + _landHair + '）抬高 ' + (landLiftAmp * DEG).toFixed(1)
                    + '° 外扩 ' + (landSpreadAmp * DEG).toFixed(1) + '°');
            }
        }
        _nLandBones = _landTot;

        /* ── ★★★ 第二十一轮：裙摆「thigh 带」选择 ─────────────────────────
         *  选骨（三条同时满足）：
         *   ① 真裙摆：名字含 `Skirt`、且不是袖布（`secdriveSel !== 1`）；
         *   ② 落在 **thigh 高度带**：占裙摆自身竖直跨度 `[thighLo, thighHi]` 的比例区间
         *      —— 用**相对比例**而不是绝对高度（换缩放不失效）。
         *   ③ 位于身体**前侧**：把「骨到体轴的水平向量」投影到角色前后轴，
         *      `> 0` 才算前侧；权重按投影大小线性升到 1。
         *      ⇒ 只把前面那片顶起来，后面那片不动（否则整圈裙一起前倾，像被风吹）。
         *  ★ 选骨表**无条件**建（与 `pieceSel` 同理）：建表只读一次、不产生行为。 */
        if (true) {
            let sMin = Infinity, sMax = -Infinity;
            for (let i = 0; i < n; i++) {
                const nm = bones[i].name || '';
                if (secdriveSel[i] === 1) continue;
                if (!/Skirt/i.test(nm) || /Hair|髪/.test(nm)) continue;
                _vHead.setFromMatrixPosition(bones[i].matrixWorld);
                if (_vHead.y < sMin) sMin = _vHead.y;
                if (_vHead.y > sMax) sMax = _vHead.y;
            }
            if (sMax > sMin) {
                const span3 = sMax - sMin;
                const yLo = sMin + span3 * thighLoK;
                const yHi = sMin + span3 * thighHiK;
                /* 体轴水平位置：用裙摆骨的水平质心当参考（比骨架根稳，根可能在脚底）。 */
                let cx0 = 0, cz0 = 0, cn0 = 0;
                for (let i = 0; i < n; i++) {
                    const nm = bones[i].name || '';
                    if (secdriveSel[i] === 1) continue;
                    if (!/Skirt/i.test(nm) || /Hair|髪/.test(nm)) continue;
                    _vHead.setFromMatrixPosition(bones[i].matrixWorld);
                    cx0 += _vHead.x; cz0 += _vHead.z; cn0++;
                }
                cx0 /= Math.max(1, cn0); cz0 /= Math.max(1, cn0);
                /* 前后轴（模型空间静态）：`fwdLocal` 已归一化，取水平分量再归一化 */
                const fx0 = fwdLocal[0], fz0 = fwdLocal[2];
                const fl0 = Math.hypot(fx0, fz0);
                const ufx = fl0 > 1e-6 ? fx0 / fl0 : 0;
                const ufz = fl0 > 1e-6 ? fz0 / fl0 : 1;
                for (let i = 0; i < n; i++) {
                    const nm = bones[i].name || '';
                    if (secdriveSel[i] === 1) continue;
                    if (!/Skirt/i.test(nm) || /Hair|髪/.test(nm)) continue;
                    /* ★ 第三十四轮：`Skirt_*` 骨名被四片布共用（第 25 轮老坑重犯）。
                     *  thigh 通道只该推**真裙摆**（matGroup===5），否则顺手把 4 号披肩
                     *  下段往前顶 —— 实测下段 dF 从 +0.47 反到 −0.70，就是用户说的
                     *  「往前卷」。`secthigh=0` 时 下段+0.467 / 中段+0.409 / 上段+0.333 同号。 */
                    if (matGroup[i] !== 5) continue;
                    _vHead.setFromMatrixPosition(bones[i].matrixWorld);
                    if (_vHead.y < yLo || _vHead.y > yHi) continue;
                    /* 高度带内：中间满额、两端平滑收边（免得带上沿出现硬折线） */
                    const mid = (yLo + yHi) * 0.5, half = (yHi - yLo) * 0.5;
                    const hk = 1 - Math.min(1, Math.abs(_vHead.y - mid) / Math.max(1e-6, half));
                    /* 前侧权重：投影 > 0 才算前；0.12 m 达到满额 */
                    const prj = (_vHead.x - cx0) * ufx + (_vHead.z - cz0) * ufz;
                    const fk = prj <= 0 ? 0 : Math.min(1, prj / 0.12);
                    const w = hk * fk;
                    if (w > 0.02) { thighSel[i] = 1; thighWgt[i] = w; _nThigh++; }
                }
            }
            if (typeof window !== 'undefined' && /[?&]secthighdbg=1/.test(location.search)) {
                (window as unknown as { __secThigh?: object }).__secThigh = {
                    n: _nThigh, lo: thighLoK, hi: thighHiK, deg: thighAmp * DEG, span: [sMin, sMax],
                };
                console.log('[secthigh] thigh 带骨 ' + _nThigh + ' 根，y 带比例 ['
                    + thighLoK.toFixed(2) + ',' + thighHiK.toFixed(2) + '] 角 '
                    + (thighAmp * DEG).toFixed(1) + '°');
            }
        }

        /* ── ★★★ 侧向摆动的「胳膊关节表」（用户 m18305）──────────────────────
         *  量「手臂相对肩膀往**外侧**荡了多少」用真实父链上的三根关节：
         *    `左肩`（肩根）→ `左肩C`（锁骨/中段）→ `左腕`（上臂）→ `左ひじ`（肘）
         *  `?secsidefind=1` 实测本模型的袖骨父链是
         *    `Skirt_* ← 左腕 ← 左肩C ← 左肩 ← shoulderP_L ← 上半身2`（右对称）。
         *  ⚠️ 骨名不是 MMD 标准日文名 `左腕/左ひじ`，而且**胳膊关节不在物理骨的
         *    `bones[]` 里**（`bones` 只有布料 573 根，一个 `肩/腕` 都没有）——
         *    它们只能从袖骨的**父链对象**里取，所以这里遍历的是 `bones[i].parent` 链。
         *  ⚠️ 只在 `sideAmp > 0` 时建表；`?secside=-1` 时 `sideArm` 为空 ⇒ 每帧那段跳过。 */
        if (sideAmp > 0) {
            const want: THREE.Object3D[][] = [[], []];
            for (let i = 0; i < n; i++) {
                if (driveSel[i] !== 1) continue;
                let p: THREE.Object3D | null = bones[i].parent;
                let g = 0;
                while (p && g++ < 12) {
                    const nm = p.name || '';
                    for (let s = 0; s < 2; s++) {
                        if (want[s].length >= 3) continue;
                        const isL = s === 0;
                        if ((isL ? /^左/ : /^右/).test(nm) || (isL ? /_L$/.test(nm) : /_R$/.test(nm))) {
                            if (!want[s].includes(p)) want[s].push(p);
                        }
                    }
                    p = p.parent;
                }
                if (want[0].length >= 3 && want[1].length >= 3) break;
            }
            /* 每侧至少要有「肩根 + 上臂」两根才够量侧向摆（链本来就 3 根）。
             * 打包格式：`[leftN, left0..N-1, rightN, right0..N-1]` —— 两侧根数可以不同。 */
            if (want[0].length >= 2 && want[1].length >= 2) {
                sideArm.push(...want[0], ...want[1]);
                sideSideN[0] = want[0].length;
                sideSideN[1] = want[1].length;
                /* ★ t20 标定：捕获时的世界 y（侧摆按几何推，这个高度梯度决定
                 *  `?secsidehlo=` / `?secsidehhi=` 该落在哪）。只做诊断用。 */
                sideArmY.length = 0;
                for (const bb of want[0]) {
                    _vHead.setFromMatrixPosition(bb.matrixWorld);
                    sideArmY.push(_vHead.y);
                }
                for (const bb of want[1]) {
                    _vHead.setFromMatrixPosition(bb.matrixWorld);
                    sideArmY.push(_vHead.y);
                }
            }
            /* ★ 诊断（判据 J「参数打印正确 ≠ 功能生效」）：`?secsidefind=1` 时把
             *  「每一侧抓到了哪几根关节」报出来。`sides` 为空 ⇒ 每帧那段整块跳过，
             *  读数上会显示 `sideBones>0` 而 `sideN=0` —— 两者一起看才分得清。 */
            if (typeof window !== 'undefined' && /[?&]secsidefind=1/.test(location.search)) {
                const l = sideArm.slice(0, sideArm.length / 2).map((b) => b.name);
                const r = sideArm.slice(sideArm.length / 2).map((b) => b.name);
                (window as any).__sideFind = {
                    left: l, right: r, total: sideArm.length,
                    sleeveChain: (() => {
                        const out2: string[] = [];
                        let seen = 0;
                        for (let i = 0; i < n && seen < 6; i++) {
                            if (driveSel[i] !== 1) continue;
                            seen++;
                            const chain: string[] = [];
                            let pp: THREE.Object3D | null = bones[i].parent;
                            let gg = 0;
                            while (pp && gg++ < 8) { chain.push(pp.name || '?'); pp = pp.parent; }
                            out2.push((bones[i].name || '?') + ' ← ' + chain.join(' ← '));
                        }
                        return out2;
                    })(),
                };
                console.warn('[secside] 胳膊关节：左', l.join('/'), '右', r.join('/'));
            }
        }
        /* 诊断：**静态**袖骨数（构建期算一次）。`?secflare=-1` 时整块分类不跑 ⇒ 恒 0，
         * 与改前逐位一致；缺省时 > 0 就是「分类真的落到了骨头上」的第一道证据。 */
        {
            let c = 0;
            for (let i = 0; i < n; i++) if (driveSel[i] === 1) c++;
            flareBones = c;
        }
        /* ★★★ 第二十一轮：这个门必须补 `|| thighAmp > 0`。
         *  原来它是 `if (driveAmp > 0)`，而 `SEC_DRIVE` 缺省 **−1（已回滚）**
         *  ⇒ `limbA/limbB` 一个都不填 ⇒ thigh 通道拿不到大腿骨 ⇒ 驱动量恒 0
         *  ⇒「选出了骨但 thighN 永远 0」。这条在第十九轮实测踩过。
         *  thigh 通道与 `?secdrive=` 无关，只需要这两根大腿骨 + `_limbRef` 基准。 */
        if (driveAmp > 0 || thighAmp > 0) {
            /* 腿/臂的**绑定姿势**朝向在前后轴上的分量 —— 用「关节 → 子关节」的位移差，
             * 不读 matrixWorld（MMD 骨 matrixAutoUpdate=false，读矩阵会拿到绑定姿势，判据 P）。
             *
             * ★★ 这里踩过一个坑（2027-01 修）：第一版写的是
             *      `dl = Math.hypot(dx, dz);   _limbRef = (dx*fx + dz*fz) / dl`
             *    —— 只用了**水平**分量做归一化。大腿在绑定姿势下几乎是**竖直**的
             *    （水平位移只有零点几毫米，是建模误差量级），于是 `(dx/dl, dz/dl)`
             *    退化成一个**乱指的单位向量**：实测 `_limbRef` = [−0.617, −0.423, …]，
             *    而正确答案应该是 0 附近。后果是 `swing = dd − ref` 恒 ≥ 0.32 ⇒
             *    `legRaw` 永远 ≥ 0.45（归一化除数）⇒ **驱动量被钉死在 1.0**，
             *    前襟被一个恒定的全力往前压，而不是随腿摆动 —— 看起来「驱动 100% 在跑」，
             *    其实根本没在跟随（这正是判据 J「参数打印正确 ≠ 功能生效」的又一例）。
             *   正确做法：用**三维**模长归一化，且投影要把 `fwdLocal[1]` 一起算进来
             *   （运行期 `swing()` 用的是完整三维点乘，两边必须同口径）。 */
            const limbPairs: Array<[string[], string[]]> = [
                [['左足'], ['左ひざ']], [['右足'], ['右ひざ']],
                [['左腕'], ['左ひじ']], [['右腕'], ['右ひじ']],
            ];
            for (let j = 0; j < 4; j++) {
                const a = pick(limbPairs[j][0]), c = pick(limbPairs[j][1]);
                limbA[j] = a; limbB[j] = c;
                const pa = bindOf(a), pc = bindOf(c);
                if (!pa || !pc) continue;
                const dx = pc.x - pa.x, dy = pc.y - pa.y, dz = pc.z - pa.z;
                const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
                _limbRef[j] = dl > 1e-9
                    ? (dx * fwdLocal[0] + dy * fwdLocal[1] + dz * fwdLocal[2]) / dl
                    : NaN;
            }
        }
    }

    return {
        bones, n, parentIdx, headLocal, restLen, restDirLocal, animLocal,
        restDirWorld: new Float32Array(n * 3),
        /* ★ t16：动画姿势下的静止方向（世界单位向量）。`restDirWorld - animDirWorld`
         *  就是「我们的侧摆/外撑把袖子挪了多少」——**不含** carry/风，与走向无关。 */
        animDirWorld: new Float32Array(n * 3),
        /* ★★★ 十四轮二次根因修（用户 m02277「袖子向两侧飘」第四次反馈）：
         *  侧摆**不能**只改 `_vRest`。`_vRest` 同时是 ①回正弹簧的目标 ②限角基准
         *  ③方向性约束的基准。只推它，粒子会跟着收敛、其它约束又把它拉回来，最终
         *  骨朝向几乎不变（实测袖片主力骨 `Skirt_11_0` 世界方向只偏 2.3°、袖片像素
         *  面积 −0.8%、轮廓宽度 0 px；而 `onBeforeRender` 强转同一批骨 60° 能改
         *  51.76% 像素 ⇒ 管线通，是通道自己把量吃掉了）。
         *  这里存**进入侧摆通道那一瞬**的目标方向；写回旋转时按「基准 → 最终」算出
         *  侧摆增量四元数，直接叠在最终骨骼朝向上 —— 在所有弹簧/限角/碰撞之后施加，
         *  谁也吃不掉它。全 0（缺省）= 该骨本帧没走侧摆 ⇒ 走原路径，逐位不变；
         *  `?secside=-1` 即全 0，可回滚。 */
        sideBaseDir: new Float32Array(n * 3),
        particle, particlePrev, driveSel, limit, stiffness: stiff, keep, gravity, wind, windFront, carry,
        windHem, hemLo, hemHi, hemFwdAmp, hemN: 0, hemW: 0,
        hemSel, hemWgt, hemAmt: 0, _hemRootPrev: new Float32Array([NaN, NaN]),
        /* ★★★ 落脚脉冲（用户 m07388）：两个包络幅度 + 高度权重表 + 诊断量。
         *  幅度全 0（`?secland=-1`）⇒ `landWgt` 全 0 ⇒ 运行期整块跳过、`landN` 恒 0。 */
        landPulse: 0, landLiftAmp, landSpreadAmp, landHairK, landWgt, landSpreadWgt, landSpBias: spBias,
        /* ★ 第四十二轮：头发底限 + 诊断量（见 `SecondaryOptions.hairFloor`） */
        hairFloor, hairFloorN: 0, hairFloorDeg: 0, hairFloorMinY: 0, hairFloorApplied: 0,
        hairSolveOff: hairSolve ? 0 : 1, hairAnimOnly: 0,
        hairFloorAnim: Math.max(0, Math.min(1.6, Number(new URLSearchParams(window.location.search).get('hairflooranim') ?? 0) || 0)),
        landN: 0, landDeg: 0,
        landApplied: 0,
        /* ── ★★★ 第二十一轮 ── */
        pieceSel, ribbonSel, pieceAmp, piecePh, pieceWRib, pieceN: 0, pieceDegNow: 0,
        pieceApplied: 0, pieceBaseDir: new Float32Array(n * 3),
        pieceCapeN: _nPiece, pieceRibbonN: _nRibbon,
        /* ★ 第二十二轮：披肩整片通道（见 `SecondaryRig.shawlAmp`） */
        shawlSel, shawlAmp, shawlPh, shawlN: 0, shawlDegNow: 0, shawlApplied: 0,
        shawlBaseDir: new Float32Array(n * 3), shawlBones: _nShawl,
        shawlRigid, shawlRigidAmp,
        shawlRoot: _shawlRoot, shawlOff: new Float32Array(n * 4), shawlOffOk: 0,
        shawlPush, shawlPushSign, shawlPushOsc, shawlPushDegNow: 0, shawlPushN: 0,
        shawlBase: new Float32Array(n * 3),
        clothAmp, matGroup,
    stiffCape: Math.max(0.05, Math.min(20, opts.stiffCape ?? 1)),
    stiffRibbon: Math.max(0.05, Math.min(20, opts.stiffRibbon ?? 1)),
    stiffShawl: Math.max(0.05, Math.min(20, opts.stiffShawl ?? 1)),
    netCape: Math.max(0, Math.min(1, opts.netCape ?? 0)),
    netRibbon: Math.max(0, Math.min(1, opts.netRibbon ?? 0)),
    netShawl: Math.max(0, Math.min(1, opts.netShawl ?? 0)),
    netSkirt: Math.max(0, Math.min(1, opts.netSkirt ?? 0)),
    /* ⚠️ 这里**不能**再写 parentIdx —— `:2461` 的骨架块已经给过了，
     *    同一字面量重复同名键是 `TS1117`（第二十六轮 T1-I4 修）。 */
    solDir: new Float32Array(n * 3), netA, netParent, netN: 0,
    holdCape: Math.max(0, Math.min(1, opts.holdCape ?? 0)),
    holdRibbon: Math.max(0, Math.min(1, opts.holdRibbon ?? 0)),
    holdShawl: Math.max(0, Math.min(1, opts.holdShawl ?? 0)),
    holdSkirt: Math.max(0, Math.min(1, opts.holdSkirt ?? 0)),
    holdDir: new Float32Array(n * 3), holdA, holdReady: false, holdN: 0,
    holdSum: new Float32Array(n * 3), holdFrames: 0,
        stiffK, limitK, kHair, kSkirt, kOther, stiffMean: 0,
        hairSep, hairSepStart, hairSepList, hairSepN: 0, hairSepDeg: 0,
        hairBaseDir: new Float32Array(n * 3), hairApplied: 0,
        thighSel, thighWgt, thighAmp, thighAmt: 0, thighN: 0, thighDeg: 0,
        thighApplied: 0, thighSign, thighBaseDir: new Float32Array(n * 3),
        _thighMin: NaN, _thighMax: NaN,
        /* ★ 第二十一轮：分侧驱动量 + 各自的自标定包络（**只作诊断/逐骨验收用**，
         *  真正驱动旋转的仍是 `thighAmt`）。为什么要有：`thighAmt` 是 max ⇒ 一圈峰两次，
         *  而左右骨各自只在**同侧**腿抬起时前顶；验收若拿 max 去求相关会把两块反相的
         *  方波平均掉（实测相关系数被稀释到 0.565，单侧真实值要到 0.87+）。
         *  详见 `_tools/thighscan2.js` 的注释。 */
        amtL: 0, amtR: 0,
        _thighMinL: NaN, _thighMaxL: NaN, _thighMinR: NaN, _thighMaxR: NaN,
        _landN: _nLandBones,
        _landLiftPh: landLiftPh, _landSpreadPh: landSpreadPh,
        _landLiftW: landLiftW, _landLiftD: landLiftD, _landSpreadW: landSpreadW,
        _landLiftE: 0, _landSpreadE: 0, stepPhase: NaN,
        /* ★ 第二十二轮：头发独立相位。−0.25 步 = 比裙摆**提前四分之一步**扬起。
         *  这条同时解决了用户说的「开始走的时候要先扬一下，否则会穿模」。 */
        _hairLiftE: 0, _hairSpreadE: 0,
        /* ★ 第二十二轮：头发相位缺省 **−0.25 步**（= 比裙摆早四分之一步扬起）。
         *  `?sechairph=` 可现场调：越小越早、0 = 与裙摆同相、正数 = 滞后。 */
        hairPh: QNUM('sechairph', -0.25)!,
        startT: -1, _hairKick: 0,
        gaitW: 0,
        landBaseDir: new Float32Array(n * 3),
        floorBaseDir: new Float32Array(n * 3),
        colBone, colN, colLocal, colR, colHalf, colAxis, colPmx, colShape,
        colSlack: new Float32Array(Math.max(1, n * Math.max(1, colN))),
        colScale, slackMax, iterations, rodSamples, colMul,
        repelD, repelCut, repelW, repelEvery, repelNext: 0, repelCount: 0, repelReady: false,
        repelHits: 0, repelMax: 0,
        repelStart: new Int32Array(n + 1),
        repelList: new Int32Array(0),
        _rHead: new Float32Array(n * 3),
        _rTail: new Float32Array(n * 3),
        repelDeg: new Int32Array(n),
        repelFill: new Int32Array(n),
        repelPairsRaw: new Int32Array(Math.max(64, Math.min(200000, Math.floor((n * n) / 8))) * 2),
        fwdLocal, sideLocal, axisSel, axisSign, restAxis, axisTol, antiOn, antiHits: 0, antiMaxDeg: 0,
        driveAmp, driveLead, driveFwd: 0, driveArm: 0, driveN: 0, driveRaw: 0, driveArmRaw: 0,
        flareAmp, flareAmt: 0, flareN: 0, flareSpeed, flarePhase: 0, flareRisk: 0, flareBones,
        secdriveSel, sideAmp, sideSpeed, sideAmt: 0, sideN: 0, sideBones: _nSideBones, sideRoll: 0, sideDeg: 0,
        sideFrontKill,
        /* ★ 十四轮：本帧真正把侧摆增量叠进写回旋转的骨数（诊断用；回滚时恒 0）。 */
        sideApplied: 0,
        sideStandK,
        sideHiK, sideHiLo, sideHiHi,
        /* ★ 十七轮：侧展角往复（用户 m12388）。`sideOf` 是构建期打的左右标记。 */
        sideOscAmp, sideOscRef, sideOf,
        sideOscPh: new Float32Array(2), sideOscSwing: 0, sideOscDc: NaN, sideOscEnv: NaN, sideOscR: new Float32Array(2), sideOscRaw: new Float32Array(2), sideOscN: 0,
        sideArmY,
        sideRows: opts.sideRows,
        sideArm,
        sideSideN,
        _sideRollS: new Float32Array(2).fill(NaN), _sideRollE: new Float32Array(2).fill(NaN),
        _flareRootPrev2: new Float32Array([NaN, NaN]),
        flareSpd: 0, flareDeg: 0, flareOlMean: 0, flareOlMax: 0,
        flareShiftMean: 0, flareShiftMax: 0, flareShiftN: 0,
        _flareRootPrev: new Float32Array([NaN, NaN]),
        _flareFront: new Float32Array(n).fill(NaN),
        _driveRate: new Float32Array(2), _drivePrev: new Float32Array(2), drivePrevInit: false,
        _limbSwing: new Float32Array(4),
        _limbMin: new Float32Array([Infinity, Infinity]), _limbMax: new Float32Array([-Infinity, -Infinity]),        _qDrive: new THREE.Quaternion(), _limbRef, limbA, limbB,
        collide: collide && colN > 0,
        _cWorld: new Float32Array(Math.max(1, colN) * 3),
        _cAxis: new Float32Array(Math.max(1, colN) * 3),
        _cR: new Float32Array(Math.max(1, colN)),
        _cHalf: new Float32Array(Math.max(1, colN)),
        root: (root ?? bones[0]) as THREE.Bone,
        primed: false,
        devDeg: 0, meanDevDeg: 0, peakDevDeg: 0, lastMs: 0,
        info: {
            total: all.length, hair, cloth, bones: n, gravity, stiffness, wind, excluded,
            colliders: colN, skips: 0, collide: collide && colN > 0,
        },
    };
}

/**
 * ★★★ 重建「布-布斥力」邻接表（`?secrepel=`；首帧 + 每 `repelEvery` 帧一次）。
 *
 * ⚠️ 两个坑（第一版就是踩了它们，见 `_logs/repel.jsonl` 的 `repelHitsMax = 3`）：
 *  ① **不能按静止姿势建表**：量到的重叠对（`Skirt_3_0 × Skirt_9_1`、`Skirt_5_12 × Skirt_7_12`）
 *     在静止时离得很远，是走起来才互相扫到的 —— 静止表把它们全漏掉。
 *     现在改成**按当前帧位置定期重建**（隔 `repelEvery` 帧，缺省 8）。
 *  ② **不能只比骨尾对骨尾**：`clashAudit` 量的是**骨棒对骨棒**距离，0.1 mm 的两根骨棒
 *     完全可以在中段交叉、而两个骨尾相距几十厘米（布是面，不是一串珠子）——
 *     这和身体碰撞那个 `rodSamples` 盲区是同一回事。
 *     现在改成**双向点到线段**：`i` 的尾 → `j` 的棒、`j` 的尾 → `i` 的棒，取小者，
 *     与 `auditClash` 的判据完全一致。
 * 排除：沿 `parentIdx` 上溯 ≤ 3 跳的近亲骨对（同一条骨链上相邻的骨本来就贴着）。
 */
function rebuildRepel(rig: SecondaryRig): void {
    const { bones, n, parentIdx, particle } = rig;
    const H = rig._rHead, T = rig._rTail;
    for (let i = 0; i < n; i++) {
        const p = bones[i]?.parent;
        if (p) { const e = p.matrixWorld.elements; H[i * 3] = e[12]; H[i * 3 + 1] = e[13]; H[i * 3 + 2] = e[14]; }
        else { H[i * 3] = particle[i * 3]; H[i * 3 + 1] = particle[i * 3 + 1]; H[i * 3 + 2] = particle[i * 3 + 2]; }
        T[i * 3] = particle[i * 3]; T[i * 3 + 1] = particle[i * 3 + 1]; T[i * 3 + 2] = particle[i * 3 + 2];
    }
    const wide2 = 0.20 * 0.20;      // 粗筛：骨尾距离 > 20 cm 的几乎不可能在中段交叉
    const cut = rig.repelCut;
    const linked = (a: number, b: number): boolean => {
        let p = a;
        for (let k = 0; k < 3 && p >= 0; k++) { p = parentIdx[p]; if (p < 0) break; if (p === b) return true; }
        p = b;
        for (let k = 0; k < 3 && p >= 0; k++) { p = parentIdx[p]; if (p < 0) break; if (p === a) return true; }
        return false;
    };
    const p2seg = (px: number, py: number, pz: number,
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number): number => {
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const wx = px - ax, wy = py - ay, wz = pz - az;
        const uu = ux * ux + uy * uy + uz * uz;
        let t = uu > 1e-12 ? (wx * ux + wy * uy + wz * uz) / uu : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + ux * t - px, cy = ay + uy * t - py, cz = az + uz * t - pz;
        return Math.sqrt(cx * cx + cy * cy + cz * cz);
    };
    // ★ 单趟收集（两趟会把最贵的 `p2seg` 做两遍，实测 `secMsMax` 会飙到 8.9 ms）
    const CAP = 64;   // 单根骨最多收 64 个邻居
    const pairs = rig.repelPairsRaw;
    let m = 0;
    const capM = pairs.length;
    for (let i = 0; i < n && m < capM; i++) {
        for (let j = i + 1; j < n && m < capM; j++) {
            const dx = T[i * 3] - T[j * 3], dy = T[i * 3 + 1] - T[j * 3 + 1], dz = T[i * 3 + 2] - T[j * 3 + 2];
            if (dx * dx + dy * dy + dz * dz > wide2) continue;
            if (linked(i, j)) continue;
            const d1 = p2seg(T[i * 3], T[i * 3 + 1], T[i * 3 + 2],
                H[j * 3], H[j * 3 + 1], H[j * 3 + 2], T[j * 3], T[j * 3 + 1], T[j * 3 + 2]);
            let ok = d1 < cut;
            if (!ok) {
                const d2 = p2seg(T[j * 3], T[j * 3 + 1], T[j * 3 + 2],
                    H[i * 3], H[i * 3 + 1], H[i * 3 + 2], T[i * 3], T[i * 3 + 1], T[i * 3 + 2]);
                ok = d2 < cut;
            }
            if (!ok) continue;
            pairs[m * 2] = i; pairs[m * 2 + 1] = j; m++;
        }
    }
    // 转 CSR（O(pairs)，很便宜）
    const deg = rig.repelDeg;
    deg.fill(0);
    for (let k = 0; k < m; k++) { deg[pairs[k * 2]]++; deg[pairs[k * 2 + 1]]++; }
    for (let i = 0; i < n; i++) if (deg[i] > CAP) deg[i] = CAP;
    const start = rig.repelStart;
    start[0] = 0;
    for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
    const total = start[n];
    let list = rig.repelList;
    if (list.length < total) list = rig.repelList = new Int32Array(Math.max(total, 64));
    const fill = rig.repelFill;
    fill.fill(0);
    for (let k = 0; k < m; k++) {
        const i = pairs[k * 2], j = pairs[k * 2 + 1];
        if (fill[i] < deg[i]) list[start[i] + fill[i]++] = j;
        if (fill[j] < deg[j]) list[start[j] + fill[j]++] = i;
    }
    rig.repelCount = total;
    rig.repelReady = true;
    rig.repelNext = rig.repelEvery;
}

/**
 * 每帧调用：**必须在 `model.update(t)`（或其他写局部变换的东西）之后、渲染之前**。
 *
 * @param _vx/_vz 角色世界水平速度。**故意不用** —— Verlet 的惯性项本身就是从
 *                「骨头的世界位移」里出来的，再叠一个速度驱动项会重复计入。
 *                保留参数只是为了不改调用点，将来做「风」可以用。
 */
export function updateSecondary(
    rig: SecondaryRig | null,
    dt: number,
    vx = 0,
    vz = 0,
): void {
    if (!rig || rig.n === 0) return;
    const _t0 = performance.now();
    const { bones, n, parentIdx, restLen, restDirLocal, animLocal,
        particle, particlePrev, limit, stiffness, keep,
        colN, colSlack, _cWorld, _cAxis, _cR, _cHalf, iterations, rodSamples,
        repelD, repelW, repelStart, repelList,
        fwdLocal, sideLocal, axisSel, axisSign, axisTol, windFront, carry,
        windHem, hemLo, hemHi, hemFwdAmp, hemSel, hemWgt,
        driveSel, driveAmp, driveLead, _driveRate, _drivePrev, _limbSwing, _limbMin, _limbMax, _qDrive, _limbRef, limbA, limbB,
        flareAmp, flareSpeed,
        sideAmp, sideSpeed, secdriveSel: sideSel,
        sideOscAmp, sideOscRef, sideOf, sideOscPh,
        landLiftAmp, landSpreadAmp, landWgt,
        hairFloor } = rig;
    /* ★ 第二十六轮 T1-I6：碰撞骨棒采样比例表（见下面 `rig.collide` 段的注释）。
     *  原式 `s = sMin + (1−sMin) * (k/(rodSamples−1))` 只在最内层用到 `k`，
     *  却在 `it × j × k` 三重循环里重算。这里预存 `k/(rodSamples−1)` 部分。
     *  `rodSamples` 是 `rig` 上的构建期常量（量程 1..8）⇒ 表长 8 足够。
     *  ⚠️ 必须放在 `updateSecondary` 里 —— 放 `createSecondaryMotion` 会变成
     *  `ReferenceError: rodSamples is not defined`（本文件第 6 次同型坑）。 */
    const _ROD_S = new Float32Array(8);
    for (let _k = 0; _k < 8; _k++) _ROD_S[_k] = rodSamples > 1 ? _k / (rodSamples - 1) : 1;
    /* ★★★ 第二十一轮：**必须从 `rig` 再取一次**。
     *  `pieceAmp` / `thighAmp` 在 `createSecondaryMotion` 里是局部常量，
     *  `updateSecondary` 是另一个函数作用域 —— 直接引用会每帧抛
     *  `ReferenceError: pieceAmp is not defined`，整段解算被打断，
     *  症状是「所有通道 N 全 0、primed 恒 false」（第十九轮踩过，本文件第 3 次同型）。 */
    const pieceAmp = rig.pieceAmp;
    const pieceWRib = rig.pieceWRib;
    const pieceSel = rig.pieceSel;
    const ribbonSel = rig.ribbonSel;
    const piecePh = rig.piecePh;
    const thighAmp = rig.thighAmp;
    const thighSel = rig.thighSel;
    const thighWgt = rig.thighWgt;
    /* ★ 第二十二轮：披肩整片通道同样必须从 rig 再取（同一条规矩） */
    const shawlAmp = rig.shawlAmp;
    const shawlSel = rig.shawlSel;
    const shawlPh = rig.shawlPh;
    const shawlRigid = rig.shawlRigid;
    const shawlRigidAmp = rig.shawlRigidAmp;
    const shawlRoot = rig.shawlRoot;
    const shawlOff = rig.shawlOff;
    const shawlOffOk = rig.shawlOffOk;
    const shawlBase = rig.shawlBase;
    const shawlPush = rig.shawlPush;
    const shawlPushSign = rig.shawlPushSign;
    const shawlPushOsc = rig.shawlPushOsc;
    /* ★★★ 第二十四轮 v3：`hairSep` / `hairSepStart` / `hairSepList` **必须从 rig 再取一次**。
     *  `createSecondaryMotion` 里那个同名局部量不在本函数作用域 ⇒ 直接引用会每帧抛
     *  `ReferenceError: hairSep is not defined`，整段解算被打断
     *  （症状：`hairClash` 还能读到值，但所有通道 N 归 0、让位完全没发生）。
     *  这是本文件第 4 次同型坑（前面是 pieceAmp / thighAmp / shawlAmp / sideFrontKill）。 */
    const hairSep = rig.hairSep;
    const hairSepStart = rig.hairSepStart;
    const hairSepList = rig.hairSepList;
    /** ★ 第二十四轮 v3：`matGroup` 同样**必须从 rig 再取**（第 5 次同型坑）。
     *  漏了它 ⇒ 每帧抛 `ReferenceError: matGroup is not defined`，
     *  症状特别有欺骗性：`HS_off`（`hairsep=0` 时整块不跑）读数正常，
     *  只有开了 `hairsep` 的档才崩 —— 很像"通道算法有问题"，实际是变量作用域。 */
    const matGroup = rig.matGroup;
    /** ★ 第二十二轮：起步渐入权重（调用点每帧写 `rig.gaitW`）。见 `SecondaryRig.gaitW`。 */
    const gaitW = Math.max(0, Math.min(1, rig.gaitW || 0));
    const d = Math.min(Math.max(dt, 1 / 240), 1 / 30);
    const gStep = rig.gravity * d * d;
    /* ★ 侧摆时压掉前后摆的比例（`?secsidekill=`，缺省 0.35；见逐骨那段的长注释）。
     *  必须在这里从 rig 再取一次 —— 构建期那个同名局部量不在本函数作用域里
     *  （踩过：`ReferenceError: sideFrontKill is not defined`，每帧抛、布料整段不跑）。 */
    const sideKill = Math.max(0, Math.min(1, rig.sideFrontKill));
    /* ★ t16：静止侧张比例（`?secsidestand=`，缺省 0.55）。见逐骨侧摆那段的长注释。 */
    const sideStandK = Math.max(0, Math.min(1, rig.sideStandK));
    /* ★★★ t20：近裙摆减推量（`?secsideh=`，缺省 0.55；`<=0` 关 = 回到 t16 的「所有袖骨满推」）。
     *  问题：t16 实测 X 走向的袖-裙最差净距只有 0.00888 m，最差对是
     *  `Bone_ArmLets01_R錘 × Skirt_*` —— 这两根袖骨贴着裙摆上沿，满推 `sin(缺省角)` 时
     *  袖片被侧推过去正好擦到裙摆。旧的 `?secflare=` 有 `riskG` 处理这件事，
     *  但它是按**离体轴水平距离**算风险，对「已经张开的袖骨」不敏感；
     *  这里改用**绝对高度**：袖骨越低（越靠近裙摆），推量越小。
     *  ★ 为什么不直接降 `?secside=`：那是侧向优势的唯一来源（第十二轮才把它从 52 抬到 60，只准升不准降）。
     *    降它会把 2.33× 一起压下去；而按高度加权只削减**最低那一两根**，
     *    袖片主体（小臂以上）仍满推 ⇒ 侧向优势基本不变、净距抬起来。
     *  ★ 为什么不用骨长 `restLen`：这几根袖骨是 PMX 骨，长度差 10 倍
     *    （`Bone_ArmLets01_*` 是整片袖，`*錘` 只有几 mm），用长度加权会把推量分给
     *    根本不渲染的 `*錘`；也用不了 `_vHead.y`（袖骨垂在腰侧，`*錘` 反而更高）。
     *  ★ 采用**骨节点高度**（父骨世界原点 y），与渲染位置一致：袖片根部在肩、
     *    末端在小臂，主骨 `Bone_ArmLets01_*` 原点在肩上（y≈1.58），`02_*` 在小臂
     *    （y≈1.51），而裙摆上沿约 1.00 —— 这个梯度正好区分「贴着裙摆的袖片」。 */
    const sideHiOn = rig.sideHiK > 1e-4;
    const sideHiLo = rig.sideHiLo;
    const sideHiHi = rig.sideHiHi;
    const sideHiK = rig.sideHiK;
    // ★ 风：角色世界速度的反方向（走路带起的风把裙子/头发吹向身后）
    const wStep = rig.wind * d * d;
    const wx = -vx * wStep, wz = -vz * wStep;

    /* ★★★ 角色位移补偿（`carry`，见 `SecondaryOptions.carry` 的长注释）：
     *   本求解器在世界坐标里做 Verlet，锚点（骨头的世界位置）跟着角色走、粒子不跟，
     *   于是稳态落后 `lag ≈ v / 刚度`（实测 1.45 m/s 走路时前襟被拖到身后 30 cm）。
     *   把这一帧的位移**同时**补进 `particle` 与 `particlePrev`（两者都补 = 不产生速度），
     *   等价于在角色的移动坐标系里解算。⚠️ 必须在 Verlet 之前、且每帧都做。 */
    if (carry > 0 && (vx !== 0 || vz !== 0)) {
        const cx = vx * d * carry, cz = vz * d * carry;
        for (let i = 0; i < n * 3; i += 3) {
            particle[i] += cx; particle[i + 2] += cz;
            particlePrev[i] += cx; particlePrev[i + 2] += cz;
        }
    }

    // ① 先把动画写下的局部四元数存下来（后面循环里会被我们覆盖）
    for (let i = 0; i < n; i++) animLocal[i].copy(bones[i].quaternion);
    // ② 用动画姿态刷新整棵树的世界矩阵
    rig.root.updateWorldMatrix(true, true);
    /* ★ T1-C1（只读评审）：骨架根世界位置**每帧先算一次**，不靠下面四条通道。
     *  原属性：`_vRootPos` 只在 flare / side / hem / land 四条通道**各自的 if 分支**里刷新。
     *  四条同时关掉（如 `?secflare=-1&secside=-1&sechemwind=1&sechemfwd=0&secland=-1`）时它整帧不刷：
     *  首帧是 (0,0,0)、之后停在上一帧 ⇒ 径向圆心错、推力方向全错，
     *  而**不报错、`hairSepN` 照样计数** —— 与“功能没接上”在读数上逐位相同。
     *  下面四处旧调用保留（幂等，不改任何读数），只是不再承担“唯一刷新点”的职责。 */
    _vRootPos.setFromMatrixPosition(rig.root.matrixWorld);
    // ②b ★★ 方向性约束的轴：把「角色朝向 / 侧向」从骨架根局部空间旋到世界空间。
    //     每帧一次即可（整根骨树共用一个朝向）。见 `SecondaryRig.fwdLocal` 的注释。
    /* ★★★ 十三轮（用户 m02277「袖子的部位你之前的修改没变化」）：补 `|| sideAmp > 0`。
     *  实测（`_logs/spec-sleeve-r13a.json`，`?secvelx=1.446` 沿 +X 走）发现侧摆把袖子
     *  推向**前后**（fwdDeg 50.67 / sideDeg −4.4）——修方向要读 `_vSide`，
     *  而这根轴只在 antiOn/drive/flare 开着时才刷新；`?secside=` 单独开时它是**上一帧
     *  的旧值**（首次甚至是 0 向量）。门里必须带上侧摆自己。
     *  ★★★ 十六轮：下摆前倾也用 `_vSide` 当旋转轴，同样要进这个门
     *  （`?sechemfwd=` 单独开、其它通道全关时必须能拿到正确的侧向轴）。 */
    /* ★ 第二十一轮：整片布用 `_vFwd`、thigh 用 `_vSide` ⇒ 两条都得进这个门，
     *  否则单独开它们时轴是上一帧的旧值（甚至 0 向量）。 */
    if (rig.antiOn || driveAmp > 0 || flareAmp > 0 || sideAmp > 0 || hemFwdAmp > 0 || sideOscAmp > 0
        || pieceAmp > 0 || thighAmp > 0 || shawlAmp > 0) {
        _mRot.extractRotation(rig.root.matrixWorld);
        _qRoot.setFromRotationMatrix(_mRot);
        _vFwd.set(fwdLocal[0], fwdLocal[1], fwdLocal[2]).applyQuaternion(_qRoot).normalize();
        _vSide.set(sideLocal[0], sideLocal[1], sideLocal[2]).applyQuaternion(_qRoot).normalize();
    }
    rig.antiHits = 0;
    rig.antiMaxDeg = 0;

    /* ★★ 袖子向外撑开的**总开关量**（用户 2026-10-21 反馈1），0..1。
     *   ① 只由**角色水平速度**决定 ⇒ 站定自动归 0，不需要额外状态机；
     *   ② 但带一段**死区 + 平滑**：原来 `spd / flareSpeed` 是线性的，人站着晃 5 cm/s
     *      也会算出 0.05 的撑开量（袖子会「虚撑」）。现在 < 0.12 m/s 一律 0，
     *      再平滑过渡到 `flareSpeed` 满幅 ⇒ 「站定不撑」是硬行为，不是近似。
     *   ③ 相位（手臂前后摆）与贴体风险在逐骨循环里再乘，见下面那段。
     *   ④ **兜底：速度信号缺失时不撑。** 调用点可能传 `vx = vz = 0`
     *      （例如位移由动画根运动直接写进 `matrixWorld`，或某条调用链忘了传），
     *      那时 `spd = 0` ⇒ `flareAmt = 0` ⇒ 外撑整段被跳过，`flareN` 仍是 0，
     *      症状与「功能没接上」逐位相同。
     *      所以这里再量一次**骨架根的世界位移速度**（米/秒），取两者较大值。
     *      ⚠️ 用 `d = clamp(dt)` 做分母（与 Verlet 同一口径）：`dt` 被夹到 ≤ 1/30，
     *      除以真实 dt 会把速度算小；用 `d` 反而只会高估 ⇒ 外撑宁多不少。
     *      站定时骨架根不动、`vx/vz` 也是 0 ⇒ 仍然 `flareAmt = 0`，不会「虚撑」。 */
    let flareAmt = 0;
    if (flareAmp > 0) {
        _vRootPos.setFromMatrixPosition(rig.root.matrixWorld);
        let spd = Math.hypot(vx, vz);
        const rpx = rig._flareRootPrev[0];
        if (rpx === rpx) {                          // NaN = 还没记过上一帧
            const rspd = Math.hypot(_vRootPos.x - rpx, _vRootPos.z - rig._flareRootPrev[1]) / d;
            if (rspd > spd) spd = rspd;
        }
        rig._flareRootPrev[0] = _vRootPos.x;
        rig._flareRootPrev[1] = _vRootPos.z;
        const t = (spd - 0.12) / Math.max(1e-3, flareSpeed - 0.12);
        const u = t < 0 ? 0 : t > 1 ? 1 : t;
        flareAmt = u * u * (3 - 2 * u);            // smoothstep：两端斜率为 0，起停不弹
        rig.flareSpd = spd;
    }
    rig.flareAmt = flareAmt;
    let flarePhSum = 0, flareRkSum = 0, flareDegSum = 0;
    // 米级取证：袖骨离体轴水平距离（米）的本帧累计/最大值，见下面的外撑块
    let flareOlSum = 0, flareOlMax = 0;
    rig.flareN = 0;
    rig.flareDeg = 0;
    rig.flarePhase = 0;
    rig.flareRisk = 0;
    rig.flareOlMean = 0;
    rig.flareOlMax = 0;

    /* ── ★★★ 侧向摆动量（用户 m18305）────────────────────────────────────
     *  与 `flareAmt` 一样按**角色水平速度**归一（死区 0.12 m/s、smoothstep），
     *  但两条通道各自独立：`?secflare=-1` 不影响侧向摆，`?secside=-1` 也不影响外撑。
     *  站定 ⇒ 0 ⇒ 下面那段整块跳过（与「参数没读进来」在读数上可区分：`sideBones`）。 */
    let sideAmt = 0;
    if (sideAmp > 0) {
        _vRootPos.setFromMatrixPosition(rig.root.matrixWorld);
        let spd = Math.hypot(vx, vz);
        const rpx2 = rig._flareRootPrev2[0];
        if (rpx2 === rpx2) {
            const rspd = Math.hypot(_vRootPos.x - rpx2, _vRootPos.z - rig._flareRootPrev2[1]) / d;
            if (rspd > spd) spd = rspd;
        }
        rig._flareRootPrev2[0] = _vRootPos.x;
        rig._flareRootPrev2[1] = _vRootPos.z;
        const t2 = (spd - 0.12) / Math.max(1e-3, sideSpeed - 0.12);
        const u2 = t2 < 0 ? 0 : t2 > 1 ? 1 : t2;
        sideAmt = u2 * u2 * (3 - 2 * u2);
    }
    rig.sideAmt = sideAmt;
    rig.sideN = 0;
    rig.sideApplied = 0;
    rig.sideDeg = 0;
    rig.sideRoll = 0;
    rig._sideDbgW = 0; rig._sideDbgRoll = 0; rig._sideDbgSd = 0; rig._sideDbgDeg = 0;
    const _hasSide = sideAmp > 0 && sideAmt > 0 && rig.sideArm.length > 0;
    let sideDegSum = 0, sideRollLast = 0;

    /* ── ★★★ 裙摆下摆的「走起来程度」（用户 m11430 任务3）──────────────────
     *  与侧摆/外撑同一套速度归一（死区 0.12 m/s、smoothstep、用骨架根的世界位移兜底），
     *  但**独立计时**：站定时 `hemAmt = 0` ⇒ 下摆既不折风也不前倾，纯垂落。 */
    let hemAmt = 0;
    if (rig.hemSel && (rig.windHem < 1 || rig.hemFwdAmp > 0)) {
        _vRootPos.setFromMatrixPosition(rig.root.matrixWorld);
        let spd = Math.hypot(vx, vz);
        const rpx3 = rig._hemRootPrev[0];
        if (rpx3 === rpx3) {
            const rspd = Math.hypot(_vRootPos.x - rpx3, _vRootPos.z - rig._hemRootPrev[1]) / d;
            if (rspd > spd) spd = rspd;
        }
        rig._hemRootPrev[0] = _vRootPos.x;
        rig._hemRootPrev[1] = _vRootPos.z;
        const t3 = (spd - 0.12) / Math.max(1e-3, sideSpeed - 0.12);
        const u3 = t3 < 0 ? 0 : t3 > 1 ? 1 : t3;
        hemAmt = u3 * u3 * (3 - 2 * u3);
    }
    rig.hemAmt = hemAmt;
    rig.hemN = 0;
    rig.hemW = 0;

    /* ── ★★★ 落脚脉冲（用户 m07388；参考视频实测见 `SecondaryRig.landPulse`）────
     *  输入是**本帧的步态相位** `rig.stepPhase`（调用点在 `MmdCharacter.tsx` 里
     *  用 `dist/STRIDE` 算出来，0 = 一只脚刚落地、0.5 = 另一只脚刚落地）。
     *
     *  两条包络（都在 0..1 步的相位轴上）：
     *   ① 抬升 `liftE`：紧跟落脚的**非对称**脉冲（上升宽 `landLiftW`、
     *      指数衰减宽 `landLiftD`），对应参考视频 `h` 在第 0.19 步取最小。
     *   ② 外扩 `spreadE`：滞后 `landSpreadPh` 的**高斯**包，对应 `hemW` 在 0.65 步取最大。
     *  用 max 合成一个角度，再乘每骨权重建到 `_vRest` 上（见逐骨那段）。
     *
     *  ⚠️ 为什么用 `d` 而不是墙钟：本函数每帧可能被调用多次（定格暖机路径以
     *     `dt = 1/60` 定步回放）⇒ 用相位（由 `dist/STRIDE` 决定）而不是自己积时间，
     *     定格出图与真机才会**逐位一致**。 */
    let landPulse = 0;
    {
        const LA = rig.landLiftAmp, SA = rig.landSpreadAmp;
        /* ★ T1-I1（只读评审）：补 **站定 NaN 闸**。
         *  原属性：`SEC_LAND` 缺省 8 > 0、`_landN` > 0 ⇒ **缺省配置下站定即成立**，
         *  `stepPhase = NaN` ⇒ `sp = NaN` ⇒ `landPulse = Math.max(NaN, NaN)` ⇒ `rig.landPulse = NaN`，
         *  并连带 `_landLiftE / _hairLiftE` 变 NaN。
         *  画面不受影响（下面对 NaN 的比较恰好为 false），但 `MmdCharacter.tsx` 打印的
         *  `landPulse` 读数坏掉 —— 而那正是验这条通道的判据。与 piece / shawl 两处同一写法。 */
        if ((LA > 0 || SA > 0) && rig._landN > 0 && rig.stepPhase === rig.stepPhase) {
            /* 径向基准：骨架根的世界位置。**无条件算一次** —— 不能依赖上面
             * `hemAmt`/`flareAmt`/`sideAmt` 那几段有没有跑起来
             * （`?sechemwind=1&sechemfwd=0&secflare=-1&secside=-1` 时它们全会跳过，
             *  `_vRootPos` 就停在上一帧甚至全 0 ⇒ 径向全是垃圾方向、脉冲乱飘）。 */
            _vRootPos.setFromMatrixPosition(rig.root.matrixWorld);
            /* 相位折到「最近一次落脚」之后 0..1（0 = 刚落地）。
             * `stepPhase` 是 0..1 的整循环相位（两步）⇒ 乘 2 折成单步相位，
             * 取小数部分 = 「距离上一次落脚过了多远」。 */
            let sp = rig.stepPhase * 2;
            sp = sp - Math.floor(sp);
            if (sp < 0) sp += 1;
            /* ① 抬升：峰在 landLiftPh。用「相距 = sp − ph，取环上最近距离」，
             *    让峰位跨 0/1 边界也连续（参考读数峰在 0.19，本身就在环内）。 */
            let dL = sp - rig._landLiftPh;
            dL = dL - Math.round(dL);                  // → −0.5..+0.5
            let liftE = 0;
            if (LA > 0) {
                if (dL < 0) {
                    liftE = Math.exp(-(dL / rig._landLiftW) * (dL / rig._landLiftW));
                } else {
                    liftE = Math.exp(-(dL / rig._landLiftD) * (dL / rig._landLiftD));
                }
            }
            /* ② 外扩：以 landSpreadPh 为中心的对称高斯（`landSpreadW` = 1σ 宽度）。 */
            let dS = sp - rig._landSpreadPh;
            dS = dS - Math.round(dS);
            const spreadE = SA > 0
                ? Math.exp(-(dS / rig._landSpreadW) * (dS / rig._landSpreadW))
                : 0;
            landPulse = Math.max(liftE, spreadE);
            rig.landN = 0;
            rig.landDeg = 0;
            rig._landLiftE = liftE;
            rig._landSpreadE = spreadE;

            /* ── ★★★ 第二十二轮：**头发用独立相位**（用户：「头发循环和步态错开几拍」）──
             *
             *  用户原话：「最后是头发。头发比较特殊。**扬起到落下并非完全和步态阶段重合**。
             *  即头发的循环实际上是和步态**错开几拍**。」
             *  以及：「开始向前走的时候就要**先扬一下**，如果不动会穿模。」
             *
             *  做法：头发不跟着 `sp`（落脚相位）走，而是 `sp + hairPh`（缺省 +0.25 步 =
             *  提前四分之一步扬起）。负值是「提前」，正值是「滞后」。
             *  为什么是提前：起步那一帧脚还没落、头发就已经抬起来（防穿模），
             *  所以头发的循环必须**领先**步态。
             *
             *  ⚠️ 只在 `landWgt` 里那些**头发骨**上用这个包络（见逐骨那段 `isHairI`），
             *     裙摆仍用原相位 —— 两者是两条独立的时间线。
             */
            let dH = sp - (rig._landLiftPh + rig.hairPh);
            dH = dH - Math.round(dH);
            let hairLiftE = 0;
            if (LA > 0) {
                if (dH < 0) hairLiftE = Math.exp(-(dH / rig._landLiftW) * (dH / rig._landLiftW));
                else hairLiftE = Math.exp(-(dH / rig._landLiftD) * (dH / rig._landLiftD));
            }
            let dHS = sp - (rig._landSpreadPh + rig.hairPh);
            dHS = dHS - Math.round(dHS);
            const hairSpreadE = SA > 0
                ? Math.exp(-(dHS / rig._landSpreadW) * (dHS / rig._landSpreadW)) : 0;
            /* ★★★ 第二十二轮：**起步第一下强制给头发一个上扬脉冲**。
             *
             *  用户原话：「以上说的所有运动，你需要格外注意一下开始走的那一下。
             *  比如头发，开始向前走的时候就要**先扬一下**，如果不动会穿模。」
             *
             *  为什么单靠 `hairPh` 相位偏移不够：那只让**周期性**的包络峰提前，
             *  而起步瞬间 `stepPhase` 刚从 NaN 变成 0~1 的某个值，
             *  包络此刻可能正好落在谷里（实测起步后 1.4 s 内 `hairLift` 一直是 0）。
             *  ⇒ 必须额外叠一个**与相位无关的起步脉冲**：`kick = exp(-t/0.45)`，
             *     从起步那一刻起以 0.45 s 时间常数衰减，保证「第一下一定扬」。
             *  ⚠️ 用 `rig.startT`（调用点写：起步后经过的秒数），站定/停步时置为 -1。 */
            const kickT = rig.startT;
            let hairKick = 0;
            if (kickT >= 0) hairKick = Math.exp(-kickT / 0.45);
            rig._hairKick = hairKick;
            rig._hairLiftE = Math.max(hairLiftE, hairKick);
            rig._hairSpreadE = Math.max(hairSpreadE, hairKick * 0.8);
        } else {
            rig.landN = 0;
            rig.landDeg = 0;
            rig._landLiftE = 0;
            rig._landSpreadE = 0;
            rig._hairLiftE = 0;
            rig._hairSpreadE = 0;
        }
    }
    rig.landPulse = landPulse;
    rig.landApplied = 0;

    /* ── ★★★ 第二十一轮：整片布（披风/带）的**共享摆动量** ──────────────────
     *  所有片骨绕**同一条轴**（前后轴 `_vFwd`）转**同一个角** `pieceAmp × pieceOsc`。
     *  轴与符号都与骨无关 ⇒ 左右两半一起朝同一侧摆（这正是「一个整体」）。
     *
     * ═══ ★★★ 第二十二轮：用 `stepPhase`（整圈）而不是 `sp2`（每步）═══════════════
     *
     *  实测（背视 + 正面双视角交叉验证，见 `_logs/round22/REF-CHECK.md`）：
     *    · 落脚间隔 **1.15~1.17 s**
     *    · **一个落脚区间（≈1.15 s）里，布料只走半个往复**（偏左 → 中立 → 偏右）
     *      ⇒ 布料**完整往复 = 2 个落脚区间 = 一个整圈 = 2.33 s**
     *    · 每次落地时布料在**左或右的极限**，左右交替
     *
     *  ❗️ 前两版都错在「用 `sp2`（步内相位）驱动」：
     *     `sp2 = frac(stepPhase·2)` 的周期是**一步**，而布料需要**两步**的周期。
     *     更糟的是 `sp2` 在 `stepPhase = 0.5` 处**从 1 跳回 0**
     *     ⇒ 布料角度在一帧内从 −1 跳到 +1，**每走一步就抖一下**（实测就是用户的"节奏不对"）。
     *     （`_tools/oscdir.js` 直接读 `pieceDeg` 证实了这一点：sp2=0.025 处 +0.156、
     *       sp2=0.975 处 −0.157，正好是回绕断点。）
     *
     *  ✅ 正确写法：**直接用 `stepPhase`（0..1 = 一整圈两步）**：
     *       `pieceOsc = cos(2π·(stepPhase + ph))`
     *     · `stepPhase = 0`   ⇒ osc = +1 ⇒ **左极限**（落地）
     *     · `stepPhase = 0.5` ⇒ osc = −1 ⇒ **右极限**（落地）
     *     · 连续、无断点，且每次落地都在极限、左右交替 —— 正是用户要的。
     *     `ph` 是「极限相对落地点的滞后」，缺省 0 = 落地即极限；
     *     参考视频实测有 +0.05~0.1 s 的滞后，可用 `?secpieceph=` 加（相位单位，一步的分数）。
     *
     *  ⚠️ `stepPhase` 是 NaN（站定）⇒ `pieceOsc = 0` ⇒ 整段不转 ⇒ 站立自然垂落。
     *  ⚠️ `_vFwd` 只在上面那个轴向门里刷新；门里已经补了 `pieceAmp > 0`。 */
    let pieceOsc = 0;
    if (pieceAmp > 0 && (rig.pieceCapeN > 0 || (rig.pieceRibbonN > 0 && rig.pieceWRib > 0))
        && rig.stepPhase === rig.stepPhase) {
        /* ★ 第二十二轮：乘起步渐入权重 gaitW（见 SecondaryRig.gaitW 的注释）。
         *  gaitW 在起步 0.35 s 内从 0 升到 1 ⇒ 整片布是「渐入」而不是「啪一下出现」。 */
        pieceOsc = Math.cos(2 * Math.PI * (rig.stepPhase + piecePh)) * gaitW;
    }
    rig.pieceN = 0;
    rig.pieceApplied = 0;
    rig.pieceDegNow = 0;                      // 逐骨累加，函数末尾按 pieceN 除（平均值口径）

    /* ── ★★★ 第二十二轮：披肩（编号4）的整片摆动量 ──────────────────────────
     *  与披风/带**同一套相位**（`cos(2π·stepPhase)`），所以三片布会一起朝同一侧摆，
     *  视觉上是一整块；但**幅度分开**（`shawlAmp` 缺省 5°，比披风 12° 小 —— 用户嫌大）。
     *  ⚠️ 与披风/带不同的一点：披肩**不做任何高度/径向加权**（见 `shawlSel` 的注释），
     *     每一根片骨都转同一个角 ⇒ 上段与下段同步，不再是「只有下部分动」。
     *  ⚠️ `stepPhase` 是 NaN（站定）⇒ `shawlOsc = 0` ⇒ 站立自然垂落。 */
    let shawlOsc = 0;
    if (shawlAmp > 0 && rig.shawlBones > 0 && rig.stepPhase === rig.stepPhase) {
        shawlOsc = Math.cos(2 * Math.PI * (rig.stepPhase + shawlPh)) * gaitW;
    }
    /* ★★★ 第二十八轮：披肩刚性整片的驱动量。
     *  与 `shawlOsc` 同一个相位，但**不要求 `shawlAmp > 0`** ——
     *  `shawlAmp` 乘了 `clothAmp`，用户在 `?clothamp=0` 下会把旧通道关掉，
     *  而「整片一起飘」这件事和幅度总开关是两回事，不能一起被关。 */
    let shawlOscR = 0;
    if (shawlRigid > 0 && rig.shawlBones > 0 && rig.stepPhase === rig.stepPhase) {
        shawlOscR = Math.cos(2 * Math.PI * (rig.stepPhase + shawlPh)) * gaitW;
    }
    rig.shawlN = 0;
    rig.shawlApplied = 0;
    rig.shawlDegNow = 0;
    rig.shawlPushN = 0;
    rig.shawlPushDegNow = 0;
    /* ★ 第二十五轮 C：一致化计数每帧清零（与其它通道同一规矩） */
    rig.netN = 0;
    /* ★ 第二十五轮 D：压住通道计数清零 */
    rig.holdN = 0;
    /* ★ 第二十四轮 v3：头发让位的逐帧计数 + **基准清零**（见 `SecondaryRig.hairBaseDir`）。
     *  ⚠️ 清零这条与 `sideBaseDir`/`landBaseDir`/`shawlBaseDir` 是同一个规矩，以后加同类通道照抄。 */
    rig.hairSepN = 0;
    rig.hairSepDeg = 0;
    rig.hairApplied = 0;
    {
        const hb = rig.hairBaseDir;
        for (let i2 = 0; i2 < n; i2++) {
            const b3 = i2 * 3;
            hb[b3] = 0; hb[b3 + 1] = 0; hb[b3 + 2] = 0;
        }
    }

    /* ── ★★★ 第二十一轮：thigh（裙子被大腿顶起）的驱动量 ────────────────────
     *  ⚠️ **不能复用 `legFwd`** —— 那是 `?secdrive=` 那条通道的量，而 `SEC_DRIVE`
     *  缺省 **−1（已回滚）** ⇒ `driveAmp = 0` ⇒ `legFwd` 恒 0 ⇒ thigh 永远不跑。
     *  所以这里**独立**量一次大腿前摆，只依赖 `limbA/limbB`（上面那个门已补
     *  `|| thighAmp > 0`，所以它们会被填上）。
     *
     *  归一化必须**自标定**：大腿方向在绑定/站立姿势下本来就有个常偏，
     *  写成 `raw / 0.45` 会让**站定时算出 1.0**（第十九轮实测 `idle` 下 `thighAmt` 0.904、
     *  裙摆一直在前顶）。改成「运行时 min/max 包络」+ `stepPhase` 闸。
     *  ⚠️ `?idlecreep` 会让站定时播放头仍以 0.06× 推进（腿在原地微动）⇒ 光有包络
     *  还不够，必须再加 `stepPhase` 闸（站定时它是 NaN）。 */
    {
        rig.thighN = 0;
        rig.thighDeg = 0;
        rig.thighApplied = 0;
        let rawT = NaN;
        let rawL = NaN, rawR = NaN;
        if (thighAmp > 0) {
            const thSwing = (j: number): number => {
                const a = limbA[j], b2 = limbB[j], ref = _limbRef[j];
                if (!a || !b2) return NaN;
                if (ref !== ref) return NaN;
                _vHead.setFromMatrixPosition(a.matrixWorld);
                _vLimb.setFromMatrixPosition(b2.matrixWorld).sub(_vHead);
                const l = _vLimb.length();
                if (l < 1e-6) return NaN;
                _vLimb.divideScalar(l);
                return (_vLimb.x * _vFwd.x + _vLimb.y * _vFwd.y + _vLimb.z * _vFwd.z) - ref;
            };
            const tL = thSwing(0), tR = thSwing(1);
            rawL = tL; rawR = tR;
            /* 两条腿取**较大**者：哪条大腿抬起来，前面那片裙摆就跟着让开
             * （左右对称的裙片都会吃到，不会只让一侧顶起来）。
             * ★ 这个 `rawT` 也用来推进**共用**的自标定包络（`thighAmt` 就这么来）。 */
            rawT = Math.max(tL !== tL ? -1 : tL, tR !== tR ? -1 : tR);
        }
        if (rawT === rawT) {
            /* 自标定包络：min 立刻跟随、max 缓慢放松（与 `normLimb` 同一手法）。 */
            if (!(rig._thighMin === rig._thighMin)) { rig._thighMin = rawT; rig._thighMax = rawT; }
            const kT = Math.min(1, d * 1.5);
            if (rawT < rig._thighMin) rig._thighMin = rawT; else rig._thighMin += (rawT - rig._thighMin) * kT;
            if (rawT > rig._thighMax) rig._thighMax = rawT; else rig._thighMax += (rawT - rig._thighMax) * kT;
            const spanT = rig._thighMax - rig._thighMin;
            rig.thighAmt = spanT > 1e-3
                ? Math.min(1, Math.max(0, (rawT - rig._thighMin) / spanT)) : 0;
            /* ★ 分侧驱动量（诊断 + 逐骨验收用）：每条腿**用自己的包络**归一。
             *  为什么必须分开：`thighAmt` 是 max ⇒ 一个循环里峰两次；
             *  而左侧骨只在左腿抬起时前顶、右侧骨只在右腿抬起时前顶。
             *  先用 max 求相关会把两块**反相**的方波平均成常数（实测 corr 被稀释到 0.565）。 */
            if (!(rig._thighMinL === rig._thighMinL)) { rig._thighMinL = rawL; rig._thighMaxL = rawL; }
            if (!(rig._thighMinR === rig._thighMinR)) { rig._thighMinR = rawR; rig._thighMaxR = rawR; }
            const kL = Math.min(1, d * 1.5);
            if (rawL < rig._thighMinL) rig._thighMinL = rawL; else rig._thighMinL += (rawL - rig._thighMinL) * kL;
            if (rawL > rig._thighMaxL) rig._thighMaxL = rawL; else rig._thighMaxL += (rawL - rig._thighMaxL) * kL;
            const spanL = rig._thighMaxL - rig._thighMinL;
            rig.amtL = spanL > 1e-3 ? Math.min(1, Math.max(0, (rawL - rig._thighMinL) / spanL)) : 0;
            if (rawR < rig._thighMinR) rig._thighMinR = rawR; else rig._thighMinR += (rawR - rig._thighMinR) * kL;
            if (rawR > rig._thighMaxR) rig._thighMaxR = rawR; else rig._thighMaxR += (rawR - rig._thighMaxR) * kL;
            const spanR = rig._thighMaxR - rig._thighMinR;
            rig.amtR = spanR > 1e-3 ? Math.min(1, Math.max(0, (rawR - rig._thighMinR) / spanR)) : 0;
            /* ★ 站定闸：`stepPhase` 是 NaN（站定）⇒ 驱动量归 0。
             *  ⚠️ **不能**用 `hypot(vx,vz)` 当闸：`?autowalk=…&hold=1`（原地走）
             *  和「位移由动画根运动写进 matrixWorld」这两条路里速度都是 0，
             *  一加闸就变成「走路时 thigh 恒 0」（第十九轮实测踩过）。 */
            if (!(rig.stepPhase === rig.stepPhase)) { rig.thighAmt = 0; rig.amtL = 0; rig.amtR = 0; }
        } else {
            rig.thighAmt = 0; rig.amtL = 0; rig.amtR = 0;
        }
    }

    /* ── ★★★ 侧向摆动：每一侧「手肘/手腕相对肩膀往**外侧**荡了多少」（用户 m18305）──
     *  为什么要量骨骼而不是直接用 `axisSign`：
     *    袖骨挂在胳膊上，胳膊整体往哪边荡，袖片就整体往哪边甩。侧向摆的**相位**
     *    必须来自胳膊自己的运动，否则「向两侧飘」会变成「恒定外推」。
     *  量法（每侧两根链段）：
     *    `rs` = (肘 − 肩)·side，`re` = (腕 − 肘)·side    —— `side` = 该侧的外侧水平方向
     *    速度 `vs = (rs − rs_prev)/d`、`ve = (re − re_prev)/d`
     *    `vel = (vs + ve) * 0.5`，再除以「走路时手肘侧向摆速幅值」0.45 m/s 归一到约 0..1
     *  符号：+ = 手肘/手腕正朝**外侧**荡。取 max(vel, 0) ⇒ 只往外荡，不往里收
     *  （往里收会让袖子贴上衣服，正是用户说的穿模来源）。
     *  `sideRollNorm[]` 每侧一个，逐骨按「该骨挂在哪条胳膊下」选用。 */
    const sideRollNorm: number[] = [0, 0];
    const _oa = rig.sideSideN[0] || 0;
    for (let s2 = 0; s2 < 2 && _hasSide; s2++) {
        const o = s2 === 0 ? 0 : _oa;
        const cnt = rig.sideSideN[s2] || 0;
        if (cnt < 2) continue;
        _vArmS.setFromMatrixPosition(rig.sideArm[o].matrixWorld);
        _vArmE.setFromMatrixPosition(rig.sideArm[o + 1].matrixWorld);
        _vArmW.setFromMatrixPosition(rig.sideArm[o + (cnt > 2 ? 2 : 1)].matrixWorld);
        const ls = Math.hypot(_vArmE.x - _vArmS.x, _vArmE.z - _vArmS.z);
        const lw = cnt > 2 ? Math.hypot(_vArmW.x - _vArmE.x, _vArmW.z - _vArmE.z) : ls;
        if (!(ls > 1e-5) || !(lw > 1e-5)) continue;
        /* 该侧外侧方向：肩→手肘的水平方向（胳膊摆开后仍指向身体外侧的那一侧） */
        const sox = (_vArmE.x - _vArmS.x) / ls, soz = (_vArmE.z - _vArmS.z) / ls;
        const rs = (_vArmE.x - _vArmS.x) * sox + (_vArmE.z - _vArmS.z) * soz;   // = ls
        const re = (_vArmW.x - _vArmE.x) * sox + (_vArmW.z - _vArmE.z) * soz;
        const ps = rig._sideRollS[s2], pe = rig._sideRollE[s2];
        let vel = 0;
        if (ps === ps && pe === pe) vel = 0.5 * ((rs - ps) / d + (re - pe) / d);
        rig._sideRollS[s2] = rs; rig._sideRollE[s2] = re;
        /* 0.45 m/s = 走路时手肘/手腕相对肩膀的侧向摆速典型幅值（≈1.4 m/s 步速下实测口径） */
        let t3 = vel / 0.45;
        if (t3 < 0) t3 = 0; else if (t3 > 1) t3 = 1;
        sideRollNorm[s2] = t3;
        if (t3 > sideRollLast) sideRollLast = t3;
    }
    rig.sideRoll = sideRollLast;
    /* ★★★ 十七轮（用户 m12388）：**摆臂相位** —— 侧展角往复的相位源。
     *  用户原话：「袖子侧展其实我们已经做了 8°，不过没有随着摆臂而向外摆动，
     *  可以随着行走时摆臂动作，加入一定角度的往复运动，比如 8° 到 10° 再到 8°」。
     *
     *  ★ 为什么不用上面那段 `sideRollNorm`：它量的是「手臂往**外侧**甩的角速度」，
     *    而 MMD 走路动画的手臂只做**前后**摆（实测该段恒 0，才被下面的兜底顶成常量）。
     *    所以拿它做相位，结果必然是常量 ⇒ 这正是「有 8° 但不随摆臂往复」的算术原因。
     *
     *  ★ 相位取「该侧前臂方向在前后轴上的投影」`(腕 − 肘)·_vFwd`：
     *    手臂前摆 ⇒ 腕在肘前方 ⇒ 正；后摆 ⇒ 负。左右两侧天然**反相**（走路时一前一后），
     *    正合用户要的「左袖张时右袖收」，也让两片袖子不互相抵消。
     *    用**方向**（已归一）而不是位置差，就不受手臂长度/缩放影响。
     *  ★ 归一化：除以 `sideOscRef`（缺省 0.35 = 走路摆臂时该投影的典型峰值）再夹到 ±1。
     *    `sideOscAmp = 0` ⇒ 下面逐骨那段的 `sideOscK` 恒 1 ⇒ 与十六轮逐位一致（可回滚）。 */
    if (sideOscAmp > 0 && _hasSide) {
        /* ★ 用**两臂之差**取相位，而不是各自单独归一。
         *  原因（实测 `_logs/round17/osc.jsonl` 第一版）：角色的手臂在静止姿势里本来就
         *  往前弯，`(腕−肘)·前向` 每侧都带一个**正的直流偏置** —— 左 [−0.04,+0.26]、
         *  右 [+0.58,+0.86]，两侧都是正的 ⇒ 叠加后只是把基准角整体抬高，**没有往复**。
         *  取差 `(dL − dR)/2` 后：走路一前一后 ⇒ 一正一负，直流被减掉，
         *  且左右**符号天然相反**（左袖张时右袖收），不会互相抵消。 */
        const proj = (o3: number, c3: number): number => {
            if (c3 < 2) return 0;
            _vArmE.setFromMatrixPosition(rig.sideArm[o3 + 1].matrixWorld);
            _vArmW.setFromMatrixPosition(rig.sideArm[o3 + (c3 > 2 ? 2 : 1)].matrixWorld);
            _vArmW.sub(_vArmE);
            const lw3 = _vArmW.length();
            if (lw3 < 1e-5) return 0;
            return (_vArmW.x * _vFwd.x + _vArmW.y * _vFwd.y + _vArmW.z * _vFwd.z) / lw3;
        };
        const dL3 = proj(0, rig.sideSideN[0] || 0);
        const dR3 = proj(_oa, rig.sideSideN[1] || 0);
        /* ★ 高通：减掉**慢速均值**，把摆动量压到以 0 为中心。
         *  第二版实测（`_logs/round17/osc2.jsonl`）：只取两臂之差还不够 —— 左臂在静止姿势里
         *  比右臂更向前，差值的**直流偏置**让相位始终落在 [−0.44,−0.16]，一个区间都不过零，
         *  于是两片袖子只是整体偏了一点、仍然没有往复。
         *  ⇒ 用时间常数 ~1.4 s 的均值追踪器扣掉直流（走路周期 ~1.0 s，不会被一起扣掉）。 */
        const raw3 = (dL3 - dR3) * 0.5;
        if (!(rig.sideOscDc === rig.sideOscDc)) rig.sideOscDc = raw3;
        rig.sideOscDc += (raw3 - rig.sideOscDc) * Math.min(1, d * 0.7);
        const resid3 = raw3 - rig.sideOscDc;
        /* ★ 自动增益：固定 `sideOscRef=0.35` 时实测摆臂残差只有 ±0.047
         *  ⇒ 归一后只到 ±0.13 ⇒ 2° 振幅实际只兑现 ±0.27°，看不见。
         *  改用**残差包络**归一（包络瞬时上升、慢速衰减 ~0.6/s，下限 0.05），
         *  无论这个角色摆臂多大都能跑满 ±1。 */
        const ares = Math.abs(resid3);
        if (!(rig.sideOscEnv > 0)) rig.sideOscEnv = Math.max(0.05, ares);
        if (ares > rig.sideOscEnv) rig.sideOscEnv = ares;
        else rig.sideOscEnv = Math.max(0.05, rig.sideOscEnv - rig.sideOscEnv * d * 0.6);
        let sw3 = resid3 / (rig.sideOscEnv * 0.85);
        if (sw3 < -1) sw3 = -1; else if (sw3 > 1) sw3 = 1;
        rig.sideOscSwing = sw3;
        rig.sideOscRaw[0] = +dL3.toFixed(4);
        rig.sideOscRaw[1] = +dR3.toFixed(4);
        rig.sideOscR[0] = +resid3.toFixed(4);
        /* ★★★ 关键（第三稿，前两稿都实测否决）：
         *  ① 两侧各自独立归一 ⇒ 摆臂残差带着「左臂比右臂更前」的固定差，
         *     相位区间不跨零（[−0.44,−0.16]），袖子只整体偏一点、**不往复**；
         *  ② 两臂之差取反相（`ph[1] = −ph[0]`）⇒ 一侧张开时另一侧收拢，
         *     实测**总跨度反而下降**（`_logs/round17/oscw.jsonl`：0.554→0.545→0.520）
         *     —— 视觉上两片袖子互相抵消，等于没做。
         *  用户原话「8° 到 10° 再到 8°」是**单侧张角的一个呼吸周期**，
         *  所以两侧必须**同相**：`breathe = 0.5×(1+swing)` ∈ [0,1]，
         *  `eff = base × (1 + (oscAmp/sideAmp) × breathe)`
         *  ⇒ 张角走 sideAmp → sideAmp+oscAmp → sideAmp（8°→10°→8°），
         *     且两片袖子一起开合，总跨度能真的变宽。 */
        sideOscPh[0] = sw3;
        sideOscPh[1] = sw3;
    } else {
        sideOscPh[0] = 0; sideOscPh[1] = 0;
        rig.sideOscSwing = 0;
    }
    rig.sideOscN = 0;
    /* ★★ 回退：胳膊侧向速度实测为 0 时，换成**步速**驱动侧向飘。
     *  为什么需要：MMD 走路动画里胳膊是**前后摆**的，肩→上臂这段的水平侧向速度
     *  在正常步速下只有 1e-3 m/s 量级（实测 `sideRoll` 恒 0 ⇒ 整段侧摆一次都没跑）。
     *  用户要的是「走起来袖子向两侧飘」，跟的是**速度**而不是手臂侧摆相位，
     *  所以侧向速度既然不存在，就用角色水平速度 `amt`（0..1）顶上去。
     *  判据：`sideRollLast <= 1e-3` 才算「实测没有侧向摆」，否则仍用实测值 ——
     *  将来换一份真有侧向摆的动画时自动优先用实测。 */
    if (sideRollLast <= 1e-3 && sideAmt > 0) {
        sideRollLast = sideAmt;
        sideRollNorm[0] = sideAmt;
        sideRollNorm[1] = sideAmt;
    }
    /* ★ 诊断口径「本帧侧摆角的均值」的赋值必须放在**逐骨循环之后**（见函数末尾），
     *  在这里算只会读到 0 —— `sideDegSum` 是循环里累加的（踩过：`sideN=6` 而
     *  `sideDeg` 恒 0，看着像「参数没读进来」，其实是读取时机错了）。 */
    /* ── ★★ 肢体驱动量（用户 m12638 / m12655）───────────────────────────────
     *  「大腿向前摆了多少」= 关节→子关节的世界方向在前后轴上的分量 − 绑定姿势的同一量。
     *  腿向前 ⇒ 正值；腿向后 ⇒ 负值（这时驱动量取 0，让弹簧把布片拉回原地）。
     *  ★ 归一化除数 0.45 是 05_standard 走路时大腿前后摆的典型幅值（≈ sin 27°）——
     *    摆满时驱动量 = 1，即把目标方向压 `driveAmp` 那么多弧度。
     */
    let legFwd = 0, armFwd = 0, rLegSaved = 0, rArmSaved = 0;
    if (driveAmp > 0) {
        const swing = (j: number): number => {
            const a = limbA[j], b2 = limbB[j], ref = _limbRef[j];
            if (!a || !b2) return 0;
            if (ref !== ref) return 0;                       // NaN 判定
            _vHead.setFromMatrixPosition(a.matrixWorld);
            _vLimb.setFromMatrixPosition(b2.matrixWorld).sub(_vHead);
            const l = _vLimb.length();
            if (l < 1e-6) return 0;
            _vLimb.divideScalar(l);
            return (_vLimb.x * _vFwd.x + _vLimb.y * _vFwd.y + _vLimb.z * _vFwd.z) - ref;
        };
        const s0 = swing(0), s1 = swing(1), s2 = swing(2), s3 = swing(3);
        _limbSwing[0] = s0; _limbSwing[1] = s1; _limbSwing[2] = s2; _limbSwing[3] = s3;
        const legRaw = Math.max(s0, s1);
        const armRaw = Math.max(s2, s3);
        /* 包络自标定 + 归一到 0..1（见 `_limbMin` 的长注释）。
         * 快落慢升：min 下落时立刻跟随、回升时按 ~1.5 /s 缓慢放松；max 反之。 */
        const normLimb = (v: number, j: number): number => {
            const k = Math.min(1, d * 1.5);
            if (v < _limbMin[j]) _limbMin[j] = v; else _limbMin[j] += (v - _limbMin[j]) * k;
            if (v > _limbMax[j]) _limbMax[j] = v; else _limbMax[j] += (v - _limbMax[j]) * k;
            const span = _limbMax[j] - _limbMin[j];
            if (!(span > 1e-3)) return 0;
            const t = (v - _limbMin[j]) / span;
            return t < 0 ? 0 : t > 1 ? 1 : t;
        };
        const rLeg = normLimb(legRaw, 0);
        const rArm = normLimb(armRaw, 1);
        rLegSaved = rLeg; rArmSaved = rArm;
        if (driveLead > 0) {
            /* ★★ 相位超前（用户 m12822）：`量 = x + τ·dx/dt`，一阶预测下一小段时间的摆幅。
             *  腿/臂的摆幅是 30 fps 采样、dt 会抖，所以变化率先过一阶低通（12 /s）再乘超前秒数。
             *  最后 clamp 到 [0,1]：**下限 0 是产品定义**——前襟只允许「原地 ↔ 向前」，
             *  超前项哪怕算出负值也不许把布片推到身后。 */
            if (!rig.drivePrevInit) {
                _drivePrev[0] = rLeg; _drivePrev[1] = rArm;
                _driveRate[0] = 0; _driveRate[1] = 0;
                rig.drivePrevInit = true;
            }
            const k = Math.min(1, d * 12);
            const inv = 1 / Math.max(d, 1e-4);
            _driveRate[0] += ((rLeg - _drivePrev[0]) * inv - _driveRate[0]) * k;
            _driveRate[1] += ((rArm - _drivePrev[1]) * inv - _driveRate[1]) * k;
            _drivePrev[0] = rLeg; _drivePrev[1] = rArm;
            legFwd = Math.max(0, Math.min(1, rLeg + driveLead * _driveRate[0]));
            armFwd = Math.max(0, Math.min(1, rArm + driveLead * _driveRate[1]));
        } else {
            legFwd = rLeg;
            armFwd = rArm;
        }
    }
    rig.driveFwd = legFwd;
    rig.driveArm = armFwd;
    rig.driveRaw = driveAmp > 0 ? rLegSaved : 0;
    rig.driveArmRaw = driveAmp > 0 ? rArmSaved : 0;
    rig.driveN = 0;
    rig.repelHits = 0;
    rig.repelMax = 0;
    // ③ 第一帧吸附（否则从 (0,0,0) 甩过来）
    if (!rig.primed) {
        for (let i = 0; i < n; i++) {
            const b = bones[i];
            _vHead.setFromMatrixPosition(b.matrixWorld);
            particle[i * 3] = _vHead.x; particle[i * 3 + 1] = _vHead.y; particle[i * 3 + 2] = _vHead.z;
            particlePrev[i * 3] = _vHead.x; particlePrev[i * 3 + 1] = _vHead.y; particlePrev[i * 3 + 2] = _vHead.z;
        }
        rig.primed = true;
        if (rig.collide) initColliders(rig);   // ★ 只在这里初始化一次（后面的碰撞体世界表示每帧刷新）
        if (rig.repelD > 0) rebuildRepel(rig); // ★ 布-布斥力邻接表（世界矩阵此时才可靠）
        rig.devDeg = rig.meanDevDeg = 0;
        return;
    }
    // ④ ★ 碰撞体的世界表示每帧刷新一次（挂在骨头上，跟着动画走）
    if (rig.collide) stepColliders(rig);
    /* ★ t16 回归补回：布-布斥力邻接表按 `repelEvery` 周期重建。
     *  踩过：整条语句在移植时丢了，只剩第一帧那次 `rebuildRepel`（见上面 primed 分支）
     *  ⇒ `repelNext` 永不递减、邻接表只按绑定姿势建一次；缺省 `?secrepel=0` 看不出来，
     *  但开关一开就是坏的。`?secrepel=1` 下 `repelCount` 随时间变化是这个修复的判据。 */
    if (rig.repelD > 0 && rig.repelReady && --rig.repelNext <= 0) rebuildRepel(rig);

    let maxDev = 0, sumDev = 0, cnt = 0;

    for (let i = 0; i < n; i++) {
        const b = bones[i];
        const parent = b.parent;
        if (!parent) continue;
        const L = restLen[i];
        /* ★★★ 第四十四轮：**头发回「纯动画姿态」（= 步态第五版 / V3 存档）**────────────
         *  用户 m11672「你先把头发回滚V3」→ m11683「其实就是 公用区\哥伦比娅步态复刻_第五版
         *  这里面的头发姿态」。那套里只有 10 个 .vmd，没有任何源码 ⇒「第五版头发姿态」
         *  = **纯 VMD 关键帧**；V3 源码里对应的是 `antiHair ?? false` 时
         *  `if (!antiHair && /Hair|髪|髪2/.test(bones[i].name)) continue;`（默认跳过全部头发骨）。
         *  当前版本没有传 `antiHair`，头发一直在被弹簧 / 落脚脉冲 / 底限解算 ⇒ 与第五版不同。
         *
         *  做法：在热循环**最前面早退**，完全不碰 `b.quaternion` ⇒ 骨头保持动画混出来的姿态。
         *  ⚠️ 只早退不够：`particle`（解算器内部点）会冻结在绑定姿势，把 `auditHairClash`
         *     / `hairClash` 读数带偏（量具失效最容易骗自己）⇒ 顺手按**动画矩阵**把它同步成
         *     骨尾世界位置，探针仍可信。
         *  ⚠️ `matGroup===1` 就是头发（见 `:1804` 的 `/Hair|髪/` 分类）。
         *  回滚：`?hairsolve=1`（缺省 0 = 纯动画）。
         */
        if (rig.hairSolveOff === 1 && matGroup[i] === 1) {
            // Raise only the low end of the original animation. World-space length includes mesh scale.
            // Above the floor the original quaternion remains untouched; hairflooranim=0 restores V4.
            const hairMinY = rig.hairFloorAnim;
            if (hairMinY > 0 && gaitW > 1e-4) {
                b.updateWorldMatrix(true, false);
                _vHead.setFromMatrixPosition(b.matrixWorld);
                const hairFloorDir = new THREE.Vector3(restDirLocal[i * 3], restDirLocal[i * 3 + 1], restDirLocal[i * 3 + 2])
                    .multiplyScalar(L).applyMatrix4(b.matrixWorld).sub(_vHead);
                const hairActualLength = hairFloorDir.length();
                if (hairActualLength > 1e-6 && _vHead.y + hairFloorDir.y < hairMinY) {
                    const hairTargetVertical = Math.min(0.98, (hairMinY - _vHead.y) / hairActualLength);
                    const hairRaisedDir = hairFloorDir.clone().normalize();
                    const hairHorizontal = Math.hypot(hairRaisedDir.x, hairRaisedDir.z);
                    if (hairHorizontal > 1e-6) {
                        const hairHorizontalScale = Math.sqrt(1 - hairTargetVertical * hairTargetVertical) / hairHorizontal;
                        hairRaisedDir.set(hairRaisedDir.x * hairHorizontalScale, hairTargetVertical, hairRaisedDir.z * hairHorizontalScale);
                        const hairRaiseRotation = new THREE.Quaternion().setFromUnitVectors(hairFloorDir.normalize(), hairRaisedDir);
                        hairRaiseRotation.slerp(new THREE.Quaternion(), 1 - gaitW);
                        const hairParentRotation = parent.getWorldQuaternion(new THREE.Quaternion());
                        b.quaternion.premultiply(hairParentRotation.clone().invert().multiply(hairRaiseRotation).multiply(hairParentRotation));
                        b.updateWorldMatrix(false, true);
                    }
                }
            }
            _vHead.setFromMatrixPosition(b.matrixWorld);
            _mRot.extractRotation(b.matrixWorld);
            _qW.setFromRotationMatrix(_mRot);
            _vDir.set(restDirLocal[i * 3], restDirLocal[i * 3 + 1], restDirLocal[i * 3 + 2])
                .applyQuaternion(_qW).normalize();
            particle[i * 3] = _vHead.x + _vDir.x * L;
            particle[i * 3 + 1] = _vHead.y + _vDir.y * L;
            particle[i * 3 + 2] = _vHead.z + _vDir.z * L;
            particlePrev[i * 3] = _vHead.x;
            particlePrev[i * 3 + 1] = _vHead.y;
            particlePrev[i * 3 + 2] = _vHead.z;
            rig.hairAnimOnly++;
            continue;
        }
        // 父骨的世界原点 + 世界朝向（父骨若也是物理骨，上一轮已经更新过它的矩阵）

        _mRot.extractRotation(parent.matrixWorld);
        _qParent.setFromRotationMatrix(_mRot);
        _vHead.setFromMatrixPosition(parent.matrixWorld);

        // 静止方向 = 父骨**当前**朝向 × 局部方向
        _vRest.set(restDirLocal[i * 3], restDirLocal[i * 3 + 1], restDirLocal[i * 3 + 2])
            .applyQuaternion(_qParent).normalize();
        /* ★ t16：把「动画姿势的静止方向」原样留一份，作为侧摆/外撑的**基准**。
         *  后面 drive/flare/side 都会改 `_vRest`，只有这里才是未被我们动过的值。
         *  `measureSleevePose()` 用 restDirWorld − animDirWorld 算「我们挪了多少」。 */
        {
            const ad = i * 3;
            rig.animDirWorld[ad] = _vRest.x;
            rig.animDirWorld[ad + 1] = _vRest.y;
            rig.animDirWorld[ad + 2] = _vRest.z;
            /* ★ 十四轮：本帧侧摆基准先清零（只有真走侧摆通道的骨才在下面写它）。
             *  清零放这里而不是每帧 `fill(0)`：与 `animDirWorld` 同处，省一次全数组遍历。 */
            rig.sideBaseDir[ad] = 0;
            rig.sideBaseDir[ad + 1] = 0;
            rig.sideBaseDir[ad + 2] = 0;
            /* ★ 落脚脉冲同样每帧先清零（见 `landBaseDir` 的注释）。 */
            rig.landBaseDir[ad] = 0;
            rig.landBaseDir[ad + 1] = 0;
            rig.landBaseDir[ad + 2] = 0;
            /* ★★★ 第二十一轮：整片布 / thigh 两个基准**必须**同样每帧清零。
             *  ❗️ 第十九轮就是漏了这两行 ⇒ 基准只写不清 ⇒ 写回段「非 0 就左乘增量」
             *     每帧都拿旧基准叠一个增量 ⇒ 偏离单调累积：
             *       走路时驱动每帧变 ⇒「到处乱飘」；
             *       站定时驱动归 0、旋转块被跳过（基准不再刷新）⇒ 仍继续叠同一个增量
             *       ⇒ 锁死一个方向、越拧越紧 =「走完了停下拧成一团」。
             *     A/B 铁证（`_tools/stopdrift2.js`）：坏版停下 `dev 126→153°` 不回落、
             *     下摆 `lowY` 被兜到 0.528 m；好版 `12.2→8.4°`、0.133 m。
             *  ⚠️ 这两行与 `sideBaseDir`/`landBaseDir` 是同一个规矩，以后加同类通道照抄。 */
            rig.pieceBaseDir[ad] = 0;
            rig.pieceBaseDir[ad + 1] = 0;
            rig.pieceBaseDir[ad + 2] = 0;
            rig.thighBaseDir[ad] = 0;
            rig.thighBaseDir[ad + 1] = 0;
            rig.thighBaseDir[ad + 2] = 0;
            /* ★ 第二十二轮：披肩整片通道的基准同样每帧清零（同一条硬规矩）。 */
            rig.shawlBaseDir[ad] = 0;
            rig.shawlBaseDir[ad + 1] = 0;
            rig.shawlBaseDir[ad + 2] = 0;
            /* ── ★★★ 第二十轮备忘：「带 `BaseDir` 的通道必须每帧清零」是硬规矩 ──────
             *  第十九轮新加的那两个基准数组**只写不清零**，而写回段是
             *  `if (任一分量 != 0) { 用「基准 → 当前方向」的增量四元数左乘到 _qW }`
             *  ⇒ 基准永远非 0 ⇒ 每帧叠一个增量 ⇒ 偏离单调累积。
             *
             *  症状（用户原话）：「走路时到处乱飘，走完了停下拧成一团」。
             *    走路时驱动量每帧变 ⇒ 每帧叠新增量；站定时驱动量归 0、旋转块被跳过
             *    （基准不再刷新），但写回段仍看到旧基准 ⇒ 继续叠同一个增量 ⇒ 越拧越紧。
             *
             *  A/B 铁证（`_tools/stopdrift2.js`：走 3 s → `setAutoWalk(0)` → 再采 8 s）：
             *    坏版：`walkDev 58.9°`、停下 `dev 126 → 153°` 不回落、下摆 `lowY` 被兜到 0.528 m
             *    好版：`dev 12.2° → 8.4°`、`lowY 0.133 m`
             *
             *  ⚠️ 那两条通道已随本轮回滚删除，所以这里没有要清的数组；**以后再加同类通道，
             *     清零必须和 `sideBaseDir`/`landBaseDir` 一起写在这里**，不许省。
             */
        }

        /* ── ★★ 肢体驱动的「向前摆」（用户 m12638 / m12655）─────────────────────
         *  把弹簧目标方向 `_vRest` 绕**侧向轴**向前压 `driveAmp × 量` 弧度。
         *  ★ 为什么改 `_vRest` 就够了：它同时是①回正弹簧的目标 ②限角基准
         *    ③方向性约束的基准 ⇒ 压它 = 「这段布的静止位置自己向前挪了」，
         *    于是弹簧真的把布片推向前，而不是只放宽一个上限。
         *  ★ 符号：侧向轴 = up × fwd；绕它正向旋转会把朝下的方向转**向后**，
         *    所以向前要用负角。漂移量已由 `?secdrive=` 现场标定。
         */
        if (driveAmp > 0) {
            const ds = driveSel[i];
            if (ds === 2 && legFwd > 1e-4) {
                _qDrive.setFromAxisAngle(_vSide, -driveAmp * legFwd);
                _vRest.applyQuaternion(_qDrive).normalize();
                rig.driveN++;
            } else if (ds === 1 && armFwd > 1e-4) {
                _qDrive.setFromAxisAngle(_vSide, -driveAmp * armFwd);
                _vRest.applyQuaternion(_qDrive).normalize();
                rig.driveN++;
            }
        }


        /* ── ★★ 袖子向外撑开（用户 2026-10-21 反馈1，`?secflare=`）─────────────
         *  把静止目标 `_vRest` 再朝「身体外侧」偏 `flareAmp × 撑开量` 弧度。
         *  与上一段肢体驱动的分工：驱动是**前后**，外撑是**侧向**。
         *  逐骨系数：
         *    ① 相位 `phaseG` —— 胳膊在前后摆的哪个位置（摆满到前端时最需要躲开前襟）；
         *    ② 贴体风险 `riskG` —— 袖骨离体轴的水平距离 `ol` 越小越危险（越贴身越要撑）；
         *    ③ 只对袖骨（`driveSel===1`）；其余布片一律不动，避免整条裙子被吹胀。
         */
        if (flareAmp > 0 && flareAmt > 0 && driveSel[i] === 1) {
            const hx0 = _vHead.x, hz0 = _vHead.z;
            _vOut.set(hx0 - _vRootPos.x, 0, hz0 - _vRootPos.z);
            const ol = Math.hypot(_vOut.x, _vOut.z);
            if (ol > 1e-4) {
                const phaseG = Math.min(1, Math.max(0.55, 0.5 + armFwd * 0.9));
                const rk = Math.min(1, Math.max(0, (0.42 - ol) / 0.14));
                const riskG = 0.4 + 0.6 * rk;
                const amt = flareAmt * phaseG * riskG;
                const s = Math.sin(flareAmp * amt) / ol;
                _vRest.x += _vOut.x * s;
                _vRest.z += _vOut.z * s;
                _vRest.normalize();
                rig.flareN++;
                flareDegSum += flareAmp * amt;   // flareAmp 已是弧度，见 sideDegSum 注释
                flarePhSum += phaseG;
                flareRkSum += riskG;
                flareOlSum += ol;
                if (ol > flareOlMax) flareOlMax = ol;
            }
        }

        /* ── ★★★ 袖子侧向摆动（用户 m18305，`?secside=`）─────────────────────
         *  用户原话：「袖子的摆动方向是向两侧，人物走起来以后，袖子是向两侧飘而不是前后」。
         *  做法：绕**角色侧向轴**（`_vSide`）把静止目标朝外荡 `sideAmp × w` 弧度，符号按该骨左右侧。
         *  ★ 为什么绕前后轴：绕前后轴旋转 = 在世界侧向上张开，正好是「向两侧飘」；
         *    旧的前后摆是绕**侧向轴**转，那才会把袖子甩到身前身后撞衣服。
         *  ★ `sideKill`：侧向摆的同时把 `_vRest` 里的**前后分量压掉** `sideKill` 比例，
         *    让袖子的主方向真正从「前后」翻到「侧向」，而不是两种摆叠加。
         *  ★ 闸门含 `parentIdx[i] >= 0`：没有父骨的粒子没有有意义的静止方向，
         *    写它会算出 NaN 并蔓延整片布（踩过）。
         */
        if (_hasSide && parentIdx[i] >= 0 && sideSel[i] === 1 && sideSel[i] >= 0) {
            /* ★★★ t16 重写（队长 t10 根因）：`w` **不再乘速度标量**。
             *  旧写法 `w = sideAmt × roll` 有两个致命处：
             *    ① `sideAmt` 是水平速度的**标量**（`hypot(vx,vz)`），不带方向 ⇒ 朝 +X 走
             *       与朝 +Z 走拿到同一个数 ⇒ 袖子姿态与走向无关（t10 实测 Z 走向
             *       `sleeve.x=0.21107`、X 走向 `0.19741`，差仅 6%，且 X 走向反而更贴衣服
             *       `under1=2` / `minDist=0.006`）。
             *    ② 它还乘了臂摆相位 `roll`，真实步态下 `roll` 来自标量兜底、峰值到不了 1
             *       ⇒ DevStamp 自报「净外移 0.15°」，而设定值是 26°。两个数必须分开报。
             *  现在的语义与用户原话一致：**「走起来袖子恒定向两侧张开」**——
             *    `walking` 只当开关（`sideAmt` 已是 0..1 的速度归一量），不再当幅度；
             *    幅度 = `sideStandK + (1-sideStandK)·sideAmt` ⇒ 走起来满幅、站定仍开 55%。
             *  这样姿态只由**几何**（`sideLocal` 侧向轴）决定，与走向无关。
             *  限角余量见构建期 `limit[i]` 的袖骨放行（`?secsidestand` 调静态份额）。 */
            const walking = sideAmt > 0.05 ? 1 : 0;
            const w = sideStandK + (1 - sideStandK) * sideAmt * walking;
            if (w > 1e-4) {
                /* 先压前后的分量：把 `_vRest` 在前后轴上的投影按 sideKill 缩掉。
                 * 压完必须重新归一，否则 `setFromAxisAngle` 之外还会让限角基准变短。 */
                if (sideKill > 0) {
                    const fd0 = _vRest.x * _vFwd.x + _vRest.y * _vFwd.y + _vRest.z * _vFwd.z;
                    _vRest.x -= _vFwd.x * fd0 * sideKill;
                    _vRest.y -= _vFwd.y * fd0 * sideKill;
                    _vRest.z -= _vFwd.z * fd0 * sideKill;
                    const rl0 = _vRest.length();
                    if (rl0 > 1e-6) _vRest.divideScalar(rl0);
                }
                /* ★★★ t16：**直接把静止目标朝外侧压**，不再绕任何轴转。
                 *
                 *  两次失败的过程（都实测过，别走回头路）：
                 *    ① 绕**前后轴** `_vFwdFlat` 转 ⇒ 在竖直平面里前后甩，侧向纹丝不动：
                 *       `sideN=6`、`sideDeg=26` 都在报，但 `pose.backDeg` 与 `?secside=-1`
                 *       完全相同（20.59）—— 这条通道当时对袖子**零贡献**；
                 *    ② 绕**侧向轴** `_vSide` 转 ⇒ 只在前后方向起作用（实测 `fwdDeg` 从
                 *       5.29 涨到 26.47，`sideDeg` 仍是 -0.21）—— 因为袖骨本来就近竖直，
                 *       绕侧向轴转的位移几乎全落在前后轴上。
                 *  根因：用户的诉求是「袖子**离开身体**朝两侧张开」，这是**位置**方向，
                 *  不是某个转轴。旋转只能在同一平面里换方向，没法把下垂的袖片抬向侧面。
                 *  所以这里按几何直接加：把 `_vRest` 的水平分量朝「从躯干指向该袖骨」的
                 *  方向推 `sideAmp × w` 弧度对应的量（`sin` 换算成轴向位移再归一），
                 *  与 `?secflare=` 同一套做法，只是方向取自**该臂自己的外法向**。 */
                const sx0 = _vHead.x - _vRootPos.x, sz0 = _vHead.z - _vRootPos.z;
                const ol0 = Math.hypot(sx0, sz0);
                if (ol0 > 1e-4) {
                    /* ★ t16 末调：袖片小臂段贴着裙摆上沿（`Bone_ArmLets0x_*` ↔ `Skirt_*`），
                     *  实测 `push` 满幅时 under1=1~2。几何原因：小臂骨离躯干只有 ~0.2 m，
                     *  径向外推先把袖片甩向「斜前/斜后」那侧的裙摆。
                     *  改法：外推方向偏到**纯侧向**（拿掉前后分量），并且只推水平、不抬竖直，
                     *  这样袖片是「贴着身体往两侧平移」，不会扫过前后方的裙摆。 */
                    /* ★★★ t30（队长裁决）：方向必须取**该臂自己的水平外法向** `(sx0, 0, sz0)`。
                     *
                     *  旧写法用「整具角色的一条侧向轴 `_vSide` × axisSign」：
                     *      `_vRest += _vSide * push * sgn0`
                     *  全角色只有两个世界方向，左右袖的**正确外推方向并不共线**
                     *  （躯干中线不一定在两侧袖骨正中间，且两臂姿态各自不同），
                     *  于是必有一片被推向躯干内侧，再被 `normalize()` 与净距约束吃掉。
                     *  实测就是这个症状：左袖 xSide ≈ 0.004（基本没动），右袖 0.278（正常）。
                     *  改成几何法向后左右对称性由几何保证，不再靠 `axisSign` 猜左右。
                     *  `_vSide` 别处仍要用（肢体驱动 / 方向约束），只删本段里的用法。
                     *  推出去的幅度仍是 `sin(sideAmp × w) × hw`（弧度 → 轴向位移，再归一化落到单位球）。 */
                    /* ★ t20 按骨节点高度加权（见 updateSecondary 顶部 `sideHi*` 的注释）：
                     *  袖骨原点越低 ⇒ 越靠近裙摆 ⇒ 推量越小，最低到 `1-sideHiK`。
                     *  `sideHiK=0` 时 hw 恒 1，与 t16 逐位一致（可回滚）。 */
                    let hw = 1;
                    if (sideHiOn) {
                        const hn = Math.min(1, Math.max(0, (_vHead.y - sideHiLo) / (sideHiHi - sideHiLo)));
                        hw = 1 - sideHiK * (1 - hn);
                        rig._sideDbgH = hw;
                        rig._sideDbgHy = _vHead.y;
                    }
                    /* ★★★ 十四轮根因修（用户 m02277「袖子的部位你之前的修改没变化」第二次反馈）：
                     *  这里原来是 `Math.sin(sideAmp * w)`，**数学上存在 45° 硬上限**：
                     *  `push` 是加在**单位**静止方向 `_vRest` 上的垂直分量，之后
                     *  `_vRest.normalize()` —— 加 1 个单位垂直分量再归一化，恰好偏 45°；
                     *  `sin()` 的取值又只在 [0,1] ⇒ 无论 `?secside=` 抬到多高，袖子最多
                     *  只离开原方向 **45°**，而且实际到不了（`w` 走起来才 0.55~1.0，
                     *  `sin(60°×0.55)=0.48` ⇒ 只有 **25.6°**）。
                     *  这就是「方向对了、幅度看着没变」的算术原因：十二轮把 52° 抬到 60°
                     *  只把 sin 从 0.788 抬到 0.866（+10%），视觉上根本看不出。
                     *  改法：用 **`tan()`** —— 要让目标方向偏离原方向 θ 角，垂直分量应取
                     *  `tan(θ)` 而不是 `sin(θ)`（`atan(tan θ)=θ`，可精确命中设定角）。
                     *  θ=60° 时 tan=1.73 ⇒ 偏 60°（原来 sin 只给 40.9°，再乘 w 只剩 25°）。
                     *  上限夹到 1.2 rad（68.8°）：`w` 是 0..1 的速度调制，理论上到不了，
                     *  夹一下防止将来改 `?secside=` 或 `sideStandK` 时把袖子甩穿身体。
                     *  回归安全：`?secside=-1` ⇒ `sideAmp=0` ⇒ 整块不执行，逐位不变。 */
                    /* ★★★ 十七轮（用户 m12388）：侧展角随摆臂**往复**。
                     *  基准角仍是 `sideAmp × w`（十六轮定标 8° 的静态份额），
                     *  再叠 `sideOscAmp × 该侧摆臂相位`（±1 ⇒ ±2°），得到 8°→10°→8° 的呼吸。
                     *  相位 `sideOscPh[side]` 已在上面按侧算好（左右反相）。
                     *  `sideOscAmp = 0` 或该骨认不出左右 ⇒ `oscK = 1` ⇒ 与十六轮逐位一致。 */
                    let oscK = 1;
                    if (sideOscAmp > 0) {
                        const sd0 = sideOf[i];
                        if (sd0 < 2) {
                            /* 呼吸量 `breathe = (1+swing)/2 ∈ [0,1]`：两侧同相，
                             *  swing=−1 ⇒ 8°（基准），swing=+1 ⇒ 8°+2°=10°。 */
                            const breathe = 0.5 * (1 + sideOscPh[sd0]);
                            const base0 = sideAmp * w;
                            const eff0 = base0 + sideOscAmp * w * breathe;
                            oscK = base0 > 1e-6 ? eff0 / base0 : 1;
                            if (oscK < 0.2) oscK = 0.2; else if (oscK > 2.5) oscK = 2.5;
                            rig.sideOscN++;
                        }
                    }
                    const push = Math.tan(Math.min(1.2, sideAmp * w * oscK)) * hw;
                    /* `ol0 > 1e-4` 的守卫在上面，这里直接用倒数 */
                    const inv0 = 1 / ol0;
                    /* ★★★ t30 第二版：外法向里**不许有前后分量**。
                     *
                     *  上面那版直接拿 `(sx0, 0, sz0)` 归一化。问题在于 `sz0` 的来源：
                     *  `_vRootPos` 是**骨架树最顶端**（`createSecondaryMotion` 里
                     *  `while (root && root.parent) root = root.parent;`）的世界位置，
                     *  实测 (0, 0.2507, −10.000)，不是躯干轴线；而袖骨原点在 −10.006，
                     *  于是 `sz0 = −0.006` 是网格原点与骨架原点之间的**零点差**，不是几何。
                     *  实测后果（`_logs/sleeve/t30deg.jsonl`，`?seclock=1.6&secvelz=1.446`）：
                     *  左袖 `finL` 随 `?secside` 一起涨（26°: 0.314 → 40°: 0.414 → 52°: 0.476），
                     *  比值卡在 0.69 / 0.86 / 1.00 —— 推到侧面的量被这个前后分量泄掉了；
                     *  右袖同一扫描是 1.40 / 2.72 / 4.04，两侧差 4 倍，纯属零点差符号不同。
                     *  用户原话是「袖子的摆动方向向两侧，**不随手臂前后**」，所以这里把
                     *  `z` 分量整个去掉，只推 `x`，方向取该袖片自己的 `sign(sx0)`。
                     *  几何上 `左腕` 在 x=+0.0891、`右腕` 在 x=−0.0891（实测），两片袖骨
                     *  `sx0` 分别 +0.089/+0.149 与 −0.089/−0.149，所以 `sign(sx0)` 就是
                     *  各自的朝外方向，左右对称由几何保证，不靠 `axisSign` 猜。
                     *  `sz0` 仍参与上面的 `ol0`（只当"离中轴多远"的尺度用）。 */
                    /* ★★★ 十三轮根因修（用户 m02277：袖子仍前后飘）：
                     *  上面 t30 版沿**世界 X** 推（`_vRest.x += sideSign*push`）。
                     *  那在「角色朝 ±Z」时恰好是侧向 —— t30 当时就是用
                     *  `?secvelz=1.446`（沿 Z 走）实测调的参，所以看着对。
                     *  但角色**沿 ±X 走**时，世界 X 就是**前后轴** ⇒ 推量全落进 fwdDeg：
                     *  `_logs/spec-sleeve-r13a.json`（`?secvelx=1.446&secside=60`）实测
                     *  `sideDeg=-4.4 / fwdDeg=50.67 / backDeg=42.92`——侧摆通道实际在前后摆。
                     *  这也解释了十二轮把缺省从 52° 抬到 60° 用户「没变化」：
                     *  抬的是**错方向**上的幅度。
                     *  改法：推量沿**角色自己的侧向轴 `_vSide`**（水平分量），符号取
                     *  该袖骨在 `_vSide` 上的投影符号 —— 与朝向无关，怎么走都是向两侧。
                     *  t30 的教训这里仍然成立：不用 `(sx0,0,sz0)` 整向量（rootPos 的
                     *  零点差会泄进方向），只取**投影的符号**定左右，方向本体是纯 `_vSide`。
                     *  回归安全性：朝 ±Z 时 `_vSide`≈±X ⇒ 与 t30 旧行为逐位一致
                     *  （`?secvelz=` 探针读数不变）；朝 ±X 时 sideDeg 升、fwdDeg 降。 */
                    const sLat = sx0 * _vSide.x + sz0 * _vSide.z;
                    const sideSign = sLat >= 0 ? 1 : -1;
                    /* ★★★ 十四轮二次根因修：推之前先把「未侧摆的目标方向」存下来。
                     *  只推 `_vRest` 是不够的 —— 它是弹簧目标+限角基准+写回基准，
                     *  粒子会跟着收敛，最后 `_vDir≈_vRest`，骨朝向几乎没动
                     *  （实测袖片像素面积 −0.8%、轮廓宽度 0 px）。写回旋转那一段会用
                     *  这里的 `sideBaseDir` 与最终 `restDirWorld` 算出一个**侧摆增量
                     *  四元数**，在弹簧/限角/碰撞**之后**叠上去，谁也吃不掉。 */
                    {
                        const bd = i * 3;
                        rig.sideBaseDir[bd] = _vRest.x;
                        rig.sideBaseDir[bd + 1] = _vRest.y;
                        rig.sideBaseDir[bd + 2] = _vRest.z;
                    }
                    _vRest.x += _vSide.x * sideSign * push;
                    _vRest.y += 0;
                    _vRest.z += _vSide.z * sideSign * push;
                    _vRest.normalize();
                    rig.sideN++;
                    sideDegSum += sideAmp * w;
                    rig._sideDbgW = w; rig._sideDbgRoll = sideAmt;
                    rig._sideDbgAmt = sideAmt; rig._sideDbgSd = sideSel[i];
                }
            }
        }
        /* ── ★★★ 裙摆下摆：①少吃苦风 ②略微向前垂（用户 m11430 任务3）──────────
         *  `hHem` = 高度权重（最底 1 → 窗口上界 0）× 走起来程度（站定 0）。
         *  ① 风力折减在下面 Verlet 的 `wf` 里生效（`wind` 是吹向身后的，下摆被它
         *     吹得最远 —— 实测静止 −0.24 m → 走路 −0.48 m，这一半就是回退的目标）。
         *  ② 前倾直接压 `_vRest`（与 `?secdrive=` 同一套机理：压弹簧目标 = 布片
         *     自己的静止位置往前挪了，弹簧真的把它推过去）。符号：绕侧向轴**负角**
         *     = 向前（见 drive 那段的说明）。幅度 4°，远小于裙骨限角 22°，
         *     不会被 limit 吃掉 —— 这也是这里敢直接改 `_vRest` 的理由。
         *  ⚠️ 必须写在 `restDirWorld` 落盘**之前**：那个数组是 `measureSleevePose()`
         *     与写回增量的基准，漏记会让「我们挪了多少」少算这段前倾。 */
        let hHem = 0;
        if (hemAmt > 0 && hemWgt[i] > 0.01) {
            hHem = hemWgt[i] * hemAmt;
            if (hemFwdAmp > 0) {
                _qDrive.setFromAxisAngle(_vSide, -hemFwdAmp * hHem);
                _vRest.applyQuaternion(_qDrive).normalize();
            }
            rig.hemN++;
            rig.hemW += hHem;
        }

        /* ── ★★★ 第二十一轮：整片布（披风/带）「同向飘」─────────────────────
         *  轴 = **前后轴 `_vFwd`**，不是侧向轴。
         *  ❗️ 第十九轮第一版写成 `_vSide` ⇒ 绕侧向轴转 = 在**竖直平面里前后甩**，
         *     左右两片照样各自反向（实测侧向相关仍 −0.92，和改前 −0.995 一样是「各走各的」）。
         *     绕前后轴转 = 在**世界左右方向**张开：整片骨同角 ⇒ 左右两半**同向**移动。
         *  基准 `pieceBaseDir` 存「本骨进入本段之前的方向」，写回时算增量四元数左乘。 */
        if (pieceAmp > 0 && pieceOsc !== 0 && (pieceSel[i] === 1 || (ribbonSel[i] === 1 && pieceWRib > 0))) {
            /* 带比披风轻一点：它更细更短，同角度会显得太疯（参考视频里约 0.65×）。 */
            /* ★ 第二十九轮：带用 `pieceWRib`（缺省 0 = 回滚步态V3），披风恒 1。 */
            const wPc = pieceSel[i] === 1 ? 1 : pieceWRib;
            const ang = pieceAmp * pieceOsc * wPc;
            if (Math.abs(ang) > 1e-6) {
                const pb = i * 3;
                rig.pieceBaseDir[pb] = _vRest.x;
                rig.pieceBaseDir[pb + 1] = _vRest.y;
                rig.pieceBaseDir[pb + 2] = _vRest.z;
                _qPiece.setFromAxisAngle(_vFwd, ang);
                _vRest.applyQuaternion(_qPiece).normalize();
                rig.pieceN++;
                rig.pieceDegNow += ang;
            }
        }

        /* ── ★★★ 第二十二轮：披肩（编号4）**整片一起摆** ──────────────────────
         *  绕前后轴 `_vFwd` 转同一个角，**没有任何高度/径向权重**。
         *  这正是用户要的「这布料是一个整体，不是上面不动下面往前动」：
         *  旧路上披肩被当成袖骨、吃 `hw = 1 − sideHiK(1 − hn)` 的高度减推，
         *  上段只推 45% ⇒ 看起来"上面不动下面往前"。
         *  与披风/带共用相位（一起朝同一侧），但幅度独立（`shawlAmp`，缺省 5°）。 */
        /* ── ★★★ 第二十八轮：披肩**刚性整片**（编号4「整片一起飘」）──────
         *  病根：MMD 动画自己的披肩骨关键帧就是「下段大、上段几乎不动」
         *  （锁死解算器实测：下段 59°/82°、上段 2.66°/8.62°；骨高×转角 Spearman −0.96）。
         *  所以只靠弹簧 + 逐骨通道**永远**得不到「整片一起转」：每根骨各转各的，
         *  上段被动画按住 ⇒ 用户看到「下半部分飘，上半部分几乎不动」。
         *
         *  做法：整片每根骨都取**站定方向** `holdDir`（同一把尺），再乘**同一个**摆角，
         *  每根骨相对站定的转角就完全相同 ⇒ 视觉上是刚性的一整块在摆。
         *  ⚠️ 必须同时写 `shawlBaseDir = animDirWorld`，让写回段把
         *     「动画方向 → 刚性目标」这个增量**本帧**就应用掉；
         *     只改 `_vRest` 会被弹簧下一帧拉回去（第十四/二十四轮同型坑）。
         *  ⚠️ `holdDir` 全 0 = 还没在站定帧采集过 ⇒ 本通道自动不生效，退回旧行为。 */
        if (shawlRigid > 0 && shawlSel[i] === 1 && shawlOffOk === 1 && shawlRoot >= 0 && shawlRoot !== i) {
            const hr0 = i * 3;
            const ro0 = shawlRoot * 3;
            const ox0 = shawlOff[i * 4], oy0 = shawlOff[i * 4 + 1];
            const oz0 = shawlOff[i * 4 + 2], ow0 = shawlOff[i * 4 + 3];
            /* 目标 = 片根**当前动画方向**，先按站定相对偏移转成本骨该在的方向，
             * 再叠一个整片统一的摆角。
             * ⇒ 每根骨相对片根的姿态是**冻结**的，整片像刚体一样一起摆，
             *   动画自带的「下段大、上段几乎不动」被替换掉。 */
            /* 基准形状 = 第一帧的整片姿态（每骨一份，冻结）。
             * 为什么不跟片根动画走：片根自己也只动 3°，跟它等于整片都不动。
             * 这里直接用冻结形状 + 统一摆角 ⇒ 每骨相对基准的转角**恒等** ⇒ 上下同步。 */
            _vRest.set(shawlBase[hr0], shawlBase[hr0 + 1], shawlBase[hr0 + 2]);
            if (_vRest.lengthSq() < 1e-12) {
                _vRest.set(rig.animDirWorld[ro0], rig.animDirWorld[ro0 + 1], rig.animDirWorld[ro0 + 2]);
                if (Math.abs(ow0) > 1e-6) { _qNet.set(ox0, oy0, oz0, ow0); _vRest.applyQuaternion(_qNet); }
            }
            const angR = shawlRigidAmp * shawlOscR;
            if (Math.abs(angR) > 1e-6) {
                _qPiece.setFromAxisAngle(_vFwd, angR);
                _vRest.applyQuaternion(_qPiece);
            }
            _vRest.normalize();
            rig.shawlN++;
            rig.shawlDegNow += angR;
        }
        if (shawlAmp > 0 && shawlOsc !== 0 && shawlSel[i] === 1) {
            const ang = shawlAmp * shawlOsc;
            if (Math.abs(ang) > 1e-6) {
                const sb = i * 3;
                rig.shawlBaseDir[sb] = _vRest.x;
                rig.shawlBaseDir[sb + 1] = _vRest.y;
                rig.shawlBaseDir[sb + 2] = _vRest.z;
                _qPiece.setFromAxisAngle(_vFwd, ang);
                _vRest.applyQuaternion(_qPiece).normalize();
                rig.shawlN++;
                rig.shawlDegNow += ang;
            }
        }

        /* ── ★★★ 第二十一轮：裙子被大腿顶起来往前飘 ──────────────────────────
         *  只对 `thighSel`（真裙摆、落在 thigh 高度带、位于身体**前侧**）作用：
         *  绕 `_vSide` 转 `−sign·ang`。符号由 `?secthsign=` 定，**必须实测**
         *  （几何约定对朝 −Z 建模的 MMD 骨骼成立，但本模型裙骨朝向要量过才知道）。
         *  驱动量 = 本帧大腿前摆量 `rig.thighAmt`（0..1，已自标定）× 该骨的前侧/高度权重。 */
        if (thighAmp > 0 && thighSel[i] === 1 && rig.thighAmt > 1e-4) {
            const ang = thighAmp * rig.thighAmt * thighWgt[i];
            if (ang > 1e-6) {
                const tb = i * 3;
                rig.thighBaseDir[tb] = _vRest.x;
                rig.thighBaseDir[tb + 1] = _vRest.y;
                rig.thighBaseDir[tb + 2] = _vRest.z;
                _qThigh.setFromAxisAngle(_vSide, -rig.thighSign * ang);
                _vRest.applyQuaternion(_qThigh).normalize();
                rig.thighN++;
                rig.thighDeg += ang;
            }
        }

        /* ── ★★★ 落脚脉冲：把这片布/头发朝「外上方」转开（用户 m07388）─────────
         *  机理（`SecondaryRig.landPulse` 里已证明）：裙摆/头发是**下垂链**，
         *  「整体向上抬」与「向四周张」其实是**同一个旋转** ——
         *  把骨方向从竖直向下朝该骨的**水平径向外侧**转开 θ 角，
         *  竖直分量 cos 变小（= 抬高）、水平分量 sin 变大（= 外扩）。
         *  所以两条包络只需要合成一个角度，不需要分别做升降和张开。
         *
         *  转轴 `_vLandAxis` = up × 径向：绕它正向转 θ，会把「向下」转向「向外」
         *  （右手定则：up=(0,1,0)、径向=(1,0,0) ⇒ 轴=(0,0,−1)，配合下面的负角符号
         *   实测方向正确；符号已用冻结 A/B 的像素差核对过）。
         *
         *  ★ 基准 `landBaseDir` 存「本骨进入本段之前的方向」，写回时用它算增量四元数 ——
         *  只改 `_vRest` 会被回正弹簧/限角/碰撞吃掉（这是十四轮踩过的坑，
         *  见 `sideBaseDir` 的长注释）。
         *  ★ 径向用 `_vHead − _vRootPos` 的**水平**分量：与侧摆同一口径。
         *  `ol < 1e-4`（骨正好在中轴上，例如头顶那根）没有径向 ⇒ 跳过，不猜方向。 */
        /* ★ 第二十二轮：入口条件必须把**头发自己的包络**也算进来。
         *  头发相位比裙摆早 0.25 步 ⇒ 存在「头发已经很扬、但裙摆 landPulse 还接近 0」的时刻，
         *  只判断 `landPulse` 会把头发挡在外面（表现为「头发比裙子晚动」）。 */
        const hairGate = Math.max(rig._hairLiftE || 0, rig._hairSpreadE || 0);
        if (Math.max(landPulse, hairGate) > 0.002
            && (landWgt[i] > 0.01 || (rig.landSpreadWgt && rig.landSpreadWgt[i] > 0.01))) {
            const sxL = _vHead.x - _vRootPos.x, szL = _vHead.z - _vRootPos.z;
            const ol = Math.hypot(sxL, szL);
            if (ol > 1e-4) {
                /* 两条包络分别乘自己的幅度，取较大者作为本帧角度。
                 * ★ 头发额外增益 `landHairK`（缺省 1.35）：参考视频里 `dHair` pp 73.3 px
                 *   是 `dH` pp 46.5 px 的 **1.58×**，而头发骨本来就长（1.27~2.27 m vs
                 *   裙摆 0.61~0.68 m）⇒ 同角度下头发本来会动更多，但实测（30°、索引
                 *   i=160 `Bone_Hair13_L`）只有 `lowY` 的 0.83×，说明头发的径向力臂短
                 *   （发根几乎在中轴上）吃了亏。补一个增益把「头发幅度 ≥ 裙摆」找回来。 */
                /* ★ 第二十六轮 T1-I5：原来是 `const isHairI = /Hair|髪/.test(bones[i].name || '')`，
                 *  写在 `for (let i = 0; i < n; i++)` 热循环里 ⇒ n≈573 时每秒
                 *  约 3.4 万次正则字面量构造 + `.test()`。构建期已有等价的
                 *  `matGroup[i] === 1`（同函数 `:3807` 就在用）。
                 *  ✅ R5 自检（`_tools/u26hairchk2.js`，同一骨表逐骨比对）：
                 *     573 根骨里 hairByName 9 / hairByGroup 9 / both 9 /
                 *     byNameOnly 0 / byGroupOnly 0 ⇒ **完全等价**。
                 *  ⚠️ 第一次比对（`u26hairchk.js`）拿 `skeleton.bones[i]`（742 根）
                 *     对 `matGroup`（573 根）⇒ 下标错位，报出 8 根「Bone_Hair* 被判成
                 *     披风/带」的假结论。量具必须先证明自己读的是同一张表。 */
                const isHairI = matGroup[i] === 1;
                const wG = landWgt[i] * (isHairI ? rig.landHairK : 1);
                /* ★ 外扩用**另一套权重** `landSpreadWgt`（反高度梯度）：抬升转下段、
                 *  外扩转上段。两套权重分工才让「下摆抬高」与「剪影变宽」同时成立
                 *  —— 只用抬升权重时 `maxR` 几乎不动（实测 pp 0.05 m vs 目标 0.29）。 */
                const wS = (rig.landSpreadWgt ? rig.landSpreadWgt[i] : landWgt[i])
                    * (isHairI ? rig.landHairK : 1);
                /* ★★★ 第二十二轮：**头发换成自己的两条包络**。
                 *  用户：「头发的循环实际上和步态**错开几拍**」+「开始走时要**先扬一下**」。
                 *  `_hairLiftE/_hairSpreadE` 的相位 = `sp + rig.hairPh`（缺省 −0.25 步），
                 *  即头发比裙摆**早四分之一步**抬起来 —— 起步那一帧脚还没落、头发已经扬起。
                 *  裙摆仍吃 `_landLiftE/_landSpreadE`（原相位）。两条时间线互不影响。 */
                const envL = isHairI ? rig._hairLiftE : rig._landLiftE;
                const envS = isHairI ? rig._hairSpreadE : rig._landSpreadE;
                /* ★ 第二十二轮：落脚脉冲（含头发）同样乘 gaitW 做起步渐入。 */
                const angL = rig.landLiftAmp * envL * wG * gaitW;
                const angS = rig.landSpreadAmp * envS * wS * gaitW;
                const ang = angL > angS ? angL : angS;
                if (ang > 1e-6) {
                    const bd = i * 3;
                    rig.landBaseDir[bd] = _vRest.x;
                    rig.landBaseDir[bd + 1] = _vRest.y;
                    rig.landBaseDir[bd + 2] = _vRest.z;
                    _vLandRad.set(sxL / ol, 0, szL / ol);
                    /* 轴 = up × 径向 ⇒ 绕它转负角把「向下」转「向外」 */
                    _vLandAxis.set(0, 1, 0).cross(_vLandRad).normalize();
                    _qLand.setFromAxisAngle(_vLandAxis, -ang);
                    _vRest.applyQuaternion(_qLand).normalize();
                    rig.landN++;
                    rig.landDeg += ang;
                }
            }
        }
        /* ── ★★★ 第二十四轮 v3：头发**径向让位**（`?hairsep=`）───────────────
         *  问题（用户 m02740 看背面图发现）：头发明显插进白裙与披风。
         *  实测根因（`_tools/hairradial.js`）：1.0 m 高度处**头发半径 0.230 m、
         *  裙半径 0.227 m** —— 同一空间。`hairClash` 最近 0.3 mm = 已互穿。
         *  `?secrepel=` 试过 4 档无效（按骨棒最短距离推，方向可能是竖直的）。
         *
         *  做法：**只推头发**。目标半径 = 同高度带内布骨**本帧**最大半径 + `hairSep`；
         *  不够就绕「上 × 径向」把自己往外转（与落脚脉冲同一条轴向约定、同一种夹法）。
         *  ⚠️ 布料一根都不动 —— 否则会把裙吹起来，等于用另一个 bug 掩盖这个。
         *  ⚠️ 只改 `_vRest`：与落脚脉冲同一模式。被弹簧吃掉再升级到写回增量（踩过才改）。 */
        if (hairSep > 0 && matGroup[i] === 1) {
            const s0 = hairSepStart[i], e0 = hairSepStart[i + 1];
            if (e0 > s0) {
                const hxS = _vHead.x, hyS = _vHead.y, hzS = _vHead.z;
                const dxS = hxS - _vRootPos.x, dzS = hzS - _vRootPos.z;
                const olS = Math.hypot(dxS, dzS);
                if (olS > 1e-4) {
                    /* ★ 本骨当前半径（骨尾） */
                    const lenS = restLen[i] || 0;
                    const rNow = olS + (dxS / olS) * (_vRest.x * lenS) + (dzS / olS) * (_vRest.z * lenS);
                    /* 邻居里本帧最大的那条（按骨尾半径） */
                    let rWant = -1;
                    for (let k2 = s0; k2 < e0; k2++) {
                        const j2 = hairSepList[k2];
                        const tx = particle[j2 * 3], tz = particle[j2 * 3 + 2];
                        if (!Number.isFinite(tx)) continue;
                        const rj = Math.hypot(tx - _vRootPos.x, tz - _vRootPos.z);
                        if (rj > rWant) rWant = rj;
                    }
                    if (rWant > 0) {
                        const need = rWant + hairSep;
                        if (rNow < need && lenS > 1e-4) {
                            /* 把「径向分量」从 rNow 抬到 need：转 Δ 角，径向分量按 cos 增 */
                            const curC = (rNow - olS) / lenS;             // 当前径向 cos
                            const wantC = Math.min(0.98, (need - olS) / lenS);
                            if (wantC > curC) {
                                const a1 = Math.acos(Math.max(-1, Math.min(1, curC)));
                                const a2 = Math.acos(Math.max(-1, Math.min(1, wantC)));
                                /* ✅ 第三十三轮：符号修正。
                                 *  原代码 `a2 - a1` 恒为负：`acos` 对余弦单调递减，
                                 *  而 `wantC > curC` 是进入本段的前提 ⇒ `a2 < a1` ⇒ `dAng < 0` 恒成立。
                                 *  而下面的门槛是 `if (dAng > 1e-5)` ⇒ **永远不成立**。
                                 *  实测（`_tools/u33sep.js`，第三十三轮）：`?hairsep=0.15` 下
                                 *  `rig\.hairSep=0.15` 但 `hairSepN` 恒 0 、头发骨尾 `tipRMax` 与 `hairsep=0`
                                 *  逐位相同（0.3811）⇒ 通道从未执行。
                                 *  修法：`a1 - a2`（正值 = 需要向外转的角度）。 */
                                let dAng = a1 - a2;
                                const CAP = 35 / DEG;                     // 单帧最多让 35°
                                if (dAng > CAP) dAng = CAP;
                                if (dAng > 1e-5) {
                                    /* ★ 先把「进入本段之前」的方向存进基准，写回时靠它算增量。
                                     *  必须存在改 `_vRest` **之前** —— 存完再改，两者才构成一次旋转。 */
                                    const hb2 = i * 3;
                                    rig.hairBaseDir[hb2] = _vRest.x;
                                    rig.hairBaseDir[hb2 + 1] = _vRest.y;
                                    rig.hairBaseDir[hb2 + 2] = _vRest.z;
                                    _vLandRad.set(dxS / olS, 0, dzS / olS);
                                    _vLandAxis.set(0, 1, 0).cross(_vLandRad).normalize();
                                    _qLand.setFromAxisAngle(_vLandAxis, -dAng);
                                    _vRest.applyQuaternion(_qLand).normalize();
                                    rig.hairSepN++;
                                    rig.hairSepDeg += dAng * DEG;
                                }
                            }
                        }
                    }
                }
            }
        }
        const hx = _vHead.x, hy = _vHead.y, hz = _vHead.z;
        /* ★ t16：把**实际生效**的静止目标方向存下来（世界坐标、单位向量）。
         *  放在这里而不是循环末尾：`_vRest` 在侧摆/外撑/方向约束里都被改过，
         *  这里才是最终值；`L < 1e-6` 的零长骨没有方向，跳过即可。 */
        if (L > 1e-6) {
            const rx3 = i * 3;
            rig.restDirWorld[rx3] = _vRest.x;
            rig.restDirWorld[rx3 + 1] = _vRest.y;
            rig.restDirWorld[rx3 + 2] = _vRest.z;
        }

        // 零长骨（骨头与父骨原点重合）：位移量没有意义，直接跟动画
        if (L < 1e-6) continue;

        // ── Verlet ──
        const px = particle[i * 3], py = particle[i * 3 + 1], pz = particle[i * 3 + 2];
        const ox = particlePrev[i * 3], oy = particlePrev[i * 3 + 1], oz = particlePrev[i * 3 + 2];
        const k = keep[i];
        /* ★★ 前侧布片的风力系数（用户 m14400「走路时前方衣摆依然是向后摆动的」）：
         *   `wind` 造的是**吹向身后**的风 ⇒ 前襟会一直往身体后面贴；而前襟该由
         *   `?secdrive=`（腿前摆）顶着向前。所以只对 `axisSel===0 && axisSign>0`
         *   （绑定姿势下挂在身体前方的那一组）乘 `windFront`（缺省 0 = 不吃风）。
         *   ⚠️ 判据用 `axisSel/axisSign` 而不是 `driveSel` —— 后者只在 `driveAmp>0`
         *   时被填，`?secdrive=0` 时会全零，那样这条修正就悄悄失效了。 */
        /* ★★★ 下摆折风（用户 m11430 任务3「最下摆那部分走路时不要往后飘」）：
         *  在这条系数上再乘 `1 - hHem*(1-windHem)` —— `hHem=0`（非下摆/站定）时
         *  逐位等于原值；`hHem=1` 且 `windHem=0.10` 时只剩 10% 的风 ⇒ 下摆基本垂着。
         *  与上面 `windFront` 是**乘法叠加**：一片布同时属于「前襟」和「最下摆」时
         *  两个折减都吃，这正是想要的（前襟下摆最不该被吹到身后去）。 */
        const wfBase = (axisSel[i] === 0 && axisSign[i] > 0) ? windFront : 1;
        const wf = hHem > 0 ? wfBase * (1 - hHem * (1 - windHem)) : wfBase;
        let fx = px + (px - ox) * k + wx * wf;
        let fy = py + (py - oy) * k - gStep;
        let fz = pz + (pz - oz) * k + wz * wf;

        // ── 朝父骨原点收成单位方向 ──
        let dx = fx - hx, dy = fy - hy, dz = fz - hz;
        let dist = Math.hypot(dx, dy, dz);
        if (dist < 1e-7) { dx = _vRest.x; dy = _vRest.y; dz = _vRest.z; }
        else { dx /= dist; dy /= dist; dz /= dist; }

        // ── 回正弹簧 ──
        const a = 1 - Math.exp(-stiffness[i] * d);
        if (a > 0) {
            dx += (_vRest.x - dx) * a;
            dy += (_vRest.y - dy) * a;
            dz += (_vRest.z - dz) * a;
            const l2 = Math.hypot(dx, dy, dz) || 1;
            dx /= l2; dy /= l2; dz /= l2;
        }

        // ── 限角：相对「动画方向」最多偏 limit ──
        let cosA = dx * _vRest.x + dy * _vRest.y + dz * _vRest.z;
        if (cosA > 1) cosA = 1; else if (cosA < -1) cosA = -1;
        const ang = Math.acos(cosA);
        const dev = ang;
        if (ang > limit[i]) {
            _vAxis.set(
                _vRest.y * dz - _vRest.z * dy,
                _vRest.z * dx - _vRest.x * dz,
                _vRest.x * dy - _vRest.y * dx,
            );
            const al = _vAxis.length();
            if (al > 1e-7) {
                _vAxis.divideScalar(al);
                _vDir.set(_vRest.x, _vRest.y, _vRest.z).applyAxisAngle(_vAxis, limit[i]);
                dx = _vDir.x; dy = _vDir.y; dz = _vDir.z;
            } else {
                dx = _vRest.x; dy = _vRest.y; dz = _vRest.z;
            }
        }

        // ── ★ 碰撞：把骨头的**尾巴**从身体胶囊里推出去，再重新约束骨长 ──
        //   （这是「穿模」的解药：腿扫过来时裙子被顶开，而不是被腿穿过去）
        //
        //   ★★ 判据 R：两点必须都做对，否则碰撞是「写了但没生效」——
        //   ① `colSlack`：允许它停在**静置时本来就有的**那点插深（裙摆贴腿建模），
        //      但只要比静置更深就推出去。旧版是「第一帧碰到 ⇒ 永久屏蔽」，腿扫过来也不顶。
        //   ② 按骨长归一化会把推出的成果吃回去（新尾巴又落回以头为心、半径 L 的球面），
        //      所以这里迭代 `iterations` 次，每次都「推出去 → 拉回骨长」，直到不再穿透。
        if (rig.collide && colN > 0) {
            const base = i * colN;
            // ★★ 骨棒采样：`rodSamples === 1` 时 s 恒为 1（= 只测骨尾 = 旧行为）
            const sMin = rodSamples > 1 ? 0.5 : 1;
            for (let it = 0; it < iterations; it++) {
                let nx = hx + dx * L, ny = hy + dy * L, nz = hz + dz * L;
                // 这一轮里跨「所有碰撞体 × 所有采样点」最深的那一个，只推它
                let bestPen = 0, bestS = 1, bestJ = -1;
                let bestQx = 0, bestQy = 0, bestQz = 0;   // 采样点当前在哪
                let bestTx = 0, bestTy = 0, bestTz = 0;   // 采样点该去的胶囊表面
                for (let j = 0; j < colN; j++) {
                    const R = _cR[j];
                    if (R <= 1e-6) continue;
                    const slack = colSlack[base + j] + 1e-4;
                    const cx = _cWorld[j * 3], cy = _cWorld[j * 3 + 1], cz = _cWorld[j * 3 + 2];
                    const H = _cHalf[j];
                    const ax = _cAxis[j * 3], ay = _cAxis[j * 3 + 1], az = _cAxis[j * 3 + 2];
                    for (let k = 0; k < rodSamples; k++) {
                        /* ★ T1-I6：`_ROD_S[k]` = `k/(rodSamples−1)`（rodSamples===1 时填 1，
                         *  与 sMin=1 相消 ⇒ 逐位等同原式）。原来这行在 it×j×k 最内层重算。 */
                        const s = sMin + (1 - sMin) * _ROD_S[k];
                        const qx = hx + (nx - hx) * s, qy = hy + (ny - hy) * s, qz = hz + (nz - hz) * s;
                        const ex0 = qx - cx, ey0 = qy - cy, ez0 = qz - cz;
                        // 粗筛：整根胶囊的外接球
                        if (ex0 * ex0 + ey0 * ey0 + ez0 * ez0 > (R + H) * (R + H)) continue;
                        let t = H > 0 ? ex0 * ax + ey0 * ay + ez0 * az : 0;
                        if (t > H) t = H; else if (t < -H) t = -H;
                        const ex = ex0 - ax * t, ey = ey0 - ay * t, ez = ez0 - az * t;
                        const dd = Math.hypot(ex, ey, ez);
                        const pen = R - dd;
                        // ★ 比「静置时本来就有的插深」还深，才算被扫到
                        if (pen <= slack) continue;
                        if (pen <= bestPen) continue;
                        bestPen = pen; bestS = s; bestJ = j;
                        bestQx = qx; bestQy = qy; bestQz = qz;
                        if (dd < 1e-6) {
                            // 正好在轴上：沿「动画方向」推出去
                            bestTx = cx + ax * t + _vRest.x * R;
                            bestTy = cy + ay * t + _vRest.y * R;
                            bestTz = cz + az * t + _vRest.z * R;
                        } else {
                            const sc = R / dd;
                            bestTx = cx + ax * t + ex * sc;
                            bestTy = cy + ay * t + ey * sc;
                            bestTz = cz + az * t + ez * sc;
                        }
                    }
                }
                if (bestJ < 0) break;
                // 采样点在 s 处：骨尾移 Δ 会让采样点移 Δ·s ⇒ 要把采样点推出 pen，
                // 骨尾得移 pen/s（`s` 已夹在 ≥ 0.5，`1/s` 最多 2 倍）
                const inv = 1 / Math.max(sMin, bestS);
                let ddx = (bestTx - bestQx) * inv;
                let ddy = (bestTy - bestQy) * inv;
                let ddz = (bestTz - bestQz) * inv;
                // 单轮推动量上界：深插时不要一步炸开（交给后面的迭代慢慢收）
                const dmax = 2 * _cR[bestJ];
                const dl = Math.hypot(ddx, ddy, ddz);
                if (dl > dmax) { const q = dmax / dl; ddx *= q; ddy *= q; ddz *= q; }
                nx += ddx; ny += ddy; nz += ddz;
                // 重新约束到骨长（推出后长度变了），方向也随之一变
                const bx = nx - hx, by = ny - hy, bz = nz - hz;
                const bl = Math.hypot(bx, by, bz);
                if (bl < 1e-7) break;
                const ndx = bx / bl, ndy = by / bl, ndz = bz / bl;
                // 收敛了就停（避免最后一轮做无用的抖动）
                const dotv = ndx * dx + ndy * dy + ndz * dz;
                dx = ndx; dy = ndy; dz = ndz;
                if (dotv > 0.99999) break;
            }
        }

        // ── ★★ 方向性约束（用户 m11933）：悬挂骨只许「离开身体」摆，朝身体最多偏 axisTol ──
        //   放在碰撞**之后**当最后一道：碰撞负责「腿扫过来把裙子顶开」（把前襟向前推 =
        //   用户要的「被腿顶起来向前摆一下」），本约束负责「风和惯性不许把前襟吹到身后」。
        //   两者方向一致，不冲突。
        //   数学：设轴 a（角色前向或侧向）、s = ±1（该轴正方向是否朝「外」）、
        //   fr = 动画方向在 a 上的分量。约束是 s·(dir·a) ≥ s·fr − tol；越界时把 dir
        //   **精确投影**到该半空间的边界球面上（保证 |dir| = 1，不动骨长）。
        //   ★★ 用户 m12638：「袖子一定是跟随着向前摆动的，否则一定穿模」——
        //      胳膊驱动的骨（`driveSel===1`）**整条豁免**本约束，原样跟着胳膊走。
        if (rig.antiOn && driveSel[i] !== 1) {
            const sel = axisSel[i];
            if (sel !== 2) {
                const ax = sel === 0 ? _vFwd.x : _vSide.x;
                const ay = sel === 0 ? _vFwd.y : _vSide.y;
                const az = sel === 0 ? _vFwd.z : _vSide.z;
                const s = axisSign[i];
                const fd = dx * ax + dy * ay + dz * az;
                const fr = _vRest.x * ax + _vRest.y * ay + _vRest.z * az;
                const need = s * fr - axisTol;          // s·(dir·a) 必须 ≥ need
                if (s * fd < need) {
                    let px2 = dx - ax * fd, py2 = dy - ay * fd, pz2 = dz - az * fd;
                    let pl = Math.hypot(px2, py2, pz2);
                    if (pl < 1e-6) {
                        // 当前方向几乎与轴重合：借动画方向的垂直分量定一个平面
                        px2 = _vRest.x - ax * fr; py2 = _vRest.y - ay * fr; pz2 = _vRest.z - az * fr;
                        pl = Math.hypot(px2, py2, pz2);
                        if (pl < 1e-6) { px2 = 0; py2 = -1; pz2 = 0; pl = 1; }
                    }
                    const t = s * need;
                    const tc = t > 1 ? 1 : t < -1 ? -1 : t;
                    const rr = Math.sqrt(Math.max(0, 1 - tc * tc));
                    const bx2 = (px2 / pl) * rr, by2 = (py2 / pl) * rr, bz2 = (pz2 / pl) * rr;
                    const ndx = ax * tc + bx2, ndy = ay * tc + by2, ndz = az * tc + bz2;
                    const nl = Math.hypot(ndx, ndy, ndz) || 1;
                    dx = ndx / nl; dy = ndy / nl; dz = ndz / nl;
                    rig.antiHits++;
                    let c2 = dx * _vRest.x + dy * _vRest.y + dz * _vRest.z;
                    if (c2 > 1) c2 = 1; else if (c2 < -1) c2 = -1;
                    const dev2 = Math.acos(c2) * DEG;
                    if (dev2 > rig.antiMaxDeg) rig.antiMaxDeg = dev2;
                }
            }
        }

        /* ── ★★★ 布-布斥力（`?secrepel=`，用户 m15017）─────────────────────────────
         *  放在「身体碰撞」与「方向性约束」**之后**：它们管的是「别插进身体」，
         *  这一条管的是「布片之间别互相穿过」（长袖叠裙摆、前襟外披片互相叠）。
         *  只和 `j < i` 的邻居比 —— 那些骨头的骨尾本帧已经定稿（`particle[j]` 是
         *  约束后的最终位置），本轮的 `particle[j]` 还是上一帧的值也无所谓（差一帧
         *  只有毫米级）；只推自己这一半，下一帧轮到对方让开。 */
        if (repelD > 0 && rig.repelReady) {
            const rx0 = hx + dx * L, ry0 = hy + dy * L, rz0 = hz + dz * L;
            let ax2 = 0, ay2 = 0, az2 = 0, hit = 0;
            for (let k2 = repelStart[i]; k2 < repelStart[i + 1]; k2++) {
                const j2 = repelList[k2];
                if (j2 >= i) continue;
                const jp = bones[j2]?.parent;
                let jhx = particle[j2 * 3], jhy = particle[j2 * 3 + 1], jhz = particle[j2 * 3 + 2];
                if (jp) { const e = jp.matrixWorld.elements; jhx = e[12]; jhy = e[13]; jhz = e[14]; }
                const jtx = particle[j2 * 3], jty = particle[j2 * 3 + 1], jtz = particle[j2 * 3 + 2];
                // ① 我的骨尾 → 对方骨棒的最近点
                let ux = jtx - jhx, uy = jty - jhy, uz = jtz - jhz;
                const uu = ux * ux + uy * uy + uz * uz;
                let t = uu > 1e-12 ? ((rx0 - jhx) * ux + (ry0 - jhy) * uy + (rz0 - jhz) * uz) / uu : 0;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                let cxp = jhx + ux * t, cyp = jhy + uy * t, czp = jhz + uz * t;
                let ex = rx0 - cxp, ey = ry0 - cyp, ez = rz0 - czp;
                let d2 = ex * ex + ey * ey + ez * ez;
                // ② 对方的骨尾 → 我的骨棒（双向，取更近的那个 —— 与 `auditClash` 同判据）
                ux = rx0 - hx; uy = ry0 - hy; uz = rz0 - hz;
                const uu2 = ux * ux + uy * uy + uz * uz;
                let t2 = uu2 > 1e-12 ? ((jtx - hx) * ux + (jty - hy) * uy + (jtz - hz) * uz) / uu2 : 0;
                t2 = t2 < 0 ? 0 : t2 > 1 ? 1 : t2;
                const cx2 = hx + ux * t2, cy2 = hy + uy * t2, cz2 = hz + uz * t2;
                const fx = jtx - cx2, fy = jty - cy2, fz = jtz - cz2;
                const d22 = fx * fx + fy * fy + fz * fz;
                if (d22 < d2) { d2 = d22; ex = -fx; ey = -fy; ez = -fz; }
                if (d2 >= repelD * repelD || d2 < 1e-12) continue;
                const dd = Math.sqrt(d2);
                const push = ((repelD - dd) * repelW * 0.5) / dd;
                ax2 += ex * push; ay2 += ey * push; az2 += ez * push;
                hit++;
            }
            if (hit > 0) {
                const nx2 = rx0 + ax2, ny2 = ry0 + ay2, nz2 = rz0 + az2;
                const bx2 = nx2 - hx, by2 = ny2 - hy, bz2 = nz2 - hz;
                const bl2 = Math.hypot(bx2, by2, bz2);
                if (bl2 > 1e-7) {
                    dx = bx2 / bl2; dy = by2 / bl2; dz = bz2 / bl2;
                    const pl2 = Math.hypot(ax2, ay2, az2);
                    if (pl2 > rig.repelMax) rig.repelMax = pl2;
                }
                rig.repelHits += hit;
            }
        }

        if (dev > maxDev) maxDev = dev;
        sumDev += dev; cnt++;

        // ── 写回旋转 ──
        //   R 把骨头的「动画方向」转到「物理方向」（世界空间）
        //   骨世界朝向 = R · 父世界朝向 · 动画局部四元数
        /* ── ★★★ 第二十五轮 C：**链一致化**（见 `SecondaryOptions.netCape`）────────────
         *  父先子后 ⇒ 父骨本帧的解算方向 `solDir[parentIdx[i]]` 已经定稿。
         *  把本骨方向朝父骨方向混合 α，然后把**混合后**的方向存进 `solDir[i]` 给子骨用。
         *  α→1 时整条链方向相同 ⇒ 一片布像刚性体整体转（用户要的「是一个整体」），
         *  同时梢部相对根部的乱甩被压掉（用户要的「8 号别飘太大」）。
         *  ⚠️ 必须在 `_qR` 之前：`_qR` 用的是 `dx/dy/dz`，混合要影响它。
         *  ⚠️ α 全 0 时整段不执行 ⇒ 与改动前逐位一致。 */
        {
            const nA = rig.netA[i];
            if (nA > 0) {
                /* ★ 第二十六轮 b：混的是**偏差量**，不是**绝对方向**。
                 *  `patch26a`（改成同片父骨）实测无效（`netN` 仍 66、披肩 `dU0` 仍 +0.0105
                 *  水平）⇒ 混错的不是「哪根父骨」，是「混什么量」：
                 *  父骨的 `solDir` 是**绝对朝向**，而披肩骨挂在手臂父链上，
                 *  手臂动画朝外 ⇒ 父骨绝对朝向本来就水平 ⇒ 整片被拽平并冻住
                 *  = 用户 m03795 说的「4 号飞成翅膀又一动不动」。
                 *  ⇒ 改为共享**相对静止方向的偏差** `dv = solDir[pi] − restDirWorld[pi]`，
                 *  再加到本骨的静止方向上：`target = normalize(restDirWorld[i] + dv)`。
                 *  小偏差下是旋转的一阶近似 ⇒ 整片共享同一偏差 = 真刚体整体转，
                 *  同时**不改变整片绝对朝向** ⇒ 不会被手臂拽平。 */
                const pi = rig.netParent[i];
                if (pi >= 0) {
                    const sd = rig.solDir;
                    const rd = rig.restDirWorld;
                    const bx4 = pi * 3;
                    const qx = sd[bx4], qy = sd[bx4 + 1], qz = sd[bx4 + 2];
                    if (qx !== 0 || qy !== 0 || qz !== 0) {
                        /* ★ 第二十六轮 c：构造**父骨的旋转增量四元数**（静止方向 → 解算方向），
                         *  再把它施加到本骨的静止方向上。这才是「整片共享同一旋转」的定义。
                         *  `patch26b` 的「静止方向 + 偏差向量」只是小角度一阶近似，
                         *  披肩下段实测偏 20°+，加法方向会偏 ⇒ 加大 α 反而更不同步
                         *  （实测 cosLH：net 0 → 0.34、0.7 → 0.15、1 → −0.03）。 */
                        _vNetA.set(rd[bx4], rd[bx4 + 1], rd[bx4 + 2]);
                        const la = _vNetA.length();
                        if (la > 1e-7) {
                            _vNetA.multiplyScalar(1 / la);
                            _vNetB.set(qx, qy, qz).normalize();
                            _qNet.setFromUnitVectors(_vNetA, _vNetB);
                            const si4 = i * 3;
                            _vNetT.set(rd[si4], rd[si4 + 1], rd[si4 + 2]).applyQuaternion(_qNet);
                            const tl = _vNetT.length();
                            if (tl > 1e-7) {
                                const ia = 1 - nA;
                                let mx = dx * ia + (_vNetT.x / tl) * nA;
                                let my = dy * ia + (_vNetT.y / tl) * nA;
                                let mz = dz * ia + (_vNetT.z / tl) * nA;
                                const ml = Math.hypot(mx, my, mz);
                                if (ml > 1e-7) {
                                    dx = mx / ml; dy = my / ml; dz = mz / ml;
                                    rig.netN++;
                                }
                            }
                        }
                    }
                }
            }
            const si3 = i * 3;
            rig.solDir[si3] = dx; rig.solDir[si3 + 1] = dy; rig.solDir[si3 + 2] = dz;
        }
        /* ── ★★★ 第二十五轮 D：**压住飘动**（见 `SecondaryOptions.holdCape`）──────────
         *  朝「站定姿态」方向混合 β：β→1 时布料钉在站立垂落的样子，
         *  动画自带的摆动被压掉（刚度已经压不下去了，实测 1→8 只降 16%）。
         *  ⚠️ 在 `netA`(朝父骨) 之后：两条通道可叠加，顺序不影响各自缺省(0)时的逐位一致。 */
        {
            const hA = rig.holdA[i];
            if (hA > 0 && rig.holdReady) {
                const hd3 = i * 3;
                const gx = rig.holdDir[hd3], gy = rig.holdDir[hd3 + 1], gz = rig.holdDir[hd3 + 2];
                if (gx !== 0 || gy !== 0 || gz !== 0) {
                    const ib = 1 - hA;
                    const mx = dx * ib + gx * hA;
                    const my = dy * ib + gy * hA;
                    const mz = dz * ib + gz * hA;
                    const ml = Math.hypot(mx, my, mz);
                    if (ml > 1e-7) { dx = mx / ml; dy = my / ml; dz = mz / ml; rig.holdN++; }
                }
            }
        }
        /* ── ★★★ 第四十二轮：**头发骨尾世界 Y 底限**（`?hairfloor=`）──────────────
         *  用户 m10457：「头发是走路时落下去才会穿模，你只需要调整落点，抬高即可」。
         *  实测（`_tools/u37ph.js`，按 `stepPhase` 分 10 桶）：`seclandlift` 0/8/20/40
         *  四档在相位 0.0/0.5 两桶的 `tipY` **逐位相同 1.493~1.500** —— 因为
         *  `landLiftAmp` 是高斯脉冲，脉冲之间归零，低点从来没被抬过。
         *  这里给一个**与包络无关的常量底限**：骨尾世界 Y 低于 `hairFloor` 就补抬。
         *  ⚠️ 只改 `_vRest`（与落脚脉冲同一模式），不碰布料；只作用于 `matGroup===1`。
         *  ⚠️ 乘 `gaitW`：站定不生效（站定实测零穿模，见 `_logs/round37/r37geo`）。
         *  ⚠️ 轴 = `up × 径向`（与落脚脉冲同一条）：绕它转会把「向下」转向「向外」，
         *    实测同时带径向位移（`seclandlift=20` 时 `rMax` +83 mm），这正是需要的。
         *  回滚：`?hairfloor=0`（缺省 0）⇒ 整块不进。 */
        if (hairFloor > 0 && matGroup[i] === 1 && gaitW > 1e-4) {
            const gfl = gaitW;
            /* 本骨骨尾当前世界 Y：骨头 + 静止方向 × 骨长（与写回同一口径） */
            const tipY = _vHead.y + _vRest.y * L;
            const need = hairFloor - tipY;
            if (need > 0.001) {
                const sxF = _vHead.x - _vRootPos.x, szF = _vHead.z - _vRootPos.z;
                const olF = Math.hypot(sxF, szF);
                if (olF > 1e-4) {
                    /* 抬到刚好够（不越过底限）：角度 = asin(need / 骨长) */
                    /* ★ 存「施加前方向」，写回时用它补增量（与落脚/侧摆同一套） */
                    const fb = i * 3;
                    rig.floorBaseDir[fb] = _vRest.x;
                    rig.floorBaseDir[fb + 1] = _vRest.y;
                    rig.floorBaseDir[fb + 2] = _vRest.z;
                    const angF = Math.asin(Math.min(1, need / Math.max(1e-3, L))) / gfl;
                    _vLandRad.set(sxF / olF, 0, szF / olF);
                    _vLandAxis.set(0, 1, 0).cross(_vLandRad).normalize();
                    _qLand.setFromAxisAngle(_vLandAxis, -angF);
                    _vRest.applyQuaternion(_qLand).normalize();
                    rig.hairFloorN++;
                    rig.hairFloorDeg += angF * gfl;
                    if (tipY < rig.hairFloorMinY) rig.hairFloorMinY = tipY;
                }
            }
        }
        _vDir.set(dx, dy, dz);
        _qR.setFromUnitVectors(_vRest, _vDir);
        _qW.copy(_qParent).multiply(animLocal[i]).premultiply(_qR);
        /* ★★★ 十四轮二次根因修（用户 m02277「袖子向两侧飘」第四次反馈）：
         *  侧摆的量**必须在这里补上去**。上面的链路是
         *    `R: _vRest → _vDir`（本次求解的偏转）· 父朝向 · 动画局部四元数，
         *  而侧摆只改 `_vRest`；粒子又会收敛到 `_vRest` ⇒ `_vDir ≈ _vRest` ⇒ R ≈ I，
         *  侧摆被完整抵消。实测（`?secside=60` vs `-1`，冻结姿态）袖片主力骨
         *  `Skirt_11_0` 世界方向只差 2.3°，袖片像素面积 −0.8%、轮廓宽度 0 px。
         *  所以把「基准方向 → 侧摆后目标方向」这一段的旋转单独算成 `_qSide`，
         *  在**所有弹簧/限角/碰撞之后**左乘上去 —— 它叠加在最终朝向上，谁也吃不掉。
         *  只对 `sideBaseDir` 非零（本帧真走了侧摆通道）的骨生效；
         *  `?secside=-1` ⇒ 全零 ⇒ 本块整段不执行 ⇒ 与改前逐位一致（可回滚）。 */
        {
            const bd = i * 3;
            const bx = rig.sideBaseDir[bd], by = rig.sideBaseDir[bd + 1], bz = rig.sideBaseDir[bd + 2];
            if (bx !== 0 || by !== 0 || bz !== 0) {
                _vSideBase.set(bx, by, bz).normalize();
                _vSideNow.set(_vRest.x, _vRest.y, _vRest.z).normalize();
                _qSide.setFromUnitVectors(_vSideBase, _vSideNow);
                _qW.premultiply(_qSide);
                rig.sideApplied++;
            }
        }
        /* ★★★ 落脚脉冲的增量同样必须在这里补（用户 m07388）——
         *  与侧摆同一个坑：只改 `_vRest` 会被回正弹簧/限角/碰撞收敛回去。
         *  「基准 `landBaseDir` → 最终 `_vRest`」的旋转左乘到 `_qW` 上，
         *  它叠加在所有约束之后，谁也吃不掉。全 0 = 该骨没走落脚通道 ⇒ 逐位不变。 */
        {
            const lb = i * 3;
            const lx = rig.landBaseDir[lb], ly = rig.landBaseDir[lb + 1], lz = rig.landBaseDir[lb + 2];
            if (lx !== 0 || ly !== 0 || lz !== 0) {
                _vLandBase.set(lx, ly, lz).normalize();
                _vLandNow.set(_vRest.x, _vRest.y, _vRest.z).normalize();
                _qLand.setFromUnitVectors(_vLandBase, _vLandNow);
                _qW.premultiply(_qLand);
                rig.landApplied++;
            }
        }
        /* ★ 第四十二轮：头发底限的增量同样必须在这里补 ——
         *  与侧摆（`_qSide`）/落脚脉冲（`_qLand`）同一个坑：只改 `_vRest` 会被
         *  回正弹簧/限角/碰撞收敛回去，实测「加了参数但头发一点没抬」。
         *  「基准 `floorBaseDir` → 最终 `_vRest`」的旋转左乘到 `_qW` 上。 */
        {
            const fb = i * 3;
            const fx = rig.floorBaseDir[fb], fy = rig.floorBaseDir[fb + 1], fz = rig.floorBaseDir[fb + 2];
            if (fx !== 0 || fy !== 0 || fz !== 0) {
                _vSideBase.set(fx, fy, fz).normalize();
                _vSideNow.set(_vRest.x, _vRest.y, _vRest.z).normalize();
                _qSide.setFromUnitVectors(_vSideBase, _vSideNow);
                _qW.premultiply(_qSide);
                rig.hairFloorApplied++;
            }
        }
        /* ── ★★★ 第二十一轮：整片布 / thigh 的增量四元数左乘 ────────────────
         *  与侧摆/落脚**完全同一个坑**：只改 `_vRest` 会被回正弹簧/限角/碰撞收敛回去。
         *  把「基准 → 最终 `_vRest`」的旋转左乘到 `_qW` 上，它叠加在所有约束之后。
         *  基准全 0 = 该骨本帧没走这条通道 ⇒ 逐位不变。
         *  ⚠️ 正因为这里判「非 0 就叠」，上面**每帧清零**才是必需的（第十九轮的根因）。 */
        {
            const pb2 = i * 3;
            const px = rig.pieceBaseDir[pb2], py = rig.pieceBaseDir[pb2 + 1], pz = rig.pieceBaseDir[pb2 + 2];
            if (px !== 0 || py !== 0 || pz !== 0) {
                _vPieceBase.set(px, py, pz).normalize();
                _vPieceNow.set(_vRest.x, _vRest.y, _vRest.z).normalize();
                _qPiece.setFromUnitVectors(_vPieceBase, _vPieceNow);
                _qW.premultiply(_qPiece);
                rig.pieceApplied++;
            }
        }
        {
            const tb2 = i * 3;
            const tx = rig.thighBaseDir[tb2], ty = rig.thighBaseDir[tb2 + 1], tz = rig.thighBaseDir[tb2 + 2];
            if (tx !== 0 || ty !== 0 || tz !== 0) {
                _vThighBase.set(tx, ty, tz).normalize();
                _vThighNow.set(_vRest.x, _vRest.y, _vRest.z).normalize();
                _qThigh.setFromUnitVectors(_vThighBase, _vThighNow);
                _qW.premultiply(_qThigh);
                rig.thighApplied++;
            }
        }
        /* ★ 第二十二轮：披肩整片通道的写回（同一条规矩：基准非 0 就左乘增量）。 */
        {
            const sb2 = i * 3;
            const sx2 = rig.shawlBaseDir[sb2], sy2 = rig.shawlBaseDir[sb2 + 1], sz2 = rig.shawlBaseDir[sb2 + 2];
            if (sx2 !== 0 || sy2 !== 0 || sz2 !== 0) {
                _vPieceBase.set(sx2, sy2, sz2).normalize();
                _vPieceNow.set(_vRest.x, _vRest.y, _vRest.z).normalize();
                _qPiece.setFromUnitVectors(_vPieceBase, _vPieceNow);
                _qW.premultiply(_qPiece);
                rig.shawlApplied++;
            }
        }
        /* ── ★★★ 第二十九轮：披肩**整片前移**（编号4）───────────────────────
         *  为什么放在这里：前面所有通道改的都是 `_vRest`（下一帧的目标），
         *  弹簧会把它们拉回去；这里改的是**本帧已经定稿的 `_qW`**，
         *  下面紧接着 `b.quaternion = parent⁻¹ · _qW`，所以**一定生效**。
         *  基准取 `_vRest`（本帧定稿的目标方向，与上面四条写回通道同口径），
         *  每根披肩骨转**同一个角** ⇒ 整片一起前移（不是只有尾端）。
         *  目的：走路时让披肩整体甩到大腿最前面之外，避免穿模大腿。
         *  `?secshawlpush=` 0 = 关（缺省），`?secshawlpushsign=` 定方向。
         *  ⚠️ 第一版误用了 `solDir` —— 它是 net 一致化块里的局部 `sd`，此处不在作用域，
         *     运行期抛 `ReferenceError: solDir is not defined`（整段解算被打断）。 */
        /* ★★★ 第三十二轮：**只推片根骨**。
         *  根因：原先对每根披肩骨都施加同一个转角，而 `_qW` 是相对父骨的、
         *  沿骨链累加 —— 链深 3 节的骨实际世界转角 ≈ 3 × 15° = 45°，
         *  越靠链尾越平，`hold` 再把这个摊平的姿态锁死 ⇒ 站定就不垂落了
         *  （实测站定下摆竖直分量 `dirU` 从 0.9927 掉到 0.2617 = 几乎水平）。
         *  现在只对**片根骨**（父骨不属于披肩片）施加：骨链是父子关系，
         *  转根骨 = 整棵子树刚性旋转，才是真正的「整块 4 号布料一起前移」，
         *  不累加、不推平。 */
        const _pPush = parentIdx[i];
        if (shawlPush > 0 && shawlSel[i] === 1 && gaitW > 1e-4
            && !(_pPush >= 0 && shawlSel[_pPush] === 1)) {
            _vNetA.copy(_vRest);
            if (_vNetA.lengthSq() > 1e-12) {
                _vNetA.normalize();
                /* ★ 乘 `gaitW`：站定 = 0（布自然垂落，不会一直撑着）；
                 *   起步 `GAIT_FADE_SEC` 0.35 s 内渐入 —— 与 piece/shawl/land 三条通道同一口径，
                 *   不乘的话布料会在起步瞬间被硬推开（用户 m06677 反馈的「不自然」）。
                 *   `shawlPushOsc` 是与走路相位同步的**轻微呼吸**（前移量 ±2°），
                 *   满足「原地轻微摆动、幅度尽量小」。 */
                const angP = (shawlPush + shawlPushOsc * shawlOscR) * gaitW;
                if (Math.abs(angP) > 1e-6) {
                    _qPiece.setFromAxisAngle(_vSide, -shawlPushSign * angP);
                    _vNetB.copy(_vNetA).applyQuaternion(_qPiece).normalize();
                    _qPiece.setFromUnitVectors(_vNetA, _vNetB);
                    _qW.premultiply(_qPiece);
                    rig.shawlPushN++;
                    rig.shawlPushDegNow += angP;
                }
            }
        }
        /* ★★★ 第二十四轮 v3：**头发让位的写回**（同一条规矩：基准非 0 就左乘增量）。
         *  为什么不能只靠「让位段改 `_vRest`」：`dx/dy/dz` 在本骨段更早处已定稿，
         *  改 `_vRest` 只影响下一帧的目标，而弹簧下一帧又拉回去 ⇒ 稳态几乎不动。
         *  实测证据：`hairSepN` 有计数，但 `hairClash.minDist` 在 `?hairsep=` 0/0.02/0.04/0.08
         *  四档上是 0.9 → **0.3** → 1.1 → 0.7 mm，**不单调**。
         *  ⚠️ 与第十四轮「侧摆只改 `_vRest` 被弹簧吃掉」是同一个坑，这里用同一套解药。 */
        {
            const hb3 = i * 3;
            const hx3 = rig.hairBaseDir[hb3], hy3 = rig.hairBaseDir[hb3 + 1], hz3 = rig.hairBaseDir[hb3 + 2];
            if (hx3 !== 0 || hy3 !== 0 || hz3 !== 0) {
                _vPieceBase.set(hx3, hy3, hz3).normalize();
                _vPieceNow.set(_vRest.x, _vRest.y, _vRest.z).normalize();
                _qPiece.setFromUnitVectors(_vPieceBase, _vPieceNow);
                _qW.premultiply(_qPiece);
                rig.hairApplied++;
            }
        }
        b.quaternion.copy(_qParent).invert().multiply(_qW);

        // 父骨矩阵必须立刻跟上，否则链上后面那根骨读到的父朝向是过期的
        b.updateMatrix();
        b.matrixWorld.multiplyMatrices(parent.matrixWorld, b.matrix);

        // ── 粒子落到约束后的位置 ──
        particle[i * 3] = hx + dx * L;
        particle[i * 3 + 1] = hy + dy * L;
        particle[i * 3 + 2] = hz + dz * L;
        particlePrev[i * 3] = px;
        particlePrev[i * 3 + 1] = py;
        particlePrev[i * 3 + 2] = pz;
    }

    /* ★★★ 第二十八轮：披肩**站定相对偏移**采集（刚性整片的基准）。
     *  为什么不用 `holdDir`：那个数组只对 `holdA[i] > 0` 的骨填充，
     *  `holdShawl` 缺省 0 ⇒ 披肩全是 0，刚性通道静默不跑（第一版就栽在这）。
     *  这里第一帧无条件采一次：`shawlOff[i]` = 片根方向 → 本骨方向 的旋转。
     *  ⚠️ 用 `animDirWorld`（本帧动画方向）而不是 `restDirWorld`（求解器目标），
     *     因为要的是「动画里这片布长什么样」，不是「我们把它挪成什么样」。 */
    if (shawlRigid > 0 && rig.shawlOffOk === 0 && shawlRoot >= 0) {
        const ro1 = shawlRoot * 3;
        _vNetA.set(rig.animDirWorld[ro1], rig.animDirWorld[ro1 + 1], rig.animDirWorld[ro1 + 2]);
        const la1 = _vNetA.length();
        if (la1 > 1e-6) {
            _vNetA.multiplyScalar(1 / la1);
            for (let i6 = 0; i6 < n; i6++) {
                if (shawlSel[i6] !== 1) continue;
                const a6 = i6 * 3;
                _vNetB.set(rig.animDirWorld[a6], rig.animDirWorld[a6 + 1], rig.animDirWorld[a6 + 2]);
                if (_vNetB.lengthSq() < 1e-12) { shawlOff[i6 * 4 + 3] = 0; continue; }
                _vNetB.normalize();
                _qNet.setFromUnitVectors(_vNetA, _vNetB);
                shawlBase[a6] = _vNetB.x;
                shawlBase[a6 + 1] = _vNetB.y;
                shawlBase[a6 + 2] = _vNetB.z;
                shawlOff[i6 * 4] = _qNet.x;
                shawlOff[i6 * 4 + 1] = _qNet.y;
                shawlOff[i6 * 4 + 2] = _qNet.z;
                shawlOff[i6 * 4 + 3] = _qNet.w;
            }
            rig.shawlOffOk = 1;
        }
    }

    /* ★★★ 第二十五轮 D：**站定姿态采集**（见 `SecondaryOptions.holdCape`）。
     *  站定（`stepPhase` 非数 = 刚停下/还没起步）时，把本帧每骨的 `restDirWorld`
     *  （本帧求解器最终采用的「静止目标方向」）存进 `holdDir`。
     *  走路时 `hold` 通道朝它混合 ⇒ 布料被「钉」回站立垂落的样子，动画自带的摆动被压掉。
     *  ⚠️ 只在 `holdA` 有非零项时才采（全 0 时连本 if 都不进 ⇒ 精确回滚）。
     *  ⚠️ 站定期间**持续刷新**（不锁死）：换动画/换姿势后自动跟上。 */
    if (rig.holdCape > 0 || rig.holdRibbon > 0 || rig.holdShawl > 0 || rig.holdSkirt > 0) {
        /* ★ 兜底：还没采过就无条件采一次（第一帧）。
         *  否则「一进来就在走 / 整段没有站定帧」时 `holdReady` 永远 false，
         *  hold 通道静默失效（本文件踩过 6 次「通道静默不跑」的同型坑）。 */
        /* ★★★ 第三十三轮 g：修「尾端向上卷」（用户 m08076/m08078）。
         *  旧门禁 `!(stepPhase===stepPhase) || !holdReady` 里 `holdReady` 在本段末尾
         *  **无条件置 true** ⇒ 只有首帧进得来；而 `holdFrames` 只在前 30 帧累加。
         *  页面一进来就 autowalk，那 30 帧全落在**起步相位**（动画把裙骨顶起），
         *  整片披肩被钉死在这个「翻起」方向上，此后永不重采 —— 观感就是尾端上卷、
         *  且每次刷新撞到的相位不同 ⇒ 「有时好好的、有时飞起来」。
         *  修法：逐帧累加到覆盖**一个完整步态周期**（2.33 s）的帧数再冻结、不再重采。
         *  ⇒ 同一初始条件必然给同一结果（消除随机），且整圈平均天然偏向垂落。 */
        if (rig.holdFrames < 160) {
            const hd = rig.holdDir, rd = rig.restDirWorld, hs = rig.holdSum;
            /* ★★★ 第三十二轮 c：**累加求平均**，不要只取某一帧。
             *  根因：`setAutoWalk(0)` 只停位移、MMD 动画仍在播 ⇒「站定」姿态本身在动。
             *  若只取一帧，采到翻起相位就把整段布料钉死在翻起姿态上 ——
             *  实测同一配置连跑三次，站定竖直分量 0.9852 / 0.9756 / **0.0337**（第三次翻平）。
             *  累加 30 帧后归一化 ⇒ 平均掉动画相位，连跑应给同一个数；
             *  且平均方向天然偏「竖直垂落」（翻起只占周期一小段）。
             *  攒够之前先用首帧值，保证通道不会静默不跑。 */
            const HOLD_AVG_N = 160;   /* 整圈平均：2.33 s 步态周期 ≈ 140 帧，取 160 留余量 */
            for (let i5 = 0; i5 < n; i5++) {
                if (rig.holdA[i5] <= 0) continue;
                const hb5 = i5 * 3;
                hd[hb5] = rd[hb5]; hd[hb5 + 1] = rd[hb5 + 1]; hd[hb5 + 2] = rd[hb5 + 2];
                if (rig.holdFrames < HOLD_AVG_N) {
                    hs[hb5] += rd[hb5]; hs[hb5 + 1] += rd[hb5 + 1]; hs[hb5 + 2] += rd[hb5 + 2];
                }
            }
            if (rig.holdFrames < HOLD_AVG_N) {
                rig.holdFrames++;
                if (rig.holdFrames === HOLD_AVG_N) {
                    for (let i5 = 0; i5 < n; i5++) {
                        if (rig.holdA[i5] <= 0) continue;
                        const hb5 = i5 * 3;
                        const ax5 = hs[hb5], ay5 = hs[hb5 + 1], az5 = hs[hb5 + 2];
                        const l5 = Math.hypot(ax5, ay5, az5);
                        if (l5 > 1e-6) {
                            hd[hb5] = ax5 / l5; hd[hb5 + 1] = ay5 / l5; hd[hb5 + 2] = az5 / l5;
                        }
                    }
                }
            }
            rig.holdReady = true;
        }
    } else {
        rig.holdReady = false;
    }

    void _vFree;
    rig.devDeg = maxDev * DEG;
    rig.meanDevDeg = cnt ? (sumDev / cnt) * DEG : 0;
    rig.peakDevDeg = Math.max(rig.devDeg, rig.peakDevDeg * 0.98);
    /* ★ 第二十四轮 v4：本帧刚度均值 —— **从刚度数组重算**，用来证明
     *  `?secstiffk=` / 分片乘数真的进了数组，而不只是读进了常量
     *  （本文件踩过 3 次「参数打印正确 ≠ 功能生效」）。
     *  ⚠️ `updateSecondary` 里解构出的名字是 `stiffness`（不是 `stiff` —— 那是
     *     `createSecondaryMotion` 里的局部名）。写成 `stiff` 会每帧抛
     *     `ReferenceError: stiff is not defined`，整段解算被打断。
     *     这是本文件第 6 次同型坑，前面是 pieceAmp / thighAmp / shawlAmp /
     *     sideFrontKill / hairSep / matGroup。 */
    {
        let sSum = 0;
        for (let i5 = 0; i5 < n; i5++) sSum += stiffness[i5];
        rig.stiffMean = n > 0 ? sSum / n : 0;
    }
    /* ★ 落脚脉冲的平均角读数（累计值在逐骨循环里写）。
     *  ⚠️ 必须除以 `landN` —— 第一版直接输出累计和，99 根 × 2.8° 报成 `landDeg 273.89`，
     *  一眼看不出是「每根 2.8°」还是「整体转了 274°」。与 `sideDeg`/`flareDeg` 同口径。 */
    rig.landDeg = rig.landN > 0 ? rig.landDeg / rig.landN : 0;
    /* ★ 第二十一轮：整片布 / thigh 的「平均角」—— 与 `landDeg`、`sideDeg` 同口径
     *  （累计和 ÷ 生效骨数）。第一版报累计和：479 根 × 各自角 ⇒ 输出 −94.46，
     *  看着像「偏了 94°」，实际每根只有 −0.2°（第十九轮踩过）。 */
    rig.pieceDegNow = rig.pieceN > 0 ? rig.pieceDegNow / rig.pieceN : 0;
    /* ★ 第二十二轮：披肩整片的平均角（同口径：累计和 ÷ 生效骨数） */
    rig.shawlDegNow = rig.shawlN > 0 ? rig.shawlDegNow / rig.shawlN : 0;
    rig.thighDeg = rig.thighN > 0 ? rig.thighDeg / rig.thighN : 0;
    /* ★ 诊断口径：「本帧侧摆角的均值」= 累计角度 / 本帧被摆的袖骨数。
     *  为 0 而 `sideBones > 0` ⇒ 速度门把它压成了 0（站定 / 速度信号缺失），
     *  不是「分类没跑到」—— 两者靠 `sideBones` 就能分开。 */
    rig.sideDeg = rig.sideN > 0 ? sideDegSum / rig.sideN : 0;
    /* 外撑的均值读数同理（累计值在逐骨循环里写）。 */
    if (rig.flareN > 0) {
        rig.flareDeg = flareDegSum / rig.flareN;
        rig.flarePhase = flarePhSum / rig.flareN;
        rig.flareRisk = flareRkSum / rig.flareN;
        rig.flareOlMean = flareOlSum / rig.flareN;
        rig.flareOlMax = flareOlMax;
    }
    // Inset only the character-left half of material 4 during walking.
    const shawlLeftIn = Math.max(0, Math.min(0.04, Number(new URLSearchParams(window.location.search).get('shawlleftin') ?? 0.02) || 0));
    if (shawlLeftIn > 0 && gaitW > 1e-4) {
        const inwardAxis = _vSide.clone().setY(0).normalize();
        for (let si = 0; si < n; si++) {
            if (shawlSel[si] !== 1) continue;
            const spi = parentIdx[si];
            if (spi >= 0 && shawlSel[spi] === 1) continue;
            const sb = bones[si];
            if (!sb.parent) continue;
            const base = sb.userData.mmdRestPosition as number[] | undefined;
            if (!base || base[0] <= 0) continue;
            sb.updateWorldMatrix(true, false);
            const world = sb.getWorldPosition(new THREE.Vector3()).addScaledVector(inwardAxis, -shawlLeftIn * gaitW);
            sb.position.copy(sb.parent.worldToLocal(world));
            sb.updateMatrix(); sb.updateWorldMatrix(false, true);
        }
    }
    // Long back hair uses PMX raw F/F2 names, not the short Bone_Hair strands.
    // Correct after the original solver so its high poses and timing are preserved.
    const backHairFloor = Math.max(0, Math.min(1.15, Number(new URLSearchParams(window.location.search).get('backhairfloor') ?? 1.05) || 0));
    if (backHairFloor > 0 && gaitW > 0.99) {
        for (const side of ['左', '右']) {
            for (const chain of ['F', 'F2']) {
                const root = bones.find(b => b.userData.mmdBoneName === side + chain + '_0_1');
                const end = bones.find(b => b.userData.mmdBoneName === side + chain + (chain === 'F' ? '_19_1' : '_14_1'));
                if (!root?.parent || !end) continue;
                root.updateWorldMatrix(true, true);
                const endIndex = bones.indexOf(end);
                const backHairTip = new THREE.Vector3(restDirLocal[endIndex * 3], restDirLocal[endIndex * 3 + 1], restDirLocal[endIndex * 3 + 2]).multiplyScalar(restLen[endIndex]).applyMatrix4(end.matrixWorld);
                if (backHairTip.y >= backHairFloor) continue;
                const origin = root.getWorldPosition(new THREE.Vector3());
                const direction = backHairTip.sub(origin);
                const length = direction.length();
                const targetY = Math.max(-0.999, Math.min(0.999, (backHairFloor - origin.y) / length));
                direction.normalize();
                const horizontal = Math.hypot(direction.x, direction.z);
                if (horizontal < 1e-6) continue;
                const factor = Math.sqrt(1 - targetY * targetY) / horizontal;
                const target = new THREE.Vector3(direction.x * factor, targetY, direction.z * factor);
                const rotation = new THREE.Quaternion().setFromUnitVectors(direction, target);
                const parentRotation = root.parent.getWorldQuaternion(new THREE.Quaternion());
                root.quaternion.premultiply(parentRotation.clone().invert().multiply(rotation).multiply(parentRotation));
                root.updateMatrix();
                root.updateWorldMatrix(false, true);
            }
        }
    }
    // Narrow the back-hair opening by horizontal yaw only: world Y stays unchanged.
    const backHairGap = Math.max(0.2, Math.min(1, Number(new URLSearchParams(window.location.search).get('backhairgap') ?? 0.91)));
    if (gaitW > 0.99 && backHairGap < 1) {
        const hairSideAxis = _vSide.clone().setY(0).normalize();
        const hairFrontAxis = new THREE.Vector3().crossVectors(hairSideAxis, new THREE.Vector3(0, 1, 0));
        for (const side of ['左', '右']) for (const chain of ['F', 'F2']) {
            const root = bones.find(b => b.userData.mmdBoneName === side + chain + '_0_1');
            const end = bones.find(b => b.userData.mmdBoneName === side + chain + (chain === 'F' ? '_19_1' : '_14_1'));
            if (!root?.parent || !end) continue;
            root.updateWorldMatrix(true, true);
            const origin = root.getWorldPosition(new THREE.Vector3());
            const delta = end.getWorldPosition(new THREE.Vector3()).sub(origin);
            const x = delta.dot(hairSideAxis), z = delta.dot(hairFrontAxis);
            const radius = Math.hypot(x, z);
            if (radius < 1e-6) continue;
            const targetX = x * backHairGap;
            const targetZ = Math.sign(z || -1) * Math.sqrt(Math.max(0, radius * radius - targetX * targetX));
            const hairGapYaw = Math.atan2(targetX, targetZ) - Math.atan2(x, z);
            const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), hairGapYaw);
            const parentRotation = root.parent.getWorldQuaternion(new THREE.Quaternion());
            root.quaternion.premultiply(parentRotation.clone().invert().multiply(rotation).multiply(parentRotation));
            root.updateMatrix(); root.updateWorldMatrix(false, true);
        }
    }
    rig.lastMs = performance.now() - _t0;
}
export function resetSecondary(rig: SecondaryRig | null): void {
    if (rig) rig.primed = false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ★★ 穿模审计（用户 m11046 任务2）
 *
 * 判据 R：**「碰撞写进代码了」≠「碰撞生效了」。** 碰撞是「推出 → 又按骨长拉回」
 * 的两步操作，第二步会把第一步的成果吃掉一部分；再加上 `colSkip`（第一帧本来就
 * 插在身体里的骨×体对会被永久屏蔽），布料完全可能看起来在动、却依然穿模。
 *
 * 唯一可靠的验证办法是把**求解器最终写回的那颗粒子**（`rig.particle`，它才是
 * 骨尾的真实世界坐标）拿去和所有碰撞体比一遍，量出「插进身体多少米」。
 * 返回的 `worst` 里 `pen > 0` 就是穿模的深度。
 * ──────────────────────────────────────────────────────────────────────────── */
export interface CollideHit {
    /** 物理骨名 */
    bone: string;
    /** 它插进去的碰撞体挂在哪根骨上 */
    col: string;
    /** 插进去多少米（正数 = 穿模深度），相对**被 colScale 放大后**的碰撞体 */
    pen: number;
    /** 这一对是否在「静置允许的插深」之内（超了才会被推出去） */
    skipped: boolean;
    /** 超出允许插深的部分（米）；> 0 = 真的没推出去 */
    over: number;
    /** ★ 相对**可见身体**的穿透深度（米）。用 `rawR × visScale` 当身体半径 —— 这个数
     *  与 `colScale` 无关，所以能跨设置横向比较：「加大碰撞球有没有真的更不穿」。 */
    penVis: number;
}
export interface CollideAudit {
    cols: number; bones: number; primed: boolean;
    colScale: number; iterations: number;
    /** 穿透最深的若干对（含允许插深内的，方便看出「本来就嵌着」还是「推不出去」） */
    worst: CollideHit[];
    /** 有多少「骨尾×碰撞体」对真的插在身体里 */
    penPairs: number;
    /** 其中有多少对还在「静置允许的插深」之内（正常） */
    penSkipped: number;
    /** ★ 超出允许插深的对数 —— **这才是真正的穿模计数** */
    penOver: number;
    /** 最大穿透深度（米） */
    maxPen: number;
    /** ★ 最大**超出**量（米）—— 真正该被清零的数 */
    maxOver: number;
    /** ★ 相对**可见身体**（`rawR × visScale`）的最大穿透深度（米）。
     *  判据：< 0 表示布料的骨尾完全在可见身体之外 ⇒ 不穿模。 */
    maxPenVis: number;
    /** 有多少「骨尾×碰撞体」对插进了可见身体 */
    penVisPairs: number;
    /** 估算可见身体时用的半径倍率 */
    visScale: number;
    /** 每个碰撞体：挂在哪根骨、形状、半径（米）、半长（米） */
    colliders: { bone: string; shape: number; r: number; half: number }[];
    colN: number;
}
export function auditColliders(rig: SecondaryRig | null, top = 14, visScale = 1.35): CollideAudit {
    const out: CollideAudit = {
        cols: 0, bones: 0, primed: false, colScale: 0, iterations: 0, worst: [],
        penPairs: 0, penSkipped: 0, penOver: 0, maxPen: 0, maxOver: 0,
        maxPenVis: 0, penVisPairs: 0, visScale,
        colliders: [], colN: 0,
    };
    if (!rig) return out;
    const { colN, colBone, colShape, n, bones } = rig;
    out.colN = colN; out.cols = colN; out.bones = n; out.primed = rig.primed;
    out.colScale = rig.colScale; out.iterations = rig.iterations;
    for (let j = 0; j < colN; j++) {
        out.colliders.push({
            bone: colBone[j]?.name ?? '?',
            shape: colShape[j], r: rig._cR[j], half: rig._cHalf[j],
        });
    }
    if (!rig.collide || colN === 0 || !rig.primed) return out;

    const hits: CollideHit[] = [];
    for (let i = 0; i < n; i++) {
        const b = bones[i];
        if (!b) continue;
        const px = rig.particle[i * 3], py = rig.particle[i * 3 + 1], pz = rig.particle[i * 3 + 2];
        if (!Number.isFinite(px)) continue;
        for (let j = 0; j < colN; j++) {
            const R = rig._cR[j];
            if (R <= 1e-6) continue;
            const cx = rig._cWorld[j * 3], cy = rig._cWorld[j * 3 + 1], cz = rig._cWorld[j * 3 + 2];
            let ex = px - cx, ey = py - cy, ez = pz - cz;
            const H = rig._cHalf[j];
            if (H > 0) {
                const ax = rig._cAxis[j * 3], ay = rig._cAxis[j * 3 + 1], az = rig._cAxis[j * 3 + 2];
                let t = ex * ax + ey * ay + ez * az;
                if (t > H) t = H; else if (t < -H) t = -H;
                ex -= ax * t; ey -= ay * t; ez -= az * t;
            }
            const dd = Math.hypot(ex, ey, ez);
            const pen = R - dd;
            // 可见身体的估算半径：把被 colScale 放大的半径还原回原始 PMX 半径，再乘 visScale
            const visR = R / Math.max(1e-6, rig.colScale * (rig.colMul?.[j] ?? 1)) * visScale;   // 参照恒为「原始 PMX 半径 × visScale」
            const penVis = visR - dd;
            if (penVis > 0) { out.penVisPairs++; if (penVis > out.maxPenVis) out.maxPenVis = penVis; }
            if (pen <= 0) continue;
            out.penPairs++;
            const slack = rig.colSlack[i * colN + j] || 0;
            const over = pen - slack;
            const skipped = over <= 1e-4;
            if (skipped) out.penSkipped++;
            else { out.penOver++; if (over > out.maxOver) out.maxOver = over; }
            if (pen > out.maxPen) out.maxPen = pen;
            hits.push({ bone: b.name || `#${i}`, col: colBone[j]?.name ?? '?', pen, skipped, over, penVis });
        }
    }
    // 排序：真正没推出去的（over）优先，其次看总插深
    hits.sort((a, b) => (b.penVis - a.penVis) || (b.over - a.over) || (b.pen - a.pen));
    out.worst = hits.slice(0, top);
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★ 骨棒（= 布片那条带）对身体的穿透取证（用户 m13789）
 *
 *  `auditColliders` 只把**骨尾那一个点**拿去比，所以它给的 `maxPenVis = 0`
 *  只证明「骨尾没进身体」。布料是面：腿可以从两根骨**之间**穿过，那时每个骨尾
 *  都在胶囊外面，面却被扎穿。这个函数就是把「骨棒后半段（s = 0.5…1.0）」
 *  一起测出来的穿透量，用来判断上面那条盲区到底有多大。
 * ══════════════════════════════════════════════════════════════════════════ */
export interface RodHit { bone: string; col: string; pen: number; penVis: number; s: number }
export interface RodAudit {
    bones: number; colN: number; rodSamples: number; primed: boolean;
    /** 骨棒后端最大穿透（相对 `colScale` 放大后的胶囊，米） */
    maxPen: number;
    /** 相对**原始 PMX 半径**（`visScale=1` 就是最接近可见身体的判据）的最大穿透，米 */
    maxPenVis: number;
    penPairs: number; penVisPairs: number; visScale: number;
    worst: RodHit[];
}
export function auditRod(rig: SecondaryRig | null, rodSamples = 4, top = 14, visScale = 1.35): RodAudit {
    const out: RodAudit = {
        bones: 0, colN: 0, rodSamples, primed: false,
        maxPen: 0, maxPenVis: 0, penPairs: 0, penVisPairs: 0, visScale, worst: [],
    };
    if (!rig) return out;
    const { colN, colBone, n, bones } = rig;
    out.bones = n; out.colN = colN; out.primed = rig.primed;
    if (!rig.collide || colN === 0 || !rig.primed) return out;

    const S = Math.max(1, Math.min(8, Math.round(rodSamples)));
    const sMin = S > 1 ? 0.5 : 1;
    const hits: RodHit[] = [];
    for (let i = 0; i < n; i++) {
        const b = bones[i];
        if (!b) continue;
        const tx = rig.particle[i * 3], ty = rig.particle[i * 3 + 1], tz = rig.particle[i * 3 + 2];
        if (!Number.isFinite(tx)) continue;
        const p = b.parent;
        if (!p) continue;
        const he = p.matrixWorld.elements;
        const hx = he[12], hy = he[13], hz = he[14];
        for (let j = 0; j < colN; j++) {
            const R = rig._cR[j];
            if (R <= 1e-6) continue;
            const cx = rig._cWorld[j * 3], cy = rig._cWorld[j * 3 + 1], cz = rig._cWorld[j * 3 + 2];
            const H = rig._cHalf[j];
            const ax = rig._cAxis[j * 3], ay = rig._cAxis[j * 3 + 1], az = rig._cAxis[j * 3 + 2];
            let best = -Infinity, dd = Infinity, sBest = 1;
            for (let k = 0; k < S; k++) {
                const s = S > 1 ? sMin + (1 - sMin) * (k / (S - 1)) : 1;
                const qx = hx + (tx - hx) * s, qy = hy + (ty - hy) * s, qz = hz + (tz - hz) * s;
                let ex = qx - cx, ey = qy - cy, ez = qz - cz;
                if (H > 0) {
                    let t = ex * ax + ey * ay + ez * az;
                    if (t > H) t = H; else if (t < -H) t = -H;
                    ex -= ax * t; ey -= ay * t; ez -= az * t;
                }
                const d = Math.hypot(ex, ey, ez);
                const pn = R - d;
                if (pn > best) { best = pn; dd = d; sBest = s; }
            }
            const pen = best;
            const visR = R / Math.max(1e-6, rig.colScale * (rig.colMul?.[j] ?? 1)) * visScale;   // 参照恒为「原始 PMX 半径 × visScale」
            const penVis = visR - dd;
            if (penVis > 0) { out.penVisPairs++; if (penVis > out.maxPenVis) out.maxPenVis = penVis; }
            if (pen <= 0) continue;
            out.penPairs++;
            if (pen > out.maxPen) out.maxPen = pen;
            hits.push({ bone: b.name || `#${i}`, col: colBone[j]?.name ?? '?', pen, penVis, s: sBest });
        }
    }
    hits.sort((a, b) => (b.penVis - a.penVis) || (b.pen - a.pen));
    out.worst = hits.slice(0, top);
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★★ 布料**互相**穿模的取证（用户 m13789：「走路时前面衣料和袖子穿模」）
 *
 *  背景：`collideAudit` 已经证明布料的骨尾在整个走路周期里从不进入身体代理
 *  （`maxPenVis ≤ 0`，见 `_logs/walkcollide.jsonl`）⇒ 用户看到的「穿模」不是
 *  「布插进身体」，那只可能是**两块布互相插**：长袖（`driveSel===1`，176 根）
 *  甩到前襟/裙摆（`driveSel===2` 51 根 + 名字含 `Skirt_` 的那些）里去。
 *  引擎里**没有任何布料↔布料的碰撞**（碰撞体只有 PMX 静止刚体 = 身体），
 *  所以这类互相穿插从来没人管过 —— 这个函数就是把它的量级量出来。
 *
 *  度量：把每根弹簧骨当一根「父骨原点 → 骨尾粒子」的短棒，算**异组**骨棒之间的
 *  最短距离（点到线段，双向取小）。同一根链上的邻居（`Skirt_1_2` 与 `Skirt_1_3`）
 *  本来就在一起，所以只比**不同组**的对。
 *  判据：布片本身有宽度，两组骨棒的最近距离 < ~2 cm 就基本可以肯定网格已经互穿了；
 *  `< 0`（粒子落进对方的棒里）则一定是。
 * ══════════════════════════════════════════════════════════════════════════ */
export interface ClashHit { a: string; b: string; ga: number; gb: number; d: number }
export interface ClashAudit {
    bones: number; primed: boolean;
    /** 各组根数：[其它, 袖套(arm), 前襟(panel), 裙摆(Skirt_*)] */
    groups: [number, number, number, number];
    /** 异组骨棒的最近距离（米）—— < 0.02 就基本可以认定互穿 */
    minDist: number;
    /** 最近的那一对叫什么 */
    minPair: string | null;
    /** 距离小于 1 cm / 2 cm / 5 cm 的异组对数 */
    under1: number; under2: number; under5: number;
    /** 参与比较的对数 */
    pairs: number;
    /** 最近的若干对 */
    worst: ClashHit[];
}

/** 点到线段的最短距离（三维） */
function _p2seg(px: number, py: number, pz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number): number {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = px - ax, wy = py - ay, wz = pz - az;
    const uu = ux * ux + uy * uy + uz * uz;
    let t = uu > 1e-12 ? (wx * ux + wy * uy + wz * uz) / uu : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + ux * t - px, cy = ay + uy * t - py, cz = az + uz * t - pz;
    return Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/** ★ 第二十四轮 v3：头发 ↔ 布料的穿模读数。 */
export interface HairClashAudit {
    bones: number; primed: boolean;
    /** 各类布各多少根：[其它, 头发, 披风, 带, 披肩, 裙, 袖] */
    groups: number[];
    /** 头发×布料 的最近距离（米）—— < 0.02 基本可认定互穿 */
    minDist: number;
    /** 最近的那一对（`头发骨 × 布骨`） */
    minPair: string | null;
    /** 距离 < 1 cm / 2 cm / 5 cm 的对数 */
    under1: number; under2: number; under5: number;
    /** 参与比较的对数 */
    pairs: number;
    /** 按**布料类**分别的最近距离：披风/带/披肩/裙/袖 */
    byGroup: { cape: number; ribbon: number; shawl: number; skirt: number; sleeve: number };
    worst: { hair: string; cloth: string; g: number; d: number }[];
}

/** 每一类布的中文名（报错与报告里用，避免 2/3/4 这些魔数） */
const MAT_LABEL = ['其它', '头发', '披风', '带', '披肩', '裙', '袖'];

/**
 * ★★★ 第二十四轮 v3：**头发 ↔ 布料**的最小骨棒距离。
 *
 * 为什么不能复用 `auditClash`：它的分组是 `driveSel===1/2` + `/Skirt/`，
 * **头发一根都不在里面** ⇒ 用户 m02740 指出的「头发穿进白裙/披风」永远是 0 读数。
 *
 * 口径与 `auditClash` 完全一致（头 = 父骨世界原点，尾 = 粒子），
 * 只比**头发 × 非头发布料**，并且额外给出「按布料类分开的最近距离」——
 * 一眼能看出是穿在裙上还是穿在披风上。
 */
export function auditHairClash(rig: SecondaryRig | null, under5 = 0.05, top = 10): HairClashAudit {
    const out: HairClashAudit = {
        bones: 0, primed: false, groups: [0, 0, 0, 0, 0, 0, 0],
        minDist: Infinity, minPair: null, under1: 0, under2: 0, under5: 0, pairs: 0,
        byGroup: { cape: Infinity, ribbon: Infinity, shawl: Infinity, skirt: Infinity, sleeve: Infinity },
        worst: [],
    };
    if (!rig) return out;
    const { n, bones, particle, matGroup } = rig;
    out.bones = n; out.primed = rig.primed;
    if (!rig.primed || !matGroup) return out;
    for (let i = 0; i < n; i++) out.groups[matGroup[i]] = (out.groups[matGroup[i]] || 0) + 1;

    /* 骨棒：头 = 父骨世界原点，尾 = 粒子（与 `auditClash` 同一口径） */
    const H = new Float32Array(n * 3), T = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const p = bones[i]?.parent;
        if (p) { const e = p.matrixWorld.elements; H[i * 3] = e[12]; H[i * 3 + 1] = e[13]; H[i * 3 + 2] = e[14]; }
        T[i * 3] = particle[i * 3]; T[i * 3 + 1] = particle[i * 3 + 1]; T[i * 3 + 2] = particle[i * 3 + 2];
    }

    const keyOf = (g6: number): keyof HairClashAudit['byGroup'] | null =>
        g6 === 2 ? 'cape' : g6 === 3 ? 'ribbon' : g6 === 4 ? 'shawl' : g6 === 5 ? 'skirt' : g6 === 6 ? 'sleeve' : null;

    const hits: { hair: string; cloth: string; g: number; d: number }[] = [];
    for (let i = 0; i < n; i++) {
        if (matGroup[i] !== 1) continue;                 // 只看头发
        if (!Number.isFinite(T[i * 3])) continue;
        for (let j = 0; j < n; j++) {
            if (j === i || matGroup[j] < 2) continue;    // 只看「非头发」的布
            if (!Number.isFinite(T[j * 3])) continue;
            out.pairs++;
            const d1 = _p2seg(T[i * 3], T[i * 3 + 1], T[i * 3 + 2],
                H[j * 3], H[j * 3 + 1], H[j * 3 + 2], T[j * 3], T[j * 3 + 1], T[j * 3 + 2]);
            const d2 = _p2seg(T[j * 3], T[j * 3 + 1], T[j * 3 + 2],
                H[i * 3], H[i * 3 + 1], H[i * 3 + 2], T[i * 3], T[i * 3 + 1], T[i * 3 + 2]);
            const d = d1 < d2 ? d1 : d2;
            if (d < 0.01) out.under1++;
            if (d < 0.02) out.under2++;
            if (d < under5) out.under5++;
            if (d < out.minDist) {
                out.minDist = d;
                out.minPair = (bones[i]?.name ?? '?') + ' × ' + (bones[j]?.name ?? '?');
            }
            const kg = keyOf(matGroup[j]);
            if (kg && d < out.byGroup[kg]) out.byGroup[kg] = d;
            if (d < under5) hits.push({ hair: bones[i]?.name ?? '?', cloth: bones[j]?.name ?? '?', g: matGroup[j], d });
        }
    }
    hits.sort((a, b) => a.d - b.d);
    out.worst = hits.slice(0, top);
    const fix = (x: number) => (Number.isFinite(x) ? x : -1);
    out.minDist = fix(out.minDist);
    out.byGroup.cape = fix(out.byGroup.cape);
    out.byGroup.ribbon = fix(out.byGroup.ribbon);
    out.byGroup.shawl = fix(out.byGroup.shawl);
    out.byGroup.skirt = fix(out.byGroup.skirt);
    out.byGroup.sleeve = fix(out.byGroup.sleeve);
    return out;
}
export const MAT_GROUP_LABEL = MAT_LABEL;

export function auditClash(rig: SecondaryRig | null, under5 = 0.05, top = 12): ClashAudit {
    const out: ClashAudit = {
        bones: 0, primed: false, groups: [0, 0, 0, 0], minDist: Infinity, minPair: null,
        under1: 0, under2: 0, under5: 0, pairs: 0, worst: [],
    };
    if (!rig) return out;
    const { n, bones, driveSel, particle } = rig;
    out.bones = n; out.primed = rig.primed;
    if (!rig.primed) return out;

    // 分组：1 = 袖套（胳膊驱动的那些），2 = 前襟（前襟驱动），3 = 裙摆（名字含 Skirt）
    const g = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const nm = bones[i]?.name ?? '';
        if (driveSel[i] === 1) g[i] = 1;
        else if (driveSel[i] === 2) g[i] = 2;
        else if (/Skirt/.test(nm)) g[i] = 3;
    }
    for (let i = 0; i < n; i++) out.groups[g[i]]++;

    // 骨棒：头 = 父骨世界原点，尾 = 粒子
    const H = new Float32Array(n * 3), T = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const p = bones[i]?.parent;
        if (p) { const e = p.matrixWorld.elements; H[i * 3] = e[12]; H[i * 3 + 1] = e[13]; H[i * 3 + 2] = e[14]; }
        T[i * 3] = particle[i * 3]; T[i * 3 + 1] = particle[i * 3 + 1]; T[i * 3 + 2] = particle[i * 3 + 2];
    }

    const hits: ClashHit[] = [];
    for (let i = 0; i < n; i++) {
        const gi = g[i];
        if (gi === 0) continue;
        if (!Number.isFinite(T[i * 3])) continue;
        for (let j = i + 1; j < n; j++) {
            const gj = g[j];
            if (gj === 0 || gj === gi) continue;          // 只比**异组**
            if (!Number.isFinite(T[j * 3])) continue;
            out.pairs++;
            // 双向：i 的尾到 j 的棒、j 的尾到 i 的棒
            const d1 = _p2seg(T[i * 3], T[i * 3 + 1], T[i * 3 + 2],
                H[j * 3], H[j * 3 + 1], H[j * 3 + 2], T[j * 3], T[j * 3 + 1], T[j * 3 + 2]);
            const d2 = _p2seg(T[j * 3], T[j * 3 + 1], T[j * 3 + 2],
                H[i * 3], H[i * 3 + 1], H[i * 3 + 2], T[i * 3], T[i * 3 + 1], T[i * 3 + 2]);
            const d = d1 < d2 ? d1 : d2;
            if (d < 0.01) out.under1++;
            if (d < 0.02) out.under2++;
            if (d < under5) out.under5++;
            if (d < out.minDist) {
                out.minDist = d;
                out.minPair = (bones[i]?.name ?? '?') + ' × ' + (bones[j]?.name ?? '?');
            }
            if (d < under5) hits.push({ a: bones[i]?.name ?? '?', b: bones[j]?.name ?? '?', ga: gi, gb: gj, d });
        }
    }
    hits.sort((a, b) => a.d - b.d);
    out.worst = hits.slice(0, top);
    if (!Number.isFinite(out.minDist)) out.minDist = -1;
    return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★★ 用户 m18305（第七项修复）：「袖子的摆动方向向两侧，不随手臂前后」
 *
 *  验收要回答的不是「参数读没读进来」，而是**袖子相对手臂骨的偏移朝哪个轴**：
 *    X（侧向）= 从手臂骨指向身体外侧的方向；
 *    Z（前后）= 角色前进轴 —— 袖子随手臂前后摆时这个分量大。
 *  取「袖骨骨尾 − 它的**动画姿势**尾位」，再投影到 X / Z，把手臂自身前后摆
 *  这个共享成分减掉。只读 `rig`：不改 `particle` / `quaternion` / `_vRest`
 *  里任何一个数，所以与 `?secdrive=-1` / `?secflare=-1` 回滚路径互不影响。
 *  分母只算真正分出来的袖骨（`secdriveSel===1` 且 `axisSel===1`），夹在胳肢窝
 *  正中那些侧向偏移恒 0 的骨会稀释均值。
 * ══════════════════════════════════════════════════════════════════════════ */
export interface SleeveRead {
    /* ═══ ★★★ t30：三个**独立**量 + 左右分袖报（t21 F2）═══════════════════════
     *
     *  旧口径 `x` / `z` 是「Σ|分量| / 骨数」——取绝对值再平均，左右袖的正负相互抵消，
     *  于是「袖子到底往哪飘」被平均掉了；`xSigned` 虽然带符号，但它是 8 根混在一起，
     *  而且**没有左右袖的区分**，看一只袖不合格、另一只合格时完全看不出来。
     *
     *  新口径：先按 `axisSign` 把袖骨分成**左袖**（`axisSign >= 0`）与**右袖**，
     *  每只袖各算三个量（米，均为**该袖骨根数上的平均**）：
     *    xSide = Σ (Δ · 侧向轴) / 根数   —— Δ 已经乘过 axisSign，
     *                                      正数 = 朝**该袖自己那一侧的外侧**张开；
     *    xFin  = Σ max(Δ · 前向轴, 0) / 根数 —— 朝角色**前进方向**的分量；
     *    xBack = Σ max(−Δ · 前向轴, 0) / 根数 —— 朝**后退方向**的分量。
     *  为什么把前后拆成 xFin / xBack 两个：总前后位移大，未必是「随手臂摆动」，
     *  可能是一致地朝前（或朝后）垂着。拆开才能看出「来回摆」还是「静态偏置」。
     *  验收比值一律用 **xSide / (xFin + xBack)**（见 `ratioL` / `ratioR`）。
     *
     *  `x` / `xSigned` 保留只为**回滚可比**（旧日志里是这套数），定义与关系：
     *    x       = (Σ|side| over 左右两袖) / 根数 —— **无符号**均值；
     *    xSigned = (Σ side  over 左右两袖) / 根数 —— 带符号，正 = 朝各自外侧；
     *    两者只有在「所有袖骨都朝自己外侧移动」时才相等；只要有一只袖往里缩，
     *    `xSigned < x`，差值就是两侧相互抵消的量。
     *    ⚠️ t21 指出 `x` 被混进了前向分量、不能用于判「向两侧飘」，判定一律用 `xSide`。
     * ═════════════════════════════════════════════════════════════════════════ */
    /** 左右两袖合并的无符号侧向均值（米）—— 仅回滚可比，不作判据 */
    x: number;
    /** 左袖 / 右袖的侧向（米，正 = 朝该袖外侧） */
    sideL: number;
    sideR: number;
    /** 左袖 / 右袖的前向分量（米，正 = 朝角色前进方向） */
    finL: number;
    finR: number;
    /** 左袖 / 右袖的后向分量（米） */
    backL: number;
    backR: number;
    /** 左右袖各自参与统计的骨数 */
    nL: number;
    nR: number;
    /** 验收比值：xSide / (xFin + xBack)，每只袖各一个 */
    ratioL: number;
    ratioR: number;
    /** 左右两袖的平均比值（仅供看趋势，判据仍用 ratioL / ratioR） */
    ratioLR: number;
    /** Σ|前后|/骨数（米） */
    /** Σ|竖直|/骨数（米） */
    y: number;
    /** ★ 第二十六轮 T1-I4 修：Σ|前后| / 骨数（米）—— `:4999` 一直在返回它，
     *  接口里漏了声明（`TS2353`）。旧日志里 `z` 就是这套数，保留原义。 */
    z: number;
    /** Σ带符号侧向/骨数（米，正 = 朝该骨自己的外侧） */
    xSigned: number;
    /** 参与统计的袖骨数 */
    n: number;
    /** 侧向最大（带符号，米） */
    xMax: number;
    /** 前后最大（米） */
    zMax: number;
    /** 侧向 > 前后的根数 —— 判「主运动轴」的直接证据 */
    xOverZ: number;
    /** 同一份样本、只看全部袖骨（不筛轴）的均值，用来剔除口径差异 */
    xAll: number;
    zAll: number;
    nAll: number;
    /** 侧向偏移 > 2 cm 的袖骨根数（按根判定，不被 8 根平均稀释） */
    moved: number;
    /** 侧向净外移 > 2 cm 的根数（判「袖片是不是真的离开衣身」） */
    outN: number;
    /** 最靠外的 3 根自身侧向位移之和（米）——不受「别在收」的骨稀释 */
    outTop: number;
    /** 实测净外移：8 根袖骨「实际骨尾 − 动画骨尾」在侧向上的平均（米，正 = 更靠外） */
    spreadMean: number;
    /** 同上取最大值（米） */
    spreadMax: number;
    /** 仅供对照：平均朝向在水平面上的角度（度），不作判定依据 */
    spreadAnimDeg: number;
    /** 逐骨明细（仅 `?secrows=1` 时填充：[骨号, 侧向 m, 前后 m]） */
    rowsX?: Array<[number, number, number]>;
}

/* ★★ t16 实测净外移（队长点名要的那个数，不能拿设定值冒充）
 *  口径：两侧各 4 根袖骨，**按骨分别**比「动画姿势的骨尾」与「实际粒子的骨尾」，
 *  取两者在角色水平面上的**侧向**距离（米，正 = 比动画姿势更靠外）：
 *      Δside_i = (p_i − a_i) · sideAxis · sign_i
 *  再对 8 根取平均（`spreadMean`，米）与「净外移 > σ 的根数」（`outN`）。
 *  为什么不报角度：袖骨本身近竖直，\"张开多少度\" 对骨骼方向几乎不变，
 *  量出来的角度会被手臂自身前后摆淹没（实测同一根骨在关掉侧摆时也能差 20°+）。
 *  位移米数是唯一稳定、可信、可与 `minDist` 直接比较的量。
 *  `spreadAnimDeg` 只保留「平均朝向在水平面上的角度」作参考，不参与判定。 */
function measureSpan(rig: SecondaryRig): { spreadMean: number; spreadMax: number; spreadAnimDeg: number } {
    const { n, bones, particle, secdriveSel, axisSign, restDirLocal, restLen } = rig;
    _mRot.extractRotation(rig.root.matrixWorld);
    _qParent.setFromRotationMatrix(_mRot);
    _vFree.set(rig.sideLocal[0], rig.sideLocal[1], rig.sideLocal[2]).applyQuaternion(_qParent).normalize();
    _vFwdFlat.set(rig.fwdLocal[0], rig.fwdLocal[1], rig.fwdLocal[2]).applyQuaternion(_qParent).normalize();
    let sum = 0, mx = -Infinity, m = 0;
    let ax = 0, az = 0;
    for (let i = 0; i < n; i++) {
        if (secdriveSel[i] !== 1) continue;
        const L = restLen[i];
        if (!(L > 1e-6)) continue;
        const par = bones[i]?.parent;
        if (!par) continue;
        const pe = par.matrixWorld.elements;
        _vHead.set(pe[12], pe[13], pe[14]);
        _mRot.extractRotation(par.matrixWorld);
        _vFree.set(rig.sideLocal[0], rig.sideLocal[1], rig.sideLocal[2]).applyQuaternion(_qParent).normalize();
        _qParent.setFromRotationMatrix(_mRot);
        _vRest.set(restDirLocal[i * 3], restDirLocal[i * 3 + 1], restDirLocal[i * 3 + 2])
            .applyQuaternion(_qParent).multiplyScalar(L);
        const axx = _vHead.x + _vRest.x, azz = _vHead.z + _vRest.z;
        const dxx = particle[i * 3] - axx, dzz = particle[i * 3 + 2] - azz;
        const sgn = axisSign[i] >= 0 ? 1 : -1;
        const dSide = (dxx * _vFree.x + dzz * _vFree.z) * sgn;
        sum += dSide; m++;
        if (dSide > mx) mx = dSide;
        ax += dxx; az += dzz;
    }
    if (!m) return { spreadMean: 0, spreadMax: 0, spreadAnimDeg: 0 };
    const ang = Math.atan2(ax * _vFree.x + az * _vFree.z, ax * _vFwdFlat.x + az * _vFwdFlat.z) * 57.29578;
    return { spreadMean: +(sum / m).toFixed(4), spreadMax: +mx.toFixed(4), spreadAnimDeg: +ang.toFixed(2) };
}

export function measureSleeve(rig: SecondaryRig): SleeveRead {
    const { n, bones, particle, restDirLocal, restLen, secdriveSel, axisSel, axisSign } = rig;
    let sx = 0, sz = 0, sy = 0, sxs = 0, cnt = 0, mx = 0, mz = 0, over = 0, movedN = 0;
    let ax2 = 0, az2 = 0, all = 0, outN = 0;
    /* ★ t30：左右袖分开累计（L = axisSign >= 0） */
    const L_side = { s: 0, fin: 0, back: 0, n: 0 };
    const R_side = { s: 0, fin: 0, back: 0, n: 0 };
    const outs: number[] = [];
    for (let i = 0; i < n; i++) {
        if (secdriveSel[i] !== 1) continue;
        const L = restLen[i];
        if (!(L > 1e-6)) continue;
        const bone = bones[i];
        const parent = bone?.parent;
        if (!parent) continue;
        // 世界侧向轴（与逐帧求解同口径，但不写 `_vSide` 以免污染求解器）
        _mRot.extractRotation(rig.root.matrixWorld);
        _qParent.setFromRotationMatrix(_mRot);
        _vFree.set(rig.sideLocal[0], rig.sideLocal[1], rig.sideLocal[2]).applyQuaternion(_qParent).normalize();
        // 动画姿势下该骨的尾位（不含任何布料偏移）
        const pe = parent.matrixWorld.elements;
        _vHead.set(pe[12], pe[13], pe[14]);
        _mRot.extractRotation(parent.matrixWorld);
        _qParent.setFromRotationMatrix(_mRot);
        _vRest.set(restDirLocal[i * 3], restDirLocal[i * 3 + 1], restDirLocal[i * 3 + 2])
            .applyQuaternion(_qParent).multiplyScalar(L);
        const ax = _vHead.x + _vRest.x, ay = _vHead.y + _vRest.y, az = _vHead.z + _vRest.z;
        const px = particle[i * 3], py = particle[i * 3 + 1], pz = particle[i * 3 + 2];
        const ox = px - ax, oz = pz - az;
        const side = (ox * _vFree.x + oz * _vFree.z) * (axisSign[i] >= 0 ? 1 : -1);
        /* ★ t16：按**根**判定「这片袖骨有没有被往外挪」——`sleeve.x` 是 8 根的平均值，
         *  均值摆动 1~3 cm 也能越过阈值，但那样袖片在画面上根本看不出来。
         *  同一支侧向轴 `_vFree`（= `_vSide`），乘 `axisSign` 后正数 = 朝自己那一侧。
         *  阈值 2 cm：小于它的都是重力/风的抖动。 */
        if (Math.abs(side) > 0.02) movedN++;
        if (side > 0.02) { outN++; outs.push(side); }
        /* ★★★ 前后分量必须是**投影**，不能是水平模长（队长独立复核指出的硬 bug）。
         *  旧写法 `const fwd = Math.hypot(ox, oz);` 让 `fwd` 变成「水平总位移」，
         *  于是恒有 `|side| ≤ fwd`（投影的绝对值不可能超过模长）：
         *    ① `if (Math.abs(side) > fwd) over++` 恒为假 ⇒ `xOverZ ≡ 0`；
         *    ② 均值上 `z ≥ x` 恒成立 ⇒ 判据「X 显著增大、Z 显著减小」**无论怎么改袖子都不可能过**。
         *  `fwdLocal` 与 `sideLocal` 是同一平面内互相垂直的两个水平单位向量
         *  （构建期 `sideLocal = [fz, 0, -fx]`，见 `fwdLocal` 的注释），所以同一个
         *  `_qParent` 转出来就是正交的前向轴，直接把位移投影上去才是「前后分量」。 */
        _vFwdFlat.set(rig.fwdLocal[0], rig.fwdLocal[1], rig.fwdLocal[2]).applyQuaternion(_qParent).normalize();
        const fwdC = ox * _vFwdFlat.x + oz * _vFwdFlat.z;
        const fwd = Math.abs(fwdC);          // 与 `side` 的绝对值同口径
        const up = Math.abs(py - ay);
        // 逐骨明细（`?secrows=1`）：必须在 `fwd` 声明之后，否则 TDZ 报错
        if (rig.sideRows) rig.sideRows.push([i, +side.toFixed(4), +fwd.toFixed(4)]);
        ax2 += Math.abs(side); all++;
        az2 += fwd;
        if (axisSel[i] !== 1) continue;
        sx += Math.abs(side); sz += fwd; sy += up; sxs += side; cnt++;
        /* ★ t30：左右分袖 + 前后拆成正负两半（`fwdC` 带符号，正 = 朝前进方向） */
        {
            const box = axisSign[i] >= 0 ? L_side : R_side;
            box.s += side;
            if (fwdC > 0) box.fin += fwdC; else box.back += -fwdC;
            box.n++;
        }
        if (Math.abs(side) > mx) mx = side;
        if (fwd > mz) mz = fwd;
        if (Math.abs(side) > fwd) over++;
    }
    const m = cnt ? 1 / cnt : 0;
    const ma = all ? 1 / all : 0;
    /* ★ t30：左右袖各自的「侧向 / 前后」比值，分母 = 前向 + 后向（各自取正再相加） */
    const mLS = L_side.n ? 1 / L_side.n : 0;
    const mRS = R_side.n ? 1 / R_side.n : 0;
    const sideL = +(L_side.s * mLS).toFixed(5);
    const sideR = +(R_side.s * mRS).toFixed(5);
    const finL = +(L_side.fin * mLS).toFixed(5);
    const finR = +(R_side.fin * mRS).toFixed(5);
    const backL = +(L_side.back * mLS).toFixed(5);
    const backR = +(R_side.back * mRS).toFixed(5);
    const rL = L_side.n && (finL + backL) > 1e-6 ? +(sideL / (finL + backL)).toFixed(3) : 0;
    const rR = R_side.n && (finR + backR) > 1e-6 ? +(sideR / (finR + backR)).toFixed(3) : 0;
    return {
        sideL, sideR, finL, finR, backL, backR,
        nL: L_side.n, nR: R_side.n,
        ratioL: rL, ratioR: rR,
        ratioLR: +(0.5 * (rL + rR)).toFixed(3),
        moved: movedN,        // 侧向偏移 > 2 cm 的袖骨根数（按根判定，不受均值稀释）
        outN,
        ...measureSpan(rig),
        outTop: +outs.sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0).toFixed(4),
        rowsX: rig.sideRows && rig.sideRows.length ? rig.sideRows.slice(-rig.n) : undefined,
        x: +(sx * m).toFixed(5), z: +(sz * m).toFixed(5), y: +(sy * m).toFixed(5),
        xSigned: +(sxs * m).toFixed(5), n: cnt,
        xMax: +mx.toFixed(5), zMax: +mz.toFixed(5), xOverZ: over,
        xAll: +(ax2 * ma).toFixed(5), zAll: +(az2 * ma).toFixed(5), nAll: all,
    };
}

/* ── ★ t16：袖向姿态读数（**不受 `carry` / 风影响**，与走向无关）──────────────
 *  为什么不用 `measureSleeve()` 判「走向无关性」：
 *    `measureSleeve` 量的是「粒子相对动画姿势尾位」的**世界**位移，而求解器每帧把
 *    `carry × 速度 × dt` 平移到 `particle` 与 `particlePrev` 上（见 `carry` 的注释）。
 *    于是这个位移里必然含一份**沿行走方向**的偏置 ⇒ 朝 +X 走与朝 +Z 走读数天然不同，
 *    那反映的是「她朝哪走」，不是「袖子往哪飘」。
 *  这份读数只看`_vRest`（弹簧目标方向）相对**动画静止方向**的偏角分解：
 *    `sideDeg` = 目标方向在角色侧向轴上偏了多少度（正 = 朝该骨自己那一侧张开）；
 *    `fwdDeg`  = 在前后轴上的偏角；
 *    `upDeg`   = 竖直分量变化。
 *  `_vRest` 只由动画姿态与我们的侧摆/外撑旋转决定 ⇒ 与 `carry`、风、走向全部无关，
 *  正是「袖子朝哪飘」本身。
 */
export interface SleevePose {
    /** 参与统计的袖骨根数 */
    n: number;
    /** 绕角色前后轴的平均偏角（度）：正 = 朝该骨自己那一侧张开（= 向两侧飘） */
    sideDeg: number;
    /** 绕角色侧向轴的平均偏角（度，取绝对值）：这就是「随手臂前后摆」的幅度 */
    fwdDeg: number;
    /** 每一根「朝外」的分布：min / median / max（度），用来证明不是个别骨在动 */
    sideMin: number;
    sideMed: number;
    sideMax: number;
    /** 侧向偏角 ≥ 10° 的骨数（**主判据**：走向无关时应两组相同） */
    sideOver10: number;
    /** 静止目标相对动画方向的总偏角（度，不分轴）= 我们的侧摆/外撑一共把袖子挪了多少 */
    backDeg: number;
    /** ★ 十四轮：本帧把侧摆增量真正叠进写回四元数的骨数。
     *  `n>0` 而 `sideApplied===0` ⇒ 通道算了但没落地（正是修复前的老症状）。 */
    applied: number;
    /** ★ 十六轮：**裙摆下摆**通道本帧作用的骨数（`?sechemwind=`/`?sechemfwd=` 是否建起来的判据） */
    hemN: number;
    /** 下摆高度权重之和（= Σ wgt×走起来程度），0 表示整块没生效 */
    hemW: number;
    /** 下摆骨沿角色**前后轴**的平均偏移（米，正 = 向前）。负得很厉害就是「往后飘」 */
    hemFwd: number;
    /** ★ 十七轮：本帧被「摆臂相位」调制的袖骨数（`?secsideosc=` 是否真在跑） */
    oscN: number;
    /** ★ 十七轮：左/右两侧本帧的摆臂相位（−1..+1）。两数应**反相**（一正一负），
     *  否则说明相位源接错了（例如接回只有标量的 `sideRollNorm`）。 */
    oscPhL: number;
    oscPhR: number;
    /** ★ 十七轮：摆动量（−1..+1，已扣直流），`sideDeg` 应随它上下摆 */
    oscSwing: number;
    /** ★ 十七轮诊断：左右前臂前后投影的**原始**值（含直流偏置） */
    oscRawL: number;
    oscRawR: number;
    /** ★ 十七轮诊断：扣掉直流后的残差（这才是相位来源） */
    oscResid: number;
    /** ★ 十七轮：**单侧**侧展角均值（度）—— 两侧相位相反，混算会互相抵消，
     *  判「往复」必须看这两个数的随时间变化，不能用 `sideDeg`。 */
    sideDegL: number;
    sideDegR: number;
}

/** 量**裙摆下摆**沿前后轴偏了多少米（用户 m11430 任务3 的判据），与 `measureSleevePose` 同源口径。
 *  做法：下摆骨的 `restDirWorld` 相对 `animDirWorld` 在**前后轴**上的投影差 × 骨长，
 *  按高度权重加权求平均 —— 直接给「下摆平均被挪到前/后多少米」。 */
export function measureHemPose(rig: SecondaryRig | null): { n: number; fwdM: number; backM: number; wgt: number } {
    const out = { n: 0, fwdM: 0, backM: 0, wgt: 0 };
    if (!rig || !rig.primed || !rig.hemSel) return out;
    const { n, restDirWorld, animDirWorld, restLen, hemWgt } = rig;
    _mRot.extractRotation(rig.root.matrixWorld);
    _qParent.setFromRotationMatrix(_mRot);
    _vFwdFlat.set(rig.fwdLocal[0], rig.fwdLocal[1], rig.fwdLocal[2]).applyQuaternion(_qParent).normalize();
    let ws = 0, fsum = 0;
    for (let i = 0; i < n; i++) {
        if (rig.hemSel[i] !== 1) continue;
        const w = hemWgt[i];
        if (!(w > 0.05)) continue;
        const k = i * 3;
        const dfx = restDirWorld[k] - animDirWorld[k];
        const dfy = restDirWorld[k + 1] - animDirWorld[k + 1];
        const dfz = restDirWorld[k + 2] - animDirWorld[k + 2];
        const proj = (dfx * _vFwdFlat.x + dfy * _vFwdFlat.y + dfz * _vFwdFlat.z) * restLen[i];
        fsum += proj * w;
        ws += w;
        out.n++;
    }
    if (ws > 1e-9) {
        out.fwdM = +(fsum / ws).toFixed(4);       // 正 = 向前
        out.backM = +(-fsum / ws).toFixed(4);     // 正 = 向后（老行为的方向）
        out.wgt = +ws.toFixed(3);
    }
    return out;
}

export function measureSleevePose(rig: SecondaryRig | null): SleevePose {
    const out: SleevePose = { n: 0, sideDeg: 0, fwdDeg: 0, sideMin: 0, sideMed: 0, sideMax: 0, sideOver10: 0, backDeg: 0, applied: 0, hemN: 0, hemW: 0, hemFwd: 0, oscN: 0, oscPhL: 0, oscPhR: 0, oscSwing: 0, oscRawL: 0, oscRawR: 0, oscResid: 0, sideDegL: 0, sideDegR: 0 };
    if (!rig || !rig.primed) return out;
    const { n, restDirWorld, animDirWorld } = rig;
    _mRot.extractRotation(rig.root.matrixWorld);
    _qParent.setFromRotationMatrix(_mRot);
    _vFree.set(rig.sideLocal[0], rig.sideLocal[1], rig.sideLocal[2]).applyQuaternion(_qParent).normalize();
    _vFwdFlat.set(rig.fwdLocal[0], rig.fwdLocal[1], rig.fwdLocal[2]).applyQuaternion(_qParent).normalize();
    const vals: number[] = [];
    let fwdSum = 0, backSum = 0, spread = 0;
    const valsL: number[] = [], valsR: number[] = [];
    let sumL = 0, sumR = 0, nL = 0, nR = 0;
    for (let i = 0; i < n; i++) {
        if (rig.secdriveSel[i] !== 1) continue;
        const k = i * 3;
        const ax = animDirWorld[k], ay = animDirWorld[k + 1], az = animDirWorld[k + 2];
        const rx = restDirWorld[k], ry = restDirWorld[k + 1], rz = restDirWorld[k + 2];
        if (!(ax * ax + ay * ay + az * az > 1e-9)) continue;
        /* ★ t16 口径：量「我们的侧摆/外撑把静止目标从动画方向转了多少」，再按轴拆。
         *  基准 `animDirWorld`（动画姿势）与结果 `restDirWorld`（求解器实际用的目标）
         *  都是世界方向、都不经 `carry`/风 ⇒ **与角色走向无关**。
         *  ① `signed` = 绕前后轴 `_vFwdFlat` 的旋转角（度）：绕前后轴转 = 在侧向上张开、
         *     符号取该骨的绑定左右侧（`sideLocal` 投影），正 = 朝它自己那一侧张；
         *  ② `fwdPart` = 绕侧向轴 `_vFree` 的旋转角：这就是「前后摆」；
         *  ③ `spread` = 目标方向相对动画方向的总偏角（不分轴）。 */
        const as = ax * _vFree.x + ay * _vFree.y + az * _vFree.z;
        const af = ax * _vFwdFlat.x + ay * _vFwdFlat.y + az * _vFwdFlat.z;
        const rs = rx * _vFree.x + ry * _vFree.y + rz * _vFree.z;
        const rf = rx * _vFwdFlat.x + ry * _vFwdFlat.y + rz * _vFwdFlat.z;
        // 绕前后轴的角度差（侧向张角）
        /* 符号：把「该骨动画方向的侧向指向」定成正方向。
         *  袖骨在绑定姿势里本来就挂身体两侧，`as` 是它动画状态下的侧向分量；
         *  张得更开 ⇒ 结果侧向分量同号且更大 ⇒ sideAng 为正。
         *  （不能用 `axisSign`：那是绑定左右侧，同一个值两边方向相反。） */
        const rawSide = Math.atan2(rs * -ay + ry * as, rs * as + ry * ay) * 57.29578;
        const sideAng = rawSide * ((as !== 0 ? as : rs) < 0 ? -1 : 1);
        // 绕侧向轴的角度差（前后摆）
        const fwdAng = Math.atan2(rf * -ay + ry * af, rf * af + ry * ay) * 57.29578;
        const dot = Math.max(-1, Math.min(1, ax * rx + ay * ry + az * rz));
        const tot = Math.acos(dot) * 57.29578;
        vals.push(sideAng);
        /* ★ 十七轮：按侧分开累加 —— 两侧相位相反，混在平均里会**互相抵消**，
         *  于是 `sideDeg` 看起来「纹丝不动」。要证明往复，必须看单侧。 */
        {
            const sd1 = rig.sideOf[i];
            if (sd1 === 0) { valsL.push(sideAng); sumL += sideAng; nL++; }
            else if (sd1 === 1) { valsR.push(sideAng); sumR += sideAng; nR++; }
        }
        if (rig.sideRows) rig.sideRows.push([i, +sideAng.toFixed(2), +fwdAng.toFixed(2)]);
        fwdSum += Math.abs(fwdAng);
        spread += tot;
        backSum += Math.max(0, -rf);
    }
    if (!vals.length) return out;
    vals.sort((a, b) => a - b);
    out.n = vals.length;
    out.sideMin = +vals[0].toFixed(2);
    out.sideMed = +vals[vals.length >> 1].toFixed(2);
    out.sideMax = +vals[vals.length - 1].toFixed(2);
    out.sideDeg = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
    out.fwdDeg = +(fwdSum / vals.length).toFixed(2);
    /* ★ 十七轮：分侧均值（这才是「往复」的可见读数） */
    out.sideDegL = nL ? +(sumL / nL).toFixed(2) : 0;
    out.sideDegR = nR ? +(sumR / nR).toFixed(2) : 0;
    out.sideOver10 = vals.filter((v) => v >= 10).length;
    out.backDeg = +(spread / vals.length).toFixed(2);
    out.applied = rig.sideApplied;
    /* ★ 十六轮：顺带把下摆通道的读数一并带出（同一个探针就能判两条通道）。 */
    out.hemN = rig.hemN;
    out.hemW = +rig.hemW.toFixed(2);
    const hp = measureHemPose(rig);
    out.hemFwd = hp.fwdM;
    /* ★ 十七轮：侧展角往复的读数（判据：`oscN > 0` 且 `oscPhL / oscPhR` **符号相反**）。 */
    out.oscN = rig.sideOscN || 0;
    out.oscPhL = +(rig.sideOscPh ? rig.sideOscPh[0] : 0).toFixed(3);
    out.oscPhR = +(rig.sideOscPh ? rig.sideOscPh[1] : 0).toFixed(3);
    out.oscSwing = +(rig.sideOscSwing || 0).toFixed(3);
    out.oscRawL = rig.sideOscRaw ? +rig.sideOscRaw[0].toFixed(3) : 0;
    out.oscRawR = rig.sideOscRaw ? +rig.sideOscRaw[1].toFixed(3) : 0;
    out.oscResid = rig.sideOscR ? +rig.sideOscR[0].toFixed(4) : 0;
    return out;
}

/* ── 袖 ↔ 衣（前襟 / 裙摆）互穿：只统计含袖骨的对，回答「侧飘有没有解决穿模」── */export interface SleeveClash {
    /** 参与比较的袖骨根数 */
    sleeve: number;
    /** 袖骨 ↔ 非袖骨的对数 */
    pairs: number;
    /** 最近距离（米） */
    minDist: number;
    minPair: string | null;
    /** 距离 < 1 / 2 / 5 cm 的对数 */
    under1: number;
    under2: number;
    under5: number;
    worst: ClashHit[];
    /** ★ t20 诊断：参与判据的袖骨（已排除 `*錘` 零权重端点骨）及其父骨世界 y（米）。 */
    sleeveY?: Array<[string, number]>;
}

export function auditSleeveClash(rig: SecondaryRig | null, under5 = 0.05, top = 12): SleeveClash {
    const out: SleeveClash = {
        sleeve: 0, pairs: 0, minDist: Infinity, minPair: null,
        under1: 0, under2: 0, under5: 0, worst: [],
    };
    if (!rig) return out;
    const { n, bones, secdriveSel, particle } = rig;
    if (!rig.primed) return out;
    for (let i = 0; i < n; i++) if (secdriveSel[i] === 1) out.sleeve++;
    const H = new Float32Array(n * 3), T = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const p = bones[i]?.parent;
        if (p) { const e = p.matrixWorld.elements; H[i * 3] = e[12]; H[i * 3 + 1] = e[13]; H[i * 3 + 2] = e[14]; }
        T[i * 3] = particle[i * 3]; T[i * 3 + 1] = particle[i * 3 + 1]; T[i * 3 + 2] = particle[i * 3 + 2];
    }
    const hits: ClashHit[] = [];
    /* ★★★ t20：**排除 `*錘` 端点骨**。
     *  实测最差对全是 `Bone_ArmLets0x_*錘 × Skirt_*` —— 这几根骨在模型里**权重为 0**
     *  （`pre-sleeve-skin.js` 实测：`01_L` 389 顶点、`02_L` 52 顶点，四个 `*錘` 全是 0），
     *  它们不驱动任何顶点，骨棒「最近距离」只是两个数学点挨着，画面上没有任何东西碰。
     *  把它们计入判据会让净距数字由一根不渲染的骨决定（t16 的 0.00888 就是这么来的：
     *  最差对 `Bone_ArmLets01_R錘 × Skirt_*`）。
     *  排除后判据只统计真正参与蒙皮的袖骨，与「袖片会不会擦到裙摆」一一对应。
     *  轮廓骨名一律以 `錘` 结尾（PMX 的习惯），用后缀判即可，不依赖具体编号。 */
    const isGhost = (nm: string): boolean => nm.endsWith('錘') || nm.endsWith('锤');
    for (let i = 0; i < n; i++) {
        if (secdriveSel[i] !== 1) continue;
        if (isGhost(bones[i]?.name ?? '')) continue;
        if (!Number.isFinite(T[i * 3])) continue;
        for (let j = 0; j < n; j++) {
            if (j === i || secdriveSel[j] === 1) continue;   // 只比「袖 ↔ 非袖」
            if (isGhost(bones[j]?.name ?? '')) continue;
            if (!Number.isFinite(T[j * 3])) continue;
            out.pairs++;
            const d1 = _p2seg(T[i * 3], T[i * 3 + 1], T[i * 3 + 2],
                H[j * 3], H[j * 3 + 1], H[j * 3 + 2], T[j * 3], T[j * 3 + 1], T[j * 3 + 2]);
            const d2 = _p2seg(T[j * 3], T[j * 3 + 1], T[j * 3 + 2],
                H[i * 3], H[i * 3 + 1], H[i * 3 + 2], T[i * 3], T[i * 3 + 1], T[i * 3 + 2]);
            const d = d1 < d2 ? d1 : d2;
            if (d < 0.01) out.under1++;
            if (d < 0.02) out.under2++;
            if (d < under5) out.under5++;
            if (d < out.minDist) {
                out.minDist = d;
                out.minPair = (bones[i]?.name ?? '?') + ' × ' + (bones[j]?.name ?? '?');
            }
            if (d < under5) hits.push({ a: bones[i]?.name ?? '?', b: bones[j]?.name ?? '?', ga: 1, gb: 0, d });
        }
    }
    hits.sort((a, b) => a.d - b.d);
    out.worst = hits.slice(0, top);
    if (!Number.isFinite(out.minDist)) out.minDist = -1;
    /* ★★ t20 诊断：把参与判据的袖骨（已排除 `*錘`）的**父骨世界 y** 一起返回，
     *  用来确定 `?secsidehlo=` / `?secsidehhi=` 该取多少（阶段 1 标定用）。 */
    out.sleeveY = [];
    for (let i = 0; i < n; i++) {
        if (secdriveSel[i] !== 1) continue;
        if (isGhost(bones[i]?.name ?? '')) continue;
        out.sleeveY.push([bones[i]?.name ?? '?', +(H[i * 3 + 1] || 0).toFixed(3)]);
    }
    return out;
}

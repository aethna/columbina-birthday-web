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
    /** 角色位移补偿系数。缺省 1 —— 见 `SecondaryOptions.carry` 的长注释 */
    carry: number;
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
const _qR = new THREE.Quaternion();
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
    /** 上限，防止弱机上一次性处理几百根 */
    maxBones?: number;
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
    const gravity = opts.gravity ?? 9.8;
    const drag = Math.min(0.95, Math.max(0, opts.drag ?? 0.25));
    const wind = Math.max(0, opts.wind ?? 6);
    const windFront = Math.max(0, Math.min(2, opts.windFront ?? 0));   // 前侧布片的风力系数，见 windFront 的注释
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
        limit[i] = (isHair ? limitDeg * 1.5 : isSkirt ? limitDeg : limitDeg * 0.9) / DEG;
        stiff[i] = isHair ? stiffness * 1.4 : isSkirt ? stiffness * 0.75 : stiffness;
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
    const driveSel = new Uint8Array(n);
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
         */
        if (driveAmp > 0) {
            const armRe = /^(左|右)(腕|ひじ|手首)/;
            for (let i = 0; i < n; i++) {
                let p: THREE.Object3D | null = bones[i].parent;
                let g2 = 0;
                while (p && p !== rootObj && g2++ < 12) {
                    if (armRe.test(p.name)) { driveSel[i] = 1; break; }
                    p = p.parent;
                }
                if (driveSel[i] === 0 && axisSel[i] === 0 && axisSign[i] > 0) driveSel[i] = 2;
            }
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
        particle, particlePrev, limit, stiffness: stiff, keep, gravity, wind, windFront, carry,
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
        driveSel, driveAmp, driveLead, driveFwd: 0, driveArm: 0, driveN: 0, driveRaw: 0, driveArmRaw: 0,
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
        driveSel, driveAmp, driveLead, _driveRate, _drivePrev, _limbSwing, _limbMin, _limbMax, _qDrive, _limbRef, limbA, limbB } = rig;
    const d = Math.min(Math.max(dt, 1 / 240), 1 / 30);
    const gStep = rig.gravity * d * d;
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
    // ②b ★★ 方向性约束的轴：把「角色朝向 / 侧向」从骨架根局部空间旋到世界空间。
    //     每帧一次即可（整根骨树共用一个朝向）。见 `SecondaryRig.fwdLocal` 的注释。
    if (rig.antiOn || driveAmp > 0) {
        _mRot.extractRotation(rig.root.matrixWorld);
        _qRoot.setFromRotationMatrix(_mRot);
        _vFwd.set(fwdLocal[0], fwdLocal[1], fwdLocal[2]).applyQuaternion(_qRoot).normalize();
        _vSide.set(sideLocal[0], sideLocal[1], sideLocal[2]).applyQuaternion(_qRoot).normalize();
    }
    rig.antiHits = 0;
    rig.antiMaxDeg = 0;

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

    // ④′ ★ 布-布斥力的邻接表：按**当前帧**位置定期重建（布片是会互相扫到的，
    //     静止姿势定的表会漏掉「走起来才碰面」的那些对）
    if (rig.repelD > 0 && rig.repelReady && --rig.repelNext <= 0) rebuildRepel(rig);

    // ④ ★ 碰撞体的世界表示每帧刷新一次（挂在骨头上，跟着动画走）
    if (rig.collide) stepColliders(rig);

    let maxDev = 0, sumDev = 0, cnt = 0;

    for (let i = 0; i < n; i++) {
        const b = bones[i];
        const parent = b.parent;
        if (!parent) continue;
        const L = restLen[i];

        // 父骨的世界原点 + 世界朝向（父骨若也是物理骨，上一轮已经更新过它的矩阵）
        _mRot.extractRotation(parent.matrixWorld);
        _qParent.setFromRotationMatrix(_mRot);
        _vHead.setFromMatrixPosition(parent.matrixWorld);

        // 静止方向 = 父骨**当前**朝向 × 局部方向
        _vRest.set(restDirLocal[i * 3], restDirLocal[i * 3 + 1], restDirLocal[i * 3 + 2])
            .applyQuaternion(_qParent).normalize();

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

        const hx = _vHead.x, hy = _vHead.y, hz = _vHead.z;

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
        const wf = (axisSel[i] === 0 && axisSign[i] > 0) ? windFront : 1;
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
                        const s = rodSamples > 1 ? sMin + (1 - sMin) * (k / (rodSamples - 1)) : 1;
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
        _vDir.set(dx, dy, dz);
        _qR.setFromUnitVectors(_vRest, _vDir);
        _qW.copy(_qParent).multiply(animLocal[i]).premultiply(_qR);
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

    void _vFree;
    rig.devDeg = maxDev * DEG;
    rig.meanDevDeg = cnt ? (sumDev / cnt) * DEG : 0;
    rig.peakDevDeg = Math.max(rig.devDeg, rig.peakDevDeg * 0.98);
    rig.lastMs = performance.now() - _t0;
}

/** 让她重新起势（传送 / 重新开始时用，避免从上一处的姿态甩过来） */
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
            const visR = R / Math.max(1e-6, rig.colScale * (rig.colMul[j] || 1)) * visScale;   // 参照恒为「原始 PMX 半径 × visScale」
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
            const visR = R / Math.max(1e-6, rig.colScale * (rig.colMul[j] || 1)) * visScale;   // 参照恒为「原始 PMX 半径 × visScale」
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

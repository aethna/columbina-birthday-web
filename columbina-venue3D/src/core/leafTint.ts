/**
 * leafTint.ts —— 「只染叶子、不动树干」的换色工具（用户 m05645）。
 *
 * 目标叶色取自游戏截图：
 *   · 钴蓝 `#5984c4`   —— `公用区\背景素材\素材\背景素材2.png` 树冠受光面中位色
 *   · 青绿 `#147e91`   —— `公用区\背景素材\素材\背景素材4.png` 树冠受光面中位色
 *
 * ── 判据 Y：`colorNode` 换色三件套 ──────────────────────────────────
 * ① **写了 `colorNode` 就必须自己把贴图乘回来**。
 *    `three/src/materials/nodes/NodeMaterial.js:880`
 *      `let colorNode = this.colorNode ? vec4( this.colorNode ) : materialColor;`
 *    这是**整个替换** `color × map`，不是叠加。不乘 `map` 的话叶子会变成一块
 *    没有任何叶脉/疏密的纯色板。
 * ② **BLEND 材质必须给 `vec4(rgb, tex.a)`**。给 `vec3` 时 `vec4(vec3)` 的 a = 1，
 *    透明的叶片会变成**不透明板子**。
 * ③ **换色相要把贴图转成亮度再乘目标色**，不能直接「原色 × 蓝」——
 *    原来的绿色 (0.2,0.5,0.15) 乘蓝色 (0.35,0.52,0.77) 出来是**发黑的墨绿**，
 *    因为绿通道被蓝通道 0.52 拖下去了。转亮度（Rec.709）之后贴图只保留明暗，
 *    色相完全由目标色决定，叶脉与疏密照样保留。
 *
 * ── 为什么用平坦自发光而不是「亮度遮罩自发光」 ──────────────────────
 * 会场是**月夜**，入射光极弱。实测 `?leafgain=` 从 1.0 加到 2.5 画面几乎不动
 * ⇒ albedo 那一支撑不起亮度，想要参考图那种明亮叶色**只能靠自发光**。
 * 试过 `emissiveNode = tint * lum`：夜里自然了，但白天叶子暗到看不出青绿/蓝 ⇒ 否决。
 * 代价是 `?hour=0` 深夜叶子偏亮，用 `?leafemis=` 随时压。
 */
import * as THREE from 'three/webgpu';
import { vec3, vec4, float, dot, smoothstep, texture, uv, positionLocal, positionWorld, cameraPosition, length, mix, attribute, time, sin, uniform, Fn } from 'three/tsl';

export const LEAF_TINTS = ['#5984c4', '#147e91'] as const;

/* ══════════════════════════════════════════════════════════════════════════
 * 顶点风（树冠随风摆动）
 *
 * ── 为什么不用现成库（用户 m02804 让我自己决定要不要引入 ez-tree）────────
 * `@dgreenheck/ez-tree` 值钱的是「顶点风 + LOD」两件事，但它是「运行时按参数生成
 * 它自己的树」，而我们的树是照参考图（光杆 + 冠球）烘出来的 GLB —— 接进来等于换树形。
 * 风本身是十行着色器，自己写反而可控。
 *
 * ── ⚠️⚠️ 为什么风要写在 `positionNode` 里、而且必须用两套坐标 ────────────
 * `three/src/materials/nodes/NodeMaterial.js:842` 先 `instancedMesh(object).toStack()`
 * （`InstanceNode.js:208` 做 `instanceMatrixNode.mul(positionLocal).xyz` 并 assign 回
 * `positionLocal`），`:848` 之后才应用 `positionNode`。所以在 `positionNode` 内部：
 *   · `positionLocal` —— **已经乘过实例矩阵**，≈ 世界坐标 ⇒ 拿它算**相位**
 *     （每棵树相位不同，否则整片森林像一块布整体摆）。
 *   · `attribute('position')` —— 仍是**原始局部坐标**。GLB 都做过
 *     `--normalize`（高度归一到 1.0 m），所以它的 y ∈ [0,1] = **离地高度比例**
 *     ⇒ 拿它算**振幅**（根部纹丝不动、树冠摆幅最大）。
 * 两套坐标各司其职，缺一个就会出「整片森林同步平移」或「树根在地上滑」。
 *
 * ── 相位为什么用 x/z 而不是实例序号 ──────────────────────────────────────
 * 实例序号要额外接 `instanceIndex`（本项目没用过，风险未知）；x/z 是现成的，
 * 且相邻树的相位天然不同 —— 风本来就是空间相关的。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 树顶最大摆幅（世界单位 = 米）。`?windamp=` 可改。
 *
 * ⚠️ 2026-10-13 用户反馈「风吹动树冠时，树冠的摆动幅度太大了」：
 * 原值 0.34 m 是**树顶单向最大位移**，而 `windOffset` 里两个正弦叠加后
 * `gust` 的峰值可达 0.62+0.38 = 1.0 ⇒ 实际摆幅 ≈ ±0.34 m，也就是**峰峰 0.68 m**。
 * 对于冠幅只有 2~4 m 的树，树冠横向来回晃 68 cm 就像在跳舞。
 * ⇒ 降到 0.14（峰峰约 0.28 m，接近真实微风中树梢的位移量级）。
 *
 * ★ 2026-10-19 用户第二轮反馈「树冠随风摆动幅度过大」，原话是「像被大风吹」：
 *   0.14 依然是**树顶单向峰值**，峰峰 0.28 m。树本身只有 3~5 m 高（乘实例
 *   抖动后 2~7 m），这等于整团树冠横移 **5%~9% 树高** —— 远看不是「叶尖在抖」
 *   而是「冠在平移」。更糟的是树干/树枝**根本不走这套风**（`*_branches` 不匹配
 *   `LEAF_NAME_RE`，只吃 `applyBarkShade`），于是冠相对于枝滑动，读起来像一块
 *   浮在枝上的布被风吹跑。
 *   ⇒ 压到 **0.05**（峰峰约 0.10 m）：叶尖仍有肉眼可辨的轻颤，冠身几乎不位移。
 *   ⚠️ 要再调小请**改这个缺省值**，不要靠 `?windamp=` 糊 —— 用户看的是缺省观感。 */
export const uWindAmp = uniform(0.05);

/** `?wind=0` 关风。**在材质构建期读取**，切换需要重建森林。 */
let LEAF_WIND = 1.0;
export function setLeafWind(on: boolean) { LEAF_WIND = on ? 1.0 : 0.0; }
export function setWindAmp(v: number) { uWindAmp.value = v; }

/**
 * 自发光随距离渐隐的两个半径（米），做成 uniform 以便 `?lefade=` / `?lefar=` 实时改。
 * d ≤ NEAR ⇒ 系数 1（近处叶子照旧亮）；d ≥ FAR ⇒ 系数 0（自发光完全退掉，只剩雾）。
 * 与 `WorldController` 的森林雾（NEAR 42 / FAR 70）对齐：雾还没起效的近处不该被削，
 * 雾已经吃掉一切的远处不该再自己发亮。
 */
export const uEmisFadeNear = uniform(30.0);
export const uEmisFadeFar = uniform(85.0);
export function setEmisFade(near: number, far: number) {
    uEmisFadeNear.value = Math.max(0.001, near);
    uEmisFadeFar.value = Math.max(uEmisFadeNear.value + 0.001, far);
}

/** 风向（单位向量，固定；只有大小在变）。 */
const WIND_DIR_X = 0.86;
const WIND_DIR_Z = 0.51;

/**
 * 风位移节点。返回「相对当前 `positionLocal` 的偏移」，直接加即可。
 *
 * 两个正弦叠加（慢摆 + 细颤）——单个正弦看着像机械摆动，
 * 叠一个高频小幅之后才有「风一阵一阵」的感觉。
 *
 * ★ 2026-10-19：高频那一支从 `3.40 rad/s × 0.38` 降到 `2.60 × 0.30`，主摆从
 *   1.55 降到 1.30。幅度收敛之后（见 `uWindAmp`），**频率成了第二个「像大风吹」
 *   的来源**：0.54 Hz 的细颤在高对比的叶色上读作「抖」，而真实微风里的树梢是
 *   0.2~0.4 Hz 的慢摆。权重仍归一化到 1.0（0.70+0.30），峰值振幅不变。
 */
function windOffset() {
    // ⚠️ 必须是原始局部坐标（未乘实例矩阵），见上面的说明
    const rawY = attribute('position', 'vec3').y;
    const hN = rawY.clamp(0.0, 1.0);
    // 相位取世界 x/z
    const phase = positionLocal.x.mul(0.31).add(positionLocal.z.mul(0.27));
    const s1 = sin(time.mul(1.30).add(phase));
    const s2 = sin(time.mul(2.60).add(phase.mul(1.73)));
    const gust = s1.mul(0.70).add(s2.mul(0.30));
    // 平方衰减：0.5 高度处只有 1/4 摆幅，根部完全不动
    const amp = hN.mul(hN).mul(uWindAmp).mul(float(LEAF_WIND));
    return vec3(
        gust.mul(amp).mul(WIND_DIR_X),
        gust.abs().mul(amp).mul(-0.05),   // 摆动时略微下沉，避免看着像在拉伸
        gust.mul(amp).mul(WIND_DIR_Z),
    );
}

/**
 * 材质名 → 是不是「叶子」。
 *
 * ⚠️⚠️ **不要用 `/leaf/i`**。`leaf` 的复数是 `leaves`（f → v），
 *     `'island_tree_01_leaves'.indexOf('leaf')` = **-1**。
 *     2026-10-11 因为这个错把「叶子没变色」查了半天（判据 Z / AGENT.md 坑 50）。
 * ⚠️ 针叶树用的是 `_twigs`（`fir_sapling_medium_twigs`），也**不含 leaf** ⇒ 一并收进来。
 */
export const LEAF_NAME_RE = /lea[fv]|twig|needle|foliage|canopy/i;

/**
 * 「剪影卡片」材质：给**没有 alpha 通道**的贴图现场抠出 alpha。
 *
 * ── 为什么需要它（2026-10-11 森林首轮出图全是黑方块）────────────────
 * Poly Haven 的 glTF 把植物的 `alphaMode` 标成 `BLEND`，但 diffuse 是 **JPG**，
 * **根本没有 alpha 通道**（`_tools/glbtex.py` 实测：`img=PNG RGB (512,512) 无 alpha 通道`），
 * 透明部分被烘成了**纯黑**（角落像素 `(0,0,0)`）。
 * 于是每一张草卡/花卡渲出来都是「一块黑矩形里画着一株草」。
 *
 * 修法：用亮度当抠图遮罩 —— 背景 lum≈0.016（黑），植物明显更亮。
 * `smoothstep(0.015, 0.075)` 之后配 `alphaTest = 0.5` ⇒ 实际切在 lum ≈ 0.045，
 * 既能切干净黑底，又不会把深绿色的苔藓切掉。
 *
 * ⚠️ 走 `alphaTest`（MASK）而不是 `transparent`（BLEND）：
 *    一屏 1500 张草卡如果都进 BLEND，排序是**逐实例对象**级别排不出来的，
 *    既慢又会出现前后穿插错误。MASK 只丢弃片元，照常写深度。
 */
export function makeCutoutMaterial(m: any, gain: number, emis: number): THREE.MeshStandardNodeMaterial {
    const node = new THREE.MeshStandardNodeMaterial();
    node.side = m?.side ?? THREE.DoubleSide;
    node.transparent = false;
    node.depthWrite = true;
    node.alphaTest = 0.5;
    node.map = m?.map ?? null;
    node.normalMap = m?.normalMap ?? null;
    const ns = (node as any).normalScale;
    if (m?.normalScale && ns) ns.copy(m.normalScale);
    node.roughness = 1.0;
    node.metalness = 0.0;
    const base = m?.color ? vec3(m.color.r, m.color.g, m.color.b) : vec3(1, 1, 1);
    if (node.emissive) {
        node.emissive.copy(m?.color ?? new THREE.Color(1, 1, 1));
        node.emissiveIntensity = emis;
    }
    if (m?.map) {
        const t = texture(m.map, uv());
        const lum = dot(t.rgb, vec3(0.2126, 0.7152, 0.0722));
        const a = smoothstep(float(0.015), float(0.075), lum);
        node.colorNode = vec4(t.rgb.mul(base).mul(float(gain)), a);
    } else {
        node.colorNode = vec4(base.mul(float(gain)), float(1.0));
    }
    return node;
}

/* ═══ ★★ 叶片明暗（顶点色遮罩）2026-10-12 用户 m02188 ★★ ═══════════════════
 *
 * 用户原话：「我们的树冠糊成一团的原因是，明暗，光影。你看图，树冠下方的叶子是
 *   带阴影的，而上方向阳的则没有。而且，如果树叶本身，加入颜色的明暗光影变化，
 *   就不会糊成一团亮色块」
 *
 * 病根：这一片树冠里**每一片叶子共用同一个 albedo**，而项目没有阴影贴图
 *   （`castShadow = false` 是全项目的性能取舍，`Forest.tsx:223`），
 *   于是整颗冠渲染出来是一块**平色** —— 不管形状做得多密，读起来都是一团。
 *   参考图（`公用区\背景素材\素材\树素材.png`）里冠**下缘**是压暗的、只有向阳面亮，
 *   而且每片叶自己的明暗都不一样 —— 体积感就是从这层明暗来的，不是从轮廓来的。
 *
 * 做法：在 `_tools/treegen.py` 里把三层遮蔽**烘进顶点色**（glTF 的 `COLOR_0`）：
 *   ① 冠内高度（下层被上层树冠遮住）② 到冠轴的距离（里层被外圈叶子挡）
 *   ③ 单片随机（打破「一个亮度色块」）
 *   前端把 albedo 与 emissive **各乘一遍**这个顶点色即可，零额外 draw call。
 *
 * ── ⚠️ 为什么必须带开关，而不是无脑取样 ──────────────────────────────
 * Blender 的 `export_vertex_color` 默认值是 **`MATERIAL`** ——
 *   **材质里没用到顶点色就不导出 COLOR_0**（`_tools/vcolprobe.py` 实测枚举：
 *   `['MATERIAL', 'ACTIVE', 'NAME', 'NONE']`）。
 * 万一某个 GLB 没带上，`attribute('color')` 会取到全 0 ⇒ **整片森林变黑**。
 * 所以只有几何体**真的带** `color` 属性时才把这个节点接进来（`Forest.tsx` 里判定），
 * 紧急情况可以用 URL `?vshade=0` 强制关掉。
 */
let LEAF_VSHADE = 1.0;
export function setLeafVertexShade(on: boolean) { LEAF_VSHADE = on ? 1.0 : 0.0; }

/**
 * 把 GLTFLoader 给的一片叶材质换成「亮度遮罩 × 目标色」的 TSL 节点材质。
 *
 * @param m       源材质（只用来抄 side / transparent / alphaTest / map / normalMap）
 * @param tintHex 目标色（十六进制字符串）
 * @param gain    目标色倍率（albedo 那一支）
 * @param emis    自发光强度（平坦，见文件头）
 */
export function makeLeafMaterial(m: any, tintHex: string, gain: number, emis: number): THREE.MeshStandardNodeMaterial {
    const tint = new THREE.Color(tintHex);
    const node = new THREE.MeshStandardNodeMaterial();

    node.side = m?.side ?? THREE.FrontSide;
    /* ═══ ★★ 2026-10-11 用户 m07134：「现在是小碎叶」—— 真因是叶子**根本没有 alpha** ★★
     *
     * 病灶：Poly Haven 导出这些 GLB 时把 alpha 通道丢了（`_tools/glbtex.py` 实测
     *   `island_tree_03_leaves = PNG RGB (512,512) ⚠️ 无 alpha 通道`，
     *   `tree_small_02_leaves` 同样是 RGB），**透明区被烘成纯黑**。
     *   而 `alphaMode` 仍写着 BLEND ⇒ `tex.a` 恒等于 1 ⇒ 每一片叶子都是**实心四边形**。
     *   看上去就是「一堆小蓝三角插在树上」，枝条也因为盖不住而全露出来。
     *
     * 修法：和 `makeCutoutMaterial` 同一套 —— **用亮度现抠 alpha**。
     *   实测叶图集（`_logs/tex/tree_c/07_tree_small_02_leaves.png`）背景是纯黑
     *   （lum≈0），叶片是深绿（lum 0.2~0.5）⇒ 阈值取在 lum≈0.04 非常干净。
     *   ⚠️ 阈值必须**比草卡低**（草是 0.015~0.075）：树叶有很深的背光叶片，
     *      抬到 0.045 会把暗叶整片切掉，树冠反而更稀。
     *
     * ⚠️ 同时把 BLEND 改成 `alphaTest`（MASK）：一屏几千片叶子进 BLEND 是逐对象排序，
     *    排不出来 ⇒ 前后穿插错乱 + 每帧都要跑一遍透明队列。MASK 只丢弃片元、照常写深度。
     */
    node.transparent = false;
    node.alphaTest = 0.5;
    node.depthWrite = true;
    node.map = m?.map ?? null;
    node.normalMap = m?.normalMap ?? null;
    /* ⚠️ `MeshStandardNodeMaterial extends NodeMaterial`（不是 `MeshStandardMaterial`），
       它**没有 `normalScale` 属性**，直接 `.copy()` 会 `TypeError`；
       而这个 traverse 外面通常包着 try/catch ⇒ 异常被静默吞掉，看着像「条件没命中」。
       2026-10-11 踩过（AGENT.md 坑 49）。 */
    const ns = (node as any).normalScale;
    if (m?.normalScale && ns) ns.copy(m.normalScale);

    node.roughness = 1.0;
    node.metalness = 0.0;

    const tintCol = vec3(tint.r, tint.g, tint.b);
    // 叶片明暗（顶点色 `COLOR_0`，见上面的说明）。关掉时是纯白，乘上去等于没乘。
    const shade = LEAF_VSHADE > 0 ? attribute('color', 'vec3') : vec3(1, 1, 1);

    /* 顶点风：只动**顶点位置**，不动法线（树冠摆 30 cm，法线跟着转反而会闪）。
       `positionNode` 的返回值就是**新的 positionLocal**（`NodeMaterial.js:850`）。 */
    if (LEAF_WIND > 0) {
        node.positionNode = Fn(() => positionLocal.add(windOffset()))();
    }
    if (node.emissive) {
        node.emissive.copy(tint);
        node.emissiveIntensity = emis;
        /* ⚠️ 自发光**也必须吃这层明暗**。
         * 本项目的叶子夜里全靠 `emissiveIntensity` 撑亮度（月夜那 26 棵树要 2.0），
         * 若自发光保持平坦，它会把刚烘出来的对比度整个抹平 —— 又回到「一团亮色块」，
         * 而且**越暗的时段越糊**（用户那张截图就是 04:27 拍的）。
         * 走 `emissiveNode` 时 `emissiveIntensity` 不再参与，所以这里自己乘 `emis`。
         *
         * ── ⚠️⚠️ 距离渐隐（2026-10-13 用户 m04061「远处树冠 + 雾，雾像是在自发光」）──
         * 根因：`node_modules/three/src/materials/nodes/NodeMaterial.js:1203`
         *   `setupOutput()` 里 `outputNode = this.setupFog( builder, outputNode );`
         * 雾是在**最后**叠上去的，也就是叠在自发光**之上**；而自发光**不吃距离衰减**。
         * ⇒ 远处的树冠不管多远都保持满亮度，雾再盖上去就成了「雾里透出亮的轮廓」，
         *   看着正像雾自己在发光。
         *
         * 修法：给自发光乘一个「离相机越远越弱」的系数，让远处叶子的亮度退回
         * 与雾差不多的水平，雾就能正常把它吃掉。
         * `smoothstep(FAR, NEAR, d)`：d ≤ NEAR 时 = 1（近处照旧亮），d ≥ FAR 时 = 0。
         * 取 NEAR=45 / FAR=110 与森林雾（`WorldController` 的 `FOREST_FOG_NEAR=42` /
         * `FOREST_FOG_FAR=70`）大致对齐。 */
        const viewDist = length(positionWorld.sub(cameraPosition));
        /* ⚠️⚠️ `smoothstep(edge0, edge1, x)` **要求 edge0 < edge1**（GLSL 规范），
         * 反过来传（edge0=远、edge1=近）是**未定义行为** —— 实测在不同驱动上
         * 要么恒 0 要么恒 1，改了参数却看不出任何变化，正是这个坑。
         * ⇒ 老老实实写 `smoothstep(near, far, d)`（近处 0、远处 1）再 `oneMinus`。 */
        const emisFade = smoothstep(uEmisFadeNear, uEmisFadeFar, viewDist).oneMinus();
        node.emissiveNode = tintCol.mul(shade).mul(float(emis)).mul(emisFade);
    }
    if (m?.map) {
        const t = texture(m.map, uv());
        // Rec.709 亮度当遮罩：只留明暗，色相完全由 tintCol 决定
        const lum = dot(t.rgb, vec3(0.2126, 0.7152, 0.0722));
        // 同一个亮度再抠一次 alpha（贴图没有 alpha 通道，见上面的说明）
        const a = smoothstep(float(0.010), float(0.060), lum);
        node.colorNode = vec4(tintCol.mul(lum).mul(shade).mul(float(gain)), a);
    } else {
        node.colorNode = vec4(tintCol.mul(shade).mul(float(gain)), float(1.0));
    }
    return node;
}

/**
 * 树干「高度遮蔽」：**在源材质上就地挂 `colorNode`**，不重建材质。
 *
 * ── 为什么需要它（2026-10-11 用户 m08938「树干不是自发光」）──────────
 * 先澄清：树干**本来就没有 emissive** —— `_tools/treegen.py` 导出的 GLB 里
 * `emissiveFactor` 是 `None`（= 全黑），`Forest.tsx` 走 `add(0, src, null)` 那个分支，
 * `FOREST_EMIS` 是给**剪影卡片**（草/花）用的，树干拿不到。
 *
 * 用户看到的「发白 / 发平」另有原因，而且是两条叠加：
 *   ① **全项目没有任何阴影**。`castShadow = receiveShadow = false` 出现在
 *      `Forest.tsx:209`、`VenuePropsReal.tsx:219`、`RegionProps.tsx:265`……
 *      连 `renderer.shadowMap` 都没开（这是全项目的性能取舍，不能只为树开）。
 *      ⇒ 树干的每一个横截面收到的光**完全相同**，一根圆柱看着就是一条**平的色带**。
 *   ② 树皮源头贴图是 `japanese_camphor_bark_diff_1k__pale_L190_S30.png`，
 *      亮度 190、饱和度 30 —— **本身就已经很亮**。
 *
 * 修法（**零额外几何、零额外 draw call**）：按**实例的局部高度**做一次渐暗 ——
 * 根部最暗、往树冠方向回到正常。这在真实森林里是「下层被上层树冠遮住」的遮蔽，
 * 视觉上立刻把一根平色带变成有体积感的圆柱。
 *
 * ── ⚠️⚠️ 为什么是「就地改」而不是「新建材质」（这一条是用一次全灭换来的）─────
 * 第一版写成了 `new THREE.MeshStandardNodeMaterial()` + `node.map = m.map` +
 * `texture(m.map, uv())`，结果**整个森林从场景里消失**，出图只剩地面。
 * 页面 console 抓到：
 *     `[error] THREE.WebGPURenderer: Unsupported texture type with RGBFormat. 1009`
 *     `[warning] THREE.WebGPURenderer: Texture format not supported.`
 * 根因：**树皮贴图是 JPEG（RGB 三通道、无 alpha）**。走 GLTFLoader 的标准路径时
 * three 会自己处理这个格式；一旦自己 `texture()` 取样，就把它推进了 **RGBFormat**
 * 这条路，而这个 WebGPU 后端不认 ⇒ 实例化网格一个都不出（且**不抛异常**，只是静默不画）。
 * 叶子那边没踩到是因为叶子用 `leaf_atlas_*.png`（**RGBA**）。
 * ⇒ 所以在**源材质**（GLTFLoader 建的 `MeshStandardNodeMaterial`）上就地挂 `colorNode`。
 *
 * @param m        GLTFLoader 给的源材质（原地修改）
 * @param tint     树皮基调色
 * @param aoFloor  根部最暗处保留的比例（0.45 = 压掉 55%）
 * @param aoTop    归一化到多高时回到 1.0（**模型局部单位**）
 * @param gain     albedo 倍率
 */
export function applyBarkShade(
    m: any,
    tint: THREE.Color,
    aoFloor: number,
    aoTop: number,
    gain: number,
): void {
    if (!m) return;
    const tintCol = vec3(tint.r, tint.g, tint.b);
    // 根部暗、越往上越亮，到 aoTop 之后完全恢复
    const hy = positionLocal.y.div(float(Math.max(0.5, aoTop))).clamp(0.0, 1.0);
    const ao = mix(float(aoFloor), float(1.0), hy);
    const base = tintCol.mul(ao).mul(float(gain));
    if (m.map) {
        const t = texture(m.map, uv());
        // ⚠️ `NodeMaterial.js:880` 的 `colorNode` 是**整个替换** `color × map`，
        //    所以必须自己把贴图乘回来，否则树干变成一块纯色板。
        m.colorNode = vec4(t.rgb.mul(base), t.a);
    } else {
        m.colorNode = vec4(base, float(1.0));
    }
    m.needsUpdate = true;
}

/**
 * 树干 / 树枝材质：**真贴图 × 高度渐变遮蔽**（旧接口，保留给需要独立材质的地方）。
 *
 * @deprecated ⚠️ 这个函数会把 JPEG 贴图推进 RGBFormat 路径，**整批网格静默不画**
 *   （见 `applyBarkShade` 的说明）。森林里请用 `applyBarkShade`。
 *   这里保留实现只是为了别的地方可能确实需要一份独立材质，而且叶子那套 RGBA
 *   图集走这个路径是安全的。
 */
export function makeBarkMaterial(
    m: any,
    gain: number,
    tintHex: string,
    aoFloor = 0.55,
    aoTop = 12.0,
): THREE.MeshStandardNodeMaterial {
    const tint = new THREE.Color(tintHex);
    const node = new THREE.MeshStandardNodeMaterial();
    node.side = m?.side ?? THREE.FrontSide;
    node.transparent = false;
    node.depthWrite = true;
    node.alphaTest = 0;
    node.roughness = 0.92;
    node.metalness = 0.0;
    const tintCol = vec3(tint.r, tint.g, tint.b);
    const hy = positionLocal.y.div(float(Math.max(0.5, aoTop))).clamp(0.0, 1.0);
    const ao = mix(float(aoFloor), float(1.0), hy);
    if (m?.map) {
        const t = texture(m.map, uv());
        node.colorNode = vec4(t.rgb.mul(tintCol).mul(ao).mul(float(gain)), t.a);
    } else {
        node.colorNode = vec4(tintCol.mul(ao).mul(float(gain)), float(1.0));
    }
    return node;
}

/**
 * VenuePropsReal —— 用户 m07996 第①条：
 *   「去网上找类似风格的，真实树，建筑的成品模型，包括贴图那种完整版，替换原神那个模型」
 *
 * 素材来源：**Poly Haven**（`polyhaven.com`，全部 **CC0**，可商用、可改、免署名）。
 * 抓取 = `_tools\polyhaven-fetch.py`，减面/归一化 = `_tools\ph-blender.py`（Blender 5.2 headless），
 * 一键构建 = `_tools\ph-build.ps1`。产物落 `public\venue\real\*.glb`。
 *
 * ── 为什么整条链路是这样（都是这轮踩出来的）─────────────────────────
 * 1. **Poly Haven 是摄影测量级素材**：`island_tree_01` 原始 **1,599,403 三角**、几何 `.bin` 一个就 58 MB，
 *    而会场原本 131 件道具加起来才 ~775k 三角。所以**必须减面**，不能直接进 web。
 * 2. **减面必须按材质拆**：Poly Haven 的树是「一个 mesh 挂三种材质」——
 *    叶 1,060,032 / 枝 504,584 / 干 34,787 三角。不对着材质拆开直接砍，
 *    枝干和叶片会被同一个比例削平，叶子（剪影）先烂。所以 Blender 侧先
 *    `separate(type='MATERIAL')`，再给叶片单独一份预算（`--leaf-budget`）。
 * 3. **月岩 gltf 里塞了 4 份 LOD**（LOD0..LOD3 同时存在），不减掉会重影四遍（`--lod0`）。
 * 4. **`modular_fort_01` 是 22 件的模块化城堡套件**，铺在 42×71 米网格里，
 *    要按名字挑件导出（`--pick tower_round` / `--pick wall_thin_gate`）——
 *    正好拿来当「柱子 / 大门 / 残墙 / 石台」。
 * 5. **统一归一化**：导出前把每件缩成「高度 = 1.0、原点 = 底面中心」（`--normalize --ground`）。
 *    这样运行时 `scale` 直接就是**米**，不用关心月岩原始只有 0.2 米、城堡套件有 13 米。
 *
 * ── 摆位：原来是老线 `wujien-layout.json` 的 121 条，现已改为环形 ──────
 * 第一版照抄老线 `manifest.json` 的 **121 条 `jobs`（tree 32 / rock 39 / mushroom 45 / bush 5）
 * 和 10 条 ruin 摆位**，只换「取哪个 mesh」。用户 m08676 任务2 之后改成
 * **「中间空地 + 四周一圈树」**（见下面 `RING_*` 常量），建筑全部撤掉。
 */
import { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { vec3, vec4, float, dot, texture, uv } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { QNUM } from '../../core/utils/query';
// ★ 环形布局的位置公式搬到 `core/venueRing.ts` —— 角色碰撞要复算**同一个圆**，
//   两边各写一份迟早会错位（撞空气 / 从树里穿过去）。
import { hash01, ringAt, ringCfg } from '../../core/venueRing';

/** `?real=0` 退回原神那套 OBJ 道具（对照用） */
export const REAL_ON = QNUM('real', 1)! > 0;

/** `?realgrid=1` 不按摆位表铺，改成把每件素材在原点附近**一字排开**
 *  —— 看素材长什么样、量高度、挑哪件合适，全靠这张「样品图」。 */
const REAL_GRID = QNUM('realgrid', 0)! > 0;

/** 夜空里道具偏暗，给个整体增益（`?realgain=` 可覆盖，做明暗对照图用） */
const GAIN = QNUM('realgain', 1.0)!;

/** 「自发光补光」强度（`?realemis=`）。
 *  ⚠️ 第一版写的是 `m.emissive = m.color * 0.14`，结果 **所有道具都变成灰白**：
 *  GLTFLoader 里 `material.color` 是 `baseColorFactor`（白），颜色全在贴图上，
 *  所以那行等于给每件道具糊了一层**与贴图无关的平铺灰**（probe 实测 `emissive=0x696969`），
 *  月夜里本来就很弱的光照根本压不过它，贴图的颜色和明暗全被洗掉。
 *  正确做法：**让自发光也走贴图**（`emissiveMap = map`），只调 `emissiveIntensity`，
 *  这样提亮的是 albedo 本身，颜色与纹理细节都保住。 */
const EMIS = QNUM('realemis', 0.34)!;

/* ══════════════════════════════════════════════════════════════════════
 * ★★★ 树叶配色（用户 m05645 逐字）：
 *   「现有的树需要把叶子改成青绿色，蓝色两种。
 *     `公用区\背景素材\素材\背景素材2.png` 和 `背景素材4.png` 中树叶子的配色。
 *     这个只需要调色即可。」
 *
 * ── 为什么能「只调色」────────────────────────────────────────────────
 *  `_tools/glbinfo.py` 查出 `tree_a/b.glb` 的叶子是**独立材质**（名字以 `_leaves` 结尾、
 *  `alphaMode=BLEND`），树干/枝干是另外两个材质 ⇒ 可以**只染叶、不动树干**。
 *  （枝干在 `island_tree_01_branches` 里合并成一整块，剪不了枝 —— 那是另一件事。）
 *
 * ── 颜色从哪来 ───────────────────────────────────────────────────────
 *  用 PIL 对两张参考图取「高饱和像素的中位色」：
 *    `背景素材2.png` 受光树冠 = **#5984c4**（H 216° S 0.55 V 0.77）← 钴蓝
 *    `背景素材4.png` 受光树冠 = **#147e91**（H 189° S 0.86 V 0.57）← 青绿
 *  两色的**亮度与原绿色叶子接近**，所以换色不改变树的明暗，只换色相。
 *
 * ── 手法：亮度当遮罩 ─────────────────────────────────────────────────
 *  ⚠️ 不能直接 `颜色 × 蓝` —— 原贴图是绿的，绿×蓝 = 一片发黑的墨绿。
 *  正确做法是把贴图**转成亮度**（`dot(tex.rgb, vec3(0.2126,0.7152,0.0722))`，
 *  Rec.709 亮度），再乘目标色 ⇒ 叶脉、疏密、明暗全保留，只有色相被换掉。
 *
 *  ⚠️⚠️ 两个必踩的坑（都在这里一次性解决）：
 *   ① `colorNode` 会**整个替换** `color × map`，所以贴图必须手动乘回去（否则叶子变纯色块）；
 *   ② `colorNode` 给 `vec3` 时 alpha 直接变 1 ⇒ **BLEND 的叶子会变成一整块不透明的板子**，
 *      必须给 `vec4(rgb, tex.a)` 把 alpha 一起交出去。
 *  详见 `AGENT.md` 判据 Y。
 */
const LEAF_ON = QNUM('leaf', 1)! > 0;
const LEAF_GAIN = QNUM('leafgain', 1.0)!;
/** 叶子的自发光倍率（`?leafemis=`）。参考图是**白天**拍的，叶色面积大、明度高；
 *  会场是**月夜**，同一套叶色渲出来会暗一大截（实测中位色 #174e5a vs 参考 #147e91）。
 *  叶子比树干薄、透光，本来就该有点自亮，所以给一个专属倍率把它拉回来。 */
const LEAF_EMIS = QNUM('leafemis', 2.0)!;
/** 每件素材用哪个颜色（下标进 `LEAF_TINTS`）。`tree_a` 蓝、`tree_b` 青绿 ⇒ 树环里两色混着长。 */
const LEAF_TINT_OF: Record<string, number> = {
    tree_a: 0,
    tree_b: 1,
    tree_c: 1,      // othonna 矮灌木
};
/** 参考图采样得到的两种叶色（受光面中位色）。 */
const LEAF_TINTS = ['#5984c4', '#147e91'] as const;

/** ── 环形布局（用户 m08676 任务2）───────────────────────────────────
 *  「删除所有建筑，树木移动一下，改成周围有树围一圈（不能过于密集），中间是空地。」
 *
 *  原来 121 条摆位是**撒满整个地面圆盘**的（实测半径 4.10 ~ 32.13 米），
 *  中间那一圈是「会场道具」的密度，不是「空地」。
 *  现在改成：**所有道具都只在半径 `RING_R` 附近的一条环带里**，圆心一带留空。
 *
 *  半径怎么定的：旧摆位最远 32.13 米，所以地面圆盘半径 ≈ 36 米左右，
 *  树环取 29 米 —— 树冠（4~5 米宽）离盘边还有余量，从场心看过去正好压在
 *  地平线上「围」起来，又不会因为太靠边而悬空。
 *
 *  数量怎么定的：周长 2π×29 ≈ 182 米，26 棵 ⇒ 平均间距 **7 米**，
 *  树冠宽 4~5 米 ⇒ 平均留 2~3 米空隙，读作「围了一圈」而不是「一堵树墙」。
 *
 *  ★ 这些参数现在从 `core/venueRing.ts` 读 —— 角色碰撞要复算同一个圆。
 */
const RING = ringCfg();
const RING_R = RING.r;                 // 树环半径（米）
const RING_N = RING.n;                 // 树的数量
/** 角度抖动：每一棵在自己的扇区里最多偏 ±`槽宽 × RING_AJ`。
 *  抖动必须 < 0.5，否则两棵会抢到同一个角度、挤成一堆（那就「过于密集」了）。 */
const RING_AJ = RING.aj;
/** 半径抖动（米），让树环不是一条完美的圆 */
const RING_RJ = RING.rj;
/** 石头 / 灌木的数量（它们只做点缀，铺得比树稀） */
const RING_ROCK = RING.rock;
const RING_BUSH = RING.bush;
/** `?ruin=1` 把用户 m08676 要求删掉的建筑（柱子/大门/石台）加回来做对照 */
const RUIN_ON = QNUM('ruin', 0)! > 0;

type Kind = 'tree' | 'bush' | 'rock' | 'mushroom';

interface AssetDef {
    /** public 下的路径 */
    url: string;
    kind: Kind;
    /** 目标高度（米）。GLB 已归一化成高度 1，所以 scale 就等于这个数 */
    h: number;
    /** 高度抖动比例（同一件素材铺多次时不要一样高） */
    jitter?: number;
}

/** 素材表。名字与 `_tools\ph-build.ps1` 里的 `$jobs` 一一对应。 */
const ASSETS: Record<string, AssetDef> = {
    // ── 树：两个岛树（阔叶）──
    tree_a: { url: '/venue/real/tree_a.glb', kind: 'tree', h: 5.4, jitter: 0.30 },
    tree_b: { url: '/venue/real/tree_b.glb', kind: 'tree', h: 4.6, jitter: 0.30 },
    // ── 灌木 / 小丛：蕨、荨麻、银叶菊（沙漠灌木，圆乎乎，正好顶蘑菇）──
    bush_fern: { url: '/venue/real/bush_fern.glb', kind: 'bush', h: 1.1, jitter: 0.35 },
    bush_nettle: { url: '/venue/real/bush_nettle.glb', kind: 'bush', h: 1.3, jitter: 0.35 },
    tree_c: { url: '/venue/real/tree_c.glb', kind: 'bush', h: 0.9, jitter: 0.40 },
    // ── 石头：三块月岩 + 一块纳米比亚巨砾 ──
    rock_a: { url: '/venue/real/rock_a.glb', kind: 'rock', h: 0.5, jitter: 0.45 },
    rock_b: { url: '/venue/real/rock_b.glb', kind: 'rock', h: 0.42, jitter: 0.45 },
    rock_c: { url: '/venue/real/rock_c.glb', kind: 'rock', h: 0.38, jitter: 0.45 },
    rock_d: { url: '/venue/real/rock_d.glb', kind: 'rock', h: 1.0, jitter: 0.35 },
    // ── 建筑：模块化城堡套件里挑出来的四件（h 只给样品排开用，实际落位看 RUIN_MAP）──
    fort_tower: { url: '/venue/real/fort_tower.glb', kind: 'rock', h: 5.4 },
    fort_gate: { url: '/venue/real/fort_gate.glb', kind: 'rock', h: 6.0 },
    fort_wall: { url: '/venue/real/fort_wall.glb', kind: 'rock', h: 4.2 },
    fort_walk: { url: '/venue/real/fort_walk.glb', kind: 'rock', h: 3.2 },
};

/** 每类 → 从哪些素材里挑（同一类里按位置哈希确定性轮换，保证可复现） */
const POOL: Record<Kind, string[]> = {
    tree: ['tree_a', 'tree_b'],
    bush: ['bush_fern', 'bush_nettle', 'tree_c'],
    rock: ['rock_a', 'rock_b', 'rock_c', 'rock_d'],
    // 蘑菇位（45 处，原本是贴地的小蘑菇）改铺「小石头 + 矮灌木」，尺度压到 0.1~0.3 米
    mushroom: ['rock_b', 'rock_c', 'tree_c'],
};

/** 废墟摆位 → 用哪件建筑素材 + 目标高度（米）。键是 `manifest.extras[].obj` 的子串。
 *
 *  `sxz` = 水平方向额外缩放（厘米级微调柱子的粗细 / 石台的直径）。
 *  为什么要它：城堡套件里没有「细柱子」和「矮石台」这两种东西 ——
 *  全部是墙、塔、转角件。但 `tower_round` 是个**规整的锥台**，
 *  横向压到 0.36 就是一根石柱，纵向压到 0.6、横向放到 5 倍就是一块圆石台。
 *  比起再去找两套素材，直接改比例更省事，质感也是同一批石头。 */
const RUIN_MAP: { match: string; asset: string; h: number; sxz?: number }[] = [
    // 石台：圆塔压扁成三级圆台，正好托住场心
    { match: 'Ruin_Pingtai_A_01', asset: 'fort_tower', h: 0.62, sxz: 4.6 },
    // 祭坛：方形石座
    { match: 'Ruin_Jitan_C_02', asset: 'fort_wall', h: 2.2 },
    // 四角柱子：圆塔横向压细 ⇒ 石柱
    { match: 'Ruin_Pillar_02A', asset: 'fort_tower', h: 5.4, sxz: 0.36 },
    // 大门 / 残门
    { match: 'Ruin_Damen_A_02', asset: 'fort_gate', h: 6.0 },
    { match: 'Ruin_Damen_B_07', asset: 'fort_gate', h: 4.4 },
    // 残墙
    { match: 'Ruin_Damen_B_01', asset: 'fort_wall', h: 3.4 },
    { match: 'Ruin_Damen_B_06', asset: 'fort_walk', h: 3.0 },
];

/** 位置 → 确定性伪随机 [0,1)。**不能用 `fract(sin(i*12.9898)*43758.5453)`**：
 *  判据 N —— 这个式子在大索引上会退化；这里用整数混合（PCG 风格）保证稳定。
 *  ★ 实现已搬到 `core/venueRing.ts`（角色碰撞要复算同一个圆），这里只是转出。 */
export { hash01 };

async function buildReal(sb: string[]): Promise<THREE.Group> {
    const man = await (await fetch('/venue/manifest.json')).json();
    // 注：manifest 里的 `unit = 0.1` 是**旧 OBJ 线**的换算系数，对 GLB 素材没有意义 ——
    //     摆位坐标本身就是米。这里故意不读 unit，免得又有人拿它去乘高度。
    const loader = new GLTFLoader();

    // ── 素材加载（每份只加载一次，之后 clone）──
    const cache: Record<string, THREE.Group | null> = {};
    /** 被「亮度遮罩换色」接管的叶子材质数量 —— 只用于 HUD 自检。 */
    let leafSwaps = 0;
    const getAsset = async (key: string): Promise<THREE.Group | null> => {
        if (key in cache) return cache[key];
        const def = ASSETS[key];
        if (!def) { cache[key] = null; return null; }
        try {
            const gltf = await loader.loadAsync(def.url);
            const root = gltf.scene as THREE.Group;
            let tris = 0;
            root.traverse((o: any) => {
                if (!o.isMesh) return;
                o.castShadow = false;
                o.receiveShadow = false;
                const idx = o.geometry?.index;
                tris += (idx ? idx.count : (o.geometry?.attributes?.position?.count || 0)) / 3;
                // 材质：GLTFLoader 已经按 glTF 的 pbrMetallicRoughness 建好
                // （alphaMode=MASK 会自动落到 alphaTest=0.5、doubleSided 会落到 DoubleSide）。
                // 这里只补一件事：**整体提亮**。会场是月夜，光本来就弱，
                // 写实贴图按标准 PBR 渲出来会偏暗。
                // ⚠️ 不能用平坦的 `emissive = color * k`（见文件头 EMIS 的注释），
                // 必须让自发光**跟着贴图走**，否则贴图的颜色会被一层灰洗掉。
                const m = o.material as any;
                /* ★ 叶子单独走「亮度遮罩换色」（见文件上方 `LEAF_ON` 那一段）。
                   判据用**材质名**而不是 mesh 名 —— GLB 里叶子的材质叫
                   `island_tree_01_leaves` / `othonna_cerarioides_leaves`。
                   ⚠️⚠️ 坑 50（本轮最贵的一课）：**`/leaf/i` 匹配不到 `…_leaves`！**
                   "leaf" 的复数是 "leaves"（f → **v**），l-e-a-v-e-s 里根本没有
                   "leaf" 这个子串 —— 子串只有 "leav"/"eave"/"aves"。
                   我盯着屏幕看了半天，一直把 `…leaves` 读成 "leaf"+"ves"。
                   教训：**不要用肉眼认字符串，打出 `charCodeAt` 或直接 `indexOf` 验证。**
                   正确写法是 `/lea[fv]/i`（同时吃 leaf 和 leaves）。 */
                const tintIdx = LEAF_TINT_OF[key];
                if (LEAF_ON && tintIdx !== undefined && m && /lea[fv]/i.test(String(m.name))) {
                    const tint = new THREE.Color(LEAF_TINTS[tintIdx]);
                    const node = new THREE.MeshStandardNodeMaterial();
                    node.side = m.side ?? THREE.FrontSide;
                    node.transparent = m.transparent ?? false;
                    node.alphaTest = m.alphaTest ?? 0;
                    node.depthWrite = m.depthWrite ?? true;
                    node.normalMap = m.normalMap ?? null;
                    /* ⚠️⚠️ 坑 49（本轮花了很久才找到）：**`MeshStandardNodeMaterial`
                       没有 `normalScale`**。它继承的是 `NodeMaterial`，不是
                       `MeshStandardMaterial`（`three/src/materials/nodes/MeshStandardNodeMaterial.js:19`
                       `class MeshStandardNodeMaterial extends NodeMaterial`）。
                       写 `node.normalScale.copy(...)` 会抛 `TypeError: Cannot read
                       properties of undefined`，而这个 traverse 外面包着 try/catch ⇒
                       **异常被静默吞掉，材质一个都没换成，叶子还是绿的，没有任何报错**。
                       规矩：给 Node 材质搬属性之前，先确认那个属性真的存在。 */
                    if (m.normalScale && (node as any).normalScale) {
                        (node as any).normalScale.copy(m.normalScale);
                    }
                    node.roughness = 1.0;
                    node.metalness = 0.0;
                    const tintCol = vec3(tint.r, tint.g, tint.b);
                    /* ── 自发光：这里**故意用平坦色**，不走贴图 ────────────────────
                       和文件头上方 `EMIS`（会场道具）那个坑结论相反，原因是光照条件不同：
                       会场是**月夜**，入射光本来就弱（实测 albedo 那一支几乎压不出亮度，
                       `?leafgain=` 从 1.0 加到 2.5 图像几乎不动）⇒ **想要参考图那种
                       明亮饱和的叶色，只能靠自发光**。所以叶子给一个比道具强得多的平坦
                       自发光，色相 = 目标叶色。
                       ⚠️ 代价：`?hour=0` 深夜时叶子会偏亮偏「霓虹」，这是这套取舍的必然结果，
                       用 `?leafemis=` 可以随时压下来（实测 0.35→0.68 是「有光」和「发光」的分界）。
                       （试过用 `emissiveNode = tint*lum` 走贴图：夜里确实自然了，但白天叶子
                         暗到看不出青绿/蓝，因为在弱光下 albedo 那一支根本撑不起来。） */
                    if (node.emissive) {
                        node.emissive.copy(tint);
                        node.emissiveIntensity = EMIS * LEAF_EMIS;
                    }
                    if (m.map) {
                        const t = texture(m.map, uv());
                        const lumN = dot(t.rgb, vec3(0.2126, 0.7152, 0.0722));
                        /* ⚠️ `colorNode` 给 vec4 时要把 `t.a` 一起交出去 —— 给 vec3 的话
                           alpha 直接是 1，BLEND 的叶子会变成一整块不透明的板子（判据 Y）。 */
                        node.colorNode = vec4(tintCol.mul(lumN).mul(float(LEAF_GAIN)), t.a);
                    } else {
                        node.colorNode = vec4(tintCol.mul(float(LEAF_GAIN)), float(1.0));
                    }
                    o.material = node;
                    leafSwaps++;
                    return;
                }
                if (m && m.color) {
                    m.color.multiplyScalar(GAIN);
                    if (m.emissive) {
                        if (m.map) {
                            m.emissiveMap = m.map;
                            m.emissiveMap.colorSpace = m.map.colorSpace;
                            m.emissive.setRGB(1, 1, 1);
                        } else {
                            m.emissive.copy(m.color);
                        }
                        m.emissiveIntensity = EMIS;
                    }
                    m.needsUpdate = true;
                }
            });
            sb.push(`[venue-real] ${key} ${def.url.split('/').pop()} 三角 ${Math.round(tris)}`);
            return (cache[key] = root);
        } catch (e) {
            sb.push(`[venue-real] 素材加载失败 ${key} (${def.url}): ${e}`);
            return (cache[key] = null);
        }
    };

    const group = new THREE.Group();
    group.name = 'venue-props-real';

    // ── 样品图模式：把每件素材一字排开 ──
    // ⚠️ 第一版格宽用 `h*1.6+0.5`，13 件排到 **61.5 米**，走出了地面圆盘，
    //    结果整排看着全部「悬空」。现在改成 `h*1.02+0.3`（约 39 米）并**以原点居中**。
    if (REAL_GRID) {
        const keys = Object.keys(ASSETS);
        const w = (k: string) => ASSETS[k].h * 1.02 + 0.3;
        const total = keys.reduce((s, k) => s + w(k), 0);
        let x = -total / 2;
        for (const k of keys) {
            const cw = w(k);
            const g = await getAsset(k);
            if (!g) { x += cw; continue; }
            const holder = new THREE.Group();
            holder.position.set(x + cw / 2, 0, 0);
            holder.scale.setScalar(ASSETS[k].h);
            holder.add(g.clone(true));
            group.add(holder);
            x += cw;
        }
        sb.push(`[venue-real] 样品排开 ${keys.length} 件，横向 ${total.toFixed(1)} 米（居中）`);
        return group;
    }

    const place = async (key: string, sx: number, sz: number, h: number, salt: number,
                         rot: number | null, pos: [number, number, number], sxz = 1) => {
        const g = await getAsset(key);
        if (!g) return false;
        const holder = new THREE.Group();
        /* ⚠️ 2026-10-17 修：原来是 `set(pos[0], 0, pos[2])` —— 把调用方算好的 y 丢掉了，
           强制贴地。`?ruin=1` 那条路径（`:395` 的 `const [x, y, z] = ex.pos`）其实带了
           清单里的高度，被这一行抹平 ⇒ 建筑/石台一律坐回 y=0。
           GLB 已归一化成「高度 = 1、底面贴地」（见下），所以 `pos[1]` 就是应该的落位高度。
           `Number.isFinite` 是对清单里可能出现的 null 做兜底 —— 宁可贴地，不要 NaN。 */
        holder.position.set(pos[0], Number.isFinite(pos[1]) ? pos[1] : 0, pos[2]);
        holder.rotation.y = rot ?? hash01(sx, sz, 7) * Math.PI * 2;
        // GLB 已归一化成「高度 = 1、底面贴地」，所以 scale 直接就是米。
        // sxz 是水平方向的额外挤压：圆柱压细成柱子 / 压扁成石台都靠它。
        holder.scale.set(h * sxz, h, h * sxz);
        holder.add(g.clone(true));
        group.add(holder);
        return true;
    };

    // ── 环形布局（用户 m08676 任务2）：中间空地，四周一圈树 ──
    // 每个道具分到自己的一个「扇区」，在扇区内做角度/半径抖动 ——
    // 这样既不是等分的机械圆环，也不会两棵挤在一起。
    // ★ 公式在 `core/venueRing.ts`（角色碰撞必须在同一个坐标系里复算）

    const put = async (kind: Kind, i: number, n: number, r0: number, salt: number,
                       hScale = 1, hOverride?: number) => {
        const pool = POOL[kind];
        if (!pool.length) return false;
        const [x, z] = ringAt(i, n, r0, salt);
        const def = ASSETS[pool[Math.floor(hash01(x, z, 1) * pool.length) % pool.length]];
        if (!def) return false;
        const base = hOverride ?? def.h * hScale;
        const h = base * (1 + (hash01(x, z, 2) - 0.5) * (def.jitter ?? 0));
        return place(Object.keys(ASSETS).find((k) => ASSETS[k] === def)!, x, z, h, salt,
                     hash01(x, z, 5) * Math.PI * 2, [x, 0, z]);
    };

    // 树：主角，环最外圈
    let placed = 0;
    for (let i = 0; i < RING_N; i++) if (await put('tree', i, RING_N, RING_R, 3)) placed++;

    // 石头：略靠里一点，做前景层次（树环 29 米 ⇒ 石头 25 米）
    for (let i = 0; i < RING_ROCK; i++) if (await put('rock', i, RING_ROCK, RING_R - 4.0, 6)) placed++;

    // 灌木：夹在树之间、半径和树差不多，补空档但不成排
    for (let i = 0; i < RING_BUSH; i++)
        if (await put('bush', i, RING_BUSH, RING_R + 0.8, 9)) placed++;

    sb.push(`[venue-real] 环形布局：树 ${RING_N} 棵 @ ${RING_R} 米`
        + `（角抖 ${RING_AJ} / 半径抖 ±${RING_RJ} 米）`
        + `、石 ${RING_ROCK}、灌木 ${RING_BUSH}，共 ${placed} 件；圆心留空`);
    sb.push(`[venue-real] 叶色：${LEAF_ON ? 'ON' : 'OFF'} gain=${LEAF_GAIN}`
        + ` emis=${LEAF_EMIS} 换 ${leafSwaps} 片叶材质`);

    // ── 建筑（用户 m08676 任务2 要求删除，`?ruin=1` 可加回来做对照）──
    if (RUIN_ON) {
        let ruinN = 0;
        for (const ex of man.extras || []) {
            if (ex.kind !== 'ruin' || !ex.obj) continue;
            const hit = RUIN_MAP.find((r) => String(ex.obj).includes(r.match));
            if (!hit) continue;
            const [x, y, z] = ex.pos || [0, 0, 0];
            // ⚠️ 原来这里写的是 `hit.h * unit / 0.1 * (ex.sc || 1) * 0.1` ——
            //    代入 unit = 0.1 之后整个式子塌缩成 `hit.h * sc * 0.1`，
            //    5.4 米的塔变成 0.54 米，柱子/石台/大门全都矮到看不见。
            //    这是 OBJ 时代换算单位留下的残渣；GLB 侧已经是「高度 1」了，直接乘 sc 就是米。
            const h = hit.h * (ex.sc || 1);
            const ok = await place(hit.asset, x, z, h, 11, ex.rot ?? 0, [x, y, z], hit.sxz ?? 1);
            if (ok) ruinN++;
        }
        sb.push(`[venue-real] ?ruin=1：建筑加回来 ${ruinN} 件`);
    }

    return group;
}

export function VenuePropsReal({ visible = true }: { visible?: boolean }) {
    const [group, setGroup] = useState<THREE.Group | null>(null);
    useEffect(() => {
        let dead = false;
        const sb: string[] = [];
        buildReal(sb)
            .then((g) => {
                sb.forEach((s) => console.log(s));
                if (!dead) setGroup(g);
            })
            .catch((e) => console.log('[venue-real] 构建失败 ' + e));
        return () => { dead = true; };
    }, []);
    /* ★★ 距离剔除（用户 m02260 / m02439 两次点名）★★
       「不要渲染草地刷新外的东西，省显卡资源」。
       会场树环半径 29 m，而地形盘半宽只有 TERRAIN_AREA/2 = 80 m。
       相机退到 120 m 之外时，这圈树已经**悬在地形盘之外**了 —— 实机截图上就是
       天边黑带里那一排发光的树（叶子有自发光，雾压不住它们）。
       所以这里直接 `visible = false`，连 draw call 都不发。 */
    const HIDE_R = 120;
    useFrame(({ camera }) => {
        if (!group) return;
        const dx = camera.position.x, dz = camera.position.z;
        group.visible = visible && dx * dx + dz * dz < HIDE_R * HIDE_R;
    });
    if (!group) return null;
    return <primitive object={group} visible={visible} />;
}

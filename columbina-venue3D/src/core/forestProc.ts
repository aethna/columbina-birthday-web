/**
 * forestProc —— 森林里**不需要下载**的几件道具，用几何体直接造出来。
 *
 * ── 为什么是程序化的 ────────────────────────────────────────────────
 * 用户要的森林素材清单里有「蘑菇」，但 **Poly Haven 一件蘑菇都没有**
 * （`_tools/polyhaven-fetch.py --list` 521 个模型里搜不到 mushroom / fungus / toadstool），
 * 下载源（ambientCG / Kenney / Quaternius）要么没有、要么授权/格式对不上。
 * 蘑菇本身形状极简（一根圆柱 + 一个扁球冠），与其去找素材不如直接造，
 * 而且**颜色是我们自己定的**，正好对上用户「对照着调色就行」的要求。
 * 石板路同理：Poly Haven 的 `stone_01` 是一块天然石，做不出「切好的石板」。
 *
 * ── 参考色（`公用区\背景素材\素材\`）────────────────────────────────
 * `背景素材2.png`：地面橙、树冠钴蓝、**石板路是奶白色**、蘑菇是淡蓝。
 * `背景素材4.png`：地面砖红、树冠青绿、**白色伞状蘑菇**、石砌建筑。
 * ⇒ 蘑菇两种：白色伞菌 + 淡蓝小菌。石板：奶白偏暖。
 *
 * ── 约定 ────────────────────────────────────────────────────────────
 * 每个 parts 的几何体**底面已经落在 y = 0**（`Forest.tsx` 还会再统一贴一次地，
 * 但不依赖它）。`name` 会进 `groupsByMat` 的 key，必须唯一。
 */
import * as THREE from 'three/webgpu';
import { vec2, vec3, vec4, float, positionLocal, fract, abs, clamp, mix, length, Fn, dot, smoothstep, texture, normalLocal } from 'three/tsl';
import { QNUM } from './utils/query';

export interface ProcPart {
    name: string;
    material: THREE.MeshStandardNodeMaterial;
    geometry: THREE.BufferGeometry;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 石板岩面贴图（用户 m00002 第2条：「石板路没用任何贴图，纯色」）
 *
 * ── 为什么之前是纯色 ────────────────────────────────────────────────
 * 上面 `slabGrain()` 那套是**纯程序化**的明暗（接缝 / 麻点 / 斑块 / 裂纹），
 * 全部是数值算出来的标量乘在基色上。它能把均匀色板变成「有点脏的石头」，
 * 但**没有一张真实的岩面**：没有石粒的颗粒感、没有真实的明暗块、没有层理。
 * 实测放大图（`_tmp_preview\r12\fb2_zoom.jpg`）里石板顶面就是「均匀浅灰 +
 * 极细碎麻点」，用户说「纯色」是准确的。
 *
 * ── 贴图从哪来 ──────────────────────────────────────────────────
 * 不新下载任何素材：直接用项目里已有的
 *   `public/textures/ground/rocks_ground_06_diff_1k.png`（1024²，RGBA PNG）
 *   `public/textures/ground/rocks_ground_06_rough_1k.png`
 * 它是「碎岩 / 卵石堆叠的砂土地面」，米黄偏褐，正好是石板该有的岩面。
 *
 * ⚠️⚠️ **必须用 PNG，不能用 JPEG**：`Forest.tsx:402-414` 记着实测过的报错
 *    `Unsupported texture type with RGBFormat. 1009` —— 树皮 JPEG 走
 *    显式 `texture()` 那条路会让**整片森林消失**。上面这两张是 RGBA PNG，安全。
 *
 * ── ⚠️⚠️ 归一化：只保留「变化」，不改变整体明暗 ─────────────────────
 * 贴图要**乘**在区域底色上。直接乘会把贴图自己的整体亮度也带进来
 * （这张岩石贴图线性亮度均值 ≈ 0.2549，而石板基色 `#8d877c` 线性 ≈ 0.28），
 * ⇒ 石板会整体变暗变褐。所以先除以它自己的线性亮度均值，得到「均值 = 1 的斑驳」：
 *     `lumNorm = texRGB / 0.2549`
 * 再乘基色 ⇒ 石板还是那个中灰 `#8d877c`，只是多了岩面的明暗变化。
 * 这与 `core/textures/groundMaps.ts:12-18` 记的是同一条纪律。
 *
 * ── 每块石板为什么各不相同（不需要额外 attribute）────────────────────
 * `three/src/nodes/accessors/InstanceNode.js:208-209`
 *   `const instancePosition = instanceMatrixNode.mul( positionLocal ).xyz;
 *    positionLocal.assign( instancePosition );`
 * ⇒ 在 `colorNode` 里读到的 `positionLocal` **已经乘过实例矩阵**（含每实例
 *   `p.rot` 的 yaw 旋转与 `h` 缩放，见 `Forest.tsx:484-489`），
 *   拿它的 `xz` 做 UV ⇒ 每块石板自动取到贴图上不同的区域、并且随石板一起旋转。
 *   （同一条事实 `core/leafTint.ts:41-49` 也记过。）
 * ⚠️ 但**归一化几何**里 XZ 直径 ≈ 7.08（`buildProcAsset()` 把高度缩到 1），
 *   所以「米」要 `/0.13` 换算 —— 就是下面那个 `K`。
 * ══════════════════════════════════════════════════════════════════════════ */

const SLAB_DIR = '/textures/ground';
/** `?slabtex=0`：关掉真实贴图，退回旧的纯程序化分支（回滚旋钮）。 */
const SLAB_TEX_ON = QNUM('slabtex', 1) !== 0;
/** 一张贴图铺多少米。`?slabtexscale=` 可改。0.62 m ⇒ 1024 px 铺 62 cm ≈ 0.6 mm/texel。 */
const SLAB_TILE = QNUM('slabtexscale', 0.62) || 0.62;
/** `rocks_ground_06_diff_1k` 的**逐通道**线性均值（同 `groundMaterial.ts:138` 的 `LUM_ROCKS` 来源）。
 *
 *  ⚠️ 必须逐通道，不能只除总亮度：这张贴图偏「米黄褐」（R 0.3046 / G 0.2467 / B 0.1889），
 *  只除总亮度 0.2549 会让 R ×1.19、R ×0.97、B ×0.74 ⇒ 石板整体变暖变亮
 *  （实测截图 mean 97.8→115.8）。逐通道除完得到「均值 = 1 的斑驳」，
 *  石板还是原来的 `#8d877c`，只多出纹理 —— 这正是 `textures/groundMaps.ts:12-18` 记的做法。 */
const SLAB_MEAN = vec3(0.3046, 0.2467, 0.1889);
/** 贴图对比度保留比例：1.0 = 原样（岩面很花，石板会像迷彩），0 = 只剩基色。
 *  `?slabtexcontrast=` 可改。
 *  ⚠️ 实测（`_logs\round12\path_hi_on/off.png`，`ImageStat` 逐块量 sd）：
 *  0.62 时石板内部 sd 5.79→12.10、10.98→15.05、14.09→23.17（纹理确实进来了），
 *  但**均值同时 +5~+8 级**（101.7→107.7、107.2→116.6、97.8→115.5）—— 贴图的
 *  均值虽然被归一到 1，可 `mix(vec3(1), norm, k)` 是**在线性空间**上做混合，
 *  而 `norm` 的算术平均是 1、几何平均 < 1（乘性项拉低亮部抬不高暗部）。
 *  0.45 之后均值差压到 ±2 级以内，纹理仍明显。 */
const SLAB_CONTRAST = Math.max(0, Math.min(1, QNUM('slabtexcontrast', 0.45) ?? 0.45));

let slabDiff: THREE.Texture | null = null;
let slabRough: THREE.Texture | null = null;
let slabPromise: Promise<void> | null = null;

/** 预载石板贴图。失败**不抛**：保持 null，`slabGrain()` 自动退回纯程序化分支。
 *  单例（重复调用复用同一个 Promise），与 `groundMaterial.ts:180-185` 同一套路。 */
export function preloadSlabTextures(): Promise<void> {
    if (slabPromise) return slabPromise;
    if (!SLAB_TEX_ON) { slabPromise = Promise.resolve(); return slabPromise; }
    const loader = new THREE.TextureLoader();
    const one = (url: string, srgb: boolean): Promise<THREE.Texture> =>
        loader.loadAsync(url).then((t) => {
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = 8;
            if (srgb) t.colorSpace = THREE.SRGBColorSpace;
            t.needsUpdate = true;
            return t;
        });
    slabPromise = Promise.all([
        one(`${SLAB_DIR}/rocks_ground_06_diff_1k.png`, true),
        one(`${SLAB_DIR}/rocks_ground_06_rough_1k.png`, false),
    ]).then(([d, r]) => {
        slabDiff = d;
        slabRough = r;
        console.log(`[slab] 岩面贴图就绪 diff(1024²) rough(1024²) tile=${SLAB_TILE} m`);
    }).catch((e) => {
        /* 记一行就够：石板退回纯程序化，不阻塞森林构建。 */
        console.error(`[slab] 岩面贴图加载失败，退回程序化石纹 —— ${e?.message ?? e}`);
    });
    return slabPromise;
}

/** 石板石纹：**纯程序化的明暗 + 接缝**，不加自发光、不动基色色相。
 *
 *  ── 为什么要自己做（用户 2026-10-23 反馈「石板路没纹理，一块纯色」）────────
 *  石板是 `slabPart()` 用 `CylinderGeometry(7 边)` 现造的，`stoneMat()` 只设了
 *  `color / roughness / metalness / flatShading` —— **没有 map、没有 colorNode**，
 *  所以七边形顶面就是一块绝对均匀的 `#8d877c`。开着 `flatShading` 后每个面一个法线，
 *  但同面之内没有任何亮度变化，读起来就是「一块没有材质的塑料」。
 *
 *  ── 做法（三件套，全部在**线性亮度**上做，色相严格不变）──────────────────
 *  ① `groove`：沿局部 XZ 取 `fract` 造格子接缝，只在格子边界 ±0.06 内压暗 ⇒ 像
 *     石板之间磨出来的缝，而不是画上去的网格线；
 *  ② `speck`：用 `positionLocal` 的三维哈希做细碎麻点（石材的矿粒），±8%；
 *  ③ `stain`：低频斑块（`floor` 到 0.35 m 一格的平滑三线性近似），±12% 的大块干湿深浅。
 *  三者相乘成一个标量 `k`，最后 `base.mul(k)` —— **只乘亮度**，所以石板还是那个中灰
 *  `#8d877c`，不会变白（用户 m07705 抱怨过「白自发光」，那次是把反照率压到中灰才修好，
 *  这里不能反着来）。
 *
 *  ⚠️ 不能用 `mx_noise_float`：本项目 colorNode 里它实测恒为 0（`Terrain.tsx:466` 有记）。
 *  ⚠️ `colorNode` 是**整个替换** `color × map`（`NodeMaterial.js:880`），所以这里
 *     必须自己把 `m.color` 乘回去（本材质本来就没 map，只需乘基色）。
 *  ⚠️ 不要换成「`new MeshStandardNodeMaterial()` + 显式 `texture()`」那一套 ——
 *     见 `Forest.tsx:402-414`：JPEG 树皮走那条路会触发 `Unsupported texture type with
 *     RGBFormat` 让整片森林消失。本项目现在用的是 **RGBA PNG**（见上），安全。
 *
 * ── 2026-10-24（用户 m00002 第2条）：接上真实岩面贴图 ──────────────────
 *  上面那套程序化纹理全部保留为**兜底**（`?slabtex=0` 或贴图加载失败时走它），
 *  有贴图时换成「三平面投影采样 + 只保留明暗变化」，见 `slabTexNode()`。 */
function slabGrain(name: string, color: string, roughness = 0.90, flat = false): THREE.MeshStandardNodeMaterial {
    const m = stoneMat(name, color, roughness, flat);
    const base = vec3(m.color.r, m.color.g, m.color.b);
    /* ⚠️⚠️ 量纲：`positionLocal` 是**归一化之后**的几何体坐标（`buildProcAsset()`
     *  把整个件缩到「高度 = 1」，见本文件 `:251-263`）。石板归一化前的尺寸是
     *  直径 0.92 m / 厚 0.13 m ⇒ 归一化后 **XZ 直径 ≈ 7.08、厚度 = 1**。
     *  渲染时 `Forest.tsx` 再乘 `h = 0.13`（米）⇒ 世界尺寸回到 0.92 m。
     *  所以下面所有「米」都要先除以 0.13 换成归一化单位，否则纹理会细到看不见
     *  （这是本文件 `:251` 那条「量纲坑」的翻版，别再踩一次）。 */
    const K = 1 / 0.13; // 归一化单位 / 米

    /* ── 有贴图：三平面投影 ────────────────────────────────────────────
     * 只做 `xz` 单投影会出问题：石板是七边棱柱，**侧壁是竖直面**，用 xz 投影
     * 相当于把贴图沿 Y 拉成无限长的条纹（侧壁高度 0.13 m 只占贴图 0.2 个 tile，
     * 却要把整张贴图压进那一条 → 拉花）。所以按法线做**三平面**：
     *   · 顶/底面（normalLocal.y ≈ ±1）取 `vec2(x, z)`；
     *   · 侧壁（normalLocal.y ≈ 0）按 `|nx|`/`|nz|` 在 `vec2(z, y)` 与 `vec2(x, y)` 之间混。
     * `normalLocal` 在这一步**已经乘过实例矩阵的法线**（`InstanceNode.js:212-216`
     * `normalLocal.assign(transformNormal(normalLocal, instanceMatrixNode))`），
     * 而实例矩阵只有 yaw 旋转 + 等比缩放 ⇒ 方向不变，权重照样可用。 */
    if (slabDiff) {
        /* 先绑到 const：`slabDiff` 是模块级 `let`，闭包里 TS 收窄会丢，
           直接传进 `texture()` 会报 `Texture | null`；同时保证这一帧采样的是同一张图。 */
        const dt = slabDiff;
        const tile = SLAB_TILE * K; // 一个 tile = SLAB_TILE 米，换成归一化单位
        m.colorNode = Fn(() => {
            const p = positionLocal as any;
            const n = normalLocal as any;
            const ax = abs(n.x);
            const ay = abs(n.y);
            const az = abs(n.z);
            const sum = ax.add(ay).add(az).add(float(1e-5));
            const wx = ax.div(sum);
            const wy = ay.div(sum);
            const wz = az.div(sum);

            const cX = texture(dt, vec2(p.z, p.y).div(float(tile))).rgb;
            const cY = texture(dt, vec2(p.x, p.z).div(float(tile))).rgb;
            const cZ = texture(dt, vec2(p.x, p.y).div(float(tile))).rgb;
            const avg = cX.mul(wx).add(cY.mul(wy)).add(cZ.mul(wz));

            /* 归一化：**逐通道**除以贴图自己的均值 ⇒ 均值 = 1 的「纯变化」（保色相、保亮度），
               再往 1 收一点（对比度低于 1 不让石板花成迷彩）。 */
            const norm = avg.div(SLAB_MEAN);
            const damp = norm.mul(float(SLAB_CONTRAST)).add(float(1 - SLAB_CONTRAST));

            /* 盘缘仍是程序化的：石板边沿磨得比中间暗一点，给「这块石头有厚度」。
               （贴图只给表面质感，给不了「这块是有边的实体」。
                 数值与下面的兜底分支**保持一致**，否则 `?slabtex=0` 对拍会多出
                 一个 +5% 的亮度差，看不出到底是贴图还是这道边在起作用。） */
            const rad = length(vec2(p.x, p.z));
            const rim = mix(float(0.80), float(1.0), clamp(rad.sub(float(2.6)).div(float(0.95)), float(0), float(1)));

            return vec4(base.mul(damp).mul(rim), float(1.0));
        })();
        /* 粗糙度也接一下：岩石贴图里凹陷处更糙，顶面被踩得更光的错觉。
           只有一张 rough 图，同样走三平面太贵 ⇒ 用顶面投影就够（侧壁本来就看不见）。 */
        if (slabRough) {
            const rt = slabRough;
            const tile = SLAB_TILE * K;
            m.roughnessNode = Fn(() => {
                const p = positionLocal as any;
                const r = texture(rt, vec2(p.x, p.z).div(float(tile))).g;
                return mix(float(roughness - 0.06), float(Math.min(1, roughness + 0.02)), r);
            })();
        }
        return m;
    }

    /* ── 没贴图：旧的纯程序化兜底 ─────────────────────────────────── */
    m.colorNode = Fn(() => {
        const p = positionLocal as any;

        // ── ① 盘缘压暗：石板边沿磨得比中间暗一点，给出「这块石头有厚度」
        const rad = length(vec2(p.x, p.z));
        const rim = mix(float(0.80), float(1.0), clamp(rad.sub(float(2.6)).div(float(0.95)), float(0), float(1)));

        // ── ② 矿粒麻点：三维位置哈希，±7%（世界尺度约 1 cm，读作石材颗粒）
        const h1 = fract(p.x.mul(float(37.19)).add(p.y.mul(float(71.53))).add(p.z.mul(float(53.87))));
        const h2 = fract(h1.mul(float(43758.5453)));
        /* ⚠️ 幅度实测过：±7%（0.93~1.07）在 1:1 特写下石板内部 p95-p05 只有 **10~12 级**，
           几乎看不出颗粒（石板本就浅灰 `#8d877c`，乘法项压不出多少）。放到 ±11% 才够。 */
        const speck = float(0.89).add(h2.mul(float(0.22)));

        // ── ③ 低频斑块：约 12 cm 一格的明暗（石材的干湿/成色不均），±11%
        const cellS = 0.12 * K;
        const sx = fract(p.x.div(float(cellS)));
        const sz = fract(p.z.div(float(cellS)));
        const tx = float(1).sub(abs(sx.mul(float(2)).sub(float(1))));
        const tz = float(1).sub(abs(sz.mul(float(2)).sub(float(1))));
        const stain = mix(float(0.84), float(1.16), tx.mul(tz));

        // ── ④ 一道贯穿的裂纹：只有石板才有的「切痕」，沿 X 走、位置固定在 -0.35 m
        const crackDist = abs(p.z.sub(float(-0.35 * K)));
        const crack = mix(float(0.70), float(1.0), clamp(crackDist.div(float(0.018 * K)), float(0), float(1)));

        const k = rim.mul(speck).mul(stain).mul(crack);
        return vec4(base.mul(k), float(1.0));
    })();
    return m;
}

function stoneMat(name: string, color: string, roughness = 0.90, flat = false): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = name;
    m.color = new THREE.Color(color);
    m.roughness = roughness;
    m.metalness = 0;
    m.flatShading = flat;
    return m;
}

/** 一个伞菌：圆柱菌柄 + 车削出来的伞盖。整体高度 = `stemH + capR * 0.62`。 */
function mushroom(
    name: string,
    capColor: string,
    gillColor: string,
    capR: number,
    stemH: number,
    stemR: number,
): ProcPart[] {
    /* 菌柄。`--ground` 那套在这儿手动做：平移到底面 y = 0。 */
    const stem = new THREE.CylinderGeometry(stemR * 0.78, stemR * 1.15, stemH, 10, 1);
    stem.translate(0, stemH / 2, 0);

    /* 伞盖用 Lathe：从顶点往外拉一圈，边缘再往下垂一点点 —— 比半球更像伞。 */
    const h = capR * 0.62;
    const profile: THREE.Vector2[] = [
        new THREE.Vector2(0.000, h),
        new THREE.Vector2(capR * 0.30, h * 0.96),
        new THREE.Vector2(capR * 0.58, h * 0.82),
        new THREE.Vector2(capR * 0.80, h * 0.58),
        new THREE.Vector2(capR * 0.94, h * 0.28),
        new THREE.Vector2(capR * 1.00, h * 0.06),
        new THREE.Vector2(capR * 0.96, -capR * 0.06),
    ];
    const cap = new THREE.LatheGeometry(profile, 18);
    cap.translate(0, stemH, 0);
    cap.computeVertexNormals();

    /* 菌褶：伞盖正下方一片薄的圆盘，单独一个材质方便给个浅色，
     * 这一片是「从下往上看蘑菇」时唯一能看见的东西。 */
    const gill = new THREE.CircleGeometry(capR * 0.92, 18);
    gill.rotateX(Math.PI / 2);
    gill.translate(0, stemH + h * 0.02, 0);

    return [
        { name: `${name}_stem`, material: stoneMat(`${name}_stem`, gillColor, 0.95), geometry: stem },
        { name: `${name}_cap`, material: stoneMat(`${name}_cap`, capColor, 0.72), geometry: cap },
        { name: `${name}_gill`, material: stoneMat(`${name}_gill`, gillColor, 0.98), geometry: gill },
    ];
}

/** 奶白色伞菌（`背景素材4.png`）。整高 ≈ 0.42 m。 */
function mushroomA(): ProcPart[] {
    return mushroom('mush_a', '#efe7d8', '#d8cbb4', 0.26, 0.26, 0.030);
}

/** 淡蓝小菌（`背景素材2.png`）。整高 ≈ 0.19 m。 */
function mushroomB(): ProcPart[] {
    return mushroom('mush_b', '#a9c4d6', '#8fa6bb', 0.13, 0.11, 0.018);
}

/** 石板：七边形切石，底面贴地。直径 0.92 m、厚 0.13 m。 */
function slabPart(): ProcPart[] {
    const g = new THREE.CylinderGeometry(0.46, 0.41, 0.13, 7, 1);
    g.translate(0, 0.065, 0);
    /* 顶面抖一下：`CylinderGeometry` 的顶点顺序是「侧面按段 × 上下环」，
     * 直接把**上半环**（y > 0.05）的 y 抬落几毫米，石板就不会像压出来的饼。 */
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y > 0.05) {
            const k = Math.sin(i * 12.9898) * 43758.5453;
            pos.setY(i, y + ((k - Math.floor(k)) - 0.5) * 0.022);
        }
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();

    /* ⚠️ 2026-10-10（用户 m07705「石板路为什么是白色自发光的？」）：
       它**没有**发光 —— `stoneMat` 不设 emissive，`FOREST_EMIS` 也只作用在
       `makeCutoutMaterial`（草花卡片）上。看着像自发光的原因是两条叠在一起：
       ① 反照率 `#cfc7b8` 是接近白的浅灰（线性 0.63），正午直射一照就顶到 0.9+；
       ② 森林道具 `castShadow = receiveShadow = false`（`Forest.tsx` 的 `add()`），
          石板既不自阴影、也不接收旁边的树影，于是和周围暗红的裸地一比就是「发光」。
       修法：反照率压到中灰石色、粗糙度拉满。 */
    return [{ name: 'f_slab', material: slabGrain('f_slab', '#8d877c', 0.97, true), geometry: g }];
}

/** 按 `FOREST_ASSETS[key].proc` 造件。名字对不上就返回空数组（静默，不抛）。
 *
 *  ⚠️⚠️ **必须归一化成「高度 = 1、底面 y = 0」**，和下载来的 GLB 同一套约定。
 *  `Forest.tsx` 的实例矩阵是 `_s.set(h*sxz, h, h*sxz)` —— `h` 是**米**，
 *  它同时缩放三个轴。上面这些几何体是按**真实尺寸**建的（石板直径 0.92 m、
 *  厚 0.13 m），不归一化就会被 `h = 0.13` 缩成 12 cm 的小方块。
 *  （这个坑和「`gMin/gMax` 是倍率不是米」是同一族：**量纲**。） */
export function buildProcAsset(name: string): ProcPart[] {
    let parts: ProcPart[];
    switch (name) {
        case 'mush_a': parts = mushroomA(); break;
        case 'mush_b': parts = mushroomB(); break;
        case 'slab': parts = slabPart(); break;
        default: return [];
    }
    let top = 0;
    for (const p of parts) {
        p.geometry.computeBoundingBox();
        top = Math.max(top, p.geometry.boundingBox!.max.y);
    }
    if (top > 1e-6 && Math.abs(top - 1) > 1e-6) {
        const k = 1 / top;
        for (const p of parts) p.geometry.scale(k, k, k);
    }
    for (const p of parts) {
        p.geometry.computeBoundingBox();
        p.geometry.computeBoundingSphere();
    }
    return parts;
}

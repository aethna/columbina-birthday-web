/**
 * Forest —— 无主地带（森林）的**流式实例化**渲染（用户 m05607 方案 B / m06230）。
 *
 * ── 为什么必须用 `InstancedMesh` ────────────────────────────────────
 * 参考实现是 `RegionProps.tsx`：它是 `src.clone(true)` **逐件 clone** ⇒
 * 一件 = 至少一次 draw call，420 件就已经到预算上限了（那里有注释写明）。
 * 森林一件屏幕里就有几千件 ⇒ 只能实例化：**一个素材一次 draw call**。
 *
 * ── 为什么按「相机」而不是「角色」铺 ────────────────────────────────
 * 草是 `useGridSnapping(camera)`（见 `core/utils/gridSnapping.ts`），
 * 地形盘也是跟着相机吸附的。森林跟着相机才不会出现「树比地面先到」的裂缝。
 *
 * ── 流式加载的粒度 ──────────────────────────────────────────────────
 * 每 `CHUNK`（32 m）重算一次，一次收集以相机为中心的 5×5 个 chunk
 * （160×160 m，比 `?area=` 默认的 160 m 地形盘略大一圈）。
 * 重算只是 2500 次整数哈希 + 高度函数，几毫秒，走到哪算到哪，
 * **不保存任何地图数据** —— 这正是「随机地图种子」的意思（判据 N：确定性）。
 *
 * ── 叶色 ────────────────────────────────────────────────────────────
 * 树按位置分到钴蓝 / 青绿两种（`core/leafTint.ts`），所以一屏里两色混长，
 * 和 `公用区\背景素材\素材\背景素材2.png`（钴蓝）/ `背景素材4.png`（青绿）同族。
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { useFrame, useThree } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { QNUM, QSTR } from '../../core/utils/query';
import { CHUNK, FOREST_ASSETS, DEFAULT_FOREST_SEED, collectForest } from '../../core/forest';
import { LEAF_TINTS, LEAF_NAME_RE, makeLeafMaterial, makeCutoutMaterial, applyBarkShade, setLeafVertexShade, setLeafWind, setWindAmp, setEmisFade } from '../../core/leafTint';
import { buildProcAsset, preloadSlabTextures } from '../../core/forestProc';
import { resetTreeColliders, addTreeCollider } from '../../core/world/treeCollide';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const FOREST_ON = QNUM('forest', 1)! > 0;
/** 整株树的整体增益（树皮/树干）。夜里偏暗，用 `?forestgain=` 提。 */
const FOREST_GAIN = QNUM('forestgain', 1.0)!;
/** 树干自发光补光。和会场道具同理：**跟着贴图走**，不要加一层与贴图无关的灰。 */
const FOREST_EMIS = QNUM('forestemis', 0.18)!;
const LEAF_GAIN = QNUM('leafgain', 1.0)!;
/** 叶子自发光强度。会场那 26 棵树是**月夜**下的主角，需要 2.0 才够亮；
 *  森林在正午也要好看，2.0 会把叶子烧成霓虹青 ⇒ 默认压到 0.85。 */
const LEAF_EMIS = QNUM('leafemis', 0.85)!;
/** 叶片顶点色明暗开关（用户 m02188）。默认开；`?vshade=0` 可强制关掉做 A/B。
 *  实际还会与「几何体真的带 color 属性」做与运算 —— 见下面 `isLeaf` 分支。 */
const LEAF_VSHADE_ON = QNUM('vshade', 1)! > 0;
/** 顶点风开关与幅度（用户 m02804 让我决定要不要引入 ez-tree —— 决定不引入，
 *  只把它值钱的两件事（顶点风 / LOD）自己做。这是顶点风那一半）。
 *  ⚠️ 在**材质构建期**读取 ⇒ 切换要重建森林（改 URL 刷新即可）。 */
const LEAF_WIND_ON = QNUM('wind', 1)! > 0;
/** ⚠️ 2026-10-19 用户第二轮反馈「树冠摆动幅度过大（像被大风吹）」：0.14 → **0.05**。
 *  含义是**树顶单向峰值**（世界米），峰峰 0.10 m。0.14 时 3~5 m 的树冠会横移
 *  5%~9% 树高，而树干/树枝不吃风 ⇒ 冠相对枝滑动，读作「被吹跑」。
 *  详细推理见 `core/leafTint.ts` 的 `uWindAmp` 注释。 */
const LEAF_WIND_AMP = QNUM('windamp', 0.05)!;
setLeafWind(LEAF_WIND_ON);
setWindAmp(LEAF_WIND_AMP);
/** 自发光随距离渐隐：`?lefade=`（近，<= 它不削）/ `?lefar=`（远，>= 它削到 0）。
 *  见 `leafTint.ts` 里「远处树冠 + 雾像自发光」那段说明。 */
const LEAF_EMIS_FADE_NEAR = QNUM('lefade', 30)!;
const LEAF_EMIS_FADE_FAR = QNUM('lefar', 85)!;
setEmisFade(LEAF_EMIS_FADE_NEAR, LEAF_EMIS_FADE_FAR);
const SEED = QNUM('fseed', DEFAULT_FOREST_SEED)!;

/** 树皮色。Poly Haven 的 `island_tree_03_branches` 反照率**偏灰白**，
 *  直出是「白珊瑚」不是树 ⇒ 乘一层暖褐。`?bark=` 可覆盖。 */
/* ⚠️ 2026-10-11 m07134：`#6b4f36` 太暗，树皮被压成**近黑的板条**（出图里像「树干被切成
 *  一块块」的深色长条）。Poly Haven 的树皮贴图本身已是灰褐色，只需要一点点暖调，
 *  不该再整体压暗 ⇒ 换成接近中性的 `#bda98f`（只提暖、几乎不改明度）。 */
/* 树皮/石头的中性调整。`_tools/treegen.py` 生成的树皮反照率本身就是暖褐（0.22~0.30），
 * 不再需要额外压色；留一个接近白的中性值只为了以后微调。 */
/* ★ 2026-10-11 m08938「树干不是自发光」的收尾：树皮贴图 `bark_pale.jpg` 源头是
 *  `..._pale_L190_S30.png`（**亮度 190、饱和度 30**，本身已经很亮），
 *  再乘接近中性的 `#a4967f` 基本等于原样输出 ⇒ 出图一片苍白、没有体积。
 *  实测的「发白」真因有两条（都不是 emissive）：
 *    ① 全项目 `castShadow = receiveShadow = false`（本文件 `:209`），树干每个横截面
 *       收到完全相同的光 ⇒ 一根圆柱读成一条**平的色带**；
 *    ② 反照率本来就偏高。
 *  所以这里做两件事：把色相压到**苍白中性灰**（`#b0aca4`，素材1/4 的树干都是
 *  苍白灰白，暖褐方向是错的），并让 `applyBarkShade`
 *  按局部高度做一层**人造遮蔽**（根部暗、往上恢复）补回体积感。零额外 draw call。 */
const BARK_TINT = new THREE.Color(QSTR('bark') ?? '#b0aca4');
/** 树皮人造遮蔽：根部保留比例 / 恢复到 1.0 的局部高度（模型单位）。
 *  新树形把 `trunk_h` 降到 1.5~8 m，锚点归一化取 5.0 覆盖大多数物种。 */
const BARK_AO_FLOOR = QNUM('barkao', 0.42)!;
const BARK_AO_TOP = QNUM('barkaoTop', 5.0)!;
/** 石头色。`f_boulder` 在正午像白瓷，压暗一档。 */
const ROCK_TINT = new THREE.Color('#8b8175');
/** 树冠加厚：叶组几何体围绕树干轴的水平放大倍率（见 `buildForest` 里的说明）。 */
const LEAF_SPREAD = QNUM('leafspread', 1.12)!;
const LEAF_SPREAD_Y = QNUM('leafspready', 1.06)!;

/** 每个 (素材, 叶色) 的实例上限。一屏 7×7 个 chunk（`CULL_R = 74 m`）实测
 *  最密的草丛约 1000 出头，1600 留了足够余量。
 *  内存：1600 × 16 float × 4 B = 102 KB/槽位 —— 几十个槽位也就几 MB。
 *  超了只是截断（不会崩），`window.__forest.capped` 会记下来。 */
const CAP = 1600;

/* ════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-21 第四轮反馈 4a：「依然没有树」——失败必须**响** ★★
 *
 * 现象：用户实机刷新后依然一棵树都没有，而探针 `__forest.total = 925`、
 * 同机位 headless 出图 `_logs/t21/f4a_at_58_186.png` 是密林。
 * 为什么两边不一致成这样还能「无人知晓」：
 *
 *   ① `loader.loadAsync(def.url)` 失败原本只 `console.warn` 后 `continue`
 *      —— 18 个 GLB 素材**全部**失败时，`slots` 是空的、`total` 恒为 0，
 *      页面看起来只是「有点空」，控制台一条 warn 淹在 vite 的 HMR 噪声里。
 *   ② `buildForest()` 整体 reject 原来也只 `console.warn`
 *      ⇒ 连「建到一半」和「一个素材都没有」都分不开。
 *
 * ⇒ 现在两处都变成**可枚举的响**：
 *   · 每个失败素材进 `missing[]`（key + url + 错误原文），并 `console.error`；
 *   · `window.__forest.missing` 常驻（正常是 `[]`），
 *     `window.__forest.ok = total > 0 && missing.length === 0`；
 *   · 全部失败时再补一条 `console.error`，带**一步定位**判据。
 *
 * 一步定位（用户刷新后仍无树时，**只看控制台一行**）：
 *   打开 DevTools → Console，找 `[forest]` 开头的 **error**：
 *     · 有 `404 … /forest/real/xxx.glb`
 *         ⇒ 静态宿主没把 `public/forest/real/` 带上，或 base 不是站点根
 *           （`base` 配了子路径时 URL 必须是 `/子路径/forest/real/…`）。
 *           验：直接在地址栏打开 `https://<host>/forest/real/p_oak.glb`，
 *           下载到文件＝路径对；出 404 / 返回 index.html＝路径错。
 *     · 有 `Unsupported texture type with RGBFormat` / `Texture format not supported`
 *         ⇒ 有人重建了树皮材质（JPEG 无 alpha 被推进 RGBFormat），见
 *           `applyBarkShade` 上方的长注释：**只能在源材质上挂 `colorNode`**。
 *     · 一条 `[forest]` error 都没有，但 `__forest.missing.length > 0`
 *         ⇒ 素材是「加载成功但没建出槽位」，看 `missing[].url` 逐个复现。
 *   · 全都没有 error，而 `__forest.total === 0` 且 `missing.length === 0`
 *     ⇒ 素材全好，是**这附近没有树**：查 `__forestCam` 与 `__forest.cell`
 *       是不是你以为的位置（`?forest=0` 会被 `FOREST_ON` 关掉整层）。
 * ════════════════════════════════════════════════════════════════════════ */

/** 一个加载/构建失败的素材。`url` 原样保留，`error` 留短串（供控制台与探针读）。 */
export interface ForestMissing { key: string; url: string; error: string }

interface Slot {
    /** 全局唯一（`素材|材质组序号|叶色`）。**不能只用 `素材|叶色`**：
     *  一棵树按材质会拆出「枝 / 干 / 叶」三个槽位，前两个的叶色都是 0，
     *  用 `素材|叶色` 当 id 三者在 Map 里互相覆盖 ⇒ 只有最后一个（叶）能拿到实例矩阵，
     *  树干与树枝的 count 却被写成同一个数、矩阵全是 0 ⇒ **整棵树的树干完全不画**。
     *  2026-10-11 就是这么出图的：满屏蓝色树叶悬在半空、看不到一根树干。 */
    id: string;
    mesh: THREE.InstancedMesh;
    /** 属于哪个素材（`collectForest` 返回的 `p.key`）。 */
    key: string;
    /** 叶色槽：只吃 `p.tint === leafTint` 的件；`null` = 所有件都吃（树干/树枝/石头…）。 */
    leafTint: number | null;
}

interface Built {
    group: THREE.Group;
    slots: Slot[];
    byKey: Map<string, Slot[]>;
    /** 建出槽位的素材数（GLB + proc 都算）。 */
    loaded: number;
    /** 失败素材清单（正常为 `[]`）。见文件上方 4a 长注释。 */
    missing: ForestMissing[];
}

/** 错误对象 → 一行短串（探针里读得动，控制台里又不刷屏）。 */
function errText(e: any): string {
    const m = e && (e.message ?? e.reason ?? e.type);
    return String(m ?? e ?? 'unknown').slice(0, 300);
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
/* 零尺度占位矩阵已随第七轮修法删除：槽位不再用「count=1 + 零尺度」冒充实例，
 * 改为「首次 refill() 拿到真实数据才进场景」。见 `add()` 里那段长注释。 */

async function buildForest(): Promise<Built> {
    const loader = new GLTFLoader();
    const group = new THREE.Group();
    group.name = 'forest';
    const slots: Slot[] = [];
    const byKey = new Map<string, Slot[]>();
    const missing: ForestMissing[] = [];
    let loaded = 0;

    /* 石板岩面贴图（用户 m00002 第2条）：必须在下面的素材循环之前完成 ——
     * `buildProcAsset('slab')` 是在循环里**同步**调用的，会立刻读模块级的
     * `slabDiff`；没预载完就只能退回纯程序化石纹。
     * 失败不阻塞：`preloadSlabTextures()` 内部已 catch，这里再兜一层。 */
    await preloadSlabTextures().catch(() => { });

    for (const key of Object.keys(FOREST_ASSETS)) {
        const def = FOREST_ASSETS[key];
        /* ── 按材质把子网格合并 ─────────────────────────────────────
         * Blender 导出的每株植物都是**一堆独立小面片**（`f_grass_a` 有 **17** 个 Plane 子网格、
         * `f_conifer` 有 9 个），它们共用同一张材质。不合并的话
         * 「一个素材一个 InstancedMesh」会退化成「一个子网格一个 InstancedMesh」
         * ⇒ 实测一屏 **106 次 draw call**（每个都还要各自算 512 个实例矩阵）。
         * 合并后每个素材只剩 1~3 个槽位（树按「叶/枝/干」分，草只剩 1 个）。
         *
         * ⚠️ 合并要求所有几何体**属性集完全一致**，所以统一只留 position/normal/uv，
         *    别的（tangent / uv1 / color）一律删掉 —— 我们用的是 MeshStandardNodeMaterial，
         *    只需要这三样。 */
        const groupsByMat = new Map<string, { mat: any; geos: THREE.BufferGeometry[] }>();
        const meshes: any[] = [];
        let inv = new THREE.Matrix4();

        if (def.proc) {
            /* 程序化素材（蘑菇 / 石板）：不下载 GLB，直接由 `core/forestProc.ts`
             * 生成几何体与材质。用一个临时 `Group` 包一层，后面「按材质合并 + 贴地」
             * 的代码路径与 GLB 素材**完全共用**。 */
            const holder = new THREE.Group();
            for (const part of buildProcAsset(def.proc)) {
                holder.add(new THREE.Mesh(part.geometry, part.material));
            }
            holder.updateMatrixWorld(true);
            holder.traverse((o: any) => { if (o.isMesh) meshes.push(o); });
        } else {
            let gltf: any;
            try {
                gltf = await loader.loadAsync(def.url);
            } catch (e) {
                /* ⚠️ 4a：这里原本是 `console.warn` + `continue` —— 18 个素材全失败时
                 * 一棵树都没有，而页面上只有几条 warn。现在登记进 `missing`
                 * （稍后进 `window.__forest.missing`）并升级成 **error**。 */
                missing.push({ key, url: def.url, error: errText(e) });
                console.error(`[forest] 素材加载失败 ${key} (${def.url}) —— ${errText(e)}`);
                continue;
            }
            gltf.scene.updateMatrixWorld(true);
            inv = gltf.scene.matrixWorld.clone().invert();
            gltf.scene.traverse((o: any) => { if (o.isMesh) meshes.push(o); });
        }

        for (const mm of meshes) {
            const src = (Array.isArray(mm.material) ? mm.material[0] : mm.material) as any;
            // ⚠️ 别把这个变量也叫 `key`（外层是素材名），否则后面那条 console.warn 会打印错的素材名
            const mk = String(src?.name ?? '') + '#' + (src?.uuid ?? '');
            const local = inv.clone().multiply(mm.matrixWorld);
            const g = (mm.geometry as THREE.BufferGeometry).clone();
            g.applyMatrix4(local);
            /* ⚠️⚠️ 这段「只留 position/normal/uv」的清洗会把 **COLOR_0 一起删掉**。
             * 2026-10-12 用户 m02188 的叶片明暗（顶点色）就是死在这里：
             *   GLB 里明明有（`_tools/glbcolor.py` 实测 `leaves COLOR_0 VEC4 ushort norm`），
             *   运行时却是 `attrs=[position,normal,uv]` ⇒ 开关 A/B 逐像素几乎相同。
             * ⇒ `color` 必须放行（其余 tangent 之类照旧删掉省显存）。 */
            for (const name of Object.keys(g.attributes)) {
                if (name === 'color') {
                    /* 只有**树**保留顶点色（叶片明暗）。别的素材（石头/草卡/花/蘑菇）
                     * 沿用老行为删掉 —— 它们各自的材质路径不是为顶点色设计的，
                     * 顺手改到它们的观感就不是这次要做的事了。 */
                    if (!def.leafy) g.deleteAttribute(name);
                    continue;
                }
                if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
            }
            /* 顶点色统一转成 `float32 × 3`。
             * Blender 把 COLOR_0 导出成 `VEC4 / UNSIGNED_SHORT / normalized`
             * （`_tools/glbcolor.py` 实测），而 TSL 的 `attribute('color','vec3')`
             * 声明的是 `vec3<f32>` —— 顶点缓冲却是 `uint16x4norm`，
             * WebGPU 建管线时会报 attribute 与 vertex buffer layout 不兼容。
             * 一次性转掉，约 0.2~0.4 MB/物种，换掉整类格式坑。 */
            const ca = g.getAttribute('color') as THREE.BufferAttribute | undefined;
            if (ca && (!(ca.array instanceof Float32Array) || ca.itemSize !== 3)) {
                const n = ca.count;
                const f = new Float32Array(n * 3);
                for (let i = 0; i < n; i++) {
                    f[i * 3] = ca.getX(i);
                    f[i * 3 + 1] = ca.getY(i);
                    f[i * 3 + 2] = ca.getZ(i);
                }
                g.setAttribute('color', new THREE.BufferAttribute(f, 3));
            }
            if (!g.attributes.normal) g.computeVertexNormals();
            if (!g.attributes.uv) {
                g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
            }
            let e = groupsByMat.get(mk);
            if (!e) { e = { mat: src, geos: [] }; groupsByMat.set(mk, e); }
            e.geos.push(g);
        }

        /* ── 树冠「加厚」───────────────────────────────────────────
         * `island_tree_03` 这类素材的叶片是**沿细枝散落的小面片**，实物比例放大到
         * 8 米高之后，叶子之间的空隙比叶子还大 ⇒ 出图是一片**光秃秃的枝杈纠缠**，
         * 完全不是参考图里那种连成一片的冠层。
         * 把叶组几何体在**水平方向围绕树干轴**放大一点，叶片间隙就合上了 ——
         * 这是**纯缩放、不加一个三角**的做法（判据：先找免费的杠杆）。 */
        if (def.leafy) {
            for (const { mat, geos } of groupsByMat.values()) {
                if (!LEAF_NAME_RE.test(String(mat?.name || ''))) continue;
                for (const g of geos) g.scale(LEAF_SPREAD, LEAF_SPREAD_Y, LEAF_SPREAD);
            }
        }

        /* ── 贴地：把**整株**的最低点压到 y = 0 ──────────────────────
         * `ph-blender.py --ground` 本该做这件事，但实测有素材没落到 0
         * （`f_flower_a` 合并后 min.y = 0.24、`f_flower_d` = 0.06）
         * ⇒ 乘上缩放后花会**浮在地面上方** 8~13 cm，眼睛看得出来。
         *
         * ⚠️⚠️ 必须按**整株**算一个 `y0`，不能每个材质组各算各的：
         *     树的叶子与树干是两个材质组，各自贴地会把**树冠平移到树干底部**
         *     —— 出图就是「一丛灌木长在树桩旁边」。 */
        let y0 = Infinity;
        for (const { geos } of groupsByMat.values()) {
            for (const g of geos) {
                g.computeBoundingBox();
                y0 = Math.min(y0, g.boundingBox!.min.y);
            }
        }
        if (isFinite(y0) && Math.abs(y0) > 1e-4) {
            for (const { geos } of groupsByMat.values()) for (const g of geos) g.translate(0, -y0, 0);
        }
        for (const { geos } of groupsByMat.values()) {
            for (const g of geos) { g.computeBoundingBox(); g.computeBoundingSphere(); }
        }

        /* 「加载成功但一件几何体都没有」也是失败 —— 老代码在这里会静默跳过，
         * 最终表现同样是「没有树」，但 `missing` 里看不出原因。 */
        if (groupsByMat.size === 0) {
            missing.push({ key, url: def.url || `proc:${def.proc}`, error: 'loaded but produced no geometry' });
            console.error(`[forest] 素材无几何体 ${key} (${def.url || def.proc})`);
            continue;
        }
        loaded++;

        let gi = 0;
        for (const { mat: src, geos } of groupsByMat.values()) {
            const gIdx = gi++;
            let geo: THREE.BufferGeometry;
            try {
                geo = geos.length === 1 ? geos[0] : (mergeGeometries(geos, false) as THREE.BufferGeometry);
            } catch (e) {
                console.warn(`[forest] ${key} 子网格合并失败，退回逐个实例化:`, e);
                geo = geos[0];
            }
            if (!geo) continue;

            const isLeaf = !!def.leafy && LEAF_NAME_RE.test(String(src?.name || ''));
            // 「剪影卡片」：GLTF 标了透明/抠图，但贴图其实没有 alpha 通道（全是黑底 JPG）
            const isCard = !isLeaf && (src?.transparent === true || (src?.alphaTest ?? 0) > 0);

            const add = (tint: number, mat: THREE.Material, leafTint: number | null) => {
                const im = new THREE.InstancedMesh(geo, mat, CAP);
                im.name = `${key}|${gIdx}|${tint}`;
                im.castShadow = false;
                im.receiveShadow = false;
                // 实例散布在 160 m 见方里，基础包围球只有模型本身那么大 ⇒
                // 不关掉视锥剔除会被整批剔掉（一阵一阵闪）。
                im.frustumCulled = false;
                /* ★★ 2026-10-22 第七轮：**建出来先不进场景**，等 `refill()` 拿到真实实例
                 * 再 `group.add()`（见 `refill()` 里 `if (!s.mesh.parent)` 那段）。
                 *
                 * 病灶（实证，`_logs/t5/` 全套对照）：一个 InstancedMesh 只要**在还没有
                 *   真实实例的某一帧被渲染器扫到过**，它的 GPU 侧实例绑定就定格在那一帧，
                 *   之后无论 `count` 提到多少、`instanceMatrix.needsUpdate` 置几次都刷不动
                 *   ⇒ 整片森林「提交 340 万个三角形但零像素」。
                 *   （`RenderObject.js:580` 在 `instanceCount === 0` 时直接 `return null` 不发
                 *    draw，但 `Pipelines.getForRender` 在取 drawParams **之前**就建好了管线；
                 *    `InstanceNode.update()` 又只在物体被真正 draw 时才跑 ⇒ 首帧那份数据永远
                 *    停在原地。）
                 *
                 * 已验证无效的修法（都试过了，别再回头）：
                 *   - `count = 1` + 零尺度矩阵占位 + `DynamicDrawUsage` → **纯回归**，
                 *     连原本能出树的「直接出生」也一起弄瞎（`_logs/t5/fix2/`，三机位全 241 KB）
                 *   - 只 `needsUpdate` / 换新 instanceMatrix / 克隆 geometry / `count = 1600`
                 *     / 只改 `alphaTest` / 只置空 `map` / 强制 `group.visible = true` → 全部无效
                 *   - 800 ms 后 `material.clone()`（V1）能出树，但会在首帧分叉出两套材质，
                 *     `leafTint` 的 uniform / 共享状态脱钩 —— 也不再走这条路
                 *
                 * 现在这条路的三条依据：
                 *   - `J3`：运行期 `new InstancedMesh(...)` 拿到数据后再进场景 → 出像素
                 *   - `X3`：有真实数据后 `remove + add` → 出树（384 KB）
                 *   - 静态 `?cam=` 与「直接出生」都出树 ⇒ 只要首帧就带真实数据就没事
                 *
                 * ⚠️ `instanceMatrix` 保持默认 `StaticDrawUsage`：`DynamicDrawUsage` 走的是
                 *   `updateRanges` 增量上传（`setMatrixAt` 不登记范围），`needsUpdate` 不见得
                 *   会把整块 100 KB 的矩阵数组推上去 —— 这正是上一版回归的疑点。 */
                im.count = 0;
                const slot: Slot = { id: im.name, mesh: im, key, leafTint };
                slots.push(slot);
                let arr = byKey.get(key);
                if (!arr) { arr = []; byKey.set(key, arr); }
                arr.push(slot);
            };

            if (isLeaf) {
                /* 叶片明暗（用户 m02188）：树冠原本是一块平色 ⇒ 糊成一团亮色块。
                 * `_tools/treegen.py` 已把「冠内高度 / 到冠轴距离 / 单片随机」三层遮蔽
                 * 烘进顶点色 `COLOR_0`，这里只要确认几何体**真的带**这个属性再开。
                 * ⚠️ 不带就开 ⇒ `attribute('color')` 取到全 0 ⇒ 整片森林变黑。 */
                const hasVCol = !!geo.getAttribute('color');
                setLeafVertexShade(LEAF_VSHADE_ON && hasVCol);
                // 两种叶色各一个 InstancedMesh（材质不同，不能靠 instanceColor）
                for (let t = 0; t < LEAF_TINTS.length; t++) {
                    add(t, makeLeafMaterial(src, LEAF_TINTS[t], LEAF_GAIN, LEAF_EMIS), t);
                }
            } else if (isCard) {
                add(0, makeCutoutMaterial(src, FOREST_GAIN, FOREST_EMIS), null);
            } else if (def.leafy) {
                /* ★ 2026-10-11 m08938「树干不是自发光」：树干叠一层**高度遮蔽**。
                 *
                 *  先澄清「自发光」这条：`_tools/treegen.py` 导出的 GLB 里
                 *  `emissiveFactor` 是 `None`（全黑），树干分支也从来没设过 emissive
                 *  —— `FOREST_EMIS` 只给 `isCard`（草/花卡片）用。
                 *
                 *  用户看到的「发白/发平」真因是**全项目关了阴影**
                 *  （`castShadow = receiveShadow = false`，本文件 `:209` 一脉相承），
                 *  一根圆柱每个横截面收到完全相同的光 ⇒ 读成一条平的色带。
                 *
                 *  ⚠️⚠️ **不能换成 `new MeshStandardNodeMaterial()` + 显式 `texture()`**
                 *  （第一版就是这么写的，整个森林从场景里消失，出图只剩地面）。
                 *  页面 console 抓到：
                 *      [error] THREE.WebGPURenderer: Unsupported texture type with RGBFormat. 1009
                 *      [warning] THREE.WebGPURenderer: Texture format not supported.
                 *  树皮贴图是 **JPEG（RGB 三通道，无 alpha）**，走 GLTFLoader 的标准路径时
                 *  three 会替我们处理格式；自己 `node.map = m.map` 再 `texture(m.map, uv())`
                 *  就把它推进了 **RGBFormat** 这条路，而这个 WebGPU 后端不认
                 *  ⇒ 实例化网格一个都不出。叶子那边没踩到，是因为叶子用的是
                 *    `leaf_atlas_*.png`（**RGBA**），不是 JPEG。
                 *  ⇒ 正确做法：**在源材质上就地挂 `colorNode`**，不重建材质、不碰 `map`。
                 *    源材质是 GLTFLoader 建的 `MeshStandardNodeMaterial`（所以 `colorNode`
                 *    这个 TSL 入口本来就存在，坑 45 说的「写在普通 MeshStandardMaterial 上
                 *    会被静默忽略」在这里不适用）。 */
                applyBarkShade(src, BARK_TINT, BARK_AO_FLOOR, BARK_AO_TOP, FOREST_GAIN);
                if (src && src.color) {
                    src.color.multiply(BARK_TINT);
                    src.color.multiplyScalar(FOREST_GAIN);
                    src.needsUpdate = true;
                }
                /* ★★ 2026-10-12 修「森林只有叶子没有树干」：
                 *  上面这一支原本**只改材质、没有 `add()`**（是当年排查 RGBFormat 时
                 *  把 `add(0, src, null);` 弄丢了），于是树干的 InstancedMesh 从来没被创建，
                 *  叶色槽照常出图 ⇒ 树冠浮在半空、下面一根杆都没有。
                 *  取证：`_tools/spec-tree7.json` 的 eval 里把 map 名含 `leaf_atlas` 的全部
                 *  `visible=false`，出图 `V2_trunkonly.png` 只剩地形和石头，一棵树干都没有。 */
                add(0, src, null);
            } else {
                if (src && src.color) {
                    /* 反照率校正**只对下载来的素材**做：程序化素材（蘑菇/石板）
                     *  的颜色是我们在 `forestProc.ts` 里亲手定的，再乘一层就跑了。
                     *  `key` 是**素材名**（不是材质名），所以这里的判的是「这件素材是什么」。 */
                    if (!def.proc) {
                        if (def.leafy) src.color.multiply(BARK_TINT);
                        else if (/rock|boulder|pebble|stone/i.test(key)) src.color.multiply(ROCK_TINT);
                    }
                    src.color.multiplyScalar(FOREST_GAIN);
                    src.needsUpdate = true;
                }
                add(0, src, null);
            }
        }
    }
    /* 全部失败时最响的那一条：带**一步定位**判据（见文件上方 4a 长注释）。 */
    if (missing.length > 0 && loaded === 0) {
        console.error(
            `[forest] 全部 ${missing.length} 个素材都没建出来 ⇒ 整片森林是空的。`
            + ' 定位：在地址栏直接打开 ' + (missing[0]?.url || '/forest/real/p_oak.glb')
            + ' —— 能下载到文件＝路径对（问题在解析/材质，看上面同类 error）；'
            + ' 404 或返回 index.html＝静态宿主没带 public/forest/real 或 base 不是站点根。'
            + ' 清单见 window.__forest.missing。',
        );
    }
    return { group, slots, byKey, loaded, missing };
}

function refill(built: Built, camX: number, camZ: number, seed: number): { total: number; capped: number; per: Record<string, number> } {
    const cursor = new Map<Slot, number>();
    let total = 0;
    let capped = 0;
    /* ★★ 2026-10-23 第九轮：树干碰撞体跟着实例一起重建（用户反馈 3「人物直接穿过树干」）。
     *
     *  为什么在这里发布：`collectForest()` 的每件道具都带 `key / x / z / h / sxz`，
     *  世界树干半径 = `frac(key) × h × sxz` —— 这是**唯一**能拿到真实实例尺寸的时机。
     *  去读 InstancedMesh 的实例矩阵反解世界坐标要多走一层 GPU buffer，得不偿失。
     *
     *  ⚠️ 发布点必须在 `for (const slot of list)` **外面**：一个道具可能对应两个叶色槽
     *     （`slot.leafTint !== null` 那条 continue），写在里面会让同一棵树重复注册两次。
     *  ⚠️ 森林按相机铺、32 m 一次 `refill()` ⇒ 这里是整表重建，不是增量追加。 */
    resetTreeColliders();
    collectForest(camX, camZ, seed, (p) => {
        const list = built.byKey.get(p.key);
        if (!list) return;
        total++;
        addTreeCollider(p.key, p.x, p.z, p.h, p.sxz);
        for (const slot of list) {
            // 叶色槽只吃对上色的件；树干/树枝/石头等 `leafTint === null`，两色都要长
            if (slot.leafTint !== null && slot.leafTint !== p.tint) continue;
            const i = cursor.get(slot) ?? 0;
            if (i >= CAP) { capped++; continue; }
            cursor.set(slot, i + 1);
            _e.set(0, p.rot, 0);
            _q.setFromEuler(_e);
            _p.set(p.x, p.y, p.z);
            _s.set(Math.max(0.01, p.h * p.sxz), p.h, Math.max(0.01, p.h * p.sxz));
            _m.compose(_p, _q, _s);
            slot.mesh.setMatrixAt(i, _m);
        }
    });
    const per: Record<string, number> = {};
    for (const s of built.slots) {
        const n = cursor.get(s) ?? 0;
        /* ★★ 2026-10-22 第七轮：**先写数据，再进场景**（详见 `add()` 里那段长注释）。
         *
         *   旧写法的问题：`add()` 里 `group.add(im)` 发生在建槽那一刻，此时
         *   `count = 0`；首帧渲染器扫到它、把实例绑定定格在「空」的状态，之后
         *   `refill()` 再写矩阵也没用（`_logs/t5/fix2/` 三机位全 241 KB = 零树）。
         *
         *   现在：`add()` 不再 `group.add()`，第一次 `refill()` 拿到 `n > 0` 才把它挂进
         *   场景 —— 渲染器第一次见到它时，`count` 与 `instanceMatrix` 已是最终内容。
         *
         *   `n === 0` 时**保持不挂**（不是 `count = 1` 占位）：没实例就不该被扫到。
         *   离开森林区块时 `count` 归 0 但对象仍在场景里——这是**允许**的，因为
         *   「定格」只发生在它第一次被扫到的那一帧，而那一帧一定已经是真实数据。 */
        s.mesh.count = n;
        if (n > 0) {
            s.mesh.instanceMatrix.needsUpdate = true;
            per[s.id] = n;
            if (!s.mesh.parent) built.group.add(s.mesh);
        }
        /* `n === 0`：`count` 归 0、对象留在场景里也不影响 —— 「定格」只发生在它
         * 第一次被扫到的那一帧，而那一帧按上面的逻辑一定已经有真实数据。 */
    }
    return { total, capped, per };
}

/* ════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-23 第八轮：「首次进场景」的一次性成本挪到加载期付掉 ★★
 *
 * 用户反馈：「森林刷出来了，但**刷新慢**、刷新过程**卡顿**；月坑水体同样」。
 * 实测（冻结构建 `dist-verify-perf-base`，preview 9435，1280×720，
 * `_logs/round6/results-perf-base.jsonl`）：
 *   · 会场出生处 `total = 0`（会场不在森林区）⇒ 没有任何槽位进过场景；
 *   · 第一次走进森林、`refill()` 在一帧内挂上 50 个槽位 → **982.3 ms 单帧**
 *     （t = 5537 ms）；这就是用户感知到的「刷新慢 / 卡顿」；
 *   · 之后纯换格只有 13~17 ms（`collectForest` 25 个 chunk ≈ 11 ms 超额）。
 *
 * 这 982 ms 是什么（三次探针 `_logs/round6/pre-warmtest*.js`，都只改运行时对象）：
 *   · warmtest1 逐帧挂 1 槽（真实非零矩阵）≈ 34 ms/槽，合计 ≈ 2.3 s；
 *   · warmtest2 一帧挂全部 57 槽 = **1044.5 ms**；全摘掉、隔帧再挂 57 槽
 *     = **6.6 ms** ⇒ 成本是**一次性**的（管线编译 + 纹理/几何首次上传），
 *     不是每次挂载都要付；
 *   · warmtest3 用**替身 InstancedMesh**（同 geometry、同 material、`count = 1`、
 *     真实矩阵）先编译一遍 → 真实槽位首次挂载**仍然 1225 + 1450 ms**
 *     ⇒ 成本绑在**具体的那个 InstancedMesh 对象**上，替身替不了别人。
 *
 * 所以修法只有一条：让每个**真实**槽位自己先把这笔成本付掉，而且趁玩家
 * 还看不见它的时候付。做法是「真实矩阵挂一帧 → 立刻摘掉」：
 *   · 挂的时候 `count = 1` 且矩阵是**真实非零尺度**（不是当年被证否的
 *     `count = 1` + 零尺度占位）⇒ `InstanceNode.update()` 真的跑过一次，
 *     实例绑定被正确建立；
 *   · **隔帧**再 `group.remove()` —— 与第七轮取证 X3 同型（`remove` 之后
 *     `add` 能正常出树，384 KB），而同一 tick 内的 `remove/add`（Y1）无效；
 *   · 之后 `refill()` 的 `group.add()` 仍然发生在「数据已写完」之后，
 *     第七轮「先写数据后进场景」的**不变式原样保留**，槽位不会被定格。
 *
 * 分批 + 自适应批量：每帧目标 ≤ `WARM_BUDGET_MS`（默认 45 ms），用上一批的
 * 实测帧时做 EWMA 估每槽成本。加载期总共多花约 1 s 墙钟，但**不出现长帧**。
 * `?fwarm=0` 可关掉做 A/B。
 * ════════════════════════════════════════════════════════════════════════ */
const WARM_ON = QNUM('fwarm', 1)! > 0;
const WARM_BUDGET_MS = QNUM('fwarmbudget', 45)!;
/** 预热用的替身位置：相机正下方 800 m。槽位 `frustumCulled = false`，
 *  所以照样提交、管线照样编译，但一定不出现在画面里。 */
const WARM_Y = -800;

interface WarmState {
    /** 还没付过成本的槽位 */
    pending: Slot[];
    /** 当前这一批：本帧挂上，下一帧摘掉 */
    batch: Slot[];
    batchAt: number;
    /** 每槽边际成本 EWMA（ms） */
    estMs: number;
    /** 每槽最坏成本（慢衰减，ms）。
     *  为什么不能只用 `estMs`：摘批后槽位又变回「无 parent」，`refill()` 里按
     *  `!mesh.parent` 重算 pending 会把付过成本的槽位塞回来 ⇒ 这些「复热」批次
     *  几乎零成本（管线已编译），把 `estMs` 拖到下限 2 ms，`k` 于是涨到 8，
     *  下一批 8 个**真槽**同帧编译 —— 实测撞出 374~430 ms 尖峰。
     *  定量一律用 `max(peakMs, estMs)`，让一批的峰值成本只看最坏的那一档。 */
    peakMs: number;
    batches: number;
    slots: number;
    /** 已经付过成本的槽位（按对象身份记）。
     *  摘批后它们同样是「无 parent」，只靠 `!mesh.parent` 判不出来 ——
     *  实测重复预热把 `done` 推到 160（真实 57 槽），warm 总耗时 10.6 s。 */
    warmed: Set<Slot>;
    startMs: number;
    endMs: number;
    /** 本帧刚摘掉一批 ⇒ `refill()` 必须顺延一帧（第七轮 Y1：同 tick remove+add 无效）。 */
    holdRefill: boolean;
    /** 逐批实测（诊断用）：`[相对 startMs 的时刻, 本批槽数, 该批那一帧的帧时]` */
    log: [number, number, number][];
}

/** 一次预热最多塞几槽（`?fwarmk`）。真槽单槽成本约 50 ms，8 槽同帧必炸。 */
const WARM_MAX_K = Math.max(1, Math.round(QNUM('fwarmk', 2)!));

function makeWarm(built: Built): WarmState {
    /* 已经在场景里的槽位（已经有真实数据）不碰 —— 它们已经付过这笔成本。 */
    const pending = built.slots.filter((s) => !s.mesh.parent);
    const warmed = new Set(built.slots.filter((s) => !!s.mesh.parent));
    return {
        pending, batch: [], batchAt: 0, estMs: 24, peakMs: 40, batches: 0, slots: 0,
        warmed, startMs: performance.now(), endMs: 0, holdRefill: false, log: [],
    };
}

/** 下一次该预热哪些槽：只取「从没付过成本」的，别把复热算进进度。 */
function warmPending(built: Built, W: WarmState): Slot[] {
    return built.slots.filter((s) => !s.mesh.parent && !W.warmed.has(s));
}

function warmPublish(W: WarmState): void {
    (window as any).__forestWarm = {
        mode: 'warm-remove',
        done: W.slots,
        total: W.slots + W.pending.length,
        batches: W.batches,
        estMs: +W.estMs.toFixed(1),
        peakMs: +W.peakMs.toFixed(1),
        hold: W.holdRefill,
        ms: +(performance.now() - W.startMs).toFixed(0),
        endMs: W.endMs ? +W.endMs.toFixed(0) : 0,
        log: W.log,
    };
}

/** 只摘不挂：把当前批次移出场景。
 *  **必须与挂载分属两帧** —— 第七轮 Y1 取证「同一 tick 内 `remove`+`add` 无效」
 *  （实例绑定被打回定格态），X3 取证「隔帧 `remove` 之后 `add` 正常出树」。
 *  因此真换格撞上预热批次时，`refill()` 要顺延一帧（见 `useFrame`）。 */
function warmDropBatch(built: Built, W: WarmState): void {
    for (const s of W.batch) {
        built.group.remove(s.mesh);
        s.mesh.count = 0;
        /* 记成「付过成本」：之后 `refill()` 重算 pending 时才不会把它塞回队列。 */
        W.warmed.add(s);
    }
    W.batch = [];
    W.batchAt = 0;
}

/** 每帧推进一步：挂一批 → 下一帧摘掉 → 再挂下一批。 */
function warmStep(built: Built, camX: number, camZ: number, W: WarmState, frameDt: number): void {
    const now = performance.now();
    if (W.batch.length > 0) {
        /* 上一批已经真的画过一帧（管线编译 + 首次上传都发生在那一帧）⇒ 摘掉。
         * 用这一帧的实测时长更新每槽成本，下一批据此定量。 */
        const dt = now - W.batchAt;
        const per = Math.max(2, (dt - 7) / W.batch.length);
        W.estMs = W.estMs * 0.5 + per * 0.5;
        /* 峰值只升不降（缓慢回落）：一批炸了就必须记住，否则下一批又超发。 */
        W.peakMs = per > W.peakMs ? per : W.peakMs * 0.9 + per * 0.1;
        if (W.log.length < 240) W.log.push([+(now - W.startMs).toFixed(0), W.batch.length, +dt.toFixed(1)]);
        warmDropBatch(built, W);
        if (W.pending.length === 0) W.endMs = now;
        warmPublish(W);
        return;
    }
    if (W.pending.length === 0) {
        if (!W.endMs) W.endMs = now;
        return;
    }
    /* 当前的帧已经很长（资源上传 / 地形重建…）⇒ 这一帧别再往上叠编译成本。
     * 实测：不加这道闸，预热批次会和加载期的 200~260 ms 长帧叠在同一帧。
     * 阈值就是 `WARM_BUDGET_MS`（默认 45 ms）：60 fps 的正常帧（16 ms）永远不触发，
     * 而刚被上一批拖长的帧会自然跳过，形成「一批 / 隔一帧」的节流。 */
    if (frameDt > WARM_BUDGET_MS) return;
    /* 定量看「最坏单槽成本」而不是 EWMA：复热批次会把 EWMA 压到 2 ms。 */
    const sizing = Math.max(4, W.peakMs, W.estMs);
    const k = Math.max(1, Math.min(WARM_MAX_K, Math.round(WARM_BUDGET_MS / sizing)));
    const take = W.pending.splice(0, k);
    for (const s of take) {
        _p.set(camX, WARM_Y, camZ);
        _q.identity();
        _s.set(1, 1, 1);
        _m.compose(_p, _q, _s);
        s.mesh.setMatrixAt(0, _m);
        s.mesh.count = 1;
        s.mesh.instanceMatrix.needsUpdate = true;
        built.group.add(s.mesh);
    }
    W.batch = take;
    W.batchAt = performance.now();
    W.batches++;
    W.slots += take.length;
    warmPublish(W);
}

export function Forest({ visible = true }: { visible?: boolean }) {
    const camera = useThree((s: any) => s.camera);
    /* 只读诊断（2026-10-22 第五轮）：判定「R3F 真正渲染的 scene」是不是森林组所在的那棵 ——
     * 若两者不是同一对象，实例数据再正确也不会出现在画面里。 */
    const r3fScene = useThree((s: any) => s.scene);
    const r3fGl = useThree((s: any) => s.gl);
    const [built, setBuilt] = useState<Built | null>(null);
    const lastCell = useRef<{ x: number; z: number } | null>(null);
    /** 第八轮：加载期预热作业（见下方 `makeWarm` / `warmStep` 的长注释）。 */
    const warmRef = useRef<WarmState | null>(null);
    /* ⚠️⚠️ 管线预热：森林「画了但零像素」的根因与修法（2026-10-22 第五轮）。
     *
     * 病灶：`add()` 为了「首帧就带实例路径」把 `count` 设成 1 并压入零尺度矩阵，
     *   那份管线是在**还没有真实实例**（会场出生处 `total = 0`）时编译的。之后
     *   `refill()` 把 `count` 提到 16~24、矩阵写进 buffer、`instanceMatrix.needsUpdate`
     *   也置了，但 WebGPU 后端**复用第一次编译的管线/instance 绑定** ⇒ 实例矩阵到不了
     *   顶点着色器 ⇒ 整片森林零像素（`draw calls` 正常、`visible` 全 true、矩阵读数全对）。
     *
     * 决定性对照（同机位 1280×720，第三人称传送到 39.7,-110，全部在 `_logs/t5/captain/`）：
     *   - 基线（首帧 `count = 1` 占位）                        → 241 KB，无树
     *   - 传送后（已渲染多帧）`group.remove(mesh); group.add(mesh)` → **384 KB，出树** ← X3
     *   - 传送后 `material.clone()` 全量替换                    → 531 KB，出树     ← V1
     *   - 换全新 `MeshStandardNodeMaterial`                     → 出树             ← U2
     *   - 把**同一个**材质对象重新挂回去                         → 241 KB，无树     ← V3
     *   - 换新 `instanceMatrix` attribute / 克隆 geometry / `count = 1600`
     *     / 只 `needsUpdate` / 只改 `alphaTest` / 只置空 `map`   → **全部无效**
     *   - **在 `refill()` 同一 tick 里做 `remove/add`**          → 241 KB，无效     ← Y1
     *   ⇒ 与矩阵内容、视锥、可见性、材质数据都无关：后端要看到「这一帧它按新的
     *     count 画过」，再重新登记节点，instance 绑定才会重建。
     *
     * 修法（第七轮，已实现）：**不要预热**。槽位在 `add()` 里不再进场景，
     *   第一次 `refill()` 拿到真实 `n > 0` 才 `group.add()` —— 渲染器第一次
     *   见到它时数据已经是终态，不需要任何「隔帧重登记」或「换材质」的补丁。
     *   上一版 800 ms `material.clone()` 预热已删除（V1 会分叉材质，见上）。 */
    /* 旧的 `warmTimer`（800 ms 后逐槽 `material.clone()` 预热）已在第七轮删除 ——
     * 见下方 `__forestWarm` 那行注释：现在是「首次拿到真实数据才进场景」，不需要预热。 */

    useEffect(() => {
        if (!FOREST_ON) return;
        let dead = false;
        /* 4a：构建整体失败也要响 —— 原来这里只有 `console.warn`，
         * 于是「buildForest 抛异常」和「这附近确实没树」在页面上长得一模一样。 */
        const publishFail = (e: any) => {
            const missing: ForestMissing[] = [{ key: '<build>', url: '', error: errText(e) }];
            console.error('[forest] 构建失败（整片森林没有生成）:', e);
            (window as any).__forestBuildError = errText(e);
            (window as any).__forestMissing = { missing, missingCount: 1, assets: Object.keys(FOREST_ASSETS).length, loaded: 0, ok: false };
            (window as any).__forest = {
                total: 0, capped: 0, per: {}, cell: [0, 0], seed: SEED,
                missing, missingCount: 1, assets: Object.keys(FOREST_ASSETS).length, loaded: 0,
                buildFailed: true, ok: false,
            };
        };
        buildForest().then((b) => {
            if (dead) return;
            /* 构建完成那一刻就把 `missing` 挂出去（不必等相机跨 chunk）——
             * 「一个素材都没加载出来」必须在用户还没走动时就能读到。 */
            (window as any).__forestMissing = {
                missing: b.missing,
                missingCount: b.missing.length,
                assets: Object.keys(FOREST_ASSETS).length,
                loaded: b.loaded,
                ok: b.loaded > 0 && b.missing.length === 0,
            };
            setBuilt(b);
        }).catch(publishFail);
        return () => { dead = true; };
    }, []);

    useFrame((_state, delta) => {
        if (!built || !camera) return;
        /* 只读诊断句柄（2026-10-22 第五轮）：`__forestCam` 只有位置，查不出
         * 「树到底在不在视锥里」——同一坐标 `?cam` 自由相机看得见整片林、
         * 第三人称一棵都看不见，必须拿相机矩阵把实例逐件投影到 NDC 才能定因。
         * 只挂引用，不改变任何渲染行为。 */
        (window as any).__forestCamObj = camera;
        (window as any).__forestDbg = { scene: r3fScene, gl: r3fGl, camera };
        const cx = Math.floor(camera.position.x / CHUNK);
        const cz = Math.floor(camera.position.z / CHUNK);
        const moved = !lastCell.current || lastCell.current.x !== cx || lastCell.current.z !== cz;

        /* ── 加载期预热（第八轮，见上方长注释）：把「首次进场景」的一次性成本
         *    摊到换格发生之前。
         *    ⚠️ 换格撞上预热批次时，本帧**只摘不挂**，`refill()` 顺延到下一帧：
         *    第七轮 Y1 已证「同一 tick 里 remove+add」会把实例绑定打回定格态。 */
        if (WARM_ON) {
            let W = warmRef.current;
            if (!W) { W = warmRef.current = makeWarm(built); warmPublish(W); }
            if (W.batch.length > 0 && moved) {
                warmDropBatch(built, W);
                W.holdRefill = true;
                warmPublish(W);
                return;
            }
            if (!moved && (W.pending.length > 0 || W.batch.length > 0)) {
                /* `delta` 是上一帧的真实时长（秒）⇒ ms。预热要避让已经卡住的帧。 */
                warmStep(built, camera.position.x, camera.position.z, W, delta * 1000);
            }
        }

        if (!moved) return;
        lastCell.current = { x: cx, z: cz };
        const st = refill(built, camera.position.x, camera.position.z, SEED);
        /* refill 之后：已经挂进场景的槽位（有真实数据）已经付过一次性成本，
         * 从预热队列里剔除；剩下的继续在后续帧预热，供下一次换格用。 */
        if (WARM_ON && warmRef.current) {
            const W = warmRef.current;
            W.holdRefill = false;
            /* 只认「从没付过成本」的槽 —— 摘批后的槽同样无 parent，用 `!mesh.parent`
             * 会把它们重新排队（实测 done 冲到 160 / 真实 57）。 */
            const pend = warmPending(built, W);
            if (pend.length !== W.pending.length) {
                W.pending = pend;
                if (pend.length === 0 && !W.endMs) W.endMs = performance.now();
            }
            warmPublish(W);
        }
        /* `total/capped/per/cell/seed` 语义**不变**（既有取证脚本按 `total` 判空林）；
         * 4a 新增 `missing/missingCount/assets/loaded/buildFailed/ok`。 */
        (window as any).__forest = {
            ...st,
            cell: [cx, cz],
            seed: SEED,
            missing: built.missing,
            missingCount: built.missing.length,
            assets: Object.keys(FOREST_ASSETS).length,
            loaded: built.loaded,
            buildFailed: false,
            ok: st.total > 0 && built.missing.length === 0,
        };
        // 探针用：把整棵实例组挂到 window 上，CDP eval 里可以遍历查包围盒/实例矩阵
        (window as any).__forestRoot = built;
        (window as any).__forestCam = [camera.position.x, camera.position.y, camera.position.z];
        /* `__forestWarm` 由 `warmPublish()` 发布（第八轮：加载期预热进度）。
         * 第七轮那行 `{ done: 0, mode: 'lazy-add' }` 已删除 —— 它会在每次换格
         * 把预热进度覆盖成常量，取证脚本就读不到真实状态了。 */
    });

    if (!FOREST_ON) {
        /* 被 `?forest=0` 关掉时也要留下痕迹 —— 否则「没有树」分不清是加载失败还是开关关了。 */
        return null;
    }
    if (!built) return null;
    return <primitive object={built.group} visible={visible} />;
}

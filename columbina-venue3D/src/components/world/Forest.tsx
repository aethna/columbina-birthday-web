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
import { buildProcAsset } from '../../core/forestProc';
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
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

async function buildForest(): Promise<Built> {
    const loader = new GLTFLoader();
    const group = new THREE.Group();
    group.name = 'forest';
    const slots: Slot[] = [];
    const byKey = new Map<string, Slot[]>();

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
                console.warn(`[forest] 素材加载失败 ${key} (${def.url}):`, e);
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
                im.count = 0;
                im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
                group.add(im);
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
    return { group, slots, byKey };
}

function refill(built: Built, camX: number, camZ: number, seed: number): { total: number; capped: number; per: Record<string, number> } {
    const cursor = new Map<Slot, number>();
    let total = 0;
    let capped = 0;
    collectForest(camX, camZ, seed, (p) => {
        const list = built.byKey.get(p.key);
        if (!list) return;
        total++;
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
        s.mesh.count = n;
        s.mesh.instanceMatrix.needsUpdate = true;
        if (n) per[s.id] = n;
    }
    return { total, capped, per };
}

export function Forest({ visible = true }: { visible?: boolean }) {
    const camera = useThree((s: any) => s.camera);
    const [built, setBuilt] = useState<Built | null>(null);
    const lastCell = useRef<{ x: number; z: number } | null>(null);

    useEffect(() => {
        if (!FOREST_ON) return;
        let dead = false;
        buildForest().then((b) => {
            if (dead) return;
            setBuilt(b);
        }).catch((e) => console.warn('[forest] 构建失败:', e));
        return () => { dead = true; };
    }, []);

    useFrame(() => {
        if (!built || !camera) return;
        const cx = Math.floor(camera.position.x / CHUNK);
        const cz = Math.floor(camera.position.z / CHUNK);
        if (lastCell.current && lastCell.current.x === cx && lastCell.current.z === cz) return;
        lastCell.current = { x: cx, z: cz };
        const st = refill(built, camera.position.x, camera.position.z, SEED);
        (window as any).__forest = { ...st, cell: [cx, cz], seed: SEED };
        // 探针用：把整棵实例组挂到 window 上，CDP eval 里可以遍历查包围盒/实例矩阵
        (window as any).__forestRoot = built;
        (window as any).__forestCam = [camera.position.x, camera.position.y, camera.position.z];
    });

    if (!FOREST_ON || !built) return null;
    return <primitive object={built.group} visible={visible} />;
}

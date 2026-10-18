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
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { worldHeightCPU } from '../../core/worldRegions';
import { keepOutFactor } from '../../core/world/keepOut';
import { QNUM } from '../../core/utils/query';

/* ══════════════════════════════════════════════════════════════════════════
 * 0. URL 开关与常量
 * ══════════════════════════════════════════════════════════════════════════ */

/** 总开关。`?flower=0` 时组件直接 `return null`，连加载都不发起。 */
const FLOWER_ON = QNUM('flower', 1)! > 0;

/** 素材地址（`public/` 下的绝对路径，与 `DeskProps.tsx` 的写法一致）。 */
const FLOWER_URL = '/venue/flowers/blue_trumpet.glb';

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

/** 贴地下沉量（米）。地形是起伏的、花又是「平底」的，稍微压进土里 1 cm
 *  比在坡上露出一条缝好看；这个量级也远小于花高，看不出被埋。 */
const SINK = 0.01;

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
 * 3. 装配（glb → 一个 InstancedMesh）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 建好之后**由本组件独占**的东西，卸载时要逐个释放（见 `disposeBuilt`）。 */
interface Built {
    group: THREE.Group;
    im: THREE.InstancedMesh;
    geo: THREE.BufferGeometry;
    mat: THREE.MeshStandardMaterial;
    /** 材质上挂着的贴图（clone 是浅拷贝，贴图对象仍是共享引用 —— 但这份 glb
     *  只被这里加载过，所以由这里负责释放，不会误伤别人）。 */
    textures: THREE.Texture[];
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

function build(gltfRoot: THREE.Object3D, spots: FlowerSpot[]): Built | null {
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

    const textures: THREE.Texture[] = [];
    const seen = new Set<THREE.Texture>();
    for (const key of TEX_SLOTS) {
        const t = mat[key] as THREE.Texture | null | undefined;
        if (t && !seen.has(t)) { seen.add(t); textures.push(t); }
    }

    const im = new THREE.InstancedMesh(geo, mat, spots.length);
    im.name = 'flower-cluster-instances';
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
        const k = baseScale * s.scale;
        _scl.set(k, k, k);
        _mat.compose(_pos, _quat, _scl);
        im.setMatrixAt(i, _mat);
    }
    im.instanceMatrix.needsUpdate = true;

    /* 包围球必须按**实例**重算：几何体自带的包围球只有模型那么大（原点附近），
       而实例铺在半径 46 m 的环上 —— 不重算的话相机一转整片花就被视锥剔掉，
       表现是「花一闪一闪」。这比 `Forest.tsx:271` 那种直接 `frustumCulled=false`
       更省（近处看不到时仍然会剔），所以选重算。 */
    im.computeBoundingSphere();

    const group = new THREE.Group();
    group.name = 'flower-clusters';
    group.add(im);

    return { group, im, geo, mat, textures };
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
    b.group.remove(b.im);
    b.group.parent?.remove(b.group);
    b.im.dispose();          // 实例矩阵缓冲
    b.geo.dispose();
    for (const t of b.textures) t.dispose();
    b.mat.dispose();
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 组件
 * ══════════════════════════════════════════════════════════════════════════ */

/** 探针数据（`_tools/webgpu-shot.mjs --eval` 可以读 `window.__flowers()`）。 */
let LAST_STATS: Record<string, unknown> = {};

export function FlowerClusters({ visible = true }: { visible?: boolean }) {
    const [built, setBuilt] = useState<Built | null>(null);

    useEffect(() => {
        if (!FLOWER_ON) return;

        /* 规划是纯函数、同步的：先算好「该在哪摆多少朵」，
           再去加载模型。这样加载慢的时候控制台里也能先看到件数。 */
        const { spots, clusters, dropped } = planAll();
        if (!spots.length) {
            console.warn('[flower-clusters] 一个花丛都没摆出来（避让区占满了？），跳过加载');
            return;
        }

        let cancelled = false;
        let made: Built | null = null;

        const loader = new GLTFLoader();
        loader.load(
            FLOWER_URL,
            (gltf) => {
                /* 卸载（或 StrictMode 的「挂载→清理→再挂载」）后才回来的：
                   什么都别建，也别 setState —— 建了就是一份没人释放的泄漏。 */
                if (cancelled) return;
                try {
                    made = build(gltf.scene, spots);
                } catch (e) {
                    // 装配阶段的意外同样吞掉：宁可草地上没有花，也不能白屏
                    console.warn('[flower-clusters] 装配失败，本次不摆花丛:', e);
                    return;
                }
                if (!made) return;

                LAST_STATS = {
                    clusters: clusters.length,
                    count: spots.length,
                    dropped,
                    perCluster: clusters.map((c) => c.n),
                    scale: REAL_H,
                    seed: SEED,
                };
                if (FLOWER_DEBUG) {
                    console.info(
                        `[flower-clusters] ${clusters.length} 丛 / ${spots.length} 朵 / `
                        + `丢弃 ${dropped} 朵｜每丛 ${clusters.map((c) => c.n).join(',')}`
                        + `｜种子 ${SEED}`,
                    );
                }

                /* `setState` 触发一次重渲染把 `<primitive>` 挂进场景 ——
                   这是整个组件唯一的 React 状态变化，之后不会再有。 */
                setBuilt(made);
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
            if (made) {
                disposeBuilt(made);
                made = null;
            }
        };
    }, []);

    if (!FLOWER_ON || !built) return null;

    /* `visible={false}` 时**只关 group**，不卸载 InstancedMesh ——
       卸载会重新走一遍「规划 + 下载 + 装配」，而不可见的子树本来就不发 draw call。
       （同 `DeskProps.tsx:539` 对信箱的处理。） */
    return <primitive object={built.group} visible={visible} />;
}

/* 探针：给无头截图脚本读「到底摆了几丛几朵」。 */
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__flowers = () => LAST_STATS;
}

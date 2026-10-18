/**
 * CollectProps —— 委托阶段 13 个「采集点」的视觉道具（**纯程序化几何体**）。
 *
 * ── 这个文件干什么 ─────────────────────────────────────────────────────
 * 玩家在会场各处找到 13 个采集点（野茶丛 / 虹彩蔷薇 / 水下的灯 / 月泉 /
 * 月灵灯 / 散落的小物件 ×5 / 夜路的尽头 / 生日蛋糕 / 水边 / 取水处 /
 * 花丛 / 发光蘑菇 / 干柴堆），走到跟前按 F 交委托。
 * 这里只做**看得见的那一层**：每个点一件道具。交互判定、文案、任务状态
 * 都不归这里管（见 `core/game/interact.ts` 与 `ui/QuestList.tsx`）。
 *
 * ── 坐标从哪来（唯一真值，本文件一个坐标都不自己算）────────────────────
 * 位置一律读 `core/game/layout.ts` 的 `POINT_SPOTS` / `pointXZ()`。
 * 那份文件头上写得很清楚：采集点坐标会被「3D 道具 / NPC 站位 / 小地图 /
 * 交互系统」四处同时读，**谁都不许自己算**。
 * 连「一共有哪几个点」都是 `Object.keys(POINT_SPOTS)` 现取的 ——
 * layout 里加了新点，这里至少会给一个兜底石标（见 `buildFallback`），
 * 而不是静默什么都不画：那样玩家会站在空地上按 F，是最难排查的一种坏。
 *
 * ── 高度（不写死 y = 0）───────────────────────────────────────────────
 * 每个实例 `position.y = worldHeightCPU(x, z) + CP_LIFT`。
 * ⚠️ `worldHeightCPU` 只对**会场中心**（r ≲ 9.5 m）刻意返回 0，而采集点在
 *    r = 28~40 m 的外圈 —— 那里地形有起伏，写死 `y = 0` 会浮空或埋进土里。
 * `CP_LIFT` 缺省 1 cm：地面上的**贴地圆盘**（水坑泥底 / 灯下光晕）与地形网格
 * 共面会 z-fighting（闪烁的摩尔纹），抬 1 cm 是纯渲染需要，不影响落位语义。
 *
 * ── 确定性（项目铁律）─────────────────────────────────────────────────
 * 全部伪随机走 `core/venueRing.ts` 的 `hash01`（PCG 整数混合）。
 * **禁止 `Math.random()` / `fract(sin(...))`**：项目要做「改前 vs 改后」的
 * A/B 截图，随机摆位会让两次截图其实是在比「布局甲 vs 布局乙」（判据 A / N）。
 *
 * ── 三角数预算 ─────────────────────────────────────────────────────────
 * 全部道具**共享一小组「单位几何体」**（见 `makeGeos`），靠每个 mesh 的
 * `scale` 复用同一份顶点数据 —— 这是这里省三角的主要手段。
 * 合计 **5384 三角**（预算 2 万），单点 200~1500，全部达标。
 * 另外，`litter ×5` 是**每处各建一次**而不是 clone 同一份，
 * 否则五处小物件会长得一模一样（一眼假）。
 *
 * ── 为什么 import `three/webgpu` 而不是 `three` ───────────────────────
 * 渲染器是 `WebGPURenderer`（`app/App.tsx:165`）。`three` 与 `three/webgpu`
 * 是**两份不同的类**，混着用会让 `instanceof` / 材质识别出岔子。
 * `MeshStandardMaterial` 在 WebGPU 下会被自动映射成 `MeshStandardNodeMaterial`
 * （AGENT.md 实测），所以普通标准材质就够用，**不要**碰 TSL 的 `*NodeMaterial`
 * ——那套 `colorNode` / `emissiveNode` 是给「必须自定义 BRDF」的场合用的。
 *
 * ── URL 开关（项目规矩：所有要 A/B 的量都得上 URL）─────────────────────
 *   ?cp=0          整组采集点道具不渲染
 *   ?cpgain=<k>    全部自发光强度的总增益（缺省 1.0）
 *   ?cpsink=<m>    水面相对**岸顶**的下沉量（缺省 0.07，见 `addPond`）
 *   ?cplift=<m>    贴地件的抬升量（缺省 0.01，防 z-fighting）
 *   ?cppulse=0     关掉发光脉动（缺省 1）
 *   ?cpdebug=1     打印每个点的三角数与落位
 */
import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { POINT_SPOTS, pointXZ } from '../../core/game/layout';
import { worldHeightCPU } from '../../core/worldRegions';
import { hash01 } from '../../core/venueRing';
import { QNUM } from '../../core/utils/query';

/* ══════════════════════════════════════════════════════════════════════════
 * 0. URL 开关与常量
 * ══════════════════════════════════════════════════════════════════════════ */

/** 总开关。`?cp=0` 时整个组件返回 `null`（连 group 都不建）。 */
const CP_ON = QNUM('cp', 1)! > 0;
/** 自发光总增益 —— 月夜场景里「亮不亮」是要反复调的一个量，必须能上 URL。 */
const CP_GAIN = QNUM('cpgain', 1.0)!;
/** 水面相对岸顶的下沉量（米）。见 `addPond` 的长注释。 */
const CP_SINK = QNUM('cpsink', 0.07)!;
/** 贴地件的抬升量（米），防与地形网格 z-fighting。 */
const CP_LIFT = QNUM('cplift', 0.01)!;
/** 发光脉动开关。 */
const CP_PULSE = QNUM('cppulse', 1)! > 0;
/** 调试打印。 */
const CP_DEBUG = QNUM('cpdebug', 0)! > 0;

/** 相机离场心超过这个距离就整组 `visible = false`（与 `VenuePropsReal.tsx:429`、
 *  `Banquet.tsx:495` 同一套）。地形盘半宽只有 80 m，再远这些道具已经悬在盘外了。 */
const HIDE_R = 130;

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 共享几何体 / 共享材质
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 单位几何体表 —— **全场景只建一次**，所有 mesh 靠 `scale` 复用它。
 *
 * 括号里是三角数（手算，写在这里是为了改的时候一眼看出预算）。
 * 段数都是**刻意压到最低**的：这些小道具在屏幕上最多几十像素高，
 * 8 段球和 32 段球肉眼分不出来，但三角数差 4 倍。
 */
function makeGeos() {
    return {
        /** 36 —— 叶簇 / 花心 / 面团这类「圆乎乎的团块」 */
        blob: new THREE.SphereGeometry(1, 6, 4),
        /** 80 —— 需要读成「球」的发光体（水下的灯、月泉的银球） */
        ball: new THREE.SphereGeometry(1, 8, 6),
        /** 40 —— 半球菌盖 */
        dome: new THREE.SphereGeometry(1, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2),
        /** 20 —— 碎石 / 小物件 / 花头（20 面的低模在夜景里正好是「小碎块」） */
        ico: new THREE.IcosahedronGeometry(1, 0),
        /** 12 */
        box: new THREE.BoxGeometry(1, 1, 1),
        /** 2 —— 花瓣 / 叶片 / 纸片 */
        plane: new THREE.PlaneGeometry(1, 1),
        /** 32 —— 需要看到端面的柱子（圆木、灯杆座、蛋糕胚、木墩） */
        cyl: new THREE.CylinderGeometry(1, 1, 1, 8, 1, false),
        /** 8 —— 细杆（花茎、灯杆、蜡烛）。4 棱无盖：1~2 cm 的杆子用 8 棱柱是纯浪费 */
        tube: new THREE.CylinderGeometry(1, 1, 1, 4, 1, true),
        /** 18 */
        cone: new THREE.ConeGeometry(1, 1, 6, 1, false),
        /** 9 —— 鱼尾巴（三棱锥压扁） */
        tri: new THREE.ConeGeometry(1, 1, 3, 1, false),
        /** 20 —— 贴地圆盘（水面 / 泥底 / 光晕） */
        disc: new THREE.CircleGeometry(1, 20),
        /** 40 —— 贴地圆环（光晕圈 / 桶箍） */
        ring: new THREE.RingGeometry(0.86, 1, 20, 1),
        /** 48 —— 小圆环（灯笼提环） */
        ringSm: new THREE.TorusGeometry(1, 0.14, 3, 8),
        /** 80 —— 大圆环（桶箍） */
        torus: new THREE.TorusGeometry(1, 0.08, 4, 10),
        /** 64 —— 半圆提手 */
        arc: new THREE.TorusGeometry(1, 0.07, 4, 8, Math.PI),
        /** 96 —— 弯月小饰 */
        crescent: new THREE.TorusGeometry(1, 0.16, 4, 12, Math.PI * 1.4),
        /** 16 —— 桶身（上大下小、无盖） */
        bucket: new THREE.CylinderGeometry(1, 0.82, 1, 8, 1, true),
        /** 12 —— 灯笼罩（六棱、无盖，上下收口） */
        shade: new THREE.CylinderGeometry(0.5, 0.62, 1, 6, 1, true),
        /** 28 —— 无盖圆柱，用来给贴地圆盘「补裙边」（见 `addPond` ②） */
        skirt: new THREE.CylinderGeometry(1, 1, 1, 14, 1, true),
    };
}

interface MatOpts {
    color: number;
    emissive?: number;
    /** 自发光强度（构造时已乘 `?cpgain=`） */
    ei?: number;
    rough?: number;
    metal?: number;
    /** 给了就是半透明（并默认关掉 depthWrite，避免挡住后面的透明件） */
    opacity?: number;
    side?: THREE.Side;
    flat?: boolean;
    depthWrite?: boolean;
}

function mkMat(o: MatOpts): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
        color: o.color,
        roughness: o.rough ?? 0.8,
        metalness: o.metal ?? 0,
        flatShading: o.flat ?? false,
        side: o.side ?? THREE.FrontSide,
    });
    if (o.emissive !== undefined) {
        m.emissive.setHex(o.emissive);
        m.emissiveIntensity = (o.ei ?? 1) * CP_GAIN;
    }
    if (o.opacity !== undefined) {
        m.transparent = true;
        m.opacity = o.opacity;
        m.depthWrite = o.depthWrite ?? false;
    }
    return m;
}

/** 一个「会呼吸」的发光材质。 */
interface Pulse {
    mat: THREE.MeshStandardMaterial;
    /** 基准自发光强度（构造时已乘 `?cpgain=`） */
    base: number;
    /** 振幅（相对 base 的比例） */
    amp: number;
    /** 角速度（弧度/秒） */
    speed: number;
    /** 相位 —— 四个光源同时呼吸会像「全局闪一下」，错开才像「各自在亮」 */
    phase: number;
}

/**
 * 共享材质表。
 *
 * 为什么**必须共享**：① 省内存（274 个 mesh 只吃 ~20 份材质）；
 * ② 发光脉动只写这几份材质的 `emissiveIntensity` 就能让全场亮起来
 * （见组件里的 `useFrame`，每帧只写 4 个属性，不遍历场景）。
 */
function makeMats(pulse: Pulse[]) {
    /** 登记一份「会呼吸」的材质，顺便返回它，方便就地写进表里。 */
    const breathe = (m: THREE.MeshStandardMaterial, amp: number, speed: number) => {
        pulse.push({
            mat: m,
            base: m.emissiveIntensity,
            amp,
            speed,
            phase: pulse.length * 1.7,
        });
        return m;
    };

    return {
        /* ── 植物 ── */
        leaf: mkMat({ color: 0x2f5f3c, rough: 0.85 }),
        leafHi: mkMat({ color: 0xa9cc63, emissive: 0x5f8a2a, ei: 0.6, rough: 0.7 }),
        stem: mkMat({ color: 0x40682f, rough: 0.9 }),
        /* ── 花 ── */
        petalPink: mkMat({ color: 0xff9ec8, emissive: 0x8a2f52, ei: 0.35, rough: 0.6, side: THREE.DoubleSide }),
        petalPurple: mkMat({ color: 0xb693ff, emissive: 0x4a2f8a, ei: 0.35, rough: 0.6, side: THREE.DoubleSide }),
        petalBlue: mkMat({ color: 0x8fc0ff, emissive: 0x2a4f8a, ei: 0.35, rough: 0.6, side: THREE.DoubleSide }),
        flowerWhite: mkMat({ color: 0xf4f6ea, emissive: 0x6a705c, ei: 0.5, rough: 0.7 }),
        flowerYellow: mkMat({ color: 0xffe08a, emissive: 0x8a6a20, ei: 0.5, rough: 0.7 }),
        flowerHeart: mkMat({ color: 0xffd166, emissive: 0xa8761c, ei: 0.8, rough: 0.6 }),
        /* ── 水与泥 ── */
        water: mkMat({ color: 0x5fa8d8, emissive: 0x1b4a72, ei: 1.5, rough: 0.12, metal: 0.35, opacity: 0.66, depthWrite: true }),
        mud: mkMat({ color: 0x2c2119, rough: 0.95, flat: true }),
        /* ── 石 / 木 / 纸 ── */
        stone: mkMat({ color: 0x8b8f96, rough: 0.9, flat: true }),
        stoneDk: mkMat({ color: 0x4e545c, rough: 0.9, flat: true }),
        wood: mkMat({ color: 0x8a6134, rough: 0.85 }),
        woodDk: mkMat({ color: 0x5c4023, rough: 0.9 }),
        paper: mkMat({ color: 0xd9d0bf, rough: 0.95, flat: true, side: THREE.DoubleSide }),
        /* ── 蛋糕 ── */
        cream: mkMat({ color: 0xfff3e0, emissive: 0x6a5a40, ei: 0.45, rough: 0.6 }),
        cherry: mkMat({ color: 0xe0415a, emissive: 0x6a1420, ei: 0.5, rough: 0.45 }),
        /* ── 鱼 ── */
        fish: mkMat({ color: 0x9fd0ff, emissive: 0x24486e, ei: 0.8, rough: 0.3, metal: 0.6, side: THREE.DoubleSide }),
        /* ── 发光件（这四份就是 `useFrame` 每帧唯一会写的东西）── */
        glowBlue: breathe(mkMat({ color: 0x9fe4ff, emissive: 0x3fc8ff, ei: 2.6, rough: 0.25, opacity: 0.85, depthWrite: true }), 0.16, 1.1),
        glowSilver: breathe(mkMat({ color: 0xdcecff, emissive: 0x9fd0ff, ei: 2.0, rough: 0.2, metal: 0.5, opacity: 0.9, depthWrite: true }), 0.12, 0.8),
        glowWarm: breathe(mkMat({ color: 0xffdca8, emissive: 0xffb45c, ei: 2.2, rough: 0.35, opacity: 0.88, depthWrite: true }), 0.14, 1.5),
        glowCyan: breathe(mkMat({ color: 0xc8fff2, emissive: 0x6ff0d8, ei: 2.4, rough: 0.4, opacity: 0.92, depthWrite: true }), 0.20, 1.9),
        /** 灯下光晕 / 水面微光：贴地半透明圈，不写 depthWrite，免得挡住水面 */
        halo: mkMat({ color: 0xffe6b8, emissive: 0xffc978, ei: 1.6, rough: 1, opacity: 0.34 }),
        haloBlue: mkMat({ color: 0x9fe4ff, emissive: 0x4fc8ff, ei: 1.8, rough: 1, opacity: 0.30 }),
        /** 灯笼罩：半透明灯罩，要**看得到里面的灯芯**，所以 depthWrite 关掉 */
        shade: mkMat({ color: 0xffe9c2, emissive: 0xffcf88, ei: 1.1, rough: 0.5, opacity: 0.42, side: THREE.DoubleSide }),
    };
}

type Geos = ReturnType<typeof makeGeos>;
type Mats = ReturnType<typeof makeMats>;

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 通用小工具
 * ══════════════════════════════════════════════════════════════════════════ */

/** 往 `parent` 里放一个 mesh。`scale` 给单个数就是等比。 */
function put(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    pos: readonly [number, number, number],
    scale: number | readonly [number, number, number] = 1,
    rot?: readonly [number, number, number],
): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    if (typeof scale === 'number') m.scale.setScalar(scale);
    else m.scale.set(scale[0], scale[1], scale[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    // 项目统一关阴影（`VenuePropsReal.tsx:219`）：会场本来就没开 shadowMap，
    // 开着只会让每件道具多进一次阴影 pass，白花钱。
    m.castShadow = false;
    m.receiveShadow = false;
    parent.add(m);
    return m;
}

/** 贴地圆盘 / 圆环的固定朝向：几何体本来在 XY 面朝 +Z，绕 X 转 -90° 让它朝上。 */
const FLAT: readonly [number, number, number] = [-Math.PI / 2, 0, 0];

/** 数一棵子树有多少三角（用来在 `?cpdebug=1` 时对预算）。 */
function countTris(root: THREE.Object3D): number {
    let n = 0;
    root.traverse((o: THREE.Object3D) => {
        if (!(o instanceof THREE.Mesh)) return;
        const g = o.geometry;
        const idx = g.index;
        n += (idx ? idx.count : g.attributes.position.count) / 3;
    });
    return Math.round(n);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 浅水坑 —— `fish` / `water` / `lamp` / `spring` 四处共用
 * ══════════════════════════════════════════════════════════════════════════ */

/** 岸顶高度（局部 y）。水面相对它下沉 `?cpsink=`。 */
const BANK_TOP = 0.10;
/** 泥底圆盘高度 —— 贴着地面 1.2 cm（理由见下面长注释）。 */
const MUD_Y = 0.012;

/**
 * 挖一汪浅水坑。
 *
 * ── ★ 为什么**不能**真按「水面比地面低 0.06~0.10 m」去摆 ★ ──────────────
 * 地形是**一整块不透明网格**。水面盘真沉到地面以下，结果不是「看起来像沉
 * 下去」，而是**一个像素都画不出来** —— 被地形挡住，整个水坑消失。
 * `core/worldRegions.ts:498` 里已经把这条结论写死了：
 *   「将来若真要做小水坑，**不要再挖地形** —— 用一层贴着地面的水面盘即可，
 *     挖地形会牵动 CPU/GPU 两份真值同步，代价远大于收益。」
 * ⇒ 这里换成「**围一圈抬起来的岸**，水面贴着地面」：
 *     水面 y = BANK_TOP − ?cpsink= = 0.100 − 0.070 = **0.030**
 *     泥底 y = **0.012**，岸顶 y = **0.100**
 *   于是「水面比（岸顶）地面低 **0.07 m**」这条要求是**实打实满足**的
 *   （0.06~0.10 区间内），读起来就是「一汪沉在泥岸里的水」，
 *   而像素上又不会被地形吃掉。
 *   `?cpsink=` 可以现场把水面往下压做 A/B —— **压过 0.088 就会看到水坑
 *   整个消失**，那正是「真下沉」的必然结果，可以拿它当这条结论的活证据。
 *
 * ── ★ 不能穿模：地形有起伏，而圆盘是平的 ★ ────────────────────────────
 * 采集点在 r = 28~40 m，`worldHeightCPU` 在那里不为 0（会场只有 r ≲ 9.5 m
 * 被抹平成 0）。一个直径 3 m 的平圆盘架在起伏地面上，**低的一侧必然翘起
 * 露出底下的缝**。两道兜底：
 *   ① 泥壁（`G.skirt`，无盖圆柱向下埋 0.5 m）—— 从任何低角度看过去，
 *      看到的都是泥壁的外侧，缝被堵死；
 *   ② 岸边那一圈扁石头**每颗都插进地里 0.18 m** —— 石头是实体，
 *      地形怎么起伏都不会在石头底下露空。
 */
function addPond(g: THREE.Group, G: Geos, M: Mats, R: number, nStone: number) {
    const waterY = BANK_TOP - CP_SINK;

    // ① 湿泥圈（深棕不透明，略大于水面）—— 「外圈一圈深色湿泥环」
    put(g, G.disc, M.mud, [0, MUD_Y, 0], R * 1.14, FLAT);
    // ② 泥壁：兜底 ①，向下埋 0.5 m 堵住地形低侧的缝
    put(g, G.skirt, M.mud, [0, MUD_Y - 0.25, 0], [R * 1.14, 0.5, R * 1.14]);
    // ③ 水面：半透明淡蓝 + 低粗糙 + 中金属 + 一点自发光（夜里才看得见）
    put(g, G.disc, M.water, [0, waterY, 0], R, FLAT);
    // ④ 岸边石：兜底 ②，一圈扁石头，各自插进地里
    for (let i = 0; i < nStone; i++) {
        const a = (i / nStone) * Math.PI * 2 + (hash01(i, 91, 7) - 0.5) * 0.55;
        const r = R * 1.19 + hash01(i, 92, 7) * 0.10;
        put(
            g, G.ico, M.stone,
            [Math.cos(a) * r, BANK_TOP - 0.14, Math.sin(a) * r],
            [0.26 + hash01(i, 93, 7) * 0.10, 0.14, 0.22 + hash01(i, 94, 7) * 0.08],
            [0, hash01(i, 95, 7) * 3.1, 0],
        );
    }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 13 个采集点的建法
 *
 *    签名统一是 `(G, M, v)`，`v` = **该点第几处**（`litter` 有 5 处、
 *    `mushroom` 有 2 处）。单处的点用不上 `v`，按 TS 的 `noUnusedParameters`
 *    规矩写成 `_v`。
 *    每个 builder 都在**局部坐标**里建：y = 0 就是地面，`yaw = 0` 面朝 +Z
 *    （与项目全局约定一致，见 `layout.ts` 文件头）。
 * ══════════════════════════════════════════════════════════════════════════ */

type Builder = (G: Geos, M: Mats, v: number) => THREE.Group;

/** ① 野茶丛：一丛低矮绿叶灌木，顶上一圈淡黄绿嫩芽 + 几朵白花。**364 三角**。 */
const buildTea: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    // 叶簇：同一颗低面球做非等比缩放 —— 共享 geometry 是这里省三角的主要手段
    put(g, G.blob, M.leaf, [0, 0.30, 0], [0.62, 0.34, 0.58]);
    put(g, G.blob, M.leaf, [0.34, 0.22, 0.18], [0.40, 0.24, 0.38]);
    put(g, G.blob, M.leaf, [-0.28, 0.20, -0.22], [0.36, 0.22, 0.34]);
    put(g, G.blob, M.leaf, [0.06, 0.42, -0.30], [0.30, 0.20, 0.30]);
    // 嫩芽：采茶采的就是这个 —— 淡黄绿的小尖，压在叶簇顶上
    for (let i = 0; i < 8; i++) {
        const a = hash01(i, 11, 31) * Math.PI * 2;
        const r = 0.12 + hash01(i, 12, 31) * 0.34;
        put(g, G.ico, M.leafHi, [Math.cos(a) * r, 0.44 + hash01(i, 13, 31) * 0.12, Math.sin(a) * r],
            [0.05, 0.09, 0.05], [0, a, 0]);
    }
    // 白花：给「茶丛开花」一个读得出来的亮点
    for (let i = 0; i < 3; i++) {
        const a = hash01(i, 21, 41) * Math.PI * 2;
        const r = 0.20 + hash01(i, 22, 41) * 0.26;
        put(g, G.ico, M.flowerWhite, [Math.cos(a) * r, 0.40, Math.sin(a) * r], 0.055);
    }
    return g;
};

/** ② 虹彩蔷薇：细茎 + 5 朵粉/紫/蓝的花（每朵 5 片花瓣 + 花心）+ 叶。**236 三角**。 */
const buildRose: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    // 底部叶簇，让花丛不是「凭空插在地上的五根杆」
    put(g, G.blob, M.leaf, [0, 0.10, 0], [0.30, 0.13, 0.30]);
    const tints = [M.petalPink, M.petalPurple, M.petalBlue];
    for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + hash01(i, 3, 51) * 0.9;
        const r = 0.09 + hash01(i, 4, 51) * 0.15;
        const h = 0.30 + hash01(i, 5, 51) * 0.22;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        // 茎：4 棱无盖圆柱 = 8 三角。1.3 cm 的杆子用 8 棱柱是纯浪费
        put(g, G.tube, M.stem, [x, h / 2, z], [0.013, h, 0.013]);
        // 叶：单片四边形（双面材质），斜着挑出去
        put(g, G.plane, M.leaf, [x * 1.7, h * 0.55, z * 1.7], [0.16, 0.07, 1], [0, -a, -0.5]);
        // 花：5 片花瓣绕心排一圈，花瓣自身再向外倾
        const col = tints[i % tints.length];
        const fy = h + 0.02;
        for (let p = 0; p < 5; p++) {
            const pa = (p / 5) * Math.PI * 2 + a;
            put(g, G.plane, col,
                [x + Math.cos(pa) * 0.045, fy, z + Math.sin(pa) * 0.045],
                [0.075, 0.045, 1], [0, -pa, 0.55]);
        }
        put(g, G.ico, M.flowerHeart, [x, fy + 0.012, z], 0.022);
    }
    return g;
};

/** ③ 水下的一点光：小水洼 + 水下幽蓝光球 + 水面上一圈微光。**364 三角**。 */
const buildLamp: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    addPond(g, G, M, 0.95, 7);
    const wy = BANK_TOP - CP_SINK;
    // 灯芯：压在**水面以下** 0.20 m —— 「水下的一点光」，所以不能浮在水上
    put(g, G.ball, M.glowBlue, [0, wy - 0.20, 0], 0.30);
    // 内芯更亮一层：单层半透明球在雾里读不出「有个点光源」
    put(g, G.blob, M.glowBlue, [0, wy - 0.20, 0], 0.15);
    // 水面上的微光圈：贴在水面上方 5 mm，半透明不加 depthWrite
    put(g, G.ring, M.haloBlue, [0, wy + 0.005, 0], 0.78, FLAT);
    return g;
};

/** ④ 月泉：石圈围起的小泉 + 上方一枚银色发光球与弯月小饰。**412 三角**。 */
const buildSpring: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    addPond(g, G, M, 1.15, 8);
    const wy = BANK_TOP - CP_SINK;
    // 细杆把银球「举」在水面上 —— 悬空的球会读成穿模
    put(g, G.tube, M.stone, [0, wy + 0.5, 0], [0.018, 1.0, 0.018]);
    put(g, G.ball, M.glowSilver, [0, wy + 1.05, 0], 0.26);
    // 弯月小饰：TorusGeometry 的弧段，本来就在 XY 面竖着立，不用转
    put(g, G.crescent, M.glowSilver, [0, wy + 1.42, 0], 0.20, [0, 0, 0.5]);
    return g;
};

/** ⑤ 月灵灯：细杆 + 灯笼体（半透明灯罩 + 里面发光的芯）+ 地面光晕。**208 三角**。 */
const buildLantern: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    put(g, G.cyl, M.stoneDk, [0, 0.03, 0], [0.17, 0.06, 0.17]);      // 底座
    put(g, G.tube, M.woodDk, [0, 0.67, 0], [0.024, 1.22, 0.024]);    // 灯杆
    put(g, G.blob, M.glowWarm, [0, 1.48, 0], [0.20, 0.26, 0.20]);    // 灯芯
    put(g, G.shade, M.shade, [0, 1.48, 0], [0.34, 0.42, 0.34]);      // 半透明灯罩
    put(g, G.cone, M.woodDk, [0, 1.73, 0], [0.24, 0.14, 0.24]);      // 顶盖
    put(g, G.ringSm, M.woodDk, [0, 1.82, 0], 0.07, FLAT);            // 提环
    // 地面光晕：一圈实心圆盘 + 一圈亮环，夜里读作「灯照在地上」
    put(g, G.disc, M.halo, [0, 0.014, 0], 0.85, FLAT);
    put(g, G.ring, M.halo, [0, 0.020, 0], 1.0, FLAT);
    return g;
};

/** ⑥ 散落的小物件（×5）：每处 1 圈地面痕迹 + 4 件形状各异的小物。**236 三角/处**。 */
const buildLitter: Builder = (G, M, v) => {
    const g = new THREE.Group();
    // `v` 进哈希 —— 五处必须长得不一样，否则一眼看出是同一个东西复制了五遍
    const h = (i: number, s: number) => hash01(v * 13 + i, s, 17);

    // 地面痕迹：**每个物件单看只有几厘米**，没有这层底色时五处会「看不见」——
    // 玩家走到跟前只看到草皮，读不出「这里有一摊要捡的东西」。
    // 内圈实心 + 两道半径错开的描边：三个半径互不相同所以不会 z-fighting，
    // 双环读起来也更像「被人踩过的秃地」而不是一枚贴纸。
    put(g, G.disc, M.stoneDk, [0, 0.009, 0], 0.30, FLAT);
    put(g, G.ring, M.stoneDk, [0, 0.010, 0], 0.44, FLAT);
    put(g, G.ring, M.paper, [0, 0.011, 0], 0.62, FLAT);

    // 每处 4 件：2 件扁的（纸片 / 木屑）+ 1 件长的（木棍）+ 1 件圆的（果核 / 圆石）。
    // 形状刻意分开，否则四块小方片在夜里会糊成一坨认不出来。
    const spots: Array<[number, number]> = [
        [0, 0], [0.34, 0.12], [-0.26, 0.20], [0.10, -0.30],
    ];
    for (let i = 0; i < spots.length; i++) {
        const [x, z] = spots[i];
        const yaw = h(i, 1) * Math.PI * 2;
        if (i === 0) {
            // 一块翻倒的小木板
            put(g, G.box, M.wood, [x, 0.018 + h(i, 2) * 0.02, z],
                [0.10 + h(i, 3) * 0.07, 0.028 + h(i, 4) * 0.02, 0.07 + h(i, 5) * 0.05], [0, yaw, 0]);
        } else if (i === 1) {
            // 躺倒的小圆柱（一截木棍）
            put(g, G.cyl, M.woodDk, [x, 0.035, z], [0.032, 0.16, 0.032], [0, yaw, Math.PI / 2]);
        } else if (i === 2) {
            // 折起的纸片
            put(g, G.box, M.paper, [x, 0.018 + h(i, 2) * 0.02, z],
                [0.09 + h(i, 3) * 0.06, 0.022, 0.07 + h(i, 5) * 0.05], [0, yaw, 0]);
        } else {
            // 果核 / 圆石：用 80 面的球而不是 20 面的石头，因为它要当这堆里
            // 唯一「看得出是个圆东西」的锚点，尖角一多就成了一块碎渣
            put(g, G.ball, M.stone, [x, 0.045 + h(i, 6) * 0.02, z],
                0.055 + h(i, 7) * 0.025, [0, yaw, 0]);
        }
    }
    return g;
};

/** ⑦ 夜路的尽头：立着的石碑（带阴刻面板）+ 底座碎石 + 旁边一盏小灯。**256 三角**。 */
const buildRoadend: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    put(g, G.box, M.stone, [0, 0.51, 0], [0.56, 1.02, 0.13]);         // 碑身
    put(g, G.box, M.stoneDk, [0, 0.62, 0.072], [0.36, 0.48, 0.02]);   // 碑面阴刻（换个色读作刻痕）
    put(g, G.box, M.stoneDk, [0, 1.04, 0], [0.58, 0.06, 0.15]);       // 碑顶压条
    put(g, G.box, M.stoneDk, [0, 0.02, 0], [0.52, 0.05, 0.42]);       // 底座石板
    // 底座碎石：六颗都插进地里，坡地上也不会露空
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.5;
        put(g, G.ico, M.stone, [Math.cos(a) * 0.34, 0.04, Math.sin(a) * 0.28],
            [0.11 + hash01(i, 61, 9) * 0.06, 0.09, 0.10], [0, hash01(i, 62, 9) * 3, 0]);
    }
    // 碑前的一小堆垒石：远处只看得到一个「这里有人来过」的尖，比一根光杆更耐看
    put(g, G.ico, M.stoneDk, [-0.52, 0.05, -0.16], [0.14, 0.10, 0.13], [0, 0.7, 0]);
    put(g, G.ico, M.stone, [-0.52, 0.14, -0.16], [0.09, 0.08, 0.09], [0, 1.9, 0]);
    // 旁边的小灯：短杆挑一颗暖光点 —— 「路标」要有个能指方向的光
    put(g, G.tube, M.woodDk, [0.42, 0.28, 0.10], [0.016, 0.56, 0.016]);
    put(g, G.ico, M.glowWarm, [0.42, 0.60, 0.10], 0.065);
    put(g, G.disc, M.halo, [0.42, 0.014, 0.10], 0.30, FLAT);
    return g;
};

/** ⑧ 生日蛋糕：矮木墩上一个小圆蛋糕 + 奶油球 + 樱桃 + 一根蜡烛。**340 三角**。 */
const buildCake: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    put(g, G.cyl, M.woodDk, [0, 0.12, 0], [0.30, 0.24, 0.30]);       // 木墩
    put(g, G.cyl, M.wood, [0, 0.245, 0], [0.31, 0.015, 0.31]);       // 墩面（略亮一圈，读作切面）
    put(g, G.cyl, M.cream, [0, 0.31, 0], [0.20, 0.14, 0.20]);        // 蛋糕胚
    for (let i = 0; i < 8; i++) {                                    // 顶上一圈奶油球
        const a = (i / 8) * Math.PI * 2;
        put(g, G.ico, M.cream, [Math.cos(a) * 0.165, 0.40, Math.sin(a) * 0.165], 0.048);
    }
    put(g, G.blob, M.cream, [0, 0.42, 0], 0.085);                    // 中心奶油
    put(g, G.ico, M.cherry, [0, 0.475, 0], 0.050);                   // 樱桃
    put(g, G.tube, M.flowerWhite, [0, 0.53, 0], [0.012, 0.10, 0.012]);
    put(g, G.ico, M.glowWarm, [0, 0.59, 0], 0.025);                  // 烛火
    return g;
};

/**
 * ⑨ 水边（爱诺·池塘捉鱼）：浅水坑 + 3 条银蓝色小鱼剪影 + 几根芦苇。**424 三角**。
 *
 * ⚠️ 为什么 `fish` 和 `water` **各挖一汪**，而不是在两点中点挖一汪 ——
 *    实测两点相距 **16.0 m**（(262°,36) → (288°,35)）。交互判定是「玩家进到
 *    `pointXZ(id)` 半径 `REACH = 2.6 m` 内按 F」（`layout.ts:70`）。
 *    中点挖一汪，水离两个判定点各 **8 m** —— 玩家会在草地上对着空气按 F。
 *    所以「至少要有水」这条只能靠**各自一汪**来满足。
 */
const buildFish: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    addPond(g, G, M, 1.30, 9);
    const wy = BANK_TOP - CP_SINK;
    // 三条鱼：扁椭球身 + 三角尾，半沉在水里（露出脊背）
    for (let i = 0; i < 3; i++) {
        const a = hash01(i, 71, 23) * Math.PI * 2;
        const r = 0.25 + hash01(i, 72, 23) * 0.65;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const yaw = hash01(i, 73, 23) * Math.PI * 2;
        put(g, G.blob, M.fish, [x, wy + 0.012, z], [0.17, 0.055, 0.075], [0, yaw, 0]);
        // 尾巴：三棱锥压扁，绕 Y 转到身后（yaw + 180°）
        put(g, G.tri, M.fish, [x + Math.cos(yaw + Math.PI) * 0.15, wy + 0.012, z - Math.sin(yaw + Math.PI) * 0.15],
            [0.05, 0.075, 0.012], [0, yaw, 0]);
    }
    // 芦苇：长在水坑边上（半径 > R，不插在水里）
    for (let i = 0; i < 5; i++) {
        const a = 0.6 + i * 0.9;
        const r = 1.62 + hash01(i, 81, 23) * 0.22;
        const hgt = 0.42 + hash01(i, 82, 23) * 0.34;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        put(g, G.tube, M.stem, [x, hgt / 2, z], [0.012, hgt, 0.012], [0, a, 0]);
        put(g, G.plane, M.leaf, [x * 1.06, hgt * 0.72, z * 1.06], [0.05, 0.26, 1], [0, -a, 0.28]);
    }
    return g;
};

/** ⑩ 取水处（奈芙尔·打一桶清水）：同一汪浅水坑 + 木水桶（桶身/桶箍/提手）。**508 三角**。 */
const buildWater: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    addPond(g, G, M, 1.30, 9);
    const wy = BANK_TOP - CP_SINK;
    // 木桶摆在岸边石圈外面，桶底插进地里 2 cm（坡地上不露缝）
    const bx = 1.55;
    const bz = 0.55;
    const by = wy - 0.02;
    put(g, G.bucket, M.wood, [bx, by + 0.13, bz], [0.19, 0.26, 0.19]);     // 桶身（上大下小）
    put(g, G.disc, M.woodDk, [bx, by + 0.005, bz], 0.155, FLAT);           // 桶底
    put(g, G.disc, M.water, [bx, by + 0.22, bz], 0.165, FLAT);             // 桶里打好的水
    put(g, G.torus, M.woodDk, [bx, by + 0.22, bz], 0.185, FLAT);           // 桶箍
    put(g, G.arc, M.woodDk, [bx, by + 0.26, bz], 0.18);                    // 提手（半圆，竖着立在桶口）
    for (let i = 0; i < 3; i++) {                                          // 岸边几块碎石
        const a = 2.2 + i * 0.7;
        put(g, G.ico, M.stone, [Math.cos(a) * 1.75, 0.03, Math.sin(a) * 1.75],
            [0.10, 0.07, 0.09], [0, a, 0]);
    }
    return g;
};

/** ⑪ 花丛：一大丛各色小花（12 朵，白/黄/粉/紫混）+ 底叶。**420 三角**。 */
const buildFlower: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    const cols = [M.flowerWhite, M.flowerYellow, M.petalPink, M.petalPurple];
    // 底叶：三团矮叶把花托住，不然 12 朵花会像「插在草地上的一把图钉」
    put(g, G.blob, M.leaf, [0, 0.10, 0], [0.40, 0.14, 0.40]);
    put(g, G.blob, M.leaf, [0.26, 0.08, -0.20], [0.26, 0.11, 0.24]);
    put(g, G.blob, M.leaf, [-0.24, 0.08, 0.22], [0.24, 0.10, 0.22]);
    for (let i = 0; i < 12; i++) {
        // 用「黄金角」撒点（i * 137.5°），比 `i/n*2π` 均匀得多，也不会排成圈
        const a = i * 2.39996 + hash01(i, 101, 33) * 0.5;
        const r = 0.10 + Math.sqrt(hash01(i, 102, 33)) * 0.40;
        const hgt = 0.22 + hash01(i, 103, 33) * 0.26;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        // 只有高过叶面的花才配茎，矮的埋在叶里看不见杆
        if (hgt > 0.34) put(g, G.tube, M.stem, [x, hgt / 2, z], [0.010, hgt, 0.010]);
        put(g, G.ico, cols[i % cols.length], [x, hgt + 0.03, z],
            0.042 + hash01(i, 104, 33) * 0.022, [0, a, 0]);
    }
    return g;
};

/**
 * ⑫ 发光蘑菇：每处 4 朵（白/淡青菌柄 + 半球菌盖，菌盖发淡青光）+ 孢子点。**328 三角/处**。
 * ★ 2026-10-15：`layout.ts` 的 `POINT_SPOTS.mushroom` 原本只有 1 条，与委托 13
 *    的 `count = 2`（文案「采两朵」）对不上，已在 layout 补成 2 条。
 *    本文件按 `pointXZ(id)` 逐点建 ⇒ 自动跟着变成 2 处，不用改。
 */
const buildMushroom: Builder = (G, M, v) => {
    const g = new THREE.Group();
    // 一处一小丛苔藓，把蘑菇的根藏起来
    put(g, G.blob, M.leaf, [0, 0.035, 0], [0.42, 0.10, 0.42]);
    for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + hash01(v * 7 + i, 111, 19) * 1.2;
        const r = 0.08 + hash01(v * 7 + i, 112, 19) * 0.24;
        const hgt = 0.13 + hash01(v * 7 + i, 113, 19) * 0.11;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        // 菌柄：4 棱无盖圆柱（8 三角）—— 顶上被菌盖罩住，看不到空心
        put(g, G.tube, M.flowerWhite, [x, hgt / 2, z], [0.032, hgt, 0.032]);
        // 菌盖：半球，压扁一点，微微外翻
        put(g, G.dome, M.glowCyan, [x, hgt, z], [0.115 + hash01(i, 114, 19) * 0.05, 0.085, 0.115], [0.12, a, 0]);
    }
    // 飘起来的孢子光点：给「会发光的蘑菇」补一层体积感
    for (let i = 0; i < 5; i++) {
        const a = hash01(v * 3 + i, 121, 19) * Math.PI * 2;
        const r = 0.18 + hash01(v * 3 + i, 122, 19) * 0.34;
        put(g, G.ico, M.glowCyan, [Math.cos(a) * r, 0.30 + hash01(i, 123, 19) * 0.24, Math.sin(a) * r],
            0.014 + hash01(i, 124, 19) * 0.012);
    }
    return g;
};

/** ⑬ 干柴堆：6~8 根交叉堆叠的圆木 + 引火柴 + 围石。**344 三角**。 */
const buildFirewood: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    // 底层 4 根并排躺，上层 3 根横过去 —— 交叉角度靠哈希抖，别摆成一把梳子
    for (let i = 0; i < 4; i++) {
        const x = (i - 1.5) * 0.20;
        put(g, G.cyl, M.wood, [x, 0.065, 0], [0.065, 0.86, 0.065],
            [0, Math.PI / 2 + (hash01(i, 131, 27) - 0.5) * 0.22, 0]);
    }
    for (let i = 0; i < 3; i++) {
        const z = (i - 1) * 0.17;
        put(g, G.cyl, M.woodDk, [0, 0.195, z], [0.058, 0.78, 0.058],
            [0, Math.PI / 2 + 0.30 + (hash01(i, 132, 27) - 0.5) * 0.30, 0]);
    }
    // 引火柴：几颗小碎木塞在缝里
    for (let i = 0; i < 3; i++) {
        const a = hash01(i, 141, 27) * Math.PI * 2;
        put(g, G.ico, M.woodDk, [Math.cos(a) * 0.34, 0.035, Math.sin(a) * 0.34],
            0.055 + hash01(i, 142, 27) * 0.03, [0, a, 0]);
    }
    // 围石：柴堆周围三块石头，各自插进地里
    for (let i = 0; i < 3; i++) {
        const a = 1.1 + i * 2.1;
        put(g, G.ico, M.stone, [Math.cos(a) * 0.62, 0.03, Math.sin(a) * 0.62],
            [0.13, 0.09, 0.11], [0, a, 0]);
    }
    return g;
};

/**
 * 兜底：`layout.ts` 里加了新 id 而这里还没建模型时用。
 *
 * 为什么值得写这 8 行：**隐形是最难排查的一种坏** —— 玩家走到判定点、
 * 提示弹出来、地上什么都没有，看代码还看不出问题（`POINT_SPOTS` 有、
 * `pointXZ` 有，只是这里没有对应的 builder）。给一块发光石标 + 一条
 * `console.warn`，问题自己会说话。
 */
const buildFallback: Builder = (G, M, _v) => {
    const g = new THREE.Group();
    put(g, G.ico, M.stoneDk, [0, 0.16, 0], [0.22, 0.20, 0.20], [0, 0.4, 0]);
    put(g, G.ico, M.glowBlue, [0, 0.40, 0], 0.075);
    put(g, G.disc, M.haloBlue, [0, 0.014, 0], 0.34, FLAT);
    return g;
};

/** id → 建法。键必须与 `layout.ts` 的 `POINT_SPOTS` 对齐（对不上的会走兜底 + 警告）。 */
const BUILDERS: Record<string, Builder> = {
    tea: buildTea,
    rose: buildRose,
    lamp: buildLamp,
    spring: buildSpring,
    lantern: buildLantern,
    litter: buildLitter,
    roadend: buildRoadend,
    cake_slice: buildCake,
    fish: buildFish,
    water: buildWater,
    flower: buildFlower,
    mushroom: buildMushroom,
    firewood: buildFirewood,
};

/** 这几个点的朝向有讲究：石碑要**面朝场心**（玩家从中心往外走，正对着它读）。 */
const FACE_HUB = new Set<string>(['roadend']);

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 装配
 * ══════════════════════════════════════════════════════════════════════════ */

interface Built {
    group: THREE.Group;
    /** 会呼吸的共享材质（只有 4 份，见 `useFrame`） */
    pulse: Pulse[];
    /** 每个采集实例的索引：`pointId → [第 0 处, 第 1 处, …]`。
     *  用来实现「采过就收起来」——见 `CollectProps` 的 `taken` 参数。 */
    insts: Map<string, THREE.Object3D[]>;
}

/** 调试探针的数据（`_tools/webgpu-shot.mjs --eval` 可以读 `window.__collectProps()`）。 */
let LAST_STATS: Record<string, unknown> = {};

function buildAll(): Built {
    const pulse: Pulse[] = [];
    const G = makeGeos();
    const M = makeMats(pulse);
    const group = new THREE.Group();
    group.name = 'collect-props';

    const perId: Record<string, number> = {};
    const insts = new Map<string, THREE.Object3D[]>();
    let meshes = 0;
    const unknown: string[] = [];

    // ★ 点的**清单**也是从 layout 现取的，不在本文件里再抄一份 —— 抄一份就会漏同步
    for (const id of Object.keys(POINT_SPOTS)) {
        const make = BUILDERS[id] ?? buildFallback;
        if (!BUILDERS[id]) unknown.push(id);
        const spots = pointXZ(id);
        if (!spots.length) continue;

        for (let i = 0; i < spots.length; i++) {
            const [x, z] = spots[i];
            // ⚠️ 每处**单独建**，不是 clone 同一份 —— `litter` 有 5 处、
            //    `mushroom` 有 2 处，五处一模一样一眼就看出是复制粘贴的
            const inst = make(G, M, i);
            inst.name = `collect_${id}_${i}`;
            // ★ 落位：地面高度必须现取。会场中心 worldHeightCPU 恒为 0，
            //   但采集点在 r = 28~40 m 的外圈，写死 y = 0 会浮空或埋进土里
            inst.position.set(x, worldHeightCPU(x, z) + CP_LIFT, z);
            // 朝向：需要面朝场心的（石碑）用 atan2，其余用哈希随机（同一处每次一样）
            inst.rotation.y = FACE_HUB.has(id)
                ? Math.atan2(-x, -z) + (hash01(x, z, 71) - 0.5) * 0.25
                : hash01(x, z, 61) * Math.PI * 2;
            group.add(inst);
            const bucket = insts.get(id);
            if (bucket) bucket.push(inst); else insts.set(id, [inst]);

            const t = countTris(inst);
            perId[id] = (perId[id] ?? 0) + t;
            meshes += inst.children.length;
        }
    }

    group.updateMatrixWorld(true);
    const total = countTris(group);
    LAST_STATS = { ids: Object.keys(perId).length, perId, total, meshes, unknown, pulse: pulse.length };

    if (unknown.length) {
        console.warn('[collect-props] POINT_SPOTS 里有本文件还没建模型的 id，已用兜底石标顶上：'
            + unknown.join(', '));
    }
    if (CP_DEBUG) {
        const lines = Object.keys(perId)
            .map((k) => `${k} ${perId[k]}`)
            .join(' / ');
        console.log(`[collect-props] ${Object.keys(perId).length} 个点、${meshes} 个 mesh、`
            + `合计 ${total} 三角｜${lines}`);
    }
    return { group, pulse, insts };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 组件
 * ══════════════════════════════════════════════════════════════════════════ */

export function CollectProps({ visible = true, picked }: {
    visible?: boolean;
    /**
     * 已被采走的**具体点位**：键 = `"pointId:index"`（例如 `"rose:2"`），值 = true。
     *
     * ⚠️ 这里以前叫 `taken?: Record<string, number>`，收的是 `pointId -> 已采数量`，
     *    而唯一的调用方（`components/game/GameLayer.tsx`）传进去的是
     *    `collected`（**键是委托 id**）⇒ `taken[id]` 永远是 `undefined` ⇒
     *    `n = 0` ⇒ 一件都不收，「采过就收起来」整体空转（地上一直躺着能看不能按的物件）。
     *    现在改成按点位键精确隐藏：不再依赖「按索引顺序收」这种近似，
     *    玩家采的就是哪一棵，消失的就是哪一棵 —— 更直观，也不会出现
     *    「明明采了远处那朵，消失的却是近处这朵」。
     */
    picked?: Record<string, boolean>;
}) {
    // 整棵树一次建好、`useMemo` 缓存 —— 每次 render 重建成百个 mesh 会直接把帧率打没
    const built = useMemo(() => buildAll(), []);
    const group = built.group;

    /* ★ 「采过就收起来」。
     *
     * 为什么必须有：`litter` 是 5 处、`mushroom` 是 2 处，但委托只要 5 个 / 2 朵。
     * 玩家采够之后，`GameLayer` 会把剩下的互动点 `enabled:false` 关掉 ——
     * 于是地上**还亮着一堆能看不能按的物件**，玩家会以为卡了。
     * 收起来之后「能看见的都能按」这条规则才成立。
     *
     * 为什么隐藏而不是卸载：`buildAll` 建一次 255 个 mesh 是刻意的（`useMemo([])`），
     * 为了采一个点去重建整棵树不值得；`visible=false` 的子树不产生 draw call，
     * 代价可忽略。
     *
     * 按索引顺序收（第 0 处先没）—— 哈希随机会让玩家看见「远处的先消失」，
     * 那比顺序消失更莫名其妙。 */
    /* ★ 「采过就收起来」。 */
    useFrame(() => {
        if (!picked) return;
        for (const [id, arr] of built.insts) {
            for (let i = 0; i < arr.length; i++) arr[i].visible = !picked[`${id}:${i}`];
        }
    });

    useFrame(({ camera, clock }) => {
        // ① 距离剔除（与 `VenuePropsReal.tsx:429` / `Banquet.tsx:495` 同一套）：
        //    地形盘半宽只有 80 m，相机退远了这些道具已经悬在盘外，直接不发 draw call
        const dx = camera.position.x;
        const dz = camera.position.z;
        const near = dx * dx + dz * dz < HIDE_R * HIDE_R;
        group.visible = visible && near;

        // ② 发光脉动。
        //    ★ 这里是**唯一**的每帧写入，而且只写 `pulse` 里那 4 份**共享材质**的
        //      `emissiveIntensity` —— 全场上百个发光 mesh 共用它们，所以代价是
        //      「4 次属性写入/帧」，**不是**遍历场景（遍历几百个 mesh 才是要避免的）。
        //      四个光源相位错开，否则会读成「整个屏幕在闪」而不是「各自在呼吸」。
        if (!CP_PULSE || !near || !visible) return;
        const t = clock.getElapsedTime();
        for (const p of built.pulse) {
            p.mat.emissiveIntensity = p.base * (1 + p.amp * Math.sin(t * p.speed + p.phase));
        }
    });

    if (!CP_ON) return null;
    return <primitive object={group} visible={visible} />;
}

/** 探针：给无头截图脚本 `--eval` 读，确认 13 个点真的都建出来了。 */
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__collectProps = () => LAST_STATS;
}

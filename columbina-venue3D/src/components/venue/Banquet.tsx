/**
 * Banquet.tsx —— 会场中央的「生日宴长桌」（用户 m00002）。
 *
 * 需求原话：「去找以下素材：一张大桌子（可以围坐所有 NPC + 哥伦比娅），桌子上
 *   摆放月亮主体多层大生日蛋糕，和零食饮料果盘。可以拼接，比如桌子是一个素材，
 *   蛋糕是另一个素材。」
 *
 * ── 三样素材的来路（详见 `公用区\素材\宴会素材来源.md`）───────────────────
 *   · 长桌 `table_banquet.glb` —— 火山方舟 Ark 图生 3D（`_tools/ship3d.py`）。
 *   · 蛋糕 `cake_moon.glb`     —— 同上，月亮主题双层蛋糕（银白奶油 + 发光满月 +
 *     新月顶饰），是全场景唯一的「月亮主体多层蛋糕」。
 *   · 零食/饮料/果盘 —— Poly Haven CC0 的 28 件道具（`_tools/ph-props.ps1`
 *     批量转出来的 `public/venue/props/*.glb`）。
 *
 * ── 为什么桌子是「三张拼起来」而不是「一张拉长」──────────────────────────
 *   `table_banquet.glb` 归一化后水平 2.539 × 1.129、高 1.0。餐桌真实高按
 *   `?bh=` 取 **0.78 m** ⇒ **等比**缩放 0.78 后单张只有 1.98 × 0.88 m，
 *   围坐 16 人根本不够（每人要 0.7~0.8 m 桌沿）。
 *   两条路：
 *     ① 非等比拉长（scale.x = 2.2、scale.z = 1.3、scale.y = 0.78）—— 桌腿会
 *        被拉成 1.7:1 的扁方柱，近看穿帮；
 *     ② **三张首尾相接**（真实宴会就是这么摆的）—— 等比缩放、零形变，
 *        总长 5.94 m、宽 0.88 m。
 *   选 ②。三张的贴图只加载一次（`CACHE` 里 clone），三角数 3 × 20000 = 60000，
 *   与 `tree_a.glb` 单棵持平。
 *
 * ── 座次（16 席）────────────────────────────────────────────────────────
 *   长边 7 + 7 = 14 席（间距 0.85 m），两端各 1 席 ⇒ 16 席。
 *   第 16 席（+x 端）**留给哥伦比娅**：她归 `MmdCharacter` 管、位置走
 *   `?char=`，所以这里只摆 15 个 NPC（见 `NpcCrowd.tsx` 的 `?npclayout=table`）。
 *
 * ── URL 开关（项目规矩：所有要 A/B 的量都得上 URL）────────────────────────
 *   ?banquet=0        整桌不加载
 *   ?bx= ?bz=         桌心世界坐标（米，缺省 0 / 0 —— 会场中心）
 *   ?byaw=<度>        桌子绕 Y 的朝向（缺省 0，长轴沿 X）
 *   ?bh=<m>           桌高（米，缺省 0.78）
 *   ?bseg=<n>         拼几张（缺省 3）
 *   ?bcake=<m>        蛋糕真实高度（米，缺省 0.50；水平尺寸随之等比）
 *   ?bfood=0          只留桌子 + 蛋糕，不摆零食果盘（做 A/B 对照）
 *   ?bemis=<k>        道具自发光强度（缺省 0.34，与 `VenuePropsReal` 同源）
 *   ?bchair=<n>       给每席摆椅子（**缺省 0 = 不摆**，见下）
 *   ?bchairmix=0      椅子统一用同一款（缺省 1 = 按座位哈希混搭）
 *   ?bdebug=1         打印每件素材的加载/摆位明细
 *
 * ── 关于椅子（`public/venue/chairs/`，10 件 Poly Haven CC0）────────────────
 *   2026-10-14 用户 m01149 要求「找椅子模型和坐姿的素材，找出来先备用」。
 *   椅子已找齐并转好（见 `公用区\素材\椅子素材来源.md`），但**缺省不摆**：
 *   现在 15 个 NPC 是**站**在桌边的（`?npclayout=table` 的站姿），
 *   摆上椅子却不坐下会更假。等坐姿动作接上（见坐姿素材调研）再用
 *   `?bchair=1` 打开。
 *
 * ── 坑（从 `VenuePropsReal.tsx` 抄来的，别再踩）───────────────────────────
 *   ① `GLTFLoader` 里 `material.color` 是 `baseColorFactor`（白），颜色全在
 *      贴图上 ⇒ **不能** `m.emissive = m.color * 0.14`（会给道具糊一层与贴图
 *      无关的平铺灰）。正确做法是 `m.emissiveMap = m.map` + `emissive` 置白。
 *   ② `MeshStandardNodeMaterial` **没有 `normalScale`**，写 `.copy()` 抛
 *      TypeError 且会被 try/catch 静默吞掉。
 *   ③ GLB 一律「高度 = 1、底面 y = 0、水平居中」⇒ `scale.setScalar(h)` 里的
 *      `h` 直接就是**真实高度（米）**，不用再乘任何系数。
 */

import * as THREE from 'three';
import { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { QNUM, QSTR } from '../../core/utils/query';
import { hash01 } from '../../core/venueRing';
import { worldHeightCPU } from '../../core/worldRegions';

/* ════════════════════════════════════════════════════════════════════════════
 * 1. URL 开关与几何常量
 *
 *    这些常量**导出**给 `NpcCrowd.tsx` 用（`?npclayout=table` 的座次必须和
 *    桌子实际尺寸严格一致，两边各写一份迟早对不上）。
 * ════════════════════════════════════════════════════════════════════════════ */
export const BANQUET_ON = QNUM('banquet', 1)! > 0;
export const BANQUET_X = QNUM('bx', 0)!;
/** 缺省把桌子摆在**哥伦比娅正北**，并且让长轴沿 Z ⇒ 她的缺省站位
 *  `?char=0,0,-10` 正好落在长桌 −Z 端的**主位**上（生日宴的主人席）。
 *  推导：`?byaw=90` 时 `toWorld(lx,0)` 的 z = `BANQUET_Z − lx`，
 *  端席在局部 x = ±(`TABLE_LEN`/2 + 0.42) = ±3.39 ⇒ 要让它落在 z = −10，
 *  取 `BANQUET_Z = −10 + 3.39 = −6.61`。改 `?bh=` / `?bseg=` 会挪动端席，
 *  所以这个常数是**按缺省几何算死的**；换参数时 `?bz=` 要跟着调。 */
export const BANQUET_Z = QNUM('bz', -6.61)!;
export const BANQUET_YAW = (QNUM('byaw', 90)! * Math.PI) / 180;

/** 桌高（米）。真实餐桌 0.75~0.78，取 0.78。 */
export const TABLE_H = QNUM('bh', 0.78)!;
/** 拼几张。 */
export const TABLE_SEGS = Math.max(1, Math.round(QNUM('bseg', 3)!));

/** 单段桌面归一化尺寸（来自 `_tools/glbbox.py` 实测，高度已归一到 1）。 */
export const TABLE_SEG_L = 2.539;
export const TABLE_SEG_W = 1.129;

/** 桌面全长 / 全宽（米）。 */
export const TABLE_LEN = TABLE_SEG_L * TABLE_H * TABLE_SEGS;
export const TABLE_WID = TABLE_SEG_W * TABLE_H;

/** 蛋糕真实高度（米）—— GLB 归一化后水平是 0.936 × 0.940，等比缩放。 */
const CAKE_H = QNUM('bcake', 0.50)!;
/** 摆不摆零食/饮料/果盘。 */
const FOOD_ON = QNUM('bfood', 1)! > 0;
/** 道具自发光强度（会场夜里全靠它把道具从雾里拉出来）。 */
const EMIS = QNUM('bemis', 0.34)!;
/** 蛋糕单独给强一点：需求就是「月亮主体」，得让它读成在发光。 */
const CAKE_EMIS = QNUM('bemis_cake', 0.55)!;
const DEBUG = QNUM('bdebug', 0)! > 0;

/* ── 椅子（`public/venue/chairs/`，10 件 Poly Haven CC0）──────────────────
 * ★ 缺省 = 1（摆）。`NpcCrowd` 的 `?npcpose` 缺省已改成 `sit`，
 *   两边配套：坐下却没椅子会穿帮（人悬在半空）。
 *   要回看「站着围桌」的老样子：`?bchair=0&npcpose=stand`。 */
const CHAIR_ON = QNUM('bchair', 1)! > 0;
const CHAIR_MIX = QNUM('bchairmix', 1)! > 0;
/** 椅子真实高度（米）—— 餐椅坐面高约 0.45、靠背顶 0.9~1.0。 */
const CHAIR_H = QNUM('bchairh', 0.92)!;
/** 椅子相对座位点的**前后挪动**（米）。座位点是「**站**在桌边的人」的位置
 *  （离桌沿 `SEAT_D = 0.42`），而**坐**着的人躯干会比站着更靠近桌沿 ——
 *  所以椅子要**朝桌心挪**一点，不能照着站位摆（照站位摆会离桌沿 0.6 m，
 *  俯拍一看椅子全飘在桌外，`_logs/banquet/_chair_top_zoom.jpg` 就是这个症状）。
 *  负值 = 朝桌心。实测椅子 `chair_painted_01` 归一化深度 0.564、坐面在 +Z 侧
 *  ⇒ 0.92 m 高时前缘在椅心 +0.26 m。取 −0.12 ⇒ 椅心离桌沿 0.30 m、
 *  **前缘离桌沿 0.04 m**（基本贴住桌沿），是真实宴会的样子。 */
const CHAIR_BACK = QNUM('bchairback', -0.12)!;
const CHAIR_DIR = '/venue/chairs';
/** 椅子池。⚠️ `chair_painted_02` 实测面朝 +85.7°（其余都朝 +Z），单独列出来
 *  好加补偿角（见 `CHAIR_YAW_FIX`）。`chair_wooden_01` 是 2.27 m 高背宝座，
 *  归一化后水平只剩 0.30 m，按 0.92 m 摆出来会窄得不像椅子 ⇒ 排除。 */
const CHAIR_POOL = [
    'chair_painted_01',
    'chair_dining_02',
    'chair_armchair',
    'stool_chinese',
    'stool_painted',
    'stool_wood_01',
];
/** 面朝补偿角（弧度）—— `_tools/chair_face.py` 实测值。缺省 0（已朝 +Z）。 */
const CHAIR_YAW_FIX: Record<string, number> = {
    chair_painted_02: -Math.PI / 2,
};

/* ════════════════════════════════════════════════════════════════════════════
 * 2. 素材表
 * ════════════════════════════════════════════════════════════════════════════ */
const P = '/venue/props';
const TABLE_URL = `${P}/table_banquet.glb`;
const CAKE_URL = `${P}/cake_moon.glb`;

/** 桌面陈设。坐标是**桌面局部系**（米）：x 沿桌长（±`TABLE_LEN`/2）、
 *  z 沿桌宽（±`TABLE_WID`/2）、y 起点是桌面高度 `TABLE_H`。
 *  `mirror !== false` 时同一件会镜像到 −z —— 长桌两侧都要摆，手写两遍
 *  既啰嗦又容易两边对不齐。 */
interface PropInst {
    key: string;
    x: number;
    z: number;
    /** **期望的真实高度（米）**。`scale = h / NORM_H[key]`，见下面的表。 */
    h: number;
    /** 绕 Y 的朝向（弧度）。缺省用 `hash01` 给一个确定性的随机角。 */
    rot?: number;
    /** `false` = 只摆 +z 这一份（缺省镜像到 ±z 两份）。 */
    mirror?: boolean;
}

/**
 * ⚠️ 归一化例外表（`_tools/glbbox.py` 实测）。
 *
 * `ph-blender.py --normalize --ground` 名义上把每件缩成「高 = 1.0、底面 y = 0」，
 * 但有四件没做到 1.000。**不修正的话篮子会高 28% 顶到蛋糕**（1.283 倍）。
 * 单位：归一化后的实际高度（sizeY）。
 */
const NORM_H: Record<string, number> = {
    basket_wicker_02: 1.283,
    fruit_pear: 0.979,
    teaset_01: 0.992,
    goblets_brass: 0.997,
};
const nh = (key: string) => NORM_H[key] ?? 1;

/* 布局思路：中段是主角（月亮蛋糕 + 四支蜡烛 + 酒瓶高脚杯），左段是果盘与
 * 提篮（需求点名的「果盘」），右段是甜点、小食与茶具。所有尺寸都按「实物多大」
 * 写，摆位按桌面 5.94 × 0.88 m 摊开 —— 改 `?bh=` / `?bseg=` 会改桌面尺寸，
 * 但**道具不会跟着变**（它们是真高），所以这套坐标只在缺省几何下严丝合缝。 */
const LAYOUT: PropInst[] = [
    /* ── 中央：月亮主体多层生日蛋糕（不镜像）────────────────────────── */
    { key: 'cake_moon', x: 0.00, z: 0.00, h: CAKE_H, rot: 0.42, mirror: false },

    /* ── 蛋糕两侧：四支细蜡烛（镜像 ⇒ 共 4 支）──────────────────────── */
    { key: 'candle_wood', x: -0.36, z: 0.30, h: 0.26 },
    { key: 'candle_wood', x: 0.36, z: 0.30, h: 0.26 },

    /* ── 中段：酒瓶与高脚杯 ─────────────────────────────────────────── */
    { key: 'bottles_wine', x: 0.76, z: 0.27, h: 0.32 },
    { key: 'goblets_brass', x: -0.76, z: 0.27, h: 0.22 },

    /* ── 左段：果盘（雕花木盘 + 四样水果）与木碗 ────────────────────── */
    { key: 'plate_carved', x: -1.44, z: 0.24, h: 0.045 },
    { key: 'fruit_apple', x: -1.56, z: 0.20, h: 0.085 },
    { key: 'fruit_apple', x: -1.33, z: 0.21, h: 0.080 },
    { key: 'fruit_pomegranate', x: -1.44, z: 0.31, h: 0.100 },
    { key: 'fruit_pear', x: -1.44, z: 0.16, h: 0.110 },
    { key: 'fruit_lychee', x: -1.35, z: 0.29, h: 0.045 },
    { key: 'bowl_wood_01', x: -1.92, z: 0.24, h: 0.095 },
    { key: 'fruit_lime', x: -1.86, z: 0.19, h: 0.055 },
    { key: 'fruit_kiwi', x: -1.98, z: 0.29, h: 0.060 },
    { key: 'basket_wicker_01', x: -2.42, z: 0.00, h: 0.130, mirror: false },
    { key: 'fruit_banana', x: -2.42, z: 0.04, h: 0.150, rot: 0.6, mirror: false },
    { key: 'jug_metal', x: -2.74, z: 0.22, h: 0.28 },
    { key: 'jug_clay', x: -2.74, z: -0.22, h: 0.26, mirror: false },

    /* ── 右段：甜点、小食与茶具 ─────────────────────────────────────── */
    { key: 'cake_strawberry', x: 1.42, z: 0.00, h: 0.12, mirror: false },
    { key: 'cake_carrot', x: 1.96, z: 0.00, h: 0.10, mirror: false },
    { key: 'basket_wicker_02', x: 1.12, z: 0.25, h: 0.26 },
    { key: 'fruit_avocado', x: 1.02, z: 0.13, h: 0.090 },
    { key: 'snack_croissant', x: 2.44, z: 0.19, h: 0.080 },
    { key: 'bowl_wood_02', x: 0.98, z: -0.18, h: 0.16, mirror: false },
    { key: 'teaset_01', x: 2.74, z: 0.00, h: 0.21, mirror: false },
];

/* ════════════════════════════════════════════════════════════════════════════
 * 2.5 座次 —— **导出的唯一真值**
 *
 *     `NpcCrowd.tsx` 的 `?npclayout=table` 直接调 `seatSpots()`，不自己算坐标。
 *     两边各写一份几何迟早对不上（桌子改 `?bh=` 座位就飘到桌外了）。
 * ════════════════════════════════════════════════════════════════════════════ */
/** 长边每侧几席。7 + 7 = 14，加两端 = 16 席，正好「15 NPC + 哥伦比娅」。 */
const SIDE_N = 7;
/** 座位离桌沿的水平退让（米）—— 站姿的人脚尖离桌沿 0.42 m 看着最自然。 */
const SEAT_D = 0.42;

/** 局部 (lx,lz) → 世界坐标 + 朝向桌心的 yaw。
 *  朝向约定：`yaw = 0` 时模型面朝 **+Z**，绕 Y 转 `a` 把前向量映到
 *  `(sin a, 0, cos a)` ⇒ 对准方向 `(dx,dz)` 要 `a = atan2(dx, dz)`。
 *  这与 `NpcCrowd.scatterSpots()` 的 `atan2(-x, -z)`（对准原点）同一套约定。 */
function seatAt(lx: number, lz: number): { x: number; z: number; yaw: number } {
    const [wx, wz] = toWorld(lx, lz, BANQUET_YAW);
    return { x: wx, z: wz, yaw: Math.atan2(BANQUET_X - wx, BANQUET_Z - wz) };
}

/**
 * 桌边座次（世界坐标 + 朝向），**共 15 席 —— 第 16 席留给哥伦比娅**。
 *
 * 为什么只给 15：哥伦比娅归 `MmdCharacter` 管、位置走 `?char=`，缺省
 * `[0, 0, -10]` 正好落在长桌 **+x 端**（`?byaw=90` 下世界 z = `BANQUET_Z − lx`
 * = −6.61 − 3.39 = **−10**，见 `BANQUET_Z` 的推导）。所以这里不返回 +x 端席，
 * 免得她和 NPC 叠在一起。
 *
 * 返回顺序：先 +z 侧 7 席（自 −x 向 +x），再 −z 侧 7 席，最后 −x 端 1 席。
 */
export function seatSpots(): { x: number; z: number; yaw: number }[] {
    const halfL = TABLE_LEN / 2;
    const halfW = TABLE_WID / 2;
    const out: { x: number; z: number; yaw: number }[] = [];
    /* 长边：间距 = 桌长 / 7，两端各留半格，所以第一席在 −3/7·桌长 处。 */
    const step = TABLE_LEN / SIDE_N;
    for (const lz of [halfW + SEAT_D, -(halfW + SEAT_D)]) {
        for (let i = 0; i < SIDE_N; i++) {
            out.push(seatAt((i - (SIDE_N - 1) / 2) * step, lz));
        }
    }
    /* −x 端 1 席（+x 端留给哥伦比娅，不在此列）。 */
    out.push(seatAt(-(halfL + SEAT_D), 0));
    return out;
}

/** 给探针/调试看的一行摘要。 */
export const SEAT_INFO = () => ({
    seats: seatSpots().length,
    columbina: seatAt(TABLE_LEN / 2 + SEAT_D, 0),
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. 加载与摆位
 * ════════════════════════════════════════════════════════════════════════════ */

/** 每份素材只 `loadAsync` 一次，之后 `clone(true)`（与 `VenuePropsReal` 同）。 */
const CACHE: Record<string, THREE.Group | null> = {};

async function getAsset(loader: GLTFLoader, url: string, sb: string[]): Promise<THREE.Group | null> {
    if (url in CACHE) return CACHE[url];
    try {
        const g = await loader.loadAsync(url);
        CACHE[url] = g.scene;
        if (DEBUG) sb.push(`[banquet] 载入 ${url}`);
    } catch (e) {
        CACHE[url] = null;
        sb.push(`[banquet] !! 素材加载失败 ${url}: ${String(e)}`);
    }
    return CACHE[url];
}

/** 材质后处理 —— 见文件头坑 ①。 */
function prepMaterials(root: THREE.Object3D, emis: number) {
    root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        const mm = mesh.material as THREE.Material | THREE.Material[];
        for (const m of Array.isArray(mm) ? mm : [mm]) {
            const s = m as THREE.MeshStandardMaterial;
            if (!s || !(s as unknown as { isMaterial?: boolean }).isMaterial) continue;
            if (s.map) {
                s.emissiveMap = s.map;
                s.emissiveMap.colorSpace = s.map.colorSpace;
                s.emissive?.setRGB(1, 1, 1);
            } else if (s.emissive && s.color) {
                s.emissive.copy(s.color);
            }
            s.emissiveIntensity = emis;
            s.needsUpdate = true;
        }
    });
}

/** 桌面高度（世界 y）—— 在桌子 footprint 上采 `worldHeightCPU` 取**最高点**，
 *  保证没有一条桌腿陷进坡里（`MoonShip.tsx:86` 的 `placeOnTerrain` 同一套理由）。 */
function groundTop(cx: number, cz: number, yaw: number, halfL: number, halfW: number): number {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let y = -Infinity;
    for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
            const u = (i / 2) * halfW;
            const v = (j / 2) * halfL;
            const h = worldHeightCPU(cx + u * c + v * s, cz - u * s + v * c);
            if (h > y) y = h;
        }
    }
    return Number.isFinite(y) ? y : 0;
}

/** 局部 (x,z) → 世界 (x,z)，绕桌心转 `yaw`（与 `MoonShip.placeOnTerrain` 同约定）。 */
function toWorld(lx: number, lz: number, yaw: number): [number, number] {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [BANQUET_X + lx * c + lz * s, BANQUET_Z - lx * s + lz * c];
}

async function buildBanquet(sb: string[]): Promise<THREE.Group> {
    const root = new THREE.Group();
    root.name = 'banquet';
    const loader = new GLTFLoader();

    /* ── 桌面高度 ───────────────────────────────────────────────────────── */
    const y0 = groundTop(BANQUET_X, BANQUET_Z, BANQUET_YAW, TABLE_LEN / 2, TABLE_WID / 2);
    sb.push(`[banquet] 桌心 (${BANQUET_X}, ${BANQUET_Z}) 地面 y=${y0.toFixed(3)}`
        + `｜桌面 ${TABLE_LEN.toFixed(2)} × ${TABLE_WID.toFixed(2)} m｜高 ${TABLE_H} m`
        + `｜${TABLE_SEGS} 段拼接`);

    /* ── ① 桌子：`TABLE_SEGS` 段首尾相接 ───────────────────────────────── */
    const segL = TABLE_SEG_L * TABLE_H;
    const tpl = await getAsset(loader, TABLE_URL, sb);
    if (tpl) {
        prepMaterials(tpl, EMIS);
        for (let i = 0; i < TABLE_SEGS; i++) {
            const lx = (i - (TABLE_SEGS - 1) / 2) * segL;
            const c = tpl.clone(true);
            /* ⚠️ 坑：**不要**再给 `c` 加 `position.set(lx, 0, 0)`。段的世界位置已经由
             * `seg.position`（下面的 `toWorld(lx, 0)`）给足了；子节点再来一次就变成
             * 双重偏移，段间距翻倍成 2 × segL ⇒ 三张桌子之间露出 1.98 m 的空档。
             * 这是 `_logs/banquet/bq_solo_top.png`（正上方俯拍）里发现的：
             * 桌面断成三截、中间两段是空的。修之前实测段心在 z = −2.65 / −6.61 /
             * −10.57（间距 3.96 m，应为 1.98 m）。 */
            c.scale.setScalar(TABLE_H);
            const seg = new THREE.Group();
            seg.add(c);
            const [wx, wz] = toWorld(lx, 0, BANQUET_YAW);
            seg.position.set(wx, y0, wz);
            seg.rotation.y = BANQUET_YAW;
            seg.name = `banquet_table_${i}`;
            root.add(seg);
        }
    } else {
        return root;
    }

    /* ── ② 蛋糕 ─────────────────────────────────────────────────────────── */
    const cakeTpl = await getAsset(loader, CAKE_URL, sb);
    if (cakeTpl) {
        prepMaterials(cakeTpl, CAKE_EMIS);
        const c = cakeTpl.clone(true);
        c.scale.setScalar(CAKE_H);
        const g = new THREE.Group();
        g.add(c);
        const [wx, wz] = toWorld(0, 0, BANQUET_YAW);
        g.position.set(wx, y0 + TABLE_H, wz);
        g.rotation.y = BANQUET_YAW + 0.42;
        g.name = 'banquet_cake';
        root.add(g);
        sb.push(`[banquet] 蛋糕 ${CAKE_H} m 高（水平 ${(0.936 * CAKE_H).toFixed(3)} m）`);
    }

    /* ── ③ 零食 / 饮料 / 果盘 ───────────────────────────────────────────── */
    if (FOOD_ON) {
        const cache: Record<string, THREE.Group | null> = {};
        let n = 0;
        for (const it of LAYOUT) {
            if (it.key === 'cake_moon') continue;
            if (!(it.key in cache)) {
                cache[it.key] = await getAsset(loader, `${P}/${it.key}.glb`, sb);
            }
            const t = cache[it.key];
            if (!t) continue;
            prepMaterials(t, EMIS);

            /* 同一件素材被摆多次 ⇒ 每摆一次都要 `clone`，否则后一次会改掉前一次的
             * `scale` / `position`（`Object3D` 只有一份变换）。 */
            const sides = it.mirror === false ? [it.z] : [it.z, -it.z];
            for (const lz of sides) {
                const c = t.clone(true);
                /* `it.h` 是**期望的真实高度（米）**，而 GLB 的实际高度是 `nh(key)` 倍
                 * （`--normalize` 对四件没做到 1.0，见 `NORM_H`）⇒ 必须除掉。
                 * 不除的话 `basket_wicker_02` 会高 28%（0.334 m 而不是 0.26 m）。 */
                c.scale.setScalar(it.h / nh(it.key));
                const g = new THREE.Group();
                g.add(c);
                const [wx, wz] = toWorld(it.x, lz, BANQUET_YAW);
                g.position.set(wx, y0 + TABLE_H, wz);
                /* 朝向：确定性哈希（判据 N 禁 `fract(sin())`），`rot` 优先。 */
                g.rotation.y = it.rot ?? hash01(it.x * 100, lz * 100, 31) * Math.PI * 2;
                g.name = `banquet_${it.key}_${n++}`;
                root.add(g);
            }
        }
        sb.push(`[banquet] 桌面陈设 ${n} 件（${new Set(LAYOUT.map((i) => i.key)).size} 种素材）`);
    }

    /* ── ④ 椅子（`?bchair=1`，缺省摆）────────────────────────────────── */
    if (CHAIR_ON) {
        /* ★ 用户 m02724 定版（以此为准）：
         *   「所有 NPC 是坐姿，而唯独哥伦比娅本人**没有椅子**，是**站着**的，
         *     留出的是**中央主位**给哥伦比娅切蛋糕用。」
         * ⇒ 只给 15 个 NPC 摆椅子（`seatSpots()` 的 15 席）。
         *   **不要**再把 `SEAT_INFO().columbina`（+x 端第 16 席）拼进来 ——
         *   那是 §0.10 那版「16 人围坐」的写法，已被这条指令推翻。
         *   哥伦比娅站在那一席上切蛋糕，椅子留空。 */
        const seats = seatSpots();
        let nc = 0;
        for (let i = 0; i < seats.length; i++) {
            const sp = seats[i];
            const key = CHAIR_MIX
                ? CHAIR_POOL[Math.floor(hash01(i, 17, 43) * CHAIR_POOL.length) % CHAIR_POOL.length]
                : CHAIR_POOL[0];
            const url = `${CHAIR_DIR}/${key}.glb`;
            const t = await getAsset(loader, url, sb);   // 自带缓存，同款只 load 一次
            if (!t) continue;
            prepMaterials(t, EMIS);
            const c = t.clone(true);
            c.scale.setScalar(CHAIR_H);
            const g = new THREE.Group();
            g.add(c);
            /* 椅子摆在「人的位置」往**桌心反方向**退 `CHAIR_BACK` 米 —— 座位点
             * 是人站的位置（离桌沿 `SEAT_D`），椅子要再退一点才不与人重叠。 */
            const yaw = sp.yaw;                       // 该席面朝桌心
            const bx = -Math.sin(yaw) * CHAIR_BACK;   // 面朝 (sin yaw, cos yaw) ⇒ 退是取负
            const bz = -Math.cos(yaw) * CHAIR_BACK;
            g.position.set(sp.x + bx, y0, sp.z + bz);
            /* 椅子也要面朝桌心：`yaw = 0` 面朝 +Z，对准 (dx,dz) 取 `atan2(dx,dz)`，
             * 与 `seatAt()` 同一套约定。再加该款的朝向补偿。 */
            g.rotation.y = yaw + (CHAIR_YAW_FIX[key] ?? 0);
            g.name = `banquet_chair_${i}`;
            root.add(g);
            nc++;
        }
        sb.push(`[banquet] 椅子 ${nc} 把（${CHAIR_MIX ? `${new Set(CHAIR_POOL).size} 款混搭` : CHAIR_POOL[0]}，高 ${CHAIR_H} m）`);
    }

    root.updateMatrixWorld(true);
    return root;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 4. 组件
 * ════════════════════════════════════════════════════════════════════════════ */
export function Banquet({ visible = true }: { visible?: boolean }) {
    const [group, setGroup] = useState<THREE.Group | null>(null);

    useEffect(() => {
        if (!BANQUET_ON) return;
        let cancelled = false;
        const sb: string[] = [];
        buildBanquet(sb).then((g) => {
            if (cancelled) return;
            sb.forEach((s) => console.log(s));
            setGroup(g);
        }).catch((e) => {
            console.error('[banquet] 构建失败', e);
        });
        return () => { cancelled = true; };
    }, []);

    /* 与 `VenuePropsReal` 同：相机退到 120 m 外就整体剔除（地形盘半宽只有
     * `TERRAIN_AREA/2 = 80 m`，再远会看到桌子悬在盘外）。 */
    const HIDE_R = 120;
    useFrame(({ camera }) => {
        if (!group) return;
        const dx = camera.position.x - BANQUET_X;
        const dz = camera.position.z - BANQUET_Z;
        group.visible = visible && dx * dx + dz * dz < HIDE_R * HIDE_R;
    });

    if (!group) return null;
    return <primitive object={group} visible={visible} />;
}

/** 探针：给 `_tools/webgpu-shot.mjs --eval` 读，确认桌子真的建出来了。 */
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__banquet = () => ({
        on: BANQUET_ON,
        segs: TABLE_SEGS,
        len: +TABLE_LEN.toFixed(3),
        wid: +TABLE_WID.toFixed(3),
        h: TABLE_H,
        cake: CAKE_H,
        food: FOOD_ON,
        items: FOOD_ON ? LAYOUT.length : 0,
        chair: CHAIR_ON,
        chairN: CHAIR_ON ? seatSpots().length : 0,
    });
}

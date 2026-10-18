/* ==================================================================
 * 道具避让区（Keep-Out）—— 一份真值，三处消费
 *
 * 用户 m02063 的任务 2：「草地上实现『避开道具』的功能」。
 *
 * 为什么要有这个文件：需要「知道哪里有实体道具」的地方现在有三个，而且它们
 * 各自都不知道别人的存在 ——
 *   ① 草地 compute shader（`grassCompute.ts`）：叶片不能长进石头/长桌/蛋糕台的肚子里；
 *   ② 角色碰撞（`MmdCharacter.tsx` 的 `deskPush()`）：人不能穿过月牙石桌；
 *   ③ 花丛摆放（`FlowerClusters.tsx`）：不能把花插进石头里。
 * 三处各抄一份坐标 = 迟早对不上（这个项目已经因为「同一份坐标抄两遍」栽过：
 * 见 `继续任务.MD` §0.16 的 `CAKE_STAND_XZ` 事件）。所以这里只留一份。
 *
 * ── 形状为什么统一用「旋转椭圆」──
 * 道具的占地轮廓基本是「一条长边 + 一条短边 + 某个朝向」：月牙石桌 2.70×1.05、
 * 宴会长桌 1.60×5.94、蛋糕台近似圆。圆盖不住长条（半径取大到盖住长边，短边两侧
 * 就会空出两米长的隐形墙），矩形又会在角上多切掉一块。旋转椭圆两个半轴分开给，
 * 且 `归一化 → 单位圆径向推出` 有闭式解（见 `MmdCharacter.tsx:936` 的注释），
 * 三处都能用同一条判据：把点变换进椭圆局部系后，`q = sqrt((lx/rx)² + (lz/rz)²)`，
 * `q < 1` 就在里面。
 *
 * ── GPU 侧为什么是定长数组 ──
 * 草地的避让跑在 compute shader 里，WebGPU 不支持「运行期长度的 uniform 数组」。
 * 所以这里给一个**固定槽位数** `KEEP_OUT_MAX`，没用的槽位落在 `(9999, 9999)` 且
 * 半径取 1e-3 —— 归一化距离会变成天文数字，`smoothstep` 直接饱和成 1（= 不影响）。
 * 加道具时如果槽位不够，把 `KEEP_OUT_MAX` 调大即可（shader 侧按常量展开）。
 * ================================================================== */

import { BANQUET_XZ, CAKE_STAND_XZ, DESK_XZ, DESK_YAW, MAILBOX_XZ } from '../game/layout';

/** 一个「道具占掉的地盘」：中心 + 两个半轴 + 绕 Y 的朝向（弧度）。 */
export interface KeepOutEllipse {
    /** 中心世界 X */
    x: number;
    /** 中心世界 Z */
    z: number;
    /** 局部 X 方向的半轴（米） */
    rx: number;
    /** 局部 Z 方向的半轴（米） */
    rz: number;
    /** 绕 Y 的朝向（弧度）。局部 X 轴 = `(cos rot, -sin rot)` 这个方向。 */
    rot: number;
    /** 仅用于调试打印 */
    name: string;
}

/**
 * 月牙石桌的占地半轴。
 *
 * 真值来源：`public/venue/game/moon_table.glb` 归一化 bbox `宽 1.550 × 深 0.605 × 高 1.436`，
 * `DeskProps.tsx` 里再乘 `MOON_SCALE = 1.74` ⇒ 2.697 × 1.053 × 2.499 m。
 * 半轴取 `1.35 / 0.53`（比 bbox 略收 1~2 cm：碰撞边界稍微切进石头一点，
 * 读起来比「隔着一层空气撞墙」自然）。
 */
export const DESK_HALF_X = 1.35;
export const DESK_HALF_Z = 0.53;

/**
 * 宴会长桌的半轴。
 *
 * `BANQUET_YAW = 90°` ⇒ 局部 `lx` 映射到世界 **Z**、局部 `lz` 映射到世界 **X**
 * （`layout.ts:207-210` 有推导）。所以世界系里：X 半轴 = 桌宽的一半、
 * Z 半轴 = 桌长的一半。
 */
const BANQUET_HALF_W = 0.85;
const BANQUET_HALF_L = 3.00;

/**
 * 全部避让区。**顺序即 GPU 槽位顺序**，改顺序前先看 `KEEP_OUT_MAX` 够不够。
 */
export const KEEP_OUT: KeepOutEllipse[] = [
    {
        x: DESK_XZ[0], z: DESK_XZ[1],
        rx: DESK_HALF_X, rz: DESK_HALF_Z, rot: DESK_YAW,
        name: '月牙石桌',
    },
    {
        x: BANQUET_XZ[0], z: BANQUET_XZ[1],
        // 90° 旋转后局部 X→世界 Z：直接给「世界系半轴」，rot 填 0
        rx: BANQUET_HALF_W, rz: BANQUET_HALF_L, rot: 0,
        name: '宴会长桌',
    },
    {
        x: CAKE_STAND_XZ[0], z: CAKE_STAND_XZ[1],
        /* ⚠️ 2026-10-19 用户看图反馈「会场这一片不长草的地板是啥？」
         *   原来是 0.95 —— 那是**把蛋糕台当成直径 1.9 m 的圆盘**去清草，
         *   而蛋糕台本身只有 0.6 m 上下。它又和长桌那一片在 z 方向连成一条，
         *   两片一合并就成了一块 3 m × 7 m 的「水泥地」。
         *   现在收到和真实占地相当的 0.55，重叠区也不再连片。 */
        rx: 0.55, rz: 0.55, rot: 0,
        name: '蛋糕台',
    },
    {
        x: MAILBOX_XZ[0], z: MAILBOX_XZ[1],
        rx: 0.42, rz: 0.42, rot: 0,
        name: '信箱',
    },
];

/* ── 阶段开关：长桌与蛋糕台只在「宴会阶段」才存在 ──────────────────────
 * 用户 m03988：「那个光秃的一条（蛋糕桌子）你等任务进行到那一步的时候，再压草高度。
 *              之前正常。」
 * 也就是说：委托阶段（letter / quest）场上根本没有长桌和蛋糕台，草地上却已经
 * 提前留出两条空地 —— 那条「水泥地」在宴会开始前**始终存在**，而玩家那时看得最多。
 * 现在把这两处做成可开关的槽位：`setKeepOutProps(false)` 时它们的半径压到 1e-3、
 * 中心丢到 (9999,9999)，等价于「不存在」；宴会开始时再恢复。
 *
 * ⚠️ GPU 侧的 uniformArray 是**模块级 Vector4 数组**（`useGrassUniforms.ts` 的
 *    `KEEP_A` / `KEEP_B`）。`UniformArrayNode.update()` 是 `NodeUpdateType.RENDER`，
 *    每次渲染都会把数组内容重新打包上传 ⇒ 只要改掉这些 Vector4 的数值，下一帧就生效，
 *    不需要重建材质。改完记得调 `syncKeepOutUniforms()`（同文件导出）。 */
const PROPS_SLOTS = [1, 2];
const PROPS_ORIGINAL = PROPS_SLOTS.map((k) => ({ ...KEEP_OUT[k] }));
let propsOn = true;

/**
 * 开关「长桌 + 蛋糕台」这两处避让区（槽位 1、2）。返回是否真的发生了变化。
 * 只在阶段切换时调一次，别每帧调（会白改 uniform）。
 */
export function setKeepOutProps(on: boolean): boolean {
    if (propsOn === on) return false;
    propsOn = on;
    for (let i = 0; i < PROPS_SLOTS.length; i++) {
        const k = PROPS_SLOTS[i];
        KEEP_OUT[k] = on
            ? { ...PROPS_ORIGINAL[i] }
            : { ...KEEP_OUT_EMPTY, name: PROPS_ORIGINAL[i].name };
    }
    return true;
}

/** 当前是否已经开了（给调试/探针用）。 */
export function keepOutPropsOn(): boolean { return propsOn; }

/** GPU 侧固定槽位数。当前只用了 4 个，留 8 个够以后加。 */
export const KEEP_OUT_MAX = 8;

/** 空槽位（不影响任何东西）：半径 1e-3 + 远处坐标 ⇒ 归一化距离爆表 ⇒ 因子恒 1。 */
export const KEEP_OUT_EMPTY: KeepOutEllipse = { x: 9999, z: 9999, rx: 1e-3, rz: 1e-3, rot: 0, name: '' };

/**
 * 把 `(x, z)` 变换进第 `k` 个避让区的局部系，返回归一化椭圆距离 `q`。
 * `q < 1` 在椭圆内，`q = 1` 正好在边界上。
 */
export function keepOutQ(k: number, x: number, z: number): number {
    const o = KEEP_OUT[k];
    if (!o) return Infinity;
    const dx = x - o.x;
    const dz = z - o.z;
    const c = Math.cos(o.rot);
    const s = Math.sin(o.rot);
    // 世界 → 局部（绕 Y 旋转 rot 的逆变换）：局部 X 轴 = (cos, −sin)
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    return Math.hypot(lx / o.rx, lz / o.rz);
}

/**
 * CPU 版避让因子：1 = 完全不受影响，0 = 完全在道具肚子里。
 * `1 ~ 1.45` 是过渡带（草叶从满高渐隐到 0），避免出现「一刀切的圆坑」。
 *
 * ⚠️ 与 shader 里那一段**必须同参**（`smoothstep(1.0, 1.45, q)`）。
 */
export function keepOutFactor(x: number, z: number): number {
    let q = Infinity;
    for (let k = 0; k < KEEP_OUT.length; k++) q = Math.min(q, keepOutQ(k, x, z));
    const t = (q - 1.0) / (1.45 - 1.0);
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);   // smoothstep
}

/**
 * CPU 版「草还能长多高」的系数：KEEP_H_MIN（踩秃的短草茬）~ 1（满高）。
 * 用到它的地方要和 shader 里 mix(KEEP_H_MIN, 1, keep) 完全一致。
 */
export function keepOutHeightFactor(x: number, z: number): number {
    return KEEP_H_MIN + (1 - KEEP_H_MIN) * keepOutFactor(x, z);
}

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

import { BANQUET_XZ, CAKE_STAND_XZ, DESK_XZ, DESK_YAW, MAILBOX_XZ, pointXZ } from '../game/layout';
import { QNUM } from '../utils/query';
import { CRATERS, CRATER_FLOOR_ON } from '../worldRegions';

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

/* ── ★★ 2026-10-20 task-10：四处采集点的「贴地浅水台」也要压草 ──────────────
 *
 * 用户 2026-10-20 截图反馈（`公用区\10月20日反馈.png`，缩略 `_logs/fb1.jpg`）：
 * 「草地上有一块扁平的浅灰多边形板，离远了看得见、走近就没了。」
 *
 * 实测定位（无头探针 + 出图，证据 `_logs/render/T10*.png`、`_logs/render_t10*.jsonl`）：
 *   · `collect_water_0`  `(-15.2, 4.9)`   ⌀3.13 m、台面高 0.24 m
 *   · `collect_spring_0` `( 36.5,-16.3)` ⌀3.53 m、含石台/芦苇总高 2.25 m
 *   两者都是 `CollectProps.tsx` 的 `buildSpring`/`buildWater` 造的**浅水石台**：
 *   泥底 `2c2119` + 水面 `5fa8d8`（opacity 0.66）+ 一圈灰石块 `8b8f96`
 *   + 14 棱裙边圆柱 ⇒ 从上往下看就是一块**浅灰多边形板**，边缘有一圈可见侧壁。
 *
 * 为什么「远现近隐」：台面离地只有 0.24 m，而草是齐人高（≈1.6 m）。
 * 从高处/远处越过草尖能看到台面；玩家走到跟前时视线贴着草尖，
 * 台子整块被草吞掉（实测 16 m / 5 m 高机位已经**完全看不见**，见 `T10f_pond16.png`）。
 *
 * 修法：给这四处各留一块半径 `POND_KEEP_R` 的短草区（`KEEP_H_MIN = 8%` 的矮草茬，
 * 过渡带到 `1.45 × r ≈ 2.75 m`）。半径只比台子本身大 0.5 m ⇒ 既不会像蛋糕台那样
 * 连成一片「水泥地」，也保证台子在**任何距离**都是「草地上的一个水洼」。
 * ⚠️ 这四块是**追加槽位**（索引 4~7），不参与 `setKeepOutProps` 的阶段开关；
 *    加完后 `KEEP_OUT_MAX = 8` 刚好用满 —— 以后再加水台要先把这个常量调大。 */
const POND_KEEP_R = 1.9;
const POND_IDS = ['water', 'spring', 'fish', 'lamp'] as const;
/** `?pondkeep=0` 关掉这四块（A/B 对照：关掉即用户反馈时的旧样子）。 */
const POND_KEEP_ON = QNUM('pondkeep', 1)! > 0;
if (POND_KEEP_ON) {
    for (const id of POND_IDS) {
        for (const [x, z] of pointXZ(id)) {
            KEEP_OUT.push({ x, z, rx: POND_KEEP_R, rz: POND_KEEP_R, rot: 0, name: `采集点·${id}` });
        }
    }
}

/* ── ★★ 2026-10-20 task-17：坑里那艘飞船（机身 / 龙骨贴地段）也要压草 ────────
 *
 * 用户 m01992：「草叶不许和飞船模型穿模 —— 船底/船腹下不要冒草尖」，
 * 用户 m02038 给了范式：「效果等同于邀请函的月牙桌子和草之间的避让效果」
 * ⇒ 就是**这一张表**（草 `useGrassUniforms.ts` / 花 `FlowerClusters.tsx` 都读它），
 *   不另写一套 mask。
 *
 * 形状：随船停泊朝向旋转的椭圆。船体实测 bbox = **16.51 × 3.64 × 26.00 m**
 * （`WingShipApi.tsx:137-142`：`halfW = s1.x/2 = 8.25` 展向、`halfL = s1.z/2 = 13.00` 船长）：
 *   · 龙骨/机身在**局部 Z** 方向压进地里 0.3 m（`API_BURY`）⇒ 长轴必须盖住整条龙骨，
 *     否则机首/机尾下方会冒出齐腰高的草尖（那就是用户说的「穿模」）；
 *   · 两侧发动机舱在展向 25%~33% 处低到龙骨底面 ⇒ 局部 X 方向要盖住它们；
 *   · 机翼外侧仍留草（那里离地 0.8~2.5 m，草碰不到）。
 *
 * ⚠️ 半轴**不写死**：`WingShipApi.tsx` 量完真实 bbox 后调 `setShipKeepOut()`
 *    覆盖（参数是 `halfW`/`halfL`，来自 `s1.x/2`、`s1.z/2`）。这里的初值只是
 *    「量出来之前」的占位 —— 用当前船（`Ship01.glb`，16.51 × 26.00 m）的实测值。
 * ⚠️ 占 1 个槽位 ⇒ `KEEP_OUT_MAX` 从 8 抬到 9（`useGrassUniforms.ts` 的
 *    `KEEP_A/KEEP_B` 与 `grassCompute.ts` 的循环都按这个常量定长，会自动跟上）。
 * `?craterfloor=0`（A/B 回旧观感）时这一条也一起废掉 —— 旧观感里坑底根本没草。 */
const SHIP_KEEP_SLOT = KEEP_OUT.length;
export const SHIP_KEEP_INDEX = SHIP_KEEP_SLOT;
/** 椭圆半轴相对 bbox 半轴的「收紧系数」+ 余量（米）。按低机位观感可调。 */
const SHIP_KEEP_RX_K = 0.70;
const SHIP_KEEP_RZ_K = 0.85;
const SHIP_KEEP_MARGIN = 0.35;
/** 当前船的实测半轴（米）：`Ship01.glb` = 16.51 × 26.00 m。仅作「运行时覆盖之前」的初值。 */
const SHIP_HALF_W0 = 8.25;
const SHIP_HALF_L0 = 13.0;

KEEP_OUT.push(
    CRATER_FLOOR_ON
        ? {
            x: CRATERS[0].x, z: CRATERS[0].z,
            rx: SHIP_HALF_W0 * SHIP_KEEP_RX_K + SHIP_KEEP_MARGIN,
            rz: SHIP_HALF_L0 * SHIP_KEEP_RZ_K + SHIP_KEEP_MARGIN,
            rot: (QNUM('wyaw', -24)! * Math.PI) / 180,
            name: '飞船（机身/龙骨）',
        }
        : { x: 9999, z: 9999, rx: 1e-3, rz: 1e-3, rot: 0, name: '飞船（机身/龙骨）·关' },
);

/**
 * 用 `WingShipApi.tsx` **运行时量到的** bbox 半轴刷新飞船那一条避让区。
 *
 * 为什么必须运行时给：船换素材/换 `?wlen=` 之后 `s1.x/2`、`s1.z/2` 就变了，
 * 写死 13 / 8.25 会让草第二天从船肚子里长出来（而且只在换素材时才发现）。
 *
 * 调用方（`WingShipApi.tsx` 里 `halfL/halfW` 算出来之后）：
 * ```ts
 * if (setShipKeepOut(halfW, halfL, (API_YAW * Math.PI) / 180)) syncKeepOutUniforms();
 * ```
 * ⚠️ 必须跟着调 `syncKeepOutUniforms()`（`useGrassUniforms.ts`）—— GPU 侧的
 *    `uKeepA/uKeepB` 是模块级 Vector4 数组，改完不推就还是旧值。
 * @returns 是否真的改了（`?craterfloor=0` 时这条槽位是空的，返回 false）
 */
export function setShipKeepOut(halfW: number, halfL: number, rotRad: number): boolean {
    if (!CRATER_FLOOR_ON) return false;
    const o = KEEP_OUT[SHIP_KEEP_SLOT];
    if (!o) return false;
    const rx = halfW * SHIP_KEEP_RX_K + SHIP_KEEP_MARGIN;
    const rz = halfL * SHIP_KEEP_RZ_K + SHIP_KEEP_MARGIN;
    if (Math.abs(o.rx - rx) < 1e-4 && Math.abs(o.rz - rz) < 1e-4 && Math.abs(o.rot - rotRad) < 1e-4) return false;
    o.rx = rx;
    o.rz = rz;
    o.rot = rotRad;
    return true;
}

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

/**
 * GPU 侧固定槽位数。
 * 4 原有（月牙石桌 / 长桌 / 蛋糕台 / 信箱）+ 4 采集点水洼 + **1 飞船**（task-17）= 9。
 * ⚠️ 这个常量同时决定 `useGrassUniforms.ts` 的 `KEEP_A/KEEP_B` 长度与
 *    `grassCompute.ts:59` 的循环上界 —— 加槽位只改这里，两处会自动跟上。
 */
export const KEEP_OUT_MAX = 9;

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
export const KEEP_H_MIN = 0.08;

export function keepOutHeightFactor(x: number, z: number): number {
    return KEEP_H_MIN + (1 - KEEP_H_MIN) * keepOutFactor(x, z);
}

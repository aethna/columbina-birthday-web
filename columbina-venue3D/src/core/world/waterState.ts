/* ══════════════════════════════════════════════════════════════════════════════
 * 月坑浅水 · 唯一真值（state + 几何函数）
 *
 * 用户 m02364 任务5：「原喇叭花部分改成浅水（高度最高到哥伦比娅膝盖）。
 *   并加入人物模型和水体碰撞（即人物走过去会掀起波浪）。」
 *
 * 这个模块是水体的**唯一真值**：环带半径、深度、水面高度、涉水阻尼、
 * 涟漪状态全在这里，材质与角色都只读它 —— 不要再在别处写第二份常数。
 *
 * ── 水面高度（`SURFACE_MODE`）──────────────────────────────────────────────
 * 坑是**碗形**：任何水平面都会把飞船泡进去、或与坑壁穿插。
 * 所以缺省 `SURFACE_MODE = 'sheet'` ⇒ 水面**贴地形抬升**：
 *      waterY(x,z) = worldHeightCPU(x,z) + pondDepthAt(x,z)
 * 坑底被 task-19 抬到 ~-2.45 m、`r ≤ 15` 变平台之后，这条式子自动跟着走 ——
 * **绝对不要**在这里写死任何高度常数（坑底、坑缘随时会被改）。
 * 若用户改成「平面 + 环形水槽」（`'plane'`），把 `SURFACE_MODE` 切过去即可：
 * 那时水面取 `planeY`（= 环带内 `worldHeightCPU` 的最高点 + 深度），
 * 几何构建处（`components/water/CraterWater.tsx`）已经按两种模式分支。
 *
 * ── 与其它模块的边界（硬约束）──────────────────────────────────────────────
 * · 不改 `MoonShip.tsx` / `WingShipApi.tsx` 的落点与姿态：水面只是**画在**
 *   地形上方的薄片，碰撞、落位、`__dshProbe(0,-196)` 全都逐字不变。
 * · 不改 `worldRegions.ts` / `worldHeight.ts` / `Terrain.tsx`（task-19 的 scope）：
 *   这里只**读** `worldHeightCPU` 与 `CRATERS`，以及可选的 `POND_*` 常量。
 * ══════════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { QNUM, QSTR } from '../utils/query';
import * as WR from '../worldRegions';
import { CRATERS, worldHeightCPU } from '../worldRegions';

/* ── 0. 常量 ─────────────────────────────────────────────────────────────── */

/** 总开关：`?craterwater=0` 关掉水体（验收 ④ 用；关掉后是 task-19 的暗蓝地面）。 */
export const WATER_ON = QNUM('craterwater', 1)! > 0;

/** 坑心（= 主坑中心，飞船落点）。 */
export const POND_CX = CRATERS[0].x;
export const POND_CZ = CRATERS[0].z;

/** 从 `worldRegions.ts` 里取 `POND_*`（task-19 落盘后会变成真值），没落盘就用卡片默认值。 */
const numOr = (key: string, dflt: number): number => {
    const v = (WR as unknown as Record<string, unknown>)[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
};

/** 环带内缘 / 外缘（米，相对坑心）。task-25 起 = 坑缘外的平地环槽（25.5 ~ 33）。 */
export const POND_R_IN = numOr('POND_R_IN', 15.0);
export const POND_R_OUT = numOr('POND_R_OUT', 21.5);
/** 水面高出地形的量（= 水深）。0.30 m，硬上限 0.42 m = 身高 1.379 m 的膝盖。 */
export const POND_DEPTH = numOr('POND_DEPTH', 0.30);
export const POND_DEPTH_MAX = numOr('POND_DEPTH_MAX', 0.42);
/** 内外缘的过渡带宽度（米）：`?waterfade=`（0 = 硬边，1.0 = 缺省，2 = 更柔）。 */
export const EDGE_FADE = QNUM('waterfade', 1.0)!;

/**
 * 水面模式（task-25）。用户 m02547 澄清「水环不在坑里，水环在地面上」⇒ 水体搬到
 * 坑缘外的平地环槽（r 25.5~33），槽底水平、水面也水平 ⇒ `'plane'`。
 *
 * **自动判定而不是写死**：asset 的 task-24 落盘前 `POND_R_OUT` 还是 21.5（在坑内），
 * 那时切成平面会让水面悬在坑壁上。所以按 `POND_R_OUT >= 30` 判定 —— 新地形一落盘
 * 这里自动变 `'plane'`，共享 dev server 上不会出现「平面泡进坑里」的中间态。
 * `?watermode=sheet` 可强制回旧模式做 A/B。
 */
const PLANE_READY = POND_R_OUT >= 30;
const MODE_OVR = QSTR('watermode', '');
export const SURFACE_MODE: 'sheet' | 'plane' =
    MODE_OVR === 'sheet' ? 'sheet'
        : MODE_OVR === 'plane' ? 'plane'
            : (PLANE_READY ? 'plane' : 'sheet');

/**
 * 水平水面高度（世界米，`'plane'` 模式唯一真值）=
 * 「环槽外侧平地高度 − 0.02」，与 asset 的 `worldRegions.computePondWaterY()` **同一式子**，
 * 但**在运行时（挂载后）现算**，不抄模块求值期的常量。
 *
 * 为什么不用 `worldRegions.POND_WATER_Y` 这个常量：它是 `worldRegions` 模块求值那一刻算出来的，
 * 而 `worldHeightCPU` 读的是 `uTerrainAmp/uTerrainFreq/uTerrainSeed` 这些**可在运行时被 URL 覆盖**的
 * uniform —— 实测同一页面里会出现 `worldRegions.POND_WATER_Y = 0.1437`（早求值实例）与
 * `0.1252`（晚求值实例 / asset 报的值）两个数，差 1.9 cm，水面就浮在地面之上。
 * 现算 ⇒ 永远跟当前地形一致；`?waterY=` 可强行指定做 A/B。
 */
const WATER_Y_OVR = QNUM('waterY', 0)!;
let _waterY: number | null = null;

export function pondWaterY(): number {
    if (_waterY !== null) return _waterY;
    if (WATER_Y_OVR) { _waterY = WATER_Y_OVR; return _waterY; }
    /* 采样半径取 `POND_R_OUT + 0.8`（= 33.8 m）：这一圈在**平地平台上、且已出了环槽**
       （环槽 25.5~33、收边 ±0.7 ⇒ 33.8 处槽深贡献 < 0.1 cm），中位数就是平地高度。
       ⚠️ 不要用 r = 32 采样 —— 那落在槽底（−0.32），会得到「槽底 + 0.30」的假水面（实测 −0.176）。 */
    const R_PROBE = POND_R_OUT + 0.8;
    const hs: number[] = [];
    for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        hs.push(worldHeightCPU(POND_CX + R_PROBE * Math.cos(a), POND_CZ + R_PROBE * Math.sin(a)));
    }
    hs.sort((a, b) => a - b);
    _waterY = hs[hs.length >> 1] - 0.02;
    return _waterY;
}

/** 涉水阻力：水里期望速度 × 这个系数（用户要求「走过去会掀起波浪」，阻力只是体感）。 */
export const WATER_PACE = QNUM('waterpace', 0.75)!;

/**
 * 涉水阻力随**浸没深度**变化的下限（2026-10-21 反馈3 新增）。
 *
 * 旧实现是**固定乘 0.75** —— 不管水到脚踝还是到小腿，都是同一个减速比例，
 * 于是「踩进水里」和「踩进浅坑」体感上没有任何区别，用户读作「碰撞很差」。
 * 现在：`pace = 1 - (1 - WATER_PACE) * saturate(depth / PACE_DEPTH_REF)`。
 *
 * ⚠️ 参照深度必须按**真实水深分布**取，不能拍脑袋填 0.30：
 *    实测（`_logs/t21/water4.jsonl`，`__waterTest.depth`）环带内水深分布是
 *      r 外侧水线 0.0215 → 环带主体 **0.30** → 内侧水线 0.3669
 *    ⇒ 环带**绝大部分水深都 ≥ 0.30**。第一版取 `PACE_DEPTH_REF = 0.30`，
 *      结果 pace 在 r 一进水就饱和到 0.75，只有最外 2 cm 有斜坡，
 *      「越走越沉」在画面上完全不存在（等于把常量 0.75 换了个写法）。
 *    改取 **0.15**：斜坡落在两条水线的浅水带里（depth < 0.15），
 *    主体仍是满阻力 0.75 —— 诚实口径是「入水/出水有过渡，水中间阻力恒定」，
 *    因为这片水**本来就是等深的**（`POND_DEPTH` 恒定），没有更深处可走。
 */
export const PACE_DEPTH_REF = QNUM('waterpaceref', 0.15)!;

/**
 * 涉水时的**垂直沉降**（米/最大水深）。
 *
 * 旧实现只缩水平位移 ⇒ 角色像在冰面上平移，读作「打滑」。人涉水时身体会被
 * 水的浮力+阻力抬住、脚下又踩进泥里，整体略微下沉。这里让 `group.y` 按
 * `-PACE_SINK * saturate(depth / PACE_DEPTH_REF)` 下沉，并在出水的 0.35 s 内
 * 线性回位（由 `MmdCharacter.tsx` 每帧朝目标 lerp，不做突变）。
 */
export const PACE_SINK = QNUM('watersink', 0.045)!;

/** 涟漪：同时存在 3 圈，最大半径 1.8 m，每 1/0.55 s 扩散一圈。
 *  ⚠️ 2026-10-22 第三轮（t1）：2.6 → 1.8。用户截图里那圈「横跨画面的同心巨环」
 *  就是这个半径：人站在水里时最外环直径 5.2 m，比人高 3 倍。
 *  收到 1.8 m 后最外环直径 3.6 m，仍明显小于水环宽度（25.5~33 ⇒ 7.5 m 宽）。
 *  配套：`CraterWater.tsx` 里环带宽 0.22~0.42 → 0.13~0.26，泡沫 alpha 减半。 */
export const RIPPLE_COUNT = 3;
export const RIPPLE_MAX_R = QNUM('rippler', 1.8)!;
export const RIPPLE_SPEED = QNUM('ripplespd', 0.55)!;
/** 停下后强度衰减到 0 所需时间（秒）：用户要求 1.5 s 内收干净。 */
export const RIPPLE_FADE_SEC = 1.5;

/**
 * 在水里**站着不动**时的残余涟漪强度（0 = 完全静止）。
 *
 * 用户反馈3 修复时新增：旧代码在水里站着也把强度抬到 0.25 并**永不衰减**，
 * 读作「一圈不会消失的亮环」。改成只由真实速度驱动后，站定时强度会一路掉到 0；
 * 但脚确实踩在水里，留一点点余波更像液体（`?waterresidual=` 可调，0 = 绝对静止）。
 */
export const STAND_RESIDUAL = QNUM('waterresidual', 0.06)!;

/** 速度方向低通的时间常数（1/s）：越小越黏、越大越跟手。 */
export const WATER_VEL_SMOOTH = QNUM('watervel', 8)!;

/* ── 1. 纯函数（几何 / 深度 / 判定）──────────────────────────────────────── */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v: number): number => {
    const t = clamp01(v);
    return t * t * (3 - 2 * t);
};

/** 到坑心的水平距离。 */
export function pondRadiusAt(x: number, z: number): number {
    return Math.hypot(x - POND_CX, z - POND_CZ);
}

/**
 * 环带遮罩：0 = 干地，1 = 满水，中间由 `EDGE_FADE` 米宽的 smoothstep 过渡。
 * 坑心一侧（`r < POND_R_IN`）与坑壁一侧（`r > POND_R_OUT`）都是 0。
 */
export function pondMaskAt(x: number, z: number): number {
    const r = pondRadiusAt(x, z);
    const edge = Math.max(1e-3, EDGE_FADE);
    const inn = smooth01((r - (POND_R_IN - edge)) / edge);
    const out = 1 - smooth01((r - (POND_R_OUT - edge)) / edge);
    return clamp01(inn * out);
}

/** 是否在水里（`margin` 是宽容带，给「刚踩到水边」用）。 */
export function inPond(x: number, z: number, margin = 0): boolean {
    if (!WATER_ON) return false;
    const r = pondRadiusAt(x, z);
    return r >= POND_R_IN - margin && r <= POND_R_OUT + margin;
}

/** 该点的水深（米）。受 `POND_DEPTH_MAX` 硬上限约束。
 *  `'plane'` 模式：水深 = 水平水面 − 地形（负值 = 地面露出水面，钳成 0）。 */
export function pondDepthAt(x: number, z: number): number {
    if (SURFACE_MODE === 'plane') {
        const d = (pondWaterY() - worldHeightCPU(x, z)) * pondMaskAt(x, z);
        return d > 0 ? d : 0;
    }
    const d = Math.min(POND_DEPTH, POND_DEPTH_MAX) * pondMaskAt(x, z);
    return d > 0 ? d : 0;
}

/**
 * 该点的**涉水减速系数**（1 = 不减速，`WATER_PACE` = 最深处）。
 *
 * 2026-10-21 反馈3 修复：旧版是常量 `WATER_PACE`，脚踝深和齐小腿深一个手感。
 * 现在按脚点水深插值 —— 站到水线边上不卡，往中间走越走越沉。
 * ⚠️ 唯一真值在这里，`MmdCharacter.tsx` 只读不算，避免第二份公式。
 */
export function waterPaceAt(x: number, z: number): number {
    if (!WATER_ON || PACE_DEPTH_REF <= 0) return WATER_PACE;
    const t = clamp01(pondDepthAt(x, z) / PACE_DEPTH_REF);
    return 1 - (1 - WATER_PACE) * t;
}

/** 该点的**垂直沉降量**（米，负值 = 往下）。同样只按脚点水深插值。 */
export function waterSinkAt(x: number, z: number): number {
    if (!WATER_ON || PACE_DEPTH_REF <= 0) return 0;
    return -PACE_SINK * clamp01(pondDepthAt(x, z) / PACE_DEPTH_REF);
}

/**
 * 水面世界高度（**唯一实现**，材质/几何/探针都用它）。
 * `'sheet'`：贴地形抬升（旧方案：坑内碗形）；`'plane'`：整个环带同一个 `POND_WATER_Y`（task-25 的新水环）。
 * ⚠️ 不要在这里写死坑底高度 —— 一律从 `worldHeightCPU` 现算（或读 `POND_WATER_Y`）。
 */
export function waterYAt(x: number, z: number): number {
    if (SURFACE_MODE === 'plane') return pondWaterY();
    const ground = worldHeightCPU(x, z);
    const depth = Math.min(POND_DEPTH, POND_DEPTH_MAX) * pondMaskAt(x, z);
    return ground + depth;
}

/* ── 2. 涟漪状态（uniform，材质每帧读）──────────────────────────────────── */

/** 世界时间（秒）—— 涟漪扩散的相位来源。 */
export const uWaterTime = uniform(0);
/**
 * 玩家涉水状态：`x, y = 脚点世界 XZ`；`z = 当前速度 m/s`；`w = 涟漪强度 0..1`。
 * ⚠️ 涟漪**跟着人走**（中心就是这个位置），不是留在原地。
 */
export const uWaterPlayer = uniform(new THREE.Vector4(POND_CX, POND_CZ, 0, 0));

/**
 * 玩家**水平速度**（世界 m/s，vec2）。接触泡沫与尾迹要朝**运动方向**拖长，
 * 只靠 `uWaterPlayer.z` 的标量速度拿不到方向。
 */
export const uWaterVel = uniform(new THREE.Vector2(0, 0));

/**
 * 涉水**接触**状态：`x, y = 脚点世界 XZ`；`z = 是否在水里（0/1）`；`w = 脚点水深（米）`。
 *
 * ★ 2026-10-21 用户反馈3「人物模型和水体的物理碰撞很差」：
 *   站定不动时涟漪强度会衰减到 0，而水面又是 `depthWrite=false` 的半透明片 ⇒
 *   画面上**一点接触痕迹都没有**，人像站在一块玻璃板上。所以单独留一份接触状态，
 *   材质据此在脚踝处画一圈白沫（见 `CraterWater.tsx` 的 ⑤）。
 */
export const uWaterContact = uniform(new THREE.Vector4(POND_CX, POND_CZ, 0, 0));

let rippleStrength = 0;
let lastInWater = false;
let lastX = POND_CX;
let lastZ = POND_CZ;

/**
 * 角色每帧喂进来的涉水状态（`MmdCharacter` 的 `useFrame` 只加这一行，不改既有分支）。
 * 在岸上时 `rippleStrength` 按 `RIPPLE_FADE_SEC` 线性衰减到 0 ⇒ 「停下 1.5 s 内收干净」。
 */
export function setPlayerWaterState(x: number, z: number, speed: number, delta: number): void {
    const d = Number.isFinite(delta) && delta > 0 ? delta : 1 / 60;
    const wet = inPond(x, z, 0.5);
    /* ★★ 2026-10-21 用户反馈3 修复：原来只要 `wet` 为真就
         `rippleStrength = max(rippleStrength, 0.25 + speed*0.9)`
        ⇒ 哪怕站着不动，每帧也把强度**抬回 0.25**，`RIPPLE_FADE_SEC` 那条
        「停下 1.5 s 内收干净」的分支永远进不去（实测：走 3 m/s 后原地站 3 s，
        `__water().strength` 仍是 1.0）。后果是水面上一圈**永不消失的同心环**，
        而她其实站着不动 —— 这正是「碰撞很差」最直观的一条。

        现在的口径：**强度只由「本帧真实速度」驱动**，停下就按 `RIPPLE_FADE_SEC`
        衰减到 0；在水里站着时保留一点点「余波」（`STAND_RESIDUAL`），
        因为脚是踩在水里的，水面本来就该有极轻微的扰动，但**不是** 0.25 那一圈亮环。 */
    const moving = Math.abs(speed) > 0.05;
    if (wet && moving) {
        // 走得越快荡得越明显
        const target = clamp01(0.25 + speed * 0.9);
        rippleStrength = Math.min(1, Math.max(rippleStrength, target));
    } else {
        const floor = wet ? STAND_RESIDUAL : 0;
        rippleStrength = Math.max(floor, rippleStrength - d / RIPPLE_FADE_SEC);
    }
    lastInWater = wet;
    uWaterPlayer.value.set(x, z, speed, rippleStrength);

    /* 速度方向：一阶差分（`x,z` 已经是本帧的真实脚点）。用来把尾迹/泡沫朝运动方向拖长。 */
    const vx = (x - lastX) / d;
    const vz = (z - lastZ) / d;
    lastX = x;
    lastZ = z;
    const vlen = Math.hypot(vx, vz);
    if (vlen > 0.02 && vlen < 40) {
        /* 一阶低通，避免单帧抖动把方向打翻（`?watervel=` 可调滞后强度）。 */
        const k = 1 - Math.exp(-WATER_VEL_SMOOTH * d);
        uWaterVel.value.x += (vx - uWaterVel.value.x) * k;
        uWaterVel.value.y += (vz - uWaterVel.value.y) * k;
    } else {
        const k = 1 - Math.exp(-WATER_VEL_SMOOTH * 2.2 * d);
        uWaterVel.value.x -= uWaterVel.value.x * k;
        uWaterVel.value.y -= uWaterVel.value.y * k;
    }

    /* 接触状态：脚点水深。`depthWrite=false` 的水面本身没有任何接触线索，
       材质靠这一项在脚踝画一圈白沫（`?wcontact=` 可关掉做 A/B）。 */
    const depth = wet ? pondDepthAt(x, z) : 0;
    uWaterContact.value.set(x, z, wet ? 1 : 0, depth);
}

/** 推进世界时间（`CraterWater` 的 `useFrame` 每帧调一次）。 */
export function tickWaterTime(t: number): void {
    uWaterTime.value = t;
}

/**
 * 探针：无头脚本 `--eval` 读它验「涟漪存在且跟随」。
 * 半径/强度与材质里用的是**同一个公式**，所以读数能直接对上画面。
 */
export function getRipples(): {
    on: boolean;
    mode: string;
    inWater: boolean;
    center: [number, number];
    playerSpeed: number;
    strength: number;
    vel: [number, number];
    contact: number;
    contactDepth: number;
    rings: { i: number; radius: number; strength: number }[];
} {
    const p = uWaterPlayer.value;
    const t = uWaterTime.value;
    const rings: { i: number; radius: number; strength: number }[] = [];
    for (let i = 0; i < RIPPLE_COUNT; i++) {
        const ph = ((t * RIPPLE_SPEED + i / RIPPLE_COUNT) % 1 + 1) % 1;
        rings.push({
            i,
            radius: +(ph * RIPPLE_MAX_R).toFixed(3),
            strength: +(p.w * (1 - ph)).toFixed(3),
        });
    }
    const c = uWaterContact.value;
    const v = uWaterVel.value;
    return {
        on: WATER_ON,
        mode: SURFACE_MODE,
        inWater: lastInWater,
        center: [+p.x.toFixed(2), +p.y.toFixed(2)],
        playerSpeed: +p.z.toFixed(3),
        strength: +p.w.toFixed(3),
        vel: [+v.x.toFixed(3), +v.y.toFixed(3)],
        contact: c.z,
        contactDepth: +c.w.toFixed(3),
        rings,
    };
}

/* 无头截图 / 验收用的探针（不参与渲染）。 */
if (typeof window !== 'undefined') {
    const w = window as unknown as Record<string, unknown>;
    w.__water = () => getRipples();
    /** ★ 单元测试入口：直接调 `useFrame` 用的那个 `setPlayerWaterState`（同一函数引用），
     *  因为无头里 WASD 走不动（`keydown` 到不了物理层），只能这样喂速度验「强度随速度上升」。
     *  用法：`__waterTest.set(-18,-193,3.2,0.016)` ⇒ `__water().strength` 从 0.25 升到 1。 */
    w.__waterTest = {
        set: setPlayerWaterState,
        y: waterYAt,
        mask: pondMaskAt,
        depth: pondDepthAt,
        pace: waterPaceAt,
        sink: waterSinkAt,
        inPond,
    };
    /** ★ 诊断：水面高度的来源与口径（排查「水面高度走了 fallback」用）。 */
    w.__waterDiag = {
        source: Number(QNUM('waterY', 0)!) > 0 ? 'url' : 'computed',
        mode: SURFACE_MODE,
        waterY: pondWaterY(),
        rIn: POND_R_IN,
        rOut: POND_R_OUT,
    };
}

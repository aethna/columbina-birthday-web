/**
 * 会场环形布局的**共享真值**（用户 m11046 任务3：「人物走到树木模型，目前是直接穿过去的。
 * 要加入碰撞了。不能穿模。」）
 *
 * 为什么单独开一个文件：
 *   树的位置本来是 `VenuePropsReal.tsx` 里的**局部**函数（`hash01` / `ringAt`）算出来的。
 *   角色要撞到树，就必须**在完全相同的坐标系里复算出同一个圆**。
 *   如果两边各写一份公式，改了一个忘了另一个 ⇒ 碰撞圆和可见的树错位，
 *   现象比没有碰撞还糟（撞空气 / 从树里穿过去）。所以位置公式只留一份，两边都 import。
 *
 * ⚠️ `hash01` 不能用 `fract(sin(i*12.9898)*43758.5453)`（判据 N：大索引上会退化），
 *    这里用整数混合（PCG 风格），保证「同一棵树每次都在同一个地方」。
 */
import { QNUM } from './utils/query';

/** 位置 → 确定性伪随机 [0,1)。与 `VenuePropsReal.tsx` 原实现逐位一致。 */
export function hash01(a: number, b: number, salt = 0): number {
    let h = (Math.imul(Math.round((a + 1000) * 64) | 0, 0x27d4eb2d)
        ^ Math.imul(Math.round((b + 1000) * 64) | 0, 0x165667b1)
        ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface RingCfg {
    /** 树环半径（米） */
    r: number;
    /** 树的数量 */
    n: number;
    /** 角度抖动系数 */
    aj: number;
    /** 半径抖动（米） */
    rj: number;
    /** 石头数量 */
    rock: number;
    /** 灌木数量 */
    bush: number;
}

export function ringCfg(): RingCfg {
    return {
        r: QNUM('ring', 29)!,
        n: Math.max(0, Math.round(QNUM('ringn', 26)!)),
        aj: QNUM('ringaj', 0.34)!,
        rj: QNUM('ringrj', 3.2)!,
        // ★ 缺省 0（用户 m11917 任务3：「场景内有旧的石头模型没删干净」）。
        //   用户 m08676 任务2 要的是「中间是空地、周围树围一圈」，这批 `rock_a~d`
        //   是上一版照抄老线 `wujien-layout.json` 摆位表留下的环形石头（18 块 @ 半径 25 m），
        //   属于该删没删的旧道具。用 `?ringrock=18` 可以随时还原。
        rock: Math.max(0, Math.round(QNUM('ringrock', 0)!)),
        bush: Math.max(0, Math.round(QNUM('ringbush', 9)!)),
    };
}

/** 环上第 i 件道具的 (x, z)。与 `VenuePropsReal.tsx` 的 `ringAt` 逐位一致。 */
export function ringAt(i: number, n: number, r0: number, salt: number, cfg?: RingCfg): [number, number] {
    const c = cfg ?? ringCfg();
    const slot = (Math.PI * 2) / n;
    const a = i * slot + (hash01(i, salt, 21) - 0.5) * slot * c.aj * 2;
    const r = r0 + (hash01(i, salt, 22) - 0.5) * 2 * c.rj;
    return [Math.sin(a) * r, Math.cos(a) * r];
}

/** 树的两种素材（与 `VenuePropsReal.tsx` 的 `ASSETS`/`POOL` 对应）。
 *  `frac` = **根部最大水平半径 ÷ 模型自身高度**，由 `_tools\tree-radius.py`
 *  直接读 GLB 的 POSITION 顶点量出来（两个模型都是「高度归一化到 0~1」的，
 *  渲染时再乘 `h`，所以 `r = h × frac` 与可见树干逐棵对齐）。
 *
 *  ⚠️ 两个素材的树干粗细差 **2.8 倍**：`tree_a` 0.130 / `tree_b` 0.363。
 *  用一个统一的系数会让细树「撞空气」、粗树「插进树皮」——
 *  实测时正是这个原因导致「碰撞开着她也像是站在树干里面」。
 */
const TREE_POOL = [
    { h: 5.4, jitter: 0.30, frac: 0.1302 },   // tree_a：底部 0~10% 高度恒为 0.1302
    { h: 4.6, jitter: 0.30, frac: 0.3627 },   // tree_b：底部 0~20% 高度恒为 0.3627
] as const;

/** `?treefrac=` 可整体覆盖（调试用；<0 表示用每棵素材自己的实测值）。 */
const TRUNK_FRAC_OVERRIDE = QNUM('treefrac', -1)!;

export interface CircleCollider {
    /** 世界 x（`group` 局部坐标；会场没有整体平移，故等于世界坐标） */
    x: number;
    /** 世界 z */
    z: number;
    /** 碰撞半径（米） */
    r: number;
    /** 树干高度（米）= 树高 × 1.02（与 `place()` 的 `holder.scale` 一致） */
    h: number;
    /** 调试用名字 */
    name: string;
    /** 用了哪个素材（tree_a / tree_b） */
    asset: string;
}

/** 复算全部 26 棵树的树干位置与半径 —— 与可见的树**逐棵**对齐。 */
export function treeColliders(extra = 0): CircleCollider[] {
    const cfg = ringCfg();
    const out: CircleCollider[] = [];
    for (let i = 0; i < cfg.n; i++) {
        const [x, z] = ringAt(i, cfg.n, cfg.r, 3, cfg);
        const idx = Math.floor(hash01(x, z, 1) * TREE_POOL.length) % TREE_POOL.length;
        const def = TREE_POOL[idx];
        const h = def.h * (1 + (hash01(x, z, 2) - 0.5) * def.jitter);
        const frac = TRUNK_FRAC_OVERRIDE >= 0 ? TRUNK_FRAC_OVERRIDE : def.frac;
        const r = h * frac;
        out.push({ x, z, r: r + extra, h: h * 1.02, name: `tree${i}`, asset: idx === 0 ? 'tree_a' : 'tree_b' });
    }
    return out;
}

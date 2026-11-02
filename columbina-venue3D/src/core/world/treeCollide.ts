/**
 * treeCollide —— **森林**（`Forest.tsx` 的 57 个 InstancedMesh）的树干碰撞体注册表。
 *
 * ── 为什么需要这个文件（用户 2026-10-23 反馈 3）────────────────────────
 *  「森林的树干加一下体积，现在人物直接穿过去。」
 *
 *  会场那 26 棵树**早就有**碰撞：`core/venueRing.ts:98 treeColliders()`，
 *  按 `TREE_POOL.frac`（由 `_tools/tree-radius.py` 直读 GLB 顶点量出）算半径，
 *  消费方 `MmdCharacter.tsx:981 TREE_COLS`。但那是**会场环**的静态树 ——
 *  森林是 `Forest.tsx` 用 `collectForest()` 每 32 m 现算的实例，
 *  位置/缩放/高度每次都不同，`venueRing` 里根本不知道它们的存在
 *  ⇒ 走进去直接穿模。
 *
 * ── 设计（为什么是一张全局表，而不是让 Forest 直接调角色）──────────────
 *  森林按**相机**铺（`gridSnapping`），角色在森林里走动时相机几乎不动
 *  ⇒ `refill()` 的调用频率是「换格级」（32 m 一次），不是每帧。
 *  所以让 `Forest.refill()` 在收集实例的**同一个回调**里顺手把碰撞体写进这张表，
 *  `MmdCharacter` 每帧只读 —— 没有跨组件的调用方向问题，也不用把实例矩阵
 *  反解成世界坐标（那要读 GPU 侧 buffer，得不偿失）。
 *
 * ── 半径从哪来（别用「目测树干粗细」）──────────────────────────────────
 *  森林 GLB 全部归一化成「高度 = 1、底面 y = 0」（`forestProc.ts:119` 同一约定），
 *  渲染时 `_s.set(h * sxz, h, h * sxz)` ⇒ **世界树干半径 = frac × h × sxz**。
 *  `frac` 是「根部体段最大水平半径 ÷ 模型自身高度」，用 python 直读 GLB 的
 *  POSITION 顶点量出来的（见下表注释）。
 *  ⚠️ 必须乘 `node.scale` 再量，否则量到的是未缩放顶点。
 *  ⚠️ 只量到「底部若干比例的体段」：本文件取 0~15% 高度，
 *     因为再往上就进冠层了（`ph_umbrella` 在 30% 处半径翻 2.3 倍，
 *     `ph_bushy` 在 20% 处翻 1.8 倍 —— 用 30% 会得到一圈「隐形墙」）。
 */

export interface TrunkCollider {
    /** 世界 x */
    x: number;
    /** 世界 z */
    z: number;
    /** 碰撞半径（米） */
    r: number;
}

/** 每米树高对应的树干半径（`frac`，无量纲）—— python 直读 GLB POSITION，
 *  取 0~15% 高度体段的最大水平半径 ÷ 模型高度。
 *
 *  | 素材 | GLB | frac | 对应树高 h | 世界半径 r = frac·h（sxz = 1）|
 *  |---|---|---|---|---|
 *  | f_oak      | p_oak.glb        | 0.0265 | 12.0 m | 0.32 m |
 *  | f_tall     | p_tall.glb       | 0.0197 | 16.0 m | 0.32 m |
 *  | f_umbrella | ph_umbrella.glb  | 0.1106 | 11.0 m | 1.22 m |
 *  | f_blob     | ph_blob.glb      | 0.1914 |  5.4 m | 1.03 m |
 *
 *  ⚠️ 2026-10-24（12 轮任务1）删掉 `f_pine`(0.0575) / `f_spire`(0.0488)：
 *    这两款针叶树已从 `FOREST_ASSETS` 与 `LAYERS[0].pool` 里整体摘除（用户点名不要），
 *    留着这两条碰撞就是「空气里有一根看不见的柱子」。
 *
 *  ⚠️ 故意**不收录**的三种：
 *   · `f_weeping`（frac 0.6070）—— 量到的是**垂枝冠层**不是树干，收进去会变成一堵墙；
 *   · `f_bushy`（frac 0.3077）—— 灌木，游戏里从灌木中间穿过去是正常表现；
 *   · 草 / 花 / 石头 / 蘑菇 / 石板 —— 都不该挡人。
 */
const TRUNK_FRAC: Record<string, number> = {
    f_oak: 0.0265,
    f_tall: 0.0197,
    f_umbrella: 0.1106,
    f_blob: 0.1914,
};

/** 半径上限（米）。`ph_umbrella` / `ph_blob` 的根部本来就粗，
 *  但它们乘上 `sxz`（0.78~1.28）与 `h` 的抖动后偶尔会超过 1.3 m，
 *  读起来像「树干周围有一圈看不见的垫子」⇒ 钳到 1.05 m。 */
const R_MAX = 1.05;

let _list: TrunkCollider[] = [];

/** 清空（`refill()` 开头调；森林按相机铺，每次重建就是一份完整的新表）。 */
export function resetTreeColliders(): void {
    _list = [];
}

/** 发布一件。`key` 不在 `TRUNK_FRAC` 里就直接忽略（草/花/石头/蘑菇/石板）。
 *  @param h    实例高度（米，`ForestProp.h`）
 *  @param sxz  实例的 XZ 缩放（`ForestProp.sxz`）
 */
export function addTreeCollider(key: string, x: number, z: number, h: number, sxz: number): void {
    const frac = TRUNK_FRAC[key];
    if (!frac) return;
    const r = Math.min(R_MAX, frac * h * sxz);
    if (r <= 0) return;
    _list.push({ x, z, r });
}

/** 只读视图（碰撞循环用；不要存引用，`refill()` 会整张换掉）。 */
export function treeColliderList(): readonly TrunkCollider[] {
    return _list;
}

/** 当前表里有几件 —— 给 `MmdCharacter` 的 gate 判据用（见 `:3256` 那条注释：
 *  门槛写 `TREE_COLS.length > 0` 会让「只在月球有碰撞体」的情况整段静默跳过）。 */
export function treeColliderCount(): number {
    return _list.length;
}

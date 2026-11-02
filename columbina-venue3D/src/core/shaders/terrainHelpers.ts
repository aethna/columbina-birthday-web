import {
  Fn,
  vec2,
  vec3,
  float,
  normalize,
  cross,
  length,
  max,
  abs,
  select,
  dot,
  cos,
  sin,
  mx_fractal_noise_float,
} from "three/tsl";
import { QNUM } from "../utils/query";

/**
 * Returns function that calculates terrain height
 * @param terrainAmp - Terrain amplitude uniform
 * @param terrainFreq - Terrain frequency uniform
 * @param terrainSeed - Terrain seed uniform
 */
export function getTerrainHeight(
  terrainAmp: any,
  terrainFreq: any,
  terrainSeed: any
) {
  return Fn(([xz]: [any]) => {
    const samplePos = xz.add(vec2(0.001)); // Offset to avoid origin artifacts
    const noiseValue = mx_fractal_noise_float(
      samplePos.mul(terrainFreq).add(vec2(terrainSeed, float(0.0)))
    );
    return noiseValue.mul(terrainAmp);
  });
}

/* ════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-20 task-9：法线差分步长**必须与世界坐标解耦**（用户：
 *    「月球坑最顶端的坑壁，只要视角移动就会像波浪一样翻滚。」）★★
 *
 * 原来的写法是 `epsilon = max(0.1, max(|x|,|z|) * 0.01)` —— 「离原点越远，
 * 取样越粗」。看起来像是「远处省精度」的优化，实际是个**混叠陷阱**：
 *
 *   · 主坑在 `CRATERS[0] = (0, -196)`（`core/worldRegions.ts`，r=24 / d=3.9），
 *     离原点的距离 |z| ≈ 196 ⇒ epsilon ≈ **1.96 m** 的差分步长。
 *   · 坑缘的锯齿（rim jag）是 `RIM_JAG_AMP = 0.30 m`、径向波长约 **5.4–7.2 m**
 *     的隆起（`worldHeight.ts:233-243`）。
 *   · 用 2 m 的尺子去量 5 m 的波纹 ⇒ 梯度基本是**随取样点随机翻转**的。
 *   · 地形网格跟着相机**跳格**（`useGridSnapping`，步长 0.15625 m），
 *     所以「相机一动 ⇒ 顶点落到的世界坐标一变 ⇒ 法线方向大跳」——
 *     这就是用户看到的「波浪一样翻滚」。几何本身没动，动的是法线。
 *
 * 现在改成**固定步长**（缺省 0.625 m = 顶点格边长，见 `Terrain.tsx` 的
 * `segments = round(grassAreaSize / 0.625)`）：
 *   · 0.625 ≫ 跳格 0.15625 m，且与三角面尺度一致 ⇒ 估出来的法线就是**这个面**
 *     真正的朝向，不再随取样点乱跳；
 *   · 0.625 ≪ 坑缘波长 5.4 m ⇒ 坑缘的细节一点没少（**坑形本身完全不改**，
 *     这条只影响法线怎么估，不改 `getTerrainHeight` 的任何一个字）。
 *   · 顶点阶段的代价不变：还是 3 次高度求值，没有更贵的中心差分。
 *
 * ⚠️ 实测（`_logs/render_t9_norm.jsonl` 第一枪的探针，300 个坑缘采样点，
 *    每次把取样点沿 x/z 挪一个跳格 0.15625 m，看世界法线偏转多少度）：
 *      · 旧行为 `ε = max(0.1, max(|x|,|z|)*0.01)`（坑缘处 ε≈2.22 m）：
 *        **mean 2.69° / max 13.58°**
 *      · ε = 0.35 m：mean 7.40° / **max 48.18°**（反而更抖 —— 0.35 m 的尺子量到了
 *        网格 0.625 m 表达不出来的高频起伏，法线和真实三角面对不上）
 *      ⇒ 所以步长不是「越小越好」，**要跟网格对齐**；而真正把抖动归零的是
 *        `Terrain.tsx` 里把跳格量化到格边（顶点世界坐标从此固定）。
 *        这条 epsilon 修的是「法线估得对不对」，几何侧那条修的是「采样点会不会变」，
 *        两条必须一起在。`?neps=0` 回到旧公式，`?tsnap=0` 回到旧跳格，都可 A/B。
 * ⚠️ 这个函数不只给地形用：`grass/core/grassCompute.ts:227`（草叶朝向）
 *    与 `Rose/core/vatMaterial.ts:96`（玫瑰）也在调它 ⇒ 改步长会一起受益
 *    （以前草在 40 m 外法线同样是乱的）。 */
const NORMAL_EPS = QNUM('neps', 0.625)!;

/**
 * Returns function that calculates terrain normal
 * @param getTerrainHeight - Function returned from getTerrainHeight
 */
export function getTerrainNormal(getTerrainHeight: any) {
  return Fn(([xz]: [any]) => {
    const baseEpsilon = float(0.1);
    const minDist = max(abs(xz.x), abs(xz.y));
    const epsilon = NORMAL_EPS > 0
      ? float(NORMAL_EPS)
      : max(baseEpsilon, minDist.mul(0.01));

    const h = getTerrainHeight(xz);
    const hx = getTerrainHeight(xz.add(vec2(epsilon, float(0.0))));
    const hz = getTerrainHeight(xz.add(vec2(float(0.0), epsilon)));

    // Standard Finite Difference method for Y-up
    const p1 = vec3(epsilon, hx.sub(h), float(0.0));
    const p2 = vec3(float(0.0), hz.sub(h), epsilon);

    // Cross product order for Y-up
    const normal = cross(p2, p1);
    const len = length(normal);

    // Handle edge case where normal is zero (flat surface)
    const threshold = float(0.0001);
    const defaultNormal = vec3(float(0.0), float(1.0), float(0.0));
    return select(
      len.greaterThan(threshold),
      normalize(normal),
      defaultNormal
    );
  });
}

/**
 * Rotates a vector around an axis by a given angle
 * @param v - Vector to rotate
 * @param axis - Rotation axis
 * @param angle - Rotation angle in radians
 */
export const rotateAxis = Fn(([v, axis, angle]: [any, any, any]) => {
  const axisNorm = normalize(axis);
  const proj = axisNorm.mul(dot(axisNorm, v));
  return proj
    .add(v.sub(proj).mul(cos(angle)))
    .add(cross(axisNorm, v).mul(sin(angle)));
});

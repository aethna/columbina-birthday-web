/**
 * visRadius.ts —— 「世界可见半径」的**唯一真值**（task-15 / 用户 10-20 反馈3+4）。
 *
 * ── 用户原话与裁定 ──────────────────────────────────────────────────
 * 反馈3：他在截图里画了一条红线 ＝ **草地刷新边缘**（草盘 `GRASS_EDGE_FADE_IN 30 /
 *   `GRASS_EDGE_FADE_OUT 40`，见 `grass/core/grassMaterial.ts:87-88`），并要求
 *   「红线之外不该有任何渲染」。当时的现象：40~52 m 还在画树、
 *   196 m 外 `CRATERS[0]` 那艘飞船还被提交绘制。
 * 反馈4：他走出会场很远之后，「森林不见了，而会场在草地外也渲染了」
 *   —— 各子系统各用一套半径（森林 52/100、`RegionProps` 140、会场道具 120、
 *      月船无上限），所以谁先没、谁还在，完全不统一。
 *
 * ⇒ **裁定（Lead m01009，照此实现）**：世界可见半径 = 草盘边缘 `R_VIS = 40 m`，
 *   **以相机位置为圆心**，对所有「会自己冒出来的东西」统一生效：
 *   树 / 月船 / 会场建筑与道具 / 区域道具 / 花丛。
 *
 * ⚠️ **草盘本身不在这里定义** —— `R_VIS` 只是「跟它对齐」的消费方。
 *    真值仍然是 `grass/core/config.ts` 的 `DEFAULT_GRASS_AREA_SIZE / 2 = 40`，
 *    改动那边时请同步 `R_VIS_BASE`（本文件头部注释是唯一的交叉引用点）。
 *
 * ── 为什么是「相机距离」而不是「离世界原点」──────────────────────────
 * 因为草盘自己就是跟着相机走的（`grass/core/gridSnapping.ts` 按相机跳格），
 * 用户看到的那条红线永远是「以我为中心 40 m 的一个圆」。所以剔除判据必须用相机距离，
 * 否则玩家一走动就会出现「草还在、树没了」或者反过来的口径分裂。
 *
 * ── URL 开关（A/B 用）────────────────────────────────────────────────
 *   `?visr=<m>`  改半径（例：`?visr=15` 极限收紧，用来肉眼检查谁没吃到这条判据）
 *   `?visr=0`    **关掉整条判据**，各子系统回到 task-15 之前的口径
 *                （森林 `CULL_R` 回到 52 m、`RegionProps` 回到 140 m、船不剔除）
 *   另外 `?fog=0` 单独保留，用来区分「雾盖掉了」和「真的没画」。
 */
import { useFrame, useThree } from '@react-three/fiber';
import type * as THREE from 'three/webgpu';
import { QNUM } from '../utils/query';

/** 缺省可见半径（米）＝ 草盘边缘。见文件头「草盘本身不在这里定义」。 */
export const R_VIS_BASE = 40;

/** `?visr=` 原值；`null` = 没给参数。 */
const VISR_OVR = QNUM('visr');

/**
 * 实际生效的可见半径（米）。
 *   · 没给参数 / `?visr=1` → 40（缺省）
 *   · `?visr=<m>`（> 0）   → `<m>`
 *   · `?visr=0`            → `Infinity`（= 判据关闭，`outsideVis()` 恒 false）
 */
export const R_VIS: number = VISR_OVR === null || VISR_OVR === 1
    ? R_VIS_BASE
    : (VISR_OVR > 0 ? VISR_OVR : Infinity);

/** 判据是否生效（`?visr=0` 时 false）。各子系统据此决定「要不要退回旧口径」。 */
export const VISR_ON = Number.isFinite(R_VIS);

/**
 * 世界点 `(x, z)` 是否落在相机 `(camX, camZ)` 的可见圆**之外**。
 * `?visr=0`（`R_VIS = Infinity`）时恒返回 false ⇒ 等于没有这条判据。
 */
export function outsideVis(
    x: number, z: number, camX: number, camZ: number, r: number = R_VIS,
): boolean {
    if (!Number.isFinite(r)) return false;
    const dx = x - camX, dz = z - camZ;
    return dx * dx + dz * dz > r * r;
}

/**
 * 给整棵子树挂「超距即不提交绘制」的开关（WorldController 挂载层用）。
 *
 * 为什么不写在各个组件内部：这些组件（尤其船）已经各自有 `visible` 语义
 * （`?wapi=0` / `?ship=1` / 阶段门控），在挂载层加一层**只会额外隐藏、不会反向打开**，
 * 既不动它们内部逻辑，也不会和 `GameLayer` 的阶段开关打架。
 *
 * ⚠️ 只改 `visible`，**不 unmount** —— 卸载 `WingShipApi` 里的 26.9 MB GLB 会触发
 *    重新解析，来回走过 40 m 边界就卡顿；`visible=false` 只是让渲染器跳过它，
 *    几何与贴图留在显存里（这也是本文件存在的意义：省的是 draw call 与三角形，
 *    不是显存）。
 */
export function useVisGate(
    ref: React.RefObject<THREE.Object3D | null>,
    x: number, z: number,
    enabled = true,
): void {
    const camera = useThree((s) => s.camera);
    useFrame(() => {
        const o = ref.current;
        if (!o) return;
        o.visible = enabled && !outsideVis(x, z, camera.position.x, camera.position.z);
    });
}

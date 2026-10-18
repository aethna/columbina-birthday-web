/**
 * 小地图共享状态 —— Canvas 内 ↔ DOM 外的桥。
 *
 * 为什么不用 zustand：这里**每帧都写**，进 store 就会触发 React 每秒重渲染 60 次，
 * 而小地图实际只需要 30 fps。所以走一个纯模块对象，DOM 侧用 rAF 自己读自己画。
 *
 * 为什么不全在 DOM 侧算：玩家的世界坐标只有 Canvas 里拿得到
 * （`gameStore.characterRef` + R3F 的 `useThree().camera`）。
 */
export interface MiniMapState {
    /** 玩家世界坐标（米）。拿不到角色时回落到相机位置 */
    x: number;
    z: number;
    /** 相机朝向：0 = 正北（世界 -Z），+π/2 = 正东（世界 +X） */
    yaw: number;
    /** 当前时刻（0~24，由 `core/sky/sunCycle.ts` 的 SkyClock 驱动） */
    hour: number;
    /** 1 = 白天，0 = 夜里 */
    dayness: number;
    /** 玩家所在的区域 id（删海后只剩会场与月球；其余地方 `dominantRegion` 返回 `venue`） */
    region: 'venue' | 'moon';
    /** 第一帧之前不要画，免得闪一下原点 */
    ready: boolean;
}

export const minimapState: MiniMapState = {
    x: 0,
    z: 0,
    yaw: 0,
    hour: 23,
    dayness: 0,
    region: 'venue',
    ready: false,
};

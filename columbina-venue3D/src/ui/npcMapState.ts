/**
 * 大地图上的 NPC 位置（模块级容器，第五十六轮 / 用户 m01561）。
 *
 * 为什么单独开一份，而不是放 `minimapState`：
 * · `GameLayer` 是**唯一**知道「现在场上有谁、站在哪」的地方 —— 它的 `standSpots()` /
 *   `seatSpots2()` 同时也是互动点坐标的来源，两边共用同一个数组才不可能脱钩；
 * · `WorldMap` 是纯 UI，拿不到 3D 侧的落点表。
 * 所以由 `GameLayer` 在阶段变化时写一份进来，`WorldMap` 订阅着读。
 *
 * 为什么不并进 `minimapState`：那个对象**每帧**被写（玩家 x/z/yaw），混进来会让
 * 「NPC 换了一批」和「玩家挪了一步」变成同一种事件，订阅侧分不清该不该重建 DOM。
 *
 * 用户原话：「显示所有NPC位置（当NPC入场以后）」—— 阶段没到之前场上根本没人，
 * 所以 `letter` 阶段写空表，地图上就不画点。
 */

export interface NpcMark {
    id: string;
    name: string;
    /** 世界坐标（米，未做环面折回）。 */
    x: number;
    z: number;
}

/** `stand` = 委托阶段环带站位；`seat` = 宴会座次；`none` = 场上没人。 */
export type NpcMarkLayout = 'none' | 'stand' | 'seat';

let _layout: NpcMarkLayout = 'none';
let _list: NpcMark[] = [];
let _version = 0;
const _subs = new Set<() => void>();

/**
 * 写一批新的落点。
 *
 * 幂等：内容一模一样就直接返回。`GameLayer` 里那个 effect 会被 React 反复调用
 * （任何一次祖先重渲染都可能跑），不判等会让订阅侧每次重渲染都重建 15 个 DOM 节点。
 */
export function setNpcMarks(layout: NpcMarkLayout, list: NpcMark[]): void {
    const same = _layout === layout && _list.length === list.length
        && _list.every((m, i) => m.id === list[i].id && m.x === list[i].x && m.z === list[i].z);
    if (same) return;
    _layout = layout;
    _list = list.slice();
    _version++;
    for (const f of _subs) f();
}

/** `useSyncExternalStore` 的快照函数 —— **必须**返回稳定引用，否则会无限重渲染。 */
export function getNpcMarks(): NpcMark[] {
    return _list;
}

export function npcMarkLayout(): NpcMarkLayout {
    return _layout;
}

export function npcMarkVersion(): number {
    return _version;
}

export function subscribeNpcMarks(cb: () => void): () => void {
    _subs.add(cb);
    return () => { _subs.delete(cb); };
}

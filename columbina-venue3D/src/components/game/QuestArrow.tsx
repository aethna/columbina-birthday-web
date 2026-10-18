/**
 * QuestArrow —— 世界里那支「指到目标头上」的 3D 箭头（★ 2026-10-18 用户 m00863 任务3）。
 *
 * ── 为什么是真 3D 物体而不是屏幕 overlay ──────────────────────────────
 * 用户原话要的是「屏幕里应该有箭头提示 NPC/委托点位」，指的是**世界中的目标点**：
 * 玩家要能转头看见它在哪、走过去它还在那个位置。贴屏幕的 2D 箭头只能表达「往左往右」，
 * 一旦目标被树/人挡住就彻底失真，而且玩家绕圈时箭头不会跟着目标转 —— 那正是
 * 老版「指引说按 F、人却在十米外」那类 bug 的观感来源。
 *
 * ── 每帧读 store，但**不订阅** ────────────────────────────────────────
 * `useGameStore2.getState()` 在 useFrame 里读，不建立订阅：箭头只关心
 * 「选中了谁 / 接没接 / 采够没 / 交没交」，这些都随玩家操作低频变化，
 * 用 hook 订阅会让整个 UI 为一次按键重渲染。这里宁愿每帧多读几次对象字段。
 *
 * ── 为什么每帧只写数字、不算坐标 ──────────────────────────────────────
 * 项目为此专门返工过一轮：useFrame 里 `new THREE.Vector3()` / `pointXZ1()` /
 * `worldHeightCPU()` 都会**每帧新建数组/对象**，60 fps 下就是持续喂 GC。
 * 所以：
 *   ① 目标坐标在挂载时算一次，拍平成数字存进表（`buildTargets`）；
 *   ② 地面高度**懒算 + 缓存**（见 `heightOf`）—— 不能挂载时算，因为
 *      `WorldController` 会在 effect 里把地形振幅 uniform 从 1.5 改成 0.55，
 *      早算一步会把高度放大 2.7 倍，箭头直接浮到半空；
 *   ③ 帧内只剩 `Math.sin` 与 `position.set`（改已有 Vector3 的分量，不新建）。
 *
 * ── 目标解析规则（任务3 的判定，集中在这一处）────────────────────────
 *   · 委托还没接            → 指**发委托的 NPC**（玩家得先去找他说话）
 *   · 已接 + kind==='talk'  → 指 `targetNpc`（q1 是「去和林尼说话」，不是找阿蕾奇诺）
 *   · 已接 + 采集/到访，且 `collected < count` → 指**采集点位**
 *   · 已接 + 采够、待交付   → 指**发委托的 NPC**（该回去交差了）
 *   · 已交付                → **不显示**（这条委托已经没有下一步可指；用户允许不显示，
 *                              这里选隐藏而不是指回 NPC，避免玩家以为还能再交一次）
 *
 * ── 点位多实例怎么办 ──────────────────────────────────────────────────
 * `rose ×3 / lantern ×3 / litter ×5 / mushroom ×2` 是多实例摆放，而箭头只能指一处。
 * 取 `layout.pointXZ1()`（= `POINT_SPOTS[id]` 的第一处）。理由：第一处就是
 * `CollectProps` 建实例的数组顺序里的第 0 个，玩家照着走过去必然能交互；
 * 指中心点反而可能落在某个实例之间的空地上，白跑一趟。
 *
 * ── NPC 坐标为什么走 `npcStandSpots()` ────────────────────────────────
 * `layout.NPC_SPOTS` 是**死代码**（全 src 无调用），真正的落点由 `NpcCrowd`
 * 的黄金角散点决定；`GameLayer` 注册 F 键互动点用的也是这份表。这里用同一个函数，
 * 箭头才和模型、互动点三者重合（踩过的坑见 `NpcCrowd.tsx` 346-351 行的说明）。
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';

import { QUESTS } from '../../core/game/copy';
import { pointXZ1 } from '../../core/game/layout';
import { useGameStore2 } from '../../core/game/questStore';
import { worldHeightCPU } from '../../core/worldRegions';
import { NPC_ROSTER, npcStandSpots } from '../npc/NpcCrowd';
import { questArrowState } from '../../ui/guideState';

/** 金色强调色：任务列表徽章 / InteractHint「按 F」是同一支，不平白引入新颜色。 */
const ARROW_COLOR = '#e8d8a8';

/** 悬浮基准高度（相对地面，米）。NPC 要比头顶高一截才不会被头发吃掉。 */
const ARROW_Y_NPC = 2.15;
const ARROW_Y_POINT = 1.5;

/** 上下浮动：幅度 0.15 m、周期 1.2 s（用户在手感要求里给的量级）。 */
const BOB_AMP = 0.15;
const BOB_PERIOD = 1.2;

/** 箭头尺寸。圆锥尖端朝下，圆锥本体占 0~CONE_H，杆子接在上面。
 *  尺寸是「20 m 外还认得出」定的：0.22 m 半径的锥在 1080p、60° FOV 下约 20 px 宽，
 *  再小就只剩一个金点，玩家会以为那是采集点的辉光。 */
const CONE_H = 0.50;
const CONE_R = 0.22;
const SHAFT_H = 0.38;
const SHAFT_R = 0.06;

/**
 * 一条委托的两个候选落点，**拍平成数字**（帧内不再碰数组）。
 * `alt*` 给 q1 的 `targetNpc` 用；没有就与 `npc*` 相同。
 */
interface ArrowTarget {
    npcX: number;
    npcZ: number;
    altX: number;
    altZ: number;
    ptX: number;
    ptZ: number;
    hasPoint: boolean;
}

/** 按 id 索引 14 条委托。帧内用 `QUESTS.find(cb)` 会每帧新建一个闭包，所以先建表。 */
const QUEST_BY_ID: Record<string, (typeof QUESTS)[number]> = {};
for (const q of QUESTS) QUEST_BY_ID[q.id] = q;

type Spot = { x: number; z: number; yaw: number };

/** 按 `NPC_ROSTER` 顺序从站位表取某人 XZ —— 与 `GameLayer.npcPos()` 完全同源。 */
function npcXZ(id: string, spots: Spot[]): { x: number; z: number } | null {
    const i = NPC_ROSTER.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const s = spots[i];
    return s ? { x: s.x, z: s.z } : null;
}

/** 挂载时把 14 条委托的坐标一次性拍平（只调用一次，不进帧循环）。 */
function buildTargets(): Record<string, ArrowTarget> {
    /* `npcStandSpots()` 每次调用都会重跑一遍散点算法，所以整张表只取一次再索引。 */
    const spots = npcStandSpots();
    const out: Record<string, ArrowTarget> = {};
    for (const q of QUESTS) {
        const giver = npcXZ(q.npc, spots);
        const alt = q.targetNpc ? npcXZ(q.targetNpc, spots) : null;
        const pt = q.pointId ? pointXZ1(q.pointId) : null;
        const bx = giver ? giver.x : 0;
        const bz = giver ? giver.z : 0;
        out[q.id] = {
            npcX: bx,
            npcZ: bz,
            altX: alt ? alt.x : bx,
            altZ: alt ? alt.z : bz,
            ptX: pt ? pt[0] : 0,
            ptZ: pt ? pt[1] : 0,
            hasPoint: !!pt,
        };
    }
    return out;
}

export function QuestArrow({ visible }: { visible: boolean }) {
    const group = useRef<THREE.Group>(null);

    /* 几何与材质都只在挂载时建一次。
     * ⚠️ 卸载时**不要 dispose**：React 19 StrictMode 会「挂载→清理→再挂载」，
     * 提前释放会让第二次挂载拿到空的 GPU buffer（见 `DeskProps.tsx:542-545` 的返工记录）。 */
    const geo = useMemo(
        () => ({
            cone: new THREE.ConeGeometry(CONE_R, CONE_H, 12),
            shaft: new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, SHAFT_H, 8),
        }),
        [],
    );
    const mat = useMemo(
        () => ({
            /* MeshBasicMaterial：不吃光照，夜里/月球区也不会变成一团黑。
             * `toneMapped: false` 保住金色纯度，`fog: false` 让 25 m 外的箭头不被雾吃掉。 */
            core: new THREE.MeshBasicMaterial({
                color: ARROW_COLOR,
                toneMapped: false,
                fog: false,
                depthWrite: false,
            }),
            /* 外面套一层放大的加法混合锥：远处的小物体靠这圈辉光才认得出是「箭头」，
             * 只靠 0.16 m 半径的实心锥在夜间远景里几乎看不见。 */
            glow: new THREE.MeshBasicMaterial({
                color: ARROW_COLOR,
                toneMapped: false,
                fog: false,
                transparent: true,
                opacity: 0.28,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                side: THREE.DoubleSide,
            }),
        }),
        [],
    );

    const targets = useMemo(buildTargets, []);

    /* 地面高度缓存：`worldHeightCPU` 内部会建 Record（`regionWeights`），
     * 每帧调就是每帧分配。高度只跟 (x,z) 与固定的地形参数有关，按「委托:落点类型」
     * 缓存一次即可。懒算的理由见文件头（要等 WorldController 把振幅 uniform 改完）。 */
    const heights = useRef<Record<string, number>>({});
    const heightOf = (key: string, x: number, z: number): number => {
        const hit = heights.current[key];
        if (hit !== undefined) return hit;
        const h = worldHeightCPU(x, z);
        heights.current[key] = h;
        return h;
    };

    useFrame((state) => {
        const g = group.current;
        if (!g) return;

        const id = questArrowState.questId;
        if (!visible || !id) {
            g.visible = false;
            return;
        }

        const q = QUEST_BY_ID[id];
        const t = targets[id];
        if (!q || !t) {
            g.visible = false;
            return;
        }

        const st = useGameStore2.getState();
        if (st.delivered.includes(id)) {
            g.visible = false;
            return;
        }

        const accepted = st.accepted.includes(id);
        const need = q.count ?? 1;
        const got = st.collected[id] ?? 0;

        /* 规则见文件头。q1 是唯一 kind==='talk' 的，`targetNpc` 决定「找谁说话」。 */
        let toPoint = false;
        let x = t.npcX;
        let z = t.npcZ;
        if (accepted) {
            if (q.kind === 'talk') {
                x = t.altX;
                z = t.altZ;
            } else if (got < need && t.hasPoint) {
                toPoint = true;
                x = t.ptX;
                z = t.ptZ;
            }
        }

        const base = toPoint
            ? heightOf(`${id}:p`, x, z) + ARROW_Y_POINT
            : heightOf(`${id}:n`, x, z) + ARROW_Y_NPC;

        /* 上下浮动。只做浮动不做自转：圆锥 + 圆柱是绕 Y 轴旋转对称的，
         * 转起来画面上**完全看不出来**，没必要为了「有动画」白烧一次矩阵更新。 */
        const bob = Math.sin((state.clock.elapsedTime / BOB_PERIOD) * Math.PI * 2) * BOB_AMP;

        g.visible = true;
        g.position.set(x, base + bob, z);
    });

    return (
        /* group 的原点 = 箭头尖端。尖端落在目标正上方 ARROW_Y_* 处，锥体朝上长，
         * 所以看起来就是「尖头戳着目标、杆子竖在上方」。 */
        <group ref={group} visible={false}>
            {/* ConeGeometry 的尖端在 +Y、底面在 −Y；绕 X 转 π 后尖端朝 −Y，
                再上移半个高度让尖端恰好落在 group 原点（见上面注释）。 */}
            <mesh geometry={geo.cone} material={mat.core} rotation={[Math.PI, 0, 0]} position={[0, CONE_H / 2, 0]} />
            <mesh
                geometry={geo.cone}
                material={mat.glow}
                rotation={[Math.PI, 0, 0]}
                position={[0, CONE_H / 2, 0]}
                scale={1.45}
            />
            {/* 杆子接在锥底上方 */}
            <mesh geometry={geo.shaft} material={mat.core} position={[0, CONE_H + SHAFT_H / 2, 0]} />
        </group>
    );
}

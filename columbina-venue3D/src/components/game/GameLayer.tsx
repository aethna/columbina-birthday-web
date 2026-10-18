/**
 * GameLayer —— 生日会全流程的**总编排**（3D 侧唯一入口）。
 *
 * ── 这个文件为什么存在 ───────────────────────────────────────────────
 * 用户 m02541 要的是一条完整的游戏线：
 *   ① 空世界 → 去书桌写 11 封邀请函（信纸逐行显示 + 收进信封 + 月亮火漆）
 *   ② 去信箱寄出 → 14 个 NPC 站姿撒满地图，各发一个委托
 *   ③ 跑完 14 个委托（采集 13 个点位）→ 站姿 NPC 隐藏
 *   ④ 会场中央刷新坐姿 NPC + 长桌 + 蛋糕 → 哥伦比娅站主位切蛋糕
 *   ⑤ 合影 → 收进相册 → 全部完成
 *
 * 3D 道具各写各的（`DeskProps` / `CollectProps` / `NpcCrowd` / `Banquet`），
 * 但「什么时候出现、什么时候消失、按 F 时发生什么」必须**只有一个地方说了算**，
 * 否则 5 个组件各判一次阶段，迟早对不上。所以全在这里。
 *
 * ── 三层分工（改动前先读这段）───────────────────────────────────────
 *   `core/game/layout.ts`      世界坐标唯一真值（谁都不许自己算坐标）
 *   `core/game/copy.ts`        文案唯一真值（逐字照抄文案总表）
 *   `core/game/questStore.ts`  状态机（zustand，低频，驱动 React）
 *   `core/game/interact.ts`    互动注册表（每帧挑最近，F 键触发）
 *   **本文件**                 把上面四份接到 3D 场景上
 *
 * ── 为什么互动要「注册 / 注销」而不是一直挂着 ────────────────────────
 * `interact.ts` 的 `updateNearest()` 挑的是「离玩家最近且在半径内」的那个。
 * 如果任务阶段不对的可互动对象也挂在表里（只是 `enabled()` 返回 false），
 * 那还好；但如果**书桌和 NPC 同时挂着**，玩家站在两者中间时提示会来回跳。
 * 所以按阶段**真的注销**：写邀请函阶段表里只有书桌 + 信箱。
 *
 * ── 为什么 NPC 用「整群重挂」而不是原地换姿势 ────────────────────────
 * `NpcCrowd` 的站姿/坐姿是**加载期烘焙**的（`?npcpose=stand|sit` 决定扫哪个
 * 动作、要不要把腿链抹回绑定姿势）。坐姿那套绝不能走「腿链 → identity」那步
 * （见 `NpcCrowd.tsx:657`），所以换姿势只能重挂、重新烘。用户 m02762 也明确
 * 允许「刷新过程慢就加黑屏淡入淡出」，那就走黑屏 —— 顺带把 43.9 MB 的
 * PMX 重新下载（浏览器有缓存，实际是解码耗时）遮住。
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';

import { useGameStore, type CameraMode } from '../../core/store/gameStore';
import { QNUM } from '../../core/utils/query';
import {
    DESK_XZ, DESK_YAW, DESK_STAND_D, MAILBOX_XZ, MAILBOX_YAW,
    NPC_ORDER, pointXZ, CAKE_STAND_XZ, CAKE_GUIDE, DESK_GUIDE, MAILBOX_GUIDE,
    REACH, yawTo, type GuideTarget,
} from '../../core/game/layout';
import { LETTERS, NPCS, POINT_COPY, QUESTS, STAND_CHAT, FEAST_CHAT, FINAL_NOTE } from '../../core/game/copy';
import {
    useGameStore2, canDeliver, questOfNpc, type Phase,
} from '../../core/game/questStore';
import {
    registerInteractable, updateNearest, clearNearest, startInteractKey, interactState,
} from '../../core/game/interact';
import { setGuide } from '../../ui/guideState';

import { DeskProps } from './DeskProps';
import { CollectProps } from './CollectProps';
import { NpcCrowd, NPC_ROSTER, npcStandSpots, npcSeatSpots } from '../npc/NpcCrowd';
import { Banquet } from '../venue/Banquet';
import { setKeepOutProps } from '../../core/world/keepOut';
import { syncKeepOutUniforms } from '../grass/hooks/useGrassUniforms';
import { PhotoSnap } from './PhotoSnap';
import { QuestArrow } from './QuestArrow';
import { FlowerClusters } from '../flower/FlowerClusters';

/* ==================================================================
 * 0. 常量
 * ================================================================== */

/** 会场中央的空地半径（见 `layout.ts` 头注释）。中心这一圈永远不放 NPC/采集点。 */
const HUB_CLEAR = 9.5;

/** 黑屏过渡的时长（毫秒）。太短遮不住卡顿，太长玩家等得烦。 */
const FADE_MS = 1100;

/** 屏幕提示的显示时长。 */
const TOAST_MS = 2600;

/** 同理，信箱前面站的位置。 */
const MAILBOX_STAND_D = 1.15;
/** 切蛋糕时站的位置（长桌 +x 端主位，见 `layout.CAKE_STAND_XZ` 的注释）。 */
const CAKE_STAND_D = 0;
/** 采集点道具在玩家「采完」后是否隐藏。缺省隐藏 —— 采过的东西还在原地会让人以为没生效。 */
/** 采够的采集点**收起来**（否则地上还亮着一堆能看不能按的物件）。
 *  `?hidtaken=0` 可关，用来对比「收起来 vs 留着」哪个更好读。 */
const HIDE_TAKEN = QNUM('hidtaken', 1)! > 0;

/* ==================================================================
 * 1. 小工具
 * ================================================================== */

/** 把玩家瞬移到某点并转向目标。**只在「指引式」操作里用**（写邀请函 / 寄信 / 切蛋糕）。
 *  平时玩家自由走动，绝不干预。 */
function teleport(
    char: THREE.Object3D,
    x: number,
    z: number,
    lookX: number,
    lookZ: number,
): void {
    char.position.set(x, char.position.y, z);
    char.rotation.y = yawTo(x, z, lookX, lookZ);
}

/** 取某个 NPC 的中文名（`copy.ts` 是唯一真值）。 */
function npcName(id: string): string {
    const n = NPCS.find((x) => x.id === id);
    return n ? n.name : id;
}

/* ── 站位表的两个缓存 ────────────────────────────────────────────────
 * `npcStandSpots()` / `npcSeatSpots()` 每次都重跑散点算法（15 次黄金角迭代），
 * 而它们在「注册互动点」的 effect 里被逐人调用。跑一次存下来即可 ——
 * 两张表都是**纯函数**（输入固定 ⇒ 输出固定），缓存不会失效。
 *
 * ⚠️ 这两个数组同时是「模型落点」和「互动点坐标」的唯一来源：
 * 一份传给 `<NpcCrowd spots={...}>` 摆人，一份用来 `registerInteractable`。
 * 两边共用同一个引用 ⇒ 物理上不可能脱钩。 */
let _standSpots: ReturnType<typeof npcStandSpots> | null = null;
let _seatSpots: ReturnType<typeof npcSeatSpots> | null = null;
function standSpots() {
    if (!_standSpots) _standSpots = npcStandSpots();
    return _standSpots;
}
function seatSpots2() {
    if (!_seatSpots) _seatSpots = npcSeatSpots();
    return _seatSpots;
}

/** 某个 NPC 当前的 XZ（`seated=true` 取宴会座次，否则取委托阶段环带落点）。
 *  按 `NPC_ROSTER` 的顺序索引 —— 名册改了这里自动跟着改。 */
function npcPos(id: string, seated: boolean): [number, number] {
    const i = NPC_ROSTER.findIndex((d) => d.id === id);
    if (i < 0) return [0, 0];
    const t = seated ? seatSpots2() : standSpots();
    const s = t[i];
    return s ? [s.x, s.z] : [0, 0];
}

/* ==================================================================
 * 2. 组件
 * ================================================================== */

export function GameLayer() {
    const scene = useThree((s) => s.scene);
    const characterRef = useGameStore((s) => s.characterRef);

    /* ── 阶段与关键状态（**逐个订阅**，避免整 store 订阅导致每次 setState 全量重渲染）── */
    const phase = useGameStore2((s) => s.phase);
    const writingIndex = useGameStore2((s) => s.writingIndex);
    const lettersWritten = useGameStore2((s) => s.lettersWritten);
    const lettersReady = useGameStore2((s) => s.lettersReady);
    const lettersSent = useGameStore2((s) => s.lettersSent);
    const acceptedLen = useGameStore2((s) => s.accepted.length);
    const deliveredLen = useGameStore2((s) => s.delivered.length);
    /* 已采数量 —— 喂给委托进度与互动点开关。
       ⚠️ 注意键是**委托 id**，不是点位 id（见 `questStore.ts` 里 `picked` 的注释）。 */
    const collected = useGameStore2((s) => s.collected);
    /* 已被采走的**具体点位**（`pointId:index`）—— 只用于「地上收起来 / 该点关掉」。 */
    const picked = useGameStore2((s) => s.picked);
    const cakeCut = useGameStore2((s) => s.cakeCut);
    const dialogOpen = useGameStore2((s) => s.dialog !== null);
    const photoOpen = useGameStore2((s) => s.photo !== null);

    /* ── 3D 侧的「现在该显示什么」──────────────────────────────────────
     * 全部由 `phase` 推出来，**不额外存一份 state** —— 两份状态一定会不同步。 */

    /** 书桌：从第一帧就在（任务① 的目标），一直到全部结束。 */
    const showDesk = true;
    /** 信箱：写完 11 封之前不出现。用户要的是「先写信，再寄信」两步。 */
    const showMailbox = lettersReady || lettersSent;
    /** 采集点道具：委托阶段才出现（任务① 时地图上应该是空的）。 */
    const showPoints = phase === 'quest' || phase === 'feast' || phase === 'done';
    /** 站姿 NPC：**只有委托阶段**。交付完最后一个立刻隐藏。 */
    const showStandNpc = phase === 'quest';
    /** 坐姿 NPC + 长桌 + 蛋糕：委托全交付之后。 */
    const showFeast = phase === 'feast' || phase === 'done';

    /* ── 草地避让区跟着「宴会开场」走（用户 m03988）───────────────────────
     * 「那个光秃的一条（蛋糕桌子）你等任务进行到那一步的时候，再压草高度。之前正常。」
     * 委托阶段场上根本没有长桌和蛋糕台，草却提前空出了两条 —— 那条「水泥地」在
     * 宴会开始前一直都在，而玩家看得最多的正是这个阶段。
     * 这里只在**阶段切换**时改一次值（`setKeepOutProps` 内部有幂等判断），
     * 然后同步进草的 uniformArray（`UniformArrayNode.update()` 每帧重新上传，
     * 所以下一帧 compute shader 就按新槽位撒草了）。 */
    useEffect(() => {
        if (setKeepOutProps(showFeast)) syncKeepOutUniforms();
    }, [showFeast]);

    /* ── 每帧：把玩家坐标喂给互动系统 ──────────────────────────────────
     * `characterRef` 是 `MmdCharacter` 登记的哥伦比娅本体。它可能晚挂，
     * 所以每帧都取一次，拿不到就跳过（不做任何事比乱挑目标安全）。 */
    useFrame(() => {
        const c = characterRef?.current;
        if (!c) return;
        if (dialogOpen || photoOpen) {
            /* 对话/看合影时清掉目标 —— 否则「按 F 继续」和「按 F 打招呼」两条提示会同时出现。 */
            clearNearest();
            return;
        }
        updateNearest(c.position.x, c.position.z);
    });

    /* ── F 键监听（幂等，挂一次）────────────────────────────────────── */
    useEffect(() => {
        startInteractKey();
    }, []);

    /* ── 小地图指引：跟着阶段走 ─────────────────────────────────────── */
    useEffect(() => {
        let g: GuideTarget | null = null;
        if (!lettersSent) {
            /* 任务①：11 封没写完 → 指书桌；写完了 → 指信箱。 */
            g = lettersReady ? MAILBOX_GUIDE : DESK_GUIDE;
        } else if (phase === 'quest') {
            /* 任务②/③：优先指「离玩家最近的那个未完成目标」—— 这里退而求其次，
             * 指第一个还没交付的委托对应的点。玩家跑图时看任务列表就能对号。 */
            const st = useGameStore2.getState();
            const next = QUESTS.find((q) => !st.delivered.includes(q.id));
            if (next) {
                if (next.kind === 'talk' && next.targetNpc) {
                    const [x, z] = npcPos(next.targetNpc, false);
                    g = { label: npcName(next.targetNpc), x, z };
                } else if (next.pointId) {
                    const [x, z] = pointXZ(next.pointId)[0] ?? [0, 0];
                    g = { label: POINT_COPY[next.pointId]?.label ?? next.title, x, z };
                }
            }
        } else if (phase === 'feast') {
            g = CAKE_GUIDE;
        }
        setGuide(g);
        return () => setGuide(null);
    }, [phase, lettersReady, lettersSent, deliveredLen, acceptedLen]);

    /* ── 屏幕提示 + 黑屏过渡的定时清理 ─────────────────────────────── */
    useEffect(() => {
        if (!lettersSent) return;
        /* 用户原话：「屏幕显示文字提示邀请函已寄出即可」。 */
        const st = useGameStore2.getState();
        st.showToast('邀请函已寄出', '朋友们正在赶来…');
        const t = window.setTimeout(() => useGameStore2.getState().clearToast(), TOAST_MS);
        return () => window.clearTimeout(t);
    }, [lettersSent]);

    /* ── 黑屏过渡：只在「大批刷新」时用（用户 m02762 授权）─────────────
     * 两个触发点：① 站姿 NPC 出现（`quest` 开始）；② 坐姿 NPC 出现（`feast` 开始）。 */
    const fadeShown = useRef<string | null>(null);
    useEffect(() => {
        const key = phase === 'quest' ? 'q' : phase === 'feast' ? 'f' : null;
        if (!key || fadeShown.current === key) return;
        fadeShown.current = key;
        const st = useGameStore2.getState();
        st.setFade({
            title: phase === 'quest' ? '朋友们来了' : '生日宴开始',
            sub: phase === 'quest' ? '正在布置会场…' : '正在摆放长桌与蛋糕…',
        });
        const t = window.setTimeout(() => useGameStore2.getState().setFade(null), FADE_MS);
        return () => window.clearTimeout(t);
    }, [phase]);

    /* ── 切蛋糕：`cakeCut` 一置位就把合影推给 PhotoView（用户要求 F 收起）── */
    useEffect(() => {
        if (!cakeCut) return;
        const st = useGameStore2.getState();
        st.openPhoto('/venue/game/photo_feast.png', '生日宴合影');
    }, [cakeCut]);

    return (
        <>
            {/* 书桌 / 信箱（含脚下的发光标识） */}
            <DeskProps visible={showDesk} mailboxVisible={showMailbox} />

            {/* 13 个采集点的道具 + 浅水坑。
                `picked` 的键是点位实例（`pointId:index`），与 `CollectProps` 内部
                `built.insts` 的键（`POINT_SPOTS` 的 id）+ 索引正好对得上；
                以前这里错传 `collected`（委托 id），导致「采过就收起来」恒不生效。 */}
            <CollectProps visible={showPoints} picked={HIDE_TAKEN ? picked : undefined} />
            <FlowerClusters />

            {/* 站姿 NPC（委托阶段）与坐姿 NPC（宴会阶段）—— 同一个组件、两套烘焙参数，
                所以用 `key` 强制重挂。`?npcpose=stand|npclayout=ring` 见 NpcCrowd 头注释。
                ★ `spots` 必须传：它和下面 `GameInteract` 注册的互动点坐标是**同一份数组**，
                  不传的话 `NpcCrowd` 会自己跑一套黄金角散点，互动点就飘到十米外去了。 */}
            {showStandNpc && <NpcCrowd key="npc-stand" visible pose="stand" layout="ring" spots={standSpots()} />}
            {showFeast && <NpcCrowd key="npc-sit" visible pose="sit" layout="table" spots={seatSpots2()} />}

            {/* 长桌 + 蛋糕（宴会阶段；缺省就在场，用 visible 控） */}
            <Banquet visible={showFeast} />

            {/* 采集点/书桌/信箱的「已采过就隐藏」由各自组件内部处理 */}

            <GameInteract />
            <PhotoSnap />

            {/* 委托箭头（★ 2026-10-18 用户 m00863 任务3）：
                选中态存在 `ui/guideState.ts` 的模块级容器里，由任务列表点击写入，
                本组件只负责在「委托阶段」把它挂进场景（宴会阶段没有可指的目标）。
                常挂着而不是 `{showStandNpc && …}` 是故意的：卸载会丢掉每帧的
                高度缓存，而 visible=false 已经让它彻底不画。 */}
            <QuestArrow visible={showStandNpc} />
        </>
    );
}

/* ==================================================================
 * 3. 互动注册 —— 本文件的核心
 *
 *    每个阶段注册一组可互动对象，阶段一变整组注销重注册。
 *    **全部只走 F 键**（用户 m02646：除了他明确点名的两处，其余一律 F）。
 * ================================================================== */

function GameInteract() {
    /* 依赖项全是「会影响注册内容」的标量 —— 故意不用对象，免得每次渲染都重注册。 */
    const phase = useGameStore2((s) => s.phase);
    const writingIndex = useGameStore2((s) => s.writingIndex);
    const lettersWritten = useGameStore2((s) => s.lettersWritten);
    const lettersReady = useGameStore2((s) => s.lettersReady);
    const lettersSent = useGameStore2((s) => s.lettersSent);
    const acceptedLen = useGameStore2((s) => s.accepted.length);
    const collected = useGameStore2((s) => s.collected);
    const deliveredLen = useGameStore2((s) => s.delivered.length);
    const cakeCut = useGameStore2((s) => s.cakeCut);

    /* `collected` 是对象，直接进依赖数组会每次都变。用它的「内容指纹」当依赖。 */
    const collectedKey = useMemo(
        () => QUESTS.map((q) => `${q.id}:${collected[q.id] ?? 0}`).join('|'),
        [collected],
    );

    useEffect(() => {
        const offs: Array<() => void> = [];
        const st = () => useGameStore2.getState();

        /* ── 任务① 书桌：只在「还没开始写 / 正在写」时可互动 ────────────
         * 11 封写完之后书桌仍然摆着（场景不该突然空一块），但不再可互动。 */
        offs.push(registerInteractable({
            id: 'desk',
            label: POINT_COPY.desk.label,
            x: DESK_XZ[0],
            z: DESK_XZ[1],
            radius: REACH,
            enabled: () => !lettersReady && writingIndex < 0,
            hint: () => `按 F 写邀请函（${lettersWritten}/${LETTERS.length}）`,
            glow: true,
            glowColor: '#e8d8a8',
            onUse: () => {
                const c = useGameStore?.getState?.().characterRef?.current;
                if (c) {
                    /* 站到桌子「面朝场心」那一侧，转身面朝桌子。 */
                    const dx = 0 - DESK_XZ[0];
                    const dz = 0 - DESK_XZ[1];
                    const L = Math.hypot(dx, dz) || 1;
                    teleport(
                        c,
                        DESK_XZ[0] + (dx / L) * DESK_STAND_D,
                        DESK_XZ[1] + (dz / L) * DESK_STAND_D,
                        DESK_XZ[0], DESK_XZ[1],
                    );
                }
                st().startLetter(useGameStore2.getState().lettersWritten);
            },
        }));

        /* ── 任务② 信箱：11 封写完才出现 ───────────────────────────── */
        if (lettersReady && !lettersSent) {
            offs.push(registerInteractable({
                id: 'mailbox',
                label: POINT_COPY.mailbox.label,
                x: MAILBOX_XZ[0],
                z: MAILBOX_XZ[1],
                radius: REACH,
                enabled: () => true,
                hint: () => POINT_COPY.mailbox.hint,
                glow: true,
                glowColor: '#9fd8e8',
                onUse: () => {
                    const c = useGameStore?.getState?.().characterRef?.current;
                    if (c) {
                        const dx = 0 - MAILBOX_XZ[0];
                        const dz = 0 - MAILBOX_XZ[1];
                        const L = Math.hypot(dx, dz) || 1;
                        teleport(
                            c,
                            MAILBOX_XZ[0] + (dx / L) * MAILBOX_STAND_D,
                            MAILBOX_XZ[1] + (dz / L) * MAILBOX_STAND_D,
                            MAILBOX_XZ[0], MAILBOX_XZ[1],
                        );
                    }
                    st().sendLetters();
                },
            }));
        }

        /* ── 委托阶段：14 个 NPC（打招呼 / 接委托 / 交付）+ 13 个采集点 ── */
        if (phase === 'quest') {
            for (const id of NPC_ORDER) {
                const [x, z] = npcPos(id, false);
                offs.push(registerInteractable({
                    id: `npc:${id}`,
                    label: npcName(id),
                    x, z,
                    radius: REACH + 0.4,
                    enabled: () => true,
                    hint: () => {
                        const q = questOfNpc(id);
                        const s = st();
                        /* ★ `talk` 类：我是别人要找的人 —— 提示要盖过自己的委托，
                           否则玩家看着「按 F 接取「帽子里的礼物」」按下去，
                           弹出来的却是阿蕾奇诺的交付台词，像点错了。 */
                        const hit = QUESTS.find(
                            (x) => x.kind === 'talk' && x.targetNpc === id
                                && s.accepted.includes(x.id) && !s.delivered.includes(x.id),
                        );
                        if (hit) return `按 F 交付「${hit.title}」`;
                        if (!q) return '按 F 打招呼';
                        if (s.delivered.includes(q.id)) return '按 F 打招呼';
                        if (!s.accepted.includes(q.id)) return `按 F 接取委托「${q.title}」`;
                        if (canDeliver(s, q)) return `按 F 交付「${q.title}」`;
                        return '按 F 说话';
                    },
                    glow: true,
                    glowColor: '#c8b8e8',
                    onUse: () => talkToNpc(id),
                }));
            }

            for (const q of QUESTS) {
                if (!q.pointId) continue;
                const spots = pointXZ(q.pointId);
                const need = q.count ?? 1;
                spots.forEach(([x, z], i) => {
                    /* 点位实例键：`pointId:index`。**必须与 `CollectProps` 收起来的
                       那个索引一致** —— 两边都来自 `pointXZ(pointId)` 的数组顺序。 */
                    const spotKey = `${q.pointId}:${i}`;
                    offs.push(registerInteractable({
                        id: `point:${spotKey}`,
                        label: POINT_COPY[q.pointId]?.label ?? q.title,
                        x, z,
                        radius: REACH,
                        enabled: () => {
                            const s = st();
                            /* 没接这个委托 → 点不可用（用户要的是「先找 NPC 接，再去做」）。 */
                            if (!s.accepted.includes(q.id)) return false;
                            if (s.delivered.includes(q.id)) return false;
                            /* ★ 这一处已经被采走了 → 关掉。以前没有这道判断，
                               `addCollect` 又只写全局计数 ⇒ **同一处能连按 N 次交差**
                               （`rose ×3` 站着不动按三下就完成）。 */
                            if (s.picked[spotKey]) return false;
                            /* `litter ×5` / `mushroom ×2`：采够数量后剩下的点也关掉
                               （正常情况下点位数量 == need，这道判断是兜底）。 */
                            return (s.collected[q.id] ?? 0) < need;
                        },
                        hint: () => POINT_COPY[q.pointId!]?.hint ?? '按 F',
                        glow: true,
                        glowColor: '#a8e8c0',
                        onUse: () => collectAt(q.id, spotKey, need),
                    }));
                });
            }
        }

        /* ── 宴会阶段：切蛋糕 + 14 个 NPC 打招呼（坐姿）─────────────── */
        if (phase === 'feast' || phase === 'done') {
            if (!cakeCut) {
                offs.push(registerInteractable({
                    id: 'cake',
                    label: CAKE_GUIDE.label,
                    x: CAKE_STAND_XZ[0],
                    z: CAKE_STAND_XZ[1],
                    radius: REACH + 0.6,
                    enabled: () => true,
                    hint: () => '按 F 切蛋糕',
                    glow: true,
                    glowColor: '#ffd8a0',
                    onUse: () => {
                        const c = useGameStore?.getState?.().characterRef?.current;
                        if (c) {
                            /* 站到主位上，面朝桌心（= 蛋糕）。 */
                            teleport(c, CAKE_STAND_XZ[0] - CAKE_STAND_D, CAKE_STAND_XZ[1], 0, -6.61);
                        }
                        st().cutCake();
                    },
                }));
            }

            for (const id of NPC_ORDER) {
                const [x, z] = npcPos(id, true);
                offs.push(registerInteractable({
                    id: `npc:${id}`,
                    label: npcName(id),
                    x, z,
                    radius: REACH + 0.4,
                    enabled: () => true,
                    hint: () => '按 F 打招呼',
                    glow: true,
                    glowColor: '#c8b8e8',
                    onUse: () => talkToNpc(id),
                }));
            }
        }

        return () => offs.forEach((f) => f());
    }, [
        phase, writingIndex, lettersWritten, lettersReady, lettersSent,
        acceptedLen, collectedKey, deliveredLen, cakeCut,
    ]);

    return null;
}

/* ==================================================================
 * 4. 互动的具体行为
 * ================================================================== */

/**
 * 和一个 NPC 说话。按任务状态决定说哪一段 —— 这是「NPC 功能：打招呼 / 发委托」的实现。
 *
 * 优先级（自上而下，命中即停）：
 *   ① 宴会阶段（feast/done）→ 庆功宴闲聊（用户 m02820 之后 NPC 只剩「打招呼」，
 *      所以这里不再有「合影」入口）
 *   ② 有委托且已满足交付条件 → 交付台词 + 发奖励
 *   ③ 有委托且已接取但没做完 → 进行中台词
 *   ④ 有委托且没接取 → 接取台词 + 接受委托
 *   ⑤ 没委托（派蒙等）→ 场景对话
 */
function talkToNpc(id: string): void {
    const s = useGameStore2.getState();

    /* ① 宴会阶段 */
    if (s.phase === 'feast' || s.phase === 'done') {
        const lines = FEAST_CHAT[id];
        s.openDialog(id, lines && lines.length ? lines : ['……']);
        return;
    }

    /* ①.5 ★ `talk` 类委托的**交付**：我就是别人要找的那个人。
     *
     * 为什么必须有这一段（原本没有，是死锁）：
     *   `canDeliver()` 对 `kind === 'talk'` **硬返回 false**（`questStore.ts:326`），
     *   因为 talk 类的交付不看采集数量、看的是「有没有跟目标说过话」——
     *   但那句「和 targetNpc 对话时直接交付」只在注释里，**没有任何代码实现**。
     *   后果：q1（阿蕾奇诺 → 找林尼说话）永远进不了下面的分支②，
     *   只会掉进分支③一直显示「还没见到人？」，`delivered` 卡在 13，
     *   `deliverQuest` 里「14 个全完成 → phase='feast'」永不触发 ⇒ **整个流程死锁**。
     *
     * 位置放在「接取自己的委托」**之前**：林尼身上有 q2，玩家为了 q1 来找他时
     * 应该先结算 q1 的交付台词，而不是被 q2 的接取词抢走。
     * 一次可能命中多个（不同 NPC 都把同一个人当目标）—— 全部结算，台词串起来。 */
    const talkHits = QUESTS.filter(
        (q) => q.kind === 'talk' && q.targetNpc === id
            && s.accepted.includes(q.id) && !s.delivered.includes(q.id),
    );
    if (talkHits.length) {
        const lines: string[] = [];
        for (const q of talkHits) {
            s.deliverQuest(q.id);
            lines.push(...q.deliver);
        }
        /* 全部交付完 ⇒ `deliverQuest` 已把 phase 推成 feast，补一句转场提示。 */
        const after = useGameStore2.getState();
        if (after.phase === 'feast') {
            lines.push('（远处传来桌子的挪动声。）');
        }
        after.openDialog(id, lines.length ? lines : ['……']);
        return;
    }

    const q = questOfNpc(id);

    /* ② 交付 */
    if (q && s.accepted.includes(q.id) && !s.delivered.includes(q.id) && canDeliver(s, q)) {
        s.deliverQuest(q.id);
        /* 交付后如果全部完成，`deliverQuest` 已经把 phase 推成 `feast` —— 这里再读一次。 */
        const after = useGameStore2.getState();
        if (after.phase === 'feast') {
            after.openDialog(id, [...q.deliver, `（${q.reward} 已收下。远处传来桌子的挪动声。）`]);
        } else {
            after.openDialog(id, q.deliver);
        }
        return;
    }

    /* ③ 进行中 */
    if (q && s.accepted.includes(q.id)) {
        s.openDialog(id, q.progress);
        return;
    }

    /* ④ 接取 */
    if (q) {
        s.acceptQuest(q.id);
        s.openDialog(id, q.offer);
        return;
    }

    /* ⑤ 闲聊（`talk` 类委托的目标 NPC 也走这里 —— 他本身没委托） */
    const lines = STAND_CHAT[id];
    s.openDialog(id, lines && lines.length ? lines : ['……']);
}

/** 在某个采集点按 F：标记该点 + 计数 +1，到量了就提示可以回去交付了。
 *  `spotKey` = `pointId:index`（哪一处），计数仍按**委托 id** 记（`collected`）。 */
function collectAt(questId: string, spotKey: string, need: number): void {
    const s = useGameStore2.getState();
    const pointId = spotKey.split(':')[0];
    s.pickSpot(spotKey);
    s.addCollect(questId, 1);

    const got = (useGameStore2.getState().collected[questId] ?? 0);
    const q = QUESTS.find((x) => x.id === questId);
    const ok = POINT_COPY[pointId]?.okText ?? '';

    if (got >= need) {
        s.showToast(ok, `「${q?.title ?? ''}」可以回去交付了`);
    } else {
        s.showToast(ok, `${got}/${need}`);
    }
    /* ⚠️ 这个 `clearTimeout` 兜底是**无效**的（2026-10-17 记）：
       `t` 在 TOAST_MS 后已经把 toast 清掉了，再过 100 ms 去 clear 一个已经跑完的
       定时器没有任何作用；而真正的问题是**连续采集时定时器互相踩** ——
       第 2 次的 toast 会被第 1 次留下的 `clearToast` 提前清掉（表现为提示一闪而过）。
       正确做法是把「当前 toast 的定时器 id」存进 store、每次先清上一个。
       这里先留下判断注释，等 toast 改成 store 持有 id（见报告 3.x）。 */
    const t = window.setTimeout(() => useGameStore2.getState().clearToast(), TOAST_MS);
    window.setTimeout(() => window.clearTimeout(t), TOAST_MS + 100);
}

/* ==================================================================
 * 5. 探针（给无头出图脚本读数，与 `__npc` / `__photo` 同一套）
 * ================================================================== */

if (typeof window !== 'undefined') {
    (window as unknown as { __game?: unknown }).__game = {
        phase: () => useGameStore2.getState().phase,
        letters: () => {
            const s = useGameStore2.getState();
            return {
                written: s.lettersWritten, ready: s.lettersReady, sent: s.lettersSent,
                total: LETTERS.length,
            };
        },
        quests: () => {
            const s = useGameStore2.getState();
            return {
                accepted: s.accepted.length,
                delivered: s.delivered.length,
                collected: s.collected,
                total: QUESTS.length,
            };
        },
        /* 已交付的委托 **id 列表** —— 注意 `quests().delivered` 是**个数**，
           想判「某条交付了没」必须用这个。端到端脚本踩过：
           对个数调 `.includes()` 直接 TypeError（2026-10-15）。 */
        deliveredIds: () => useGameStore2.getState().delivered.slice(),
        cake: () => useGameStore2.getState().cakeCut,
        photo: () => useGameStore2.getState().photoSeen,
        finalNote: () => FINAL_NOTE,
        /* 对话是否开着 + 当前行号 —— 端到端脚本靠它判断「还要按几次 F 才翻完」。 */
        dialog: () => {
            const d = useGameStore2.getState().dialog;
            return d ? { npc: d.npc, line: d.line, total: d.lines.length } : null;
        },
        /* 当前最近的可互动对象 —— 用来验证「人走到哪、提示就指到哪」。 */
        nearest: () => ({ id: interactState.id, label: interactState.label, hint: interactState.hint }),
        /* ── 端到端脚本要用的「坐标真值」出口 ─────────────────────────
           互动点的 x/z 只有本文件知道（它把 `npcPos` / `pointXZ` 喂给了
           `registerInteractable`）。脚本要模拟「玩家走过去」，就必须拿到
           同一份坐标 —— 否则验的是脚本自己算的位置，不是游戏里的位置。 */
        npcPos: (id: string, seated = false) => npcPos(id, seated),
        npcIds: () => NPC_ORDER.slice(),
        /* 委托表（脚本按它决定「去哪个点采几次、回哪个 NPC 交」） */
        questList: () => QUESTS.map((q) => ({
            id: q.id, npc: q.npc, title: q.title, kind: q.kind,
            pointId: q.pointId ?? null, count: q.count ?? 1, targetNpc: q.targetNpc ?? null,
        })),
        pointXZ: (id: string) => pointXZ(id),
        /* 切蛋糕主位坐标（`CAKE_STAND_XZ`）—— 端到端脚本要走到这里按 F。 */
        cakeSpot: () => CAKE_STAND_XZ.slice() as [number, number],
        /* 当前弹着的合影 URL（切蛋糕之后应该是 photo_feast.png） */
        photoUrl: () => useGameStore2.getState().photo?.url ?? null,
        shots: () => useGameStore2.getState().shots.length,
        /* 相册是否开着 —— 端到端脚本点完「相册」按钮要读它确认真的开了。 */
        album: () => useGameStore2.getState().albumOpen,
        /* 当前 Toast 内容（无头出图时确认提示真的弹了）。 */
        toast: () => useGameStore2.getState().toast,
        /* ★ 直接把黑屏过渡**停住**（出图验收用）。
         *
         * 正常流程里 `setFade` 由阶段切换触发，`FADE_MS`(1.1 s) 后自动清掉 ——
         * 那点时间窗根本抓不稳（截图要等场景加载完）。这里直接写 store，
         * 只要 phase 不再变，负责清它的 effect 就不会重跑，画面就**一直停着**。
         * 传 null 收起。仅验收用，正常玩法不会走到。 */
        fade: (title: string | null, sub = '') => {
            useGameStore2.getState().setFade(title ? { title, sub } : null);
        },
        /* 把某个 NPC 瞬移到玩家面前 —— 无头验收时不用真的走完地图。 */
        warp: (x: number, z: number) => {
            const c = useGameStore?.getState?.().characterRef?.current;
            if (!c) return false;
            c.position.x = x;
            c.position.z = z;
            return true;
        },
        /* 直接驱动状态机（跳过 F 键），用来快速跳到某个阶段出图。 */
        setPhase: (p: Phase) => useGameStore2.getState().setPhase(p),
        writeAll: () => {
            const st = useGameStore2.getState();
            for (let i = 0; i < LETTERS.length; i++) st.finishLetter();
            useGameStore2.getState().setLettersReady();
        },
        sendAll: () => useGameStore2.getState().sendLetters(),
        acceptAll: () => {
            const st = useGameStore2.getState();
            for (const q of QUESTS) st.acceptQuest(q.id);
        },
        deliverAll: () => {
            const st = useGameStore2.getState();
            for (const q of QUESTS) st.deliverQuest(q.id);
        },
        cutCake: () => useGameStore2.getState().cutCake(),
        closePhoto: () => useGameStore2.getState().closePhoto(),
        /* 相机模式：出图时经常要在 Follow / FPV / Detached 之间切。 */
        cam: (m: CameraMode) => useGameStore.getState().setCameraMode?.(m),
    };
}

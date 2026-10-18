/**
 * 任务系统 —— 生日会全流程的状态机（**唯一真值**）。
 *
 * ── 阶段（`Phase`）──────────────────────────────────────────────────
 *   `letter`  任务①「写邀请函」：世界空荡，只有书桌 + 信箱。写完 11 封 → 寄出 → 进 `quest`。
 *   `quest`   任务②「投递邀请函」完成后：15 个 NPC 站姿撒满地图，各自发委托。
 *   `feast`   14 个委托全交付 → 站姿 NPC 隐藏，会场中央刷新坐姿 NPC + 长桌 + 蛋糕。
 *   `done`    切完蛋糕、看完合影 → 全部任务完成，NPC 功能改为「打招呼 / 查看合影」。
 *
 * ── 为什么这里可以用 zustand ────────────────────────────────────────
 * 与 `interactState` / `minimapState` 不同，这些状态**只在玩家操作时变**（低频），
 * 而且要驱动 React 重渲染（任务列表、对话框）。所以走 store 是对的。
 * 每帧变的那些（玩家坐标、最近可互动对象）留在纯模块对象里。
 *
 * ── 为什么「已读台词」也要记 ────────────────────────────────────────
 * 用户要求「每个 NPC 负责一个委托任务」，但同一个 NPC 在不同阶段说的话完全不同
 * （接取 / 进行中 / 交付 / 庆功宴闲聊）。用 `talked` 记「这个 NPC 的哪几段已经播过」，
 * 才能做到「再次对话时接着上次说」而不是从头念。
 */

import { create } from 'zustand';
import { LETTERS, QUESTS, type Quest } from './copy';

/* ==================================================================
 * 阶段
 * ================================================================== */

export type Phase = 'letter' | 'quest' | 'feast' | 'done';

/** 任务列表里的一行。 */
export interface QuestLine {
    id: string;
    title: string;
    /** 任务列表里的那一行描述（委托词 desc / 邀请函进度）。 */
    desc: string;
    /** 目标提示，例如「虹彩蔷薇 2/3」。 */
    progress: string;
    done: boolean;
}

/* ==================================================================
 * Store
 * ================================================================== */

interface GameState {
    phase: Phase;

    /* ── 任务① 写邀请函 ── */
    /** 已经写完的邀请函数量（0..11）。 */
    lettersWritten: number;
    /** 11 封全写完、准备寄出。 */
    lettersReady: boolean;
    /** 已经投进信箱。 */
    lettersSent: boolean;
    /** 当前正在信纸上逐行显示的那封信的下标（-1 = 没在写）。 */
    writingIndex: number;
    /** 信纸正文已经显示到第几行（逐行动画用）。 */
    writingLine: number;

    /* ── 任务② 委托 ── */
    /** 已接取的委托 id。 */
    accepted: string[];
    /** 每个委托的采集计数：`questId -> 已收集数`。 */
    collected: Record<string, number>;
    /**
     * **哪一处采集点**已经被采过：`"pointId:index" -> true`。
     *
     * ⚠️ 与 `collected` 是两个不同的 id 空间，别混：
     *   · `collected` 的键是**委托 id**（`questId`），值是「采了几个」——
     *     委托的完成判定用它（`deliverQuest` / 任务列表进度）；
     *   · `picked` 的键是**点位实例**（`pointId:index`，例如 `"rose:2"`）——
     *     「这一株已经被摘走了、地上要消失、互动点要关掉」用它。
     *
     * 2026-10-17 补：之前只有 `collected`，于是「按点位隐藏/按点位禁用」这两件事
     * 都无处可写 —— `GameLayer` 只好把 `collected`（委托 id）当点位表传给
     * `CollectProps`，键空间对不上，`taken[id]` 恒为 `undefined`，「采过就收起来」
     * 整个空转；同一处还能连按 N 次交差（因为计数只看全局 `collected[questId]`）。
     */
    picked: Record<string, boolean>;
    /** 已交付（完成）的委托 id。 */
    delivered: string[];

    /* ── 任务③ 切蛋糕 ── */
    /** 蛋糕已切。 */
    cakeCut: boolean;
    /** 合影已看（按 F 收起）。 */
    photoSeen: boolean;

    /* ── 对话 / 合影查看 ── */
    /** 当前正在播的对话：`null` = 没在对话。 */
    dialog: { npc: string; lines: string[]; line: number } | null;
    /** 当前正在展示的合影（`null` = 没在展示）。 */
    photo: { url: string; caption: string } | null;
    /** 每个 NPC 已看过的合影张数（给「查看合影」用）。 */
    photosTaken: string[];

    /* ── 拍照 / 相册（用户 m02820：合影功能常态化）──
     * 用户原话：「所有NPC合影/查看合影功能撤掉，合影功能做常态化（即界面UI做一个拍照按钮），
     * 再做一个相册按钮，查看所有拍照的图片以及最后切蛋糕任务的图片。」
     * ⇒ NPC 身上不再挂「合影」功能，改成 UI 上一个常驻拍照按钮 + 一个相册。
     */
    /** 玩家拍过的照片（PNG dataURL），**最新的排在最前面**（相册直接顺序渲染即可）。 */
    shots: string[];
    /** 相册是否打开。 */
    albumOpen: boolean;

    /* ── 屏幕提示 / 黑屏过渡 ── */
    /** 屏幕中央文字提示（`null` = 不显示）。用于「邀请函已寄出」这类一次性通知。 */
    toast: { text: string; sub: string } | null;
    /** 黑屏过渡（`null` = 不黑屏）。用于 NPC 大批刷新时遮住卡顿。 */
    fade: { title: string; sub: string } | null;

    /* ── 动作 ── */
    setPhase: (p: Phase) => void;

    startLetter: (i: number) => void;
    advanceLetterLine: (total: number) => void;
    finishLetter: () => void;
    setLettersReady: () => void;
    sendLetters: () => void;

    acceptQuest: (id: string) => void;
    addCollect: (id: string, n?: number) => void;
    /** 标记**某一处**采集点已被采走（键 = `pointId:index`，见 `picked` 的注释）。 */
    pickSpot: (key: string) => void;
    deliverQuest: (id: string) => void;

    cutCake: () => void;
    closePhoto: () => void;

    openDialog: (npc: string, lines: string[]) => void;
    nextDialogLine: () => void;
    closeDialog: () => void;
    openPhoto: (url: string, caption: string) => void;
    addPhoto: (npc: string) => void;

    addShot: (url: string) => void;
    openAlbum: () => void;
    closeAlbum: () => void;
    showToast: (text: string, sub?: string) => void;
    clearToast: () => void;
    setFade: (f: { title: string; sub: string } | null) => void;

    /** 全部重置（`?game=0` 或调试用）。 */
    reset: () => void;
}

const initial = {
    phase: 'letter' as Phase,
    lettersWritten: 0,
    lettersReady: false,
    lettersSent: false,
    writingIndex: -1,
    writingLine: 0,
    accepted: [] as string[],
    collected: {} as Record<string, number>,
    picked: {} as Record<string, boolean>,
    delivered: [] as string[],
    cakeCut: false,
    photoSeen: false,
    dialog: null,
    photo: null,
    photosTaken: [] as string[],
    shots: [] as string[],
    albumOpen: false,
    toast: null,
    fade: null,
};

export const useGameStore2 = create<GameState>((set, get) => ({
    ...initial,

    setPhase: (p) => set({ phase: p }),

    startLetter: (i) => set({ writingIndex: i, writingLine: 0 }),

    /** 信纸逐行推进；推到末行时不动（等玩家点鼠标收信）。 */
    advanceLetterLine: (total) =>
        set((s) => ({ writingLine: Math.min(s.writingLine + 1, total) })),

    /** 当前这封写完 → 收进信封。11 封都写完则 `lettersReady`。 */
    finishLetter: () =>
        set((s) => {
            const n = Math.min(s.lettersWritten + 1, LETTERS.length);
            return {
                lettersWritten: n,
                lettersReady: n >= LETTERS.length,
                writingIndex: -1,
                writingLine: 0,
            };
        }),

    setLettersReady: () => set({ lettersReady: true }),

    /** 寄出全部邀请函 → 进委托阶段。 */
    sendLetters: () =>
        set({
            lettersSent: true,
            phase: 'quest',
        }),

    acceptQuest: (id) =>
        set((s) => (s.accepted.includes(id) ? s : { accepted: [...s.accepted, id] })),

    addCollect: (id, n = 1) =>
        set((s) => ({
            collected: { ...s.collected, [id]: (s.collected[id] ?? 0) + n },
        })),

    /** 标记某一处采集点被采走。幂等：同一处重复采不会重复记。 */
    pickSpot: (key) =>
        set((s) => (s.picked[key] ? s : { picked: { ...s.picked, [key]: true } })),

    /** 交付：标记完成；14 个全完成则进 `feast` 阶段。 */
    deliverQuest: (id) =>
        set((s) => {
            if (s.delivered.includes(id)) return s;
            const delivered = [...s.delivered, id];
            const all = delivered.length >= QUESTS.length;
            return {
                delivered,
                ...(all ? { phase: 'feast' as Phase } : {}),
            };
        }),

    cutCake: () => set({ cakeCut: true }),

    /** 收起合影。
     *
     *  ⚠️ 这里原本是 `set({ photo: null, photoSeen: true, phase: 'done' })` ——
     *    把**阶段推进**塞进了一个纯 UI 动作，后果是：
     *    ① `PhotoView` 的关闭是"点哪儿都能关"（`ui/PhotoView.tsx:67` 的 `onClick`），
     *       玩家在 `quest` 阶段随手点开任意一张合影再关掉，`phase` 就被直接推到 `done`，
     *       **`feast`（长桌宴）整个阶段被跳过** —— 因为 `phase === 'done'` 也满足
     *       `questStore.ts:299` / `:380` 的 `feasting` 判定，界面看起来"还能用"，
     *       所以这个跳过很难被察觉，只会表现为"宴会环节没出现，直接就尾声了"。
     *    ② 反过来，`done` 是个**终态**，任何一张图的关闭都会把阶段重置回终态，
     *       将来若加了"从尾声回看照片"的功能，会把人踢回结局。
     *
     *  现在：关照片只负责关照片；只有**正在 `feast`**（= 全部委托已交付、宴会进行中）
     *  才顺带推进到 `done`。其他阶段保持不变，由各自的状态机决定何时推进。 */
    closePhoto: () =>
        set((s) => ({
            photo: null,
            photoSeen: true,
            phase: s.phase === 'feast' ? 'done' : s.phase,
        })),

    openDialog: (npc, lines) => set({ dialog: { npc, lines, line: 0 } }),

    nextDialogLine: () =>
        set((s) => {
            if (!s.dialog) return s;
            const next = s.dialog.line + 1;
            if (next >= s.dialog.lines.length) return { dialog: null };
            return { dialog: { ...s.dialog, line: next } };
        }),

    closeDialog: () => set({ dialog: null }),

    openPhoto: (url, caption) => set({ photo: { url, caption } }),

    addPhoto: (npc) =>
        set((s) => (s.photosTaken.includes(npc) ? s : { photosTaken: [...s.photosTaken, npc] })),

    /* ── 拍照 / 相册 / 提示 / 黑屏 ──
     * 上限 60 张：每张是 PNG dataURL，1~3 MB，无限堆会把内存吃光。
     * 相册是「最新在前」，所以超出时砍尾（最老的）。
     */
    addShot: (url) => set((s) => ({ shots: [url, ...s.shots].slice(0, 60) })),

    openAlbum: () => set({ albumOpen: true }),
    closeAlbum: () => set({ albumOpen: false }),

    showToast: (text, sub = '') => set({ toast: { text, sub } }),
    clearToast: () => set({ toast: null }),
    setFade: (f) => set({ fade: f }),

    reset: () => set({ ...initial }),
}));

/* ==================================================================
 * 派生查询（不放进 store，避免每次渲染重算）
 * ================================================================== */

/** 任务列表。按阶段给不同内容 —— 用户要的是「右侧任务列表」。 */
export function questLines(s: GameState): QuestLine[] {
    const out: QuestLine[] = [];

    /* 任务① 写邀请函（三个阶段都能回看） */
    const w = s.lettersWritten;
    out.push({
        id: 'q_letter',
        title: '写邀请函',
        desc: s.lettersSent
            ? '邀请函已全部寄出。'
            : '在月亮上办生日会，得先把朋友们请来。去窗前的书桌写信吧。',
        progress: s.lettersSent
            ? '已完成'
            : `邀请函 ${w}/${LETTERS.length}`,
        done: s.lettersSent,
    });

    /* 任务② 投递邀请函 —— 只在「11 封写完但还没寄」时出现 */
    if (s.lettersReady && !s.lettersSent) {
        out.push({
            id: 'q_mail',
            title: '投递邀请函',
            desc: '信写好了。林间有个信箱，把信投进去。',
            progress: '待投递',
            done: false,
        });
    }

    /* 任务② 委托 —— 委托阶段及之后 */
    if (s.phase === 'quest' || s.phase === 'feast' || s.phase === 'done') {
        out.push({
            id: 'q_quests',
            title: '实现朋友们的委托',
            desc: '大家都在月亮上等着。挨个问问他们需要什么。',
            progress: `${s.delivered.length}/${QUESTS.length}`,
            done: s.delivered.length >= QUESTS.length,
        });

        /* 未完成的委托逐条列出（已完成的不再占位） */
        for (const q of QUESTS) {
            if (s.delivered.includes(q.id)) continue;
            out.push({
                id: q.id,
                title: q.title,
                desc: s.accepted.includes(q.id) ? q.needLabel : `（${q.npcName}）${q.desc}`,
                progress: questProgress(s, q),
                done: false,
            });
        }
    }

    /* 任务③ 切蛋糕 */
    if (s.phase === 'feast' || s.phase === 'done') {
        out.push({
            id: 'q_cake',
            title: '切蛋糕',
            desc: '人都齐了。去长桌主位，把蛋糕切开。',
            progress: s.cakeCut ? '已完成' : '待切',
            done: s.cakeCut,
        });
    }

    return out;
}

/** 单个委托的进度文字。 */
export function questProgress(s: GameState, q: Quest): string {
    if (s.delivered.includes(q.id)) return '已完成';
    if (!s.accepted.includes(q.id)) return '未接取';
    if (q.kind === 'talk') return '去和对方说话';
    const need = q.count ?? 1;
    const got = Math.min(s.collected[q.id] ?? 0, need);
    return `${got}/${need}`;
}

/** 某个委托是否已满足交付条件（但还没交付）。 */
export function canDeliver(s: GameState, q: Quest): boolean {
    if (s.delivered.includes(q.id)) return false;
    if (!s.accepted.includes(q.id)) return false;
    /* ★ `talk` 类**不经过这里** —— 它的交付条件是「跟 `targetNpc` 说过话」，
     *   那个事件只有 `talkToNpc()` 知道（在 `components/game/GameLayer.tsx`），
     *   而本文件是纯状态层，拿不到「谁刚跟谁说过话」。
     *   所以 `talk` 的交付由 `GameLayer.talkToNpc()` 在「我就是 targetNpc」时
     *   直接调 `deliverQuest()` 完成，`canDeliver` 对它恒 false。
     *   ⚠️ 这条不是「不能交付」，是「不由本函数裁决」—— 早期版本没有对应的
     *   实现分支，导致 q1 永远交不掉、流程卡死，详见 `talkToNpc()` ①.5 的注释。 */
    if (q.kind === 'talk') return false;
    const need = q.count ?? 1;
    return (s.collected[q.id] ?? 0) >= need;
}

/** 找某个 NPC 负责的委托。 */
export function questOfNpc(npc: string): Quest | undefined {
    return QUESTS.find((q) => q.npc === npc);
}

/** 15 个 NPC 里哪些在「委托阶段」有活干（有委托的 14 个 + 派蒙挂在空身上）。 */
export function npcsWithQuests(): string[] {
    return QUESTS.map((q) => q.npc);
}

/* ==================================================================
 * 场景可见性 —— 「现在该显示什么」的**唯一判据**
 *
 * 为什么单拎出来：这份推导会被**两个地方**同时读 ——
 *   ① `components/game/GameLayer.tsx`（书桌 / 信箱 / 采集点）
 *   ② `components/WorldController.tsx`（NPC 群像 / 宴会长桌）
 * 各写一份 `phase === 'quest'` 迟早会有一处漏改，然后出现「NPC 来了但道具没来」
 * 这种要翻五个文件才能定位的坏。所以只在这里判一次。
 *
 * 用户 m02541 的流程原文（逐条对应）：
 *   「玩家进入世界，此时无任何NPC，无桌子，蛋糕，椅子等道具」
 *   「（写完 11 封）此时任务1：写邀请函完成，刷新任务2：投递邀请函」
 *   「完成后，所有NPC（站姿）按预定位置刷新」
 *   「所有委托完成后，站姿NPC隐藏，会场中央刷新坐姿NPC和桌子，蛋糕道具」
 *   「此时所有任务完成。NPC坐姿不变，蛋糕和桌子不变」
 * ================================================================== */

export interface SceneVisibility {
    /** 书桌：从进游戏第一帧就在（任务① 的目标），全程不消失。 */
    desk: boolean;
    /** 信箱：11 封写完才出现 —— 用户要的是「先写信，再寄信」两步。 */
    mailbox: boolean;
    /** 13 个采集点的道具：委托阶段才出现（任务① 时地图上应该是空的）。 */
    points: boolean;
    /** 站姿 NPC：**只有委托阶段**。最后一个委托交付完立刻隐藏。 */
    standNpc: boolean;
    /** 坐姿 NPC + 长桌 + 蛋糕：委托全交付之后，一直到游戏结束都不消失。 */
    feast: boolean;
}

export function sceneVisibility(s: GameState): SceneVisibility {
    const questing = s.phase === 'quest';
    const feasting = s.phase === 'feast' || s.phase === 'done';
    return {
        desk: true,
        mailbox: s.lettersReady || s.lettersSent,
        points: questing || feasting,
        standNpc: questing,
        feast: feasting,
    };
}

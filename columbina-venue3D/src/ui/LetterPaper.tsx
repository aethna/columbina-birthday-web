/**
 * LetterPaper —— 「写邀请函」的信纸界面（本任务的主角）。
 *
 * 用户原话：
 *   「每一封邀请函都是信纸……邀请函内容逐行显示在信纸上，显示完成后，点击鼠标，
 *     做信纸收进信封动画。信封上的火漆应为月亮形状。」
 *
 * ── 为什么这里**可以**用鼠标（而别处只能按 F）───────────────────────
 * 用户的另一条硬规则是「除了我明确说明的可以点击鼠标外，其余所有功能全部指定只能按 F 键」。
 * 「点击鼠标，做信纸收进信封动画」就是那条**明确说明的例外**，所以信纸是本项目里
 * 唯一以鼠标为主交互的界面。顺手也接了 F 键（捕获阶段 + preventDefault + stopPropagation），
 * 不然玩家刚跟 NPC 交互完、手还按在 F 上，会以为界面卡住了。
 *
 * ── 为什么点击是「推进一行」而不是「跳到全部显示」─────────────────
 * 规格里这两句是有冲突的：
 *   ①「若 writingLine < lines.length → advanceLetterLine(lines.length)（推进一行）」
 *   ②「玩家点一下可以跳到全部显示」
 * 选了 ①，理由是：store 契约**只提供了 `advanceLetterLine`（+1，带 clamp）**这一个动作，
 * 没有任何「直接设置到第 N 行」的口子 —— 动作集就是设计意图的最强证据；
 * 而且右下角的提示语被指定为「点击继续」（不是「点击跳过」），语义也站在 ① 这边。
 * 想改成 ② 的话，把 `onAdvance` 里那一次调用换成循环调用即可。
 *
 * ── 为什么不用 gsap ────────────────────────────────────────────────
 * 这段动画全是「改一个 transform / opacity，让 CSS transition 去补间」，
 * 交给浏览器合成器就能跑在 GPU 上。gsap 在这里只会多一层 JS 每帧写样式的开销，
 * 还让「动画到哪一帧了」这件事从 CSS 里跑到 JS 里，更难对时序。整个收信过程
 * 只有 6 个时间点，一个 setTimeout 链比时间轴库好读得多。
 *
 * ── 为什么要自己注入 <style> ───────────────────────────────────────
 * 关键帧（@keyframes）没法写成 inline style，而项目里没引 CSS-in-JS 库、也没
 * 给 UI 配 .css 文件。整块 keyframes 用 `lp-` 前缀命名、只在挂载时注入一次，
 * 既不碰全局样式表，也不会跟别人的类名撞车。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { LETTERS, NPCS } from '../core/game/copy';
import { useGameStore2 } from '../core/game/questStore';
import { getPortrait } from './npcPortrait';
import { waxSealDataURL } from './waxSeal';

/* ==================================================================
 * 时序 —— 全部集中在这里，改节奏只动这一块
 * ================================================================== */

/** 信纸对折（rotateX 压扁） */
const T_FOLD = 420;
/** 折好的信纸缩小 + 飞向信封 + 淡出 */
const T_FLY = 380;
/** 火漆「啪」地盖上（带回弹） */
const T_SEAL = 430;
/** 信封抖一下，表示装好了 */
const T_SHAKE = 260;
/** 信封淡出 */
const T_OUT = 330;
/** 整段收信动画：1.82 s，落在规格要求的 1.6~2.0 s 里 */
const T_TOTAL = T_FOLD + T_FLY + T_SEAL + T_SHAKE + T_OUT;

/** 自动逐行显示的间隔 */
const AUTO_MS = 380;

/** 落款（用户没给文案，这里用角色的完整名号） */
const SIGNATURE = '——哥伦比娅•希珀塞莱尼娅';

/** 中文手写感字体栈：楷体优先，逐级回落到系统衬线 */
const PAPER_FONT = '"Kaiti SC", Kaiti, STKaiti, 楷体, KaiTi, "Songti SC", "Noto Serif SC", serif';

/* ==================================================================
 * 火漆 —— 模块级缓存
 * ================================================================== */

/**
 * 火漆是**一个**静态图案，11 封信用的是同一枚印章。
 * 画一次存住：`waxSealDataURL` 里有 40 段采样 × 好几层离屏 canvas，
 * 每封信重画一遍纯属白烧 CPU。惰性生成 —— 不写信的时候一行都不跑。
 */
let SEAL_CACHE = '';
function sealURL(): string {
    if (!SEAL_CACHE) SEAL_CACHE = waxSealDataURL(96);
    return SEAL_CACHE;
}

/* ==================================================================
 * 关键帧
 * ================================================================== */

const KEYFRAMES = `
/* 正文每一行「浮现」：新挂载的行播一次，已经显示完的行因为 key 不变不会重播 */
@keyframes lp-line-in {
    from { opacity: 0; transform: translateY(9px); }
    to   { opacity: 1; transform: translateY(0); }
}
/* 「点击继续」的呼吸感。不做成硬闪 —— 硬闪在深色背景上很吵 */
@keyframes lp-blink {
    0%, 100% { opacity: 0.30; }
    50%      { opacity: 0.95; }
}
/* 信纸登场：从下方轻轻推上来 */
@keyframes lp-paper-in {
    from { opacity: 0; transform: translateY(26px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
}
/* 火漆盖上：0 → 过冲 1.14 → 回落 0.94 → 1，模拟真火漆被压下去的弹性 */
@keyframes lp-seal-pop {
    0%   { transform: scale(0) rotate(-38deg); opacity: 0; }
    55%  { transform: scale(1.14) rotate(7deg); opacity: 1; }
    78%  { transform: scale(0.94) rotate(-4deg); }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
/* 信封抖一下：不是平移，是绕中心的小角度摆动 —— 更像手里掂了掂 */
@keyframes lp-shake {
    0%, 100% { transform: rotate(0deg); }
    22%      { transform: rotate(-2.4deg) translateY(-3px); }
    52%      { transform: rotate(2.1deg) translateY(2px); }
    78%      { transform: rotate(-0.9deg); }
}
/* 信封登场：从略小、略低的位置升上来 */
@keyframes lp-env-in {
    from { transform: translate(-50%, -42%) scale(0.82); opacity: 0; }
    to   { transform: translate(-50%, -50%) scale(1); opacity: 1; }
}
`;

/* ==================================================================
 * 组件
 * ================================================================== */

/** 收信动画的阶段。`idle` = 正常写信中。 */
type Phase = 'idle' | 'fold' | 'fly' | 'seal' | 'shake' | 'out';

export function LetterPaper() {
    /* ── 订阅 store ────────────────────────────────────────────────
       只订阅**基本类型**（数字）。questStore 的 `questLines(s)` 那种派生函数
       每次返回新数组，放选择器里会让 zustand 的 Object.is 永远不等，
       触发 "getSnapshot should be cached" 的无限重渲染（QuestList.tsx 踩过）。
       数字没这个问题，可以放心切。 */
    const writingIndex = useGameStore2((s) => s.writingIndex);
    const writingLine = useGameStore2((s) => s.writingLine);

    const [phase, setPhase] = useState<Phase>('idle');
    const [sealUrl, setSealUrl] = useState('');

    /** 动画期间屏蔽重复点击。用 ref 不用 state：它不需要触发重渲染 */
    const busyRef = useRef(false);
    /** 未走完的 setTimeout，切换信件 / 卸载时统一清掉，避免动画回调打到下一封信上 */
    const timersRef = useRef<number[]>([]);

    const letter = writingIndex >= 0 ? LETTERS[writingIndex] : undefined;

    /* ── 收信动画：一个 setTimeout 链推进 6 个阶段 ───────────────── */
    const beginClose = useCallback(() => {
        if (busyRef.current) return;
        busyRef.current = true;
        setSealUrl(sealURL());

        const push = (fn: () => void, ms: number) => {
            timersRef.current.push(window.setTimeout(fn, ms));
        };
        push(() => setPhase('fold'), 0);
        push(() => setPhase('fly'), T_FOLD);
        push(() => setPhase('seal'), T_FOLD + T_FLY);
        push(() => setPhase('shake'), T_FOLD + T_FLY + T_SEAL);
        push(() => setPhase('out'), T_FOLD + T_FLY + T_SEAL + T_SHAKE);
        push(() => {
            /* ★ 用 getState() 而不是闭包里的变量：这个回调要活 1.8 s，
               期间玩家可能已经触发了别的 store 变更，闭包里的值会过期。
               `lettersWritten` 必须**在** finishLetter 之前读 —— 它自己会 +1。 */
            const st = useGameStore2.getState();
            const done = st.lettersWritten;
            st.finishLetter();
            /* finishLetter 内部其实已经把 lettersReady 一起算了
               （`lettersReady: n >= LETTERS.length`），这一句是幂等的冗余。
               留着是因为契约把「11 封写完 → lettersReady」写成了显式步骤，
               以后 finishLetter 的语义变了也不会悄悄丢掉这个状态。 */
            if (done + 1 >= LETTERS.length) st.setLettersReady();
        }, T_TOTAL);
    }, []);

    /* ── 换信 / 卸载：清定时器 + 复位动画状态 ────────────────────────
       ⚠️ 这里必须清 timersRef。HMR 或者玩家在动画中途被切走时，
       旧回调会把 phase 推给**新**的那封信，出现「还没写就收信」的鬼影。 */
    useEffect(() => {
        busyRef.current = false;
        setPhase('idle');
        setSealUrl('');
        const timers = timersRef.current;
        return () => {
            for (const t of timers) window.clearTimeout(t);
            timers.length = 0;
        };
    }, [writingIndex]);

    /* ── 自动逐行显示 ───────────────────────────────────────────────
       每 tick 都重新 getState()：writingLine 变化不重启 interval（否则每次推进
       都会重置计时器，间隔会越拖越长）。writingIndex 一变就自己停，防止
       旧计时器继续推新信的行。 */
    const total = letter?.lines.length ?? 0;
    useEffect(() => {
        if (writingIndex < 0 || total === 0) return;
        const id = window.setInterval(() => {
            const st = useGameStore2.getState();
            if (st.writingIndex !== writingIndex || st.writingLine >= total) {
                window.clearInterval(id);
                return;
            }
            st.advanceLetterLine(total);
        }, AUTO_MS);
        return () => window.clearInterval(id);
    }, [writingIndex, total]);

    /* ── 推进 ───────────────────────────────────────────────────────
       正文没显示完 → 推进一行；显示完了 → 收信。
       已经收信中（busyRef）就直接吞掉，防止连点把动画打断在半路。 */
    const onAdvance = useCallback(() => {
        if (busyRef.current) return;
        const st = useGameStore2.getState();
        if (st.writingIndex < 0) return;
        const L = LETTERS[st.writingIndex];
        if (!L) return;
        if (st.writingLine < L.lines.length) {
            st.advanceLetterLine(L.lines.length);
        } else {
            beginClose();
        }
    }, [beginClose]);

    /* ── F 键 ───────────────────────────────────────────────────────
       **捕获阶段**（第三参 true）+ stopPropagation：
       window 是捕获链的第一站，在这里拦住就轮不到全局那个「按 F 跟 NPC 交互」
       的处理器 —— 否则写信时按 F 会同时推进信纸**和**触发场景交互。
       ⚠️ 只在信纸开着时拦，别的时候原样放行。 */
    useEffect(() => {
        if (writingIndex < 0) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.code !== 'KeyF' && e.key.toLowerCase() !== 'f') return;
            if (e.repeat) return;
            e.preventDefault();
            e.stopPropagation();
            onAdvance();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [writingIndex, onAdvance]);

    /* ── 头像 ───────────────────────────────────────────────────────
       getPortrait 内部有缓存，同一 id 只画一次，所以这里不必再 useMemo 兜底；
       这里 memo 的是「这封信有哪几个收件人」这层映射。 */
    const portraits = useMemo(() => {
        if (!letter) return [] as { id: string; url: string; name: string }[];
        return letter.npcs.map((id) => ({
            id,
            url: getPortrait(id),
            name: NPCS.find((n) => n.id === id)?.name ?? id,
        }));
    }, [letter]);

    /* ── 探针（无头验收用）─────────────────────────────────────────
       与 `window.__npc` / `window.__game` / `window.__photo` 同一套约定。
       为什么需要它：信纸的「点击推进 / 点击收信」是用户明确允许的**鼠标例外**，
       而无头脚本合成不出 React 的 `onClick`（需要真 pointer 序列）。
       没有这个探针就只能直接调 store 的 `finishLetter()`，那样**绕过了
       `beginClose` 的动画与 `busyRef` 门控**，等于没验。
       这里暴露的是**同一个回调**（`onAdvance` / `beginClose`），只是入口不同。
       ⚠️ 必须挂在 early return **之前**（hooks 规则）。 */
    useEffect(() => {
        const w = window as unknown as { __letter?: unknown };
        w.__letter = {
            /** 信纸是否开着 */
            open: () => useGameStore2.getState().writingIndex >= 0,
            /** 当前这封的行数 / 已显示行数 */
            lines: () => {
                const st = useGameStore2.getState();
                const L = st.writingIndex >= 0 ? LETTERS[st.writingIndex] : undefined;
                return L ? { total: L.lines.length, shown: st.writingLine } : null;
            },
            /** 等价于点一下信纸：没显示完就推进，显示完了就收信 */
            next: () => onAdvance(),
            /** 直接跳到收信动画 */
            finish: () => beginClose(),
        };
        return () => { delete w.__letter; };
    }, [onAdvance, beginClose]);

    /* writingIndex < 0 = 没在写信，整块不渲染（规格要求） */
    if (!letter) return null;
    const lines = letter.lines;
    const shown = lines.slice(0, Math.min(writingLine, lines.length));
    const allShown = writingLine >= lines.length;
    const closing = phase !== 'idle';

    /* ── 信纸外层：负责「飞」和淡出（位移+缩放）──────────────────── */
    const paperWrap: CSSProperties = {
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: 'clamp(430px, 52vw, 780px)',
        height: 'clamp(430px, 72vh, 660px)',
        marginLeft: 'calc(clamp(430px, 52vw, 780px) / -2)',
        marginTop: 'calc(clamp(430px, 72vh, 660px) / -2)',
        transformOrigin: 'center center',
        transform:
            phase === 'fly' || phase === 'seal' || phase === 'shake' || phase === 'out'
                ? 'translate(0, 9vh) scale(0.16)'
                : phase === 'fold'
                    ? 'translate(0, 0) scale(0.9)'
                    : 'translate(0, 0) scale(1)',
        opacity: closing && phase !== 'fold' ? 0 : 1,
        transition: `transform ${phase === 'fold' ? T_FOLD : T_FLY}ms cubic-bezier(.5,.05,.6,.95), opacity ${T_FLY}ms ease-in`,
        animation: 'lp-paper-in 380ms cubic-bezier(.2,.8,.3,1)',
        pointerEvents: 'none',
    };

    /* ── 信纸内层：负责「对折」（rotateX 压扁）──────────────────────
       折和飞拆成两层，是因为 3D 旋转之后的 translate 是**在旋转后的坐标系里**
       生效的，混在一起写会让信纸飞偏。 */
    const paperFold: CSSProperties = {
        width: '100%',
        height: '100%',
        transformOrigin: 'center center',
        transform:
            closing ? 'perspective(1000px) rotateX(78deg) scaleY(0.42)' : 'perspective(1000px) rotateX(0deg) scaleY(1)',
        transition: `transform ${T_FOLD}ms cubic-bezier(.45,.05,.55,.95)`,
    };

    const paperFace: CSSProperties = {
        position: 'relative',
        width: '100%',
        height: '100%',
        /* 米黄纸色。不用纯白 —— 纯白在深色夜空场景里会像一块灯箱 */
        background: 'linear-gradient(160deg, #f7f2e6 0%, #f1ead9 52%, #e9e0cb 100%)',
        /* 不规则圆角：四角半径故意不一样，读起来像手工裁的纸 */
        borderRadius: '15px 11px 17px 13px / 12px 17px 11px 15px',
        boxShadow: [
            /* 内阴影 = 做旧/毛边：两层，外圈大面积泛黄，内圈压一道暗边 */
            'inset 0 0 46px rgba(152,120,68,0.20)',
            'inset 0 0 9px rgba(122,94,52,0.16)',
            /* 外投影把纸从深色背景里托起来 */
            '0 22px 58px rgba(0,0,0,0.55)',
        ].join(', '),
        overflow: 'hidden',
    };

    /* 纸张纹理：极淡的横向格线。40px 一格，和正文的 lineHeight(20px×2.0) 对齐 */
    const ruling: CSSProperties = {
        position: 'absolute',
        inset: 0,
        backgroundImage:
            'repeating-linear-gradient(to bottom, rgba(96,118,140,0) 0px, rgba(96,118,140,0) 39px, rgba(96,118,140,0.15) 39px, rgba(96,118,140,0.15) 40px)',
        backgroundPosition: '0 0',
        pointerEvents: 'none',
    };

    return (
        <div
            /* ★ UI.tsx 最外层是 pointerEvents:'none'，这里必须显式打开。
               挂在整个遮罩上（而不是只挂在纸上）：反正遮罩已经把点击吞掉了，
               让「吞掉但什么都不做」变成「推进一行」严格更好 —— 玩家不用瞄准。 */
            onPointerDown={(e) => {
                /* 别让点击穿透到 3D 画布 —— 那里有指针锁定 / 拖拽视角的监听，
                   写信时不该转镜头。 */
                e.stopPropagation();
            }}
            onClick={(e) => {
                e.stopPropagation();
                onAdvance();
            }}
            style={{
                position: 'fixed',
                inset: 0,
                pointerEvents: 'auto',
                cursor: allShown && !closing ? 'pointer' : 'default',
                /* 轻微压暗背景，把注意力收到信纸上。径向渐变比纯色更柔和 */
                background: closing
                    ? 'transparent'
                    : 'radial-gradient(ellipse at center, rgba(6,10,22,0.34) 0%, rgba(4,7,16,0.62) 100%)',
                transition: 'background 600ms ease',
                zIndex: 40,
                userSelect: 'none',
                overflow: 'hidden',
            }}
        >
            <style>{KEYFRAMES}</style>

            {/* ══════════ 信纸 ══════════ */}
            <div style={paperWrap}>
                <div style={paperFold}>
                    <div style={paperFace}>
                        <div style={ruling} />

                        {/* ── 贴上去的 NPC 头像 ────────────────────────
                            多收件人（如林尼/琳妮特/菲米尼）就横排贴多个。
                            每张带一点随机角度的倾斜 + 一小条胶带，才像「贴」的不是「印」的。 */}
                        <div
                            style={{
                                position: 'absolute',
                                top: 16,
                                right: 18,
                                display: 'flex',
                                gap: 8,
                                alignItems: 'flex-start',
                            }}
                        >
                            {portraits.map((p, i) => {
                                /* 固定序列而不是随机：同一封信每次重渲染角度都得一样，
                                   否则头像会自己扭来扭去 */
                                const tilt = [-4, 3, -2, 4, -3][i % 5];
                                return (
                                    <div
                                        key={p.id}
                                        title={p.name}
                                        style={{
                                            position: 'relative',
                                            width: 68,
                                            height: 68,
                                            borderRadius: '50%',
                                            overflow: 'hidden',
                                            background: '#fdfaf2',
                                            /* 白描边 + 一圈淡淡的投影 = 相纸贴在纸上的厚度 */
                                            border: '3px solid #fffdf7',
                                            boxShadow: '0 3px 9px rgba(60,45,20,0.32)',
                                            transform: `rotate(${tilt}deg)`,
                                        }}
                                    >
                                        <img
                                            src={p.url}
                                            alt={p.name}
                                            width={68}
                                            height={68}
                                            style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
                                        />
                                        {/* 一小条胶带：半透明白，压在头像上沿 */}
                                        <div
                                            style={{
                                                position: 'absolute',
                                                top: -3,
                                                left: '50%',
                                                width: 30,
                                                height: 11,
                                                marginLeft: -15,
                                                background: 'rgba(255,252,238,0.62)',
                                                boxShadow: '0 1px 3px rgba(80,60,30,0.18)',
                                                transform: `rotate(${-tilt * 0.7}deg)`,
                                            }}
                                        />
                                    </div>
                                );
                            })}
                        </div>

                        {/* ── 正文区 ─────────────────────────────── */}
                        <div
                            style={{
                                position: 'absolute',
                                inset: 0,
                                padding: '34px 52px 64px',
                                display: 'flex',
                                flexDirection: 'column',
                                fontFamily: PAPER_FONT,
                                color: '#2f2a22',
                            }}
                        >
                            {/* 抬头：「给谁的」 */}
                            <div
                                style={{
                                    fontSize: 23,
                                    lineHeight: 1.7,
                                    letterSpacing: '0.06em',
                                    marginBottom: 14,
                                    animation: 'lp-line-in 380ms ease-out',
                                }}
                            >
                                {letter.to}：
                            </div>

                            {/* 正文：只渲染前 writingLine 行。key 用下标 ——
                                内容不变、只是往后追加，用下标才能保证老行不重挂载
                                （重挂载 = 重播浮现动画 = 满屏字乱闪）。

                                ⚠️ 这里必须是 minHeight 而不是 height。lines 里的句子
                                长短不一，长句在信纸宽度下会折成 2~3 个视觉行；写死 height: 40
                                的话盒子不跟着长，折行部分会**直接压到下一行身上**（肉眼看
                                就是两行字叠在一起糊成一团）。minHeight 保住了单行的行距，
                                折行时又能撑开。 */}
                            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                                {shown.map((line, i) => (
                                    <div
                                        key={i}
                                        style={{
                                            fontSize: 20,
                                            lineHeight: 2.0,
                                            minHeight: 40,
                                            letterSpacing: '0.03em',
                                            animation: 'lp-line-in 340ms ease-out',
                                        }}
                                    >
                                        {line}
                                    </div>
                                ))}
                            </div>

                            {/* 落款：正文全出来之后才淡入 */}
                            {allShown && (
                                <div
                                    style={{
                                        alignSelf: 'flex-end',
                                        fontSize: 19,
                                        lineHeight: 1.8,
                                        marginTop: 10,
                                        opacity: 0.9,
                                        animation: 'lp-line-in 620ms ease-out 120ms both',
                                    }}
                                >
                                    {SIGNATURE}
                                </div>
                            )}
                        </div>

                        {/* ── 右下角提示 ─────────────────────────── */}
                        <div
                            style={{
                                position: 'absolute',
                                right: 26,
                                bottom: 18,
                                fontFamily: PAPER_FONT,
                                fontSize: 15,
                                letterSpacing: '0.08em',
                                color: allShown ? '#9a7b3c' : '#8b8578',
                                animation: allShown
                                    ? 'lp-line-in 400ms ease-out'
                                    : `lp-blink 1.5s ease-in-out infinite`,
                            }}
                        >
                            {allShown ? '点击，把信收进信封' : '点击继续'}
                        </div>
                    </div>
                </div>
            </div>

            {/* ══════════ 信封 ══════════
                只在**纸折完之后**才登场（phase 到 'fly' 才挂）。
                ⚠️ 别用 `closing`（= phase !== 'idle'）当条件 —— 那会在 phase='fold'
                的**第一帧**就把信封挂上去，于是整段对折过程里信封一直盖在信纸上，
                看起来像"信纸还没折就已经在信封里了"（第一版验收截图就是这么翻车的）。
                外层管「入场 + 淡出」，内层管「抖」——
                拆两层是因为两个 keyframes 都写 animation 会互相覆盖重启。 */}
            {(phase === 'fly' || phase === 'seal' || phase === 'shake' || phase === 'out') && (
                <div
                    style={{
                        position: 'absolute',
                        left: '50%',
                        top: '58%',
                        width: 260,
                        height: 172,
                        /* translate(-50%,-50%) 由 keyframes 负责（含入场位移），
                           这里给个静态兜底值，动画跑完后 CSS 不会跳 */
                        transform: 'translate(-50%, -50%)',
                        opacity: phase === 'out' ? 0 : 1,
                        transition: `opacity ${T_OUT}ms ease-in`,
                        animation: 'lp-env-in 420ms cubic-bezier(.2,.9,.3,1.1)',
                    }}
                >
                    <div
                        style={{
                            position: 'relative',
                            width: '100%',
                            height: '100%',
                            animation: phase === 'shake' ? `lp-shake ${T_SHAKE}ms ease-in-out` : undefined,
                        }}
                    >
                        {/* 信封本体 */}
                        <div
                            style={{
                                position: 'absolute',
                                inset: 0,
                                background: 'linear-gradient(158deg, #f2e8d2 0%, #e6d9ba 55%, #d8c8a4 100%)',
                                border: '2px solid #b8a377',
                                borderRadius: 5,
                                boxShadow: '0 18px 44px rgba(0,0,0,0.5)',
                                /* 正面的两道折痕：左下→右上、右下→左上，交叉成信封的 X */
                                backgroundImage: [
                                    'linear-gradient(to top right, rgba(150,128,86,0) 49.4%, rgba(150,128,86,0.35) 49.4%, rgba(150,128,86,0.35) 50.6%, rgba(150,128,86,0) 50.6%)',
                                    'linear-gradient(to top left, rgba(150,128,86,0) 49.4%, rgba(150,128,86,0.35) 49.4%, rgba(150,128,86,0.35) 50.6%, rgba(150,128,86,0) 50.6%)',
                                    'linear-gradient(158deg, #f2e8d2 0%, #e6d9ba 55%, #d8c8a4 100%)',
                                ].join(', '),
                            }}
                        />

                        {/* 收件人：写在信封正面，玩家能确认「这封是给谁的」 */}
                        <div
                            style={{
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                top: '46%',
                                textAlign: 'center',
                                fontFamily: PAPER_FONT,
                                fontSize: 19,
                                color: '#4a3d28',
                                letterSpacing: '0.08em',
                                pointerEvents: 'none',
                            }}
                        >
                            {letter.to}
                        </div>

                        {/* 翻盖：CSS border 三角。挂载时是「掀开」的（rotateX 180°），
                            火漆盖下去之前合上 —— 顺序反了会看起来像先封后开。 */}
                        <div
                            style={{
                                position: 'absolute',
                                top: -2,
                                left: -2,
                                width: 0,
                                height: 0,
                                borderLeft: '130px solid transparent',
                                borderRight: '130px solid transparent',
                                borderTop: '88px solid #e9dbba',
                                transformOrigin: '50% 0%',
                                transform: `perspective(620px) rotateX(${phase === 'fly' ? 180 : 0}deg)`,
                                transition: 'transform 300ms ease-in',
                                filter: 'drop-shadow(0 2px 3px rgba(90,70,35,0.28))',
                            }}
                        />

                        {/* 月亮火漆：0 → 过冲 → 回弹地「啪」一下盖在翻盖尖上 */}
                        {phase !== 'fly' && (
                            <img
                                src={sealUrl}
                                alt="月亮火漆"
                                width={78}
                                height={78}
                                style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: 48,
                                    marginLeft: -39,
                                    animation: `lp-seal-pop ${T_SEAL}ms cubic-bezier(.2,1.5,.4,1) both`,
                                    pointerEvents: 'none',
                                }}
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

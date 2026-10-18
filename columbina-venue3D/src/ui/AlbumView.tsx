/**
 * AlbumView —— 全屏相册（切蛋糕合影 + 玩家拍的照片）。
 *
 * ── 为什么 F / Esc 监听走**捕获阶段** ────────────────────────────────
 * `core/game/interact.ts` 在 window **冒泡**阶段监听 KeyF 并 `fireInteract()`。
 * 相册是全屏遮罩，此刻按 F 只应该关相册，绝不能顺手把身后那个 NPC 又触发一次。
 * `addEventListener('keydown', h, true)` + `stopPropagation()` 能在捕获阶段就截住事件：
 * window 既是捕获链的第一站、也是冒泡链的最后一站，所以捕获永远先跑，
 * 而捕获阶段的 stopPropagation 会直接掐掉整条后续路径（含 window 自己的冒泡监听）。
 * 同一套写法见 `ui/PhotoView.tsx` 与 `ui/DialogBox.tsx`，别改成 false。
 *
 * ── 为什么放大态要先吃掉一次 F / Esc ─────────────────────────────────
 * 玩家点开一张照片后，F 的直觉含义是「退出放大」而不是「关掉整个相册」。
 * 所以 handler 里先看 `big`，非 null 只退出放大；再按一次才关相册。
 * 因为 handler 依赖 `big`，effect 的依赖数组里必须带上它 —— 否则永远读到旧的 null。
 *
 * ── 为什么合影那张必须有 onError 兜底 ───────────────────────────────
 * `/venue/game/photo_feast.png` 是切蛋糕时**烘出来**的，进相册时可能还没落盘。
 * 没有兜底就是浏览器默认的破图图标 + alt 文字，整块网格的观感直接垮掉。
 * 这里换成一个等尺寸（同样 16/10）的占位块，网格不会因为一张图加载失败而跳动。
 *
 * ── ★ 2026-10-18 用户任务5：合影要「切完蛋糕」才准看 ──────────────────
 * 之前合影卡是**无条件**拼在 `cards` 第一位的，而 `/venue/game/photo_feast.png`
 * 是打进 `public/` 的静态图：任务还没做完，玩家开局就能在相册里看到它，
 * 等于把结局透了。现在的解锁判据是 `questStore.cakeCut` ——
 *   · **不用 `phase`**：`phase === 'feast'` 的含义是「14 个委托全部交完」，
 *     跟「切了蛋糕没有」没有关系；`phase === 'done'` 更糟，它在
 *     `questStore.ts:299` / `:380` 等几处都被当成「宴会中」（`feasting`）用，
 *     所以 `feast` 与 `done` 这两个值**都不能**代表「切蛋糕完成」。
 *   · **不用 `photoSeen`**：那是「看过合影」，而 `closePhoto` 对**任意**一张合影
 *     都会置 true（`questStore.ts:242-247`），拿它当判据等于开局点开再关掉就解锁。
 *   · **用 `cakeCut`**：它只由 `cutCake()` 一处置位（`questStore.ts:226`，切蛋糕的
 *     真实交互里调），并且 `questLines()` 的 q_cake 条目也拿它当 `done` 判据
 *     （`questStore.ts:344-346`）—— 同一个字段，任务列表与相册口径一致。
 * 未解锁时既不占位、也不显示破图占位块，直接用「相册空态」。
 *
 * ── ★ 2026-10-18 用户任务4：关闭时要把指针锁要回来 ─────────────────────
 * 见 `useFollowCamera.ts` 里 `requestPointerLockNow()` 的长注释：
 * 「关闭」只解冻不够，必须在**同一次手势**里重新请求指针锁，否则玩家会停在
 * 「光标露在外面」的状态里，进而镜头被鼠标拖着走、角色还能跑出画面。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useGameStore2 } from '../core/game/questStore';
import { requestPointerLockNow } from '../components/camera/hooks/useFollowCamera';

/** 切蛋糕合影：全流程固定第一张，不在 `shots` 里（它由场景烘出来，不是玩家拍的）。 */
const FEAST_URL = '/venue/game/photo_feast.png';

/** 合影卡片的暖金描边 —— 跟 QuestList 的进度徽章、PhotoView 的相纸同一套强调色。 */
const GOLD = 'rgba(232,216,168,0.55)';

/** 普通照片卡片的描边。 */
const PLAIN = 'rgba(255,255,255,0.12)';

interface Card {
    key: string;
    url: string;
    caption: string;
    /** 合影卡：暖金描边 + 单独的兜底文案。 */
    feast: boolean;
}

/** 占位块：尺寸必须和真图一致（16/10），否则加载失败时整行卡片会矮一截。 */
const placeholderStyle: CSSProperties = {
    width: '100%',
    aspectRatio: '16 / 10',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(10, 12, 18, 0.9)',
    color: '#8a93a8',
    fontSize: 13,
    letterSpacing: 1,
};

/** 相册空态（★ 2026-10-18 任务5：合影没解锁、也还没拍过照时走到这里）。
 *  刻意复用标题副标那套灰蓝（`#9aa6bd` + 小字号 + 字距），不另起一套配色 ——
 *  用户要的是「按现有空态处理」，不是新做一屏插画。 */
const emptyStyle: CSSProperties = {
    gridColumn: '1 / -1',
    padding: '34px 4px',
    color: '#9aa6bd',
    fontSize: 13,
    lineHeight: 2,
    letterSpacing: 1,
    whiteSpace: 'pre-line',
};

const closeBtnStyle = {
    color: '#e6ebf5',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    backdropFilter: 'blur(4px)',
    border: '1px solid rgba(255,255,255,0.1)',
    transition: 'all 0.2s ease',

    '&:hover': {
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        borderColor: 'rgba(255,255,255,0.3)',
    },
} as const;

export function AlbumView() {
    const albumOpen = useGameStore2((s) => s.albumOpen);
    const closeAlbum = useGameStore2((s) => s.closeAlbum);
    const shots = useGameStore2((s) => s.shots);
    /* ★ 2026-10-18 任务5：切蛋糕合影的解锁判据 —— 只在切蛋糕真正发生过之后才进相册。
       为什么是 `cakeCut` 而不是 `phase` / `photoSeen`，见文件头那段长注释。 */
    const cakeCut = useGameStore2((s) => s.cakeCut);

    /** 关闭相册 = 关界面 + **把指针交还 FPS 视角**。
     *  ★ 2026-10-18 任务4：两步必须写在同一个 handler 里。`closeAlbum()` 只是同步改了
     *  store，`PointerHold` 释放占用、`useFollowCamera` 请求指针锁都要等到 React 提交
     *  之后（早就不在本次 click/keydown 的手势窗口里了），Chrome 那边会直接拒。
     *  所以这里在**同一个手势**里补一次 `requestPointerLockNow()`。
     *  重复调用是安全的：已锁 / ALT 还按着 / 还压着别的界面，它都会自己 bail。 */
    const closeAndRelock = () => {
        closeAlbum();
        requestPointerLockNow();
    };

    /** 放大中的图片地址；null = 没在放大。 */
    const [big, setBig] = useState<string | null>(null);
    /** 鼠标当前悬停的卡片下标。内联样式没有 :hover，只能自己记一个（-1 = 没悬停）。 */
    const [hover, setHover] = useState(-1);
    /** 合影加载失败。**只跟踪这一张**：玩家拍的照片是内存里的 dataURL，不可能加载失败；
     *  而用下标当 key 去记失败会出错 —— `shots` 是「新的插到最前面」，
     *  上一轮失败的 `shot-0` 会平白把刚拍的那张也标成坏图。 */
    const [feastBroken, setFeastBroken] = useState(false);

    useEffect(() => {
        // 没打开就不挂监听，免得平白多一个全局 keydown 抢 F 键
        if (!albumOpen) return;

        const onKey = (e: KeyboardEvent) => {
            if (e.repeat) return;

            // code 是物理键位，key 兜底（某些输入法/远程桌面下 code 会缺）
            const isEsc = e.code === 'Escape' || e.key === 'Escape';
            const isF = e.code === 'KeyF';
            if (!isEsc && !isF) return;

            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;

            // 捕获阶段截胡，别让 interact.ts 的冒泡监听再 fireInteract 一次
            e.preventDefault();
            e.stopPropagation();

            // 先退放大，再关相册（理由见文件头）
            if (big !== null) {
                setBig(null);
                return;
            }
            /* ★ 2026-10-18 任务4：F / Esc 关闭这一路同样要在**本次 keydown 里**要回指针锁
               （延迟到 effect 里就丢手势窗口了，理由见 `closeAndRelock` 的注释）。
               这里不用 `closeAndRelock`：它的引用每次渲染都变，会把这个 effect 变成
               每次重渲染都重挂一次监听 —— 而 `closeAlbum` / `requestPointerLockNow`
               都是模块级稳定引用，直接内联调用更省事。 */
            closeAlbum();
            requestPointerLockNow();
        };

        // true = 捕获阶段，别改
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [albumOpen, big, closeAlbum]);

    // 相册关掉时顺手清掉放大态和加载失败记录。
    // 放大态：组件只是 return null 并没有卸载，不清的话下次打开会直接顶着一张全屏大图。
    // 失败记录：合影是切蛋糕时才烘出来的，第一次打开相册可能刚好还没落盘 ——
    // 那种失败必须能在下次打开时重试，否则一次 404 就会让「合影生成中…」永久卡住。
    useEffect(() => {
        if (!albumOpen) {
            setBig(null);
            setFeastBroken(false);
        }
    }, [albumOpen]);

    if (!albumOpen) return null;

    const total = shots.length;

    /* ★ 2026-10-18 任务5：合影只有在 `cakeCut` 之后才拼进第一张。
       未解锁时连占位块都不给 —— 它要是出现，「相册里有东西」这件事本身就把结局透了。 */
    const cards: Card[] = [
        ...(cakeCut
            ? [{ key: 'feast', url: FEAST_URL, caption: '切蛋糕合影', feast: true }]
            : []),
        // shots 里最新的在最前面，所以第 i 张是「第 total - i 张」
        ...shots.map((url, i) => ({
            key: `shot-${i}`,
            url,
            caption: `第 ${total - i} 张`,
            feast: false,
        })),
    ];

    return (
        <>
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(6, 8, 14, 0.94)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                    zIndex: 70,
                    // auto：把点击全吃掉，别漏到后面的 3D 画布上（否则点照片会转相机）
                    pointerEvents: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    color: '#e6ebf5',
                    userSelect: 'none',
                }}
            >
                {/* 顶部标题栏 */}
                <div
                    style={{
                        flex: '0 0 auto',
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        padding: '20px 26px 14px',
                    }}
                >
                    <div>
                        <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 2 }}>相册</div>
                        <div style={{ marginTop: 4, fontSize: 12, color: '#9aa6bd' }}>
                            Esc 或 F 也可关闭
                        </div>
                    </div>

                    <IconButton sx={closeBtnStyle} onClick={closeAndRelock} aria-label="关闭相册">
                        <CloseIcon sx={{ fontSize: '24px' }} />
                    </IconButton>
                </div>

                {/* 内容网格：flex:1 + minHeight:0 才能让 overflowY 真正生效
                    （flex 子项默认 min-height:auto，不给 0 的话它会撑破容器、滚动条永远不出现） */}
                <div
                    style={{
                        flex: '1 1 auto',
                        minHeight: 0,
                        overflowY: 'auto',
                        padding: '0 26px 26px',
                    }}
                >
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                            gap: 14,
                        }}
                    >
                        {/* ★ 2026-10-18 任务5：空态。合影没解锁、玩家也还没拍过照时会走到这里
                            （开局点相册就是这一屏）。以前这里是一片纯空白，看起来像加载失败。 */}
                        {cards.length === 0 && (
                            <div style={emptyStyle}>
                                {'相册还是空的。\n切完蛋糕之后，生日宴的合影会收进这里；平时也可以随手拍几张。'}
                            </div>
                        )}

                        {cards.map((c, i) => {
                            const isHover = hover === i;
                            // 只有合影那张需要兜底（理由见 feastBroken 的注释）
                            const isBroken = c.feast && feastBroken;

                            return (
                                <div
                                    key={c.key}
                                    onMouseEnter={() => setHover(i)}
                                    // 只在「确实是我被悬停」时才清，避免快速划过时把后一张的悬停态误清掉
                                    onMouseLeave={() => setHover((h) => (h === i ? -1 : h))}
                                    onClick={() => {
                                        // 破图不放大：放出来也是一块空白，不如让点击什么都不做
                                        if (!isBroken) setBig(c.url);
                                    }}
                                    style={{
                                        border: `1px solid ${
                                            c.feast ? GOLD : isHover ? 'rgba(255,255,255,0.55)' : PLAIN
                                        }`,
                                        borderRadius: 8,
                                        overflow: 'hidden',
                                        background: 'rgba(255,255,255,0.03)',
                                        // 破图时不给放大光标 —— 光标的承诺要和点击的结果一致
                                        cursor: isBroken ? 'default' : 'zoom-in',
                                        transition: 'border-color 0.18s ease, transform 0.18s ease',
                                        transform: isHover ? 'translateY(-2px)' : 'none',
                                    }}
                                >
                                    {isBroken ? (
                                        <div style={placeholderStyle}>合影生成中…</div>
                                    ) : (
                                        <img
                                            src={c.url}
                                            alt={c.caption}
                                            onError={() => {
                                                if (c.feast) setFeastBroken(true);
                                            }}
                                            style={{
                                                display: 'block',
                                                width: '100%',
                                                aspectRatio: '16 / 10',
                                                objectFit: 'cover',
                                                background: '#0a0c12',
                                            }}
                                        />
                                    )}

                                    {/* 图下标注 */}
                                    <div
                                        style={{
                                            padding: '7px 9px',
                                            fontSize: 12,
                                            color: c.feast ? '#e8d8a8' : '#9aa6bd',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                        }}
                                    >
                                        {c.caption}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* 放大层：点任意处退出 */}
            {big !== null && (
                <div
                    onClick={() => setBig(null)}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.9)',
                        zIndex: 80,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'auto',
                        cursor: 'zoom-out',
                    }}
                >
                    <img
                        src={big}
                        alt="照片"
                        style={{ maxWidth: '86vw', maxHeight: '86vh', borderRadius: 10 }}
                    />
                </div>
            )}
        </>
    );
}

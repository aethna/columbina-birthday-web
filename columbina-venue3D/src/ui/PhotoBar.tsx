/**
 * PhotoBar —— 右下角的两个圆形按钮（拍照 / 相册）。
 *
 * ── 为什么这里可以有 onClick，而场景里其他东西不行 ──────────────────
 * 用户 m02646 逐字：「除了我明确说明的可以点击鼠标外，其余所有功能全部指定只能按 F 键」。
 * 这两个按钮正是他明确要求做出来的「可点击 UI」，所以点击是**被授权**的交互。
 * 但授权只覆盖这两个按钮本身 —— 别顺手给它们再绑 F 键：F 键在场景里已经被
 * `core/game/interact.ts` 的互动系统占着（对话 / 收信 / 收合影），再绑一次会互相抢事件。
 *
 * ── Z 键（用户任务6）─────────────────────────────────────────────────
 * 拍照另给了一个键盘快捷键 Z：全仓库此前没有任何 `KeyZ`，也不和 WASD / Shift / F 冲突。
 * 它和按钮走**同一个 `doSnap`**，所以「这一帧没拍成就不弹提示」不会两条路各说一套。
 * 不进 `core/input/controls.ts` 的 keyBindings：那套是电平式（按住连拍 + 依赖指针锁），
 * 拍照要的是 keydown 边沿。
 *
 * ── 为什么相册打开时整条工具栏 return null ──────────────────────────
 * 相册是全屏遮罩（zIndex 70），本组件是 zIndex 55。留着也不会盖住相册，
 * 但会**浮在相册右下角**压住网格里的照片 —— 而且「相册里再点相册」本身就没意义。
 * 直接不渲染，比改 zIndex 干净。
 *
 * ── 为什么用 row-reverse ───────────────────────────────────────────
 * 容器贴着 right:12 定位，`row-reverse` 让**第一个 DOM 子元素落在最右边**。
 * 于是「拍照」始终贴着屏幕角落 —— 主操作不随相册张数变化而漂移。
 *
 * ── 两个测试按钮（用户任务15）────────────────────────────────────────
 * 用户原话：「增加测试按钮，放置于右下角。有 2 个按钮：一个是初始化：功能是
 * 清除所有进度，回退至游戏开始。一个是完成当前任务（只完成任务列表里已经接的委托/任务）。」
 *   · 初始化 = `questStore.reset()` + 清互动/小地图指引 + 传送回出生点；
 *   · 完成当前任务 = `questStore.finishAcceptedQuests()`（只碰已接取未交付的）。
 * 放在本容器里（`row-reverse` ⇒ 排到相册左边，不占主操作位置），并给
 * `?testbtns=0` 开关：正式版可以整组关掉，不必改代码。
 * ⚠️ 用 `QSTR(...) !== '0'` 而不是 `QFLAG(...)` —— 后者没有默认值参数，
 *    缺省会被判成 false，等于把按钮默认关掉了。
 */
import { type CSSProperties, useCallback, useEffect } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import { useGameStore2 } from '../core/game/questStore';
import { useGameStore } from '../core/store/gameStore';
import { snapPhoto } from '../components/game/PhotoSnap';
import { clearNearest } from '../core/game/interact';
import { SPAWN_XZ, SPAWN_YAW } from '../core/game/layout';
import { QUESTS } from '../core/game/copy';
import { setGuide, setQuestArrow } from './guideState';
import { QSTR } from '../core/utils/query';

/** 徽标数字上限：超过 99 一律显示 99+，否则三位数会把徽标撑宽、顶出按钮外。 */
const BADGE_MAX = 99;

/** 拍照提示停留时长（毫秒）。比切场景提示（4 s）短：它只是「快门按到了」的确认。 */
const SNAP_TOAST_MS = 2000;

/** 测试按钮的提示时长：比拍照稍长，因为「已交付 N 条」要看清数字。 */
const TEST_TOAST_MS = 3000;

/** 测试按钮开关：`?testbtns=0` 关掉整组（缺省开）。见文件头「两个测试按钮」。 */
const SHOW_TEST_BTNS = QSTR('testbtns') !== '0';

/** 跟 `SideBar.tsx` 的 btnStyle 同一套视觉：深色半透明 + backdrop blur。 */
const btnStyle = {
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    backdropFilter: 'blur(4px)',
    // 圆形（用户要的是两个圆按钮），但底色/描边/hover 全部沿用 SideBar 那套
    borderRadius: '50%',
    padding: '10px',
    border: '1px solid rgba(255,255,255,0.1)',
    transition: 'all 0.2s ease',
    color: 'white',

    '&:hover': {
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        borderColor: 'rgba(255,255,255,0.3)',
    },
} as const;

const iconStyle = { fontSize: '24px' } as const;

/* 测试按钮（用户任务15）与上面两个主按钮同一套底，但用**虚线描边 + 小一号图标**
 * 让它们在视觉上「明显不是玩法的一部分」：玩家不该把它们当成正常功能去点。 */
const testBtnStyle = {
    ...btnStyle,
    padding: '8px',
    border: '1px dashed rgba(255,255,255,0.22)',
} as const;

const testIconStyle = { fontSize: '20px' } as const;

/** 张数徽标：暖金小胶囊，和 QuestList 的进度徽章 / PhotoView 的相纸是同一套强调色。 */
const badgeStyle: CSSProperties = {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 18,
    height: 18,
    padding: '0 4px',
    boxSizing: 'border-box',
    borderRadius: 9,
    background: '#e8d8a8',
    color: '#1b1608',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: '16px', // 16 = 18 - 上下各 1px 描边（box-sizing: border-box）
    textAlign: 'center',
    border: '1px solid rgba(0,0,0,0.35)',
    // 徽标只是装饰：让点击落在下面的 IconButton 上，别被它截胡
    pointerEvents: 'none',
};

export function PhotoBar() {
    const shots = useGameStore2((s) => s.shots);
    const albumOpen = useGameStore2((s) => s.albumOpen);
    /* ★ 2026-10-18 用户任务5：徽标上的张数必须和相册里真能看到的一致。
       合影要等切蛋糕之后才进相册（判据与理由见 `AlbumView.tsx` 文件头），
       所以这里也只有 `cakeCut` 为真时才算那一张 —— 否则开局徽标写着「1 张」、
       点进去却只有一块空态，等于自己打自己的脸。 */
    const cakeCut = useGameStore2((s) => s.cakeCut);
    const openAlbum = useGameStore2((s) => s.openAlbum);
    const showToast = useGameStore2((s) => s.showToast);

    /* ★ 2026-10-20 任务6：按钮和 Z 键走**同一条链路**，所以「没拍成就不弹提示」
       这条行为天然一致 —— 不要在键位回调里另写一遍 snapPhoto + showToast。 */
    const doSnap = useCallback(() => {
        // snapPhoto 返回 false = 这一帧没拍成（比如还没进入场景），此时不该骗玩家说「已拍照」
        const ok = snapPhoto();
        /* 2 s（用户任务5）：提示只是确认「快门按到了」，2 s 足够读完又不挡视线。
           消失由 `questStore.showToast` 的定时器负责，调用方不用自己 clear。 */
        if (ok) showToast('已拍照', '相册里可以查看', SNAP_TOAST_MS);
    }, [showToast]);

    /* ★ Z 键拍照。为什么这么挂（而不是塞 `core/input/controls.ts` 的 keyBindings）：
     *  ① 那是**电平式**输入 —— 每帧读 `isPressed`，按住 Z 会连拍，而且要先拿到
     *     pointer lock 才生效；拍照是「按一次 = 一张」，必须走 keydown 边沿 + `e.repeat`。
     *  ② 监听挂在 window 冒泡阶段，和 `core/game/interact.ts` 的 F 键同一层级、同一套
     *     「输入框聚焦就不抢键」的守卫。相册里 F 键那条（`AlbumView.tsx`）在捕获阶段
     *     只拦 Esc/F，Z 会继续冒泡下来，所以这里必须自己再挡一次 `albumOpen`。
     *  ③ 本组件在 `albumOpen` 时 `return null`，但 **hooks 之前不能提前 return**
     *     —— 所以这段必须放在下面那个早退之前。 */
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            // 物理键位优先，key 兜底（中文输入法 / 远程桌面下 code 有时缺）
            if (e.code !== 'KeyZ' && e.key !== 'z' && e.key !== 'Z') return;
            // 按住不放只算第一下
            if (e.repeat) return;
            // 带修饰键的组合还给浏览器（Ctrl/Cmd+Z 撤销）
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            // 有输入框聚焦时不要抢键（和 interact.ts 的 F 键同一条规则）
            const el = document.activeElement as HTMLElement | null;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
            // 相册（全屏遮罩）或大图查看时不该在背后偷偷拍照
            const s = useGameStore2.getState();
            if (s.albumOpen || s.photo) return;
            e.preventDefault();
            doSnap();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [doSnap]);

    /* ★ 2026-10-20 任务15：测试按钮①「初始化」。
     * 顺序有讲究：先 `reset()`（它内部会 `stopToastTimer()` 并清 toast），
     * 再弹提示 —— 反过来的话提示会被 reset 一起抹掉。
     * 传送用 `characterRef`（`MmdCharacter` 登记的哥伦比娅本体，可能是 null）：
     * 只改 x/z 与朝向，**保留 y** —— y 由地形贴地逻辑每帧写，这里硬塞会掉进地下。 */
    const doTestReset = useCallback(() => {
        useGameStore2.getState().reset();
        // 互动高亮/提示还指着上一个可交互对象，不清会留一个「对着空气按 F」的圈
        clearNearest();
        // 小地图指引与世界内委托箭头都是模块级容器，不受 store.reset() 管辖
        setGuide(null);
        setQuestArrow(null);

        const c = useGameStore.getState().characterRef?.current;
        if (c) {
            c.position.set(SPAWN_XZ[0], c.position.y, SPAWN_XZ[1]);
            c.rotation.y = SPAWN_YAW;
        }

        showToast('已初始化', '进度已清空，回到出生点', TEST_TOAST_MS);
    }, [showToast]);

    /* ★ 任务15：测试按钮②「完成当前任务」。
     * 真正的结账逻辑在 `questStore.finishAcceptedQuests()`（只有那里同时知道
     * `collected` 与 `picked` 两本账、以及 `pointXZ` 的实例数）；这里只负责
     * 「先数一数有没有活干」和给玩家一句人话。
     * 凑满 14 条时**不在这里切场景**：store 只记 `pendingFeast`，
     * `GameLayer` 的兜底 effect 会在没有对话时兑现（本按钮不开对话）。 */
    const doTestFinish = useCallback(() => {
        const st = useGameStore2.getState();
        const todo = st.accepted.filter((id) => !st.delivered.includes(id)).length;
        if (todo === 0) {
            showToast('没有进行中的委托', '先去和 NPC 聊聊接委托', TEST_TOAST_MS);
            return;
        }
        st.finishAcceptedQuests();
        const after = useGameStore2.getState();
        showToast(
            `已交付 ${todo} 条委托`,
            `总进度 ${after.delivered.length}/${QUESTS.length}`,
            TEST_TOAST_MS,
        );
    }, [showToast]);

    // 相册打开时整条工具栏让位（理由见文件头）
    if (albumOpen) return null;

    // +1 = 切蛋糕合影（**解锁后**才算）。它不进 shots（由场景在切蛋糕时烘出来）
    const count = shots.length + (cakeCut ? 1 : 0);
    /* 一张都没有时就别念「（0 张）」了 —— 那是把内部计数念给玩家听 */
    const albumLabel = count > 0 ? `相册（${count} 张）` : '相册';
    const badgeText = count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);


    return (
        <div
            style={{
                position: 'fixed',
                right: '12px',
                bottom: '14px',
                display: 'flex',
                gap: '10px',
                flexDirection: 'row-reverse',
                // UI.tsx 最外层是 pointerEvents:'none'，这里必须显式打开，否则按钮点不动
                pointerEvents: 'auto',
                zIndex: 55,
            }}
        >
            {/* 拍照。Tooltip 里带上快捷键 —— 用户看不见 F12，但看得见鼠标悬停的提示 */}
            <Tooltip title="拍照（Z）" placement="top">
                <IconButton sx={btnStyle} onClick={doSnap} aria-label="拍照">
                    <PhotoCameraIcon sx={iconStyle} />
                </IconButton>
            </Tooltip>

            {/* 相册（带张数徽标）。Tooltip 必须直接包住 IconButton 才能拿到它的 ref，
                所以徽标挂在外面这层 relative 容器上，而不是塞进 Tooltip 里。 */}
            <div style={{ position: 'relative' }}>
                <Tooltip title={albumLabel} placement="top">
                    <IconButton sx={btnStyle} onClick={openAlbum} aria-label={albumLabel}>
                        <PhotoLibraryIcon sx={iconStyle} />
                    </IconButton>
                </Tooltip>

                {/* ★ 2026-10-18 任务5：count 现在可以是 0（合影没解锁、也还没拍过照）——
                    这时干脆不挂徽标，比挂一个「0」干净。 */}
                {count > 0 && (
                    <span style={badgeStyle} aria-hidden="true">
                        {badgeText}
                    </span>
                )}
            </div>

            {/* ★ 2026-10-20 任务15：两个测试按钮。`row-reverse` ⇒ DOM 越靠后显示越靠左，
                所以这里的顺序是「分隔线 → 完成当前任务 → 初始化」，屏幕上从左到右是
                「初始化 / 完成当前任务 / 分隔线 / 相册 / 拍照」，主操作仍在最右角。 */}
            {SHOW_TEST_BTNS && (
                <>
                    <div
                        aria-hidden="true"
                        style={{
                            width: 1,
                            alignSelf: 'stretch',
                            margin: '4px 2px',
                            background: 'rgba(255,255,255,0.12)',
                        }}
                    />
                    <Tooltip title="完成当前任务（只结算已接取的委托）" placement="top">
                        <IconButton
                            sx={testBtnStyle}
                            onClick={doTestFinish}
                            aria-label="完成当前任务"
                        >
                            <TaskAltIcon sx={testIconStyle} />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title="初始化（清空进度，回到出生点）" placement="top">
                        <IconButton sx={testBtnStyle} onClick={doTestReset} aria-label="初始化">
                            <RestartAltIcon sx={testIconStyle} />
                        </IconButton>
                    </Tooltip>
                </>
            )}
        </div>
    );
}

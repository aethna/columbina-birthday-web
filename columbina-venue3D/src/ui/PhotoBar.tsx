/**
 * PhotoBar —— 右下角的两个圆形按钮（拍照 / 相册）。
 *
 * ── 为什么这里可以有 onClick，而场景里其他东西不行 ──────────────────
 * 用户 m02646 逐字：「除了我明确说明的可以点击鼠标外，其余所有功能全部指定只能按 F 键」。
 * 这两个按钮正是他明确要求做出来的「可点击 UI」，所以点击是**被授权**的交互。
 * 但授权只覆盖这两个按钮本身 —— 别顺手给它们再绑 F 键：F 键在场景里已经被
 * `core/game/interact.ts` 的互动系统占着（对话 / 收信 / 收合影），再绑一次会互相抢事件。
 *
 * ── 为什么相册打开时整条工具栏 return null ──────────────────────────
 * 相册是全屏遮罩（zIndex 70），本组件是 zIndex 55。留着也不会盖住相册，
 * 但会**浮在相册右下角**压住网格里的照片 —— 而且「相册里再点相册」本身就没意义。
 * 直接不渲染，比改 zIndex 干净。
 *
 * ── 为什么用 row-reverse ───────────────────────────────────────────
 * 容器贴着 right:12 定位，`row-reverse` 让**第一个 DOM 子元素落在最右边**。
 * 于是「拍照」始终贴着屏幕角落 —— 主操作不随相册张数变化而漂移。
 */
import { type CSSProperties } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import { useGameStore2 } from '../core/game/questStore';
import { snapPhoto } from '../components/game/PhotoSnap';

/** 徽标数字上限：超过 99 一律显示 99+，否则三位数会把徽标撑宽、顶出按钮外。 */
const BADGE_MAX = 99;

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

    // 相册打开时整条工具栏让位（理由见文件头）
    if (albumOpen) return null;

    // +1 = 切蛋糕合影（**解锁后**才算）。它不进 shots（由场景在切蛋糕时烘出来）
    const count = shots.length + (cakeCut ? 1 : 0);
    /* 一张都没有时就别念「（0 张）」了 —— 那是把内部计数念给玩家听 */
    const albumLabel = count > 0 ? `相册（${count} 张）` : '相册';
    const badgeText = count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);

    const handleSnap = () => {
        // snapPhoto 返回 false = 这一帧没拍成（比如还没进入场景），此时不该骗玩家说「已拍照」
        const ok = snapPhoto();
        if (ok) showToast('已拍照', '相册里可以查看');
    };

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
            {/* 拍照 */}
            <Tooltip title="拍照" placement="top">
                <IconButton sx={btnStyle} onClick={handleSnap} aria-label="拍照">
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
        </div>
    );
}

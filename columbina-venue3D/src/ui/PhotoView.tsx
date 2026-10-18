/**
 * PhotoView —— 屏幕中央的合影查看（用户：「屏幕中央给出合影…按F收起合影」）。
 *
 * ── 鼠标：从「什么都不干」改成「点击收起」（用户 m00002，2026-10-17）──────
 * 用户 m02646 曾逐字收紧：「除了我明确说明的可以点击鼠标外，其余所有功能全部指定
 * 只能按 F 键」，当时放开的只有信纸收信与对话翻页两处，所以本组件一直是**零鼠标
 * handler**（`pointerEvents:'auto'` 只用来把点击吃掉，防它穿透到画布转相机）。
 *
 * 2026-10-17 用户 m00002 明确把这一处补进授权名单，逐字：「在所有需要鼠标按键互动的
 * 情况下（比如邀请函切下一张，哥伦比娅与 NPC 互动，**收起合影**等），强制唤起鼠标
 * 指针…」。既然要求在这里呼出指针，那指针出现后点一下必须**有反应** ——
 * 否则玩家看到的是一个能动、却点哪都不管用的光标，比不给光标更迷惑。
 * 所以这里补 `onClick={closePhoto}`，提示语同步改成「点击 / F 收起」。
 *
 * 遮罩仍用 `pointerEvents: 'auto'`：点击由本组件消费，不会漏到 3D 画布上
 * （否则玩家在合影上随手一点，后面的相机就跟着转了）。
 *
 * ── F 键为什么走捕获阶段 ─────────────────────────────────────────────
 * 同 `DialogBox.tsx`：`core/game/interact.ts` 在 window 冒泡阶段监听 KeyF 并 `fireInteract()`。
 * 合影是全屏遮罩，此刻按 F 应该只收起合影，绝不能顺手把身后那个 NPC 又触发一次。
 * `addEventListener('keydown', h, true)` + `stopPropagation()` 能在捕获阶段就截住事件 ——
 * window 既是捕获链的第一站、也是冒泡链的最后一站，所以捕获永远先跑。
 */
import { useEffect, type CSSProperties } from 'react';
import { useGameStore2 } from '../core/game/questStore';
import { requestPointerLockNow } from '../components/camera/hooks/useFollowCamera';

/** 「相纸」外框：暖色描边 + 暖色投影，让图片看起来像一张摆在夜色里的照片。 */
const FRAME: CSSProperties = {
    display: 'block',
    maxWidth: '78vw',
    maxHeight: '72vh',
    objectFit: 'contain',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.55)',
    boxShadow: '0 18px 60px rgba(0,0,0,0.72), 0 0 0 6px rgba(255,244,214,0.10), 0 0 44px rgba(232,216,168,0.22)',
    background: 'rgba(0,0,0,0.35)',
};

export function PhotoView() {
    const photo = useGameStore2((s) => s.photo);
    const closePhoto = useGameStore2((s) => s.closePhoto);

    /* ★ 2026-10-18 用户任务4：收起合影 = 关界面 + **把指针交还 FPS 视角**。
     * 必须和 `closePhoto()` 写在同一次手势里：等 React 提交后再由
     * `useFollowCamera` 的 effect 去请求锁，就已经不在 keydown/click 的手势窗口内了
     * （Chrome 会拒；刚被 Esc 解除过锁时还有一个 ~1.25 s 冷却窗口）。
     * 详细成因见 `useFollowCamera.ts` 里 `requestPointerLockNow()` 的注释。
     * 已锁 / ALT 还按着 / 还压着别的界面时它会自己 bail，所以两条关闭路径都直接调。 */
    const closeAndRelock = () => {
        closePhoto();
        requestPointerLockNow();
    };

    useEffect(() => {
        // 没在展示合影就不挂监听
        if (!photo) return;

        const onKey = (e: KeyboardEvent) => {
            if (e.repeat || e.code !== 'KeyF') return;
            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;

            // 捕获阶段截胡，别让 interact.ts 的冒泡监听再 fireInteract 一次
            e.preventDefault();
            e.stopPropagation();
            /* 任务4：这里直接内联两步而不用 `closeAndRelock` —— 那个闭包每次渲染都变，
               放进依赖数组会让监听每次重渲染都重挂；`closePhoto` / `requestPointerLockNow`
               都是稳定引用。 */
            closePhoto();
            requestPointerLockNow();
        };

        // true = 捕获阶段，别改
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [photo, closePhoto]);

    if (!photo) return null;

    return (
        <div
            onClick={closeAndRelock}
            style={{
                position: 'fixed',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 18,
                background: 'rgba(0,0,0,0.82)',

                // auto：点击由本组件的 onClick 消费，不会漏到 3D 画布转相机（见文件头）
                pointerEvents: 'auto',
                cursor: 'pointer', // 提示「这里可以点」——用户 m00002 要求弱化鼠标后，光标形态就是唯一的可见线索
                userSelect: 'none',
                zIndex: 60, // 全场最高：合影期间它盖住对话框/任务列表/侧栏按钮
                animation: 'photoFade 0.28s ease-out both',
            }}
        >
            {/* 进场动画：遮罩淡入 + 图片从 0.94 放大到 1。写在组件里，不动全局样式表 */}
            <style>{`
                @keyframes photoFade {
                    from { opacity: 0; }
                    to   { opacity: 1; }
                }
                @keyframes photoPop {
                    from { opacity: 0; transform: scale(0.94); }
                    to   { opacity: 1; transform: scale(1); }
                }
            `}</style>

            <img
                src={photo.url}
                alt={photo.caption || '合影'}
                style={{ ...FRAME, animation: 'photoPop 0.34s cubic-bezier(0.22, 1, 0.36, 1) both' }}
            />

            {/* 图下的说明文字 */}
            <div
                style={{
                    maxWidth: '78vw',
                    textAlign: 'center',
                    fontSize: 15,
                    lineHeight: 1.7,
                    color: '#e8d8a8',
                    textShadow: '0 2px 8px rgba(0,0,0,0.7)',
                }}
            >
                {photo.caption}
            </div>

            {/* 右下角收起提示 —— 鼠标与 F 都能收（用户 m00002 把这一处补进授权名单） */}
            <div
                style={{
                    position: 'fixed',
                    right: 28,
                    bottom: 24,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: '#9aa6bd',
                    fontSize: 13,
                }}
            >
                <span
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 24,
                        height: 24,
                        border: '1px solid rgba(255,255,255,0.5)',
                        borderRadius: 5,
                        color: '#ffffff',
                        fontSize: 13,
                        fontWeight: 700,
                        lineHeight: 1,
                        boxShadow: 'inset 0 -2px 0 rgba(255,255,255,0.14)',
                    }}
                >
                    F
                </span>
                <span>点击 / F 收起</span>
            </div>
        </div>
    );
}

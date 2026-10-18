/**
 * CursorKey.tsx —— 按住 ALT 呼出鼠标指针，同时冻结视角转动（用户 m05698）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * Follow 模式下 `useFollowCamera.ts` 会把画布**指针锁**住（pointer lock）。锁住期间
 * 浏览器隐藏光标、并把 `mousemove` 变成无限的 `movementX/Y` —— 视角转得顺滑，
 * 但玩家点不到任何界面（右下角拍照/相册、任务列表、侧面按钮）。
 * 所以 ALT 的本质是**两件事必须一起做**：
 *   1. `document.exitPointerLock()` ⇒ 光标回来，能点 UI；
 *   2. 冻结所有鼠标驱动的转视角入口 ⇒ 光标自由移动时画面不会跟着疯转。
 * 只做第 1 件 = 「光标一露出来画面就乱转」；只做第 2 件 = 光标还是隐藏的，没法用。
 *
 * ── 为什么是挂在 App 里的组件 ─────────────────────────────────────────────
 * 和 `<KeyboardMapper/>`（`App.tsx`）同一套路：只挂全局监听、返回 null。
 * 挂在 App 顶层而不是 `CameraViewControl` 里，是因为 `?cam=` 调试参数会让
 * `CameraViewControl` **整个不挂载**，那时这个开关也不该跟着消失。
 *
 * ── 三个必须处理的边界 ───────────────────────────────────────────────────
 *   ① `e.repeat`：按住 ALT 不放时系统连发 keydown，不过滤就是每秒几十次 setState。
 *   ② `window.blur`：Alt+Tab 切走时浏览器**不会**补发 keyup（那一下是 OS 收的），
 *      不兜底就会永远停在「光标自由」，切回来发现视角死了。
 *   ③ `e.preventDefault()`：Windows 上单按 Alt 会把焦点抢到浏览器菜单栏，之后就
 *      收不到 keyup 了。只在**纯 Alt**（没按别的修饰键）时拦截，免得误伤
 *      Alt+F4 / Ctrl+Alt+… 这些系统与页面组合键。
 */
import { useEffect } from 'react';
import { useGameStore } from '../store/gameStore';

/** 认 `e.code` 为主、`e.key` 兜底 —— 某些键盘映射下 code 可能缺失。 */
function isAltKey(e: KeyboardEvent): boolean {
    return e.code === 'AltLeft' || e.code === 'AltRight' || e.key === 'Alt';
}

export function CursorKey() {
    useEffect(() => {
        const setFree = useGameStore.getState().setCursorFree;

        const onDown = (e: KeyboardEvent) => {
            if (!isAltKey(e)) return;
            // ① 按住重复触发，过滤掉
            if (e.repeat) return;
            // ③ 纯 Alt 才抢默认行为（拦掉浏览器菜单焦点）
            if (!e.ctrlKey && !e.shiftKey && !e.metaKey) e.preventDefault();
            setFree(true);
        };

        const onUp = (e: KeyboardEvent) => {
            if (!isAltKey(e)) return;
            setFree(false);
        };

        // ② 失焦兜底：按键状态可能就此丢失，强制回到「不自由」
        const onBlur = () => setFree(false);

        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        window.addEventListener('blur', onBlur);

        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
            window.removeEventListener('blur', onBlur);
        };
    }, []);

    /**
     * 无头验收探针。为什么不复用 `window.__game`：那个对象归 `GameLayer` 管，
     * 而这里读的是**相机 store**，不是任务 store，分开放归属更清楚。
     * `alt(true/false)` 是给脚本用的替身按键 —— 无头合成 KeyboardEvent 也能跑，
     * 但直接调它能绕开「DevTools 把合成事件的 keyup 吃掉」这类干扰。
     */
    useEffect(() => {
        const w = window as unknown as {
            __cursor?: {
                free: () => boolean;
                alt: (down: boolean) => void;
            };
        };
        w.__cursor = {
            free: () => useGameStore.getState().isCursorFree,
            alt: (down: boolean) => useGameStore.getState().setCursorFree(down),
        };
        return () => { delete w.__cursor; };
    }, []);

    return null;
}

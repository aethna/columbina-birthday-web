import { InputSystem } from '@core';

export type GameAction = 'MoveForward' | 'MoveBackward' | 'RotateLeft' | 'RotateRight' | 'Run' | 'Jump';

/**
 * InputSystem + 一个「总闸」（用户 m00002，2026-10-17）。
 *
 * ── 为什么锁在输入层，而不是逐个改移动代码 ──────────────────────────
 * 人物位移的唯一驱动是 `components/character/utils/solveCam.ts`，而它开头就是
 * 六个 `input.isPressed(...)` / `input.getAxis(...)`。也就是说**所有**输入 ——
 * 键盘 WASD、方向键、手机摇杆（`TouchJoystick` 走的也是 `setButton`/`setAxis`）——
 * 都要先经过这里。在 `isPressed`/`getAxis` 上设闸，等于一次性覆盖全部移动入口，
 * 以后新加的解算器（`solveTank.ts` 之类）也自动吃到，不用再去每个调用点补条件。
 *
 * ── 为什么不用 `isControlEnabled` ──────────────────────────────────
 * 那个标志一关，`ui/UI.tsx:83-85` 那一层（音频按钮 / 侧栏 / 摇杆）会 opacity→0
 * 整层淡出，还牵动相机初始化时序。互动期间我们要的是「人不动」，不是「界面消失」。
 *
 * ── 为什么在这里继承而不是改 `packages/three-core` ────────────────
 * `three-core` 是通用输入库（别的项目也用），「互动占住鼠标」是本作玩法语义，
 * 不该下沉进去。继承一层、覆写两个读方法即可，`KeyboardMapper` 照旧拿到这个实例。
 */
class LockableInputSystem extends InputSystem<GameAction> {
  /** 锁定期间：所有按键与摇杆读数一律当作「没按」。 */
  private locked = false;

  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  isLocked(): boolean {
    return this.locked;
  }

  override isPressed(action: GameAction): boolean {
    if (this.locked) return false;
    return super.isPressed(action);
  }

  override getAxis(axisName: string): number {
    if (this.locked) return 0;
    return super.getAxis(axisName);
  }
}

export const input = new LockableInputSystem();

export const keyBindings: Record<string, GameAction> = {
  KeyW: 'MoveForward', ArrowUp: 'MoveForward',
  KeyS: 'MoveBackward', ArrowDown: 'MoveBackward',
  KeyA: 'RotateLeft', ArrowLeft: 'RotateLeft',
  KeyD: 'RotateRight', ArrowRight: 'RotateRight',
  ShiftLeft: 'Run', ShiftRight: 'Run',
  Space: 'Jump'
};

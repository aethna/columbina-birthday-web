// src/core/input/InputSystem.ts

type Listener = () => void;

export class InputSystem<T extends string = string> {
  // 1. Digital State (Buttons)
  private activeActions = new Set<T>();

  // 2. Analog State (Axes)
  private axes = new Map<string, number>();

  // 3. Signal Subscribers
  private listeners = new Map<T, Set<Listener>>();

  // --- Read State (For Game Loop) ---
  isPressed(action: T): boolean {
    return this.activeActions.has(action);
  }

  getAxis(axisName: string): number {
    return this.axes.get(axisName) || 0;
  }

  getVector(xAxis: string, yAxis: string) {
    return { x: this.getAxis(xAxis), y: this.getAxis(yAxis) };
  }

  // --- Write State (For Inputs) ---
  setButton(action: T, isDown: boolean) {
    if (isDown) {
      this.activeActions.add(action);
      this.emit(action); // Trigger One-Shot Event
    } else {
      this.activeActions.delete(action);
    }
  }

  setAxis(axisName: string, value: number) {
    this.axes.set(axisName, value);
  }

  // --- Event System ---
  subscribe(action: T, callback: Listener) {
    if (!this.listeners.has(action)) this.listeners.set(action, new Set());
    this.listeners.get(action)!.add(callback);
    return () => this.listeners.get(action)?.delete(callback);
  }

  private emit(action: T) {
    this.listeners.get(action)?.forEach((cb) => cb());
  }
  
  reset() {
    this.activeActions.clear();
    this.axes.clear();
  }
}
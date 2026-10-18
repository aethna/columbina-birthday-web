import {
  MAX_HANDS,
  type HandLandmark,
  type YoloHandDetection,
} from '../store';

export type TrackerInput = {
  x: number;
  y: number;
  confidence: number;
};

export type HandTrackerParams = {
  /** 0 = snappy, 1 = very smooth (more lag). */
  smoothing: number;
  matchThreshold: number;
  aliveMs: number;
  fadeMs: number;
};

export const defaultHandTrackerParams: HandTrackerParams = {
  smoothing: 0.8,
  matchThreshold: 0.1,
  aliveMs: 100,
  fadeMs: 1000,
};

/** Defaults → tracker object → flat prop overrides (only defined values). */
export function mergeHandTrackerParams(
  tracker?: Partial<HandTrackerParams>,
  overrides?: Partial<HandTrackerParams>,
): HandTrackerParams {
  const merged = { ...defaultHandTrackerParams, ...tracker };
  if (!overrides) {
    return merged;
  }
  if (overrides.smoothing !== undefined) merged.smoothing = overrides.smoothing;
  if (overrides.matchThreshold !== undefined) {
    merged.matchThreshold = overrides.matchThreshold;
  }
  if (overrides.aliveMs !== undefined) merged.aliveMs = overrides.aliveMs;
  if (overrides.fadeMs !== undefined) merged.fadeMs = overrides.fadeMs;
  return merged;
}

type TrackerSlot = {
  pos: HandLandmark;
  confidence: number;
  active: boolean;
  activeRatio: number;
  lastUpdateTime: number;
};

function createSlot(): TrackerSlot {
  return {
    pos: { x: 0, y: 0, z: 0 },
    confidence: 0,
    active: false,
    activeRatio: 0,
    lastUpdateTime: 0,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Fixed-slot hand tracker. Nearest match within threshold, else round-robin.
 */
export class HandTrackerPool {
  private readonly slots: TrackerSlot[];
  private params: HandTrackerParams;
  private lastActiveIndex = 0;

  constructor(size = MAX_HANDS, params: Partial<HandTrackerParams> = {}) {
    this.slots = Array.from({ length: size }, createSlot);
    this.params = { ...defaultHandTrackerParams, ...params };
  }

  setParams(params: Partial<HandTrackerParams>): void {
    this.params = { ...this.params, ...params };
  }

  getParams(): HandTrackerParams {
    return { ...this.params };
  }

  assignDetections(inputs: TrackerInput[], now: number, deltaSec: number): void {
    const { matchThreshold } = this.params;
    const usedDetections = new Set<number>();
    const usedSlots = new Set<number>();

    const pairs: { di: number; si: number; dist: number }[] = [];
    for (let di = 0; di < inputs.length; di++) {
      const input = inputs[di];
      for (let si = 0; si < this.slots.length; si++) {
        const slot = this.slots[si];
        const dist = Math.hypot(input.x - slot.pos.x, input.y - slot.pos.y);
        pairs.push({ di, si, dist });
      }
    }
    pairs.sort((a, b) => a.dist - b.dist);

    for (const { di, si, dist } of pairs) {
      if (usedDetections.has(di) || usedSlots.has(si)) {
        continue;
      }
      if (dist >= matchThreshold) {
        continue;
      }

      this.applyInputToSlot(si, inputs[di], now, deltaSec);
      usedDetections.add(di);
      usedSlots.add(si);
      this.lastActiveIndex = si;
    }

    for (let di = 0; di < inputs.length; di++) {
      if (usedDetections.has(di)) {
        continue;
      }

      let si = (this.lastActiveIndex + 1) % this.slots.length;
      for (let attempt = 0; attempt < this.slots.length; attempt++) {
        if (!usedSlots.has(si)) {
          break;
        }
        si = (si + 1) % this.slots.length;
      }

      this.applyInputToSlot(si, inputs[di], now, deltaSec);
      usedDetections.add(di);
      usedSlots.add(si);
      this.lastActiveIndex = si;
    }
  }

  tickFade(now: number, deltaSec: number): void {
    const { aliveMs, fadeMs } = this.params;
    const fadeStep = deltaSec / (fadeMs / 1000);

    for (const slot of this.slots) {
      if (now - slot.lastUpdateTime > aliveMs) {
        slot.active = false;
        slot.activeRatio = Math.max(0, slot.activeRatio - fadeStep);
      }
    }
  }

  hasAnyActive(): boolean {
    return this.slots.some((slot) => slot.activeRatio > 0.001);
  }

  reset(): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i] = createSlot();
    }
    this.lastActiveIndex = 0;
  }

  toStoreOutput(frameWidth: number, frameHeight: number): {
    hands: HandLandmark[][];
    detections: YoloHandDetection[];
    slotActiveRatio: number[];
  } {
    const hands: HandLandmark[][] = Array.from({ length: this.slots.length }, () => []);
    const detections: YoloHandDetection[] = [];
    const slotActiveRatio: number[] = [];

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      slotActiveRatio.push(slot.activeRatio);

      if (slot.activeRatio > 0.001) {
        hands[i] = [{ x: slot.pos.x, y: slot.pos.y, z: slot.pos.z }];

        const px = slot.pos.x * frameWidth;
        const py = slot.pos.y * frameHeight;
        const half = 12;
        detections.push({
          xmin: px - half,
          ymin: py - half,
          xmax: px + half,
          ymax: py + half,
          confidence: slot.confidence,
        });
      } else {
        detections.push({
          xmin: 0,
          ymin: 0,
          xmax: 0,
          ymax: 0,
          confidence: 0,
        });
      }
    }

    return { hands, detections, slotActiveRatio };
  }

  private applyInputToSlot(
    slotIndex: number,
    input: TrackerInput,
    now: number,
    deltaSec: number,
  ): void {
    const { smoothing, fadeMs } = this.params;
    const slot = this.slots[slotIndex];
    const t = 1 - Math.min(Math.max(smoothing, 0), 0.98);

    slot.pos.x = lerp(slot.pos.x, input.x, t);
    slot.pos.y = lerp(slot.pos.y, input.y, t);
    slot.pos.z = 0;
    slot.confidence = input.confidence;
    slot.active = true;
    slot.lastUpdateTime = now;
    slot.activeRatio = Math.min(1, slot.activeRatio + deltaSec / (fadeMs / 1000));
  }
}

export function detectionsToTrackerInputs(
  landmarks: HandLandmark[][],
  confidences: number[],
): TrackerInput[] {
  const inputs: TrackerInput[] = [];

  for (let i = 0; i < landmarks.length; i++) {
    const point = landmarks[i]?.[0];
    if (!point) {
      continue;
    }

    inputs.push({
      x: point.x,
      y: point.y,
      confidence: confidences[i] ?? 1,
    });
  }

  return inputs;
}

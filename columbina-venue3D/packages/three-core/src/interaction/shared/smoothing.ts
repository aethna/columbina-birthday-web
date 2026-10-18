import type { HandLandmark } from '../store';

export type HandLandmarks = HandLandmark[][];

// Lower = snappier, higher = smoother.
export const HAND_TRACKING_SMOOTHING = 0.5;
export const HAND_TRACKING_ALIVE_MS = 150;

export function smoothTowardInPlace(
  current: HandLandmarks,
  target: HandLandmarks,
  alpha: number,
) {
  if (current.length !== target.length) {
    current.length = 0;
    for (let h = 0; h < target.length; h++) {
      const src = target[h];
      const copy: HandLandmark[] = new Array(src.length);
      for (let i = 0; i < src.length; i++) {
        const p = src[i];
        copy[i] = { x: p.x, y: p.y, z: p.z };
      }
      current.push(copy);
    }
    return;
  }

  for (let h = 0; h < target.length; h++) {
    const tHand = target[h];
    const cHand = current[h];
    if (cHand.length !== tHand.length) {
      cHand.length = 0;
      for (let i = 0; i < tHand.length; i++) {
        const p = tHand[i];
        cHand.push({ x: p.x, y: p.y, z: p.z });
      }
      continue;
    }
    for (let i = 0; i < tHand.length; i++) {
      const c = cHand[i];
      const t = tHand[i];
      c.x += (t.x - c.x) * alpha;
      c.y += (t.y - c.y) * alpha;
      c.z += (t.z - c.z) * alpha;
    }
  }
}

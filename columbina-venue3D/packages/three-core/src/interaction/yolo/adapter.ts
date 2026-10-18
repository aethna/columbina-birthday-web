import type { HandLandmark, YoloHandDetection, YoloHandFrame } from '../store';

type RawDetection = Record<string, unknown>;

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizePixelCoord(
  value: number,
  axisSize: number,
  mirror: boolean,
): number {
  const normalized = clamp01(value / axisSize);
  return mirror ? 1 - normalized : normalized;
}

function parseBoxDetection(
  raw: RawDetection,
  frameWidth: number,
  frameHeight: number,
): YoloHandDetection | null {
  const confidence = asNumber(raw.confidence) ?? asNumber(raw.score) ?? 1;

  const xmin = asNumber(raw.xmin) ?? asNumber(raw.left);
  const ymin = asNumber(raw.ymin) ?? asNumber(raw.top);
  const xmax = asNumber(raw.xmax) ?? asNumber(raw.right);
  const ymax = asNumber(raw.ymax) ?? asNumber(raw.bottom);

  if (xmin !== null && ymin !== null && xmax !== null && ymax !== null) {
    return { xmin, ymin, xmax, ymax, confidence };
  }

  const box = raw.box;
  if (Array.isArray(box) && box.length >= 4) {
    const [b0, b1, b2, b3] = box.map(asNumber);
    if (b0 !== null && b1 !== null && b2 !== null && b3 !== null) {
      return { xmin: b0, ymin: b1, xmax: b2, ymax: b3, confidence };
    }
  }

  const cx = asNumber(raw.cx) ?? asNumber(raw.x);
  const cy = asNumber(raw.cy) ?? asNumber(raw.y);
  const w = asNumber(raw.w) ?? asNumber(raw.width);
  const h = asNumber(raw.h) ?? asNumber(raw.height);

  if (cx === null || cy === null || w === null || h === null) {
    return null;
  }

  const looksNormalized =
    cx >= 0 &&
    cx <= 1 &&
    cy >= 0 &&
    cy <= 1 &&
    w >= 0 &&
    w <= 1 &&
    h >= 0 &&
    h <= 1;

  if (looksNormalized) {
    const halfW = w * 0.5;
    const halfH = h * 0.5;
    return {
      xmin: (cx - halfW) * frameWidth,
      ymin: (cy - halfH) * frameHeight,
      xmax: (cx + halfW) * frameWidth,
      ymax: (cy + halfH) * frameHeight,
      confidence,
    };
  }

  const halfW = w * 0.5;
  const halfH = h * 0.5;
  return {
    xmin: cx - halfW,
    ymin: cy - halfH,
    xmax: cx + halfW,
    ymax: cy + halfH,
    confidence,
  };
}

function parseCenterDetection(
  raw: RawDetection,
  frameWidth: number,
  frameHeight: number,
): YoloHandDetection | null {
  const center = raw.center;
  if (!Array.isArray(center) || center.length < 2) {
    return null;
  }

  const cx = asNumber(center[0]);
  const cy = asNumber(center[1]);
  if (cx === null || cy === null) {
    return null;
  }

  const confidence = asNumber(raw.confidence) ?? asNumber(raw.score) ?? 1;
  const size = 24;
  const px = cx * frameWidth;
  const py = cy * frameHeight;

  return {
    xmin: px - size,
    ymin: py - size,
    xmax: px + size,
    ymax: py + size,
    confidence,
  };
}

export function parseYoloHandFrame(payload: unknown): YoloHandFrame | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const message = payload as Record<string, unknown>;
  const frameWidth =
    asNumber(message.frame_width) ??
    asNumber(message.frameWidth) ??
    asNumber(message.width) ??
    640;
  const frameHeight =
    asNumber(message.frame_height) ??
    asNumber(message.frameHeight) ??
    asNumber(message.height) ??
    480;

  const rawDetections =
    message.detections ??
    message.hands ??
    message.results ??
    (Array.isArray(payload) ? payload : null);

  if (!Array.isArray(rawDetections)) {
    return null;
  }

  const detections: YoloHandDetection[] = [];

  for (const item of rawDetections) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const raw = item as RawDetection;
    const detection =
      parseBoxDetection(raw, frameWidth, frameHeight) ??
      parseCenterDetection(raw, frameWidth, frameHeight);

    if (detection) {
      detections.push(detection);
    }
  }

  return {
    detections,
    frameWidth,
    frameHeight,
  };
}

/**
 * Convert YOLO bounding boxes into handStore.hands layout.
 * Expects coords already in view space (Python flips X before send).
 */
export function yoloDetectionsToLandmarks(frame: YoloHandFrame): HandLandmark[][] {
  const frameWidth = frame.frameWidth ?? 640;
  const frameHeight = frame.frameHeight ?? 480;

  return frame.detections.map((detection) => {
    const centerX = (detection.xmin + detection.xmax) * 0.5;
    const centerY = (detection.ymin + detection.ymax) * 0.5;

    return [
      {
        x: normalizePixelCoord(centerX, frameWidth, false),
        y: normalizePixelCoord(centerY, frameHeight, false),
        z: 0,
      },
    ];
  });
}

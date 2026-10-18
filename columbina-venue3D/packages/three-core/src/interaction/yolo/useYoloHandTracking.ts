import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  HandTrackerPool,
  mergeHandTrackerParams,
  detectionsToTrackerInputs,
  type HandTrackerParams,
} from '../shared/handTracker';
import {
  applyYoloTrackedHandsToStore,
  clearHandStore,
  type YoloHandFrame,
} from '../store';
import { parseYoloHandFrame, yoloDetectionsToLandmarks } from './adapter';

export interface YoloWebSocketOptions extends Partial<HandTrackerParams> {
  url?: string;
  tracker?: Partial<HandTrackerParams>;
}

const WS_STALE_MS = 500;

/**
 * Receives YOLO hand-detection bounding boxes from a local Python backend
 * and maps them into stable handStore slots via distance-based tracking.
 */
export function useYoloHandTracking(options: YoloWebSocketOptions = {}) {
  const {
    url = 'ws://127.0.0.1:8765',
    tracker,
    smoothing,
    matchThreshold,
    aliveMs,
    fadeMs,
  } = options;

  const trackerParams = useMemo(
    () => mergeHandTrackerParams(tracker, { smoothing, matchThreshold, aliveMs, fadeMs }),
    [tracker, smoothing, matchThreshold, aliveMs, fadeMs],
  );

  const trackerPool = useRef(new HandTrackerPool(undefined, trackerParams));
  const lastFrame = useRef<YoloHandFrame | null>(null);
  const hasConnectedOnce = useRef(false);
  const lastWsTime = useRef(0);

  useLayoutEffect(() => {
    trackerPool.current.setParams(trackerParams);
  }, [trackerParams]);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (disposed) return;

      ws = new WebSocket(url);

      ws.onopen = () => {
        hasConnectedOnce.current = true;
        console.log(`[YoloHandTracking] WebSocket connected to ${url}`);
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          const frame = parseYoloHandFrame(payload);
          if (!frame) {
            return;
          }

          lastFrame.current = frame;
          lastWsTime.current = performance.now();
        } catch (err) {
          console.error('[YoloHandTracking] Error parsing WebSocket message:', err);
        }
      };

      ws.onerror = () => {
        if (hasConnectedOnce.current) {
          // Stay silent during reconnect churn.
        }
      };

      ws.onclose = () => {
        if (!disposed) {
          if (hasConnectedOnce.current) {
            console.warn('[YoloHandTracking] Connection lost. Retrying in 2 seconds...');
          } else {
            console.log('[YoloHandTracking] Waiting for YOLO backend to initialize...');
          }
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
      trackerPool.current.reset();
      lastFrame.current = null;
      clearHandStore();
    };
  }, [url]);

  useFrame((_state, delta) => {
    const now = performance.now();
    const wsFresh = now - lastWsTime.current < WS_STALE_MS;
    const frame = lastFrame.current;

    trackerPool.current.tickFade(now, delta);

    if (wsFresh && frame) {
      const landmarks = yoloDetectionsToLandmarks(frame);
      const confidences = frame.detections.map((detection) => detection.confidence);
      const inputs = detectionsToTrackerInputs(landmarks, confidences);
      trackerPool.current.assignDetections(inputs, now, delta);

      const output = trackerPool.current.toStoreOutput(
        frame.frameWidth ?? 640,
        frame.frameHeight ?? 480,
      );

      applyYoloTrackedHandsToStore(
        output.hands,
        output.detections,
        output.slotActiveRatio,
        {
          frameWidth: frame.frameWidth ?? 640,
          frameHeight: frame.frameHeight ?? 480,
        },
      );
      return;
    }

    if (!wsFresh) {
      trackerPool.current.reset();
      lastFrame.current = null;
      clearHandStore();
    }
  }, -2);
}

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  applyMediaPipeHandsToStore,
  clearHandStore,
} from '../store';
import {
  HAND_TRACKING_ALIVE_MS,
  HAND_TRACKING_SMOOTHING,
  smoothTowardInPlace,
  type HandLandmarks,
} from '../shared/smoothing';

export interface MediaPipeWebSocketOptions {
  url?: string;
}

/**
 * Receives MediaPipe hand-landmark data via WebSocket from a local Python backend.
 * Bypasses browser camera and in-browser MediaPipe inference.
 */
export function useMediaPipeHandTracking(options: MediaPipeWebSocketOptions = {}) {
  const { url = 'ws://127.0.0.1:8765' } = options;

  const targetLandmarks = useRef<HandLandmarks>([]);
  const targetWorld = useRef<HandLandmarks>([]);
  const smoothedLandmarks = useRef<HandLandmarks>([]);
  const smoothedWorld = useRef<HandLandmarks>([]);

  const hasConnectedOnce = useRef(false);
  const lastUpdateTime = useRef(0);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (disposed) return;

      ws = new WebSocket(url);

      ws.onopen = () => {
        hasConnectedOnce.current = true;
        console.log(`[MediaPipeHandTracking] WebSocket connected to ${url}`);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          targetLandmarks.current = data.landmarks ?? [];
          targetWorld.current = data.worldLandmarks ?? [];

          if (targetLandmarks.current.length > 0) {
            lastUpdateTime.current = performance.now();
          }
        } catch (err) {
          console.error('[MediaPipeHandTracking] Error parsing WebSocket message:', err);
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
            console.warn('[MediaPipeHandTracking] Connection lost. Retrying in 2 seconds...');
          } else {
            console.log('[MediaPipeHandTracking] Waiting for tracking backend to initialize...');
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
      clearHandStore();
    };
  }, [url]);

  useFrame((_state, delta) => {
    const target = targetLandmarks.current;
    const targetW = targetWorld.current;
    const timedOut =
      performance.now() - lastUpdateTime.current > HAND_TRACKING_ALIVE_MS;

    if (target.length === 0 || timedOut) {
      if (smoothedLandmarks.current.length !== 0) {
        smoothedLandmarks.current.length = 0;
        smoothedWorld.current.length = 0;
        clearHandStore();
      }
      return;
    }

    const alpha = 1 - Math.pow(HAND_TRACKING_SMOOTHING, delta * 60);

    smoothTowardInPlace(smoothedLandmarks.current, target, alpha);
    smoothTowardInPlace(smoothedWorld.current, targetW, alpha);

    applyMediaPipeHandsToStore(smoothedLandmarks.current, smoothedWorld.current);
  });
}

import {
  useMediaPipeHandTracking,
  type MediaPipeWebSocketOptions,
} from './useMediaPipeHandTracking';

export type MediaPipeHandTrackingProps = MediaPipeWebSocketOptions;

/** Drop inside <Canvas> to stream MediaPipe hand landmarks into handStore. */
export function MediaPipeHandTracking(props: MediaPipeHandTrackingProps = {}) {
  useMediaPipeHandTracking(props);
  return null;
}

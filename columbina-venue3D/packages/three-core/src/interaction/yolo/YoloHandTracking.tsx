import { useYoloHandTracking, type YoloWebSocketOptions } from './useYoloHandTracking';

export type YoloHandTrackingProps = YoloWebSocketOptions;

/** Drop inside <Canvas> to stream YOLO hand detections into handStore. */
export function YoloHandTracking(props: YoloHandTrackingProps = {}) {
  useYoloHandTracking(props);
  return null;
}

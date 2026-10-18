// @core/interaction/store.ts

import { instancedArray } from "three/tsl";



export const MAX_HANDS = 10;

export const POINTS_PER_HAND = 1; // use index 9

export const MAX_INSTANCES = MAX_HANDS * POINTS_PER_HAND;



export type HandLandmark = { x: number; y: number; z: number };

export type HandTrackingSource = 'none' | 'mediapipe' | 'yolo';



export type YoloHandDetection = {

  xmin: number;

  ymin: number;

  xmax: number;

  ymax: number;

  confidence: number;

};



export type YoloHandFrame = {

  detections: YoloHandDetection[];

  frameWidth?: number;

  frameHeight?: number;
};



export type MediaPipeHandState = {

  worldLandmarks: HandLandmark[][];

  gestures: string[];

};



export type YoloHandState = {

  detections: YoloHandDetection[];

  slotActiveRatio: number[];

  frameWidth: number;

  frameHeight: number;

};



// Global TSL InstancedArray node.
// Becomes a storage buffer readable by both compute shaders and the render pass.

export const sharedHandPosNode = instancedArray(MAX_INSTANCES, 'vec3');



export const handStore = {

  source: 'none' as HandTrackingSource,

  hands: [] as HandLandmark[][],

  mediapipe: null as MediaPipeHandState | null,

  yolo: null as YoloHandState | null,

  video: null as HTMLVideoElement | null,

  videoWidth: 640,

  videoHeight: 480,

  mirror: true,
};



export function clearHandStore(): void {

  handStore.source = 'none';

  handStore.hands = [];

  handStore.mediapipe = null;

  handStore.yolo = null;

}



export function applyMediaPipeHandsToStore(

  hands: HandLandmark[][],

  worldLandmarks: HandLandmark[][] = [],

): void {

  handStore.source = 'mediapipe';

  handStore.hands = hands;

  handStore.mediapipe = {

    worldLandmarks,

    gestures: handStore.mediapipe?.gestures ?? [],

  };

  handStore.yolo = null;

}



export function applyYoloHandsToStore(hands: HandLandmark[][]): void {

  handStore.source = 'yolo';

  handStore.hands = hands;

  handStore.mediapipe = null;

}



export function applyYoloTrackedHandsToStore(

  hands: HandLandmark[][],

  detections: YoloHandDetection[],

  slotActiveRatio: number[],

  frame: { frameWidth: number; frameHeight: number },

): void {

  handStore.source = 'yolo';

  handStore.hands = hands;

  handStore.mediapipe = null;

  handStore.videoWidth = frame.frameWidth;

  handStore.videoHeight = frame.frameHeight;

  handStore.yolo = {

    detections,

    slotActiveRatio,

    frameWidth: frame.frameWidth,

    frameHeight: frame.frameHeight,

  };

}



/**

 * Reuse the same outer arrays on handStore to avoid churning references every frame.

 */

export function syncMediaPipeResultsToStore(results: {

  landmarks?: HandLandmark[][];

  worldLandmarks?: HandLandmark[][];

  gestures?: string[];

} | null): void {

  const newLandmarks = results?.landmarks;

  const newWorld = results?.worldLandmarks ?? [];



  if (!newLandmarks?.length) {

    return;

  }



  handStore.source = 'mediapipe';

  handStore.yolo = null;



  handStore.hands.length = 0;

  for (let i = 0; i < newLandmarks.length; i++) {

    handStore.hands.push(newLandmarks[i]);

  }



  handStore.mediapipe = {

    worldLandmarks: newWorld,

    gestures: results?.gestures ?? handStore.mediapipe?.gestures ?? [],

  };

}



export function syncYoloDetectionsToStore(frame: YoloHandFrame | null): void {

  if (!frame?.detections?.length) {

    return;

  }



  handStore.source = 'yolo';

  handStore.mediapipe = null;



  if (frame.frameWidth) {

    handStore.videoWidth = frame.frameWidth;

  }

  if (frame.frameHeight) {
    handStore.videoHeight = frame.frameHeight;
  }

  handStore.yolo = {

    detections: frame.detections,

    slotActiveRatio: frame.detections.map(() => 1),

    frameWidth: frame.frameWidth ?? handStore.videoWidth,

    frameHeight: frame.frameHeight ?? handStore.videoHeight,

  };

}



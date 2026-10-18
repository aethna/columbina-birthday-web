import { HandLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';
import { CameraManager } from './CameraManager';

export interface HandLandmarkManagerOptions {
  modelType?: 'LITE' | 'FULL'; // Mapping concepts, although HandLandmarker usually uses a path
  numHands?: number;
  mirror?: boolean;
}

export class HandLandmarkManager extends EventTarget {
  static readonly EVENTS = {
    HAND_DETECTED: 'hand-detected',
    ERROR: 'error'
  } as const;

  private handLandmarker: HandLandmarker | null = null;
  private cameraManager: CameraManager | null = null;
  private rafId: number | null = null;
  private isRunning: boolean = false;
  private options: HandLandmarkManagerOptions;
  private lastVideoTime = -1;
  
  // Store latest results
  private results: any = null;

  constructor(options: HandLandmarkManagerOptions = {}) {
    super();
    this.options = {
      modelType: options.modelType || 'FULL',
      numHands: options.numHands || 2,
      mirror: options.mirror === undefined ? true : options.mirror
    };
  }

  async init(cameraManager?: CameraManager, autoStart = true) {
    if (cameraManager) {
      this.cameraManager = cameraManager;
    } else {
      this.cameraManager = new CameraManager();
      await this.cameraManager.start();
    }

    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/wasm'
    );

    this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: this.options.numHands
    });

    if (autoStart) this.start();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loop();
  }

  stop() {
    this.isRunning = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose(): void {
    this.stop();
    if (this.handLandmarker) {
      this.handLandmarker.close();
      this.handLandmarker = null;
    }
    this.cameraManager = null;
    this.results = null;
  }

  /**
   * Run a single detection pass without scheduling another frame.
   * Intended for external loops (e.g. R3F useFrame).
   * Returns null when no new video frame is available.
   */
  detectOnce() {
    if (!this.cameraManager || !this.handLandmarker) return null;

    const video = this.cameraManager.video;
    if (video.currentTime === this.lastVideoTime) return this.results;

    this.lastVideoTime = video.currentTime;

    try {
      const results = this.handLandmarker.detectForVideo(video, performance.now());
      this.results = results;
      this.dispatchEvent(new CustomEvent(HandLandmarkManager.EVENTS.HAND_DETECTED, { detail: results }));
      return results;
    } catch (err) {
      console.error('Hand detection error:', err);
      this.dispatchEvent(new CustomEvent(HandLandmarkManager.EVENTS.ERROR, { detail: err }));
      return null;
    }
  }

  private loop() {
    if (!this.isRunning || !this.cameraManager || !this.handLandmarker) return;
    this.detectOnce();
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  /**
   * Returns array of world landmarks (3D) for the first detected hand.
   * Format: [{x, y, z}, ...] (meters)
   */
  getWorldLandmarks(handIndex: number = 0): any[] {
    if (this.results && this.results.worldLandmarks && this.results.worldLandmarks[handIndex]) {
      return this.results.worldLandmarks[handIndex];
    }
    return [];
  }
  
  /**
   * Returns array of normalized landmarks (2D/3D) for overlay.
   */
  getLandmarks(handIndex: number = 0): any[] {
     if (this.results && this.results.landmarks && this.results.landmarks[handIndex]) {
      return this.results.landmarks[handIndex];
    }
    return []; 
  }

  get video(): HTMLVideoElement | null {
    return this.cameraManager ? this.cameraManager.video : null;
  }
}

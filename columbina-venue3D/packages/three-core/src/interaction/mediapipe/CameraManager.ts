export interface CameraManagerOptions {
  width?: number;
  height?: number;
  facingMode?: string;
  fps?: number;
}

export interface FrameEventDetails {
  video: HTMLVideoElement;
  timestamp: number;
  width: number;
  height: number;
}

export interface ReadyEventDetails {
  stream: MediaStream;
  video: HTMLVideoElement;
  capabilities: MediaTrackCapabilities | null;
}

export interface DeviceChangeEventDetails {
  devices: MediaDeviceInfo[];
}

export interface ErrorEventDetails {
  message: string;
  errorObject: any;
}

export class CameraManager extends EventTarget {
  private _video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private options: Required<CameraManagerOptions>;
  private animationFrameId: number | null = null;
  private isPaused: boolean = false;
  private isRunning: boolean = false;

  private _canvas: HTMLCanvasElement | null = null;
  private _context: CanvasRenderingContext2D | null = null;

  constructor(options: CameraManagerOptions = {}) {
    super();
    this.options = {
      width: options.width ?? 1280,
      height: options.height ?? 720,
      facingMode: options.facingMode ?? 'user',
      fps: options.fps ?? 30,
    };

    this._video = document.createElement('video');
    this._video.setAttribute('playsinline', 'true');
    this._video.setAttribute('id', 'lens-video');
    
    // Bind methods to ensure correct 'this' context if passed around
    this.loop = this.loop.bind(this);
    this.handleDeviceChange = this.handleDeviceChange.bind(this);

    navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange);
  }

  get video(): HTMLVideoElement {
    return this._video;
  }

  async start(): Promise<MediaStream> {
    // If already running, stop first to ensure clean state
    if (this.stream) {
        this.stop();
    }

    try {
      const constraints: MediaStreamConstraints = {
        video: {
          width: { ideal: this.options.width },
          height: { ideal: this.options.height },
          facingMode: this.options.facingMode,
          frameRate: { ideal: this.options.fps },
        },
        audio: false,
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this._video.srcObject = this.stream;

      await this._video.play();
      
      const track = this.stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities ? track.getCapabilities() : null;

      const readyEvent = new CustomEvent<ReadyEventDetails>('ready', {
        detail: {
          stream: this.stream,
          video: this._video,
          capabilities,
        },
      });
      this.dispatchEvent(readyEvent);

      this.isRunning = true;
      this.isPaused = false;
      
      // Start the loop
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        this._video.requestVideoFrameCallback(this.loop);
      } else {
        this.animationFrameId = requestAnimationFrame(this.loop);
      }

      return this.stream;
    } catch (error: any) {
      const errorEvent = new CustomEvent<ErrorEventDetails>('error', {
        detail: {
          message: error.name === 'NotAllowedError' ? 'Permission denied' : 'Camera error',
          errorObject: error,
        },
      });
      this.dispatchEvent(errorEvent);
      throw error;
    }
  }

  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    
    this._video.pause();
    this._video.srcObject = null;
    this.isRunning = false;
    
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Note: If using requestVideoFrameCallback, stopping the video source implicitly stops the callbacks.
  }

  dispose(): void {
      this.stop();
      navigator.mediaDevices.removeEventListener('devicechange', this.handleDeviceChange);
      this._canvas = null;
      this._context = null;
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    if (this.isPaused && this.isRunning) {
      this.isPaused = false;
      // If we were using requestAnimationFrame and fell out of loop? 
      // Actually with the way loop is structured, it keeps requesting next frame unless stopped.
      // But if paused, we just don't emit. 
    }
  }

  getSnapshot(format: string = 'image/jpeg'): string {
    if (!this._video || this._video.videoWidth === 0) {
      return '';
    }

    if (!this._canvas) {
        this._canvas = document.createElement('canvas');
        this._context = this._canvas.getContext('2d');
    }

    if (this._canvas.width !== this._video.videoWidth || this._canvas.height !== this._video.videoHeight) {
        this._canvas.width = this._video.videoWidth;
        this._canvas.height = this._video.videoHeight;
    }

    if (this._context) {
      this._context.drawImage(this._video, 0, 0);
      return this._canvas.toDataURL(format);
    }
    return '';
  }

  private loop(now: number, metadata?: VideoFrameCallbackMetadata): void {
    if (!this.isRunning) return;

    // Schedule next frame
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this._video.requestVideoFrameCallback(this.loop);
    } else {
      this.animationFrameId = requestAnimationFrame(() => this.loop(performance.now()));
    }

    if (!this.isPaused) {
      const frameEvent = new CustomEvent<FrameEventDetails>('frame', {
        detail: {
          video: this._video,
          timestamp: now,
          width: this._video.videoWidth,
          height: this._video.videoHeight,
        },
      });
      this.dispatchEvent(frameEvent);
    }
  }

  private async handleDeviceChange() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const event = new CustomEvent<DeviceChangeEventDetails>('device:change', {
        detail: { devices },
      });
      this.dispatchEvent(event);
    } catch (e) {
      console.error('Error enumerating devices:', e);
    }
  }
}

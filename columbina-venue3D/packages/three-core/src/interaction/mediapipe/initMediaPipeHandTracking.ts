import { handStore, syncMediaPipeResultsToStore } from '../store';
import { HandLandmarkManager, type HandLandmarkManagerOptions } from './HandLandmarkManager';

export const initMediaPipeHandTracking = async () => {
  try {
    const options: HandLandmarkManagerOptions = { modelType: 'LITE', mirror: true };
    const manager = new HandLandmarkManager(options);
    await manager.init();

    if (manager.video) {
      document.body.appendChild(manager.video);
      // Hide video, let WebGL handle visuals
      manager.video.style.display = 'none';
      handStore.video = manager.video;
    }

    manager.addEventListener(HandLandmarkManager.EVENTS.HAND_DETECTED, (e: any) => {
      syncMediaPipeResultsToStore(e.detail);
    });
  } catch (e) {
    console.error('MediaPipe tracking error:', e);
  }
};

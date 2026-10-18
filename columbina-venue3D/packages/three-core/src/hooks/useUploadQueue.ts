import { create } from 'zustand';

export interface UploadQueueState {
  uploadQueue: string[];
  currentUploader: string | null;
  enqueueUpload: (id: string) => void;
  processNextUpload: () => void;
  removeUpload: (id: string) => void;
}

/**
 * Global queue to throttle GPU uploads and prevent PCIe saturation.
 */
export const useUploadQueue = create<UploadQueueState>((set, get) => ({
  uploadQueue: [],
  currentUploader: null,

  enqueueUpload: (id) => set((state) => {
    // If nothing is uploading, take the slot immediately
    if (state.currentUploader === null) {
      return { currentUploader: id };
    }
    // Prevent duplicate entries
    if (state.uploadQueue.includes(id) || state.currentUploader === id) return state;
    return { uploadQueue: [...state.uploadQueue, id] };
  }),

  processNextUpload: () => set((state) => {
    if (state.uploadQueue.length > 0) {
      const [next, ...rest] = state.uploadQueue;
      return { 
        currentUploader: next, 
        uploadQueue: rest 
      };
    }
    return { currentUploader: null };
  }),

  removeUpload: (id) => set((state) => {
    // If the active uploader is removed, trigger next in line
    if (state.currentUploader === id) {
      const [next, ...rest] = state.uploadQueue;
      return { currentUploader: next || null, uploadQueue: rest };
    }
    return { uploadQueue: state.uploadQueue.filter((i) => i !== id) };
  }),
}));
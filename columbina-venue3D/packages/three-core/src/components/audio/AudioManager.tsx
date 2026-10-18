'use client';

import { useEffect, useState, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { AudioListener } from 'three/webgpu';

interface AudioManagerProps {
  /** Callback to pass the listener back to your state management */
  onListenerCreated?: (listener: AudioListener) => void;
  /** Optional global volume (0.0 to 1.0) */
  masterVolume?: number;
}

/**
 * Core Audio Manager
 * Responsible for attaching the WebGPU AudioListener to the active camera
 * and managing the global audio context state.
 */
export function AudioManager({ 
  onListenerCreated, 
  masterVolume = 1.0 
}: AudioManagerProps) {
  const { camera } = useThree();
  
  // Create listener once
  const [listener] = useState(() => new AudioListener());

  // Handle Master Volume
  useEffect(() => {
    if (listener.gain) {
      listener.setMasterVolume(masterVolume);
    }
  }, [masterVolume, listener]);

  useEffect(() => {
    if (!camera) return;

    // Attach listener to camera for spatial audio calculations
    camera.add(listener);
    
    // Notify the app that the listener is ready
    if (onListenerCreated) {
      onListenerCreated(listener);
    }

    // 
    
    return () => {
      camera.remove(listener);
      // Optional: Cleanup audio context if needed, 
      // though usually kept alive for the app session.
    };
  }, [camera, listener, onListenerCreated]);

  return null;
}
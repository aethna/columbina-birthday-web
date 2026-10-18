'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { useLoader, useFrame } from '@react-three/fiber';
import { AudioLoader } from 'three';

interface Track {
  id: string;
  url: string;
  volume?: number;
  /** Pitch offset in cents (negative = lower) */
  detune?: number;
}

interface BgmProps {
  listener: THREE.AudioListener | null;
  active: boolean;
  tracks: Track[];
  fadeDuration?: number;
}

export function Bgm({ listener, active, tracks, fadeDuration = 1 }: BgmProps) {
  const urls = useMemo(() => tracks.map(t => t.url), [tracks]);
  const buffers = useLoader(AudioLoader, urls);
  const sounds = useRef<Map<string, { audio: THREE.Audio; targetVol: number }>>(new Map());

  useEffect(() => {
    if (!listener || !buffers) return;

    sounds.current.forEach(({ audio }) => {
      if (audio.isPlaying) audio.stop();
      audio.disconnect();
    });
    sounds.current.clear();

    tracks.forEach((t, index) => {
      const audio = new THREE.Audio(listener);
      const targetVol = t.volume ?? 0.5;
      
      audio.setBuffer(buffers[index]);
      audio.setLoop(true);
      if (t.detune) audio.setDetune(t.detune);
      
      // 1. Attempt to set volume to 0 before playing
      audio.setVolume(0);
      
      // Direct GainNode access to force value to 0 (Bypassing Three.js logic)
      if (audio.gain && audio.gain.gain) {
        audio.gain.gain.value = 0;
        audio.gain.gain.setValueAtTime(0, listener.context.currentTime);
      }

      if (active) {
        const context = listener.context;
        if (context.state === 'suspended') {
            context.resume().catch(() => {});
        }
        
        audio.play();

        // Force volume to 0 AGAIN immediately after playing.
        // Since JS is single-threaded, this executes before the audio hardware 
        // outputs a single sample, guaranteeing silence.
        audio.setVolume(0);
        
        // Double Tap on the raw node for safety
        if (audio.gain && audio.gain.gain) {
           audio.gain.gain.value = 0;
           audio.gain.gain.cancelScheduledValues(listener.context.currentTime);
           audio.gain.gain.setValueAtTime(0, listener.context.currentTime);
        }
      }
      
      sounds.current.set(t.id, { audio, targetVol });
    });

    return () => {
      sounds.current.forEach(({ audio }) => {
        if (audio.isPlaying) audio.stop();
        audio.disconnect();
      });
    };
  }, [tracks, listener, buffers]); 

  useFrame((_, delta) => {
    const safeDelta = Math.min(delta, 0.1);

    sounds.current.forEach((obj) => {
      const { audio, targetVol } = obj;
      const currentVol = audio.getVolume();
      const destination = active ? targetVol : 0;

      if (active && !audio.isPlaying) {
        audio.play();
        // Force 0 again just in case it was stopped
        audio.setVolume(0);
      } 
      else if (!active && audio.isPlaying && currentVol <= 0.001) {
        audio.pause();
      }

      if (Math.abs(currentVol - destination) > 0.0001) {
        const step = safeDelta / fadeDuration;
        const newVol = THREE.MathUtils.lerp(currentVol, destination, step * 3.0);
        audio.setVolume(newVol);
      } else if (currentVol !== destination) {
        audio.setVolume(destination);
      }
    });
  });

  return null;
}
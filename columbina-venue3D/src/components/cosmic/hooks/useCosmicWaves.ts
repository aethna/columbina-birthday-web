import { useMemo, useRef, useCallback, useEffect } from 'react';
import * as THREE from 'three/webgpu';
import { useFrame } from '@react-three/fiber';
import { struct } from 'three/tsl';
import { MathUtils } from 'three';
import { uTime, uActiveWaveCount, GlobalWaveState } from '../../../core/shaders/uniforms';
import { gameEvents, type GameEvents } from '../../../core/events';

const MAX_WAVES = 16;
const DATA_PER_WAVE = 5; // x, z, startTime, maxRadius, lifetime

export const waveStructure = struct({
  x: 'float',
  z: 'float',
  startTime: 'float',
  maxRadius: 'float',
  lifetime: 'float',
});

interface UseCosmicWavesOptions {
  enabled?: boolean;
  waveParams?: {
    radiusMin: number;
    radiusMax: number;
    lifetimeMin: number;
    lifetimeMax: number;
  };
}

export function useCosmicWaves({ enabled = true, waveParams }: UseCosmicWavesOptions = {}) {
  const waveDataArray = useMemo(() => new Float32Array(MAX_WAVES * DATA_PER_WAVE), []);
  const waveStorageBuffer = useMemo(
    () => new THREE.StorageBufferAttribute(waveDataArray, DATA_PER_WAVE),
    [waveDataArray]
  );

  useEffect(() => {
    GlobalWaveState.buffer = waveStorageBuffer;
    return () => {
      GlobalWaveState.buffer = null;
    };
  }, [waveStorageBuffer]);

  const activeWaves = useRef<{
    pos: THREE.Vector2;
    startTime: number;
    maxRadius: number;
    lifetime: number;
  }[]>([]);

  const triggerShockwave = useCallback(
    (position: THREE.Vector3, maxRadius: number = 15.0, lifetime: number = 5.0) => {
      activeWaves.current.push({
        pos: new THREE.Vector2(position.x, position.z),
        startTime: uTime.value,
        maxRadius,
        lifetime,
      });
      if (activeWaves.current.length > MAX_WAVES) activeWaves.current.shift();
    },
    []
  );

  useEffect(() => {
    if (!enabled || !waveParams) return;

    const onHit = ({ position, radius }: GameEvents['beam:hit']) => {
      const lifetime = MathUtils.lerp(
        waveParams.lifetimeMin,
        waveParams.lifetimeMax,
        Math.random()
      );
      triggerShockwave(position, radius, lifetime);
    };

    gameEvents.on('beam:hit', onHit);
    return () => gameEvents.off('beam:hit', onHit);
  }, [enabled, waveParams, triggerShockwave]);

  useFrame(() => {
    if (!enabled) return;

    waveDataArray.fill(0);

    activeWaves.current = activeWaves.current.filter((wave) => {
      const age = uTime.value - wave.startTime;
      return age <= wave.lifetime;
    });

    let activeCount = 0;
    for (let i = 0; i < activeWaves.current.length; i++) {
      const wave = activeWaves.current[i];
      const age = uTime.value - wave.startTime;
      if (age > wave.lifetime) break;

      const index = activeCount * DATA_PER_WAVE;
      waveDataArray[index + 0] = wave.pos.x;
      waveDataArray[index + 1] = wave.pos.y;
      waveDataArray[index + 2] = wave.startTime;
      waveDataArray[index + 3] = wave.maxRadius;
      waveDataArray[index + 4] = wave.lifetime;
      activeCount++;
    }

    uActiveWaveCount.value = activeCount;
    waveStorageBuffer.needsUpdate = true;
  });

  return {
    triggerShockwave,
    waveCount: MAX_WAVES,
  };
}

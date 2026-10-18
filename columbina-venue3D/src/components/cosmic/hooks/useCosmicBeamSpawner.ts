// ============================================================================
// Cosmic Beam Spawner Hook
// ============================================================================

import { useRef, useMemo, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { MathUtils } from 'three';
import { useGameStore } from '../../../core/store/gameStore';
import { CosmicBeamsRef } from '../CosmicBeams';
import { MAX_POSITION_ATTEMPTS } from '../config';
import { isPositionValid, generateRandomDonutPosition } from '../utils/beamPositionValidator';

interface UseCosmicBeamSpawnerOptions {
  beamsRef: React.RefObject<CosmicBeamsRef | null>;
  waveParams: {
    donutMinRadius: number;
    donutMaxRadius: number;
    autoSpawn: boolean;
    minSpawnInterval: number;
    maxSpawnInterval: number;
    speedThreshold: number;
  };
  onBeamSpawn: (position: THREE.Vector3) => void;
}

/**
 * Hook to handle automatic beam spawning (speed-based) and manual trigger (key 'Z').
 * Parent only defines what happens when a beam is spawned (onBeamSpawn).
 */
export function useCosmicBeamSpawner({
  beamsRef,
  waveParams,
  onBeamSpawn,
}: UseCosmicBeamSpawnerOptions) {
  const characterRef = useGameStore((state) => state.characterRef);
  const characterPos = useMemo(() => new THREE.Vector3(), []);
  const currentPosCache = useMemo(() => new THREE.Vector3(), []); // Reuse for getWorldPosition
  const prevCharacterPos = useRef<THREE.Vector3 | null>(null);
  const spawnTimer = useRef<number>(0);

  const spawnBeam = useCallback(() => {
    if (!characterRef?.current) return;

    characterRef.current.getWorldPosition(characterPos);
    const beamPositions = beamsRef.current?.getBeamPositions() || [];

    let position: THREE.Vector3 | null = null;
    for (let attempt = 0; attempt < MAX_POSITION_ATTEMPTS; attempt++) {
      const candidate = generateRandomDonutPosition(
        characterPos,
        waveParams.donutMinRadius,
        waveParams.donutMaxRadius
      );
      if (isPositionValid(candidate, beamPositions)) {
        position = candidate;
        break;
      }
    }

    if (!position) {
      position = generateRandomDonutPosition(
        characterPos,
        waveParams.donutMinRadius,
        waveParams.donutMaxRadius
      );
    }

    onBeamSpawn(position);
  }, [characterRef, characterPos, beamsRef, waveParams, onBeamSpawn]);

  useFrame((_, delta) => {
    if (!waveParams.autoSpawn || !characterRef?.current) return;

    // Reuse cached vector instead of creating new one
    characterRef.current.getWorldPosition(currentPosCache);

    if (!prevCharacterPos.current) {
      prevCharacterPos.current = currentPosCache.clone();
      return;
    }

    const distance = currentPosCache.distanceTo(prevCharacterPos.current);
    const speed = distance / delta;

    prevCharacterPos.current.copy(currentPosCache);
    characterPos.copy(currentPosCache);

    if (speed < waveParams.speedThreshold) {
      spawnTimer.current = 0;
      return;
    }

    const speedNormalized = Math.min(speed / 5.0, 1.0);
    const spawnInterval = MathUtils.lerp(
      waveParams.maxSpawnInterval,
      waveParams.minSpawnInterval,
      speedNormalized
    );

    spawnTimer.current += delta;

    if (spawnTimer.current >= spawnInterval) {
      spawnTimer.current = 0;
      spawnBeam();
    }
  });

  return {
    spawnBeam
  };
}

import { useRef, Suspense, useEffect } from 'react';
import { useControls } from 'leva';
import { MathUtils } from 'three';
import { useCosmicBeamSpawner } from './hooks/useCosmicBeamSpawner';
import { useCosmicWaves } from './hooks/useCosmicWaves';
import { CosmicBeams, CosmicBeamsRef } from './CosmicBeams';
import { BeamAudio } from './BeamAudio';
import { gameEvents } from '../../core/events';
import { useShortcut } from '@core/hooks/useShortcut';

export function CosmicSystem() {
  const beamsRef = useRef<CosmicBeamsRef>(null);

  const [waveParams] = useControls('Waves', () => ({
    radiusMin: { value: 5.0, min: 1.0, max: 50.0, step: 0.5 },
    radiusMax: { value: 10.0, min: 1.0, max: 50.0, step: 0.5 },
    lifetimeMin: { value: 3.0, min: 0.5, max: 20.0, step: 0.1 },
    lifetimeMax: { value: 5.0, min: 0.5, max: 20.0, step: 0.1 },
    donutMinRadius: { value: 5.0, min: 1.0, max: 30.0, step: 0.5 },
    donutMaxRadius: { value: 15.0, min: 1.0, max: 50.0, step: 0.5 },
    autoSpawn: { value: true, label: 'Auto Spawn' },
    minSpawnInterval: { value: 2.0, min: 0.1, max: 10.0, step: 0.1, label: 'Min Interval (s)' },
    maxSpawnInterval: { value: 5.0, min: 0.1, max: 10.0, step: 0.1, label: 'Max Interval (s)' },
    speedThreshold: { value: 0.1, min: 0.01, max: 5.0, step: 0.01, label: 'Speed Threshold' },
  }), { collapsed: true });

  useCosmicWaves({ waveParams });

  const { spawnBeam } = useCosmicBeamSpawner({
    beamsRef,
    waveParams,
    onBeamSpawn: (position) => {
      beamsRef.current?.triggerBeam(position, (hitPos) => {
        const radius = MathUtils.lerp(waveParams.radiusMin, waveParams.radiusMax, Math.random());
        gameEvents.emit('beam:hit', { position: hitPos, radius });
      });
    },
  });

  useShortcut('z', () => {
    spawnBeam();
  });

  return (
    <>
      <CosmicBeams ref={beamsRef} />
      <Suspense fallback={null}>
        <BeamAudio />
      </Suspense>
    </>
  );
}

import { useEffect } from 'react';
import { useOneShotAudio } from '@core/hooks/useOneShotAudio';
import { useGameStore } from '../../core/store/gameStore';
import { AudioListener } from 'three/webgpu';
import { gameEvents } from '../../core/events';
import * as THREE from 'three/webgpu';

export function BeamAudio() {
  const listener = useGameStore((state) => state.audioListener);
  const { play } = useOneShotAudio(listener as AudioListener, ['/audio/wave01.mp3']);

  useEffect(() => {
    const onHit = (payload: { position: THREE.Vector3; radius: number }) => {
      play({
        position: payload.position,
        volume: 0.5,
        detuneRange: 300,
        refDistance: 5,
        maxDistance: 60
      });
    };
    gameEvents.on('beam:hit', onHit);
    return () => gameEvents.off('beam:hit', onHit);
  }, [play]);

  return null;
}
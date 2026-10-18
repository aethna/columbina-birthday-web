import { forwardRef, useImperativeHandle } from 'react';
import { useOneShotAudio } from '@core/hooks/useOneShotAudio';
import { StepType } from './hooks/useCharacterPhysics';
import { useGameStore } from '../../core/store/gameStore';
import { AudioListener } from 'three/webgpu';

export interface CharacterAudioHandle {
  playStep: (type: StepType, volume: number) => void;
}

export const CharacterAudio = forwardRef<CharacterAudioHandle>((_, ref) => {
  const listener = useGameStore((state) => state.audioListener);
  const characterRef = useGameStore((state) => state.characterRef);

  const { play } = useOneShotAudio(listener as AudioListener, [
    '/audio/fs_grass1.mp3',
    '/audio/fs_grass2.mp3',
    '/audio/fs_grass3.mp3',
    '/audio/fs_grass4.mp3',
    '/audio/fs_grass5.mp3',
  ]);

  useImperativeHandle(ref, () => ({
    playStep: (type: StepType, volume: number) => {
      play({
        position: characterRef?.current?.position,
        volume,
        detuneRange: 200,
        refDistance: 2,
        maxDistance: 30
      });
    },
  }));

  return null;
});

CharacterAudio.displayName = 'CharacterAudio';
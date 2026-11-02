import mitt from 'mitt';
import type * as THREE from 'three';

export type GameEvents = {
  'rose:spawn': { position: THREE.Vector3; count?: number; radius?: number };
  'game:start': void;
  'game:over': void;
};

export const gameEvents = mitt<GameEvents>();

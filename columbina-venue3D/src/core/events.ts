import mitt from 'mitt';
import type * as THREE from 'three';

export type GameEvents = {
  'beam:spawn': THREE.Vector3;
  'beam:hit': { position: THREE.Vector3; radius: number };
  'rose:spawn': { position: THREE.Vector3; count?: number; radius?: number };
  'game:start': void;
  'game:over': void;
};

export const gameEvents = mitt<GameEvents>();

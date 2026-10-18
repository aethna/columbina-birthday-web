import { useEffect, useRef, MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useAnimations } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { Group, Object3D, AnimationClip } from 'three';

import { calculateBlendWeights } from '../utils/calculateBlendWeights';
import { CameraMode, useGameStore } from '../../../core/store/gameStore';
import { INITIAL_PHYSICS_STATE, PhysicsState } from '../config';
import { solveTank } from '../utils/solveTank';
import { solveCam } from '../utils/solveCam';
import { input } from '../../../core/input/controls';

export type StepType = 'walk' | 'run' | 'back';
export interface StepEvent {
  type: StepType;
  volume: number;
}

export function useCharacterPhysics(
  groupRef: MutableRefObject<Group | null>,
  scene: Object3D | null,
  animations: AnimationClip[],
  onStep: (event: StepEvent) => void
) {
  const { camera } = useThree();
  const cameraMode = useGameStore((state) => state.cameraMode);
  const isMobile = useGameStore((state) => state.isMobile);
  const isControlEnabled = useGameStore((state) => state.isControlEnabled);

  const sceneRef = useRef<Object3D | null>(null);
  sceneRef.current = scene;
  const { actions } = useAnimations(animations, sceneRef);

  const animState = useRef({
    lastWalkTime: 0,
    lastRunTime: 0,
    lastBackTime: 0
  });

  const state = useRef<PhysicsState>({ ...INITIAL_PHYSICS_STATE });

  // Init Animations
  useEffect(() => {
    ['Idle', 'Walk', 'Run', 'Back'].forEach((name) => {
      const action = actions[name];
      if (action) {
        action.reset().play();
        action.setEffectiveWeight(name === 'Idle' ? 1.0 : 0.0);
      }
    });
  }, [actions]);

  const processFootstep = (
    actionName: string,
    weight: number,
    thresholds: number[],
    stateKey: keyof typeof animState.current,
    type: StepType
  ) => {
    const action = actions[actionName];
    if (!action || weight <= 0.5) return;

    const duration = action.getClip().duration;
    const time = (action.time % duration) / duration;
    const lastTime = animState.current[stateKey];

    thresholds.forEach(t => {
      if (lastTime < t && time >= t) {
        onStep?.({ type, volume: weight });
      }
    });

    animState.current[stateKey] = time;
  };

  useFrame((_, delta) => {
    if (!groupRef.current || !isControlEnabled) return;
    
    const s = state.current;

    if (cameraMode === CameraMode.FPV) {
      solveTank(groupRef.current, s, delta, isMobile);
    } else {
      solveCam(groupRef.current, camera, s, delta);
    }

    // Animation blending
    const rotateLeft = input.isPressed('RotateLeft') || input.getAxis('horizontal') < -0.1;
    const rotateRight = input.isPressed('RotateRight') || input.getAxis('horizontal') > 0.1;
    const isRotating = (cameraMode === CameraMode.FPV) && (rotateLeft || rotateRight);
    /* ⚠️ 这里必须传**带符号**的 `s.speed`（负 = 后退）。
     * `solveTank.ts:49` 在后退时写 `targetSpeed = -s.backSpeed`；原本套的那层
     * `Math.abs()` 把后退抹成正向前进 ⇒ `utils/calculateBlendWeights.ts:36` 的
     * `if (speed < 0)` 分支**永远不执行**：后退时播的是 Walk、`actions['Back']`
     * （`useCharacterAssets.ts:107` 注册，上面 :113 连脚步声都接好了）权重恒 0。 */
    const targetWeights = calculateBlendWeights(
      s.speed,
      isRotating,
      s.walkSpeed,
      s.runSpeed,
      s.backSpeed
    );

    s.idleWeight = THREE.MathUtils.lerp(s.idleWeight, targetWeights.idle, s.animBlendLerpFactor);
    s.walkWeight = THREE.MathUtils.lerp(s.walkWeight, targetWeights.walk, s.animBlendLerpFactor);
    s.runWeight = THREE.MathUtils.lerp(s.runWeight, targetWeights.run, s.animBlendLerpFactor);
    s.backWeight = THREE.MathUtils.lerp(s.backWeight, targetWeights.back, s.animBlendLerpFactor);

    actions['Idle']?.setEffectiveWeight(s.idleWeight);
    actions['Walk']?.setEffectiveWeight(s.walkWeight);
    actions['Run']?.setEffectiveWeight(s.runWeight);
    actions['Back']?.setEffectiveWeight(s.backWeight);

    // Footsteps
    processFootstep('Walk', s.walkWeight, [0.05, 0.55], 'lastWalkTime', 'walk');
    processFootstep('Run', s.runWeight, [0.1, 0.6], 'lastRunTime', 'run');
    processFootstep('Back', s.backWeight, [0.1, 0.6], 'lastBackTime', 'back');
  });
}


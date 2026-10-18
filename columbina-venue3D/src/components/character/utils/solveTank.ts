import * as THREE from 'three/webgpu';
import { Group } from 'three';
import { PhysicsState } from '../config';
import { input } from '../../../core/input/controls';

/**
 * SOLVER: TANK MODE (Tank Control)
 * Direct implementation of the original tank controls.
 * W/S = Move Forward/Back
 * A/D = Rotate Left/Right (Velocity based)
 */

export const solveTank = (
  group: Group,
  s: PhysicsState,
  delta: number,
  isMobile: boolean
) => {
  const moveForward = input.isPressed('MoveForward')
  const moveBackward = input.isPressed('MoveBackward')
  const rotateLeft = input.isPressed('RotateLeft')
  const rotateRight = input.isPressed('RotateRight')
  const run = input.isPressed('Run')

  // 1. Rotation (Velocity Based with Lerp)
  let targetRotationVelocity = 0;
  if (rotateLeft) {
    targetRotationVelocity = s.rotateSpeed * (isMobile ? 0.5 : 1);
  } else if (rotateRight) {
    targetRotationVelocity = -s.rotateSpeed * (isMobile ? 0.5 : 1);
  }

  s.rotationVelocity = THREE.MathUtils.lerp(
    s.rotationVelocity,
    targetRotationVelocity,
    s.rotationLerpFactor
  );

  if (Math.abs(s.rotationVelocity) > 0.001) {
    group.rotation.y += s.rotationVelocity * delta;
  }

  // 2. Movement Calculation (Forward/Back)
  let targetSpeed = 0;

  if (moveForward) {
    targetSpeed = run ? s.runSpeed : s.walkSpeed;
  } else if (moveBackward) {
    targetSpeed = -s.backSpeed;
  }

  s.speed = THREE.MathUtils.lerp(s.speed, targetSpeed, s.speedLerpFactor);

  if (Math.abs(s.speed) > 0.01) {
    group.translateZ(s.speed * delta);
  }
};
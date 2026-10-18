import * as THREE from 'three/webgpu';
import { Group, Camera, Euler } from 'three';
import { PhysicsState } from '../config';
import { input } from '../../../core/input/controls';

const getShortestAngleDifference = (from: number, to: number) => {
  const delta = to - from;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
};

const tempEuler = new Euler(0, 0, 0, 'YXZ');
const tempDir = new THREE.Vector3();

/**
 * 转向增益：原来 3.0（约 0.33 秒才转到位）。提到 8.0 让「面向」追得更快，
 * 转弯时她不会长时间侧着身子跑。
 */
const TURN_GAIN = 8.0;

/**
 * ★ 「转身画圆」的修法（本线改，2026-XX）。
 *
 * 原实现有两个叠加的问题：
 *   1. `group.rotation.y += diff * delta * 3.0` 是慢速插值，转向要 ~0.33 秒；
 *   2. 但**同一帧**就 `group.translateZ(speed * delta)` —— 沿**当前朝向**推进。
 *   ⇒ 转弯期间她一边慢慢转头、一边沿旧朝向直线前进，合起来的轨迹就是一段圆弧。
 *      只按 A/D 时更明显：`inputAngle = ±π/2`，她以满速边走边转 90°。
 *
 * 改成：**位移沿「输入方向」而不是「当前朝向」**，朝向再快速追上去。
 * 这样转弯时脚下走的是玩家要的那条直线，视觉上只是「人先转过来」，
 * 不会甩出一条圆。代价是转向那几帧里她身体与行进方向有短暂夹角（约 0.2 米），
 * 这正是所有第三人称游戏的做法。
 *
 * 想回到旧行为（复现 bug / 做对照图）：`?turnmode=arc`。
 */
const MOVE_ALONG_INPUT = (() => {
    try {
        return !new URLSearchParams(location.search).get('turnmode')?.startsWith('arc');
    } catch { return true; }
})();

/**
 * SOLVER: CAMERA MODE (Camera Relative)
 * Input Vector determines Target Angle relative to Camera.
 * Always moves "Forward" relative to the character model.
 */
export const solveCam = (
  group: Group,
  camera: Camera,
  s: PhysicsState,
  delta: number
) => {

  const moveForward = input.isPressed('MoveForward')
  const moveBackward = input.isPressed('MoveBackward')
  const rotateLeft = input.isPressed('RotateLeft')
  const rotateRight = input.isPressed('RotateRight')
  const run = input.isPressed('Run')
  const joyX = input.getAxis('horizontal');
  const joyY = input.getAxis('vertical');

  // 1. Calculate Input Vector (ix, iy)
  let ix = 0;
  let iy = 0;

  // Priority: Joystick > Keyboard
  if (Math.abs(joyX) > 0.01 || Math.abs(joyY) > 0.01) {
    ix = joyX;
    iy = joyY;
  } else {
    // Map WASD to Vector
    if (rotateLeft) ix -= 1;
    if (rotateRight) ix += 1;
    if (moveForward) iy += 1;
    if (moveBackward) iy -= 1;
  }

  const inputLen = Math.sqrt(ix * ix + iy * iy);

  // 2. Logic
  let targetSpeed = 0;
  /** 这一帧玩家想去的方向（世界坐标下的 Y 轴角度）。没输入时保持 null。 */
  let moveAngle: number | null = null;

  if (inputLen > 0.1) {
    // A. Calculate Target Angle relative to Camera
    // FIX: Using (ix, iy) maps Forward Input to Forward Angle (0 rads).
    // (Previous version used -iy which reversed controls)
    const inputAngle = Math.atan2(ix, -iy);

    tempEuler.setFromQuaternion(camera.quaternion);
    const camAngle = tempEuler.y;

    const targetRotation = camAngle + inputAngle;

    // B. Smooth Rotate
    const currentRotation = group.rotation.y;
    const diff = getShortestAngleDifference(currentRotation, targetRotation);

    // 转向增益见文件头 TURN_GAIN。Math.min(1,…) 防低帧率下过冲。
    group.rotation.y += diff * Math.min(1, delta * TURN_GAIN);

    // C. Move Forward
    // 位移方向 = 玩家输入方向（见文件头 MOVE_ALONG_INPUT 的推导）
    moveAngle = targetRotation;

    const maxSpeed = run ? s.runSpeed : s.walkSpeed;
    targetSpeed = maxSpeed * Math.min(inputLen, 1.0);
  }

  // D. Apply Speed
  s.speed = THREE.MathUtils.lerp(s.speed, targetSpeed, s.speedLerpFactor);

  if (Math.abs(s.speed) > 0.01) {
    if (MOVE_ALONG_INPUT && moveAngle !== null) {
      // 「转身画圆」的修法：沿输入方向走直线，朝向让 B 段去追
      tempDir.set(Math.sin(moveAngle), 0, Math.cos(moveAngle));
      group.position.addScaledVector(tempDir, s.speed * delta);
    } else {
      group.translateZ(s.speed * delta);
    }
  }

  // Reset Rotation Velocity (Clean up state from FPV mode)
  s.rotationVelocity = 0;
};
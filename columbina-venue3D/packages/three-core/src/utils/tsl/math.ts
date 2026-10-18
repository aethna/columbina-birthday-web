import * as THREE from "three/webgpu";
import {
  vec2,
  float,
  sqrt,
  dot,
  select,
  pow,
  clamp,
  mix,
  step,
} from "three/tsl";

/**
 * Safely normalizes a 2D vector, returning a default if length is too small.
 */
export const safeNormalize2D = (v: any) => {
  const m2 = dot(v, v);
  const len = sqrt(m2);
  const threshold = float(1e-6);
  return select(len.greaterThan(threshold), v.div(len), vec2(1.0, 0.0));
};

/**
 * Cubic Bezier curve evaluation
 * @param p0 - Start point (vec3)
 * @param p1 - First control point (vec3)
 * @param p2 - Second control point (vec3)
 * @param p3 - End point (vec3)
 * @param t - Parameter [0, 1] (float)
 */
export const bezier3 = (p0: any, p1: any, p2: any, p3: any, t: any) => {
  const u = float(1.0).sub(t);
  const u2 = u.mul(u);
  const u3 = u2.mul(u);
  const t2 = t.mul(t);
  const t3 = t2.mul(t);

  return p0.mul(u3)
    .add(p1.mul(3.0).mul(u2).mul(t))
    .add(p2.mul(3.0).mul(u).mul(t2))
    .add(p3.mul(t3));
};

/**
 * Cubic Bezier curve tangent evaluation
 * Useful for aligning objects along a curve.
 */
export const bezier3Tangent = (p0: any, p1: any, p2: any, p3: any, t: any) => {
  const u = float(1.0).sub(t);
  const u2 = u.mul(u);
  const ut = u.mul(t);
  const t2 = t.mul(t);

  return p1.sub(p0).mul(u2).mul(3.0)
    .add(p2.sub(p1).mul(ut).mul(6.0))
    .add(p3.sub(p2).mul(t2).mul(3.0));
};

/**
 * Easing: easeInOutCubic
 */
export const easeInOutCubic = (t: any) => {
  const clampedT = t.clamp(0.0, 1.0);
  const val1 = clampedT.mul(clampedT).mul(clampedT).mul(4.0);
  const p = clampedT.sub(1.0);
  const val2 = p.mul(p).mul(p).mul(4.0).add(1.0);
  const isSecondHalf = step(0.5, clampedT);
  return mix(val1, val2, isSecondHalf);
};

/**
 * Easing: easeOutCubic
 */
export const easeOutCubic = (t: any) => {
  const x = t.clamp(0.0, 1.0);
  const oneMinusX = float(1.0).sub(x);
  return float(1.0).sub(oneMinusX.mul(oneMinusX).mul(oneMinusX));
};

/**
 * Easing: easeOutExpo
 */
export const easeOutExpo = (t: any) => {
  const x = t.clamp(0.0, 1.0);
  return float(1.0).sub(pow(float(2.0), x.mul(-10.0)));
};

/**
 * Returns a random position inside a sphere of the given radius (centered at origin).
 */
export function getRandomVectorInsideSphere(radius: number): THREE.Vector3 {
  const vector = new THREE.Vector3();
  vector.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  vector.normalize().multiplyScalar(Math.random() * radius);
  return vector;
}


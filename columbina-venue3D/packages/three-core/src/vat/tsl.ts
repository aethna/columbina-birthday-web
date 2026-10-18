import * as THREE from 'three/webgpu'
import {
  abs,
  float,
  mix,
  normalize,
  sign,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import type { VATMeta } from './types'

/** Decode VAT normal texel (oct-encoded or linear RGB). */
export const decodeVatNormal = (texel: any, isCompressed: boolean) => {
  if (isCompressed) {
    const encoded = texel.xy.mul(2.0).sub(1.0)
    const vZ = float(1.0).sub(abs(encoded.x)).sub(abs(encoded.y))
    const v = vec3(encoded.x, encoded.y, vZ)
    const s = sign(v.xy)
    const adj = float(1.0).sub(abs(v.yx)).mul(s)
    const finalXY = mix(adj, v.xy, step(0.0, v.z))
    return normalize(vec3(finalXY.x, finalXY.y, v.z))
  }
  return normalize(texel.rgb.mul(2.0).sub(1.0))
}

/**
 * Build VAT sample UV from animation frame [0, 1] and meta layout.
 * Uses mesh UV1 as the base coordinate.
 */
export function createVATSampleUV(frame: any, meta: VATMeta) {
  const uFrames = uniform(meta.frameCount)
  const frameIndex = uFrames.sub(float(1.0)).mul(frame)
  return vec2(uv(1).x.add(frameIndex.mul(1.0 / meta.textureWidth)), uv(1).y)
}

/** Sample VAT position texture (RGB = local position). */
export function sampleVATPosition(posTex: THREE.Texture, sampleUV: any) {
  return texture(posTex, sampleUV).rgb
}

/** Sample and decode VAT normal texture. */
export function sampleVATNormal(
  nrmTex: THREE.Texture,
  sampleUV: any,
  compressNormal = true
) {
  const rawNormal = texture(nrmTex, sampleUV)
  return decodeVatNormal(rawNormal, compressNormal)
}

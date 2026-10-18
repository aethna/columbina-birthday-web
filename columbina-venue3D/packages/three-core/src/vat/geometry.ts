import * as THREE from 'three'
import type { VATMeta } from './types'

export type SetupVATGeometryOptions = {
  /**
   * Flip X on mesh positions (Unity left-handed -> Three.js right-handed).
   * Default: true
   */
  flipX?: boolean
}

/**
 * Setup VAT geometry: generate UV1 coordinates for Unity VAT texture layout.
 * Optionally converts positions from Unity's left-handed to Three.js right-handed.
 */
export function setupVATGeometry(
  geometry: THREE.BufferGeometry,
  meta: VATMeta,
  options: SetupVATGeometryOptions = {}
): void {
  const { flipX = true } = options
  const count = geometry.getAttribute('position').count
  const positionAttr = geometry.getAttribute('position')

  const uv1Array = new Float32Array(count * 2)
  const padding = meta.padding ?? 2
  const adjustedFramesCount = meta.frameCount + padding

  for (let i = 0; i < count; i++) {
    const columnIndex = Math.floor(i / meta.textureHeight)
    const verticalIndex = i % meta.textureHeight

    const uIdx = columnIndex * adjustedFramesCount
    const vIdx = verticalIndex

    uv1Array[2 * i + 0] = (uIdx + 0.5) / meta.textureWidth
    uv1Array[2 * i + 1] = (vIdx + 0.5) / meta.textureHeight
  }

  geometry.setAttribute('uv1', new THREE.BufferAttribute(uv1Array, 2))

  if (flipX) {
    const positionArray = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      positionArray[3 * i + 0] = positionAttr.getX(i) * -1
      positionArray[3 * i + 1] = positionAttr.getY(i)
      positionArray[3 * i + 2] = positionAttr.getZ(i)
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3))
  }
}

/**
 * Resolve animation frame ratio [0, 1] from explicit ratio or elapsed time.
 */
export function calculateVATFrame(
  frameRatio: number | undefined,
  currentTime: number,
  metaData: VATMeta,
  speed: number
): number {
  if (frameRatio !== undefined) {
    return Math.max(0, Math.min(1, frameRatio))
  }
  const fps = metaData.fps || 24
  const duration = metaData.frameCount / fps
  const timePosition = ((currentTime * speed) % duration) / duration
  return Math.max(0, Math.min(1, timePosition))
}

/** Extract the first mesh geometry from a THREE.Group/Scene. */
export function extractGeometryFromScene(scene: THREE.Group): THREE.BufferGeometry | null {
  let geometry: THREE.BufferGeometry | null = null

  scene.traverse((object: any) => {
    if (object.isMesh && object.geometry && !geometry) {
      geometry = object.geometry.clone()
    }
  })

  return geometry
}

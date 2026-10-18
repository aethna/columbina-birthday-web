import { instancedArray, storage } from 'three/tsl'
import * as THREE from 'three/webgpu'

/** Core VAT metadata (Unity VAT texture layout). */
export interface VATMeta {
  frameCount: number
  textureWidth: number
  textureHeight: number
  textures: {
    position: string
    normal: string
  }
  /** Space between columns (default: 2) */
  padding?: number
  /** Whether normals are oct-encoded */
  compressNormal?: boolean
  /** Mesh path (glb / gltf / fbx) */
  glb?: string
  fps?: number
  storeDelta?: boolean
}

/** Loaded VAT assets for a single meta.json. */
export interface VATData {
  scene: THREE.Group | null
  posTex: THREE.Texture | null
  nrmTex: THREE.Texture | null
  meta: VATMeta | null
  isLoaded: boolean
}

/** Distance-based LOD level configuration. */
export interface VATLODConfig {
  metaPath: string
  minDistance: number
  maxDistance: number
  debugColor?: [number, number, number]
}

/** Runtime LOD buffers after assets are loaded and geometry is set up. */
export interface VATLODBufferConfig extends VATLODConfig {
  geometry: THREE.BufferGeometry
  posTex: THREE.Texture
  nrmTex: THREE.Texture
  meta: VATMeta
  indices: ReturnType<typeof instancedArray>
  drawBuffer: THREE.IndirectStorageBufferAttribute
  drawStorage: ReturnType<typeof storage>
  vertexCount: number
}

import { struct } from 'three/tsl'
import type { VATLODConfig, VATLODBufferConfig } from '@core'

// Rose-specific aliases over shared VAT LOD types
export type RoseLODConfig = VATLODConfig
export type RoseLODBufferConfig = VATLODBufferConfig

// Re-export core VAT types used by Rose
export type { VATMeta } from '@core'

/**
 * Rose instance layout: lifecycle-driven spawn system.
 * Not part of shared VAT — each project defines its own instance fields.
 */
export const roseVatStructure = struct({
  position: 'vec3',
  isActive: 'float',
  frame: 'float',
  age: 'float',
  seed: 'float',
  progress: 'float',
})

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_ROSE_LOD_CONFIG: RoseLODConfig[] = [
  {
    metaPath: '/vat/Rose_meta.json',
    minDistance: 0,
    maxDistance: 5,
    debugColor: [1, 0, 0],
  },
  {
    metaPath: '/vat/RoseLowPoly_meta.json',
    minDistance: 5,
    maxDistance: Infinity,
    debugColor: [0, 1, 0],
  },
]

export const ROSE_TEXTURES = {
  petal: '/textures/Rose/Rose_Petal_Diff.ktx2',
  outline: '/textures/Rose/Rose_Outline.ktx2',
  normal: '/textures/Rose/Rose_Petal_Normal.ktx2',
}

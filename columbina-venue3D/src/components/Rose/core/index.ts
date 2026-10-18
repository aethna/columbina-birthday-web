// Rose-specific VAT material and compute (lifecycle / spawn)
export { createVATMaterial } from './vatMaterial'
export {
  createUpdateCompute,
  createSpawnCompute,
  createResetInstanceCompute,
  createRoseInstanceData,
  createResetCountCompute,
  createVisibleIndicesBuffer,
} from './vatCompute'

// Rose config
export {
  DEFAULT_ROSE_LOD_CONFIG,
  ROSE_TEXTURES,
  roseVatStructure,
} from './config'
export type { RoseLODConfig, RoseLODBufferConfig, VATMeta } from './config'

// Re-export shared VAT utilities from @core for local convenience
export {
  setupVATGeometry,
  calculateVATFrame,
  extractGeometryFromScene,
  preloadVATAssets,
  useVATPreloader,
} from '@core'

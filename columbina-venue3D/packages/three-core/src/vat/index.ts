export type {
  VATMeta,
  VATData,
  VATLODConfig,
  VATLODBufferConfig,
} from './types'

export { drawIndirectStructure } from './structures'

export {
  setupVATGeometry,
  calculateVATFrame,
  extractGeometryFromScene,
} from './geometry'
export type { SetupVATGeometryOptions } from './geometry'

export {
  preloadVATAssets,
  useVATPreloader,
  clearVATCache,
} from './loader'

export {
  decodeVatNormal,
  createVATSampleUV,
  sampleVATPosition,
  sampleVATNormal,
} from './tsl'

export {
  createVisibleIndicesBuffer,
  createResetCountCompute,
  createLODRouting,
} from './compute'
export type { VATLODRoutingBuffer } from './compute'

import { struct } from 'three/tsl'

/**
 * WebGPU drawIndirect / drawIndexedIndirect buffer layout.
 * [vertexCount/indexCount, instanceCount, firstVertex/firstIndex, firstInstance, offset/baseVertex]
 */
export const drawIndirectStructure = struct({
  vertexCount: 'uint',
  instanceCount: { type: 'uint', atomic: true },
  firstVertex: 'uint',
  firstInstance: 'uint',
  offset: 'uint',
})

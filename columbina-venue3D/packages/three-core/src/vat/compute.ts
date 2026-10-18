import {
  atomicAdd,
  atomicStore,
  float,
  Fn,
  If,
  instancedArray,
  storage,
  uint,
} from 'three/tsl'

/** Per-instance visible index buffer for indirect draw. */
export function createVisibleIndicesBuffer(count: number) {
  return instancedArray(new Uint32Array(count), 'uint')
}

/** Reset indirect draw counters for one LOD buffer. */
export function createResetCountCompute(
  drawStorage: ReturnType<typeof storage>,
  indexCount: number
) {
  return Fn(() => {
    drawStorage.get('vertexCount').assign(uint(indexCount))
    atomicStore(drawStorage.get('instanceCount'), uint(0))
  })().compute(1)
}

export type VATLODRoutingBuffer = {
  drawStorage: ReturnType<typeof storage>
  indices: ReturnType<typeof instancedArray>
  minDistance: number
  maxDistance: number
}

/**
 * Build a distance-based LOD routing function for use inside a compute Fn.
 * Assigns instances into the matching LOD's visible-indices buffer.
 */
export function createLODRouting(lodBuffers: VATLODRoutingBuffer[]) {
  return (distToCamera: any, instanceIdx: any) => {
    if (lodBuffers.length === 0) return

    if (lodBuffers.length === 1) {
      const config = lodBuffers[0]
      const lodIndex = atomicAdd(config.drawStorage.get('instanceCount'), uint(1))
      config.indices.element(lodIndex).assign(uint(instanceIdx))
      return
    }

    const buildChain = (index: number): any => {
      if (index >= lodBuffers.length) return

      const config = lodBuffers[index]
      const isLast = index === lodBuffers.length - 1

      const minDist = float(config.minDistance)
      const maxDist =
        config.maxDistance === Infinity ? float(1e9) : float(config.maxDistance)

      const inRange = distToCamera.greaterThanEqual(minDist).and(
        isLast || config.maxDistance === Infinity
          ? distToCamera.lessThanEqual(maxDist)
          : distToCamera.lessThan(maxDist)
      )

      const lodBlock = () => {
        const lodIndex = atomicAdd(config.drawStorage.get('instanceCount'), uint(1))
        config.indices.element(lodIndex).assign(uint(instanceIdx))
      }

      if (isLast) {
        return If(inRange, lodBlock)
      }

      const nextChain = buildChain(index + 1)
      return If(inRange, lodBlock).Else(() => {
        if (nextChain) nextChain
      })
    }

    const chain = buildChain(0)
    if (chain) chain
  }
}

import { describe, expect, it } from 'vitest'
import {
  sameAmbientOcclusion,
  topFaceAmbientOcclusion,
  vertexAmbientOcclusion,
} from './terrainShading.js'

function sampleHeight(map, x, z) {
  return map[z]?.[x] ?? 0
}

describe('地形顶点环境遮蔽烘焙', () => {
  it('使用两侧格和对角格计算四级体素 AO', () => {
    expect(vertexAmbientOcclusion(false, false, false)).toBe(3)
    expect(vertexAmbientOcclusion(false, false, true)).toBe(2)
    expect(vertexAmbientOcclusion(true, false, true)).toBe(1)
    expect(vertexAmbientOcclusion(true, true, false)).toBe(1)
  })

  it('只在较高相邻地形朝向低平台的两个顶点烘焙阴影', () => {
    const map = [
      [2, 3, 2],
      [2, 2, 2],
      [2, 2, 2],
    ]
    expect(topFaceAmbientOcclusion(map, 1, 1, 2, sampleHeight)).toEqual([2, 2, 3, 3])
  })

  it('AO 相同的地块仍可参与贪心合并', () => {
    expect(sameAmbientOcclusion([3, 3, 3, 3], [3, 3, 3, 3])).toBe(true)
    expect(sameAmbientOcclusion([2, 2, 3, 3], [3, 3, 3, 3])).toBe(false)
  })
})


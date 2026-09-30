// Height-field adaptation of the MIT-licensed vertex AO rule used by
// https://github.com/mikolalysenko/ao-mesher
// 3 = fully open, 1 = the darkest valid corner in this surface mesher.
export function vertexAmbientOcclusion(sideA, sideB, corner) {
  if (sideA && sideB) return 1
  return 3 - (Number(sideA) + Number(sideB) + Number(corner))
}

export function topFaceAmbientOcclusion(map, x, z, height, sampleHeight) {
  const cornerAo = (offsetX, offsetZ) => vertexAmbientOcclusion(
    sampleHeight(map, x + offsetX, z) > height,
    sampleHeight(map, x, z + offsetZ) > height,
    sampleHeight(map, x + offsetX, z + offsetZ) > height,
  )

  return [
    cornerAo(-1, -1),
    cornerAo(1, -1),
    cornerAo(1, 1),
    cornerAo(-1, 1),
  ]
}

export function sameAmbientOcclusion(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

// Strong enough to remain readable after the hemisphere fill light is applied.
export const AO_LIGHT_LEVELS = Object.freeze([0, 0.5, 0.74, 1])

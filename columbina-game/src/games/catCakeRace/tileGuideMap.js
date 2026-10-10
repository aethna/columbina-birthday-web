import {
  DIRECTION,
  MECHANISM_TYPE,
  MapTile,
  RaceMap,
  TERRAIN_TYPE,
  TileMechanism,
} from './domain.js'

const sampleX = Array.from({ length: 10 }, (_, index) => 1 + index * 3)
const tiles = Array.from({ length: 3 }, (_, y) => (
  Array.from({ length: 29 }, (_, x) => new MapTile({ x, y, terrainType: TERRAIN_TYPE.PIT }))
))
const samples = [
  (x, y) => new MapTile({ x, y, baseHeight: 2 }),
  (x, y) => new MapTile({ x, y, terrainType: TERRAIN_TYPE.WALL }),
  null,
  (x, y) => new MapTile({ x, y, terrainType: TERRAIN_TYPE.SPIKES, symbol: '^' }),
  (x, y) => new MapTile({ x, y, mechanism: new TileMechanism({ type: MECHANISM_TYPE.GLUE }) }),
  (x, y) => new MapTile({ x, y, mechanism: new TileMechanism({ type: MECHANISM_TYPE.SPRING, direction: DIRECTION.RIGHT }), symbol: 'u' }),
  (x, y) => new MapTile({ x, y, mechanism: new TileMechanism({ type: MECHANISM_TYPE.PISTON, direction: DIRECTION.RIGHT }), symbol: 'R' }),
  (x, y) => new MapTile({ x, y, mechanism: new TileMechanism({ type: MECHANISM_TYPE.TRACTOR_BOMB }), symbol: 'b' }),
  (x, y) => new MapTile({ x, y, isCheckpoint: true }),
  (x, y) => new MapTile({ x, y, isFinish: true }),
]

samples.forEach((createTile, index) => {
  if (createTile) tiles[1][sampleX[index]] = createTile(sampleX[index], 1)
})

const pitX = sampleX[2]
for (let y = 0; y < 3; y += 1) {
  for (let x = pitX - 1; x <= pitX + 1; x += 1) {
    if (x === pitX && y === 1) continue
    tiles[y][x] = new MapTile({ x, y })
  }
}

export const tileGuideMap = new RaceMap({ width: 29, height: 3, tiles })

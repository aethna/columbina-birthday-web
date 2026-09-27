import {
  DIRECTION,
  MECHANISM_TYPE,
  MapTile,
  RaceMap,
  TERRAIN_TYPE,
  TileMechanism,
  canJumpBetweenHeights,
  tileStandingHeight,
} from './domain.js'

export const MAP_WIDTH = 10
export const MAP_HEIGHT = 50

export const MAP_LAYOUTS = Object.freeze({
  map1: [
    '..........','FFFFFFFFFF','b.0.2L.^R.','.0..2.g...','....2..0..','..u.2.....','...P..2..L','.^....2.w.','....o.2...','..g...0...',
    'CCCCCCCCCC','...000....','..0.L.2.P.','.^0...2...','..0.g.....','..0..u....','..0.P..^..','..000.....','....o.....','..2...g...',
    'CCCCCCCCCC','..R222....','..0.2..^..','..u.2.....','.^..2.....','...02.g...','...0..2.P.','.o....2...','..000.....','....g.....',
    'CCCCCCCCCC','..2220....','..2.L0.^..','..2.u0....','..2.P0....','..2.g0....','..2..000..','..2....o..','..0...^...','...g......',
    'CCCCCCCCCC','..000.....','..0.L^....','..0.u.....','..0.P.222.','..0.g.2...','..000.2...','.x..o.2...','..^...2...','SSSSSSSSSS',
  ],
  map2: [
    '..........','FFFFFFFFFF','#b.ooo...#','#Rw...##.#','#.P.g..#.#','###.u..#.#','#..^^..#.#','#.x....#.#','#..ooo..w#','#....g...#',
    'CCCCCCCCCC','#.###.u..#','#...o.P..#','#.w.o.##.#','#...o.g..#','###.o....#','#.u...^^.#','#...###..#','#.x.....x#','#...g....#',
    'CCCCCCCCCC','#.u..###.#','#Pooo....#','#...#.w..#','#.g.#....#','#...#.^^.#','#.x.#....#','#...#..o.#','#.u...Rgu#','#........#',
    'CCCCCCCCCC','###.w....#','#..Pooo..#','#.u...##.#','#...g....#','#.###.x..#','#...^....#','#.ooo.##.#','#...u...w#','#....g...#',
    'CCCCCCCCCC','#.x..##..#','#.P.o....L','#.w.o.#..#','#...o.g..#','###.u....#','#..^^....#','#.x..##.u#','#....g.L.#','SSSSSSSSSS',
  ],
  map3: [
    '..........','FFFFFFFFFF','#bu#..P..#','#..##.^..#','#..P..o..#','#.....R..#','#..##u...#','#..g..L..#','#..^..o..#','#.....P..#',
    'CCCCCCCCCC','#..R..##.#','#..#.w.L.#','#..#.o...#','#..D...^.#','#.....##.#','#..g.R...#','#..#...o.#','#..P.uL..#','#..#.....#',
    'CCCCCCCCCC','#..##..R.#','#..L.x...#','#..#.^...#','#..#...P.#','#.....o..#','#..R..##.#','#..#g....#','#..D.w.L.#','#..#.....#',
    'CCCCCCCCCC','#..P.###.#','#..#...R.#','#..#o....#','#..L.u.^.#','#.....##.#','#..g.D...#','#..#...o.#','#u.R..P..#','#..#.....#',
    'CCCCCCCCCC','#..##.L..#','#..P.w...#','#..#.^...#','#..R...o.#','#.....##.#','#..g..D..#','#..#...L.#','#..P.w...#','SSSSSSSSSS',
  ],
  map4: [
    '..........','FFFFFFFFFF','R..o....^t','b..R.2....','..g...^..t','b..o...u..','...^....ot','b....P2...','..w.wo...t','b..g...^..',
    'CCCCCCCCCC','t...0...^.','..o...Pg.b','t..R..2...','..^.....ob','t..g...u..','..o...^..b','t....2P...','..x.u..o.b','t..^...g..',
    'CCCCCCCCCC','b...2...o.','..^...Pg.t','b..R......','..u...2..t','b....g....','..o....^.t','b..w.P....','..^.w.o..t','b...2.g...',
    'CCCCCCCCCC','t...0...o.','..g...P^.b','t..R..2...','..o...u..b','t..^......','..x...g..b','t....oP...','..^.u.2..b','t..g......',
    'CCCCCCCCCC','b...2...^.','..o...Pg.t','b..R..u...','..^...2..t','b..g......','..w...o..t','b....^.P..','..o.u.x..t','SSSSSSSSSS',
  ],
  map5: [
    '..........','FFFFFFFFFF','..o#..P...','x..#...^.t','...L....o.','b.##.x....','..g...R...','P...#....t','..^...w...','b...2....t',
    'CCCCCCCCCC','t..#......','.R.#.uo..b','..^#...L..','u..#.....b','t.##..g...','..P...^...','...#...R.b','x..#..o...','t...2....b',
    'CCCCCCCCCC','b..#..P...','..o#.w...t','w..#...L..','...R....^.','b.##..g..t','..^...D...','...#..o..t','u..#...R..','b...2....t',
    'CCCCCCCCCC','t..#..L...','..^#.u...b','x..#...o..','...P....^b','t.##..g...','..R...o...','...#...D.b','w..#..^...','t...2....b',
    'CCCCCCCCCC','b..#..P...','..o#.w...t','x..#...L..','...R....^.','b.##..g..t','..^...D...','u..#..o..t','bu..2.R..t','SSSSSSSSSS',
  ],
})

const MAP_NAMES = Object.freeze({
  map1: '地图一：云上起跑线',
  map2: '地图二：碎石回廊',
  map3: '地图三：交错平台',
  map4: '地图四：灰岩台地',
  map5: '地图五：星桥终线',
})

function mechanismForSymbol(symbol) {
  if (symbol === 'g') return new TileMechanism({ type: MECHANISM_TYPE.GLUE })
  if (symbol === 'u') return new TileMechanism({ type: MECHANISM_TYPE.SPRING, direction: DIRECTION.UP, parameters: { distance: 2 } })
  if (symbol === 'w') return new TileMechanism({ type: MECHANISM_TYPE.SPRING, direction: DIRECTION.UP, parameters: { distance: 3 } })
  if (symbol === 'x') return new TileMechanism({ type: MECHANISM_TYPE.SPRING, direction: DIRECTION.UP, parameters: { distance: 4 } })
  if (symbol === 'R') return new TileMechanism({ type: MECHANISM_TYPE.PISTON, direction: DIRECTION.RIGHT, parameters: { intervalMs: 3000, minDistance: 1, maxDistance: 3 } })
  if (symbol === 'L') return new TileMechanism({ type: MECHANISM_TYPE.PISTON, direction: DIRECTION.LEFT, parameters: { intervalMs: 3000, minDistance: 1, maxDistance: 3 } })
  if (symbol === 'P') return new TileMechanism({ type: MECHANISM_TYPE.PISTON, direction: DIRECTION.UP, parameters: { intervalMs: 3000, minDistance: 1, maxDistance: 3 } })
  if (symbol === 'D') return new TileMechanism({ type: MECHANISM_TYPE.PISTON, direction: DIRECTION.DOWN, parameters: { intervalMs: 3000, minDistance: 1, maxDistance: 3 } })
  if (symbol === 'b' || symbol === 't') return new TileMechanism({
    type: MECHANISM_TYPE.TRACTOR_BOMB,
    parameters: {
      intervalMs: 10_000,
      contactDetonates: true,
      triggerRadius: 1,
      effectRadius: 3,
      blocksMovement: false,
    },
  })
  return null
}

function tileForSymbol(symbol, x, y) {
  const baseHeight = symbol === '.' || symbol === 'S' || symbol === 'F' || symbol === 'C' || symbol === 'g' || symbol === 'b' || symbol === 't' || symbol === 'u' || symbol === 'w' || symbol === 'x' || symbol === 'R' || symbol === 'L' || symbol === 'P' || symbol === 'D' || symbol === '^' ? 1 : 0
  const terrainType = symbol === '#' ? TERRAIN_TYPE.WALL : symbol === 'o' ? TERRAIN_TYPE.PIT : symbol === '^' ? TERRAIN_TYPE.SPIKES : TERRAIN_TYPE.NORMAL
  return new MapTile({
    x,
    y,
    symbol,
    baseHeight: symbol === '2' ? 2 : baseHeight,
    terrainType,
    isStart: symbol === 'S',
    isCheckpoint: symbol === 'C',
    isFinish: symbol === 'F',
    mechanism: mechanismForSymbol(symbol),
  })
}

function isInsideBombEffect(tile, bombTile) {
  const radius = bombTile.mechanism.parameters.effectRadius ?? 3
  return Math.abs(tile.position.x - bombTile.position.x)
    + Math.abs(tile.position.y - bombTile.position.y) <= radius
}

function isPistonTarget(tile, pistonTile) {
  return pistonTile.position.move(pistonTile.mechanism.direction).equals(tile.position)
}

function isInsideUnsafeMechanismArea(map, tile) {
  return map.flatTiles.some((mechanismTile) => {
    if (mechanismTile.mechanism?.type === MECHANISM_TYPE.TRACTOR_BOMB) {
      return isInsideBombEffect(tile, mechanismTile)
    }
    if (mechanismTile.mechanism?.type === MECHANISM_TYPE.PISTON) {
      return isPistonTarget(tile, mechanismTile)
    }
    return false
  })
}

function isGuaranteedSpring(map, springTile) {
  const distance = springTile.mechanism.parameters.distance ?? 1
  let current = springTile.position
  let travelled = 0
  for (let step = 0; step < distance; step += 1) {
    const next = map.getTile(current.move(springTile.mechanism.direction))
    const heightBlocksLaunch = distance > 1 && next
      && tileStandingHeight(next) > tileStandingHeight(springTile)
    if (!next || next.terrainType === TERRAIN_TYPE.WALL || !next.canJumpIn || heightBlocksLaunch) break
    if (
      next.terrainType !== TERRAIN_TYPE.NORMAL
      || !next.canStand
      || (next.mechanism && next.mechanism.type !== MECHANISM_TYPE.GLUE)
      || isInsideUnsafeMechanismArea(map, next)
    ) return false
    current = next.position
    travelled += 1
  }
  return travelled > 0
}

function isStableRouteTile(map, tile) {
  if (!tile?.canStand || !tile.canJumpIn || !tile.canJumpOut) return false
  if (tile.terrainType !== TERRAIN_TYPE.NORMAL || tile.mechanism !== null) return false
  return !map.flatTiles.some((mechanismTile) => {
    if (mechanismTile.mechanism?.type === MECHANISM_TYPE.TRACTOR_BOMB) {
      return isInsideBombEffect(tile, mechanismTile)
    }
    if (mechanismTile.mechanism?.type === MECHANISM_TYPE.PISTON) {
      return isPistonTarget(tile, mechanismTile)
    }
    return false
  })
}

function isGuaranteedRouteTile(map, tile) {
  if (!tile?.canStand || !tile.canJumpIn || !tile.canJumpOut) return false
  if (tile.terrainType !== TERRAIN_TYPE.NORMAL) return false
  if (tile.mechanism
    && tile.mechanism.type !== MECHANISM_TYPE.GLUE
    && !(tile.mechanism.type === MECHANISM_TYPE.SPRING && isGuaranteedSpring(map, tile))) return false
  return !isInsideUnsafeMechanismArea(map, tile)
}

function findRoute(map, canUseTile) {
  if (!(map instanceof RaceMap)) throw new TypeError('map must be a RaceMap')
  const starts = map.flatTiles.filter((tile) => tile.isStart && canUseTile(map, tile))
  const queue = [...starts]
  const visited = new Set(starts.map((tile) => tile.position.key))
  const previous = new Map()

  while (queue.length > 0) {
    const tile = queue.shift()
    if (tile.isFinish) {
      const route = []
      let key = tile.position.key
      while (key) {
        const routeTile = map.tileIndex.get(key)
        route.push(routeTile.position.clone())
        key = previous.get(key) ?? null
      }
      return route.reverse()
    }

    Object.values(DIRECTION).forEach((direction) => {
      const next = map.getTile(tile.position.move(direction))
      if (!next || visited.has(next.position.key) || !canUseTile(map, next)) return
      if (!canJumpBetweenHeights(tileStandingHeight(tile), tileStandingHeight(next))) return
      visited.add(next.position.key)
      previous.set(next.position.key, tile.position.key)
      queue.push(next)
    })
  }
  return []
}

export function findStableRoute(map) {
  return findRoute(map, isStableRouteTile)
}

export function findGuaranteedRoute(map) {
  return findRoute(map, isGuaranteedRouteTile)
}

export function parseMapLayout(id, rows) {
  if (!Array.isArray(rows) || rows.length !== MAP_HEIGHT) throw new RangeError(`${id} must contain ${MAP_HEIGHT} rows`)
  if (rows.some((row) => typeof row !== 'string' || row.length !== MAP_WIDTH)) {
    throw new RangeError(`${id} must contain ${MAP_WIDTH}-character rows`)
  }
  const tiles = rows.map((row, y) => [...row].map((symbol, x) => tileForSymbol(symbol, x, y)))
  const map = new RaceMap({ width: MAP_WIDTH, height: MAP_HEIGHT, tiles })
  map.id = id
  map.name = MAP_NAMES[id] ?? id
  map.startRow = rows.findIndex((row) => row.includes('S'))
  map.finishRow = rows.findIndex((row) => row.includes('F'))
  map.respawnRows = rows.map((row, y) => (row.includes('C') ? y : null)).filter((y) => y !== null)
  map.stableRoute = findStableRoute(map)
  map.guaranteedRoute = findGuaranteedRoute(map)
  if (map.guaranteedRoute.length === 0) throw new Error(`${id} does not contain a guaranteed route from start to finish`)
  return map
}

export function createDesignedMap(id = 'map1') {
  if (!MAP_LAYOUTS[id]) throw new Error(`Unknown designed map: ${id}`)
  return parseMapLayout(id, MAP_LAYOUTS[id])
}

export function createDesignedMaps() {
  return Object.fromEntries(Object.keys(MAP_LAYOUTS).map((id) => [id, createDesignedMap(id)]))
}

function cloneMechanism(mechanism) {
  return mechanism
    ? new TileMechanism({ type: mechanism.type, direction: mechanism.direction, parameters: mechanism.parameters })
    : null
}

function cloneRaceMap(source) {
  const tiles = source.tiles.map((row) => row.map((tile) => new MapTile({
    x: tile.position.x,
    y: tile.position.y,
    baseHeight: tile.baseHeight,
    terrainType: tile.terrainType,
    canStand: tile.canStand,
    canJumpIn: tile.canJumpIn,
    canJumpOut: tile.canJumpOut,
    isStart: tile.isStart,
    isCheckpoint: tile.isCheckpoint,
    isFinish: tile.isFinish,
    mechanism: cloneMechanism(tile.mechanism),
    symbol: tile.symbol,
  })))
  const map = new RaceMap({ width: source.width, height: source.height, tiles })
  map.id = source.id
  map.name = source.name
  map.startRow = source.startRow
  map.finishRow = source.finishRow
  map.respawnRows = [...source.respawnRows]
  map.stableRoute = source.stableRoute.map((position) => position.clone())
  map.guaranteedRoute = source.guaranteedRoute.map((position) => position.clone())
  return map
}

function shuffle(values, random) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const previous = result[index]
    result[index] = result[swapIndex]
    result[swapIndex] = previous
  }
  return result
}

function randomMechanism(random) {
  const roll = random()
  if (roll < 0.2) return new TileMechanism({ type: MECHANISM_TYPE.GLUE })
  if (roll < 0.55) return new TileMechanism({
    type: MECHANISM_TYPE.SPRING,
    direction: DIRECTION.UP,
    parameters: { distance: 1 + Math.floor(random() * 3) },
  })
  if (roll < 0.85) {
    const directions = [DIRECTION.LEFT, DIRECTION.RIGHT, DIRECTION.UP, DIRECTION.DOWN]
    return new TileMechanism({
      type: MECHANISM_TYPE.PISTON,
      direction: directions[Math.floor(random() * directions.length)],
      parameters: { intervalMs: 3000, minDistance: 1, maxDistance: 3 },
    })
  }
  return new TileMechanism({
    type: MECHANISM_TYPE.TRACTOR_BOMB,
    parameters: {
      intervalMs: 10_000,
      contactDetonates: true,
      triggerRadius: 1,
      effectRadius: 3,
      blocksMovement: false,
    },
  })
}

function symbolForMechanism(mechanism) {
  if (mechanism.type === MECHANISM_TYPE.GLUE) return 'g'
  if (mechanism.type === MECHANISM_TYPE.SPRING) return 'u'
  if (mechanism.type === MECHANISM_TYPE.TRACTOR_BOMB) return 'b'
  return ({
    [DIRECTION.LEFT]: 'L',
    [DIRECTION.RIGHT]: 'R',
    [DIRECTION.UP]: 'P',
    [DIRECTION.DOWN]: 'D',
  })[mechanism.direction]
}

export function createRandomizedMap(id = null, { random = Math.random } = {}) {
  if (typeof random !== 'function') throw new TypeError('random must be a function')
  const baseIds = Object.keys(MAP_LAYOUTS)
  const sourceId = id ?? baseIds[Math.floor(random() * baseIds.length)]
  if (!MAP_LAYOUTS[sourceId]) throw new Error(`Unknown designed map: ${sourceId}`)
  const source = createDesignedMap(sourceId)
  const map = cloneRaceMap(source)
  // Some layouts deliberately use safe forward springs as their fastest
  // guaranteed corridor. Preserve that corridor when there is no completely
  // mechanism-free route to protect.
  const routeToProtect = source.stableRoute.length > 0
    ? source.stableRoute
    : source.guaranteedRoute
  const protectedRoute = routeToProtect.map((position) => position.clone())
  const routeKeys = new Set(protectedRoute.map((position) => position.key))

  // Every possible bottom-to-top route must cross this row. Turning every
  // standable tile on it into recoverable glue removes a zero-risk route while
  // keeping the race completable because glue always expires after five seconds.
  const gateRows = shuffle([...new Set(protectedRoute
    .map((position) => position.y)
    .filter((y) => ![map.startRow, map.finishRow, ...map.respawnRows].includes(y)))], random)
  const gateRow = gateRows[0]
  map.getRow(gateRow).forEach((tile) => {
    if ([TERRAIN_TYPE.WALL, TERRAIN_TYPE.PIT].includes(tile.terrainType)) return
    tile.terrainType = TERRAIN_TYPE.NORMAL
    tile.canStand = true
    tile.canJumpIn = true
    tile.canJumpOut = true
    tile.mechanism = new TileMechanism({ type: MECHANISM_TYPE.GLUE })
    tile.symbol = 'g'
  })

  const candidates = shuffle(map.flatTiles.filter((tile) => (
    tile.terrainType === TERRAIN_TYPE.NORMAL
    && tile.mechanism === null
    && !tile.isStart
    && !tile.isFinish
    && !tile.isCheckpoint
    && !routeKeys.has(tile.position.key)
  )), random)
  const targetAmount = Math.min(candidates.length, 12 + Math.floor(random() * 12))
  let placed = 0
  for (const tile of candidates) {
    if (placed >= targetAmount) break
    const mechanism = randomMechanism(random)
    const candidate = { position: tile.position, mechanism }
    if (mechanism.type === MECHANISM_TYPE.TRACTOR_BOMB
      && protectedRoute.some((position) => isInsideBombEffect({ position }, candidate))) continue
    if (mechanism.type === MECHANISM_TYPE.PISTON
      && routeKeys.has(tile.position.move(mechanism.direction).key)) continue
    tile.mechanism = mechanism
    tile.symbol = symbolForMechanism(mechanism)
    placed += 1
  }

  map.sourceMapId = sourceId
  map.id = id ?? 'random'
  map.name = id
    ? `${source.name} · 随机布局`
    : `随机地形：${source.name.replace(/^地图[一二三四五]：/, '')}`
  map.stableRoute = findStableRoute(map)
  map.guaranteedRoute = findGuaranteedRoute(map)
  if (map.stableRoute.length > 0) throw new Error(`${map.name} unexpectedly contains a zero-risk route`)
  if (map.guaranteedRoute.length === 0) throw new Error(`${map.name} does not contain a guaranteed route`)
  return map
}

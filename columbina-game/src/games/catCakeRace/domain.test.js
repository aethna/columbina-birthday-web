import { describe, expect, it } from 'vitest'
import {
  AI_DIFFICULTY,
  AI_DIFFICULTY_CONFIG,
  CONTROLLER_TYPE,
  CatCake,
  DIRECTION,
  GLUE_MAX_DURATION_MS,
  GridPosition,
  MapTile,
  MECHANISM_TYPE,
  NORMAL_JUMP_COOLDOWN_MS,
  PISTON_INTERVAL_MS,
  RACE_COUNTDOWN_MS,
  RACE_STATUS,
  RaceMap,
  RaceSession,
  RESPAWN_INVINCIBILITY_MS,
  STACK_ROLE,
  TERRAIN_TYPE,
  TRACTOR_BOMB_EFFECT_RADIUS,
  TRACTOR_BOMB_INTERVAL_MS,
  TRACTOR_BOMB_MAX_PULL_DISTANCE,
  TRACTOR_BOMB_MIN_PULL_DISTANCE,
  TRACTOR_BOMB_TRIGGER_RADIUS,
  TractorBomb,
  TileMechanism,
  canJumpBetweenHeights,
  createFoundationRace,
  createPlayableRace,
} from './domain.js'
import {
  MAP_HEIGHT,
  MAP_LAYOUTS,
  MAP_WIDTH,
  createDesignedMap,
  createDesignedMaps,
  createRandomizedMap,
} from './maps.js'

function createHeightRace(targetHeight) {
  const map = new RaceMap({
    width: 5,
    height: 2,
    tiles: [
      Array.from({ length: 5 }, (_, x) => new MapTile({ x, y: 0, baseHeight: x === 2 ? targetHeight : 0, isFinish: true })),
      Array.from({ length: 5 }, (_, x) => new MapTile({ x, y: 1, isStart: true })),
    ],
  })
  const contestants = [
    new CatCake({ id: 'player', name: 'player', controllerType: CONTROLLER_TYPE.PLAYER, startPosition: new GridPosition(2, 1) }),
    ...[0, 1, 3, 4].map((x, index) => new CatCake({
      id: `ai-${index}`,
      name: `ai-${index}`,
      controllerType: CONTROLLER_TYPE.AI,
      startPosition: new GridPosition(x, 1),
    })),
  ]
  const race = new RaceSession({ map, contestants })
  race.startCountdown(0)
  race.advanceClock(RACE_COUNTDOWN_MS)
  return race
}

function createBombRace({
  positions = [
    new GridPosition(0, 3),
    new GridPosition(0, 0),
    new GridPosition(6, 0),
    new GridPosition(0, 6),
    new GridPosition(6, 6),
  ],
  randomValues = [0],
  configureMap = () => {},
} = {}) {
  const width = 7
  const height = 7
  const tiles = Array.from({ length: height }, (_, y) => (
    Array.from({ length: width }, (_, x) => new MapTile({ x, y }))
  ))
  tiles[3][3].mechanism = new TileMechanism({
    type: MECHANISM_TYPE.TRACTOR_BOMB,
    parameters: {
      intervalMs: TRACTOR_BOMB_INTERVAL_MS,
      triggerRadius: TRACTOR_BOMB_TRIGGER_RADIUS,
      effectRadius: TRACTOR_BOMB_EFFECT_RADIUS,
      blocksMovement: false,
    },
  })
  const map = new RaceMap({ width, height, tiles })
  configureMap(map)
  const contestants = positions.map((position, index) => new CatCake({
    id: index === 0 ? 'player' : `ai-${index}`,
    name: index === 0 ? 'player' : `ai-${index}`,
    controllerType: index === 0 ? CONTROLLER_TYPE.PLAYER : CONTROLLER_TYPE.AI,
    startPosition: position,
  }))
  let randomIndex = 0
  const race = new RaceSession({
    map,
    contestants,
    random: () => randomValues[Math.min(randomIndex++, randomValues.length - 1)],
  })
  race.startCountdown(0)
  race.advanceClock(RACE_COUNTDOWN_MS)
  return race
}

describe('娅娅猫向前冲基础对象', () => {
  it('creates one player and four independent AI contestants', () => {
    const race = createFoundationRace()
    expect(race.contestants).toHaveLength(5)
    expect(race.contestants.filter((cat) => cat.controllerType === CONTROLLER_TYPE.PLAYER)).toHaveLength(1)
    expect(race.contestants.filter((cat) => cat.controllerType === CONTROLLER_TYPE.AI)).toHaveLength(4)
    expect(new Set(race.contestants.map((cat) => cat.position.key)).size).toBe(5)
  })

  it('moves positions by one orthogonal tile', () => {
    const start = new GridPosition(2, 2)
    expect(start.move(DIRECTION.UP)).toEqual(new GridPosition(2, 1))
    expect(start.move(DIRECTION.RIGHT)).toEqual(new GridPosition(3, 2))
  })

  it('changes from countdown to running after three seconds', () => {
    const race = createFoundationRace()
    expect(race.startCountdown(100)).toBe(true)
    expect(race.advanceClock(100 + RACE_COUNTDOWN_MS - 1)).toBe(RACE_STATUS.COUNTDOWN)
    expect(race.advanceClock(100 + RACE_COUNTDOWN_MS)).toBe(RACE_STATUS.RUNNING)
  })

  it('allows climbing one height but rejects climbing two', () => {
    expect(canJumpBetweenHeights(0, 1)).toBe(true)
    expect(canJumpBetweenHeights(0, 2)).toBe(false)
    expect(canJumpBetweenHeights(2, 0)).toBe(true)
    expect(canJumpBetweenHeights(7, 0)).toBe(true)
  })

  it('applies the 0.3 second cooldown after a successful jump', () => {
    const race = createHeightRace(0)
    const first = race.attemptNormalJump('player', DIRECTION.UP, RACE_COUNTDOWN_MS)
    const second = race.attemptNormalJump('player', DIRECTION.DOWN, RACE_COUNTDOWN_MS + NORMAL_JUMP_COOLDOWN_MS - 1)
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, reason: 'jump-cooldown' })
  })

  it('rejects a height-zero to height-two normal jump', () => {
    const race = createHeightRace(2)
    expect(race.attemptNormalJump('player', DIRECTION.UP, RACE_COUNTDOWN_MS)).toEqual({ ok: false, reason: 'height-difference' })
    expect(race.player.normalJumpReadyAt).toBe(RACE_COUNTDOWN_MS + NORMAL_JUMP_COOLDOWN_MS)
  })

  it('consumes cooldown when a wall blocks a normal jump', () => {
    const race = createFoundationRace()
    const target = race.map.getTile(new GridPosition(2, 2))
    target.terrainType = TERRAIN_TYPE.WALL
    target.canJumpIn = false
    race.startCountdown(0)
    race.advanceClock(RACE_COUNTDOWN_MS)
    expect(race.attemptNormalJump(race.player.id, DIRECTION.UP, RACE_COUNTDOWN_MS).reason).toBe('target-blocks-jump')
    expect(race.player.normalJumpReadyAt).toBe(RACE_COUNTDOWN_MS + NORMAL_JUMP_COOLDOWN_MS)
  })

  it('allows a normal jump into a pit and resolves death and respawn', () => {
    const race = createFoundationRace()
    const target = race.map.getTile(new GridPosition(2, 2))
    target.terrainType = TERRAIN_TYPE.PIT
    target.canStand = false
    target.isCheckpoint = false
    race.startCountdown(0)
    race.advanceClock(RACE_COUNTDOWN_MS)

    const result = race.attemptNormalJump(race.player.id, DIRECTION.UP, RACE_COUNTDOWN_MS)

    expect(result).toMatchObject({ ok: true, outcome: 'respawned-after-pit' })
    expect(race.player.deathCount).toBe(1)
    expect(race.player.position).toEqual(new GridPosition(2, 3))
  })

  it('forms no more than a two-cat stack', () => {
    const race = createFoundationRace()
    race.startCountdown(0)
    race.advanceClock(RACE_COUNTDOWN_MS)
    const result = race.attemptNormalJump('cat-player', DIRECTION.RIGHT, RACE_COUNTDOWN_MS)
    const bottom = race.getContestant('cat-ai-3')
    expect(result.outcome).toBe('stacked')
    expect(race.player.stack.role).toBe(STACK_ROLE.TOP)
    expect(bottom.stack.role).toBe(STACK_ROLE.BOTTOM)
    expect(race.contestantsAt(new GridPosition(3, 3))).toHaveLength(2)
  })

  it('stores the map as a two-dimensional array', () => {
    const race = createFoundationRace()
    expect(race.map.tiles).toHaveLength(4)
    expect(race.map.tiles.every((row) => row.length === 5)).toBe(true)
    expect(race.map.flatTiles).toHaveLength(20)
  })

  it('uses one tractor bomb with a ten-second cycle and contact detonation', () => {
    const bomb = new TractorBomb({ now: 0 })
    expect(bomb.intervalMs).toBe(TRACTOR_BOMB_INTERVAL_MS)
    expect(bomb.tick(9_999)).toBeNull()
    expect(bomb.tick(10_000)).toEqual({ at: 10_000, reason: 'cycle' })
    expect(bomb.tick(19_999)).toBeNull()
    expect(bomb.tick(20_000)).toEqual({ at: 20_000, reason: 'cycle' })

    const contactBomb = new TractorBomb({ now: 0 })
    expect(contactBomb.onCatCakeContact(2_000)).toEqual({ at: 2_000, reason: 'contact' })
    expect(contactBomb.onCatCakeContact(2_001)).toBeNull()
    expect(contactBomb.tick(12_000)).toEqual({ at: 12_000, reason: 'cycle' })
  })

  it('uses a centered 3×3 bomb trigger area without enlarging it', () => {
    const bomb = new TractorBomb({ now: 0 })
    const center = new GridPosition(5, 5)
    expect(bomb.triggerRadius).toBe(TRACTOR_BOMB_TRIGGER_RADIUS)
    expect(bomb.containsTriggerPosition(center, new GridPosition(4, 4))).toBe(true)
    expect(bomb.containsTriggerPosition(center, new GridPosition(6, 6))).toBe(true)
    expect(bomb.containsTriggerPosition(center, new GridPosition(7, 5))).toBe(false)
    expect(bomb.onCatCakeEnterTriggerArea(2_000, center, new GridPosition(6, 5))).toEqual({ at: 2_000, reason: 'contact' })
  })

  it('uses the documented 7×7 diamond as the bomb effect area', () => {
    const bomb = new TractorBomb({ now: 0 })
    const center = new GridPosition(3, 3)
    expect(bomb.effectRadius).toBe(TRACTOR_BOMB_EFFECT_RADIUS)
    expect(bomb.containsEffectPosition(center, new GridPosition(0, 3))).toBe(true)
    expect(bomb.containsEffectPosition(center, new GridPosition(1, 2))).toBe(true)
    expect(bomb.containsEffectPosition(center, new GridPosition(0, 2))).toBe(false)
    expect(bomb.pickPullDistance(() => 0)).toBe(TRACTOR_BOMB_MIN_PULL_DISTANCE)
    expect(bomb.pickPullDistance(() => 0.999)).toBe(TRACTOR_BOMB_MAX_PULL_DISTANCE)
  })

  it('pulls each affected cat toward the bomb and supports diagonal movement', () => {
    const race = createBombRace({
      positions: [
        new GridPosition(1, 2),
        new GridPosition(0, 0),
        new GridPosition(6, 0),
        new GridPosition(0, 6),
        new GridPosition(6, 6),
      ],
    })
    race.advanceClock(RACE_COUNTDOWN_MS + TRACTOR_BOMB_INTERVAL_MS)
    expect(race.player.position).toEqual(new GridPosition(2, 3))
    const event = race.mechanismEvents.at(-1)
    expect(event.reason).toBe('cycle')
    expect(event.affectedCatIds).toEqual(['player'])
    expect(event.results[0]).toMatchObject({
      catId: 'player',
      pullDistance: 1,
      outcome: 'pulled',
    })
  })

  it('detonates immediately when a normal jump enters the centered 3×3 trigger area', () => {
    const race = createBombRace({
      positions: [
        new GridPosition(1, 3),
        new GridPosition(0, 0),
        new GridPosition(6, 0),
        new GridPosition(0, 6),
        new GridPosition(6, 6),
      ],
    })
    const result = race.attemptNormalJump('player', DIRECTION.RIGHT, RACE_COUNTDOWN_MS)
    expect(result.outcome).toBe('triggered-tractor-bomb')
    expect(result.bombEvents).toHaveLength(1)
    expect(result.bombEvents[0].reason).toBe('contact')
    expect(race.player.position).toEqual(new GridPosition(3, 3))
  })

  it('stops a bomb pull before a wall and only resolves the final tile', () => {
    const race = createBombRace({
      configureMap(map) {
        const wall = map.getTile(new GridPosition(1, 3))
        wall.terrainType = TERRAIN_TYPE.WALL
        wall.canJumpIn = false
        wall.canStand = false
      },
    })
    race.advanceClock(RACE_COUNTDOWN_MS + TRACTOR_BOMB_INTERVAL_MS)
    expect(race.player.position).toEqual(new GridPosition(0, 3))
    expect(race.mechanismEvents.at(-1).results[0].path).toEqual([])
  })

  it('resolves pit, glue and spring tiles reached by bomb pulls', () => {
    const pitRace = createBombRace({
      configureMap(map) {
        const pit = map.getTile(new GridPosition(1, 3))
        pit.terrainType = TERRAIN_TYPE.PIT
        pit.canStand = false
      },
    })
    pitRace.advanceClock(RACE_COUNTDOWN_MS + TRACTOR_BOMB_INTERVAL_MS)
    expect(pitRace.player.deathCount).toBe(1)
    expect(pitRace.mechanismEvents.at(-1).results[0].outcome).toBe('respawned-after-pit')

    const glueRace = createBombRace({
      configureMap(map) {
        map.getTile(new GridPosition(1, 3)).mechanism = new TileMechanism({ type: MECHANISM_TYPE.GLUE })
      },
    })
    glueRace.advanceClock(RACE_COUNTDOWN_MS + TRACTOR_BOMB_INTERVAL_MS)
    expect(glueRace.player.position).toEqual(new GridPosition(1, 3))
    expect(glueRace.player.glue.active).toBe(true)

    const springRace = createBombRace({
      configureMap(map) {
        map.getTile(new GridPosition(1, 3)).mechanism = new TileMechanism({
          type: MECHANISM_TYPE.SPRING,
          direction: DIRECTION.RIGHT,
          parameters: { distance: 2 },
        })
      },
    })
    springRace.advanceClock(RACE_COUNTDOWN_MS + TRACTOR_BOMB_INTERVAL_MS)
    expect(springRace.player.position).toEqual(new GridPosition(3, 3))
    expect(springRace.mechanismEvents).toContainEqual(expect.objectContaining({
      type: 'spring-activation',
      position: new GridPosition(1, 3),
      affectedCatIds: ['player'],
    }))
    expect(springRace.mechanismEvents.at(-1).results[0].outcome).toBe('triggered-spring')
  })

  it('calculates stacked cats independently during a bomb pull', () => {
    const race = createBombRace({
      positions: [
        new GridPosition(0, 3),
        new GridPosition(0, 3),
        new GridPosition(6, 0),
        new GridPosition(0, 6),
        new GridPosition(6, 6),
      ],
      randomValues: [0, 0.3],
    })
    const bottom = race.player
    const top = race.getContestant('ai-1')
    bottom.stack = { role: STACK_ROLE.BOTTOM, partnerId: top.id, shakeOffAttempts: 0 }
    top.stack = { role: STACK_ROLE.TOP, partnerId: bottom.id, shakeOffAttempts: 0 }
    race.syncHeight(bottom)
    race.syncHeight(top)

    race.advanceClock(RACE_COUNTDOWN_MS + TRACTOR_BOMB_INTERVAL_MS)
    expect(bottom.position).toEqual(new GridPosition(1, 3))
    expect(top.position).toEqual(new GridPosition(2, 3))
    expect(bottom.stack.role).toBe(STACK_ROLE.NONE)
    expect(top.stack.role).toBe(STACK_ROLE.NONE)
  })

  it('plays the center jump-and-stun result without moving the cat', () => {
    const race = createBombRace({
      positions: [
        new GridPosition(3, 3),
        new GridPosition(0, 0),
        new GridPosition(6, 0),
        new GridPosition(0, 6),
        new GridPosition(6, 6),
      ],
    })
    race.advanceClock(RACE_COUNTDOWN_MS + TRACTOR_BOMB_INTERVAL_MS)
    expect(race.player.position).toEqual(new GridPosition(3, 3))
    expect(race.mechanismEvents.at(-1).results[0].outcome).toBe('center-jump-and-stun')
  })

  it('applies glue to a single cat and clears it after five seconds', () => {
    const race = createFoundationRace()
    race.map.getTile(new GridPosition(2, 2)).mechanism = new TileMechanism({ type: MECHANISM_TYPE.GLUE })
    race.startCountdown(0)
    race.advanceClock(RACE_COUNTDOWN_MS)
    const result = race.attemptNormalJump(race.player.id, DIRECTION.UP, RACE_COUNTDOWN_MS)
    expect(result.outcome).toBe('stuck-in-glue')
    expect(race.player.glue).toEqual({
      active: true,
      attempts: 0,
      expiresAt: RACE_COUNTDOWN_MS + GLUE_MAX_DURATION_MS,
    })
    race.advanceClock(RACE_COUNTDOWN_MS + GLUE_MAX_DURATION_MS)
    expect(race.player.glue.active).toBe(false)
  })

  it('does not apply floor glue to the top cat in a stack', () => {
    const race = createFoundationRace()
    race.map.getTile(new GridPosition(3, 3)).mechanism = new TileMechanism({ type: MECHANISM_TYPE.GLUE })
    race.startCountdown(0)
    race.advanceClock(RACE_COUNTDOWN_MS)
    expect(race.attemptNormalJump(race.player.id, DIRECTION.RIGHT, RACE_COUNTDOWN_MS).outcome).toBe('stacked')
    expect(race.player.stack.role).toBe(STACK_ROLE.TOP)
    expect(race.player.glue.active).toBe(false)
  })

  it('respawns on an open tile of the personal respawn line', () => {
    const race = createFoundationRace()
    const player = race.player
    player.activateCheckpoint(new GridPosition(2, 2))
    const blocker = race.getContestant('cat-ai-1')
    blocker.position = new GridPosition(2, 2)
    race.killAndRespawn(player, 5_000)
    expect(player.position).toEqual(new GridPosition(1, 2))
    expect(player.invincibleUntil).toBe(5_000 + RESPAWN_INVINCIBILITY_MS)
  })

  it('parses all five designed maps into 10 by 50 two-dimensional maps', () => {
    const maps = createDesignedMaps()
    expect(Object.keys(maps)).toEqual(['map1', 'map2', 'map3', 'map4', 'map5'])
    Object.values(maps).forEach((map) => {
      expect(map.width).toBe(MAP_WIDTH)
      expect(map.height).toBe(MAP_HEIGHT)
      expect(map.tiles).toHaveLength(MAP_HEIGHT)
      expect(map.tiles.every((row) => row.length === MAP_WIDTH)).toBe(true)
      expect(map.startRow).toBe(49)
      expect(map.finishRow).toBe(1)
      expect(map.respawnRows).toEqual([10, 20, 30, 40])
      expect(map.guaranteedRoute.length).toBeGreaterThan(0)
      expect(map.getTile(map.guaranteedRoute[0]).isStart).toBe(true)
      expect(map.getTile(map.guaranteedRoute.at(-1)).isFinish).toBe(true)
      map.guaranteedRoute.forEach((position) => {
        const tile = map.getTile(position)
        expect(tile.terrainType).toBe(TERRAIN_TYPE.NORMAL)
        expect([null, MECHANISM_TYPE.GLUE, MECHANISM_TYPE.SPRING])
          .toContain(tile.mechanism?.type ?? null)
      })
    })
    expect(new Set(Object.values(MAP_LAYOUTS).map((rows) => rows.join('\n'))).size).toBe(5)
  })

  it('maps b and t symbols to the same single bomb mechanism', () => {
    const map = createDesignedMap('map4')
    const timerSymbol = map.flatTiles.find((tile) => tile.symbol === 'b')
    const contactSymbol = map.flatTiles.find((tile) => tile.symbol === 't')
    expect(timerSymbol.symbol).toBe('b')
    expect(contactSymbol.symbol).toBe('t')
    expect(timerSymbol.mechanism.parameters).toEqual({
      intervalMs: 10_000,
      contactDetonates: true,
      triggerRadius: 1,
      effectRadius: 3,
      blocksMovement: false,
    })
    expect(contactSymbol.mechanism.parameters).toEqual(timerSymbol.mechanism.parameters)
    expect(timerSymbol.canStand).toBe(true)
    expect(timerSymbol.canJumpIn).toBe(true)
    expect(timerSymbol.canJumpOut).toBe(true)
  })

  it('builds varied maps without a zero-risk route while preserving a guaranteed route', () => {
    function seededRandom(initialSeed) {
      let seed = initialSeed >>> 0
      return () => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
        return seed / 0x1_0000_0000
      }
    }

    Object.keys(MAP_LAYOUTS).forEach((id, mapIndex) => {
      for (let variant = 0; variant < 5; variant += 1) {
        const map = createRandomizedMap(id, { random: seededRandom((mapIndex + 1) * 100 + variant) })
        expect(map.stableRoute).toHaveLength(0)
        expect(map.guaranteedRoute.length).toBeGreaterThan(0)
        expect(map.guaranteedRoute.some((position) => (
          map.getTile(position).mechanism?.type === MECHANISM_TYPE.GLUE
        ))).toBe(true)
        map.guaranteedRoute.forEach((position) => {
          const tile = map.getTile(position)
          expect(tile.terrainType).toBe(TERRAIN_TYPE.NORMAL)
          expect([null, MECHANISM_TYPE.GLUE, MECHANISM_TYPE.SPRING]).toContain(tile.mechanism?.type ?? null)
        })
      }
    })
  })

  it('lets a glued cat escape according to the documented increasing probability', () => {
    const race = createFoundationRace()
    race.random = () => 0
    race.map.getTile(new GridPosition(2, 2)).mechanism = new TileMechanism({ type: MECHANISM_TYPE.GLUE })
    race.startCountdown(0)
    race.advanceClock(RACE_COUNTDOWN_MS)
    expect(race.attemptNormalJump(race.player.id, DIRECTION.UP, RACE_COUNTDOWN_MS).outcome).toBe('stuck-in-glue')
    const escaped = race.attemptNormalJump(
      race.player.id,
      DIRECTION.LEFT,
      RACE_COUNTDOWN_MS + NORMAL_JUMP_COOLDOWN_MS,
    )
    expect(escaped.outcome).toBe('moved')
    expect(race.player.glue.active).toBe(false)
  })

  it('lets a bottom cat shake the top cat off with increasing attempts', () => {
    const race = createFoundationRace()
    race.random = () => 0
    race.startCountdown(0)
    race.advanceClock(RACE_COUNTDOWN_MS)
    expect(race.attemptNormalJump(race.player.id, DIRECTION.RIGHT, RACE_COUNTDOWN_MS).outcome).toBe('stacked')
    const bottom = race.getContestant('cat-ai-3')
    const result = race.attemptNormalJump(
      bottom.id,
      DIRECTION.UP,
      RACE_COUNTDOWN_MS + NORMAL_JUMP_COOLDOWN_MS,
    )
    expect(result.outcome).toBe('shake-off-success')
    expect(bottom.stack.role).toBe(STACK_ROLE.NONE)
    expect(race.player.stack.role).toBe(STACK_ROLE.NONE)
    expect(race.player.position).toEqual(new GridPosition(3, 2))
  })

  it('activates pistons every three seconds and pushes cats in their configured direction', () => {
    const race = createBombRace({
      positions: [
        new GridPosition(1, 3),
        new GridPosition(0, 0),
        new GridPosition(6, 0),
        new GridPosition(0, 6),
        new GridPosition(6, 6),
      ],
      configureMap(map) {
        map.getTile(new GridPosition(0, 3)).mechanism = new TileMechanism({
          type: MECHANISM_TYPE.PISTON,
          direction: DIRECTION.RIGHT,
          parameters: { intervalMs: 3000, minDistance: 1, maxDistance: 3 },
        })
      },
    })
    race.advanceClock(RACE_COUNTDOWN_MS + 3000)
    expect(race.player.position).toEqual(new GridPosition(3, 3))
    expect(race.mechanismEvents.find((event) => event.type === 'piston-activation')).toMatchObject({
      type: 'piston-activation',
      direction: DIRECTION.RIGHT,
      affectedCatIds: ['player'],
    })
  })

  it('staggers periodic traps into independent phases instead of firing together', () => {
    const race = createBombRace({
      configureMap(map) {
        const bombPositions = [new GridPosition(1, 1), new GridPosition(5, 5)]
        bombPositions.forEach((position) => {
          map.getTile(position).mechanism = new TileMechanism({
            type: MECHANISM_TYPE.TRACTOR_BOMB,
            parameters: { intervalMs: TRACTOR_BOMB_INTERVAL_MS },
          })
        })
        const pistonPositions = [new GridPosition(0, 2), new GridPosition(0, 3), new GridPosition(0, 4)]
        pistonPositions.forEach((position) => {
          map.getTile(position).mechanism = new TileMechanism({
            type: MECHANISM_TYPE.PISTON,
            direction: DIRECTION.RIGHT,
            parameters: { intervalMs: PISTON_INTERVAL_MS },
          })
        })
      },
    })
    const bombTimes = race.tractorBombs.map((bomb) => bomb.timer.nextExplosionAt)
    const pistonTimes = race.pistons.map((piston) => piston.nextActivationAt)
    expect(new Set(bombTimes).size).toBe(bombTimes.length)
    expect(new Set(pistonTimes).size).toBe(pistonTimes.length)
    expect(bombTimes.every((time) => time > RACE_COUNTDOWN_MS && time < RACE_COUNTDOWN_MS + TRACTOR_BOMB_INTERVAL_MS)).toBe(true)
    expect(pistonTimes.every((time) => time > RACE_COUNTDOWN_MS && time < RACE_COUNTDOWN_MS + PISTON_INTERVAL_MS)).toBe(true)
  })

  it('lets a powered piston push a cat up one terrain level', () => {
    const race = createBombRace({
      positions: [
        new GridPosition(1, 3),
        new GridPosition(0, 0),
        new GridPosition(6, 0),
        new GridPosition(0, 6),
        new GridPosition(6, 6),
      ],
      configureMap(map) {
        map.getTile(new GridPosition(0, 3)).mechanism = new TileMechanism({
          type: MECHANISM_TYPE.PISTON,
          direction: DIRECTION.RIGHT,
          parameters: { intervalMs: 4000, minDistance: 1, maxDistance: 1 },
        })
        map.getTile(new GridPosition(2, 3)).baseHeight = 1
        map.getTile(new GridPosition(3, 3)).mechanism = null
      },
    })
    race.advanceClock(RACE_COUNTDOWN_MS + 4000)
    expect(race.player.position).toEqual(new GridPosition(2, 3))
  })

  it('runs four AI contestants to the finish on every designed map', () => {
    Object.values(AI_DIFFICULTY).forEach((aiDifficulty) => {
      Object.values(createDesignedMaps()).forEach((map) => {
        const race = createPlayableRace(map, { random: () => 0.42, aiDifficulty })
        race.startCountdown(0)
        for (let now = RACE_COUNTDOWN_MS; now <= 120_000; now += 50) race.advanceClock(now)
        expect(race.contestants.filter((cat) => cat.controllerType === CONTROLLER_TYPE.AI)
          .every((cat) => cat.finish.reached)).toBe(true)
      })
    })
  }, 15_000)

  it('gives every designed map the complete mixed mechanism and hazard set', () => {
    const raceSections = [[2, 9], [11, 19], [21, 29], [31, 39], [41, 48]]
    Object.values(createDesignedMaps()).forEach((map) => {
      const mechanisms = new Set(map.flatTiles.map((tile) => tile.mechanism?.type).filter(Boolean))
      expect(mechanisms).toEqual(new Set([
        MECHANISM_TYPE.GLUE,
        MECHANISM_TYPE.SPRING,
        MECHANISM_TYPE.PISTON,
        MECHANISM_TYPE.TRACTOR_BOMB,
      ]))
      expect(map.flatTiles.some((tile) => tile.terrainType === TERRAIN_TYPE.SPIKES)).toBe(true)
      expect(map.flatTiles.some((tile) => tile.terrainType === TERRAIN_TYPE.PIT)).toBe(true)
      expect(map.startRow).toBe(MAP_HEIGHT - 1)
      expect(map.finishRow).toBe(1)
      expect(map.flatTiles.filter((tile) => tile.mechanism?.type === MECHANISM_TYPE.SPRING).length)
        .toBeGreaterThanOrEqual(7)
      expect(map.flatTiles.filter((tile) => tile.mechanism?.type === MECHANISM_TYPE.PISTON).length)
        .toBeGreaterThanOrEqual(9)
      expect(map.flatTiles
        .filter((tile) => tile.mechanism?.type === MECHANISM_TYPE.SPRING)
        .every((tile) => tile.baseHeight === 1)).toBe(true)
      raceSections.forEach(([startRow, endRow]) => {
        const sectionTiles = map.flatTiles.filter((tile) => (
          tile.position.y >= startRow && tile.position.y <= endRow
        ))
        expect(sectionTiles.some((tile) => tile.mechanism?.type === MECHANISM_TYPE.SPRING)).toBe(true)
        expect(sectionTiles.some((tile) => tile.mechanism?.type === MECHANISM_TYPE.PISTON)).toBe(true)
      })
    })
  })

  it('uses distinct speed, mistake and compensation settings for each AI difficulty', () => {
    const easy = AI_DIFFICULTY_CONFIG[AI_DIFFICULTY.EASY]
    const normal = AI_DIFFICULTY_CONFIG[AI_DIFFICULTY.NORMAL]
    const hard = AI_DIFFICULTY_CONFIG[AI_DIFFICULTY.HARD]
    expect(easy.actionMinMs).toBeGreaterThan(normal.actionMinMs)
    expect(normal.actionMinMs).toBeGreaterThan(hard.actionMinMs)
    expect(easy.mistakeChance).toBeGreaterThan(normal.mistakeChance)
    expect(normal.mistakeChance).toBeGreaterThan(hard.mistakeChance)
    expect(easy.compensationThreshold).toBeLessThan(normal.compensationThreshold)
    expect(normal.compensationThreshold).toBeLessThan(hard.compensationThreshold)
  })

  it('enables safe-route compensation after repeated actions without forward progress', () => {
    const race = createHeightRace(0)
    const cat = race.contestants.find((contestant) => contestant.controllerType === CONTROLLER_TYPE.AI)
    for (let attempt = 0; attempt < race.aiConfig.compensationThreshold; attempt += 1) {
      race.updateAiProgress(cat, cat.position.y)
    }
    expect(cat.aiSafeMode).toBe(true)
    expect(cat.aiCompensationCount).toBe(1)
  })

  it('leaves safe-route compensation after advancing three rows', () => {
    const race = createHeightRace(0)
    const cat = race.contestants.find((contestant) => contestant.controllerType === CONTROLLER_TYPE.AI)
    cat.aiSafeMode = true
    cat.aiSafeModeStartedY = 10
    cat.aiBestY = 10
    cat.position = new GridPosition(cat.position.x, 7)
    race.updateAiProgress(cat, 8)
    expect(cat.aiSafeMode).toBe(false)
    expect(cat.aiSafeModeStartedY).toBeNull()
  })

  it('immediately enables compensation when an AI repeats a death position', () => {
    const race = createHeightRace(0)
    const cat = race.contestants.find((contestant) => contestant.controllerType === CONTROLLER_TYPE.AI)
    cat.lastDeathPositionKey = cat.position.key
    cat.repeatedDeathCount = 1
    race.killAndRespawn(cat, RACE_COUNTDOWN_MS + 100)
    expect(cat.aiSafeMode).toBe(true)
    expect(cat.aiCompensationCount).toBe(1)
  })
})

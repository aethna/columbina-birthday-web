export const DIRECTION = Object.freeze({
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
})

export const TERRAIN_TYPE = Object.freeze({
  NORMAL: 'normal',
  WALL: 'wall',
  PIT: 'pit',
  SPIKES: 'spikes',
})

export const MECHANISM_TYPE = Object.freeze({
  SPRING: 'spring',
  PISTON: 'piston',
  GLUE: 'glue',
  TRACTOR_BOMB: 'tractor-bomb',
})

export const CONTROLLER_TYPE = Object.freeze({
  PLAYER: 'player',
  AI: 'ai',
})

export const AI_DIFFICULTY = Object.freeze({
  EASY: 'easy',
  NORMAL: 'normal',
  HARD: 'hard',
})

export const AI_DIFFICULTY_CONFIG = Object.freeze({
  [AI_DIFFICULTY.EASY]: Object.freeze({
    actionMinMs: 760,
    actionVarianceMs: 360,
    mistakeChance: 0.16,
    riskScale: 0.7,
    compensationThreshold: 5,
  }),
  [AI_DIFFICULTY.NORMAL]: Object.freeze({
    actionMinMs: 500,
    actionVarianceMs: 260,
    mistakeChance: 0.06,
    riskScale: 1,
    compensationThreshold: 7,
  }),
  [AI_DIFFICULTY.HARD]: Object.freeze({
    actionMinMs: 330,
    actionVarianceMs: 150,
    mistakeChance: 0.01,
    riskScale: 1.25,
    compensationThreshold: 10,
  }),
})

export const CAT_ACTION_STATE = Object.freeze({
  IDLE: 'idle',
  FORCED_MOVEMENT: 'forced-movement',
  DEAD: 'dead',
  RESPAWNING: 'respawning',
  FINISHING: 'finishing',
  SHAKING_OFF: 'shaking-off',
  RESOLVING_MECHANISM: 'resolving-mechanism',
})

export const STACK_ROLE = Object.freeze({
  NONE: 'none',
  BOTTOM: 'bottom',
  TOP: 'top',
})

export const RACE_STATUS = Object.freeze({
  READY: 'ready',
  COUNTDOWN: 'countdown',
  RUNNING: 'running',
  FINISHED: 'finished',
})

export const NORMAL_JUMP_COOLDOWN_MS = 300
export const RESPAWN_INVINCIBILITY_MS = 1000
export const RACE_COUNTDOWN_MS = 3000
export const GLUE_MAX_DURATION_MS = 5000
export const PISTON_INTERVAL_MS = 3000
export const TRACTOR_BOMB_INTERVAL_MS = 10_000
export const TRACTOR_BOMB_TRIGGER_RADIUS = 1
export const TRACTOR_BOMB_EFFECT_RADIUS = 3
export const TRACTOR_BOMB_MIN_PULL_DISTANCE = 1
export const TRACTOR_BOMB_MAX_PULL_DISTANCE = 4

const DIRECTION_OFFSET = Object.freeze({
  [DIRECTION.UP]: { x: 0, y: -1 },
  [DIRECTION.DOWN]: { x: 0, y: 1 },
  [DIRECTION.LEFT]: { x: -1, y: 0 },
  [DIRECTION.RIGHT]: { x: 1, y: 0 },
})

function mechanismPhaseValue(position, salt) {
  let value = Math.imul(position.x + 1, 0x45d9f3b)
    ^ Math.imul(position.y + 1, 0x119de1f3)
    ^ salt
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  return (value ^ (value >>> 16)) >>> 0
}

function assignStaggeredPhases(mechanisms, intervalFor, assignAt, startAt, salt) {
  const groups = new Map()
  mechanisms.forEach((mechanism) => {
    const interval = intervalFor(mechanism)
    const group = groups.get(interval) ?? []
    group.push(mechanism)
    groups.set(interval, group)
  })
  groups.forEach((group, interval) => {
    const ordered = [...group].sort((left, right) => (
      mechanismPhaseValue(left.position, salt) - mechanismPhaseValue(right.position, salt)
    ))
    ordered.forEach((mechanism, index) => {
      const randomFraction = mechanismPhaseValue(mechanism.position, salt ^ 0x9e3779b9) / 0x1_0000_0000
      const slotPosition = index + 0.2 + randomFraction * 0.6
      const delay = Math.max(1, Math.round((slotPosition / ordered.length) * interval))
      assignAt(mechanism, startAt + delay, delay)
    })
  })
}

function assertInteger(value, name) {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`)
}

function assertEnum(value, values, name) {
  if (!Object.values(values).includes(value)) throw new TypeError(`Unknown ${name}: ${value}`)
}

export class GridPosition {
  constructor(x, y) {
    assertInteger(x, 'x')
    assertInteger(y, 'y')
    this.x = x
    this.y = y
  }

  move(direction, distance = 1) {
    assertEnum(direction, DIRECTION, 'direction')
    assertInteger(distance, 'distance')
    const offset = DIRECTION_OFFSET[direction]
    return new GridPosition(this.x + offset.x * distance, this.y + offset.y * distance)
  }

  equals(other) {
    return other instanceof GridPosition && this.x === other.x && this.y === other.y
  }

  clone() {
    return new GridPosition(this.x, this.y)
  }

  get key() {
    return `${this.x},${this.y}`
  }
}

export class RespawnLine {
  constructor({ y, preferredX }) {
    assertInteger(y, 'respawn line y')
    assertInteger(preferredX, 'respawn line preferredX')
    this.y = y
    this.preferredX = preferredX
  }

  updateAnchor(position) {
    if (!(position instanceof GridPosition)) throw new TypeError('position must be a GridPosition')
    this.y = position.y
    this.preferredX = position.x
  }
}

export class TileMechanism {
  constructor({ type, direction = null, parameters = {} }) {
    assertEnum(type, MECHANISM_TYPE, 'mechanism type')
    if (direction !== null) assertEnum(direction, DIRECTION, 'mechanism direction')
    this.type = type
    this.direction = direction
    this.parameters = { ...parameters }
  }
}

export class TractorBomb {
  constructor({
    intervalMs = TRACTOR_BOMB_INTERVAL_MS,
    now = 0,
    triggerRadius = TRACTOR_BOMB_TRIGGER_RADIUS,
    effectRadius = TRACTOR_BOMB_EFFECT_RADIUS,
  } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs must be positive')
    assertInteger(triggerRadius, 'triggerRadius')
    assertInteger(effectRadius, 'effectRadius')
    if (triggerRadius < 0) throw new RangeError('triggerRadius must not be negative')
    if (effectRadius < 0) throw new RangeError('effectRadius must not be negative')
    this.intervalMs = intervalMs
    this.triggerRadius = triggerRadius
    this.effectRadius = effectRadius
    this.nextExplosionAt = now + intervalMs
    this.cooldownUntil = null
    this.explosionCount = 0
    this.lastExplosion = null
  }

  get isCoolingDown() {
    return this.cooldownUntil !== null
  }

  explode(now, reason) {
    this.cooldownUntil = now + this.intervalMs
    this.nextExplosionAt = this.cooldownUntil
    this.explosionCount += 1
    this.lastExplosion = { at: now, reason }
    return this.lastExplosion
  }

  tick(now) {
    if (this.isCoolingDown) {
      if (now < this.cooldownUntil) return null
      this.cooldownUntil = null
      return this.explode(now, 'cycle')
    }
    if (now >= this.nextExplosionAt) return this.explode(now, 'cycle')
    return null
  }

  onCatCakeContact(now) {
    if (this.isCoolingDown) return null
    return this.explode(now, 'contact')
  }

  containsTriggerPosition(bombPosition, catPosition) {
    if (!(bombPosition instanceof GridPosition) || !(catPosition instanceof GridPosition)) {
      throw new TypeError('bombPosition and catPosition must be GridPosition values')
    }
    return Math.abs(catPosition.x - bombPosition.x) <= this.triggerRadius
      && Math.abs(catPosition.y - bombPosition.y) <= this.triggerRadius
  }

  containsEffectPosition(bombPosition, catPosition) {
    if (!(bombPosition instanceof GridPosition) || !(catPosition instanceof GridPosition)) {
      throw new TypeError('bombPosition and catPosition must be GridPosition values')
    }
    return Math.abs(catPosition.x - bombPosition.x)
      + Math.abs(catPosition.y - bombPosition.y) <= this.effectRadius
  }

  pickPullDistance(random = Math.random) {
    if (typeof random !== 'function') throw new TypeError('random must be a function')
    const value = random()
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError('random must return a number from 0 (inclusive) to 1 (exclusive)')
    }
    return TRACTOR_BOMB_MIN_PULL_DISTANCE
      + Math.floor(value * (TRACTOR_BOMB_MAX_PULL_DISTANCE - TRACTOR_BOMB_MIN_PULL_DISTANCE + 1))
  }

  onCatCakeEnterTriggerArea(now, bombPosition, catPosition) {
    if (!this.containsTriggerPosition(bombPosition, catPosition)) return null
    return this.onCatCakeContact(now)
  }
}

export class MapTile {
  constructor({
    x,
    y,
    baseHeight = 0,
    terrainType = TERRAIN_TYPE.NORMAL,
    canStand,
    canJumpIn,
    canJumpOut,
    isStart = false,
    isCheckpoint = false,
    isFinish = false,
    mechanism = null,
    symbol = null,
  }) {
    this.position = new GridPosition(x, y)
    assertInteger(baseHeight, 'baseHeight')
    if (baseHeight < 0 || baseHeight > 2) throw new RangeError('baseHeight must be between 0 and 2')
    assertEnum(terrainType, TERRAIN_TYPE, 'terrain type')
    if (mechanism !== null && !(mechanism instanceof TileMechanism)) {
      throw new TypeError('mechanism must be a TileMechanism or null')
    }

    const isBlocked = terrainType === TERRAIN_TYPE.WALL
    const isPit = terrainType === TERRAIN_TYPE.PIT
    this.baseHeight = baseHeight
    this.terrainType = terrainType
    this.canStand = canStand ?? (!isBlocked && !isPit)
    this.canJumpIn = canJumpIn ?? !isBlocked
    this.canJumpOut = canJumpOut ?? (!isBlocked && !isPit)
    this.isStart = Boolean(isStart)
    this.isCheckpoint = Boolean(isCheckpoint)
    this.isFinish = Boolean(isFinish)
    this.mechanism = mechanism
    this.symbol = symbol
  }
}

export class RaceMap {
  constructor({ width, height, tiles }) {
    assertInteger(width, 'width')
    assertInteger(height, 'height')
    if (width < 1 || height < 1) throw new RangeError('Map dimensions must be positive')
    if (!Array.isArray(tiles) || tiles.some((row) => !Array.isArray(row))) {
      throw new TypeError('tiles must be a two-dimensional array')
    }
    if (tiles.length !== height || tiles.some((row) => row.length !== width)) {
      throw new RangeError('tiles must match the declared map dimensions')
    }

    this.width = width
    this.height = height
    this.tiles = tiles.map((row) => [...row])
    this.flatTiles = this.tiles.flat()
    this.tileIndex = new Map()
    this.flatTiles.forEach((tile) => {
      if (!(tile instanceof MapTile)) throw new TypeError('Every tile must be a MapTile')
      if (!this.contains(tile.position)) throw new RangeError(`Tile ${tile.position.key} is outside the map`)
      if (this.tileIndex.has(tile.position.key)) throw new Error(`Duplicate tile at ${tile.position.key}`)
      this.tileIndex.set(tile.position.key, tile)
    })
  }

  contains(position) {
    return position instanceof GridPosition
      && position.x >= 0
      && position.x < this.width
      && position.y >= 0
      && position.y < this.height
  }

  getTile(position) {
    if (!(position instanceof GridPosition)) throw new TypeError('position must be a GridPosition')
    return this.tileIndex.get(position.key) ?? null
  }

  getRow(y) {
    assertInteger(y, 'row y')
    return this.tiles[y] ? [...this.tiles[y]] : []
  }
}

export class CatCake {
  constructor({ id, name, controllerType, startPosition, color = '#ffffff' }) {
    if (!id || !name) throw new TypeError('CatCake requires id and name')
    assertEnum(controllerType, CONTROLLER_TYPE, 'controller type')
    if (!(startPosition instanceof GridPosition)) throw new TypeError('startPosition must be a GridPosition')

    this.id = id
    this.name = name
    this.controllerType = controllerType
    this.color = color
    this.position = startPosition.clone()
    this.currentHeight = 0
    this.actionState = CAT_ACTION_STATE.IDLE
    this.respawnLine = new RespawnLine({ y: startPosition.y, preferredX: startPosition.x })
    this.normalJumpReadyAt = 0
    this.invincibleUntil = 0
    this.deathCount = 0
    this.glue = { active: false, attempts: 0, expiresAt: 0 }
    this.stack = { role: STACK_ROLE.NONE, partnerId: null, shakeOffAttempts: 0 }
    this.finish = { reached: false, time: null, frame: null, rank: null }
    this.nextAiActionAt = 0
    this.lastAction = 'waiting'
    this.lastDeathPositionKey = null
    this.repeatedDeathCount = 0
    this.aiBestY = startPosition.y
    this.aiStalledActions = 0
    this.aiSafeMode = false
    this.aiSafeModeStartedY = null
    this.aiCompensationCount = 0
  }

  canAttemptNormalJump(now) {
    return !this.finish.reached
      && this.actionState === CAT_ACTION_STATE.IDLE
      && this.stack.role !== STACK_ROLE.BOTTOM
      && !this.glue.active
      && now >= this.normalJumpReadyAt
  }

  consumeNormalJumpCooldown(now) {
    this.normalJumpReadyAt = now + NORMAL_JUMP_COOLDOWN_MS
  }

  activateCheckpoint(position) {
    this.respawnLine.updateAnchor(position)
  }

  resetStack() {
    this.stack = { role: STACK_ROLE.NONE, partnerId: null, shakeOffAttempts: 0 }
  }
}

export function canJumpBetweenHeights(currentHeight, targetHeight) {
  assertInteger(currentHeight, 'currentHeight')
  assertInteger(targetHeight, 'targetHeight')
  return targetHeight - currentHeight <= 1
}

export class RaceSession {
  constructor({ map, contestants, random = Math.random, aiDifficulty = AI_DIFFICULTY.NORMAL }) {
    if (!(map instanceof RaceMap)) throw new TypeError('map must be a RaceMap')
    if (!Array.isArray(contestants) || contestants.length !== 5) {
      throw new Error('A race requires exactly five CatCakes')
    }
    if (contestants.some((cat) => !(cat instanceof CatCake))) {
      throw new TypeError('Every contestant must be a CatCake')
    }
    const playerCount = contestants.filter((cat) => cat.controllerType === CONTROLLER_TYPE.PLAYER).length
    if (playerCount !== 1) throw new Error('A race requires exactly one player-controlled CatCake')
    if (typeof random !== 'function') throw new TypeError('random must be a function')
    assertEnum(aiDifficulty, AI_DIFFICULTY, 'AI difficulty')

    this.map = map
    this.contestants = contestants
    this.random = random
    this.aiDifficulty = aiDifficulty
    this.aiConfig = AI_DIFFICULTY_CONFIG[aiDifficulty]
    this.status = RACE_STATUS.READY
    this.countdownEndsAt = null
    this.startedAt = null
    this.nextFinishFrame = 0
    this.mechanismEvents = []
    this.tractorBombs = map.flatTiles
      .filter((tile) => tile.mechanism?.type === MECHANISM_TYPE.TRACTOR_BOMB)
      .map((tile) => ({ position: tile.position.clone(), parameters: tile.mechanism.parameters, timer: null }))
    this.pistons = map.flatTiles
      .filter((tile) => tile.mechanism?.type === MECHANISM_TYPE.PISTON)
      .map((tile) => ({
        position: tile.position.clone(),
        direction: tile.mechanism.direction,
        parameters: tile.mechanism.parameters,
        nextActivationAt: null,
      }))
    this.contestants.forEach((cat) => this.syncHeight(cat))
  }

  get player() {
    return this.contestants.find((cat) => cat.controllerType === CONTROLLER_TYPE.PLAYER)
  }

  startCountdown(now) {
    if (this.status !== RACE_STATUS.READY) return false
    this.status = RACE_STATUS.COUNTDOWN
    this.countdownEndsAt = now + RACE_COUNTDOWN_MS
    this.tractorBombs.forEach((bomb) => {
      bomb.timer = new TractorBomb({
        intervalMs: bomb.parameters.intervalMs ?? TRACTOR_BOMB_INTERVAL_MS,
        now: this.countdownEndsAt,
        triggerRadius: bomb.parameters.triggerRadius ?? TRACTOR_BOMB_TRIGGER_RADIUS,
        effectRadius: bomb.parameters.effectRadius ?? TRACTOR_BOMB_EFFECT_RADIUS,
      })
    })
    assignStaggeredPhases(
      this.tractorBombs,
      (bomb) => bomb.parameters.intervalMs ?? TRACTOR_BOMB_INTERVAL_MS,
      (bomb, activationAt, delay) => {
        bomb.timer.nextExplosionAt = activationAt
        bomb.phaseDelayMs = delay
      },
      this.countdownEndsAt,
      0x51f15e,
    )
    assignStaggeredPhases(
      this.pistons,
      (piston) => piston.parameters.intervalMs ?? PISTON_INTERVAL_MS,
      (piston, activationAt, delay) => {
        piston.nextActivationAt = activationAt
        piston.phaseDelayMs = delay
      },
      this.countdownEndsAt,
      0x71570f,
    )
    this.contestants.forEach((cat, index) => {
      if (cat.controllerType === CONTROLLER_TYPE.AI) {
        cat.nextAiActionAt = this.countdownEndsAt + this.aiConfig.actionMinMs + index * 90
      }
    })
    return true
  }

  randomInteger(minimum, maximum) {
    return minimum + Math.floor(this.random() * (maximum - minimum + 1))
  }

  recordBombExplosion(bomb, explosion, catId = null) {
    if (!explosion) return null
    const results = this.resolveTractorBombExplosion(bomb, explosion.at)
    const event = {
      type: 'tractor-bomb-explosion',
      position: bomb.position.clone(),
      catId,
      affectedCatIds: results.map((result) => result.catId),
      results,
      ...explosion,
    }
    this.mechanismEvents.push(event)
    return event
  }

  buildBombPullPath(startPosition, bombPosition, pullDistance) {
    const path = []
    let current = startPosition.clone()
    for (let step = 0; step < pullDistance && !current.equals(bombPosition); step += 1) {
      const next = new GridPosition(
        current.x + Math.sign(bombPosition.x - current.x),
        current.y + Math.sign(bombPosition.y - current.y),
      )
      const tile = this.map.getTile(next)
      if (!tile || tile.terrainType === TERRAIN_TYPE.WALL || !tile.canJumpIn) break
      path.push(next)
      current = next
    }
    return path
  }

  detachStackForForcedMovement(cat) {
    if (cat.stack.role === STACK_ROLE.NONE) return
    const partner = this.getContestant(cat.stack.partnerId)
    cat.resetStack()
    partner?.resetStack()
    if (this.map.getTile(cat.position)) this.syncHeight(cat)
    if (partner && this.map.getTile(partner.position)) this.syncHeight(partner)
  }

  canUseForcedLanding(position, catId, ignoredCatIds = new Set()) {
    const tile = this.map.getTile(position)
    if (!tile || tile.terrainType === TERRAIN_TYPE.WALL || !tile.canJumpIn) return false
    const occupants = this.contestantsAt(position, catId)
      .filter((occupant) => !ignoredCatIds.has(occupant.id))
    if (occupants.length === 0) return true
    return occupants.length === 1 && occupants[0].stack.role === STACK_ROLE.NONE
  }

  chooseForcedLanding(startPosition, path, catId, ignoredCatIds = new Set()) {
    for (let index = path.length - 1; index >= 0; index -= 1) {
      if (this.canUseForcedLanding(path[index], catId, ignoredCatIds)) {
        return { position: path[index].clone(), stoppedByFullStack: index !== path.length - 1 }
      }
    }
    return { position: startPosition.clone(), stoppedByFullStack: path.length > 0 }
  }

  resolveSpringLaunch(cat, springTile, now, visitedSprings = new Set(), ignoredCatIds = new Set()) {
    const springKey = springTile.position.key
    if (visitedSprings.has(springKey)) {
      return { outcome: 'spring-cycle-stopped', position: cat.position.clone() }
    }
    const nextVisitedSprings = new Set(visitedSprings)
    nextVisitedSprings.add(springKey)
    this.mechanismEvents.push({
      type: 'spring-activation',
      at: now,
      position: springTile.position.clone(),
      catId: cat.id,
      affectedCatIds: [cat.id],
    })
    const distance = springTile.mechanism.parameters.distance ?? 1
    const direction = springTile.mechanism.direction
    const path = []
    let current = springTile.position.clone()
    for (let step = 0; step < distance; step += 1) {
      const next = current.move(direction)
      const tile = this.map.getTile(next)
      const heightBlocksMultiTileSpring = distance > 1 && tile?.baseHeight > springTile.baseHeight
      if (!tile || tile.terrainType === TERRAIN_TYPE.WALL || !tile.canJumpIn || heightBlocksMultiTileSpring) break
      path.push(next)
      current = next
    }
    if (path.length === 0) {
      cat.actionState = CAT_ACTION_STATE.IDLE
      return { outcome: 'spring-blocked', position: cat.position.clone() }
    }
    return this.resolveForcedLanding(cat, springTile.position, path, now, nextVisitedSprings, ignoredCatIds)
  }

  resolveForcedLanding(
    cat,
    startPosition,
    path,
    now,
    visitedSprings = new Set(),
    ignoredCatIds = new Set(),
  ) {
    const intendedPosition = path.at(-1)?.clone() ?? startPosition.clone()
    const { position, stoppedByFullStack } = this.chooseForcedLanding(
      startPosition,
      path,
      cat.id,
      ignoredCatIds,
    )
    const moved = !position.equals(startPosition)
    if (moved) cat.glue = { active: false, attempts: 0, expiresAt: 0 }
    cat.actionState = CAT_ACTION_STATE.FORCED_MOVEMENT
    cat.position = position.clone()
    cat.resetStack()
    this.syncHeight(cat)

    const tile = this.map.getTile(position)
    if (tile.isCheckpoint) cat.activateCheckpoint(position)
    if (tile.terrainType === TERRAIN_TYPE.PIT || tile.terrainType === TERRAIN_TYPE.SPIKES) {
      const danger = tile.terrainType
      const respawned = this.killAndRespawn(cat, now)
      return {
        outcome: respawned ? `respawned-after-${danger}` : 'waiting-for-respawn-space',
        position: cat.position.clone(),
        intendedPosition,
        stoppedByFullStack,
      }
    }

    const bottom = this.contestantsAt(position, cat.id)
      .find((occupant) => !ignoredCatIds.has(occupant.id)) ?? null
    if (bottom) this.stackOn(cat, bottom, tile)
    if (tile.isFinish) {
      this.finishContestant(cat, now, this.nextFinishFrame++)
      return { outcome: 'finished', position: cat.position.clone(), intendedPosition, stoppedByFullStack }
    }
    if (tile.mechanism?.type === MECHANISM_TYPE.SPRING && cat.stack.role !== STACK_ROLE.TOP) {
      const springResult = this.resolveSpringLaunch(cat, tile, now, visitedSprings, ignoredCatIds)
      return {
        outcome: 'triggered-spring',
        position: cat.position.clone(),
        intendedPosition,
        stoppedByFullStack,
        springResult,
      }
    }
    const bombEvents = this.triggerBombsNear(cat.position, now, cat.id)
    if (bombEvents.length > 0) {
      cat.lastAction = 'triggered-tractor-bomb'
      return {
        outcome: 'triggered-tractor-bomb',
        position: cat.position.clone(),
        intendedPosition,
        stoppedByFullStack,
        bombEvents,
      }
    }
    if (tile.mechanism?.type === MECHANISM_TYPE.GLUE && cat.stack.role !== STACK_ROLE.TOP) {
      cat.glue = { active: true, attempts: 0, expiresAt: now + GLUE_MAX_DURATION_MS }
      cat.actionState = CAT_ACTION_STATE.IDLE
      return { outcome: 'stuck-in-glue', position: cat.position.clone(), intendedPosition, stoppedByFullStack }
    }

    cat.actionState = CAT_ACTION_STATE.IDLE
    return {
      outcome: bottom ? 'stacked' : stoppedByFullStack ? 'stopped-before-full-stack' : 'pulled',
      position: cat.position.clone(),
      intendedPosition,
      stoppedByFullStack,
    }
  }

  resolveTractorBombExplosion(bomb, now) {
    const plans = this.contestants
      .filter((cat) => (
        !cat.finish.reached
        && cat.actionState !== CAT_ACTION_STATE.RESPAWNING
        && now >= cat.invincibleUntil
        && bomb.timer.containsEffectPosition(bomb.position, cat.position)
      ))
      .map((cat, order) => {
        const startPosition = cat.position.clone()
        const atCenter = startPosition.equals(bomb.position)
        const pullDistance = atCenter ? 0 : bomb.timer.pickPullDistance(this.random)
        return {
          cat,
          order,
          startPosition,
          atCenter,
          pullDistance,
          path: atCenter ? [] : this.buildBombPullPath(startPosition, bomb.position, pullDistance),
          initialStackRole: cat.stack.role,
        }
      })

    plans.filter((plan) => !plan.atCenter).forEach((plan) => this.detachStackForForcedMovement(plan.cat))
    const roleOrder = { [STACK_ROLE.BOTTOM]: 0, [STACK_ROLE.NONE]: 1, [STACK_ROLE.TOP]: 2 }
    const orderedPlans = [...plans]
      .sort((a, b) => roleOrder[a.initialStackRole] - roleOrder[b.initialStackRole] || a.order - b.order)
    const unresolvedCatIds = new Set(orderedPlans.filter((plan) => !plan.atCenter).map((plan) => plan.cat.id))
    const results = orderedPlans
      .map((plan) => {
        if (plan.atCenter) {
          plan.cat.actionState = CAT_ACTION_STATE.RESOLVING_MECHANISM
          plan.cat.actionState = CAT_ACTION_STATE.IDLE
          return {
            catId: plan.cat.id,
            pullDistance: 0,
            startPosition: plan.startPosition,
            position: plan.cat.position.clone(),
            outcome: 'center-jump-and-stun',
          }
        }
        unresolvedCatIds.delete(plan.cat.id)
        const landing = this.resolveForcedLanding(
          plan.cat,
          plan.startPosition,
          plan.path,
          now,
          new Set(),
          unresolvedCatIds,
        )
        return {
          catId: plan.cat.id,
          pullDistance: plan.pullDistance,
          startPosition: plan.startPosition,
          path: plan.path.map((position) => position.clone()),
          ...landing,
        }
      })

    return results.sort((a, b) => (
      plans.find((plan) => plan.cat.id === a.catId).order
      - plans.find((plan) => plan.cat.id === b.catId).order
    ))
  }

  buildLinearForcedPath(startPosition, direction, distance, movementHeight) {
    const path = []
    let current = startPosition.clone()
    for (let step = 0; step < distance; step += 1) {
      const next = current.move(direction)
      const tile = this.map.getTile(next)
      if (
        !tile
        || tile.terrainType === TERRAIN_TYPE.WALL
        || !tile.canJumpIn
        || tile.baseHeight > movementHeight
      ) break
      path.push(next)
      current = next
    }
    return path
  }

  activatePiston(piston, now) {
    const targetPosition = piston.position.move(piston.direction)
    const affected = this.contestantsAt(targetPosition)
      .filter((cat) => (
        cat.actionState !== CAT_ACTION_STATE.RESPAWNING
        && now >= cat.invincibleUntil
      ))
    const distances = new Map()
    const bottom = affected.find((cat) => cat.stack.role === STACK_ROLE.BOTTOM)
    const top = bottom ? affected.find((cat) => cat.id === bottom.stack.partnerId) : null
    if (bottom) {
      const bottomDistance = this.randomInteger(
        piston.parameters.minDistance ?? 1,
        piston.parameters.maxDistance ?? 3,
      )
      distances.set(bottom.id, bottomDistance)
      if (top) distances.set(top.id, this.randomInteger(1, bottomDistance))
    }
    affected.forEach((cat) => {
      if (!distances.has(cat.id)) {
        distances.set(cat.id, this.randomInteger(
          piston.parameters.minDistance ?? 1,
          piston.parameters.maxDistance ?? 3,
        ))
      }
    })

    const plans = affected.map((cat, order) => ({
      cat,
      order,
      startPosition: cat.position.clone(),
      initialStackRole: cat.stack.role,
      distance: distances.get(cat.id),
      path: this.buildLinearForcedPath(
        cat.position,
        piston.direction,
        distances.get(cat.id),
        // A piston is a powered shove, so it can lift a cat by one terrain
        // level while moving. A two-level rise is still blocked.
        cat.currentHeight + 1,
      ),
    }))
    plans.forEach((plan) => this.detachStackForForcedMovement(plan.cat))
    const roleOrder = { [STACK_ROLE.BOTTOM]: 0, [STACK_ROLE.NONE]: 1, [STACK_ROLE.TOP]: 2 }
    const orderedPlans = [...plans]
      .sort((a, b) => roleOrder[a.initialStackRole] - roleOrder[b.initialStackRole] || a.order - b.order)
    const unresolvedCatIds = new Set(orderedPlans.map((plan) => plan.cat.id))
    const results = orderedPlans.map((plan) => {
      unresolvedCatIds.delete(plan.cat.id)
      const landing = this.resolveForcedLanding(
        plan.cat,
        plan.startPosition,
        plan.path,
        now,
        new Set(),
        unresolvedCatIds,
      )
      plan.cat.lastAction = 'piston'
      return {
        catId: plan.cat.id,
        distance: plan.distance,
        startPosition: plan.startPosition,
        path: plan.path.map((position) => position.clone()),
        ...landing,
      }
    })
    const event = {
      type: 'piston-activation',
      at: now,
      position: piston.position.clone(),
      direction: piston.direction,
      affectedCatIds: results.map((result) => result.catId),
      results,
    }
    this.mechanismEvents.push(event)
    return event
  }

  advancePistons(now) {
    this.pistons.forEach((piston) => {
      if (now < piston.nextActivationAt) return
      this.activatePiston(piston, now)
      piston.nextActivationAt = now + (piston.parameters.intervalMs ?? PISTON_INTERVAL_MS)
    })
  }

  triggerBombsNear(position, now, catId) {
    return this.tractorBombs
      .map((bomb) => this.recordBombExplosion(
        bomb,
        bomb.timer?.onCatCakeEnterTriggerArea(now, bomb.position, position),
        catId,
      ))
      .filter(Boolean)
  }

  isInsideBombEffect(position) {
    return this.tractorBombs.some((bomb) => {
      const distance = Math.abs(position.x - bomb.position.x) + Math.abs(position.y - bomb.position.y)
      return distance <= (bomb.parameters.effectRadius ?? TRACTOR_BOMB_EFFECT_RADIUS)
    })
  }

  isAiSafeTile(tile) {
    return tile.terrainType !== TERRAIN_TYPE.SPIKES
      && !tile.mechanism
      && !this.isInsideBombEffect(tile.position)
  }

  aiTileCost(cat, tile, safeMode = cat.aiSafeMode) {
    let cost = 1
    const riskScale = safeMode ? 1 : this.aiConfig.riskScale
    if (tile.terrainType === TERRAIN_TYPE.SPIKES) cost += (safeMode ? 500 : 35 * riskScale)
    if (tile.mechanism?.type === MECHANISM_TYPE.GLUE) cost += (safeMode ? 140 : 7 * riskScale)
    if (tile.mechanism?.type === MECHANISM_TYPE.PISTON) cost += (safeMode ? 180 : 9 * riskScale)
    if (tile.mechanism?.type === MECHANISM_TYPE.TRACTOR_BOMB) cost += (safeMode ? 220 : 12 * riskScale)
    if (tile.mechanism?.type === MECHANISM_TYPE.SPRING) cost += safeMode ? 12 : -0.2
    this.tractorBombs.forEach((bomb) => {
      const distance = Math.abs(tile.position.x - bomb.position.x) + Math.abs(tile.position.y - bomb.position.y)
      const radius = bomb.parameters.effectRadius ?? TRACTOR_BOMB_EFFECT_RADIUS
      if (distance <= radius) cost += (safeMode ? 90 : 5 * riskScale) * (radius - distance + 1)
    })
    if (tile.position.key === cat.lastDeathPositionKey) {
      cost += (safeMode ? 300 : 12 * riskScale) * Math.max(1, cat.repeatedDeathCount)
    }
    const occupants = this.contestantsAt(tile.position, cat.id)
    cost += occupants.length * 3
    const playerOccupant = occupants.find((occupant) => (
      occupant.controllerType === CONTROLLER_TYPE.PLAYER
      && occupant.stack.role === STACK_ROLE.NONE
      && !occupant.finish.reached
    ))
    if (!safeMode && playerOccupant) cost = Math.max(0.25, cost - 5)
    return cost
  }

  findAiDirection(cat, { safeOnly = cat.aiSafeMode } = {}) {
    const startKey = cat.position.key
    const costs = new Map([[startKey, 0]])
    const previous = new Map()
    const frontier = [{ tile: this.map.getTile(cat.position), cost: 0 }]
    let finishTile = null

    while (frontier.length > 0) {
      frontier.sort((a, b) => a.cost - b.cost || a.tile.position.y - b.tile.position.y)
      const current = frontier.shift()
      if (current.cost !== costs.get(current.tile.position.key)) continue
      if (current.tile.isFinish) {
        finishTile = current.tile
        break
      }
      const currentHeight = current.tile.position.key === startKey ? cat.currentHeight : current.tile.baseHeight
      const directions = [DIRECTION.UP, DIRECTION.LEFT, DIRECTION.RIGHT, DIRECTION.DOWN]
      directions.forEach((direction) => {
        const next = this.map.getTile(current.tile.position.move(direction))
        if (!next || next.terrainType === TERRAIN_TYPE.WALL || next.terrainType === TERRAIN_TYPE.PIT) return
        if (!next.canJumpIn || !next.canStand || !canJumpBetweenHeights(currentHeight, next.baseHeight)) return
        if (this.contestantsAt(next.position, cat.id).length >= 2) return
        if (safeOnly && !next.isFinish && !this.isAiSafeTile(next)) return
        const nextCost = current.cost + this.aiTileCost(cat, next, cat.aiSafeMode)
        if (nextCost >= (costs.get(next.position.key) ?? Number.POSITIVE_INFINITY)) return
        costs.set(next.position.key, nextCost)
        previous.set(next.position.key, { key: current.tile.position.key, direction })
        frontier.push({ tile: next, cost: nextCost })
      })
    }

    if (!finishTile) {
      return safeOnly ? this.findAiDirection(cat, { safeOnly: false }) : null
    }
    let key = finishTile.position.key
    let step = previous.get(key)
    while (step && step.key !== startKey) {
      key = step.key
      step = previous.get(key)
    }
    return step?.direction ?? null
  }

  legalAiDirections(cat) {
    const directions = [DIRECTION.UP, DIRECTION.LEFT, DIRECTION.RIGHT, DIRECTION.DOWN]
    return directions.filter((direction) => {
      const tile = this.map.getTile(cat.position.move(direction))
      return tile
        && tile.terrainType !== TERRAIN_TYPE.WALL
        && tile.terrainType !== TERRAIN_TYPE.PIT
        && tile.canJumpIn
        && tile.canStand
        && canJumpBetweenHeights(cat.currentHeight, tile.baseHeight)
        && this.contestantsAt(tile.position, cat.id).length < 2
    })
  }

  activateAiCompensation(cat) {
    if (cat.controllerType !== CONTROLLER_TYPE.AI || cat.aiSafeMode || cat.finish.reached) return false
    cat.aiSafeMode = true
    cat.aiSafeModeStartedY = cat.position.y
    cat.aiStalledActions = 0
    cat.aiCompensationCount += 1
    cat.lastAction = 'safe-route-compensation'
    return true
  }

  updateAiProgress(cat, previousY) {
    if (cat.finish.reached || cat.position.y < cat.aiBestY) {
      cat.aiBestY = Math.min(cat.aiBestY, cat.position.y)
      cat.aiStalledActions = 0
    } else if (cat.position.y >= previousY) {
      cat.aiStalledActions += 1
    } else {
      cat.aiStalledActions = Math.max(0, cat.aiStalledActions - 1)
    }

    if (
      cat.aiSafeMode
      && cat.aiSafeModeStartedY !== null
      && cat.position.y <= cat.aiSafeModeStartedY - 3
    ) {
      cat.aiSafeMode = false
      cat.aiSafeModeStartedY = null
      cat.aiStalledActions = 0
      return
    }
    if (cat.aiStalledActions >= this.aiConfig.compensationThreshold) {
      this.activateAiCompensation(cat)
    }
  }

  advanceAi(now) {
    this.contestants.forEach((cat) => {
      if (
        cat.controllerType !== CONTROLLER_TYPE.AI
        || cat.finish.reached
        || cat.actionState === CAT_ACTION_STATE.RESPAWNING
        || now < cat.nextAiActionAt
      ) return
      cat.nextAiActionAt = now
        + this.aiConfig.actionMinMs
        + Math.floor(this.random() * this.aiConfig.actionVarianceMs)
      const previousY = cat.position.y
      let direction = this.findAiDirection(cat)
      if (!direction) {
        cat.lastAction = 'replanning'
        cat.aiStalledActions += 1
        if (cat.aiStalledActions >= this.aiConfig.compensationThreshold) this.activateAiCompensation(cat)
        return
      }
      if (!cat.aiSafeMode && this.random() < this.aiConfig.mistakeChance) {
        const alternatives = this.legalAiDirections(cat).filter((candidate) => candidate !== direction)
        if (alternatives.length > 0) {
          direction = alternatives[Math.floor(this.random() * alternatives.length)]
        }
      }
      const result = this.attemptNormalJump(cat.id, direction, now)
      cat.lastAction = result.ok ? result.outcome : result.reason
      this.updateAiProgress(cat, previousY)
    })
  }

  completeWaitingRespawns(now) {
    this.contestants.forEach((cat) => {
      if (cat.actionState !== CAT_ACTION_STATE.RESPAWNING) return
      const position = this.findOpenRespawnPosition(cat)
      if (!position) return
      cat.position = position
      cat.invincibleUntil = now + RESPAWN_INVINCIBILITY_MS
      cat.actionState = CAT_ACTION_STATE.IDLE
      cat.lastAction = 'respawned'
      this.syncHeight(cat)
    })
  }

  advanceClock(now) {
    if (this.status === RACE_STATUS.COUNTDOWN && now >= this.countdownEndsAt) {
      this.status = RACE_STATUS.RUNNING
      this.startedAt = this.countdownEndsAt
    }
    this.contestants.forEach((cat) => {
      if (cat.glue.active && now >= cat.glue.expiresAt) {
        cat.glue = { active: false, attempts: 0, expiresAt: 0 }
      }
    })
    if (this.status === RACE_STATUS.RUNNING) {
      this.completeWaitingRespawns(now)
      this.advancePistons(now)
      this.tractorBombs.forEach((bomb) => {
        this.recordBombExplosion(bomb, bomb.timer?.tick(now))
      })
      this.advanceAi(now)
    }
    return this.status
  }

  getContestant(id) {
    return this.contestants.find((cat) => cat.id === id) ?? null
  }

  contestantsAt(position, exceptId = null) {
    return this.contestants.filter((cat) => (
      cat.id !== exceptId
      && !cat.finish.reached
      && cat.actionState !== CAT_ACTION_STATE.RESPAWNING
      && cat.position.equals(position)
    ))
  }

  syncHeight(cat) {
    const tile = this.map.getTile(cat.position)
    if (!tile) throw new Error(`${cat.name} is not standing on a map tile`)
    cat.currentHeight = tile.baseHeight + (cat.stack.role === STACK_ROLE.TOP ? 1 : 0)
  }

  detachTopCat(cat) {
    if (cat.stack.role !== STACK_ROLE.TOP) return
    const bottom = this.getContestant(cat.stack.partnerId)
    bottom?.resetStack()
    cat.resetStack()
    if (bottom) this.syncHeight(bottom)
  }

  stackOn(cat, bottom, tile) {
    this.detachTopCat(cat)
    cat.position = tile.position.clone()
    cat.stack = { role: STACK_ROLE.TOP, partnerId: bottom.id, shakeOffAttempts: 0 }
    bottom.stack = { role: STACK_ROLE.BOTTOM, partnerId: cat.id, shakeOffAttempts: 0 }
    this.syncHeight(bottom)
    this.syncHeight(cat)
  }

  fail(reason) {
    return { ok: false, reason }
  }

  attemptShakeOff(cat, direction, now) {
    if (now < cat.normalJumpReadyAt) return this.fail('jump-cooldown')
    cat.consumeNormalJumpCooldown(now)
    const top = this.getContestant(cat.stack.partnerId)
    if (!top || top.stack.role !== STACK_ROLE.TOP) {
      cat.resetStack()
      this.syncHeight(cat)
      return this.fail('missing-stack-partner')
    }
    const targetPosition = top.position.move(direction)
    const targetTile = this.map.getTile(targetPosition)
    cat.stack.shakeOffAttempts += 1
    const probability = Math.min(1, 0.1 + (cat.stack.shakeOffAttempts - 1) * 0.2)
    if (
      !targetTile
      || targetTile.terrainType === TERRAIN_TYPE.WALL
      || !targetTile.canJumpIn
      || !this.canUseForcedLanding(targetPosition, top.id)
    ) {
      cat.lastAction = 'shake-off-blocked'
      return { ok: true, outcome: 'shake-off-blocked', probability, cat }
    }
    if (this.random() >= probability) {
      cat.lastAction = 'shake-off-failed'
      return { ok: true, outcome: 'shake-off-failed', probability, cat }
    }

    const startPosition = top.position.clone()
    cat.resetStack()
    top.resetStack()
    this.syncHeight(cat)
    this.syncHeight(top)
    const landing = this.resolveForcedLanding(top, startPosition, [targetPosition], now)
    cat.lastAction = 'shake-off-success'
    top.lastAction = 'shaken-off'
    return { ok: true, outcome: 'shake-off-success', probability, cat, top, landing }
  }

  attemptGlueEscape(cat, now) {
    cat.consumeNormalJumpCooldown(now)
    cat.glue.attempts += 1
    const probabilities = [0.3, 0.48, 0.66, 0.84, 1]
    const probability = probabilities[Math.min(cat.glue.attempts, probabilities.length) - 1]
    if (this.random() >= probability) {
      cat.lastAction = 'glue-struggle'
      return { escaped: false, result: { ok: true, outcome: 'glue-struggle', probability, cat } }
    }
    cat.glue = { active: false, attempts: 0, expiresAt: 0 }
    cat.lastAction = 'escaped-glue'
    return { escaped: true, result: null }
  }

  attemptNormalJump(catId, direction, now) {
    if (this.status !== RACE_STATUS.RUNNING) return this.fail('race-not-running')
    if (!Object.values(DIRECTION).includes(direction)) return this.fail('invalid-direction')
    const cat = this.getContestant(catId)
    if (!cat) return this.fail('unknown-contestant')
    if (now < cat.normalJumpReadyAt) return this.fail('jump-cooldown')
    if (cat.finish.reached || cat.actionState !== CAT_ACTION_STATE.IDLE) return this.fail('action-blocked')
    if (cat.stack.role === STACK_ROLE.BOTTOM) return this.attemptShakeOff(cat, direction, now)
    let cooldownConsumed = false
    if (cat.glue.active) {
      const escape = this.attemptGlueEscape(cat, now)
      if (!escape.escaped) return escape.result
      cooldownConsumed = true
    }

    // Once a legal normal-jump action is submitted, every map/target validation
    // result consumes the same cooldown, including a failed landing.
    if (!cooldownConsumed) cat.consumeNormalJumpCooldown(now)
    const sourceTile = this.map.getTile(cat.position)
    if (!sourceTile?.canJumpOut) return this.fail('source-blocks-jump')
    const targetPosition = cat.position.move(direction)
    const targetTile = this.map.getTile(targetPosition)
    if (!targetTile) return this.fail('outside-map')
    if (targetTile.terrainType === TERRAIN_TYPE.WALL || !targetTile.canJumpIn) {
      return this.fail('target-blocks-jump')
    }
    const occupants = this.contestantsAt(targetPosition, cat.id)
    if (occupants.length >= 2) return this.fail('target-stack-full')
    const bottom = occupants[0] ?? null
    if (bottom && (bottom.stack.role !== STACK_ROLE.NONE || bottom.finish.reached)) return this.fail('target-stack-full')
    const targetHeight = targetTile.baseHeight + (bottom ? 1 : 0)
    if (!canJumpBetweenHeights(cat.currentHeight, targetHeight)) return this.fail('height-difference')

    if (bottom) this.stackOn(cat, bottom, targetTile)
    else {
      this.detachTopCat(cat)
      cat.position = targetPosition
      cat.resetStack()
      this.syncHeight(cat)
    }

    if (targetTile.isCheckpoint) cat.activateCheckpoint(targetPosition)
    if (targetTile.terrainType === TERRAIN_TYPE.PIT) {
      const respawned = this.killAndRespawn(cat, now)
      return { ok: true, outcome: respawned ? 'respawned-after-pit' : 'waiting-for-respawn-space', cat }
    }
    if (targetTile.terrainType === TERRAIN_TYPE.SPIKES) {
      if (now < cat.invincibleUntil) return { ok: true, outcome: 'moved-while-invincible', cat }
      const respawned = this.killAndRespawn(cat, now)
      return { ok: true, outcome: respawned ? 'respawned-after-spikes' : 'waiting-for-respawn-space', cat }
    }
    if (targetTile.isFinish) {
      this.finishContestant(cat, now, this.nextFinishFrame++)
      cat.lastAction = 'finished'
      return { ok: true, outcome: 'finished', cat }
    }
    if (targetTile.mechanism?.type === MECHANISM_TYPE.SPRING && cat.stack.role !== STACK_ROLE.TOP) {
      const springResult = this.resolveSpringLaunch(cat, targetTile, now)
      cat.lastAction = 'triggered-spring'
      return { ok: true, outcome: 'triggered-spring', cat, springResult }
    }

    // Bombs float above the tile and never block movement. Entering any cell in
    // their centered 3×3 trigger area requests an immediate explosion.
    const bombEvents = this.triggerBombsNear(cat.position, now, cat.id)
    if (bombEvents.length > 0) {
      cat.lastAction = 'triggered-tractor-bomb'
      return { ok: true, outcome: 'triggered-tractor-bomb', cat, bombEvents }
    }

    if (targetTile.mechanism?.type === MECHANISM_TYPE.GLUE && cat.stack.role !== STACK_ROLE.TOP) {
      cat.glue = { active: true, attempts: 0, expiresAt: now + GLUE_MAX_DURATION_MS }
      cat.lastAction = 'stuck-in-glue'
      return { ok: true, outcome: 'stuck-in-glue', cat }
    }
    cat.lastAction = bottom ? 'stacked' : 'moved'
    return { ok: true, outcome: bottom ? 'stacked' : 'moved', cat }
  }

  killAndRespawn(cat, now) {
    const deathPositionKey = cat.position.key
    cat.repeatedDeathCount = cat.lastDeathPositionKey === deathPositionKey ? cat.repeatedDeathCount + 1 : 1
    cat.lastDeathPositionKey = deathPositionKey
    this.detachTopCat(cat)
    if (cat.stack.role === STACK_ROLE.BOTTOM) {
      const top = this.getContestant(cat.stack.partnerId)
      top?.resetStack()
      if (top) this.syncHeight(top)
    }
    cat.resetStack()
    cat.deathCount += 1
    if (cat.controllerType === CONTROLLER_TYPE.AI) {
      cat.aiStalledActions += Math.ceil(this.aiConfig.compensationThreshold / 2)
      if (cat.repeatedDeathCount >= 2 || cat.aiStalledActions >= this.aiConfig.compensationThreshold) {
        this.activateAiCompensation(cat)
      }
    }
    const respawnPosition = this.findOpenRespawnPosition(cat)
    if (!respawnPosition) {
      cat.actionState = CAT_ACTION_STATE.RESPAWNING
      cat.lastAction = 'waiting-for-respawn-space'
      return false
    }
    cat.position = respawnPosition
    cat.invincibleUntil = now + RESPAWN_INVINCIBILITY_MS
    cat.actionState = CAT_ACTION_STATE.IDLE
    cat.lastAction = 'respawned'
    this.syncHeight(cat)
    return true
  }

  findOpenRespawnPosition(cat) {
    return this.map.getRow(cat.respawnLine.y)
      .filter((tile) => (
        tile.canStand
        && tile.canJumpIn
        && tile.terrainType !== TERRAIN_TYPE.PIT
        && tile.terrainType !== TERRAIN_TYPE.SPIKES
        && this.contestantsAt(tile.position, cat.id).length === 0
      ))
      .sort((a, b) => (
        Math.abs(a.position.x - cat.respawnLine.preferredX)
        - Math.abs(b.position.x - cat.respawnLine.preferredX)
        || a.position.x - b.position.x
      ))[0]?.position.clone() ?? null
  }

  finishContestant(cat, time, frame) {
    this.detachTopCat(cat)
    cat.finish = { reached: true, time, frame, rank: null }
    cat.actionState = CAT_ACTION_STATE.FINISHING
    cat.lastAction = 'finished'
    this.updateFinishRanks()
    if (this.contestants.every((contestant) => contestant.finish.reached)) this.status = RACE_STATUS.FINISHED
  }

  updateFinishRanks() {
    const finishers = this.contestants
      .filter((cat) => cat.finish.reached)
      .sort((a, b) => a.finish.time - b.finish.time || a.finish.frame - b.finish.frame)
    finishers.forEach((cat) => {
      cat.finish.rank = 1 + finishers.filter((other) => other.finish.time < cat.finish.time).length
    })
  }
}

export function createFoundationRace() {
  const width = 5
  const height = 4
  const tiles = Array.from({ length: height }, (_, y) => (
    Array.from({ length: width }, (_, x) => (
      new MapTile({
        x,
        y,
        baseHeight: 0,
        isStart: y === height - 1,
        isCheckpoint: y === 2,
        isFinish: y === 0,
      })
    ))
  ))

  const map = new RaceMap({ width, height, tiles })
  const colors = ['#8edcff', '#d5a7ff', '#ffb8dc', '#a9efcc', '#ffe39a']
  const contestants = [
    new CatCake({
      id: 'cat-player',
      name: '玩家猫猫糕',
      controllerType: CONTROLLER_TYPE.PLAYER,
      startPosition: new GridPosition(2, 3),
      color: colors[0],
    }),
    ...[0, 1, 3, 4].map((x, index) => new CatCake({
      id: `cat-ai-${index + 1}`,
      name: `AI 猫猫糕 ${index + 1}`,
      controllerType: CONTROLLER_TYPE.AI,
      startPosition: new GridPosition(x, 3),
      color: colors[index + 1],
    })),
  ]
  return new RaceSession({ map, contestants })
}

export function createPlayableRace(
  map,
  { random = Math.random, aiDifficulty = AI_DIFFICULTY.NORMAL } = {},
) {
  if (!(map instanceof RaceMap)) throw new TypeError('map must be a RaceMap')
  const startTiles = map.flatTiles
    .filter((tile) => tile.isStart && tile.canStand)
    .sort((a, b) => a.position.x - b.position.x)
  if (startTiles.length < 5) throw new Error('A playable race map requires at least five start tiles')
  const preferredIndices = [4, 0, 2, 6, 8]
  const selectedStarts = preferredIndices.map((index) => startTiles[Math.min(index, startTiles.length - 1)])
  const colors = ['#8edcff', '#d5a7ff', '#ffb8dc', '#a9efcc', '#ffe39a']
  const names = ['玩家猫猫糕', '巡游猫猫糕', '星糖猫猫糕', '薄荷猫猫糕', '奶油猫猫糕']
  const contestants = selectedStarts.map((tile, index) => {
    const cat = new CatCake({
      id: index === 0 ? 'cat-player' : `cat-ai-${index}`,
      name: names[index],
      controllerType: index === 0 ? CONTROLLER_TYPE.PLAYER : CONTROLLER_TYPE.AI,
      startPosition: tile.position,
      color: colors[index],
    })
    cat.preferredLane = tile.position.x
    return cat
  })
  return new RaceSession({ map, contestants, random, aiDifficulty })
}

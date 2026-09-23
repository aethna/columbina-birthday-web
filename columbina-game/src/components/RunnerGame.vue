<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import characterIdle from '../../p/columbina-idle.png'
import characterJump from '../../p/columbina-jump.png'
import characterRun from '../../p/columbina-run-transparent.webp'
import moonObstacle from '../../p/event/moon-obstacle.webp'
import stageOne from '../../p/stages/01.jpg'
import stageTwo from '../../p/stages/02.jpg'
import stageThree from '../../p/stages/03.jpg'
import stageFour from '../../p/stages/04.jpg'
import stageMusicOne from '../../p/audio/stage-01.opus'
import stageMusicTwo from '../../p/audio/stage-02.opus'
import stageMusicThree from '../../p/audio/stage-03.opus'
import stageMusicFour from '../../p/audio/stage-04.opus'
import { collidesWithAlpha, loadAlphaMask } from '../games/alphaCollision.js'
import { playSfx } from '../games/sound.js'
import { setBgm } from '../games/bgm.js'
import { playVoice, stopVoice, VOICE_EVENTS } from '../games/voice.js'

const emit = defineEmits(['back'])

const stage = ref(null)
const playerElement = ref(null)
const status = ref('ready')
const playerY = ref(0)
const distance = ref(0)
const score = ref(0)
const bestScore = ref(Number(localStorage.getItem('columbina-runner-best') || 0))
const jumpsUsed = ref(0)
const onGround = ref(true)
const videoFailed = ref(false)
const jumpImageFailed = ref(false)
const idleImageFailed = ref(false)
const platforms = ref([])
const hazards = ref([])
const challenges = ref([])
const effects = ref([])
const isHit = ref(false)
const moonObstacleMask = ref(null)

let animationFrame = 0
let lastFrame = 0
let playerVelocity = 0
let generatedUntil = 0
let challengeIndex = 0
let entityId = 0
let effectId = 0
const effectTimers = new Set()

const speed = computed(() => Math.min(405, 265 + Math.max(0, score.value - 4) * 4.2))
const stageBackgrounds = [stageOne, stageTwo, stageThree, stageFour]
const stageMusic = [stageMusicOne, stageMusicTwo, stageMusicThree, stageMusicFour]
const currentStageBackground = computed(() => stageBackgrounds[Math.floor(score.value / 10) % stageBackgrounds.length])
watch(() => Math.floor(score.value / 10), (index) => setBgm(stageMusic[index % 4]), { immediate: true })
function preloadStage(index) { const image = new Image(); image.src = stageBackgrounds[index % stageBackgrounds.length] }
watch(score, (value) => { if (value > 0 && value % 10 === 9) preloadStage(Math.floor(value / 10) + 1) })

function stageSize() {
  return {
    width: stage.value?.clientWidth || 1100,
    height: stage.value?.clientHeight || 650,
  }
}

function playerSize() {
  return {
    width: playerElement.value?.offsetWidth || 68,
    height: playerElement.value?.offsetHeight || 68,
  }
}

function groundY() {
  return Math.round(stageSize().height * 0.77)
}

function playerX() {
  return Math.round(stageSize().width * 0.22)
}

function addPlatform(start, end) {
  platforms.value.push({ id: entityId++, start, end })
}

function addChallenge(scoreX, kind) {
  challenges.value.push({ id: entityId++, scoreX, kind, scored: false })
}

function gapWidth(kind, level) {
  const levelSpeed = Math.min(405, 265 + Math.max(0, level - 4) * 4.2)
  if (kind === 'short') return Math.round(Math.min(155, levelSpeed * 0.52))
  if (kind === 'medium') return Math.round(Math.min(245, levelSpeed * 0.83))
  return Math.round(Math.min(350, levelSpeed * 1.13))
}

function createGap(kind, level, landingLength) {
  const start = generatedUntil
  const width = gapWidth(kind, level)
  const landingStart = start + width
  const landing = landingLength || (level < 6 ? 720 : level < 16 ? 630 : 560)
  addPlatform(landingStart, landingStart + landing)
  addChallenge(landingStart + Math.min(130, landing * 0.24), `${kind}-gap`)
  generatedUntil = landingStart + landing
}

function createGroundObstacle(height, level, kind) {
  const sectionStart = generatedUntil
  const sectionLength = level < 16 ? 820 : 700
  const asset = level % 2 === 0 ? 'vertical-one' : 'vertical-two'
  const assetRatio = asset === 'vertical-one' ? 226 / 400 : 173 / 383
  addPlatform(sectionStart, sectionStart + sectionLength)
  hazards.value.push({
    id: entityId++,
    type: 'tower',
    kind,
    x: sectionStart + Math.min(330, sectionLength * 0.42) + (asset === 'vertical-one' ? -8 : 8),
    width: Math.round(height * assetRatio),
    height,
    bottomGap: 0,
    asset,
  })
  addChallenge(sectionStart + sectionLength * 0.68, `${kind}-obstacle`)
  generatedUntil = sectionStart + sectionLength
}

function createLowTunnel(level) {
  const sectionStart = generatedUntil
  const lead = 190
  const width = gapWidth('short', level)
  const gapStart = sectionStart + lead
  const landingStart = gapStart + width
  addPlatform(sectionStart, gapStart)
  addPlatform(landingStart, landingStart + 650)
  const asset = level % 2 === 0 ? 'horizontal-one' : 'horizontal-two'
  const obstacleWidth = width + 205
  const assetRatio = asset === 'horizontal-one' ? 383 / 377 : 400 / 333
  hazards.value.push({
    id: entityId++,
    type: 'ceiling',
    kind: 'low-route',
    x: gapStart - 58 + (asset === 'horizontal-one' ? -8 : 8),
    width: obstacleWidth,
    height: Math.round(obstacleWidth / assetRatio),
    clearance: 158,
    asset,
  })
  addChallenge(landingStart + 180, 'short-gap-low-ceiling')
  generatedUntil = landingStart + 650
}

function createDoubleGap(level) {
  const firstStart = generatedUntil
  const firstWidth = gapWidth('short', level)
  const islandStart = firstStart + firstWidth
  const islandWidth = 220
  const secondStart = islandStart + islandWidth
  const secondWidth = gapWidth(level > 38 ? 'medium' : 'short', level)
  const landingStart = secondStart + secondWidth
  addPlatform(islandStart, secondStart)
  addPlatform(landingStart, landingStart + 680)
  addChallenge(landingStart + 150, 'double-gap')
  generatedUntil = landingStart + 680
}

function createGapThenObstacle(level) {
  const start = generatedUntil
  const width = gapWidth(level > 25 ? 'medium' : 'short', level)
  const landingStart = start + width
  const landingLength = 850
  addPlatform(landingStart, landingStart + landingLength)
  const asset = level % 2 === 0 ? 'vertical-two' : 'vertical-one'
  const obstacleHeight = 130
  const assetRatio = asset === 'vertical-one' ? 226 / 400 : 173 / 383
  hazards.value.push({
    id: entityId++,
    type: 'tower',
    kind: 'double',
    x: landingStart + 310 + (asset === 'vertical-one' ? -8 : 8),
    width: Math.round(obstacleHeight * assetRatio),
    height: obstacleHeight,
    bottomGap: 0,
    asset,
  })
  addChallenge(landingStart + 560, 'gap-mid-obstacle')
  generatedUntil = landingStart + landingLength
}

function choosePattern(level) {
  const roll = Math.random()

  if (level <= 5) {
    if (roll < 0.68) return 'short'
    if (roll < 0.84) return 'safe'
    return 'singleBlock'
  }
  if (level <= 15) {
    if (roll < 0.32) return 'short'
    if (roll < 0.62) return 'medium'
    if (roll < 0.75) return 'singleBlock'
    if (roll < 0.91) return 'lowTunnel'
    return 'doubleBlock'
  }
  if (level <= 30) {
    if (roll < 0.12) return 'singleBlock'
    if (roll < 0.31) return 'medium'
    if (roll < 0.52) return 'long'
    if (roll < 0.69) return 'doubleBlock'
    if (roll < 0.85) return 'lowTunnel'
    return 'gapBlock'
  }

  if (roll < 0.08) return 'singleBlock'
  if (roll < 0.23) return 'medium'
  if (roll < 0.41) return 'long'
  if (roll < 0.56) return 'lowTunnel'
  if (roll < 0.70) return 'doubleBlock'
  if (roll < 0.83) return 'tripleBlock'
  if (roll < 0.93) return 'doubleGap'
  return 'gapBlock'
}

function generateChallenge(level) {
  const pattern = choosePattern(level)

  if (pattern === 'safe') {
    const start = generatedUntil
    addPlatform(start, start + 720)
    addChallenge(start + 520, 'safe-run')
    generatedUntil = start + 720
    return
  }
  if (pattern === 'short' || pattern === 'medium' || pattern === 'long') {
    createGap(pattern, level)
    return
  }
  if (pattern === 'lowTunnel') {
    createLowTunnel(level)
    return
  }
  if (pattern === 'singleBlock') {
    createGroundObstacle(72, level, 'single')
    return
  }
  if (pattern === 'doubleBlock') {
    createGroundObstacle(132, level, 'double')
    return
  }
  if (pattern === 'tripleBlock') {
    createGroundObstacle(192, level, 'triple')
    return
  }
  if (pattern === 'doubleGap') {
    createDoubleGap(level)
    return
  }
  createGapThenObstacle(level)
}

function ensureWorld() {
  const ahead = distance.value + stageSize().width * 2.5
  while (generatedUntil < ahead) {
    generateChallenge(challengeIndex)
    challengeIndex += 1
  }
}

function clearEffectTimers() {
  effectTimers.forEach((timer) => clearTimeout(timer))
  effectTimers.clear()
}

function addEffect(type, level = 0, x = playerX(), y = playerY.value) {
  const id = effectId++
  effects.value.push({ id, type, level, x, y })
  const timer = setTimeout(() => {
    effects.value = effects.value.filter((effect) => effect.id !== id)
    effectTimers.delete(timer)
  }, type === 'score' ? 700 : 480)
  effectTimers.add(timer)
}

function prepareGame(nextStatus) {
  cancelAnimationFrame(animationFrame)
  clearEffectTimers()
  status.value = nextStatus
  distance.value = 0
  score.value = 0
  jumpsUsed.value = 0
  onGround.value = true
  isHit.value = false
  playerVelocity = 0
  lastFrame = 0
  challengeIndex = 0
  platforms.value = []
  hazards.value = []
  challenges.value = []
  effects.value = []

  const { width } = stageSize()
  const initialEnd = Math.max(1100, width * 1.18)
  addPlatform(-300, initialEnd)
  generatedUntil = initialEnd
  ensureWorld()
  playerY.value = groundY() - playerSize().height
}

function resetGame() {
  prepareGame('ready')
}

function startGame() {
  playSfx('start')
  playVoice(VOICE_EVENTS.RUNNER_START)
  prepareGame('playing')
  animationFrame = requestAnimationFrame(gameLoop)
}

function jump() {
  if (status.value === 'over' || jumpsUsed.value >= 3) return
  const startedNow = status.value === 'ready'
  if (startedNow) startGame()

  const jumpForces = [-525, -510, -495]
  const level = jumpsUsed.value + 1
  playerVelocity = jumpForces[jumpsUsed.value]
  playSfx('jump')
  /* 开局那一下不喊，避免和开场台词撞车 */
  if (!startedNow) playVoice(VOICE_EVENTS.RUNNER_JUMP, { chance: 0.24, cooldown: 7000 })
  jumpsUsed.value = level
  onGround.value = false
  addEffect(level === 1 ? 'jump' : 'trail', level, playerX() - 18, playerY.value + playerSize().height * 0.62)
}

function hasSupport(worldX) {
  return platforms.value.some((platform) => worldX >= platform.start && worldX <= platform.end)
}

function hazardRect(hazard) {
  const x = hazard.x - distance.value
  if (hazard.type === 'ceiling') {
    return {
      x,
      y: groundY() - hazard.clearance - hazard.height,
      width: hazard.width,
      height: hazard.height,
    }
  }
  return {
    x,
    y: groundY() - hazard.bottomGap - hazard.height,
    width: hazard.width,
    height: hazard.height,
  }
}

function playerRect() {
  const size = playerSize()
  return {
    x: playerX() - size.width / 2 + size.width * 0.16,
    y: playerY.value + size.height * 0.13,
    width: size.width * 0.68,
    height: size.height * 0.75,
  }
}

function intersectRects(first, second) {
  const left = Math.max(first.x, second.x)
  const right = Math.min(first.x + first.width, second.x + second.width)
  const top = Math.max(first.y, second.y)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  if (left >= right || top >= bottom) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function hitObstacle() {
  const player = playerRect()
  return hazards.value.some((hazard) => {
    const rect = hazardRect(hazard)
    if (rect.x > stageSize().width + 80 || rect.x + rect.width < -80) return false
    if (hazard.type !== 'ceiling' || !moonObstacleMask.value) {
      return collidesWithAlpha(player, rect, moonObstacleMask.value)
    }

    /* 悬空障碍的图保持原始比例、在裁剪框里底对齐：碰撞也用这同一套几何算，
       否则某些机型（Huawei 等）上图片被拉抻，判定框和看到的图形对不上 */
    const visiblePlayer = intersectRects(player, rect)
    if (!visiblePlayer) return false
    const renderedHeight = rect.width * moonObstacleMask.value.height / moonObstacleMask.value.width
    const imageRect = {
      x: rect.x,
      y: rect.y + rect.height - renderedHeight,
      width: rect.width,
      height: renderedHeight,
    }
    return collidesWithAlpha(visiblePlayer, imageRect, moonObstacleMask.value, { flipX: true, flipY: true })
  })
}

function endGame() {
  if (status.value !== 'playing') return
  status.value = 'over'
  isHit.value = true
  playSfx('hit')
  playVoice(VOICE_EVENTS.RUNNER_DEATH)
  cancelAnimationFrame(animationFrame)
  addEffect('hit', 0, playerX(), playerY.value + playerSize().height / 2)
  if (score.value > bestScore.value) {
    bestScore.value = score.value
    localStorage.setItem('columbina-runner-best', String(score.value))
  }
}

function updateScore() {
  const worldX = distance.value + playerX()
  challenges.value.forEach((challenge) => {
    if (!challenge.scored && worldX >= challenge.scoreX) {
      challenge.scored = true
      score.value += 1
      playSfx('score')
      addEffect('score', 0, playerX() + 42, Math.max(70, playerY.value - 24))
    }
  })
}

function cleanWorld() {
  const cutoff = distance.value - 450
  platforms.value = platforms.value.filter((platform) => platform.end > cutoff)
  hazards.value = hazards.value.filter((hazard) => hazard.x + hazard.width > cutoff)
  challenges.value = challenges.value.filter((challenge) => !challenge.scored || challenge.scoreX > cutoff)
}

function gameLoop(timestamp) {
  if (status.value !== 'playing') return
  if (!lastFrame) lastFrame = timestamp
  const delta = Math.min((timestamp - lastFrame) / 1000, 0.034)
  lastFrame = timestamp

  distance.value += speed.value * delta
  const size = playerSize()
  const worldX = distance.value + playerX()
  const supported = hasSupport(worldX)

  if (onGround.value && supported) {
    playerY.value = groundY() - size.height
  } else {
    if (onGround.value && !supported) {
      onGround.value = false
      playerVelocity = Math.max(playerVelocity, 35)
    }

    const previousBottom = playerY.value + size.height
    playerVelocity += 1580 * delta
    playerY.value += playerVelocity * delta
    const currentBottom = playerY.value + size.height

    if (playerVelocity >= 0 && supported && previousBottom <= groundY() + 8 && currentBottom >= groundY()) {
      playerY.value = groundY() - size.height
      playerVelocity = 0
      const wasAirborne = !onGround.value
      onGround.value = true
      jumpsUsed.value = 0
      if (wasAirborne) addEffect('dust', 0, playerX(), groundY() - 8)
    }
  }

  if (playerY.value < 7) {
    playerY.value = 7
    playerVelocity = Math.max(90, playerVelocity)
  }

  ensureWorld()
  updateScore()

  if (hitObstacle() || playerY.value > stageSize().height + 35) {
    endGame()
    return
  }

  cleanWorld()
  animationFrame = requestAnimationFrame(gameLoop)
}

function handleAction(event) {
  if (event?.target?.closest?.('button')) return
  jump()
}

function handleKeydown(event) {
  if (!['Space', 'ArrowUp', 'Enter'].includes(event.code)) return
  event.preventDefault()
  jump()
}

function handleResize() {
  if (status.value !== 'playing') {
    nextTick(resetGame)
    return
  }
  if (onGround.value) playerY.value = groundY() - playerSize().height
  ensureWorld()
}

function goBack() {
  cancelAnimationFrame(animationFrame)
  clearEffectTimers()
  stopVoice()
  emit('back')
}

function platformStyle(platform) {
  return {
    left: `${platform.start - distance.value}px`,
    top: `${groundY()}px`,
    width: `${platform.end - platform.start}px`,
  }
}

function hazardStyle(hazard) {
  const rect = hazardRect(hazard)
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  }
}

function hazardImage(hazard) {
  return moonObstacle
}

onMounted(() => {
  loadAlphaMask(moonObstacle).then((mask) => { moonObstacleMask.value = mask }).catch((error) => console.warn(error))
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', handleResize)
  nextTick(resetGame)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame)
  clearEffectTimers()
  stopVoice()
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', handleResize)
})
</script>

<template>
  <section class="runner-page">
    <header class="runner-header">
      <button class="runner-back" type="button" @click="goBack"><span>←</span> 返回游廊</button>
      <div class="runner-title"><span></span><strong>哥伦比娅 · 无尽巡游</strong></div>
      <div class="runner-best">BEST <strong>{{ String(bestScore).padStart(2, '0') }}</strong></div>
    </header>

    <div class="runner-layout">
      <div
        ref="stage"
        class="runner-stage"
        :class="{ 'is-running': status === 'playing', 'is-hit': isHit }"
        role="application"
        aria-label="哥伦比娅无尽巡游游戏区域"
        @pointerdown="handleAction"
      >
        <Transition name="background-fade" mode="out-in"><div :key="currentStageBackground" class="runner-background" :style="{ backgroundImage: `linear-gradient(180deg, rgba(7, 15, 53, .30), rgba(10, 17, 62, .58)), url('${currentStageBackground}')` }"></div></Transition>

        <div class="runner-hud">
          <div class="runner-score"><small>DREAM {{ Math.floor(score / 10) + 1 }} · SCORE</small><strong>{{ String(score).padStart(2, '0') }}</strong></div>
          <div class="jump-meter" aria-label="本次腾空已使用跳跃次数">
            <small>JUMP</small>
            <span v-for="number in 3" :key="number" :class="{ used: number <= jumpsUsed }"></span>
          </div>
        </div>

        <div
          v-for="platform in platforms"
          :key="platform.id"
          class="runner-platform"
          :style="platformStyle(platform)"
        ></div>

        <div
          v-for="hazard in hazards"
          :key="hazard.id"
          class="runner-hazard"
          :class="[`hazard-${hazard.type}`, `hazard-${hazard.kind}`]"
          :style="hazardStyle(hazard)"
        >
          <img :src="hazardImage(hazard)" alt="" draggable="false" />
        </div>

        <div
          v-for="effect in effects"
          :key="effect.id"
          class="runner-effect"
          :class="[`effect-${effect.type}`, `effect-level-${effect.level}`]"
          :style="{ left: `${effect.x}px`, top: `${effect.y}px` }"
        >
          <template v-if="effect.type === 'score'">+1</template>
          <template v-else-if="effect.type === 'hit'">✦</template>
          <template v-else>···</template>
        </div>

        <div
          ref="playerElement"
          class="runner-player"
          :class="{ airborne: !onGround, 'jump-two': jumpsUsed === 2, 'jump-three': jumpsUsed === 3, vanished: isHit }"
          :style="{ left: `${playerX()}px`, top: `${playerY}px` }"
        >
          <img
            v-if="onGround && !videoFailed"
            :src="characterRun"
            alt="奔跑中的哥伦比娅"
            draggable="false"
            @error="videoFailed = true"
          />
          <img
            v-else-if="onGround && !idleImageFailed"
            :src="characterIdle"
            alt="哥伦比娅"
            draggable="false"
            @error="idleImageFailed = true"
          />
          <img
            v-else-if="!onGround && !jumpImageFailed"
            :src="characterJump"
            alt="跳跃中的哥伦比娅"
            draggable="false"
            @error="jumpImageFailed = true"
          />
          <span v-else class="runner-fallback" aria-label="哥伦比娅素材加载失败">歌</span>
        </div>

        <div v-if="status === 'ready'" class="runner-overlay">
          <div class="runner-dialog">
            <p>DREAM 02 · RUN</p>
            <h2>无尽巡游</h2>
            <span>连续点击可使出一段、二段和三段跳。</span>
            <button type="button" @pointerdown.stop @click="startGame">进入梦境</button>
          </div>
        </div>

        <div v-if="status === 'over'" class="runner-overlay game-over">
          <div class="runner-dialog">
            <p>RUN COMPLETE</p>
            <h2>巡游结束</h2>
            <div class="runner-result">
              <span>本局<strong>{{ score }}</strong></span>
              <span>最佳<strong>{{ bestScore }}</strong></span>
            </div>
            <button type="button" @pointerdown.stop @click="startGame">重新开始</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.runner-page {
  width: 100%;
  height: 100vh;
  height: 100svh;
  height: 100dvh;
  overflow: hidden;
  background: #eee9df;
  display: flex;
  flex-direction: column;
}

.runner-header {
  min-height: 68px;
  padding: 0 clamp(18px, 4vw, 72px);
  border-bottom: 2px solid #171717;
  background: #f7f4ed;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
}

.runner-back {
  width: fit-content;
  border: 0;
  padding: 10px 0;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
}

.runner-back span {
  margin-right: 8px;
  font-size: 18px;
}

.runner-title {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 14px;
}

.runner-title span {
  width: 9px;
  height: 9px;
  border: 1px solid #171717;
  border-radius: 50%;
  background: #f4b7d2;
}

.runner-best {
  justify-self: end;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
}

.runner-best strong {
  margin-left: 8px;
  font-size: 17px;
}

.runner-layout {
  min-height: 0;
  width: 100%;
  padding: clamp(12px, 2.5vw, 34px);
  flex: 1;
}

.runner-stage {
  position: relative;
  width: min(1480px, 100%);
  height: 100%;
  min-height: 450px;
  margin: 0 auto;
  overflow: hidden;
  border: 2px solid #171717;
  background: #000;
  box-shadow: 8px 8px 0 #171717;
  cursor: pointer;
  isolation: isolate;
  touch-action: none;
  user-select: none;
}

.runner-stage::before {
  content: '';
  position: absolute;
  z-index: 1;
  inset: 0;
  background: linear-gradient(rgba(23, 23, 23, 0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(23, 23, 23, 0.045) 1px, transparent 1px);
  background-size: 32px 32px;
}

.runner-background {
  position: absolute;
  z-index: 0;
  inset: 0;
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  opacity: 1;
  pointer-events: none;
}

.runner-stage.is-hit {
  animation: stage-shake 360ms ease;
}

.runner-stage.is-hit::after {
  content: '';
  position: absolute;
  z-index: 20;
  inset: 0;
  pointer-events: none;
  background: #f4b7d2;
  animation: hit-flash 420ms ease forwards;
}

.runner-sky {
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 23%;
  left: 0;
  width: calc(100% + 560px);
  pointer-events: none;
  will-change: transform;
}

.runner-sky.far {
  opacity: 0.16;
  background: radial-gradient(ellipse at center, #f7f4ed 0 42%, transparent 44%) 0 52% / 210px 48px repeat-x;
}

.runner-sky.near {
  opacity: 0.12;
  background: radial-gradient(ellipse at center, #f7f4ed 0 43%, transparent 45%) 80px 74% / 260px 64px repeat-x;
}

.runner-moon {
  position: absolute;
  z-index: 1;
  top: 11%;
  right: 10%;
  width: clamp(58px, 7vw, 88px);
  aspect-ratio: 1;
  border: 2px solid #171717;
  border-radius: 50%;
  background: #d8ff62;
}

.runner-hud {
  position: absolute;
  z-index: 10;
  top: 20px;
  right: 24px;
  left: 24px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: start;
  pointer-events: none;
}

.runner-score {
  display: flex;
  flex-direction: column;
}

.runner-score small,
.jump-meter small {
  color: #fff;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 9px;
  letter-spacing: 0.09em;
}

.runner-score strong {
  color: #050505;
  font-size: 38px;
  line-height: 1;
  letter-spacing: -0.06em;
  -webkit-text-stroke: 2px #fff;
  paint-order: stroke fill;
  text-shadow: 0 0 2px #fff;
}

.jump-meter {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 5px;
}

.jump-meter small {
  margin-right: 3px;
}

.jump-meter span {
  width: 13px;
  height: 13px;
  border: 1px solid #fff;
  border-radius: 50%;
  background: #f7f4ed;
}

.jump-meter span.used {
  background: #fff;
}

.runner-platform {
  position: absolute;
  z-index: 2;
  bottom: 0;
  border-top: 5px solid #000;
  background: repeating-linear-gradient(135deg, rgba(23, 23, 23, 0.1) 0 1px, transparent 1px 14px), #eee9df;
  will-change: left;
}

.runner-platform::before {
  content: '';
  position: absolute;
  top: 9px;
  right: 0;
  left: 0;
  height: 2px;
  background: repeating-linear-gradient(90deg, #171717 0 8px, transparent 8px 18px);
  opacity: 0.36;
}

.runner-hazard {
  position: absolute;
  z-index: 4;
  border: 0;
  background: transparent;
  box-shadow: none;
  will-change: left;
}

.runner-hazard > img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center bottom;
  pointer-events: none;
  user-select: none;
}

.hazard-ceiling {
  border-top: 0;
  background: transparent;
  overflow: hidden;
}

.hazard-ceiling > img {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: auto;
  max-width: none;
  object-fit: contain;
  object-position: center bottom;
}

.runner-player {
  position: absolute;
  z-index: 7;
  width: clamp(58px, 6vw, 82px);
  transform: translateX(-50%);
  transform-origin: 50% 80%;
  will-change: top, transform;
}

.runner-player.airborne {
  transform: translateX(-50%) rotate(-5deg) scale(1.04);
}

.runner-player.jump-two {
  transform: translateX(-50%) rotate(-9deg) scale(1.08);
}

.runner-player.jump-three {
  transform: translateX(-50%) rotate(-13deg) scale(1.12);
}

.runner-player.vanished {
  animation: player-hit 360ms ease forwards;
}

.runner-player img,
.runner-player video {
  display: block;
  width: 100%;
  height: auto;
  transform: scaleX(-1);
  pointer-events: none;
  filter: drop-shadow(4px 5px 0 rgba(23, 23, 23, 0.2));
}

.runner-player video {
  object-fit: contain;
}

.runner-fallback {
  display: grid;
  width: 64px;
  height: 64px;
  border: 2px solid #171717;
  border-radius: 50%;
  place-items: center;
  background: #f4b7d2;
  font-weight: 900;
}

.runner-effect {
  position: absolute;
  z-index: 6;
  pointer-events: none;
  font-family: ui-monospace, monospace;
  font-weight: 900;
}

.effect-jump {
  color: #171717;
  animation: dust-out 480ms ease forwards;
}

.effect-trail {
  color: #f4b7d2;
  font-size: 20px;
  text-shadow: 10px 8px 0 #d8ff62;
  animation: trail-out 480ms ease forwards;
}

.effect-level-3 {
  color: #346aff;
  text-shadow: 9px 7px 0 #f4b7d2, 18px 12px 0 #d8ff62;
}

.effect-dust {
  letter-spacing: 5px;
  animation: dust-out 480ms ease forwards;
}

.effect-score {
  color: #171717;
  font-size: 22px;
  animation: score-up 700ms ease forwards;
}

.effect-hit {
  color: #f4b7d2;
  font-size: 44px;
  animation: hit-pop 480ms ease forwards;
}

.runner-overlay {
  position: absolute;
  z-index: 15;
  inset: 0;
  padding: 20px;
  background: rgba(184, 220, 244, 0.48);
  display: grid;
  place-items: center;
  backdrop-filter: blur(3px);
}

.runner-overlay.game-over {
  background: rgba(244, 183, 210, 0.58);
}

.runner-dialog {
  width: min(430px, 100%);
  border: 2px solid #171717;
  padding: clamp(25px, 4vw, 43px);
  background: #f7f4ed;
  text-align: center;
  box-shadow: 8px 8px 0 #171717;
}

.runner-dialog > p {
  margin: 0 0 10px;
  font-family: ui-monospace, monospace;
  font-size: 9px;
  letter-spacing: 0.1em;
}

.runner-dialog h2 {
  margin: 0 0 13px;
  font-size: clamp(33px, 5vw, 48px);
  letter-spacing: -0.07em;
}

.runner-dialog > span {
  display: block;
  margin-bottom: 23px;
  color: #5b5953;
  font-size: 13px;
}

.runner-dialog button {
  min-width: 145px;
  border: 2px solid #171717;
  padding: 13px 20px;
  background: #d8ff62;
  box-shadow: 3px 3px 0 #171717;
  cursor: pointer;
  font-weight: 800;
}

.runner-result {
  margin: 22px 0;
  border-top: 1px solid #171717;
  border-bottom: 1px solid #171717;
  padding: 14px 0;
  display: flex;
  justify-content: space-around;
}

.runner-result span {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
}

.runner-result strong {
  font-size: 25px;
}

@keyframes stage-shake {
  20%, 60% { transform: translateX(-7px); }
  40%, 80% { transform: translateX(7px); }
}

@keyframes hit-flash {
  0% { opacity: 0.7; }
  100% { opacity: 0; }
}

@keyframes player-hit {
  to { opacity: 0; transform: translateX(-50%) rotate(24deg) scale(0.35); }
}

@keyframes dust-out {
  to { opacity: 0; transform: translate(-22px, 12px) scale(1.7); }
}

@keyframes trail-out {
  to { opacity: 0; transform: translate(-45px, 18px) scale(0.5); }
}

@keyframes score-up {
  to { opacity: 0; transform: translateY(-42px) scale(1.2); }
}

@keyframes hit-pop {
  to { opacity: 0; transform: scale(2.2) rotate(35deg); }
}

@media (max-width: 700px) {
  .runner-header {
    min-height: 58px;
    padding: 0 14px;
    grid-template-columns: 1fr auto;
  }

  .runner-title {
    display: none;
  }

  .runner-layout {
    height: calc(100dvh - 58px);
    padding: 8px;
  }

  .runner-stage {
    width: 100%;
    min-height: 0;
    height: 100%;
    box-shadow: 4px 4px 0 #171717;
  }

  .runner-hud {
    top: 14px;
    right: 14px;
    left: 14px;
  }

  .runner-score strong {
    font-size: 31px;
  }

  .runner-player {
    width: clamp(54px, 16vw, 72px);
  }

  .runner-dialog {
    padding: 27px 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .runner-stage,
  .runner-stage::after,
  .runner-player,
  .runner-effect {
    animation-duration: 0.01ms !important;
  }
}

/* Birthday event visual system */
.runner-page{background:radial-gradient(circle at 50% 0,#203f8c,#07112e 68%);color:#f8f8ff}
.runner-header{min-height:66px;border-bottom:1px solid rgba(255,255,255,.18);background:rgba(5,12,40,.74);backdrop-filter:blur(20px)}
.runner-back{color:rgba(255,255,255,.76);font-weight:500}.runner-back span{color:#bcecff}.runner-title{font-family:'Noto Serif SC','Songti SC',serif;letter-spacing:.08em}.runner-title span{border:0;background:#a9efff;box-shadow:0 0 12px #8cdeff}.runner-best{color:rgba(255,255,255,.52)}.runner-best strong{color:#fff}
.runner-stage{border:1px solid rgba(216,239,255,.4);border-radius:3px;background:#0b1741;box-shadow:0 24px 80px rgba(0,0,30,.42),inset 0 0 80px rgba(6,14,48,.18)}.runner-stage::before{z-index:2;background:linear-gradient(90deg,rgba(7,13,43,.18),transparent 35% 70%,rgba(7,13,43,.12));background-size:auto}.runner-background{background-position:center;background-size:cover;transition:background-image .55s ease}
.runner-sky,.runner-moon{display:none}.runner-hud{z-index:10}.runner-score small,.jump-meter small{color:rgba(255,255,255,.72);letter-spacing:.16em}.runner-score strong{color:#fff;font-weight:500;-webkit-text-stroke:0;text-shadow:0 2px 12px rgba(0,0,30,.55)}.jump-meter span{border:1px solid rgba(255,255,255,.78);background:rgba(10,21,63,.35);backdrop-filter:blur(5px)}.jump-meter span.used{background:#bcecff;box-shadow:0 0 10px rgba(142,222,255,.8)}
.runner-platform{z-index:3;border-top:1px solid rgba(221,244,255,.9);background:radial-gradient(ellipse at 14% 35%,rgba(179,224,255,.18) 0 5%,transparent 6%),radial-gradient(ellipse at 67% 58%,rgba(116,172,236,.15) 0 7%,transparent 8%),linear-gradient(180deg,rgba(186,231,255,.88) 0,rgba(78,130,199,.82) 11px,rgba(28,54,119,.72) 12px,rgba(7,18,55,.76) 100%);box-shadow:0 -5px 16px rgba(118,206,255,.34),inset 0 12px 18px rgba(210,241,255,.16);backdrop-filter:blur(2px)}.runner-platform::before{top:16px;height:28px;background:radial-gradient(ellipse at 20px 0,rgba(167,215,255,.2) 0 15px,transparent 16px) 0 0/78px 35px repeat-x;opacity:1}.runner-platform::after{content:'';position:absolute;top:-7px;left:0;right:0;height:10px;background:radial-gradient(ellipse at center,rgba(226,248,255,.9) 0 23%,rgba(128,202,245,.6) 28%,transparent 66%) 0 0/54px 10px repeat-x;filter:drop-shadow(0 0 5px #9ce6ff)}
.runner-hazard{z-index:5;filter:drop-shadow(0 0 9px rgba(142,218,255,.55))}.runner-hazard>img{object-fit:fill;object-position:center}.hazard-ceiling>img{transform:rotate(180deg)}
.runner-player img,.runner-player video{filter:drop-shadow(0 8px 8px rgba(0,5,30,.45))}.effect-jump,.effect-score{color:#fff;text-shadow:0 0 8px #7ed8ff}.effect-trail{color:#caeaff;text-shadow:10px 8px 0 rgba(177,142,255,.65)}.effect-level-3{color:#fff;text-shadow:9px 7px 0 #b99aff,18px 12px 0 #8adaff}
.runner-overlay{background:rgba(5,12,43,.38);backdrop-filter:blur(6px)}.runner-overlay.game-over{background:rgba(14,9,50,.48)}.runner-dialog{width:min(430px,94%);border:1px solid rgba(224,241,255,.52);background:linear-gradient(145deg,rgba(32,48,105,.84),rgba(8,16,52,.9));box-shadow:0 20px 70px rgba(0,0,30,.38);color:#fff}.runner-dialog>p{color:#9ce5ff;letter-spacing:.18em}.runner-dialog h2{font-family:'Noto Serif SC','Songti SC',serif;font-weight:600;letter-spacing:.1em}.runner-dialog>span{color:rgba(239,244,255,.68)}.runner-dialog button{min-width:150px;border:1px solid rgba(255,255,255,.7);border-radius:999px;background:rgba(125,197,255,.18);box-shadow:none;font-family:'Noto Serif SC','Songti SC',serif;letter-spacing:.08em}.runner-dialog button:hover{color:#101b47;background:#fff}.runner-result{border-color:rgba(255,255,255,.28)}
.background-fade-enter-active,.background-fade-leave-active{transition:opacity .7s ease}.background-fade-enter-from,.background-fade-leave-to{opacity:0}

/* Do not cap the playfield on ultrawide or fullscreen displays. */
.runner-stage{width:100%;margin:0}
.runner-background{background-repeat:no-repeat;background-size:cover;background-position:center}
</style>

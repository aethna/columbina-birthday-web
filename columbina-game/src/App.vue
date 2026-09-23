<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import characterIdle from '../p/columbina-idle.png'
import characterJump from '../p/columbina-jump.png'
import flightIdle from '../p/columbina-flight-tap.png'
import flightJump from '../p/columbina-flight-default.png'
import boardPieceHuman from '../p/board-piece-player-purple.png'
import boardPieceAi from '../p/board-piece-columbina-pink.png'
import eventHero from '../p/event/hero.jpg'
import eventLogoZh from '../p/event/logo-cn.png'
import heroMotion from '../p/event/hero-motion.mp4'
import moonObstacle from '../p/event/moon-obstacle.webp'
import boardBackground from '../p/event/board-background.webp'
import brandIcon from '../p/event/brand-icon.png'
import lobbyMusic from '../p/audio/lobby.opus'
import stageMusicOne from '../p/audio/stage-01.opus'
import stageMusicTwo from '../p/audio/stage-02.opus'
import stageMusicThree from '../p/audio/stage-03.opus'
import stageMusicFour from '../p/audio/stage-04.opus'
import ticTacToeBoard from '../p/event/tictactoe-board.webp'
import gomokuBoard from '../p/event/gomoku-board.webp'
import stageOne from '../p/stages/01.jpg'
import stageTwo from '../p/stages/02.jpg'
import stageThree from '../p/stages/03.jpg'
import stageFour from '../p/stages/04.jpg'
import characterRun from '../p/columbina-run-transparent.webp'
import ticTacToeWorkerUrl from './games/ticTacToe.worker.js?worker&url'
import gomokuWorkerUrl from './games/gomoku.worker.js?worker&url'
import { playSfx } from './games/sound.js'
import { resumeBgm, setBgm, stopBgm, suspendBgm } from './games/bgm.js'
import { playVoice, stopVoice, VOICE_EVENTS } from './games/voice.js'
import {
  cancelAllResourceLoads,
  demoteAssetGroup,
  loadAssetGroup,
  promoteAssetGroup,
  setBackgroundDownloadsPaused,
} from './games/resourceLoader.js'
import { DICE_ASSETS, DICE_COVER } from './games/teyvatDice.js'
import { isEnglish } from './i18n.js'

// These views are never part of the first lobby paint. Code-splitting also prevents
// their worker/game setup from being evaluated until the selected game is mounted.
const RunnerGame = defineAsyncComponent(() => import('./components/RunnerGame.vue'))
const BoardGame = defineAsyncComponent(() => import('./components/BoardGame.vue'))
const TeyvatDiceGame = defineAsyncComponent(() => import('./components/TeyvatDiceGame.vue'))

const eventLogo = isEnglish ? './english-logo.png' : eventLogoZh

const screen = ref('lobby')
const assetLoading = ref({
  active: false,
  title: '',
  loaded: 0,
  total: 0,
  state: 'queued',
  bytesReceived: 0,
  totalBytes: null,
  error: '',
  longWait: false,
})
const heroVideoEnabled = ref(false)
const soundEnabled = ref(false)
const gameStatus = ref('ready')
const gameStage = ref(null)
const playerElement = ref(null)
const playerY = ref(220)
const isJumping = ref(false)
const obstacles = ref([])
const score = ref(0)
const bestScore = ref(Number(localStorage.getItem('columbina-best') || 0))
const boardKind = ref('tictactoe')
/* 五子棋「重新开始」靠重挂组件来彻底重置（见 reloadBoard）；这个计数就是新 key 的一部分 */
const boardSessionKey = ref(0)
const emptyStats = () => ({ tictactoe: { wins: 0, losses: 0, draws: 0 }, gomoku: { wins: 0, losses: 0, draws: 0 } })
let savedStats
try { savedStats = JSON.parse(localStorage.getItem('columbina-board-stats') || 'null') } catch { savedStats = null }
const boardStats = ref(savedStats || emptyStats())
const stageBackgrounds = [stageOne, stageTwo, stageThree, stageFour]
const stageMusic = [stageMusicOne, stageMusicTwo, stageMusicThree, stageMusicFour]
const loadedAssetGroups = new Set()
// Automatic prefetch is opt-in because it competes with visible lobby cards on a
// constrained connection. When enabled, only core groups run and only one at a time.
const BACKGROUND_PREFETCH_ENABLED = import.meta.env.VITE_GAME_BACKGROUND_PREFETCH === 'true'
const assetGroups = {
  flightCore: [flightIdle, flightJump, moonObstacle, stageOne, stageMusicOne],
  runnerCore: [characterIdle, characterJump, characterRun, moonObstacle, stageOne, stageMusicOne],
  tictactoeCore: [boardPieceHuman, boardPieceAi, ticTacToeBoard, boardBackground, brandIcon, stageMusicThree, ticTacToeWorkerUrl],
  gomokuCore: [boardPieceHuman, boardPieceAi, gomokuBoard, boardBackground, brandIcon, stageMusicThree, gomokuWorkerUrl],
  stageTwo: [stageTwo, stageMusicTwo],
  stageThree: [stageThree, stageMusicThree],
  stageFour: [stageFour, stageMusicFour],
  diceCore: DICE_ASSETS,
}
const backgroundPreloadOrder = ['flightCore', 'runnerCore', 'tictactoeCore', 'gomokuCore']
const currentStageBackground = computed(() => stageBackgrounds[Math.floor(score.value / 10) % stageBackgrounds.length])
function applyBgm() {
  if (!soundEnabled.value) return
  const index = Math.floor(score.value / 10)
  if (screen.value === 'lobby') setBgm(lobbyMusic)
  else if (screen.value === 'game') setBgm(stageMusic[index % 4])
  else if (screen.value === 'board') setBgm(stageMusicThree)
  else if (screen.value === 'dice') setBgm(stageMusicThree)
}
watch([screen, () => Math.floor(score.value / 10)], applyBgm, { immediate: true })
function preloadStage(index) { const image = new Image(); image.src = stageBackgrounds[index % stageBackgrounds.length] }
watch(score, (value) => { if (value > 0 && value % 10 === 9) preloadStage(Math.floor(value / 10) + 1) })
let velocity = 0
let animationFrame = 0
let lastFrame = 0
let spawnTimer = 0
let obstacleId = 0
let poseTimer = 0
const assetGroupTasks = new Map()
const assetGroupProgress = new Map()
let launchToken = 0
let foregroundGroup = ''
let pendingLaunch = null
let activeLaunch = null
let longWaitTimer = 0
let backgroundIdleHandle = 0
let deferredMediaHandle = 0
let backgroundPreloadCursor = 0

const playerImage = computed(() => (isJumping.value ? flightJump : flightIdle))
const loadingPercent = computed(() => {
  if (!assetLoading.value.total) return 0
  return Math.round(assetLoading.value.loaded / assetLoading.value.total * 100)
})
const loadingStatusText = computed(() => ({
  queued: '排队中',
  requesting: '请求中',
  downloading: '下载中',
  decoding: '解码中',
  complete: '资源已准备',
  failed: '下载失败',
  cancelled: '已取消',
}[assetLoading.value.state] || '准备中'))

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function cancelIdle(handle) {
  if (!handle) return
  if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle)
  else window.clearTimeout(handle)
}

function scheduleIdle(callback, timeout = 3000) {
  if (typeof window.requestIdleCallback === 'function') return window.requestIdleCallback(callback, { timeout })
  return window.setTimeout(callback, timeout)
}

function startAssetGroup(group, { priority = 'foreground', background = false } = {}) {
  if (loadedAssetGroups.has(group)) return Promise.resolve()
  if (assetGroupTasks.has(group)) {
    const existing = assetGroupTasks.get(group)
    if (priority === 'foreground') {
      existing.priority = 'foreground'
      promoteAssetGroup(group)
    }
    return existing.promise
  }

  const controller = new AbortController()
  const progress = {
    loaded: 0,
    total: assetGroups[group].length,
    state: 'queued',
    bytesReceived: 0,
    totalBytes: null,
  }
  assetGroupProgress.set(group, progress)
  const task = {
    controller,
    priority,
    background,
    foregroundTokens: new Set(),
    promise: null,
  }
  task.promise = loadAssetGroup(assetGroups[group], {
      signal: controller.signal,
      concurrency: 1,
      group,
      priority: () => task.priority,
      onProgress(event) {
        progress.loaded = event.completed
        progress.total = event.total
        progress.state = event.state
        progress.bytesReceived = event.bytesReceived
        progress.totalBytes = event.totalBytes
        if (foregroundGroup === group) {
          assetLoading.value = {
            ...assetLoading.value,
            loaded: event.completed,
            total: event.total,
            state: event.state,
            bytesReceived: event.bytesReceived || 0,
            totalBytes: event.totalBytes ?? null,
          }
        }
      },
    }).then(() => {
      loadedAssetGroups.add(group)
    }).finally(() => {
      if (assetGroupTasks.get(group) === task) assetGroupTasks.delete(group)
    })
  assetGroupTasks.set(group, task)
  return task.promise
}

function scheduleBackgroundPreload() {
  if (!BACKGROUND_PREFETCH_ENABLED || document.hidden || foregroundGroup || backgroundIdleHandle) return
  if ([...assetGroupTasks.values()].some((task) => task.background && task.priority === 'background')) return
  setBackgroundDownloadsPaused(false)
  backgroundIdleHandle = scheduleIdle(() => {
    backgroundIdleHandle = 0
    if (document.hidden || foregroundGroup) return
    const group = backgroundPreloadOrder.find((name, index) => index >= backgroundPreloadCursor && !loadedAssetGroups.has(name) && !assetGroupTasks.has(name))
    if (!group) return
    backgroundPreloadCursor = backgroundPreloadOrder.indexOf(group) + 1
    startAssetGroup(group, { priority: 'background', background: true })
      .catch((error) => {
        // Speculative work never creates a foreground error. It may be retried from
        // the next idle period or superseded by a foreground request.
        if (import.meta.env.DEV && error?.reason !== 'preempted-by-foreground') console.warn(`[AssetPreload:${group}]`, error)
      })
      .finally(scheduleBackgroundPreload)
  })
}

function suspendBackgroundPreload() {
  cancelIdle(backgroundIdleHandle)
  backgroundIdleHandle = 0
  setBackgroundDownloadsPaused(true)
}

function releaseLaunch(launch, reason = 'cancelled') {
  const task = assetGroupTasks.get(launch.group)
  if (!task) return
  task.foregroundTokens.delete(launch.token)
  if (task.foregroundTokens.size) return
  if (task.background) {
    task.priority = 'background'
    demoteAssetGroup(launch.group)
    scheduleBackgroundPreload()
  } else {
    task.controller.abort(reason)
  }
}

function clearLongWaitTimer() {
  window.clearTimeout(longWaitTimer)
  longWaitTimer = 0
}

function armLongWaitTimer(token) {
  clearLongWaitTimer()
  longWaitTimer = window.setTimeout(() => {
    if (activeLaunch?.token === token) assetLoading.value = { ...assetLoading.value, longWait: true }
  }, 30_000)
}

function resetAssetLoading() {
  clearLongWaitTimer()
  assetLoading.value = {
    active: false,
    title: '',
    loaded: 0,
    total: 0,
    state: 'queued',
    bytesReceived: 0,
    totalBytes: null,
    error: '',
    longWait: false,
  }
}

async function prepareAssetGroup(group, title, onReady) {
  if (loadedAssetGroups.has(group)) {
    onReady()
    return
  }

  if (activeLaunch?.group === group) return
  if (activeLaunch) releaseLaunch(activeLaunch, 'superseded')
  const token = ++launchToken
  startAssetGroup(group, { priority: 'foreground' })
  const task = assetGroupTasks.get(group)
  task.foregroundTokens.add(token)
  pendingLaunch = { group, title, onReady }
  activeLaunch = { token, group }
  foregroundGroup = group
  const progress = assetGroupProgress.get(group) || { loaded: 0, total: assetGroups[group].length }
  suspendBackgroundPreload()
  assetLoading.value = {
    active: true,
    title,
    loaded: progress.loaded,
    total: progress.total,
    state: progress.state || 'queued',
    bytesReceived: progress.bytesReceived || 0,
    totalBytes: progress.totalBytes ?? null,
    error: '',
    longWait: false,
  }
  armLongWaitTimer(token)

  try {
    await task.promise
    if (token !== launchToken) return
    foregroundGroup = ''
    pendingLaunch = null
    activeLaunch = null
    resetAssetLoading()
    scheduleBackgroundPreload()
    onReady()
  } catch (error) {
    if (token !== launchToken) return
    clearLongWaitTimer()
    activeLaunch = null
    foregroundGroup = ''
    assetLoading.value = {
      ...assetLoading.value,
      active: true,
      error: error?.reason === 'body-idle-timeout'
        ? '资源下载长时间没有进展，请重试。'
        : error?.reason === 'response-header-timeout'
          ? '请求长时间未获得响应，请重试。'
          : error?.reason === 'absolute-timeout'
            ? '单个资源下载超过上限，请重试。'
            : '部分资源下载失败，请重试。',
    }
    if (import.meta.env.DEV) console.error(`[AssetLoader:${group}]`, error)
  }
}

function cancelAssetLoading() {
  launchToken += 1
  stopVoice()
  if (activeLaunch) releaseLaunch(activeLaunch)
  activeLaunch = null
  foregroundGroup = ''
  pendingLaunch = null
  resetAssetLoading()
  scheduleBackgroundPreload()
}

function retryAssetLoading() {
  if (!pendingLaunch) return
  const { group, title, onReady } = pendingLaunch
  prepareAssetGroup(group, title, onReady)
}

function restartAssetLoading() {
  if (!pendingLaunch) return
  const { group, title, onReady } = pendingLaunch
  cancelAssetLoading()
  prepareAssetGroup(group, title, onReady)
}

function stageSize() {
  return {
    width: gameStage.value?.clientWidth || 960,
    height: gameStage.value?.clientHeight || 600,
  }
}

function resetGame() {
  cancelAnimationFrame(animationFrame)
  const { height } = stageSize()
  gameStatus.value = 'ready'
  playerY.value = Math.max(90, height * 0.41)
  velocity = 0
  obstacles.value = []
  score.value = 0
  spawnTimer = 0
  lastFrame = 0
  isJumping.value = false
}

function openGame() {
  playSfx('ui')
  prepareAssetGroup('flightCore', '云隙轻歌', () => {
    screen.value = 'game'
    nextTick(() => { window.scrollTo(0, 0); resetGame() })
  })
}

function openRunner() {
  playSfx('ui')
  prepareAssetGroup('runnerCore', '无尽巡游', () => {
    cancelAnimationFrame(animationFrame)
    screen.value = 'runner'
    nextTick(() => window.scrollTo(0, 0))
  })
}

function openBoard(kind) {
  playSfx('ui')
  playVoice(VOICE_EVENTS.BOARD_ENTER)
  const title = kind === 'tictactoe' ? '月亮棋' : '星月五子棋'
  prepareAssetGroup(`${kind}Core`, title, () => {
    cancelAnimationFrame(animationFrame)
    boardKind.value = kind
    screen.value = 'board'
    nextTick(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  })
}

function closeBoard() {
  stopVoice()
  screen.value = 'lobby'
  nextTick(() => window.scrollTo({ top: 0, behavior: 'instant' }))
}

/* 提瓦特战力党：零依赖单文件游戏，用 iframe 承载（见 TeyvatDiceGame.vue）。
   和另外四个游戏一样先把资源预热完再切屏；预热用的 URL 带同一个 ?v= 后缀，
   所以 iframe 打开时直接命中缓存、基本瞬开。 */
function openDice() {
  playSfx('ui')
  stopVoice()
  cancelAnimationFrame(animationFrame)
  prepareAssetGroup('diceCore', '提瓦特战力党', () => {
    screen.value = 'dice'
    nextTick(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  })
}

function closeDice() {
  screen.value = 'lobby'
  nextTick(() => window.scrollTo({ top: 0, behavior: 'instant' }))
}

/* 五子棋重开会重挂棋盘组件（避免残局/语音状态残留） */
function reloadBoard() {
  boardSessionKey.value += 1
  nextTick(() => window.scrollTo({ top: 0, behavior: 'instant' }))
}

function saveBoardResult({ game, outcome }) {
  if (!boardStats.value[game]) boardStats.value[game] = { wins: 0, losses: 0, draws: 0 }
  boardStats.value[game][outcome] += 1
  localStorage.setItem('columbina-board-stats', JSON.stringify(boardStats.value))
}

function returnToLobby() {
  playSfx('ui')
  stopVoice()
  cancelAnimationFrame(animationFrame)
  clearTimeout(poseTimer)
  screen.value = 'lobby'
  nextTick(() => window.scrollTo(0, 0))
}

function startGame() {
  playSfx('start')
  playVoice(VOICE_EVENTS.RUNNER_START)
  resetGame()
  gameStatus.value = 'playing'
  addObstacle(true)
  velocity = -480
  showJumpPose()
  animationFrame = requestAnimationFrame(gameLoop)
}

function showJumpPose() {
  isJumping.value = true
  clearTimeout(poseTimer)
  poseTimer = setTimeout(() => {
    isJumping.value = false
  }, 190)
}

function flap() {
  if (gameStatus.value === 'over') return
  if (gameStatus.value === 'ready') {
    startGame()
    return
  }

  velocity = -480
  playSfx('jump')
  playVoice(VOICE_EVENTS.RUNNER_JUMP, { chance: 0.24, cooldown: 7000 })
  showJumpPose()
}

function handleStagePress(event) {
  if (event.target.closest('button')) return
  flap()
}

function addObstacle(isFirst = false) {
  const { width, height } = stageSize()
  const gapHeight = Math.min(246, Math.max(194, height * 0.37))
  const safeMargin = Math.min(118, Math.max(72, height * 0.15))
  const available = Math.max(1, height - gapHeight - safeMargin * 2)
  const gapTop = safeMargin + Math.random() * available

  obstacles.value.push({
    id: obstacleId++,
    x: isFirst ? width + 42 : width + 110,
    width: Math.min(142, Math.max(96, width * 0.105)),
    gapTop,
    gapHeight,
    passed: false,
  })
}

function collides(obstacle) {
  const { width, height } = stageSize()
  const playerX = width * 0.24
  const playerWidth = playerElement.value?.offsetWidth || Math.min(72, Math.max(48, width * 0.05))
  const playerHeight = playerElement.value?.offsetHeight || playerWidth
  const playerLeft = playerX - playerWidth * 0.34
  const playerRight = playerX + playerWidth * 0.34
  const playerTop = playerY.value + playerHeight * 0.14
  const playerBottom = playerY.value + playerHeight * 0.86
  const obstacleInset = obstacle.width * 0.08
  const obstacleLeft = obstacle.x + obstacleInset
  const obstacleRight = obstacle.x + obstacle.width - obstacleInset
  if (playerRight <= obstacleLeft || playerLeft >= obstacleRight) return false

  // Even if enlarged artwork is cropped or its root does not reach the edge,
  // the complete logical upper/lower column still causes a failure.
  return playerTop < obstacle.gapTop
    || playerBottom > obstacle.gapTop + obstacle.gapHeight
}

function endGame() {
  playSfx('hit')
  playVoice(VOICE_EVENTS.RUNNER_DEATH)
  gameStatus.value = 'over'
  isJumping.value = false
  cancelAnimationFrame(animationFrame)
  if (score.value > bestScore.value) {
    bestScore.value = score.value
    localStorage.setItem('columbina-best', String(score.value))
  }
}

function gameLoop(timestamp) {
  if (gameStatus.value !== 'playing') return
  if (!lastFrame) lastFrame = timestamp
  const delta = Math.min((timestamp - lastFrame) / 1000, 0.034)
  lastFrame = timestamp
  const { width, height } = stageSize()

  velocity += 1480 * delta
  playerY.value += velocity * delta
  spawnTimer += delta

  if (spawnTimer >= 2.08) {
    spawnTimer = 0
    addObstacle()
  }

  const baseSpeed = Math.max(168, width * 0.18)
  const speed = Math.min(baseSpeed * 1.72, baseSpeed + score.value * 7.5)
  obstacles.value.forEach((obstacle) => {
    obstacle.x -= speed * delta
    if (!obstacle.passed && obstacle.x + obstacle.width < width * 0.24) {
      obstacle.passed = true
      score.value += 1
      playSfx('score')
    }
  })
  obstacles.value = obstacles.value.filter((obstacle) => obstacle.x + obstacle.width > -8)

  const playerHeight = playerElement.value?.offsetHeight || 72
  const hitBoundary = playerY.value < -8 || playerY.value > height - playerHeight - 19
  if (hitBoundary || obstacles.value.some(collides)) {
    endGame()
    return
  }

  animationFrame = requestAnimationFrame(gameLoop)
}

function handleKeydown(event) {
  if (screen.value !== 'game' || !['Space', 'ArrowUp'].includes(event.code)) return
  event.preventDefault()
  flap()
}

function handleResize() {
  if (screen.value === 'game' && gameStatus.value !== 'playing') resetGame()
}

/* 离开页面立刻停声：手机浏览器会把页面放进 bfcache，
   Web Audio 的 AudioContext 不会自己停，返回主站后音乐还在响 */
function handleLeavePage() {
  suspendBackgroundPreload()
  stopBgm()
  suspendBgm()
}

/* 用前进/后退回到本页时，恢复声音 */
function handleReturnPage(event) {
  if (!event || !event.persisted) return
  resumeBgm()
  applyBgm()
}

/* 部分浏览器（Via 等）返回上一页时 pagehide 不及时，靠可见性变化兼容 */
function handleVisibility() {
  if (document.hidden) handleLeavePage()
  else {
    resumeBgm()
    applyBgm()
    scheduleBackgroundPreload()
    scheduleDeferredLobbyMedia()
  }
}

function enableSound() {
  soundEnabled.value = true
  applyBgm()
}

function scheduleDeferredLobbyMedia() {
  if (heroVideoEnabled.value || deferredMediaHandle || document.hidden) return
  deferredMediaHandle = scheduleIdle(() => {
    deferredMediaHandle = 0
    if (!document.hidden) heroVideoEnabled.value = true
  }, 3500)
}

onMounted(() => {
  scheduleBackgroundPreload()
  scheduleDeferredLobbyMedia()
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', handleResize)
  window.addEventListener('pagehide', handleLeavePage)
  window.addEventListener('beforeunload', handleLeavePage)
  window.addEventListener('unload', handleLeavePage)
  window.addEventListener('pageshow', handleReturnPage)
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('pointerdown', enableSound, { capture: true, once: true })
})

onBeforeUnmount(() => {
  launchToken += 1
  stopVoice()
  clearLongWaitTimer()
  cancelIdle(backgroundIdleHandle)
  cancelIdle(deferredMediaHandle)
  assetGroupTasks.forEach(({ controller }) => controller.abort('unmount'))
  cancelAllResourceLoads('unmount')
  cancelAnimationFrame(animationFrame)
  clearTimeout(poseTimer)
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('pagehide', handleLeavePage)
  window.removeEventListener('beforeunload', handleLeavePage)
  window.removeEventListener('unload', handleLeavePage)
  window.removeEventListener('pageshow', handleReturnPage)
  document.removeEventListener('visibilitychange', handleVisibility)
  window.removeEventListener('pointerdown', enableSound, { capture: true })
  stopBgm()
})
</script>

<template>
  <main class="app-shell" @copy.prevent @cut.prevent @contextmenu.prevent @dragstart.prevent>
    <Transition name="screen" mode="out-in">
      <section v-if="screen === 'lobby'" key="lobby" class="lobby-page">
        <header class="topbar">
          <div class="topbar-left">
            <a class="back-link" href="../index.html" aria-label="返回主站首页" @click="handleLeavePage">
              <span class="back-arrow" aria-hidden="true">←</span> 返回
            </a>
            <a class="brand" href="#" aria-label="新月再梦听羽生首页" @click.prevent>
              <img class="brand-crescent" :src="brandIcon" alt="" draggable="false" />
              <span>哥伦比娅生日会</span>
            </a>
          </div>
          <span class="edition">COLUMBINA BIRTHDAY · 2027</span>
        </header>

        <section class="hero" :style="{ '--hero-image': `url('${eventHero}')` }">
          <img class="hero-fallback" :src="eventHero" fetchpriority="high" alt="" aria-hidden="true" />
          <video
            v-if="heroVideoEnabled"
            class="hero-video"
            autoplay
            :muted="true"
            loop
            :poster="eventHero"
            playsinline
            webkit-playsinline
            x5-playsinline
            t7-video-player-type="inline"
            x5-video-player-type="h5-page"
            disablepictureinpicture
            disableremoteplayback
            controlslist="nodownload nofullscreen noremoteplayback"
            preload="none"
            aria-hidden="true"
          >
            <source :src="heroMotion" type="video/mp4" />
          </video>
          <div class="hero-glow"></div>
          <div class="hero-content">
            <p class="hero-kicker">「新月再梦听羽生」主题游戏</p>
            <img class="event-logo" :src="eventLogo" alt="新月再梦听羽生 · 哥伦比娅生日会" />
            <p class="hero-copy">循着月光进入她的梦境。五段旅程，五种相遇，<br />在羽声落下之前，与哥伦比娅共度这一夜。</p>
            <a class="hero-cta" href="#games"><span>进入梦境游廊</span><b>↓</b></a>
          </div>
          <div class="hero-scroll"><span></span>SCROLL TO DREAM</div>
        </section>

        <div id="games" class="lobby-content">
          <div class="section-heading">
            <div><p class="eyebrow">DREAM ARCADE · 05</p><h1>月下游廊</h1></div>
            <p class="intro">选择一段梦境，与她一同飞行、奔跑，或在月色中落下一枚棋子。</p>
          </div>

          <div class="game-grid" aria-label="小游戏列表">
            <article
              class="game-card featured"
              role="button"
              tabindex="0"
              @click="openGame"
              @keydown.enter="openGame"
              @keydown.space.prevent="openGame"
            >
              <div
                class="card-art game-cover"
                :style="{
                  backgroundImage: `url('${stageOne}')`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  backgroundRepeat: 'no-repeat',
                }"
              >
                <span class="cover-vignette"></span>
                <img class="cover-character flight-cover-character" :src="flightIdle" alt="飞行中的哥伦比娅" />
                <span class="play-orbit"><span>01</span><b>进入</b></span>
              </div>
              <div class="card-body">
                <div>
                  <p class="card-number">DREAM 01 · FLIGHT</p>
                  <h2>云隙轻歌</h2>
                  <p>陪哥伦比娅轻盈起飞，在云隙之间延续她的歌。</p>
                </div>
                <button class="enter-button" type="button" @click.stop="openGame">
                  开始游戏 <span>↗</span>
                </button>
              </div>
            </article>

            <article
              class="game-card featured runner-card"
              role="button"
              tabindex="0"
              @click="openRunner"
              @keydown.enter="openRunner"
              @keydown.space.prevent="openRunner"
            >
              <div
                class="card-art runner-card-art game-cover"
                :style="{
                  backgroundImage: `url('${stageThree}')`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  backgroundRepeat: 'no-repeat',
                }"
              >
                <span class="cover-vignette"></span>
                <img
                  class="cover-character runner-cover-character"
                  :src="characterIdle"
                  alt="奔跑中的哥伦比娅"
                  draggable="false"
                />
                <span class="play-orbit"><span>02</span><b>进入</b></span>
              </div>
              <div class="card-body">
                <div>
                  <p class="card-number">DREAM 02 · RUN</p>
                  <h2>无尽巡游</h2>
                  <p>踏过月岩与冰晶，在一段、二段、三段跳之间找到属于她的节奏。</p>
                </div>
                <button class="enter-button" type="button" @click.stop="openRunner">
                  开始游戏 <span>↗</span>
                </button>
              </div>
            </article>

            <article
              class="game-card featured board-card"
              role="button"
              tabindex="0"
              @click="openBoard('tictactoe')"
              @keydown.enter="openBoard('tictactoe')"
              @keydown.space.prevent="openBoard('tictactoe')"
            >
              <div class="card-art board-card-art game-cover" :style="{ backgroundImage: `linear-gradient(rgba(6, 13, 48, .22), rgba(6, 13, 48, .54)), url('${boardBackground}')` }">
                <span class="board-halo"></span>
                <img class="board-cover" :src="ticTacToeBoard" alt="月亮棋棋盘" />
                <span class="play-orbit"><span>03</span><b>进入</b></span>
              </div>
              <div class="card-body">
                <div><p class="card-number">DREAM 03 · PVE</p><h2>月亮棋</h2><p>棋盘只保留最近五枚棋子，每一步都可能改写局面。</p></div>
                <button class="enter-button" type="button" @click.stop="openBoard('tictactoe')">找哥伦比娅下棋 <span>↗</span></button>
              </div>
            </article>

            <article
              class="game-card featured board-card"
              role="button"
              tabindex="0"
              @click="openBoard('gomoku')"
              @keydown.enter="openBoard('gomoku')"
              @keydown.space.prevent="openBoard('gomoku')"
            >
              <div class="card-art board-card-art game-cover" :style="{ backgroundImage: `linear-gradient(rgba(6, 13, 48, .22), rgba(6, 13, 48, .54)), url('${boardBackground}')` }">
                <span class="board-halo"></span>
                <img class="board-cover" :src="gomokuBoard" alt="星月五子棋棋盘" />
                <span class="play-orbit"><span>04</span><b>进入</b></span>
              </div>
              <div class="card-body">
                <div><p class="card-number">DREAM 04 · PVE</p><h2>星月五子棋</h2><p>在十五路棋盘上连成五子，与哥伦比娅来一局。</p></div>
                <button class="enter-button" type="button" @click.stop="openBoard('gomoku')">找哥伦比娅下棋 <span>↗</span></button>
              </div>
            </article>

            <!-- DREAM 05：提瓦特战力党。卡面结构与上面四张完全一致，
                 只是横跨两列（grid-column:1/-1），否则第 3 行会空半格。 -->
            <article
              class="game-card featured dice-card"
              role="button"
              tabindex="0"
              @click="openDice"
              @keydown.enter="openDice"
              @keydown.space.prevent="openDice"
            >
              <div
                class="card-art game-cover"
                :style="{
                  backgroundImage: `url('${DICE_COVER}')`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center 42%',
                  backgroundRepeat: 'no-repeat',
                }"
              >
                <span class="cover-vignette"></span>
                <span class="play-orbit"><span>05</span><b>进入</b></span>
              </div>
              <div class="card-body">
                <div>
                  <p class="card-number">DREAM 05 · DICE</p>
                  <h2>提瓦特战力党</h2>
                  <p>十二位提瓦特角色，投骰、选骰、重投，在攻防之间决出胜负。</p>
                </div>
                <button class="enter-button" type="button" @click.stop="openDice">
                  开始游戏 <span>↗</span>
                </button>
              </div>
            </article>
          </div>

          <section class="lobby-stats" aria-label="我的棋类战绩">
            <strong>梦境记录</strong>
            <span>月亮棋　胜 {{ boardStats.tictactoe.wins }} · 负 {{ boardStats.tictactoe.losses }} · 和 {{ boardStats.tictactoe.draws }}</span>
            <span>星月五子棋　胜 {{ boardStats.gomoku.wins }} · 负 {{ boardStats.gomoku.losses }} · 和 {{ boardStats.gomoku.draws }}</span>
          </section>
        </div>

        <footer class="lobby-footer">
          <span>愿今夜的月光，停留得久一些。</span>
          <span>哥伦比娅生日会 · 新月再梦听羽生</span>
        </footer>
      </section>

      <section v-else-if="screen === 'game'" key="game" class="game-page">
        <header class="game-header">
          <button class="back-button" type="button" @click="returnToLobby"><span>←</span> 返回游廊</button>
          <div class="game-title">
            <span class="status-dot"></span>
            <strong>哥伦比娅 · 云隙轻歌</strong>
          </div>
          <div class="best-score">BEST <strong>{{ String(bestScore).padStart(2, '0') }}</strong></div>
        </header>

        <div class="game-layout">
          <div
            ref="gameStage"
            class="game-stage"
            :class="{ 'is-playing': gameStatus === 'playing', 'is-over': gameStatus === 'over' }"
            role="application"
            aria-label="哥伦比娅的云隙轻歌游戏区域"
            @pointerdown="handleStagePress"
          >
            <Transition name="background-fade" mode="out-in">
              <div :key="currentStageBackground" class="flight-background" :style="{ backgroundImage: `linear-gradient(rgba(6, 12, 42, .08), rgba(7, 12, 40, .25)), url('${currentStageBackground}')` }"></div>
            </Transition>
            <div class="score-display">
              <strong>{{ String(score).padStart(2, '0') }}</strong>
              <small>{{ Math.floor(score / 10) + 1 }} / 梦境</small>
            </div>

            <div
              v-for="obstacle in obstacles"
              :key="obstacle.id"
              class="obstacle-pair"
              :style="{ width: `${obstacle.width}px`, transform: `translateX(${obstacle.x}px)` }"
            >
              <div class="obstacle top" :style="{ height: `${obstacle.gapTop}px`, width: `${obstacle.width}px`, backgroundImage: `url('${moonObstacle}')` }"></div>
              <div
                class="obstacle bottom"
                :style="{
                  top: `${obstacle.gapTop + obstacle.gapHeight}px`,
                  bottom: '0',
                  width: `${obstacle.width}px`,
                  backgroundImage: `url('${moonObstacle}')`,
                }"
              ></div>
            </div>

            <div
              ref="playerElement"
              class="player"
              :class="{ jumping: isJumping }"
              :style="{ top: `${playerY}px` }"
            >
              <img :src="playerImage" alt="游戏角色" draggable="false" />
            </div>

            <div v-if="gameStatus === 'ready'" class="game-overlay ready-overlay">
              <div class="overlay-card">
                <p class="overlay-label">DREAM 01 · FLIGHT</p>
                <h2>云隙轻歌</h2>
                <p>点击画面或按空格，让她穿过月光的间隙。</p>
                <button type="button" class="primary-button" @pointerdown.stop @click="startGame">进入梦境</button>
              </div>
            </div>

            <div v-if="gameStatus === 'over'" class="game-overlay over-overlay">
              <div class="overlay-card result-card">
                <h2>再来一次</h2>
                <div class="result-score">
                  <span>本局得分 <strong>{{ score }}</strong></span>
                  <span>最佳记录 <strong>{{ bestScore }}</strong></span>
                </div>
                <button type="button" class="primary-button" @pointerdown.stop @click="startGame">重新开始</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <RunnerGame v-else-if="screen === 'runner'" key="runner" @back="returnToLobby" />
      <TeyvatDiceGame v-else-if="screen === 'dice'" key="dice" @back="closeDice" />
      <BoardGame v-else :key="`board-${boardKind}-${boardSessionKey}`" :kind="boardKind" @back="closeBoard" @reload="reloadBoard" @result="saveBoardResult" />
    </Transition>

    <section v-if="assetLoading.active" class="asset-loader asset-loader-game" aria-live="polite">
      <div class="asset-loader-card">
        <span class="asset-loader-moon">☾</span>
        <p>PREPARING DREAM</p>
        <h2>{{ assetLoading.title }}</h2>
        <div class="asset-progress" role="progressbar" :aria-valuenow="loadingPercent" aria-valuemin="0" aria-valuemax="100">
          <span :style="{ width: `${loadingPercent}%` }"></span>
        </div>
        <strong v-if="!assetLoading.error">{{ loadingPercent }}% · {{ assetLoading.loaded }}/{{ assetLoading.total }}</strong>
        <small v-if="!assetLoading.error" class="asset-load-status">
          {{ loadingStatusText }}
          <template v-if="assetLoading.totalBytes !== null"> · {{ formatBytes(assetLoading.bytesReceived) }} / {{ formatBytes(assetLoading.totalBytes) }}</template>
          <template v-else-if="assetLoading.bytesReceived"> · {{ formatBytes(assetLoading.bytesReceived) }} · 大小未知</template>
        </small>
        <p v-else class="asset-load-error">{{ assetLoading.error }}</p>
        <p v-if="assetLoading.longWait && !assetLoading.error" class="asset-load-wait">仍在{{ loadingStatusText }}，可继续等待、取消或重新开始。</p>
        <div class="asset-loader-actions">
          <button v-if="assetLoading.error" type="button" @click="retryAssetLoading">重新下载</button>
          <button v-else-if="assetLoading.longWait" type="button" @click="restartAssetLoading">重新开始</button>
          <button type="button" @click="cancelAssetLoading">返回大厅</button>
        </div>
      </div>
    </section>
  </main>
</template>

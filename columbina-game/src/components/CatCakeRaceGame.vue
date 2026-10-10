<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import columbinaSpriteUrl from '../../p/cat-cake-race/columbina.png?url'
import titleArtUrl from '../../p/cat-cake-race/标题.png?url'
import opponent02Url from '../../p/cat-cake-race/02_176e4cad.png?url'
import opponent03Url from '../../p/cat-cake-race/03_58e3ea7d.png?url'
import opponent04Url from '../../p/cat-cake-race/04_60e5eebb.png?url'
import opponent05Url from '../../p/cat-cake-race/05_6a1807dc.png?url'
import opponent06Url from '../../p/cat-cake-race/06_63993ad2.png?url'
import opponent07Url from '../../p/cat-cake-race/07_be3181de.png?url'
import opponent08Url from '../../p/cat-cake-race/08_f1294cc5.png?url'
import opponent09Url from '../../p/cat-cake-race/09_f5a66c6c.png?url'
import opponent10Url from '../../p/cat-cake-race/10_fb7db564.png?url'
import terrainModelUrl from '../../p/cat-cake-race/model.gltf?url'
import springModelUrl from '../../p/cat-cake-race/弹簧-动画.gltf?url'
import pistonModelUrl from '../../p/cat-cake-race/活塞-动画.gltf?url'
import spikeModelUrl from '../../p/cat-cake-race/地刺.gltf?url'
import bombModelUrl from '../../p/cat-cake-race/牵引炸弹.gltf?url'
import {
  AI_DIFFICULTY,
  CONTROLLER_TYPE,
  DIRECTION,
  RACE_STATUS,
  STACK_ROLE,
  createPlayableRace,
} from '../games/catCakeRace/domain.js'
import { createDesignedMaps, createRandomizedMap } from '../games/catCakeRace/maps.js'
import CatCakeTerrainPreview from './CatCakeTerrainPreview.vue'

defineEmits(['back'])

const designedMaps = createDesignedMaps()
const mapOptions = Object.values(designedMaps)
const selectedMapId = ref('')
const generatedMap = ref(mapOptions[0])
const selectedMap = computed(() => generatedMap.value)
const selectedDifficulty = ref('')
const difficultyOptions = [
  { id: AI_DIFFICULTY.EASY, label: '轻松' },
  { id: AI_DIFFICULTY.NORMAL, label: '标准' },
  { id: AI_DIFFICULTY.HARD, label: '困难' },
]
const opponentCandidates = [
  { id: '02', url: opponent02Url },
  { id: '03', url: opponent03Url },
  { id: '04', url: opponent04Url },
  { id: '05', url: opponent05Url },
  { id: '06', url: opponent06Url },
  { id: '07', url: opponent07Url },
  { id: '08', url: opponent08Url },
  { id: '09', url: opponent09Url },
  { id: '10', url: opponent10Url },
]
const difficultyLabel = computed(() => (
  difficultyOptions.find((option) => option.id === selectedDifficulty.value)?.label ?? '未选择'
))

function selectOpponentSprites() {
  const pool = [...opponentCandidates]
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1))
    const current = pool[index]
    pool[index] = pool[target]
    pool[target] = current
  }
  return pool.slice(0, 4)
}

function createRaceWithSprites(map, aiDifficulty) {
  const race = createPlayableRace(map, { aiDifficulty })
  const selectedOpponents = selectOpponentSprites()
  const spriteUrls = { [race.player.id]: columbinaSpriteUrl }
  race.contestants
    .filter((cat) => cat.controllerType === CONTROLLER_TYPE.AI)
    .forEach((cat, index) => {
      const opponent = selectedOpponents[index]
      spriteUrls[cat.id] = opponent.url
      cat.name = `${opponent.id}号猫猫糕`
    })
  return { race, spriteUrls }
}

const initialRace = createRaceWithSprites(selectedMap.value, AI_DIFFICULTY.NORMAL)
const session = ref(initialRace.race)
const contestantSpriteUrls = ref(initialRace.spriteUrls)
const clock = ref(Date.now())
const actionMessage = ref('请先选择地图和AI难度，再开始比赛。')
const centerPrompt = ref('')
const processedEventCount = ref(0)
let clockTimer = 0
let centerPromptTimer = 0
let previousPlayerStackSignature = ''
let previousPlayerGlueActive = false

const player = computed(() => session.value.player)
const canConfigure = computed(() => session.value.status === RACE_STATUS.READY)
const hasRaceSetup = computed(() => Boolean(selectedMapId.value && selectedDifficulty.value))
const canStart = computed(() => canConfigure.value && hasRaceSetup.value)
const canMove = computed(() => session.value.status === RACE_STATUS.RUNNING && !player.value.finish.reached)
const statusLabel = computed(() => ({
  [RACE_STATUS.READY]: '等待开始',
  [RACE_STATUS.COUNTDOWN]: `倒计时 ${Math.max(1, Math.ceil((session.value.countdownEndsAt - clock.value) / 1000))}`,
  [RACE_STATUS.RUNNING]: '比赛进行中',
  [RACE_STATUS.FINISHED]: '比赛结束',
}[session.value.status]))
const elapsedMs = computed(() => {
  if (!session.value.startedAt) return 0
  const completedAt = session.value.status === RACE_STATUS.FINISHED
    ? Math.max(...session.value.contestants.map((cat) => cat.finish.time ?? session.value.startedAt))
    : clock.value
  return Math.max(0, completedAt - session.value.startedAt)
})

function formatTime(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1000
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
}

function startRace() {
  if (!canStart.value) {
    actionMessage.value = '需要先选择地图和AI难度。'
    return
  }
  const now = Date.now()
  clock.value = now
  if (session.value.startCountdown(now)) actionMessage.value = '3秒倒计时开始。准备！'
}

function resetRace(message = '比赛已重置，可以重新开始。') {
  const aiDifficulty = selectedDifficulty.value || AI_DIFFICULTY.NORMAL
  const nextRace = createRaceWithSprites(selectedMap.value, aiDifficulty)
  contestantSpriteUrls.value = nextRace.spriteUrls
  session.value = nextRace.race
  clock.value = Date.now()
  processedEventCount.value = 0
  previousPlayerStackSignature = ''
  previousPlayerGlueActive = false
  centerPrompt.value = ''
  actionMessage.value = message
}

function rerollSelectedMap() {
  generatedMap.value = createRandomizedMap(selectedMapId.value === 'random' ? null : selectedMapId.value)
}

function restartRace() {
  if (!hasRaceSetup.value) return
  rerollSelectedMap()
  resetRace(`已重新生成${selectedMap.value.name}，可以开始比赛。`)
}

function selectDifficulty(difficulty) {
  if (!canConfigure.value || selectedDifficulty.value === difficulty) return
  selectedDifficulty.value = difficulty
  resetRace(selectedMapId.value
    ? `已选择${selectedMap.value.name}和${difficultyLabel.value}难度，可以开始比赛。`
    : `已选择${difficultyLabel.value}难度，请继续选择地图。`)
}

function selectMap(id) {
  if (!canConfigure.value) return
  selectedMapId.value = id
  generatedMap.value = createRandomizedMap(id)
  resetRace(selectedDifficulty.value
    ? `已选择${selectedMap.value.name}和${difficultyLabel.value}难度，可以开始比赛。`
    : `已选择${selectedMap.value.name}，请继续选择AI难度。`)
}


function selectRandomMap() {
  if (!canConfigure.value) return
  selectedMapId.value = 'random'
  generatedMap.value = createRandomizedMap()
  resetRace(selectedDifficulty.value
    ? `已生成${selectedMap.value.name}和${difficultyLabel.value}难度，可以开始比赛。`
    : `已生成${selectedMap.value.name}，请继续选择AI难度。`)
}

function describeResult(result) {
  if (result.ok) {
    return ({
      moved: '跳跃成功。',
      stacked: '落到另一只猫猫糕上，形成双层堆叠。',
      finished: '到达终点！等待其他猫猫糕完成比赛。',
      'respawned-after-pit': '主动跳入坑中，已返回最近复活线。',
      'respawned-after-spikes': '触发尖刺，已返回最近复活线。',
      'waiting-for-respawn-space': '复活线暂无空位，正在等待复活。',
      'moved-while-invincible': '复活无敌期间不会受到尖刺伤害。',
      'stuck-in-glue': '落入胶水，连续按方向键尝试挣脱。',
      'glue-struggle': '挣脱胶水失败。',
      'shake-off-failed': '甩落失败。',
      'shake-off-blocked': '甩落方向没有可用落点。',
      'shake-off-success': '成功甩落上方猫猫糕！',
      'triggered-spring': '弹簧启动，已完成强制弹射。',
      'triggered-tractor-bomb': '进入炸弹触发区，牵引爆炸！',
    })[result.outcome] ?? `动作完成：${result.outcome}`
  }
  return ({
    'race-not-running': '倒计时结束后才能移动。',
    'jump-cooldown': '跳跃冷却中。',
    'outside-map': '目标超出地图边界。',
    'target-blocks-jump': '目标格被墙阻挡。',
    'height-difference': '目标高度超过普通跳跃能力。',
    'target-stack-full': '目标格已有两只猫猫糕。',
    'action-blocked': '当前状态不能主动跳跃。',
    'source-blocks-jump': '当前格不能主动离开。',
    'missing-stack-partner': '堆叠状态异常，已自动解除。',
  })[result.reason] ?? `动作未执行：${result.reason}`
}

function playerStackSignature() {
  return `${player.value.stack.role}:${player.value.stack.partnerId ?? ''}`
}

function showCenterPrompt(message) {
  centerPrompt.value = message
  window.clearTimeout(centerPromptTimer)
  centerPromptTimer = window.setTimeout(() => {
    centerPrompt.value = ''
  }, 1800)
}

function describeDeathReason(reason) {
  return ({
    pit: '掉进坑里',
    spikes: '碰到地刺',
  })[reason] ?? '意外'
}

function syncPlayerPrompt() {
  const signature = playerStackSignature()
  if (!previousPlayerStackSignature) {
    previousPlayerStackSignature = signature
    previousPlayerGlueActive = player.value.glue.active
    return
  }
  if (signature !== previousPlayerStackSignature) {
    const previousRole = previousPlayerStackSignature.split(':')[0]
    previousPlayerStackSignature = signature
    if (player.value.stack.role === STACK_ROLE.TOP) {
      const partner = session.value.getContestant(player.value.stack.partnerId)
      showCenterPrompt(partner?.controllerType === CONTROLLER_TYPE.AI
        ? '已跳上其他猫猫糕'
        : '已形成双层堆叠')
    } else if (player.value.stack.role === STACK_ROLE.BOTTOM) {
      showCenterPrompt('有猫猫糕叠上来了')
    } else if (previousRole !== STACK_ROLE.NONE) {
      showCenterPrompt('堆叠已解除')
    }
  }
  if (!previousPlayerGlueActive && player.value.glue.active) {
    showCenterPrompt('被胶水粘住，按方向键挣脱')
  }
  previousPlayerGlueActive = player.value.glue.active
}

function processMechanismEvents() {
  const events = session.value.mechanismEvents.slice(processedEventCount.value)
  processedEventCount.value = session.value.mechanismEvents.length
  const playerEvents = events.filter((event) => event.affectedCatIds?.includes(player.value.id))
  const deathEvent = playerEvents.filter((event) => event.type === 'cat-death').at(-1)
  if (deathEvent) showCenterPrompt(`因为${describeDeathReason(deathEvent.reason)}死亡`)
  const relevant = playerEvents.filter((event) => event.type !== 'cat-death').at(-1)
  if (!relevant) return
  if (relevant.type === 'tractor-bomb-explosion') actionMessage.value = '牵引炸弹爆炸，玩家位置已重新结算。'
  if (relevant.type === 'piston-activation') actionMessage.value = '活塞启动，玩家被强制推动。'
  if (relevant.type === 'spring-activation') actionMessage.value = '弹簧启动，玩家已被弹射。'
}

function move(direction) {
  if (!canMove.value) return
  const now = Date.now()
  clock.value = now
  session.value.advanceClock(now)
  const result = session.value.attemptNormalJump(player.value.id, direction, now)
  actionMessage.value = describeResult(result)
  processMechanismEvents()
  syncPlayerPrompt()
}

function handleKeydown(event) {
  if ((event.key === 'Enter' || event.key === ' ') && canStart.value) {
    event.preventDefault()
    startRace()
    return
  }
  const direction = {
    ArrowUp: DIRECTION.UP,
    ArrowDown: DIRECTION.DOWN,
    ArrowLeft: DIRECTION.LEFT,
    ArrowRight: DIRECTION.RIGHT,
    w: DIRECTION.UP,
    W: DIRECTION.UP,
    s: DIRECTION.DOWN,
    S: DIRECTION.DOWN,
    a: DIRECTION.LEFT,
    A: DIRECTION.LEFT,
    d: DIRECTION.RIGHT,
    D: DIRECTION.RIGHT,
  }[event.key]
  if (!direction) return
  event.preventDefault()
  move(direction)
}

onMounted(() => {
  clockTimer = window.setInterval(() => {
    const now = Date.now()
    clock.value = now
    const previous = session.value.status
    session.value.advanceClock(now)
    processMechanismEvents()
    syncPlayerPrompt()
    if (previous === RACE_STATUS.COUNTDOWN && session.value.status === RACE_STATUS.RUNNING) {
      actionMessage.value = '比赛开始！方向键或WASD控制跳跃。'
    }
    if (!player.value.finish.reached && session.value.status === RACE_STATUS.FINISHED) {
      actionMessage.value = '比赛结束。'
    }
  }, 50)
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  window.clearInterval(clockTimer)
  window.clearTimeout(centerPromptTimer)
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <section class="cat-race-page">
    <header class="cat-race-header">
      <button class="cat-back" type="button" @click="$emit('back')">← 返回游廊</button>
      <div class="brand"><small>DREAM 06 · CAT CAKE RACE</small><strong>娅娅猫向前冲</strong></div>
      <div class="header-status"><b>{{ formatTime(elapsedMs) }}</b><span>{{ statusLabel }}</span></div>
    </header>

    <main class="cat-race-content">
      <section class="race-intro">
        <div class="race-heading">
          <img class="race-title-art" :src="titleArtUrl" alt="娅娅猫向前冲标题图案">
          <div class="race-heading-copy">
            <p class="phase-tag">FULL PLAYABLE RACE · 1 PLAYER VS 4 AI</p>
            <h1>娅娅猫向前冲</h1>
            <p>从地图底部起点向顶部终点前进，使用方向键或WASD跳跃。和4只AI争夺终点，利用机关捷径，并避开地刺、坑、活塞、胶水和牵引炸弹。</p>
          </div>
        </div>
        <div class="race-actions">
          <button type="button" class="secondary" :disabled="!hasRaceSetup" @click="restartRace">重新生成地图</button>
        </div>
      </section>

      <section class="race-quick-guide" aria-label="快速玩法说明">
        <span class="guide-step"><b>目标</b> 从赛道底部的起点出发，向画面顶部的终点前进。</span>
        <span class="guide-step"><b>前进</b> 按 ↑ / W 向前；← → / A D 横向绕路，↓ / S 后退。</span>
        <span class="guide-step"><b>操作</b> 电脑用方向键或 WASD；手机点赛场下方的方向按钮。</span>
      </section>

      <details class="tile-guide">
        <summary>
          <span><b>地块与机关图例</b><small>看懂每种地形效果，再决定路线</small></span>
          <span class="guide-toggle" aria-hidden="true">展开说明　＋</span>
        </summary>
        <div class="tile-guide-grid">
          <div class="tile-guide-item"><span class="tile-mark tile-normal">平</span><span><b>普通地块 / 高台</b><small>普通地块可以通行；遇到高台时试着跳上去。</small></span></div>
          <div class="tile-guide-item"><span class="tile-mark tile-wall">墙</span><span><b>墙壁</b><small>无法穿过，沿旁边绕行。</small></span></div>
          <div class="tile-guide-item"><span class="tile-mark tile-pit">坑</span><span><b>坑</b><small>掉入后回到最近的复活线。</small></span></div>
          <div class="tile-guide-item"><span class="tile-mark tile-spikes">刺</span><span><b>地刺</b><small>碰到后会回到最近的复活线；复活后会暂时安全。</small></span></div>
          <div class="tile-guide-item"><span class="tile-mark tile-glue">黏</span><span><b>胶水</b><small>会黏住猫猫糕；连续按方向键尝试挣脱。</small></span></div>
          <div class="tile-guide-item"><span class="tile-mark tile-spring">弹</span><span><b>弹簧</b><small>会朝指向把猫猫糕弹出去，可以借此找捷径。</small></span></div>
          <div class="tile-guide-item"><span class="tile-mark tile-piston">推</span><span><b>活塞</b><small>启动时会沿指向推动附近猫猫糕，留意它的朝向。</small></span></div>
          <div class="tile-guide-item"><span class="tile-mark tile-bomb">引</span><span><b>牵引炸弹</b><small>爆炸会牵引附近猫猫糕，可能改变落点和前进路线。</small></span></div>
          <div class="tile-guide-item"><span class="tile-mark tile-checkpoint">存</span><span><b>复活线</b><small>横向发光线；经过后更新复活位置，失足时从这里继续。</small></span></div>
          <div class="tile-guide-item"><span class="tile-mark tile-finish">终</span><span><b>终点</b><small>赛道顶部的终点线；抵达后完成比赛并显示名次。</small></span></div>
        </div>
      </details>

      <section class="race-stage" aria-label="娅娅猫向前冲正式赛场">
        <div class="stage-toolbar">
          <div class="stage-selectors">
            <div class="map-tabs" role="tablist" aria-label="选择地图">
              <button
                v-for="map in mapOptions"
                :key="map.id"
                type="button"
                role="tab"
                :disabled="!canConfigure"
                :aria-selected="selectedMapId === map.id"
                :class="{ active: selectedMapId === map.id }"
                @click="selectMap(map.id)"
              >
                {{ map.id.replace('map', '地图') }}
              </button>
              <button
                type="button"
                role="tab"
                :disabled="!canConfigure"
                :aria-selected="selectedMapId === 'random'"
                :class="{ active: selectedMapId === 'random' }"
                @click="selectRandomMap"
              >
                随机选择
              </button>
            </div>
            <div class="difficulty-tabs" aria-label="选择AI难度">
              <small>AI难度</small>
              <button
                v-for="difficulty in difficultyOptions"
                :key="difficulty.id"
                type="button"
                :disabled="!canConfigure"
                :aria-pressed="selectedDifficulty === difficulty.id"
                :class="{ active: selectedDifficulty === difficulty.id }"
                @click="selectDifficulty(difficulty.id)"
              >
                {{ difficulty.label }}
              </button>
            </div>
          </div>
          <div class="stage-meta">
            <strong>{{ selectedMapId ? selectedMap.name : '请选择地图' }}</strong>
            <span>AI {{ difficultyLabel }}</span>
            <span>底部起点 → 顶部终点</span>
            <span>保底风险通路 {{ selectedMap.guaranteedRoute?.length ?? 0 }} 格</span>
            <span>复活线 {{ selectedMap.respawnRows.join(' / ') }}</span>
          </div>
        </div>

        <div class="board-wrap">
          <CatCakeTerrainPreview
            :map="selectedMap"
            :model-url="terrainModelUrl"
            :sprite-url="columbinaSpriteUrl"
            :sprite-urls="contestantSpriteUrls"
            :spring-model-url="springModelUrl"
            :piston-model-url="pistonModelUrl"
            :spike-model-url="spikeModelUrl"
            :bomb-model-url="bombModelUrl"
            :contestants="session.contestants"
            :focus-position="player.position"
            :mechanism-events="session.mechanismEvents"
            live
          />
          <div v-if="session.status === RACE_STATUS.COUNTDOWN" class="countdown-overlay">
            {{ Math.max(1, Math.ceil((session.countdownEndsAt - clock) / 1000)) }}
          </div>
          <div v-else-if="session.status === RACE_STATUS.READY" class="ready-overlay">
            <span>{{ hasRaceSetup ? '按 Enter 或点击开始比赛' : '请先选择地图和AI难度' }}</span>
            <button v-if="hasRaceSetup" type="button" :disabled="!canStart" @click="startRace">开始比赛</button>
          </div>
          <div v-else-if="player.finish.reached" class="finish-overlay">
            <small>FINISH</small><strong>第 {{ player.finish.rank }} 名</strong>
          </div>
          <div v-if="centerPrompt" class="stack-overlay" role="status" aria-live="assertive">{{ centerPrompt }}</div>
        </div>

        <div class="play-hud">
          <div class="controls-card">
            <div class="direction-pad">
              <button type="button" :disabled="!canMove" aria-label="向上跳跃" @click="move(DIRECTION.UP)">↑</button>
              <div>
                <button type="button" :disabled="!canMove" aria-label="向左跳跃" @click="move(DIRECTION.LEFT)">←</button>
                <button type="button" :disabled="!canMove" aria-label="向下跳跃" @click="move(DIRECTION.DOWN)">↓</button>
                <button type="button" :disabled="!canMove" aria-label="向右跳跃" @click="move(DIRECTION.RIGHT)">→</button>
              </div>
            </div>
            <div class="control-copy">
              <small>PLAYER CONTROL</small>
              <strong>方向键 / WASD</strong>
              <p>每次按下跳一格；被胶水黏住或压在下层时，继续按方向键尝试脱困。</p>
            </div>
          </div>
          <p class="action-message" aria-live="polite">{{ actionMessage }}</p>
        </div>
      </section>
    </main>
  </section>
</template>

<style scoped>
.cat-race-page{min-height:var(--app-vh,800px);color:#f8fbff;background:radial-gradient(circle at 72% 8%,rgba(130,91,196,.3),transparent 30%),linear-gradient(145deg,#07142f,#11133b 58%,#25153d)}
.race-quick-guide{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:-8px 0 12px;padding:13px 16px;border:1px solid rgba(169,221,255,.22);border-radius:12px;background:rgba(104,151,221,.09)}.guide-step{color:rgba(237,243,255,.78);font-size:12px;line-height:1.6}.guide-step b{display:block;margin-bottom:2px;color:#a9e7ff;font-size:10px;letter-spacing:.12em}
.tile-guide{margin:0 0 22px;border:1px solid rgba(169,221,255,.2);border-radius:12px;background:rgba(8,17,47,.34)}.tile-guide summary{display:flex;min-height:58px;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;cursor:pointer;list-style:none}.tile-guide summary::-webkit-details-marker{display:none}.tile-guide summary:focus-visible{outline:2px solid #9fe5ff;outline-offset:3px;border-radius:10px}.tile-guide summary>span:first-child{display:grid;gap:3px}.tile-guide summary b{color:#e8f6ff;font-size:12px}.tile-guide summary small{color:rgba(225,239,255,.58);font-size:10px}.guide-toggle{flex:0 0 auto;color:#9fe5ff;font-size:10px}.guide-toggle::after{content:'＋';margin-left:5px}.tile-guide[open] .guide-toggle::after{content:'－'}.tile-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:0 14px 14px}.tile-guide-item{display:flex;min-width:0;align-items:center;gap:10px;padding:10px;border:1px solid rgba(255,255,255,.09);border-radius:9px;background:rgba(255,255,255,.035)}.tile-guide-item>span:last-child{display:grid;gap:3px}.tile-guide-item b{color:#f1f7ff;font-size:11px}.tile-guide-item small{color:rgba(225,239,255,.58);font-size:10px;line-height:1.5}.tile-mark{display:grid;width:34px;height:34px;flex:0 0 34px;place-items:center;border:1px solid rgba(255,255,255,.22);border-radius:8px;color:#fff;font-size:11px;font-weight:700;text-shadow:0 1px 4px #111}.tile-normal{background:linear-gradient(145deg,#9383c9,#618cb2)}.tile-wall{background:repeating-linear-gradient(135deg,#58637b 0 5px,#30394f 5px 10px)}.tile-pit{background:#101522}.tile-spikes{background:linear-gradient(145deg,#d75b62,#81364f)}.tile-glue{background:linear-gradient(145deg,#9a9da6,#565d6b)}.tile-spring{background:linear-gradient(145deg,#69cdbd,#287e94)}.tile-piston{background:linear-gradient(145deg,#dca86a,#815d83)}.tile-bomb{background:linear-gradient(145deg,#202039,#7142a1)}.tile-checkpoint{background:linear-gradient(0deg,#29446b 0 42%,#8beaff 42% 56%,#29446b 56%)}.tile-finish{background:repeating-conic-gradient(#eaf5ff 0 25%,#233455 0 50%) 50%/12px 12px}
.cat-race-header{min-height:70px;padding:10px clamp(18px,4cqw,58px);display:grid;grid-template-columns:1fr auto 1fr;align-items:center;border-bottom:1px solid rgba(255,255,255,.15);background:rgba(5,11,34,.72);backdrop-filter:blur(18px)}
.cat-back{justify-self:start;border:0;padding:8px 0;background:transparent;color:rgba(255,255,255,.76);cursor:pointer}.brand{display:flex;flex-direction:column;align-items:center;gap:3px}.brand small,.phase-tag{color:#9fe5ff;font-size:9px;letter-spacing:.2em}.brand strong{font-family:var(--serif);font-size:16px;letter-spacing:.13em}.header-status{justify-self:end;display:flex;align-items:center;gap:10px}.header-status b{font:600 14px/1 monospace;color:#fff}.header-status span{padding:7px 12px;border:1px solid rgba(169,232,255,.35);border-radius:999px;color:#bbecff;background:rgba(107,199,255,.08);font-size:11px}
.cat-race-content{width:min(1180px,calc(100% - 34px));margin:0 auto;padding:clamp(32px,5cqw,64px) 0}.race-intro{display:flex;align-items:end;justify-content:space-between;gap:28px;margin-bottom:26px}.race-heading{display:flex;align-items:center;gap:clamp(14px,2.2cqw,26px)}.race-title-art{width:clamp(86px,10cqw,132px);height:clamp(86px,10cqw,132px);flex:0 0 auto;object-fit:contain;filter:drop-shadow(0 14px 24px rgba(2,7,28,.38))}.race-heading-copy{min-width:0}.phase-tag{margin:0 0 8px}.race-intro h1{margin:0 0 10px;font-family:var(--serif);font-size:clamp(38px,5cqw,60px);font-weight:600;letter-spacing:.08em}.race-heading-copy>p:last-child{max-width:720px;margin:0;color:rgba(237,243,255,.66);font-size:13px;line-height:1.8}.race-actions{display:flex;flex-shrink:0;gap:10px}.race-actions button{border:1px solid rgba(255,255,255,.65);border-radius:999px;padding:10px 20px;background:#f4f8ff;color:#101638;cursor:pointer}.race-actions .secondary{background:rgba(255,255,255,.06);color:#fff}.race-actions button:disabled{cursor:not-allowed;opacity:.4}
.race-stage{border:1px solid rgba(211,232,255,.22);padding:clamp(14px,2.5cqw,26px);background:linear-gradient(145deg,rgba(30,45,94,.72),rgba(11,17,53,.86));box-shadow:0 20px 70px rgba(0,0,25,.24)}.stage-toolbar{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:13px}.stage-selectors{display:grid;gap:8px}.map-tabs,.difficulty-tabs{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.difficulty-tabs small{margin-right:3px;color:rgba(225,239,255,.52);font-size:8px;letter-spacing:.08em}.map-tabs button,.difficulty-tabs button{border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:7px 12px;background:rgba(255,255,255,.05);color:rgba(255,255,255,.65);cursor:pointer;font-size:9px}.map-tabs button.active,.difficulty-tabs button.active{border-color:rgba(171,225,255,.72);background:rgba(125,202,255,.18);color:#fff}.map-tabs button:disabled,.difficulty-tabs button:disabled{cursor:not-allowed;opacity:.45}.stage-meta{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px 14px;color:rgba(225,239,255,.52);font-size:9px}.stage-meta strong{width:100%;color:#fff;font-family:var(--serif);font-size:12px;text-align:right}.board-wrap{position:relative;overflow:hidden;border:1px solid rgba(223,238,255,.18)}.countdown-overlay,.ready-overlay,.finish-overlay,.stack-overlay{position:absolute;z-index:10;inset:0;display:grid;place-content:center;text-align:center;background:rgba(6,8,26,.38);backdrop-filter:blur(2px);pointer-events:none}.countdown-overlay{font:700 clamp(64px,12cqw,130px)/1 var(--serif);text-shadow:0 0 35px rgba(179,222,255,.9)}.ready-overlay{color:#d9efff;font-size:14px;letter-spacing:.08em}.finish-overlay small{color:#9fe5ff;letter-spacing:.3em}.finish-overlay strong{margin-top:8px;font-family:var(--serif);font-size:44px}.stack-overlay{inset:35% 10%;border:1px solid rgba(189,235,255,.55);border-radius:16px;color:#fff;background:rgba(19,30,69,.82);box-shadow:0 12px 50px rgba(0,0,0,.35);font:600 clamp(18px,3cqw,30px)/1.3 var(--serif);text-shadow:0 2px 16px rgba(125,202,255,.8)}.play-hud{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:20px;margin-top:15px}.controls-card{display:flex;align-items:center;gap:14px}.direction-pad{display:flex;flex-direction:column;align-items:center;gap:4px}.direction-pad>div{display:flex;gap:4px}.direction-pad button{width:42px;height:36px;border:1px solid rgba(255,255,255,.34);border-radius:5px;background:rgba(255,255,255,.08);color:#fff;cursor:pointer;font-size:18px}.direction-pad button:hover:not(:disabled){background:rgba(158,220,255,.2)}.direction-pad button:disabled{opacity:.28}.control-copy small{color:#93dfff;font-size:8px;letter-spacing:.16em}.control-copy strong{display:block;margin:3px 0;font-size:12px}.control-copy p{max-width:410px;margin:0;color:rgba(235,243,255,.5);font-size:9px;line-height:1.55}.action-message{justify-self:end;margin:0;color:#d9efff;font-size:11px;text-align:right}
.ready-overlay{place-items:center;pointer-events:auto}.ready-overlay button{margin-top:14px;border:1px solid rgba(255,255,255,.78);border-radius:999px;padding:11px 30px;background:#f4f8ff;color:#101638;font-weight:700;cursor:pointer;letter-spacing:.08em}.ready-overlay button:disabled{cursor:not-allowed;opacity:.45}
.stack-overlay{inset:auto;top:50%;left:50%;width:auto;max-width:210px;padding:4px 8px;transform:translate(-50%,-50%);border-radius:999px;border-color:rgba(189,235,255,.36);background:rgba(19,30,69,.62);box-shadow:0 4px 15px rgba(0,0,0,.2);font:600 clamp(9px,1cqw,11px)/1.15 var(--serif);white-space:nowrap;text-shadow:0 1px 6px rgba(125,202,255,.55)}
@container app (max-width:800px){.cat-race-header{grid-template-columns:1fr auto}.brand{display:none}.header-status{gap:5px}.header-status span{padding:6px 8px}.cat-race-content{width:min(100% - 20px,1180px)}.race-intro{align-items:start;flex-direction:column}.race-heading{align-items:flex-start}.race-title-art{width:78px;height:78px}.race-quick-guide{grid-template-columns:1fr;gap:7px;margin:-8px 0 10px;padding:11px 13px}.guide-step{font-size:11px;overflow-wrap:anywhere}.guide-step b{display:inline;margin:0 8px 0 0}.tile-guide{margin-bottom:16px}.tile-guide summary{min-height:54px;padding:10px 12px}.tile-guide-grid{grid-template-columns:1fr;gap:6px;padding:0 9px 10px}.tile-guide-item{gap:9px;padding:8px}.tile-guide-item small{font-size:10px}.stage-toolbar{align-items:start;flex-direction:column}.stage-meta{justify-content:flex-start}.stage-meta strong{text-align:left}.play-hud{grid-template-columns:1fr}.action-message{justify-self:stretch;text-align:center}.controls-card{flex-direction:column;justify-content:center;gap:8px}.direction-pad button{width:54px;height:48px;touch-action:manipulation}.control-copy{display:block;text-align:center}.control-copy p{max-width:320px;font-size:11px;line-height:1.55}}
</style>

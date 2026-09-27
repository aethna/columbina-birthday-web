<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import columbinaSpriteUrl from '../../p/cat-cake-race/columbina.png?url'
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
const difficultyLabel = computed(() => (
  difficultyOptions.find((option) => option.id === selectedDifficulty.value)?.label ?? '未选择'
))
const session = ref(createPlayableRace(selectedMap.value, { aiDifficulty: AI_DIFFICULTY.NORMAL }))
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
  session.value = createPlayableRace(selectedMap.value, { aiDifficulty })
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
    'pit-cannot-be-normal-jump-target': '普通跳跃不能直接落入坑中。',
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
        ? '你堆叠了其他猫猫糕！'
        : '发生双层堆叠！')
    } else if (player.value.stack.role === STACK_ROLE.BOTTOM) {
      showCenterPrompt('其他 AI 猫猫糕跳到了你的头上！')
    } else if (previousRole !== STACK_ROLE.NONE) {
      showCenterPrompt('堆叠已解除。')
    }
  }
  if (!previousPlayerGlueActive && player.value.glue.active) {
    showCenterPrompt('被胶水粘住了！连续按方向键挣脱。')
  }
  previousPlayerGlueActive = player.value.glue.active
}

function processMechanismEvents() {
  const events = session.value.mechanismEvents.slice(processedEventCount.value)
  processedEventCount.value = session.value.mechanismEvents.length
  const relevant = events.filter((event) => event.affectedCatIds?.includes(player.value.id)).at(-1)
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
        <div>
          <p class="phase-tag">FULL PLAYABLE RACE · 1 PLAYER VS 4 AI</p>
          <h1>娅娅猫向前冲</h1>
          <p>从地图底部起点向顶部终点前进，使用方向键或WASD跳跃。和4只AI争夺终点，利用机关捷径，并避开地刺、坑、活塞、胶水和牵引炸弹。</p>
        </div>
        <div class="race-actions">
          <button type="button" class="secondary" :disabled="!hasRaceSetup" @click="restartRace">重新生成地图</button>
        </div>
      </section>

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
              <p>普通跳跃间隔0.3秒。被胶水或压在下层时，继续按方向键执行挣脱或甩落。</p>
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
.cat-race-header{min-height:70px;padding:10px clamp(18px,4cqw,58px);display:grid;grid-template-columns:1fr auto 1fr;align-items:center;border-bottom:1px solid rgba(255,255,255,.15);background:rgba(5,11,34,.72);backdrop-filter:blur(18px)}
.cat-back{justify-self:start;border:0;padding:8px 0;background:transparent;color:rgba(255,255,255,.76);cursor:pointer}.brand{display:flex;flex-direction:column;align-items:center;gap:3px}.brand small,.phase-tag{color:#9fe5ff;font-size:9px;letter-spacing:.2em}.brand strong{font-family:var(--serif);font-size:16px;letter-spacing:.13em}.header-status{justify-self:end;display:flex;align-items:center;gap:10px}.header-status b{font:600 14px/1 monospace;color:#fff}.header-status span{padding:7px 12px;border:1px solid rgba(169,232,255,.35);border-radius:999px;color:#bbecff;background:rgba(107,199,255,.08);font-size:11px}
.cat-race-content{width:min(1180px,calc(100% - 34px));margin:0 auto;padding:clamp(32px,5cqw,64px) 0}.race-intro{display:flex;align-items:end;justify-content:space-between;gap:28px;margin-bottom:26px}.phase-tag{margin:0 0 8px}.race-intro h1{margin:0 0 10px;font-family:var(--serif);font-size:clamp(38px,5cqw,60px);font-weight:600;letter-spacing:.08em}.race-intro>div>p:last-child{max-width:720px;margin:0;color:rgba(237,243,255,.66);font-size:13px;line-height:1.8}.race-actions{display:flex;flex-shrink:0;gap:10px}.race-actions button{border:1px solid rgba(255,255,255,.65);border-radius:999px;padding:10px 20px;background:#f4f8ff;color:#101638;cursor:pointer}.race-actions .secondary{background:rgba(255,255,255,.06);color:#fff}.race-actions button:disabled{cursor:not-allowed;opacity:.4}
.race-stage{border:1px solid rgba(211,232,255,.22);padding:clamp(14px,2.5cqw,26px);background:linear-gradient(145deg,rgba(30,45,94,.72),rgba(11,17,53,.86));box-shadow:0 20px 70px rgba(0,0,25,.24)}.stage-toolbar{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:13px}.stage-selectors{display:grid;gap:8px}.map-tabs,.difficulty-tabs{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.difficulty-tabs small{margin-right:3px;color:rgba(225,239,255,.52);font-size:8px;letter-spacing:.08em}.map-tabs button,.difficulty-tabs button{border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:7px 12px;background:rgba(255,255,255,.05);color:rgba(255,255,255,.65);cursor:pointer;font-size:9px}.map-tabs button.active,.difficulty-tabs button.active{border-color:rgba(171,225,255,.72);background:rgba(125,202,255,.18);color:#fff}.map-tabs button:disabled,.difficulty-tabs button:disabled{cursor:not-allowed;opacity:.45}.stage-meta{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px 14px;color:rgba(225,239,255,.52);font-size:9px}.stage-meta strong{width:100%;color:#fff;font-family:var(--serif);font-size:12px;text-align:right}.board-wrap{position:relative;overflow:hidden;border:1px solid rgba(223,238,255,.18)}.countdown-overlay,.ready-overlay,.finish-overlay,.stack-overlay{position:absolute;z-index:10;inset:0;display:grid;place-content:center;text-align:center;background:rgba(6,8,26,.38);backdrop-filter:blur(2px);pointer-events:none}.countdown-overlay{font:700 clamp(64px,12cqw,130px)/1 var(--serif);text-shadow:0 0 35px rgba(179,222,255,.9)}.ready-overlay{color:#d9efff;font-size:14px;letter-spacing:.08em}.finish-overlay small{color:#9fe5ff;letter-spacing:.3em}.finish-overlay strong{margin-top:8px;font-family:var(--serif);font-size:44px}.stack-overlay{inset:35% 10%;border:1px solid rgba(189,235,255,.55);border-radius:16px;color:#fff;background:rgba(19,30,69,.82);box-shadow:0 12px 50px rgba(0,0,0,.35);font:600 clamp(18px,3cqw,30px)/1.3 var(--serif);text-shadow:0 2px 16px rgba(125,202,255,.8)}.play-hud{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:20px;margin-top:15px}.controls-card{display:flex;align-items:center;gap:14px}.direction-pad{display:flex;flex-direction:column;align-items:center;gap:4px}.direction-pad>div{display:flex;gap:4px}.direction-pad button{width:42px;height:36px;border:1px solid rgba(255,255,255,.34);border-radius:5px;background:rgba(255,255,255,.08);color:#fff;cursor:pointer;font-size:18px}.direction-pad button:hover:not(:disabled){background:rgba(158,220,255,.2)}.direction-pad button:disabled{opacity:.28}.control-copy small{color:#93dfff;font-size:8px;letter-spacing:.16em}.control-copy strong{display:block;margin:3px 0;font-size:12px}.control-copy p{max-width:410px;margin:0;color:rgba(235,243,255,.5);font-size:9px;line-height:1.55}.action-message{justify-self:end;margin:0;color:#d9efff;font-size:11px;text-align:right}
.ready-overlay{place-items:center;pointer-events:auto}.ready-overlay button{margin-top:14px;border:1px solid rgba(255,255,255,.78);border-radius:999px;padding:11px 30px;background:#f4f8ff;color:#101638;font-weight:700;cursor:pointer;letter-spacing:.08em}.ready-overlay button:disabled{cursor:not-allowed;opacity:.45}
@container app (max-width:800px){.cat-race-header{grid-template-columns:1fr auto}.brand{display:none}.header-status{gap:5px}.header-status span{padding:6px 8px}.cat-race-content{width:min(100% - 20px,1180px)}.race-intro{align-items:start;flex-direction:column}.stage-toolbar{align-items:start;flex-direction:column}.stage-meta{justify-content:flex-start}.stage-meta strong{text-align:left}.play-hud{grid-template-columns:1fr}.action-message{justify-self:stretch;text-align:center}.control-copy{display:none}.controls-card{justify-content:center}}
</style>

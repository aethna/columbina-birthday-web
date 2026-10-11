<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  createFreshBoard,
  getMatchGroups,
  getSpecialAnchor,
  getSpecialEffect,
  hasLegalMove,
  MATCH_BOARD_SIZE,
} from '../games/matchThreeEngine.js'

const emit = defineEmits(['back'])

const normalModules = import.meta.glob('../../p/match-three/tiles/normal/gem-*.png', {
  eager: true,
  import: 'default',
  query: '?url',
})
const specialModules = {
  'line-horizontal': import.meta.glob('../../p/match-three/tiles/special/line-horizontal/gem-*.png', { eager: true, import: 'default', query: '?url' }),
  'line-vertical': import.meta.glob('../../p/match-three/tiles/special/line-vertical/gem-*.png', { eager: true, import: 'default', query: '?url' }),
  'area-bomb': import.meta.glob('../../p/match-three/tiles/special/area-bomb/gem-*.png', { eager: true, import: 'default', query: '?url' }),
  'color-bomb': import.meta.glob('../../p/match-three/tiles/special/color-bomb/gem-*.png', { eager: true, import: 'default', query: '?url' }),
}
const boardTexture = new URL('../../p/match-three/board/board-8x8.png', import.meta.url).href

function assetMap(modules) {
  return Object.fromEntries(Object.entries(modules).map(([path, url]) => {
    const id = Number(path.match(/gem-(\d+)\.png$/)?.[1]) - 1
    return [id, url]
  }))
}

const normalImages = assetMap(normalModules)
const specialImages = Object.fromEntries(Object.entries(specialModules).map(([type, modules]) => [type, assetMap(modules)]))
const gemNames = ['月辉', '花芽', '霜羽', '星辉', '暖霞', '潮汐']
const specialNames = {
  'line-horizontal': '横向清除',
  'line-vertical': '纵向清除',
  'area-bomb': '范围爆发',
  'color-bomb': '同色清除',
}

const mode = ref(null)
const board = ref([])
const selectedIndex = ref(null)
const score = ref(0)
const moves = ref(30)
const busy = ref(false)
const status = ref('select')
const clearingCells = ref(new Set())
const toast = ref('')
const endlessBest = ref(readEndlessBest())
const moveLabel = computed(() => mode.value === 'ranked' ? moves.value : '∞')
const modeTitle = computed(() => mode.value === 'ranked' ? '排位模式' : '无尽模式')
const scoreTip = computed(() => mode.value === 'ranked' ? '30 步挑战 · 本局成绩暂不提交' : '无步数限制 · 成绩仅保存在本机')

let toastTimer = 0
let nextTileId = 0

function readEndlessBest() {
  try {
    return Number(localStorage.getItem('match-three-endless-best') || 0)
  } catch {
    return 0
  }
}

function writeEndlessBest(value) {
  try {
    localStorage.setItem('match-three-endless-best', String(value))
  } catch {
    // The game remains playable when browser storage is disabled.
  }
}

function showToast(message) {
  toast.value = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = '' }, 1800)
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function newTile(type) {
  nextTileId += 1
  return { id: `tile-${nextTileId}`, type, special: null }
}

function startMode(nextMode) {
  mode.value = nextMode
  board.value = createFreshBoard().map((tile) => newTile(tile.type))
  score.value = 0
  moves.value = 30
  selectedIndex.value = null
  clearingCells.value = new Set()
  status.value = 'playing'
  busy.value = false
}

function goBack() {
  emit('back')
}

function imageFor(tile) {
  if (!tile) return ''
  return tile.special ? specialImages[tile.special]?.[tile.type] : normalImages[tile.type]
}

function areAdjacent(a, b) {
  const ax = a % MATCH_BOARD_SIZE
  const ay = Math.floor(a / MATCH_BOARD_SIZE)
  const bx = b % MATCH_BOARD_SIZE
  const by = Math.floor(b / MATCH_BOARD_SIZE)
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1
}

function addLine(targets, orientation, x, y, width = MATCH_BOARD_SIZE) {
  if (orientation === 'horizontal') {
    const row = Math.max(0, Math.min(MATCH_BOARD_SIZE - 1, y))
    for (let col = 0; col < width; col += 1) targets.add(row * MATCH_BOARD_SIZE + col)
  } else {
    const col = Math.max(0, Math.min(MATCH_BOARD_SIZE - 1, x))
    for (let row = 0; row < width; row += 1) targets.add(row * MATCH_BOARD_SIZE + col)
  }
}

function getComboTargets(firstIndex, secondIndex) {
  const first = board.value[firstIndex]
  const second = board.value[secondIndex]
  const targets = new Set([firstIndex, secondIndex])
  const firstColor = first.special === 'color-bomb'
  const secondColor = second.special === 'color-bomb'

  if (firstColor && secondColor) {
    board.value.forEach((_, index) => targets.add(index))
    return targets
  }

  if (firstColor || secondColor) {
    const colorIndex = firstColor ? firstIndex : secondIndex
    const other = firstColor ? second : first
    board.value.forEach((tile, index) => {
      if (tile?.type !== other.type) return
      targets.add(index)
      if (tile.special && tile.special !== 'color-bomb') {
        getSpecialEffect(board.value, index).forEach((cell) => targets.add(cell))
      }
    })
    targets.add(colorIndex)
    return targets
  }

  const firstX = firstIndex % MATCH_BOARD_SIZE
  const firstY = Math.floor(firstIndex / MATCH_BOARD_SIZE)
  const secondX = secondIndex % MATCH_BOARD_SIZE
  const secondY = Math.floor(secondIndex / MATCH_BOARD_SIZE)
  const centerX = Math.round((firstX + secondX) / 2)
  const centerY = Math.round((firstY + secondY) / 2)

  if (first.special === 'area-bomb' && second.special === 'area-bomb') {
    for (let y = centerY - 2; y <= centerY + 2; y += 1) {
      for (let x = centerX - 2; x <= centerX + 2; x += 1) {
        if (x >= 0 && x < MATCH_BOARD_SIZE && y >= 0 && y < MATCH_BOARD_SIZE) targets.add(y * MATCH_BOARD_SIZE + x)
      }
    }
  } else if (
    (first.special === 'area-bomb' && second.special?.startsWith('line-')) ||
    (second.special === 'area-bomb' && first.special?.startsWith('line-'))
  ) {
    for (let delta = -1; delta <= 1; delta += 1) {
      addLine(targets, 'horizontal', centerX, centerY + delta)
      addLine(targets, 'vertical', centerX + delta, centerY)
    }
  } else {
    getSpecialEffect(board.value, firstIndex).forEach((cell) => targets.add(cell))
    getSpecialEffect(board.value, secondIndex).forEach((cell) => targets.add(cell))
  }
  return targets
}

function expandSpecialEffects(initialTargets, protectedCells = new Set(), alreadyTriggered = new Set()) {
  const targets = new Set([...initialTargets].filter((index) => !protectedCells.has(index)))
  const queue = [...targets]
  let triggered = 0

  while (queue.length) {
    const index = queue.pop()
    const tile = board.value[index]
    if (!tile?.special || alreadyTriggered.has(index)) continue
    alreadyTriggered.add(index)
    triggered += 1

    const effects = getSpecialEffect(board.value, index, tile.type)
    for (const effectIndex of effects) {
      if (protectedCells.has(effectIndex) || targets.has(effectIndex)) continue
      targets.add(effectIndex)
      queue.push(effectIndex)
    }
  }

  return { targets, triggered }
}

async function clearAndDrop(initialTargets, protectedCells = new Set(), alreadyTriggered = new Set(), chain = 0, specialBonus = 0) {
  const { targets, triggered } = expandSpecialEffects(initialTargets, protectedCells, alreadyTriggered)
  const existing = [...targets].filter((index) => board.value[index])
  if (existing.length === 0) return { cleared: 0, triggered: 0 }

  clearingCells.value = new Set(existing)
  score.value += Math.round(existing.length * 10 * (1 + chain * 0.5)) + specialBonus + triggered * 35
  await wait(130)

  const next = [...board.value]
  for (const index of existing) next[index] = null

  for (let x = 0; x < MATCH_BOARD_SIZE; x += 1) {
    const column = []
    for (let y = MATCH_BOARD_SIZE - 1; y >= 0; y -= 1) {
      const tile = next[y * MATCH_BOARD_SIZE + x]
      if (tile) column.push(tile)
    }
    while (column.length < MATCH_BOARD_SIZE) {
      column.push(newTile(Math.floor(Math.random() * 6)))
    }
    for (let y = MATCH_BOARD_SIZE - 1; y >= 0; y -= 1) {
      next[y * MATCH_BOARD_SIZE + x] = column[MATCH_BOARD_SIZE - 1 - y]
    }
  }

  board.value = next
  clearingCells.value = new Set()
  await wait(190)
  return { cleared: existing.length, triggered }
}

async function resolveMatches(preferredIndex = null, directTargets = null, directTriggered = new Set()) {
  let groups = getMatchGroups(board.value)
  let firstPass = true
  let chain = 0
  let nextDirectTargets = directTargets
  let triggeredSpecials = directTriggered
  // Keep specials created during this resolution from being consumed by a gravity cascade.
  const freshSpecials = new Set()

  while (groups.length > 0 || nextDirectTargets?.size) {
    const protectedCells = new Set(freshSpecials)
    const clearTargets = new Set(nextDirectTargets ?? [])
    let specialBonus = 0

    for (const group of groups) {
      let anchor = null
      if (group.special) {
        anchor = getSpecialAnchor(group, firstPass ? preferredIndex : null)
        const tile = board.value[anchor]
        if (tile) {
          tile.special = group.special
          protectedCells.add(anchor)
          freshSpecials.add(anchor)
          specialBonus += 50
        }
      }
      group.cells.forEach((index) => {
        if (index !== anchor) clearTargets.add(index)
      })
    }

    if (clearTargets.size === 0) break
    const result = await clearAndDrop(clearTargets, protectedCells, triggeredSpecials, chain, specialBonus)
    if (result.cleared === 0) break

    groups = getMatchGroups(board.value)
    nextDirectTargets = null
    triggeredSpecials = new Set()
    preferredIndex = null
    firstPass = false
    chain += 1
  }

  if (!hasLegalMove(board.value)) {
    board.value = createFreshBoard().map((tile) => newTile(tile.type))
    showToast('棋盘已重新排列')
  }
}

async function swapCells(firstIndex, secondIndex) {
  const next = [...board.value]
  ;[next[firstIndex], next[secondIndex]] = [next[secondIndex], next[firstIndex]]
  board.value = next
  await wait(100)

  const first = board.value[firstIndex]
  const second = board.value[secondIndex]
  let directTargets = null
  let alreadyTriggered = new Set()
  if (first.special === 'color-bomb' || second.special === 'color-bomb') {
    directTargets = getComboTargets(firstIndex, secondIndex)
    alreadyTriggered = new Set([firstIndex, secondIndex])
  } else if (getMatchGroups(board.value).length === 0) {
    const reverted = [...board.value]
    ;[reverted[firstIndex], reverted[secondIndex]] = [reverted[secondIndex], reverted[firstIndex]]
    board.value = reverted
    selectedIndex.value = null
    return false
  }

  if (mode.value === 'ranked') moves.value = Math.max(0, moves.value - 1)
  selectedIndex.value = null
  busy.value = true
  await resolveMatches(directTargets ? null : secondIndex, directTargets, alreadyTriggered)
  busy.value = false

  if (mode.value === 'ranked' && moves.value === 0) finishGame()
  return true
}

async function selectCell(index) {
  if (status.value !== 'playing' || busy.value) return
  if (selectedIndex.value == null) {
    selectedIndex.value = index
    return
  }
  if (selectedIndex.value === index) {
    selectedIndex.value = null
    return
  }

  const firstIndex = selectedIndex.value
  if (!areAdjacent(firstIndex, index)) {
    selectedIndex.value = index
    return
  }
  await swapCells(firstIndex, index)
}

function finishGame() {
  if (mode.value === 'endless' && score.value > endlessBest.value) {
    endlessBest.value = score.value
    writeEndlessBest(score.value)
  }
  status.value = 'over'
  selectedIndex.value = null
}

function exitEndless() {
  if (mode.value === 'endless' && status.value === 'playing') finishGame()
}

function returnToModeSelect() {
  status.value = 'select'
  mode.value = null
  selectedIndex.value = null
  busy.value = false
}

onMounted(() => {
  // Eagerly decode the small icon set once the player enters this game.
  Object.values(normalImages).forEach((src) => { const image = new Image(); image.src = src })
})

onBeforeUnmount(() => window.clearTimeout(toastTimer))
</script>

<template>
  <main class="match-three-page">
    <header class="match-header">
      <button type="button" class="match-back" @click="goBack"><span>←</span> 返回游廊</button>
      <div class="match-brand"><span class="match-brand-moon">✧</span><strong>月下消消乐</strong></div>
      <span class="match-header-label">DREAM 07 · MATCH THREE</span>
    </header>

    <section v-if="status === 'select'" class="match-mode-screen">
      <div class="match-intro">
        <p class="match-eyebrow">A LITTLE DREAM OF MATCHING</p>
        <h1>月下消消乐</h1>
        <p>交换相邻的角色方块，连成三枚以上即可消除。四消、五消与 L/T 形会唤醒特别效果。</p>
      </div>

      <div class="match-mode-cards">
        <button class="match-mode-card ranked-mode" type="button" @click="startMode('ranked')">
          <span class="mode-card-icon">30</span>
          <span class="mode-card-copy"><small>RANKED CHALLENGE</small><strong>排位模式</strong><em>30 步挑战，结束后显示本局成绩。排行榜暂未接入。</em></span>
          <span class="mode-card-arrow">↗</span>
        </button>
        <button class="match-mode-card endless-mode" type="button" @click="startMode('endless')">
          <span class="mode-card-icon">∞</span>
          <span class="mode-card-copy"><small>ENDLESS PLAY</small><strong>无尽模式</strong><em>不限步数，可随时结束；分数仅保存在本机。</em></span>
          <span class="mode-card-arrow">↗</span>
        </button>
      </div>

      <div class="match-mode-note"><span>✦</span> 六种角色方块 · 八乘八棋盘 · 特殊效果可连锁触发</div>
    </section>

    <section v-else class="match-game-screen">
      <div class="match-game-heading">
        <div>
          <p class="match-eyebrow">{{ mode === 'ranked' ? 'RANKED CHALLENGE' : 'ENDLESS PLAY' }}</p>
          <h1>{{ modeTitle }}</h1>
        </div>
        <p class="match-score-tip">{{ scoreTip }}</p>
      </div>

      <div class="match-game-layout">
        <aside class="match-stats" aria-label="本局数据">
          <div class="match-stat score-stat"><span>本局分数</span><strong>{{ score.toLocaleString() }}</strong></div>
          <div class="match-stat"><span>剩余步数</span><strong>{{ moveLabel }}</strong></div>
          <div v-if="mode === 'endless'" class="match-stat"><span>本机最高分</span><strong>{{ endlessBest.toLocaleString() }}</strong></div>
          <div class="match-next-tip"><span>操作提示</span><p>点选一枚方块，再点选上下左右相邻的一枚进行交换。</p></div>
          <button v-if="mode === 'endless' && status === 'playing'" class="match-end-button" type="button" :disabled="busy" @click="exitEndless">结束本局</button>
        </aside>

        <div class="match-board-column">
          <div class="match-board-frame">
            <div class="match-board" :style="{ backgroundImage: `url('${boardTexture}')` }" :aria-busy="busy">
              <button
                v-for="(tile, index) in board"
                :key="tile?.id ?? `empty-${index}`"
                class="match-cell"
                :class="{
                  'is-selected': selectedIndex === index,
                  'is-clearing': clearingCells.has(index),
                  'is-special': Boolean(tile?.special),
                }"
                :data-gem="tile?.type"
                :disabled="busy || status !== 'playing'"
                :aria-label="tile ? `${gemNames[tile.type]}${tile.special ? `，${specialNames[tile.special]}` : ''}` : '空格'"
                :aria-pressed="selectedIndex === index"
                @click="selectCell(index)"
              >
                <img v-if="tile" :src="imageFor(tile)" alt="" draggable="false" />
              </button>
            </div>
            <div v-if="toast" class="match-toast" role="status">{{ toast }}</div>
            <div v-if="status === 'over'" class="match-result-shade">
              <div class="match-result-card">
                <p class="match-eyebrow">{{ mode === 'ranked' ? 'CHALLENGE COMPLETE' : 'ENDLESS COMPLETE' }}</p>
                <h2>{{ mode === 'ranked' ? '挑战结束' : '本局结束' }}</h2>
                <p class="match-final-score">{{ score.toLocaleString() }} <span>分</span></p>
                <p v-if="mode === 'ranked'" class="match-result-note">本局成绩已记录在此页面，排行榜功能暂未接入。</p>
                <p v-else class="match-result-note">无尽模式成绩只保存在本机，不计入排名。</p>
                <div class="match-result-actions">
                  <button class="match-primary-button" type="button" @click="startMode(mode)">再玩一局</button>
                  <button class="match-secondary-button" type="button" @click="returnToModeSelect">选择模式</button>
                </div>
              </div>
            </div>
          </div>
          <p class="match-board-caption">交换相邻方块 · 连成三枚或以上即可消除</p>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.match-three-page{min-height:100vh;color:#f5f7ff;background:radial-gradient(ellipse at 50% -12%,#344d96 0,#152450 42%,#080f29 100%);font-family:var(--sans,Arial,sans-serif);overflow:auto}
.match-header{height:64px;padding:0 clamp(16px,4vw,56px);display:grid;grid-template-columns:1fr auto 1fr;align-items:center;border-bottom:1px solid rgba(220,237,255,.16);background:rgba(4,10,31,.42);backdrop-filter:blur(18px)}
.match-back{justify-self:start;border:0;padding:9px 0;color:rgba(238,245,255,.74);background:transparent;font:inherit;font-size:12px;cursor:pointer}.match-back span{margin-right:8px;color:#b6e8ff;font-size:16px}
.match-brand{display:flex;align-items:center;gap:10px;font-family:var(--serif,Georgia,serif);letter-spacing:.1em;font-size:14px}.match-brand-moon{display:grid;width:26px;height:26px;place-items:center;border:1px solid rgba(207,238,255,.66);border-radius:50%;color:#dff7ff;box-shadow:0 0 20px rgba(133,211,255,.3)}
.match-header-label{justify-self:end;color:rgba(205,225,255,.48);font-size:9px;letter-spacing:.18em}
.match-mode-screen{width:min(1040px,calc(100% - 40px));margin:0 auto;padding:clamp(42px,8vh,90px) 0 50px}.match-intro{text-align:center}.match-eyebrow{margin:0 0 10px;color:#a9e4ff;font-size:9px;letter-spacing:.24em}.match-intro h1,.match-game-heading h1{margin:0;font-family:var(--serif,Georgia,serif);font-size:clamp(34px,5vw,58px);font-weight:500;letter-spacing:.1em;text-shadow:0 0 34px rgba(134,198,255,.22)}.match-intro>p:last-child{max-width:600px;margin:16px auto 0;color:rgba(224,234,255,.68);font-family:var(--serif,Georgia,serif);font-size:13px;line-height:1.9}
.match-mode-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:42px auto 0}.match-mode-card{position:relative;min-height:172px;padding:25px;display:flex;align-items:center;gap:20px;overflow:hidden;text-align:left;border:1px solid rgba(198,228,255,.24);border-radius:8px;color:#f5f7ff;background:linear-gradient(135deg,rgba(47,69,130,.62),rgba(10,19,54,.8));box-shadow:0 20px 60px rgba(0,0,20,.2);cursor:pointer;transition:transform .22s ease,border-color .22s ease,box-shadow .22s ease}.match-mode-card:hover{transform:translateY(-4px);border-color:rgba(190,234,255,.68);box-shadow:0 24px 72px rgba(36,67,156,.32)}.match-mode-card:focus-visible,.match-back:focus-visible,.match-cell:focus-visible,.match-end-button:focus-visible,.match-primary-button:focus-visible,.match-secondary-button:focus-visible{outline:2px solid #c3ecff;outline-offset:3px}.ranked-mode:before,.endless-mode:before{content:'';position:absolute;width:170px;height:170px;right:4%;top:-50px;border-radius:50%;background:#7cceff;opacity:.13;filter:blur(48px);pointer-events:none}.endless-mode:before{background:#c495ff}
.mode-card-icon{position:relative;flex:0 0 58px;height:58px;display:grid;place-items:center;border:1px solid rgba(207,236,255,.58);border-radius:50%;color:#d9f6ff;font-family:var(--serif,Georgia,serif);font-size:22px;box-shadow:0 0 26px rgba(120,204,255,.24)}.endless-mode .mode-card-icon{color:#efdfff;box-shadow:0 0 26px rgba(187,138,255,.25)}.mode-card-copy{position:relative;display:grid;gap:7px}.mode-card-copy small{color:#a9dff9;font-size:8px;letter-spacing:.19em}.endless-mode .mode-card-copy small{color:#d2b6ff}.mode-card-copy strong{font-family:var(--serif,Georgia,serif);font-size:24px;font-weight:500;letter-spacing:.1em}.mode-card-copy em{max-width:300px;color:rgba(228,236,255,.62);font-size:11px;font-style:normal;line-height:1.7}.mode-card-arrow{position:absolute;right:22px;bottom:19px;color:rgba(221,241,255,.7);font-size:16px}.match-mode-note{margin:27px 0 0;text-align:center;color:rgba(218,232,255,.5);font-size:10px;letter-spacing:.06em}.match-mode-note span{margin-right:8px;color:#bcecff}
.match-game-screen{width:min(1180px,calc(100% - 36px));margin:0 auto;padding:24px 0 30px}.match-game-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin:0 0 18px}.match-game-heading .match-eyebrow{margin-bottom:4px}.match-game-heading h1{font-size:clamp(25px,3vw,35px)}.match-score-tip{margin:0 0 4px;color:rgba(221,234,255,.55);font-size:10px}.match-game-layout{display:grid;grid-template-columns:minmax(170px,220px) minmax(0,1fr);align-items:center;gap:clamp(18px,4vw,58px);max-width:1120px;margin:0 auto}.match-stats{display:grid;gap:15px}.match-stat{padding:15px 17px;border:1px solid rgba(214,234,255,.16);border-radius:6px;background:rgba(7,16,47,.55);box-shadow:inset 0 0 30px rgba(114,163,255,.04)}.match-stat span,.match-next-tip>span{display:block;color:rgba(222,235,255,.52);font-size:10px;letter-spacing:.08em}.match-stat strong{display:block;margin-top:6px;color:#fff;font-family:var(--serif,Georgia,serif);font-size:27px;font-weight:500}.score-stat strong{color:#c6efff;text-shadow:0 0 18px rgba(109,209,255,.24)}.match-next-tip{padding:4px 3px;color:rgba(220,233,255,.58)}.match-next-tip p{margin:7px 0 0;font-size:11px;line-height:1.75}.match-end-button{height:40px;border:1px solid rgba(221,235,255,.35);border-radius:999px;color:#fff;background:rgba(145,122,205,.13);font:inherit;font-size:11px;cursor:pointer}.match-end-button:disabled{opacity:.45;cursor:wait}
.match-board-column{min-width:0}.match-board-frame{position:relative;width:min(100%,min(78vh,800px));aspect-ratio:1;margin:0 auto;padding:0;border:1px solid rgba(183,221,255,.58);border-radius:4px;background:linear-gradient(145deg,rgba(139,193,255,.18),rgba(22,50,113,.36));box-shadow:0 20px 65px rgba(0,0,20,.44),0 0 44px rgba(106,194,255,.11);overflow:hidden}.match-board{position:absolute;inset:0;display:grid;grid-template-columns:repeat(8,minmax(0,1fr));grid-template-rows:repeat(8,minmax(0,1fr));background-size:100% 100%;background-position:center;touch-action:manipulation}.match-cell{position:relative;min-width:0;min-height:0;padding:6%;display:grid;place-items:center;border:0;background:transparent;cursor:pointer;transition:filter .14s ease,transform .14s ease}.match-cell:not(.is-special):before{content:"";position:absolute;inset:4%;border:1px solid rgba(var(--gem-glow),.42);border-radius:14%;background:radial-gradient(circle,rgba(var(--gem-glow),.24),rgba(var(--gem-glow),.16) 66%,rgba(var(--gem-glow),.08));box-shadow:inset 0 0 10px rgba(var(--gem-glow),.12),0 0 9px rgba(var(--gem-glow),.2);pointer-events:none}.match-cell.is-special:before{content:"";position:absolute;inset:1%;border:1px solid rgba(var(--gem-glow),.82);border-radius:16%;background:radial-gradient(circle,rgba(var(--gem-glow),.32),rgba(var(--gem-glow),.2) 66%,rgba(var(--gem-glow),.1));box-shadow:inset 0 0 16px rgba(var(--gem-glow),.32),0 0 19px rgba(var(--gem-glow),.54);animation:special-pulse 1.8s ease-in-out infinite alternate;pointer-events:none}.match-cell.is-special:after{content:"";position:absolute;z-index:2;inset:1%;border-radius:16%;background:conic-gradient(from 0deg,transparent 0 69%,rgba(255,255,255,.88) 75%,rgba(var(--gem-glow),.88) 79%,transparent 86% 100%);mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1px));animation:special-ring 3.4s linear infinite;pointer-events:none}.match-cell[data-gem="0"]{--gem-glow:177,139,255}.match-cell[data-gem="1"]{--gem-glow:164,219,103}.match-cell[data-gem="2"]{--gem-glow:91,186,245}.match-cell[data-gem="3"]{--gem-glow:152,119,248}.match-cell[data-gem="4"]{--gem-glow:246,139,186}.match-cell[data-gem="5"]{--gem-glow:239,91,112}.match-cell img{position:relative;z-index:1;display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(3,13,47,.24));transition:transform .15s ease,filter .15s ease}.match-cell:hover img{transform:scale(1.07)}.match-cell.is-selected{z-index:2;background:radial-gradient(circle,rgba(242,251,255,.55),rgba(189,231,255,.22) 65%,transparent 75%);box-shadow:inset 0 0 0 2px rgba(255,255,255,.84),0 0 20px rgba(178,235,255,.56);animation:cell-pulse .8s ease-in-out infinite alternate}.match-cell.is-selected img{transform:scale(1.09)}.match-cell.is-clearing:after{content:"";position:absolute;inset:12%;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.95),rgba(159,225,255,.58) 35%,rgba(115,147,255,.16) 70%,transparent);animation:clear-burst .2s ease-out both;pointer-events:none}.match-cell.is-clearing img{transform:scale(.56);opacity:0;filter:brightness(2.3);transition:transform .12s ease,opacity .12s ease,filter .12s ease}.match-cell.is-special img{filter:drop-shadow(0 0 8px rgba(181,226,255,.58));animation:special-glint 2.8s ease-in-out infinite}.match-cell img{animation:gem-enter .22s cubic-bezier(.18,.75,.35,1.2) both}.match-toast{position:absolute;z-index:4;left:50%;top:10px;transform:translateX(-50%);padding:7px 14px;border:1px solid rgba(235,247,255,.46);border-radius:99px;color:#fff;background:rgba(13,28,72,.82);font-size:10px;white-space:nowrap;box-shadow:0 6px 20px rgba(0,0,30,.32)}.match-board-caption{margin:11px 0 0;text-align:center;color:rgba(219,233,255,.52);font-size:10px;letter-spacing:.04em}
.match-result-shade{position:absolute;z-index:5;inset:0;display:grid;place-items:center;padding:14px;background:rgba(4,10,33,.62);backdrop-filter:blur(7px)}.match-result-card{width:min(410px,100%);padding:25px 24px;text-align:center;border:1px solid rgba(223,241,255,.48);border-radius:8px;background:linear-gradient(150deg,rgba(39,58,119,.96),rgba(9,18,55,.98));box-shadow:0 18px 70px rgba(0,0,25,.55)}.match-result-card h2{margin:0;font-family:var(--serif,Georgia,serif);font-size:30px;font-weight:500;letter-spacing:.12em}.match-final-score{margin:17px 0 8px;color:#d6f5ff;font-family:var(--serif,Georgia,serif);font-size:44px;text-shadow:0 0 28px rgba(129,221,255,.25)}.match-final-score span{font-size:15px}.match-result-note{margin:0;color:rgba(222,235,255,.58);font-size:10px;line-height:1.65}.match-result-actions{display:flex;justify-content:center;gap:10px;margin-top:20px}.match-primary-button,.match-secondary-button{min-height:38px;padding:0 16px;border:1px solid rgba(223,242,255,.66);border-radius:999px;color:#132047;background:#e8f7ff;font:inherit;font-size:10px;cursor:pointer}.match-secondary-button{color:#fff;background:rgba(255,255,255,.08)}
@keyframes cell-pulse{to{box-shadow:inset 0 0 0 2px rgba(255,255,255,.44),0 0 9px rgba(178,235,255,.3)}}@keyframes gem-enter{from{transform:translateY(-16%) scale(.78);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}@keyframes clear-burst{from{transform:scale(.35);opacity:.2}to{transform:scale(1.15);opacity:1}}@keyframes special-pulse{from{opacity:.72;box-shadow:inset 0 0 12px rgba(var(--gem-glow),.22),0 0 12px rgba(var(--gem-glow),.38)}to{opacity:1;box-shadow:inset 0 0 19px rgba(var(--gem-glow),.4),0 0 25px rgba(var(--gem-glow),.72)}}@keyframes special-ring{to{transform:rotate(360deg)}}@keyframes special-glint{0%,100%{filter:drop-shadow(0 0 6px rgba(181,226,255,.38))}50%{filter:drop-shadow(0 0 12px rgba(207,240,255,.88))}}
@media(max-width:760px){.match-header{height:58px;padding:0 14px}.match-header-label{font-size:7px;letter-spacing:.1em}.match-brand{font-size:12px}.match-mode-screen{padding-top:45px}.match-mode-cards{grid-template-columns:1fr;gap:12px;margin-top:30px}.match-mode-card{min-height:138px;padding:19px}.match-game-screen{width:min(100% - 20px,540px);padding:14px 0 22px}.match-game-heading{align-items:start;flex-direction:column;gap:3px;margin-bottom:12px}.match-score-tip{font-size:9px}.match-game-layout{grid-template-columns:1fr;gap:11px}.match-stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.match-stat{padding:9px 10px}.match-stat span{font-size:8px}.match-stat strong{font-size:20px}.match-next-tip{display:none}.match-end-button{grid-column:1/-1;height:34px}.match-board-frame{width:min(100%,calc(100dvh - 245px),560px)}.match-board-caption{margin-top:7px;font-size:9px}.match-cell{padding:5%}.match-result-card{padding:20px 15px}.match-result-card h2{font-size:26px}.match-final-score{font-size:38px}}
@media(max-width:390px){.match-mode-card{gap:13px;padding:16px}.mode-card-icon{flex-basis:48px;height:48px;font-size:18px}.mode-card-copy strong{font-size:21px}.mode-card-copy em{font-size:10px}.match-board-frame{width:min(100%,calc(100dvh - 260px),560px)}.match-stat{padding:8px}.match-stat strong{font-size:18px}}
@media(prefers-reduced-motion:reduce){.match-cell,.match-cell img,.match-mode-card{transition:none;animation:none}.match-cell:before,.match-cell:after{animation:none!important}.match-cell.is-selected{animation:none}}
</style>

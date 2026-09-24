<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import humanPiece from '../../p/board-piece-player-purple.png'
import aiPiece from '../../p/board-piece-columbina-pink.png'
import ticTacToeBoard from '../../p/event/tictactoe-board.webp'
import gomokuBoard from '../../p/event/gomoku-board.webp'
import boardBackground from '../../p/event/board-background.webp'
import brandIcon from '../../p/event/brand-icon.png'
import { AI, GAME_STATUS, HUMAN } from '../games/shared.js'
import {
  claimTicTacToeDraw, createTicTacToeState, makeTicTacToeMove, MAX_ACTIVE_PIECES,
} from '../games/ticTacToeEngine.js'
import { TicTacToeAI } from '../games/ticTacToeAI.js'
import { createGomokuState, makeGomokuMove } from '../games/gomokuEngine.js'
import { GomokuAI } from '../games/gomokuAI.js'
import { playSfx } from '../games/sound.js'
import { playVoice, stopVoice, VOICE_EVENTS } from '../games/voice.js'

const props = defineProps({ kind: { type: String, required: true } })
const emit = defineEmits(['back', 'reload', 'result'])

const difficulty = ref('medium')
const firstPlayer = ref(HUMAN)
const setupConfirmed = ref(false)
const thinking = ref(false)
const errorMessage = ref('')
const resultRecorded = ref(false)
let requestId = 0
let aiAbortController = null

const isTicTacToe = computed(() => props.kind === 'tictactoe')
const size = computed(() => isTicTacToe.value ? 3 : 15)
const state = ref(createState())
const title = computed(() => isTicTacToe.value ? '月亮棋' : '星月五子棋')
const subtitle = computed(() => isTicTacToe.value ? '仅保留最近 5 枚棋子' : '先连成五子的一方获胜')
const lastMove = computed(() => state.value.moves.at(-1))
const expiringMove = computed(() => {
  if (!isTicTacToe.value || gameOver.value || state.value.moves.length < MAX_ACTIVE_PIECES) return null
  return state.value.activeMoves[0]
})
const winningCells = computed(() => new Set(state.value.winningLine.map(({ row, col }) => `${row}-${col}`)))
const statusText = computed(() => {
  if (state.value.status === GAME_STATUS.WON) return '🎉 你赢了！'
  if (state.value.status === GAME_STATUS.LOST) return '哥伦比娅赢了'
  if (state.value.status === GAME_STATUS.DRAW) return '🤝 平局'
  return state.value.currentPlayer === HUMAN ? '轮到你落子' : '轮到哥伦比娅落子'
})
const gameOver = computed(() => state.value.status !== GAME_STATUS.PLAYING)
const boardImage = computed(() => isTicTacToe.value ? ticTacToeBoard : gomokuBoard)

function createState() {
  return props.kind === 'tictactoe' ? createTicTacToeState(firstPlayer?.value || HUMAN) : createGomokuState(firstPlayer?.value || HUMAN)
}

function applyMove(current, move) {
  return isTicTacToe.value ? makeTicTacToeMove(current, move) : makeGomokuMove(current, move)
}

function recordResult() {
  if (!gameOver.value || resultRecorded.value) return
  resultRecorded.value = true
  const outcome = state.value.status === GAME_STATUS.WON ? 'wins' : state.value.status === GAME_STATUS.LOST ? 'losses' : 'draws'
  playSfx(outcome === 'wins' ? 'win' : outcome === 'losses' ? 'lose' : 'draw')
  if (outcome === 'wins') playVoice(VOICE_EVENTS.BOARD_PLAYER_WIN)
  else if (outcome === 'losses') playVoice(VOICE_EVENTS.BOARD_COLUMBINA_WIN)
  emit('result', { game: props.kind, outcome })
}

function getTicTacToeWorkerMove(aiState, level, signal) {
  if (typeof Worker === 'undefined') return TicTacToeAI.getBestMove(aiState, level)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../games/ticTacToe.worker.js', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (move, error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(move)
    }
    const abort = () => finish(null)
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event) => {
      if (event.data?.type === 'RESULT') finish(event.data.move || null)
      else if (event.data?.type === 'ERROR') finish(null, new Error(event.data.error))
    }
    worker.onerror = () => finish(null, new Error('月亮棋计算线程启动失败'))
    worker.postMessage({ type: 'SEARCH', state: aiState, difficulty: level })
  })
}

async function askAI() {
  if (state.value.status !== GAME_STATUS.PLAYING || state.value.currentPlayer !== AI) return
  thinking.value = true
  errorMessage.value = ''
  const thisRequest = ++requestId
  aiAbortController?.abort()
  aiAbortController = new AbortController()
  try {
    await nextTick()
    const aiState = JSON.parse(JSON.stringify(state.value))
    const move = isTicTacToe.value
      ? await getTicTacToeWorkerMove(aiState, difficulty.value, aiAbortController.signal)
      : await GomokuAI.getBestMove(aiState, difficulty.value, { signal: aiAbortController.signal })
    if (thisRequest !== requestId || !move) return
    state.value = applyMove(state.value, move)
    playSfx('piece-ai')
    recordResult()
  } catch (error) {
    console.error('[BoardGame AI]', error)
    if (thisRequest === requestId) errorMessage.value = '哥伦比娅暂时走神了，请重新开始本局。'
  } finally {
    if (thisRequest === requestId) thinking.value = false
  }
}

function play(row, col) {
  if (thinking.value || gameOver.value || state.value.currentPlayer !== HUMAN || state.value.board[row][col]) return
  const next = applyMove(state.value, { row, col })
  if (next === state.value) return
  state.value = next
  playSfx('piece')
  if (gameOver.value) recordResult()
  else {
    /* 玩家落子后偶尔说一句（带冷却，不然每手都呛） */
    playVoice(VOICE_EVENTS.BOARD_MOVE, { chance: 0.4, cooldown: 6500 })
    window.setTimeout(askAI, 180)
  }
}

function resetRound() {
  requestId += 1
  aiAbortController?.abort()
  thinking.value = false
  errorMessage.value = ''
  resultRecorded.value = false
  state.value = createState()
  if (firstPlayer.value === AI) window.setTimeout(askAI, 120)
}

function beginGame() {
  setupConfirmed.value = true
  resetRound()
}

/* 五子棋重开改成重挂组件（交给 App 的 reloadBoard）；月亮棋仍走局部重置 */
function restart() {
  if (props.kind !== 'gomoku') {
    playSfx('ui')
    resetRound()
    return
  }
  playSfx('ui')
  stopVoice()
  requestId += 1
  aiAbortController?.abort()
  emit('reload')
}

function changeDifficulty() {
  playSfx('ui')
  /* “要我让你一点吗”——只有让子的档位才有这句 */
  if (difficulty.value !== 'hard') playVoice(VOICE_EVENTS.BOARD_HANDICAP)
}

function claimDraw() {
  state.value = claimTicTacToeDraw(state.value)
  recordResult()
}

function leave() {
  playSfx('ui')
  stopVoice()
  requestId += 1
  aiAbortController?.abort()
  emit('back')
}

function cellLabel(row, col) {
  const value = state.value.board[row][col]
  return `第 ${row + 1} 行第 ${col + 1} 列${value ? `，${value === HUMAN ? '你的' : '哥伦比娅的'}棋子` : '，空位'}`
}

function pieceRotation(player, index) {
  const variation = (index % 5) - 2
  return `${(player === HUMAN ? -3 : 3) + variation}deg`
}

onBeforeUnmount(() => { requestId += 1; aiAbortController?.abort(); stopVoice() })
</script>

<template>
  <section
    class="board-page"
    :class="isTicTacToe ? 'ttt-page' : 'gomoku-page'"
    :style="{ backgroundImage: `linear-gradient(180deg, rgba(5, 12, 48, .48), rgba(5, 12, 48, .78)), url('${boardBackground}')` }"
  >
    <header class="board-topbar">
      <button class="board-back" type="button" aria-label="返回小游戏大厅" @click="leave">← 返回大厅</button>
      <div class="board-brand"><span><img :src="isTicTacToe ? humanPiece : aiPiece" alt="" /></span><strong>{{ title }}</strong></div>
    </header>

    <main class="board-main">
      <aside class="board-panel setup-panel">
        <p class="board-kicker">YOU VS COLUMBINA</p>
        <h1>{{ title }}</h1>
        <p class="board-subtitle">{{ subtitle }}</p>

        <div class="piece-key">
          <span><img :src="humanPiece" alt="" />你 · {{ isTicTacToe ? 'X' : '黑棋' }}</span>
          <span><img :src="aiPiece" alt="" />哥伦比娅 · {{ isTicTacToe ? 'O' : '白棋' }}</span>
        </div>
      </aside>

      <section class="play-area" aria-live="polite">
        <div class="turn-banner" :class="{ finished: gameOver }">
          <span class="turn-pulse"></span><img v-if="state.status === GAME_STATUS.LOST" class="columbina-win-icon" :src="brandIcon" alt="" /><strong>{{ statusText }}</strong><small>第 {{ state.moveCount + (gameOver ? 0 : 1) }} 手</small>
        </div>

        <div class="board-wrap">
          <div class="game-board" :class="isTicTacToe ? 'ttt-board' : 'gomoku-board'" :style="{ '--board-size': size, backgroundImage: `url('${boardImage}')` }" role="grid" :aria-label="`${title}棋盘`">
            <button
              v-for="(_, index) in size * size"
              :key="index"
              class="board-cell"
              :class="{
                occupied: state.board[Math.floor(index / size)][index % size],
                latest: lastMove?.row === Math.floor(index / size) && lastMove?.col === index % size,
                expiring: expiringMove?.row === Math.floor(index / size) && expiringMove?.col === index % size,
                winning: winningCells.has(`${Math.floor(index / size)}-${index % size}`),
              }"
              type="button"
              role="gridcell"
              :aria-label="cellLabel(Math.floor(index / size), index % size)"
              :disabled="thinking || gameOver || state.currentPlayer !== HUMAN || Boolean(state.board[Math.floor(index / size)][index % size])"
              @click="play(Math.floor(index / size), index % size)"
            >
              <span class="grid-dot"></span>
              <img v-if="state.board[Math.floor(index / size)][index % size]" class="board-piece" :class="state.board[Math.floor(index / size)][index % size]" :style="{ '--piece-turn': pieceRotation(state.board[Math.floor(index / size)][index % size], index) }" :src="state.board[Math.floor(index / size)][index % size] === HUMAN ? humanPiece : aiPiece" alt="" />
            </button>
          </div>
        </div>

        <p v-if="errorMessage" class="board-error">{{ errorMessage }}</p>
        <div class="board-actions">
          <button type="button" @click="restart">重新开始</button>
          <button v-if="isTicTacToe && state.drawAvailable && !gameOver" class="draw-button" type="button" @click="claimDraw">判定平局</button>
        </div>

        <div v-if="gameOver" class="board-result-overlay">
          <div class="result-panel">
            <strong><img v-if="state.status === GAME_STATUS.LOST" class="columbina-win-icon result-icon" :src="brandIcon" alt="" />{{ statusText }}</strong><span>本局共 {{ state.moveCount }} 手</span>
            <div><button type="button" @click="restart">再来一局</button><button type="button" @click="leave">返回大厅</button></div>
          </div>
        </div>
      </section>
    </main>
    <div v-if="!setupConfirmed" class="setup-overlay" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <form class="setup-dialog" @submit.prevent="beginGame">
        <p class="board-kicker">PLAY WITH COLUMBINA</p>
        <h2 id="setup-title">和哥伦比娅下棋</h2>
        <p>开始之前，决定她要让你多少，以及谁先落子。</p>

        <fieldset @change="changeDifficulty">
          <legend>哥伦比娅问：“要我让让你吗？”</legend>
          <div class="option-row">
            <label v-for="item in [['easy','多让一点'],['medium','稍微让让'],['hard','不用让']]" :key="item[0]">
              <input v-model="difficulty" type="radio" :value="item[0]" />
              <span>{{ item[1] }}</span>
            </label>
          </div>
        </fieldset>

        <fieldset @change="playSfx('ui')">
          <legend>谁先落子？</legend>
          <div class="option-row two">
            <label><input v-model="firstPlayer" type="radio" :value="HUMAN" /><span>你先手</span></label>
            <label><input v-model="firstPlayer" type="radio" :value="AI" /><span>哥伦比娅先手</span></label>
          </div>
        </fieldset>

        <div class="setup-dialog-actions">
          <button type="button" @click="leave">返回大厅</button>
          <button class="setup-start" type="submit">开始对局 →</button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.board-page{--bg:#f3efe6;--panel:#fffdf8;--ink:#171717;--muted:#706d66;--line:#242424;--accent:#d9ff55;--pink:#f5b6d1;min-height:var(--app-vh,800px);background:var(--bg);color:var(--ink);font-family:Inter,"Microsoft YaHei",sans-serif;transition:.2s;background-color:.2s}
.board-page.dark{--bg:#111310;--panel:#1d211b;--ink:#f5f1e9;--muted:#aaa99f;--line:#d9ded0;--accent:#c8ef4d;--pink:#d98eae}
.board-topbar{height:68px;padding:0 clamp(16px,4cqw,56px);border-bottom:2px solid var(--line);display:grid;grid-template-columns:1fr auto 1fr;align-items:center;background:var(--panel);position:sticky;top:0;z-index:20}
.board-back,.theme-toggle{border:0;background:transparent;color:var(--ink);font-weight:800;cursor:pointer}.theme-toggle{justify-self:end}.board-brand{display:flex;align-items:center;gap:9px}.board-brand span{width:31px;height:31px;border:2px solid var(--line);border-radius:50%;display:grid;place-items:center;background:var(--accent);color:#171717;font-weight:900}
.board-main{max-width:1500px;margin:auto;padding:clamp(14px,2.5cqw,32px);display:grid;grid-template-columns:minmax(220px,270px) minmax(320px,720px) minmax(210px,260px);gap:clamp(14px,2cqw,28px);align-items:start}.board-panel{background:var(--panel);border:2px solid var(--line);box-shadow:6px 6px 0 var(--line);padding:22px}.board-kicker{font:800 10px ui-monospace,monospace;letter-spacing:.15em;margin:0 0 12px}.setup-panel h1{font-size:clamp(28px,4cqw,46px);margin:0;line-height:1}.board-subtitle{color:var(--muted);font-size:13px;margin:12px 0 25px}.setup-panel fieldset{border:0;padding:0;margin:0 0 19px}.setup-panel legend{font-size:12px;font-weight:900;margin-bottom:9px}.option-row{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.option-row.two{grid-template-columns:1fr 1fr}.option-row input{position:absolute;opacity:0}.option-row span{display:block;border:1px solid var(--line);padding:9px 4px;text-align:center;font-size:12px;cursor:pointer}.option-row input:checked+span{background:var(--accent);color:#171717;box-shadow:2px 2px 0 var(--line)}
.piece-key{border-top:1px solid color-mix(in srgb,var(--line) 30%,transparent);padding-top:15px;display:flex;gap:14px;flex-wrap:wrap}.piece-key span{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:700}.piece-key img{width:26px;height:26px;object-fit:contain}
.play-area{min-width:0}.turn-banner{height:48px;padding:0 14px;margin-bottom:12px;border:2px solid var(--line);background:var(--panel);display:flex;align-items:center;gap:9px}.turn-banner small{margin-left:auto;color:var(--muted)}.turn-pulse{width:10px;height:10px;border:2px solid var(--line);border-radius:50%;background:var(--accent)}.turn-banner.thinking .turn-pulse{animation:pulse 1s infinite}.turn-banner.finished{background:var(--accent);color:#171717}
.board-wrap{position:relative;margin:auto;width:min(100%,650px);aspect-ratio:1}.game-board{display:grid;grid-template-columns:repeat(var(--board-size),1fr);width:100%;height:100%;border:2px solid #171717;background:#d5ac6e;padding:3.1%;box-shadow:8px 8px 0 var(--line)}.board-cell{position:relative;min-width:0;min-height:0;border:0;background:transparent;padding:0;cursor:pointer}.board-cell::before,.board-cell::after{content:"";position:absolute;background:rgba(27,22,16,.68)}.board-cell::before{height:1px;left:0;right:0;top:50%}.board-cell::after{width:1px;top:0;bottom:0;left:50%}.board-cell:not(:disabled):hover{background:rgba(217,255,85,.3)}.grid-dot{position:absolute;z-index:1;left:50%;top:50%;width:3px;height:3px;background:#171717;border-radius:50%;transform:translate(-50%,-50%)}.board-piece{position:absolute;z-index:3;inset:8%;width:84%;height:84%;object-fit:contain;animation:piece-in .2s ease-out}.ttt-board{padding:7%;gap:2px;background:var(--panel)}.ttt-board .board-cell{border:2px solid var(--line)}.ttt-board .board-cell::before,.ttt-board .board-cell::after,.ttt-board .grid-dot{display:none}.ttt-board .board-piece{inset:12%;width:76%;height:76%}.board-cell.latest .board-piece{filter:drop-shadow(0 0 0 var(--accent)) drop-shadow(0 0 5px var(--accent))}.board-cell.latest::marker{color:var(--accent)}.board-cell.winning{background:rgba(217,255,85,.65)}.board-cell.winning .board-piece{transform:scale(1.08)}
.thinking-mask{position:absolute;z-index:6;inset:0;background:rgba(20,20,20,.25);backdrop-filter:blur(1px);display:grid;place-content:center;text-align:center;color:white;font-weight:900}.thinking-mask span{width:38px;height:38px;border:4px solid rgba(255,255,255,.4);border-top-color:var(--accent);border-radius:50%;margin:auto;animation:spin .8s linear infinite}.board-actions{display:flex;justify-content:center;gap:8px;margin-top:20px;flex-wrap:wrap}.board-actions button,.result-panel button{border:2px solid var(--line);background:var(--panel);color:var(--ink);font-weight:850;padding:10px 18px;cursor:pointer;box-shadow:3px 3px 0 var(--line)}.board-actions button:disabled{opacity:.35;cursor:not-allowed;box-shadow:none}.board-actions .draw-button{background:var(--pink);color:#171717}.board-error{background:#a42b2b;color:white;padding:10px;text-align:center;font-size:12px}.result-panel{margin-top:14px;border:2px solid var(--line);background:var(--accent);color:#171717;padding:18px;text-align:center}.result-panel>strong{display:block;font-size:24px}.result-panel>span{font-size:12px}.result-panel div{display:flex;justify-content:center;gap:8px;margin-top:12px}.result-panel button{background:#fff;color:#171717}
@keyframes piece-in{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}@keyframes piece-expiring{0%,100%{opacity:1}50%{opacity:.25}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{transform:scale(1.5);opacity:.5}}
@container app (max-width: 1050px){.board-main{grid-template-columns:220px 1fr}}
@container app (max-width: 720px){.board-topbar{height:58px;padding:0 13px}.board-brand strong{font-size:13px}.board-main{display:flex;flex-direction:column;padding:10px}.play-area,.setup-panel{width:100%}.setup-panel{padding:15px;box-shadow:3px 3px 0 var(--line)}.setup-panel h1,.board-kicker,.board-subtitle,.piece-key{display:none}.setup-panel fieldset{display:inline-block;width:49%;vertical-align:top;margin:0}.option-row span{padding:7px 2px;font-size:10px}.board-wrap{width:min(94cqw,650px)}.game-board{box-shadow:4px 4px 0 var(--line)}.turn-banner{margin-top:2px}.board-actions{margin-top:13px}.theme-toggle,.board-back{font-size:11px}.gomoku-board .board-piece{inset:2%;width:96%;height:96%}}
.board-cell.expiring .board-piece {
  animation: piece-expiring 1.6s ease-in-out infinite;
}
.board-piece {
  rotate: var(--piece-turn, 0deg);
}
.setup-overlay{position:fixed;z-index:50;inset:0;background:rgba(18,18,18,.62);backdrop-filter:blur(5px);display:grid;place-items:center;padding:18px}.setup-dialog{width:min(520px,100%);border:2px solid var(--line);background:var(--panel);color:var(--ink);padding:32px;box-shadow:9px 9px 0 var(--line)}.setup-dialog h2{font-size:40px;line-height:1;margin:8px 0 10px}.setup-dialog>p:not(.board-kicker){margin:0 0 27px;color:var(--muted);font-size:13px}.setup-dialog fieldset{border:0;padding:0;margin:0 0 22px}.setup-dialog legend{font-size:13px;font-weight:900;margin-bottom:10px}.setup-dialog-actions{display:grid;grid-template-columns:1fr 1.5fr;gap:9px;margin-top:30px}.setup-dialog-actions button{border:2px solid var(--line);background:var(--panel);color:var(--ink);padding:12px;font-weight:900;cursor:pointer}.setup-dialog-actions .setup-start{background:var(--accent);color:#171717;box-shadow:4px 4px 0 var(--line)}
.board-main {
  max-width: 1100px;
  grid-template-columns: minmax(220px, 270px) minmax(320px, 720px);
}

/* Birthday event visual system */
.board-page,.board-page.dark{--bg:#07112e;--panel:rgba(17,28,74,.78);--ink:#f8f8ff;--muted:rgba(232,239,255,.6);--line:rgba(218,237,255,.36);--accent:#9ce5ff;--pink:#d5a5ec;background:radial-gradient(circle at 50% 0,#203f8c,#07112e 68%);color:var(--ink);font-family:'Outfit','PingFang SC',sans-serif}
.board-topbar{height:66px;border-bottom:1px solid rgba(255,255,255,.18);background:rgba(5,12,40,.74);backdrop-filter:blur(20px)}.board-back,.theme-toggle{font-weight:500;color:rgba(255,255,255,.76)}.board-brand{font-family:'Noto Serif SC','Songti SC',serif;letter-spacing:.08em}.board-brand span{border:1px solid rgba(255,255,255,.48);background:rgba(156,229,255,.14);color:#dff6ff;box-shadow:inset 0 0 15px rgba(136,220,255,.3)}
.board-main{padding:clamp(14px,2.5cqw,30px);gap:clamp(14px,2cqw,28px)}.board-panel{border:1px solid var(--line);background:linear-gradient(145deg,rgba(32,48,105,.75),rgba(8,16,52,.82));box-shadow:0 18px 55px rgba(0,0,30,.28)}.setup-panel h1{font-family:'Noto Serif SC','Songti SC',serif;font-weight:600;letter-spacing:.08em}.board-kicker{color:#9ce5ff}.option-row span{border:1px solid var(--line);border-radius:2px}.option-row input:checked+span{background:rgba(156,229,255,.24);color:#fff;box-shadow:inset 0 0 18px rgba(120,210,255,.15)}
.turn-banner{border:1px solid var(--line);background:rgba(12,23,65,.75);box-shadow:0 10px 35px rgba(0,0,30,.18)}.turn-pulse{border:0;background:#a9efff;box-shadow:0 0 12px #8cdeff}.turn-banner.finished{background:rgba(156,229,255,.25);color:#fff}
.board-wrap{width:min(100%,650px);aspect-ratio:1}.game-board{display:grid;grid-template-columns:repeat(var(--board-size),minmax(0,1fr));grid-template-rows:repeat(var(--board-size),minmax(0,1fr));gap:0;width:100%;height:100%;border:0;background-color:transparent;background-position:center;background-repeat:no-repeat;background-size:100% 100%;box-shadow:none}.board-cell{display:block;width:100%;height:100%;min-width:0;min-height:0;margin:0;border:0!important;border-radius:0;padding:0;appearance:none;-webkit-appearance:none;background:transparent;box-shadow:none;overflow:visible}.board-cell::before,.board-cell::after,.grid-dot{display:none!important}.ttt-board{padding:12.2% 12.1%;background-color:transparent}.gomoku-board{padding:9.05%;background-color:transparent}.board-cell:not(:disabled):hover{background:radial-gradient(circle,rgba(221,248,255,.36),transparent 64%)}.board-piece{inset:5%;width:90%;height:90%;filter:drop-shadow(0 5px 7px rgba(0,5,35,.28));animation:piece-in .2s ease-out}.ttt-board .board-piece{inset:10%;width:80%;height:80%}.gomoku-board .board-piece{inset:-4%;width:108%;height:108%}.board-cell.latest .board-piece{filter:drop-shadow(0 0 8px #c5f2ff)}.board-cell.winning{background:radial-gradient(circle,rgba(199,239,255,.5),transparent 70%)}
.board-actions button,.result-panel button{border:1px solid var(--line);border-radius:999px;background:rgba(125,197,255,.12);color:#fff;box-shadow:none;font-weight:500}.board-actions button:hover,.result-panel button:hover{background:#fff;color:#101b47}.board-actions .draw-button{background:rgba(213,165,236,.25);color:#fff}.result-panel{border:1px solid var(--line);background:rgba(156,229,255,.22);color:#fff}.result-panel>strong{font-family:'Noto Serif SC','Songti SC',serif}
.setup-overlay{background:rgba(3,8,31,.68);backdrop-filter:blur(12px)}.setup-dialog{border:1px solid rgba(224,241,255,.52);background:linear-gradient(145deg,rgba(32,48,105,.94),rgba(8,16,52,.97));color:#fff;box-shadow:0 25px 90px rgba(0,0,30,.55)}.setup-dialog h2{font-family:'Noto Serif SC','Songti SC',serif;font-weight:600;letter-spacing:.06em}.setup-dialog>p:not(.board-kicker){color:var(--muted)}.setup-dialog-actions button{border:1px solid var(--line);border-radius:999px;background:rgba(125,197,255,.1);color:#fff;font-weight:500}.setup-dialog-actions .setup-start{background:rgba(156,229,255,.25);color:#fff;box-shadow:none}.setup-dialog-actions .setup-start:hover{background:#fff;color:#101b47}
@container app (max-width: 720px){.game-board{box-shadow:none}.gomoku-board .board-piece{inset:-6%;width:112%;height:112%}.board-main{padding:8px}.setup-panel{box-shadow:none}}
.board-result-overlay{position:fixed;z-index:60;inset:0;display:grid;place-items:center;padding:18px;background:rgba(3,8,31,.48);backdrop-filter:blur(7px)}.board-result-overlay .result-panel{width:min(420px,94cqw);margin:0;border:1px solid rgba(224,241,255,.52);background:linear-gradient(145deg,rgba(32,48,105,.96),rgba(8,16,52,.98));color:#fff;box-shadow:0 25px 90px rgba(0,0,30,.55);padding:32px}.board-result-overlay .result-panel>strong{font-family:'Noto Serif SC','Songti SC',serif;font-size:34px}.board-result-overlay .result-panel>span{display:block;margin-top:8px;color:rgba(239,244,255,.68)}.board-result-overlay .result-panel button{border:1px solid rgba(255,255,255,.55);border-radius:999px;background:rgba(125,197,255,.16);color:#fff;box-shadow:none}.board-result-overlay .result-panel button:hover{background:#fff;color:#101b47}
.board-brand{min-width:0;white-space:nowrap}.board-brand span{overflow:hidden}.board-brand span img{display:block;width:82%;height:82%;object-fit:contain}.board-brand strong{white-space:nowrap;font-size:clamp(12px,2.1cqw,16px)}
.columbina-win-icon{width:22px;height:22px;object-fit:contain;vertical-align:middle;filter:drop-shadow(0 0 6px rgba(183,229,255,.58))}.result-icon{width:34px;height:34px;margin-right:8px}

/* Keep the board scene and its global navigation anchored to the viewport. */
.board-page{width:100%;background-position:center;background-repeat:no-repeat;background-size:cover}
.board-topbar{position:sticky;width:100%;padding-left:16px;padding-right:16px}
.board-back{position:absolute;z-index:1;top:50%;left:16px;transform:translateY(-50%);white-space:nowrap}
.board-brand{position:absolute;left:50%;transform:translateX(-50%);flex-wrap:nowrap;white-space:nowrap}
.board-brand strong{display:block;white-space:nowrap;word-break:keep-all;overflow-wrap:normal}
.setup-panel h1{font-size:clamp(26px,3cqw,40px);white-space:nowrap;word-break:keep-all;overflow-wrap:normal}
.board-main{width:100%;max-width:none}
@container app (min-width: 721px){
  .board-page{height:var(--app-vh,800px);overflow:hidden}
  .board-main{height:calc(var(--app-vh,800px) - 66px);grid-template-columns:minmax(220px,270px) minmax(0,1fr)}
  .play-area{display:flex;width:100%;height:100%;min-height:0;flex-direction:column}
  .board-wrap{align-self:center;flex:1 1 auto;width:auto;height:auto;min-width:0;min-height:0;max-width:100%;max-height:100%;margin:auto;aspect-ratio:1}
}

/* ===== 设计像素固定弹窗（画布由根 scale 统一缩放；--app-vh 代替 vh） ===== */
.setup-dialog{width:min(520px,100%);max-height:calc(var(--app-vh,800px) - 36px);overflow-y:auto;padding:38px 34px}
.setup-dialog h2{margin:8px 0 10px;font-size:45px}
.setup-dialog>p:not(.board-kicker){margin:0 0 27px;font-size:13px}
.setup-dialog fieldset{margin-bottom:22px;padding:0}
.setup-dialog legend{margin-bottom:10px;font-size:13px}
.setup-dialog .option-row{gap:5px}
.setup-dialog-actions{margin-top:30px;gap:9px}
.setup-dialog-actions button{padding:12px;font-size:14px}
.option-row span{padding:9px 4px;font-size:12px}
.setup-dialog .board-kicker{font-size:10px}
.board-result-overlay .result-panel{width:min(420px,94cqw);max-height:calc(var(--app-vh,800px) - 36px);overflow-y:auto;padding:32px}
.board-result-overlay .result-panel>strong{font-size:34px}
.board-result-overlay .result-panel>span{font-size:12px}
.board-result-overlay .result-panel>div{gap:8px;margin-top:12px}
.board-result-overlay .result-panel button{padding:12px 18px;font-size:14px}
</style>

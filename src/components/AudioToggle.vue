<template>
  <button
    class="audio-toggle"
    :class="{ playing }"
    type="button"
    :aria-label="playing ? '关闭背景音乐' : '播放背景音乐'"
    :aria-pressed="playing"
    :title="playing ? '关闭背景音乐' : '播放背景音乐'"
    @click="toggle"
  >
    <svg class="audio-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path class="spk" d="M11 5.4 6.5 9.1H3.4a1 1 0 0 0-1 1v3.8a1 1 0 0 0 1 1h3.1L11 18.6z" />
      <template v-if="playing">
        <path class="wave" d="M14.5 9.1a4.2 4.2 0 0 1 0 5.8" />
        <path class="wave" d="M17.2 6.4a8 8 0 0 1 0 11.2" />
      </template>
      <path v-else class="slash" d="M14.5 8.7 20.7 15.3" />
    </svg>
  </button>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

/* 用 Web Audio + .bin 资源播放：
   1) 页面上没有 <audio> 元素；
   2) 资源不是 audio/mpeg（octet-stream + .bin），
   两者一起避开国产浏览器（夸克 / QQ / UC 等）的媒体嗅探。 */
const BGM_URL = './audio/nod-krai.bin'
const VOLUME = 0.5

/* 默认开启：图标进站即显示「播放中」 */
const playing = ref(true)

let ctx = null
let rawBuffer = null
let decoded = null
let source = null
let gainNode = null
let loading = null
let hiddenPause = false

/* 进站不主动播放：页面下滑（或首次触摸/点击/按键）后才开始；一直不动就保持安静 */
const SCROLL_TRIGGERS = ['scroll', 'wheel', 'touchmove']
const ACTION_TRIGGERS = ['pointerdown', 'touchstart', 'keydown']
const SCROLLED_PX = 6

let armed = false

function getCtx() {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!ctx) ctx = new AC()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

function loadBuffer() {
  if (decoded) return Promise.resolve(decoded)
  if (loading) return loading
  const c = getCtx()
  if (!c) return Promise.resolve(null)
  loading = fetch(BGM_URL)
    .then((res) => res.arrayBuffer())
    .then((buf) => {
      rawBuffer = buf
      return c.decodeAudioData(buf.slice(0))
    })
    .then((b) => { decoded = b; return b })
    .catch(() => { loading = null; return null })
  return loading
}

function stopAudio() {
  if (source) {
    try { source.stop() } catch { /* 已停止 */ }
    try { source.disconnect() } catch { /* ignore */ }
    source = null
  }
  if (gainNode) {
    try { gainNode.disconnect() } catch { /* ignore */ }
    gainNode = null
  }
}

function attemptPlay() {
  if (!playing.value || source) return
  const c = getCtx()
  if (!c) return
  loadBuffer().then((buffer) => {
    if (!buffer || !playing.value || source) return
    const g = c.createGain()
    g.gain.value = VOLUME
    const node = c.createBufferSource()
    node.buffer = buffer
    node.loop = true
    node.connect(g).connect(c.destination)
    node.start(0)
    source = node
    gainNode = g
    stopStartWatch()
  })
}

function onScrollTrigger() {
  if (window.scrollY > SCROLLED_PX || document.documentElement.scrollTop > SCROLLED_PX) attemptPlay()
}

function onActionTrigger(e) {
  if (e.target && e.target.closest && e.target.closest('.audio-toggle')) return
  attemptPlay()
}

function armStartWatch() {
  if (armed) return
  armed = true
  SCROLL_TRIGGERS.forEach((type) => window.addEventListener(type, onScrollTrigger, { passive: true }))
  ACTION_TRIGGERS.forEach((type) => document.addEventListener(type, onActionTrigger, { passive: true }))
}

function stopStartWatch() {
  if (!armed) return
  armed = false
  SCROLL_TRIGGERS.forEach((type) => window.removeEventListener(type, onScrollTrigger))
  ACTION_TRIGGERS.forEach((type) => document.removeEventListener(type, onActionTrigger))
}

function toggle() {
  if (playing.value) {
    playing.value = false
    stopStartWatch()
    stopAudio()
  } else {
    playing.value = true
    attemptPlay()
  }
}

/* 切到后台（切 App / 切标签）：先停声，回来再续播 */
function onVisibility() {
  if (document.hidden) {
    hiddenPause = true
    stopAudio()
  } else if (hiddenPause) {
    hiddenPause = false
    if (playing.value) attemptPlay()
  }
}

/* 离开本页（去游戏页 / 关闭）：立刻停声 */
function onPageHide() {
  hiddenPause = false
  stopAudio()
}

/* 从别的页面返回：保持安静，图标同步为「已关闭」，想听再点一下 */
function onPageShow(event) {
  if (!event || !event.persisted) return
  hiddenPause = false
  playing.value = false
  stopStartWatch()
  stopAudio()
}

onMounted(() => {
  armStartWatch()
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  stopStartWatch()
  stopAudio()
  window.removeEventListener('pagehide', onPageHide)
  window.removeEventListener('pageshow', onPageShow)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<style scoped>
.audio-toggle{
  position:fixed;z-index:60;top:22px;left:22px;
  width:46px;height:46px;padding:0;cursor:pointer;
  display:grid;place-items:center;
  border:1px solid var(--line);border-radius:50%;
  background:rgba(8,12,26,.42);
  backdrop-filter:blur(6px);
  color:var(--blue);
  transition:color .35s,border-color .35s,background .35s,transform .35s;
}
.audio-toggle:hover{color:var(--gold);border-color:rgba(230,200,138,.5);background:rgba(8,12,26,.62);transform:translateY(-2px)}
.audio-toggle.playing{color:var(--moon);border-color:rgba(157,184,232,.4)}
.audio-icon{width:22px;height:22px;display:block;overflow:visible}
.spk{fill:currentColor;stroke:none}
.wave,.slash{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round}
.slash{stroke:var(--gold)}
.audio-toggle.playing .wave{animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.55}50%{opacity:1}}

@media(max-width:520px){
  .audio-toggle{top:12px;left:12px;width:40px;height:40px}
  .audio-icon{width:19px;height:19px}
}
</style>

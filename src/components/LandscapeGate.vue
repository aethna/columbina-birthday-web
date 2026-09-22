<template>
  <Transition name="lgate">
    <div v-if="show" class="lgate" role="alertdialog" aria-modal="true" aria-label="建议横屏浏览">
      <button class="lgate-skip" type="button" @click="dismiss">
        <span class="x" aria-hidden="true">✕</span>
        <span>继续竖屏浏览</span>
      </button>

      <div class="lgate-body">
        <svg class="lgate-icon" viewBox="0 0 120 120" aria-hidden="true">
          <rect x="42" y="26" width="36" height="68" rx="9" />
          <path d="M48 86h24" opacity=".55" />
          <path class="ring" d="M22 60a38 38 0 0 1 34-37.8" />
          <path class="tip" d="M54 10l14 12-16 6z" />
        </svg>
        <p class="lgate-text">为了更好的浏览体验，请将设备横过来</p>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/* 会话级开关：横屏进入 / 转到横屏 / 手动关闭 → 本次进入网站不再提示（刷新页面才重置） */
let dismissedInSession = false

const dismissed = ref(dismissedInSession)
const isPhone = ref(false)
const portrait = ref(false)

const show = computed(() => isPhone.value && portrait.value && !dismissed.value)

let mqPortrait = null
let mqCoarse = null

function dismiss() {
  dismissedInSession = true
  dismissed.value = true
}

function evaluate() {
  const coarse = mqCoarse ? mqCoarse.matches : false
  const shortSide = Math.min(window.innerWidth, window.innerHeight)
  isPhone.value = coarse && shortSide <= 600
  /* 用视口宽高判断横竖屏：部分国产浏览器不更新 matchMedia('orientation') */
  portrait.value = window.innerHeight >= window.innerWidth
  /* 横屏（或转到横屏）：本次会话彻底不再提示 */
  if (isPhone.value && !portrait.value) dismiss()
}

/* 提示期间锁住页面滚动；另外显示满 3 秒自动关闭——用户不理会时不必手动点 */
const AUTO_DISMISS_MS = 3000
let savedOverflow = ''
let autoTimer = null
watch(show, (value) => {
  const body = document.body
  if (value) {
    savedOverflow = body.style.overflow
    body.style.overflow = 'hidden'
    autoTimer = setTimeout(() => { autoTimer = null; dismiss() }, AUTO_DISMISS_MS)
  } else {
    body.style.overflow = savedOverflow
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
  }
})

function addListeners() {
  if (mqPortrait && mqPortrait.addEventListener) mqPortrait.addEventListener('change', evaluate)
  if (mqCoarse && mqCoarse.addEventListener) mqCoarse.addEventListener('change', evaluate)
  window.addEventListener('resize', evaluate)
  window.addEventListener('orientationchange', evaluate)
}

function removeListeners() {
  if (mqPortrait && mqPortrait.removeEventListener) mqPortrait.removeEventListener('change', evaluate)
  if (mqCoarse && mqCoarse.removeEventListener) mqCoarse.removeEventListener('change', evaluate)
  window.removeEventListener('resize', evaluate)
  window.removeEventListener('orientationchange', evaluate)
}

onMounted(() => {
  mqPortrait = window.matchMedia('(orientation: portrait)')
  mqCoarse = window.matchMedia('(pointer: coarse)')
  addListeners()
  evaluate()
})

onBeforeUnmount(() => {
  removeListeners()
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
  if (show.value) document.body.style.overflow = savedOverflow
})
</script>

<style scoped>
.lgate{
  position:fixed;inset:0;z-index:300;
  display:flex;align-items:center;justify-content:center;
  padding:calc(env(safe-area-inset-top,0px) + 22px) 22px calc(env(safe-area-inset-bottom,0px) + 22px);
  background:radial-gradient(circle at 50% 38%,#1b2a63 0,#0a1130 54%,#04060d 100%);
}
.lgate-skip{
  position:absolute;left:calc(env(safe-area-inset-left,0px) + 14px);top:calc(env(safe-area-inset-top,0px) + 14px);
  display:inline-flex;align-items:center;gap:8px;cursor:pointer;
  padding:9px 18px;border-radius:999px;
  border:1px solid rgba(157,184,232,.45);
  background:rgba(8,12,26,.55);color:var(--ink);
  font-family:var(--sans);font-size:13px;letter-spacing:.14em;
  transition:color .3s,border-color .3s,background .3s;
}
.lgate-skip:hover,.lgate-skip:focus-visible{color:var(--gold);border-color:rgba(230,200,138,.62);background:rgba(8,12,26,.82)}
.lgate-skip .x{font-size:14px;line-height:1;color:var(--blue)}
.lgate-body{display:flex;flex-direction:column;align-items:center;gap:26px;max-width:430px;text-align:center}
.lgate-icon{
  width:112px;height:112px;overflow:visible;
  fill:none;stroke:var(--blue);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;
  animation:lgate-tilt 3.2s ease-in-out infinite;
}
.lgate-icon rect{fill:rgba(157,184,232,.09)}
.lgate-icon .ring{stroke:var(--gold);opacity:.92}
.lgate-icon .tip{fill:var(--gold);stroke:none}
@keyframes lgate-tilt{0%,22%{transform:rotate(0)}46%,72%{transform:rotate(-90deg)}96%,100%{transform:rotate(0)}}
.lgate-text{
  margin:0;font-family:var(--serif);font-size:clamp(17px,4.6vw,22px);
  letter-spacing:.14em;line-height:1.75;color:var(--moon);
  text-shadow:0 2px 14px rgba(5,7,15,.8);
}
.lgate-enter-active,.lgate-leave-active{transition:opacity .45s ease}
.lgate-enter-from,.lgate-leave-to{opacity:0}

@media(prefers-reduced-motion:reduce){
  .lgate-icon{animation:none}
}
</style>

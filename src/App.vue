<template>
  <SkyCanvas />
  <div class="grain"></div>
  <div class="vignette"></div>

  <AudioToggle v-if="view !== 'admin'" />
  <!-- 登录入口：QQ 互联应用审核通过前先不展示；恢复时删掉这三行注释即可
  <UserAuth v-if="view !== 'admin' && view !== 'login'" :return-to="authReturnTo" />
  -->

  <template v-if="view === 'login'">
    <LoginPage :return-to="pendingTarget || '/#/signup'" @back="go('home')" />
  </template>
  <template v-else-if="view === 'signup'">
    <SubmitPage @back="go('home')" />
  </template>
  <template v-else-if="view === 'admin'">
    <AdminPage />
  </template>
  <template v-else>
    <HeroSection />
    <IntroSection />
    <WorksSection />
    <GameSection @play="gate('game')" />
    <TimelineSection />
    <CtaSection @join="joinOpen = true" @signup="gate('signup')" @venue="gate('venue')" />
    <SiteFooter />
  </template>

  <JoinModal :open="joinOpen" @close="joinOpen = false" />
  <LandscapeGate />
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import SkyCanvas from './components/SkyCanvas.vue'
import AudioToggle from './components/AudioToggle.vue'
// import UserAuth from './components/UserAuth.vue'  // QQ 应用审核通过前先隐藏登录入口
import LoginPage from './components/LoginPage.vue'
import HeroSection from './components/HeroSection.vue'
import IntroSection from './components/IntroSection.vue'
import WorksSection from './components/WorksSection.vue'
import GameSection from './components/GameSection.vue'
import TimelineSection from './components/TimelineSection.vue'
import CtaSection from './components/CtaSection.vue'
import SiteFooter from './components/SiteFooter.vue'
import JoinModal from './components/JoinModal.vue'
import LandscapeGate from './components/LandscapeGate.vue'
import SubmitPage from './components/SubmitPage.vue'
import AdminPage from './components/AdminPage.vue'
import { useAuth } from './composables/useAuth'

const joinOpen = ref(false)
const { user, ready, load: loadAuth } = useAuth()

/* 页面内切换：首页 / 报名页 / 登录页 / 管理后台（都用 hash 记录，刷新和后退都能回到原处） */
const VIEW_HASH = { signup: '#/signup', admin: '#/admin', login: '#/login' }
const HASH_VIEW = { '#/signup': 'signup', '#/admin': 'admin', '#/login': 'login' }

/* hash 可能带查询串（如 #/login?error=state），取路径部分判断视图 */
function currentView() {
  const path = String(window.location.hash || '').split('?')[0]
  return HASH_VIEW[path] || 'home'
}

const view = ref(currentView())
/* 被门禁拦下时记下真正想去的地方，登录成功后往那儿跳 */
const pendingTarget = ref('')

/* 右上角登录按钮登录成功后回到当前视图 */
const authReturnTo = computed(() => (view.value === 'signup' ? '/#/signup' : '/'))

function go(next) {
  view.value = next
  const want = VIEW_HASH[next] || ''
  if (window.location.hash !== want) {
    if (want) window.location.hash = want
    else window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  if (next === 'home') nextTick(observeReveals)
  window.scrollTo({ top: 0, behavior: 'auto' })
}

/* ---------------- 门禁：小游戏 / 会场 / 我要参与 ---------------- */

const GATE_TARGET = { game: '/game/index.html', venue: '/venue/index.html', signup: '/#/signup' }

/* QQ 互联应用审核期间临时关闭门禁：未登录也放行。
   审核通过后把这里改回 true，门禁立刻恢复（登录入口那几行注释也一并恢复）。 */
const GATE_ENABLED = false

/** 未登录 → 去登录页并记住目标；已登录 → 直接放行 */
function gate(action) {
  const target = GATE_TARGET[action] || '/'
  if (GATE_ENABLED && !user.value) {
    pendingTarget.value = target
    go('login')
    return
  }
  if (action === 'signup') go('signup')
  else window.location.href = target
}

/* 直接敲 #/signup 或登录返回时的兜底：登录态一确定就复查视图 */
watch([view, ready], ([v, r]) => {
  if (!r) return
  if (v === 'signup' && !user.value && GATE_ENABLED) {
    pendingTarget.value = '/#/signup'
    go('login')
    return
  }
  if (v === 'login' && user.value) {
    const t = pendingTarget.value
    pendingTarget.value = ''
    if (t && t !== '/#/signup') window.location.href = t
    else if (t) go('signup')
    else go('home')
  }
})

function onHashChange() {
  const want = currentView()
  if (want !== view.value) {
    view.value = want
    if (want === 'home') nextTick(observeReveals)
    window.scrollTo({ top: 0, behavior: 'auto' })
  }
}

/* 滚动显现 */
function observeReveals() {
  const io = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('in')
        io.unobserve(e.target)
      }
    })
  }, { threshold: 0.12 })
  document.querySelectorAll('.reveal:not(.in)').forEach((el) => io.observe(el))
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  loadAuth()
  nextTick(observeReveals)
})

onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))
</script>

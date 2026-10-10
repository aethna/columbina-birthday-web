<template>
  <SkyCanvas />
  <div class="grain"></div>
  <div class="vignette"></div>

  <AudioToggle v-if="view !== 'admin'" />
  <UserAuth v-if="view !== 'admin' && view !== 'login'" :return-to="authReturnTo" />

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
import UserAuth from './components/UserAuth.vue'
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

/* 门禁开关：true = 未登录点「小游戏 / 前往会场」会先被引导到登录页。
   注意：「我要参与」/ 报名页始终不需要登录（不跟账号绑定），不参与门禁判断。 */
const GATE_ENABLED = true

/** 未登录 → 去登录页并记住目标；已登录 → 直接放行；报名页不受门禁影响 */
function gate(action) {
  if (action === 'signup') { go('signup'); return }
  const target = GATE_TARGET[action] || '/'
  if (GATE_ENABLED && !user.value) {
    pendingTarget.value = target
    go('login')
    return
  }
  window.location.href = target
}

/* 登录返回后的兜底：登录态一确定就复查视图（报名页不拦） */
watch([view, ready], ([v, r]) => {
  if (!r) return
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

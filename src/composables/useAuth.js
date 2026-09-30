import { ref } from 'vue'

/**
 * 访客登录态（QQ 登录）。
 * 会话是后端下发的 HttpOnly cookie，前端只知道「登录了没 / 叫什么 / 头像」，
 * 所以进站先问一次 /api/auth/me，问完 ready 才为 true —— 门禁靠 ready 而不是靠猜。
 */
const user = ref(null)
const ready = ref(false)
let inflight = null

function fetchMe() {
  if (inflight) return inflight
  inflight = fetch('/api/auth/me', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((d) => { user.value = d && d.loggedIn ? d.user : null })
    .catch(() => { user.value = null })
    .then(() => { ready.value = true; inflight = null })
  return inflight
}

export function useAuth() {
  /** 拼 QQ 授权入口；returnTo 是站内路径，登录成功后后端直接 302 回这里 */
  function loginHref(returnTo) {
    let to = String(returnTo || '/')
    if (!to.startsWith('/') || to.startsWith('//')) to = '/'
    return `/api/auth/qq/start?returnTo=${encodeURIComponent(to)}`
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } catch (e) { /* 网络失败也当已退出，刷新后以服务端为准 */ }
    user.value = null
  }

  return { user, ready, load: fetchMe, loginHref, logout }
}

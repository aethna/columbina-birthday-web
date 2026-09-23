/* 高度锚定缩放 —— 仅移动端启用。
   手机：与 main 相同（scale = vh/800，设计宽 = vw/scale，根 transform）。
   桌面：关掉 scale，自然流式布局（html:not(.app-scale-on) 覆盖）。 */

const DESIGN_H = 800

export function isMobileLayout() {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    /\b(Mobi|Android|iPhone|iPad|iPod|HarmonyOS)\b/i.test(navigator.userAgent)
  )
}

export function installAppScale() {
  const root = document.documentElement
  const app = () => document.getElementById('app')

  const update = () => {
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || DESIGN_H

    if (!isMobileLayout()) {
      /* 桌面：不装 scale，走 main 之外的桌面覆盖（见 style.css 文末） */
      root.classList.remove('app-scale-on')
      root.style.setProperty('--app-scale', '1')
      root.style.setProperty('--app-design-w', '100%')
      root.style.setProperty('--app-vh', '100dvh')
      if (app()) app().style.height = ''
      return
    }

    /* 手机：与 main 完全一致的高度锚定缩放 */
    root.classList.add('app-scale-on')
    const scale = vh / DESIGN_H
    const designW = vw / scale

    root.style.setProperty('--app-scale', String(scale))
    root.style.setProperty('--app-design-w', `${designW}px`)
    root.style.setProperty('--app-vh', `${DESIGN_H}px`)

    const el = app()?.querySelector('.app-root')
    if (el) {
      app().style.height = `${el.offsetHeight * scale}px`
    }
  }

  update()
  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', update)
  window.visualViewport?.addEventListener('resize', update)
  if (typeof matchMedia === 'function') {
    matchMedia('(pointer: coarse)').addEventListener?.('change', update)
  }

  return () => {
    window.removeEventListener('resize', update)
    window.removeEventListener('orientationchange', update)
    window.visualViewport?.removeEventListener('resize', update)
    matchMedia('(pointer: coarse)')?.removeEventListener?.('change', update)
  }
}

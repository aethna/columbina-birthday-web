/* 高度锚定缩放：纵向锁设计高（比例永远一致），横向设计宽 = vw/scale 随屏幕拉伸。
   浏览器缩放时 vw/vh 同比变 → designW 不变 → 构图锁定；只有 --app-scale 变。 */

const DESIGN_H = 800

export function installAppScale() {
  const root = document.documentElement
  const app = () => document.getElementById('app')

  const update = () => {
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || DESIGN_H
    /* 纵向：视口高 → 设计高，比例固定 */
    const scale = vh / DESIGN_H
    /* 横向：设计宽随屏宽伸展（窄屏变窄、宽屏变宽，不锁 16:9） */
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

  return () => {
    window.removeEventListener('resize', update)
    window.removeEventListener('orientationchange', update)
    window.visualViewport?.removeEventListener('resize', update)
  }
}

import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { initLocalization } from './i18n.js'
import { installAppScale } from './appScale.js'

installAppScale()
createApp(App).mount('#app')
initLocalization()
/* 挂载后 .app-root 才有高度，再触发一次 resize 以垫正文档滚动高度 */
requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))

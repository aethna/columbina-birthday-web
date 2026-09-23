import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { initLocalization } from './i18n.js'
createApp(App).mount('#app')
initLocalization()

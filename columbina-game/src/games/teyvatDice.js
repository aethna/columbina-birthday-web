/**
 * 提瓦特战力党（Teyvat Power Dice）—— 单文件游戏的接入信息。
 *
 * 这个游戏不是 Vue 组件：它是零依赖的单文件 HTML（16:9 舞台 + 自己的资源目录），
 * 源码原样放在 public/teyvat-dice/ 下，由 Vite 复制到 dist/teyvat-dice/，
 * 再由 TeyvatDiceGame.vue 用 iframe 承载，所以这里只放路径与预热清单。
 *
 * base 是 './'，因此统一用相对路径，部署到任意子路径（GitHub Pages 子目录等）都对。
 */
export const DICE_DIR = `${import.meta.env.BASE_URL}teyvat-dice/`
export const DICE_ENTRY = `${DICE_DIR}index.html`

// Keep iframe consumption and optional prefetch on the exact deployed URL.
// Load diagnostics only record data; they never manufacture a cache-key query.
const asset = (name) => `${DICE_DIR}assets/${name}`

/** 卡片封面：游戏自己的开局对阵图（1600×900，主体在画面 25%~60% 高度处） */
export const DICE_COVER = asset('bg-start.jpg')

/** 运行时素材清单（12 头像 + 4 背景 + 4 骰子），供大厅后台预热用 */
export const DICE_ASSETS = [
  'av-ayaka.png', 'av-bennett.png', 'av-columb.png', 'av-ganyu.png',
  'av-hutao.png', 'av-nahida.png', 'av-neuvil.png', 'av-raiden.png',
  'av-venti.png', 'av-xiao.png', 'av-xingqiu.png', 'av-zhongli.png',
  'bg-board.png', 'bg-coin2.png', 'bg-menu.jpg', 'bg-start.jpg',
  'die-ace.png', 'die-d4.png', 'die-d6.png', 'die-d8.png',
].map(asset)

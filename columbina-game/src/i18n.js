const STORAGE_KEY = 'columbina-language'
const saved = localStorage.getItem(STORAGE_KEY)
export const language = saved === 'zh' || saved === 'en' ? saved : ((navigator.languages || [navigator.language || 'zh-CN']).some((lang) => String(lang).toLowerCase().startsWith('zh')) ? 'zh' : 'en')
export const isEnglish = language === 'en'

const exact = new Map(Object.entries({
  '返回': 'Back', '哥伦比娅生日会': 'Columbina Birthday Celebration',
  '「新月再梦听羽生」主题游戏': "“Where Feathers Bloom in the New Moon's Dream” · Themed Games",
  '循着月光进入她的梦境。六段旅程，六种相遇，\n在羽声落下之前，与哥伦比娅共度这一夜。': 'Follow the moonlight into her dreams. Six journeys, six encounters—\nspend this night with Columbina before the feathers fall silent.',
  '进入梦境游廊': 'Enter the Dream Arcade', '月下游廊': 'Dream Arcade',
  '选择一段梦境，与她一同飞行、奔跑，或在月色中落下一枚棋子。': 'Choose a dream: fly and run beside her, or place a piece together beneath the moon.',
  '进入': 'ENTER', '云隙轻歌': 'Song Through the Clouds', '陪哥伦比娅轻盈起飞，在云隙之间延续她的歌。': 'Take flight with Columbina and carry her song through the clouds.',
  '开始游戏 ↗': 'Play Now ↗', '开始游戏': 'Play Now', '无尽巡游': 'Endless Sojourn', '踏过月岩与冰晶，在一段、二段、三段跳之间找到属于她的节奏。': 'Cross moonlit crags and ice crystals, finding her rhythm through single, double, and triple jumps.',
  '月亮棋': 'Moon Chess', '棋盘只保留最近五枚棋子，每一步都可能改写局面。': 'Only the five newest pieces remain on the board. Every move can reshape the game.',
  '找哥伦比娅下棋 ↗': 'Challenge Columbina ↗', '找哥伦比娅下棋': 'Challenge Columbina', '星月五子棋': 'Starlit Gomoku', '在十五路棋盘上连成五子，与哥伦比娅来一局。': 'Make five in a row on a 15×15 board and challenge Columbina.',
  '提瓦特战力党': 'Teyvat Power Dice',
  '十二位提瓦特角色，投骰、选骰、重投，在攻防之间决出胜负。': 'Twelve Teyvat characters — roll, pick, reroll, and settle it in attack and defence.',
  '进入提瓦特…': 'Entering Teyvat…',
  '循着月光进入她的梦境。六段旅程，六种相遇，': 'Follow the moonlight into her dreams. Six journeys, six encounters—',
  '在羽声落下之前，与哥伦比娅共度这一夜。': 'spend this night with Columbina before the feathers fall silent.',
  '梦境记录': 'Dream Record', '愿今夜的月光，停留得久一些。': 'May tonight’s moonlight linger a little longer.',
  '哥伦比娅生日会 · 新月再梦听羽生': "Columbina Birthday Celebration · Where Feathers Bloom in the New Moon's Dream",
  '返回游廊': 'Back to Arcade', '哥伦比娅 · 云隙轻歌': 'Columbina · Song Through the Clouds', '梦境': 'DREAM',
  '点击画面或按空格，让她穿过月光的间隙。': 'Tap the screen or press Space to guide her through the moonlit gaps.', '进入梦境': 'Enter the Dream',
  '再来一次': 'One More Dream', '本局得分': 'Score', '最佳记录': 'Best', '重新开始': 'Restart',
  '重新下载': 'Download Again', '返回大厅': 'Back to Lobby', '← 返回大厅': '← Back to Lobby', '下载时间过长，请检查网络后重试。': 'The download timed out. Check your connection and try again.', '部分资源下载失败，请重试。': 'Some resources failed to download. Please try again.',
  '返回小游戏大厅': 'Return to the game lobby', '仅保留最近 5 枚棋子': 'Only the 5 newest pieces remain', '先连成五子的一方获胜': 'First to connect five wins',
  '🎉 你赢了！': '🎉 You win!', '哥伦比娅赢了': 'Columbina wins', '🤝 平局': '🤝 Draw', '轮到你落子': 'Your turn', '轮到哥伦比娅落子': 'Columbina’s turn',
  '你 · X': 'You · X', '你 · 黑棋': 'You · Black', '哥伦比娅 · O': 'Columbina · O', '哥伦比娅 · 白棋': 'Columbina · White',
  '判定平局': 'Declare Draw', '再来一局': 'Play Again', '和哥伦比娅下棋': 'Play Against Columbina',
  '开始之前，决定她要让你多少，以及谁先落子。': 'Before the match, choose the difficulty and who makes the first move.',
  '哥伦比娅问：“要我让让你吗？”': 'Columbina asks, “Should I go easy on you?”', '多让一点': 'Go Easy', '稍微让让': 'A Little', '不用让': 'No Mercy',
  '谁先落子？': 'Who moves first?', '你先手': 'You First', '哥伦比娅先手': 'Columbina First', '开始对局 →': 'Start Match →',
  '哥伦比娅暂时走神了，请重新开始本局。': 'Columbina lost focus for a moment. Please restart the match.',
  '哥伦比娅 · 无尽巡游': 'Columbina · Endless Sojourn', '连续点击可使出一段、二段和三段跳。': 'Tap repeatedly to perform single, double, and triple jumps.',
  '巡游结束': 'Sojourn Ended', '本局': 'Score', '最佳': 'Best',
  '哥伦比娅无尽巡游游戏区域': 'Columbina Endless Sojourn game area', '本次腾空已使用跳跃次数': 'Jumps used while airborne',
  '奔跑中的哥伦比娅': 'Columbina running', '跳跃中的哥伦比娅': 'Columbina jumping', '飞行中的哥伦比娅': 'Columbina flying', '哥伦比娅': 'Columbina',
  '月亮棋棋盘': 'Moon Chess board', '星月五子棋棋盘': 'Starlit Gomoku board', '小游戏列表': 'Game list', '我的棋类战绩': 'My board-game record',
  '关闭': 'Close',
}))

const patterns = [
  [/^月亮棋\s+胜 (\d+) · 负 (\d+) · 和 (\d+)$/, 'Moon Chess  W $1 · L $2 · D $3'],
  [/^星月五子棋\s+胜 (\d+) · 负 (\d+) · 和 (\d+)$/, 'Starlit Gomoku  W $1 · L $2 · D $3'],
  [/^第 (\d+) 手$/, 'Move $1'], [/^本局共 (\d+) 手$/, '$1 moves this match'],
  [/^第 (\d+) 行第 (\d+) 列，空位$/, 'Row $1, column $2, empty'], [/^第 (\d+) 行第 (\d+) 列，你的棋子$/, 'Row $1, column $2, your piece'],
  [/^第 (\d+) 行第 (\d+) 列，哥伦比娅的棋子$/, 'Row $1, column $2, Columbina’s piece'], [/^(.+)棋盘$/, '$1 board'],
]

function translated(text) {
  const trimmed = text.trim()
  if (!trimmed) return text
  let result = exact.get(trimmed)
  if (!result) for (const [pattern, replacement] of patterns) if (pattern.test(trimmed)) { result = trimmed.replace(pattern, replacement); break }
  return result ? text.replace(trimmed, result) : text
}

function translateElement(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  nodes.forEach((node) => {
    if (node.parentElement?.closest('.language-switcher')) return
    const next = translated(node.nodeValue)
    if (next !== node.nodeValue) node.nodeValue = next
  })
  const elements = root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll('*')] : []
  elements.forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) if (el.hasAttribute(attr)) {
      const current = el.getAttribute(attr); const next = translated(current)
      if (next !== current) el.setAttribute(attr, next)
    }
    if (el.matches('.event-logo')) el.setAttribute('src', './english-logo.png')
  })
}

function addSwitcher() {
  const box = document.createElement('div')
  box.className = 'language-switcher'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Language')
  box.innerHTML = `<span aria-hidden="true">✦</span><button type="button" data-lang="zh">中文</button><i></i><button type="button" data-lang="en">EN</button>`
  box.querySelector(`[data-lang="${language}"]`).classList.add('active')
  box.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.lang === language) return
    localStorage.setItem(STORAGE_KEY, button.dataset.lang); window.location.reload()
  }))
  document.body.appendChild(box)
}

export function initLocalization() {
  document.documentElement.lang = isEnglish ? 'en' : 'zh-CN'; addSwitcher()
  if (!isEnglish) return
  document.title = "Columbina’s Dream Arcade · Where Feathers Bloom in the New Moon's Dream"
  document.querySelector('meta[name="description"]')?.setAttribute('content', 'A collection of fan-made games for Columbina’s birthday celebration.')
  translateElement(document.body)
  const observer = new MutationObserver((mutations) => mutations.forEach((mutation) => {
    if (mutation.type === 'characterData') { const next = translated(mutation.target.nodeValue); if (next !== mutation.target.nodeValue) mutation.target.nodeValue = next }
    else if (mutation.type === 'attributes') translateElement(mutation.target)
    else mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) { const next = translated(node.nodeValue); if (next !== node.nodeValue) node.nodeValue = next }
      else if (node.nodeType === Node.ELEMENT_NODE) translateElement(node)
    })
  }))
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'placeholder', 'alt'] })
}

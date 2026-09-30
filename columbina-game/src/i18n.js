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
  '← 返回游廊': '← Back to Arcade',
  '娅娅猫向前冲': 'Columbina Cat Dash',
  '地图一：云上起跑线': 'Map 1: Cloudline Starting Point',
  '地图二：碎石回廊': 'Map 2: Shattered Stone Corridor',
  '地图三：交错平台': 'Map 3: Interlaced Platforms',
  '地图四：灰岩台地': 'Map 4: Limestone Terrace',
  '地图五：星桥终线': 'Map 5: Starbridge Finish',
  '娅娅猫向前冲标题图案': 'Columbina Cat Dash title art',
  'FULL PLAYABLE RACE · 1 PLAYER VS 4 AI': 'FULL PLAYABLE RACE · 1 PLAYER VS 4 AI',
  '从地图底部起点向顶部终点前进，使用方向键或WASD跳跃。和4只AI争夺终点，利用机关捷径，并避开地刺、坑、活塞、胶水和牵引炸弹。': 'Race from the bottom start to the top finish with the arrow keys or WASD. Compete against four AI cats, use mechanisms for shortcuts, and avoid spikes, pits, pistons, glue, and tractor bombs.',
  '选择五张正式地图，与4只AI竞速；使用跳跃、弹簧和机关冲向终点。': 'Choose from five official maps and race four AI cats; use jumps, springs, and mechanisms to reach the finish.',
  '等待开始': 'Waiting to start',
  '比赛进行中': 'Race in progress',
  '比赛结束': 'Race finished',
  '重新生成地图': 'Regenerate map',
  '随机选择': 'Random map',
  '随机布局': 'Randomized layout',
  'AI难度': 'AI difficulty',
  '选择AI难度': 'Choose AI difficulty',
  '轻松': 'Easy',
  '标准': 'Normal',
  '困难': 'Hard',
  '请选择地图': 'Choose a map',
  '选择地图': 'Choose a map',
  '未选择': 'Not selected',
  '娅娅猫向前冲正式赛场': 'Columbina Cat Dash race stage',
  '正面斜俯视合并地形预览': 'Merged terrain preview',
  '当前地图的合并地形': 'Merged terrain for the current map',
  '底部起点 → 顶部终点': 'Bottom start → top finish',
  '按 Enter 或点击开始比赛': 'Press Enter or click to start the race',
  '请先选择地图和AI难度': 'Choose a map and AI difficulty first',
  '开始比赛': 'Start Race',
  '向上跳跃': 'Jump up',
  '向左跳跃': 'Jump left',
  '向下跳跃': 'Jump down',
  '向右跳跃': 'Jump right',
  'PLAYER CONTROL': 'PLAYER CONTROL',
  '方向键 / WASD': 'Arrow keys / WASD',
  '普通跳跃间隔0.3秒。被胶水或压在下层时，继续按方向键执行挣脱或甩落。': 'Normal jumps have a 0.3-second cooldown. Keep pressing a direction to escape glue or shake off a cat stacked above you.',
  '请先选择地图和AI难度，再开始比赛。': 'Choose a map and AI difficulty before starting the race.',
  '3秒倒计时开始。准备！': 'The 3-second countdown has started. Get ready!',
  '比赛开始！方向键或WASD控制跳跃。': 'The race has started! Use the arrow keys or WASD to jump.',
  '比赛结束。': 'The race is over.',
  '跳跃成功。': 'Jump successful.',
  '落到另一只猫猫糕上，形成双层堆叠。': 'Landed on another cat cake and formed a two-layer stack.',
  '到达终点！等待其他猫猫糕完成比赛。': 'You reached the finish! Waiting for the other cat cakes.',
  '主动跳入坑中，已返回最近复活线。': 'You jumped into a pit and returned to the nearest respawn line.',
  '触发尖刺，已返回最近复活线。': 'Spikes triggered. Returned to the nearest respawn line.',
  '复活线暂无空位，正在等待复活。': 'The respawn line is full. Waiting for an open spot.',
  '复活无敌期间不会受到尖刺伤害。': 'Spikes cannot hurt you during respawn invincibility.',
  '落入胶水，连续按方向键尝试挣脱。': 'Stuck in glue. Press directions repeatedly to break free.',
  '挣脱胶水失败。': 'Failed to break free from the glue.',
  '甩落失败。': 'Shake-off failed.',
  '甩落方向没有可用落点。': 'There is no available landing spot in that direction.',
  '成功甩落上方猫猫糕！': 'You shook the cat cake above you off!',
  '弹簧启动，已完成强制弹射。': 'Spring activated. Forced launch complete.',
  '进入炸弹触发区，牵引爆炸！': 'Entered the bomb trigger zone. Tractor bomb detonated!',
  '倒计时结束后才能移动。': 'You can move when the countdown ends.',
  '跳跃冷却中。': 'Jump cooldown active.',
  '目标超出地图边界。': 'The target is outside the map.',
  '目标格被墙阻挡。': 'The target tile is blocked by a wall.',
  '目标高度超过普通跳跃能力。': 'The target is too high for a normal jump.',
  '目标格已有两只猫猫糕。': 'The target tile already has two cat cakes.',
  '当前状态不能主动跳跃。': 'You cannot jump manually in the current state.',
  '当前格不能主动离开。': 'You cannot leave this tile manually.',
  '堆叠状态异常，已自动解除。': 'The stack became invalid and was cleared automatically.',
  '有猫猫糕叠上来了': 'A cat cake stacked on top of you',
  '已跳上其他猫猫糕': 'You jumped on another cat cake',
  '已形成双层堆叠': 'A two-layer stack formed',
  '堆叠已解除': 'Stack cleared',
  '被胶水粘住，按方向键挣脱': 'Stuck in glue — press a direction to escape',
  '牵引炸弹爆炸，玩家位置已重新结算。': 'Tractor bomb detonated. Player positions recalculated.',
  '活塞启动，玩家被强制推动。': 'Piston activated. The player was pushed.',
  '弹簧启动，玩家已被弹射。': 'Spring activated. The player was launched.',
  '因为掉进坑里死亡': 'Died because you fell into a pit',
  '因为碰到地刺死亡': 'Died because you hit spikes',
  '因为意外死亡': 'Died in an accident',
}))

const patterns = [
  [/^地图([1-5])$/, 'Map $1'],
  [/^地图一：云上起跑线$/, 'Map 1: Cloudline Starting Point'],
  [/^地图二：碎石回廊$/, 'Map 2: Shattered Stone Corridor'],
  [/^地图三：交错平台$/, 'Map 3: Interlaced Platforms'],
  [/^地图四：灰岩台地$/, 'Map 4: Limestone Terrace'],
  [/^地图五：星桥终线$/, 'Map 5: Starbridge Finish'],
  [/^(\d+)号猫猫糕$/, 'Columbina Cat $1'],
  [/^倒计时 (\d+)$/, 'Countdown $1'],
  [/^复活线 (.+)$/, 'Respawn lines $1'],
  [/^保底风险通路 (\d+) 格$/, 'Guaranteed route $1 tiles'],
  [/^AI (未选择|轻松|标准|困难) (.*)$/, 'AI $1 $2'],
  [/^AI (未选择|轻松|标准|困难)$/, 'AI $1'],
  [/^(.+) · 随机布局$/, '$1 · Randomized layout'],
  [/^已选择(.+)和(轻松|标准|困难)难度，可以开始比赛。$/, 'Selected $1 on $2 difficulty. Ready to race.'],
  [/^已选择(.+)，请继续选择AI难度。$/, 'Selected $1. Choose an AI difficulty next.'],
  [/^已生成(.+)和(轻松|标准|困难)难度，可以开始比赛。$/, 'Generated $1 on $2 difficulty. Ready to race.'],
  [/^已生成(.+)，请继续选择AI难度。$/, 'Generated $1. Choose an AI difficulty next.'],
  [/^动作完成：(.*)$/, 'Action complete: $1'],
  [/^动作未执行：(.*)$/, 'Action not performed: $1'],
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
  if (!result) return text
  let next = text.replace(trimmed, result)
  // Pattern translations may contain captured Chinese labels (map names or
  // difficulty names). Apply the same exact dictionary to those captures so
  // dynamic status messages are fully translated as one unit.
  exact.forEach((translation, source) => {
    if (source !== trimmed && next.includes(source)) next = next.replaceAll(source, translation)
  })
  return next
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

const STORAGE_KEY = 'columbina-language'

function detectLanguage() {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'zh' || saved === 'en') return saved
  return (navigator.languages || [navigator.language || 'zh-CN'])
    .some((lang) => String(lang).toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

export const language = detectLanguage()
export const isEnglish = language === 'en'

const exact = new Map(Object.entries({
  '愿此月夜，献予哥伦比娅': 'May this moonlit night be dedicated to Columbina',
  '天': 'DAYS', '时': 'HOURS', '分': 'MINUTES', '秒': 'SECONDS',
  '☾ 生日会已经开始 ❋': '☾ The celebration has begun ❋', '↓向 下↓': '↓ SCROLL ↓',
  '一场献给月亮的': 'A Birthday Celebration', '生日企划': 'Dedicated to the Moon',
  '哥伦比娅·希珀塞莱尼娅，前至冬愚人众第三席「': 'Columbina Hyposelenia, formerly the Third of the Fatui Harbingers, “',
  '少女': 'Damselette',
  '」，如今的三月女神。她生于挪德卡莱的月光之下，歌声与夜色是她与世界之间，最温柔的丝线。而在朋友们的帮助下，她找到了家在何处。': ',” is now the Trilune Goddess. Born beneath the moonlight of Nod-Krai, her song and the night are the gentlest threads connecting her to the world. With the help of her friends, she finally found where home is.',
  '一场献给月亮的\n生日企划': 'A Birthday Celebration\nDedicated to the Moon',
  '哥伦比娅·希珀塞莱尼娅，前至冬愚人众第三席「少女」，如今的三月女神。她生于挪德卡莱的月光之下，歌声与夜色是她与世界之间，最温柔的丝线。而在朋友们的帮助下，她找到了家在何处。': 'Columbina Hyposelenia, formerly the Third of the Fatui Harbingers, “Damselette,” is now the Trilune Goddess. Born beneath the moonlight of Nod-Krai, her song and the night are the gentlest threads connecting her to the world. With the help of her friends, she finally found where home is.',
  '「月下的世界终将再次明朗」': '“The world beneath the moon shall know light once more.”',
  '—— 2027 · 三月交辉之时': '— 2027 · When the Three Moons Shine as One',
  '哥伦比娅·希珀塞莱尼娅': 'Columbina Hyposelenia', '角色档案': 'CHARACTER PROFILE',
  '她是天，她是光，我们唯一的信仰': 'She is the sky, she is the light, our one and only faith',
  '前愚人众第三席，代号：「少女」': 'Former Third of the Fatui Harbingers, codenamed “Damselette”',
  '三月女神': 'The Trinity of Moon Goddesses', '生日：1月14日': 'Birthday: January 14',
  '标志：镂空眼罩 · 翅膀头饰': 'Signature: Hollow eye veil · Winged headdress',
  '家：挪德卡莱·银月之庭': 'Home: Silvermoon Hall, Nod-Krai',
  '企划内容': 'Celebration Projects', '以下产出将于生日当天（1月14日）一同公开。': 'The following works will be released together on her birthday, January 14.',
  '手书': 'Fan Animation', '音乐': 'Music', '其他': 'Other', '筹备中': 'In Preparation',
  '与哥伦比娅一起玩游戏': 'Play with Columbina',
  '「梦境游廊」已经开启——陪她穿过云隙、踏过月岩，或在月色里落下一枚棋子。': 'The Dream Arcade is open—fly through cloudbreaks, cross moonlit crags, or place a piece beneath the moon with her.',
  '云隙轻歌': 'Song Through the Clouds', '无尽巡游': 'Endless Sojourn', '月亮棋': 'Moon Chess', '星月五子棋': 'Starlit Gomoku',
  '与哥伦比娅一起玩游戏 ↗': 'Play with Columbina ↗',
  '企划时间线': 'Project Timeline', '2026 · 秋': 'AUTUMN · 2026', '企划筹备': 'Project Preparation',
  '确定企划方向，搭建宣传小站，公开征集参与。': 'Set the creative direction, launch the campaign site, and open public participation.',
  '2026 · 冬': 'WINTER · 2026', '创作进行时': 'Creation in Progress', '企划内容创作中，欢迎提出宝贵建议': 'The celebration works are in production. Your suggestions are always welcome.',
  '2027 · 1月14日': 'JANUARY 14 · 2027', '新月再梦听羽生': "Where Feathers Bloom in the New Moon's Dream",
  '全部产出正式公开。生日快乐！哥伦比娅！': 'All works are officially released. Happy birthday, Columbina!',
  '愿你也沐浴着月光': 'May Moonlight Shine Upon You, Too',
  '如果你也喜欢这位月之少女，欢迎加入这场企划——无论是投稿、赞助、留下祝福，还是仅仅在生日那天说一声「生日快乐」，都是月光的一部分。': 'If you love this moon maiden too, join our celebration. Whether you submit a work, support the project, leave a blessing, or simply say “Happy Birthday” on that day, you are part of the moonlight.',
  '我要参与 →': 'Join Us →', '我要参与': 'Join Us', '添加q群 →': 'Join QQ Group →', '添加q群': 'Join QQ Group',
  '添加 QQ 群': 'Join Our QQ Group', '哥伦比娅生日企划': 'Columbina Birthday Celebration', '新月再梦听羽生 · 哥伦比娅生日企划': "Where Feathers Bloom in the New Moon's Dream · Columbina Birthday Celebration",
  '复制 QQ 号': 'Copy QQ Number', '已复制 ✓': 'Copied ✓',
  '本企划为玩家自发组织的粉丝企划，与原神官方无关，不得用于任何商业用途。': 'This is a fan-organized project unaffiliated with Genshin Impact. It may not be used for commercial purposes.',
  '「哥伦比娅」角色版权归米哈游所有。': 'Columbina and Genshin Impact are the property of HoYoverse.',
  '为了更好的浏览体验，请将设备横过来': 'Rotate your device for the best viewing experience', '继续竖屏浏览': 'Continue in portrait',
  '返回首页': 'Back to Home', '我要修改': 'Edit Submission',
  '把你的作品交给这场月夜——《新月再梦听羽生》哥伦比娅生日会征集中。': "Offer your work to this moonlit night—submissions are open for the Columbina Birthday Celebration, “Where Feathers Bloom in the New Moon's Dream.”",
  '投稿已更新': 'Submission Updated', '投稿已收到': 'Submission Received',
  '修改已覆盖到原投稿，编号保持不变 ❤️': 'Your original submission has been updated. Its ID remains unchanged. ❤️',
  '感谢你为这场生日会添的一束月光 ❤️': 'Thank you for adding a ray of moonlight to this celebration. ❤️',
  '投稿编号': 'Submission ID', '单品名称': 'Work Title', '单品类别': 'Category', '上传附件': 'Uploaded Files',
  '请务必保存编号，方便后续与负责人核对或需要修改内容时使用；请不要泄露编号给其他人，防止内容被篡改。': 'Save this ID for future verification or edits. Do not share it, as anyone with the ID can alter your submission.',
  '如果不小心没有保存编号，请及时联系项目组，并提供投稿时填写的联系方式、作品名称等信息，我们会帮你找回。': 'If you lose the ID, contact the project team with the contact details and work title used in your submission so we can help recover it.',
  '需要改内容？点右上角「我要修改」，输入编号就能直接改，不用重新填一遍。': 'Need to make changes? Select “Edit Submission” at the top right and enter your ID—there is no need to refill the form.',
  '再投一份': 'Submit Another Work', '正在修改投稿': 'Editing submission', '保存后会覆盖原内容，编号不变。': 'Saving will replace the original content while keeping the same ID.', '退出修改': 'Exit Editing',
  '节目主要负责人联系方式': 'Primary Contact Method', '联系方式': 'Contact Details', '微信': 'WeChat', '邮箱': 'Email',
  '参与人员昵称（选填）': 'Participant Names (Optional)', '填写所有参与人员的昵称，用顿号或逗号分隔': 'Enter all participant names, separated by commas',
  '我们将根据填入的昵称展示参与制作人员的名单': 'These names will be used in the public contributor credits.',
  '投稿形式': 'Submission Type', '个人创作': 'Individual Work', '团队创作': 'Team Work',
  '参与成员分工': 'Team Roles', '每位成员的分工与昵称都要填写，至少保留 2 位。': 'Enter both role and name for every member. At least two members are required.',
  '分工（如：作画 / 剪辑）': 'Role (e.g. art / editing)', '昵称': 'Name', '填写作品名称': 'Enter the title of your work',
  '请选择': 'Select', '作品预计时间': 'Estimated Duration', '作品大致简介': 'Work Summary', '简单介绍作品内容': 'Briefly introduce your work',
  '作品是否涉及哥伦比娅以外的其他角色': 'Does the work feature characters other than Columbina?', '否': 'No', '是': 'Yes',
  '当前作品进展（选填）': 'Current Progress (Optional)', '暂不填写': 'Prefer Not to Say',
  '仅有构想': 'Concept Only', '已开始制作': 'Production Started', '已有初稿': 'First Draft Ready', '接近完成': 'Nearly Complete', '已完成': 'Complete',
  '除哥伦比娅外涉及角色': 'Other Featured Characters', '一行一个角色名，至少保留一个。': 'Enter one character per line; at least one is required.', '角色名': 'Character Name',
  '作品预览（选填）': 'Work Preview (Optional)', '提供链接': 'Provide a Link', '上传文件': 'Upload Files', '暂不提供': 'Not Now',
  '粘贴作品链接（http:// 或 https:// 开头）': 'Paste a work link beginning with http:// or https://',
  '投稿须知': 'Submission Terms', '已阅读并同意 ✓': 'Read and Accepted ✓', '（必须点开阅读并同意后才能提交）': '(Open and accept the terms before submitting)',
  '保存中…': 'Saving…', '提交中…': 'Submitting…', '保存修改': 'Save Changes', '提交投稿': 'Submit Work',
  '请先点开上方蓝色「投稿须知」并点击「我已知晓并同意」。': 'Open the blue “Submission Terms” above and select “I Have Read and Agree.”',
  '本人同意生日会组将本次投稿作品用于《新月再梦听羽生》哥伦比娅生日会总视频、直播、预告、宣传及活动相关内容展示；作品著作权仍归原作者所有。': "I authorize the birthday celebration team to display this submission in the “Where Feathers Bloom in the New Moon's Dream” Columbina Birthday Celebration video, livestream, trailers, promotions, and related event materials. Copyright remains with the original creator.",
  '我已知晓并同意': 'I Have Read and Agree', '暂不同意': 'Not Now', '修改投稿': 'Edit Submission', '请输入投稿编号': 'Enter Your Submission ID',
  '粘贴 32 位投稿编号': 'Paste the 32-character submission ID', '读取中…': 'Loading…', '读取投稿': 'Load Submission', '取消': 'Cancel',
  '编号是修改这份投稿的唯一凭据，请不要泄露给其他人，以免内容被篡改。若没有保存编号，请及时联系项目组并提供联系方式与作品名称，我们会帮你找回。': 'This ID is the sole credential for editing your submission. Keep it private to prevent unauthorized changes. If you did not save it, contact the project team with your contact details and work title so we can help recover it.',
  '动画': 'Animation', '混剪': 'Video Edit', '插画': 'Illustration', '漫画': 'Comic', '故事': 'Story', '原摄': 'In-Game Photography', '原壶': 'Serenitea Pot', '原琴': 'Lyre Performance',
  '小于 1 分钟': 'Under 1 Minute', '1～3 分钟': '1–3 Minutes', '3～6 分钟': '3–6 Minutes', '6 分钟以上': 'Over 6 Minutes',
  '点击选择文件，或把文件拖到这里': 'Select files or drag them here', '支持大文件断点续传': 'Resumable uploads supported', '最多': 'Up to',
  '移除': 'Remove', '原有附件 ✓': 'Existing File ✓', '不改动就保持原样': 'Kept unless removed', '已上传 ✓': 'Uploaded ✓', '上传失败': 'Upload Failed', '重试': 'Retry', '等待上传…': 'Waiting to Upload…',
  '关闭': 'Close', '关闭背景音乐': 'Turn Off Background Music', '播放背景音乐': 'Play Background Music',
  '填写负责人QQ号': 'Enter the primary contact’s QQ number', '填写负责人邮箱地址': 'Enter the primary contact’s email address',
  '投稿管理后台': 'Submission Admin', '账号': 'Username', '管理员账号': 'Admin Username', '口令': 'Password', '登录口令': 'Password', '登录中…': 'Signing In…', '登录': 'Sign In',
  '投稿管理': 'Submission Management', '超级管理员': 'Super Admin', '管理员': 'Admin', '退出': 'Sign Out', '全部投稿': 'All Submissions', '已收藏': 'Favorites', '含附件': 'With Files', '24 小时内': 'Last 24 Hours',
  '搜索 / 刷新': 'Search / Refresh', '加载中…': 'Loading…', '每页': 'Per Page', '还没有符合条件的投稿。': 'No matching submissions.', '收藏': 'Favorite', '取消收藏': 'Unfavorite', '删除': 'Delete', '清空选择': 'Clear Selection', '查看详情': 'View Details', '上一页': 'Previous', '下一页': 'Next',
}))

const patterns = [
  [/^支持大文件断点续传 · 单个文件最大 (\d+) MB · 最多 (\d+) 个$/, 'Resumable uploads · Max $1 MB per file · Up to $2 files'],
  [/^检测到未完成的上传「(.+)」，重新选择同一个文件即可接着传。$/, 'An incomplete upload “$1” was found. Select the same file to resume.'],
  [/^上传中 · (.+) · (.+) \/ (.+)$/, 'Uploading · $1 · $2 / $3'],
  [/^超过 (\d+) MB 上限$/, 'Exceeds the $1 MB limit'],
  [/^用时 (.+) · 平均 (.+)$/, 'Time $1 · Average $2'],
  [/^(\d+) 秒$/, '$1 sec'], [/^(\d+) 分 (\d+) 秒$/, '$1 min $2 sec'],
  [/^填写负责人 QQ 号$/, 'Enter the primary contact’s QQ number'], [/^填写负责人微信号$/, 'Enter the primary contact’s WeChat ID'], [/^填写负责人邮箱$/, 'Enter the primary contact’s email'],
  [/^正在修改投稿 (.+)，保存后会覆盖原内容，编号不变。$/, 'Editing submission $1. Saving will replace its contents while preserving the ID.'],
]

function translated(text) {
  const trimmed = text.trim()
  if (!trimmed) return text
  let result = exact.get(trimmed)
  if (!result) {
    for (const [pattern, replacement] of patterns) {
      if (pattern.test(trimmed)) { result = trimmed.replace(pattern, replacement); break }
    }
  }
  if (!result) return text
  return text.replace(trimmed, result)
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
    for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
      if (el.hasAttribute(attr)) {
        const current = el.getAttribute(attr)
        const next = translated(current)
        if (next !== current) el.setAttribute(attr, next)
      }
    }
    if (el.matches('.title-logo,.event-logo')) {
      if (!el.dataset.zhLogo) el.dataset.zhLogo = el.getAttribute('src')
      el.setAttribute('src', './english-logo.png')
    }
  })
}

function addSwitcher() {
  const box = document.createElement('div')
  box.className = 'language-switcher'
  box.setAttribute('role', 'group')
  box.setAttribute('aria-label', 'Language')
  box.innerHTML = `<span aria-hidden="true">✦</span><button type="button" data-lang="zh">中文</button><i></i><button type="button" data-lang="en">EN</button>`
  box.querySelector(`[data-lang="${language}"]`).classList.add('active')
  box.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    const next = button.dataset.lang
    if (next === language) return
    localStorage.setItem(STORAGE_KEY, next)
    window.location.reload()
  }))
  document.body.appendChild(box)
}

export function initLocalization() {
  document.documentElement.lang = isEnglish ? 'en' : 'zh-CN'
  addSwitcher()
  if (!isEnglish) return
  document.title = "Where Feathers Bloom in the New Moon's Dream · Columbina Birthday Celebration"
  const description = document.querySelector('meta[name="description"]')
  if (description) description.content = 'A fan-made birthday celebration for Columbina Hyposelenia from Genshin Impact.'
  translateElement(document.body)
  const observer = new MutationObserver((mutations) => mutations.forEach((mutation) => {
    if (mutation.type === 'characterData') {
      const next = translated(mutation.target.nodeValue)
      if (next !== mutation.target.nodeValue) mutation.target.nodeValue = next
    } else if (mutation.type === 'attributes') translateElement(mutation.target)
    else mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const next = translated(node.nodeValue)
        if (next !== node.nodeValue) node.nodeValue = next
      } else if (node.nodeType === Node.ELEMENT_NODE) translateElement(node)
    })
  }))
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'placeholder', 'alt'] })
}

/**
 * 全局配置
 *
 * 场景配置在 scenes.js
 * 任务配置在 quests.js
 * 这里只放全局常量和角色配置
 */

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------
// 每个格子多少像素。所有场景统一用这个规格。
// 场景尺寸 40×24 格 = 2560×1536 像素。
export const TILE_SIZE = 64;

// ---------------------------------------------------------------------------
// NPC 配置
// ---------------------------------------------------------------------------
// id            : 唯一标识（任务通过它引用）
// scene         : 所属场景（只在该场景出现）
// guest         : true = 需要收到邀请函才出现（主线剧情）
// tileX/tileY   : 在场景里的位置（格子坐标）
// name / icon   : 显示名和头顶图标
// sprite        : 场景里的立绘（透明背景 PNG）
// portrait      : 对话框头像
//                 字符串 -> emoji 占位
//                 { url: '...' } -> 图片
// portraitBg    : 头像底色
// displayHeight : 立绘在场景里显示多高（像素）。小孩角色要调小。
// dialog        : 对话内容，一条一句
// offers        : 该 NPC 提供的功能入口（小游戏 / 单品）
// ---------------------------------------------------------------------------
// ★ 站位规则（2026-10-04 起）：所有客人 NPC 都站在**禁行格（'#'）**上，
//   而且必须紧贴可走格 —— 这样哥伦比娅能走到旁边挨着他/她，但走不进同格，
//   两个模型就不会重合了。验收脚本 _verify_all.mjs 会强制这条规则。
// ---------------------------------------------------------------------------
export const NPCS = [
  // ==========================================================================
  // 受邀的客人 —— 全部在主会场
  // guest: true 表示「收到邀请函后才会出现」
  // ==========================================================================
  {
    id: 'npc-ainuo',
    scene: 'starship',
    guest: true,
    tileX: 36, tileY: 16,
    name: '爱诺',
    icon: '👧',
    color: 0xffc8e0,
    sprite: 'assets/chars-scene/ainuo-stand.png',
    portrait: { url: 'assets/chars/npc-ainuo-portrait.png' },
    portraitBg: '#3d2a3a',
    displayHeight: 128,
    dialog: [
      { text: '哇——！这里好大！比我的工坊大三倍！' },
      { text: '哥伦比娅姐姐吧，看见伊涅芙了吗？……她在打扫会场，那我们来吃蛋卷吧。' },
      { text: '乌吉恩圈那盏灯我看了，缺的是源珠。等我去修！' },
    ],
    offers: [
      {
        text: '要不要玩个小游戏？我自己做的，零件全是我亲手拧上去的！',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-nefer',
    scene: 'shallows',
    guest: true,
    tileX: 36, tileY: 23,
    name: '奈芙尔',
    icon: '📋',
    color: 0x4a9a8a,
    sprite: 'assets/chars-scene/nefer-stand.png',
    portrait: { url: 'assets/chars/npc-nefer-portrait.png' },
    portraitBg: '#2a3d3a',
    displayHeight: 188,
    dialog: [
      { text: '邀请函我收到了。' },
      { text: '『月亮上没有伏尼契商会』——要不要考虑开个分部？' },
      { text: '既然来了，就把这场宴会当成一笔生意办妥。放心，不做亏本买卖，更不做亏待寿星的买卖。' },
    ],
    offers: [
      {
        text: '这是这次生日会的单品清单。上面的信息不免费。',
        label: '查看单品',
        url: '#goods',
      },
    ],
  },
  {
    id: 'npc-philins',
    scene: 'icefield',
    guest: true,
    tileX: 1, tileY: 23,
    name: '菲林斯',
    icon: '🎁',
    color: 0xffd97a,
    sprite: 'assets/chars-scene/philins-stand.png',
    portrait: { url: 'assets/chars/npc-philins-portrait.png' },
    portraitBg: '#3d3626',
    displayHeight: 188,
    dialog: [
      { text: '这块空地很好，比我想象中更适合挂灯。' },
      { text: '您不必为我添灯——今晚有月亮。我这一生替别人掌灯，倒也愿意做一次被照亮的人。' },
      { text: '安置的事，交给我就好。这是我的本分。' },
    ],
    offers: [
      {
        text: '我做的小东西，您愿意的话，随便看看。',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-sandrone',
    scene: 'pools',
    guest: true,
    tileX: 30, tileY: 4,
    name: '桑多涅',
    icon: '🎪',
    color: 0xa78bfa,
    sprite: 'assets/chars-scene/sandrone-stand.png',
    portrait: { url: 'assets/chars/npc-sandrone-portrait.png' },
    portraitBg: '#2f2a3d',
    displayHeight: 178,
    dialog: [
      { text: '哈。就这儿？安静得连回声都懒得来。' },
      { text: '伊涅芙又来问我『心』的事——我要是知道，还用得着在这儿吹风？让她自己找。' },
      { text: '天黑之前必须布置完。' },
    ],
    offers: [
      {
        text: '我做了个小游戏。……要玩吗？不玩也别浪费我的心血。',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-lawuma',
    scene: 'moonpath',
    guest: true,
    tileX: 19, tileY: 5,
    name: '菈乌玛',
    icon: '🎵',
    color: 0x6fb3ff,
    sprite: 'assets/chars-scene/lawuma-stand.png',
    portrait: { url: 'assets/chars/npc-lawuma-portrait.png' },
    portraitBg: '#26313d',
    displayHeight: 188,
    dialog: [
      { text: '月亮下办生日会，倒是个很合适的说法。' },
      { text: '我要带祭品来——但你说不用。那我就把自己带来。这是我唯一不会改变的礼物。' },
      { text: '我来得不算晚吧？若晚了一步，也许……也不打紧。' },
    ],
    offers: [
      {
        text: '想听听这片林子的故事吗？也许，比您想的长一些。',
        label: '单品展示',
        url: '#goods',
      },
    ],
  },

  // ==========================================================================
  // 第二批客人（2026-10-04 加入）—— 邀请函 docx 里还有 8 位收信人
  // 阿蕾奇诺 / 林尼 / 琳妮特 / 菲米尼 / 那维莱特 / 芙宁娜 / 伊涅芙 / 旅行者
  // 他们没有委托任务，只在会场里聊天。
  // ==========================================================================
  {
    id: 'npc-arlecchino',
    scene: 'venue',
    guest: true,
    tileX: 2, tileY: 6,
    name: '阿蕾奇诺',
    icon: '🖤',
    color: 0xd94f6a,
    sprite: 'assets/chars-scene/arlecchino-stand.png',
    portrait: { url: 'assets/chars/npc-arlecchino-portrait.png' },
    portraitBg: '#2e1a20',
    displayHeight: 188,
    dialog: [
      { text: '月亮上的路，比我想象中好找。' },
      { text: '你信里写的那件事，我记着。' },
      { text: '生日会而已。我准时到。礼物我带来了。不必谢。' },
    ],
    offers: [],
  },
  {
    id: 'npc-lyney',
    scene: 'venue',
    guest: true,
    tileX: 35, tileY: 3,
    name: '林尼',
    icon: '🎩',
    color: 0xe07ad0,
    sprite: 'assets/chars-scene/lyney-stand.png',
    portrait: { url: 'assets/chars/npc-lyney-portrait.png' },
    portraitBg: '#2b2438',
    displayHeight: 176,
    dialog: [
      { text: '「月亮上没有什么像样的舞台」？' },
      { text: '那正好。台子越简陋，魔术越好看。观众离得近，破绽藏不住，那才有意思。' },
      { text: '看仔细咯。今晚这一场，是仅属于月亮的，独一无二的奇迹时刻。' },
      { text: '（说实话，这句话我练了三遍。）' },
    ],
    offers: [
      {
        text: '想看个小魔术吗？就地取材的那种——先说好，看完不许鼓掌，要鼓掌等谢幕。',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-lynette',
    scene: 'pond',
    guest: true,
    tileX: 8, tileY: 14,
    name: '琳妮特',
    icon: '🐱',
    color: 0x9fb6d8,
    sprite: 'assets/chars-scene/lynette-stand.png',
    portrait: { url: 'assets/chars/npc-lynette-portrait.png' },
    portraitBg: '#242c38',
    displayHeight: 172,
    dialog: [
      { text: '……' },
      { text: '（她点了点头，看来确实不打算说话。）' },
      { text: '……茶。谢谢。' },
      { text: '（她把一杯茶推到你面前，说了今天最长的一句话：）『找我？……请长话短说。』' },
    ],
    offers: [],
  },
  {
    id: 'npc-freminet',
    scene: 'grove',
    guest: true,
    tileX: 29, tileY: 10,
    name: '菲米尼',
    icon: '🤿',
    color: 0x7fd0c8,
    sprite: 'assets/chars-scene/freminet-stand.png',
    portrait: { url: 'assets/chars/npc-freminet-portrait.png' },
    portraitBg: '#1f3330',
    displayHeight: 168,
    dialog: [
      { text: '那个…在月亮上遨游……和潜水，真的不一样吗？' },
      { text: '我、我把头盔也带来了。虽然这里…好像用不上。' },
      { text: '这里比海底安静。安静得…有点舒服。' },
      { text: '……谢谢你，愿意让我来看看。' },
    ],
    offers: [],
  },
  {
    id: 'npc-neuvillette',
    scene: 'icefield',
    guest: true,
    tileX: 34, tileY: 23,
    name: '那维莱特',
    icon: '⚖️',
    color: 0x8fb8ff,
    sprite: 'assets/chars-scene/neuvillette-stand.png',
    portrait: { url: 'assets/chars/npc-neuvillette-portrait.png' },
    portraitBg: '#1e2a3d',
    displayHeight: 188,
    dialog: [
      { text: '你特意让今晚不下雨。' },
      { text: '依照惯例，这份人情应当以正式的书面形式收讫——但今晚不在惯例之内。' },
      { text: '……多谢。月亮，我看得很清楚。' },
      { text: '枫丹的雨，今夜也停一停吧。' },
      { text: '今天是你的生日啊，祝你生日快乐。不知道今天下不下雨，我会想想办法的。' },
      { text: '……时常在想，什么时候可以走入一场雨中。' },
    ],
    offers: [],
  },
  {
    id: 'npc-furina',
    scene: 'pools',
    guest: true,
    tileX: 1, tileY: 12,
    name: '芙宁娜',
    icon: '🎬',
    color: 0x86c8ff,
    sprite: 'assets/chars-scene/furina-stand.png',
    portrait: { url: 'assets/chars/npc-furina-portrait.png' },
    portraitBg: '#1d2c42',
    displayHeight: 178,
    dialog: [
      { text: '没有水族箱，也没有镜头？——那更好！纯天然的舞台布景可是稀缺品。' },
      { text: '灯光、走位、情绪——全部交给本人。' },
      { text: '月灵们不会演戏？那就教到会为止。教不会的，也能当群演。' },
      { text: '掌声我收下了。……不过先说好，那句话是真心还是场面话？' },
    ],
    offers: [
      {
        text: '要不要先看一段本人导的片子？只放一遍——本导演的档期很紧。',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-ineffa',
    scene: 'starship',
    guest: true,
    tileX: 14, tileY: 7,
    name: '伊涅芙',
    icon: '⚙️',
    color: 0xc9b6ff,
    sprite: 'assets/chars-scene/ineffa-stand.png',
    portrait: { url: 'assets/chars/npc-ineffa-portrait.png' },
    portraitBg: '#2a2438',
    displayHeight: 172,
    dialog: [
      { text: '正在检索…问题：『有「心」的机械，是如何进行情感活动的？』' },
      { text: '检索结果：无。对策：继续观察现场所有来宾。' },
      { text: '扫帚我就不拿了，你说月亮上不太脏。重复：这并不妨碍我执行『把桌子擦干净』的备用方案。' },
    ],
    offers: [],
  },
  {
    id: 'npc-traveler',
    scene: 'shallows',
    guest: true,
    tileX: 11, tileY: 23,
    name: '旅行者',
    icon: '⭐',
    color: 0xffe08a,
    sprite: 'assets/chars-scene/traveler-stand.png',
    portrait: { url: 'assets/chars/npc-traveler-portrait.png' },
    portraitBg: '#33291a',
    displayHeight: 180,
    dialog: [
      { text: '你果然在这里。' },
      { text: '旅途还长，但今天，我准时到了。' },
      { text: '说起来，派蒙一进门就去数蛋糕了。要不要趁她数完之前先过去看看？' },
    ],
    offers: [],
  },

  // ==========================================================================
  // 伙伴（不是受邀客人）
  //
  // ★ 2026-10-07 用户要求「作图AI制作旅行者空和派蒙（飘在空脑袋的旁边）的 Q 版
  //   （放进会场）」。空 = 男主旅行者，和上面那位「旅行者（荧）」是两个人。
  //
  //   他【没有】 guest: true —— 派蒙和空是陪哥伦比娅来的，不是被邀请的客人，
  //   所以一进会场就该在场，也不参与「13 位客人」那两条验收断言。
  //
  //   派蒙画在同一张立绘里（飘在他脑袋左侧），所以这张图比他本人宽一截；
  //   tools/build-npc-q.py 会把【脚底中心】对齐画布中心，不然他会被推偏半格。
  // ==========================================================================
  {
    id: 'npc-aether',
    scene: 'moonpath',
    tileX: 27, tileY: 23,
    name: '空',
    icon: '🗡',
    color: 0xffd98a,
    sprite: 'assets/chars-scene/aether-stand.png',
    portrait: { url: 'assets/chars/npc-aether-portrait.png' },
    portraitBg: '#33291a',
    displayHeight: 180,
    dialog: [
      { text: '……这里比我想的还热闹。' },
      { text: '派蒙，别乱动人家桌上的东西。……那块也不行。' },
      { text: '生日快乐。今晚的月亮，我们都看见了。' },
    ],
    offers: [],
  },

];

// ---------------------------------------------------------------------------
// 玩家
// ---------------------------------------------------------------------------
export const PLAYER = {
  speed: 210,
  size: 40,
  color: 0x6fb3ff,

  // 主角素材
  //   sprite: 一张立绘（不走路）
  //   sheet : 行走图网格（8 方向 × 每方向 8 帧走路）
  // 两个都不填就用代码画的占位小人
  sprite: null,
  sheet: 'assets/chars-scene/hero-sheet.png',

  // 行走图每帧的尺寸（要和拼图脚本的输出一致）
  // 8 方向 → 雪碧图 8 列 × 8 行 × 192 = 1536×1536
  frameWidth: 192,
  frameHeight: 192,

  // 每个方向的帧数 —— 8 个方向都是 8 帧真实迈步
  // （由图生视频抽帧得到：逐帧生图做不出走路，见 继续任务.md 5.3）
  // 行序必须和 characters.js 的 DIRS / tools/build-hero-sheet2.py 的 ROWS 一致
  framesPerDir: {"down": 8, "left": 8, "right": 8, "up": 8, "downright": 8, "downleft": 8, "upright": 8, "upleft": 8},

  // 主角在场景里的显示高度（像素）
  // 192 = 3 格高；屏幕显示 134px，占 720p 视口约 18.6%
  // （DNF 的角色占屏 17~30%，这个比例接近）
  displayHeight: 192,
};

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------
export const INTERACT = {
  radius: 78,
  // 2026-10-18：从 'E' 改回 'F' —— 第 11 轮就把交互键改成 F 了，
  // 但这里一直没跟着改，成了"文档是 F、配置是 E、代码硬编码 F"的三份真源。
  key: 'F',
};

// ---------------------------------------------------------------------------
// 引导箭头配色
// ---------------------------------------------------------------------------
export const GUIDE = {
  sameSceneColor: 0xffd97a,
  crossSceneColor: 0x9ecbff,
};
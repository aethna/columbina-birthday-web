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
    scene: 'venue',
    guest: true,
    tileX: 11, tileY: 6,
    name: '爱诺',
    icon: '👧',
    color: 0xffc8e0,
    sprite: 'assets/chars-scene/ainuo-stand.png',
    portrait: { url: 'assets/chars/npc-ainuo-portrait.png' },
    portraitBg: '#3d2a3a',
    displayHeight: 128,
    dialog: [
      { text: '哇——！好大的树！' },
      { text: '谢谢你邀请我，我一定来！' },
      { text: '乌吉恩圈那盏灯，我等会儿就去看看。' },
    ],
    offers: [
      {
        text: '要不要玩个小游戏？我带来的！',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-nefer',
    scene: 'venue',
    guest: true,
    tileX: 15, tileY: 19,
    name: '奈芙尔',
    icon: '📋',
    color: 0x4a9a8a,
    sprite: 'assets/chars-scene/nefer-stand.png',
    portrait: { url: 'assets/chars/npc-nefer-portrait.png' },
    portraitBg: '#2a3d3a',
    displayHeight: 188,
    dialog: [
      { text: '收到你的邀请函了。' },
      { text: '「月亮上没有伏尼契商会」——这条情报我记下了。' },
      { text: '既然来了，就帮你把这场生日会办妥吧。' },
    ],
    offers: [
      {
        text: '这是这次生日会的单品清单。',
        label: '查看单品',
        url: '#goods',
      },
    ],
  },
  {
    id: 'npc-philins',
    scene: 'venue',
    guest: true,
    tileX: 27, tileY: 18,
    name: '菲林斯',
    icon: '🎁',
    color: 0xffd97a,
    sprite: 'assets/chars-scene/philins-stand.png',
    portrait: { url: 'assets/chars/npc-philins-portrait.png' },
    portraitBg: '#3d3626',
    displayHeight: 188,
    dialog: [
      { text: '这块空地不错，布置一下会很好看。' },
      { text: '灯我就不带了 —— 今晚有月亮。' },
      { text: '交给我吧。' },
    ],
    offers: [
      {
        text: '我做的小东西，随便看看。',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-sandrone',
    scene: 'venue',
    guest: true,
    tileX: 29, tileY: 15,
    name: '桑多涅',
    icon: '🎪',
    color: 0xa78bfa,
    sprite: 'assets/chars-scene/sandrone-stand.png',
    portrait: { url: 'assets/chars/npc-sandrone-portrait.png' },
    portraitBg: '#2f2a3d',
    displayHeight: 178,
    dialog: [
      { text: '……这里好安静。' },
      { text: '伊涅芙又问我「心」的事了。下次让她自己来问你。' },
      { text: '天黑之前要布置好才行。' },
    ],
    offers: [
      {
        text: '我做了个小游戏，要玩吗？',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-lawuma',
    scene: 'venue',
    guest: true,
    tileX: 21, tileY: 19,
    name: '菈乌玛',
    icon: '🎵',
    color: 0x6fb3ff,
    sprite: 'assets/chars-scene/lawuma-stand.png',
    portrait: { url: 'assets/chars/npc-lawuma-portrait.png' },
    portraitBg: '#26313d',
    displayHeight: 188,
    dialog: [
      { text: '林子里办生日会，倒是别有味道。' },
      { text: '你说不用带祭品……那我就把自己带来了。' },
      { text: '我来得不算晚吧？' },
    ],
    offers: [
      {
        text: '想听听这片林子的故事吗？',
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
    tileX: 10, tileY: 14,
    name: '阿蕾奇诺',
    icon: '🖤',
    color: 0xd94f6a,
    sprite: 'assets/chars-scene/arlecchino-stand.png',
    portrait: { url: 'assets/chars/npc-arlecchino-portrait.png' },
    portraitBg: '#2e1a20',
    displayHeight: 188,
    dialog: [
      { text: '月亮上的路，比我想象中好找。' },
      { text: '你信里写的那件事，我没有忘。' },
      { text: '生日会而已 —— 我准时到。' },
    ],
    offers: [],
  },
  {
    id: 'npc-lyney',
    scene: 'venue',
    guest: true,
    tileX: 14, tileY: 6,
    name: '林尼',
    icon: '🎩',
    color: 0xe07ad0,
    sprite: 'assets/chars-scene/lyney-stand.png',
    portrait: { url: 'assets/chars/npc-lyney-portrait.png' },
    portraitBg: '#2b2438',
    displayHeight: 176,
    dialog: [
      { text: '「月亮上没有什么像样的舞台」？' },
      { text: '那正好。台子越简陋，魔术越好看。' },
      { text: '看着吧，我会让整片月海都鼓掌。' },
    ],
    offers: [
      {
        text: '想看个小魔术吗？就地取材的那种。',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-lynette',
    scene: 'venue',
    guest: true,
    tileX: 21, tileY: 6,
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
      { text: '（……茶，谢谢。）' },
    ],
    offers: [],
  },
  {
    id: 'npc-freminet',
    scene: 'venue',
    guest: true,
    tileX: 24, tileY: 7,
    name: '菲米尼',
    icon: '🤿',
    color: 0x7fd0c8,
    sprite: 'assets/chars-scene/freminet-stand.png',
    portrait: { url: 'assets/chars/npc-freminet-portrait.png' },
    portraitBg: '#1f3330',
    displayHeight: 168,
    dialog: [
      { text: '在月亮上遨游……和潜水，真的不一样吗？' },
      { text: '我把头盔带来了。虽然这里好像用不上。' },
      { text: '……谢谢你，让我来看看。' },
    ],
    offers: [],
  },
  {
    id: 'npc-neuvillette',
    scene: 'venue',
    guest: true,
    tileX: 28, tileY: 9,
    name: '那维莱特',
    icon: '⚖️',
    color: 0x8fb8ff,
    sprite: 'assets/chars-scene/neuvillette-stand.png',
    portrait: { url: 'assets/chars/npc-neuvillette-portrait.png' },
    portraitBg: '#1e2a3d',
    displayHeight: 188,
    dialog: [
      { text: '你特意让今晚不下雨。' },
      { text: '……谢谢。月亮，我看得很清楚。' },
      { text: '枫丹的雨，今夜也停一停吧。' },
    ],
    offers: [],
  },
  {
    id: 'npc-furina',
    scene: 'venue',
    guest: true,
    tileX: 33, tileY: 10,
    name: '芙宁娜',
    icon: '🎬',
    color: 0x86c8ff,
    sprite: 'assets/chars-scene/furina-stand.png',
    portrait: { url: 'assets/chars/npc-furina-portrait.png' },
    portraitBg: '#1d2c42',
    displayHeight: 178,
    dialog: [
      { text: '没有水族箱，也没有镜头？那怎么行！' },
      { text: '灯光、走位、情绪 —— 全部交给我。' },
      { text: '月灵们不会演戏？那就教到会为止。' },
    ],
    offers: [
      {
        text: '要不要先看一段我导的片子？',
        label: '打开小游戏',
        url: 'games/demo-game/index.html',
      },
    ],
  },
  {
    id: 'npc-ineffa',
    scene: 'venue',
    guest: true,
    tileX: 34, tileY: 14,
    name: '伊涅芙',
    icon: '⚙️',
    color: 0xc9b6ff,
    sprite: 'assets/chars-scene/ineffa-stand.png',
    portrait: { url: 'assets/chars/npc-ineffa-portrait.png' },
    portraitBg: '#2a2438',
    displayHeight: 172,
    dialog: [
      { text: '「有『心』的机械，是如何进行情感活动的？」' },
      { text: '这个问题，我一直没问出答案。' },
      { text: '扫帚我就不拿了 —— 你说月亮上不太脏。' },
    ],
    offers: [],
  },
  {
    id: 'npc-traveler',
    scene: 'venue',
    guest: true,
    tileX: 14, tileY: 23,
    name: '旅行者',
    icon: '⭐',
    color: 0xffe08a,
    sprite: 'assets/chars-scene/traveler-stand.png',
    portrait: { url: 'assets/chars/npc-traveler-portrait.png' },
    portraitBg: '#33291a',
    displayHeight: 180,
    dialog: [
      { text: '你果然在这里。' },
      { text: '旅途还长 —— 但今天，我准时到了。' },
      { text: '走吧，去看看你布置好的月亮。' },
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
  //   sheet : 行走图网格（4 方向 × 每方向 8 帧走路）
  // 两个都不填就用代码画的占位小人
  sprite: null,
  sheet: 'assets/chars-scene/hero-sheet.png',

  // 行走图每帧的尺寸（要和拼图脚本的输出一致）
  frameWidth: 192,
  frameHeight: 192,

  // 每个方向的帧数 —— 四个方向都是 8 帧真实迈步
  // （由图生视频抽帧得到：逐帧生图做不出走路，见 继续任务.md 5.3）
  framesPerDir: {"down": 8, "left": 8, "right": 8, "up": 8},

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
  key: 'E',
};

// ---------------------------------------------------------------------------
// 引导箭头配色
// ---------------------------------------------------------------------------
export const GUIDE = {
  sameSceneColor: 0xffd97a,
  crossSceneColor: 0x9ecbff,
};
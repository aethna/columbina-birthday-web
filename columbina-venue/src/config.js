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
export const NPCS = [
  // ==========================================================================
  // 受邀的客人 —— 全部在主会场
  // guest: true 表示「收到邀请函后才会出现」
  // ==========================================================================
  {
    id: 'npc-ainuo',
    scene: 'venue',
    guest: true,
    tileX: 16, tileY: 12,
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
    tileX: 26, tileY: 10,
    name: '奈芙尔',
    icon: '📋',
    color: 0x4a9a8a,
    sprite: 'assets/chars-scene/nefer-stand.png',
    portrait: { url: 'assets/chars/npc-nefer-portrait.png' },
    portraitBg: '#2a3d3a',
    displayHeight: 188,
    dialog: [
      { text: '收到你的邀请函了。' },
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
    tileX: 28, tileY: 15,
    name: '菲林斯',
    icon: '🎁',
    color: 0xffd97a,
    sprite: 'assets/chars-scene/philins-stand.png',
    portrait: { url: 'assets/chars/npc-philins-portrait.png' },
    portraitBg: '#3d3626',
    displayHeight: 188,
    dialog: [
      { text: '这块空地不错，布置一下会很好看。' },
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
    tileX: 21, tileY: 14,
    name: '桑多涅',
    icon: '🎪',
    color: 0xa78bfa,
    sprite: 'assets/chars-scene/sandrone-stand.png',
    portrait: { url: 'assets/chars/npc-sandrone-portrait.png' },
    portraitBg: '#2f2a3d',
    displayHeight: 178,
    dialog: [
      { text: '……这里好安静。' },
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
    tileX: 12, tileY: 15,
    name: '菈乌玛',
    icon: '🎵',
    color: 0x6fb3ff,
    sprite: 'assets/chars-scene/lawuma-stand.png',
    portrait: { url: 'assets/chars/npc-lawuma-portrait.png' },
    portraitBg: '#26313d',
    displayHeight: 188,
    dialog: [
      { text: '林子里办生日会，倒是别有味道。' },
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
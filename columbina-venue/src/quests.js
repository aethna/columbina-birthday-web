/**
 * 任务配置
 *
 * 设计原则：
 *   任务由 NPC 发放（NPC 在主会场），内容是筹备林间生日会所需的物资。
 *   因为主会场是林地，没有现成的派对用品，所以任务都是「去别处收集」。
 *
 * 剧情顺序：
 *   主线：在书桌写 11 封邀请函 → 收起来 → 投信箱 → 13 位客人前来
 *     ↓
 *   委托：每个 NPC 一个任务，为主题筹备物资
 *
 * 任务目标类型：
 *   talk      和指定 NPC 对话
 *   visit     走到指定场景的指定位置
 *   collect   收集 N 个物品（由场景里的交互点触发）
 *   openGame  打开小游戏
 */

export const QUESTS = [
  // =========================================================================
  // 主线：写邀请函 & 投递
  // 这两个任务不由 NPC 发放，而是推进剧情用的
  //
  // ★ 流程改版（2026-10-04）：写信环节回来了，而且升级成一段过场
  //   旧：　　　　　　　　　　　　　　 收起 → 投递
  //   新：书桌前按 E 写一封（信纸逐行展开 → 收归信封）→ 桌上累积
  //       → 收起 → 投递
  //   正文来自《生日会邀请函.docx》，一共 11 封（见 StorySystem.js 的 GUESTS）。
  // =========================================================================
  {
    id: 'main-write',
    // title 里的 id 保持 main-write 不变 —— 存档、验收脚本都按这个 id 找任务，
    // 改 id 会让老存档和新脚本都对不上。只改给人看的文案。
    title: '【主线】写邀请函',
    desc: '走到窗前的书桌，把邀请函一封一封写好',
    scene: 'home',
    // 特殊标记：不是 NPC 派发，而是场景交互推进
    special: 'write',
    // count 要和 StorySystem.js 的 GUESTS.length 一致（11 封）
    target: { type: 'writeLetters', count: 11 },
    reward: null,
    autoAccept: true,
  },
  {
    id: 'main-deliver',
    title: '【主线】投递邀请函',
    desc: '把写好的邀请函投进林间信箱',
    scene: 'mailbox',
    special: 'deliver',
    target: { type: 'deliverLetters', count: 1 },
    reward: null,
    autoAccept: true,
  },

  // =========================================================================
  // 委托：每个 NPC 一个，筹备生日会物资
  // =========================================================================

  // —— 爱诺（小孩，活泼）→ 去池塘捉鱼 ——
  {
    id: 'q-ainuo-fish',
    scene: 'venue',
    title: '【委托】池塘捉鱼',
    desc: '爱诺说想吃鱼。去池塘边捉几条回来吧',
    giverNpcId: 'npc-ainuo',
    deliverNpcId: 'npc-ainuo',
    // 交付后会在会场出现的道具（和任务一一对应）
    //
    // ★ 坐标来源：场景网格图/林间空地委托完成后道具点位.png
    //   用户在图上用红框标了 10 个可放道具的格子，
    //   下面 5 个道具各占其中一个，互不重复。
    //   （红框=1 格；按 64px/格 最小二乘拟合，误差为 0）
    propReward: { id: 'fish-basket', name: '鱼篓', tileX: 5, tileY: 22, h: 92 },
    target: {
      // 改成采集类：由场景里的交互点触发（原来走到就算完成，没过程感）
      type: 'collect',
      itemId: 'fish',
      count: 1,
      needLabel: '在池塘边捉鱼',
    },
    reward: '爱诺的星星糖 ×3',
  },

  // —— 奈芙尔（干练，负责）→ 去池塘打水 ——
  {
    id: 'q-nefer-water',
    scene: 'venue',
    title: '【委托】打一桶清水',
    desc: '奈芙尔说煮茶和洗果子都要用水。拿上她给的空桶，去池塘打一桶回来',
    giverNpcId: 'npc-nefer',
    deliverNpcId: 'npc-nefer',
    // 交付后会在会场出现的道具（和任务一一对应）
    propReward: { id: 'water-bucket', name: '水桶', tileX: 9, tileY: 22, h: 86 },
    // 接任务时先给一个空桶 —— 没有它到池塘也打不了水
    onAcceptGive: { id: 'bucket-empty', name: '空桶' },
    target: {
      // 不再用「走到某处」，改成「拿到装满水的桶」
      type: 'collect',
      itemId: 'water-full',
      count: 1,
      needLabel: '在池塘边打满一桶水',
    },
    reward: '奈芙尔的护符 ×1',
  },

  // —— 菲林斯（手巧，爱美）→ 采野花做装饰 ——
  {
    id: 'q-philins-flower',
    scene: 'venue',
    title: '【委托】采集野花',
    desc: '菲林斯说空地上太素了，想用野花装点一下',
    giverNpcId: 'npc-philins',
    deliverNpcId: 'npc-philins',
    // 交付后会在会场出现的道具（和任务一一对应）
    propReward: { id: 'flower-vase', name: '花瓶', tileX: 12, tileY: 22, h: 96 },
    target: {
      // 改成采集类：由场景里的交互点触发（原来走到就算完成，没过程感）
      type: 'collect',
      itemId: 'flower',
      count: 1,
      needLabel: '在秘境采花',
    },
    reward: '菲林斯的手环 ×1',
  },

  // —— 桑多涅（人偶少女，爱玩）→ 采发光蘑菇当灯 ——
  {
    id: 'q-sandrone-mushroom',
    scene: 'venue',
    title: '【委托】会发光的蘑菇',
    desc: '桑多涅说天黑看不见，想要会发光的蘑菇当灯',
    giverNpcId: 'npc-sandrone',
    deliverNpcId: 'npc-sandrone',
    // 交付后会在会场出现的道具（和任务一一对应）
    propReward: { id: 'mushroom-lamp', name: '蘑菇灯', tileX: 28, tileY: 22, h: 90 },
    target: {
      // 改成采集类：由场景里的交互点触发（原来走到就算完成，没过程感）
      type: 'collect',
      itemId: 'mushroom',
      count: 1,
      needLabel: '在秘境采发光的蘑菇',
    },
    reward: '桑多涅的发条 ×1',
  },

  // —— 菈乌玛（年长，神秘）→ 收集干柴生火 ——
  {
    id: 'q-lawuma-firewood',
    scene: 'venue',
    title: '【委托】拾取干柴',
    desc: '菈乌玛说夜里要生一堆火。去秘境周围拾些干柴',
    giverNpcId: 'npc-lawuma',
    deliverNpcId: 'npc-lawuma',
    // 交付后会在会场出现的道具（和任务一一对应）
    propReward: { id: 'firewood-pile', name: '柴堆', tileX: 32, tileY: 22, h: 74 },
    target: {
      // 改成采集类：由场景里的交互点触发（原来走到就算完成，没过程感）
      type: 'collect',
      itemId: 'firewood',
      count: 1,
      needLabel: '在秘境拾一捆干柴',
    },
    reward: '菈乌玛的故事 ×1',
  },

  // =========================================================================
  // 结局：庆功宴上的「切蛋糕」
  //
  // ★ 这条任务【不是开局就有的】。它带 afterParty 标记：
  //     · QuestSystem.snapshot() 在庆功宴开起来之前完全不把它列进任务列表；
  //     · celebration.isPartyTime() 也把带这个标记的任务排除在
  //       「是不是所有委托都完成了」的判定之外 ——
  //       否则它自己会把那个条件顶掉，围桌永远开不起来。
  //   围桌一开，任务列表里就自动多出这一条（用户原话：「任务列表刷新新任务：切蛋糕」）。
  // =========================================================================
  {
    id: 'q-party-cake',
    scene: 'venue',
    title: '【结局】切蛋糕',
    desc: '大家都到齐了。走到主位，为这场生日会切下第一块蛋糕',
    afterParty: true,
    // 出现即「进行中」—— 不需要找谁去接
    autoAccept: true,
    // 进度由交互点直接置满（见 QuestSystem.completeById），
    // 这里写个占位目标只是让任务列表有进度条可画
    target: { type: 'interact', count: 1 },
    reward: null,
  },
];

// ---------------------------------------------------------------------------
// 场景里的可交互点
// ---------------------------------------------------------------------------
// 这些是「走到附近按 E 触发」的功能点。
//
// 邀请函流程（当前版本）：
//   书桌写 → 从桌上拿 → 去信箱投递
//
// 为什么分「写」和「拿」两步：
//   直接写好就自动收进包里没有实感。
//   分成两步后，玩家能明确看到「桌上多了东西 → 我拿走了」，
//   以后要加"坐下来写字的动画"时，也是在「写」这一步插。
//
// id        : 唯一标识
// scene     : 所在场景
// tileX/Y   : 位置（格子）
// icon      : 头顶图标
// label     : 名称
// hint      : 走近时的提示
// action    : 触发动作
//   'writeLetter'   写一封（放在桌上）
//   'takeLetters'   从桌上拿走写好的
//   'deliver'       投递
//   'none'          只是看看
// requires  : 触发前提
// ---------------------------------------------------------------------------
export const INTERACT_POINTS = [
  // ===== 书桌场景 =====
  //
  // ★ 流程改版（2026-10-04 第二版）：写信 → 投递，中间不再有「收起来」
  //
  //   书桌只剩一件事：还没写完就按 E 写下一封（信纸逐行展开 → 收归信封的过场）。
  //   信纸过场的收尾就是「折起来 → 收进信封 → 封口 → 飞走」，那一刻这封信
  //   已经进了哥伦比娅怀里（StorySystem 直接记 carried），所以没有
  //   「先堆在桌上、再回来按 E 收进怀里」这一步了。
  //
  //   为什么删掉那一步：
  //     它没有任何任务在指引（main-write 写满第 11 封就自动完成，主线立刻把玩家
  //     指向「投递邀请函 → 前往信箱」），玩家走到信箱却发现 requires 不满足、
  //     没提示也没反应，直接卡死（用户 2026-10-04 反馈的问题4）。
  //
  //   label / hint / shape / requires 都可以写成 (story) => ... 的函数，
  //   InteractPoints 会用当期剧情求值（见 InteractPoints.js 的 resolve()）。
  {
    id: 'ip-desk',
    scene: 'home',
    tileX: 15, tileY: 5,
    shape: 'pen',
    label: '窗前的书桌',
    hint: (s) => `按 E 写邀请函（${s.writtenCount}/${s.totalCount}）`,
    action: 'writeOrTake',
    // 11 封都写完了，这个点就【整个消失】（连幽灵图标都不留，见 InteractPoints.rebuild）
    requires: (s) => !s.allWritten,
    hideWhenUnavailable: true,
  },

  // ===== 信箱场景 =====
  {
    id: 'ip-mailbox',
    scene: 'mailbox',
    tileX: 21, tileY: 13,
    shape: 'mailbox',
    label: '林间信箱',
    hint: '按 E 投递邀请函',
    action: 'deliver',
    // 11 封都写好、还没投出去 → 信箱可用（信在 carried 里，见 StorySystem.writeLetter）
    requires: 'allWrittenNotDelivered',
  },

  // ===== 池塘：任务目标点 =====
  {
    id: 'ip-pond-fish',
    questId: 'q-ainuo-fish',
    scene: 'pond',
    tileX: 14, tileY: 11,
    shape: 'fish',
    label: '水边',
    hint: '能看到鱼影',
    // 采集：按 E 拿到任务物品（itemId 要和任务目标的 itemId 对上）
    action: 'collectItem',
    collectId: 'fish',
    okText: '你卷起裤脚，在浅水里捞了一阵。\n还真抓到了一条肥鱼。',
  },
  {
    id: 'ip-pond-water',
    questId: 'q-nefer-water',
    scene: 'pond',
    tileX: 27, tileY: 5,
    shape: 'drop',
    label: '取水处',
    hint: '按 E 打水',
    // 通用换物：需要空桶 -> 给装满水的桶
    //
    // 为什么这么做：
    //   原来的打水任务是「走到水边就算完成」，没有过程感。
    //   改成携带空桶来装水，玩家能明确看到「桶空了 -> 桶满了」。
    action: 'exchangeItem',
    needItem: 'bucket-empty',
    needHint: '你没有能装水的东西。先去会场找奈芙尔接下打水的委托，她会给你一个空桶。',
    giveItem: 'water-full',
    giveName: '装满水的桶',
    doneItem: 'water-full',
    doneHint: '桶已经装满了，赶紧送回去吧。',
    okText: '你蹲在池边，把桶按进水里。\n水很凉，一下子就满了。',
    collectId: 'water-full',
  },

  // ===== 秘境：任务目标点 =====
  {
    id: 'ip-grove-flower',
    questId: 'q-philins-flower',
    scene: 'grove',
    tileX: 27, tileY: 11,
    shape: 'flower',
    label: '花丛',
    hint: '开得正好的野花',
    // 采集：按 E 拿到任务物品（itemId 要和任务目标的 itemId 对上）
    action: 'collectItem',
    collectId: 'flower',
    okText: '你挑了几朵开得最好的野花，\n小心地连茎折下来。',
  },
  {
    id: 'ip-grove-mushroom',
    questId: 'q-sandrone-mushroom',
    scene: 'grove',
    tileX: 7, tileY: 10,
    shape: 'mushroom',
    label: '发光蘑菇',
    hint: '泛着微光',
    // 采集：按 E 拿到任务物品（itemId 要和任务目标的 itemId 对上）
    action: 'collectItem',
    collectId: 'mushroom',
    okText: '这种蘑菇在暗处泛着淡淡的蓝光。\n你采下两朵。',
  },
  {
    id: 'ip-grove-wood',
    questId: 'q-lawuma-firewood',
    scene: 'grove',
    tileX: 18, tileY: 20,
    shape: 'wood',
    label: '干柴堆',
    hint: '一些枯枝',
    // 采集：按 E 拿到任务物品（itemId 要和任务目标的 itemId 对上）
    action: 'collectItem',
    collectId: 'firewood',
    okText: '你捡了一捆干燥的枯枝，\n用草绳捆好。',
  },

  // ===== 主会场：庆功宴主位（切蛋糕） =====
  //
  // 位置就是哥伦比娅在围桌场景里站的那个「主位口袋」(19,9) ——
  // 左边两位旅行者、右边桑多涅。庆典一开她人就在这个点上，
  // 所以玩家站在那儿按 E 就能切。
  {
    id: 'ip-party-cake',
    questId: 'q-party-cake',
    scene: 'venue',
    tileX: 19, tileY: 9,
    shape: 'cake',
    label: '切蛋糕',
    hint: '按 E 切开生日蛋糕',
    action: 'cake',
    // 只有庆功宴开了才存在；没开的时候【连这个点都不建】
    // （hideWhenUnavailable + requires，见 InteractPoints.rebuild）
    requires: 'partyTime',
    hideWhenUnavailable: true,
    // ★ 这个点落在桌子前沿上：图标和文字都要抬到桌面之上，
    //   否则会被大桌子（depth 450）盖住，玩家根本看不见。
    iconDy: -34,
    labelDy: -66,
  },
];

/**
 * 主线剧情系统
 *
 * 剧情流程：
 *   1. 开场：只有主角，没有任何 NPC
 *   2. 到窗前书桌坐下，按 E 写邀请函 —— 一封一封写（共 11 封）
 *      每写一封：信纸在屏幕上展开、内容逐行显示 → 收归信封
 *   3. 把桌上写好的信收起来
 *   4. 去林间信箱投递
 *   5. 13 位客人受邀前来，出现在主会场
 *   6. NPC 开始派发委托（收集食材、装饰等）
 *
 * 设计说明：
 *   - 剧情进度存在 localStorage，刷新不丢
 *   - NPC 是否出现，由「邀请函是否写完并投递」决定
 *   - 正文来自《生日会邀请函.docx》，一字未改；
 *     一封邀请函可以同时寄给几个人（比如林尼、琳妮特、菲米尼共收一封），
 *     所以这里以「信」为单位（GUESTS 的每一项 = 一封），
 *     每封信带 npcIds 数组指向收信的 NPC。
 */

const STORAGE_KEY = 'venue-story-v1';

/** 当前存档版本 —— 每次改流程/改信件结构都要 +1 */
export const STORY_VERSION = 4;

// ---------------------------------------------------------------------------
// 邀请函（顺序 = 写在纸上的顺序 = 玩家写的顺序）
//
//   id      : 信的唯一标识（写进存档）
//   to      : 信纸抬头的称呼
//   name    : 收件人显示名（任务/提示里用）
//   npcIds  : 这封信邀请的是哪几位（可能多人共收一封）
//   lines   : 正文段落，一句一段，逐行显示
//   sign    : 落款
// ---------------------------------------------------------------------------
const SIGN = '——哥伦比娅•希珀塞莱尼娅';

export const GUESTS = [
  {
    id: 'letter-sandrone',
    to: '桑多涅：',
    name: '桑多涅',
    npcIds: ['npc-sandrone'],
    lines: [
      '我要过生日了。',
      '1月14日，在月亮上。',
      '这次是我第一次以固定的日子过生日。过去我不太明白什么是“生日”，只知道祈月之夜是个愉快的“节日”，人们会为我准备好吃的贡品，会围在一起跳舞。但我觉得还是你的茶会更有趣，我很怀念过去和大家一起嬉闹的时光。',
      '只需要在有月光的地方呼唤我的名字，月光会为你指引通往生日会的道路。',
      '我很期待你的到来。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-arlecchino',
    to: '阿蕾奇诺：',
    name: '阿蕾奇诺',
    npcIds: ['npc-arlecchino'],
    lines: [
      '我要过生日了。在月亮上。',
      '我很怀念祈月之夜和你一起玩的日子。',
      '也记得你和我一同对抗博士，和同伴们一起把我带回这个世界的经历。',
      '当初有你的帮忙，让月亮重新回到了提瓦特。',
      '现在，我想邀请你，来月亮上看看。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-triplets',
    to: '林尼、琳妮特、菲米尼：',
    name: '林尼、琳妮特、菲米尼',
    npcIds: ['npc-lyney', 'npc-lynette', 'npc-freminet'],
    lines: [
      '你们好。',
      '我是哥伦比娅。',
      '我要在月亮上过生日。月亮上没有什么像样的舞台，但我听说林尼可以在任何地方表演魔术。如果你们愿意来的话，我会准备蛋糕和茶。',
      '琳妮特可以不用说话。发呆也可以。我平时也经常发呆。派蒙说这样不太好，但我觉得没什么。',
      '菲米尼想来试试在月球上遨游吗？说不定是和潜水完全不一样的感受。',
      '你们的登场，会让月亮也跟着热闹。',
      '我很期待你们三个能来。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-neuvillette',
    to: '那维莱特先生：',
    name: '那维莱特',
    npcIds: ['npc-neuvillette'],
    lines: [
      '我是哥伦比娅。',
      '你是枫丹的最高审判官，大概很忙。但我还是想问一下：',
      '你愿意来月亮上参加我的生日会吗？',
      '听说枫丹经常下雨。那天夜晚枫丹下雨的时候，我抬头看过，月亮是看不清的。所以我想，你可能不常看见清晰明亮的月亮。如果你来的话，我会让那天晚上不下雨的。这件事我大概能做到，让你来的路上有明亮的月光。',
      '希望可以看到你开心地前来。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-furina',
    to: '芙宁娜导演：',
    name: '芙宁娜',
    npcIds: ['npc-furina'],
    lines: [
      '您好。',
      '我们在千灵映影节一起给水族箱选过“演员”。您说要选一条气质符合的鱼。我到现在也不太确定“气质”是怎么看出来的。',
      '我的生日派对在月亮上。没有水族箱，也没有镜头。',
      '但如果您来的话，可以继续当导演。月亮上的月灵们大概不太会演戏，但您可以教他们。',
      '您的到来一定能让月亮上有热热闹闹的戏份。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-ainuo',
    to: '爱诺：',
    name: '爱诺',
    npcIds: ['npc-ainuo'],
    lines: [
      '月亮上的机器不少，但大部分为龙族留下的科技。月灵们不太会修东西。',
      '如果你来的话，能不能帮我看看乌吉恩圈的灯？有一盏好像不太亮了。',
      '当然，蛋糕管够。蛋卷也可以。我知道你喜欢甜的东西。',
      '想要来月亮上一起发明些新奇的玩意吗？',
      '我可以用月矩力帮你。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-lawuma',
    to: '菈乌玛：',
    name: '菈乌玛',
    npcIds: ['npc-lawuma'],
    lines: [
      '我要过生日了。',
      '以前在霜月之子的时候，你们会为我准备祭品。那时候我不太明白为什么要那样做。现在稍微明白了一点。',
      '你跟我说要多交朋友。我交到了一些。虽然有时候还是会用错方法，比如给陌生人一拳。派蒙说这样不对。',
      '生日那天，你不用带祭品来。带你自己来就好。',
      '以前，是你主动带霜月之子拉起我的手。',
      '现在，换我主动在生日上邀请你了。很开心你的到来。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-nefer',
    to: '奈芙尔：',
    name: '奈芙尔',
    npcIds: ['npc-nefer'],
    lines: [
      '你说要“多体验没见过的东西”。月亮上应该算没见过的吧。',
      '我要在那里过生日。如果你想来，我非常欢迎你的到来。如果你觉得情报不够，我可以先告诉你一些月亮上的事：',
      '月亮上有月灵。它们会说话，但说的话很难懂。',
      '月亮上没有伏尼契商会。',
      '但月亮上绝对有值得你一看的美景。',
      '这，算不算一种有价值的情报呢？',
      '希望值得你的到来吧。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-ineffa',
    to: '伊涅芙：',
    name: '伊涅芙',
    npcIds: ['npc-ineffa'],
    lines: [
      '我要在月亮上办生日会。',
      '我有些想不明白一件事，有「心」的机械是如何进行情感活动的？',
      '以前我也向桑多涅提问过，但一直没太搞懂。',
      '不过现在，我一直在主动学这件事，虽然学得不太好。如果你来的话，我们可以聊聊这个。你不用帮我扫地，月亮上不太脏。',
      '因为我已经把月亮打扫好了，期待你的到来。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-philins',
    to: '菲林斯先生：',
    name: '菲林斯',
    npcIds: ['npc-philins'],
    lines: [
      '我要在月亮上过生日。月亮上的灯光很暗，比灯塔暗多了。但是月亮很亮。',
      '所以如果你来，可能不用自己带一盏灯。',
      '你看守了那么久的灯塔，想请你看看月亮的光。',
      '你来的路上，不必顺着灯指引，月光会为你照亮前方。',
    ],
    sign: SIGN,
  },
  {
    id: 'letter-traveler',
    to: '旅行者：',
    name: '旅行者',
    npcIds: ['npc-traveler'],
    lines: [
      '你现在应该还在旅途的路上吧。',
      '从前总是你来银月之庭陪我，如今……换我在月亮上邀请你了。',
      '虽然你仍奔走在旅途之中，但我心里总觉得，',
      '你会准时到来。',
      '就像那天我们在你的飞船旁谈话那样，像提瓦特与月亮间的引力，你总会找到我的。',
    ],
    sign: SIGN,
  },
];

/** npcId -> 那封信（一个 NPC 只会收到一封） */
const LETTER_OF_NPC = {};
for (const g of GUESTS) {
  for (const id of g.npcIds) LETTER_OF_NPC[id] = g;
}

export function letterOfNpc(npcId) {
  return LETTER_OF_NPC[npcId] || null;
}

// ---------------------------------------------------------------------------
export default class StorySystem {
  constructor(onChange = null) {
    this.onChange = onChange;
    this.data = this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (!Array.isArray(parsed.lettersWritten)) parsed.lettersWritten = [];
          if (typeof parsed.onDesk !== 'number') parsed.onDesk = 0;
          if (typeof parsed.carried !== 'number') parsed.carried = 0;

          // ★ 旧存档（version < 4）迁移
          //
          //   老存档里 lettersWritten 存的是 npcId，而且中途一度删掉过「写信」环节
          //   （5 封信开局就在桌上）。现在写信环节回来了，而且信的粒度和数量都变了
          //   （5 封 → 11 封，一封可多人共收），老进度没法一一对应：
          //     · 已经投递完成的存档 → 视为全部完成，不倒退
          //     · 其他（含已写若干封 / 已收起 / 未投递）→ 回到「一封都没写」，
          //       让玩家把新的写信环节完整走一遍（想保留旧进度可点左下角「初始化」前先截图）
          if ((parsed.version || 1) < STORY_VERSION) {
            if (parsed.delivered) {
              parsed.lettersWritten = GUESTS.map((g) => g.id);
              parsed.onDesk = 0;
              parsed.carried = 0;
            } else {
              parsed.lettersWritten = [];
              parsed.onDesk = 0;
              parsed.carried = 0;
              parsed.delivered = false;
            }
            parsed.version = STORY_VERSION;
          }

          return parsed;
        }
      }
    } catch (e) {
      console.warn('读取剧情进度失败，重新开始', e);
    }
    // 初始状态：一封都还没写，全部要在书桌上写完
    return {
      lettersWritten: [],
      onDesk: 0,
      carried: 0,
      delivered: false,
      version: STORY_VERSION,
    };
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('保存剧情进度失败', e);
    }
  }

  notify(kind) {
    if (this.onChange) this.onChange(this, kind);
  }

  // -------------------------------------------------------------------------
  // 状态查询
  // -------------------------------------------------------------------------

  /** 写好的邀请函数量 */
  get writtenCount() {
    return this.data.lettersWritten.length;
  }

  /** 邀请函总数（= 信件封数，不是 NPC 人数） */
  get totalCount() {
    return GUESTS.length;
  }

  /** 是否所有邀请函都写完了 */
  get allWritten() {
    return this.writtenCount >= this.totalCount;
  }

  /** 是否已投递 */
  get isDelivered() {
    return !!this.data.delivered;
  }

  /** 某封信是否已写 */
  hasLetter(letterId) {
    return this.data.lettersWritten.includes(letterId);
  }

  /** 某个 NPC 的邀请函是否已经写好（多人共收一封时，写一封就算都给到了） */
  hasLetterFor(npcId) {
    const g = letterOfNpc(npcId);
    return g ? this.hasLetter(g.id) : false;
  }

  /**
   * 某个 NPC 现在是否应该出现在场景里
   *
   * 当前规则：必须全部写完并投递，客人一起出现。
   * （后期想改成"写一个来一个"，把这里改成
   *   `return this.hasLetterFor(npcId) && this.isDelivered;` 即可）
   */
  isGuestArrived(npcId) {
    if (!this.allWritten || !this.isDelivered) return false;
    return !!letterOfNpc(npcId);
  }

  /** 当前应该显示哪些 NPC */
  arrivedGuests() {
    if (!this.allWritten || !this.isDelivered) return [];
    return Object.keys(LETTER_OF_NPC);
  }

  /** 下一封该写的邀请函（没写完时用） */
  nextGuest() {
    return GUESTS.find((g) => !this.hasLetter(g.id)) || null;
  }

  // -------------------------------------------------------------------------
  // 推进剧情
  // -------------------------------------------------------------------------

  /**
   * 在书桌上写一封邀请函
   * @returns {Object|null} 刚写好的那封信（含抬头/正文/落款），写不了返回 null
   */
  writeLetter() {
    if (this.allWritten) return null;

    const g = this.nextGuest();
    if (!g) return null;

    this.data.lettersWritten.push(g.id);
    this.data.onDesk = (this.data.onDesk || 0) + 1;   // 先放在桌上
    this.save();
    this.notify('write');

    return g;
  }

  /**
   * 从桌上拿走写好的邀请函
   *
   * 流程上这一步是必需的：
   *   写 → 放在桌上 → 拿走 → 才能去信箱投递
   * 这样玩家能明确看到「桌上多了东西，我收起来了」。
   *
   * @returns {number} 拿走了几封，0 表示桌上没东西
   */
  takeLetters() {
    const n = this.data.onDesk || 0;
    if (n <= 0) return 0;

    this.data.onDesk = 0;
    this.data.carried = (this.data.carried || 0) + n;
    this.save();
    this.notify('take');
    return n;
  }

  /** 桌上待拿的信有几封 */
  get onDeskCount() {
    return this.data.onDesk || 0;
  }

  /** 身上带着几封 */
  get carriedCount() {
    return this.data.carried || 0;
  }

  /**
   * 投递邀请函
   * @returns {boolean} 是否成功
   */
  deliverLetters() {
    if (!this.allWritten) return false;
    if (this.data.delivered) return false;
    // 必须先把信从桌上拿走，才能投递
    if ((this.data.carried || 0) <= 0) return false;

    this.data.carried = 0;
    this.data.delivered = true;
    this.save();
    this.notify('deliver');
    return true;
  }

  /** 给 UI 用的快照 */
  snapshot() {
    return {
      written: this.writtenCount,
      total: this.totalCount,
      allWritten: this.allWritten,
      delivered: this.isDelivered,
      onDesk: this.onDeskCount,
      carried: this.carriedCount,
      nextGuest: this.nextGuest(),
      letters: GUESTS.map((g) => ({
        id: g.id,
        to: g.to,
        name: g.name,
        npcIds: g.npcIds,
        written: this.hasLetter(g.id),
        arrived: this.isGuestArrived(g.npcIds[0]),
      })),
      guests: GUESTS.map((g) => ({
        npcId: g.npcIds[0],
        npcIds: g.npcIds,
        name: g.name,
        written: this.hasLetter(g.id),
        arrived: this.isGuestArrived(g.npcIds[0]),
      })),
    };
  }

  /** 调试用：重置剧情 */
  reset() {
    this.data = {
      lettersWritten: [],
      onDesk: 0,
      carried: 0,
      delivered: false,
      version: STORY_VERSION,
    };
    this.save();
    this.notify('reset');
  }
}

/**
 * 主线剧情系统
 *
 * 剧情流程：
 *   1. 开场：只有主角，没有任何 NPC
 *   2. 在书桌写邀请函（5 封，对应 5 个 NPC）
 *   3. 去信箱投递
 *   4. NPC 受邀前来，出现在主会场
 *   5. NPC 开始派发委托（收集食材、装饰等）
 *
 * 设计说明：
 *   - 剧情进度存在 localStorage，刷新不丢
 *   - NPC 是否出现，由「邀请函是否写完并投递」决定
 *   - 后期要做"写一个来一个"的话，把 invitedCount 改成实时读
 *     已写邀请函数量即可，这里的接口已经预留
 */

const STORAGE_KEY = 'venue-story-v1';

// ---------------------------------------------------------------------------
// 被邀请的 NPC（顺序 = 写邀请函的顺序）
// ---------------------------------------------------------------------------
export const GUESTS = [
  {
    npcId: 'npc-ainuo',
    name: '爱诺',
    // 邀请函文案（后期用户会给正式文案，这里先占位）
    letter: '爱诺，请你来参加我的生日会。',
  },
  {
    npcId: 'npc-nefer',
    name: '奈芙尔',
    letter: '奈芙尔，请你来参加我的生日会。',
  },
  {
    npcId: 'npc-philins',
    name: '菲林斯',
    letter: '菲林斯，请你来参加我的生日会。',
  },
  {
    npcId: 'npc-sandrone',
    name: '桑多涅',
    letter: '桑多涅，请你来参加我的生日会。',
  },
  {
    npcId: 'npc-lawuma',
    name: '菈乌玛',
    letter: '菈乌玛，请你来参加我的生日会。',
  },
];

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
          if (typeof parsed.onDesk !== 'number') parsed.onDesk = 0;
          if (typeof parsed.carried !== 'number') parsed.carried = 0;

          // ★ 旧存档（version < 3）迁移到新流程
          //
          //   旧流程里玩家可能停在「一封都没写」的状态（lettersWritten 为空），
          //   而新流程已经把「写信」这一步去掉了 —— 不迁移的话：
          //     没信可写（交互点没了）+ 桌上也没信 → 主线彻底卡死。
          //   所以旧存档一律补成「5 封都写好、摆在桌上」。
          //   （已经收走或已投递的进度保留，不倒退）
          if ((parsed.version || 1) < 3) {
            const need = GUESTS.length;
            if ((parsed.lettersWritten || []).length < need) {
              parsed.lettersWritten = GUESTS.map((g) => g.npcId);
            }
            if (!parsed.delivered && !parsed.carried) {
              parsed.onDesk = Math.max(parsed.onDesk || 0, need);
            }
            parsed.version = 3;
          }

          return parsed;
        }
      }
    } catch (e) {
      console.warn('读取剧情进度失败，重新开始', e);
    }
    // 初始状态：5 封邀请函**已经写好摆在桌上**
    //
    // ★ 流程改版（2026-09-28）：
    //   旧流程：写信（书桌）→ 桌上累积 → 收起信件 → 邮箱投递
    //   新流程：　　　　　　　　　　　 收起信件 → 邮箱投递
    //
    //   去掉「写信」这一步之后，"信从哪来"需要一个交代 ——
    //   就让 5 封信开局就在书桌旁摆着，玩家直接去收起。
    //   所以 lettersWritten 一开始就是满的、onDesk = 5。
    return {
      lettersWritten: GUESTS.map((g) => g.npcId),   // 5 封都已写好
      onDesk: GUESTS.length,                        // 全都摆在桌上等着收
      carried: 0,
      delivered: false,
      version: 3,
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

  /** 邀请函总数（= NPC 数量） */
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

  /** 某个 NPC 的邀请函是否已写 */
  hasLetter(npcId) {
    return this.data.lettersWritten.includes(npcId);
  }

  /**
   * 某个 NPC 现在是否应该出现在场景里
   *
   * 当前规则：必须全部写完并投递，NPC 才一起出现。
   * （后期想改成"写一个来一个"，把这里改成
   *   `return this.hasLetter(npcId) && this.isDelivered;` 即可）
   */
  isGuestArrived(npcId) {
    if (!this.allWritten || !this.isDelivered) return false;
    return GUESTS.some((g) => g.npcId === npcId);
  }

  /** 当前应该显示哪些 NPC */
  arrivedGuests() {
    if (!this.allWritten || !this.isDelivered) return [];
    return GUESTS.map((g) => g.npcId);
  }

  /** 下一封该写谁的邀请函（没写完时用） */
  nextGuest() {
    return GUESTS.find((g) => !this.hasLetter(g.npcId)) || null;
  }

  // -------------------------------------------------------------------------
  // 推进剧情
  // -------------------------------------------------------------------------

  /**
   * 在书桌上写一封邀请函
   * @returns {Object|null} 写好的那封（含 NPC 名字和文案），写不了返回 null
   */
  writeLetter() {
    if (this.allWritten) return null;

    const g = this.nextGuest();
    if (!g) return null;

    this.data.lettersWritten.push(g.npcId);
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
      guests: GUESTS.map((g) => ({
        ...g,
        written: this.hasLetter(g.npcId),
        arrived: this.isGuestArrived(g.npcId),
      })),
    };
  }

  /** 调试用：重置剧情 */
  reset() {
    this.data = { lettersWritten: [], onDesk: 0, carried: 0, delivered: false, version: 2 };
    this.save();
    this.notify('reset');
  }
}

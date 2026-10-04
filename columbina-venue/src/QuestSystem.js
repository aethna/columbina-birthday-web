/**
 * 任务系统 —— 支持完整的「接取 → 进行 → 交付」链路
 *
 * 一条任务的生命周期：
 *   available  → 可接取
 *   active     → 已接取，进行中
 *   ready      → 目标已达成，可以去交付
 *   completed  → 已交付
 *
 * 任务类型（target.type）目前支持：
 *   talk      和指定 NPC 对话
 *   visit     走到指定格子附近
 *   openGame  打开小游戏
 *   collect   收集 N 个
 *
 * 进度存 localStorage，按日期分桶；"每日"任务次日自动重置。
 */

import { QUESTS } from './quests.js';

const STORAGE_KEY = 'venue-quests-v2';

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export default class QuestSystem {
  /**
   * @param {Function} onChange 状态变化回调
   * @param {Object}   story    StorySystem 实例（可选）
   *
   * ★ 为什么需要 story（修「主线一直显示进行中 / 0%」的根因）：
   *   主线的两个任务用的是 writeLetters / deliverLetters 这两种 target.type，
   *   但它们的进度**不存在本系统里** —— 邀请函写了几个、投没投递，
   *   全部记在 StorySystem（lettersWritten / delivered）。
   *
   *   本系统之前完全不知道 StorySystem 的存在，于是：
   *     - getProgress() 走通用分支，拿本系统的 counter（永远是 0）
   *       → 显示「写下邀请函 0/5」「投递进度 0%」
   *     - checkCompletion() 永远判不到 >= 1
   *       → 主线永远停在 active，永远显示「进行中」
   *
   *   修法就是把这个外部进度源接进来，让进度和完成判定都去问 StorySystem。
   */
  constructor(onChange = null, story = null) {
    this.onChange = onChange;
    this.story = story;
    this.data = this.load();
    if (!this.data.states) this.data.states = {};
    if (!this.data.counters) this.data.counters = {};
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.date === todayKey()) return parsed;
      }
    } catch (e) {
      console.warn('读取任务进度失败，重新开始', e);
    }
    return { date: todayKey(), states: {}, counters: {} };
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('保存任务进度失败', e);
    }
  }

  // ---- 状态读写 ------------------------------------------------------------

  /**
   * 按 id 查任务状态（给交互点系统用）
   *
   * getState() 需要传整个任务对象，但交互点只知道自己关联的 questId，
   * 所以补一个按 id 查的入口。找不到就返回 null。
   */
  getStateById(questId) {
    const q = QUESTS.find((x) => x.id === questId);
    if (!q) return null;
    return this.getState(q);
  }

  getState(quest) {
    if (!this.data.states[quest.id]) {
      return quest.autoAccept ? 'active' : 'available';
    }
    return this.data.states[quest.id];
  }

  setState(quest, state) {
    this.data.states[quest.id] = state;
    this.save();
    if (this.onChange) this.onChange(this, quest, state);
  }

  getCounter(questId) {
    return this.data.counters[questId] || 0;
  }

  addCounter(questId, n = 1) {
    this.data.counters[questId] = this.getCounter(questId) + n;
  }

  // ---- 对外动作 ------------------------------------------------------------

  accept(quest) {
    if (this.getState(quest) !== 'available') return false;
    this.setState(quest, 'active');
    // 和 deliver 一样要通知外部（UI 刷新、接任务发道具都挂在这个回调上）
    if (this.onChange) this.onChange(this, quest, 'accepted');
    return true;
  }

  deliver(quest) {
    if (this.getState(quest) !== 'ready') return false;
    this.setState(quest, 'completed');

    // ★ 必须通知外部
    //   之前漏了这一句，导致「交付 -> 解锁道具」的回调从来没触发过，
    //   表现就是：任务交了，但会场里该出现的道具不出现。
    if (this.onChange) this.onChange(this, quest, 'delivered');
    return true;
  }

  /** 记录：和某个 NPC 对话过 */
  markTalked(npcId) {
    let changed = false;

    for (const q of QUESTS) {
      if (this.getState(q) !== 'active') continue;
      if (q.target.type !== 'talk') continue;
      if (q.target.npcId !== npcId) continue;

      this.addCounter(q.id, 1);
      changed = true;
    }

    if (changed) this.checkCompletion();
  }

  /** 记录：玩家走到某格附近 */
  markVisit(tileX, tileY) {
    let changed = false;

    for (const q of QUESTS) {
      if (this.getState(q) !== 'active') continue;
      if (q.target.type !== 'visit') continue;

      const dx = Math.abs(q.target.tileX - tileX);
      const dy = Math.abs(q.target.tileY - tileY);
      const r = q.target.radius ?? 1;

      if (dx <= r && dy <= r) {
        // 位置类任务只需到达一次，用 1 标记
        if (this.getCounter(q.id) < 1) {
          this.addCounter(q.id, 1);
          changed = true;
        }
      }
    }

    if (changed) this.checkCompletion();
  }

  /** 记录：打开了小游戏 */
  markOpenGame() {
    let changed = false;

    for (const q of QUESTS) {
      if (this.getState(q) !== 'active') continue;
      if (q.target.type !== 'openGame') continue;
      this.addCounter(q.id, 1);
      changed = true;
    }
    if (changed) this.checkCompletion();
  }

  /** 记录：收集物品 */
  markCollect(itemId, n = 1) {
    let changed = false;

    for (const q of QUESTS) {
      if (this.getState(q) !== 'active') continue;
      if (q.target.type !== 'collect') continue;
      if (q.target.itemId && q.target.itemId !== itemId) continue;
      this.addCounter(q.id, n);
      changed = true;
    }
    if (changed) this.checkCompletion();
  }

  // ---- 进度计算 ------------------------------------------------------------

  getProgress(quest) {
    const st = this.getState(quest);
    if (st === 'completed' || st === 'ready') return 1;

    const t = quest.target;

    // ---- 主线：进度存在 StorySystem 里 --------------------------------
    //   邀请函写了几封 / 投没投递，都不是本系统的计数器能回答的。
    //
    // ★ 「writeLetters」类型的进度 = 已写好的信 / 总数
    //
    //   2026-10-04 写信环节回来了（书桌前按 E → 信纸逐行展开 → 收归信封），
    //   任务目标就是「把 11 封 invitation 写完」，所以这里必须看 writtenCount。
    //   （2026-09-28 ~ 2026-10-04 之间那版去掉写信环节的流程看的是 carriedCount，
    //     现在改回来了；改错会让任务开局就 100% 自己完成。）
    if (t.type === 'writeLetters') {
      if (!this.story) return 0;
      const need = t.count || this.story.totalCount || 11;
      return Math.min(1, this.story.writtenCount / need);
    }
    if (t.type === 'deliverLetters') {
      if (!this.story) return 0;
      return this.story.isDelivered ? 1 : 0;
    }

    const need = t.count || 1;
    const got = this.getCounter(quest.id);

    return Math.min(1, got / need);
  }

  /**
   * 取「已完成的数量 / 需要的数量」这对数字，给 UI 显示用。
   *
   * 为什么要单独一个方法：
   *   通用任务用本系统的 counter 就行，但主线要问 StorySystem；
   *   UI 层不该关心这个区别。
   */
  getCounts(quest) {
    const t = quest.target || {};
    if (t.type === 'writeLetters') {
      // 和 getProgress 保持一致：看「已写好」的数量
      return {
        got: this.story ? this.story.writtenCount : 0,
        need: t.count || (this.story ? this.story.totalCount : 11),
      };
    }
    if (t.type === 'deliverLetters') {
      return { got: this.story && this.story.isDelivered ? 1 : 0, need: t.count || 1 };
    }
    return { got: this.getCounter(quest.id), need: t.count || 1 };
  }

  /** 进行中的任务达成目标 → 变 ready */
  checkCompletion() {
    let anyNewlyReady = false;

    for (const q of QUESTS) {
      if (this.getState(q) !== 'active') continue;
      if (this.getProgress(q) >= 1) {
        this.data.states[q.id] = 'ready';
        anyNewlyReady = true;
      }
    }

    this.save();

    if (this.onChange) this.onChange(this, null, anyNewlyReady ? 'ready' : 'progress');
    return anyNewlyReady;
  }

  /**
   * 把主线状态和 StorySystem 的真正进度对齐。
   *
   * ★ 这是主线 bug 的另一半修复。
   *
   *   主线是「自动接取」的（autoAccept: true），所以它一进游戏就是 active，
   *   而且它**不经过 checkCompletion()** —— 因为推进主线的动作
   *   （坐下写信、去信箱投递）走的是 StorySystem，根本没调本系统的方法。
   *
   *   结果：邀请函写满 5 封、也投递了，主线依然停在 active（显示「进行中」）。
   *
   *   所以必须在 StorySystem 每次变化时调一次这个方法，把状态推上去：
   *     - 5 封都写完      → main-write 直接算 completed
   *       （它是"写下"型目标，写完即达成，没有"交付"这一步）
   *     - 已经投递        → main-deliver 直接算 completed
   *
   *   为什么主线不搞 ready → completed 两步：
   *     主线没有 NPC 可以交付，搞两步会永远卡在 ready，
   *     所以条件达成就直接 completed。
   *
   * @returns {boolean} 是否有状态变化
   */
  syncStoryQuests() {
    if (!this.story) return false;
    let changed = false;

    for (const q of QUESTS) {
      if (!q.special) continue;
      const st = this.getState(q);

      // 已经完成的不再动（避免把 completed 又刷回 active）
      if (st === 'completed') continue;

      let done = false;
      if (q.target.type === 'writeLetters') done = this.getProgress(q) >= 1;
      else if (q.target.type === 'deliverLetters') done = this.getProgress(q) >= 1;
      else continue;

      if (done) {
        this.data.states[q.id] = 'completed';
        changed = true;
        if (this.onChange) this.onChange(this, q, 'delivered');
      }
    }

    if (changed) this.save();
    return changed;
  }

  // ---- UI 快照 -------------------------------------------------------------

  snapshot() {
    return QUESTS.map((q) => {
      const c = this.getCounts(q);
      return {
        id: q.id,
        title: q.title,
        desc: q.desc,
        reward: q.reward,
        giverNpcId: q.giverNpcId,
        deliverNpcId: q.deliverNpcId || q.giverNpcId,
        target: q.target,
        state: this.getState(q),
        progress: this.getProgress(q),
        counter: c.got,
        need: c.need,
      };
    });
  }

  /** 当前该去做的事（用于任务追踪指引） */
  activeGuide() {
    const list = this.snapshot().filter(
      (q) => q.state === 'active' || q.state === 'ready'
    );
    return list[0] || null;
  }

  reset() {
    this.data = { date: todayKey(), states: {}, counters: {} };
    this.save();
    if (this.onChange) this.onChange(this, null, 'reset');
  }
}

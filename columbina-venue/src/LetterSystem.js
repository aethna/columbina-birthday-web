/**
 * 信纸过场系统（写邀请函）
 *
 * 一段过场的完整节奏：
 *   1. 书桌前按 F  →  背景暗下来，信纸浮上来
 *   2. 正文逐行显示（一行一行打出来，读得慢的可以按 F 跳过当前行）
 *   3. 落款出现
 *   4. 信纸折起来 → 收进信封 → 封口 → 信封飞走
 *   5. onDone() 回调  →  VenueScene 把这一封记进 StorySystem
 *
 * 为什么要这么设计（和 DialogSystem 的关系）：
 *   - 对话是「一句话一条」，用对话框（左下角固定框）就够了；
 *     写信是「一整张信纸」，需要占满屏幕、要能滚动看长信，
 *     更需要一个「被折进信封」的收尾 —— 所以单独一个 DOM 层。
 *   - 两者都用 window.__venuePaused 冻结游戏输入，不会互相打架：
 *     信纸打开时 VenueScene.update() 会直接 return。
 *
 * DOM 在 venue.html（#letter-root），样式也在那里。
 */

// 11 封信的 id —— 直接问 StorySystem 要，别再手写一份
//   （手写的那份迟早会和新加的信对不上，见 readme 里记过的同类坑）
import { GUESTS } from './StorySystem.js';

const LETTER_IDS = GUESTS.map((g) => g.id);

/**
 * 逐行显示的速度（2026-10-04 用户反馈「文字逐行跳出的速度太快」，整体放慢一倍）
 *
 *   LINE_MS_TOTAL        一段正文从头打到尾的目标时长 —— 字多就快、字少就慢
 *   LINE_MS_MIN / MAX    单字耗时的上下限（防止 3 个字的短句磨蹭 1 秒）
 *   LINE_GAP_MS          一段打完 → 下一段开始之间的停顿（留出阅读时间）
 *   LINE_GAP_EMPTY_MS    空行（段落分隔）的停顿
 *   LINE_GAP_AFTER_SKIP  玩家按 F 跳字补全后的停顿
 *
 * 想再调快/调慢，只改这几个数就够。
 */
const LINE_MS_TOTAL = 4400;
const LINE_MS_MIN = 12;
const LINE_MS_MAX = 48;
const LINE_GAP_MS = 520;
const LINE_GAP_EMPTY_MS = 320;
const LINE_GAP_AFTER_SKIP = 400;

export default class LetterSystem {
  constructor() {
    this.root = document.getElementById('letter-root');
    this.stage = document.getElementById('letter-stage');
    this.paper = document.getElementById('letter-paper');
    this.doodleEl = document.getElementById('letter-doodle');
    this.recipientEl = document.getElementById('letter-recipient');
    this.bodyEl = document.getElementById('letter-body');
    this.signEl = document.getElementById('letter-sign');
    this.envelopeEl = document.getElementById('letter-envelope');
    this.sealEl = document.getElementById('letter-seal');
    this.hintEl = document.getElementById('letter-hint');
    this.countEl = document.getElementById('letter-count');

    this.guest = null;
    this.lines = [];
    this.lineEls = [];
    this.index = -1;        // 当前正在打的段落
    this._timer = null;     // 打字定时器
    this._timers = [];      // 收尾动画用的 setTimeout 句柄
    this._typing = false;
    this._sealing = false;
    this._openedAt = 0;
    this.onDone = null;

    this.bindEvents();
    this._warmDoodles();
  }

  // -------------------------------------------------------------------------
  /**
   * 预热信纸抬头涂鸦
   *
   * 11 张涂鸦一共几百 KB，场景创建时让浏览器先把它们抓进缓存，
   * 玩家真正写信时图片是秒出的，不会出现「信纸已经浮上来了、抬头还是空的」。
   * 用过的 Image 对象挂在 this._warm 上，避免被 GC 掉导致请求中止。
   */
  _warmDoodles() {
    this._warm = LETTER_IDS.map((id) => {
      const im = new Image();
      im.src = `assets/letters/${id}.png`;
      return im;
    });
  }

  // -------------------------------------------------------------------------
  /**
   * 换掉信纸抬头的涂鸦
   *
   * ★ 用户 m13727 任务1：每封信的纸上要画对应收信人的 Q 版简笔画/涂鸦。
   *   贴图按「信 id」命名（assets/letters/letter-<谁>.png），
   *   而 StorySystem.GUESTS 每一项本来就有 id —— 直接拿来做文件名，不用再映射一次。
   *
   * ★ 图片没画好 / 404 时要把这一行整个撤掉（而不是留一个破图标占位），
   *   否则信纸正文会被无谓地顶下去一段。见 venue.html 的 #letter-doodle:empty。
   */
  _setDoodle(letterId) {
    if (!this.doodleEl) return;
    this.doodleEl.innerHTML = '';
    if (!letterId) return;

    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => { this.doodleEl.innerHTML = ''; });
    img.src = `assets/letters/${letterId}.png`;
    this.doodleEl.appendChild(img);
  }

  // -------------------------------------------------------------------------
  bindEvents() {
    // 点击信纸任意处 / 按 F → 推进（F = 场景互动键，2026-10-12 由 E 改 F）
    this.root.addEventListener('click', () => this.advance());
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;
      if (e.key === 'f' || e.key === 'F' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        this.advance();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.skipToEnd();
      }
    });
  }

  isOpen() {
    return this.root.classList.contains('active');
  }

  // -------------------------------------------------------------------------
  /**
   * 打开一张信纸
   * @param {Object} guest   StorySystem 里的一封信 { to, name, lines, sign }
   * @param {Object} opts    { index, total, onDone }
   */
  open(guest, opts = {}) {
    this.guest = guest;
    this.lines = Array.isArray(guest.lines) ? guest.lines.slice() : [];
    this.onDone = opts.onDone || null;
    this._openedAt = Date.now();
    this._sealing = false;
    this._typing = false;
    this.index = -1;

    this.recipientEl.textContent = guest.to || '';
    this.signEl.textContent = guest.sign || '';
    // 抬头涂鸦跟着这封信换（信 id 就是贴图名）
    this._setDoodle(guest.id);
    this.signEl.classList.remove('show');
    this.countEl.textContent = opts.total
      ? `第 ${(opts.index || 0) + 1} / ${opts.total} 封`
      : '';

    // 重建正文
    this.bodyEl.innerHTML = '';
    this.lineEls = this.lines.map((text) => {
      const el = document.createElement('div');
      el.className = 'letter-line';
      el.dataset.text = text;
      this.bodyEl.appendChild(el);
      return el;
    });

    // 归位动画用到的 class
    this.paper.classList.remove('fold', 'in');
    this.envelopeEl.classList.remove('show', 'open', 'fly');
    this.sealEl.classList.remove('show');
    this.hintEl.textContent = '按 F / 点击 继续';

    this.root.classList.add('active');
    window.__venuePaused = true;

    // 纸浮上来之后开始逐行显示
    // （用 _after 而不是 requestAnimationFrame：先让 .in 的移除真正落地一帧，
    //   否则同一帧里 remove + add 会被浏览器合并，纸是"啪"地出现而不是浮上来）
    this._after(60, () => this.paper.classList.add('in'));
    this._after(460, () => this.nextLine());
  }

  /** 关掉（收尾动画结束后由内部调用，或外部强制） */
  close() {
    this._clearTimers();
    this._stopTyping();
    this.root.classList.remove('active');
    window.__venuePaused = false;
    this.guest = null;
    this._sealing = false;
  }

  // -------------------------------------------------------------------------
  // 逐行显示
  // -------------------------------------------------------------------------
  nextLine() {
    this.index += 1;
    if (this.index >= this.lineEls.length) {
      this.startSeal();
      return;
    }
    const el = this.lineEls[this.index];
    el.classList.add('show');
    this.scrollToLine(el);
    this._typeInto(el, el.dataset.text || '');
  }

  /** 把一段文字一个字一个字打出来（长句自动提速，避免一段打太久） */
  _typeInto(el, text) {
    this._stopTyping();
    if (!text) {
      this._after(LINE_GAP_EMPTY_MS, () => this.nextLine());
      return;
    }
    // 一段最长 ~4.4 秒：字多就快、字少就慢
    const speed = Math.max(LINE_MS_MIN, Math.min(LINE_MS_MAX, Math.round(LINE_MS_TOTAL / text.length)));
    let i = 0;
    this._typing = true;
    this.hintEl.textContent = '按 F / 点击 继续';

    this._timer = setInterval(() => {
      i += 1;
      el.textContent = text.slice(0, i);
      if (i >= text.length) {
        this._stopTyping();
        this._after(LINE_GAP_MS, () => this.nextLine());
      }
    }, speed);
  }

  /** 当前行还没打完 → 直接补全 */
  _finishTyping() {
    if (!this._typing) return false;
    const el = this.lineEls[this.index];
    if (el) el.textContent = el.dataset.text || '';
    this._stopTyping();
    this._after(LINE_GAP_AFTER_SKIP, () => this.nextLine());
    return true;
  }

  /** 推进：正在打字 → 补全；否则立刻显示下一行 */
  advance() {
    // 刚打开的那一下（按 F 开信纸的那次按键会冒泡过来）不响应
    if (Date.now() - this._openedAt < 260) return;
    if (this._sealing) return;

    if (this._finishTyping()) return;

    // 还在等下一行的定时器：直接冲掉，马上接上
    if (this._timers.length) this._clearTimers();
    this.nextLine();
  }

  /** Esc：直接跳到收尾动画 */
  skipToEnd() {
    if (this._sealing) return;
    this._stopTyping();
    this._clearTimers();
    // 把还没显示的段落一次性补上（不展开打字，直接给全文，避免突变太生硬）
    // ★ 2026-10-18：判断从 `>` 改为 `>=` —— 打字中按 Esc 时当前行只显示了半句，
    //   旧写法会跳过它，半截句子直接折进信封。
    this.lineEls.forEach((el, i) => {
      if (i >= this.index) {
        el.textContent = el.dataset.text || '';
        el.classList.add('show');
      }
    });
    this.index = this.lineEls.length - 1;
    this.startSeal();
  }

  // -------------------------------------------------------------------------
  // 收尾：折纸 → 收进信封 → 封口 → 飞走
  // -------------------------------------------------------------------------
  startSeal() {
    if (this._sealing) return;
    this._sealing = true;
    this._stopTyping();
    this._clearTimers();

    this.hintEl.textContent = '……';
    this.signEl.classList.add('show');

    // 1) 信纸先被折起来、往信封的方向落下去
    this._after(120, () => {
      this.paper.classList.add('fold');
      this.paper.classList.remove('in');
    });

    // 2) 信封在信纸下方出现，盖子打开（正好接住落下来的纸）
    this._after(520, () => {
      this.envelopeEl.classList.add('show');
      this._after(120, () => this.envelopeEl.classList.add('open'));
    });

    // 3) 信封合上 + 打上火漆印
    this._after(1280, () => {
      this.envelopeEl.classList.remove('open');
      this.sealEl.classList.add('show');
    });

    // 4) 信封飞走
    this._after(1920, () => this.envelopeEl.classList.add('fly'));

    // 5) 收场
    this._after(2760, () => {
      const done = this.onDone;
      this.close();
      if (done) done(this.guest);
    });
  }

  // -------------------------------------------------------------------------
  scrollToLine(el) {
    try {
      const top = el.offsetTop - this.bodyEl.clientHeight * 0.35;
      this.bodyEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } catch {
      /* 老浏览器没有 scrollTo options，忽略 */
    }
  }

  _stopTyping() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._typing = false;
  }

  _after(ms, fn) {
    const id = setTimeout(() => {
      this._timers = this._timers.filter((t) => t !== id);
      fn();
    }, ms);
    this._timers.push(id);
    return id;
  }

  _clearTimers() {
    this._timers.forEach((t) => clearTimeout(t));
    this._timers = [];
  }
}

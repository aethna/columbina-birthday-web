/**
 * 对话系统（仙剑 / 剑侠 风格）
 *
 * 布局：左侧大头像 + 右侧文字，外双线描边 + 名牌。
 * 用 DOM 实现而不是 Phaser 的 Text，原因：
 *   对话要放按钮、图片头像、富文本，DOM 处理这些远比 Canvas 简单，
 *   而且中文行高、换行、滚动都是浏览器原生能力。
 *
 * 对外接口：open(npc, lines, onClose) / close() / isOpen()
 */

export default class DialogSystem {
  constructor() {
    this.root = document.getElementById('dialog-root');
    this.portraitEl = document.getElementById('dialog-portrait');
    this.nameEl = document.getElementById('dialog-name');
    this.textEl = document.getElementById('dialog-text');
    this.linksEl = document.getElementById('dialog-links');
    this.hintEl = document.getElementById('dialog-hint');

    this.lines = [];
    this.index = 0;
    this.onClose = null;
    this._bound = false;

    // 刚关闭的时间戳。
    // ★ 为什么要它（用户 m01441 的问题4）：
    //   「一直按 F，应该有一个对话结束、对话框关闭的过程，再按 F 才是再开始互动。」
    //   之前 close() 只把面板隐藏就完了，同一个 F 键在下一帧又被
    //   VenueScene.handleInteract() 接走 —— 玩家看到的就是「对话没结束，
    //   只是又从第一句开始」，像卡进了循环。
    //   记下关闭时刻，让场景那边在一个很短的冷却窗口里忽略这次按键。
    this._closedAt = 0;

    // 已经用键盘触发过的行号。
    //   带按钮的行按一次 F 就按过按钮了，同一行不该反复触发（见 advance）。
    this._usedLinks = new Set();

    // 逐字打印状态
    this._typeTimer = null;
    this._typing = false;
    this._fullText = '';

    this.bindEvents();
  }

  bindEvents() {
    if (this._bound) return;
    this._bound = true;

    // 点击对话框 → 推进
    this.root.addEventListener('click', (e) => {
      if (e.target.classList.contains('dialog-link')) return;
      if (!this.isOpen()) return;
      // 鼠标点击 ≠ 按按钮：点在文字上只是翻页，避免误触「接下委托」
      this.advance(false);
    });

    window.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;

      // 推进对话：空格 / 回车 / F（与场景里的互动键一致，2026-10-12 由 E 改 F）
      if (e.key === ' ' || e.key === 'Enter' || e.key.toLowerCase() === 'f') {
        e.preventDefault();
        this.advance(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
  }

  isOpen() {
    return this.root.classList.contains('active');
  }

  /**
   * 刚关闭不久？
   * 场景那边在 handleInteract() 里问它，避免「关掉对话的那一下按键」立刻又把对话打开。
   * @param {number} ms 冷却窗口（毫秒）
   */
  justClosed(ms = 350) {
    if (!this._closedAt) return false;
    return (performance.now() - this._closedAt) < ms;
  }

  /**
   * 按立绘的宽高比把头像框撑开
   *
   * ★ 为什么需要它（用户 m01441 的问题1「立绘缩在一个角落里了」）：
   *   头像框原来是写死的 128×192，图片 object-fit: contain。
   *   而 14 张立绘的高度都统一是 320，宽度却从 156 到 342 不等。
   *   contain 遇到「宽图」时按宽度贴合，画出来的高度就矮了 ——
   *   最极端的「空」（342×320）只画出 124×116，高度只占框的 62%，
   *   加上 object-position: center bottom，人整个贴在框底中间，看着就是「缩在角落」。
   *
   *   修法不是改 object-fit（改成 cover 会把头裁掉，历史上踩过），
   *   而是让【框】去适配图：高度固定 192，宽度 = 192 × 宽高比，
   *   这样每张立绘都是满高、满框、不变形。
   *   窄图（萤 160×320）算出来 96px，比原来的 128 还窄 —— 但那是图片真实比例，
   *   硬撑宽只会留白，不如给个下限 96px 保证描边好看。
   */
  fitPortrait(img) {
    if (!img) return;
    const apply = () => {
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      if (!w || !h) return;
      const el = this.portraitEl;
      // 内容区高度（clientHeight 已扣掉描边、含 padding）—— 手机端 CSS 会把它压到 150，
      // 从 DOM 实测才能跟着变，不写死。
      const H = el.clientHeight || 188;
      // 内容区宽 = H × 宽高比
      const inner = Math.ceil((H * w) / h);
      // style.width 设的是 border-box（全局 box-sizing: border-box），
      // 所以要把左右描边加回去，否则图会被撑不满 —— 差 4px 时 fillH 只有 0.97，
      // 眼睛能看到上下各一条缝，正是问题1「缩在角落」的残留。
      const borderX = Math.max(0, el.offsetWidth - el.clientWidth);
      this.setPortraitWidth(Math.max(88, Math.min(300, inner + borderX)));
    };
    if (img.complete) apply();
    else img.addEventListener('load', apply, { once: true });
  }

  /**
   * 设置头像框宽度，并让名牌跟着挪
   *   名牌是 position:absolute 挂在框左上角外侧（原来写死 left:130px），
   *   框宽一变就必须重算，否则窄图时名牌会飘在半空。
   */
  setPortraitWidth(px) {
    this.portraitEl.style.width = `${px}px`;
    // 130 = 原设计里 128px 框 + 2px 描边，名牌左边压在框右边缘
    this.nameEl.style.left = `${px + 2}px`;
  }

  /**
   * 打开对话
   * @param {Object} npc   NPC 配置对象（含 name / portrait / portraitBg）
   * @param {Array}  lines 对话行
   * @param {Function} onClose 关闭回调
   */
  open(npc, lines, onClose = null) {
    if (!lines || !lines.length) return;

    this.lines = lines;
    this.index = 0;
    this.onClose = onClose;
    this._usedLinks.clear();
    // 记住是谁在说话 —— 合影这类选项需要它（见 handleLink）
    this.currentNpc = npc;

    const name = typeof npc === 'string' ? npc : (npc.name || 'NPC');
    const portrait = (typeof npc === 'object' && npc.portrait) || '💬';
    const bg = (typeof npc === 'object' && npc.portraitBg) || '#26313d';

    // 头像：支持 emoji 字符串或 { url: '图片地址' }
    this.portraitEl.style.background = bg;
    if (typeof portrait === 'object' && portrait.url) {
      this.portraitEl.innerHTML = `<img src="${portrait.url}" alt="${name}">`;
      this.fitPortrait(this.portraitEl.querySelector('img'));
    } else {
      this.portraitEl.textContent = portrait;
      this.setPortraitWidth(128);   // emoji 头像用默认宽度
    }

    this.nameEl.textContent = name;

    this.root.classList.add('active');
    window.__venuePaused = true;

    this.render();
  }

  /**
   * 推进对话。
   * 如果正在逐字打印，先立刻显示完整文字（经典手感：再按一次才跳下一句）
   */
  advance(fromKey = false) {
    if (this._typing) {
      this.finishTyping();
      return;
    }

    // ★ 这一行带按钮时，按 F / 空格 / 回车 = 按下那个按钮（用户 m01441 的问题3）
    //
    //   以前 advance() 只会翻页，按钮必须用鼠标点 ——
    //   玩家一路按 F 读到「【委托】…接下委托」这一行，再按 F 就翻过去了，
    //   委托根本没接上，以为坏了。键盘玩家没有别的办法按到那个按钮。
    //
    //   为什么只对键盘生效、鼠标点文字仍然只是翻页：
    //     鼠标玩家可以（也应该）直接点那个金字按钮，点文字误触「接下委托」
    //     反而是新问题。键盘玩家则没有第二个入口，必须在这里接。
    //
    //   _usedLinks 防重复：像「#任务面板」这类链接点完后对话是不关的，
    //   不记一笔的话再按 F 会无限重触发同一个链接，永远翻不到下一句。
    const line = this.lines[this.index];
    if (line && line.link && fromKey && !this._usedLinks.has(this.index)) {
      this._usedLinks.add(this.index);
      this.handleLink(line.link);
      return;
    }

    this.index += 1;
    if (this.index >= this.lines.length) {
      this.close();
      return;
    }
    this.render();
  }

  render() {
    const line = this.lines[this.index];

    // 逐字打印
    this.startTyping(line.text || '');

    // 跳转按钮
    this.linksEl.innerHTML = '';
    if (line.link) {
      const btn = document.createElement('button');
      btn.className = 'dialog-link';
      btn.textContent = line.link.label || '打开';

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleLink(line.link);
      });

      this.linksEl.appendChild(btn);
    }

    const isLast = this.index === this.lines.length - 1;
    // 带按钮的行要说清「按 F 就是按这个按钮」，否则键盘玩家不知道能按
    if (line.link) {
      this.hintEl.textContent = `点击「${line.link.label || '按钮'}」或按 F`;
    } else {
      this.hintEl.textContent = isLast
        ? '点击或按 Esc 关闭'
        : `点击继续 (${this.index + 1}/${this.lines.length})`;
    }
  }

  // ---- 逐字打印 ------------------------------------------------------------

  startTyping(text) {
    clearInterval(this._typeTimer);

    this._fullText = text;
    this._typing = true;
    this.textEl.classList.add('typing');
    this.textEl.textContent = '';

    let i = 0;
    const speed = 28; // 每字多少毫秒

    this._typeTimer = setInterval(() => {
      i += 1;
      this.textEl.textContent = text.slice(0, i);

      if (i >= text.length) {
        this.finishTyping();
      }
    }, speed);
  }

  finishTyping() {
    clearInterval(this._typeTimer);
    this._typeTimer = null;
    this._typing = false;
    this.textEl.classList.remove('typing');
    this.textEl.textContent = this._fullText;
  }

  // ---- 跳转接口 ------------------------------------------------------------

  /**
   * 处理对话里的跳转选项
   *
   * link 结构：{ label: '按钮文字', url: '地址', newTab: false }
   *   url 以 # 开头  → 站内面板（如 #quests）
   *   其余          → 交给外层 HTML，决定用弹层还是新标签页
   */
  handleLink(link) {
    if (!link) return;

    // ---- 合影（任务4 / 第八轮）----
    //
    // 为什么先 close 再派发：
    //   对话面板是 DOM，全屏插画是 canvas 上 scrollFactor=0 的图层。
    //   如果先铺插画，对话那层会盖在上面，玩家看不到图。
    //
    // ★ photo 有两种取值（m09394 加的围坐互动）：
    //   · true / 'npc'  → 这位 NPC 和哥伦比娅的单张合影（拍立得）
    //   · 'cake'        → 刚才那张「所有人围坐、哥伦比娅切蛋糕」的大合影
    if (link.photo) {
      const npc = this.currentNpc;
      const cake = link.photo === 'cake';
      this.close();
      window.dispatchEvent(new CustomEvent('venue:photo', { detail: { npc, cake } }));
      return;
    }

    // ---- 占位入口（小游戏 / 单品，后期接入）----
    //
    // 先把按钮位置和交互路径占住：点下去给一句明确反馈，
    // 而不是静默什么都不发生（那样玩家会以为是 bug）。
    if (link.soon) {
      const label = link.label || '这个';
      this.close();
      window.dispatchEvent(new CustomEvent('venue:soon', { detail: { label } }));
      return;
    }

    // ---- 任务按钮（接取 / 交付）----
    if (link.action) {
      window.dispatchEvent(new CustomEvent('venue:quest-action', {
        detail: { action: link.action, questId: link.questId },
      }));
      // 办完事自动关对话，给玩家一个明确的反馈
      this.close();
      return;
    }

    // ---- 跳转按钮 ----
    const url = typeof link === 'string' ? link : link?.url;
    if (!url) return;

    if (url.startsWith('#')) {
      window.dispatchEvent(new CustomEvent('venue:open-panel', {
        detail: { panel: url.slice(1) },
      }));
      return;
    }

    window.dispatchEvent(new CustomEvent('venue:open-url', {
      detail: {
        url,
        newTab: !!(link && link.newTab),
        label: (link && link.label) || '内容',
      },
    }));
  }

  close() {
    clearInterval(this._typeTimer);
    this._typeTimer = null;
    this._typing = false;

    const wasOpen = this.root.classList.contains('active');

    this.root.classList.remove('active');
    window.__venuePaused = false;

    // 记下关闭时刻：场景那边据此在冷却窗口里忽略同一次按键（问题4）
    if (wasOpen) this._closedAt = performance.now();

    const cb = this.onClose;
    this.onClose = null;
    if (typeof cb === 'function') cb();
  }
}

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
      this.advance();
    });

    window.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;

      if (e.key === ' ' || e.key === 'Enter' || e.key.toLowerCase() === 'e') {
        e.preventDefault();
        this.advance();
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

    const name = typeof npc === 'string' ? npc : (npc.name || 'NPC');
    const portrait = (typeof npc === 'object' && npc.portrait) || '💬';
    const bg = (typeof npc === 'object' && npc.portraitBg) || '#26313d';

    // 头像：支持 emoji 字符串或 { url: '图片地址' }
    this.portraitEl.style.background = bg;
    if (typeof portrait === 'object' && portrait.url) {
      this.portraitEl.innerHTML = `<img src="${portrait.url}" alt="${name}">`;
    } else {
      this.portraitEl.textContent = portrait;
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
  advance() {
    if (this._typing) {
      this.finishTyping();
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
    this.hintEl.textContent = isLast
      ? '点击或按 Esc 关闭'
      : `点击继续 (${this.index + 1}/${this.lines.length})`;
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

    this.root.classList.remove('active');
    window.__venuePaused = false;

    const cb = this.onClose;
    this.onClose = null;
    if (typeof cb === 'function') cb();
  }
}

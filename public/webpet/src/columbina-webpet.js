/**
 * columbina-webpet.js —— 网页版桌宠「哥伦比娅」，单文件实现
 *
 * 【它是干什么的】
 *   一行 <script> 把一只会动的哥伦比娅挂到任意网页上。她按权重随机切换动画，
 *   可以拖动、可以点击互动，不联网、不读配置、不存 Cookie。
 *
 * 【生命周期 —— 这是本项目的核心约定】
 *   桌宠活在**页面自己的浏览上下文**里：
 *     · 这个标签页还开着 → 她就在；
 *     · 页面内跳路由 / 跳到别的二级域名，只要目标页也引了本脚本，她照样在
 *       （位置记在 sessionStorage，同源才带过去；跨域则回到默认位置）；
 *     · 关掉标签页 → 她消失。没有任何常驻进程或后台实体。
 *
 * 【为什么用 Shadow DOM】
 *   要能塞进任意页面（包括别人的模板），宿主页面的 CSS 会把桌宠挤变形：
 *   `img,video{max-width:100%}`、`*{box-sizing}`、全局 transition、z-index 陷阱……
 *   挂一层 Shadow Root 之后宿主样式进不来，桌宠在任何站点上都长一样。
 *
 * 【和 Electron 版对齐的口径】
 *   · 画布 640×360，人物站在 FEET_Y=330 的线上，人物高 265；
 *   · 动画切换**一律硬切**，不做 opacity 过渡 —— 照 pet.ts:203 那条三代踩坑结论：
 *     双层互相淡化会整体掉亮度，单层淡入会把下面的旧姿势透出来（用户报过的"重叠"）；
 *   · 掷骰权重 idle/turn/move，余下概率归随机动作。
 */
(function (global) {
  'use strict';

  if (global.__columbinaWebPet) return;
  global.__columbinaWebPet = true;

  var CANVAS_W = 640;
  var CANVAS_H = 360;

  /* ------------------------------------------------------------------ 资源根
   * 素材和本脚本同住 webpet/ 下（…/webpet/src/columbina-webpet.js + …/webpet/assets/anim/*.webm）。
   * 但宿主页面可能在任何层级引用它 —— 挂到站点首页时页面在 /，素材却在 /webpet/assets/。
   * 所以不能写相对页面，必须从**本脚本自己的 URL** 反推：
   *   http://host/webpet/src/columbina-webpet.js  →  http://host/webpet/
   * 想覆盖就提前设 window.WEBPET_BASE。
   */
  var SELF_BASE = (function () {
    try {
      var s = document.currentScript;
      if (!s || !s.src) return '';
      return s.src.replace(/src\/columbina-webpet\.js(\?[^/]*)?$/, '')
                  .replace(/columbina-webpet\.js(\?[^/]*)?$/, '');
    } catch (e) { return ''; }
  })();

  /* 命中盒：只有这一块响应拖拽/点击，避免整块透明区域挡住宿主页面的链接 */
  var HIT = { x0: 200, y0: 50, x1: 440, y1: 335 };

  /* ------------------------------------------------------------------ 动画池
   * 与 columbina-config.json 的 animations 段对齐（改素材时这里要跟着改）。
   * 名字即文件名：assets/anim/<名字>.webm
   */
  var ANIMS = {
    idle: ['待机呼吸', '待机摇摆', '晃脚待机', '轻轻点头', '歪头', '点头'],
    turn: ['左右张望'],
    drag: ['被拎起悬空'],
    clicks: ['点击回应', '开心跳跃', '被吓一跳', '害羞低头', '抖一抖'],
    move: ['原地踏步'],
    actions: ['伸个懒腰', '打瞌睡', '前倾好奇', '原地蹲下', '抖一抖', '旋转展示', '开心跳跃', '害羞低头']
  };

  /* 默认配置。本次需求不做设置页，所以这里是唯一的配置来源；
   * 宿主页面想改，只需在引入脚本前写 <script>window.COLUMBINA_WEBPET={...}</script>。
   */
  var DEFAULTS = {
    size: 240,          // 画布宽度（px），高度按 640:360 换算
    corner: 'bottom-right',
    marginX: 24,
    marginY: 24,
    fixed: false,       // true = 只原地待机，不横走
    moveEnabled: true,  // 允许横向走动
    idleIntervalMs: [4200, 9000],  // 两次独立动画之间的间隔随机区间
    weights: { idle: 45, turn: 0, move: 15 }  // 余下 40% 归随机动作
  };

  var CSS = [
    ':host{all:initial}',
    '.wrap{position:fixed;inset:0;pointer-events:none;z-index:2147483000;',
    '  font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.stage{position:absolute;left:0;top:0;pointer-events:auto;cursor:grab;',
    '  will-change:transform;touch-action:none;-webkit-user-select:none;user-select:none;',
    '  -webkit-tap-highlight-color:transparent}',
    '.stage.dragging{cursor:grabbing}',
    '.video{position:absolute;left:0;top:0;width:100%;height:100%;',
    '  object-fit:contain;pointer-events:none;opacity:0;z-index:0;',
    '  transform-origin:center;background:transparent}',
    '.video.is-front{opacity:1}'
  ].join('\n');

  function pick(pool, exclude) {
    var src = exclude ? pool.filter(function (n) { return n !== exclude; }) : pool;
    if (!src.length) src = pool;
    return src[Math.floor(Math.random() * src.length)];
  }

  function randBetween(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  /* 与 dsh-pet 的 rollKind 同口径 */
  function rollKind(w) {
    var r = Math.random();
    w = w || DEFAULTS.weights;
    if (r < w.idle / 100) return 'idle';
    if (r < (w.idle + w.turn) / 100) return 'turn';
    if (r < (w.idle + w.turn + w.move) / 100) return 'move';
    return 'action';
  }

  /* ------------------------------------------------------------------ 主体 */
  function WebPet(opts) {
    opts = opts || {};
    var user = opts.config || (global.COLUMBINA_WEBPET || {});
    this.cfg = {};
    for (var k in DEFAULTS) this.cfg[k] = DEFAULTS[k];
    for (var k2 in user) if (user[k2] !== undefined) this.cfg[k2] = user[k2];
    if (user.weights) this.cfg.weights = user.weights;

    this.mount = opts.mount || document.body;
    this.layers = Object.create(null);
    this.front = null;
    this.curAnim = '';
    this.pos = { x: 0, y: 0 };
    this.busy = false;
    this.timers = { gap: 0 };
    this.walking = null;
    this.drag = null;
    this.destroyed = false;

    this._build();
    this._bindEvents();
    this._placeInitial();
  }

  WebPet.prototype._build = function () {
    var host = document.createElement('div');
    host.setAttribute('data-webpet', 'columbina');
    this.host = host;
    this.mount.appendChild(host);

    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    this.root = root;

    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    root.appendChild(wrap);
    this.wrap = wrap;

    var stage = document.createElement('div');
    stage.className = 'stage';
    /* 语义：给读屏一张静态描述，动画对辅助技术是干扰 */
    stage.setAttribute('role', 'img');
    stage.setAttribute('aria-label', '网页桌宠：哥伦比娅');
    wrap.appendChild(stage);
    this.stage = stage;

    this._applySize();
  };

  WebPet.prototype._applySize = function () {
    var w = Math.round(this.cfg.size || 240);
    var h = Math.round(w * CANVAS_H / CANVAS_W);
    this.stageW = w;
    this.stageH = h;
    this.stage.style.width = w + 'px';
    this.stage.style.height = h + 'px';
  };

  /* 取（或懒创建）某个动画的 video 层 */
  WebPet.prototype._layer = function (name) {
    var v = this.layers[name];
    if (v) return v;
    v = document.createElement('video');
    v.className = 'video';
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';
    v.dataset.name = name;
    v.src = (global.WEBPET_BASE || SELF_BASE || '') + 'assets/anim/' + encodeURIComponent(name) + '.webm';
    this.stage.appendChild(v);
    this.layers[name] = v;
    return v;
  };

  /**
   * 硬切到某个动画。
   * @param {string} name  动画名（= 文件名）
   * @param {boolean} once  true = 播一遍就结束；false = 循环
   * @param {Function} [onEnd] once 播完的回调
   */
  WebPet.prototype.switchTo = function (name, once, onEnd) {
    if (this.destroyed || !name) return;
    var next = this._layer(name);
    var prev = this.front;

    if (prev === next && !next.paused) {
      next._onEnd = once ? onEnd : null;
      return;
    }

    next.loop = !once;
    next._onEnd = once ? onEnd : null;

    /* ↓↓ 硬切：同一帧里把新层打到完全不透明、旧层打到完全透明。
     * 不给任何过渡 —— 半透明的任何一帧都会让下面的旧姿势透出来。 */
    next.style.zIndex = '2';
    next.style.opacity = '1';
    next.classList.add('is-front');

    if (prev && prev !== next) {
      prev.style.opacity = '0';
      prev.classList.remove('is-front');
      try { prev.pause(); } catch (e) { /* ignore */ }
    }

    this.front = next;
    this.curAnim = name;

    next.onended = function () {
      var cb = next._onEnd;
      next._onEnd = null;
      if (cb) cb();
    };

    try { next.currentTime = 0; } catch (e) { /* 元数据未就绪时忽略 */ }
    var p = next.play();
    if (p && p.catch) {
      p.catch(function () {
        /* 自动播放被拒（理论上不会：muted + playsinline）：等首次交互再补 */
        var self = this;
        var retry = function () {
          document.removeEventListener('pointerdown', retry);
          if (!self.destroyed) { try { next.play(); } catch (e) { /* ignore */ } }
        };
        document.addEventListener('pointerdown', retry, { once: true });
      }.bind(this));
    }
  };

  /* 播一遍，结束后回到待机 */
  WebPet.prototype.playOnce = function (name, done) {
    var self = this;
    if (this.busy) return;
    this.busy = true;
    this.switchTo(name, true, function () {
      self.busy = false;
      if (self.destroyed) return;
      if (done) done(); else self._scheduleIdle();
    });
  };

  /* 排下一次动画 */
  WebPet.prototype._scheduleIdle = function () {
    var self = this;
    clearTimeout(this.timers.gap);
    var iv = this.cfg.idleIntervalMs || [4200, 9000];
    var wait = randBetween(iv[0], iv[1]);
    this.timers.gap = setTimeout(function () {
      if (self.destroyed || self.busy || self.drag) return;
      var kind = rollKind(self.cfg.weights);

      if (kind === 'idle') {
        self.switchTo(pick(ANIMS.idle, self.curAnim), true, function () {
          self._scheduleIdle();
        });
        return;
      }
      if (kind === 'turn') {
        self.playOnce(pick(ANIMS.turn));
        return;
      }
      if (kind === 'move' && self.cfg.moveEnabled && !self.cfg.fixed) {
        if (Math.random() < 0.55) { self._walk(); return; }
      }
      self.playOnce(pick(ANIMS.actions, self.curAnim));
    }, wait);
  };

  /* 横走一段：播走路动作 + 同时平移，走到目标就停 */
  WebPet.prototype._walk = function () {
    var self = this;
    var maxX = Math.max(0, global.innerWidth - this.stageW);
    var from = this.pos.x;
    var dist = randBetween(80, 260) * (Math.random() < 0.5 ? -1 : 1);
    var to = Math.min(maxX, Math.max(0, from + dist));
    dist = to - from;

    if (Math.abs(dist) < 40) { this.playOnce(pick(ANIMS.move)); return; }

    this.switchTo(pick(ANIMS.move), false, null);

    var start = 0;
    var dur = Math.abs(dist) * 22; // 约 22ms/px
    function tick(now) {
      if (self.destroyed) return;
      if (!start) start = now;
      var k = Math.min(1, (now - start) / dur);
      self.pos.x = from + dist * k;
      self._applyPos();
      if (k < 1) {
        self.walking = requestAnimationFrame(tick);
      } else {
        self.walking = null;
        self.switchTo(pick(ANIMS.idle), true, function () { self._scheduleIdle(); });
      }
    }
    this.walking = requestAnimationFrame(tick);
  };

  WebPet.prototype._placeInitial = function () {
    var w = this.stageW;
    var h = this.stageH;
    var vw = global.innerWidth;
    var vh = global.innerHeight;
    var c = this.cfg.corner;
    var mx = this.cfg.marginX || 0;
    var my = this.cfg.marginY || 0;

    /* 位置存 sessionStorage：同源页面之间跳转能落回原处，关掉标签页就没了 */
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('columbina-webpet-pos') || 'null'); } catch (e) { /* ignore */ }

    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      this.pos.x = Math.min(Math.max(0, saved.x), Math.max(0, vw - w));
      this.pos.y = Math.min(Math.max(0, saved.y), Math.max(0, vh - h));
    } else {
      this.pos.x = (c === 'bottom-right' || c === 'top-right') ? vw - w - mx : mx;
      this.pos.y = (c === 'bottom-right' || c === 'bottom-left') ? vh - h - my : my;
    }
    this._applyPos();
  };

  WebPet.prototype._applyPos = function () {
    this.stage.style.transform = 'translate(' + Math.round(this.pos.x) + 'px,' + Math.round(this.pos.y) + 'px)';
  };

  WebPet.prototype._savePos = function () {
    try {
      sessionStorage.setItem('columbina-webpet-pos',
        JSON.stringify({ x: Math.round(this.pos.x), y: Math.round(this.pos.y) }));
    } catch (e) { /* 隐私模式下 sessionStorage 可能不可用，忽略 */ }
  };

  WebPet.prototype._bindEvents = function () {
    var self = this;

    this.stage.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      self.drag = {
        sx: e.clientX, sy: e.clientY,
        ox: self.pos.x, oy: self.pos.y,
        moved: false
      };
      self.stage.classList.add('dragging');
      /* 拖拽时先切成"被拎起"的姿势 */
      self.switchTo(pick(ANIMS.drag), false, null);
      try { self.stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    this.stage.addEventListener('pointermove', function (e) {
      var d = self.drag;
      if (!d) return;
      var dx = e.clientX - d.sx;
      var dy = e.clientY - d.sy;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      d.moved = true;

      if (self.walking) { cancelAnimationFrame(self.walking); self.walking = null; }

      var maxX = Math.max(0, global.innerWidth - self.stageW);
      var maxY = Math.max(0, global.innerHeight - self.stageH);
      self.pos.x = Math.min(maxX, Math.max(0, d.ox + dx));
      self.pos.y = Math.min(maxY, Math.max(0, d.oy + dy));
      self._applyPos();
    });

    function endDrag() {
      var d = self.drag;
      if (!d) return;
      self.drag = null;
      self.stage.classList.remove('dragging');

      if (!d.moved) {
        /* 没移动 = 点击：播一个互动动画 */
        self.playOnce(pick(ANIMS.clicks, self.curAnim));
        return;
      }
      self._savePos();
      /* 松手 → 回待机 */
      self.switchTo(pick(ANIMS.idle), true, function () { self._scheduleIdle(); });
    }

    this.stage.addEventListener('pointerup', endDrag);
    this.stage.addEventListener('pointercancel', endDrag);

    /* 页面不可见时暂停视频，省电也省 GPU */
    document.addEventListener('visibilitychange', function () {
      if (!self.front) return;
      if (document.hidden) { try { self.front.pause(); } catch (e) { /* ignore */ } }
      else { try { self.front.play(); } catch (e) { /* ignore */ } }
    });

    global.addEventListener('resize', function () {
      if (self.destroyed) return;
      var maxX = Math.max(0, global.innerWidth - self.stageW);
      var maxY = Math.max(0, global.innerHeight - self.stageH);
      self.pos.x = Math.min(self.pos.x, maxX);
      self.pos.y = Math.min(self.pos.y, maxY);
      self._applyPos();
    });
  };

  WebPet.prototype.start = function () {
    this.switchTo(pick(ANIMS.idle), true, this._scheduleIdle.bind(this));
    return this;
  };

  WebPet.prototype.destroy = function () {
    this.destroyed = true;
    clearTimeout(this.timers.gap);
    if (this.walking) cancelAnimationFrame(this.walking);
    for (var n in this.layers) {
      try { this.layers[n].pause(); } catch (e) { /* ignore */ }
    }
    if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
  };

  /* ------------------------------------------------------------------ 导出 */
  global.ColumbinaWebPet = WebPet;
  global.WEBPET_ANIMS = ANIMS;

  /* 自动挂载：脚本一加载她就出现。想手动控制就设 window.COLUMBINA_WEBPET_NO_AUTO = true */
  function boot() {
    if (global.COLUMBINA_WEBPET_NO_AUTO) return;
    if (global.__columbinaWebPetInstance) return;
    var pet = new WebPet();
    global.__columbinaWebPetInstance = pet;
    pet.start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

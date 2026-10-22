/**
 * 手机端输入 + 横屏全屏控制
 *
 * =============================================================================
 * 为什么单独一个模块，而不是塞进 VenueScene
 * =============================================================================
 *   1. 输入法（键盘）和输入源（触屏控件）是两件事。VenueScene 里已经有
 *      cursors / keyW.. / keyInteract / keyQ / keyM 这些 Key 对象，
 *      再把 DOM 控件的监听写进去，会把「场景逻辑」和「DOM 事件」搅在一起。
 *   2. 键盘和触屏必须共用同一份真值：这里导出的 touchState / consumeTouch()
 *      就是那份真值。VenueScene 读取时和 Key.isDown **取或**，
 *      所以「按 WASD」和「按方向键」走的是同一条移动代码路径
 *      （包括暂停、对话、过场时的冻结语义，不用复制第二套）。
 *   3. 全屏 / 横屏是纯粹的外壳行为，和游戏逻辑无关。
 *
 * =============================================================================
 * 定长脉冲（pulse）：为什么不用伪造 KeyboardEvent
 * =============================================================================
 *   伪造 `new KeyboardEvent('keydown', {keyCode: 70})` 也能让 Phaser 的 Key.isDown
 *   变 true，但有三个坑：
 *     · 它是「写全局状态」——分不清是谁按的，出问题没法查；
 *     · 交互键 F 有 JustDown 语义（按下那一帧有效），伪造 keydown 后如果不配对
 *       keyup，下一次 JustDown 永远不会再触发；
 *     · 对话 / 信纸系统自己也挂了 window 的 keydown，伪造事件会顺带触发它们，
 *       出现「点一下互动键，对话连跳两页」这种耦合 bug。
 *   所以这里改为：控件按下 → 往 pulses 里写一个 **带过期时间的脉冲**，
 *   VenueScene 在 update 里消费一次。过期时间解决「按了但那一帧没被消费」的
 *   情况（比如按互动键时正好在对话中，handleInteract 根本没被调用）。
 */

/* -------------------------------------------------------------------------- */
/* 1. 共享输入状态（键盘与触屏的交汇点）                                       */
/* -------------------------------------------------------------------------- */

/** 四向持续态：对应 WASD / 方向键，按下即 true，抬起即 false */
export const touchState = {
  left: false,
  right: false,
  up: false,
  down: false,
};

/**
 * 脉冲窗口（ms）。
 * 为什么要过期：手机上一次点击可能在 100ms 后才被下一次 update 消费；
 * 但如果这期间场景处于对话 / 暂停状态，消费点根本不会被执行，
 * 脉冲留到对话结束后再触发就是「幽灵按键」。200ms 足够覆盖一帧抖动，
 * 又短到不可能跨过一次对话。
 */
const PULSE_MS = 200;

/** 一次性按键的到期时间戳（0 = 没有待消费的脉冲） */
const pulses = { interact: 0, quest: 0, map: 0 };

/** 写入一个脉冲 */
function fire(name) {
  if (!(name in pulses)) return;
  pulses[name] = Date.now() + PULSE_MS;
}

/**
 * 消费一个脉冲：读到就清掉，且只在这一帧内有效
 * @param {'interact'|'quest'|'map'} name
 * @returns {boolean} 这一帧是否应视为「该键被按下」
 */
export function consumeTouch(name) {
  const until = pulses[name] || 0;
  if (!until) return false;
  pulses[name] = 0;
  return Date.now() <= until;
}

/** 清空全部触控状态（失焦 / 切后台 / 场景重启时调用，防止「按键卡住」） */
export function resetTouchState() {
  touchState.left = touchState.right = touchState.up = touchState.down = false;
  pulses.interact = pulses.quest = pulses.map = 0;
}

/* -------------------------------------------------------------------------- */
/* 2. 环境判定                                                                 */
/* -------------------------------------------------------------------------- */

/** 是否触摸设备（粗指针 → 手机上必然命中；触摸笔记本用鼠标时不命中） */
function isCoarsePointer() {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** 当前是否横屏（用 innerWidth/innerHeight，CSS 旋转不会影响这两个值） */
function isLandscape() {
  return window.innerWidth > window.innerHeight;
}

/**
 * 对外暴露的触摸判定：给文案用（触屏上「按 F」是错的提示，要改成「点互动」）。
 * 没有触控层也照样返回真实值 —— 它描述的是设备，不是本模块有没有初始化。
 */
export function isTouchDevice() {
  return isCoarsePointer();
}

/* -------------------------------------------------------------------------- */
/* 3. 全屏 / 横屏                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 「沉浸模式」= 全屏 + 横屏。
 *
 * 能力差异（决定了必须做 CSS 兜底）：
 *   · Android Chrome：Fullscreen API ✓，screen.orientation.lock('landscape') ✓
 *     → 真全屏 + 真锁横屏，用户转不回去。
 *   · iPadOS Safari：webkitRequestFullscreen ✓，orientation.lock ✗
 *     → 全屏了但锁不住，靠用户自己转；转了以后 CSS 旋转自动失效。
 *   · iPhone Safari：两者都没有
 *     → 只能 CSS 假横屏（把 body 旋转 90°），视觉上是横屏。
 *   所以流程是「先尽力申请，再按实际视口补 CSS 旋转」，不是二选一。
 */
const immersive = {
  on: false,
  busy: false,
  /** 用户手动退出过，就不再自动进（避免和系统的退出手势打架） */
  userOptedOut: false,
};

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

async function enterFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return false;
  try {
    // navigationUI: 'hide' 让手机浏览器把地址栏也收掉（不支持时被忽略）
    await req.call(el, { navigationUI: 'hide' });
    return true;
  } catch {
    return false;
  }
}

async function exitFullscreen() {
  if (!fsElement()) return;
  const ex = document.exitFullscreen || document.webkitExitFullscreen;
  try {
    await ex.call(document);
  } catch {
    /* 用户手势限制 / 已在退出中，忽略 */
  }
}

async function lockLandscape() {
  try {
    if (screen.orientation && typeof screen.orientation.lock === 'function') {
      await screen.orientation.lock('landscape');
      return true;
    }
  } catch {
    /* iOS / 非全屏状态下会抛，属预期 */
  }
  return false;
}

function unlockOrientation() {
  try {
    if (screen.orientation && typeof screen.orientation.unlock === 'function') {
      screen.orientation.unlock();
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 打开 / 关闭 CSS 假横屏
 *
 * ★ 关键设计：**旋转的是 body，不是 #game-root**
 *   Phaser 的 ScaleManager 通过 `parent.getBoundingClientRect()` 取尺寸（RESIZE 模式
 *   每 500ms 轮询一次）。如果给 #game-root 加 transform，读到的是旋转后的**外接矩形**，
 *   宽高会被交换成反的。而旋转 body、让 #game-root 仍然是 `inset:0` 的 fixed 子元素时，
 *   它的大小会跟着 body 的布局尺寸走（100vh × 100vw，本来就已经交换过了），
 *   外接矩形正好等于横屏尺寸 —— Phaser 不用改一行。main.js 因此保持原样。
 */
function applyCssLandscape(on) {
  document.documentElement.classList.toggle('venue-force-landscape', !!on);
  // CSS 旋转不会触发 resize 事件，Phaser 只靠 500ms 轮询也能跟上；
  // 这里主动派发一次，让它当帧就重算画布，避免转屏瞬间有半秒黑边。
  window.dispatchEvent(new Event('resize'));
}

/** 按钮文案 / 高亮同步 */
function syncButton() {
  const btn = document.getElementById('fs-btn');
  if (!btn) return;
  btn.classList.toggle('on', immersive.on);
  btn.textContent = immersive.on ? '退出全屏' : '横屏全屏';
  btn.setAttribute('aria-pressed', immersive.on ? 'true' : 'false');
}

/**
 * 进入 / 退出沉浸模式
 * @param {boolean} on
 */
export async function setImmersive(on) {
  if (immersive.busy || immersive.on === !!on) {
    syncButton();
    return immersive.on;
  }
  immersive.busy = true;
  try {
    if (on) {
      immersive.on = true;
      await enterFullscreen();
      await lockLandscape();
      // 锁不住（iOS / 被拒绝）→ 只要现在还竖着，就用 CSS 兜底
      applyCssLandscape(!isLandscape());
    } else {
      immersive.on = false;
      applyCssLandscape(false);
      unlockOrientation();
      await exitFullscreen();
    }
  } finally {
    immersive.busy = false;
    syncButton();
    exposeDebug();
  }
  return immersive.on;
}

/** 供验收脚本读取的调试面（不参与游戏逻辑） */
function exposeDebug() {
  window.__venueMobile = {
    active: isCoarsePointer(),
    immersive: immersive.on,
    cssLandscape: document.documentElement.classList.contains('venue-force-landscape'),
    coarse: isCoarsePointer(),
    landscape: isLandscape(),
    touchState: { ...touchState },
  };
}

/* -------------------------------------------------------------------------- */
/* 4. 控件绑定                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 浮动隐形摇杆 → 四向布尔值
 *
 * 设计要点（用户拍板）：完全隐形 —— 屏幕上没有任何常驻控件，
 * 拖动时也不画圆环或摇杆芯，一点视觉反馈都没有。
 *   · 手指按在画面的哪里，哪里就是摇杆圆心；
 *   · 原地松手 = 一次普通点击，什么都不拦（点屏幕仍等于点鼠标）；
 *   · 按住并滑出阈值 = 开始移动。
 *
 * 为什么不用四向按钮：游戏斜向也能走（VenueScene 对斜向做了 1/√2 归一化，
 * 「W+D 一起按 = 右上」）。四个互斥按钮一次只能表达一个方向，斜走按不出来；
 * 补到八个按钮又挤成一团且常驻遮挡画面。摇杆把向量离散成 8 扇区，
 * 斜向同时点亮相邻两个标志，正好复用键盘那套既有逻辑 —— 场景代码不用改。
 *
 * 为什么离散成 8 扇区而不是连续量：角色只有 4 向行走动画 + 4 个斜向组合，
 * 8 扇区已覆盖游戏能表现的全部方向；用连续量就得给 touchState 换浮点契约、
 * 在场景里重做归一化与动画判定，改动面大而收益为零。
 */
const DRAG_THRESHOLD = 12; // px，超过才算「滑动移动」，否则算点击
const SECTORS = 8;

/** 把 (dx, dy) 向量离散成要置位的方向集合。屏幕坐标 y 向下，所以 up = dy < 0。 */
function dirsFromVector(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (!len) return [];
  // 角度：0 = 右，顺时针为正（因为 y 向下）
  const ang = Math.atan2(dy, dx);
  // 每个扇区 2π/8，四舍五入到最近的扇区中心
  const step = (Math.PI * 2) / SECTORS;
  const idx = Math.round(ang / step) & (SECTORS - 1);
  return [
    ['right'],
    ['right', 'down'],
    ['down'],
    ['down', 'left'],
    ['left'],
    ['left', 'up'],
    ['up'],
    ['up', 'right'],
  ][idx];
}

/**
 * 假横屏下屏幕坐标与画面坐标差 90°。
 *
 * canvas 的 CSS 是 rotate(90deg) translateY(-100%)，映射关系为
 * 内容 (x, y) → 屏幕 (H - y, x)，取逆得：dx_内容 = dy_屏幕，dy_内容 = -dx_屏幕。
 * 手指位移只有换算到内容坐标系，角色才会朝着玩家看到的方向走 ——
 * 否则手机上会出现「往右滑、人却往下走」。
 */
function screenDeltaToContent(dx, dy) {
  const rotated = document.documentElement.classList.contains('venue-force-landscape');
  return rotated ? { dx: dy, dy: -dx } : { dx, dy };
}

/**
 * 绑定隐形摇杆。
 *
 * 只在游戏画面（canvas / #game-root）上起手，HUD 按钮上的触摸一律不管，
 * 否则点「互动」会顺带把角色推动一下。
 *
 * 监听放在 window 的捕获阶段而不是 canvas 上：手指滑出 canvas 边界后
 * 仍要收到 pointermove/pointerup，否则方向会永久卡住、角色一直走。
 *
 * 没有任何视觉反馈 —— 圆环、摇杆芯一概不画（用户要求「隐形」）。
 */
function bindFloatingJoystick() {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  // 按下那一刻场景是否「忙」（对话 / 信纸 / 插画 overlay 开着）。
  // 必须在 pointerdown 记，不能到 pointerup 再读 —— 那一拍 overlay 已被点掉。
  let busyAtStart = false;

  const clearDirs = () => {
    touchState.left = touchState.right = touchState.up = touchState.down = false;
  };

  const isGameSurface = (el) => {
    if (!el) return false;
    if (el.id === 'game-root') return true;
    return el.tagName === 'CANVAS' && !!el.closest('#game-root');
  };

  const apply = (clientX, clientY) => {
    const sdx = clientX - startX;
    const sdy = clientY - startY;
    if (!dragging) {
      if (Math.hypot(sdx, sdy) < DRAG_THRESHOLD) return;
      dragging = true;
    }
    const { dx, dy } = screenDeltaToContent(sdx, sdy);
    const len = Math.hypot(dx, dy) || 1;
    clearDirs();
    // 归一化方向：手感与键盘一致（距离远近不改变速度）
    for (const d of dirsFromVector(dx / len, dy / len)) touchState[d] = true;
    exposeDebug();
  };

  const reset = () => {
    pointerId = null;
    dragging = false;
    clearDirs();
    exposeDebug();
  };

  window.addEventListener(
    'pointerdown',
    (e) => {
      // 只处理触摸（鼠标点击保持原样，桌面玩家不受影响）
      if (e.pointerType === 'mouse') return;
      if (pointerId !== null) return; // 多指：只跟踪第一根
      if (!isGameSurface(e.target)) return; // HUD 上的触摸不归摇杆管
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
      // 场景此刻是否正被对话 / 信纸 / 插画占着（这一拍之后 overlay 会被点掉，
      // 所以必须现在记下来，见 pointerup 里的说明）
      const sc = window.__venueScene;
      busyAtStart =
        !!window.__venuePaused ||
        !!sc?.overlay ||
        !!sc?.dialog?.isOpen?.() ||
        !!sc?.letter?.isOpen?.();
      // ★ 这里不 preventDefault：轻点必须原样落到 Phaser / DOM click 上，
      //   「点屏幕 = 点鼠标」正是靠这一点成立的。
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerId !== pointerId) return;
      apply(e.clientX, e.clientY);
    },
    { capture: true, passive: true }
  );

  const end = (e) => {
    if (e && e.pointerId !== pointerId) return;
    if (pointerId === null) return;
    const wasTap = !dragging;
    const sceneWasBusy = busyAtStart;
    reset();
    // ★ 轻点 = 点屏幕 = F 互动（用户明确要求的映射）。
    //
    //   为什么要看「按下那一刻」的场景状态，而不是松手时：
    //   F 互动与鼠标点击本来不是一回事，手机端没法区分所以只能等同；
    //   但画面上的插画 overlay 是靠 Phaser 的 pointerdown 收起的，
    //   点下去的那一帧 overlay 就已经没了 —— 等到 pointerup 再看，
    //   场景已经「空闲」，这次点击又会被当成互动，于是把插画重新打开。
    //   dialog / 信纸同理：那一拍是「点击推进对话」，不是新的互动。
    if (wasTap && !sceneWasBusy) fire('interact');
  };
  window.addEventListener('pointerup', end, { capture: true, passive: true });
  window.addEventListener('pointercancel', end, { capture: true, passive: true });

  // 转屏 / 切后台时把状态清干净，免得旧方向被带过去
  window.addEventListener('resize', () => {
    if (pointerId !== null) reset();
  });
}

/** 一次性动作键 */
function bindAction(el, name) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.classList.add('on');
    fire(name);
    exposeDebug();
  });
  const up = () => el.classList.remove('on');
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('click', (e) => e.preventDefault());
}

/* -------------------------------------------------------------------------- */
/* 5. 初始化                                                                   */
/* -------------------------------------------------------------------------- */

let bound = false;

/**
 * 初始化手机端控件。
 * 桌面端（无粗指针）直接返回 null，控件保持 hidden —— 桌面玩家看不到多余按钮。
 *
 * @returns {{active: boolean, toggleImmersive: () => Promise<boolean>}|null}
 */
export function initMobileControls() {
  if (bound) return { active: true, toggleImmersive: () => setImmersive(!immersive.on) };

  const act = document.getElementById('mobile-act');
  const fsBtn = document.getElementById('fs-btn');
  if (!act || !fsBtn) return null; // 非会场页面（如 index.html）不初始化

  const coarse = isCoarsePointer();
  // 全屏按钮只有触摸设备才显示；但保留 DOM，验收脚本可断言 hidden
  act.hidden = !coarse;
  fsBtn.hidden = !coarse;
  if (!coarse) {
    exposeDebug();
    return null;
  }

  bindFloatingJoystick();
  bindAction(document.getElementById('mp-interact'), 'interact');
  bindAction(document.getElementById('mp-map'), 'map');

  fsBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (immersive.on) immersive.userOptedOut = true;
    await setImmersive(!immersive.on);
  });

  // ---- 系统事件同步 ----
  document.addEventListener('fullscreenchange', () => {
    // 用户用系统手势退出全屏：跟着退出沉浸模式，按钮文案别骗人
    if (!fsElement() && immersive.on && !immersive.busy) {
      immersive.on = false;
      applyCssLandscape(false);
      syncButton();
      exposeDebug();
    }
  });

  // 切后台 / 失焦：把按住的方向全部松开，否则回来后角色会一直走
  window.addEventListener('blur', resetTouchState);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetTouchState();
  });

  // ---- 横屏自动全屏（best-effort）----
  //
  // 浏览器要求全屏必须由用户手势触发，所以「转屏即全屏」不可能 100% 成功。
  // 策略：转进横屏时先试一次（Android 上如果页面已被授权就直接成）；
  //       失败则记一个 pending，下一次用户触摸任意位置时补一次。
  //       用户手动按过「退出全屏」就不再自动进，免得和退出操作打架。
  let pendingAutoFs = false;
  let lastLandscape = isLandscape();

  const tryAutoImmersive = async () => {
    if (immersive.on || immersive.userOptedOut) return;
    if (!isLandscape()) return;
    const ok = await setImmersive(true);
    if (!ok) pendingAutoFs = true;
  };

  const onViewportChange = () => {
    const now = isLandscape();
    const cssOn = document.documentElement.classList.contains('venue-force-landscape');

    if (cssOn && now) {
      // ★ 兜底旋转的退场：CSS 假横屏只是「设备还竖着」时的权宜，
      //   用户把手机转过来以后必须撤掉，否则会变成横屏再转 90°，画面倒着。
      applyCssLandscape(false);
    } else if (immersive.on && !now && !cssOn) {
      // 沉浸模式里又转回竖屏（iOS 锁不住方向）：重新用 CSS 撑住横屏画面
      applyCssLandscape(true);
    } else if (now && !lastLandscape) {
      // 刚转成横屏 —— 尝试真正的全屏 + 锁方向
      tryAutoImmersive();
    }

    lastLandscape = now;
    exposeDebug();
  };

  window.addEventListener('resize', onViewportChange);
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', onViewportChange);
  }
  window.addEventListener('orientationchange', onViewportChange);

  // 手势补票：pending 时任意一次触摸都尝试补进全屏
  window.addEventListener(
    'pointerdown',
    () => {
      if (!pendingAutoFs) return;
      pendingAutoFs = false;
      tryAutoImmersive();
    },
    true
  );

  bound = true;
  syncButton();
  exposeDebug();

  return {
    active: true,
    toggleImmersive: () => setImmersive(!immersive.on),
    isImmersive: () => immersive.on,
  };
}

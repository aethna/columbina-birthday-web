// 主线写信环节 + 初始化按钮 专项核查
//   1. 写信环节已回归：书桌上只有一个交互点 ip-desk，开局一封都没写
//   1b. 书桌单点两态：写满前是「写」态、写满后自动变「收」态（文字 + 图标都切换）
//   2. 信纸过场：按 E → 信纸浮上来 → 逐行显示 → 折进信封 → 飞走 → 记进存档
//   3. 左下角初始化按钮：清存档 + 刷新，进度全部复位

import puppeteer from 'puppeteer';

const b = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-http-cache'],
  protocolTimeout: 180000,
});
const p = await b.newPage();
await p.setCacheEnabled(false);
await p.setViewport({ width: 1280, height: 720 });
const errs = [];
p.on('pageerror', (e) => errs.push('ERR ' + e.message.slice(0, 150)));

// window.confirm 在无头浏览器里默认返回 false，这里改成自动确认
p.on('dialog', async (d) => { await d.accept(); });

await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 3500));
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 6500));

const results = [];
const rec = (n, name, pass, detail) => results.push({ n, name, pass, detail });

// ---------- 1. 写信环节回归：书桌单点 + 开局空白 ----------
try {
  const r = await p.evaluate(async () => {
    const s = window.__venueScene;
    s.scenes.load('home', null, true);
    await new Promise((r) => setTimeout(r, 1800));
    const pts = s.interactPoints.points.map((x) => ({
      id: x.id, label: x.labelText, hint: x.hintText, action: x.action,
      icon: x.iconText, tile: [x.tileX, x.tileY],
    }));
    return {
      pts,
      hasDesk: pts.some((x) => x.id === 'ip-desk' && x.action === 'writeOrTake'),
      // 写信/收信合成一个点了，不该再有独立的 takeLetters 点
      hasSplitTake: pts.some((x) => x.action === 'takeLetters'),
      written: s.story.writtenCount,
      total: s.story.totalCount,
      onDesk: s.story.onDeskCount,
      carried: s.story.carriedCount,
      allWritten: s.story.allWritten,
    };
  });
  const pass = r.hasDesk && !r.hasSplitTake && r.total === 11
    && r.written === 0 && r.onDesk === 0 && r.carried === 0 && !r.allWritten;
  rec(1, '写信环节回归：书桌单点、开局一封都没写', pass,
      `home 交互点=${r.pts.map((x) => `${x.id}(${x.label})`).join('/')}  `
    + `独立收信点=${r.hasSplitTake}  written=${r.written}/${r.total} onDesk=${r.onDesk}`);
} catch (e) {
  rec(1, '写信环节回归：书桌单点、开局一封都没写', false, e.message);
}

// ---------- 1b. 书桌单点两态（文字 + 图标都随剧情切换） ----------
try {
  const r = await p.evaluate(async () => {
    const s = window.__venueScene;
    const read = () => {
      const x = s.interactPoints.points.find((q) => q.id === 'ip-desk');
      return { label: x.labelText, hint: x.hintText, icon: x.iconText };
    };
    const before = read();
    while (!s.story.allWritten) s.story.writeLetter();
    s.interactPoints.rebuild('home');
    s.refreshQuestUI();
    await new Promise((r) => setTimeout(r, 300));
    const after = read();
    const Q = (await import('/src/quests.js')).QUESTS;
    const mw = Q.find((x) => x.id === 'main-write');
    return {
      before, after,
      state: s.quests.getState(mw),
      counts: s.quests.getCounts(mw),
      prog: s.quests.getProgress(mw),
    };
  });
  const okBefore = r.before.label === '窗前的书桌' && r.before.hint.includes('写邀请函')
    && r.before.hint.includes('0/11') && r.before.icon === '✎';
  const okAfter = r.after.label === '桌上的邀请函' && r.after.hint === '按 E 收起来'
    && r.after.icon === '✉';
  const okQuest = r.state === 'completed' && r.prog === 1 && r.counts.got === 11 && r.counts.need === 11;
  rec(1, '书桌单点两态 + 主线进度按「写好」计',
      okBefore && okAfter && okQuest,
      `写态「${r.before.label} / ${r.before.hint} / ${r.before.icon}」  `
    + `收态「${r.after.label} / ${r.after.hint} / ${r.after.icon}」  `
    + `main-write=${r.state} ${r.counts.got}/${r.counts.need}`);
} catch (e) {
  rec(1, '书桌单点两态 + 主线进度按「写好」计', false, e.message);
}

// ---------- 2. 信纸过场：打开 → 逐行 → 收进信封 → 记进存档 ----------
try {
  await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import('/src/quests.js')).QUESTS;
    const mw = Q.find((x) => x.id === 'main-write');
    // 上一项检查把主线推到了 completed；任务状态是存在 QuestSystem 里的，
    // story.reset() 不会把它退回来，这里显式复位，模拟「刚开了一局新游戏」。
    s.story.reset();
    s.quests.setState(mw, 'active');
    s.scenes.load('home', null, true);
    await new Promise((r) => setTimeout(r, 1500));
  });
  await new Promise((r) => setTimeout(r, 800));

  const opened = await p.evaluate(() => {
    const s = window.__venueScene;
    const before = s.story.writtenCount;
    s.startLetterWriting();
    const root = document.getElementById('letter-root');
    const lines = document.querySelectorAll('#letter-body .letter-line').length;
    return {
      before,
      open: s.letter.isOpen(),
      paused: window.__venuePaused === true,
      active: root.classList.contains('active'),
      recipient: document.getElementById('letter-recipient').textContent,
      count: document.getElementById('letter-count').textContent,
      lines,
    };
  });

  // 直接跳到收尾，验证「折纸 → 收信封 → 飞走 → 记账」整条链路
  await p.evaluate(() => window.__venueScene.letter.skipToEnd());
  await new Promise((r) => setTimeout(r, 3600));

  const closed = await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import('/src/quests.js')).QUESTS;
    const mw = Q.find((x) => x.id === 'main-write');
    return {
      open: s.letter.isOpen(),
      paused: window.__venuePaused === true,
      active: document.getElementById('letter-root').classList.contains('active'),
      written: s.story.writtenCount,
      onDesk: s.story.onDeskCount,
      counts: s.quests.getCounts(mw),
      state: s.quests.getState(mw),
    };
  });

  const okOpen = opened.open && opened.paused && opened.active
    && opened.recipient === '桑多涅：' && opened.count.includes('1 / 11') && opened.lines >= 4;
  const okClose = !closed.open && !closed.paused && !closed.active
    && closed.written === opened.before + 1 && closed.onDesk === 1
    && closed.counts.got === 1 && closed.counts.need === 11 && closed.state === 'active';
  rec(2, '信纸过场：逐行显示 → 收归信封 → 记账',
      okOpen && okClose,
      `打开 open=${opened.open} paused=${opened.paused} 抬头="${opened.recipient}" `
    + `计数="${opened.count}" 段落=${opened.lines}  `
    + `收尾 open=${closed.open} paused=${closed.paused} written=${closed.written} `
    + `onDesk=${closed.onDesk} 主线=${closed.state} ${closed.counts.got}/${closed.counts.need}`);
} catch (e) {
  rec(2, '信纸过场：逐行显示 → 收归信封 → 记账', false, e.message);
}

// ---------- 3. 初始化按钮 ----------
try {
  // 先造一堆进度
  await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import('/src/quests.js')).QUESTS;
    s.story.takeLetters();
    s.story.data.delivered = true;
    s.story.save();
    Q.forEach((q) => { if (!q.special) s.quests.setState(q, 'active'); });
    Q.forEach((q) => { if (q.propReward) s.unlockProp(q.propReward.id); });
  });
  await new Promise((r) => setTimeout(r, 600));

  const before = await p.evaluate(() => ({
    written: window.__venueScene.story.writtenCount,
    carried: window.__venueScene.story.carriedCount,
  }));

  // 按钮存在且可见
  const btn = await p.evaluate(() => {
    const el = document.getElementById('reset-btn');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.textContent.trim(), x: Math.round(r.left), y: Math.round(r.top),
             w: Math.round(r.width), h: Math.round(r.height),
             visible: r.width > 0 && r.height > 0 };
  });

  // 点击（会触发 confirm -> 自动 accept -> reload）
  await Promise.all([
    p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null),
    p.click('#reset-btn'),
  ]);
  await new Promise((r) => setTimeout(r, 6500));

  const after = await p.evaluate(() => {
    const s = window.__venueScene;
    return {
      written: s ? s.story.writtenCount : null,
      onDesk: s ? s.story.onDeskCount : null,
      carried: s ? s.story.carriedCount : null,
      delivered: s ? s.story.isDelivered : null,
      propCount: s ? (s.props || []).filter((x) => x.texture).length : null,
    };
  });

  const resetOK = !!btn && btn.visible && btn.text === '初始化'
    && btn.x < 200 && btn.y > 500
    && after.written === 0 && after.onDesk === 0
    && after.carried === 0 && after.delivered === false && after.propCount === 0;

  rec(3, '左下角初始化按钮可用', resetOK,
      `按钮="${btn ? btn.text : '缺失'}" @(${btn ? btn.x : '-'},${btn ? btn.y : '-'})  `
    + `点击前 written=${before.written} carried=${before.carried}  `
    + `点击后 written=${after.written} onDesk=${after.onDesk} carried=${after.carried} `
    + `delivered=${after.delivered} 道具=${after.propCount}`);
} catch (e) {
  rec(3, '左下角初始化按钮可用', false, e.message);
}

console.log('\n============== 主线写信环节核查 ==============');
let passN = 0;
for (const r of results) {
  console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} 任务${r.n}  ${r.name}`);
  console.log(`         ${r.detail}`);
  if (r.pass) passN++;
}
console.log(`\n${passN}/${results.length} 通过`);
console.log('\n运行时报错:', errs.length ? [...new Set(errs)].slice(0, 4).join('\n') : '无');
await b.close();

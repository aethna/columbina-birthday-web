// 主线写信 + 投递 + 初始化按钮 专项核查
//
// 覆盖 2026-10-04 用户反馈的四个问题里的三个「流程类」问题：
//   1. 书桌提示里出现函数源码（`(s) => ...`）—— 这里断言 npcTip 的文本里不含 '=>'
//   2. 信纸逐行显示的速度（那部分靠 _shoot-letter.mjs 截图看，这里只保证不被改回来）
//   3. 「投递邀请函」走到信箱前没提示、按 E 无反应、任务卡死
//
// 检查项：
//   1. 写信环节：home 只有一个 ip-desk，开局一封都没写，提示文字是求值后的字符串
//   2. 书桌写满 → 点消失、11 封信直接进怀里（不再有「按 E 收起来」这一步）
//   3. 信箱投递：写满 11 封 → 信箱有提示 → 按 E 投递成功、主线完成（问题4 的回归测试）
//   4. 左下角初始化按钮：清存档 + 刷新，进度全部复位

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await wait(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await wait(6500);

const results = [];
const rec = (n, name, pass, detail) => results.push({ n, name, pass, detail });

// ---------- 1. 写信环节 + 提示文字是求值后的字符串 ----------
try {
  const r = await p.evaluate(async () => {
    const s = window.__venueScene;
    s.scenes.load('home', null, true);
    await new Promise((r) => setTimeout(r, 1800));
    const pts = s.interactPoints.points.map((x) => ({
      id: x.id, label: x.labelText, hint: x.hintText, action: x.action,
      icon: x.iconText, tile: [x.tileX, x.tileY],
    }));

    // 把主角挪到书桌点上，等游戏循环把浮动提示刷出来，读它的真实文本
    const desk = s.interactPoints.points.find((x) => x.id === 'ip-desk');
    let tip = '';
    if (desk) {
      s.player.x = desk.x;
      s.player.y = desk.y;
      s.interactPoints.update(s.player.x, s.player.y);
      await new Promise((r) => setTimeout(r, 600));
      tip = (s.npcTip && s.npcTip.text) || '';
    }

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
      tip,
    };
  });
  const okState = r.hasDesk && !r.hasSplitTake && r.total === 11
    && r.written === 0 && r.onDesk === 0 && r.carried === 0 && !r.allWritten;
  // ★ 问题1：提示文字必须是「✎ 窗前的书桌\n按 E 写邀请函（0/11）」，
  //   不能把 quests.js 里的 (story) => '...' 函数原样打出来
  const okTip = r.tip.includes('窗前的书桌') && r.tip.includes('按 E 写邀请函')
    && r.tip.includes('0/11') && !r.tip.includes('=>');
  rec(1, '写信环节：书桌单点、开局空白、提示文字已求值（问题1）', okState && okTip,
      `home 交互点=${r.pts.map((x) => `${x.id}(${x.label})`).join('/')}  `
    + `独立收信点=${r.hasSplitTake}  written=${r.written}/${r.total}  `
    + `提示=${JSON.stringify(r.tip)}`);
} catch (e) {
  rec(1, '写信环节：书桌单点、开局空白、提示文字已求值（问题1）', false, e.message);
}

// ---------- 2. 书桌写满 → 点消失 + 信直接进怀里 ----------
try {
  const r = await p.evaluate(async () => {
    const s = window.__venueScene;
    const read = () => {
      const x = s.interactPoints.points.find((q) => q.id === 'ip-desk');
      return x ? { label: x.labelText, hint: x.hintText, icon: x.iconText } : null;
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
      written: s.story.writtenCount,
      onDesk: s.story.onDeskCount,
      carried: s.story.carriedCount,
    };
  });
  const okBefore = !!r.before && r.before.label === '窗前的书桌'
    && r.before.hint.includes('写邀请函') && r.before.hint.includes('0/11') && r.before.icon === '✎';
  // ★ 写满 11 封后书桌点应当【消失】（requires 不成立），不再有「桌上的邀请函 / 按 E 收起来」
  const okAfter = r.after === null;
  // ★ 信必须在 carried 里（写信过场的收归信封 = 收进怀里），不能留在桌上
  const okBooks = r.written === 11 && r.carried === 11 && r.onDesk === 0;
  const okQuest = r.state === 'completed' && r.prog === 1 && r.counts.got === 11 && r.counts.need === 11;
  rec(2, '书桌写满后点消失 + 11 封信直接进怀里',
      okBefore && okAfter && okBooks && okQuest,
      `写态「${r.before ? r.before.label + ' / ' + r.before.hint + ' / ' + r.before.icon : '缺失'}」  `
    + `写满后=${r.after ? JSON.stringify(r.after) : '已消失'}  `
    + `written=${r.written} onDesk=${r.onDesk} carried=${r.carried}  `
    + `main-write=${r.state} ${r.counts.got}/${r.counts.need}`);
} catch (e) {
  rec(2, '书桌写满后点消失 + 11 封信直接进怀里', false, e.message);
}

// ---------- 3. 信箱投递（问题4 回归测试） ----------
try {
  await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import('/src/quests.js')).QUESTS;
    // 上一项检查把主线推到了 completed；任务状态存在 QuestSystem 里，
    // story.reset() 不会把它退回来，这里显式复位，模拟「刚开了一局新游戏」。
    s.story.reset();
    s.quests.setState(Q.find((x) => x.id === 'main-write'), 'active');
    s.quests.setState(Q.find((x) => x.id === 'main-deliver'), 'active');
    // 写满 11 封（每封的信封都进了怀里），然后站到信箱场景
    while (!s.story.allWritten) s.story.writeLetter();
    s.scenes.load('mailbox', null, true);
    await new Promise((r) => setTimeout(r, 1500));
    s.interactPoints.rebuild('mailbox');
    s.refreshQuestUI();
  });
  await wait(900);

  // 3a. 站在信箱点上 → 有提示、文字已求值、交互点可用
  const seen = await p.evaluate(async () => {
    const s = window.__venueScene;
    const pt = s.interactPoints.points.find((x) => x.id === 'ip-mailbox');
    if (!pt) return { missing: true, points: s.interactPoints.points.map((x) => x.id) };
    s.player.x = pt.x;
    s.player.y = pt.y;
    const nearest = s.interactPoints.update(s.player.x, s.player.y);
    await new Promise((r) => setTimeout(r, 600));
    return {
      id: pt.id,
      label: pt.labelText,
      hint: pt.hintText,
      available: !!nearest,
      activeId: s.interactPoints.active ? s.interactPoints.active.id : null,
      tip: (s.npcTip && s.npcTip.text) || '',
      carried: s.story.carriedCount,
      onDesk: s.story.onDeskCount,
    };
  });

  // 3b. 按 E 投递
  const done = await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import('/src/quests.js')).QUESTS;
    const pt = s.interactPoints.points.find((x) => x.id === 'ip-mailbox');
    s.triggerPoint(pt);
    await new Promise((r) => setTimeout(r, 400));
    const md = Q.find((x) => x.id === 'main-deliver');
    return {
      delivered: s.story.isDelivered,
      state: s.quests.getState(md),
      counts: s.quests.getCounts(md),
      carried: s.story.carriedCount,
    };
  });

  const okSeen = !seen.missing && seen.available && seen.activeId === 'ip-mailbox'
    && seen.label === '林间信箱' && seen.hint === '按 E 投递邀请函'
    && seen.tip.includes('林间信箱') && seen.tip.includes('按 E 投递邀请函')
    && !seen.tip.includes('=>');
  const okDone = done.delivered === true && done.state === 'completed'
    && done.counts.got === 1 && done.counts.need === 1;
  rec(3, '信箱投递：写满 11 封后信箱有提示且按 E 投得出去（问题4 回归）',
      okSeen && okDone,
      `信箱点=${seen.missing ? '缺失' : `${seen.label} / ${seen.hint}`}  `
    + `可用=${seen.available} active=${seen.activeId} 提示=${JSON.stringify(seen.tip || '')}  `
    + `投递后 delivered=${done.delivered} main-deliver=${done.state} ${done.counts.got}/${done.counts.need}`);
} catch (e) {
  rec(3, '信箱投递：写满 11 封后信箱有提示且按 E 投得出去（问题4 回归）', false, e.message);
}

// ---------- 4. 初始化按钮 ----------
try {
  // 先造一堆进度
  await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import('/src/quests.js')).QUESTS;
    s.story.data.delivered = true;
    s.story.save();
    Q.forEach((q) => { if (!q.special) s.quests.setState(q, 'active'); });
    Q.forEach((q) => { if (q.propReward) s.unlockProp(q.propReward.id); });
  });
  await wait(600);

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
  await wait(6500);

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

  rec(4, '左下角初始化按钮可用', resetOK,
      `按钮="${btn ? btn.text : '缺失'}" @(${btn ? btn.x : '-'},${btn ? btn.y : '-'})  `
    + `点击前 written=${before.written} carried=${before.carried}  `
    + `点击后 written=${after.written} onDesk=${after.onDesk} carried=${after.carried} `
    + `delivered=${after.delivered} 道具=${after.propCount}`);
} catch (e) {
  rec(4, '左下角初始化按钮可用', false, e.message);
}

console.log('\n============ 主线写信 + 投递环节核查 ============');
let passN = 0;
for (const r of results) {
  console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} 任务${r.n}  ${r.name}`);
  console.log(`         ${r.detail}`);
  if (r.pass) passN++;
}
console.log(`\n${passN}/${results.length} 通过`);
console.log('\n运行时报错:', errs.length ? [...new Set(errs)].slice(0, 4).join('\n') : '无');
await b.close();

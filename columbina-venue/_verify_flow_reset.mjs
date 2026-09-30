// 本轮 2 项修复的专项核查
//   1. 主线流程：写信环节已去掉，开局桌上 5 封信
//   2. 左下角初始化按钮：清存档 + 刷新，进度全部复位
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

// ---------- 1. 新流程：没有写信交互点，开局桌上 5 封信 ----------
try {
  const r = await p.evaluate(async () => {
    const s = window.__venueScene;
    s.scenes.load('home', null, true);
    await new Promise((r) => setTimeout(r, 1800));
    const pts = s.interactPoints.points.map((x) => ({
      id: x.id, label: x.label, action: x.action, shape: x.shape,
    }));
    return {
      pts,
      hasDesk: pts.some((x) => x.id === 'ip-desk' || x.action === 'writeLetter'),
      hasTake: pts.some((x) => x.action === 'takeLetters'),
      onDesk: s.story.onDeskCount,
      written: s.story.writtenCount,
      carried: s.story.carriedCount,
      allWritten: s.story.allWritten,
    };
  });
  rec(1, '去掉写信环节，开局桌上 5 封',
      !r.hasDesk && r.hasTake && r.onDesk === 5 && r.written === 5 && r.allWritten,
      `home 交互点=${r.pts.map((x) => x.label).join('/')}  写信点存在=${r.hasDesk}  `
    + `onDesk=${r.onDesk} written=${r.written}`);
} catch (e) {
  rec(1, '去掉写信环节，开局桌上 5 封', false, e.message);
}

// ---------- 1b. 任务文案 + 进度语义 ----------
try {
  const r = await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import('/src/quests.js')).QUESTS;
    const mw = Q.find((x) => x.id === 'main-write');
    const before = {
      title: mw.title, desc: mw.desc,
      state: s.quests.getState(mw),
      counts: s.quests.getCounts(mw),
      prog: s.quests.getProgress(mw),
    };
    // 模拟「收起了 5 封信」
    s.story.takeLetters();
    await new Promise((r) => setTimeout(r, 400));
    const after = {
      state: s.quests.getState(mw),
      counts: s.quests.getCounts(mw),
      prog: s.quests.getProgress(mw),
      carried: s.story.carriedCount,
    };
    return { before, after };
  });
  const okTitle = r.before.title.includes('整理') || r.before.title.includes('邀请函');
  const okDesc = r.before.desc.includes('写好');
  const okBefore = r.before.state === 'active' && r.before.prog === 0;
  const okAfter = r.after.state === 'completed' && r.after.prog === 1 && r.after.carried === 5;
  rec(1, '任务文案与进度语义正确', okTitle && okDesc && okBefore && okAfter,
      `标题="${r.before.title}" 描述="${r.before.desc}"  `
    + `收起前=${r.before.state} ${r.after.carried === 5 ? '' : ''}0/5  `
    + `收起后=${r.after.state} ${r.after.counts.got}/${r.after.counts.need}`);
} catch (e) {
  rec(1, '任务文案与进度语义正确', false, e.message);
}

// ---------- 2. 初始化按钮 ----------
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
    keys: Object.keys(localStorage).length,
    story: localStorage.getItem('venue-story-v1') ? '有' : '无',
    quests: localStorage.getItem('venue-quests-v2') ? '有' : '无',
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
      keys: Object.keys(localStorage).length,
      story: localStorage.getItem('venue-story-v1') ? '有' : '无',
      quests: localStorage.getItem('venue-quests-v2') ? '有' : '无',
      onDesk: s ? s.story.onDeskCount : null,
      carried: s ? s.story.carriedCount : null,
      delivered: s ? s.story.isDelivered : null,
      propCount: s ? (s.props || []).filter((x) => x.texture).length : null,
    };
  });

  const ok = btn && btn.visible
    && btn.text === '初始化'
    && btn.x < 200 && btn.y > 500          // 左下角
    && after.story === '无' || after.onDesk === 5;  // 存档被清 -> 回到初始

  const resetOK = after.onDesk === 5 && after.carried === 0
    && after.delivered === false && after.propCount === 0;

  rec(2, '左下角初始化按钮可用', !!btn && btn.visible && resetOK,
      `按钮="${btn ? btn.text : '缺失'}" @(${btn ? btn.x : '-'},${btn ? btn.y : '-'})  `
    + `点击前存档 keys=${before.keys}  `
    + `点击后 onDesk=${after.onDesk} carried=${after.carried} delivered=${after.delivered} 道具=${after.propCount}`);
} catch (e) {
  rec(2, '左下角初始化按钮可用', false, e.message);
}

console.log('\n============== 本轮修复核查 ==============');
let passN = 0;
for (const r of results) {
  console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} 任务${r.n}  ${r.name}`);
  console.log(`         ${r.detail}`);
  if (r.pass) passN++;
}
console.log(`\n${passN}/${results.length} 通过`);
console.log('\n运行时报错:', errs.length ? [...new Set(errs)].slice(0, 4).join('\n') : '无');
await b.close();

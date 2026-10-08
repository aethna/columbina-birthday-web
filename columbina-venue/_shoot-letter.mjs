// 信纸过场（写邀请函）的视觉验收：
//   1. 打开信纸 → 逐行显示的中间态
//   2. 收归信封 → 信封打开 / 封口 / 飞走
// 同时把页面报错、DOM 尺寸、正文文本都打出来，方便定位问题。
import puppeteer from 'puppeteer';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会\\venue';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });

const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(3000);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await sleep(7000);

// ---- 1. 走到 home 场景 ------------------------------------------------
await p.evaluate(async () => {
  const s = window.__venueScene;
  s.scenes.load('home', null, true);
  await new Promise((r) => setTimeout(r, 2500));
});
await sleep(800);

const state1 = await p.evaluate(() => {
  const s = window.__venueScene;
  const pts = (s.interactPoints.points || []).map((q) => ({
    id: q.id, action: q.action, label: q.labelText, hint: q.hintText, icon: q.iconText,
    tx: q.tileX, ty: q.tileY, x: Math.round(q.x), y: Math.round(q.y),
  }));
  return {
    scene: s.scenes.current.id,
    story: { written: s.story.writtenCount, total: s.story.totalCount, onDesk: s.story.onDeskCount },
    quests: s.quests.snapshot().filter((q) => q.id.startsWith('main')).map((q) => ({ id: q.id, state: q.state, progress: q.progress, counter: q.counter, need: q.need, title: q.title })),
    points: pts,
  };
});
console.log('=== home 初始状态 ===');
console.log(JSON.stringify(state1, null, 1));

// ---- 2. 打开信纸，拍逐行显示的过程 ------------------------------------
await p.evaluate(() => window.__venueScene.startLetterWriting());
await sleep(1000);
await p.screenshot({ path: `${OUT}\\_letter_a_open.png` });

const dom1 = await p.evaluate(() => {
  const paper = document.getElementById('letter-paper');
  const body = document.getElementById('letter-body');
  const r = paper.getBoundingClientRect();
  return {
    active: document.getElementById('letter-root').classList.contains('active'),
    paused: !!window.__venuePaused,
    paper: `${Math.round(r.width)}x${Math.round(r.height)} @ ${Math.round(r.x)},${Math.round(r.y)}`,
    paperOpacity: getComputedStyle(paper).opacity,
    lines: [...body.querySelectorAll('.letter-line')].map((el) => ({ shown: el.classList.contains('show'), text: el.textContent })),
    recipient: document.getElementById('letter-recipient').textContent,
    sign: document.getElementById('letter-sign').textContent,
    count: document.getElementById('letter-count').textContent,
  };
});
console.log('=== 信纸打开 1.0s ===');
console.log(JSON.stringify(dom1, null, 1));

await sleep(1800);
await p.screenshot({ path: `${OUT}\\_letter_b_mid.png` });
const dom2 = await p.evaluate(() => ({
  lines: [...document.querySelectorAll('#letter-body .letter-line')].map((el) => el.textContent.length),
  sign: getComputedStyle(document.getElementById('letter-sign')).opacity,
}));
console.log('=== 逐行显示 2.8s（每行已打字数）===', JSON.stringify(dom2));

await sleep(2200);
await p.screenshot({ path: `${OUT}\\_letter_c_full.png` });

// ---- 3. 跳过 → 收归信封 ----------------------------------------------
await p.evaluate(() => window.__venueScene.letter.skipToEnd());
await sleep(500);
await p.screenshot({ path: `${OUT}\\_letter_d_env_open.png` });
await sleep(700);
await p.screenshot({ path: `${OUT}\\_letter_e_seal.png` });
await sleep(700);
await p.screenshot({ path: `${OUT}\\_letter_f_fly.png` });
await sleep(1200);
await p.screenshot({ path: `${OUT}\\_letter_g_after.png` });

const state2 = await p.evaluate(() => {
  const s = window.__venueScene;
  const pts = (s.interactPoints.points || []).map((q) => ({ id: q.id, label: q.labelText, hint: q.hintText, icon: q.iconText }));
  return {
    letterOpen: s.letter.isOpen(),
    paused: !!window.__venuePaused,
    story: { written: s.story.writtenCount, total: s.story.totalCount, onDesk: s.story.onDeskCount },
    quests: s.quests.snapshot().filter((q) => q.id.startsWith('main')).map((q) => ({ id: q.id, state: q.state, progress: q.progress, counter: q.counter, need: q.need })),
    points: pts,
  };
});
console.log('=== 写完第 1 封后 ===');
console.log(JSON.stringify(state2, null, 1));

// ---- 4. 连写到全部写完（不截图，只验证逻辑）----------------------------
const state3 = await p.evaluate(async () => {
  const s = window.__venueScene;
  for (let i = 0; i < 12; i++) {
    s.startLetterWriting();
    // 等一帧，让 open() 把状态挂上，然后直接跳到收尾
    await new Promise((r) => setTimeout(r, 60));
    if (s.letter.isOpen()) s.letter.skipToEnd();
    await new Promise((r) => setTimeout(r, 3200));
  }
  return {
    written: s.story.writtenCount, total: s.story.totalCount,
    allWritten: s.story.allWritten, onDesk: s.story.onDeskCount,
    quests: s.quests.snapshot().filter((q) => q.id.startsWith('main')).map((q) => ({ id: q.id, state: q.state, progress: q.progress, counter: q.counter, need: q.need })),
    points: (s.interactPoints.points || []).map((q) => ({ id: q.id, label: q.labelText, hint: q.hintText, icon: q.iconText, available: q.marker.alpha > 0.1 })),
  };
});
console.log('=== 11 封全部写完 ===');
console.log(JSON.stringify(state3, null, 1));

console.log('\n=== 页面报错 ===');
console.log(errs.length ? errs.slice(0, 20).join('\n') : '(无)');
await b.close();

// 2026-10-04 四个问题的截图 + 实测证据
//
//   问题1  书桌浮动提示打印出函数源码      → _fix1_desk_tip.png + npcTip 原文
//   问题2  邀请函逐行显示太快              → _fix2_letter_typing.png + 每行打完的实测毫秒
//   问题3  火漆印改成蓝色弯月              → 由 _shoot-letter.mjs 的 _letter_e_seal.png 覆盖
//   问题4  信箱前没提示、按 E 无反应        → _fix4_mailbox_tip.png + 投递后的 _fix4_delivered.png
//
// 跑法：在 venue/ 目录下 `node _shoot-fixes.mjs`

import puppeteer from 'puppeteer';

const b = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-http-cache'],
  protocolTimeout: 240000,
});
const p = await b.newPage();
await p.setCacheEnabled(false);
await p.setViewport({ width: 1280, height: 720 });
const errs = [];
p.on('pageerror', (e) => errs.push('ERR ' + e.message.slice(0, 150)));
p.on('dialog', async (d) => { await d.accept(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const log = (s) => { out.push(s); console.log(s); };

await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await wait(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await wait(6500);

// ---------- 问题1：书桌提示 ----------
await p.evaluate(async () => {
  const s = window.__venueScene;
  s.scenes.load('home', null, true);
  await new Promise((r) => setTimeout(r, 1500));
  const desk = s.interactPoints.points.find((x) => x.id === 'ip-desk');
  s.player.x = desk.x;
  s.player.y = desk.y + 40;
  s.interactPoints.update(s.player.x, s.player.y);
});
await wait(900);
await p.screenshot({ path: '_fix1_desk_tip.png' });
const tip1 = await p.evaluate(() => (window.__venueScene.npcTip || {}).text || '');
log(`问题1 书桌提示原文: ${JSON.stringify(tip1)}`);
log(`问题1 含函数源码 '=>' : ${tip1.includes('=>')}`);

// ---------- 问题2：逐行显示的实测节奏 ----------
await p.evaluate(() => {
  const s = window.__venueScene;
  window.__speed = [];
  const t0 = performance.now();
  window.__speedTimer = setInterval(() => {
    document.querySelectorAll('#letter-body .letter-line').forEach((el, i) => {
      if (el.dataset.text && el.textContent === el.dataset.text && !el.dataset.doneAt) {
        el.dataset.doneAt = String(Math.round(performance.now() - t0));
        window.__speed.push({ line: i + 1, chars: el.dataset.text.length, ms: Math.round(performance.now() - t0) });
      }
    });
  }, 50);
  s.startLetterWriting();
});

// 让它自然打完前几行（不干预），中途拍一张
await wait(9000);
await p.screenshot({ path: '_fix2_letter_typing.png' });
await wait(9000);

const speed = await p.evaluate(() => {
  clearInterval(window.__speedTimer);
  return window.__speed;
});
log('问题2 每行打完的时刻（自然播放，未按 E 跳过）：');
for (const s of speed) log(`        第 ${s.line} 行  ${s.chars} 字  @ ${(s.ms / 1000).toFixed(2)}s`);

// 收尾，把这一封记进去
await p.evaluate(() => window.__venueScene.letter.skipToEnd());
await wait(3800);

// ---------- 问题4：信箱提示 + 投递 ----------
await p.evaluate(async () => {
  const s = window.__venueScene;
  const Q = (await import('/src/quests.js')).QUESTS;
  s.story.reset();
  s.quests.setState(Q.find((x) => x.id === 'main-write'), 'active');
  s.quests.setState(Q.find((x) => x.id === 'main-deliver'), 'active');
  while (!s.story.allWritten) s.story.writeLetter();
  s.scenes.load('mailbox', null, true);
  await new Promise((r) => setTimeout(r, 1600));
  s.interactPoints.rebuild('mailbox');
  const pt = s.interactPoints.points.find((x) => x.id === 'ip-mailbox');
  s.player.x = pt.x;
  s.player.y = pt.y + 44;
  s.interactPoints.update(s.player.x, s.player.y);
  s.refreshQuestUI();
});
await wait(1000);
await p.screenshot({ path: '_fix4_mailbox_tip.png' });
const tip4 = await p.evaluate(() => (window.__venueScene.npcTip || {}).text || '');
log(`问题4 信箱提示原文: ${JSON.stringify(tip4)}`);

await p.evaluate(() => {
  const s = window.__venueScene;
  const pt = s.interactPoints.points.find((x) => x.id === 'ip-mailbox');
  s.triggerPoint(pt);
});
await wait(1200);
await p.screenshot({ path: '_fix4_delivered.png' });
const after4 = await p.evaluate(async () => {
  const s = window.__venueScene;
  const Q = (await import('/src/quests.js')).QUESTS;
  const md = Q.find((x) => x.id === 'main-deliver');
  return {
    delivered: s.story.isDelivered,
    state: s.quests.getState(md),
    counts: s.quests.getCounts(md),
  };
});
log(`问题4 按 E 之后: delivered=${after4.delivered}  main-deliver=${after4.state} `
  + `${after4.counts.got}/${after4.counts.need}`);

const tail = `\n=== 页面报错 ===\n${errs.length ? [...new Set(errs)].slice(0, 4).join('\n') : '(无)'}\n`;
out.push(tail);
console.log(tail);

const fs = await import('node:fs');
fs.writeFileSync('D:/DSH工作区/哥伦比娅生日会/_fixes_shots_report.txt', out.join('\n'), 'utf8');

await b.close();

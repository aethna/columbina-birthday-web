// 实拍：结局「切蛋糕」的两处修复
//   ① 任务列表里点「前往」能正确指到主会场（用户反馈 2）
//   ② 主会场的「切蛋糕」交互点图标真的看得见（用户追加反馈）
//
// 跑法（必须在 venue/ 目录下）：node _shot_cake.mjs
import puppeteer from 'puppeteer';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会\\venue';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 300000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await sleep(6500);

// ---- 直接把状态推到「结局任务刚出现」 ----
await p.evaluate(async () => {
  const s = window.__venueScene;
  const { QUESTS } = await import('/src/quests.js');
  s.scenes.load('venue', { tileX: 20, tileY: 18 }, true);
  await new Promise((r) => setTimeout(r, 1200));
  s.story.data.lettersWritten = s.story.snapshot().letters.map((l) => l.id);
  s.story.data.delivered = true;
  s.story.save();
  s.quests.reset();
  await new Promise((r) => setTimeout(r, 400));
  QUESTS.filter((q) => q.id !== 'q-party-cake')
    .forEach((q) => { s.quests.data.states[q.id] = 'completed'; });
  s.quests.save();
  s.maybeStartParty();
  await new Promise((r) => setTimeout(r, 2600));
});
await sleep(1200);

// ---- ① 任务列表：切蛋糕这一条 + 点「前往」的提示 ----
await p.evaluate(() => {
  document.getElementById('quest-tab').click();
});
await sleep(900);
// 列表可滚动，「切蛋糕」是最后一条 —— 滚到底才拍得到
await p.evaluate(() => {
  const list = document.getElementById('quest-list')
    || document.querySelector('.quest-list')
    || document.querySelector('#quest-panel .quest-list');
  if (list) list.scrollTop = list.scrollHeight;
  document.querySelectorAll('#quest-panel *').forEach((el) => {
    if (el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight;
  });
});
await sleep(600);
await p.screenshot({ path: `${OUT}\\_cake_1_panel.png` });

await p.evaluate(() => {
  const btn = document.querySelector('.quest-goto[data-quest="q-party-cake"]');
  if (btn) btn.click();
});
await sleep(700);
await p.screenshot({ path: `${OUT}\\_cake_2_goto.png` });
const toast = await p.evaluate(() => {
  const s = window.__venueScene;
  const btn = document.querySelector('.quest-goto[data-quest="q-party-cake"]');
  return {
    buttonExists: !!btn,
    buttonText: btn ? btn.textContent : null,
    listHasCake: !!document.querySelector('.quest-item') &&
      document.body.innerText.includes('切蛋糕'),
    toastText: s && s.toastText ? s.toastText.text : null,
    toastAlpha: s && s.toastText ? Math.round(s.toastText.alpha * 100) / 100 : null,
  };
});
console.log('TOAST ' + JSON.stringify(toast));

// 收起面板，看主会场本体
await p.evaluate(() => {
  document.getElementById('quest-close')?.click();
  document.querySelector('#quest-panel .quest-close')?.click();
  document.getElementById('quest-tab')?.click();
});
await sleep(400);
await p.evaluate(() => {
  // 面板还开着就直接加 hidden
  const panel = document.getElementById('quest-panel');
  if (panel) panel.classList.add('hidden');
  const tab = document.getElementById('quest-tab');
  if (tab) tab.classList.remove('hidden');
});
await sleep(1400);
await p.screenshot({ path: `${OUT}\\_cake_3_scene.png` });

const info = await p.evaluate(() => {
  const s = window.__venueScene;
  const cake = (s.interactPoints.points || []).find((x) => x.id === 'ip-party-cake');
  return {
    heroTile: s.player ? [Math.floor(s.player.x / 64), Math.floor(s.player.y / 64)] : null,
    cakeVisible: cake && cake.icon ? cake.icon.visible : null,
    cakeDepth: cake && cake.icon ? cake.icon.depth : null,
    labelVisible: cake && cake.labelObj ? cake.labelObj.visible : null,
  };
});
console.log(JSON.stringify(info));
console.log('OK _cake_1_panel.png / _cake_2_goto.png / _cake_3_scene.png');
await b.close();

// 第八轮实拍：围坐 NPC 的互动（图标 / 对话 / 查看合影 / 占位入口）
//
//   跑法（必须在 venue/ 目录下）：node _shot_round8.mjs
//   产物：_round8_seated.png / _round8_dialog.png / _round8_cake.png
import puppeteer from 'puppeteer';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会\\venue';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 300000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await sleep(6500);

// 开庆功宴（切蛋糕留着）
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
  await new Promise((r) => setTimeout(r, 2500));
});

// A：切蛋糕【之前】—— 主位有光圈，坐姿 NPC 没有任何图标
await sleep(600);
await p.screenshot({ path: `${OUT}\\_round8_before.png` });

// 切蛋糕（看大合影）
await p.evaluate(async () => {
  const s = window.__venueScene;
  s.placeHeroAtPartySpot();
  for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
  s.showCakeCutscene();
  for (let i = 0; i < 14; i++) await new Promise((r) => requestAnimationFrame(r));
});
await sleep(900);
await p.screenshot({ path: `${OUT}\\_round8_cake.png` });

await p.evaluate(async () => {
  const s = window.__venueScene;
  s.closeOverlay();
  for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));
  // 站到爱诺（远排最左）身边
  const seat = s.seatedNpcs.find((n) => n.id === 'npc-ainuo');
  s.player.x = seat.rect.left + 8;
  s.player.y = seat.rect.top - 26;
  for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));
  s.handleProximity();
  for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
});
await sleep(700);
await p.screenshot({ path: `${OUT}\\_round8_seated.png` });

// 开对话
await p.evaluate(async () => {
  const s = window.__venueScene;
  s.startDialog(s.activeNpc || s.seatedNpcs[0]);
  await new Promise((r) => setTimeout(r, 900));
});
await sleep(700);
await p.screenshot({ path: `${OUT}\\_round8_dialog.png` });

// 跳到「查看合影」那一行
await p.evaluate(async () => {
  const s = window.__venueScene;
  const lines = s.buildSeatedDialogLines(s.dialog.currentNpc || s.seatedNpcs[0]);
  s.dialog.index = lines.findIndex((l) => l.link && l.link.photo);
  s.dialog.render();
  await new Promise((r) => setTimeout(r, 900));
});
await sleep(700);
await p.screenshot({ path: `${OUT}\\_round8_links.png` });

// 点「查看合影」→ 修订后应该看到【这位 NPC 和哥伦比娅的单独合影】
await p.evaluate(async () => {
  const s = window.__venueScene;
  document.querySelector('#dialog-links .dialog-link').click();
  for (let i = 0; i < 14; i++) await new Promise((r) => requestAnimationFrame(r));
});
await sleep(900);
await p.screenshot({ path: `${OUT}\\_round8_photo.png` });

console.log('shots done');
await b.close();

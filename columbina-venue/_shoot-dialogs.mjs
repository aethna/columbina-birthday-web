// 对话框头像核查
//
// 目标：13 位客人的对话框头像现在全部换成了 Q 版立绘（原来是 5 张写实全身立绘 +
//       8 张新增的混搭），需要把每一个头像放进真实对话框里看一遍 ——
//       会不会被裁掉、和 portraitBg 撞色、比例是否统一。
//
// 做法：把存档改成「11 封都已投递」，客人全部到场，然后对每一位调用
//       s.startDialog(npc)，直接截 #dialog-root 这个 DOM 元素（不是截全屏，
//       这样 13 张拼在一起就是一张干净的对照表）。

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
p.on('pageerror', (e) => errs.push('ERR ' + e.message.slice(0, 160)));

await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 3500));
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 7000));

const names = await p.evaluate(async () => {
  const s = window.__venueScene;
  const GUESTS = (await import('/src/StorySystem.js')).GUESTS;
  s.story.data.lettersWritten = GUESTS.map((g) => g.id);
  s.story.data.onDesk = 0;
  s.story.data.carried = 0;
  s.story.data.delivered = true;
  s.story.save();
  s.scenes.load('venue', null, true);
  await new Promise((r) => setTimeout(r, 2600));
  return s.npcs.map((n) => n.name);
});
console.log(`对话框头像核查：${names.length} 位`);

const root = await p.evaluateHandle(() => window.__venueScene.dialog.root);
const el = root.asElement();

for (let i = 0; i < names.length; i++) {
  await p.evaluate((idx) => {
    const s = window.__venueScene;
    if (s.dialog.isOpen()) s.dialog.close();
    s.startDialog(s.npcs[idx]);
  }, i);
  await new Promise((r) => setTimeout(r, 500));
  // 让第一句打完，文字不会停在半截
  await p.evaluate(() => window.__venueScene.dialog.finishTyping && window.__venueScene.dialog.finishTyping());
  await new Promise((r) => setTimeout(r, 220));
  const file = `_dlg_${String(i).padStart(2, '0')}_${names[i]}.png`;
  await el.screenshot({ path: file });
  console.log(`  截图 ${file}`);
}

await p.evaluate(() => window.__venueScene.dialog.close());
console.log('\n运行时报错:', errs.length ? [...new Set(errs)].slice(0, 5).join('\n') : '无');
await b.close();

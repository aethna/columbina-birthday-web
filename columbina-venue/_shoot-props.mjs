// 把 5 个道具的实际位置，叠加到用户标注的网格图上，直观核对是否落在红框里
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会\\venue';
const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise(r => setTimeout(r, 3500));
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await new Promise(r => setTimeout(r, 6500));

// 解锁全部道具并切到会场
const info = await p.evaluate(async () => {
  const s = window.__venueScene;
  const Q = (await import('/src/quests.js')).QUESTS;
  Q.forEach(q => { if (q.propReward) s.unlockProp(q.propReward.id); });
  s.scenes.load('venue', null, true);
  await new Promise(r => setTimeout(r, 2200));
  return {
    props: (s.props || []).filter(x => x.texture).map(x => ({
      key: x.texture.key, x: x.x, y: x.y,
    })),
  };
});
console.log('会场道具:');
info.props.forEach(pr => console.log(`  ${pr.key} @ (${Math.round(pr.x)}, ${Math.round(pr.y)})`));

// 用 F2 全图视图拍一张，能一次看到整个会场
await p.evaluate(async () => {
  const s = window.__venueScene;
  // 直接调 F2 的逻辑
  if (s.toggleFullMap) s.toggleFullMap();
  await new Promise(r => setTimeout(r, 900));
});
await new Promise(r => setTimeout(r, 800));
const fn = `${OUT}\\_props_fullmap.png`;
await p.screenshot({ path: fn });
console.log('全图:', fn);

await b.close();

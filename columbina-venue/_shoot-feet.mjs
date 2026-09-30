// 把两个版本都拍成游戏内四方向画面，做并排对比
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'D:\\DSH工作区\\哥伦比娅生日会';
const OUT = path.join(ROOT, 'venue');

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise(r => setTimeout(r, 3500));
await p.evaluate(() => { localStorage.clear(); });
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await new Promise(r => setTimeout(r, 5500));
await p.addStyleTag({ content: '#quest-panel,#quest-list,aside{display:none!important}' });

const tag = process.argv[2] || 'vX';
const shots = [];

for (const [key, dir] of [['s', 'down'], ['a', 'left'], ['d', 'right'], ['w', 'up']]) {
  await p.evaluate(async () => {
    const s = window.__venueScene;
    s.scenes.load('home', null, true);
    await new Promise(r => setTimeout(r, 900));
  });
  await new Promise(r => setTimeout(r, 800));
  await p.keyboard.down(key);
  await new Promise(r => setTimeout(r, 450));
  const pos = await p.evaluate(() => {
    const s = window.__venueScene, cam = s.cameras.main;
    return { sx: (s.player.x - cam.worldView.x) * cam.zoom, sy: (s.player.y - cam.worldView.y) * cam.zoom };
  });
  const fn = path.join(OUT, `_cmp_${tag}_${dir}.png`);
  await p.screenshot({
    path: fn,
    clip: {
      x: Math.max(0, Math.min(1280 - 200, Math.round(pos.sx - 100))),
      y: Math.max(0, Math.min(720 - 240, Math.round(pos.sy - 200))),
      width: 200, height: 240,
    },
  });
  shots.push(fn);
  await p.keyboard.up(key);
  await new Promise(r => setTimeout(r, 200));
}

const info = await p.evaluate(() => {
  const s = window.__venueScene;
  return { frame: [s.playerInfo.frameWidth, s.playerInfo.frameHeight] };
});
console.log(`${tag} 每帧: ${info.frame.join('x')}`);
console.log(shots.join('\n'));
await b.close();

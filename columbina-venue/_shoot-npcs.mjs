// 客人 NPC 站位截图核查
//
// 目标（对应需求 2）：
//   NPC 站在哥伦比娅【走不到】的格子上，但玩家能贴到旁边挨着站 ——
//   所以既要有全景（看清 13 位的分布），也要有「玩家贴着 NPC 站」的近景，
//   证明两个立绘不重叠。
//
// 做法：直接把存档改成「11 封都写好并且已投递」，
//       客人就会全部出现在会场。

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

// ---------- 让 13 位客人全部到场 ----------
const info = await p.evaluate(async () => {
  const s = window.__venueScene;
  const GUESTS = (await import('/src/StorySystem.js')).GUESTS;
  s.story.data.lettersWritten = GUESTS.map((g) => g.id);
  s.story.data.onDesk = 0;
  s.story.data.carried = 0;
  s.story.data.delivered = true;
  s.story.save();
  s.scenes.load('venue', null, true);
  await new Promise((r) => setTimeout(r, 2600));
  return {
    count: s.npcs.length,
    npcs: s.npcs.map((n) => ({
      name: n.name,
      tile: [Math.floor(n.x / 64), Math.floor(n.y / 64)],
      mode: n.info ? n.info.mode : '?',
    })),
  };
});
console.log(`到场客人 ${info.count} 位`);
for (const n of info.npcs) console.log(`  ${n.name.padEnd(6)} tile=[${n.tile}] mode=${n.mode}`);

/** 把相机放到某个世界坐标上（先停掉跟随，免得被 player 拖回去） */
async function look(worldX, worldY, zoom, file, playerTile) {
  await p.evaluate(async (wx, wy, z, pt) => {
    const s = window.__venueScene;
    const cam = s.cameras.main;
    cam.stopFollow();
    cam.setZoom(z);
    cam.centerOn(wx, wy);
    if (pt) {
      s.player.setPosition(pt[0] * 64 + 32, pt[1] * 64 + 32);
    }
  }, worldX, worldY, zoom, file, playerTile || null);
  await new Promise((r) => setTimeout(r, 900));
  await p.screenshot({ path: file });
  console.log('  截图 ' + file);
}

// 1) 全景：zoom 0.5 刚好铺满整张 2560x1536 的会场
await look(1280, 768, 0.5, '_npc_overview.png');

// 2) 玩家贴着 NPC 站的近景（证明「能挨在一起但不重叠」）
//
//    每个客人的坐标都是禁行格，所以玩家只能站在它【旁边的可走格】上。
//    这里自动找一格紧邻的可走格把主角放过去，然后让相机跟住主角 ——
//    画面上主角在正中、客人就在旁边一格（64px）处，重叠与否一眼就能看出来。
const closeups = await p.evaluate(async () => {
  const s = window.__venueScene;
  const m = s.scenes.getMap('venue');
  const out = [];
  for (const n of s.npcs) {
    const tx = Math.floor(n.x / 64), ty = Math.floor(n.y / 64);
    const cand = [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]]
      .filter(([x, y]) => m[y] && m[y][x] === '.');
    if (!cand.length) { out.push({ name: n.name, skip: true }); continue; }
    // 优先选「同 y 的左右邻格」：两人脚踩在同一条横线上，肩并肩站着，
    // 到底有没有叠在一起最容易判断；左右都没位置才退而求其次站上下。
    const pick = cand.find(([x, y]) => y === ty) || cand[0];
    out.push({ name: n.name, npc: [tx, ty], player: pick });
  }
  return out;
});

for (const c of closeups) {
  if (c.skip) { console.log(`  跳过 ${c.name}（没有相邻可走格）`); continue; }
  const file = `_npc_close_${c.npc[0]}_${c.npc[1]}.png`;
  await p.evaluate(async (pt) => {
    const s = window.__venueScene;
    const cam = s.cameras.main;
    s.player.setPosition(pt[0] * 64 + 32, pt[1] * 64 + 32);
    cam.setZoom(1.0);
    cam.startFollow(s.player, true, 1, 1);
    cam.centerOn(s.player.x, s.player.y);
  }, c.player);
  await new Promise((r) => setTimeout(r, 700));
  await p.screenshot({ path: file });
  console.log(`  截图 ${file}  ${c.name}(${c.npc}) ← 主角(${c.player})`);
}

console.log('\n运行时报错:', errs.length ? [...new Set(errs)].slice(0, 5).join('\n') : '无');
await b.close();

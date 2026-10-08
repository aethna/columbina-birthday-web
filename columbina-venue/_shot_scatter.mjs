// 把「NPC 分散到各场景 + 模型占格」的真实运行数据导成 JSON，
// 供 _npc_scatter.py 画验收图。（必须在 venue/ 目录下跑）
//
//   node _shot_scatter.mjs
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 300000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await sleep(6500);

const data = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { NPCS } = await import('/src/config.js');
  // 客人到场
  s.story.data.lettersWritten = s.story.snapshot().letters.map((l) => l.id);
  s.story.data.delivered = true;
  s.story.save();

  const sceneIds = [...new Set(NPCS.map((n) => n.scene || 'venue'))];
  const out = [];
  for (const sid of sceneIds) {
    s.scenes.load(sid, null, true);
    await new Promise((r) => setTimeout(r, 900));
    const cfg = s.scenes.current;
    const map = s.scenes.getMap(sid);
    const npcs = s.npcs.map((n) => ({
      id: n.id, name: n.name, x: n.x, y: n.y,
      tile: [Math.floor(n.x / 64), Math.floor(n.y / 64)],
      rect: n.rect ? [n.rect.left, n.rect.top, n.rect.right, n.rect.bottom].map(Math.round) : null,
      rectSize: n.rect ? [Math.round(n.rect.w), Math.round(n.rect.h)] : null,
      tiles: n.rect ? s.tileRectOf(n.rect) : null,
      guest: !!n.def?.guest,
    }));
    // 只导出「被 NPC 占掉」的格子（人物 3×3）
    const npcCells = [];
    npcs.forEach((n) => {
      if (!n.tiles) return;
      for (let ty = n.tiles[1]; ty <= n.tiles[3]; ty++) {
        for (let tx = n.tiles[0]; tx <= n.tiles[2]; tx++) npcCells.push([tx, ty, n.id]);
      }
    });
    out.push({ scene: sid, name: cfg.name, map, npcs, npcCells, spawn: cfg.spawn, exits: cfg.exits });
  }
  return out;
});

fs.writeFileSync('_npc_scatter.json', JSON.stringify(data, null, 1), 'utf8');
console.log('场景数', data.length);
data.forEach((d) => console.log(` ${d.scene.padEnd(9)} ${d.name}  NPC ${d.npcs.length}  占格 ${d.npcCells.length}`));
await b.close();

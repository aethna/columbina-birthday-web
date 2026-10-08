// 逐个站姿 NPC 来一张实拍特写（相机停在人物身上），存到 _shots\ 里。
// 用来肉眼确认「她站在这个位置、没有被塞进树里」。
//
//   node _shot_npc_scenes.mjs
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会\\venue\\_shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 300000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await sleep(6500);

// 把客人全推到场，并关掉任务面板（免得挡住画面）
await p.evaluate(async () => {
  const s = window.__venueScene;
  s.story.data.lettersWritten = s.story.snapshot().letters.map((l) => l.id);
  s.story.data.delivered = true;
  s.story.save();
});
await sleep(600);
await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /收起任务列表/.test(b.textContent));
  if (btn) btn.click();
});
await sleep(400);

const plan = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { NPCS } = await import('/src/config.js');
  return NPCS.map((n) => ({ id: n.id, name: n.name, scene: n.scene || 'venue' }));
});

let i = 0;
for (const n of plan) {
  // 相机贴到人物身上；注意地图边缘会被 setBounds 卡住，
  // 所以不能假设人就一定在屏幕正中 —— 要从 worldView 反算她的屏幕坐标。
  const pos = await p.evaluate(async (sceneId, npcId) => {
    const s = window.__venueScene;
    if (s.scenes.current.id !== sceneId) {
      s.scenes.load(sceneId, null, true);
      await new Promise((r) => setTimeout(r, 1100));
    }
    const npc = s.npcs.find((x) => x.id === npcId);
    const cam = s.cameras.main;
    cam.stopFollow();
    cam.setZoom(1);
    if (npc) cam.centerOn(npc.x, npc.y + 20);
    await new Promise((r) => setTimeout(r, 120));
    const wv = cam.worldView;
    return npc
      ? { sx: (npc.x - wv.x) * cam.zoom, sy: (npc.y - wv.y) * cam.zoom }
      : { sx: 640, sy: 360 };
  }, n.scene, n.id);

  await sleep(650);
  const CW = 500, CH = 380;
  const cx = Math.max(0, Math.min(1280 - CW, Math.round(pos.sx - CW / 2)));
  const cy = Math.max(0, Math.min(720 - CH, Math.round(pos.sy - CH * 0.62)));
  const file = `${OUT}\\${String(++i).padStart(2, '0')}-${n.id.replace('npc-', '')}.png`;
  await p.screenshot({ path: file, clip: { x: cx, y: cy, width: CW, height: CH } });
  console.log(`${n.scene.padEnd(9)} ${n.name}  screen(${Math.round(pos.sx)},${Math.round(pos.sy)}) -> ${file.split('\\').pop()}`);
}

// 顺手把 8 张场景底图也各来一张全屏的（不带 UI），当交付素材
await b.close();
console.log('done');

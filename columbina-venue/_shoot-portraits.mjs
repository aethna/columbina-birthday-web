// 逐个 NPC 触发对话，截取对话框头像，拼成对比图
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

// 让主线走完，NPC 才会到场
await p.evaluate(async () => {
  const s = window.__venueScene;
  s.story.data.lettersWritten = ['npc-ainuo','npc-nefer','npc-philins','npc-sandrone','npc-lawuma'];
  s.story.data.delivered = true;
  s.story.notify('deliver');
  await new Promise(r => setTimeout(r, 500));
  s.scenes.load('venue', null, true);
  await new Promise(r => setTimeout(r, 2000));
});
await new Promise(r => setTimeout(r, 1500));

const info = await p.evaluate(() => {
  const s = window.__venueScene;
  return { npcs: (s.npcs || []).map(n => ({ id: n.id, name: n.name, x: n.x, y: n.y })) };
});
console.log('到场 NPC:', JSON.stringify(info.npcs.map(n => n.name)));

const shots = [];
for (const id of ['npc-ainuo', 'npc-nefer', 'npc-philins', 'npc-sandrone', 'npc-lawuma']) {
  const ok = await p.evaluate(async (npcId) => {
    const s = window.__venueScene;
    const npc = (s.npcs || []).find(n => n.id === npcId);
    if (!npc) return false;
    // 直接把对话打开（跳过走过去的过程）
    s.dialog.open({ name: npc.name, icon: npc.icon, portrait: npc.portrait,
                    portraitBg: npc.portraitBg }, [{ text: '……' }]);
    await new Promise(r => setTimeout(r, 700));
    return true;
  }, id);
  if (!ok) { console.log('跳过', id); continue; }

  const el = await p.$('#dialog-portrait');
  const fn = `${OUT}\\_dlg_${id}.png`;
  if (el) await el.screenshot({ path: fn });
  else await p.screenshot({ path: fn, clip: { x: 0, y: 380, width: 320, height: 340 } });
  shots.push({ id, fn });

  // 顺便把头像 DOM 的实际样式与尺寸也报出来（判断"显示不一致"的依据）
  const domInfo = await p.evaluate(() => {
    const el = document.getElementById('dialog-portrait');
    const img = el ? el.querySelector('img') : null;
    const r = el ? el.getBoundingClientRect() : null;
    const ir = img ? img.getBoundingClientRect() : null;
    return {
      hasImg: !!img,
      src: img ? img.getAttribute('src') : null,
      boxW: r ? Math.round(r.width) : null, boxH: r ? Math.round(r.height) : null,
      imgW: ir ? Math.round(ir.width) : null, imgH: ir ? Math.round(ir.height) : null,
      text: el ? el.textContent.trim().slice(0, 20) : null,
    };
  });
  console.log(`${id.padEnd(14)} img=${domInfo.hasImg} box=${domInfo.boxW}x${domInfo.boxH} img=${domInfo.imgW}x${domInfo.imgH} text="${domInfo.text}" src=${domInfo.src}`);

  await p.evaluate(() => window.__venueScene.dialog.close());
  await new Promise(r => setTimeout(r, 300));
}

console.log('\n截图:');
shots.forEach(s => console.log('  ' + s.fn));
await b.close();

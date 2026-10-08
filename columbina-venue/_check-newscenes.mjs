// 验收：5 个新场景（月面）能进、能走、光圈互相连通
// 用法：在 venue/ 目录下 node _check-newscenes.mjs
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会';
const NEW = ['icefield', 'pools', 'moonpath', 'starship', 'shallows'];
const NAMES = { icefield: '冰原遗迹', pools: '月面彩池', moonpath: '月面夜路', starship: '星船草甸', shallows: '青水浅滩' };
// 环：venue → icefield → pools → moonpath → starship → shallows → pond → grove → home → mailbox → venue
const RING = ['venue', 'icefield', 'pools', 'moonpath', 'starship', 'shallows', 'pond', 'grove', 'home', 'mailbox', 'venue'];

const lines = [];
const errs = [];
const ok = (c, m) => { lines.push(`${c ? '✅' : '❌'} ${m}`); if (!c) errs.push(m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const pageErrs = [];
page.on('pageerror', (e) => pageErrs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrs.push('[console] ' + m.text()); });

await page.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle2' });
await wait(7000);

// ---------- 1. 每个新场景：进得去、可走格数、背景贴图加载成功 ----------
const hasEntry = await page.evaluate(() => !!window.__venueScene);
ok(hasEntry, 'window.__venueScene 已挂载');
if (!hasEntry) {
  await browser.close();
  throw new Error('window.__venueScene 不存在，后面的验收全部无法进行');
}

for (const id of NEW) {
  const r = await page.evaluate(async (sid) => {
    const s = window.__venueScene;
    s.scenes.load(sid, null, true);
    await new Promise((r) => setTimeout(r, 400));
    const g = s.scenes.getMap(sid);
    let walk = 0;
    for (let y = 0; y < g.length; y++) for (let x = 0; x < g[y].length; x++) if (g[y][x] === '.') walk++;
    const px = s.player.x, py = s.player.y;
    const tx = Math.round((px - 32) / 64), ty = Math.round((py - 32) / 64);
    const key = `scene-bg-${sid}`;
    const has = s.textures.exists(key);
    const tex = has ? s.textures.get(key).getSourceImage() : null;
    return {
      scene: s.scenes.current.id, walk, px, py, tx, ty,
      onWalkable: g[ty] && g[ty][tx] === '.',
      texOk: has && !!tex && tex.width === 2560 && tex.height === 1536,
      texSize: tex ? `${tex.width}x${tex.height}` : 'n/a',
      exits: (s.scenes.exits || []).length,
    };
  }, id);
  ok(r.scene === id, `${id}(${NAMES[id]}) 场景加载成功`);
  ok(r.texOk, `${id} 背景贴图 2560x1536 加载成功（实测 ${r.texSize}）`);
  ok(r.onWalkable, `${id} 出生点 (${r.tx},${r.ty}) 在可走格上`);
  ok(r.exits === 2, `${id} 光圈数 = 2（实测 ${r.exits}）`);
  lines.push(`   ${id} 可走 ${r.walk} 格  出生像素(${r.px},${r.py})`);

  // 截图：正常视图 + F2 全图 + F1 可走区
  await page.screenshot({ path: `${OUT}\\venue\\_new_${id}_play.png` });
  await page.keyboard.press('F2');
  await wait(400);
  await page.screenshot({ path: `${OUT}\\venue\\_new_${id}_map.png` });
  await page.keyboard.press('F2');
  await wait(250);
  await page.keyboard.press('F1');
  await wait(400);
  await page.screenshot({ path: `${OUT}\\venue\\_new_${id}_walk.png` });
  await page.keyboard.press('F1');
  await wait(250);
}

// ---------- 2. 走一整圈：踩光圈 → 换场景 → 落点必须可走 ----------
lines.push('');
lines.push('—— 环形传送 ——');
await page.evaluate(async () => { window.__venueScene.scenes.load('venue', null, true); });
await wait(600);

for (let i = 0; i < RING.length - 1; i++) {
  const from = RING[i], to = RING[i + 1];
  const r = await page.evaluate(async (to) => {
    const s = window.__venueScene;
    const cur = s.scenes.current.id;
    const ex = (s.scenes.exits || []).find((e) => e.to === to);
    if (!ex) return { err: `从 ${cur} 找不到通往 ${to} 的光圈` };
    // 站到光圈正中心，等 update 循环检测
    s.player.setPosition(ex.portalX, ex.portalY);
    s.player.setVelocity(0, 0);
    await new Promise((r) => setTimeout(r, 1000));
    const g = s.scenes.getMap(s.scenes.current.id);
    const tx = Math.round((s.player.x - 32) / 64), ty = Math.round((s.player.y - 32) / 64);
    return {
      from: cur, scene: s.scenes.current.id, tx, ty,
      onWalkable: !!(g[ty] && g[ty][tx] === '.'),
      px: s.player.x, py: s.player.y,
      visible: s.player.visible,
    };
  }, to);
  if (r.err) { ok(false, r.err); break; }
  ok(r.scene === to && r.onWalkable && r.visible,
    `${r.from} → ${to}：到达 ${r.scene}，落点(${r.tx},${r.ty}) ${r.onWalkable ? '可走' : '★是墙'}，角色可见=${r.visible}`);
}

// ---------- 3. 反过来再走一圈（验证双向） ----------
lines.push('');
lines.push('—— 反向环形传送 ——');
const RING2 = [...RING].reverse().slice(RING.length - 2); // 从当前位置走回去
for (let i = 0; i < RING.length - 1; i++) {
  const from = RING[RING.length - 1 - i], to = RING[RING.length - 2 - i];
  const r = await page.evaluate(async (to) => {
    const s = window.__venueScene;
    const cur = s.scenes.current.id;
    const ex = (s.scenes.exits || []).find((e) => e.to === to);
    if (!ex) return { err: `从 ${cur} 找不到通往 ${to} 的光圈` };
    s.player.setPosition(ex.portalX, ex.portalY);
    s.player.setVelocity(0, 0);
    await new Promise((r) => setTimeout(r, 1000));
    const g = s.scenes.getMap(s.scenes.current.id);
    const tx = Math.round((s.player.x - 32) / 64), ty = Math.round((s.player.y - 32) / 64);
    return { from: cur, scene: s.scenes.current.id, tx, ty, onWalkable: !!(g[ty] && g[ty][tx] === '.') };
  }, to);
  if (r.err) { ok(false, r.err); break; }
  ok(r.scene === to && r.onWalkable, `${r.from} → ${to}：到达 ${r.scene}，落点(${r.tx},${r.ty}) ${r.onWalkable ? '可走' : '★是墙'}`);
}

// ---------- 4. 小地图 ----------
await page.evaluate(() => { window.__venueScene.scenes.load('venue', null, true); });
await wait(500);
// Phaser 用 JustDown 采样，press() 太快会漏掉，要按住一会儿
await page.keyboard.down('M');
await wait(250);
await page.keyboard.up('M');
await wait(700);
await page.screenshot({ path: `${OUT}\\venue\\_new_minimap.png` });
const mm = await page.evaluate(() => {
  const s = window.__venueScene;
  const on = s.minimap ? s.minimap.visible : false;
  if (!on && s.minimap) { s.minimap.toggle(); }
  return { has: !!s.minimap, visible: on };
});
ok(mm.has, '小地图对象存在');
ok(mm.visible, '按 M 能打开世界地图（截图 _new_minimap.png）');
if (!mm.visible) {
  await wait(600);
  await page.screenshot({ path: `${OUT}\\venue\\_new_minimap_forced.png` });
  lines.push('   （M 没打开，已用 toggle() 强制打开，见 _new_minimap_forced.png）');
}

await browser.close();

lines.push('');
lines.push(`运行时报错：${pageErrs.length ? pageErrs.length : '无'}`);
if (pageErrs.length) pageErrs.slice(0, 8).forEach((e) => lines.push('  ! ' + e));
lines.push(`总断言：${errs.length ? `❌ ${errs.length} 项失败` : '✅ 全部通过'}`);
fs.writeFileSync(`${OUT}\\_newscenes_report.txt`, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));

// 空（旅行者·男主）+ 派蒙 进场截图核查
//
// 目标：
//   ① 新档（谁都没邀请）进会场时，空和派蒙【已经在场】—— 他不是受邀客人；
//   ② 13 位客人到场之后，空仍然在场（不重复、不被顶掉）；
//   ③ 空站在 (19,5) 的禁行格上，玩家能贴到旁边的可走格挨着他站；
//   ④ 派蒙飘在他脑袋左上，不和他重叠。

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

const log = (s) => console.log(s);
const say = (s) => log('  ' + s);

await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 3500));

// ---------- ① 全新存档 ----------
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 7000));

const fresh = await p.evaluate(async () => {
  const s = window.__venueScene;
  s.scenes.load('venue', null, true);
  await new Promise((r) => setTimeout(r, 2600));
  return {
    total: s.npcs.length,
    names: s.npcs.map((n) => n.name),
    aether: s.npcs.filter((n) => n.def && n.def.id === 'npc-aether').map((n) => ({
      tile: [Math.floor(n.x / 64), Math.floor(n.y / 64)],
      w: n.sprite ? Math.round(n.sprite.displayWidth) : null,
      h: n.sprite ? Math.round(n.sprite.displayHeight) : null,
    })),
  };
});
log('=== ① 新档（主线未推进） ===');
say(`场景里共 ${fresh.total} 个角色：${fresh.names.join('、')}`);
say(`空：${JSON.stringify(fresh.aether)}`);

await p.evaluate(async () => {
  const s = window.__venueScene;
  const cam = s.cameras.main;
  cam.stopFollow();
  cam.setZoom(0.5);
  cam.centerOn(1280, 768);
});
await new Promise((r) => setTimeout(r, 900));
await p.screenshot({ path: '_aether_fresh_overview.png' });
say('截图 _aether_fresh_overview.png');

// 空身边的近景
await p.evaluate(async () => {
  const s = window.__venueScene;
  const cam = s.cameras.main;
  s.player.setPosition(20 * 64 + 32, 7 * 64 + 32); // (20,7) 是可走格，挨着 (19,5)
  cam.setZoom(1.0);
  cam.startFollow(s.player, true, 1, 1);
  cam.centerOn(s.player.x, s.player.y);
});
await new Promise((r) => setTimeout(r, 800));
await p.screenshot({ path: '_aether_fresh_closeup.png' });
say('截图 _aether_fresh_closeup.png');

// ---------- ② 13 位客人全到场 ----------
await p.evaluate(async () => {
  const s = window.__venueScene;
  const GUESTS = (await import('/src/StorySystem.js')).GUESTS;
  s.story.data.lettersWritten = GUESTS.map((g) => g.id);
  s.story.data.onDesk = 0;
  s.story.data.carried = 0;
  s.story.data.delivered = true;
  s.story.save();
  s.scenes.load('venue', null, true);
  await new Promise((r) => setTimeout(r, 2600));
});
await new Promise((r) => setTimeout(r, 1200));

const full = await p.evaluate(() => {
  const s = window.__venueScene;
  const guests = s.npcs.filter((n) => n.def && n.def.guest);
  const others = s.npcs.filter((n) => !(n.def && n.def.guest));
  return {
    total: s.npcs.length,
    guests: guests.length,
    others: others.map((n) => ({ name: n.name, tile: [Math.floor(n.x / 64), Math.floor(n.y / 64)] })),
  };
});
log('=== ② 13 位客人全部到场之后 ===');
say(`角色总数 ${full.total}（客人 ${full.guests} + 伙伴 ${full.others.length}）`);
say(`伙伴：${JSON.stringify(full.others)}`);

await p.evaluate(async () => {
  const s = window.__venueScene;
  const cam = s.cameras.main;
  cam.stopFollow();
  cam.setZoom(0.5);
  cam.centerOn(1280, 768);
});
await new Promise((r) => setTimeout(r, 900));
await p.screenshot({ path: '_aether_full_overview.png' });
say('截图 _aether_full_overview.png');

log('\n运行时报错: ' + (errs.length ? [...new Set(errs)].slice(0, 5).join('\n') : '无'));
await b.close();

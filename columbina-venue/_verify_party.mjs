// 庆功宴验收：所有委托完成 → NPC 消失、围桌坐、哥伦比娅站主位、禁行格生效
import puppeteer from 'puppeteer';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会\\venue';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await sleep(6500);

const fail = [];
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) fail.push(msg); };

// ---- 1. 进会场，确认「没开庆功宴」时是普通形态 -------------------------------
const before = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { NPCS } = await import('/src/config.js');
  // ★ v7（§二十八）起客人分散到 8 个场景，先把邀请函流程推完让客人到场，
  //   否则会场里一个 NPC 都没有（那才是「还没入场」的正常状态）。
  s.story.data.lettersWritten = s.story.snapshot().letters.map((l) => l.id);
  s.story.data.delivered = true;
  s.story.save();
  s.scenes.load('venue', { tileX: 20, tileY: 18 }, true);
  await new Promise((r) => setTimeout(r, 2000));
  return {
    party: s.party,
    npcs: s.npcs.length,
    expectNpcs: NPCS.filter((n) => (n.scene || 'venue') === 'venue' && n.guest).length,
    partyObjs: (s.partyObjs || []).length,
  };
});
console.log('普通形态:', JSON.stringify(before));
ok(before.party === false, '未完成委托时不开庆功宴');
ok(before.npcs > 0 && before.npcs === before.expectNpcs,
   `普通形态会场站着 ${before.npcs} 位客人（配置里 ${before.expectNpcs} 位，其余分散在别的场景）`);
ok(before.partyObjs === 0, '普通形态没有庆祝贴图');
await p.screenshot({ path: `${OUT}\\_party_before.png` });

// ---- 2. 把全部委托置为 completed，触发庆功宴 ---------------------------------
const after = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { QUESTS } = await import('/src/quests.js');
  QUESTS.forEach((q) => { s.quests.data.states[q.id] = 'completed'; });
  s.quests.save();
  const started = s.maybeStartParty();
  await new Promise((r) => setTimeout(r, 1500));

  const texKeys = (s.partyObjs || []).map((o) => (o.texture ? o.texture.key : 'ellipse'));

  // 禁行检查（2026-10-08 新几何）：
  //   主位在第 9 行（世界 y 608），桌子禁行第 8~15 行，但第 8~9 行的 col19
  //   是专门挖出来的「主位口袋」。
  //   (a) 向下推 → 必须被第 10 行的桌子拦住，走不进桌子底下；
  //   (b) 向上推 → 必须能走出第 8 行回到第 7 行空地（没把人困死）；
  //   (c) 再向右走 → 证明挡板只挡桌子本身，没把整片空地封死。
  s.placeHeroAtPartySpot();
  await new Promise((r) => setTimeout(r, 120));
  const heroTile = {
    x: Math.floor(s.player.x / 64),
    y: Math.floor(s.player.y / 64),
  };

  for (let i = 0; i < 120; i++) {
    s.player.setVelocity(0, 260);
    await new Promise((r) => requestAnimationFrame(r));
  }
  s.player.setVelocity(0, 0);
  const yd1 = s.player.y;

  s.placeHeroAtPartySpot();
  await new Promise((r) => setTimeout(r, 120));
  for (let i = 0; i < 120; i++) {
    s.player.setVelocity(0, -260);
    await new Promise((r) => requestAnimationFrame(r));
  }
  s.player.setVelocity(0, 0);
  const yu1 = s.player.y;

  for (let i = 0; i < 260; i++) {
    s.player.setVelocity(280, 0);
    await new Promise((r) => requestAnimationFrame(r));
  }
  s.player.setVelocity(0, 0);
  const xr = s.player.x;

  // (d) 绕到桌子南侧：图层必须换回「画在桌子前面」，否则桌子会反过来盖住她
  s.player.setPosition(1280, 1100);
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
  const depthSouth = s.player.depth;
  const shadowSouth = s.playerShadow.depth;
  s.placeHeroAtPartySpot();
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
  const depthNorth = s.player.depth;

  return {
    started,
    party: s.party,
    npcs: s.npcs.length,
    partyObjs: (s.partyObjs || []).length,
    texKeys,
    heroDepth: s.player.depth,
    shadowDepth: s.playerShadow.depth,
    depthSouth: Math.round(depthSouth),
    shadowSouth: Math.round(shadowSouth),
    depthNorth: Math.round(depthNorth),
    playerTile: heroTile,
    yd1: Math.round(yd1),
    yu1: Math.round(yu1),
    xr: Math.round(xr),
  };
});
console.log('庆功宴形态:', JSON.stringify({ ...after, texKeys: undefined }, null, 0));
ok(after.party === true, '委托全完成后 party = true');
ok(after.npcs === 0, `庆祝态下站着的 NPC 全部消失（${after.npcs}）`);
// 第八轮给坐姿 NPC 加了头顶图标 + 名牌，庆祝贴图由 29 涨到 57
const PARTY_OBJS = 1 + 14 * 4;
ok(after.partyObjs === PARTY_OBJS,
   `庆祝贴图数 = 桌子1 + 坐姿14 + 影子14 + 图标14 + 名牌14 = ${PARTY_OBJS}（实际 ${after.partyObjs}）`);
ok(after.playerTile.x === 19 && after.playerTile.y === 9,
   `主位落在 (${after.playerTile.x},${after.playerTile.y})，期望 (19,9) 桑多涅与旅行者之间`);
ok(after.heroDepth === 430, `主位图层 depth=${after.heroDepth}（远排 400 < 430 < 桌子 450 → 下半身被桌子挡住）`);
ok(after.shadowDepth === 425, `主位影子 depth=${after.shadowDepth}（压在桌子 450 下方，桌面上不会糊黑椭圆）`);
ok(after.yd1 < 645, `向下被桌子拦住，只走到 y=${after.yd1}（第 10 行桌沿 640）`);
ok(after.yu1 < 512,
   `向上能走出主位口袋回到空地，走到 y=${after.yu1}（第 7 行空地 ≤511）`);
ok(after.xr > 1500, `她还能在空地里一路向右（x → ${after.xr}），空地没被封死`);
ok(after.depthSouth > 460,
   `绕到桌子南侧后图层换回前面（depth ${after.depthSouth} > 近排 460），桌子不会盖住她`);
ok(after.shadowSouth === 499, `南侧影子回到 ${after.shadowSouth}`);
ok(after.depthNorth === 430, `回主位后又变回 ${after.depthNorth}（被桌子挡住）`);
await sleep(600);
await p.screenshot({ path: `${OUT}\\_party_after.png` });

// ---- 3. 切场景往返：庆祝态要留着，相机取景要跟着场景走 --------------------
const round = await p.evaluate(async () => {
  const s = window.__venueScene;
  const off1 = s.cameras.main.followOffset.y;
  s.scenes.load('icefield', null, true);
  await new Promise((r) => setTimeout(r, 1200));
  const offField = s.cameras.main.followOffset.y;
  const objsField = (s.partyObjs || []).length;
  s.scenes.load('venue', { tileX: 20, tileY: 20 }, true);
  await new Promise((r) => setTimeout(r, 1200));
  return {
    off1, offField, objsField,
    offBack: s.cameras.main.followOffset.y,
    objsBack: (s.partyObjs || []).length,
    npcsBack: s.npcs.length,
    party: s.party,
  };
});
console.log('场景往返:', JSON.stringify(round));
ok(round.off1 === -96, '会场里相机取景偏移 = -96（视野中心落到桌子中心 y≈704）');
ok(round.offField === 0, `离开会场后取景偏移复位（${round.offField}）`);
ok(round.objsField === 0, `别的场景里没有庆祝贴图（${round.objsField}）`);
ok(round.offBack === -96, '回到会场取景偏移恢复 = -96');
ok(round.objsBack === PARTY_OBJS && round.npcsBack === 0,
   `回到会场仍是庆祝态（${PARTY_OBJS} 张贴图 / 0 站立 NPC，实际 ${round.objsBack}）`);

// ---- 4. 全图视图（一屏看完）-------------------------------------------------
await p.evaluate(async () => {
  const s = window.__venueScene;
  if (s.toggleFullMap) s.toggleFullMap();
  await new Promise((r) => setTimeout(r, 900));
});
await sleep(900);
await p.screenshot({ path: `${OUT}\\_party_fullmap.png` });
console.log('截图: _party_before.png / _party_after.png / _party_fullmap.png');

console.log(fail.length ? `\n❌ ${fail.length} 项未通过` : '\n✅ 全部通过');
await b.close();
process.exit(fail.length ? 1 : 0);

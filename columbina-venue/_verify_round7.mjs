// 第七轮验收（用户 m08755 的任务 1 / 2 / 3 / 4）
//
//   任务1  站姿 NPC 分散到各场景，且「模型长宽所占的所有格子」都是主角禁行区；
//          委托 NPC 所在地图 ≠ 委托物品所在地图
//   任务2  所有委托完成后，任务列表刷新出新任务「切蛋糕」，
//          互动点在旅行者与桑多涅之间（哥伦比娅主位）
//   任务3  所有互动点图层 = 地图之上、哥伦比娅之下
//   任务4  接委托时所有 NPC 多出「合影」选项，点了全屏展示合影
//
// 跑法（必须在 venue/ 目录下）：
//   node _verify_round7.mjs
import puppeteer from 'puppeteer';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会\\venue';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 300000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await sleep(6500);

const fail = [];
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) fail.push(msg); };

// ===========================================================================
// 任务3 —— 互动点图层：地图之上、哥伦比娅之下
// ===========================================================================
const t3a = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { INTERACT_ICON_DEPTH } = await import('/src/InteractPoints.js');
  const out = {};
  for (const sid of ['home', 'mailbox', 'pond', 'grove', 'venue']) {
    s.scenes.load(sid, null, true);
    await new Promise((r) => setTimeout(r, 900));
    out[sid] = s.interactPoints.points.map((pt) => ({
      id: pt.id,
      marker: pt.marker ? pt.marker.depth : null,
      icon: pt.icon ? pt.icon.depth : null,
      label: pt.labelObj ? pt.labelObj.depth : null,
    }));
  }
  return { out, mod: INTERACT_ICON_DEPTH, playerDepth: s.player.depth };
});
console.log('\n===== 任务3：互动点图层（地图 < 互动点 < 哥伦比娅）=====');
for (const [sid, arr] of Object.entries(t3a.out)) {
  console.log(`  ${sid.padEnd(9)} ${arr.map((o) => `${o.id}(m${o.marker}/i${o.icon}/l${o.label})`).join(' ') || '无道具点'}`);
}
const allPts = Object.values(t3a.out).flat();
ok(allPts.length >= 7, `全部场景共 ${allPts.length} 个互动点`);
ok(allPts.every((o) => o.icon === t3a.mod && o.label === t3a.mod),
   `图标/文字 depth 全部 = INTERACT_ICON_DEPTH(${t3a.mod})，在地图(0)之上、哥伦比娅(${Math.round(t3a.playerDepth)})之下`);
ok(allPts.every((o) => o.marker <= 2), '光圈 depth ≤ 2，贴在地面上');

// ===========================================================================
// 任务1 —— 客人到场后，NPC 模型占格必须是禁行区
// ===========================================================================
const t1 = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { NPCS } = await import('/src/config.js');

  // 把剧情推到「邀请函全写完并已投递」—— 受邀客人这时才出现
  s.story.data.lettersWritten = s.story.snapshot().letters.map((l) => l.id);
  s.story.data.delivered = true;
  s.story.save();

  const report = [];
  const sceneIds = [...new Set(NPCS.map((n) => n.scene || 'venue'))];

  for (const sid of sceneIds) {
    s.scenes.load(sid, null, true);
    await new Promise((r) => setTimeout(r, 900));

    const here = NPCS.filter((n) => (n.scene || 'venue') === sid);
    const items = [];

    for (const n of here) {
      const npc = s.npcs.find((x) => x.id === n.id);
      if (!npc) { items.push({ id: n.id, missing: true }); continue; }

      const r = npc.rect;
      const t = s.tileRectOf(r);

      // (a) 模型占的每一格都要被判为禁行
      let blockedAll = true;
      let blockedCells = 0;
      for (let ty = t[1]; ty <= t[3]; ty++) {
        for (let tx = t[0]; tx <= t[2]; tx++) {
          if (s.scenes.isBlockedAt(sid, tx, ty)) blockedCells++;
          else blockedAll = false;
        }
      }

      // (b) 物理：从旁边一个可走格朝她推过去，人不能进到模型盒子里
      const map = s.scenes.getMap(sid);
      const cx = Math.floor(r.x / 64), cy = Math.floor(r.y / 64);
      let stand = null;
      for (let rad = 2; rad <= 6 && !stand; rad++) {
        for (let dy = -rad; dy <= rad && !stand; dy++) {
          for (let dx = -rad; dx <= rad && !stand; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
            const tx = cx + dx, ty = cy + dy;
            const row = map[ty];
            if (!row || row[tx] !== '.') continue;
            if (s.scenes.isBlockedAt(sid, tx, ty)) continue;
            stand = { tx, ty };
          }
        }
      }

      let entered = null;
      let moved = 0;
      if (stand) {
        s.player.setPosition(stand.tx * 64 + 32, stand.ty * 64 + 32);
        s.player.setVelocity(0, 0);
        for (let i = 0; i < 8; i++) await new Promise((rr) => requestAnimationFrame(rr));
        const sx = s.player.x, sy = s.player.y;

        let vx = r.x - sx, vy = r.y - sy;
        const len = Math.hypot(vx, vy) || 1;
        vx = (vx / len) * 300; vy = (vy / len) * 300;

        for (let i = 0; i < 120; i++) {
          s.player.setVelocity(vx, vy);
          await new Promise((rr) => requestAnimationFrame(rr));
          const px = s.player.x, py = s.player.y;
          if (px > r.left && px < r.right && py > r.top && py < r.bottom) {
            entered = { px: Math.round(px), py: Math.round(py) };
            break;
          }
        }
        s.player.setVelocity(0, 0);
        moved = Math.round(Math.hypot(s.player.x - sx, s.player.y - sy));
      }

      items.push({
        id: n.id, guest: !!n.guest, tile: [n.tileX, n.tileY],
        rect: Math.round(r.w) + 'x' + Math.round(r.h), tiles: t,
        blockedAll, blockedCells,
        stand: stand ? [stand.tx, stand.ty] : null, entered, moved,
      });
    }
    report.push({ scene: sid, items });
  }
  return report;
});

console.log('\n===== 任务1：站姿 NPC 模型占格 -> 禁行区 =====');
let npcCount = 0, badBlock = 0, badEnter = 0, noStand = 0, totalCells = 0;
for (const sc of t1) {
  const names = sc.items.filter((i) => !i.missing).map((i) => i.id.replace('npc-', ''));
  console.log(`  ${sc.scene.padEnd(9)} ${names.join(', ')}`);
  for (const i of sc.items) {
    npcCount++;
    if (i.missing) { console.log(`    ❌ ${i.id} 场景里没生成`); badBlock++; continue; }
    totalCells += i.blockedCells;
    if (!i.blockedAll) { console.log(`    ❌ ${i.id} 模型格 ${JSON.stringify(i.tiles)} 没有全部封住`); badBlock++; }
    if (!i.stand) { console.log(`    ⚠️ ${i.id} 旁边找不到可走格（玩家挨不到）`); noStand++; continue; }
    if (i.entered) { console.log(`    ❌ ${i.id} 哥伦比娅走进了模型盒子里 ${JSON.stringify(i.entered)}`); badEnter++; }
  }
}
ok(npcCount === 14, `14 位 NPC 全部就位分散在 ${t1.length} 个场景（实际 ${npcCount}）`);
ok(badBlock === 0, `每个 NPC 的模型占格都封死了，共 ${totalCells} 格（失败 ${badBlock}）—— 不只是落点那一格`);
ok(badEnter === 0, `物理测试：没有人能走进 NPC 的模型盒子（失败 ${badEnter}）`);
ok(noStand === 0, `每个 NPC 旁边都留了可走格给主角站（缺失 ${noStand}）`);

// ---- 委托 NPC 地图 ≠ 委托物品地图 -----------------------------------------
const t1b = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { QUESTS } = await import('/src/quests.js');
  const { NPCS } = await import('/src/config.js');
  return QUESTS.filter((q) => !q.special && q.giverNpcId).map((q) => {
    const n = NPCS.find((x) => x.id === q.giverNpcId);
    return { quest: q.title, npc: n ? n.name : q.giverNpcId, npcScene: n ? (n.scene || 'venue') : '?', propScene: q.scene };
  });
});
console.log('\n===== 任务1：委托 NPC 地图 ≠ 委托物品地图 =====');
for (const r of t1b) console.log(`  ${r.quest}：${r.npc}@${r.npcScene}  物品@${r.propScene}`);
ok(t1b.every((r) => r.npcScene !== r.propScene),
   `5 个委托全部满足「NPC 地图 ≠ 物品地图」（违反 ${t1b.filter((r) => r.npcScene === r.propScene).length} 个）`);

// ===========================================================================
// 任务4 —— 合影（必须在「还没开庆功宴」的常态下测：接委托时才有合影选项）
// ===========================================================================
const t4 = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { NPCS } = await import('/src/config.js');
  const guests = NPCS.filter((n) => n.guest);
  const missing = guests.filter((n) => !s.textures.exists(`assets/cutscene/photo-${n.id}.png`)).map((n) => n.id);

  s.scenes.load('venue', { tileX: 20, tileY: 18 }, true);
  await new Promise((r) => setTimeout(r, 1400));
  const npc = s.npcs.find((n) => n.guest);
  const lines = npc ? s.buildDialogLines(npc) : [];
  const photoLine = lines.find((l) => l.link && l.link.photo);
  return {
    guestCount: guests.length,
    photoCount: guests.length - missing.length,
    missing,
    spawned: s.npcs.length,
    venueNpcs: NPCS.filter((n) => (n.scene || 'venue') === 'venue' && !!n.guest).length,
    hasLine: !!photoLine,
    label: photoLine ? photoLine.link.label : null,
    npcId: npc ? npc.id : null,
    npcName: npc ? npc.name : null,
  };
});
console.log('\n===== 任务4：合影 =====');
console.log('  ' + JSON.stringify(t4));
ok(t4.spawned === t4.venueNpcs, `常态下会场站着 ${t4.spawned} 位 NPC（配置里就 ${t4.venueNpcs} 位 —— 其余分散在别的场景）`);
ok(t4.hasLine, `接委托的对话里出现「${t4.label}」选项`);
ok(t4.photoCount === t4.guestCount,
   `全部 ${t4.guestCount} 位客人的合影素材都已加载（缺 ${t4.missing.join(',') || '无'}）`);

if (t4.hasLine) {
  const t4b = await p.evaluate(async () => {
    const s = window.__venueScene;
    const npc = s.npcs.find((n) => n.guest);
    s.startDialog(npc);
    await new Promise((r) => setTimeout(r, 900));
    const lines = s.buildDialogLines(npc);
    const idx = lines.findIndex((l) => l.link && l.link.photo);

    // 翻到「合影留念」那一页（真人是一路点过来的）
    for (let i = 0; i < 40 && s.dialog.index < idx; i++) {
      s.dialog.advance();
      await new Promise((r) => setTimeout(r, 120));
    }
    const btn = document.querySelector('.dialog-link');
    const domLabel = btn ? btn.textContent.trim() : null;

    const dialogOpenBefore = s.dialog.isOpen();
    if (btn) btn.click();                 // ★ 真·点 DOM 按钮，不走内部调用
    await new Promise((r) => setTimeout(r, 1400));
    return {
      idx, dialogIndex: s.dialog.index, domLabel, dialogOpenBefore,
      overlayCount: (s.overlay || []).length,
      dialogOpen: s.dialog.isOpen(),
      npcName: npc.name,
      texExists: s.textures.exists(`assets/cutscene/photo-${npc.id}.png`),
    };
  });
  console.log('  ' + JSON.stringify(t4b));
  ok(t4b.dialogIndex === t4b.idx, `翻到第 ${t4b.dialogIndex} 句（合影那一句）`);
  ok(t4b.domLabel && t4b.domLabel.includes('合影'), `对话框里真的渲染出了按钮「${t4b.domLabel}」`);
  ok(t4b.texExists, `${t4b.npcName} 的合影贴图已加载`);
  ok(t4b.overlayCount === 3, `点合影 -> 全屏铺开（黑幕 + 图 + 提示 = 3，实际 ${t4b.overlayCount}）`);
  ok(t4b.dialogOpen === false, '合影时对话框已收起（不会盖住图）');
  await sleep(600);
  await p.screenshot({ path: `${OUT}\\_round7_photo.png` });
  await p.evaluate(() => window.__venueScene.closeOverlay());
  await sleep(300);
}

// ===========================================================================
// 任务2 —— 全委托完成后出现「切蛋糕」
// ===========================================================================
const t2 = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { QUESTS } = await import('/src/quests.js');

  s.scenes.load('venue', { tileX: 20, tileY: 18 }, true);
  await new Promise((r) => setTimeout(r, 1200));

  s.quests.reset();
  await new Promise((r) => setTimeout(r, 500));
  const beforeIds = s.quests.snapshot().map((q) => q.id);
  const beforeIp = s.interactPoints.points.map((x) => x.id);

  QUESTS.forEach((q) => { s.quests.data.states[q.id] = 'completed'; });
  s.quests.save();
  const started = s.maybeStartParty();
  await new Promise((r) => setTimeout(r, 2000));

  const afterIds = s.quests.snapshot().map((q) => q.id);
  const cake = s.quests.snapshot().find((q) => q.id === 'q-party-cake');
  const ip = s.interactPoints.points.find((x) => x.id === 'ip-party-cake');

  return {
    started, party: s.party,
    hasBefore: beforeIds.includes('q-party-cake'),
    hasAfter: afterIds.includes('q-party-cake'),
    beforeIp,
    cakeState: cake ? cake.state : null,
    ip: ip ? {
      tile: [ip.tileX, ip.tileY], marker: ip.marker.depth, icon: ip.icon.depth,
      label: ip.labelObj.depth, labelDy: ip.labelDy, iconDy: ip.iconDy,
    } : null,
    heroTile: [Math.floor(s.player.x / 64), Math.floor(s.player.y / 64)],
    heroDepth: s.player.depth,
    seats: s.partyObjs.length,
    standingNpcs: s.npcs.length,
  };
});
console.log('\n===== 任务2：切蛋糕 =====');
console.log('  ' + JSON.stringify(t2));
ok(t2.hasBefore === false, '委托没做完时，任务列表里【没有】切蛋糕');
ok(t2.beforeIp.includes('ip-party-cake') === false, '委托没做完时，主位地上没有切蛋糕的光圈');
ok(t2.party === true && t2.hasAfter === true, '全委托完成后，任务列表刷新出「切蛋糕」');
ok(t2.ip && t2.ip.tile[0] === 19 && t2.ip.tile[1] === 9,
   `互动点落在主位 (${t2.ip && t2.ip.tile})，即旅行者与桑多涅之间`);
ok(t2.ip && t2.ip.icon < t2.heroDepth,
   `宴会里互动点图标 depth ${t2.ip && t2.ip.icon} < 哥伦比娅 ${Math.round(t2.heroDepth)}（地图之上、哥伦比娅之下）`);
ok(t2.ip && t2.ip.labelDy <= -60, `互动点文字抬到桌面之上（labelDy=${t2.ip && t2.ip.labelDy}，桌子 depth 450）`);
ok(t2.heroTile[0] === 19 && t2.heroTile[1] === 9, `哥伦比娅自动站到主位 (${t2.heroTile})`);
ok(t2.seats === 29 + 28,
   `围桌摆出 1 张桌子 + 14 坐姿 + 14 影子 + 14 图标 + 14 名牌 = ${t2.seats}`
   + `（第八轮给坐姿 NPC 加了头顶图标/名牌，故 29 -> 57；站姿已全部撤走 ${t2.standingNpcs}）`);
await sleep(400);
await p.screenshot({ path: `${OUT}\\_round7_party.png` });

// ---- 按 E 走一遍：插画全屏 + 点鼠标收起 -----------------------------------
const t2b = await p.evaluate(async () => {
  const s = window.__venueScene;
  s.placeHeroAtPartySpot();
  for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));

  const texExists = s.textures.exists('assets/cutscene/cake-cut.png');
  s.showCakeCutscene();
  for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));

  const states = (s.overlay || []).map((o) => ({ d: o.depth, s: o.scrollFactorX }));
  const q = s.quests.snapshot().find((x) => x.id === 'q-party-cake') || {};
  return { texExists, openCount: (s.overlay || []).length, states, questState: q.state };
});
console.log('  ' + JSON.stringify(t2b));
ok(t2b.texExists, 'assets/cutscene/cake-cut.png 已加载');
ok(t2b.openCount === 3, `插画全屏铺开（黑幕 + 图 + 提示 = 3 个对象，实际 ${t2b.openCount}）`);
ok(t2b.states.every((o) => o.d >= 12000), '插画图层 depth ≥ 12000，压在所有东西之上');
ok(t2b.states.every((o) => o.s === 0), '插画固定屏幕（不跟随相机滚动）');
ok(t2b.questState === 'completed', `看完插画，「切蛋糕」记为完成（state=${t2b.questState}）`);
await sleep(600);
await p.screenshot({ path: `${OUT}\\_round7_cake.png` });

const t2c = await p.evaluate(async () => {
  const s = window.__venueScene;
  s.closeOverlay();
  for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
  return { openCount: (s.overlay || []).length };
});
ok(t2c.openCount === 0, '点鼠标收起后，插画对象全部销毁');

console.log(fail.length ? `\n❌ ${fail.length} 项未通过` : '\n✅ 全部通过');
await b.close();
process.exit(fail.length ? 1 : 0);

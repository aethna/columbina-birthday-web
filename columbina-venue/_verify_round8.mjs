// 第八轮验收（用户 m09394）
//
//   ① 围坐 NPC「大合影前不可互动、大合影后可互动」
//   ② 围坐 NPC 的对话 = 生日会闲聊 + 【查看合影】 + 【小游戏 · 单品（占位）】
//   ③ 围坐 NPC 都能真的走到身边（按模型盒算距离，不是中心点）
//   ④ 单人合影素材全部换成正脸立绘（素材层面：查 chars/npc-<id>-portrait.png 齐不齐）
//
// 跑法（必须在 venue/ 目录下）：
//   node _verify_round8.mjs
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
// 开庆功宴（把所有委托标完成）
// ===========================================================================
const boot = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { QUESTS } = await import('/src/quests.js');

  s.scenes.load('venue', { tileX: 20, tileY: 18 }, true);
  await new Promise((r) => setTimeout(r, 1200));

  s.story.data.lettersWritten = s.story.snapshot().letters.map((l) => l.id);
  s.story.data.delivered = true;
  s.story.save();

  s.quests.reset();
  await new Promise((r) => setTimeout(r, 400));
  // 除「切蛋糕」以外全部完成 —— 那条必须留给后面按 E 走一遍，
  // 否则 partyTalk 一开始就是 true，测不到「大合影前不可互动」。
  QUESTS.filter((q) => q.id !== 'q-party-cake')
    .forEach((q) => { s.quests.data.states[q.id] = 'completed'; });
  s.quests.save();
  const started = s.maybeStartParty();
  await new Promise((r) => setTimeout(r, 2200));

  // ★ 结局「切蛋糕」的任务指引（用户 2026-10-09 报的第 2 个问题）
  //   q-party-cake 的 target.type 是 'interact'，而 getGuideTarget() 原来只认
  //   visit / collect / talk，一个都不匹配 → 返回 null →
  //   任务面板点「前往」只弹「没有需要前往的地方」。
  //   正确的行为：算出会场主位那个交互点，并带上「切蛋糕」这个动作名。
  const guide = s.getGuideTarget();
  // 注意：InteractPoints 里每个运行时对象是 `{...def, x, y, marker, icon, ...}`，
  // 字段直接摊平在对象上，**没有** `.def` 这一层
  const cakeIp = (s.interactPoints.points || []).find((x) => x.id === 'ip-party-cake');

  return {
    started, party: s.party,
    seats: s.seatedNpcs.length,
    talk: s.partyTalk,
    iconVisible: s.seatedNpcs.filter((n) => n.icon && n.icon.visible).length,
    nameVisible: s.seatedNpcs.filter((n) => n.nameObj && n.nameObj.visible).length,
    iconDepth: s.seatedNpcs.length ? s.seatedNpcs[0].icon.depth : null,
    cakeState: (s.quests.snapshot().find((q) => q.id === 'q-party-cake') || {}).state,
    guide: guide && {
      sceneId: guide.sceneId,
      actionLabel: guide.actionLabel || null,
      crossScene: !!guide.crossScene,
      tileX: Math.floor(guide.x / 64),
      tileY: Math.floor(guide.y / 64),
    },
    cakeIpTile: cakeIp ? [cakeIp.tileX, cakeIp.tileY, cakeIp.scene] : null,
    // ★ 用户 2026-10-09 追加反馈：「结局任务出现后，切蛋糕的互动点没看到」
    //   根因：宴会桌 depth 450 把 420 层的图标/名牌整个盖住了。
    //   修法不是把图层抬到桌子之上（那会破坏「互动点在哥伦比娅之下」的规则），
    //   而是把图标/名牌的**位置**整个抬到桌面之上（世界 y < 桌子顶边）。
    //   所以这里断言的是「图标底边在桌子顶边之上」，不是 depth。
    cakeIconY: cakeIp && cakeIp.icon ? cakeIp.icon.y : null,
    cakeLabelY: cakeIp && cakeIp.labelObj ? cakeIp.labelObj.y : null,
    tableTop: (() => {
      const t = s.children.list.find(
        (o) => o.texture && o.texture.key === 'assets/celebration/banquet-table.png');
      return t ? t.getBounds().top : null;
    })(),
  };
});
console.log('\n===== ① 大合影【之前】：坐姿 NPC 不可互动 =====');
console.log('  ' + JSON.stringify(boot));
ok(boot.party && boot.started, '庆功宴已开启');
ok(boot.seats === 14, `摆出 ${boot.seats} 位围坐 NPC（应为 14）`);
ok(boot.cakeState !== 'completed', `切蛋糕还没做（state=${boot.cakeState}）`);
ok(boot.talk === false, 'partyTalk = false（还没放开搭话）');
ok(boot.iconVisible === 0 && boot.nameVisible === 0,
   `14 位的图标/名牌全部隐藏（可见 ${boot.iconVisible}/${boot.nameVisible}）`);

// ★ 第 2 个用户反馈：结局「切蛋糕」点「前往」要能正确指到主会场
ok(boot.guide && boot.guide.sceneId === 'venue',
   `「切蛋糕」的「前往」算得出目标（sceneId=${boot.guide ? boot.guide.sceneId : 'null'}）`);
ok(boot.guide && boot.guide.actionLabel === '切蛋糕',
   `目标带动作名「切蛋糕」（实际 ${boot.guide ? boot.guide.actionLabel : 'null'}）`);
ok(boot.guide && !boot.guide.crossScene,
   '目标判定为「就在当前这张地图上」');
ok(boot.guide && boot.cakeIpTile
   && boot.guide.tileX === boot.cakeIpTile[0] && boot.guide.tileY === boot.cakeIpTile[1],
   `指向主会场主位交互点 (${boot.cakeIpTile ? boot.cakeIpTile[0] : '?'},${boot.cakeIpTile ? boot.cakeIpTile[1] : '?'})`
   + `，实际 (${boot.guide ? boot.guide.tileX : '?'},${boot.guide ? boot.guide.tileY : '?'})`);

// ★ 追加反馈：切蛋糕的互动点必须真的看得见。
//   修法是把图标/名牌的位置抬到桌面之上（世界 y < 桌子顶边），图层保持全局默认值，
//   这样既不挡主角（互动点仍在哥伦比娅之下），也不会被桌子盖住。
ok(boot.cakeIconY != null && boot.tableTop != null && boot.cakeIconY < boot.tableTop - 20,
   `切蛋糕图标 y=${boot.cakeIconY} 在宴会桌顶边 y=${boot.tableTop} 之上`
   + '（不然会被桌子整个盖住，玩家根本看不到）');
ok(boot.cakeLabelY != null && boot.tableTop != null && boot.cakeLabelY < boot.tableTop - 20,
   `切蛋糕名牌 y=${boot.cakeLabelY} 在宴会桌顶边 y=${boot.tableTop} 之上`);

// 把主角挪到最靠近某个座位的可走格，确认「够得着也不给聊」
const preTalk = await p.evaluate(async () => {
  const s = window.__venueScene;

  // 找一个贴着座位盒子的可走格（用真实的禁行表，不用猜）
  function standSpot(seat) {
    let best = null;
    const cx = Math.floor(seat.x / 64), cy = Math.floor(seat.y / 64);
    for (let ty = cy - 5; ty <= cy + 5; ty++) {
      for (let tx = cx - 4; tx <= cx + 4; tx++) {
        if (tx < 0 || ty < 0 || tx >= 40 || ty >= 24) continue;
        if (s.scenes.isBlockedAt('venue', tx, ty)) continue;
        const wx = tx * 64 + 32, wy = ty * 64 + 32;
        const r = seat.rect;
        const dx = Math.max(r.left - wx, 0, wx - r.right);
        const dy = Math.max(r.top - wy, 0, wy - r.bottom);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (!best || d < best.d) best = { tx, ty, wx, wy, d };
      }
    }
    return best;
  }

  const seat = s.seatedNpcs.find((n) => n.id === 'npc-ainuo') || s.seatedNpcs[0];
  const spot = standSpot(seat);
  if (spot) { s.player.x = spot.wx; s.player.y = spot.wy; }
  for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
  s.handleProximity();
  return { seat: seat.id, dist: spot ? +spot.d.toFixed(1) : null, active: s.activeNpc ? s.activeNpc.id : null, tip: s.npcTip.visible };
});
console.log('  ' + JSON.stringify(preTalk));
ok(preTalk.dist !== null && preTalk.dist < 78,
   `主角能站到 ${preTalk.seat} 身边（模型盒距离 ${preTalk.dist}px < 78）`);
ok(preTalk.active === null, '但切蛋糕前【选不中】他 —— activeNpc = null');

// ===========================================================================
// ② 切蛋糕（看大合影）→ 放开互动
// ===========================================================================
const cake = await p.evaluate(async () => {
  const s = window.__venueScene;
  s.placeHeroAtPartySpot();
  for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
  s.showCakeCutscene();
  for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));
  const overlayTex = (s.overlay && s.overlay[1] && s.overlay[1].texture) ? s.overlay[1].texture.key : null;
  return {
    talk: s.partyTalk,
    iconVisible: s.seatedNpcs.filter((n) => n.icon && n.icon.visible).length,
    nameVisible: s.seatedNpcs.filter((n) => n.nameObj && n.nameObj.visible).length,
    iconDepth: s.seatedNpcs.length ? s.seatedNpcs[0].icon.depth : null,
    overlayCount: (s.overlay || []).length,
    overlayTex,
    cakeState: (s.quests.snapshot().find((q) => q.id === 'q-party-cake') || {}).state,
  };
});
console.log('\n===== ② 切蛋糕 = 拍完大合影 → 放开互动 =====');
console.log('  ' + JSON.stringify(cake));
ok(cake.overlayCount === 3 && cake.overlayTex === 'assets/cutscene/cake-cut.png',
   `大合影全屏铺开（3 个对象，贴图 ${cake.overlayTex}）`);
ok(cake.cakeState === 'completed', `「切蛋糕」记为完成（state=${cake.cakeState}）`);
ok(cake.talk === true, 'partyTalk = true（所有坐姿 NPC 放开互动）');
ok(cake.iconVisible === 14 && cake.nameVisible === 14,
   `14 位围坐 NPC 的图标/名牌全部亮起（${cake.iconVisible}/${cake.nameVisible}）`);
ok(cake.iconDepth >= 9000, `图标 depth ${cake.iconDepth} 盖在坐姿贴图(400/460)之上`);

await p.evaluate(() => window.__venueScene.closeOverlay());
await sleep(400);

// ===========================================================================
// ③ 14 位都能走到身边 + 选中
// ===========================================================================
const reach = await p.evaluate(async () => {
  const s = window.__venueScene;

  function standSpot(seat) {
    let best = null;
    const cx = Math.floor(seat.x / 64), cy = Math.floor(seat.y / 64);
    for (let ty = cy - 6; ty <= cy + 6; ty++) {
      for (let tx = cx - 5; tx <= cx + 5; tx++) {
        if (tx < 0 || ty < 0 || tx >= 40 || ty >= 24) continue;
        if (s.scenes.isBlockedAt('venue', tx, ty)) continue;
        const wx = tx * 64 + 32, wy = ty * 64 + 32;
        const r = seat.rect;
        const dx = Math.max(r.left - wx, 0, wx - r.right);
        const dy = Math.max(r.top - wy, 0, wy - r.bottom);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (!best || d < best.d) best = { tx, ty, wx, wy, d };
      }
    }
    return best;
  }

  const rows = [];
  for (const seat of s.seatedNpcs) {
    const spot = standSpot(seat);
    if (!spot) { rows.push({ id: seat.id, dist: null, active: null }); continue; }
    s.player.x = spot.wx; s.player.y = spot.wy;
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    s.handleProximity();
    rows.push({
      id: seat.id, tile: [spot.tx, spot.ty], dist: +spot.d.toFixed(1),
      active: s.activeNpc ? s.activeNpc.id : null,
      tip: s.npcTip.text.split('\n')[0],
    });
  }
  return rows;
});
console.log('\n===== ③ 14 位围坐 NPC 都能走到身边并选中 =====');
for (const r of reach) {
  console.log(`  ${String(r.id).padEnd(18)} tile${JSON.stringify(r.tile)} 距离 ${String(r.dist).padStart(5)}px  选中=${r.active}  ${r.tip}`);
}
const badReach = reach.filter((r) => r.dist === null || r.dist >= 78 || r.active !== r.id);
ok(badReach.length === 0, `14 位全部可接近且能选中（不合格 ${badReach.length} 位）`);

// ===========================================================================
// ④ 对话内容：闲聊 + 查看合影 + 小游戏·单品（占位）
// ===========================================================================
const dlg = await p.evaluate(async () => {
  const s = window.__venueScene;
  const seat = s.seatedNpcs.find((n) => n.id === 'npc-ainuo') || s.seatedNpcs[0];

  s.startDialog(seat);
  await new Promise((r) => setTimeout(r, 300));
  const root = document.getElementById('dialog-root');
  const opened = root.classList.contains('active');
  const name = document.getElementById('dialog-name').textContent;
  const first = document.getElementById('dialog-text').textContent;

  const lines = s.buildSeatedDialogLines(seat).map((l) => ({
    text: l.text, label: l.link ? l.link.label : null,
    photo: l.link ? l.link.photo : null, soon: !!(l.link && l.link.soon),
  }));

  // 跳到「查看合影」那一行（photo === true = 看这位 NPC 和哥伦比娅的【单独】合影）
  const photoIdx = lines.findIndex((l) => l.photo);
  s.dialog.index = photoIdx; s.dialog.render();
  await new Promise((r) => setTimeout(r, 200));
  const photoBtn = document.querySelector('#dialog-links .dialog-link');
  const photoBtnLabel = photoBtn ? photoBtn.textContent : null;

  return { opened, name, first, lines, photoIdx, photoBtnLabel };
});
console.log('\n===== ④ 围坐对话结构 =====');
console.log('  ' + JSON.stringify(dlg.lines, null, 0));
ok(dlg.opened, '按 E 能对坐姿 NPC 开出对话');
ok(dlg.lines.length === 4, `对话共 ${dlg.lines.length} 行（2 句生日会闲聊 + 合影 + 小游戏）`);
ok(dlg.lines[0].text && dlg.lines[1].text, '第 1、2 行是关于本次生日会的闲聊');
ok(dlg.photoBtnLabel === '📸 查看合影', `第 ${dlg.photoIdx + 1} 行按钮 = ${dlg.photoBtnLabel}`);
ok(dlg.lines.some((l) => l.soon), '有一行是「小游戏 · 单品」占位入口');

// 点「查看合影」
const photoClick = await p.evaluate(async () => {
  const s = window.__venueScene;
  document.querySelector('#dialog-links .dialog-link').click();
  for (let i = 0; i < 12; i++) await new Promise((r) => requestAnimationFrame(r));
  return {
    dialogOpen: document.getElementById('dialog-root').classList.contains('active'),
    overlayCount: (s.overlay || []).length,
    tex: (s.overlay && s.overlay[1] && s.overlay[1].texture) ? s.overlay[1].texture.key : null,
  };
});
console.log('  ' + JSON.stringify(photoClick));
ok(photoClick.overlayCount === 3 && photoClick.tex === 'assets/cutscene/photo-npc-ainuo.png',
   `点「查看合影」→ 该 NPC 与哥伦比娅的【单独】合影（贴图 ${photoClick.tex}）`);
ok(photoClick.dialogOpen === false, '对话框已自动收起，不会盖住插画');

await sleep(500);
await p.screenshot({ path: `${OUT}\\_round8_photo.png` });

// 点「小游戏 · 单品」（占位）——先收起插画再点
const offerClick = await p.evaluate(async () => {
  const s = window.__venueScene;
  s.closeOverlay();
  for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));

  const seat = s.seatedNpcs.find((n) => n.id === 'npc-ainuo') || s.seatedNpcs[0];
  const seen = [];
  const rawToast = s.toast.bind(s);
  s.toast = (t) => { seen.push(String(t)); rawToast(t); };

  s.startDialog(seat);
  await new Promise((r) => setTimeout(r, 200));
  const lines = s.buildSeatedDialogLines(seat);
  const soonIdx = lines.findIndex((l) => l.link && l.link.soon);
  s.dialog.index = soonIdx; s.dialog.render();
  await new Promise((r) => setTimeout(r, 200));
  const btn = document.querySelector('#dialog-links .dialog-link');
  const label = btn ? btn.textContent : null;
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 400));
  s.toast = rawToast;
  return { label, seen, dialogOpen: document.getElementById('dialog-root').classList.contains('active') };
});
console.log('  ' + JSON.stringify(offerClick));
ok(offerClick.label === '🎮 小游戏 · 单品', `占位按钮 = ${offerClick.label}`);
ok(offerClick.seen.length >= 1, `点下去有明确反馈（toast：${offerClick.seen[0] || '无'}）`);
ok(offerClick.dialogOpen === false, '占位选项点完对话收起');

// ===========================================================================
// ⑤ 单人合影素材 = 正脸立绘（offline 拼图产物）
// ===========================================================================
const assets = await p.evaluate(async () => {
  const { NPCS } = await import('/src/config.js');
  const guests = NPCS.filter((n) => n.guest);
  const out = [];
  for (const n of guests) {
    const slug = n.id.startsWith('npc-') ? n.id : `npc-${n.id}`;
    const tex = `assets/cutscene/photo-${n.id}.png`;
    // 立绘源文件是否同名可用（headless 里用 Image 探测，避免 404 静默）
    const portOk = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res([im.naturalWidth, im.naturalHeight]);
      im.onerror = () => res(null);
      im.src = `/assets/chars/${slug}-portrait.png`;
    });
    out.push({ id: n.id, tex, loaded: window.__venueScene.textures.exists(tex), portrait: portOk });
  }
  return out;
});
console.log('\n===== ⑤ 合影素材 =====');
ok(assets.length === 13, `受邀客人 ${assets.length} 位（空不算）`);
ok(assets.every((a) => a.loaded), `13 张 photo-*.png 全部加载（缺 ${assets.filter((a) => !a.loaded).length}）`);
ok(assets.every((a) => a.portrait && a.portrait[0] > 100),
   `13 位都有正脸立绘 chars/npc-<id>-portrait.png（缺 ${assets.filter((a) => !a.portrait).length}）`);

console.log(fail.length ? `\n❌ ${fail.length} 项未通过` : '\n✅ 全部通过');
await b.close();
process.exit(fail.length ? 1 : 0);

/**
 * 验收 2026-10-05 用户报的三个 bug 的修复
 *
 *   BUG 1  任务面板「前往」的提示要报出【目标所在地图】
 *          （原来跨场景时用 q.scene 猜地图，5 条采集委托都写 'venue'，
 *            于是去池塘捉鱼会被指回「林间空地」）
 *   BUG 2  没接对应委托时，交互点不给东西，提示「请找到 XX 接委托」
 *          （原来能直接把鱼捞走 → 计数器不加 → 委托永远做不完）
 *   BUG 3  鼠标点 NPC 对话（且无视距离）应被撤销
 *
 * 用法：
 *   cd venue
 *   & $node _verify_bugfix3.mjs
 * 需要 vite 开发服务器已在 5173 跑着。
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL = 'http://localhost:5173/venue.html';
const OUT = 'D:\\DSH工作区\\哥伦比娅生日会\\_bugfix3_report.txt';

const lines = [];
let pass = 0;
let fail = 0;

function log(s = '') {
  lines.push(s);
  console.log(s);
}

function check(name, ok, detail = '') {
  if (ok) { pass++; log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

try {
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(6000);

  const has = await page.evaluate(() => !!window.__venueScene);
  check('页面加载、__venueScene 就绪', has);
  if (!has) throw new Error('scene 没起来');

  // =====================================================================
  log('');
  log('=== BUG 3：鼠标不能再点 NPC 对话 ===');
  // =====================================================================
  const npcInput = await page.evaluate(() => {
    const s = window.__venueScene;
    return s.npcs.map((n) => ({
      name: n.name,
      interactive: !!(n.body && n.body.input),
      listeners: n.body && n.body.listenerCount ? n.body.listenerCount('pointerdown') : -1,
    }));
  });
  const anyInteractive = npcInput.filter((n) => n.interactive);
  const anyPointer = npcInput.filter((n) => n.listeners > 0);
  check(`NPC 立绘都不再可点击（共 ${npcInput.length} 位）`, anyInteractive.length === 0,
    anyInteractive.length ? '仍然可点：' + anyInteractive.map((n) => n.name).join('、') : '');
  check('NPC 立绘都没有 pointerdown 回调', anyPointer.length === 0,
    anyPointer.length ? '仍有回调：' + anyPointer.map((n) => n.name).join('、') : '');

  // 真·点一下屏幕对面的 NPC，确认不开对话
  const distClick = await page.evaluate(async () => {
    const s = window.__venueScene;
    const npc = s.npcs[0];
    if (!npc) return { skipped: true };
    // 把玩家挪到离 NPC 很远的地方
    s.player.setPosition(100, 100);
    await new Promise((r) => setTimeout(r, 300));
    const d = Phaser.Math.Distance.Between(s.player.x, s.player.y, npc.x, npc.y);
    const before = s.dialog.isOpen();
    // 直接冲着 NPC 的屏幕坐标点一下（相机换算）
    const cam = s.cameras.main;
    const sx = (npc.x - cam.scrollX) * cam.zoom;
    const sy = (npc.y - cam.scrollY) * cam.zoom;
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true, clientX: r.left + sx, clientY: r.top + sy,
    }));
    c.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, clientX: r.left + sx, clientY: r.top + sy,
    }));
    await new Promise((res) => setTimeout(res, 500));
    return { dist: Math.round(d), before, after: s.dialog.isOpen() };
  });
  check('远距离点 NPC 不会开对话框',
    distClick.skipped || (distClick.after === false),
    distClick.skipped ? '(没有 NPC)' : `玩家与 NPC 相距 ${distClick.dist}px，dialog=${distClick.after}`);

  // =====================================================================
  log('');
  log('=== BUG 2：没接委托时，采集点不给东西 ===');
  // =====================================================================
  const before = await page.evaluate(() => {
    const s = window.__venueScene;
    s.scenes.load('pond', null, true);
    return true;
  });

  // 走到 ip-pond-fish 旁边（pond 14,11）
  await page.evaluate(() => {
    const s = window.__venueScene;
    s.player.setPosition(14 * 64 + 32, 11 * 64 + 32);
  });
  await sleep(700);

  const nearInfo = await page.evaluate(() => {
    const s = window.__venueScene;
    const p = s.interactPoints.active;
    return {
      scene: s.scenes.current.id,
      hasActive: !!p,
      id: p && p.id,
      label: p && p.labelText,
      questId: p && p.questId,
      accepted: p ? s.interactPoints.isQuestAccepted(p) : null,
    };
  });
  check('pond 里站到了捉鱼交互点上', nearInfo.id === 'ip-pond-fish',
    JSON.stringify(nearInfo));

  const noQuest = await page.evaluate(() => {
    const s = window.__venueScene;
    s.triggerPoint(s.interactPoints.active);
    return {
      toast: s.toastText.text,
      hasFish: s.hasItem('fish'),
      counter: s.quests.getCounter('q-ainuo-fish'),
      state: s.quests.getStateById('q-ainuo-fish'),
    };
  });
  check('没接委托按 E：不给鱼', noQuest.hasFish === false);
  check('没接委托按 E：计数仍是 0', noQuest.counter === 0);
  check('没接委托按 E：提示里点名委托人「爱诺」', noQuest.toast.includes('爱诺'),
    `toast="${noQuest.toast}"`);
  check('没接委托按 E：提示委托名「池塘捉鱼」', noQuest.toast.includes('池塘捉鱼'),
    `toast="${noQuest.toast}"`);

  // ---- 接委托之后再按 E，应该正常拿到 ----
  const afterAccept = await page.evaluate(() => {
    const s = window.__venueScene;
    s.quests.data.states['q-ainuo-fish'] = 'active';
    s.quests.save();
    return {
      state: s.quests.getStateById('q-ainuo-fish'),
      accepted: s.interactPoints.isQuestAccepted(s.interactPoints.active),
    };
  });
  check('接取委托后 isQuestAccepted 变 true', afterAccept.accepted === true,
    JSON.stringify(afterAccept));

  await sleep(300);
  const gotFish = await page.evaluate(() => {
    const s = window.__venueScene;
    s.triggerPoint(s.interactPoints.active);
    return {
      hasFish: s.hasItem('fish'),
      counter: s.quests.getCounter('q-ainuo-fish'),
      state: s.quests.getStateById('q-ainuo-fish'),
    };
  });
  check('接了委托按 E：拿到鱼', gotFish.hasFish === true, JSON.stringify(gotFish));
  check('接了委托按 E：计数 +1', gotFish.counter === 1, JSON.stringify(gotFish));
  check('接了委托按 E：委托变 ready', gotFish.state === 'ready', JSON.stringify(gotFish));

  // =====================================================================
  log('');
  log('=== BUG 2 补充：老存档死锁（先有道具、后接委托）能补计数 ===');
  // =====================================================================
  const deadlock = await page.evaluate(() => {
    const s = window.__venueScene;
    // 造出"身上有鱼但计数是 0、且委托没接"的老存档现场
    s.giveItem('fish', '鱼');
    s.quests.data.counters['q-ainuo-fish'] = 0;
    s.quests.data.states['q-ainuo-fish'] = 'active';
    s.quests.save();

    const before = {
      hasFish: s.hasItem('fish'),
      counter: s.quests.getCounter('q-ainuo-fish'),
      state: s.quests.getStateById('q-ainuo-fish'),
    };
    s.triggerPoint(s.interactPoints.active);
    const after = {
      hasFish: s.hasItem('fish'),
      counter: s.quests.getCounter('q-ainuo-fish'),
      state: s.quests.getStateById('q-ainuo-fish'),
      toast: s.toastText.text,
    };
    return { before, after };
  });
  check('老存档（有鱼/计数0）按 E 后计数被补上',
    deadlock.after.counter === 1 && deadlock.after.state === 'ready',
    JSON.stringify(deadlock));

  // =====================================================================
  log('');
  log('=== BUG 1：任务面板「前往」要报出目标地图名 ===');
  // =====================================================================
  // 现场 1：人在池塘、委托进行中 → 目标点就在本场景（ip-pond-fish）
  // 先把主线推完（getGuideTarget 会优先指引主线，主线没完就看不到委托指引）
  await page.evaluate(() => {
    const s = window.__venueScene;
    s.story.reset();
    for (let i = 0; i < 12; i++) s.story.writeLetter();
    s.story.deliverLetters();
    s.quests.data.states['q-ainuo-fish'] = 'active';
    s.quests.data.counters['q-ainuo-fish'] = 0;
    s.quests.save();
    s.scenes.load('pond', null, true);
  });
  await sleep(700);
  const same = await page.evaluate(() => {
    const s = window.__venueScene;
    const t = s.getGuideTarget();
    s.handleGotoQuest('q-ainuo-fish');
    return {
      here: s.scenes.current.id,
      sceneId: t && t.sceneId,
      cross: t && t.crossScene,
      toast: s.toastText.text,
    };
  });
  check('在池塘点「前往」：getGuideTarget 报 sceneId=pond（同场景）',
    same.sceneId === 'pond' && same.cross === false, JSON.stringify(same));
  check('在池塘点「前往」：提示含「静谧池塘」', same.toast.includes('静谧池塘'),
    `toast="${same.toast}"`);

  // 现场 2：人回到会场 → 目标在池塘，必须跨场景且报出「静谧池塘」
  await page.evaluate(() => {
    window.__venueScene.scenes.load('venue', null, true);
  });
  await sleep(700);
  const other = await page.evaluate(() => {
    const s = window.__venueScene;
    const t = s.getGuideTarget();
    s.handleGotoQuest('q-ainuo-fish');
    return {
      here: s.scenes.current.id,
      sceneId: t && t.sceneId,
      via: t && t.viaSceneId,
      cross: t && t.crossScene,
      toast: s.toastText.text,
    };
  });
  check('在会场点「前往」：getGuideTarget 报 sceneId=pond（不是 venue）',
    other.sceneId === 'pond', JSON.stringify(other));
  check('在会场点「前往」：提示含「静谧池塘」', other.toast.includes('静谧池塘'),
    `toast="${other.toast}"`);
  check('在会场点「前往」：不再出现「林间空地」指错地图',
    !other.toast.includes('林间空地'), `toast="${other.toast}"`);
  check('在会场点「前往」：提示中转第一站（传送光圈）',
    other.toast.includes('传送光圈'), `toast="${other.toast}"`);

  // 现场 2b：跨大半个环 —— 从池塘去会场，经由哪个中转都行，只要报出终点名字
  // 现场 2b：跨大半个环 —— 从池塘去会场（交付 NPC 在会场）
  await page.evaluate(() => {
    const s = window.__venueScene;
    s.quests.data.counters['q-ainuo-fish'] = 1;
    s.quests.data.states['q-ainuo-fish'] = 'ready';
    s.quests.save();
    s.scenes.load('pond', null, true);
  });
  await sleep(700);
  const farToast = await page.evaluate(() => {
    const s = window.__venueScene;
    const t = s.getGuideTarget();
    s.handleGotoQuest('q-ainuo-fish');
    return { sceneId: t && t.sceneId, via: t && t.viaSceneId, toast: s.toastText.text };
  });
  check('池塘 → 会场（不直连）：getGuideTarget 仍能算出目标地图=venue',
    farToast.sceneId === 'venue', JSON.stringify(farToast));
  check('池塘 → 会场：提示含「林间空地」', farToast.toast.includes('林间空地'),
    `toast="${farToast.toast}"`);
  check('池塘 → 会场：提示含中转第一站及中转场景名',
    !!farToast.via && farToast.toast.includes('先走传送光圈去'),
    `toast="${farToast.toast}"`);

  // 现场 3：主线第 1 步 → 应报「窗前书桌」
  await page.evaluate(() => {
    const s = window.__venueScene;
    s.story.reset();
    s.scenes.load('venue', null, true);
  });
  await sleep(700);
  const mainToast = await page.evaluate(() => {
    const s = window.__venueScene;
    const t = s.getGuideTarget();
    s.handleGotoQuest('main-write');
    return { sceneId: t && t.sceneId, toast: s.toastText.text };
  });
  check('主线写信：目标地图 = home（窗前书桌）',
    mainToast.sceneId === 'home' && mainToast.toast.includes('窗前书桌'),
    JSON.stringify(mainToast));

  // =====================================================================
  log('');
  log('=== 回归：13 位 NPC 仍完整、交互点数量正常 ===');
  // =====================================================================
  const regression = await page.evaluate(() => {
    const s = window.__venueScene;
    // 把主线推到「11 封都写好 + 已投递」，客人才会到场
    s.story.reset();
    for (let i = 0; i < 12; i++) s.story.writeLetter();
    s.story.deliverLetters();
    s.scenes.load('venue', null, true);
    return {
      written: s.story.writtenCount,
      allWritten: s.story.allWritten,
      delivered: s.story.isDelivered,
    };
  });
  await sleep(1200);
  const npcCount = await page.evaluate(async () => {
    const s = window.__venueScene;
    // ★ 2026-10-07：会场多了「空 + 派蒙」（伙伴，没有 guest 标记，进场就在），
    //   所以这里按【客人名字】逐个核对，而不是拿 s.npcs.length 硬比 13。
    const NPCS = (await import('/src/config.js')).NPCS;
    const guestNames = NPCS.filter((n) => n.guest).map((n) => n.name);
    const present = guestNames.filter((nm) => s.npcs.some((n) => n.name === nm));
    return {
      npcs: s.npcs.length,
      guestsPresent: present.length,
      guestsTotal: guestNames.length,
      scene: s.scenes.current.id,
      interactive: s.npcs.filter((n) => n.body && n.body.input).length,
    };
  });
  check('主线推到底：13 位客人到场', npcCount.guestsPresent === 13 && npcCount.guestsTotal === 13,
    JSON.stringify({ ...regression, ...npcCount }));
  check('场景里全部 NPC 都不再可点击', npcCount.interactive === 0,
    `可点击 ${npcCount.interactive} 位（场景里共 ${npcCount.npcs} 位）`);

  log('');
  log(`运行时报错：${errors.length ? errors.join(' | ') : '无'}`);
  log('');
  log(`===== 通过 ${pass} / 失败 ${fail} =====`);
} catch (e) {
  log('');
  log('💥 脚本异常：' + (e && e.stack ? e.stack : e));
  fail++;
} finally {
  await browser.close();
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log('\n报告已写入 ' + OUT);
  process.exit(fail ? 1 : 0);
}

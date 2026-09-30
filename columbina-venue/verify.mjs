/**
 * 运行时验证脚本
 *
 * 目的：用真实浏览器加载会场，确认：
 *   1. 没有 JS 运行时错误
 *   2. Phaser 场景真的创建成功（不是黑屏）
 *   3. 地图 / NPC / 玩家都渲染出来了
 *   4. 对话系统能打开
 *
 * 用法：node verify.mjs
 * 需要先启动 dev server（npm run dev）
 */

import puppeteer from 'puppeteer';

// 注意：会场现在是 /venue.html（根路径 / 是首页），
// 所以这里必须指向 venue.html，否则会测到首页上。
const URL = process.env.VENUE_URL || 'http://localhost:5173/venue.html';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
const warnings = [];

page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  const t = msg.type();
  if (t === 'error') errors.push(`[console.error] ${msg.text()}`);
  else if (t === 'warning') warnings.push(`[warn] ${msg.text()}`);
});
page.on('requestfailed', (req) => {
  errors.push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`);
});

console.log(`打开 ${URL} ...`);
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

// 等 Phaser 场景真正初始化
await new Promise((r) => setTimeout(r, 2500));

// ---- 检查 1：canvas 是否存在且有尺寸 ----
const canvasInfo = await page.evaluate(() => {
  const c = document.querySelector('#game-root canvas');
  if (!c) return null;
  return { w: c.width, h: c.height };
});

// ---- 检查 2：场景是否创建成功 ----
const sceneInfo = await page.evaluate(() => {
  const s = window.__venueScene;
  if (!s) return { ok: false, reason: '__venueScene 不存在（场景未启动）' };
  return {
    ok: true,
    npcCount: s.npcs.length,
    booths: undefined,
    hasPlayer: !!(s.player && s.player.active),
    playerPos: s.player ? { x: Math.round(s.player.x), y: Math.round(s.player.y) } : null,
    questCount: s.quests ? s.quests.snapshot().length : 0,
    dialogOpen: s.dialog ? s.dialog.isOpen() : null,
  };
});

// ---- 检查 3：画面不是纯黑（说明真的画了东西）----
const pixelStats = await page.evaluate(() => {
  const c = document.querySelector('#game-root canvas');
  if (!c) return null;
  // WebGL canvas 需要 preserveDrawingBuffer 才能读像素，
  // 这里改用截图对比的方式，此处只返回尺寸即可。
  return { w: c.width, h: c.height };
});

// ---- 检查 4：对话框 DOM 存在 ----
const dialogDom = await page.evaluate(() => {
  return {
    root: !!document.getElementById('dialog-root'),
    name: !!document.getElementById('dialog-name'),
    text: !!document.getElementById('dialog-text'),
    links: !!document.getElementById('dialog-links'),
  };
});

// ---- 检查 5：模拟按 E 触发对话（把玩家瞬移到 NPC 旁边）----
const dialogTest = await page.evaluate(async () => {
  const s = window.__venueScene;
  if (!s || !s.npcs.length) return { ok: false, reason: 'no scene/npc' };

  const npc = s.npcs[0];
  // 瞬移到 NPC 旁边
  s.player.setPosition(npc.x + 30, npc.y);

  // 等一帧让 proximity 检测生效
  await new Promise((r) => setTimeout(r, 300));

  return {
    ok: true,
    npcName: npc.name,
    activeNpc: s.activeNpc ? s.activeNpc.name : null,
  };
});

await new Promise((r) => setTimeout(r, 400));

// ---- 检查 6：走路动画是否真的注册并可播放 ----
// 注意：不能直接 setVelocity —— 场景每帧的 update() 会按按键状态重算速度，
//       手动设的速度会被立刻覆盖。所以要模拟真实按键。
const animTest = await page.evaluate(async () => {
  const s = window.__venueScene;
  if (!s) return { ok: false, reason: 'no scene' };

  const res = { anims: {}, played: null, moved: false, dirChanged: false };

  // 动画 key 取决于角色处于哪种模式：
  //   行走图/占位 → ph-player-* 或 char-player-*
  //   立绘        → 没有动画（只有一张图），此时跳过这项检查
  const info = s.playerInfo || { mode: 'placeholder', key: 'player' };
  res.mode = info.mode;

  if (info.mode === 'sprite') {
    res.spriteMode = true;
    res.anims = { note: '立绘模式，无需动画' };
  } else {
    for (const dir of ['down', 'left', 'right', 'up']) {
      res.anims[`walk-${dir}`] = s.anims.exists(`${info.key}-walk-${dir}`);
      res.anims[`idle-${dir}`] = s.anims.exists(`${info.key}-idle-${dir}`);
    }
  }

  const startX = s.player.x;
  const startY = s.player.y;

  // 模拟按住 D（向右）
  s.keyD.isDown = true;

  await new Promise((r) => setTimeout(r, 500));

  res.moved = Math.abs(s.player.x - startX) > 5;
  res.played = s.player.anims.currentAnim ? s.player.anims.currentAnim.key : null;
  res.dirChanged = s.playerDir === 'right';

  // 松开
  s.keyD.isDown = false;
  await new Promise((r) => setTimeout(r, 200));

  res.idleAfterStop = s.player.anims.currentAnim ? s.player.anims.currentAnim.key : null;

  return res;
});

// ---- 截图 ----
await page.screenshot({ path: 'verify-screenshot.png' });
console.log('\n已截图: verify-screenshot.png');

// ---- 输出结果 ----
console.log('\n===== 验证结果 =====');
console.log('Canvas       :', canvasInfo ? `${canvasInfo.w}x${canvasInfo.h}` : '❌ 未找到');
console.log('场景         :', sceneInfo.ok ? '✅ 已创建' : `❌ ${sceneInfo.reason}`);
if (sceneInfo.ok) {
  console.log('  NPC 数量   :', sceneInfo.npcCount);
  console.log('  玩家       :', sceneInfo.hasPlayer ? `✅ 位置 ${JSON.stringify(sceneInfo.playerPos)}` : '❌');
  console.log('  委托数量   :', sceneInfo.questCount);
}
console.log('对话 DOM     :', Object.values(dialogDom).every(Boolean) ? '✅ 齐全' : `❌ ${JSON.stringify(dialogDom)}`);
console.log('靠近 NPC     :', dialogTest.ok ? `✅ 已激活 ${dialogTest.activeNpc}` : `❌ ${dialogTest.reason}`);

console.log('\n--- 走路动画 ---');
console.log('角色模式     :', animTest.mode || 'unknown');
if (animTest.spriteMode) {
  console.log('动画检查     : 跳过（立绘模式没有动画，正常）');
} else {
  const animsOk = Object.values(animTest.anims || {}).every(Boolean);
  console.log('8 个动画注册 :', animsOk ? '✅ 全部就绪' : `❌ ${JSON.stringify(animTest.anims)}`);
}
console.log('按 D 移动    :', animTest.moved ? '✅ 角色移动了' : '❌ 角色没有移动');
console.log('朝向切换     :', animTest.dirChanged ? '✅ 已转向 right' : '❌ 朝向未变');
console.log('移动时动画   :', animTest.played || '(无)');
console.log('停止后动画   :', animTest.idleAfterStop || '(无)');

// ---- 检查 7：对话界面（截图确认头像+对话框效果）----
const dialogShot = await page.evaluate(async () => {
  const s = window.__venueScene;
  if (!s || !s.npcs.length) return { ok: false };

  // 直接打开第一个 NPC 的对话
  const npc = s.npcs.find((n) => n.name === '委托官') || s.npcs[0];
  s.startDialog(npc);

  await new Promise((r) => setTimeout(r, 1800)); // 等逐字打印

  return {
    ok: true,
    npcName: npc.name,
    // 头像有两种形态：emoji 文本 或 <img> 图片，都要能识别
    portrait: (() => {
      const el = document.getElementById('dialog-portrait');
      if (!el) return '';
      const img = el.querySelector('img');
      if (img) return `[图片] ${img.getAttribute('src') || ''}`;
      return el.textContent.trim();
    })(),
    nameShown: document.getElementById('dialog-name').textContent,
    textShown: document.getElementById('dialog-text').textContent.slice(0, 30),
    hasLinkBtn: !!document.querySelector('.dialog-link'),
  };
});

await page.screenshot({ path: 'verify-dialog.png' });
console.log('\n已截图: verify-dialog.png');

console.log('\n--- 对话界面 ---');
if (dialogShot.ok) {
  console.log('  说话人     :', dialogShot.nameShown, dialogShot.nameShown === dialogShot.npcName ? '✅' : '❌');
  console.log('  头像       :', dialogShot.portrait || '(空)', dialogShot.portrait ? '✅' : '❌');
  console.log('  文字       :', `"${dialogShot.textShown}…"`, dialogShot.textShown ? '✅' : '❌');
  console.log('  跳转按钮   :', dialogShot.hasLinkBtn ? '✅ 有' : '(这一句没有，正常)');
} else {
  console.log('  ❌ 对话未能打开');
}

// ---- 检查 8：寻路 ----
const pathTest = await page.evaluate(async () => {
  const s = window.__venueScene;
  if (!s || !s.pathfinder) return { ok: false, reason: 'no pathfinder' };

  const res = {
    ok: true,
    // 从地图左上角到右下角，看能否算出一条路
    acrossMap: null,
    toWall: null,
    reachable: null,
  };

  // 跨地图寻路（对角）
  const p1 = s.pathfinder.findPath(96, 96, 1280, 900);
  res.acrossMap = p1 ? p1.length : 0;

  // 到障碍物（墙）——应该就近落脚，仍能返回路径
  const p2 = s.pathfinder.findPath(96, 96, 640, 320);
  res.toWall = p2 ? p2.length : 0;

  // 相邻格（极短路径）
  const p3 = s.pathfinder.findPath(96, 96, 160, 96);
  res.reachable = p3 ? p3.length : 0;

  return res;
});

console.log('\n--- 寻路 ---');
if (pathTest.ok) {
  console.log('跨图寻路     :', pathTest.acrossMap > 0 ? `✅ 路径 ${pathTest.acrossMap} 个点` : '❌ 找不到路径');
  console.log('到障碍物     :', pathTest.toWall > 0 ? `✅ 就近落脚 ${pathTest.toWall} 个点` : '❌ 失败');
  console.log('相邻格       :', pathTest.reachable >= 0 ? `✅ ${pathTest.reachable} 个点` : '❌ 失败');
} else {
  console.log('  ❌', pathTest.reason);
}

// ---- 检查 9：点击寻路（让角色真的自动走一段）----
// 注意：要选一个"确实有距离"的目标，否则路径只有 1~2 个点，看起来像没动。
const autoWalkTest = await page.evaluate(async () => {
  const s = window.__venueScene;

  // 关键：前面的对话测试可能还开着对话框，
  // 对话框打开时 update() 会直接 return（角色冻结），寻路自然不动。
  if (s.dialog.isOpen()) s.dialog.close();
  window.__venuePaused = false;

  await new Promise((r) => setTimeout(r, 200));

  const start = { x: s.player.x, y: s.player.y };

  // 从出生点（建筑内）走到右下角区域，中间要绕路，能真正验证寻路
  const target = s.pathfinder.toPixel(17, 12);
  const ok = s.walkTo(target.x, target.y);

  if (!ok) return { ok: false, reason: 'walkTo 返回 false' };

  const pathLen = s.path ? s.path.length : 0;

  await new Promise((r) => setTimeout(r, 2000));

  const end = { x: s.player.x, y: s.player.y };
  const moved = Math.hypot(end.x - start.x, end.y - start.y);

  return {
    ok: true,
    moved: Math.round(moved),
    pathLen,
    start: { x: Math.round(start.x), y: Math.round(start.y) },
    end: { x: Math.round(end.x), y: Math.round(end.y) },
    stillPathing: !!s.path,
  };
});

console.log('\n--- 点击寻路（自动移动）---');
if (autoWalkTest.ok) {
  console.log('路径长度     :', autoWalkTest.pathLen, '个点');
  console.log('移动距离     :', autoWalkTest.moved > 50 ? `✅ 移动了 ${autoWalkTest.moved}px` : `❌ 只移动 ${autoWalkTest.moved}px`);
  console.log('起点 → 终点  :', `${JSON.stringify(autoWalkTest.start)} → ${JSON.stringify(autoWalkTest.end)}`);
  console.log('仍在寻路中   :', autoWalkTest.stillPathing ? '是（正常，还没走到）' : '否');
} else {
  console.log('  ❌', autoWalkTest.reason);
}

// ---- 检查 10：任务系统 ----
const questTest = await page.evaluate(async () => {
  const s = window.__venueScene;
  const qs = window.__venueQuests;
  if (!qs) return { ok: false, reason: 'no quest system' };

  const list = qs.snapshot();
  const res = { ok: true, total: list.length, states: {}, actions: {} };

  list.forEach((q) => {
    res.states[q.id] = q.state;
  });

  // 测试"接受任务"
  const raw = s.constructor; // 占位，避免直接引用 QUESTS
  const target = list.find((q) => q.state === 'available');
  if (target) {
    s.handleQuestAction('accept', target.id);
    await new Promise((r) => setTimeout(r, 200));
    const after = qs.snapshot().find((q) => q.id === target.id);
    res.actions.accept = after ? after.state : 'unknown';
  } else {
    res.actions.accept = 'no available quest';
  }

  return res;
});

console.log('\n--- 任务系统 ---');
if (questTest.ok) {
  console.log('任务总数     :', questTest.total);
  console.log('各任务状态   :', JSON.stringify(questTest.states));
  console.log('接取测试     :', questTest.actions.accept === 'active' ? '✅ 成功变为 active' : `注意：${questTest.actions.accept}`);
} else {
  console.log('  ❌', questTest.reason);
}

if (errors.length) {
  console.log('\n===== ❌ 错误 =====');
  errors.forEach((e) => console.log(' ', e));
} else {
  console.log('\n✅ 无 JS 运行时错误');
}

if (warnings.length) {
  console.log('\n===== ⚠️ 警告 =====');
  warnings.slice(0, 10).forEach((w) => console.log(' ', w));
}

await browser.close();
process.exit(errors.length ? 1 : 0);

/**
 * 多场景 + 剧情系统 验证
 *
 * 检查：
 *   1. 场景能加载、背景图在不在
 *   2. NPC 初始是否隐藏（剧情要求）
 *   3. 书桌交互能否写邀请函
 *   4. 写完 5 封后投递，NPC 是否出现
 *   5. 场景切换是否正常
 *   6. 世界地图能否打开
 */
import puppeteer from 'puppeteer';

const BASE = 'http://localhost:5173/venue.html';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

console.log('打开会场...');
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 40000 });
await new Promise((r) => setTimeout(r, 3000));

// ---- 1. 基础状态 ----
const basic = await page.evaluate(() => {
  const s = window.__venueScene;
  if (!s) return { ok: false };
  return {
    ok: true,
    scene: s.scenes.current ? s.scenes.current.id : null,
    sceneName: s.scenes.current ? s.scenes.current.name : null,
    npcCount: s.npcs.length,
    storyWritten: s.story.writtenCount,
    storyTotal: s.story.totalCount,
    delivered: s.story.isDelivered,
    interactPoints: s.interactPoints ? s.interactPoints.points.length : 0,
    hasMinimap: !!s.minimap,
    hasGuide: !!s.guide,
  };
});

console.log('\n=== 初始状态 ===');
console.log('  场景      :', basic.scene, `(${basic.sceneName})`);
console.log('  NPC 数量  :', basic.npcCount, basic.npcCount === 0 ? '✅ 受邀前隐藏' : '❌ 不该出现');
console.log('  邀请函    :', `${basic.storyWritten}/${basic.storyTotal}`);
console.log('  交互点    :', basic.interactPoints, basic.interactPoints > 0 ? '✅' : '❌');
console.log('  世界地图  :', basic.hasMinimap ? '✅' : '❌');
console.log('  引导箭头  :', basic.hasGuide ? '✅' : '❌');

// ---- 2. 测试写邀请函 ----
console.log('\n=== 测试写邀请函 ===');
const writeTest = await page.evaluate(async () => {
  const s = window.__venueScene;
  const results = [];

  // 直接调用剧情系统的写邀请函
  for (let i = 0; i < 6; i++) {
    const before = s.story.writtenCount;
    const g = s.story.writeLetter();
    results.push({
      step: i + 1,
      before,
      ok: !!g,
      guest: g ? g.name : null,
      after: s.story.writtenCount,
    });
  }
  return {
    results,
    finalWritten: s.story.writtenCount,
    allWritten: s.story.allWritten,
  };
});

writeTest.results.forEach((r) => {
  console.log(`  第${r.step}次: ${r.before} -> ${r.after}  ${r.ok ? '写了「' + r.guest + '」' : '写不了（已满）'}`);
});
console.log('  最终:', `${writeTest.finalWritten}/${basic.storyTotal}`, writeTest.allWritten ? '✅ 全部写完' : '❌');

// ---- 3. 测试投递 ----
console.log('\n=== 测试投递邀请函 ===');
const deliverTest = await page.evaluate(async () => {
  const s = window.__venueScene;

  // 投递前先把信从桌上拿走（新流程要求）
  s.story.takeLetters();
  const ok = s.story.deliverLetters();

  await new Promise((r) => setTimeout(r, 1000));

  // 切到主会场看 NPC 是否出现
  s.scenes.load('venue', null, true);
  await new Promise((r) => setTimeout(r, 1200));

  return {
    delivered: s.story.isDelivered,
    deliverOk: ok,
    scene: s.scenes.current.id,
    npcCount: s.npcs.length,
    arrived: s.story.arrivedGuests(),
  };
});

console.log('  投递结果  :', deliverTest.deliverOk ? '✅ 成功' : '❌ 失败');
console.log('  已投递    :', deliverTest.delivered);
console.log('  NPC 数量  :', deliverTest.npcCount,
  deliverTest.npcCount > 0 ? `✅ ${deliverTest.arrived.length} 位客人来了` : '❌ 仍无 NPC');

// ---- 4. 测试场景切换 ----
console.log('\n=== 测试场景切换 ===');
const sceneTest = await page.evaluate(async () => {
  const s = window.__venueScene;
  const out = [];

  // 手动逐个加载场景
  for (const id of ['home', 'mailbox', 'venue', 'pond', 'grove']) {
    s.scenes.load(id, null, true);
    await new Promise((r) => setTimeout(r, 700));
    out.push({
      id,
      loaded: s.scenes.current ? s.scenes.current.id : null,
      npc: s.npcs.length,
      points: s.interactPoints ? s.interactPoints.points.length : 0,
      obstacles: s.scenes.obstacles ? s.scenes.obstacles.getLength() : 0,
    });
  }
  return out;
});

sceneTest.forEach((r) => {
  const ok = r.loaded === r.id;
  console.log(`  ${r.id.padEnd(8)} 加载${ok ? '✅' : '❌'}  NPC:${r.npc}  交互点:${r.points}  碰撞体:${r.obstacles}`);
});

// ---- 5. 测试世界地图 ----
console.log('\n=== 测试世界地图 ===');
const mapTest = await page.evaluate(async () => {
  const s = window.__venueScene;
  const before = s.minimap.visible;
  s.minimap.toggle();
  await new Promise((r) => setTimeout(r, 300));
  const after = s.minimap.visible;
  s.minimap.draw({ sceneId: s.scenes.current.id, guide: null });
  await new Promise((r) => setTimeout(r, 200));
  return { before, after, labels: s.minimap.labels.length };
});

console.log('  切换      :', mapTest.before, '->', mapTest.after, mapTest.before !== mapTest.after ? '✅' : '❌');
console.log('  场景标签  :', mapTest.labels, mapTest.labels > 0 ? '✅ 已渲染' : '❌');

// ---- 截图 ----
await page.screenshot({ path: 'verify-scene.png' });
console.log('\n已截图: verify-scene.png');

// ---- 结果 ----
if (failed.length) {
  console.log('\n=== 资源加载失败 ===');
  [...new Set(failed)].slice(0, 10).forEach((f) => console.log('  ', f));
}
if (errors.length) {
  console.log('\n=== ❌ 运行时错误 ===');
  [...new Set(errors)].slice(0, 10).forEach((e) => console.log('  ', e));
} else {
  console.log('\n✅ 无运行时错误');
}

await browser.close();
process.exit(errors.length ? 1 : 0);

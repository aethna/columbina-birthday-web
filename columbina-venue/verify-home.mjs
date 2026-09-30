/**
 * 首页 + 会场 联调验证
 *
 * 检查：
 *   1. 首页能加载、content.json 能读到
 *   2. 卡片数量正确（小游戏 3 + 单品 3）
 *   3. "进入会场"按钮指向正确
 *   4. 会场能打开、且有"返回首页"
 *   5. 首页 → 会场 → 首页 往返通畅
 */

import puppeteer from 'puppeteer';

const BASE = process.env.BASE_URL || 'http://localhost:5173';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
const failedUrls = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});
page.on('requestfailed', (r) => failedUrls.push(`[requestfailed] ${r.url()}`));
page.on('response', (r) => {
  if (r.status() >= 400) failedUrls.push(`[HTTP ${r.status()}] ${r.url()}`);
});

// ===================== 首页 =====================
console.log('=== 首页 ===');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const home = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.card')];
  const sections = [...document.querySelectorAll('.section')];
  return {
    title: document.title,
    heroTitle: document.getElementById('site-title')?.textContent,
    enterHref: document.getElementById('enter-btn')?.getAttribute('href'),
    sectionCount: sections.length,
    sectionTitles: sections.map((s) => s.querySelector('h2')?.textContent),
    cardCount: cards.length,
    cardNames: cards.map((c) => c.querySelector('.card-name')?.textContent),
    starCount: document.querySelectorAll('#stars i').length,
    hasError: !!document.querySelector('#loading'),
  };
});

console.log('页面标题   :', home.title);
console.log('主标题     :', home.heroTitle);
console.log('分区数     :', home.sectionCount, home.sectionTitles);
console.log('卡片数     :', home.cardCount, home.cardNames.join(' / '));
console.log('星点数     :', home.starCount);
console.log('进入会场   :', home.enterHref, home.enterHref === 'venue.html' ? '✅' : '❌');
console.log('加载报错   :', home.hasError ? '❌ 内容没加载出来' : '✅ 无');

await page.screenshot({ path: 'verify-home.png', fullPage: false });
console.log('已截图: verify-home.png');

// ===================== 会场 =====================
console.log('\n=== 会场 ===');
await page.goto(`${BASE}/venue.html`, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));

const venue = await page.evaluate(() => {
  const s = window.__venueScene;
  return {
    sceneOk: !!s,
    npcCount: s ? s.npcs.length : 0,
    backHref: document.getElementById('back-home')?.getAttribute('href'),
    backVisible: (() => {
      const el = document.getElementById('back-home');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })(),
    canvasOk: !!document.querySelector('#game-root canvas'),
  };
});

console.log('场景       :', venue.sceneOk ? `✅ 已创建（${venue.npcCount} NPC）` : '❌ 未创建');
console.log('Canvas     :', venue.canvasOk ? '✅' : '❌');
console.log('返回首页   :', venue.backHref, venue.backVisible ? '✅ 可见' : '❌ 不可见');

await page.screenshot({ path: 'verify-venue.png' });
console.log('已截图: verify-venue.png');

// ===================== 往返跳转 =====================
console.log('\n=== 跳转往返 ===');
const nav = {};

// 会场 → 首页
// 注意：要等页面真正就绪再点，否则按钮还没渲染出来，click 会点到空处。
await page.goto(`${BASE}/venue.html`, { waitUntil: 'networkidle2' });
await page.waitForSelector('#back-home', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 400));
await page.click('#back-home');
await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 500));
nav.backToHome = page.url().includes('index.html') || page.url().endsWith('/');
nav.backUrl = page.url();

// 首页 → 会场
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.waitForSelector('#enter-btn', { timeout: 10000 });
await page.click('#enter-btn');
await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 600));
nav.homeToVenue = page.url().includes('venue.html');
nav.venueUrl = page.url();

// 首页卡片 → 小游戏
// 注意：点击卡片会导致页面跳转，evaluate 的执行上下文会被销毁，
//       所以先取出 URL，再用 page.goto 过去验证，不要在同一次 evaluate 里等跳转。
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));

const firstCardUrl = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.card')].find((c) => c.dataset.url);
  return card ? card.dataset.url : null;
});

let gameNav = { ok: false };
if (!firstCardUrl) {
  gameNav.reason = '没有配置好链接的卡片';
} else {
  await page.goto(`${BASE}/${firstCardUrl}`, { waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1000));
  const hasGame = await page.evaluate(() => !!document.querySelector('#cv'));
  gameNav = { ok: true, url: firstCardUrl, landed: page.url(), hasGame };
}

console.log('会场→首页  :', nav.backToHome ? '✅' : '❌');
console.log('首页→会场  :', nav.homeToVenue ? '✅' : '❌');
console.log('卡片→小游戏:', gameNav.ok
  ? `${gameNav.url} → ${gameNav.hasGame ? '✅ 游戏元素已加载' : '⚠️ 页面打开但未检测到游戏'}`
  : `❌ ${gameNav.reason}`);

// ===================== 结果 =====================
if (failedUrls.length) {
  console.log('\n===== 资源失败 =====');
  [...new Set(failedUrls)].forEach((u) => console.log(' ', u));
}

if (errors.length) {
  console.log('\n===== ❌ 错误 =====');
  [...new Set(errors)].forEach((e) => console.log(' ', e));
} else {
  console.log('\n✅ 无运行时错误');
}

await browser.close();
process.exit(errors.length ? 1 : 0);

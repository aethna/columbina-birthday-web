/**
 * 「进入会场页面」截图验收
 *   node _shoot-enter.mjs
 * 产出 venue/_enter_*.png + _enter_report.txt
 *
 * 需要 vite 已经在 5173 跑着（在 venue/ 下：node node_modules/vite/bin/vite.js --port 5173 --strictPort）
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;
const REPORT = path.resolve(__dirname, '..', '_enter_report.txt');

const BASE = process.env.BASE || 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = [];
function log(m) { lines.push(m); console.log(m); }

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console: ' + m.text());
  });

  log('=== 进入会场页面验收 ===');
  log(`URL: ${BASE}/enter.html`);

  const t0 = Date.now();
  await page.goto(`${BASE}/enter.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 按时间点连拍
  const shots = [
    [450,  '_enter_a_fadein.png',   '黑幕刚淡出，星云开始点亮'],
    [1300, '_enter_b_rising.png',   '星球正在升起（遮罩揭开中）'],
    [2600, '_enter_c_planet.png',   '星球基本到位，文字浮现'],
    [4200, '_enter_d_full.png',     '完整画面 + 进度条'],
  ];
  for (const [ms, file, note] of shots) {
    const wait = ms - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    await page.screenshot({ path: path.join(OUT, file) });
    log(`  ${String(ms).padStart(5)}ms  ${file}   ${note}`);
  }

  // DOM 状态
  const state = await page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    return {
      planetClass: g('planet').className,
      skyClass: g('sky').className,
      captionClass: g('caption').className,
      barWidth: g('bar').style.width,
      hasSkip: !!g('skip'),
      bgReady: getComputedStyle(g('planet')).backgroundImage.includes('enter-venue.png'),
    };
  });
  log('');
  log('DOM 状态: ' + JSON.stringify(state));

  // 等它自己跳转到会场
  log('');
  log('等待自动跳转到 venue.html …');
  await page.waitForFunction(
    () => location.pathname.endsWith('venue.html'),
    { timeout: 15000 },
  ).catch(() => null);
  const landed = page.url();
  log(`  落地页: ${landed}`);
  await sleep(900);
  await page.screenshot({ path: path.join(OUT, '_enter_e_arrived.png') });
  log('  _enter_e_arrived.png   已经进到会场');

  log('');
  log('运行时报错: ' + (errs.length ? '\n  ' + errs.join('\n  ') : '无'));

  await browser.close();
  await fs.writeFile(REPORT, lines.join('\n') + '\n', 'utf8');
  console.log('\n报告写入: ' + REPORT);
}

main().catch((e) => { console.error(e); process.exit(1); });

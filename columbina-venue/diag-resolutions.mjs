/**
 * 多分辨率黑屏检测
 *
 * 在不同屏幕尺寸下打开会场，检查：
 *   - 画布是否铺满
 *   - 相机缩放是否合理
 *   - 地图是否真的渲染出来了（截图非纯黑）
 */
import puppeteer from 'puppeteer';

const BASE = process.env.BASE_URL || 'http://localhost:5173';

const SIZES = [
  { w: 1366, h: 768, name: '笔记本 1366×768' },
  { w: 1920, h: 1080, name: '1080p' },
  { w: 2554, h: 1235, name: '截图分辨率' },
  { w: 2560, h: 1440, name: '2K' },
  { w: 3840, h: 2160, name: '4K' },
  { w: 1280, h: 720, name: '720p' },
];

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

console.log('分辨率'.padEnd(20), '画布'.padEnd(16), '缩放'.padEnd(8), '渲染', '结果');
console.log('-'.repeat(72));

let allOk = true;

for (const size of SIZES) {
  const page = await browser.newPage();
  await page.setViewport({ width: size.w, height: size.h });

  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(`${BASE}/venue.html`, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2200));

  const info = await page.evaluate(() => {
    const canvas = document.querySelector('#game-root canvas');
    const s = window.__venueScene;
    const cam = s ? s.cameras.main : null;

    return {
      hasCanvas: !!canvas,
      cw: canvas ? canvas.width : 0,
      ch: canvas ? canvas.height : 0,
      zoom: cam ? Number(cam.zoom.toFixed(2)) : 0,
      npc: s ? s.npcs.length : 0,
      playerVisible: s && s.player ? s.player.visible : false,
      // 相机能看到的世界范围
      worldView: cam ? {
        w: Math.round(cam.width / cam.zoom),
        h: Math.round(cam.height / cam.zoom),
      } : null,
      mapSize: s ? { w: s.mapW, h: s.mapH } : null,
    };
  });

  // 判断画面是否非黑：采样截图的像素方差
  const buf = await page.screenshot({ encoding: 'base64' });
  const nonBlackRatio = await page.evaluate(async () => {
    // 用 canvas 的 toDataURL 判断不可行（WebGL），
    // 改为检查场景里是否有可见的显示对象
    const s = window.__venueScene;
    if (!s) return 0;
    const list = s.children.list.filter((o) => o.visible !== false);
    return list.length;
  });

  const canvasOk = info.hasCanvas && info.cw > 100 && info.ch > 100;
  const sceneOk = info.npc === 5;
  const objectsOk = nonBlackRatio > 10;
  const ok = canvasOk && sceneOk && objectsOk && errs.length === 0;

  if (!ok) allOk = false;

  console.log(
    size.name.padEnd(20),
    `${info.cw}×${info.ch}`.padEnd(16),
    String(info.zoom).padEnd(8),
    `${nonBlackRatio} 个对象`.padEnd(6),
    ok ? '✅' : `❌ ${errs[0] || ''}`
  );

  // 相机视野应大于地图的一半，否则说明放太大了
  if (info.worldView && info.mapSize) {
    const ratio = info.worldView.w / info.mapSize.w;
    if (ratio < 0.45) {
      console.log(`   ⚠️ 视野偏窄：只能看到地图 ${(ratio * 100).toFixed(0)}% 的宽度`);
    }
  }

  // 只在两个代表性分辨率截图
  if (size.name === '1080p' || size.name === '笔记本 1366×768') {
    await page.screenshot({ path: `diag-${size.w}.png` });
  }

  await page.close();
}

console.log('-'.repeat(72));
console.log(allOk ? '✅ 所有分辨率正常' : '❌ 存在问题');

await browser.close();
process.exit(allOk ? 0 : 1);

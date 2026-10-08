/**
 * 旧场景重绘后的实机验收：5 张场景各截两张 ——
 *   _old_<id>_play.png   纯游玩视角（看新底图清不清晰）
 *   _old_<id>_walk.png   F1 可走区叠加（绿=可走 红=挡住，看碰撞表和重绘后美术对不对得上）
 *
 * 用法：cd venue && & $node _shoot-oldscenes.mjs
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';

const URL = 'http://localhost:5173/venue.html';
const ROOT = 'D:\\DSH工作区\\哥伦比娅生日会';
const SCENES = ['home', 'mailbox', 'venue', 'pond', 'grove'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(6000);

  // 把主线推到底，让 13 位客人到场（顺便看 NPC 和新底图贴不贴）
  await page.evaluate(() => {
    const s = window.__venueScene;
    s.story.reset();
    for (let i = 0; i < 12; i++) s.story.writeLetter();
    s.story.deliverLetters();
  });

  for (const id of SCENES) {
    await page.evaluate((sid) => {
      const s = window.__venueScene;
      s.scenes.load(sid, null, true);
      const cfg = s.scenes.current;
      const t = cfg.spawn || { tileX: 20, tileY: 12 };
      s.player.setPosition(t.tileX * 64 + 32, t.tileY * 64 + 32);
    }, id);
    await sleep(1400);
    await page.screenshot({ path: `${ROOT}\\venue\\_old_${id}_play.png` });
    log.push(`${id} play  截图完成`);

    // F1 打开可走区
    await page.keyboard.down('F1');
    await sleep(260);
    await page.keyboard.up('F1');
    await sleep(700);
    await page.screenshot({ path: `${ROOT}\\venue\\_old_${id}_walk.png` });
    log.push(`${id} walk  截图完成（F1 叠加）`);

    // 关掉，免得影响下一张
    await page.keyboard.down('F1');
    await sleep(260);
    await page.keyboard.up('F1');
    await sleep(400);
  }

  // 顺带确认世界地图仍然 10 个节点
  await page.keyboard.down('M');
  await sleep(300);
  await page.keyboard.up('M');
  await sleep(900);
  await page.screenshot({ path: `${ROOT}\\venue\\_old_minimap.png` });
  log.push('世界地图截图完成');

  log.push('');
  log.push(`运行时错误：${errors.length ? errors.join(' | ') : '无'}`);
} catch (e) {
  log.push('💥 ' + (e.stack || e));
} finally {
  await browser.close();
  fs.writeFileSync(`${ROOT}\\_oldscenes_shot_log.txt`, log.join('\n'), 'utf8');
  console.log(log.join('\n'));
  process.exit(0);
}

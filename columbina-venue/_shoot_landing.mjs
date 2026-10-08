// 拍「落点」实拍：从会场进冰原、从冰原回会场，看玩家是不是站在回程光圈旁边
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

// 关掉任务面板，画面干净点
await p.evaluate(async () => {
  const s = window.__venueScene;
  const { SCENES } = await import('/src/scenes.js');
  const sc = SCENES.find((x) => x.id === 'venue');
  s.scenes.switching = false;
  s.scenes.load('venue', { tileX: sc.spawn.tileX, tileY: sc.spawn.tileY }, true);
  await new Promise((r) => setTimeout(r, 1200));
});

const hop = async (from, to) => {
  const info = await p.evaluate(async (from, to) => {
    const s = window.__venueScene;
    const { SCENES } = await import('/src/scenes.js');
    s.scenes.switching = false;
    const sc = SCENES.find((x) => x.id === from);
    s.scenes.load(from, { tileX: sc.spawn.tileX, tileY: sc.spawn.tileY }, true);
    await new Promise((r) => setTimeout(r, 800));
    s.scenes.goThrough(sc.exits.find((e) => e.to === to));
    await new Promise((r) => setTimeout(r, 2600));
    const back = SCENES.find((x) => x.id === to).exits.find((e) => e.to === from);
    // 把回程光圈画个记号，方便肉眼看清楚玩家站得多近
    const g = s.add.graphics().setDepth(9999);
    g.lineStyle(3, 0xff3366, 1).strokeRect(back.tileX * 64, back.tileY * 64, back.w * 64, back.h * 64);
    return { scene: s.scenes.current.id, tileX: Math.floor(s.player.x / 64), tileY: Math.floor(s.player.y / 64) };
  }, from, to);
  await sleep(600);
  await p.screenshot({ path: `${OUT}\\_land_${to}.png` });
  console.log(`${from} -> ${to}`, JSON.stringify(info));
};

await hop('venue', 'icefield');
await hop('icefield', 'venue');
await hop('venue', 'mailbox');

await b.close();

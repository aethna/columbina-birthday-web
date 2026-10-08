// 验收：8 方向行走（斜向行走）
// 用法：在 venue/ 目录下 node _verify_diag.mjs
//
// 验的是「真的斜着走」，而不是只看代码：
//   1. 雪碧图变成 8 列 × 8 行，64 帧；
//   2. 8 个方向都有 walk 动画，每个 8 帧；
//   3. 同时按住两个方向键 → playerDir 是斜向名、播的是斜向动画、
//      帧号落在斜向那一行；
//   4. 位移向量真的是斜的（|dx| 和 |dy| 接近相等且都非零）；
//   5. 松开后回到 idle-<斜向>；
//   6. 单键仍然正常（四个正方向没被改坏）。
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会';
const DIRS = ['down', 'left', 'right', 'up', 'downright', 'downleft', 'upright', 'upleft'];
const ROW = { down: 0, left: 1, right: 2, up: 3, downright: 4, downleft: 5, upright: 6, upleft: 7 };

const lines = [];
const errs = [];
const ok = (c, m) => { lines.push(`${c ? '✅' : '❌'} ${m}`); if (!c) errs.push(m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const pageErrs = [];
page.on('pageerror', (e) => pageErrs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrs.push('[console] ' + m.text()); });

await page.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle2' });
await wait(7000);

ok(await page.evaluate(() => !!window.__venueScene), 'window.__venueScene 已挂载');

// ---------- 1. 雪碧图规格 ----------
const sheet = await page.evaluate(() => {
  const s = window.__venueScene;
  const info = s.playerInfo || {};
  const key = info.key || 'char-player';
  const tex = s.textures.get(key);
  const src = tex.getSourceImage();
  return {
    key,
    cols: info.cols,
    framesPerDir: info.framesPerDir,
    fw: info.frameWidth,
    fh: info.frameHeight,
    w: src.width,
    h: src.height,
    total: tex.frameTotal,
  };
});
lines.push(`   主角纹理 ${sheet.key}  贴图 ${sheet.w}x${sheet.h}  frameTotal=${sheet.total}  cols=${sheet.cols}`);
ok(sheet.w === 1536 && sheet.h === 1536, `雪碧图 1536x1536（实测 ${sheet.w}x${sheet.h}）`);
ok(sheet.cols === 8, `列数 = 8（实测 ${sheet.cols}）`);
for (const d of DIRS) {
  ok(sheet.framesPerDir && sheet.framesPerDir[d] === 8, `framesPerDir.${d} = 8（实测 ${sheet.framesPerDir && sheet.framesPerDir[d]}）`);
}

// ---------- 2. 8 个动画都存在且各 8 帧 ----------
const anims = await page.evaluate((dirs) => {
  const s = window.__venueScene;
  const key = (s.playerInfo && s.playerInfo.key) || 'char-player';
  const out = {};
  for (const d of dirs) {
    const wk = `${key}-walk-${d}`;
    const ik = `${key}-idle-${d}`;
    out[d] = {
      walk: s.anims.exists(wk) ? s.anims.get(wk).frames.length : null,
      idle: s.anims.exists(ik) ? s.anims.get(ik).frames.length : null,
      walkKey: wk,
      idleKey: ik,
    };
  }
  return out;
}, DIRS);
for (const d of DIRS) {
  ok(anims[d].walk === 8, `动画 ${anims[d].walkKey} 存在且 8 帧（实测 ${anims[d].walk}）`);
  ok(anims[d].idle === 1, `动画 ${anims[d].idleKey} 存在且 1 帧（实测 ${anims[d].idle}）`);
}

// ---------- 工具：换到会场中央的空地上，避免撞墙影响位移判定 ----------
async function resetPlayer() {
  await page.evaluate(async () => {
    const s = window.__venueScene;
    if (s.scenes.current.id !== 'venue') {
      s.scenes.load('venue', null, true);
      await new Promise((r) => setTimeout(r, 500));
    }
    const px = 20 * 64 + 32, py = 12 * 64 + 32;
    s.player.setPosition(px, py);
    if (s.player.body) s.player.body.reset(px, py);
  });
  await wait(350);
}
await resetPlayer();

// ---------- 3. 双向同按 → 斜向 ----------
const CASES = [
  { keys: ['ArrowRight', 'ArrowDown'], dir: 'downright', dx: +1, dy: +1 },
  { keys: ['ArrowLeft', 'ArrowDown'], dir: 'downleft', dx: -1, dy: +1 },
  { keys: ['ArrowRight', 'ArrowUp'], dir: 'upright', dx: +1, dy: -1 },
  { keys: ['ArrowLeft', 'ArrowUp'], dir: 'upleft', dx: -1, dy: -1 },
];

const KEYCODES = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };

// 松开按键必须把两个键放在【同一个 JS 任务】里一起松开。
// 原本写成 `for (const k of keys) await page.keyboard.up(k)`：两次 CDP 往返之间
// 会插进一帧 rAF，游戏先看到「只剩一个方向按着」，于是把 playerDir 改成那个正方向；
// 等第二个键也松开时 dirNameFrom(0,0) 返回 null，代码用 `|| this.playerDir` 保留旧值，
// 结果停在正方向的 idle 上。这是测试时序造成的假失败，不是游戏 bug ——
// 真机上「先松一个手指再松另一个」本来就该转向那个正方向。
async function release(keys) {
  await page.evaluate((pairs) => {
    for (const [k, c] of pairs) {
      const ev = new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: () => c });
      Object.defineProperty(ev, 'which', { get: () => c });
      window.dispatchEvent(ev);
    }
  }, keys.map((k) => [k, KEYCODES[k]]));
}

async function hold(keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await wait(ms);
  const r = await page.evaluate(() => {
    const s = window.__venueScene;
    const anim = s.player.anims.currentAnim;
    return {
      x: s.player.x, y: s.player.y,
      dir: s.playerDir,
      anim: anim ? anim.key : null,
      frame: Number(s.player.frame.name),
      animating: s.player.anims.isPlaying,
    };
  });
  await release(keys);
  return r;
}

lines.push('');
lines.push('—— 斜向：同时按住两个方向键 ——');
for (const c of CASES) {
  await resetPlayer();
  const before = await page.evaluate(() => ({ x: window.__venueScene.player.x, y: window.__venueScene.player.y }));
  const r = await hold(c.keys, 520);
  const dx = r.x - before.x, dy = r.y - before.y;
  const wantAnim = anims[c.dir].walkKey;
  const row = ROW[c.dir];
  const inRow = r.frame >= row * 8 && r.frame < row * 8 + 8;

  lines.push(`   ${c.keys.join('+')} → dir=${r.dir}  anim=${r.anim}  frame=${r.frame}  Δ=(${dx.toFixed(1)}, ${dy.toFixed(1)})`);
  ok(r.dir === c.dir, `${c.keys.join('+')} → playerDir = ${c.dir}（实测 ${r.dir}）`);
  ok(r.anim === wantAnim, `${c.keys.join('+')} → 播放斜向动画 ${wantAnim}（实测 ${r.anim}）`);
  ok(inRow, `${c.keys.join('+')} → 帧号 ${r.frame} 落在第 ${row} 行（${row * 8}~${row * 8 + 7}）`);
  ok(Math.abs(dx) > 5 && Math.abs(dy) > 5, `${c.keys.join('+')} → 两个轴都真的动了（Δx=${dx.toFixed(1)}, Δy=${dy.toFixed(1)}）`);
  ok(Math.abs(Math.abs(dx) - Math.abs(dy)) < Math.abs(dx) * 0.25, `${c.keys.join('+')} → 位移是 45°（|dx|=${Math.abs(dx).toFixed(1)} |dy|=${Math.abs(dy).toFixed(1)}，误差 <25%）`);
  ok(Math.sign(dx) === c.dx && Math.sign(dy) === c.dy, `${c.keys.join('+')} → 位移方向与按键一致`);

  await wait(260);
  const idle = await page.evaluate(() => ({
    anim: window.__venueScene.player.anims.currentAnim ? window.__venueScene.player.anims.currentAnim.key : null,
  }));
  ok(idle.anim === anims[c.dir].idleKey, `${c.keys.join('+')} 松开后回到 ${anims[c.dir].idleKey}（实测 ${idle.anim}）`);
}

// ---------- 4. 单键回归（四个正方向没被改坏） ----------
lines.push('');
lines.push('—— 回归：单个方向键 ——');
const SINGLE = [
  { keys: ['ArrowDown'], dir: 'down', dx: 0, dy: +1 },
  { keys: ['ArrowUp'], dir: 'up', dx: 0, dy: -1 },
  { keys: ['ArrowLeft'], dir: 'left', dx: -1, dy: 0 },
  { keys: ['ArrowRight'], dir: 'right', dx: +1, dy: 0 },
];
for (const c of SINGLE) {
  await resetPlayer();
  const before = await page.evaluate(() => ({ x: window.__venueScene.player.x, y: window.__venueScene.player.y }));
  const r = await hold(c.keys, 400);
  const dx = r.x - before.x, dy = r.y - before.y;
  const row = ROW[c.dir];
  const inRow = r.frame >= row * 8 && r.frame < row * 8 + 8;
  lines.push(`   ${c.keys[0]} → dir=${r.dir}  anim=${r.anim}  frame=${r.frame}  Δ=(${dx.toFixed(1)}, ${dy.toFixed(1)})`);
  ok(r.dir === c.dir, `${c.keys[0]} → playerDir = ${c.dir}（实测 ${r.dir}）`);
  ok(r.anim === anims[c.dir].walkKey, `${c.keys[0]} → 播放 ${anims[c.dir].walkKey}`);
  ok(inRow, `${c.keys[0]} → 帧号 ${r.frame} 落在第 ${row} 行`);
  ok(Math.abs(dx) > 5 || Math.abs(dy) > 5, `${c.keys[0]} → 真的在动`);
  await wait(260);
}

// ---------- 5. 截图：8 个方向各来一张（看得出姿态不同） ----------
lines.push('');
lines.push('—— 截图 ——');
await resetPlayer();
const SHOT = [
  ['down', ['ArrowDown']],
  ['downright', ['ArrowRight', 'ArrowDown']],
  ['downleft', ['ArrowLeft', 'ArrowDown']],
  ['upright', ['ArrowRight', 'ArrowUp']],
  ['upleft', ['ArrowLeft', 'ArrowUp']],
  ['up', ['ArrowUp']],
  ['left', ['ArrowLeft']],
  ['right', ['ArrowRight']],
];
for (const [name, keys] of SHOT) {
  await resetPlayer();
  for (const k of keys) await page.keyboard.down(k);
  await wait(300);
  await page.screenshot({ path: `${OUT}\\venue\\_diag_${name}.png` });
  for (const k of keys) await page.keyboard.up(k);
  await wait(150);
}
// 八方向拼一张对照（利用 F2 全图模式不合适，这里交给 python 拼）
lines.push('   已输出 venue/_diag_<dir>.png 共 8 张');

// ---------- 6. 运行时报错 ----------
ok(pageErrs.length === 0, `无运行时报错（实测 ${pageErrs.length} 条）`);
for (const e of pageErrs.slice(0, 8)) lines.push(`   ${e.slice(0, 200)}`);

lines.push('');
lines.push(`总断言：${errs.length === 0 ? '✅ 全部通过' : `❌ ${errs.length} 条失败`}（共 ${lines.filter((l) => l.startsWith('✅') || l.startsWith('❌')).length} 条）`);

fs.writeFileSync(`${OUT}\\_verify_diag_report.txt`, lines.join('\n'), 'utf8');
await browser.close();
console.log('OK');

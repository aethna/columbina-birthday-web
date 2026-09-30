// 验证「左右移动时腿在动」——
// 连续拍同一方向的多个时刻，横向拼起来，直接看腿部轮廓有没有交替。
//
// 为什么要专门写这个脚本：
//   _shoot-feet.mjs 每个方向只拍一帧，只能证明"能显示"，
//   证明不了"在动"。腿动不动必须看【时间序列】。
import puppeteer from 'puppeteer';
import path from 'node:path';

const OUT = 'D:\\DSH工作区\\哥伦比娅生日会\\venue';
const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise(r => setTimeout(r, 3500));
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await new Promise(r => setTimeout(r, 6000));
await p.addStyleTag({ content: '#quest-panel,#quest-list,aside{display:none!important}' });

// 先报告动画注册情况 —— 帧数/帧率错了这里能直接看出来
const animInfo = await p.evaluate(() => {
  const s = window.__venueScene;
  const out = {};
  for (const d of ['down', 'left', 'right', 'up']) {
    const k = `${s.playerInfo.key}-walk-${d}`;
    const a = s.anims.get(k);
    out[d] = a ? { frames: a.frames.length, rate: a.frameRate } : null;
  }
  return { key: s.playerInfo.key, cols: s.playerInfo.cols,
           framesPerDir: s.playerInfo.framesPerDir,
           frame: [s.playerInfo.frameWidth, s.playerInfo.frameHeight],
           anims: out };
});
console.log('动画注册:', JSON.stringify(animInfo, null, 1));

const tag = process.argv[2] || 'walk';
const results = [];

for (const [key, dir] of [['s', 'down'], ['a', 'left'], ['d', 'right'], ['w', 'up']]) {
  await p.evaluate(async () => {
    const s = window.__venueScene;
    s.scenes.load('home', null, true);
    await new Promise(r => setTimeout(r, 900));
  });
  await new Promise(r => setTimeout(r, 900));

  await p.keyboard.down(key);
  await new Promise(r => setTimeout(r, 350));

  const shots = [];
  // 每 120ms 拍一张 —— 调慢后帧率约 6~8fps，这个间隔能覆盖一个完整循环
  for (let i = 0; i < 8; i++) {
    const pos = await p.evaluate(() => {
      const s = window.__venueScene, cam = s.cameras.main;
      return {
        sx: (s.player.x - cam.worldView.x) * cam.zoom,
        sy: (s.player.y - cam.worldView.y) * cam.zoom,
        anim: s.player.anims.currentAnim ? s.player.anims.currentAnim.key : null,
        frame: s.player.anims.currentFrame ? s.player.anims.currentFrame.index : null,
      };
    });
    const fn = path.join(OUT, `_walkseq_${tag}_${dir}_${i}.png`);
    await p.screenshot({
      path: fn,
      clip: {
        x: Math.max(0, Math.min(1280 - 140, Math.round(pos.sx - 70))),
        y: Math.max(0, Math.min(720 - 200, Math.round(pos.sy - 175))),
        width: 140, height: 200,
      },
    });
    shots.push(`${fn}  anim=${pos.anim} frame=${pos.frame}`);
    await new Promise(r => setTimeout(r, 120));
  }
  await p.keyboard.up(key);
  await new Promise(r => setTimeout(r, 250));
  results.push({ dir, shots });
}

for (const r of results) {
  console.log(`\n--- ${r.dir} ---`);
  r.shots.forEach(s => console.log('  ' + s));
}
await b.close();

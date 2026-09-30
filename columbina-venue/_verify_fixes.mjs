// 本轮 4 项修复的专项核查
//
//   1. 交互点提示不再出现 [object Object]
//   2. 5 个道具落在用户标注的格子上，且互不重复
//   3. 主线完成后状态是 completed、进度是 100%，且从列表消失
//   4. 绿色版本提示条已隐藏
import puppeteer from 'puppeteer';

const b = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-http-cache'],
  protocolTimeout: 180000,
});
const p = await b.newPage();
await p.setCacheEnabled(false);
await p.setViewport({ width: 1280, height: 720 });
const errs = [];
p.on('pageerror', (e) => errs.push('ERR ' + e.message.slice(0, 160)));

await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 3500));
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 6500));

const results = [];
const rec = (n, name, pass, detail) => results.push({ n, name, pass, detail });

// ---------- 1. 交互点提示没有 [object Object] ----------
try {
  const r = await p.evaluate(async () => {
    const s = window.__venueScene;
    // 去池塘，那里有「水边 / 取水处」这类交互点
    s.scenes.load('pond', null, true);
    await new Promise((r) => setTimeout(r, 1800));

    // 把玩家挪到交互点旁边，让提示条出现
    const pts = s.interactPoints.points;
    if (!pts.length) return { err: '池塘没有交互点' };
    const pt = pts[0];
    s.player.setPosition(pt.x, pt.y + 40);
    s.handleProximity();
    await new Promise((r) => setTimeout(r, 300));

    const txt = s.npcTip.text || '';
    return {
      tipText: txt,
      visible: s.npcTip.visible,
      hasObjObj: txt.includes('[object Object]'),
      iconText: pt.iconText,
      label: pt.label,
    };
  });
  rec(1, '交互点提示无 [object Object]',
      !r.hasObjObj && r.tipText.length > 0,
      `提示="${r.tipText.replace(/\n/g, ' / ')}"  iconText=${r.iconText} label=${r.label}`);
} catch (e) {
  rec(1, '交互点提示无 [object Object]', false, e.message);
}

// ---------- 2. 道具点位 ----------
try {
  const r = await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import('/src/quests.js')).QUESTS;
    const props = Q.filter((q) => q.propReward)
      .map((q) => ({ id: q.propReward.id, name: q.propReward.name,
                     tileX: q.propReward.tileX, tileY: q.propReward.tileY }));
    // 用户标注的 10 个允许格子
    const allowed = [[20,5],[10,6],[25,7],[6,9],[8,13],[36,13],[33,14],[30,15],[29,17],[26,18]];
    const key = (a, b) => `${a},${b}`;
    const aset = new Set(allowed.map((c) => key(c[0], c[1])));
    const used = props.map((x) => key(x.tileX, x.tileY));
    return {
      props,
      allInAllowed: used.every((u) => aset.has(u)),
      noDup: new Set(used).size === used.length,
      outliers: props.filter((x) => !aset.has(key(x.tileX, x.tileY))),
      allowedCount: allowed.length,
    };
  });
  rec(2, '5 个道具在标注格内且互不重复',
      r.allInAllowed && r.noDup,
      r.props.map((x) => `${x.name}(${x.tileX},${x.tileY})`).join(' ')
        + `  越界=${r.outliers.length} 个  不重复=${r.noDup}`);
} catch (e) {
  rec(2, '5 个道具在标注格内且互不重复', false, e.message);
}

// ---------- 3. 主线完成后的状态与进度 ----------
try {
  const r = await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import('/src/quests.js')).QUESTS;
    const mw = Q.find((x) => x.id === 'main-write');
    const md = Q.find((x) => x.id === 'main-deliver');

    // ★ 流程改版（2026-09-28）后，这一步是「把桌上的信收起来」
    //
    //   旧写法是直接把 lettersWritten 塞满来模拟「写完了」，
    //   但写信环节已经删掉，main-write 的进度现在看的是 carriedCount（已收起）。
    //   所以这里改成真的调用 takeLetters()，走一遍真实的收起动作。
    s.story.data.lettersWritten = ['npc-ainuo', 'npc-nefer', 'npc-philins', 'npc-sandrone', 'npc-lawuma'];
    s.story.data.onDesk = 5;
    s.story.takeLetters();
    await new Promise((r) => setTimeout(r, 400));

    const afterWrite = {
      state: s.quests.getState(mw),
      progress: s.quests.getProgress(mw),
      counts: s.quests.getCounts(mw),
    };

    // 模拟「已投递」
    s.story.data.delivered = true;
    s.story.notify('deliver');
    await new Promise((r) => setTimeout(r, 600));

    const afterDeliver = {
      state: s.quests.getState(md),
      progress: s.quests.getProgress(md),
      counts: s.quests.getCounts(md),
    };

    // 列表里还该不该出现主线
    const shown = [...document.querySelectorAll('#quest-list .quest-item .quest-title span:first-child')]
      .map((e) => e.textContent);
    const mainShown = shown.filter((t) => t.includes('主线'));

    return { afterWrite, afterDeliver, mainShown };
  });

  const ok = r.afterWrite.state === 'completed'
    && r.afterWrite.progress === 1
    && r.afterWrite.counts.got === 5 && r.afterWrite.counts.need === 5
    && r.afterDeliver.state === 'completed'
    && r.afterDeliver.progress === 1
    && r.mainShown.length === 0;

  rec(3, '主线完成后显示已完成且进度正确', ok,
      `写完=${r.afterWrite.state} ${r.afterWrite.counts.got}/${r.afterWrite.counts.need} (${Math.round(r.afterWrite.progress * 100)}%)  `
    + `投递=${r.afterDeliver.state} ${Math.round(r.afterDeliver.progress * 100)}%  `
    + `列表残留主线=${r.mainShown.length}`);
} catch (e) {
  rec(3, '主线完成后显示已完成且进度正确', false, e.message);
}

// ---------- 4. 版本提示条已隐藏 ----------
try {
  const r = await p.evaluate(() => {
    const s = window.__venueScene;
    return { exists: !!s.verLabel, showFlag: window.__venueShowVer === true };
  });
  rec(4, '绿色版本提示条已隐藏', !r.exists && !r.showFlag,
      `verLabel 存在=${r.exists}  强制显示开关=${r.showFlag}`);
} catch (e) {
  rec(4, '绿色版本提示条已隐藏', false, e.message);
}

console.log('\n================ 本轮修复核查 ================');
let passN = 0;
for (const r of results) {
  console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} 任务${r.n}  ${r.name}`);
  console.log(`         ${r.detail}`);
  if (r.pass) passN++;
}
console.log(`\n${passN}/${results.length} 通过`);
console.log('\n运行时报错:', errs.length ? [...new Set(errs)].slice(0, 4).join('\n') : '无');
await b.close();

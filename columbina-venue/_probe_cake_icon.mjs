// 探针：庆功宴开起来之后，「切蛋糕」交互点到底有没有出现在画面上？
//
// 用户 m10959 追加反馈：「结局任务出现后，切蛋糕的互动点没看到。」
//
// 要查清楚三件事：
//   ① rebuild 之后 interactPoints.points 里到底有没有 ip-party-cake
//   ② 它的 marker / icon / labelObj 各自的 visible 是什么
//   ③ 如果 visible 但看不见，是被谁盖住了 —— 遍历显示列表，
//      找出「在该点坐标上、depth 比它大」的可见对象
//
// 跑法（必须在 venue/ 目录下）：node _probe_cake_icon.mjs
import puppeteer from 'puppeteer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 300000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto('http://localhost:5173/venue.html', { waitUntil: 'networkidle2', timeout: 90000 });
await sleep(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle2', timeout: 90000 });
await sleep(6500);

const out = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { QUESTS } = await import('/src/quests.js');

  s.scenes.load('venue', { tileX: 20, tileY: 18 }, true);
  await new Promise((r) => setTimeout(r, 1200));
  s.story.data.lettersWritten = s.story.snapshot().letters.map((l) => l.id);
  s.story.data.delivered = true;
  s.story.save();
  s.quests.reset();
  await new Promise((r) => setTimeout(r, 400));
  QUESTS.filter((q) => q.id !== 'q-party-cake')
    .forEach((q) => { s.quests.data.states[q.id] = 'completed'; });
  s.quests.save();
  s.maybeStartParty();
  await new Promise((r) => setTimeout(r, 2400));

  const all = s.interactPoints.points || [];
  const cake = all.find((x) => x.id === 'ip-party-cake');
  const cakeState = (s.quests.snapshot().find((q) => q.id === 'q-party-cake') || {}).state;

  const desc = (o) => (o ? {
    visible: !!o.visible,
    alpha: o.alpha,
    depth: o.depth,
    x: o.x, y: o.y,
  } : null);

  // 该点坐标上、depth 更大且可见的对象 —— 就是「盖住它」的嫌疑人
  // ★ 用真实包围盒判定（大桌子那种精灵，它的 x/y 原点可能离蛋糕点很远，
  //   靠「中心点距离」会漏掉它）
  let cover = [];
  if (cake && cake.icon) {
    const px = cake.icon.x, py = cake.icon.y;
    const d0 = cake.icon.depth;
    cover = s.children.list
      .filter((o) => {
        if (o === cake.icon || o === cake.labelObj || o === cake.marker) return false;
        if (!o.visible || typeof o.depth !== 'number' || o.depth <= d0) return false;
        if (typeof o.getBounds !== 'function') return false;
        try {
          const bb = o.getBounds();
          return px >= bb.x && px <= bb.x + bb.width
            && py >= bb.y && py <= bb.y + bb.height;
        } catch { return false; }
      })
      .map((o) => {
        const bb = o.getBounds();
        return {
          type: o.type,
          key: o.texture ? o.texture.key : (o.text || ''),
          depth: o.depth,
          bounds: [Math.round(bb.x), Math.round(bb.y),
            Math.round(bb.width), Math.round(bb.height)],
        };
      })
      .slice(0, 25);
  }

  return {
    party: !!s.party,
    partyTalk: s.partyTalk,
    cakeState,
    pointCount: all.length,
    pointIds: all.map((x) => x.id),
    cake: cake ? {
      x: cake.x, y: cake.y, tileX: cake.tileX, tileY: cake.tileY,
      scene: cake.scene,
      marker: desc(cake.marker),
      icon: desc(cake.icon),
      label: desc(cake.labelObj),
      labelText: cake.labelText,
      iconVisibleFlag: cake.icon ? cake.icon.visible : null,
    } : null,
    cover,
  };
});

console.log(JSON.stringify(out, null, 2));
await b.close();

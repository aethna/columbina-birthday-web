// 落点验收：从 A 穿过传送圈到 B，落在 B 的哪个格子
// 规则（SceneManager.goThrough）：落点 = B.exits[to A].toTile
//   即「到达新地图后，站在回程光圈旁边，然后穿过整张地图去远端传送圈」。
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

const fail = [];
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) fail.push(msg); };

// 期望：A -> B 落在 B 里 hints[A] 说的格子
const hops = [
  { from: 'venue', to: 'icefield', want: [7, 8] },
  { from: 'icefield', to: 'venue', want: [36, 10] },
  { from: 'venue', to: 'mailbox', want: [16, 2] },
  { from: 'mailbox', to: 'venue', want: [20, 20] },
  { from: 'home', to: 'mailbox', want: null },
  { from: 'mailbox', to: 'home', want: null },
  { from: 'icefield', to: 'pools', want: null },
  { from: 'pools', to: 'icefield', want: null },
];

for (const h of hops) {
  const r = await p.evaluate(async (from, to) => {
    const s = window.__venueScene;
    const { SCENES } = await import('/src/scenes.js');
    const sc = SCENES.find((x) => x.id === from);
    const ex = sc.exits.find((e) => e.to === to);
    s.scenes.switching = false;
    s.scenes.load(from, { tileX: sc.spawn.tileX, tileY: sc.spawn.tileY }, true);
    await new Promise((res) => setTimeout(res, 900));
    s.scenes.goThrough(ex);
    await new Promise((res) => setTimeout(res, 2600));
    const { MAP_ROWS } = await import('/src/scenes.js');
    const rows = MAP_ROWS[to];
    const tx = Math.floor(s.player.x / 64), ty = Math.floor(s.player.y / 64);
    const wall = rows[ty] ? rows[ty][tx] : '?';
    // 目标场景里「通回 from」那个光圈的位置，量一下落点离它多远
    const back = SCENES.find((x) => x.id === to).exits.find((e) => e.to === from);
    const d = back
      ? Math.max(Math.abs(tx - (back.tileX + back.w / 2)), Math.abs(ty - (back.tileY + back.h / 2)))
      : -1;
    return { cur: s.scenes.current.id, tx, ty, wall, d: Math.round(d * 10) / 10 };
  }, h.from, h.to);

  const tag = `${h.from} → ${h.to}`;
  if (h.want) {
    ok(r.cur === h.to && r.tx === h.want[0] && r.ty === h.want[1],
      `${tag} 落在 (${r.tx},${r.ty})，期望 (${h.want[0]},${h.want[1]})`);
  } else {
    ok(r.cur === h.to && r.wall === '.', `${tag} 落在 (${r.tx},${r.ty}) 可走=${r.wall === '.'}`);
  }
  console.log(`   ${tag}  → 场景 ${r.cur} 格 (${r.tx},${r.ty}) 地形 ${r.wall} 离回程光圈 ${r.d} 格`);
}

await b.close();
console.log(fail.length ? `\n❌ ${fail.length} 项失败` : '\n✅ 全部通过');
process.exit(fail.length ? 1 : 0);

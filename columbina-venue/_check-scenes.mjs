// 场景拓扑自检：格子连通性、光圈/落点合法性、环状结构
// 用法：在 venue/ 目录下 node _check-scenes.mjs
import { SCENES, SCENE_MAPS, SCENE_COLS, SCENE_ROWS } from './src/scenes.js';

const errs = [];
const warn = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------- 1. 每个场景的地图行数/列数 ----------
for (const sc of SCENES) {
  const g = SCENE_MAPS[sc.id];
  ok(!!g, `场景 ${sc.id} 没有 MAP_ROWS`);
  if (!g) continue;
  ok(g.length === SCENE_ROWS, `${sc.id} 行数 ${g.length} != ${SCENE_ROWS}`);
  g.forEach((row, y) => {
    ok(row.length === SCENE_COLS, `${sc.id} 第 ${y} 行列数 ${row.length} != ${SCENE_COLS}`);
  });
}

// ---------- 2. 光圈格子必须可走；落点必须【在本场景】可走 ----------
// 注意语义（见 SceneManager.goThrough）：出口 A→B 上的 toTileX/toTileY 是
// 「回到 A 时站在哪」，也就是【A 自己的】落点，不是 B 的。
const byId = Object.fromEntries(SCENES.map((s) => [s.id, s]));
for (const sc of SCENES) {
  const g = SCENE_MAPS[sc.id];
  for (const ex of sc.exits || []) {
    for (let y = ex.tileY; y < ex.tileY + ex.h; y++) {
      for (let x = ex.tileX; x < ex.tileX + ex.w; x++) {
        ok(g[y] && g[y][x] === '.', `${sc.id}→${ex.to} 光圈格 (${x},${y}) 是墙`);
      }
    }
    ok(!!SCENE_MAPS[ex.to], `${sc.id}→${ex.to} 目标场景不存在`);
    // 落点在本场景必须可走
    const t = g[ex.toTileY];
    ok(t && t[ex.toTileX] === '.', `${sc.id}→${ex.to} 落点 (${ex.toTileX},${ex.toTileY}) 在【本场景 ${sc.id}】是墙`);
    // 落点不能落在本场景自己的光圈里，否则进门就被弹回去
    const inside = (sc.exits || []).some((e2) =>
      ex.toTileX >= e2.tileX && ex.toTileX < e2.tileX + e2.w &&
      ex.toTileY >= e2.tileY && ex.toTileY < e2.tileY + e2.h);
    ok(!inside, `${sc.id}→${ex.to} 落点 (${ex.toTileX},${ex.toTileY}) 落在本场景的光圈内（会来回弹）`);
    // 而且必须能从落点走到本场景的这个光圈（否则回不来）
    const seen = new Set();
    const stack = [[ex.toTileX, ex.toTileY]];
    let reach = false;
    while (stack.length) {
      const [x, y] = stack.pop();
      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      if (x < 0 || y < 0 || x >= SCENE_COLS || y >= SCENE_ROWS) continue;
      if (g[y][x] !== '.') continue;
      if (x >= ex.tileX && x < ex.tileX + ex.w && y >= ex.tileY && y < ex.tileY + ex.h) { reach = true; break; }
      seen.add(k);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    ok(reach, `${sc.id}→${ex.to} 的落点走不到自己的光圈`);
  }
  // spawn 必须可走
  const sg = g[sc.spawn.tileY];
  ok(sg && sg[sc.spawn.tileX] === '.', `${sc.id} spawn (${sc.spawn.tileX},${sc.spawn.tileY}) 是墙`);
}

// ---------- 2b. 出生点/落点不能落在本场景的光圈椭圆里 ----------
// SceneManager 把光圈画成一个椭圆（rx=86 ry=44），站进去就切场景。
// 如果出生点/落点正好压在椭圆里，玩家一落地就被自动弹回上一个场景 ——
// moonpath 的出生点 (3,11) 就是这么踩的坑。
const T = 64, RX = 86, RY = 44, EDGE_GAP = 54;
const SCENE_W = 40 * T, SCENE_H = 24 * T;
const SAFE_K = 1.35;   // 椭圆归一化半径的平方；>1 已在外面，留 1.35 做安全余量
function portalCenters(cfg) {
  return (cfg.exits || []).map((ex) => {
    const exX = ex.tileX * T, exY = ex.tileY * T, exW = ex.w * T, exH = ex.h * T;
    const tl = exX <= 0, tr = exX + exW >= SCENE_W, tt = exY <= 0, tb = exY + exH >= SCENE_H;
    let px = exX + exW / 2, py = exY + exH / 2;
    if (tr) px = SCENE_W - EDGE_GAP - RX;
    if (tl) px = EDGE_GAP + RX;
    if (tt) py = EDGE_GAP + RY;
    if (tb) py = SCENE_H - EDGE_GAP - RY;
    px = Math.max(RX + 20, Math.min(SCENE_W - RX - 20, px));
    py = Math.max(RY + 20, Math.min(SCENE_H - RY - 20, py));
    return { to: ex.to, px, py };
  });
}
for (const sc of SCENES) {
  const cs = portalCenters(sc);
  const check = (tileX, tileY, what) => {
    const x = tileX * T + 32, y = tileY * T + 32;
    for (const c of cs) {
      const k = ((x - c.px) / RX) ** 2 + ((y - c.py) / RY) ** 2;
      ok(k > SAFE_K,
        `${sc.id} 的${what} (${tileX},${tileY}) 压在通往 ${c.to} 的光圈里 (k=${k.toFixed(2)} ≤ ${SAFE_K}) → 一落地就自己弹走`);
    }
  };
  check(sc.spawn.tileX, sc.spawn.tileY, 'spawn');
  for (const ex of sc.exits) check(ex.toTileX, ex.toTileY, `出口→${ex.to} 的落点`);
}

// ---------- 3. 图论：每个场景有 2 个不同邻居，整体是一个环 ----------
const adj = Object.fromEntries(SCENES.map((s) => [s.id, new Set()]));
for (const sc of SCENES) {
  for (const ex of sc.exits || []) {
    if (!adj[ex.to]) errs.push(`${sc.id} 指向不存在的场景 ${ex.to}`);
    else { adj[ex.to].add(sc.id); adj[sc.id].add(ex.to); }
  }
}
for (const [id, nb] of Object.entries(adj)) {
  if (nb.size !== 2) errs.push(`场景 ${id} 的邻居数 ${nb.size} != 2（不是简单环）`);
}
// 从 home 出发能走遍所有场景
if (adj.home) {
  const seen = new Set(['home']);
  let cur = 'home', prev = null;
  for (let i = 0; i < SCENES.length + 2; i++) {
    const nxt = [...adj[cur]].find((n) => n !== prev) || [...adj[cur]][0];
    if (!nxt || nxt === 'home') break;
    if (seen.has(nxt)) { errs.push(`环在 ${nxt} 提前闭合`); break; }
    seen.add(nxt); prev = cur; cur = nxt;
  }
  ok(seen.size === SCENES.length, `环只覆盖 ${seen.size}/${SCENES.length} 个场景：环上缺 ${SCENES.filter((s) => !seen.has(s.id)).map((s) => s.id).join(',')}`);
}

// ---------- 4. 每个场景的可走区必须连通（从 spawn 洪泛） ----------
for (const sc of SCENES) {
  const g = SCENE_MAPS[sc.id];
  if (!g) continue;
  const seen = new Set();
  const stack = [[sc.spawn.tileX, sc.spawn.tileY]];
  while (stack.length) {
    const [x, y] = stack.pop();
    const k = `${x},${y}`;
    if (seen.has(k)) continue;
    if (x < 0 || y < 0 || x >= SCENE_COLS || y >= SCENE_ROWS) continue;
    if (g[y][x] !== '.') continue;
    seen.add(k);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  let total = 0;
  for (let y = 0; y < SCENE_ROWS; y++) for (let x = 0; x < SCENE_COLS; x++) if (g[y][x] === '.') total++;
  if (seen.size !== total) warn.push(`${sc.id}: 从 spawn 只能走到 ${seen.size}/${total} 格（有孤岛）`);
}

// ---------- 5. 小地图 LAYOUT 必须覆盖所有场景 ----------
import { readFileSync } from 'node:fs';
const mini = readFileSync(new URL('./src/Minimap.js', import.meta.url), 'utf8');
const block = mini.match(/const LAYOUT = \{([\s\S]*?)\n\};/);
if (!block) errs.push('Minimap.js 里找不到 LAYOUT');
else {
  const keys = [...block[1].matchAll(/^\s*([a-z]+)\s*:/gm)].map((m) => m[1]);
  for (const s of SCENES) if (!keys.includes(s.id)) errs.push(`Minimap.js LAYOUT 缺少场景 ${s.id}`);
  for (const k of keys) if (!SCENES.find((s) => s.id === k)) errs.push(`Minimap.js LAYOUT 有多余节点 ${k}`);
}

// ---------- 输出 ----------
const lines = [];
lines.push(`场景数：${SCENES.length}  ${SCENES.map((s) => s.id).join(' → ')}`);
lines.push('');
for (const sc of SCENES) {
  const g = SCENE_MAPS[sc.id];
  let total = 0;
  for (let y = 0; y < SCENE_ROWS; y++) for (let x = 0; x < SCENE_COLS; x++) if (g[y][x] === '.') total++;
  lines.push(`${sc.id.padEnd(10)} ${sc.name.padEnd(5)} 可走 ${String(total).padStart(3)} 格  spawn(${sc.spawn.tileX},${sc.spawn.tileY})`);
  for (const ex of sc.exits) lines.push(`   └→ ${ex.to.padEnd(10)} 光圈(${ex.tileX},${ex.tileY} ${ex.w}x${ex.h}) 落点(${ex.toTileX},${ex.toTileY})`);
}
lines.push('');
lines.push(errs.length ? `❌ 错误 ${errs.length} 项：` : '✅ 拓扑/碰撞/连通性 全部通过');
errs.forEach((e) => lines.push('  - ' + e));
if (warn.length) { lines.push(`⚠️ 警告 ${warn.length} 项：`); warn.forEach((w) => lines.push('  - ' + w)); }
lines.push(`运行时报错：${errs.length ? errs.length : '无'}`);

const out = 'D:\\DSH工作区\\哥伦比娅生日会\\_scenes_report.txt';
const { writeFileSync } = await import('node:fs');
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
process.exit(errs.length ? 1 : 0);

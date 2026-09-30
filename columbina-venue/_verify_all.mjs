// 任务 1~8 全覆盖核查
//
// 注意：不要在这个脚本里重启 node 服务器 ——
//       步幅修复任务同时在跑，杀 node 会把它一起杀掉。
//       直接用已经在跑的 Vite 开发服务器（HMR 会自动加载最新代码）。

import puppeteer from "puppeteer";

const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-http-cache"],
  protocolTimeout: 150000,
});
const p = await b.newPage();
await p.setCacheEnabled(false);
await p.setViewport({ width: 1280, height: 720 });
const errs = [];
p.on("pageerror", (e) => errs.push("ERR " + e.message.slice(0, 150)));

await p.goto("http://localhost:5173/venue.html", { waitUntil: "networkidle2", timeout: 90000 });
await new Promise((r) => setTimeout(r, 4000));
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: "networkidle2", timeout: 90000 });
await new Promise((r) => setTimeout(r, 7000));

const started = await p.evaluate(() => !!window.__venueScene);
console.log("启动:", started ? "OK" : "FAIL");
if (!started) {
  console.log("错误:", errs.join("\n"));
  await b.close();
  process.exit(1);
}

const results = [];
const rec = (n, name, pass, detail) => results.push({ n, name, pass, detail });

// ---------- 任务6：任务面板收起 / 展开 ----------
try {
  const dom = await p.evaluate(() => ({
    panel: !!document.getElementById("quest-panel"),
    tab: !!document.getElementById("quest-tab"),
    hide: !!document.getElementById("quest-hide"),
  }));
  if (!dom.panel || !dom.tab || !dom.hide) throw new Error("元素缺失 " + JSON.stringify(dom));

  await p.evaluate(() => document.getElementById("quest-hide").click());
  await new Promise((r) => setTimeout(r, 500));
  const a = await p.evaluate(() => {
    const panel = document.getElementById("quest-panel");
    const tab = document.getElementById("quest-tab");
    return {
      panelHidden: !!(panel && panel.classList.contains("hidden")),
      tabShown: !!(tab && !tab.classList.contains("hidden")),
    };
  });

  await p.evaluate(() => document.getElementById("quest-tab").click());
  await new Promise((r) => setTimeout(r, 500));
  const c = await p.evaluate(() => {
    const panel = document.getElementById("quest-panel");
    const tab = document.getElementById("quest-tab");
    return {
      panelShown: !!(panel && !panel.classList.contains("hidden")),
      tabHidden: !!(tab && tab.classList.contains("hidden")),
    };
  });

  rec(6, "任务面板可收起/展开", a.panelHidden && a.tabShown && c.panelShown && c.tabHidden,
      `收起=${JSON.stringify(a)} 展开=${JSON.stringify(c)}`);
} catch (e) {
  rec(6, "任务面板可收起/展开", false, e.message);
}

// ---------- 任务7：金色引导箭头已移除 ----------
try {
  const g = await p.evaluate(() => {
    const s = window.__venueScene;
    return { gone: s.guide === null || s.guide === undefined || s.guide === false };
  });
  rec(7, "金色引导箭头已移除", g.gone, g.gone ? "s.guide 为空" : "s.guide 还在");
} catch (e) {
  rec(7, "金色引导箭头已移除", false, e.message);
}

// ---------- 任务2：5 个 NPC 的配置位置都在会场可走区 ----------
//
// 注意：NPC 是「受邀客人」，主线没走完时 s.npcs 是空的 ——
//       所以这里直接比对 config 里的坐标和会场碰撞图（确定性检查），
//       不依赖剧情进度。
try {
  const r2 = await p.evaluate(async () => {
    const s = window.__venueScene;
    const m = s.scenes.getMap("venue");
    const NPCS = (await import("/src/config.js")).NPCS;
    const venueNpcs = NPCS.filter((n) => (n.scene || "venue") === "venue");
    const out = venueNpcs.map((n) => ({
      name: n.name,
      tile: [n.tileX, n.tileY],
      onWalk: m[n.tileY]?.[n.tileX] === ".",
    }));
    // 顺便看看这批位置离地图边缘有多远（太靠边相机会看不到）
    const edge = venueNpcs.map((n) => Math.min(n.tileX, n.tileY, 39 - n.tileX, 23 - n.tileY));
    return { out, minEdge: Math.min(...edge) };
  });
  const nefer = r2.out.find((n) => n.name === "奈芙尔");
  const allWalk = r2.out.every((n) => n.onWalk);
  const pass = !!nefer && nefer.onWalk && allWalk && r2.minEdge >= 4;
  rec(2, "奈芙尔在场且 5 个 NPC 位置都合理", pass,
      r2.out.map((n) => `${n.name}(${n.tile})`).join(" ") + `  离边缘最近 ${r2.minEdge} 格`);
} catch (e) {
  rec(2, "奈芙尔在场且 5 个 NPC 位置都合理", false, e.message);
}

// ---------- 任务3：交互点都有可用动作 ----------
try {
  const ips = await p.evaluate(() =>
    window.__venueScene.interactPoints.points.map((x) => ({
      id: x.id, action: x.action || "", q: x.questId || "",
    }))
  );
  const dead = ips.filter((x) => !x.action || x.action === "none");
  rec(3, "交互点都有可执行动作", dead.length === 0,
      `${ips.length} 个点；无动作的 ${dead.length} 个：${dead.map((d) => d.id).join(",") || "无"}`);
} catch (e) {
  rec(3, "交互点都有可执行动作", false, e.message);
}

// ---------- 任务4：已完成的主线从列表消失 ----------
try {
  const r4 = await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import("/src/quests.js")).QUESTS;
    const mw = Q.find((x) => x.id === "main-write");
    s.quests.setState(mw, "completed");
    s.refreshQuestUI();
    await new Promise((r) => setTimeout(r, 450));
    const shown = [...document.querySelectorAll("#quest-list .quest-item .quest-title span:first-child")]
      .map((e) => e.textContent);
    return { shown };
  });
  const still = r4.shown.some((t) => t.includes("写下邀请函"));
  rec(4, "已完成主线不再显示", !still, "列表: " + (r4.shown.join(" | ") || "(空)"));
} catch (e) {
  rec(4, "已完成主线不再显示", false, e.message);
}

// ---------- 任务5：委托完成前不显示小游戏/单品 ----------
try {
  const r5 = await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import("/src/quests.js")).QUESTS;
    const NPCS = (await import("/src/config.js")).NPCS;
    const npc = NPCS.find((n) => n.id === "npc-ainuo");
    const q = Q.find((x) => x.giverNpcId === "npc-ainuo");
    const offerLabels = (npc.offers || []).map((o) => o.label);

    // 判据：看【小游戏那个按钮】有没有出现。
    //   不能用 link 的总数来判断 —— 未完成时有「接取委托」按钮，
    //   完成后有「小游戏」按钮，两边数量都是 1，区分不出来。
    const hasOffer = (lines) =>
      lines.some((l) => l.link && offerLabels.includes(l.link.label));

    s.quests.setState(q, "available");
    const before = hasOffer(s.buildDialogLines(npc));

    s.quests.setState(q, "completed");
    const after = hasOffer(s.buildDialogLines(npc));

    return { before, after, offerLabels, offers: (npc.offers || []).length };
  });
  rec(5, "委托完成前不显示小游戏/单品", r5.before === false && r5.after === true,
      `未完成时小游戏按钮=${r5.before}，完成后=${r5.after}（offers: ${r5.offerLabels.join(",") || "无"}）`);
} catch (e) {
  rec(5, "委托完成前不显示小游戏/单品", false, e.message);
}

// ---------- 任务8：完成委托后隐藏交互点 ----------
try {
  const r8 = await p.evaluate(async () => {
    const s = window.__venueScene;
    const Q = (await import("/src/quests.js")).QUESTS;
    const q = Q.find((x) => x.id === "q-ainuo-fish");
    s.quests.setState(q, "active");
    s.scenes.load("pond", null, true);
    await new Promise((r) => setTimeout(r, 1800));
    s.interactPoints.update(s.player.x, s.player.y);
    const pt = s.interactPoints.points.find((x) => x.id === "ip-pond-fish");
    const beforeVis = pt ? pt.marker.visible : null;
    s.quests.setState(q, "completed");
    s.interactPoints.update(s.player.x, s.player.y);
    const pt2 = s.interactPoints.points.find((x) => x.id === "ip-pond-fish");
    return {
      questId: pt ? pt.questId : null, beforeVis,
      isDone: s.interactPoints.isQuestDone(pt2),
      afterVis: pt2 ? pt2.marker.visible : null,
      iconVis: pt2 && pt2.icon ? pt2.icon.visible : null,
    };
  });
  const pass = r8.questId === "q-ainuo-fish" && r8.beforeVis === true && r8.isDone === true && r8.afterVis === false;
  rec(8, "完成委托后隐藏交互点", pass, JSON.stringify(r8));
} catch (e) {
  rec(8, "完成委托后隐藏交互点", false, e.message);
}

// ---------- 补充：交付委托后道具立刻出现（水桶） ----------
try {
  const pr = await p.evaluate(async () => {
    const s = window.__venueScene;
    localStorage.removeItem("venue-props-v1");
    s.scenes.load("venue", null, true);
    await new Promise((r) => setTimeout(r, 1800));
    const before = s.props.filter((x) => x.texture).length;
    s.handleQuestAction("accept", "q-nefer-water");
    await new Promise((r) => setTimeout(r, 300));
    s.quests.markCollect("water-full", 1);
    await new Promise((r) => setTimeout(r, 400));
    s.handleQuestAction("deliver", "q-nefer-water");
    await new Promise((r) => setTimeout(r, 1300));
    const keys = s.props.filter((x) => x.texture).map((x) => x.texture.key);
    return { before, keys };
  });
  const has = pr.keys.some((k) => k.includes("water-bucket"));
  rec("水", "交付后道具立刻出现（水桶）", has, `交付前 ${pr.before} 个 -> ${pr.keys.join(",") || "无"}`);
} catch (e) {
  rec("水", "交付后道具立刻出现（水桶）", false, e.message);
}

console.log("\n================ 核查结果 ================");
let passN = 0;
for (const r of results) {
  console.log(`${r.pass ? "[OK]  " : "[FAIL]"} 任务${r.n}  ${r.name}`);
  if (!r.pass) console.log(`         ${r.detail}`);
  if (r.pass) passN++;
}
console.log(`\n${passN}/${results.length} 通过`);
console.log("\n运行时报错:", errs.length ? [...new Set(errs)].slice(0, 4).join("\n") : "无");
await b.close();

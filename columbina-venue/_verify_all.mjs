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

// ---------- 任务2：NPC 分散到各场景，都站在可走格上、相互不重叠 ----------
//
// ★ 2026-10-09（§二十八）规则变了：
//   以前 13 位客人都挤在会场、靠「站到 '#' 禁行格上」来避免和哥伦比娅重叠；
//   现在客人分散到 8 个场景，各自站在**可走格**上（人得站在实地上），
//   改由「立绘的世界包围盒换算成格子 → 这些格子全部注册成禁行」来防重叠。
//   这里只做确定性检查（不依赖剧情进度）：落点合法 + 四邻有可走格 + 两两不重叠。
//   占格是否真的被封死，由 venue/_verify_round7.mjs 在客人到场后实测。
try {
  const r2 = await p.evaluate(async () => {
    const s = window.__venueScene;
    const NPCS = (await import("/src/config.js")).NPCS;
    const out = NPCS.map((n) => {
      const sid = n.scene || "venue";
      const m = s.scenes.getMap(sid);
      const x = n.tileX, y = n.tileY;
      const neigh = [[x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]]
        .map(([nx, ny]) => m[ny]?.[nx]);
      return {
        id: n.id, name: n.name, scene: sid,
        tile: [x, y],
        walkable: m[y]?.[x] === ".",
        neighFree: neigh.filter((c) => c === ".").length,
        // 立绘是「脚底对齐锚点、向上长出 displayHeight」
        sprTop: y * 64 + 32 - (n.displayHeight || 150),
        sprBottom: y * 64 + 32 + 16,
      };
    });
    // 同一场景内两两间距
    let minDist = Infinity, minPair = null;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (out[i].scene !== out[j].scene) continue;
        const d = Math.hypot(out[i].tile[0] - out[j].tile[0], out[i].tile[1] - out[j].tile[1]);
        if (d < minDist) { minDist = d; minPair = `${out[i].name}/${out[j].name}`; }
      }
    }
    const scenes = [...new Set(out.map((n) => n.scene))];
    return { out, minDist, minPair, scenes, count: NPCS.length };
  });
  const bad = r2.out.filter((n) => !n.walkable || n.neighFree === 0);
  const clipped = r2.out.filter((n) => n.sprTop < 0 || n.sprBottom > 1536);
  const pass = r2.count === 14 && r2.scenes.length >= 8 && bad.length === 0
            && clipped.length === 0 && r2.minDist >= 2.9;
  rec(2, "14 位 NPC 分散到 8 个场景，都站在可走格且互相不重叠", pass,
      `${r2.count} 位 / ${r2.scenes.length} 个场景；同场景最小间距 ${r2.minDist === Infinity ? "n/a" : r2.minDist.toFixed(1)} 格` +
      ` (${r2.minPair || "-"})；立绘被切 ${clipped.length} 位` +
      (bad.length
        ? "  异常: " + bad.map((n) => `${n.name}@${n.scene}(${n.tile}) walkable=${n.walkable} 四邻可走=${n.neighFree}`).join(" ")
        : "") +
      (clipped.length
        ? "  被切: " + clipped.map((n) => `${n.name}(${n.tile}) top=${n.sprTop}`).join(" ")
        : ""));
} catch (e) {
  rec(2, "14 位客人位置合理", false, e.message);
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
  const still = r4.shown.some((t) => t.includes("写邀请函"));
  const hasDeliver = r4.shown.some((t) => t.includes("投递邀请函"));
  rec(4, "已完成主线不再显示", !still && hasDeliver,
      "列表: " + (r4.shown.join(" | ") || "(空)") + `  投递主线还在=${hasDeliver}`);
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

// ---------- 任务9：13 位客人的 Q 版立绘 / 对话头像素材齐全 ----------
try {
  const r9 = await p.evaluate(async () => {
    const NPCS = (await import("/src/config.js")).NPCS;
    const venueNpcs = NPCS.filter((n) => (n.scene || "venue") === "venue");
    const urls = [];
    for (const n of venueNpcs) {
      urls.push({ name: n.name, kind: "立绘", url: n.sprite });
      urls.push({ name: n.name, kind: "头像", url: (n.portrait && n.portrait.url) || "" });
    }
    const bad = [];
    for (const u of urls) {
      if (!u.url) { bad.push(`${u.name} 无${u.kind}路径`); continue; }
      try {
        const res = await fetch(u.url);
        if (!res.ok) bad.push(`${u.name} ${u.kind} HTTP ${res.status}`);
      } catch (e) { bad.push(`${u.name} ${u.kind} ${e.message}`); }
    }
    return { total: urls.length, bad };
  });
  rec(9, "会场全部角色（13 位客人 + 空）的立绘与头像素材齐全", r9.bad.length === 0,
      `${r9.total} 个文件；缺失/报错 ${r9.bad.length} 个：${r9.bad.join(", ") || "无"}`);
} catch (e) {
  rec(9, "会场全部角色（13 位客人 + 空）的立绘与头像素材齐全", false, e.message);
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

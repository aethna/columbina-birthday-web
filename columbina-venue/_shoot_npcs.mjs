import puppeteer from "puppeteer";
import fs from "fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "D:\\DSH工作区\\哥伦比娅生日会\\venue\\";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 240000 });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto("http://localhost:5173/venue.html", { waitUntil: "networkidle2", timeout: 90000 });
await sleep(3500);
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: "networkidle2", timeout: 90000 });
await sleep(6500);

// 1) 常规形态：13 位客人 + 空 全部到场
const info = await p.evaluate(async () => {
  const s = window.__venueScene;
  const { GUESTS } = await import("/src/StorySystem.js");
  s.story.data.lettersWritten = GUESTS.map((g) => g.id);
  s.story.data.delivered = true;
  if (s.story.save) s.story.save();
  s.scenes.load("venue", { tileX: 20, tileY: 18 }, true);
  await new Promise((r) => setTimeout(r, 1000));
  s.spawnNpcsForCurrentScene();
  await new Promise((r) => setTimeout(r, 1200));
  return {
    npcs: (s.npcs || []).length,
    party: !!s.party,
    list: (s.npcs || []).map((n) => [n.name || n.npcId, Math.round(n.x), Math.round(n.y)]),
  };
});
console.log(JSON.stringify(info));

// 收起任务面板，免得挡住右侧的 NPC
await p.evaluate(() => { window.__venueScene.toggleQuestPanel(); });
await sleep(700);

// 全图俯瞰
await p.evaluate(() => {
  const s = window.__venueScene;
  s.cameras.main.stopFollow();
  s.cameras.main.setZoom(0.48);
  s.cameras.main.centerOn(1280, 768);
});
await sleep(600);
await p.screenshot({ path: OUT + "_npc_fullmap.png" });

// 分区特写：上/左/右/下
const shots = [
  ["_npc_top.png", 1150, 300, 1.0],
  ["_npc_left.png", 500, 700, 1.0],
  ["_npc_right.png", 2150, 800, 1.0],
  ["_npc_bottom.png", 1280, 1180, 1.0],
];
for (const [f, cx, cy, z] of shots) {
  await p.evaluate((cx, cy, z) => {
    const s = window.__venueScene;
    s.cameras.main.setZoom(z);
    s.cameras.main.centerOn(cx, cy);
  }, cx, cy, z);
  await sleep(450);
  await p.screenshot({ path: OUT + f });
}
await b.close();
console.log("done");

// 在主位定拍：确认围桌庆功宴在游戏里的取景（含上下四周的通道）
import puppeteer from "puppeteer";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"],protocolTimeout:240000});
const p=await b.newPage();
await p.setViewport({width:1280,height:720});
await p.goto("http://localhost:5173/venue.html",{waitUntil:"networkidle2",timeout:90000});
await sleep(3500); await p.evaluate(()=>localStorage.clear());
await p.reload({waitUntil:"networkidle2",timeout:90000}); await sleep(6500);
const info=await p.evaluate(async()=>{
  const s=window.__venueScene;
  const {QUESTS}=await import("/src/quests.js");
  QUESTS.forEach(q=>{s.quests.data.states[q.id]="completed";});
  s.scenes.load("venue",{tileX:20,tileY:18},true);
  await new Promise(r=>setTimeout(r,1200));
  s.maybeStartParty();
  await new Promise(r=>setTimeout(r,1600));
  s.refreshQuestUI();
  const c=s.cameras.main, wv=c.worldView;
  return {player:[Math.round(s.player.x),Math.round(s.player.y)],
    heroDepth:s.player.depth, shadowDepth:s.playerShadow.depth,
    followOffset:c.followOffset.y,
    wvY:Math.round(wv.y), wvBottom:Math.round(wv.y+wv.height), wvH:Math.round(wv.height),
    farHeadScreen:Math.round((622-144-s.player.y)*0+((622-144)-wv.y)*c.zoom),
    tableTopScreen:Math.round((512-wv.y)*c.zoom),
    nearChairScreen:Math.round((1002-wv.y)*c.zoom),
    heroScreen:Math.round((s.player.y-wv.y)*c.zoom)};
});
console.log(JSON.stringify(info));
await sleep(500);
await p.screenshot({path:"D:\\DSH工作区\\哥伦比娅生日会\\venue\\_party_hero_spot.png"});
// 再拍一张「站在桌子南侧」的：确认她画在桌子前面（没有被桌子盖住）
await p.evaluate(async()=>{
  const s=window.__venueScene;
  s.player.setPosition(1280, 1100);
  for(let i=0;i<40;i++) await new Promise(r=>requestAnimationFrame(r));
});
await sleep(500);
await p.screenshot({path:"D:\\DSH工作区\\哥伦比娅生日会\\venue\\_party_south.png"});
await b.close();

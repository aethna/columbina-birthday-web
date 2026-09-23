<template>
  <section id="game">
    <div class="wrap">
      <div class="play reveal">
        <div class="play-main">
          <div class="eyebrow">Play</div>
          <h2>与哥伦比娅一起玩游戏</h2>
          <p>「梦境游廊」已经开启——陪她穿过云隙、踏过月岩，或在月色里落下一枚棋子。</p>
          <div class="chips">
            <span>云隙轻歌</span>
            <span>无尽巡游</span>
            <span>月亮棋</span>
            <span>星月五子棋</span>
            <span>提瓦特战力党</span>
          </div>
          <a class="play-btn" href="./game/index.html">
            与哥伦比娅一起玩游戏 <span class="arr">↗</span>
          </a>
        </div>
        <div class="play-art" aria-hidden="true">
          <span class="ring"></span>
          <span class="ring ring-2"></span>
          <span class="moon"></span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ---------- 玩游戏 ---------- */
.play{
  position:relative;overflow:hidden;
  border:1px solid var(--line);border-radius:18px;
  padding:56px 44px;
  display:grid;grid-template-columns:1.4fr .6fr;gap:44px;align-items:center;
  background:
    radial-gradient(ellipse at 10% 0%,rgba(157,184,232,.14),transparent 58%),
    linear-gradient(170deg,rgba(22,30,56,.55),rgba(9,13,26,.78));
}
.play::before{
  content:"☾";position:absolute;top:-36px;right:22px;font-size:132px;
  color:rgba(242,244,250,.05);font-family:var(--serif);pointer-events:none;
}
.play h2{margin-bottom:14px}
.play p{color:var(--ink-dim);font-size:15px;max-width:560px}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 30px}
.chips span{
  font-size:12px;letter-spacing:.16em;color:var(--blue);
  border:1px solid var(--line);border-radius:99px;padding:5px 14px;
  background:rgba(157,184,232,.06);
}
.play-btn{
  display:inline-flex;align-items:center;gap:10px;padding:15px 40px;border-radius:99px;
  font-family:var(--serif);font-size:16px;letter-spacing:.16em;color:var(--bg);
  background:linear-gradient(135deg,var(--gold),#f0d9a8);text-decoration:none;
  box-shadow:0 8px 34px rgba(230,200,138,.28);transition:transform .35s,box-shadow .35s;
}
.play-btn:hover{transform:translateY(-3px);box-shadow:0 14px 44px rgba(230,200,138,.4)}
.play-btn .arr{transition:transform .35s}
.play-btn:hover .arr{transform:translate(4px,-2px)}
/* 装饰月轮 */
.play-art{position:relative;justify-self:center;width:100%;max-width:200px;aspect-ratio:1/1;display:grid;place-items:center}
.play-art .ring{position:absolute;inset:0;border:1px solid rgba(157,184,232,.22);border-radius:50%;animation:spin 22s linear infinite}
.play-art .ring-2{inset:26px;border-style:dashed;animation-duration:32s;animation-direction:reverse}
.play-art .moon{
  width:88px;height:88px;border-radius:50%;
  background:radial-gradient(circle at 34% 30%,#fdfefe,#cdd9f2 62%,#8fa6d4);
  box-shadow:0 0 60px rgba(157,184,232,.45),0 0 120px rgba(157,184,232,.2);
}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---------- 响应式（Play 部分） ---------- */
@media(max-width:860px) and (orientation:portrait){
  .play{grid-template-columns:1fr;padding:40px 26px;gap:26px}
  .play-art{display:none}
  .play-btn{padding:14px 28px;font-size:15px}
}
</style>

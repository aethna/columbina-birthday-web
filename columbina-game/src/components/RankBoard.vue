<template>
  <div v-if="open" class="rank-overlay" @click.self="$emit('close')">
    <div class="rank-card">
      <p class="rank-label">RANKING</p>
      <h2>{{ label || '排行榜' }}</h2>

      <ol v-if="top.length" class="rank-list">
        <li
          v-for="item in top"
          :key="item.rank"
          :class="{ 'is-me': me.loggedIn && item.rank === me.rank }"
        >
          <span class="rank-no">{{ String(item.rank).padStart(2, '0') }}</span>
          <img
            v-if="item.avatar"
            class="rank-avatar"
            :src="item.avatar"
            alt=""
            referrerpolicy="no-referrer"
            loading="lazy"
          />
          <span v-else class="rank-avatar rank-avatar-empty" aria-hidden="true">☾</span>
          <span class="rank-name">{{ item.nickname }}</span>
          <span class="rank-score">{{ item.score }}</span>
        </li>
      </ol>
      <p v-else class="rank-empty">{{ loading ? '读取中…' : '还没有成绩上榜，你可以是第一个。' }}</p>

      <div class="rank-me" :class="{ 'is-top': me.loggedIn && me.inTop }">
        <template v-if="me.loggedIn && me.rank">
          <p>我的分数 <strong>{{ me.score }}</strong></p>
          <p v-if="me.inTop">当前排名 <strong>第 {{ me.rank }} 名</strong></p>
          <p v-else>当前排名 <strong>前 {{ me.percent }}%</strong></p>
        </template>
        <p v-else-if="me.loggedIn">这个游戏你还没有成绩，去玩一局吧。</p>
        <p v-else>登录后可以查看自己的排名。</p>
      </div>

      <button class="rank-close" type="button" @click="$emit('close')">关闭</button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  game: { type: String, default: '' },
  label: { type: String, default: '' },
})
defineEmits(['close'])

const top = ref([])
const me = ref({ loggedIn: false })
const loading = ref(false)

/* 每次打开（或换游戏）都重新拉一次：榜单要新鲜，而且结算后立刻能对上 */
watch(
  () => [props.open, props.game],
  async ([open, game]) => {
    if (!open || !game) return
    loading.value = true
    top.value = []
    me.value = { loggedIn: false }
    try {
      const res = await fetch(`/api/game/leaderboard?game=${encodeURIComponent(game)}`, {
        credentials: 'same-origin',
      })
      const data = await res.json()
      if (data && data.ok) {
        top.value = data.top || []
        me.value = data.me || { loggedIn: false }
      }
    } catch (e) {
      /* 拉不到就显示空榜，不打断大厅 */
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.rank-overlay{
  position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:20px;
  background:rgba(4,9,32,.62);backdrop-filter:blur(7px);
}
.rank-card{
  width:min(430px,100%);max-height:100%;overflow-y:auto;
  padding:30px 30px 24px;text-align:center;
  border:1px solid rgba(224,241,255,.52);
  background:linear-gradient(145deg,rgba(32,48,105,.9),rgba(8,16,52,.94));
  box-shadow:0 20px 70px rgba(0,0,30,.42);
}
.rank-label{margin:0 0 6px;color:#9ce5ff;font-size:10px;letter-spacing:.18em;text-transform:uppercase}
.rank-card h2{margin:0 0 20px;font-family:var(--serif);font-size:26px;font-weight:600;letter-spacing:.1em}

.rank-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.rank-list li{
  display:grid;grid-template-columns:34px 30px 1fr auto;align-items:center;gap:10px;
  padding:7px 10px;border:1px solid transparent;text-align:left;
}
.rank-list li.is-me{border-color:rgba(230,200,138,.55);background:rgba(230,200,138,.12)}
.rank-no{color:rgba(156,229,255,.8);font-size:12px;letter-spacing:.08em}
.rank-avatar{width:30px;height:30px;border-radius:50%;object-fit:cover;border:1px solid rgba(218,237,255,.4)}
.rank-avatar-empty{display:grid;place-items:center;color:var(--blue);font-size:13px;background:rgba(157,184,232,.14)}
.rank-name{
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;color:#eef3ff;
}
.rank-score{font-family:var(--serif);font-size:15px;color:#fff;letter-spacing:.06em}

.rank-empty{margin:14px 0;color:rgba(239,244,255,.6);font-size:12px;line-height:1.9}

.rank-me{
  margin-top:18px;padding:14px 12px;border-top:1px solid rgba(218,237,255,.18);
  color:rgba(239,244,255,.78);font-size:12.5px;line-height:2;
}
.rank-me strong{color:#fff;font-size:15px;letter-spacing:.05em}
.rank-me.is-top strong{color:#ffe2a6}

.rank-close{
  margin-top:16px;min-width:132px;padding:10px 24px;cursor:pointer;
  border:1px solid rgba(255,255,255,.7);border-radius:999px;background:rgba(125,197,255,.18);
  font-family:var(--serif);letter-spacing:.1em;color:#fff;transition:.3s;
}
.rank-close:hover{color:#101b47;background:#fff}

@media (max-width:520px){
  .rank-card{padding:24px 18px 18px}
  .rank-card h2{font-size:22px}
  .rank-list li{grid-template-columns:28px 26px 1fr auto;gap:8px;padding:6px 6px}
  .rank-avatar{width:26px;height:26px}
}
</style>

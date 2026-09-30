<template>
  <div class="user-auth">
    <template v-if="ready && user">
      <img
        v-if="user.avatar"
        class="ua-avatar"
        :src="user.avatar"
        :alt="user.nickname || 'QQ'"
        referrerpolicy="no-referrer"
        loading="lazy"
      />
      <span v-else class="ua-avatar ua-avatar-fallback" aria-hidden="true">☾</span>
      <span class="ua-name" :title="user.nickname || ''">{{ user.nickname || '哥伦比娅的朋友' }}</span>
      <button class="ua-out" type="button" title="退出登录" @click="onLogout">退出</button>
    </template>
    <a v-else-if="ready" class="ua-login" :href="loginHref(returnTo)">登录</a>
  </div>
</template>

<script setup>
import { useAuth } from '../composables/useAuth'

/* returnTo：登录成功后要跳回的站内目标（由 App 按当前视图算好传进来） */
defineProps({ returnTo: { type: String, default: '/' } })

const { user, ready, loginHref, logout } = useAuth()

async function onLogout() {
  await logout()
  window.location.reload()
}
</script>

<style scoped>
.user-auth{
  position:fixed;z-index:10021;top:22px;right:22px;
  display:flex;align-items:center;gap:9px;height:46px;padding:0 8px 0 6px;
  border:1px solid rgba(194,211,246,.34);border-radius:999px;
  background:linear-gradient(135deg,rgba(16,25,53,.9),rgba(45,29,68,.84));
  box-shadow:0 10px 32px rgba(0,0,0,.3),inset 0 0 18px rgba(157,184,232,.08);
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  font-family:var(--sans);color:#d9e4fb;
}
.ua-login{
  display:inline-flex;align-items:center;height:34px;padding:0 18px;border-radius:999px;
  font-size:13px;letter-spacing:.12em;text-decoration:none;color:var(--bg);
  background:linear-gradient(135deg,var(--gold),#f0d9a8);
  box-shadow:0 4px 18px rgba(230,200,138,.3);transition:transform .3s,box-shadow .3s;
}
.ua-login:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(230,200,138,.44)}
.ua-avatar{width:30px;height:30px;border-radius:50%;object-fit:cover;border:1px solid rgba(194,211,246,.4);flex:none}
.ua-avatar-fallback{display:grid;place-items:center;color:var(--gold);font-size:14px;background:rgba(157,184,232,.14)}
.ua-name{
  font-size:13px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:#e7edfb;
}
.ua-out{
  border:0;background:none;cursor:pointer;padding:6px 10px;border-radius:999px;
  font:500 12px/1 var(--sans);letter-spacing:.08em;color:rgba(226,233,250,.66);transition:.25s;
}
.ua-out:hover{color:var(--gold);background:rgba(180,199,241,.14)}

@media(max-width:520px){
  .user-auth{top:12px;right:12px;height:40px;gap:7px}
  .ua-avatar{width:26px;height:26px}
  .ua-name{max-width:72px;font-size:12px}
  .ua-login{height:30px;padding:0 14px;font-size:12px}
}
</style>

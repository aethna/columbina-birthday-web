<template>
  <section class="login-view">
    <div class="login-card">
      <div class="eyebrow" style="justify-content:center">Sign in</div>
      <h2>登录后即可参加</h2>
      <p class="tip">
        小游戏、会场与「我要参与」需要先登录 QQ；只想四处看看的话，不登录也完全没问题。
      </p>

      <a class="qq-btn" :href="loginHref(returnTo)">
        <span class="qq-mark" aria-hidden="true">🐧</span>
        使用 QQ 登录
      </a>

      <p v-if="errorText" class="err">{{ errorText }}</p>
      <button class="back-btn" type="button" @click="$emit('back')">← 返回首页</button>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useAuth } from '../composables/useAuth'

/* returnTo：登录成功后跳回的站内目标（被门禁拦下的是什么，就回什么） */
const props = defineProps({ returnTo: { type: String, default: '/#/signup' } })
defineEmits(['back'])

const { loginHref } = useAuth()

/* 失败信息由后端 302 带在 hash 上：/#/login?error=state|qq */
const errorText = computed(() => {
  const m = /[?&]error=([^&]+)/.exec(window.location.hash || '')
  const code = m ? decodeURIComponent(m[1]) : ''
  if (code === 'state') return '登录验证已过期或来源不可信，请重新点一次登录。'
  if (code === 'qq') return 'QQ 登录没有成功，请稍后再试。'
  return ''
})
</script>

<style scoped>
.login-view{
  min-height:100vh;display:grid;place-items:center;padding:120px 22px 80px;
  position:relative;z-index:2;
}
.login-card{
  width:100%;max-width:460px;text-align:center;padding:56px 36px 44px;
  border:1px solid var(--line);border-radius:18px;
  background:
    radial-gradient(ellipse at 50% 0%,rgba(157,184,232,.14),transparent 60%),
    linear-gradient(170deg,rgba(22,30,56,.7),rgba(9,13,26,.86));
  box-shadow:0 24px 60px rgba(0,0,0,.42);
  backdrop-filter:blur(6px);
}
.login-card h2{margin:10px 0 14px}
.tip{color:var(--ink-dim);font-size:14.5px;line-height:1.9;max-width:340px;margin:0 auto 34px}
.qq-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:12px;
  padding:16px 46px;border-radius:99px;text-decoration:none;
  font-family:var(--serif);font-size:16px;letter-spacing:.14em;color:var(--bg);
  background:linear-gradient(135deg,var(--gold),#f0d9a8);
  box-shadow:0 10px 36px rgba(230,200,138,.3);
  transition:transform .35s,box-shadow .35s;
}
.qq-btn:hover{transform:translateY(-3px);box-shadow:0 16px 46px rgba(230,200,138,.44)}
.qq-mark{font-size:19px;line-height:1}
.err{
  margin:22px auto 0;font-size:13px;color:#ffd7d7;line-height:1.8;
  border:1px solid rgba(255,150,150,.34);border-left:3px solid rgba(255,140,140,.7);
  border-radius:10px;padding:10px 14px;text-align:left;max-width:330px;
}
.back-btn{
  display:block;margin:30px auto 0;border:0;background:none;cursor:pointer;
  font:400 13px/1 var(--sans);letter-spacing:.14em;color:var(--ink-faint);transition:.25s;
}
.back-btn:hover{color:var(--gold)}

@media(max-width:520px){
  .login-view{padding:96px 16px 64px}
  .login-card{padding:44px 22px 34px}
  .qq-btn{padding:15px 34px;font-size:15px}
}
</style>

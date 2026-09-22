<template>
  <section class="signup">
    <div class="wrap">
      <div class="topbar">
        <button type="button" class="back" @click="$emit('back')">← 返回首页</button>
        <button type="button" class="edit-entry" @click="openEditModal">我要修改</button>
      </div>

      <header class="head">
        <div class="eyebrow" style="justify-content:center">Join</div>
        <h2>我要参与</h2>
        <p class="lead">把你的作品交给这场月夜——《新月再梦听羽生》哥伦比娅生日会征集中。</p>
      </header>

      <!-- 提交成功 -->
      <div v-if="receipt" class="card done-card">
        <div class="done-mark">❋</div>
        <h3>{{ receipt.updated ? '投稿已更新' : '投稿已收到' }}</h3>
        <p class="done-sub">{{ receipt.updated ? '修改已覆盖到原投稿，编号保持不变 ❤️' : '感谢你为这场生日会添的一束月光 ❤️' }}</p>
        <dl class="receipt">
          <div><dt>投稿编号</dt><dd class="mono">{{ receipt.id }}</dd></div>
          <div><dt>单品名称</dt><dd>{{ receipt.title }}</dd></div>
          <div v-if="receipt.category"><dt>单品类别</dt><dd>{{ receipt.category }}</dd></div>
          <div v-if="receipt.files && receipt.files.length">
            <dt>上传附件</dt>
            <dd>{{ receipt.files.map((f) => f.name).join('、') }}</dd>
          </div>
        </dl>
        <div class="tips">
          <p class="tip strong"><i class="mark">！</i>请务必保存编号，方便后续与负责人核对或需要修改内容时使用；请不要泄露编号给其他人，防止内容被篡改。</p>
          <p class="tip strong"><i class="mark">！</i>如果不小心没有保存编号，请及时联系项目组，并提供投稿时填写的联系方式、作品名称等信息，我们会帮你找回。</p>
        </div>
        <p class="tip">需要改内容？点右上角「我要修改」，输入编号就能直接改，不用重新填一遍。</p>
        <div class="done-actions">
          <button type="button" class="btn" @click="resetAll">再投一份</button>
          <button type="button" class="btn ghost" @click="$emit('back')">返回首页</button>
        </div>
      </div>

      <!-- 投稿表单 -->
      <form v-else class="card" novalidate @submit.prevent="onSubmit">
        <fieldset :disabled="submitting">
          <div v-if="editId" class="edit-banner">
            <span>正在修改投稿 <b class="mono">{{ editId }}</b>，保存后会覆盖原内容，编号不变。</span>
            <button type="button" class="banner-exit" @click="exitEdit">退出修改</button>
          </div>
          <!-- 主要负责人联系方式 -->
          <div class="grid-2">
            <label class="field">
              <span class="label">节目主要负责人联系方式 <i>*</i></span>
              <select v-model="form.contactType">
                <option value="qq">QQ</option>
                <option value="wechat">微信</option>
                <option value="email">邮箱</option>
              </select>
              <span v-if="errors.contactType" class="err">{{ errors.contactType }}</span>
            </label>
            <label class="field">
              <span class="label">联系方式 <i>*</i></span>
              <input
                v-model.trim="form.contactValue"
                :placeholder="contactPlaceholder"
                :inputmode="form.contactType === 'email' ? 'email' : 'text'"
                maxlength="200"
              />
              <span v-if="errors.contactValue" class="err">{{ errors.contactValue }}</span>
            </label>
          </div>

          <label class="field">
            <span class="label">参与人员昵称（选填）</span>
            <input v-model.trim="form.nicknames" placeholder="填写所有参与人员的昵称，用顿号或逗号分隔" maxlength="500" />
            <span class="hint">我们将根据填入的昵称展示参与制作人员的名单</span>
          </label>

          <!-- 投稿形式 -->
          <div class="grid-2">
            <label class="field">
              <span class="label">投稿形式 <i>*</i></span>
              <select v-model="form.creationType">
                <option value="personal">个人创作</option>
                <option value="team">团队创作</option>
              </select>
            </label>
          </div>

          <!-- 参与成员分工（团队创作时显示） -->
          <div v-if="form.creationType === 'team'" class="field group">
            <span class="label">参与成员分工 <i>*</i></span>
            <p class="hint">每位成员的分工与昵称都要填写，至少保留 2 位。</p>
            <div v-for="(m, i) in form.teamMembers" :key="i" class="row-line">
              <input v-model.trim="m.role" class="w-role" placeholder="分工（如：作画 / 剪辑）" maxlength="60" />
              <input v-model.trim="m.nickname" class="w-nick" placeholder="昵称" maxlength="60" />
              <button type="button" class="pm minus" title="减少一位" :disabled="form.teamMembers.length <= 2" @click="removeMember(i)">−</button>
              <button type="button" class="pm plus" title="增加一位" @click="form.teamMembers.push({ role: '', nickname: '' })">＋</button>
            </div>
            <span v-if="errors.teamMembers" class="err">{{ errors.teamMembers }}</span>
          </div>

          <hr class="sep" />

          <!-- 单品信息 -->
          <label class="field">
            <span class="label">单品名称 <i>*</i></span>
            <input v-model.trim="form.title" placeholder="填写作品名称" maxlength="200" />
            <span v-if="errors.title" class="err">{{ errors.title }}</span>
          </label>

          <div class="grid-2">
            <label class="field">
              <span class="label">单品类别 <i>*</i></span>
              <select v-model="form.category">
                <option value="" disabled>请选择</option>
                <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
              </select>
              <span v-if="errors.category" class="err">{{ errors.category }}</span>
            </label>
            <label class="field">
              <span class="label">作品预计时间 <i>*</i></span>
              <select v-model="form.duration">
                <option value="" disabled>请选择</option>
                <option v-for="d in DURATIONS" :key="d" :value="d">{{ d }}</option>
              </select>
              <span v-if="errors.duration" class="err">{{ errors.duration }}</span>
            </label>
          </div>

          <label class="field">
            <span class="label">作品大致简介 <i>*</i></span>
            <textarea v-model.trim="form.intro" rows="4" placeholder="简单介绍作品内容" maxlength="5000"></textarea>
            <span v-if="errors.intro" class="err">{{ errors.intro }}</span>
          </label>

          <div class="grid-2">
            <label class="field">
              <span class="label">作品是否涉及哥伦比娅以外的其他角色 <i>*</i></span>
              <select v-model="form.hasOtherCharacters">
                <option value="否">否</option>
                <option value="是">是</option>
              </select>
            </label>
            <label class="field">
              <span class="label">当前作品进展（选填）</span>
              <select v-model="form.progress">
                <option value="">暂不填写</option>
                <option v-for="p in PROGRESS_LIST" :key="p" :value="p">{{ p }}</option>
              </select>
            </label>
          </div>

          <!-- 其他角色（选“是”后显示） -->
          <div v-if="form.hasOtherCharacters === '是'" class="field group">
            <span class="label">除哥伦比娅外涉及角色 <i>*</i></span>
            <p class="hint">一行一个角色名，至少保留一个。</p>
            <div v-for="(c, i) in form.otherCharacters" :key="i" class="row-line">
              <input v-model.trim="form.otherCharacters[i]" class="w-full" placeholder="角色名" maxlength="100" />
              <button type="button" class="pm minus" title="减少一行" :disabled="form.otherCharacters.length <= 1" @click="removeChar(i)">−</button>
              <button type="button" class="pm plus" title="增加一行" @click="form.otherCharacters.push('')">＋</button>
            </div>
            <span v-if="errors.otherCharacters" class="err">{{ errors.otherCharacters }}</span>
          </div>

          <hr class="sep" />

          <!-- 作品预览 -->
          <div class="field group">
            <span class="label">作品预览（选填）</span>
            <div class="preview-modes">
              <label class="mode"><input type="radio" value="link" v-model="form.previewType" /> 提供链接</label>
              <label class="mode"><input type="radio" value="file" v-model="form.previewType" /> 上传文件</label>
              <label class="mode"><input type="radio" value="" v-model="form.previewType" /> 暂不提供</label>
            </div>

            <div v-if="form.previewType === 'link'" class="sub-block">
              <input v-model.trim="form.previewLink" placeholder="粘贴作品链接（http:// 或 https:// 开头）" maxlength="1000" />
              <span v-if="errors.previewLink" class="err">{{ errors.previewLink }}</span>
            </div>

            <div v-else-if="form.previewType === 'file'" class="sub-block">
              <FileUploader :key="editId || 'new'" :initial="initialFiles" @change="onFilesChange" />
              <span v-if="errors.fileIds" class="err">{{ errors.fileIds }}</span>
            </div>
          </div>

          <hr class="sep" />

          <!-- 投稿须知 gate -->
          <div class="notice-gate">
            <button type="button" class="notice-link" @click="noticeOpen = true">投稿须知</button>
            <span v-if="agreed" class="agreed">已阅读并同意 ✓</span>
            <span v-else class="need">（必须点开阅读并同意后才能提交）</span>
          </div>

          <button type="submit" class="btn submit" :disabled="!agreed || submitting">
            {{ submitting ? (editId ? '保存中…' : '提交中…') : (editId ? '保存修改' : '提交投稿') }}
          </button>
          <p v-if="errors.form" class="err center">{{ errors.form }}</p>
          <p v-if="!agreed" class="hint center">请先点开上方蓝色「投稿须知」并点击「我已知晓并同意」。</p>
        </fieldset>
      </form>
    </div>

    <!-- 投稿须知弹窗 -->
    <div class="modal" :class="{ open: noticeOpen }" role="dialog" aria-modal="true" @click.self="noticeOpen = false">
      <div class="modal-card">
        <button type="button" class="modal-close" aria-label="关闭" @click="noticeOpen = false">✕</button>
        <h3>投稿须知</h3>
        <p class="notice-text">{{ NOTICE_TEXT }}</p>
        <div class="modal-actions">
          <button type="button" class="btn" @click="acceptNotice">我已知晓并同意</button>
          <button type="button" class="btn ghost" @click="noticeOpen = false">暂不同意</button>
        </div>
      </div>
    </div>
    <!-- 修改投稿弹窗 -->
    <div class="modal" :class="{ open: editOpen }" role="dialog" aria-modal="true" @click.self="closeEditModal">
      <div class="modal-card">
        <button type="button" class="modal-close" aria-label="关闭" @click="closeEditModal">✕</button>
        <h3>修改投稿</h3>
        <p class="edit-lead">请输入投稿编号</p>
        <input
          v-model.trim="editCode"
          class="code-input mono"
          placeholder="粘贴 32 位投稿编号"
          maxlength="32"
          autocomplete="off"
          spellcheck="false"
          @keyup.enter.prevent="loadForEdit"
        />
        <p v-if="editError" class="err">{{ editError }}</p>
        <div class="modal-actions">
          <button type="button" class="btn" :disabled="loadingEdit" @click="loadForEdit">{{ loadingEdit ? '读取中…' : '读取投稿' }}</button>
          <button type="button" class="btn ghost" :disabled="loadingEdit" @click="closeEditModal">取消</button>
        </div>
        <p class="edit-warn">编号是修改这份投稿的唯一凭据，请不要泄露给其他人，以免内容被篡改。若没有保存编号，请及时联系项目组并提供联系方式与作品名称，我们会帮你找回。</p>
      </div>
    </div>
  </section>
</template>

<script setup>
import { reactive, ref, computed, watch, onMounted } from 'vue'
import FileUploader from './FileUploader.vue'
import { submitForm, lookupSubmission, updateSubmission } from '../api/client.js'

defineEmits(['back'])

const CATEGORIES = ['动画', '手书', '混剪', 'Cosplay', 'MMD', '音乐', '插画', '漫画', '故事', '原摄', '原壶', '原琴', '其他']
const DURATIONS = ['小于 1 分钟', '1～3 分钟', '3～6 分钟', '6 分钟以上']
const PROGRESS_LIST = ['仅有构想', '已开始制作', '已有初稿', '接近完成', '已完成']
const NOTICE_TEXT = '本人同意生日会组将本次投稿作品用于《新月再梦听羽生》哥伦比娅生日会总视频、直播、预告、宣传及活动相关内容展示；作品著作权仍归原作者所有。'

const BLANK_FORM = () => ({
  contactType: 'qq',
  contactValue: '',
  nicknames: '',
  creationType: 'personal',
  teamMembers: [{ role: '', nickname: '' }, { role: '', nickname: '' }],
  title: '',
  category: '',
  intro: '',
  duration: '',
  hasOtherCharacters: '否',
  otherCharacters: [''],
  progress: '',
  previewType: 'link',
  previewLink: '',
})

const form = reactive(BLANK_FORM())

const errors = reactive({})
const agreed = ref(false)
const noticeOpen = ref(false)
const submitting = ref(false)
const receipt = ref(null)
const uploadedFiles = ref([])
/* 修改已有投稿时：当前编号 + 服务器上原有的附件 */
const editId = ref(null)
const initialFiles = ref([])
const editOpen = ref(false)
const editCode = ref('')
const editError = ref('')
const loadingEdit = ref(false)

const contactPlaceholder = computed(() => {
  if (form.contactType === 'qq') return '填写负责人 QQ 号'
  if (form.contactType === 'wechat') return '填写负责人微信号'
  return '填写负责人邮箱'
})

watch(() => form.contactType, () => { delete errors.contactValue })

onMounted(() => { document.body.style.overflow = noticeOpen.value ? 'hidden' : '' })
watch(noticeOpen, (v) => { document.body.style.overflow = v ? 'hidden' : '' })
watch(editOpen, (v) => { document.body.style.overflow = v ? 'hidden' : '' })

function clearErrors() { Object.keys(errors).forEach((k) => delete errors[k]) }

function removeMember(i) { if (form.teamMembers.length > 2) form.teamMembers.splice(i, 1) }
function removeChar(i) { if (form.otherCharacters.length > 1) form.otherCharacters.splice(i, 1) }
function onFilesChange(list) { uploadedFiles.value = list }

/* ---------------- 修改已有投稿 ---------------- */

function openEditModal() {
  editError.value = ''
  editCode.value = ''
  editOpen.value = true
}

function closeEditModal() {
  editOpen.value = false
  editError.value = ''
}

/** 按编号把填过的内容读回来（编号就是修改凭据） */
async function loadForEdit() {
  if (loadingEdit.value) return
  editError.value = ''
  const id = String(editCode.value || '').trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(id)) {
    editError.value = '编号应该是 32 位的字母数字组合，请核对后重试'
    return
  }
  loadingEdit.value = true
  try {
    const r = await lookupSubmission(id)
    if (!r.ok) {
      editError.value = r.error || '读取失败，请稍后再试'
      return
    }
    fillFrom(r.item)
    editId.value = id
    /* 首次提交时已经同意过《投稿须知》，这里是同一份投稿的修改，无需重读一遍 */
    agreed.value = true
    receipt.value = null
    clearErrors()
    editOpen.value = false
    editCode.value = ''
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (e) {
    editError.value = '网络异常，读取失败，请稍后再试'
  } finally {
    loadingEdit.value = false
  }
}

/** 服务器上的字段名 → 表单字段（不用重填） */
function fillFrom(item) {
  const members = Array.isArray(item.teamMembers) ? item.teamMembers : []
  const chars = Array.isArray(item.otherCharacters) ? item.otherCharacters : []
  Object.assign(form, {
    contactType: item.contactType || 'qq',
    contactValue: item.contactValue || '',
    nicknames: item.nicknames || '',
    creationType: item.creationType === 'team' ? 'team' : 'personal',
    teamMembers: members.length
      ? members.map((m) => ({ role: m.role || '', nickname: m.nickname || '' }))
      : [{ role: '', nickname: '' }, { role: '', nickname: '' }],
    title: item.title || '',
    category: item.category || '',
    intro: item.intro || '',
    duration: item.duration || '',
    hasOtherCharacters: item.hasOtherCharacters ? '是' : '否',
    otherCharacters: chars.length ? chars.slice() : [''],
    progress: item.progress || '',
    previewType: item.previewType || '',
    previewLink: item.previewLink || '',
  })
  initialFiles.value = (item.files || []).map((f) => ({ id: f.id, name: f.name, size: Number(f.size) || 0 }))
  uploadedFiles.value = []
}

/** 退出修改：回到一份空白的新投稿 */
function exitEdit() {
  editId.value = null
  receipt.value = null
  agreed.value = false
  uploadedFiles.value = []
  initialFiles.value = []
  clearErrors()
  Object.assign(form, BLANK_FORM())
}

function acceptNotice() {
  agreed.value = true
  noticeOpen.value = false
}

/** 前端校验（后端同样会校验一遍） */
function validate() {
  clearErrors()
  if (!form.contactValue) errors.contactValue = '请填写主要负责人联系方式'
  if (form.creationType === 'team') {
    if (form.teamMembers.some((m) => !m.role || !m.nickname)) errors.teamMembers = '请把每位成员的分工和昵称都填完整'
  }
  if (!form.title) errors.title = '请填写单品名称'
  if (!form.category) errors.category = '请选择单品类别'
  if (!form.intro) errors.intro = '请填写作品大致简介'
  if (!form.duration) errors.duration = '请选择作品预计时间'
  if (form.hasOtherCharacters === '是') {
    if (!form.otherCharacters.map((c) => String(c || '').trim()).filter(Boolean).length) errors.otherCharacters = '请至少填写一个角色名'
  }
  if (form.previewType === 'link') {
    if (!form.previewLink) errors.previewLink = '请填写作品链接'
    else if (!/^https?:\/\/\S+$/i.test(form.previewLink)) errors.previewLink = '链接需以 http:// 或 https:// 开头'
  }
  if (form.previewType === 'file' && !uploadedFiles.value.length) errors.fileIds = '请先上传作品文件并等待上传完成'
  if (!agreed.value) errors.agreed = '请先阅读并同意《投稿须知》'
  return Object.keys(errors).length === 0
}

async function onSubmit() {
  if (submitting.value) return
  if (!agreed.value) { noticeOpen.value = true; return }
  if (!validate()) {
    const el = document.querySelector('.err')
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  submitting.value = true
  try {
    const useFiles = form.previewType === 'file'
    const payload = {
      contactType: form.contactType,
      contactValue: form.contactValue,
      nicknames: form.nicknames,
      creationType: form.creationType,
      teamMembers: form.creationType === 'team' ? form.teamMembers.map((m) => ({ role: m.role, nickname: m.nickname })) : [],
      title: form.title,
      category: form.category,
      intro: form.intro,
      duration: form.duration,
      hasOtherCharacters: form.hasOtherCharacters === '是',
      otherCharacters: form.hasOtherCharacters === '是' ? form.otherCharacters.map((c) => String(c || '').trim()).filter(Boolean) : [],
      progress: form.progress || '',
      previewType: form.previewType || '',
      previewLink: form.previewType === 'link' ? form.previewLink : '',
      /* 新上传的走 fileIds；编辑时保留下来的原有附件走 keepFileIds */
      fileIds: useFiles ? uploadedFiles.value.filter((f) => !f.existing).map((f) => f.fileId) : [],
      keepFileIds: useFiles ? uploadedFiles.value.filter((f) => f.existing).map((f) => f.fileId) : [],
      agreed: agreed.value,
    }
    const r = editId.value
      ? await updateSubmission(editId.value, payload)
      : await submitForm(payload)
    if (!r.ok) {
      if (r.errors) {
        Object.entries(r.errors).forEach(([k, v]) => { errors[k] = v })
        const el = document.querySelector('.err')
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else {
        errors.form = r.error || '提交失败，请稍后再试'
      }
      return
    }
    receipt.value = r
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (e) {
    errors.form = '网络异常，提交失败，请稍后再试'
  } finally {
    submitting.value = false
  }
}

function resetAll() {
  receipt.value = null
  agreed.value = false
  clearErrors()
  uploadedFiles.value = []
  initialFiles.value = []
  editId.value = null
}
</script>

<style scoped>
.signup{padding:120px 0 96px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:26px}
.back{
  background:none;border:1px solid var(--line);border-radius:99px;color:var(--ink-dim);
  font-size:13px;letter-spacing:.08em;padding:8px 18px;cursor:pointer;
  transition:color .3s,border-color .3s;
}
.back:hover{color:var(--gold);border-color:rgba(230,200,138,.45)}
.edit-entry{
  background:none;border:1px solid rgba(230,200,138,.42);border-radius:99px;color:var(--gold);
  font-size:13px;letter-spacing:.12em;padding:8px 20px;cursor:pointer;
  transition:background .3s,border-color .3s,color .3s;
}
.edit-entry:hover{background:rgba(230,200,138,.12);border-color:rgba(230,200,138,.7)}
.head{text-align:center;margin-bottom:34px}
.head .lead{margin:0 auto;text-align:center}
.card{
  border:1px solid var(--line);border-radius:18px;padding:38px 34px;
  background:
    radial-gradient(ellipse at 50% -8%,rgba(157,184,232,.1),transparent 60%),
    linear-gradient(170deg,rgba(22,30,56,.55),rgba(9,13,26,.8));
  display:flex;flex-direction:column;gap:20px;
}
.card fieldset{border:none;display:flex;flex-direction:column;gap:20px;margin:0;padding:0;min-width:0}
.edit-banner{
  display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;
  border:1px solid rgba(230,200,138,.34);border-radius:12px;padding:12px 16px;
  background:rgba(230,200,138,.08);font-size:13px;color:var(--ink-dim);line-height:1.7;
}
.edit-banner .mono{word-break:break-all}
.banner-exit{
  flex:0 0 auto;background:none;border:1px solid rgba(157,184,232,.34);border-radius:99px;
  color:var(--ink-dim);font-size:12.5px;padding:6px 16px;cursor:pointer;transition:color .3s,border-color .3s;
}
.banner-exit:hover{color:var(--gold);border-color:rgba(230,200,138,.55)}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.field{display:flex;flex-direction:column;gap:8px;min-width:0}
.label{font-size:13.5px;color:var(--ink-dim);letter-spacing:.06em}
.label i{color:var(--gold);font-style:normal;margin-left:2px}
input[type=text],input:not([type]),select,textarea{
  width:100%;padding:12px 14px;border-radius:10px;
  border:1px solid rgba(157,184,232,.22);background:rgba(6,10,22,.72);color:var(--ink);
  font-family:var(--sans);font-size:14px;font-weight:300;outline:none;
  transition:border-color .3s,box-shadow .3s;
}
textarea{resize:vertical;line-height:1.7}
input:focus,select:focus,textarea:focus{border-color:rgba(230,200,138,.55);box-shadow:0 0 0 3px rgba(230,200,138,.1)}
select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--ink-dim) 50%),linear-gradient(135deg,var(--ink-dim) 50%,transparent 50%);background-position:calc(100% - 18px) calc(50% - 2px),calc(100% - 13px) calc(50% - 2px);background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:38px}
option{background:#0a0f1e;color:var(--ink)}
.hint{font-size:12px;color:var(--ink-faint);letter-spacing:.03em}
.err{font-size:12.5px;color:#eb9c9c;letter-spacing:.03em}
.err.center{text-align:center}
.hint.center{text-align:center}
.sep{border:none;height:1px;background:linear-gradient(90deg,transparent,rgba(157,184,232,.25),transparent);margin:2px 0}
.group{gap:10px}
.row-line{display:flex;gap:10px;align-items:center;margin-bottom:8px}
.row-line .w-role{flex:1.1}
.row-line .w-nick{flex:1}
.row-line .w-full{flex:1}
.pm{
  width:36px;height:36px;flex:0 0 36px;border-radius:10px;cursor:pointer;
  border:1px solid rgba(157,184,232,.28);background:rgba(157,184,232,.07);color:var(--ink);
  font-size:16px;line-height:1;transition:all .3s;
}
.pm:hover:not(:disabled){border-color:rgba(230,200,138,.6);color:var(--gold)}
.pm:disabled{opacity:.32;cursor:not-allowed}
.preview-modes{display:flex;flex-wrap:wrap;gap:18px;margin:2px 0 4px}
.mode{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--ink-dim);cursor:pointer}
.mode input{accent-color:var(--gold);width:15px;height:15px}
.sub-block{display:flex;flex-direction:column;gap:8px}
.notice-gate{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.notice-link{
  background:none;border:none;padding:0;cursor:pointer;color:#7fb2ff;
  font-size:14px;text-decoration:underline;text-underline-offset:4px;letter-spacing:.06em;
}
.notice-link:hover{color:#a8ccff}
.need{font-size:12px;color:var(--ink-faint)}
.agreed{font-size:12px;color:#8fd6a8}
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:10px;padding:15px 42px;border-radius:99px;
  font-family:var(--serif);font-size:16px;letter-spacing:.2em;color:var(--bg);
  background:linear-gradient(135deg,var(--gold),#f0d9a8);border:none;cursor:pointer;
  box-shadow:0 8px 34px rgba(230,200,138,.28);transition:transform .35s,box-shadow .35s,opacity .3s;
}
.btn:hover:not(:disabled){transform:translateY(-3px);box-shadow:0 14px 44px rgba(230,200,138,.4)}
.btn:disabled{opacity:.42;cursor:not-allowed;box-shadow:none;transform:none}
.btn.ghost{background:none;border:1px solid rgba(157,184,232,.3);color:var(--ink-dim);box-shadow:none}
.btn.ghost:hover{color:var(--gold);border-color:rgba(230,200,138,.5)}
.submit{align-self:center;min-width:240px}
/* 成功态 */
.done-card{align-items:center;text-align:center;gap:16px}
.done-mark{
  width:56px;height:56px;border-radius:50%;display:grid;place-items:center;font-size:22px;color:var(--gold);
  background:radial-gradient(circle at 35% 30%,rgba(230,200,138,.22),rgba(74,106,168,.1));
  border:1px solid rgba(230,200,138,.3);box-shadow:0 0 26px rgba(230,200,138,.2);
}
.done-sub{color:var(--ink-dim);font-size:14px}
.receipt{width:100%;max-width:520px;display:flex;flex-direction:column;gap:10px;margin:6px 0}
.receipt > div{display:flex;gap:14px;border-bottom:1px dashed rgba(157,184,232,.16);padding-bottom:8px;text-align:left}
.receipt dt{flex:0 0 84px;color:var(--ink-faint);font-size:13px}
.receipt dd{flex:1;font-size:13.5px;word-break:break-all}
.mono{font-family:ui-monospace,Consolas,monospace;color:var(--moon)}
.tip{font-size:12.5px;color:var(--ink-dim);max-width:520px;line-height:1.8}
/* 关键提醒：白字加粗 + 金色警示框，务必一眼看见 */
.tips{
  width:100%;max-width:520px;display:flex;flex-direction:column;gap:10px;text-align:left;
  border:1px solid rgba(230,200,138,.42);border-left:3px solid var(--gold);border-radius:12px;
  padding:14px 18px;background:linear-gradient(180deg,rgba(230,200,138,.13),rgba(230,200,138,.04));
}
.tip.strong{
  margin:0;max-width:none;color:#ffffff;font-weight:700;font-size:13.5px;
  letter-spacing:.02em;line-height:1.85;
}
.tip .mark{color:var(--gold);font-style:normal;font-weight:700;margin-right:7px}
.done-actions{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
/* 弹窗 */
.modal{
  position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:24px;
  background:rgba(4,6,13,.7);backdrop-filter:blur(10px);
  opacity:0;visibility:hidden;transition:opacity .35s,visibility .35s;
}
.modal.open{opacity:1;visibility:visible}
.modal-card{
  position:relative;width:100%;max-width:520px;border:1px solid rgba(230,200,138,.28);border-radius:18px;
  padding:40px 34px 30px;text-align:center;
  background:radial-gradient(ellipse at 50% -10%,rgba(157,184,232,.16),transparent 55%),
             linear-gradient(170deg,rgba(24,33,62,.94),rgba(8,12,26,.97));
  box-shadow:0 24px 80px rgba(0,0,0,.55);
}
.modal-card h3{font-size:22px;letter-spacing:.12em;margin-bottom:18px}
.notice-text{font-size:14.5px;color:var(--ink);line-height:2;text-align:left;letter-spacing:.02em}
.edit-lead{font-size:14px;color:var(--ink-dim);line-height:1.9;text-align:left;letter-spacing:.02em;margin-bottom:18px}
.code-input{
  width:100%;padding:13px 16px;border-radius:10px;border:1px solid rgba(157,184,232,.28);
  background:rgba(6,10,22,.75);color:var(--ink);font-size:14px;outline:none;
  transition:border-color .3s,box-shadow .3s;
}
.code-input:focus{border-color:rgba(230,200,138,.55);box-shadow:0 0 0 3px rgba(230,200,138,.1)}
.edit-warn{
  font-size:12.5px;color:#ffffff;font-weight:600;letter-spacing:.02em;margin-top:18px;line-height:1.85;
  text-align:left;border:1px solid rgba(230,200,138,.38);border-left:3px solid var(--gold);border-radius:10px;
  padding:12px 14px;background:rgba(230,200,138,.1);
}
.modal-close{position:absolute;top:14px;right:16px;background:none;border:none;color:var(--ink-faint);font-size:20px;cursor:pointer}
.modal-close:hover{color:var(--gold)}
.modal-actions{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:26px}
@media(max-width:860px) and (orientation:portrait){
  .signup{padding:96px 0 72px}
  .card{padding:26px 20px}
  .grid-2{grid-template-columns:1fr}
  .row-line{flex-wrap:wrap}
  .row-line .w-role,.row-line .w-nick,.row-line .w-full{flex:1 1 100%}
  .btn{width:100%}
  .submit{min-width:0}
  .topbar{margin-bottom:20px}
  .edit-entry{padding:8px 14px;letter-spacing:.06em}
  .modal-actions .btn{width:auto;flex:1}
}
</style>

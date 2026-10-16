<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import type { AccountInput, AccountProfile } from '../../shared/accounts'
const accountApi = window.desktop.accounts

const accounts = ref<AccountProfile[]>([])
const busy = ref(false)
const error = ref('')
const notice = ref('')
const deleteId = ref<string | null>(null)
const form = reactive<AccountInput>({ label: '', username: '', password: '' })
let unsubscribe: (() => void) | undefined
async function refresh(): Promise<void> { accounts.value = await window.desktop.accounts.list() }
function reset(): void {
  form.id = undefined; form.label = ''; form.username = ''; form.password = ''
}
function edit(account: AccountProfile): void {
  Object.assign(form, { id: account.id, label: account.label, username: account.username, password: '' })
  error.value = ''; notice.value = ''
}
async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await action(); await refresh() }
  catch (cause) { error.value = (cause instanceof Error ? cause.message : '操作失败').replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
  finally { busy.value = false }
}
async function save(): Promise<void> {
  await run(async () => {
    try { await window.desktop.accounts.save({ ...form, password: form.password || undefined }) }
    finally { form.password = '' }
    await refresh(); reset(); notice.value = '账号已保存；下次启动将自动打开全部已保存账号。'
  })
}
async function remove(id: string): Promise<void> {
  await run(async () => {
    await window.desktop.accounts.remove(id)
    if (form.id === id) reset()
    deleteId.value = null; notice.value = '账号和对应登录状态已删除。'
  })
}
onMounted(() => {
  void run(refresh)
  unsubscribe = window.desktop.accounts.onChanged(() => { void refresh().catch(() => {}) })
})
onUnmounted(() => { unsubscribe?.(); form.password = '' })
</script>

<template>
  <main class="accounts-page">
    <header class="accounts-heading">
      <div><p class="eyebrow">ERP 票据助手</p><h1>账号管理</h1><p>本地保存几个账号，启动时就打开几个独立窗口。可添加或删除账号来调整数量。</p></div>
      <button class="secondary-button" :disabled="busy" @click="run(() => accountApi.open(null))">手动登录窗口</button>
    </header>
    <div class="accounts-actions">
      <span>已保存 <strong>{{ accounts.length }}</strong> 个账号 · 已打开 {{ accounts.filter(account => account.isOpen).length }} 个账号窗口</span>
      <button class="secondary-button" :disabled="busy" @click="run(() => accountApi.tile())">排列工作窗口</button>
      <button class="primary-button" :disabled="busy || accounts.length === 0" @click="run(() => accountApi.openAll())">打开全部账号</button>
    </div>
    <p v-if="error" class="account-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="account-notice" role="status">{{ notice }}</p>
    <div class="accounts-layout">
      <section class="account-list" aria-label="已保存账号">
        <div v-if="accounts.length === 0" class="accounts-empty"><h2>添加第一个账号</h2><p>在右侧保存账号密码，每个账号对应一个独立的 ERP 工作窗口。</p></div>
        <article v-for="account in accounts" :key="account.id" class="account-card">
          <div class="account-card-title"><h2>{{ account.label }}</h2><span :class="{ 'account-open': account.isOpen }">{{ account.isOpen ? '窗口已打开' : '窗口未打开' }}</span></div>
          <p>{{ account.username }}</p>
          <small>随程序启动 · {{ account.hasPassword ? '密码已设置' : '密码未设置' }}</small>
          <div class="account-card-actions">
            <button class="primary-button" :disabled="busy" @click="run(() => accountApi.open(account.id))">{{ account.isOpen ? '切换到窗口' : '打开并登录' }}</button>
            <button class="secondary-button" :disabled="busy || account.isOpen" @click="edit(account)">编辑</button>
            <button class="account-text-button" :disabled="busy || account.isOpen" @click="deleteId = account.id">删除</button>
          </div>
          <small v-if="account.isOpen">修改账号前请先关闭对应工作窗口。</small>
          <div v-if="deleteId === account.id" class="account-delete-confirm">
            <p>删除“{{ account.label }}”及其保存的登录状态？</p>
            <button :disabled="busy" @click="remove(account.id)">确认删除</button>
            <button :disabled="busy" @click="deleteId = null">取消</button>
          </div>
        </article>
      </section>
      <form class="account-editor" @submit.prevent="save">
        <h2>{{ form.id ? '编辑账号' : '添加账号' }}</h2>
        <label>账号备注<input v-model="form.label" required maxlength="80" placeholder="例如：采购一部" :disabled="busy"></label>
        <label>用户名<input v-model="form.username" required maxlength="128" autocomplete="off" :disabled="busy"></label>
        <label>密码<input v-model="form.password" type="password" :required="!form.id" maxlength="1024" autocomplete="new-password" :placeholder="form.id ? '留空保留已有密码' : '输入 ERP 登录密码'" :disabled="busy"></label>
        <p class="account-help">密码加密保存在本机。每个账号的登录状态、票据识别和代填互相独立。</p>
        <button class="primary-button" :disabled="busy">{{ busy ? '正在处理…' : '保存账号' }}</button>
        <button v-if="form.id" class="secondary-button" type="button" :disabled="busy" @click="reset">取消编辑</button>
      </form>
    </div>
  </main>
</template>

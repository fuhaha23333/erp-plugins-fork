import type { WebContents } from 'electron'
import type { AccountLoginState, AccountProfile } from '../shared/accounts'

// Adapted to the inspected ERP Login.aspx: tbUser / tbPassword / btnLogin.
// This function is serialized into the ERP page. Keep all page helpers inside it.
function inspectLoginPage(clearLogout = false) {
  const logoutKey = 'erp-assistant.explicit-logout'
  if (clearLogout) sessionStorage.removeItem(logoutKey)
  const marker = Symbol.for('erp-assistant.logout-listener')
  const marked = document as Document & { [key: symbol]: boolean }
  const isLogout = (element: Element): boolean => {
    const text = (element.textContent || (element as HTMLInputElement).value || '').trim()
    return /^(退出(登录|系统|账号|当前账号)?|注销|登出|log\s*out|sign\s*out)$/i.test(text) ||
      /(?:logout|signout|exitlogin)/i.test(`${element.getAttribute('href') ?? ''} ${element.getAttribute('onclick') ?? ''}`)
  }
  if (!marked[marker]) {
    marked[marker] = true
    document.addEventListener('click', event => {
      const element = event.target instanceof Element ? event.target.closest('a,button,input,[onclick]') : null
      if (element && isLogout(element)) sessionStorage.setItem(logoutKey, '1')
    }, true)
  }
  const user = document.querySelector<HTMLInputElement>('#tbUser')
  const password = document.querySelector<HTMLInputElement>('#tbPassword')
  const button = document.querySelector<HTMLInputElement>('#btnLogin')
  const login = Boolean(user && password?.type === 'password' && button && user.getClientRects().length)
  const logout = Array.from(document.querySelectorAll('a,button,input,[onclick]')).some(isLogout)
  const business = Boolean(document.getElementById('Ename') && document.getElementById('Mode'))
  const identity = document.querySelector('[data-erp-username]')?.getAttribute('data-erp-username') ?? null
  return {
    login, logoutRequested: sessionStorage.getItem(logoutKey) === '1', identity,
    authenticated: !login && !document.querySelector('input[type=password]') &&
      (logout || business || /\/Default\.aspx$/i.test(location.pathname)),
    error: Boolean(document.querySelector('#vcdc')?.textContent?.trim()),
    documentId: performance.timeOrigin
  }
}

function submitLogin(username: string, password: string, origin: string, path: string): boolean {
  if (location.origin !== origin || location.pathname.toLowerCase() !== path.toLowerCase()) return false
  const user = document.querySelector<HTMLInputElement>('#tbUser')
  const secret = document.querySelector<HTMLInputElement>('#tbPassword')
  const button = document.querySelector<HTMLElement>('#btnLogin')
  if (!user || !secret || secret.type !== 'password' || !button || !user.getClientRects().length) return false
  const form = user.form
  if (!form || secret.form !== form || new URL(form.action, location.href).origin !== origin) return false
  for (const [element, value] of [[user, username], [secret, password]] as const) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }
  button.click()
  return true
}

export class ErpLoginController {
  private timer: ReturnType<typeof setInterval>
  private busy = false
  private disposed = false
  private attempted = false
  private submittedDocument: number | null = null
  private submittedAt = 0
  private startedAt = Date.now()
  private clearLogout = false
  private state: AccountLoginState

  constructor(
    private readonly contents: WebContents,
    private readonly loginUrl: URL,
    profile: AccountProfile,
    private readonly credentials: () => { username: string; password: string },
    private readonly changed: (state: AccountLoginState) => void
  ) {
    this.state = { id: profile.id, label: profile.label, username: profile.username, status: 'checking', message: '正在检查登录状态' }
    this.changed(this.state)
    this.timer = setInterval(() => { void this.check() }, 600)
    this.clearLogout = true
  }

  getState(): AccountLoginState { return { ...this.state } }
  cancelLogout(): void { this.clearLogout = true }
  retry(): void {
    if (this.busy || this.state.status === 'signed-in' || this.state.status === 'signing-in') return
    this.attempted = false
    this.submittedDocument = null
    this.startedAt = Date.now()
    this.clearLogout = true
    this.update('checking', '正在重新检查登录状态')
    void this.check()
  }
  dispose(): void { this.disposed = true; clearInterval(this.timer) }

  private update(status: AccountLoginState['status'], message: string): void {
    if (this.disposed || (status === this.state.status && message === this.state.message)) return
    this.state = { ...this.state, status, message }
    this.changed(this.getState())
  }

  private async check(): Promise<void> {
    if (this.busy || this.disposed || this.contents.isDestroyed()) return
    this.busy = true
    try {
      // Credentials are only sent to the exact configured login origin and path.
      const frames = this.contents.mainFrame.framesInSubtree.filter(frame => {
        try { return new URL(frame.url).origin === this.loginUrl.origin } catch { return false }
      })
      const snapshots: Array<{ frame: Electron.WebFrameMain; page: ReturnType<typeof inspectLoginPage> }> = []
      for (const frame of frames) {
        try {
          const page = await frame.executeJavaScript(`(${inspectLoginPage.toString()})(${this.clearLogout})`) as ReturnType<typeof inspectLoginPage>
          snapshots.push({ frame, page })
        } catch { /* Navigation can replace a frame while it is being inspected. */ }
      }
      if (this.disposed) return
      if (snapshots.length) this.clearLogout = false
      const login = snapshots.find(({ frame, page }) => page.login && new URL(frame.url).pathname.toLowerCase() === this.loginUrl.pathname.toLowerCase())
      if (snapshots.some(({ page }) => page.logoutRequested) && (login || !snapshots.some(({ page }) => page.authenticated))) {
        this.update('paused', '已暂停自动登录，可点击“重新登录”恢复')
        return
      }
      const mismatch = snapshots.find(({ page }) => page.identity && page.identity !== this.state.username)
      if (mismatch) { this.update('mismatch', '当前 ERP 身份与预设账号不一致，请退出后重新登录'); return }
      if (!login && snapshots.some(({ page }) => page.authenticated)) {
        this.attempted = false
        this.update('signed-in', '已登录')
        return
      }
      if (this.state.status === 'paused' || this.state.status === 'mismatch' || this.state.status === 'failed') return
      if (login) {
        if (this.attempted) {
          if (login.page.error || login.page.documentId !== this.submittedDocument || Date.now() - this.submittedAt > 20000) {
            this.update('failed', '登录未成功，请检查账号密码后点击“重新登录”')
          }
          return
        }
        this.attempted = true
        this.submittedAt = Date.now()
        this.submittedDocument = login.page.documentId
        this.update('signing-in', '正在自动登录')
        const secret = this.credentials()
        try {
          const submitted = await login.frame.executeJavaScript(`(${submitLogin.toString()})(${JSON.stringify(secret.username)},${JSON.stringify(secret.password)},${JSON.stringify(this.loginUrl.origin)},${JSON.stringify(this.loginUrl.pathname)})`, true)
          if (!submitted) this.update('failed', '登录页面已变化，请手动登录或重试')
        } catch { /* A successful submit may destroy the execution context. Check the next page. */ }
        finally { secret.password = '' }
      } else if ((this.state.status === 'checking' && Date.now() - this.startedAt > 30000) ||
        (this.state.status === 'signing-in' && Date.now() - this.submittedAt > 30000)) {
        this.update('failed', '未能确认登录状态，请检查 ERP 页面或手动登录')
      }
    } catch {
      this.update('failed', '自动登录未完成，请检查账号配置或手动登录')
    } finally { this.busy = false }
  }
}

// Bundle with esbuild (external: electron), then run with Electron.
// Uses only local pages. Native dialog responses are stubbed to avoid visible UI.
import assert from 'node:assert/strict'
import { app, BrowserWindow, WebContentsView, dialog, type MessageBoxSyncOptions } from 'electron'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ErpViewController } from '../src/main/erp-view'
import { WorkflowSessionManager } from '../src/main/workflow-session-manager'
import type { BusinessExtraction } from '../src/shared/business'

mkdirSync(resolve('tmp'), { recursive: true })
app.setPath('userData', resolve('tmp/erp-navigation-test-profile'))
app.on('window-all-closed', () => {})
const checks: string[] = []
const deadline = setTimeout(() => finish(new Error('Navigation test timed out')), 30000)
function finish(error?: unknown): void {
  clearTimeout(deadline)
  writeFileSync(resolve('tmp/erp-navigation-test-result.json'), JSON.stringify({ passed: !error, checks, error: error instanceof Error ? error.stack : error ? String(error) : null }, null, 2))
  app.exit(error ? 1 : 0)
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Expected navigation/dialog state was not reached')
}

async function run(): Promise<void> {
  await app.whenReady()
  const editor = `<input id="Ename" value="SPSHDJ"><input id="Cname" value="商品收货登记"><input id="Mode" value="Add"><input id="unsaved" value="未保存内容">
    <script>window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = 'Unsaved'; return 'Unsaved'; });</script>`
  const logout = `<button id="logout" onclick="location.href='/logged-out'">退出当前账号</button>`
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(request.url === '/logged-out' ? '登录页面' : request.url === '/plain' ? logout : request.url === '/editor' ? editor :
      request.url === '/nested' ? logout + '<iframe src="/editor" style="width:600px;height:400px"></iframe>' : logout + editor)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const originalDialog = dialog.showMessageBoxSync
  let response = 0
  const dialogs: MessageBoxSyncOptions[] = []
  dialog.showMessageBoxSync = ((_window: BrowserWindow, options: MessageBoxSyncOptions) => {
    dialogs.push(options)
    return response
  }) as typeof dialog.showMessageBoxSync

  try {
    for (const path of ['/guarded', '/nested']) {
      const url = new URL(`http://127.0.0.1:${port}${path}`)
      const window = new BrowserWindow({ show: false, width: 1280, height: 800 })
      const sessions = new WorkflowSessionManager()
      const controller = new ErpViewController(window, { url, allowedOrigins: new Set([url.origin]) }, state => sessions.retainOpenPages(state.openPageIds))
      const contents = (window.contentView.children[0] as WebContentsView).webContents
      await until(() => !!controller.getState().currentPage?.pageId)
      const pageId = controller.getState().currentPage!.pageId!
      const extraction = { documentType: 'goods-receipt' } as BusinessExtraction
      sessions.bindToPage('cached', 'goods-receipt', pageId)
      sessions.complete('cached', 'goods-receipt', extraction)
      response = 0
      const dialogCount = dialogs.length
      await contents.executeJavaScript(`document.getElementById('logout').click()`, true)
      await until(() => dialogs.length > dialogCount)
      assert.equal(dialogs.at(-1)!.defaultId, 0)
      assert.equal(dialogs.at(-1)!.cancelId, 0)
      assert.equal(contents.getURL(), url.href)
      assert.equal(sessions.getExtraction('cached', 'goods-receipt'), extraction)
      const retainedText = await contents.executeJavaScript(`(document.getElementById('unsaved') || document.querySelector('iframe').contentDocument.getElementById('unsaved')).value`)
      assert.equal(retainedText, '未保存内容')
      checks.push(`${path}: cancelling logout retains the document and its recognition cache`)

      response = 1
      await contents.executeJavaScript(`document.getElementById('logout').click()`, true)
      await until(() => contents.getURL().endsWith('/logged-out') && controller.getState().openPageIds.length === 0)
      assert.throws(() => sessions.getExtraction('cached', 'goods-receipt'))
      assert.throws(() => sessions.complete('cached', 'goods-receipt', extraction))
      checks.push(`${path}: confirming logout reaches login page, clears cached data and rejects late OCR`)
      controller.dispose()
      window.destroy()
    }
    const url = new URL(`http://127.0.0.1:${port}/plain`)
    const window = new BrowserWindow({ show: false })
    const controller = new ErpViewController(window, { url, allowedOrigins: new Set([url.origin]) }, () => {})
    const contents = (window.contentView.children[0] as WebContentsView).webContents
    await new Promise<void>(resolve => contents.once('did-finish-load', () => resolve()))
    const count = dialogs.length
    await contents.executeJavaScript(`document.getElementById('logout').click()`, true)
    await until(() => contents.getURL().endsWith('/logged-out'))
    assert.equal(dialogs.length, count)
    checks.push('Ordinary logout without beforeunload proceeds without an extra confirmation')
    controller.dispose()
    window.destroy()
  } finally {
    dialog.showMessageBoxSync = originalDialog
    server.close()
  }
}

void run().then(() => finish(), finish)

// Run after `npm run build`; uses local fake ERP pages and no model/network API.
import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, type WebContentsView } from 'electron'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ErpViewController } from '../src/main/erp-view'
import { WorkflowSessionManager } from '../src/main/workflow-session-manager'
import { ERP_IPC } from '../src/shared/erp'
import { OCR_IPC } from '../src/shared/ocr'
import { normalizeGoodsReceiptSubmission } from '../src/main/businesses/goods-receipt-tool'
import fixture from '../test-data/goods-receipt.ckfh26070523.json'

const reportPath = resolve('tmp/session-cache-electron-result.json')
mkdirSync(resolve('tmp'), { recursive: true })
app.setPath('userData', resolve('tmp/session-cache-electron-profile'))
const report: string[] = []
const timeout = setTimeout(() => finish(new Error('Electron regression timed out')), 40000)
function finish(error?: unknown): void {
  clearTimeout(timeout)
  writeFileSync(reportPath, JSON.stringify({ passed: !error, checks: report, error: error instanceof Error ? error.stack : error ? String(error) : null }, null, 2))
  app.exit(error ? 1 : 0)
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error('Condition was not satisfied within 8 seconds')
}

async function run(): Promise<void> {
  await app.whenReady()
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(request.url === '/' ? '<iframe id="a" src="/form" style="width:800px;height:600px"></iframe><iframe id="b" src="/form" style="display:none;width:800px;height:600px"></iframe>' : `
      <input id="Ename" value="SPSHDJ"><input id="Cname" value="商品收货登记"><input id="Mode" value="Add">
      ${['DWMC', 'DWBH', 'QYRQ', 'CYDW', 'CYFS', 'SHDJBZ'].map(id => `<input id="${id}">`).join('')}
      <script>
        const rows = [];
        window.gridEditBody = { getRows: () => rows };
        window.gridhandler = () => {
          const cells = Object.fromEntries('SPMC SPBH GG SCCS DW DJ DHSL SHSL JSSL SPPH SCRQ YXQZ SPM JX BZ'.split(' ').map(key => [key, {
            value: '', setValue(value) { this.value = value }, getValue() { return this.value }
          }]));
          rows.push({ cells: () => cells });
        };
      </script>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const url = new URL(`http://127.0.0.1:${address.port}/`)
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: resolve('out/preload/index.js'), contextIsolation: true, sandbox: true } })
  const sessions = new WorkflowSessionManager()
  const controller = new ErpViewController(window, { url, allowedOrigins: new Set([url.origin]) }, state => {
    sessions.retainOpenPages(state.openPageIds)
    window.webContents.send(ERP_IPC.stateChanged, state)
  })
  const erp = (window.contentView.children[0] as WebContentsView).webContents
  let recognitions = 0
  const filledSessionIds: string[] = []
  const extraction = normalizeGoodsReceiptSubmission({ header: fixture.erpPayload.header, items: fixture.erpPayload.items.map(item => ({ ...item, sourcePages: [1] })), evidence: [], reviewRequired: [] }, 1)
  ipcMain.handle(ERP_IPC.getState, () => controller.getState())
  ipcMain.handle(ERP_IPC.setAssistantWidth, () => {})
  ipcMain.handle(OCR_IPC.selectDocument, (_event, request) => {
    sessions.bindToPage(request.sessionId, request.businessId, request.pageId)
    return { status: 'ready', message: '', preview: { ...request, token: 'test', fileName: 'receipt.png', pageCount: 1, pages: [{ pageNumber: 1, thumbnailDataUrl: '' }] } }
  })
  ipcMain.handle(OCR_IPC.extractDocument, (_event, request) => {
    recognitions++
    sessions.complete(request.sessionId, request.businessId, extraction)
    return { status: 'completed', message: '', result: { businessId: 'goods-receipt', fileName: 'receipt.png', pageCount: 1, coveragePercent: 100, pages: [], warnings: [], extractedData: extraction } }
  })
  ipcMain.handle(ERP_IPC.fillSession, async (_event, request) => {
    filledSessionIds.push(request.sessionId)
    await controller.refreshPageContext()
    return controller.fillExtractedData(request.businessId, sessions.getExtraction(request.sessionId, request.businessId), sessions.getPageId(request.sessionId, request.businessId))
  })
  await until(() => controller.getState().openPageIds.length === 2)
  const original = controller.getState().currentPage!.pageId!
  assert.equal(new Set(controller.getState().openPageIds).size, 2)
  await window.loadFile(resolve('out/renderer/index.html'))
  const buttonVisible = (label: string) => window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === ${JSON.stringify(label)} && !button.disabled)`)
  const click = async (label: string) => {
    await until(() => buttonVisible(label))
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
  }
  await click('选择票据并筛选页面')
  await click('开始识别 1 页')
  await click('确认并代填')
  await until(() => buttonVisible('重新代填'))
  await erp.executeJavaScript(`document.getElementById('a').contentWindow.gridEditBody.getRows().splice(0); void 0`)
  await click('重新代填')
  await until(() => filledSessionIds.length === 2 && buttonVisible('重新代填'))
  assert.equal(recognitions, 1)
  assert.equal(new Set(filledSessionIds).size, 1)
  assert.equal(await erp.executeJavaScript(`document.getElementById('a').contentWindow.gridEditBody.getRows().length`), 7)
  report.push('Actual renderer repeats autofill from the same cached session, restoring 7 deleted rows with only one recognition')

  await erp.executeJavaScript(`document.getElementById('a').style.display='none';document.getElementById('b').style.display='block'`)
  await until(() => controller.getState().currentPage?.pageId !== original)
  await until(() => buttonVisible('选择票据并筛选页面'))
  assert.equal(await buttonVisible('重新代填'), false)
  assert.equal(sessions.getExtraction(filledSessionIds[0], 'goods-receipt'), extraction)
  const wrongPage = await controller.fillExtractedData('goods-receipt', extraction, original)
  assert.equal(wrongPage.status, 'wrong-page')
  await erp.executeJavaScript(`document.getElementById('b').style.display='none';document.getElementById('a').style.display='block'`)
  await until(() => buttonVisible('重新代填'))
  report.push('Two identical business URLs have distinct caches; tab switching restores the original result and rejects wrong-page filling')

  await erp.executeJavaScript(`document.getElementById('a').remove();document.getElementById('b').style.display='block'`)
  await until(() => !controller.getState().openPageIds.includes(original))
  assert.throws(() => sessions.getExtraction(filledSessionIds[0], 'goods-receipt'))
  assert.throws(() => sessions.complete(filledSessionIds[0], 'goods-receipt', extraction))
  await until(() => buttonVisible('选择票据并筛选页面'))
  report.push('Removing an ERP iframe without navigation clears its cache and rejects late recognition completion')

  const beforeReload = controller.getState().currentPage!.pageId!
  await erp.executeJavaScript(`document.getElementById('b').contentWindow.location.reload()`)
  await until(() => !!controller.getState().currentPage?.pageId && controller.getState().currentPage?.pageId !== beforeReload)
  report.push('Refreshing the same URL creates a new document identity')
  controller.dispose()
  window.destroy()
  server.close()
}

void run().then(() => finish(), finish)

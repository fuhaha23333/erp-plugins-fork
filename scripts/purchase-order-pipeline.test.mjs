import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { build } from 'esbuild'
import { createReceiptPdf } from './receipt-pdf-fixture.mjs'

const root = process.cwd()
const dir = resolve(root, 'tmp/purchase-order-pipeline')
await mkdir(dir, { recursive: true })
await build({ stdin: { contents: `export { PiDocumentClient } from './src/main/agent/pi-document-client'; export { loadPiAgentConfig } from './src/main/agent/config';`, resolveDir: root, loader: 'ts' },
  outfile: resolve(dir, 'runtime.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm',
  define: { 'import.meta.env': '{"MAIN_VITE_PI_OCR_BASE_URL":"https://example.invalid/v1"}' } })
const { PiDocumentClient, loadPiAgentConfig } = await import(pathToFileURL(resolve(dir, 'runtime.mjs')).href)
const fixture = JSON.parse(await readFile('test-data/normalizer-replay/purchase-order-simple.json', 'utf8'))
const image = resolve(dir, 'wide.png')
await writeFile(image, createCanvas(800, 300).toBuffer('image/png'))
const pdf = resolve(dir, 'pages.pdf')
await writeFile(pdf, await createReceiptPdf(image, 2))
const header = '合成供货公司\n票号：TEST123456 发货日期：2026-10-10\n通用名称 规格 数量 单价\n合成商品 12片 240 3.57'

function sse(body, text, page = 2, transform = () => {}) {
  const expected = structuredClone(fixture.expected)
  expected.header.receiptRemark = null
  expected.header.remark = null
  // Identical independent source rows must survive overlapping image views.
  expected.items = [expected.items[0], structuredClone(expected.items[0])]
  expected.items.forEach(item => { item.sourcePages = [page] })
  transform(expected)
  const delta = body.tools?.length
    ? { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function', function: {
      name: 'submit_purchase_order', arguments: JSON.stringify({ ...expected, evidence: [], reviewRequired: [] })
    } }] }
    : { role: 'assistant', content: text }
  return new Response(`data: ${JSON.stringify({ id: 'test', model: body.model, choices: [{ index: 0, delta, finish_reason: body.tools?.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}

function config() {
  const value = loadPiAgentConfig()
  value.ocr.apiKey = value.normalizer.apiKey = 'test-key'
  value.pageTimeoutMs = value.normalizationTimeoutMs = 2000
  value.modelConcurrency = value.ocrConcurrency = value.normalizerConcurrency = 1
  return value
}

test('selected page alone receives two overlapping detail checks; normalizer runs once and retains original duplicate rows', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.enable_thinking, false)
    requests.push(body)
    if (body.tools?.length) {
      const text = JSON.stringify(body.messages)
      assert.match(text, /原文件第 2\/2 页/)
      assert.match(text, /同页商品局部核对：左侧/)
      assert.match(text, /同页商品局部核对：右侧/)
    } else {
      assert.match(JSON.stringify(body.messages), /第 2 页/)
      assert.match(JSON.stringify(body.messages), /data:image\/(png|jpeg);base64/)
    }
    return sse(body, header)
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, () => {}, { businessId: 'purchase-order', excludedPages: [1] })
  assert.equal(result.status, 'completed', result.message)
  assert.equal(requests.length, 4)
  assert.equal(result.result.pages[0].source, 'skipped-user')
  assert.equal(result.result.extractedData.items.length, 2)
  assert.ok(result.result.extractedData.items.every(item => item.sourcePages[0] === 2))
})

const sparseFields = ['specification', 'manufacturer', 'approvalNumber', 'unit', 'batchNumber', 'productionDate', 'expiryDate', 'quantity', 'taxIncludedUnitPrice']
function makeSparse(expected, missing = 10) {
  for (const key of sparseFields) expected.items[0][key] = null
  for (const key of sparseFields.slice(0, missing - 9)) expected.items[1][key] = null
}

test('overall 45% missing does not recover even though one row is 90% missing', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); count++
    return sse(body, header, 2, expected => makeSparse(expected, 9))
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, () => {}, { businessId: 'purchase-order', excludedPages: [1] })
  assert.equal(result.status, 'completed', result.message)
  assert.equal(count, 4)
  assert.equal(result.result.extractedData.items[0].specification, null)
})

test('exactly 50% overall missing triggers once, fills all rows, keeps header and never appends duplicate rows', async t => {
  let count = 0, normalized = 0
  const progress = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); count++
    assert.equal(body.enable_thinking, false)
    if (body.tools?.length) normalized++
    if (normalized === 2) assert.match(JSON.stringify(body.messages), /同页商品放大补救分区/)
    return sse(body, header, 2, expected => {
      if (normalized === 1) makeSparse(expected)
      if (normalized === 2) expected.header.supplierName = '补救不得改写供应商'
    })
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, event => progress.push(event.message), { businessId: 'purchase-order', excludedPages: [1] })
  assert.equal(result.status, 'completed', result.message)
  assert.equal(count, 7)
  assert.equal(normalized, 2)
  assert.equal(result.result.extractedData.items.length, 2)
  assert.equal(result.result.extractedData.header.supplierName, fixture.expected.header.supplierName)
  assert.ok(result.result.extractedData.items.every(item => item.specification && item.quantity))
  assert.ok(progress.some(message => message.includes('整单商品关键字段缺失 10/20（50%）')))
  assert.ok(result.result.warnings.some(message => message.includes('补全 10 个关键字段')))
})

test('recovery without improvement stops after one round and keeps first result', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); count++
    return sse(body, header, 2, makeSparse)
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, () => {}, { businessId: 'purchase-order', excludedPages: [1] })
  assert.equal(result.status, 'completed', result.message)
  assert.equal(count, 7)
  assert.equal(result.result.extractedData.items[0].specification, null)
  assert.ok(result.result.warnings.some(message => message.includes('已停止自动补救')))
})

test('failed enlarged OCR keeps the first extraction and stops retrying', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); count++
    return sse(body, count >= 5 ? '未检测到文字' : header, 2, makeSparse)
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, () => {}, { businessId: 'purchase-order', excludedPages: [1] })
  assert.equal(result.status, 'completed', result.message)
  assert.equal(count, 5)
  assert.equal(result.result.extractedData.items.length, 2)
  assert.ok(result.result.warnings.some(message => message.includes('已保留首次识别结果')))
})

test('zero extracted products triggers recovery and accepts recovered rows once', async t => {
  let normalized = 0, count = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); count++
    if (body.tools?.length) normalized++
    return sse(body, header, 2, expected => { if (normalized === 1) expected.items = [] })
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, () => {}, { businessId: 'purchase-order', excludedPages: [1] })
  assert.equal(result.status, 'completed', result.message)
  assert.equal(count, 7)
  assert.equal(result.result.extractedData.items.length, 2)
})

test('a timed-out recovery request is aborted and preserves the first extraction', async t => {
  let count = 0, aborted = false
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); count++
    if (count === 5) return new Promise((_resolve, reject) => {
      const abort = () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')) }
      if (init.signal.aborted) abort()
      else init.signal.addEventListener('abort', abort, { once: true })
    })
    return sse(body, header, 2, makeSparse)
  })
  const value = config(); value.pageTimeoutMs = 100
  const result = await new PiDocumentClient(value).extractDocument(pdf, () => {}, { businessId: 'purchase-order', excludedPages: [1] })
  assert.equal(result.status, 'completed', result.message)
  assert.equal(count, 5)
  assert.equal(aborted, true)
  assert.equal(result.result.extractedData.items.length, 2)
  assert.ok(result.result.warnings.some(message => message.includes('已保留首次识别结果')))
})

test('overall assessment spans selected pages instead of triggering on one sparse page', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); count++
    const page = /原文件第 2\/2 页/.test(JSON.stringify(body.messages)) ? 2 : 1
    return sse(body, header, page, expected => { if (page === 1) makeSparse(expected) })
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, () => {}, { businessId: 'purchase-order' })
  assert.equal(result.status, 'completed', result.message)
  assert.equal(count, 8)
  assert.equal(result.result.extractedData.items.length, 4)
  assert.equal(result.result.warnings.some(message => message.includes('已触发一次商品区域放大补救')), false)
})

test('cancellation during post-normalization recovery prevents further requests', async t => {
  const controller = new AbortController()
  let count = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); count++
    if (count === 5) { controller.abort(); throw new DOMException('Aborted', 'AbortError') }
    return sse(body, header, 2, makeSparse)
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, () => {}, { businessId: 'purchase-order', excludedPages: [1], signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.equal(count, 5)
})

test('an unusable detail view is bounded to one attempt and retains full-page OCR with a warning', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body)
    count++
    return sse(body, count === 2 ? '未检测到文字' : header)
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, () => {}, { businessId: 'purchase-order', excludedPages: [1] })
  assert.equal(result.status, 'completed', result.message)
  assert.equal(count, 4)
  assert.ok(result.result.warnings.some(message => message.includes('商品局部 1 核对失败')))
  assert.ok(result.result.pages[1].text.startsWith(header))
})

test('cancelling during detail OCR prevents remaining view and normalizer requests', async t => {
  const controller = new AbortController()
  let count = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body)
    count++
    if (count === 2) {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    }
    return sse(body, header)
  })
  const result = await new PiDocumentClient(config()).extractDocument(pdf, () => {}, {
    businessId: 'purchase-order', excludedPages: [1], signal: controller.signal
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(count, 2)
})

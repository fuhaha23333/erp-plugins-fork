import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { createCanvas } from '@napi-rs/canvas'
import { createReceiptPdf } from './receipt-pdf-fixture.mjs'

await mkdir('tmp/page-pipeline', { recursive: true })
await build({ stdin: { contents: `
  export { PiDocumentClient } from './src/main/agent/pi-document-client';
  export { loadPiAgentConfig } from './src/main/agent/config';
`, resolveDir: process.cwd(), loader: 'ts' }, outfile: 'tmp/page-pipeline/runtime.mjs',
  bundle: true, packages: 'external', platform: 'node', format: 'esm',
  define: { 'import.meta.env': JSON.stringify({ DEV: true,
    MAIN_VITE_PI_OCR_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }) } })
const app = await import('../tmp/page-pipeline/runtime.mjs')
const fixture = JSON.parse(await readFile('test-data/normalizer-replay/goods-receipt-simple.json'))
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function pdfFixture(t, pages = 4) {
  const dir = await mkdtemp(resolve(tmpdir(), 'erp-page-pipeline-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const image = resolve(dir, 'synthetic.png')
  await writeFile(image, createCanvas(32, 32).toBuffer('image/png'))
  const file = resolve(dir, 'synthetic.pdf')
  await writeFile(file, await createReceiptPdf(image, pages))
  return file
}

function config(overrides = {}) {
  const c = app.loadPiAgentConfig()
  c.ocr.apiKey = c.normalizer.apiKey = 'synthetic-test-key'
  return { ...c, ocrConcurrency: 2, normalizerConcurrency: 1, modelConcurrency: 2,
    pageTimeoutMs: 2000, normalizationTimeoutMs: 2000, ...overrides }
}

function response(body, page) {
  const submission = structuredClone({ ...fixture.expected, evidence: [], reviewRequired: [] })
  submission.header.supplierName = `合成供货方${page}`
  for (const item of submission.items) item.sourcePages = [page]
  const delta = body.tools?.length ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${page}`,
    type: 'function', function: { name: 'submit_goods_receipt', arguments: JSON.stringify(submission) } }] }
    : { role: 'assistant', content: fixture.ocrText }
  const chunk = { id: `response_${page}`, model: body.model, choices: [{ index: 0, delta,
    finish_reason: body.tools?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}

function requestInfo(init) {
  const body = JSON.parse(init.body)
  const stage = body.tools?.length ? 'normalizer' : 'ocr'
  const text = JSON.stringify(body.messages)
  const page = Number((stage === 'ocr' ? text.match(/这是原文件的第 (\d+) 页/) : text.match(/原文件第 (\d+)\/\d+ 页/))?.[1])
  assert.ok(page > 0)
  return { body, stage, page }
}

test('queue defaults preserve the old total budget and validate explicit stage limits', (t) => {
  const names = ['MAIN_VITE_PI_OCR_CONCURRENCY', 'MAIN_VITE_PI_NORMALIZER_CONCURRENCY', 'MAIN_VITE_PI_MODEL_CONCURRENCY']
  for (const name of names) { const old = process.env[name]; delete process.env[name]; t.after(() => {
    if (old === undefined) delete process.env[name]; else process.env[name] = old
  }) }
  assert.equal(app.loadPiAgentConfig().modelConcurrency, 8)
  assert.equal(app.loadPiAgentConfig().normalizerConcurrency, 4)
  process.env[names[0]] = '1'
  assert.equal(app.loadPiAgentConfig().modelConcurrency, 1)
  assert.equal(app.loadPiAgentConfig().normalizerConcurrency, 1)
  process.env[names[2]] = '3'
  process.env[names[1]] = '2'
  assert.equal(app.loadPiAgentConfig().modelConcurrency, 3)
  assert.equal(app.loadPiAgentConfig().normalizerConcurrency, 2)
  process.env[names[1]] = '0'
  assert.throws(() => app.loadPiAgentConfig(), /必须是正整数/)
})

test('later OCR starts while early normalizer is held; stage and shared caps apply and excluded pages stay local', async (t) => {
  const file = await pdfFixture(t)
  const gate = defer(), started = defer()
  const ocrPages = [], counts = { ocr: 0, normalizer: 0 }, peak = { ocr: 0, normalizer: 0, total: 0 }
  const logs = []
  t.mock.method(console, 'info', (label, data) => logs.push({ label, data: JSON.parse(data) }))
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { body, stage, page } = requestInfo(init)
    counts[stage]++; peak[stage] = Math.max(peak[stage], counts[stage])
    peak.total = Math.max(peak.total, counts.ocr + counts.normalizer)
    try {
      if (stage === 'ocr') ocrPages.push(page)
      else { started.resolve(); await gate.promise }
      return response(body, page)
    } finally { counts[stage]-- }
  })
  const pending = new app.PiDocumentClient(config()).extractDocument(file, () => {}, { businessId: 'goods-receipt', excludedPages: [2] })
  let assertionError
  try {
    await Promise.race([started.promise, delay(1500).then(() => { throw Error('normalizer did not start') })])
    for (let i = 0; i < 30 && !ocrPages.includes(4); i++) await delay(10)
    assert.ok(ocrPages.includes(4), 'page 4 OCR must not wait for early normalizer completion')
    assert.ok(peak.normalizer <= 1)
    assert.ok(peak.ocr <= 2 && peak.total <= 2)
  } catch (error) { assertionError = error }
  finally { gate.resolve() }
  const result = await pending
  if (assertionError) throw assertionError
  assert.equal(result.status, 'completed', result.message)
  assert.deepEqual(ocrPages.sort((a, b) => a - b), [1, 3, 4])
  assert.deepEqual(result.result.extractedData.items.map((item) => item.sourcePages[0]), [1, 1, 3, 3, 4, 4])
  const doc = logs.find((x) => x.label === '[Performance][Document]').data
  assert.equal(doc.unsettledPages, 0)
  assert.ok(doc.cumulative.normalizerQueueMs > 0)
  assert.ok(doc.cumulative.ocrQueueMs >= 0)
})

test('reverse normalizer completion still merges in original page order and preserves equal-confidence first-page fields', async (t) => {
  const file = await pdfFixture(t, 2)
  const secondFinished = defer(), completionOrder = []
  t.mock.method(console, 'info', () => {})
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { body, stage, page } = requestInfo(init)
    if (stage === 'normalizer') {
      if (page === 1) await secondFinished.promise
      else secondFinished.resolve()
      completionOrder.push(page)
    }
    return response(body, page)
  })
  const result = await new app.PiDocumentClient(config({ normalizerConcurrency: 2 })).extractDocument(file, () => {}, { businessId: 'goods-receipt' })
  assert.equal(result.status, 'completed', result.message)
  assert.deepEqual(completionOrder, [2, 1])
  assert.equal(result.result.extractedData.header.supplierName, '合成供货方1')
  assert.deepEqual(result.result.extractedData.items.map((item) => item.sourcePages[0]), [1, 1, 2, 2])
})

test('OCR failure and normalizer timeout release the single shared slot and do not block later pages', async (t) => {
  const file = await pdfFixture(t)
  const logs = [], normalizerPages = []
  t.mock.method(console, 'info', (label, data) => logs.push({ label, data: JSON.parse(data) }))
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { body, stage, page } = requestInfo(init)
    if (stage === 'ocr' && page === 1) return new Response(JSON.stringify({ error: { message: 'synthetic failure' } }),
      { status: 400, headers: { 'content-type': 'application/json' } })
    if (stage === 'normalizer') {
      normalizerPages.push(page)
      if (page === 2) return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('synthetic aborted request')), { once: true })
      })
    }
    return response(body, page)
  })
  const result = await new app.PiDocumentClient(config({ ocrConcurrency: 1, modelConcurrency: 1, normalizationTimeoutMs: 60 }))
    .extractDocument(file, () => {}, { businessId: 'goods-receipt' })
  assert.equal(result.status, 'completed', result.message)
  assert.deepEqual(normalizerPages, [2, 3, 4], 'failed OCR must never enter normalizer')
  assert.deepEqual(result.result.extractedData.items.map((x) => x.sourcePages[0]), [3, 3, 4, 4])
  assert.equal(result.result.pages[0].source, 'skipped-error')
  assert.ok(result.result.warnings.some((x) => x.includes('第 2 页字段标准化失败')))
  assert.equal(logs.find((x) => x.label === '[Performance][Document]').data.unsettledPages, 0)
  assert.equal(logs.filter((x) => x.label.startsWith('[Performance][Page')).length, 4)
})

test('unexpected document failure aborts active requests, rejects queued pages and settles before returning', async (t) => {
  const file = await pdfFixture(t)
  const logs = []
  let heldRequestAborted = false
  t.mock.method(console, 'info', (label, data) => logs.push({ label, data: JSON.parse(data) }))
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { body, stage, page } = requestInfo(init)
    if (stage === 'ocr' && page === 2) return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { heldRequestAborted = true; reject(Error('synthetic aborted')) }, { once: true })
    })
    return response(body, page)
  })
  const result = await new app.PiDocumentClient(config()).extractDocument(file, (progress) => {
    if (progress.message.startsWith('已完成 1/')) throw Error('synthetic progress failure')
  }, { businessId: 'goods-receipt' })
  assert.equal(result.status, 'failed')
  assert.ok(result.message.includes('synthetic progress failure'))
  assert.equal(heldRequestAborted, true)
  const doc = logs.find((x) => x.label === '[Performance][Document]').data
  assert.equal(doc.status, 'failed')
  assert.equal(doc.unsettledPages, 0)
  const count = logs.length
  await delay(20)
  assert.equal(logs.length, count, 'no orphan page continues after the document returned')
})

test('fatal failure during rendering prevents not-yet-created agents from sending requests after document abort', async (t) => {
  const file = await pdfFixture(t)
  t.mock.method(console, 'info', () => {})
  const originalAbort = AbortController.prototype.abort
  let documentAborted = false, requestsAfterAbort = 0
  t.mock.method(AbortController.prototype, 'abort', function (reason) {
    if (reason?.message === 'synthetic render failure') documentAborted = true
    return originalAbort.call(this, reason)
  })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (documentAborted) requestsAfterAbort++
    const { body, page } = requestInfo(init)
    return response(body, page)
  })
  const result = await new app.PiDocumentClient(config()).extractDocument(file, (progress) => {
    if (progress.message.startsWith('正在渲染第 1 页')) throw Error('synthetic render failure')
  }, { businessId: 'goods-receipt' })
  assert.equal(result.status, 'failed')
  assert.equal(documentAborted, true)
  assert.equal(requestsAfterAbort, 0)
})

test('concurrent documents share one model budget and cancelling one leaves the other running', async (t) => {
  const file = await pdfFixture(t, 2)
  t.mock.method(console, 'info', () => {})
  const started = defer()
  let requests = 0, active = 0, peak = 0, aborted = false
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { body, page } = requestInfo(init)
    const ordinal = ++requests
    active++; peak = Math.max(peak, active)
    try {
      if (ordinal === 1) {
        started.resolve()
        await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
          aborted = true; reject(new Error('window closed'))
        }, { once: true }))
      }
      await delay(10)
      return response(body, page)
    } finally { active-- }
  })
  const client = new app.PiDocumentClient(config({ modelConcurrency: 1, ocrConcurrency: 1 }))
  const controller = new AbortController()
  const first = client.extractDocument(file, () => {}, { businessId: 'goods-receipt', signal: controller.signal })
  await started.promise
  const second = client.extractDocument(file, () => {}, { businessId: 'goods-receipt' })
  await delay(50)
  assert.equal(requests, 1, 'other documents must queue behind the shared limit')
  controller.abort(new Error('window closed'))
  const [cancelled, completed] = await Promise.all([first, second])
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(completed.status, 'completed', completed.message)
  assert.equal(aborted, true)
  assert.equal(peak, 1)
  assert.equal(active, 0)
  assert.equal(completed.result.extractedData.items.length, 4)
})

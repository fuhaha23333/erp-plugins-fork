import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { createCanvas } from '@napi-rs/canvas'

const root = fileURLToPath(new URL('..', import.meta.url))
const flag = 'MAIN_VITE_PI_NORMALIZER_ENABLE_THINKING'
const endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
let bundleId = 0

async function runtime(env = {}) {
  const outfile = resolve(root, `tmp/normalizer-config/runtime-${++bundleId}.mjs`)
  await mkdir(resolve(root, 'tmp/normalizer-config'), { recursive: true })
  await build({ stdin: { contents: `
    export { loadPiAgentConfig } from './src/main/agent/config';
    export { PiDocumentClient } from './src/main/agent/pi-document-client';
    export { getExtractionAdapter } from './src/main/businesses/extraction-registry';
  `, resolveDir: root, loader: 'ts' }, outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm',
    define: { 'import.meta.env': JSON.stringify({ MAIN_VITE_PI_OCR_BASE_URL: endpoint, ...env }) } })
  return import(pathToFileURL(outfile).href)
}

function setEnv(t, name, value) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  t.after(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
}

test('legacy thinking switches cannot enable thinking or prevent startup', async (t) => {
  const app = await runtime()
  setEnv(t, flag, undefined)
  for (const value of [undefined, '', 'true', 'false', 'PRIVATE_INVALID_VALUE']) {
    if (value === undefined) delete process.env[flag]
    else process.env[flag] = value
    assert.equal(Object.hasOwn(app.loadPiAgentConfig(), 'normalizerThinking'), false)
  }
})

test('old bundled true setting is ignored', async (t) => {
  setEnv(t, flag, 'true')
  const app = await runtime({ [flag]: 'true' })
  assert.equal(Object.hasOwn(app.loadPiAgentConfig(), 'normalizerThinking'), false)
})

for (const dev of [false, true]) {
  test(`OCR, OCR retry and normalizer always disable thinking; DEV=${dev}`, async (t) => {
    const app = await runtime({ DEV: dev })
    const fixture = JSON.parse(await readFile(resolve(root, 'test-data/normalizer-replay/goods-receipt-simple.json')))
    const directory = await mkdtemp(resolve(tmpdir(), 'erp-thinking-config-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const file = resolve(directory, 'synthetic.png')
    await writeFile(file, createCanvas(32, 32).toBuffer('image/png'))
    setEnv(t, flag, undefined)
    setEnv(t, 'ERP_PERFORMANCE_LOG', '1')
    const logs = []
    t.mock.method(console, 'info', (...args) => logs.push(args))
    let captured = []
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body)
      captured.push(body)
      const delta = body.tools?.length
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic_call', type: 'function', function: {
          name: 'submit_goods_receipt', arguments: JSON.stringify({ ...fixture.expected, evidence: [], reviewRequired: [] })
        } }] }
        : { role: 'assistant', content: captured.length === 1 ? '<img src="placeholder">' : fixture.ocrText }
      const chunk = { id: 'synthetic', model: body.model, choices: [{ index: 0, delta,
        finish_reason: body.tools?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    })
    for (const expected of [false, true, undefined]) {
      if (expected === undefined) delete process.env[flag]
      else process.env[flag] = String(expected)
      captured = []
      logs.length = 0
      const config = app.loadPiAgentConfig()
      config.ocr.apiKey = config.normalizer.apiKey = 'synthetic-test-key'
      const result = await new app.PiDocumentClient(config).extractDocument(file, () => {}, { businessId: 'goods-receipt' })
      assert.equal(result.status, 'completed', result.message)
      assert.equal(result.result.extractedData.items.length, 2)
      assert.equal(captured.length, 3, 'two OCR attempts and one terminating normalizer request')
      for (const body of captured) {
        assert.equal(body.enable_thinking, false)
        assert.equal(body.reasoning_effort, undefined)
      }
      if (!dev) assert.equal(logs.length, 0, 'production sends the flag even without diagnostics')
      else {
        const normalizerLog = logs.find(([label]) => label === '[Normalizer]')
        assert.ok(normalizerLog)
        assert.equal(JSON.parse(normalizerLog[1]).requests[0].enableThinking, false)
        assert.ok(!JSON.stringify(logs).includes(fixture.expected.header.supplierName))
      }
    }
  })
}

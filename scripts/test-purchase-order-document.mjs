import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Opt-in live acceptance: sends only the named user-provided receipts to the configured models.
const root = fileURLToPath(new URL('../', import.meta.url))
process.loadEnvFile(resolve(root, '.env'))
const fixturePath = resolve(root, 'test-data/purchase-order.receipts.json')
let fixtureText
try { fixtureText = await readFile(fixturePath, 'utf8') }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  console.error('缺少本地验收数据 test-data/purchase-order.receipts.json。请先配置已获授权的票据样例；真实票据及核对数据不随公开仓库分发。')
  process.exit(1)
}
const fixtures = JSON.parse(fixtureText).cases
const simulateMissingProducts = process.argv.includes('--simulate-missing-products')
const selectedId = process.argv.slice(2).find(arg => !arg.startsWith('--'))
const selected = selectedId ? fixtures.filter(f => f.id === selectedId) : fixtures
assert.ok(selected.length, 'Unknown receipt fixture')
const dir = resolve(root, 'tmp/purchase-order-document')
await mkdir(dir, { recursive: true })
const runtime = resolve(dir, 'runtime.mjs')
await build({ stdin: { contents: `
  export { PiDocumentClient } from './src/main/agent/pi-document-client';
  export { loadPiAgentConfig } from './src/main/agent/config';
`, resolveDir: root, loader: 'ts' }, outfile: runtime, bundle: true, packages: 'external',
platform: 'node', format: 'esm', define: { 'import.meta.env': '{"DEV":true}' } })
const { PiDocumentClient, loadPiAgentConfig } = await import(pathToFileURL(runtime).href)
const config = loadPiAgentConfig()
for (const endpoint of [config.ocr, config.normalizer]) {
  const url = new URL(endpoint.baseUrl)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.hostname, 'dashscope.aliyuncs.com', 'Live fixtures are authorized for the configured Bailian endpoint only')
}
const nativeFetch = globalThis.fetch
const canonical = value => typeof value === 'string' ? value.replace(/\s/g, '').replace(/[xX*]/g, '×') : value
const summaries = []
const template = JSON.parse(await readFile(resolve(root, 'test-data/normalizer-replay/purchase-order-simple.json'), 'utf8')).expected
let failed = false
for (const fixture of selected) {
  const requests = []
  let simulated = false
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.enable_thinking, false, 'All live requests must disable thinking')
    const simulate = simulateMissingProducts && body.tools?.length && !simulated
    requests.push({ model: body.model, thinking: body.enable_thinking, stage: body.tools?.length ? 'normalizer' : 'ocr', ...(simulate ? { simulated: true } : {}) })
    if (simulate) {
      simulated = true
      const expected = structuredClone(template)
      expected.header = { ...expected.header, ...fixture.header, receiptRemark: null, remark: null }
      expected.items = [{ ...expected.items[0], ...fixture.item, sourcePages: [1] }]
      for (const key of ['specification', 'manufacturer', 'approvalNumber', 'unit', 'batchNumber', 'productionDate', 'expiryDate']) expected.items[0][key] = null
      const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'simulate_missing', type: 'function', function: {
        name: 'submit_purchase_order', arguments: JSON.stringify({ ...expected, evidence: [], reviewRequired: [] })
      } }] }
      return new Response(`data: ${JSON.stringify({ id: 'simulated-first-normalization', model: body.model, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    return nativeFetch(url, init)
  }
  let result
  try {
    result = await new PiDocumentClient(config).extractDocument(resolve(root, fixture.sourceImage),
      progress => console.log(`[${fixture.id}] ${progress.message}`), { businessId: 'purchase-order' })
  } finally { globalThis.fetch = nativeFetch }
  await writeFile(resolve(dir, `${fixture.id}${simulateMissingProducts ? '-recovery' : ''}.json`), JSON.stringify(result, null, 2))
  const errors = []
  const actual = result.result?.extractedData
  if (result.status !== 'completed') errors.push(result.message)
  if (actual?.items.length !== 1) errors.push(`items.length: ${actual?.items.length} != 1`)
  for (const section of ['header', 'item']) {
    const values = section === 'header' ? actual?.header : actual?.items[0]
    for (const [key, expected] of Object.entries(fixture[section])) {
      if (canonical(values?.[key]) !== canonical(expected)) errors.push(`${section}.${key}: ${JSON.stringify(values?.[key])} != ${JSON.stringify(expected)}`)
    }
  }
  if (!actual?.readyForAutofill) errors.push('readyForAutofill=false')
  if (simulateMissingProducts && !result.result?.warnings.some(message => message.includes('补全 7 个关键字段'))) errors.push('Recovery did not fill all 7 simulated missing fields')
  const summary = { id: fixture.id, simulatedMissingFields: simulateMissingProducts ? 7 : 0, elapsedMs: result.result?.elapsedMs, requests, errors }
  summaries.push(summary)
  console.log(JSON.stringify(summary, null, 2))
  failed ||= errors.length > 0
}
await writeFile(resolve(dir, simulateMissingProducts ? 'recovery-summary.json' : 'summary.json'), JSON.stringify(summaries, null, 2))
if (failed) process.exitCode = 1

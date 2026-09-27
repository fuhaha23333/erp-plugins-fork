import assert from 'node:assert/strict'
import test from 'node:test'
import { makeRequest, runRequest, summarize } from './normalizer-thinking-ab.mjs'

test('A/B requests differ only by the Bailian top-level thinking switch', () => {
  const on = makeRequest('same-model', true)
  const off = makeRequest('same-model', false)
  assert.equal(on.enable_thinking, true)
  assert.equal(off.enable_thinking, false)
  assert.deepEqual({ ...on, enable_thinking: false }, off)
  assert.equal(off.reasoning_effort, undefined)
  assert.equal(off.extra_body, undefined)
})

const extraction = { supplierName: '性能测试甲公司', departureDate: '2026-09-01', items: [
  { productName: '测试商品甲', specification: '10片/盒', arrivalQuantity: 12, unitPrice: 3.5, sourcePages: [1] },
  { productName: '测试商品甲', specification: '20片/盒', arrivalQuantity: 5, unitPrice: 6, sourcePages: [1] }
] }
function responseFetch(reasoningTokens, done = true, value = extraction) {
  const args = JSON.stringify(value)
  const events = [
    { choices: [{ delta: { reasoning_content: 'PRIVATE_THOUGHT' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'submit_receipt', arguments: args.slice(0, 30) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(30) } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 30,
      ...(reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }) } }
  ]
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\n\n' : ''))
  return async (_url, init) => {
    assert.equal(JSON.parse(init.body).enable_thinking, false)
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
      controller.close()
    } }))
  }
}

test('SSE handles split UTF-8/tool arguments and exposes statistics without contents', async () => {
  const result = await runRequest('https://example.invalid', 'PRIVATE_KEY', makeRequest('same-model', false), 1000, responseFetch(7))
  assert.equal(result.status, 'ok')
  assert.equal(result.inputTokens, 100)
  assert.equal(result.outputTokens, 30)
  assert.equal(result.reasoningTokens, 7)
  assert.equal(result.reasoningChars, 15)
  assert.equal(result.toolCalls, 1)
  assert.equal(result.extractionValid, true)
  assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  assert.ok(!JSON.stringify(result).includes('性能测试甲公司'))
})

test('raw provider zero is distinct from missing reasoning usage; truncated streams are not successful', async () => {
  const run = (n, done) => runRequest('https://example.invalid', 'x', makeRequest('m', false), 1000, responseFetch(n, done))
  assert.equal((await run(0)).reasoningTokens, 0)
  assert.equal((await run(undefined)).reasoningTokens, null)
  assert.equal((await run(7, false)).status, 'invalid-or-incomplete')
})

test('schema-violating invented fields are excluded from valid A/B samples', async () => {
  for (const value of [
    { ...extraction, inventedField: 'not-in-schema' },
    { ...extraction, items: extraction.items.map((item) => ({ ...item, actualReceivedQuantity: 99 })) }
  ]) {
    const result = await runRequest('https://example.invalid', 'x', makeRequest('m', false), 1000,
      responseFetch(0, true, value))
    assert.equal(result.extractionValid, false)
    assert.equal(result.status, 'invalid-or-incomplete')
  }
})

test('HTTP errors and thrown messages do not leak response/key data', async () => {
  const body = makeRequest('m', false)
  const denied = await runRequest('https://example.invalid', 'PRIVATE_KEY', body, 1000,
    async () => new Response('PRIVATE_RESPONSE', { status: 401 }))
  assert.equal(denied.httpStatus, 401)
  const failed = await runRequest('https://example.invalid', 'PRIVATE_KEY', body, 1000,
    async () => { throw new Error('PRIVATE_KEY') })
  assert.ok(!JSON.stringify([denied, failed]).includes('PRIVATE'))
})

test('summary excludes failures from valid latency and preserves missing token metrics', () => {
  const row = (elapsedMs) => ({ status: 'ok', elapsedMs, inputTokens: 10, outputTokens: 20, reasoningTokens: null })
  const result = summarize([row(20), row(10), row(30), { status: 'failed', elapsedMs: 1 }])
  assert.equal(result.valid, 3)
  assert.equal(result.failedOrInvalid, 1)
  assert.equal(result.meanMs, 20)
  assert.equal(result.medianMs, 20)
  assert.equal(result.fastestMs, 10)
  assert.equal(result.slowestMs, 30)
  assert.equal(result.meanReasoningTokens, null)
})

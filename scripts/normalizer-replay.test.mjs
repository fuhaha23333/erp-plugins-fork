import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { scoreExtraction, observeFetch } from './normalizer-replay-metrics.mjs'
import { loadReplayRuntime } from './normalizer-replay-runtime.mjs'
import { summarizeRuns } from './normalizer-replay.mjs'

const truth = { header: { supplierName: '测试供货方', customerName: '测试购买方', carrierName: null },
  items: [
    { productName: '甲', specification: '10片', quantity: 2, taxIncludedUnitPrice: 3, taxIncludedAmount: 6 },
    { productName: '甲', specification: '10片', quantity: 4, taxIncludedUnitPrice: 3, taxIncludedAmount: 12 }
  ] }
test('quality detects wrong roles, omissions, invented fields, row merging and duplications', () => {
  const correct = scoreExtraction(truth, structuredClone(truth))
  assert.equal(correct.fieldAccuracy, 1)
  assert.equal(correct.rowAccuracy, 1)
  const merged = scoreExtraction(truth, { header: { supplierName: '测试购买方', carrierName: '臆造公司' },
    items: [{ ...truth.items[0], quantity: 6, taxIncludedAmount: 18 }] })
  assert.equal(merged.headerCrossFieldErrors, 1)
  assert.equal(merged.headerMissing, 1)
  assert.equal(merged.headerInvented, 1)
  assert.equal(merged.missingRowsByCount, 1)
  assert.equal(merged.potentialMergedGroups, 1)
  assert.equal(merged.rowAccuracy, 0)
  const duplicate = scoreExtraction(truth, { ...truth, items: [...truth.items, truth.items[0]] })
  assert.equal(duplicate.excessDuplicateRows, 1)
  assert.ok(duplicate.rowAccuracy < 1)
  assert.equal(scoreExtraction(truth, null).fieldAccuracy, 0)
})

test('legitimate identical printed rows are not classified as excess duplicates', () => {
  const repeated = { header: {}, items: [truth.items[0], truth.items[0]] }
  const result = scoreExtraction(repeated, repeated)
  assert.equal(result.rowAccuracy, 1)
  assert.equal(result.excessDuplicateRows, 0)
})

test('transparent SSE observation preserves bytes and separates unknown token counts from zero', async () => {
  let now = 0
  const chunks = [
    { choices: [{ delta: { reasoning_content: 'PRIVATE_THOUGHT' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'submit', arguments: '{"公司":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"合成"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 0 } } }
  ]
  const source = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\n\n'
  const bytes = new TextEncoder().encode(source)
  const records = []
  const wrapped = observeFetch(async () => new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.slice(i, i + 5))
    c.close()
  } }), { headers: { 'content-type': 'text/event-stream' } }), records, () => ++now)
  const response = await wrapped('https://example.invalid', {})
  assert.equal(await response.text(), source)
  const m = records[0]
  assert.equal(m.reasoningTokens, 0)
  assert.equal(m.toolArgumentTokens, null)
  assert.equal(m.thinkingChars, 15)
  assert.equal(m.toolArgumentChars, '{"公司":"合成"}'.length)
  assert.ok(m.firstToolMs >= m.ttftMs)
  assert.ok(!JSON.stringify(m).includes('PRIVATE_THOUGHT'))
  assert.ok(!JSON.stringify(m).includes('合成'))
})

test('failure and repeated submission cannot count as strict quality success; missing usage stays unknown', () => {
  const good = { sample: 'sample', arm: 'B', status: 'completed', elapsedMs: 100,
    reasoningTokens: null, toolSuccess: true, schemaValid: true, normalizeSuccess: true,
    quality: scoreExtraction(truth, truth), rawQuality: scoreExtraction(truth, truth) }
  const [group] = summarizeRuns([good, { ...good, status: 'failed', elapsedMs: 1000, errorCategory: 'timeout' },
    { ...good, toolSuccess: false }])
  assert.equal(group.strictlyCorrectRuns, 1)
  assert.equal(group.reasoningTokens, null)
  assert.equal(group.reasoningReportingCount, 0)
  assert.equal(group.latencyMs.mean, 100)
  assert.equal(group.allAttemptLatencyMs.mean, 400)
})

test('real Agent/tools reach HTTP boundary unchanged except model/thinking, then terminate and normalize', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const runtime = await loadReplayRuntime(root)
  const endpoint = { providerId: 'erp-field-normalizer', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelId: 'deepseek-v4-flash-0731', apiKey: 'synthetic-test-key', supportsImages: false,
    contextWindow: 1000000, maxTokens: 16384 }
  for (const business of ['goods-receipt', 'purchase-order']) {
    const fixture = JSON.parse(await readFile(new URL(`../test-data/normalizer-replay/${business}-simple.json`, import.meta.url)))
    const adapter = runtime.getExtractionAdapter(business)
    const submission = { header: { ...fixture.expected.header }, items: fixture.expected.items, evidence: [], reviewRequired: [] }
    const probeTool = adapter.createSubmissionTool(() => {})
    for (const key of Object.keys(probeTool.parameters.properties.header.properties)) {
      if (!(key in submission.header)) submission.header[key] = null
    }
    assert.equal(Value.Check(probeTool.parameters, submission), true)
    let reference
    for (const arm of [{ model: endpoint.modelId, thinking: true }, { model: endpoint.modelId, thinking: false },
      { model: 'deepseek-v4.1-flash', thinking: false }]) {
      let submitted
      let httpCalls = 0
      let assertionError
      const tool = adapter.createSubmissionTool((value) => { submitted = value })
      const registry = runtime.createPiModelRegistry({ normalizer: { ...endpoint, modelId: arm.model },
        ocr: { ...endpoint, providerId: 'erp-qwen-ocr', modelId: 'qwen3.5-ocr', supportsImages: true } })
      const agent = runtime.createAgent(registry, registry.normalizerModel, adapter.systemPrompt, [tool], tool.name)
      agent.onPayload = (payload) => ({ ...payload, enable_thinking: arm.thinking })
      const original = agent.streamFunction
      const exchanges = []
      const fakeFetch = observeFetch(async (_url, init) => {
        httpCalls++
        const body = JSON.parse(init.body)
        try {
        assert.equal(body.model, arm.model)
        assert.equal(body.enable_thinking, arm.thinking)
        assert.equal(body.reasoning_effort, undefined)
        assert.equal(body.temperature, undefined)
        assert.equal(body.max_tokens ?? body.max_completion_tokens, endpoint.maxTokens)
        assert.equal(body.messages[0].content, adapter.systemPrompt)
        assert.deepEqual(body.tools[0].function.parameters, JSON.parse(JSON.stringify(tool.parameters)))
        const comparable = { ...body }
        delete comparable.model
        delete comparable.enable_thinking
        if (reference) assert.deepEqual(comparable, reference)
        else reference = comparable
        } catch (error) { assertionError = error }
        const chunks = [{ id: 'offline', model: arm.model, choices: [{ index: 0, delta: { role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_offline', type: 'function', function: { name: tool.name,
            arguments: JSON.stringify(submission) } }] }, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 200 } }]
        return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } })
      }, exchanges)
      agent.streamFunction = (model, context, options) => original(model, context, { ...options, fetch: fakeFetch })
      await runtime.promptWithTimeout(agent, runtime.replayPrompt(1, 1, fixture.ocrText), 5000)
      if (assertionError) throw assertionError
      assert.equal(httpCalls, 1, 'terminating real tool must not ask model for a second response')
      assert.equal(exchanges[0].reasoningTokens, null)
      assert.equal(exchanges[0].outputTokens, 200)
      assert.ok(submitted)
      assert.equal(scoreExtraction(fixture.expected, adapter.normalize(submitted, 1)).fieldAccuracy, 1)
    }
  }
})

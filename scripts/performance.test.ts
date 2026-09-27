import assert from 'node:assert/strict'
import test from 'node:test'
import { PipelinePerformance, summarizeNormalizer, summarizeRequest } from '../src/main/agent/performance'
import { createPiModelRegistry } from '../src/main/agent/model-registry'

test('concurrent page work is not reported as document wall time; failed work is counted', async () => {
  let now = 0
  const logs: Array<{ label: string; data: any }> = []
  const perf = new PipelinePerformance(true, () => now, (label, data) => logs.push({ label, data }))
  perf.startPage(1)
  perf.startPage(2)
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  const one = perf.timeAsync(1, 'ocrMs', () => pending)
  const two = perf.timeAsync(2, 'ocrMs', () => pending)
  now = 100
  finish()
  await Promise.all([one, two])
  await assert.rejects(perf.timeAsync(2, 'normalizerMs', async () => {
    now = 120
    throw new Error('private content must never be logged')
  }))
  perf.finishPage(1, 'normalized')
  perf.finishPage(2, 'failed')
  perf.finishDocument(3, 2, 'failed')
  const doc = logs.at(-1)!.data
  assert.equal(doc.cumulative.ocrMs, 200)
  assert.equal(doc.cumulative.normalizerMs, 20)
  assert.equal(doc.elapsedMs, 120)
  assert.equal(doc.excludedPages, 1)
  assert.equal(doc.unsettledPages, 0)
  assert.ok(!JSON.stringify(logs).includes('private content'))
})

test('disabled instrumentation preserves results/errors without reading the clock or logging', async () => {
  const unexpected = () => { throw new Error('instrumentation should be disabled') }
  const perf = new PipelinePerformance(false, unexpected, unexpected)
  perf.startPage(1)
  assert.equal(await perf.timeAsync(1, 'ocrMs', async () => 42), 42)
  assert.equal(perf.timeSync(1, 'mergeMs', () => 7), 7)
  const error = new Error('same error')
  assert.throws(() => perf.timeSync(1, 'normalizeMs', () => { throw error }), (actual) => actual === error)
  perf.finishPage(1, 'failed')
  perf.finishDocument(1, 1, 'failed')
})

test('normalizer logs only metrics, counts cached input, and does not invent zero reasoning usage', () => {
  const message = {
    role: 'assistant', model: 'test-model', stopReason: 'toolUse',
    content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' },
      { type: 'toolCall', name: 'submit', arguments: { secret: 'PRIVATE_ARGUMENT' } }],
    usage: { input: 100, cacheRead: 20, cacheWrite: 0, output: 30, reasoning: 0 }
  }
  const metrics = summarizeNormalizer([message] as any)
  assert.equal(metrics.inputTokens, 120)
  assert.equal(metrics.outputTokens, 30)
  assert.equal(metrics.reasoningTokens, null)
  assert.match(metrics.reasoningMetrics, /unavailable/)
  assert.equal(metrics.hasThinking, true)
  assert.equal(metrics.thinkingChars, 15)
  assert.equal(metrics.toolCalls, 1)
  assert.ok(!JSON.stringify(metrics).includes('PRIVATE'))
  message.usage.reasoning = 12
  assert.equal(summarizeNormalizer([message] as any).reasoningTokens, 12)
  assert.equal(summarizeNormalizer([]).inputTokens, null)
})

test('request inspection retains only bounded diagnostic fields and does not mutate payload', () => {
  const payload = { enable_thinking: false, reasoning_effort: 'high', messages: [{ content: 'PRIVATE' }], tools: [{}] }
  const before = JSON.stringify(payload)
  const metrics = summarizeRequest(payload)
  assert.deepEqual(metrics, { enableThinking: false, reasoningEffort: 'high', toolCount: 1 })
  assert.equal(JSON.stringify(payload), before)
  assert.ok(!JSON.stringify(metrics).includes('PRIVATE'))
  assert.equal(summarizeRequest({}).enableThinking, 'not-sent')
})

test('current registry sends no thinking switch and SDK retains positive reasoning usage (offline HTTP boundary)', async () => {
  const endpoint = { providerId: 'erp-field-normalizer', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelId: 'deepseek-v4-flash-0731', apiKey: 'synthetic-key', supportsImages: false,
    contextWindow: 1000000, maxTokens: 16384 }
  const registry = createPiModelRegistry({ normalizer: endpoint,
    ocr: { ...endpoint, providerId: 'erp-qwen-ocr', modelId: 'qwen3.5-ocr', supportsImages: true },
    maxUploadBytes: 100, maxPages: 1, ocrConcurrency: 1, pageTimeoutMs: 1000, normalizationTimeoutMs: 1000 })
  let calls = 0
  let payloads = 0
  const result = await registry.models.streamSimple(registry.normalizerModel, {
    messages: [{ role: 'user', content: 'Synthetic input', timestamp: 0 }]
  }, {
    reasoning: 'low',
    onPayload: (payload) => {
      payloads++
      const p = payload as Record<string, unknown>
      for (const key of ['enable_thinking', 'reasoning_effort', 'thinking', 'reasoning', 'chat_template_kwargs']) {
        assert.equal(p[key], undefined)
      }
    },
    fetch: async (_url, init) => {
      calls++
      const body = JSON.parse(init!.body as string)
      assert.equal(body.model, endpoint.modelId)
      assert.equal(body.enable_thinking, undefined)
      assert.equal(body.reasoning_effort, undefined)
      const chunk = { id: 'synthetic', model: endpoint.modelId, choices: [{ index: 0,
        delta: { role: 'assistant', reasoning_content: 'hidden', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19,
          completion_tokens_details: { reasoning_tokens: 7 } } }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' }
      })
    }
  }).result()
  assert.equal(calls, 1)
  assert.equal(payloads, 1)
  assert.equal(result.usage.reasoning, 7)
  assert.equal(result.usage.output, 9)
  assert.equal(result.content.some((block) => block.type === 'thinking'), true)
})

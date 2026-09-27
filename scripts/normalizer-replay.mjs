import { readFile, readdir, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Value } from 'typebox/value'
import { loadReplayRuntime } from './normalizer-replay-runtime.mjs'
import { scoreExtraction, observeFetch, describe } from './normalizer-replay-metrics.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const arms = [
  { id: 'A', model: 'deepseek-v4-flash-0731', thinking: true },
  { id: 'B', model: 'deepseek-v4-flash-0731', thinking: false },
  { id: 'C', model: 'deepseek-v4.1-flash', thinking: false }
]
const sumIfReported = (records, key) => records.length && records.every((r) => typeof r[key] === 'number')
  ? records.reduce((sum, r) => sum + r[key], 0) : null

export function summarizeRuns(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.sample}/${row.arm}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()].map((runs) => {
    const first = runs[0]
    const completed = runs.filter((r) => r.status === 'completed')
    const mean = (key) => describe(completed.map((r) => r[key])).mean
    return {
      business: first.business, sample: first.sample, arm: first.arm, model: first.model, thinking: first.thinking,
      attempts: runs.length, completed: completed.length, latencyMs: describe(completed.map((r) => r.elapsedMs)),
      allAttemptLatencyMs: describe(runs.map((r) => r.elapsedMs)),
      inputTokens: mean('inputTokens'), outputTokens: mean('outputTokens'), reasoningTokens: mean('reasoningTokens'),
      reasoningReportingCount: completed.filter((r) => r.reasoningTokens !== null).length,
      toolArgumentTokens: null, toolArgumentChars: mean('toolArgumentChars'), thinkingChars: mean('thinkingChars'),
      ttftMs: mean('ttftMs'), thinkingArrivalSpanMs: mean('thinkingArrivalSpanMs'), toolArgumentsArrivalSpanMs: mean('toolArgumentsArrivalSpanMs'),
      ocrChars: first.ocrChars, toolSchemaBytes: first.toolSchemaBytes, expectedItems: first.expectedItems,
      finalItems: runs.map((r) => r.quality.finalItems),
      fieldAccuracy: describe(runs.map((r) => r.quality.fieldAccuracy)).mean,
      headerAccuracy: describe(runs.map((r) => r.quality.headerAccuracy)).mean,
      headerNonNullAccuracy: describe(runs.map((r) => r.quality.headerNonNullAccuracy)).mean,
      headerMissingRate: describe(runs.map((r) => r.quality.headerMissingRate)).mean,
      headerCrossFieldErrors: runs.reduce((n, r) => n + r.quality.headerCrossFieldErrors, 0),
      headerInvented: runs.reduce((n, r) => n + r.quality.headerInvented, 0),
      rowAccuracy: describe(runs.map((r) => r.quality.rowAccuracy)).mean,
      rawFieldAccuracy: describe(runs.map((r) => r.rawQuality.fieldAccuracy)).mean,
      rawRowAccuracy: describe(runs.map((r) => r.rawQuality.rowAccuracy)).mean,
      rowCountSuccessRate: runs.filter((r) => r.quality.rowCountCorrect).length / runs.length,
      toolSuccessRate: runs.filter((r) => r.toolSuccess).length / runs.length,
      schemaSuccessRate: runs.filter((r) => r.schemaValid).length / runs.length,
      normalizeSuccessRate: runs.filter((r) => r.normalizeSuccess).length / runs.length,
      readyForAutofillRate: runs.filter((r) => r.readyForAutofill).length / runs.length,
      strictlyCorrectRuns: runs.filter((r) => r.status === 'completed' && r.toolSuccess && r.normalizeSuccess &&
        r.schemaValid && r.quality.fieldAccuracy === 1 && r.quality.rowAccuracy === 1).length,
      errors: runs.filter((r) => r.status !== 'completed').map((r) => r.errorCategory)
    }
  })
}

export function table(groups) {
  const fmt = (v, digits = 2) => typeof v === 'number' ? v.toFixed(digits) : 'N/A'
  const pct = (v) => typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'N/A'
  return ['| 业务/样本 | 模型 | Thinking | 平均秒 | P50秒 | 最快秒 | 最慢秒 | Input Tokens | Output Tokens | Reasoning Tokens | 字段准确率 | 商品行准确率 | Tool成功率 | 完成/尝试 |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...groups.map((g) => `| ${g.sample} | ${g.model} | ${g.thinking ? 'on' : 'off'} | ${fmt(g.latencyMs.mean === null ? null : g.latencyMs.mean / 1000)} | ${fmt(g.latencyMs.p50 === null ? null : g.latencyMs.p50 / 1000)} | ${fmt(g.latencyMs.min === null ? null : g.latencyMs.min / 1000)} | ${fmt(g.latencyMs.max === null ? null : g.latencyMs.max / 1000)} | ${fmt(g.inputTokens, 0)} | ${fmt(g.outputTokens, 0)} | ${fmt(g.reasoningTokens, 0)} | ${pct(g.fieldAccuracy)} | ${pct(g.rowAccuracy)} | ${pct(g.toolSuccessRate)} | ${g.completed}/${g.attempts} |`)].join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const option = (flag, fallback) => argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) : fallback
  const repetitions = option('--runs', 3)
  const concurrency = option('--concurrency', 2)
  if (![3, 4, 5].includes(repetitions) || ![1, 2].includes(concurrency)) throw new Error('invalid benchmark limits')
  const fixtureDir = resolve(root, 'test-data/normalizer-replay')
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith('.json')).sort()
  const fixtures = await Promise.all(names.map(async (name) => JSON.parse(await readFile(resolve(fixtureDir, name), 'utf8'))))
  if (fixtures.length !== 6 || fixtures.some((f) => f.provenance.kind !== 'synthetic-ground-truth')) throw new Error('fixed synthetic fixtures required')
  const runtime = await loadReplayRuntime(root)
  const cfg = runtime.loadPiAgentConfig()
  const url = new URL(cfg.normalizer.baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.aliyuncs.com')) throw new Error('expected existing HTTPS Bailian endpoint')
  const manifest = {
    createdAt: new Date().toISOString(), repetitions, concurrency, arms,
    baselineConfiguredModel: cfg.normalizer.modelId, maxTokens: cfg.normalizer.maxTokens,
    temperature: 'not-sent (same provider default)', reasoningEffort: 'not-sent (provider default)',
    timeoutMs: cfg.normalizationTimeoutMs, groundTruth: 'fixed synthetic specification; not human-labeled production documents',
    sourceHash: hash(await readFile(resolve(root, 'src/main/agent/pi-document-client.ts'), 'utf8')),
    fixtures: fixtures.map((f) => {
      const adapter = runtime.getExtractionAdapter(f.businessId)
      const tool = adapter.createSubmissionTool(() => {})
      return { id: f.id, fixtureHash: hash(f), ocrHash: hash(f.ocrText), ocrChars: f.ocrText.length,
        rows: f.expected.items.length, promptHash: hash(adapter.systemPrompt),
        schemaHash: hash(tool.parameters), schemaBytes: Buffer.byteLength(JSON.stringify(tool.parameters)),
        userPromptHash: hash(runtime.replayPrompt(f.pageNumber, f.pageCount, f.ocrText)) }
    })
  }
  if (argv.includes('--dry-run')) { console.log(JSON.stringify(manifest, null, 2)); return }
  if (!cfg.normalizer.apiKey) throw new Error('missing API key in environment')
  const output = resolve(root, 'tmp/normalizer-replay', `run-${Date.now()}`)
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log('[Replay Output]', output)
  const hashes = new Map()
  const rows = []
  async function run(fixture, arm, round) {
    const adapter = runtime.getExtractionAdapter(fixture.businessId)
    let submitted = null
    let submissions = 0
    const tool = adapter.createSubmissionTool((payload) => { submitted = payload; submissions++ })
    const registry = runtime.createPiModelRegistry({ ...cfg, normalizer: { ...cfg.normalizer, modelId: arm.model } })
    const agent = runtime.createAgent(registry, registry.normalizerModel, adapter.systemPrompt, [tool], tool.name)
    const exchanges = []
    const requests = []
    const monitorFetch = observeFetch(globalThis.fetch, exchanges)
    const originalStream = agent.streamFunction
    agent.streamFunction = (model, context, options) => originalStream(model, context, { ...options, fetch: monitorFetch })
    agent.onPayload = (payload) => {
      const updated = { ...payload, enable_thinking: arm.thinking }
      const comparable = { ...updated }
      delete comparable.model
      delete comparable.enable_thinking
      const controlHash = hash(comparable)
      if (requests.length === 0) {
        if (hashes.has(fixture.id) && hashes.get(fixture.id) !== controlHash) throw new Error('request parity changed')
        hashes.set(fixture.id, controlHash)
      }
      requests.push({ controlHash, toolSchemaBytes: Buffer.byteLength(JSON.stringify(updated.tools)),
        maxTokens: updated.max_tokens ?? updated.max_completion_tokens, temperature: updated.temperature ?? null })
      return updated
    }
    const startedAt = new Date().toISOString()
    const start = performance.now()
    let errorCategory = null
    try { await runtime.promptWithTimeout(agent, runtime.replayPrompt(fixture.pageNumber, fixture.pageCount, fixture.ocrText), cfg.normalizationTimeoutMs) }
    catch { errorCategory = exchanges.some((x) => x.httpStatus >= 400) ? 'http-error' : performance.now() - start >= cfg.normalizationTimeoutMs ? 'timeout' : 'agent-error' }
    const elapsedMs = performance.now() - start
    const replies = agent.state.messages.filter((m) => m.role === 'assistant')
    const calls = replies.flatMap((m) => m.content.filter((c) => c.type === 'toolCall'))
    const toolResults = agent.state.messages.filter((m) => m.role === 'toolResult')
    const schemaValid = calls.length > 0 && calls.every((call) => call.name === tool.name && Value.Check(tool.parameters, call.arguments))
    let extraction = null
    const normalizeStart = performance.now()
    let normalizeSuccess = false
    if (submitted) {
      try { extraction = adapter.normalize(submitted, fixture.pageCount); normalizeSuccess = true }
      catch { errorCategory ??= 'normalize-error' }
    }
    const normalizeMs = performance.now() - normalizeStart
    const first = exchanges[0]
    const span = (x, a, b) => typeof x?.[a] === 'number' && typeof x?.[b] === 'number' ? x[b] - x[a] : null
    const row = {
      sample: fixture.id, business: fixture.businessId, complexity: fixture.complexity, arm: arm.id, round,
      model: arm.model, thinking: arm.thinking, startedAt, completedAt: new Date().toISOString(), elapsedMs, normalizeMs,
      status: !errorCategory && normalizeSuccess ? 'completed' : 'failed', errorCategory,
      inputTokens: sumIfReported(exchanges, 'inputTokens'), outputTokens: sumIfReported(exchanges, 'outputTokens'),
      reasoningTokens: sumIfReported(exchanges, 'reasoningTokens'), toolArgumentTokens: null,
      tokenNotes: 'tool argument token split unavailable; reasoning is a subset of output; missing reasoning is null, not zero',
      thinkingChars: exchanges.reduce((n, r) => n + r.thinkingChars, 0),
      toolArgumentChars: exchanges.reduce((n, r) => n + r.toolArgumentChars, 0),
      otherTextChars: exchanges.reduce((n, r) => n + r.otherTextChars, 0),
      ttftMs: first?.ttftMs ?? null,
      thinkingArrivalSpanMs: span(first, 'firstThinkingMs', 'lastThinkingMs'),
      toolArgumentsArrivalSpanMs: span(first, 'firstToolMs', 'lastToolMs'),
      timingNotes: 'client arrival windows, not pure server queue/prefill/compute; first-request windows only; inspect exchanges on retries',
      toolCallCount: calls.length, modelResponses: replies.length, stopReason: replies.map((m) => m.stopReason),
      toolSuccess: submissions === 1 && toolResults.some((r) => r.toolName === tool.name && !r.isError),
      schemaValid, normalizeSuccess, readyForAutofill: extraction?.readyForAutofill ?? false,
      ocrChars: fixture.ocrText.length, toolSchemaBytes: Buffer.byteLength(JSON.stringify(tool.parameters)),
      expectedItems: fixture.expected.items.length, quality: scoreExtraction(fixture.expected, extraction),
      rawQuality: scoreExtraction(fixture.expected, submitted), requests, exchanges
    }
    rows.push(row)
    await appendFile(resolve(output, 'runs.jsonl'), JSON.stringify(row) + '\n')
    await writeFile(resolve(output, 'summary.json'), JSON.stringify(summarizeRuns(rows), null, 2))
    console.log('[Replay Run]', JSON.stringify({ sample: row.sample, arm: arm.id, round, status: row.status,
      elapsedMs: Math.round(row.elapsedMs), outputTokens: row.outputTokens, reasoningTokens: row.reasoningTokens,
      fields: row.quality.fieldAccuracy, rows: row.quality.rowAccuracy, tool: row.toolSuccess, ready: row.readyForAutofill,
      completedRuns: rows.length }))
    return row
  }
  // C support is established on the SAME endpoint using a complete real business request.
  const simple = fixtures.find((f) => f.id === 'goods-receipt-simple')
  const probe = await run(simple, arms[2], 1)
  const cSupported = probe.exchanges.some((x) => x.httpStatus >= 200 && x.httpStatus < 300)
  manifest.cAvailability = cSupported ? 'HTTP success on configured endpoint (see result quality)'
    : 'No successful HTTP response on configured endpoint; inspect statuses; no fallback'
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const jobs = []
  for (let round = 1; round <= repetitions; round++) {
    for (let i = 0; i < fixtures.length; i++) {
      for (let j = 0; j < 3; j++) {
        const arm = arms[(j + i + round - 1) % 3]
        const fixture = fixtures[i]
        if (arm.id === 'C' && (!cSupported || fixture.id === simple.id && round === 1)) continue
        jobs.push({ fixture, arm, round })
      }
    }
  }
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      await run(job.fixture, job.arm, job.round)
    }
  }))
  const summary = summarizeRuns(rows)
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2))
  await writeFile(resolve(output, 'table.md'), table(summary) + '\n')
  console.log('[Replay Complete]', JSON.stringify({ runs: rows.length, failed: rows.filter((r) => r.status === 'failed').length, output }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Replay failed; raw error suppressed. Check environment, fixtures and stats artifacts.'); process.exitCode = 1 })
}

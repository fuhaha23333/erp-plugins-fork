import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Synthetic data only. No customer documents, raw completions, reasoning or keys are logged.
// Bailian OpenAI-compatible HTTP uses top-level enable_thinking (not extra_body):
// https://help.aliyun.com/en/model-studio/deepseek-api
const text = `测试用随货同行单（所有名称均为合成数据）
销售方：性能测试甲公司；购货单位：性能测试乙公司；发货日期：2026-09-01。
商品名称 | 规格 | 到货数量 | 单价
测试商品甲 | 10片/盒 | 12 | 3.50
测试商品甲 | 20片/盒 | 5 | 6.00
实际收货数量未提供。原文件第1页。`
const parameters = {
  type: 'object', additionalProperties: false,
  properties: {
    supplierName: { type: 'string' }, departureDate: { type: 'string' },
    items: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        productName: { type: 'string' }, specification: { type: 'string' },
        arrivalQuantity: { type: 'number' }, unitPrice: { type: 'number' },
        sourcePages: { type: 'array', items: { type: 'integer' } }
      },
      required: ['productName', 'specification', 'arrivalQuantity', 'unitPrice', 'sourcePages']
    } }
  }, required: ['supplierName', 'departureDate', 'items']
}

export function makeRequest(model, thinking) {
  return {
    model, stream: true, stream_options: { include_usage: true }, max_tokens: 4096,
    enable_thinking: thinking,
    messages: [
      { role: 'system', content: '从合成票据原文提取销售方、发货日期及每条商品。销售方不是购货单位。相同商品不同原始行不可合并。不猜测缺失信息。必须且仅调用 submit_receipt 一次，不输出普通文本。' },
      { role: 'user', content: text }
    ],
    tools: [{ type: 'function', function: {
      name: 'submit_receipt', description: '提交合成票据的结构化字段。', parameters
    } }], tool_choice: 'auto'
  }
}

function validExtraction(calls) {
  if (calls.length !== 1 || calls[0].name !== 'submit_receipt') return false
  try {
    const v = JSON.parse(calls[0].arguments)
    return Object.keys(v).sort().join(',') === 'departureDate,items,supplierName' &&
      v.supplierName === '性能测试甲公司' && v.departureDate === '2026-09-01' &&
      Array.isArray(v.items) && v.items.length === 2 && v.items.every((item, i) =>
        Object.keys(item).sort().join(',') === 'arrivalQuantity,productName,sourcePages,specification,unitPrice' &&
        item.productName === '测试商品甲' && item.specification === ['10片/盒', '20片/盒'][i] &&
        item.arrivalQuantity === [12, 5][i] && item.unitPrice === [3.5, 6][i] &&
        JSON.stringify(item.sourcePages) === '[1]')
  } catch { return false }
}

export async function runRequest(endpoint, apiKey, body, timeoutMs = 180000, fetchFn = fetch) {
  const start = performance.now()
  const row = { thinking: body.enable_thinking, model: body.model, status: 'failed', elapsedMs: 0,
    firstTokenMs: null, inputTokens: null, outputTokens: null, reasoningTokens: null,
    reasoningMetrics: 'reasoning metrics unavailable', hasReasoning: false,
    reasoningChars: 0, stopReason: null, toolCalls: 0, extractionValid: false }
  try {
    const response = await fetchFn(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { ...row, httpStatus: response.status, errorType: 'http', elapsedMs: performance.now() - start }
    }
    if (!response.body) throw new Error('missing-stream')
    const calls = new Map()
    let done = false
    const accept = (line) => {
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (data === '[DONE]') { done = true; return }
      if (!data) return
      const chunk = JSON.parse(data)
      if (chunk.error) throw new Error('provider-stream-error')
      if (chunk.usage) {
        row.inputTokens = chunk.usage.prompt_tokens ?? null
        row.outputTokens = chunk.usage.completion_tokens ?? null
        row.reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? null
        row.reasoningMetrics = row.reasoningTokens === null ? 'reasoning metrics unavailable' : 'available (subset of outputTokens)'
      }
      for (const choice of chunk.choices ?? []) {
        if (choice.finish_reason) row.stopReason = choice.finish_reason
        const delta = choice.delta ?? {}
        if (row.firstTokenMs === null && (delta.content || delta.reasoning_content || delta.tool_calls?.length)) {
          row.firstTokenMs = performance.now() - start
        }
        row.reasoningChars += typeof delta.reasoning_content === 'string' ? delta.reasoning_content.length : 0
        for (const part of delta.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { name: '', arguments: '' }
          call.name += part.function?.name ?? ''
          call.arguments += part.function?.arguments ?? ''
          calls.set(part.index, call)
        }
      }
    }
    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) accept(line)
    }
    pending += decoder.decode()
    if (pending) accept(pending)
    row.hasReasoning = row.reasoningChars > 0
    row.toolCalls = calls.size
    row.extractionValid = validExtraction([...calls.values()])
    row.status = done && row.stopReason === 'tool_calls' && row.extractionValid ? 'ok' : 'invalid-or-incomplete'
  } catch (error) {
    // Deliberately never print provider/network error.message: it may contain request data.
    row.errorType = error?.name === 'TimeoutError' ? 'timeout' : 'network-or-response'
  }
  row.hasReasoning = row.reasoningChars > 0
  row.elapsedMs = performance.now() - start
  return row
}

export function summarize(rows) {
  const ok = rows.filter((row) => row.status === 'ok')
  const times = ok.map((row) => row.elapsedMs).sort((a, b) => a - b)
  const avg = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  const meanMetric = (key) => ok.length && ok.every((row) => typeof row[key] === 'number') ? avg(ok.map((row) => row[key])) : null
  return {
    attempted: rows.length, valid: ok.length, failedOrInvalid: rows.length - ok.length,
    meanMs: avg(times), medianMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null,
    fastestMs: times[0] ?? null, slowestMs: times.at(-1) ?? null,
    meanInputTokens: meanMetric('inputTokens'), meanOutputTokens: meanMetric('outputTokens'),
    meanReasoningTokens: meanMetric('reasoningTokens'),
    timingBasis: 'valid extractions only; failed/invalid runs are counted separately'
  }
}

async function main() {
  const args = process.argv.slice(2)
  const unknown = args.filter((arg, i) => !['--runs', '--timeout-ms', '--dry-run'].includes(arg) &&
    !['--runs', '--timeout-ms'].includes(args[i - 1]))
  if (unknown.length) throw new Error('usage')
  const runs = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 3
  const timeoutMs = args.includes('--timeout-ms') ? Number(args[args.indexOf('--timeout-ms') + 1]) : 180000
  if (![3, 4, 5].includes(runs) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('usage')
  const model = process.env.MAIN_VITE_PI_NORMALIZER_MODEL?.trim() || 'deepseek-v4-flash-0731'
  const base = new URL(process.env.MAIN_VITE_PI_NORMALIZER_BASE_URL || process.env.MAIN_VITE_PI_OCR_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
      !(base.hostname === 'dashscope.aliyuncs.com' || /^dashscope[-.][a-z0-9-]+\.aliyuncs\.com$/.test(base.hostname) ||
        /^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(base.hostname))) throw new Error('endpoint')
  const endpoint = `${base.href.replace(/\/$/, '')}/chat/completions`
  const apiKey = process.env.PI_NORMALIZER_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim() || process.env.PI_API_KEY?.trim()
  const baseline = makeRequest(model, true)
  console.log('[AB Config]', JSON.stringify({ model, runsPerMode: runs, timeoutMs,
    inputHash: createHash('sha256').update(JSON.stringify(baseline.messages)).digest('hex'),
    maxTokens: baseline.max_tokens, reasoningEffort: 'not-sent (provider default)',
    order: 'alternating on/off then off/on; sequential, no automatic retries', syntheticData: true }))
  if (args.includes('--dry-run')) return
  if (!apiKey) throw new Error('key')
  const results = []
  for (let round = 0; round < runs; round++) {
    for (const thinking of round % 2 === 0 ? [true, false] : [false, true]) {
      const result = { round: round + 1, ...await runRequest(endpoint, apiKey, makeRequest(model, thinking), timeoutMs) }
      results.push(result)
      console.log('[AB Run]', JSON.stringify(result))
    }
  }
  for (const thinking of [true, false]) console.log('[AB Summary]', JSON.stringify({ thinking,
    ...summarize(results.filter((row) => row.thinking === thinking)) }))
  if (results.some((row) => row.status !== 'ok')) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const messages = {
      key: 'Missing PI_NORMALIZER_API_KEY / DASHSCOPE_API_KEY / PI_API_KEY in environment.',
      endpoint: 'Expected an HTTPS Bailian OpenAI-compatible endpoint; no request sent.',
      usage: 'Usage: node scripts/normalizer-thinking-ab.mjs [--runs 3|4|5] [--timeout-ms 180000] [--dry-run]'
    }
    console.error(messages[error?.message] ?? 'A/B test failed; sensitive error details suppressed.')
    process.exitCode = 1
  })
}

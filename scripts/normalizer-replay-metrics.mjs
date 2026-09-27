const empty = (v) => v === null || v === undefined || v === ''
const equal = (a, b) => typeof a === 'number' && typeof b === 'number'
  ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b)
const rate = (n, d) => d ? n / d : null
const count = (values) => {
  const result = new Map()
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1)
  return result
}

/** Fixed-field, order-sensitive scoring; never use model output as ground truth. */
export function scoreExtraction(expected, actual) {
  const header = actual?.header ?? {}
  const keys = Object.keys(expected.header)
  const nonNullKeys = keys.filter((key) => expected.header[key] !== null)
  const headerCorrect = keys.filter((key) => equal(header[key], expected.header[key])).length
  const headerMissing = nonNullKeys.filter((key) => empty(header[key])).length
  const headerInvented = keys.filter((key) => expected.header[key] === null && !empty(header[key])).length
  const headerCrossFieldErrors = keys.filter((key) => !empty(header[key]) && !equal(header[key], expected.header[key]) &&
    keys.some((other) => other !== key && !empty(expected.header[other]) && equal(header[key], expected.header[other]))).length
  const items = Array.isArray(actual?.items) ? actual.items : []
  const itemKeys = Object.keys(expected.items[0] ?? {})
  const slots = Math.max(expected.items.length, items.length)
  const fieldErrors = {}
  let itemCorrect = 0
  let exactRows = 0
  for (let i = 0; i < slots; i++) {
    let rowCorrect = true
    for (const key of itemKeys) {
      const correct = i < expected.items.length && i < items.length && equal(items[i][key], expected.items[i][key])
      if (correct) itemCorrect++
      else { rowCorrect = false; fieldErrors[key] = (fieldErrors[key] ?? 0) + 1 }
    }
    if (rowCorrect && i < expected.items.length && i < items.length) exactRows++
  }
  const signature = (item) => JSON.stringify(itemKeys.map((key) => item[key]))
  const wanted = count(expected.items.map(signature))
  const got = count(items.map(signature))
  const excessDuplicateRows = [...got].reduce((sum, [key, n]) => sum + (wanted.has(key) ? Math.max(0, n - wanted.get(key)) : 0), 0)
  const identityKeys = itemKeys.filter((key) => !['quantity', 'arrivalQuantity', 'receiptQuantity', 'amount', 'taxIncludedAmount'].includes(key))
  const identity = (item) => JSON.stringify(identityKeys.map((key) => item[key]))
  const groups = new Map()
  for (const item of expected.items) {
    const key = identity(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  let potentialMergedGroups = 0
  const quantity = (item) => item.quantity ?? item.arrivalQuantity ?? 0
  for (const [key, group] of groups) {
    const matches = items.filter((item) => identity(item) === key)
    if (group.length > 1 && matches.length > 0 && matches.length < group.length &&
      equal(matches.reduce((sum, item) => sum + quantity(item), 0), group.reduce((sum, item) => sum + quantity(item), 0))) potentialMergedGroups++
  }
  return {
    headerCorrect, headerTotal: keys.length, headerAccuracy: rate(headerCorrect, keys.length),
    headerNonNullAccuracy: rate(nonNullKeys.filter((key) => equal(header[key], expected.header[key])).length, nonNullKeys.length),
    headerMissing, headerMissingRate: rate(headerMissing, nonNullKeys.length), headerInvented, headerCrossFieldErrors,
    headerErrorFields: keys.filter((key) => !equal(header[key], expected.header[key])),
    expectedItems: expected.items.length, finalItems: items.length, rowCountCorrect: items.length === expected.items.length,
    missingRowsByCount: Math.max(0, expected.items.length - items.length), extraRowsByCount: Math.max(0, items.length - expected.items.length),
    excessDuplicateRows, potentialMergedGroups, exactRows, rowSlots: slots, rowAccuracy: rate(exactRows, slots),
    itemCorrect, itemFieldTotal: slots * itemKeys.length, itemFieldAccuracy: rate(itemCorrect, slots * itemKeys.length),
    itemFieldErrors: fieldErrors,
    fieldAccuracy: rate(headerCorrect + itemCorrect, keys.length + slots * itemKeys.length)
  }
}

/** Observe raw SSE while forwarding the original bytes unchanged to pi-ai. Never retain content. */
export function observeFetch(fetchFn, records, now = () => performance.now()) {
  return async (url, init) => {
    const start = now()
    const m = { httpStatus: null, headersMs: null, elapsedMs: null, ttftMs: null,
      firstThinkingMs: null, lastThinkingMs: null, firstToolMs: null, lastToolMs: null,
      firstOtherTextMs: null, lastOtherTextMs: null, thinkingChars: 0, otherTextChars: 0,
      toolArgumentChars: 0, toolArgumentBytes: 0, inputTokens: null, cachedInputTokens: null,
      outputTokens: null, reasoningTokens: null, toolArgumentTokens: null,
      rawStopReason: null, done: false, parseErrors: 0 }
    records.push(m)
    let response
    try { response = await fetchFn(url, init) }
    catch (error) { m.elapsedMs = now() - start; m.networkError = true; throw error }
    m.headersMs = now() - start
    m.httpStatus = response.status
    if (!response.ok || !response.body) { m.elapsedMs = now() - start; return response }
    const stamp = (prefix, elapsed) => {
      if (m.ttftMs === null) m.ttftMs = elapsed
      if (m[`first${prefix}Ms`] === null) m[`first${prefix}Ms`] = elapsed
      m[`last${prefix}Ms`] = elapsed
    }
    const consume = (line) => {
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (data === '[DONE]') { m.done = true; return }
      if (!data) return
      try {
        const chunk = JSON.parse(data)
        const elapsed = now() - start
        const choice = chunk.choices?.[0]
        const usage = chunk.usage ?? choice?.usage
        if (usage) {
          m.inputTokens = usage.prompt_tokens ?? null
          m.cachedInputTokens = usage.prompt_tokens_details?.cached_tokens ?? null
          m.outputTokens = usage.completion_tokens ?? null
          m.reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? null
        }
        if (choice?.finish_reason) m.rawStopReason = choice.finish_reason
        const delta = choice?.delta ?? {}
        const thinking = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text
        if (typeof thinking === 'string' && thinking.length) { stamp('Thinking', elapsed); m.thinkingChars += thinking.length }
        if (typeof delta.content === 'string' && delta.content.length) { stamp('OtherText', elapsed); m.otherTextChars += delta.content.length }
        for (const call of delta.tool_calls ?? []) {
          const args = call.function?.arguments
          if (typeof args === 'string' && args.length) {
            stamp('Tool', elapsed); m.toolArgumentChars += args.length; m.toolArgumentBytes += Buffer.byteLength(args)
          }
        }
      } catch { m.parseErrors++ }
    }
    let pending = ''
    const decoder = new TextDecoder()
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        lines.forEach(consume)
        controller.enqueue(chunk)
      },
      flush() {
        pending += decoder.decode()
        if (pending) consume(pending)
        m.elapsedMs = now() - start
      }
    }))
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

export function describe(values) {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  return { count: nums.length, mean: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
    p50: nums.length ? (nums[Math.floor((nums.length - 1) / 2)] + nums[Math.floor(nums.length / 2)]) / 2 : null,
    min: nums[0] ?? null, max: nums.at(-1) ?? null }
}

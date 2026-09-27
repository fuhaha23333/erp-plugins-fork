import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'

type Stage = 'prepareMs' | 'renderQueueMs' | 'renderMs' | 'headerCropMs' | 'ocrMs' |
  'normalizerMs' | 'normalizeMs' | 'mergeMs' | 'disposeMs'
const emptyTimes = (): Record<Stage, number> => ({
  prepareMs: 0, renderQueueMs: 0, renderMs: 0, headerCropMs: 0,
  ocrMs: 0, normalizerMs: 0, normalizeMs: 0, mergeMs: 0, disposeMs: 0
})
const rounded = (n: number): number => Math.round(n * 100) / 100
let nextDocumentId = 0

/** Only timing/counter fields enter this logger; never pass business payloads. */
export class PipelinePerformance {
  private readonly startedAt: number
  private readonly cumulative = emptyTimes()
  private readonly pages = new Map<number, { startedAt: number; times: Record<Stage, number>; finished: boolean }>()
  private documentEnded = false
  private readonly documentId: number

  constructor(
    readonly enabled: boolean,
    private readonly now = () => performance.now(),
    private readonly log: (label: string, data: object) => void = (label, data) => console.info(label, JSON.stringify(data))
  ) {
    this.startedAt = enabled ? now() : 0
    this.documentId = enabled ? ++nextDocumentId : 0
  }

  startPage(page: number): void {
    if (this.enabled) this.pages.set(page, { startedAt: this.now(), times: emptyTimes(), finished: false })
  }

  add(page: number | null, stage: Stage, ms: number): void {
    if (!this.enabled) return
    this.cumulative[stage] += ms
    const entry = page === null ? undefined : this.pages.get(page)
    if (entry) entry.times[stage] += ms
  }

  async timeAsync<T>(page: number | null, stage: Stage, operation: () => Promise<T>): Promise<T> {
    if (!this.enabled) return operation()
    const started = this.now()
    try { return await operation() }
    finally { this.add(page, stage, this.now() - started) }
  }

  timeSync<T>(page: number | null, stage: Stage, operation: () => T): T {
    if (!this.enabled) return operation()
    const started = this.now()
    try { return operation() }
    finally { this.add(page, stage, this.now() - started) }
  }

  finishPage(page: number, status: string): void {
    const entry = this.pages.get(page)
    if (!this.enabled || !entry) return
    entry.finished = true
    this.log(`[Performance][Page ${page}]`, {
      documentId: this.documentId,
      ...Object.fromEntries(Object.entries(entry.times).map(([key, value]) => [key, rounded(value)])),
      pageTotalMs: rounded(this.now() - entry.startedAt), status,
      completedAfterDocumentReturn: this.documentEnded
    })
  }

  normalizer(page: number, model: string, elapsedMs: number, messages: AgentMessage[], requests: object[]): void {
    if (this.enabled) this.log('[Normalizer]', {
      documentId: this.documentId,
      page, model, normalizerElapsedMs: rounded(elapsedMs),
      ...summarizeNormalizer(messages), requests
    })
  }

  finishDocument(pageCount: number, selectedPages: number, status: string): void {
    if (!this.enabled) return
    this.documentEnded = true
    const localProcessingMs = this.cumulative.prepareMs + this.cumulative.renderMs +
      this.cumulative.headerCropMs + this.cumulative.normalizeMs + this.cumulative.mergeMs + this.cumulative.disposeMs
    this.log('[Performance][Document]', {
      documentId: this.documentId,
      pages: pageCount, selectedPages, excludedPages: pageCount - selectedPages, status,
      pagesStarted: this.pages.size,
      unsettledPages: [...this.pages.values()].filter((page) => !page.finished).length,
      cumulative: Object.fromEntries(Object.entries(this.cumulative).map(([key, value]) => [key, rounded(value)])),
      localProcessingMs: rounded(localProcessingMs), elapsedMs: rounded(this.now() - this.startedAt),
      timingBasis: 'cumulative stages overlap across pages; elapsedMs is document wall-clock including cleanup; localProcessingMs is measured local stages, not CPU time'
    })
  }
}

export function summarizeRequest(value: unknown) {
  const payload = value as Record<string, unknown> | null
  return {
    enableThinking: typeof payload?.enable_thinking === 'boolean' ? payload.enable_thinking : 'not-sent',
    reasoningEffort: typeof payload?.reasoning_effort === 'string' &&
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(payload.reasoning_effort)
      ? payload.reasoning_effort : payload?.reasoning_effort === undefined ? 'not-sent' : 'other',
    toolCount: Array.isArray(payload?.tools) ? payload.tools.length : 0
  }
}

export function summarizeNormalizer(messages: AgentMessage[]) {
  const replies = messages.filter((message): message is AssistantMessage => message.role === 'assistant')
  const thinking = replies.flatMap((message) => message.content.filter((block) => block.type === 'thinking'))
  // pi-ai 0.84.3 openai-completions maps absent reasoning_tokens to 0.
  // A zero from this SDK cannot establish that the provider reported zero.
  const reasoningAvailable = replies.length > 0 && replies.every((message) => (message.usage.reasoning ?? 0) > 0)
  const usageAvailable = replies.length > 0 && replies.every((message) =>
    message.usage.totalTokens > 0 || message.usage.input + message.usage.output > 0)
  return {
    modelResponses: replies.length,
    inputTokens: usageAvailable ? replies.reduce((sum, message) =>
      sum + message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, 0) : null,
    outputTokens: usageAvailable ? replies.reduce((sum, message) => sum + message.usage.output, 0) : null,
    reasoningTokens: reasoningAvailable ? replies.reduce((sum, message) => sum + message.usage.reasoning!, 0) : null,
    reasoningMetrics: reasoningAvailable ? 'available (subset of outputTokens)' :
      'reasoning metrics unavailable (SDK zero may mean zero or unreported)',
    hasThinking: thinking.length > 0,
    thinkingChars: thinking.reduce((sum, block) => sum + block.thinking.length, 0),
    stopReasons: replies.map((message) => message.stopReason),
    toolCalls: replies.reduce((sum, message) => sum + message.content.filter((block) => block.type === 'toolCall').length, 0),
    toolResults: messages.filter((message) => message.role === 'toolResult').length,
    toolErrors: messages.filter((message) => message.role === 'toolResult' && message.isError).length
  }
}

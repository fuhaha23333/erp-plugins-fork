export type ModelStage = 'ocr' | 'normalizer'

interface QueuedRequest {
  start: () => void
}

/** Per-document stage limits plus one shared budget. No document content is stored here. */
export class ModelRequestScheduler {
  private readonly queues: Record<ModelStage, QueuedRequest[]> = { ocr: [], normalizer: [] }
  private readonly active: Record<ModelStage, number> = { ocr: 0, normalizer: 0 }
  private lastStage: ModelStage = 'normalizer'

  constructor(private readonly limits: { ocr: number; normalizer: number; total: number }) {
    if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n <= 0)) {
      throw new Error('模型并发上限必须是正整数')
    }
  }

  run<T>(stage: ModelStage, operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues[stage]
      const cancel = (): void => {
        const index = queue.indexOf(job)
        if (index >= 0) queue.splice(index, 1)
        signal.removeEventListener('abort', cancel)
        reject(signal.reason)
      }
      const release = (): void => {
        this.active[stage]--
        this.drain()
      }
      const job: QueuedRequest = {
        start: () => {
          signal.removeEventListener('abort', cancel)
          this.active[stage]++
          // A job can be aborted after dispatch but before its microtask starts.
          Promise.resolve().then(() => {
            signal.throwIfAborted()
            return operation()
          }).then(
            (value) => { release(); resolve(value) },
            (error) => { release(); reject(error) }
          )
        }
      }
      queue.push(job)
      signal.addEventListener('abort', cancel, { once: true })
      this.drain()
    })
  }

  private drain(): void {
    while (this.active.ocr + this.active.normalizer < this.limits.total) {
      // Alternate eligible stages, preserving FIFO within each, so neither starves.
      const preferred: ModelStage = this.lastStage === 'ocr' ? 'normalizer' : 'ocr'
      const stage = [preferred, this.lastStage].find((s) =>
        this.queues[s].length > 0 && this.active[s] < this.limits[s])
      if (!stage) return
      const job = this.queues[stage].shift()!
      this.lastStage = stage
      job.start()
    }
  }
}

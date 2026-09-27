import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelRequestScheduler } from '../src/main/agent/model-request-scheduler'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('shared budget and stage limits bound overlapping tasks, not just dispatch counts', async () => {
  const scheduler = new ModelRequestScheduler({ ocr: 2, normalizer: 1, total: 2 })
  const controller = new AbortController()
  const gates = Array.from({ length: 4 }, deferred)
  const started: number[] = []
  const stages = ['ocr', 'ocr', 'normalizer', 'normalizer'] as const
  const counts = { ocr: 0, normalizer: 0 }
  const tasks = stages.map((stage, i) => scheduler.run(stage, async () => {
    counts[stage]++
    assert.ok(counts.ocr <= 2 && counts.normalizer <= 1 && counts.ocr + counts.normalizer <= 2)
    started.push(i)
    await gates[i].promise
    counts[stage]--
    return i
  }, controller.signal))
  await tick()
  assert.deepEqual(started, [0, 1])
  gates[0].resolve(); await tick()
  assert.deepEqual(started, [0, 1, 2])
  gates[1].resolve(); await tick()
  assert.deepEqual(started, [0, 1, 2], 'second normalizer must wait despite free total capacity')
  gates[2].resolve(); await tick()
  gates[3].resolve()
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3])
  controller.abort()
})

test('rejection releases capacity and ready normalizer is not starved by an OCR backlog', async () => {
  const scheduler = new ModelRequestScheduler({ ocr: 1, normalizer: 1, total: 1 })
  const controller = new AbortController(), gate = deferred(), order: string[] = []
  const first = scheduler.run('ocr', async () => { await gate.promise; throw Error('expected failure') }, controller.signal)
  const rejected = assert.rejects(first, /expected failure/)
  const rest = [1, 2, 3].map((i) => scheduler.run('ocr', async () => { order.push(`ocr${i}`) }, controller.signal))
  const normalizer = scheduler.run('normalizer', async () => { order.push('normalizer') }, controller.signal)
  gate.resolve()
  await Promise.all([rejected, ...rest, normalizer])
  assert.deepEqual(order, ['normalizer', 'ocr1', 'ocr2', 'ocr3'])
  controller.abort()
})

test('abort rejects queued work without running it and does not release active capacity prematurely', async () => {
  const scheduler = new ModelRequestScheduler({ ocr: 1, normalizer: 1, total: 1 })
  const firstController = new AbortController(), nextController = new AbortController(), gate = deferred()
  let ranCancelled = false, ranNext = false
  const active = scheduler.run('ocr', () => gate.promise, firstController.signal)
  await tick()
  const queued = scheduler.run('normalizer', async () => { ranCancelled = true }, firstController.signal)
  const rejected = assert.rejects(queued, /cancelled/)
  firstController.abort(Error('cancelled'))
  const next = scheduler.run('ocr', async () => { ranNext = true }, nextController.signal)
  await tick()
  assert.equal(ranCancelled, false)
  assert.equal(ranNext, false)
  gate.resolve()
  await Promise.all([active, rejected, next])
  assert.equal(ranNext, true)
  await assert.rejects(scheduler.run('ocr', async () => {}, firstController.signal), /cancelled/)
  nextController.abort()
})

test('a bounded 50-page backlog settles all jobs without runtime warnings', async (t) => {
  const warnings: unknown[] = []
  t.mock.method(process, 'emitWarning', (warning: unknown) => { warnings.push(warning) })
  const scheduler = new ModelRequestScheduler({ ocr: 1, normalizer: 1, total: 1 })
  const controller = new AbortController(), gate = deferred()
  const tasks = Array.from({ length: 50 }, () => scheduler.run('ocr', () => gate.promise, controller.signal))
  gate.resolve()
  await Promise.all(tasks)
  await tick()
  controller.abort()
  assert.equal(warnings.length, 0)
})

/** Task routing preserves instance subscriptions and awaited delivery ownership. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, onTestFinished } from 'vitest'
import { AutomationTaskRouter } from '../src/index.ts'
import { AutomationSource } from '../src/source.ts'
import type { AutomationCandidate, AutomationTaskId } from '../src/types.ts'

class CandidateSource extends AutomationSource<AutomationCandidate> {
  publish(text: string): Promise<void> { return this.emit({ text }) }
}

const taskId = brandString<AutomationTaskId>('task-one')

async function mount() {
  const ctx = new Context()
  const fiber = ctx.plugin(AutomationTaskRouter)
  onTestFinished(async () => { await fiber.dispose() })
  await fiber
  const source = new CandidateSource()
  onTestFinished(async () => { await source.dispose() })
  return { ctx, source, router: ctx.automationTasks }
}

describe('automation task connections', () => {
  it('delivers each instance to its connected task and awaits the receiver', async () => {
    const { router, source } = await mount()
    const other = new CandidateSource()
    onTestFinished(async () => { await other.dispose() })
    const delivered: Array<[AutomationTaskId, string]> = []
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const unregister = router.registerReceiver({ deliver: async (id, candidate) => {
      entered.resolve(undefined)
      await release.promise
      delivered.push([id, candidate.text])
    } })
    onTestFinished(unregister)
    router.connect(source, taskId)
    router.connect(other, brandString<AutomationTaskId>('task-two'))
    const first = source.publish('first')
    const second = other.publish('second')
    await entered.promise
    expect(delivered).toEqual([])
    release.resolve(undefined)
    await Promise.all([first, second])
    expect(delivered).toEqual([[taskId, 'first'], ['task-two', 'second']])
  })

  it('requires a task receiver and rejects a duplicate registration', async () => {
    const { router, source } = await mount()
    expect(() => router.connect(source, taskId)).toThrowError(expect.objectContaining({ code: 'SOURCE_TASK_RECEIVER_UNAVAILABLE' }))
    const receiver = { deliver: async () => {} }
    const unregister = router.registerReceiver(receiver)
    expect(() => router.registerReceiver(receiver)).toThrowError(expect.objectContaining({ code: 'SOURCE_TASK_RECEIVER_DUPLICATE' }))
    await unregister()
    expect(() => router.connect(source, taskId)).toThrowError(expect.objectContaining({ code: 'SOURCE_TASK_RECEIVER_UNAVAILABLE' }))
  })

  it('drains accepted work on unregister and never redirects an old connection to a new receiver', async () => {
    const { router, source } = await mount()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const unregister = router.registerReceiver({ deliver: async () => { entered.resolve(undefined); await release.promise } })
    router.connect(source, taskId)
    const output = source.publish('accepted')
    await entered.promise
    let closed = false
    const closing = unregister().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    const received: string[] = []
    const next = router.registerReceiver({ deliver: async (_id, value) => { received.push(value.text) } })
    onTestFinished(next)
    await expect(source.publish('stale')).rejects.toMatchObject({ code: 'SOURCE_DELIVERY_FAILED' })
    release.resolve(undefined)
    await Promise.all([output, closing])
    await unregister()
    const newSource = new CandidateSource()
    onTestFinished(async () => { await newSource.dispose() })
    router.connect(newSource, taskId)
    await newSource.publish('new')
    expect(received).toEqual(['new'])
  })

  it('removes a receiver through its contributing Cordis fiber', async () => {
    const { ctx, router, source } = await mount()
    const contributor = ctx.plugin({ inject: ['automationTasks'], apply(scope: Context) {
      scope.effect(() => scope.automationTasks.registerReceiver({ deliver: async () => {} }))
    } })
    await contributor
    router.connect(source, taskId)
    await source.publish('before unload')
    await contributor.dispose()
    await expect(source.publish('after unload')).rejects.toMatchObject({ code: 'SOURCE_DELIVERY_FAILED' })
    expect(() => router.connect(source, taskId)).toThrowError(expect.objectContaining({ code: 'SOURCE_TASK_RECEIVER_UNAVAILABLE' }))
  })

  it('returns a task failure to the emitting source', async () => {
    const { router, source } = await mount()
    const failure = new Error('storage failed')
    const unregister = router.registerReceiver({ deliver: async () => { throw failure } })
    onTestFinished(unregister)
    router.connect(source, taskId)
    await expect(source.publish('input')).rejects.toMatchObject({
      code: 'SOURCE_DELIVERY_FAILED', cause: { errors: [failure] },
    })
    await unregister()
  })
})

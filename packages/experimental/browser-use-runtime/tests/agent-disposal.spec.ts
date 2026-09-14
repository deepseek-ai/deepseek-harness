/** AgentHandle disposal must release blocking browser work before waiting for idle. */

import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { SessionResources } from '../src/index.ts'

it('closes an owned resource during disposed cancellation before the real Agent reaches idle', async () => {
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const closing = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  const releaseClose = Promise.withResolvers<undefined>()
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  const owner = await ctx.agents.create({ sessionId: SessionId('browser-disposal') })
  const resources = new SessionResources(ctx, {
    label: 'browser-fixture', exclusive: true,
    open: async () => ({
      value: {},
      async close() { closing.resolve(undefined); stopped.resolve(undefined); await releaseClose.promise },
    }),
  })
  let disposed: Promise<void> | undefined
  try {
    const operation = owner.agent.runMaintenance(signal => resources.run(owner.agent, signal, async () => {
      entered.resolve(undefined)
      await stopped.promise
    }))
    const canceled = expect(operation).rejects.toMatchObject({ kind: 'disposed' })
    await entered.promise
    disposed = owner.dispose()
    await closing.promise
    await canceled
    expect(resources.available(owner.agent)).toBe(false)
    expect(ctx.agents.get(owner.agent.id)).toBe(owner.agent)
    releaseClose.resolve(undefined)
    await disposed
    expect(ctx.agents.get(owner.agent.id)).toBeUndefined()
  } finally {
    stopped.resolve(undefined)
    releaseClose.resolve(undefined)
    await disposed
    await resources.dispose()
    await ctx.fiber.dispose()
  }
})

it('disposes an initializing browser after its first caller was already user-canceled', async () => {
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const rollback = Promise.withResolvers<undefined>()
  let acquisitionAborted = false
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  const owner = await ctx.agents.create({ sessionId: SessionId('browser-initialization-disposal') })
  const execute = vi.fn(async () => true)
  const resources = new SessionResources(ctx, {
    label: 'initializing-browser', exclusive: true,
    async open(_agent, signal) {
      signal.addEventListener('abort', () => { acquisitionAborted = true }, { once: true })
      entered.resolve(undefined)
      await rollback.promise
      signal.throwIfAborted()
      return { value: {}, close: async () => {} }
    },
  })
  let disposing: Promise<void> | undefined
  try {
    const operation = owner.agent.runMaintenance(signal => resources.run(owner.agent, signal, execute))
    const canceled = operation.catch((error: unknown) => error)
    await entered.promise
    owner.agent.cancel({ kind: 'user' })
    let disposed = false
    disposing = owner.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(acquisitionAborted).toBe(true) })
    expect(await canceled).toMatchObject({ cause: { kind: 'user' } })
    expect(disposed).toBe(false)
    expect(ctx.agents.get(owner.agent.id)).toBe(owner.agent)
    rollback.resolve(undefined)
    await disposing
    expect(execute).not.toHaveBeenCalled()
    expect(ctx.agents.get(owner.agent.id)).toBeUndefined()
  } finally {
    rollback.resolve(undefined)
    await resources.dispose()
    await disposing
    await ctx.fiber.dispose()
  }
})

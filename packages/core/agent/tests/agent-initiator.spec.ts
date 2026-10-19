import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { runInNewContext } from 'node:vm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

function agent(id: string): Agent {
  return { id: SessionId(id) } as Agent
}

async function harness(): Promise<{
  ctx: Context
  service: AgentRegistry
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentRegistry)
  return {
    ctx,
    service: ctx.agents,
    dispose: fiber.dispose,
  }
}

/** Fail a lifecycle regression promptly instead of waiting for Vitest's suite timeout. */
async function promptly<T>(task: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => { timeout.reject(new Error('initiator teardown did not settle promptly')) }, 1000)
  try {
    return await Promise.race([task, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

describe('AgentRegistry initiator scope', () => {
  it('reports an absent initiator and requires an active boundary', async () => {
    const { service, dispose } = await harness()
    expect(service.currentInitiator()).toBeUndefined()
    expect(() => service.requireInitiator()).toThrow('no initiating agent is active')
    await dispose()
  })

  it('preserves exact synchronous and Promise return identities across await', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('identity')
    const value = { result: true }
    expect(service.withInitiator(initiator, () => {
      expect(service.requireInitiator()).toBe(initiator)
      return value
    })).toBe(value)

    const promise = service.withInitiator(initiator, async () => {
      expect(service.requireInitiator()).toBe(initiator)
      await Promise.resolve()
      expect(service.requireInitiator()).toBe(initiator)
      return value
    })
    expect(service.withInitiator(initiator, () => promise)).toBe(promise)
    await expect(promise).resolves.toBe(value)
    expect(service.currentInitiator()).toBeUndefined()
    await dispose()
  })

  it('tracks a branded Promise without calling its overridable then property', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('overridden-then')
    const release = Promise.withResolvers<boolean>()
    void Object.defineProperty(release.promise, 'then', {
      value: () => { throw new Error('overridden then called') },
    })

    const pending = service.withInitiator(initiator, () => release.promise)
    expect(pending).toBe(release.promise)

    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(true)
    await new Promise<void>((resolve, reject) => {
      void Promise.prototype.then.call(pending, resolve, reject)
    })
    await disposal
    expect(disposed).toBe(true)
  })

  it('preserves a settled branded Promise when its species blocks observer construction', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('invalid-species')
    const promise = Promise.resolve()
    const constructor = {}
    Object.defineProperty(constructor, Symbol.species, {
      get: () => { throw new Error('invalid species') },
    })
    void Object.defineProperty(promise, 'constructor', { value: constructor })

    expect(service.withInitiator(initiator, () => promise)).toBe(promise)
    await dispose()
  })

  it('isolates overlapping initiators', async () => {
    const { service, dispose } = await harness()
    const a = agent('a')
    const b = agent('b')
    const bothStarted = Promise.withResolvers<boolean>()
    const release = Promise.withResolvers<boolean>()
    let starts = 0
    const run = (initiator: Agent): Promise<void> => service.withInitiator(initiator, async () => {
      expect(service.requireInitiator()).toBe(initiator)
      starts += 1
      if (starts === 2) bothStarted.resolve(true)
      await release.promise
      expect(service.requireInitiator()).toBe(initiator)
    })

    const pending = [run(a), run(b)]
    await bothStarted.promise
    expect(service.currentInitiator()).toBeUndefined()
    release.resolve(true)
    await Promise.all(pending)
    await dispose()
  })

  it('restores nested and explicitly cleared boundaries', async () => {
    const { service, dispose } = await harness()
    const parent = agent('parent')
    const child = agent('child')

    service.withInitiator(parent, () => {
      expect(service.requireInitiator()).toBe(parent)
      service.withInitiator(child, () => { expect(service.requireInitiator()).toBe(child) })
      expect(service.requireInitiator()).toBe(parent)
      service.withoutInitiator(() => {
        expect(service.currentInitiator()).toBeUndefined()
        expect(() => service.requireInitiator()).toThrow('no initiating agent is active')
      })
      expect(service.requireInitiator()).toBe(parent)
    })
    expect(service.currentInitiator()).toBeUndefined()
    await dispose()
  })

  it('restores the parent after synchronous throws and rejected operations', async () => {
    const { service, dispose } = await harness()
    const parent = agent('parent')
    const child = agent('child')
    const syncError = new Error('sync failure')
    const asyncError = new Error('async failure')

    service.withInitiator(parent, () => {
      expect(() => service.withInitiator(child, () => { throw syncError })).toThrow(syncError)
      expect(service.requireInitiator()).toBe(parent)
    })
    await expect(service.withInitiator(child, async () => {
      await Promise.resolve()
      throw asyncError
    })).rejects.toBe(asyncError)
    expect(service.currentInitiator()).toBeUndefined()
    await dispose()
  })

  it('stops new boundaries, drains active Promises, and invalidates retained references', async () => {
    const { ctx, service, dispose } = await harness()
    const initiator = agent('draining')
    const release = Promise.withResolvers<boolean>()
    const pending = service.withInitiator(initiator, async () => {
      await release.promise
      expect(service.requireInitiator()).toBe(initiator)
    })
    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()

    expect(() => service.withInitiator(initiator, () => 1)).toThrow('agent initiator scope is disposed')
    expect(() => service.withoutInitiator(() => 1)).toThrow('agent initiator scope is disposed')
    expect(disposed).toBe(false)
    expect(ctx.get('agents')).toBeUndefined()
    release.resolve(true)
    await pending
    await disposal
    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
    expect(() => service.requireInitiator()).toThrow('agent initiator scope is disposed')
  })

  it('drains cross-realm Promise boundaries before disposal', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('cross-realm')
    const release = Promise.withResolvers<boolean>()
    const operation = runInNewContext(
      '(async () => { await release; inspect() })',
      {
        release: release.promise,
        inspect: () => { expect(service.requireInitiator()).toBe(initiator) },
      },
    ) as () => Promise<void>
    const pending = service.withInitiator(initiator, operation)
    expect(pending).not.toBeInstanceOf(Promise)

    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(true)
    await pending
    await disposal
    expect(disposed).toBe(true)
  })

  it('does not self-deadlock when a boundary returns service disposal', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('service-disposer')

    const returned = service.withInitiator(initiator, dispose)
    await promptly(returned)

    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
  })

  it('does not self-deadlock when nested boundaries return ancestor disposal', async () => {
    const { ctx, service } = await harness()
    const parent = agent('parent-disposer')
    const child = agent('child-disposer')
    let disposal: Promise<void> | undefined

    const returned = service.withInitiator(parent, () => service.withInitiator(child, () => {
      disposal = ctx.fiber.dispose()
      return disposal
    }))
    expect(returned).toBe(disposal)

    await promptly(returned)
    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
  })

  it('excludes an asynchronous teardown initiator while draining unrelated boundaries', async () => {
    const { ctx, service } = await harness()
    const initiator = agent('async-disposer')
    const unrelated = agent('unrelated')
    const release = Promise.withResolvers<boolean>()
    const pending = service.withInitiator(unrelated, async () => {
      await release.promise
      expect(service.requireInitiator()).toBe(unrelated)
    })

    const returned = service.withInitiator(initiator, async () => {
      await Promise.resolve()
      await ctx.fiber.dispose()
    })
    let disposed = false
    void returned.then(() => { disposed = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(true)
    await pending
    await promptly(returned)

    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
  })
})

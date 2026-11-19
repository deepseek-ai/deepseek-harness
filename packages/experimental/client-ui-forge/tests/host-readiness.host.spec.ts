/** `forgePanel.hostReadiness`, which the host list on a provider row's Plugins page reads. */
import { afterEach, describe, expect, it } from 'vitest'
import type { ForgeReadiness } from '@deepseek-ai/dsh-experimental-forge'
import type { Config } from '../src/index.ts'
import { bench, scratch } from './harness.ts'
import type { Bench } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const signal = new AbortController().signal

/** A panel Remote whose Session directory is no checkout; the read names no Session. */
async function opened(config: Config = {}): Promise<Bench> {
  const { path, remove } = await scratch('dsh-forge-host-readiness-')
  cleanups.push(remove)
  const result = await bench(path, config)
  cleanups.push(() => result.ctx.fiber.dispose())
  return result
}

describe('forgePanel.hostReadiness', () => {
  it('reports the provider\'s readiness for the host in lowercase', async () => {
    const { ctx, provider } = await opened()
    const signIn: ForgeReadiness = { state: 'unauthenticated', message: 'not signed in', signIn: { command: 'fake auth login --hostname fake.test' } }
    const probed: string[] = []
    provider.readinessImpl = (host) => { probed.push(host); return Promise.resolve(signIn) }

    await expect(ctx.forgePanel.hostReadiness('fake', 'Fake.TEST', signal)).resolves.toEqual(signIn)

    expect(probed).toEqual(['fake.test'])
  })

  it('reports a family no provider serves as unavailable', async () => {
    const { ctx } = await opened()

    await expect(ctx.forgePanel.hostReadiness('absent', 'absent.test', signal)).resolves.toEqual({
      state: 'unavailable', message: 'forge: no provider is registered for "absent"', signIn: null,
    })
  })

  it('reports a probe that fails as unavailable with its reason', async () => {
    const { ctx, provider } = await opened()
    provider.readinessImpl = () => Promise.reject(new Error('fake: connection refused'))

    await expect(ctx.forgePanel.hostReadiness('fake', 'fake.test', signal)).resolves.toEqual({
      state: 'unavailable', message: 'fake: connection refused', signIn: null,
    })
  })

  it('reports a probe past readinessTimeoutMs as unavailable', async () => {
    const { ctx, provider } = await opened({ readinessTimeoutMs: 50 })
    provider.readinessImpl = (_host, abort) => new Promise((_resolve, reject) => {
      abort.addEventListener('abort', () => { reject(abort.reason as Error) })
    })

    await expect(ctx.forgePanel.hostReadiness('fake', 'fake.test', signal)).resolves.toEqual({
      state: 'unavailable', message: 'FORGE_PANEL_READINESS_TIMEOUT after 50ms', signIn: null,
    })
  })

  it('rejects when the caller cancels before or during the probe', async () => {
    const { ctx, provider } = await opened()
    const stopped = new Error('caller left')
    await expect(ctx.forgePanel.hostReadiness('fake', 'fake.test', AbortSignal.abort(stopped))).rejects.toBe(stopped)

    const caller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    provider.readinessImpl = (_host, abort) => new Promise((_resolve, reject) => {
      abort.addEventListener('abort', () => { reject(abort.reason as Error) })
      entered.resolve(undefined)
    })
    const read = ctx.forgePanel.hostReadiness('fake', 'fake.test', caller.signal)
    await entered.promise
    caller.abort(stopped)

    await expect(read).rejects.toBe(stopped)
  })
})

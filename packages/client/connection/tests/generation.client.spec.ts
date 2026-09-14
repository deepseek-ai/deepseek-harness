import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  type ConnectionGenerationSource,
  type ConnectionHandle,
} from '../src/client/index.ts'

type BrowserGlobal = {
  location?: { hostname: string }
}

const contexts = new Set<Context>()

afterEach(async () => {
  vi.restoreAllMocks()
  delete (globalThis as BrowserGlobal).location
  await Promise.all([...contexts].map(async ctx => ctx.fiber.dispose()))
  contexts.clear()
})

async function mount(): Promise<ConnectionHandle> {
  ;(globalThis as BrowserGlobal).location = { hostname: 'localhost' }
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin({ apply, inject: [] })
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('plugin did not provide Connection')
  return connection
}

describe('Connection generation facts', () => {
  it('publishes ready-frame Host facts and retracts them when the loop stops', async () => {
    const connection = await mount()
    const source: ConnectionGenerationSource = (signal, ready) => {
      ready({ home: '/home/from-ready' })
      return new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    connection.registerGenerationSource(source)
    const seen: Array<string | undefined> = []
    const stopListening = connection.generation.subscribe(() => {
      seen.push(connection.generation.getSnapshot()?.host.home)
    })
    const loop = connection.start({}, {
      backoffBaseMs: 1,
      backoffFactor: 2,
      backoffMaxMs: 8,
      generationReadyTimeoutMs: 100,
    })

    await vi.waitFor(() => {
      expect(connection.generation.getSnapshot()).toEqual({
        id: 1,
        host: { home: '/home/from-ready' },
      })
    })
    loop.stop()
    expect(connection.generation.getSnapshot()).toBeUndefined()
    expect(seen).toEqual(['/home/from-ready', undefined])
    stopListening()
  })
})

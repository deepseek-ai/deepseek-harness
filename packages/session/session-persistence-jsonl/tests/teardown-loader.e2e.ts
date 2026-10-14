/** JSONL teardown preserves events emitted by an asynchronously disposing injected consumer. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SessionPlugin from '@deepseek-ai/dsh-session'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as JsonlPlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionHandleClosedError } from '@deepseek-ai/dsh-session-persistence'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scheduler } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { logPath } from '../src/format.ts'

it('waits for injected consumer teardown, persists its final event, and releases listeners and leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-teardown-'))
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const consumerFinished = Promise.withResolvers<undefined>()
  let session: Session | undefined
  let unload: Promise<void> | undefined
  let unloadFinished = false
  const consumer = {
    name: 'async-persistence-consumer',
    inject: ['sessionPersistence', 'sessions'],
    async apply(consumerCtx: Context) {
      // Keep the Session alive while its persistence consumer unloads.
      session = ctx.sessions.create(SessionId('async-teardown'))
      await consumerCtx.sessionPersistence.create(session.header)
      const live = session
      live.append('turn/start', { turn: 1 })
      await consumerCtx.sessions.flush(live)
      consumerCtx.effect(() => async () => {
        entered.resolve(undefined)
        try {
          await release.promise
          live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        } finally {
          consumerFinished.resolve(undefined)
        }
      })
    },
  }
  try {
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: sessions',
      "  name: '@deepseek-ai/dsh-session'",
      '- id: persistence',
      "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${JSON.stringify(root)}`,
      '    compression: none',
      '- id: consumer',
      '  name: async-persistence-consumer',
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      loadCache: new Map(),
      async import(specifier: string) {
        switch (specifier) {
          case '@deepseek-ai/dsh-session': return SessionPlugin
          case '@deepseek-ai/dsh-session-persistence-jsonl': return JsonlPlugin
          case 'async-persistence-consumer': return consumer
          default: throw new Error(`Unexpected plugin: ${specifier}`)
        }
      },
      register(): never { throw new Error('Unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
      resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const entries = [...ctx.loader.entries()]
    const provider = entries.find(entry => entry.options.id === 'persistence')!
    const consumingEntry = entries.find(entry => entry.options.id === 'consumer')!
    await provider.fiber!.await()
    await consumingEntry.fiber!.await()
    expect(session).toBeDefined()
    const live = session!
    const oldReader = await ctx.sessionPersistence.open(live.id, 'read')
    const path = logPath(root, live.header.cwd, live.id, 'none')
    const before = await readFile(path, 'utf8')
    expect(before).toContain('turn/start')
    expect(before).not.toContain('turn/end')
    const routedEvents = ['session/event', 'session/flush', 'session/disposed'] as const
    for (const event of routedEvents) expect(ctx.events.dispatch('emit', [event])).toHaveLength(1)

    unload = provider.fiber!.dispose().then(() => { unloadFinished = true })
    await Promise.race([
      entered.promise,
      unload.then(() => { throw new Error('Provider unloaded before its injected consumer entered teardown') }),
    ])
    await scheduler.yield()
    expect(unloadFinished).toBe(false)
    for (const event of routedEvents) expect(ctx.events.dispatch('emit', [event])).toHaveLength(1)
    release.resolve(undefined)
    await consumerFinished.promise
    await unload

    expect(ctx.get('sessionPersistence')).toBeUndefined()
    for (const event of routedEvents) expect(ctx.events.dispatch('emit', [event])).toHaveLength(0)
    await expect(oldReader.read()).rejects.toBeInstanceOf(SessionHandleClosedError)
    const persisted = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line): unknown => JSON.parse(line))
    expect(persisted.slice(1)).toEqual(live.snapshotEvents())
    expect(persisted.at(-1)).toMatchObject({ type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })

    await consumingEntry.fiber!.dispose()
    await provider.init()
    await provider.fiber!.await()
    const reopened = await ctx.sessionPersistence.open(live.id, 'write')
    try {
      expect((await reopened.read()).events).toEqual(live.snapshotEvents())
      await reopened.flush()
    } finally {
      await reopened.close()
    }
    for (const event of routedEvents) expect(ctx.events.dispatch('emit', [event])).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    try {
      try {
        await unload
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

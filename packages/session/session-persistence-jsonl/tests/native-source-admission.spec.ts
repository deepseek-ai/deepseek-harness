import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const id = SessionId('native-source-admission')
const modes = (['none', 'zstd'] as const).flatMap(compression => (['read', 'write'] as const).map(access => ({ compression, access })))
let root: string
const contexts: Context[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-native-source-')) })
afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe.each(modes)('native message-source admission ($compression, $access)', ({ compression, access }) => {
  async function stored(source: unknown, type = 'agent/inbox/spliced', ignorable = false) {
    const header = { type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1, delegationDepth: 0, isSeeded: false }
    const event = { type, seq: 0, time: 1, ...(ignorable ? { ignorable: true } : {}), data: {
      target: 'next-turn', start: 0, inserted: [{ id: 'input', role: 'user', source, content: [{ type: 'text', text: 'queued' }] }],
    } }
    const lines = [header, event].map(value => JSON.stringify(value) + '\n')
    const bytes = compression === 'none' ? Buffer.from(lines.join('')) : Buffer.concat(await Promise.all(lines.map(compressZstdFrame)))
    const path = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, compression)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    return { ctx, path, bytes, event }
  }

  it.each([null, {}, [], { kind: '' }, { kind: 1 }].map(source => ({ source })))('refuses malformed queued source $source before exposing a handle', async ({ source }) => {
    const { ctx, path, bytes } = await stored(source)
    const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => { await handle.close() })
    await expect(opened).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    await expect(opened).rejects.toThrow('producer-owned source kind')
    expect(await readFile(path)).toEqual(bytes)
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock')).toHaveLength(1)
  })

  it('still validates known queued events marked ignorable', async () => {
    const { ctx, path, bytes } = await stored({}, 'agent/inbox/spliced', true)
    const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => { await handle.close() })
    await expect(opened).rejects.toThrow('producer-owned source kind')
    expect(await readFile(path)).toEqual(bytes)
  })

  it('preserves external attribution and own JSON metadata without a producer installed', async () => {
    const source = JSON.parse('{"kind":"external-producer","__proto__":{"retain":true},"metadata":{"count":1}}') as unknown
    const { ctx, path, bytes, event } = await stored(source)
    const handle = await ctx.sessionPersistence.open(id, access)
    try {
      expect((await handle.read()).events[0]).toEqual(event)
    } finally {
      await handle.close()
    }
    expect(await readFile(path)).toEqual(bytes)
  })

  it('leaves unknown ignorable queued payloads opaque', async () => {
    const { ctx, path, bytes, event } = await stored(null, 'external/inbox', true)
    const handle = await ctx.sessionPersistence.open(id, access)
    try {
      expect((await handle.read()).events[0]).toEqual(event)
    } finally {
      await handle.close()
    }
    expect(await readFile(path)).toEqual(bytes)
  })
})

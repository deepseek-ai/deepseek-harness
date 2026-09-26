import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function identity(path: string) {
  const info = await stat(path, { bigint: true })
  return { bytes: await readFile(path), dev: info.dev, ino: info.ino, mtime: info.mtimeNs, ctime: info.ctimeNs }
}

describe.each(['none', 'zstd'] as const)('V3 interrupted-turn publication (%s)', (compression) => {
  async function fixture(openStep = false) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-v3-restart-'))
    roots.push(root)
    const id = SessionId('restart')
    const path = generationLogPath(root, undefined, id, 3, compression)
    const message = { id: 'next', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }
    const rows = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      ...openStep ? [] : [{ type: 'step/end', data: { turn: 1, step: 1 } }],
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [message] } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: message, surfaceOp: 'append' },
      { type: 'session/title', data: { title: 'continue', source: { kind: 'fallback' }, messageSeqs: [5] } },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ].map((event, seq) => ({ ...event, seq, time: seq + 10 }))
    const header = { type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const first = JSON.stringify(header) + '\n'
    const body = rows.map(row => JSON.stringify(row) + '\n').join('')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, compression === 'none' ? first + body
      : Buffer.concat([await compressZstdFrame(first), await compressZstdFrame(body)]))
    async function mount() {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression })
      return ctx
    }
    return { id, path, root, rows, mount }
  }

  it('prepares read-only, publishes a verified V4 successor, and reopens without repeating the repair', async () => {
    const f = await fixture()
    const original = await identity(f.path)
    const directory = dirname(f.path)
    const files = await readdir(directory)
    const ctx = await f.mount()
    const reader = await ctx.sessionPersistence.open(f.id, 'read')
    let prepared: readonly SessionEvent[]
    try {
      prepared = (await reader.read()).events
      expect(reader.header.version).toBe(4)
      expect(prepared).toHaveLength(f.rows.length + 1)
      expect(prepared[4]).toEqual({ type: 'turn/end', seq: 4, time: 14, data: { turn: 1, reason: { kind: 'interrupted' } } })
      expect(prepared[7]).toMatchObject({ type: 'session/title', data: { messageSeqs: [6] } })
    } finally {
      await reader.close()
    }
    expect(await identity(f.path)).toEqual(original)
    expect(await readdir(directory)).toEqual(files)
    const writer = await ctx.sessionPersistence.open(f.id, 'write')
    try { expect((await writer.read()).events).toEqual(prepared) } finally { await writer.close() }
    expect(await identity(f.path)).toEqual(original)
    expect((await readdir(directory)).filter(name => name !== 'session.lock').sort()).toEqual([
      compression === 'none' ? 'session.v3.jsonl' : 'session.v3.jsonl.zstd',
      compression === 'none' ? 'session.v4.jsonl' : 'session.v4.jsonl.zstd',
    ])
    const independent = await f.mount()
    const reopened = await independent.sessionPersistence.open(f.id, 'read')
    try { expect((await reopened.read()).events).toEqual(prepared) } finally { await reopened.close() }
    expect(await identity(f.path)).toEqual(original)
  })

  it('refuses an unsettled restart without publishing or changing V3', async () => {
    const f = await fixture(true)
    const original = await identity(f.path)
    const ctx = await f.mount()
    for (const access of ['read', 'write'] as const) {
      await expect(ctx.sessionPersistence.open(f.id, access)).rejects.toThrow('turn/start does not open the expected turn')
    }
    expect(await identity(f.path)).toEqual(original)
    expect((await readdir(dirname(f.path))).filter(name => name !== 'session.lock')).toEqual([
      compression === 'none' ? 'session.v3.jsonl' : 'session.v3.jsonl.zstd',
    ])
  })
})

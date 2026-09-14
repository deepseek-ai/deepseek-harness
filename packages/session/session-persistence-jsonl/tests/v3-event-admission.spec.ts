import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath, scanLog } from '../src/format.ts'

const id = SessionId('v3-admission')
const header = { type: 'session', version: 3, id, createdAt: 1000, isSeeded: false, delegationDepth: 0 }
const start = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
const prefix = [header, start].map(row => JSON.stringify(row)).join('\n') + '\n'
const obsoleteTypes = ['tool/code-dispatch-start', 'tool/code-dispatch'] as const

function obsoleteEvent(type: string, ignorable?: true) {
  return {
    type, seq: 1, time: 2,
    data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: {} },
    ...(ignorable ? { ignorable } : {}),
  }
}

describe('native V3 event admission at EOF', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-v3-admission-'))
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })

  afterEach(async () => {
    try {
      await ctx?.fiber.dispose()
    } finally {
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  })

  async function store(bytes: Buffer): Promise<string> {
    const path = generationLogPath(root, undefined, id, 3, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    return path
  }

  it.each([{ surfaceOp: 'append' }, { sourceEventSeqs: [] }])('refuses unknown required metadata %j without truncating a provider append', async (metadata) => {
    const event = { type: 'future/required', seq: 0, time: 1, data: {}, ...metadata }
    const bytes = Buffer.from([header, event].map(row => JSON.stringify(row)).join('\n') + '\n')
    expect(scanLog(bytes)).toMatchObject({ events: [event], committedBytes: bytes.length })
    const path = await store(bytes)
    const sourceStat = await stat(path)
    for (const access of ['read', 'write'] as const) {
      const operation = async () => {
        const handle = await ctx.sessionPersistence.open(id, access)
        try {
          if (access === 'read') await handle.read()
          else await handle.append([{ type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }])
        } finally {
          await handle.close()
        }
      }
      await expect(operation()).rejects.toThrow('unknown to this harness and not marked ignorable')
      expect(await readFile(path)).toEqual(bytes)
      expect(await stat(path)).toMatchObject({ dev: sourceStat.dev, ino: sourceStat.ino })
    }
  })

  it.each(obsoleteTypes)('scanLog refuses a complete required %s EOF row', (type) => {
    const bytes = Buffer.from(prefix + JSON.stringify(obsoleteEvent(type)) + '\n')
    expect(() => scanLog(bytes)).toThrow(SessionFormatUnsupportedError)
    expect(() => scanLog(bytes)).toThrow('format v3 contains unknown event type')
  })

  it.each(obsoleteTypes.flatMap(type => ['', '{not json\n', 'null\n'].map(corruption => ({ type, corruption }))))(
    'scan, read and write refuse required $type after "$corruption" without changing bytes or inode', async ({ type, corruption }) => {
      const bytes = Buffer.from(prefix + corruption + JSON.stringify(obsoleteEvent(type)) + '\n')
      expect(() => scanLog(bytes)).toThrow(SessionFormatUnsupportedError)
      expect(() => scanLog(bytes)).toThrow('format v3 contains unknown event type')
      const path = await store(bytes)
      const sourceStat = await stat(path)
      for (const access of ['read', 'write'] as const) {
        const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => {
          await handle.close()
        })
        await expect(opened).rejects.toThrow(SessionFormatUnsupportedError)
        expect(await readFile(path)).toEqual(bytes)
        expect(await stat(path)).toMatchObject({ dev: sourceStat.dev, ino: sourceStat.ino })
      }
    },
  )

  it.each(['', '{not json\n', 'null\n'])('refuses malformed system payloads after %j without modifying storage', async (corruption) => {
    const malformed = { type: 'system/message', seq: 1, time: 2, data: null, surfaceOp: 'append' }
    const bytes = Buffer.from(prefix + corruption + JSON.stringify(malformed) + '\n')
    expect(() => scanLog(bytes)).toThrow('system/message data must be an object')
    const path = await store(bytes)
    const sourceStat = await stat(path)
    for (const access of ['read', 'write'] as const) {
      const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => {
        await handle.close()
      })
      await expect(opened).rejects.toThrow('system/message data must be an object')
      expect(await readFile(path)).toEqual(bytes)
      expect(await stat(path)).toMatchObject({ dev: sourceStat.dev, ino: sourceStat.ino })
    }
  })

  it.each(obsoleteTypes)('retains ignorable %s through scanning and a provider append', async (type) => {
    const event = obsoleteEvent(type, true)
    const bytes = Buffer.from(prefix + JSON.stringify(event) + '\n')
    expect(scanLog(bytes)).toMatchObject({ events: [start, event], committedBytes: bytes.length })
    const path = await store(bytes)
    const writer = await ctx.sessionPersistence.open(id, 'write')
    try {
      expect((await writer.read()).events).toEqual([start, event])
      await writer.append([{
        type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } },
      }])
    } finally {
      await writer.close()
    }
    expect((await readFile(path)).subarray(0, bytes.length)).toEqual(bytes)
  })

  it.each([
    '{not json',
    'null',
    JSON.stringify({ type: 'user/message', seq: 1, time: 2, data: {
      id: 'missing-surface-op', role: 'user', content: [{ type: 'text', text: 'malformed canonical tail' }],
    } }),
  ])('still recovers an ordinary malformed EOF row: %s', async (tail) => {
    const bytes = Buffer.from(prefix + tail + '\n')
    expect(scanLog(bytes)).toMatchObject({ events: [start], committedBytes: Buffer.byteLength(prefix) })
    const path = await store(bytes)
    const writer = await ctx.sessionPersistence.open(id, 'write')
    const end = {
      type: 'turn/end' as const, seq: SessionSeq(1), time: 3, data: { turn: 1, reason: { kind: 'completed' as const } },
    }
    try {
      expect((await writer.read()).events).toEqual([start])
      await writer.append([end])
    } finally {
      await writer.close()
    }
    expect(await readFile(path, 'utf8')).toBe(prefix + JSON.stringify(end) + '\n')
  })
})

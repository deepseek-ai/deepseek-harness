import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath, scanLog } from '../src/format.ts'

const id = SessionId('current-admission')
const header = { type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1000, isSeeded: false, delegationDepth: 0 }
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

describe('current event admission at EOF', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-current-admission-'))
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
    const path = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, 'none')
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

})

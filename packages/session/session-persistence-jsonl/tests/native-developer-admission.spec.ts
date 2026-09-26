/** Native JSONL reads enforce developer relationships before exposing stored data. */
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const id = SessionId('native-developer-admission')
const modes = (['none', 'zstd'] as const).flatMap(compression => (['read', 'write'] as const).map(access => ({ compression, access })))
const coordinates = { turn: 1, step: 1 }
const developer = { type: 'developer/message', surfaceOp: 'append', data: {
  ...coordinates, message: { id: 'developer', role: 'developer', source: { kind: 'tool-registry' }, content: [], extra: { retained: true } },
} }

describe.each(modes)('native developer admission ($compression, $access)', ({ compression, access }) => {
  async function stored(event: object, corruptPrefix = false) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-developer-'))
    const ctx = new Context()
    onTestFinished(async () => {
      try {
        await ctx.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: coordinates },
      { type: 'system/message', surfaceOp: 'append', data: {
        ...coordinates, message: { id: 'system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'System' }] },
      } },
      { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{ name: 'search', description: 'Historical', parameters: {} }] } } },
      event,
    ].map((row, seq) => ({ ...row, seq, time: seq + 1 }))
    const header = { type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1, delegationDepth: 0, isSeeded: false }
    const lines = [header, ...events].map(value => JSON.stringify(value) + '\n')
    if (corruptPrefix) lines.splice(-1, 0, '{invalid json}\n')
    const bytes = compression === 'none' ? Buffer.from(lines.join('')) : Buffer.concat(await Promise.all(lines.map(compressZstdFrame)))
    const path = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, compression)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    return { ctx, path, bytes, events }
  }

  it.each([false, true])('preserves an empty developer node and additional metadata on a valid open step (ignorable: %s)', async (ignorable) => {
    const { ctx, path, bytes, events } = await stored({ ...developer, ...(ignorable ? { ignorable: true } : {}) })
    const handle = await ctx.sessionPersistence.open(id, access)
    try {
      expect((await handle.read()).events).toEqual(events)
    } finally {
      await handle.close()
    }
    expect(await readFile(path)).toEqual(bytes)
  })


  it('reads name-only additions bound to their historical header without copying definitions', async () => {
    const event = { ...developer, data: { ...developer.data, headerSeq: 3, message: {
      ...developer.data.message, content: [{ type: 'tool-removal', toolName: 'old' }, { type: 'tool-addition', toolName: 'search' }],
    } } }
    const { ctx, path, bytes, events } = await stored(event)
    const handle = await ctx.sessionPersistence.open(id, access)
    try {
      expect((await handle.read()).events).toEqual(events)
    } finally {
      await handle.close()
    }
    expect(await readFile(path)).toEqual(bytes)
  })

  it.each([
    { headerSeq: 0, toolName: 'search', error: /earlier request\/header/ },
    { headerSeq: 4, toolName: 'search', error: /must name an earlier event/ },
    { headerSeq: 3, toolName: 'absent', error: /exactly one tool/ },
  ])('refuses invalid historical schema binding %# without rewriting the generation', async ({ headerSeq, toolName, error }) => {
    const event = { ...developer, data: { ...developer.data, headerSeq, message: {
      ...developer.data.message, content: [{ type: 'tool-addition', toolName }],
    } } }
    const { ctx, path, bytes } = await stored(event)
    const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => { await handle.close() })
    await expect(opened).rejects.toThrow(error)
    expect(await readFile(path)).toEqual(bytes)
  })

  it('refuses malformed known ignorable developer data even after a corrupt row', async () => {
    const invalid = { ...developer, ignorable: true, data: { ...developer.data, message: {
      ...developer.data.message, content: [{ type: 'tool-addition', toolName: 'search', tool: null }],
    } } }
    const { ctx, path, bytes } = await stored(invalid, true)
    const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => { await handle.close() })
    await expect(opened).rejects.toThrow('omit inline tool definitions')
    expect(await readFile(path)).toEqual(bytes)
  })

  it.each([
    { name: 'mismatched step', event: { ...developer, data: { ...developer.data, step: 2 } }, error: /open.*step/ },
    { name: 'protected system head', event: {
      ...developer, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2],
    }, error: /protected system head/ },
  ])('refuses a developer event with $name without rewriting the generation', async ({ event, error }) => {
    const { ctx, path, bytes } = await stored(event)
    const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => { await handle.close() })
    await expect(opened).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    await expect(opened).rejects.toThrow(error)
    expect(await readFile(path)).toEqual(bytes)
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock')).toHaveLength(1)
  })
})

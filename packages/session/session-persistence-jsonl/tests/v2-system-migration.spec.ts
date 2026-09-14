import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const id = SessionId('v2-system-migration')
const config = { provider: 'mock', model: 'mock' }
let root: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-v2-system-migration-'))
})

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

function request(system?: string) {
  return {
    type: 'request/header',
    data: { header: { config, ...(system === undefined ? {} : { system }) }, reason: 'change' },
  }
}

function user(text: string) {
  return {
    type: 'user/message', surfaceOp: 'append',
    data: { id: text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

async function writeV2(rows: readonly object[], seeded = false): Promise<string> {
  const path = generationLogPath(root, undefined, id, 2, 'none')
  await mkdir(dirname(path), { recursive: true })
  const header = {
    type: 'session', version: 2, id, createdAt: 1, isSeeded: seeded, delegationDepth: 0,
    ...(seeded ? { parentSession: 'parent' } : {}),
  }
  await writeFile(path, [header, ...rows.map((row, seq) => ({ ...row, seq, time: seq + 10 }))]
    .map(row => JSON.stringify(row)).join('\n') + '\n')
  return path
}

async function observeFile(path: string) {
  const identity = await stat(path, { bigint: true })
  return {
    bytes: await readFile(path), dev: identity.dev, ino: identity.ino,
    size: identity.size, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs,
  }
}

async function restore(handle: SessionHandle): Promise<Session> {
  const read = await handle.read()
  return Session.fromRestore(id, read.events, handle.header, handle.inheritedEventCount, read.eventState)
}

function messages(session: Session) {
  return session.deriveMessages().map(({ role, content }) => ({ role, content }))
}

function prompt(text: string) {
  return { role: 'system', content: [{ type: 'text', text }] }
}
const human = { role: 'user', content: [{ type: 'text' as const, text: 'question' }] }

function assertRequestHistory(events: readonly SessionEvent[], handle: SessionHandle) {
  const requests = events.filter(event => event.type === 'request/header')
  expect(requests).toHaveLength(3)
  const projected = requests.map((event) => {
    expect(event.data.header).toEqual({ config })
    const prefix = Session.fromRestore(id, events.slice(0, event.seq + 1), handle.header, SessionLogOffset(0), 'shared-frozen')
    return messages(prefix)
  })
  expect(projected).toEqual([[prompt('initial'), human], [prompt('changed'), human], [human]])
}

describe('V2 system prompts through current Session and JSONL persistence', () => {
  it.each([undefined, ''])('prepares prompts and clear (%j) read-only, then publishes V3 without replacing V2', async (clear) => {
    const sourcePath = await writeV2([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      user('question'), request('initial'), request('changed'), request(clear),
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const original = await observeFile(sourcePath)
    const directory = dirname(sourcePath)
    const directoryBefore = await readdir(directory)
    const ctx = await mount()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    let prepared: readonly SessionEvent[]
    try {
      expect(reader.header.version).toBe(3)
      prepared = (await reader.read()).events
      expect(prepared.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      expect(prepared.filter(event => event.type !== 'system/message').map(event => [event.type, event.time])).toEqual([
        ['turn/start', 10], ['step/start', 11], ['user/message', 12],
        ['request/header', 13], ['request/header', 14], ['request/header', 15],
        ['step/end', 16], ['turn/end', 17],
      ])
      expect(prepared.filter(event => event.type === 'system/message').map(event => ({
        seq: event.seq, content: event.data.message.content,
        surfaceOp: event.surfaceOp, sourceEventSeqs: event.sourceEventSeqs,
      }))).toEqual([
        { seq: 2, content: [], surfaceOp: 'append', sourceEventSeqs: undefined },
        { seq: 4, content: prompt('initial').content, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] },
        { seq: 6, content: prompt('changed').content, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] },
        { seq: 8, content: [], surfaceOp: { op: 'replace', startSeq: 6, endSeq: 6 }, sourceEventSeqs: [6] },
      ])
      assertRequestHistory(prepared, reader)
      const session = await restore(reader)
      expect(messages(session)).toEqual([human])
      expect(session.surface.nodes).toEqual([8, 3])
      expect(session.eventAt(SessionSeq(8))?.type).toBe('system/message')
    } finally {
      await reader.close()
    }
    expect(await observeFile(sourcePath)).toEqual(original)
    expect(await readdir(directory)).toEqual(directoryBefore)
    const independent = await mount()
    const independentReader = await independent.sessionPersistence.open(id, 'read')
    try {
      expect((await independentReader.read()).events).toEqual(prepared)
      await independent.sessionPersistence.flush()
    } finally {
      await independentReader.close()
    }
    expect(await observeFile(sourcePath)).toEqual(original)
    expect(await readdir(directory)).toEqual(directoryBefore)

    const writer = await ctx.sessionPersistence.open(id, 'write')
    try {
      expect((await writer.read()).events).toEqual(prepared)
    } finally {
      await writer.close()
    }
    expect(await observeFile(sourcePath)).toEqual(original)
    expect((await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort())
      .toEqual(['session.v2.jsonl', 'session.v3.jsonl'])
    const publishedPath = generationLogPath(root, undefined, id, 3, 'none')
    const published = (await readFile(publishedPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as unknown)
    expect(published[0]).toMatchObject({ type: 'session', version: 3, id })
    expect(published.slice(1)).toEqual(prepared)

    const reopened = await mount()
    const reopenedReader = await reopened.sessionPersistence.open(id, 'read')
    try {
      expect((await reopenedReader.read()).events).toEqual(prepared)
      assertRequestHistory(prepared, reopenedReader)
      const session = await restore(reopenedReader)
      expect(messages(session)).toEqual([human])
      expect(session.surface.nodes).toEqual([8, 3])
    } finally {
      await reopenedReader.close()
    }
    expect(await observeFile(sourcePath)).toEqual(original)
  })

  it('remaps local references and keeps the inherited cut stable through publication and a current Session append', async () => {
    const sourcePath = await writeV2([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      user('a'), request('seed prompt'), user('b'),
      { type: 'compaction/prune', data: { shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 4], shadowedTokenCount: 20 } },
      { ...user('summary'), surfaceOp: { op: 'replace', start: 2, end: 4 }, sourceEventSeqs: [2, 4] },
      { type: 'command/run', data: { commandId: 'command', name: 'test', source: { kind: 'user' } } },
      { type: 'command/done', data: { commandId: 'command', kind: 'success', sourceEventSeq: 6 } },
      { type: 'session/title', data: { title: 'title', messageSeqs: [2, 4], source: { kind: 'fallback' } } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'session/end-seed', data: { inherited: true } },
    ], true)
    const original = await observeFile(sourcePath)
    const ctx = await mount()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    let prepared: readonly SessionEvent[]
    try {
      prepared = (await reader.read()).events
      expect(reader.inheritedEventCount).toBe(14)
      expect(prepared[7]).toMatchObject({ type: 'compaction/prune', data: { shadowedRange: { start: 3, end: 6 }, shadowedSeqs: [3, 6] } })
      expect(prepared[8]).toMatchObject({ type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 6 }, sourceEventSeqs: [3, 6] })
      expect(prepared[10]).toMatchObject({ type: 'command/done', data: { sourceEventSeq: 8 } })
      expect(prepared[11]).toMatchObject({ type: 'session/title', data: { messageSeqs: [3, 6] } })
      expect(prepared[14]).toMatchObject({ type: 'session/end-seed', seq: 14, data: { inherited: true } })
      const session = await restore(reader)
      expect(session.inheritedEventCount).toBe(14)
      expect(session.firstLiveSeq).toBe(15)
      expect(session.surface.nodes).toEqual([4, 8])
      expect(messages(session)).toEqual([prompt('seed prompt'), { role: 'user', content: [{ type: 'text', text: 'summary' }] }])
      expect(session.ownEvents()).toEqual([prepared[14]])
    } finally {
      await reader.close()
    }
    expect(await observeFile(sourcePath)).toEqual(original)
    expect(await readdir(dirname(sourcePath))).toEqual(['session.v2.jsonl'])

    const writer = await ctx.sessionPersistence.open(id, 'write')
    let expected: readonly SessionEvent[]
    try {
      expect((await writer.read()).events).toEqual(prepared)
      const session = await restore(writer)
      session.append('turn/start', { turn: 2 })
      session.append('step/start', { turn: 2, step: 1 })
      session.append('system/message', {
        turn: 2, step: 1,
        message: freezeMessage({ role: 'system', id: MessageId('resumed-system'), content: [{ type: 'text', text: 'resumed prompt' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }),
      }, { surfaceOp: { op: 'replace', startSeq: SessionSeq(4), endSeq: SessionSeq(4) }, sourceEventSeqs: [SessionSeq(4)] })
      session.append('step/end', { turn: 2, step: 1 })
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      expected = session.snapshotEvents()
      await writer.append(session.snapshotEvents(session.firstLiveSeq))
      await writer.flush()
    } finally {
      await writer.close()
    }
    const reopened = await mount()
    const reopenedReader = await reopened.sessionPersistence.open(id, 'read')
    try {
      expect((await reopenedReader.read()).events).toEqual(expected)
      expect(reopenedReader.inheritedEventCount).toBe(14)
      const session = await restore(reopenedReader)
      expect(session.inheritedEventCount).toBe(14)
      expect(session.isOwnSeq(SessionSeq(13))).toBe(false)
      expect(session.isOwnSeq(SessionSeq(14))).toBe(true)
      expect(session.surface.nodes).toEqual([17, 8])
      expect(messages(session)).toEqual([prompt('resumed prompt'), { role: 'user', content: [{ type: 'text', text: 'summary' }] }])
    } finally {
      await reopenedReader.close()
    }
    expect(await observeFile(sourcePath)).toEqual(original)
  })

  it.each(['read', 'write'] as const)('refuses unsupported pre-step V2 during %s open without falling back to V1', async (access) => {
    const sourcePath = await writeV2([
      { type: 'turn/start', data: { turn: 1 } }, user('too early'),
      { type: 'step/start', data: { turn: 1, step: 1 } }, request('cannot reorder'),
    ])
    const lowerPath = generationLogPath(root, undefined, id, 1, 'none')
    await writeFile(lowerPath, JSON.stringify({ type: 'session', version: 1, id, createdAt: 1, delegationDepth: 0 }) + '\n')
    const original = await observeFile(sourcePath)
    const lower = await observeFile(lowerPath)
    const ctx = await mount()
    await expect(ctx.sessionPersistence.open(id, access)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    await expect(ctx.sessionPersistence.open(id, access)).rejects.toThrow(/before first step/)
    expect(await observeFile(sourcePath)).toEqual(original)
    expect(await observeFile(lowerPath)).toEqual(lower)
    expect((await readdir(dirname(sourcePath))).filter(name => name !== 'session.lock').sort())
      .toEqual(['session.v1.jsonl', 'session.v2.jsonl'])
  })

  it('persists native V3 system appends after the protected head without converting them to user messages', async () => {
    const ctx = await mount()
    const session = Session.create(id)
    const writer = await ctx.sessionPersistence.create(session.header)
    try {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('system/message', {
        turn: 1, step: 1,
        message: freezeMessage({ role: 'system', id: MessageId('head'), content: [{ type: 'text', text: 'head prompt' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }),
      }, { surfaceOp: 'append' })
      session.append('user/message', freezeMessage({ role: 'user', id: MessageId('question'), content: human.content, source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('system/message', {
        turn: 1, step: 1,
        message: freezeMessage({ role: 'system', id: MessageId('context'), content: [{ type: 'text', text: 'tail context' }], source: { kind: 'plugin', plugin: 'context-plugin' } }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await writer.append(session.snapshotEvents())
      await writer.flush()
    } finally {
      await writer.close()
    }
    const reopened = await mount()
    const reader = await reopened.sessionPersistence.open(id, 'read')
    try {
      expect((await reader.read()).events).toEqual(session.snapshotEvents())
      const restored = await restore(reader)
      expect(restored.surface.nodes).toEqual([2, 3, 4])
      expect(messages(restored)).toEqual([prompt('head prompt'), human, prompt('tail context')])
      expect(restored.deriveMessages().map(message => message.id)).toEqual(['head', 'question', 'context'])
    } finally {
      await reader.close()
    }
  })
})

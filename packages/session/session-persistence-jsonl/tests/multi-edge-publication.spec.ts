/** Durable composition of historical chunk collapse and V3 system/reference migration. */

import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import {
  assertReleasedV2Header, RELEASED_V2_EVENT_TYPES, releasedV2SessionFormatCodec,
  restoreReleasedV2Artifact, sessionFormatV1ToV2,
} from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { scheduler } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonlGenerationSourceChangedError } from '../src/generation.ts'
import { generationLogPath, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'

const id = SessionId('multi-edge-seeded')
const config = { provider: 'mock', model: 'mock' }
const roots: string[] = []
const contexts: Context[] = []
const v2EventTypes = new Set(RELEASED_V2_EVENT_TYPES)
const v2Catalog = createSessionFormatCatalog({
  currentVersion: 2,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec],
  currentEncoder: releasedV2SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2],
  restoreCurrent: artifact => restoreReleasedV2Artifact(artifact, v2EventTypes),
  restoreTransformedCurrent: artifact => restoreReleasedV2Artifact(artifact, v2EventTypes),
  restoreCurrentHeader(header) {
    assertReleasedV2Header(header)
    return header
  },
})

afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

function message(role: 'user' | 'assistant', text: string) {
  return {
    id: text, role, content: [{ type: 'text', text }],
    source: role === 'user' ? { kind: 'user' } : { kind: 'model', ...config },
  }
}

function event(type: string, seq: number, data: object) {
  return { type, seq, time: 100 + seq, data }
}

function request(seq: number, system: string) {
  return event('request/header', seq, { header: { config, system }, reason: 'change' })
}

/** Packed rows consume four chunk coordinates before the inherited Assistant message. */
function historicalRows() {
  return [
    event('turn/start', 0, { turn: 1 }),
    event('step/start', 1, { turn: 1, step: 1 }),
    { ...event('user/message', 2, message('user', 'question')), surfaceOp: 'append' },
    request(3, 'seed prompt'),
    { type: 'text-chunks', seq0: 4, time0: 104, data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['he', 'l', 'lo'] } },
    event('assistant/chunk', 7, { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }),
    { ...event('assistant/message', 8, { turn: 1, step: 1, message: message('assistant', 'hello') }), surfaceOp: 'append', sourceEventSeqs: [[4, 7]] },
    event('step/end', 9, { turn: 1, step: 1 }),
    event('turn/end', 10, { turn: 1, reason: { kind: 'completed' } }),
    event('session/end-seed', 11, {}),
    event('turn/start', 12, { turn: 2 }),
    event('step/start', 13, { turn: 2, step: 1 }),
    { ...event('user/message', 14, message('user', 'follow-up')), surfaceOp: 'append' },
    request(15, 'changed prompt'),
    event('compaction/prune', 16, { shadowedRange: { start: 2, end: 8 }, shadowedSeqs: [2, 8], shadowedTokenCount: 20 }),
    { ...event('user/message', 17, message('user', 'summary')), surfaceOp: { op: 'replace', start: 2, end: 8 }, sourceEventSeqs: [2, 8] },
    event('command/run', 18, { commandId: 'command', name: 'test', source: { kind: 'user' } }),
    event('command/done', 19, { commandId: 'command', kind: 'success', sourceEventSeq: 17 }),
    event('session/title', 20, { title: 'title', messageSeqs: [2, 14], source: { kind: 'fallback' } }),
    request(21, 'changed prompt'),
    event('step/end', 22, { turn: 2, step: 1 }),
    event('turn/end', 23, { turn: 2, reason: { kind: 'completed' } }),
  ]
}

async function mount(root: string, compression: JsonlCompression) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
}

async function seed(version: 0 | 1, compression: JsonlCompression, refuse = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-multi-edge-publication-'))
  roots.push(root)
  const path = generationLogPath(root, undefined, id, version, compression)
  await mkdir(dirname(path), { recursive: true })
  const header = { type: 'session', version, id, createdAt: 1, parentSession: 'parent', delegationDepth: 0, seedLength: 11 }
  const rows = refuse ? [...historicalRows().slice(0, -1), request(23, 'outside step')] : historicalRows()
  const headerLine = JSON.stringify(header) + '\n'
  const body = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  const bytes = compression === 'none' ? Buffer.from(headerLine + body) : Buffer.concat([
    await compressZstdFrame(headerLine), await compressZstdFrame(body),
  ])
  await writeFile(path, bytes)
  return { root, path, header, rows }
}

async function observe(path: string) {
  const identity = await stat(path, { bigint: true })
  return {
    bytes: await readFile(path), dev: identity.dev, ino: identity.ino,
    size: identity.size, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs,
  }
}

async function readSession(ctx: Context, access: 'read' | 'write') {
  const handle = await ctx.sessionPersistence.open(id, access)
  try {
    const result = await handle.read()
    const session = Session.fromRestore(id, result.events, handle.header, handle.inheritedEventCount, result.eventState)
    if (access === 'write') await handle.flush()
    return { header: handle.header, events: result.events, cut: handle.inheritedEventCount, session }
  } finally {
    await handle.close()
  }
}

function visible(role: 'system' | 'user' | 'assistant', text: string) {
  return { role, content: [{ type: 'text', text }] }
}

function assertRequests(events: readonly SessionEvent[], header: SessionHeader) {
  const requests = events.filter(event => event.type === 'request/header')
  expect(requests.map(event => event.data.header)).toEqual([{ config }, { config }, { config }])
  expect(requests.map(event => Session.fromRestore(
    id, events.slice(0, event.seq + 1), header, SessionLogOffset(0), 'shared-frozen',
  ).deriveMessages().map(({ role, content }) => ({ role, content })))).toEqual([
    [visible('system', 'seed prompt'), visible('user', 'question')],
    [visible('system', 'changed prompt'), visible('user', 'question'), visible('assistant', 'hello'), visible('user', 'follow-up')],
    [visible('system', 'changed prompt'), visible('user', 'summary'), visible('user', 'follow-up')],
  ])
}

function assertMigrated(result: Awaited<ReturnType<typeof readSession>>) {
  const { events, header, cut, session } = result
  expect(header).toEqual({ version: 3, id, createdAt: 1, parentSession: 'parent', delegationDepth: 0, isSeeded: true })
  expect(events.map(event => event.seq)).toEqual(Array.from({ length: 23 }, (_, seq) => seq))
  expect(events.filter(event => event.type.startsWith('assistant/'))).toEqual([{
    type: 'assistant/message', seq: 6, time: 108, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: message('assistant', 'hello'), stream: [
      { type: 'text-chunks', time0: 104, index: 0, dt: [1, 1], texts: ['he', 'l', 'lo'] },
      { type: 'chunk', time: 107, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ] },
  }])
  expect(events.filter(event => event.type === 'system/message').map(event => ({
    seq: event.seq, content: event.data.message.content, surfaceOp: event.surfaceOp, sourceEventSeqs: event.sourceEventSeqs,
  }))).toEqual([
    { seq: 2, content: [], surfaceOp: 'append', sourceEventSeqs: undefined },
    { seq: 4, content: visible('system', 'seed prompt').content, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] },
    { seq: 13, content: visible('system', 'changed prompt').content, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4] },
  ])
  expect(events[15]).toMatchObject({ type: 'compaction/prune', data: { shadowedRange: { start: 3, end: 6 }, shadowedSeqs: [3, 6] } })
  expect(events[16]).toMatchObject({ type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 6 }, sourceEventSeqs: [3, 6] })
  expect(events[18]).toMatchObject({ type: 'command/done', data: { sourceEventSeq: 16 } })
  expect(events[19]).toMatchObject({ type: 'session/title', data: { messageSeqs: [3, 12] } })
  expect(cut).toBe(9)
  expect(events[9]).toEqual({ type: 'session/end-seed', seq: 9, time: 111, data: { inherited: true } })
  expect(session.inheritedEventCount).toBe(9)
  expect(session.firstLiveSeq).toBe(23)
  expect(session.isOwnSeq(SessionSeq(8))).toBe(false)
  expect(session.isOwnSeq(SessionSeq(9))).toBe(true)
  expect(session.ownEvents()).toEqual([
    ...events.slice(9),
    expect.objectContaining({ type: 'session/end-seed', seq: 23, data: {} }),
  ])
  expect(session.surface.nodes).toEqual([13, 16, 12])
  expect(session.deriveMessages().map(({ role, content }) => ({ role, content }))).toEqual([
    visible('system', 'changed prompt'), visible('user', 'summary'), visible('user', 'follow-up'),
  ])
  assertRequests(events, header)
}

async function publishedRows(path: string, compression: JsonlCompression) {
  const bytes = await readFile(path)
  let plaintext = bytes
  if (compression === 'zstd') {
    const { frames, tornStart } = scanZstdFrames(bytes)
    expect(tornStart).toBeUndefined()
    expect(frames.length).toBeGreaterThan(0)
    plaintext = Buffer.concat(await Promise.all(frames.map(frame => decompressZstdFrame(bytes.subarray(frame.start, frame.end)))))
  }
  return plaintext.toString('utf8').trimEnd().split('\n').map((line): unknown => JSON.parse(line))
}

describe.each([0, 1] as const)('V%s multi-edge durable publication', (version) => {
  it.each(['none', 'zstd'] as const)('publishes only V3 after chunk collapse, system changes, and reference remapping (%s)', async (compression) => {
    const { root, path } = await seed(version, compression)
    const source = await observe(path)
    const ctx = await mount(root, compression)
    const prepared = await readSession(ctx, 'read')
    assertMigrated(prepared)
    await ctx.sessionPersistence.flush()
    expect(await observe(path)).toEqual(source)
    expect(await readdir(dirname(path))).toEqual([basename(path)])

    const written = await readSession(ctx, 'write')
    assertMigrated(written)
    expect(written.events).toEqual(prepared.events)
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const successor = generationLogPath(root, undefined, id, 3, compression)
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock').sort())
      .toEqual([basename(path), basename(successor)].sort())
    expect(await publishedRows(successor, compression)).toEqual([{ type: 'session', ...prepared.header }, ...prepared.events])
    expect(await observe(path)).toEqual(source)
    const published = await observe(successor)

    const reopened = await mount(root, compression)
    const native = await readSession(reopened, 'read')
    assertMigrated(native)
    expect(native.events).toEqual(prepared.events)
    expect(native.cut).toBe(prepared.cut)
    const repeated = await readSession(reopened, 'write')
    expect(repeated.events).toEqual(prepared.events)
    expect(repeated.cut).toBe(prepared.cut)
    await reopened.sessionPersistence.flush()
    expect(await observe(path)).toEqual(source)
    expect(await observe(successor)).toEqual(published)
  })

  it.each(['none', 'zstd'] as const)('re-prepares populated history after source drift rejects stale publication (%s)', async (compression) => {
    const { root, path } = await seed(version, compression)
    const source = await observe(path)
    const ctx = await mount(root, compression)
    const prepared = await readSession(ctx, 'read')
    assertMigrated(prepared)
    const tail = event('feedback/record', 24, { text: 'arrived after preparation' })
    const line = JSON.stringify(tail) + '\n'
    const appended = compression === 'none' ? Buffer.from(line) : await compressZstdFrame(line)
    const yieldSpy = vi.spyOn(scheduler, 'yield').mockImplementationOnce(async () => {
      await appendFile(path, appended)
    })
    try {
      await expect(readSession(ctx, 'write')).rejects.toBeInstanceOf(JsonlGenerationSourceChangedError)
      expect(yieldSpy).toHaveBeenCalled()
    } finally {
      yieldSpy.mockRestore()
    }
    const changed = await observe(path)
    expect(changed.bytes).toEqual(Buffer.concat([source.bytes, appended]))
    expect(changed).toMatchObject({ dev: source.dev, ino: source.ino })
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock')).toEqual([basename(path)])

    const retried = await readSession(ctx, 'write')
    const expected = [...prepared.events, { ...tail, seq: 23 }]
    expect(retried.events).toEqual(expected)
    expect(retried.cut).toBe(prepared.cut)
    assertRequests(retried.events, retried.header)
    const successor = generationLogPath(root, undefined, id, 3, compression)
    expect(await publishedRows(successor, compression)).toEqual([{ type: 'session', ...prepared.header }, ...expected])
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock').sort())
      .toEqual([basename(path), basename(successor)].sort())
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const reopened = await mount(root, compression)
    const native = await readSession(reopened, 'read')
    expect(native.events).toEqual(expected)
    expect(native.cut).toBe(prepared.cut)
    assertRequests(native.events, native.header)
    expect(await observe(path)).toEqual(changed)
  })

  it.each(['none', 'zstd'] as const)('refuses a late V3 prompt outside a step without publishing earlier edges (%s)', async (compression) => {
    const { root, path, header, rows } = await seed(version, compression, true)
    const restoreV2 = v2Catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of rows) restoreV2.decodeRow(row)
    const validV2 = restoreV2.finish()
    expect(validV2.inheritedEventCount).toBe(7)
    expect(validV2.events.slice(-2)).toEqual([
      { ...event('step/end', 22, { turn: 2, step: 1 }), seq: 18 },
      { ...request(23, 'outside step'), seq: 19 },
    ])
    const source = await observe(path)
    const ctx = await mount(root, compression)
    for (const access of ['read', 'write', 'read', 'write'] as const) {
      const failure = readSession(ctx, access)
      await expect(failure).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
      await expect(failure).rejects.toThrow(/outside an open step/)
      await ctx.sessionPersistence.flush()
      expect(await observe(path)).toEqual(source)
      expect((await readdir(dirname(path))).filter(name => name !== 'session.lock')).toEqual([basename(path)])
    }
  })
})

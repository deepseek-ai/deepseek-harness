/** V2 content admission refuses entire generations without publishing a valid prefix. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath, scanLog, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'

const id = SessionId('content-admission')
const text = { type: 'text', text: 'Keep tool/code-dispatch and tools-code-mode literal. 图片' }
const unknown = { type: 'future-block', seq: 2, text: 'Do not discard this content.' }
const prefix: readonly (SessionFormatJsonObject & { readonly type: string })[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'user/message', surfaceOp: 'append', data: {
    id: 'question', role: 'user', source: { kind: 'user' }, content: [text],
  } },
]

interface Carrier {
  readonly name: string
  readonly path: string
  rows(block: SessionFormatJsonObject): readonly (SessionFormatJsonObject & { readonly type: string })[]
  readonly targetType?: string
  readonly targetData?: SessionFormatJsonObject
}

const compaction = {
  compactionId: 'compact-1', summary: [text], rawOutput: [text], llmStreamCall: true,
  shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 7,
  provider: 'historical', model: 'historical-model',
}
const toolCall = { type: 'tool-call', id: 'root-call', name: 'run_code', arguments: '{"code":"return tools.read({})"}' }
const dispatch = {
  rootCallId: toolCall.id, parentCallId: toolCall.id, subCallId: 'read-call',
  name: 'read', arguments: { file_path: 'audit.txt', opaque: { type: 'future-block', seq: 2 } },
}

function assistantRow(type: 'assistant/message' | 'assistant/attempt', stream: readonly SessionFormatJsonObject[]): SessionFormatJsonObject & { readonly type: string } {
  return {
    type, ...(type === 'assistant/message' ? { surfaceOp: 'append' } : {}),
    data: {
      turn: 1, step: 1, stream,
      ...(type === 'assistant/message' ? { message: {
        id: 'answer', role: 'assistant', content: [text],
        source: { kind: 'model', provider: 'historical', model: 'historical-model' },
      } } : {}),
    },
  }
}

const carriers: readonly Carrier[] = [{
  name: 'team queued message', path: 'data.message.content[0]',
  rows: block => [...prefix, { type: 'team/message/queued', data: {
    version: 1, teamId: 'team-1', message: {
      id: 'queued-1', senderId: 'lead', senderName: 'lead', targetId: 'worker',
      delivery: 'quiet', content: [block],
    },
  } }],
}, ...(['summary', 'rawOutput'] as const).map((field): Carrier => ({
  name: 'compaction ' + field, path: 'data.' + field + '[0]',
  rows: block => [
    ...prefix,
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'compaction/start', data: { compactionId: 'compact-1', turn: 1 } },
    { type: 'compaction/summary', data: { ...compaction, [field]: [block] } },
  ],
  targetData: { ...compaction, shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3] },
})), {
  name: 'PTC dispatch content', path: 'data.content[0]', targetType: 'tool/ptc-dispatch',
  rows: block => [
    ...prefix,
    { type: 'assistant/message', surfaceOp: 'append', data: {
      turn: 1, step: 1, message: {
        id: 'calling-assistant', role: 'assistant', content: [toolCall],
        source: { kind: 'model', provider: 'historical', model: 'historical-model' },
      },
      stream: [
        { type: 'tool-call-chunks', time0: 1003, index: 0, id: toolCall.id,
          name: toolCall.name, dt: [], args: [toolCall.arguments] },
        { type: 'chunk', time: 1004, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
      ],
    } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: toolCall.id, name: toolCall.name, arguments: toolCall.arguments } },
    { type: 'tool/code-dispatch-start', data: dispatch },
    { type: 'tool/code-dispatch', data: { ...dispatch, isError: false, content: [block] } },
  ],
}, ...(['assistant/message', 'assistant/attempt'] as const).flatMap(type =>
  (['block-start', 'block-end'] as const).map((chunkType): Carrier => ({
    name: type + ' ' + chunkType,
    path: chunkType === 'block-start' ? 'data.stream[0].chunk.blockType' : 'data.stream[2].chunk.block',
    rows: block => [...prefix, assistantRow(type, [
      { type: 'chunk', time: 1001, chunk: {
        type: 'block-start', index: 0, blockType: chunkType === 'block-start' ? block['type']! : 'text',
      } },
      { type: 'text-chunks', time0: 1002, index: 0, dt: [], texts: [text.text] },
      { type: 'chunk', time: 1003, chunk: {
        type: 'block-end', index: 0, block: chunkType === 'block-end' ? block : text,
      } },
      { type: 'chunk', time: 1004, chunk: { type: 'finish', reason: type === 'assistant/message'
        ? { kind: 'stop' } : { kind: 'error', failure: { message: 'provider ended the attempt', code: 'SERVER' } },
      } },
    ])],
  }))),
]

let root: string | undefined
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-content-admission-'))
})

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

async function mount(compression: JsonlCompression): Promise<Context> {
  if (root === undefined) throw new Error('persistence fixture is not initialized')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
}

function line(value: unknown): string {
  return JSON.stringify(value) + '\n'
}

async function store(compression: JsonlCompression, rows: readonly SessionFormatJsonObject[]) {
  if (root === undefined) throw new Error('persistence fixture is not initialized')
  const path = generationLogPath(root, undefined, id, 2, compression)
  const events = rows.map((row, seq) => ({ ...row, seq, time: 1001 + seq }))
  const header = { type: 'session', version: 2, id, createdAt: 1000, isSeeded: false, delegationDepth: 0 }
  // The EOF carrier occupies a complete frame after a separately encoded valid prefix.
  const chunks = [line(header), events.slice(0, -1).map(line).join(''), line(events.at(-1))]
  const bytes = compression === 'none' ? Buffer.from(chunks.join(''))
    : Buffer.concat(await Promise.all(chunks.map(chunk => compressZstdFrame(chunk))))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return path
}

async function observe(path: string) {
  const identity = await stat(path, { bigint: true })
  return { bytes: await readFile(path), dev: identity.dev, ino: identity.ino, size: identity.size }
}

async function expectOnlyGenerations(paths: readonly string[]) {
  // A released write lease may leave session.lock, but no staged or published prefix may remain.
  expect((await readdir(dirname(paths[0]!))).filter(name => name !== 'session.lock').sort())
    .toEqual(paths.map(path => basename(path)).sort())
}

const modes = (['none', 'zstd'] as const).flatMap(compression =>
  (['read', 'write'] as const).map(access => ({ compression, access })),
)

describe.each(modes)('V2 content EOF refusal ($compression, $access)', ({ compression, access }) => {
  it.each(carriers)('refuses $name without source mutation or prefix publication', async (carrier) => {
    const rows = carrier.rows(unknown)
    const tail = rows.at(-1)!
    const path = await store(compression, rows)
    const original = await observe(path)
    const ctx = await mount(compression)
    const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => {
      try { await handle.read() } finally { await handle.close() }
    })
    await expect(opened).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    await expect(opened).rejects.toMatchObject({
      message: 'format v2 ' + tail['type'] + ' at seq ' + String(rows.length - 1) + ' '
        + carrier.path + ': cannot safely transform unclassified message content kind "future-block"'
        + '; source v2 artifact remains unchanged (raw log: ' + path + ')',
      location: { kind: 'jsonl', path },
    })
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])
  })
})

describe.each(['none', 'zstd'] as const)('V2 admitted content publication (%s)', (compression) => {
  it.each(carriers)('preserves $name on read, publication, and fresh reopen', async (carrier) => {
    const rows = carrier.rows(text)
    const tail = rows.at(-1)!
    const path = await store(compression, rows)
    const original = await observe(path)
    const ctx = await mount(compression)
    const reader = await ctx.sessionPersistence.open(id, 'read')
    const restored = await (async () => {
      try {
        expect(reader.header.version).toBe(3)
        return await reader.read()
      } finally { await reader.close() }
    })()
    expect(restored.events.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'system/message',
      ...rows.slice(2).map(row => row['type'] === 'tool/code-dispatch-start' ? 'tool/ptc-dispatch-start'
        : row['type'] === 'tool/code-dispatch' ? 'tool/ptc-dispatch' : row['type']),
    ])
    expect(restored.events.at(-1)).toMatchObject({
      type: carrier.targetType ?? tail['type'], seq: rows.length,
    })
    expect(restored.events.at(-1)?.data).toEqual(carrier.targetData ?? tail['data'])
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])

    const writer = await ctx.sessionPersistence.open(id, 'write')
    try {
      expect((await writer.read()).events).toEqual(restored.events)
      await writer.flush()
    } finally { await writer.close() }
    const successor = generationLogPath(root!, undefined, id, 3, compression)
    const published = await readFile(successor)
    let decoded = published
    if (compression === 'zstd') {
      const { frames, tornStart } = scanZstdFrames(published)
      expect(tornStart).toBeUndefined()
      decoded = Buffer.concat(await Promise.all(frames.map(frame =>
        decompressZstdFrame(published.subarray(frame.start, frame.end)),
      )))
    }
    expect(scanLog(decoded).events).toEqual(restored.events)
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path, successor])

    await ctx.fiber.dispose()
    const fresh = await mount(compression)
    const reopened = await fresh.sessionPersistence.open(id, 'read')
    try {
      expect(reopened.header.version).toBe(3)
      expect((await reopened.read()).events).toEqual(restored.events)
    } finally { await reopened.close() }
    expect(await observe(path)).toEqual(original)
    expect(await readFile(successor)).toEqual(published)
    await expectOnlyGenerations([path, successor])
  })
})

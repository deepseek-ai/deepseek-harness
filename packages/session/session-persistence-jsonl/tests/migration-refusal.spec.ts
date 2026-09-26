/** Durable EOF refusals preserve historical generations and never fall back from the selected generation. */

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalogWithChildren } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const id = SessionId('migration-refusal')
const config = { provider: 'historical', model: 'historical-model' }
const question = {
  id: 'question', role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: 'Read the saved migration audit.' }],
}
const dispatch = {
  rootCallId: 'root-call', parentCallId: 'root-call', subCallId: 'read-call',
  name: 'read', arguments: { file_path: 'migration-audit.txt' },
}
const prefix: readonly SessionFormatJsonObject[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'user/message', data: question, surfaceOp: 'append' },
  { type: 'request/header', data: { header: { config, system: 'Inspect the durable audit.' }, reason: 'initial' } },
]
/** Released V3 files still carry plugin attribution; current V4 files are producer-owned. */
const releasedPrefix: readonly SessionFormatJsonObject[] = [
  ...prefix.slice(0, 2),
  { type: 'system/message', surfaceOp: 'append', data: {
    turn: 1, step: 1, message: {
      id: 'native-system', role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      content: [{ type: 'text', text: 'Inspect the durable audit.' }],
    },
  } },
  { type: 'user/message', data: question, surfaceOp: 'append' },
  { type: 'request/header', data: { header: { config }, reason: 'initial' } },
]
const nativePrefix: readonly SessionFormatJsonObject[] = [
  ...prefix.slice(0, 2),
  { type: 'system/message', surfaceOp: 'append', data: {
    turn: 1, step: 1, message: {
      id: 'native-system', role: 'system', source: { kind: 'system-prompt' },
      content: [{ type: 'text', text: 'Inspect the durable audit.' }],
    },
  } },
  { type: 'user/message', data: question, surfaceOp: 'append' },
  { type: 'request/header', data: { header: { config }, reason: 'initial' } },
]


function checkpointSource(): SessionFormatJsonObject {
  const restore = createSessionFormatCatalogWithChildren([]).createRestore({
    type: 'session', version: 3, id: 'checkpoint-source', createdAt: 0, isSeeded: false, delegationDepth: 0,
  }, { recovery: 'strict', validation: 'current' })
  restore.decodeRow({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: {
    ...question, source: { kind: 'plugin', plugin: 'compact' },
  } })
  return (restore.finish().events[0]?.data as SessionFormatJsonObject)['source'] as SessionFormatJsonObject
}

function nativeCheckpoint(compactionId: string): readonly SessionFormatJsonObject[] {
  return [
    ...nativePrefix,
    { type: 'compaction/start', data: { compactionId: 'owner', turn: 1 } },
    { type: 'compaction/summary', data: {
      compactionId: 'owner', summary: [{ type: 'text', text: 'Summary' }], shadowedRange: { start: 3, end: 3 },
      shadowedSeqs: [3], shadowedTokenCount: 1, provider: config.provider, model: config.model,
    } },
    { type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3, 5, 6], data: {
      ...question, id: 'checkpoint', source: { ...checkpointSource(), compactionId },
    } },
    { type: 'compaction/end', data: { compactionId: 'owner', turn: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function releasedToolRows(
  messageFields: SessionFormatJsonObject = {}, wrapperFields: SessionFormatJsonObject = {},
): SessionFormatJsonObject[] {
  return [
    ...releasedPrefix,
    { type: 'assistant/message', surfaceOp: 'append', data: {
      turn: 1, step: 1, stream: [], message: {
        id: 'assistant', role: 'assistant', source: { kind: 'model', provider: config.provider, model: config.model },
        content: [{ type: 'tool-call', id: 'outer-call', name: 'example', arguments: '{}' }],
      },
    } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'outer-call', name: 'example', arguments: '{}' } },
    { type: 'tool/result', surfaceOp: 'append', data: {
      turn: 1, step: 1, message: {
        ...messageFields, id: 'result', role: 'user', source: { kind: 'tool', callId: 'outer-call' },
        content: [{ type: 'tool-result', toolCallId: 'outer-call', isError: false,
          content: [{ type: 'text', text: 'result' }], ...wrapperFields }],
      },
    } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function ptcRow(type: string): SessionFormatJsonObject {
  return { type, data: type.endsWith('-start') ? dispatch : {
    ...dispatch, isError: false, content: [{ type: 'text', text: 'Audit is intact.' }],
  } }
}

const migrationRefusals = [
  ...['tool/ptc-dispatch-start', 'tool/ptc-dispatch'].flatMap(type => [false, true].map(ignorable => ({
    name: type + (ignorable ? ' (ignorable)' : ' (required)'),
    tail: { ...ptcRow(type), ...(ignorable ? { ignorable: true } : {}) },
    diagnostic: 'format v2 to v3 cannot safely transform unclassified event ' + type,
  }))),
  {
    name: 'delivery activation claiming V3',
    tail: { type: 'session-log-deepseek/delivery-accepted', data: {
      sessionId: id, throughSeq: prefix.length - 1, sessionFormatVersion: 3,
    } },
    diagnostic: '@deepseek-ai/dsh-session-format-v2-to-v3 refuses this format v2 Session: format v2 delivery marker claims target format v3',
  },
  {
    name: 'source message colliding with the generated system ID',
    tail: { type: 'user/message', surfaceOp: 'append', data: {
      ...question,
      id: 'v2-to-v3-system-' + createHash('sha256')
        .update(JSON.stringify(['session-format-v2-to-v3', id, 1, 'step/start'])).digest('hex'),
    } },
    diagnostic: 'source message id collides with a generated system message id',
  },
] satisfies readonly { name: string; tail: SessionFormatJsonObject; diagnostic: string }[]

const nativeRefusals = [
  ...['tool/code-dispatch-start', 'tool/code-dispatch'].map(type => ({
    name: type,
    tail: ptcRow(type),
    diagnostic: 'format v3 contains unknown event type ' + JSON.stringify(type) + ' at seq ' + String(nativePrefix.length),
    currentError: 'unsupported' as const,
    currentSubject: type,
  })),
  {
    name: 'retired request/header.system',
    tail: { type: 'request/header', data: {
      header: { config, system: 'This prompt must not be discarded.' }, reason: 'change',
    } },
    diagnostic: 'format v3 request/header rejects retired header.system',
    currentError: 'corruption' as const,
    currentSubject: 'header.system',
  },
] satisfies readonly {
  name: string
  tail: SessionFormatJsonObject
  diagnostic: string
  currentError: 'unsupported' | 'corruption'
  currentSubject: string
}[]

const modes = (['none', 'zstd'] as const).flatMap(compression =>
  (['read', 'write'] as const).map(access => ({ compression, access })),
)

let root: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-migration-refusal-'))
})

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function mount(compression: JsonlCompression): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
}

function line(value: unknown): string {
  return JSON.stringify(value) + '\n'
}

async function store(
  version: 2 | 3 | typeof SESSION_FORMAT_VERSION,
  compression: JsonlCompression,
  rows: readonly SessionFormatJsonObject[],
) {
  const path = generationLogPath(root, undefined, id, version, compression)
  const header = { type: 'session', version, id, createdAt: 1000, isSeeded: false, delegationDepth: 0 }
  const events = rows.map((row, seq) => ({ ...row, seq, time: 1001 + seq }))
  // The offending EOF row occupies its own complete frame, not a torn compressed suffix.
  const chunks = [line(header), events.slice(0, -1).map(line).join(''), line(events.at(-1))]
  const bytes = compression === 'none' ? Buffer.from(chunks.join(''))
    : Buffer.concat(await Promise.all(chunks.map(chunk => compressZstdFrame(chunk))))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return path
}

async function observe(path: string) {
  const identity = await stat(path, { bigint: true })
  return {
    bytes: await readFile(path), dev: identity.dev, ino: identity.ino,
    size: identity.size, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs,
  }
}

async function expectRefusal(ctx: Context, access: 'read' | 'write', path: string, message: string) {
  // Close an unexpectedly successful open before the rejection assertion fails.
  const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => { await handle.close() })
  await expect(opened).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
  await expect(opened).rejects.toMatchObject({ message, location: { kind: 'jsonl', path } })
}

async function expectCurrentRefusal(
  ctx: Context,
  access: 'read' | 'write',
  path: string,
  kind: 'unsupported' | 'corruption',
  subject: string,
) {
  // Close an unexpectedly successful open before the rejection assertion fails.
  const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => { await handle.close() })
  const expected = kind === 'unsupported' ? SessionFormatUnsupportedError : SessionPersistenceCorruptionError
  await expect(opened).rejects.toBeInstanceOf(expected)
  await expect(opened).rejects.toThrow(subject)
  if (kind === 'unsupported') {
    await expect(opened).rejects.toMatchObject({ location: { kind: 'jsonl', path } })
  }
}

async function expectOnlyGenerations(paths: readonly string[]) {
  const directory = dirname(paths[0]!)
  // A released write lease keeps session.lock; every other extra entry is forbidden.
  expect((await readdir(directory)).filter(name => name !== 'session.lock').sort())
    .toEqual(paths.map(path => basename(path)).sort())
}

describe.each(modes)('EOF migration refusal ($compression, $access)', ({ compression, access }) => {
  async function expectV3Conversion(
    rows: readonly SessionFormatJsonObject[], inspect: (events: readonly SessionEvent[]) => void,
  ) {
    const path = await store(3, compression, rows)
    const original = await observe(path)
    for (const mode of [access, 'read'] as const) {
      const ctx = await mount(compression)
      const handle = await ctx.sessionPersistence.open(id, mode)
      try {
        expect(handle.header.version).toBe(SESSION_FORMAT_VERSION)
        const restored = await handle.read()
        expect(restored.events.map(event => ({ seq: event.seq, time: event.time })))
          .toEqual(rows.map((_, seq) => ({ seq, time: 1001 + seq })))
        inspect(restored.events)
      } finally {
        await handle.close()
      }
    }
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations(access === 'read' ? [path] : [path, generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, compression)])
  }

  it.each(migrationRefusals)('refuses V2 $name without publishing or discarding a tail', async ({ tail, diagnostic }) => {
    const path = await store(2, compression, [...prefix, tail])
    const original = await observe(path)
    const message = diagnostic + '; source v2 artifact remains unchanged (raw log: ' + path + ')'
    const ctx = await mount(compression)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectRefusal(ctx, access, path, message)
      expect(await observe(path)).toEqual(original)
      await expectOnlyGenerations([path])
      for (const targetCompression of ['none', 'zstd'] as const) {
        for (const targetVersion of [3, SESSION_FORMAT_VERSION]) {
          await expect(stat(generationLogPath(root, undefined, id, targetVersion, targetCompression)))
            .rejects.toMatchObject({ code: 'ENOENT' })
        }
      }
    }
  })

  it('refuses a V3 watermark claiming V4 without publishing a successor', async () => {
    const marker = { type: 'session-log-deepseek/delivery-accepted', data: {
      sessionId: id, throughSeq: 0, sessionFormatVersion: 4,
    } }
    const path = await store(3, compression, [...releasedPrefix, marker])
    const original = await observe(path)
    const ctx = await mount(compression)
    await expectRefusal(ctx, access, path,
      'format v3 delivery marker claims target format v4; source v3 artifact remains unchanged (raw log: ' + path + ')')
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])
  })

  it.each(['developer/message', 'external/required'])('refuses invalid required V3 %s before publishing', async (type) => {
    const row = { type, surfaceOp: 'append', data: {
      turn: 1, step: 1, message: {
        id: 'invalid-v3', role: 'developer', source: { kind: 'tool-registry' }, content: [],
      },
    } }
    const path = await store(3, compression, [...releasedPrefix, row])
    const original = await observe(path)
    const ctx = await mount(compression)
    await expectRefusal(ctx, access, path,
      `format v3 contains unknown event type ${JSON.stringify(type)} at seq ${releasedPrefix.length}`
      + '; source v3 artifact remains unchanged (raw log: ' + path + ')')
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])
  })

  it.each([5, 99])('retains a V3 watermark claiming V%s unchanged through native reopening', async (sessionFormatVersion) => {
    const marker = { type: 'session-log-deepseek/delivery-accepted', data: {
      sessionId: id, throughSeq: 0, sessionFormatVersion,
    } }
    await expectV3Conversion([...releasedPrefix, marker], (events) => {
      expect(events).toEqual([...nativePrefix, marker].map((row, seq) => ({ ...row, seq, time: 1001 + seq })))
    })
  })

  it.each([false, true])('refuses own V3 tool-definition deferLoading=%s without publishing a successor', async (deferLoading) => {
    const tool = { name: 'example', description: 'Saved tool definition.', parameters: { type: 'object' }, deferLoading }
    const request = { type: 'request/header', data: { header: { config, tools: [tool] }, reason: 'change' } }
    const path = await store(3, compression, [...releasedPrefix, request])
    const original = await observe(path)
    const ctx = await mount(compression)
    await expectRefusal(ctx, access, path,
      `format v3 request/header at seq ${releasedPrefix.length}.header.tools[0] contains deferLoading, which is only defined in V4`
      + '; source v3 artifact remains unchanged (raw log: ' + path + ')')
    await ctx.sessionPersistence.flush()
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])
  })

  it('preserves ordinary V3 tool-definition extension fields unchanged', async () => {
    const parameters = {
      type: 'object', properties: { deferLoading: { type: 'boolean' } }, deferLoading: true,
      default: { type: 'tool-result', toolCallId: 'opaque-call', content: [{ type: 'text', text: 'schema data' }] },
    }
    const fields = JSON.parse('{"metadata":{"saved":"original metadata"},"__proto__":{"saved":"prototype"},"constructor":{"saved":"constructor"},"plugin:deferLoading":true}') as SessionFormatJsonObject
    const tool = { name: 'example', description: 'Saved tool definition.', parameters, ...fields }
    const request = { type: 'request/header', data: { header: { config, tools: [tool] }, reason: 'initial' } }
    await expectV3Conversion([...releasedPrefix.slice(0, -1), request], (events) => {
      const expected = [...nativePrefix.slice(0, -1), request]
      expect(events).toEqual(expected.map((row, seq) => ({ ...row, seq, time: 1001 + seq })))
      const migrated = events.find(event => event.type === 'request/header')?.data.header.tools?.[0]
      expect(Object.hasOwn(migrated!, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(migrated!)).toBe(Object.prototype)
      expect(Object.hasOwn(migrated!, 'deferLoading')).toBe(false)
    })
  })

  it('leaves a V3 tool definition with only declared fields unchanged', async () => {
    const tool = { name: 'example', description: 'Saved tool definition.', parameters: { type: 'object' } }
    const request = { type: 'request/header', data: { header: { config, tools: [tool] }, reason: 'initial' } }
    await expectV3Conversion([...releasedPrefix.slice(0, -1), request], (events) => {
      expect(events).toEqual([...nativePrefix.slice(0, -1), request]
        .map((row, seq) => ({ ...row, seq, time: 1001 + seq })))
      const migrated = events.find(event => event.type === 'request/header')?.data.header.tools?.[0]
      expect(Object.hasOwn(migrated!, 'metadata')).toBe(false)
    })
  })

  it.each(['tool/code-dispatch-start', 'tool/code-dispatch'])('keeps %s unsupported beyond a damaged native suffix', async (type) => {
    const path = await store(SESSION_FORMAT_VERSION, compression, [...nativePrefix, {}, ptcRow(type)])
    const original = await observe(path)
    const ctx = await mount(compression)
    await expectCurrentRefusal(ctx, access, path, 'unsupported', type)
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])
  })

  it('refuses a native checkpoint owned by a different compaction before exposing a handle', async () => {
    const path = await store(SESSION_FORMAT_VERSION, compression, nativeCheckpoint('wrong-owner'))
    const original = await observe(path)
    const ctx = await mount(compression)
    await expectCurrentRefusal(ctx, access, path, 'corruption', 'matching compaction/start')
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])
  })

  it('refuses a native tool result without its advertised call before exposing a handle', async () => {
    const path = await store(SESSION_FORMAT_VERSION, compression, [...nativePrefix, {
      type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: {
        id: 'orphan', role: 'tool', toolCallId: 'missing', source: { kind: 'tool', callId: 'missing' },
        content: [{ type: 'text', text: 'orphan result' }],
      } },
    }])
    const original = await observe(path)
    const ctx = await mount(compression)
    await expectCurrentRefusal(ctx, access, path, 'corruption', 'advertised tool lifecycle')
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])
  })

  it.each([false, true])('reopens native matching checkpoints with unfinished tail=%s without changing records', async (unfinished) => {
    const rows = nativeCheckpoint('owner')
    const path = await store(SESSION_FORMAT_VERSION, compression, unfinished ? rows.slice(0, 8) : rows)
    const original = await observe(path)
    const ctx = await mount(compression)
    const handle = await ctx.sessionPersistence.open(id, access)
    try {
      const restored = await handle.read()
      expect(restored.events.find(event => event.type === 'user/message' && event.data.id === 'checkpoint')?.data)
        .toMatchObject({ source: { ...checkpointSource(), compactionId: 'owner' } })
    } finally {
      await handle.close()
    }
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])
  })

  it('leaves the V3 source unchanged when nested results are unsupported', async () => {
    const rows = releasedToolRows({}, { content: [
      { type: 'tool-result', toolCallId: 'nested-call', isError: true, content: [{ type: 'text', text: 'inner failure' }] },
    ] })
    const path = await store(3, compression, rows)
    const original = await observe(path)
    const ctx = await mount(compression)
    await expectRefusal(ctx, access, path,
      'format v3 tool/result at seq 7 contains a nested tool-result unsupported by this converter'
      + '; source v3 artifact remains unchanged (raw log: ' + path + ')')
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations([path])
  })

  it.each([
    { owner: 'result', field: 'extension', value: { saved: true } },
    { owner: 'result', field: '__proto__', value: { saved: true } },
    { owner: 'result', field: 'constructor', value: { saved: true } },
    { owner: 'message', field: 'toolCallId', value: 'conflicting-call' },
    { owner: 'message', field: 'isError', value: true },
  ] as const)('preserves $owner-owned $field through migration and native reopening', async ({ owner, field, value }) => {
    const extra = Object.fromEntries([[field, value]])
    const rows = owner === 'message' ? releasedToolRows(extra) : releasedToolRows({}, extra)
    const path = await store(3, compression, rows)
    const original = await observe(path)
    const ctx = await mount(compression)
    for (const mode of [access, 'read'] as const) {
      const handle = await ctx.sessionPersistence.open(id, mode)
      try {
        const result = (await handle.read()).events.find(event => event.type === 'tool/result')
        expect(result?.data.message).toMatchObject({
          role: 'tool', toolCallId: 'outer-call', isError: false,
          [`plugin:${owner}:${field}`]: value,
        })
        expect(Object.hasOwn(result!.data.message, `plugin:${owner}:${field}`)).toBe(true)
      } finally {
        await handle.close()
      }
    }
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations(access === 'read' ? [path] : [path, generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, compression)])
  })

  it('preserves outer V3 tool-message metadata through migration and native reopening', async () => {
    const metadata = JSON.parse('{"__proto__":{"saved":"prototype"},"constructor":{"saved":"constructor"},"extension":{"saved":true}}') as SessionFormatJsonObject
    const path = await store(3, compression, releasedToolRows({ ...metadata, toolCallId: 'outer-call', isError: false }))
    const original = await observe(path)
    const ctx = await mount(compression)
    const expected = {
      id: 'result', role: 'tool', source: { kind: 'tool', callId: 'outer-call' },
      toolCallId: 'outer-call', isError: false, content: [{ type: 'text', text: 'result' }],
      'plugin:message:toolCallId': 'outer-call', 'plugin:message:isError': false,
      'plugin:message:__proto__': metadata['__proto__'], 'plugin:message:constructor': metadata['constructor'],
      'plugin:message:extension': metadata['extension'],
    }
    for (const mode of [access, 'read'] as const) {
      const handle = await ctx.sessionPersistence.open(id, mode)
      try {
        const restored = await handle.read()
        const result = restored.events.find(event => event.type === 'tool/result')
        expect(result?.data.message).toEqual(expected)
        expect(Object.hasOwn(result!.data.message, 'plugin:message:__proto__')).toBe(true)
        expect(Object.getPrototypeOf(result!.data.message)).toBe(Object.prototype)
      } finally {
        await handle.close()
      }
    }
    expect(await observe(path)).toEqual(original)
    await expectOnlyGenerations(access === 'read' ? [path] : [path, generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, compression)])
  })

  it.each(nativeRefusals.flatMap(refusal => ([3, SESSION_FORMAT_VERSION] as const).map(version => ({ ...refusal, version }))))(
    'refuses V$version $name instead of falling back to readable V2', async ({ tail, diagnostic, currentError, currentSubject, version }) => {
      const lowerPath = await store(2, compression, prefix)
      const lower = await observe(lowerPath)
      const ctx = await mount(compression)
      const reader = await ctx.sessionPersistence.open(id, 'read')
      try {
        expect(reader.header.version).toBe(SESSION_FORMAT_VERSION)
        const restored = await reader.read()
        expect(restored.events.map(event => event.type)).toEqual([
          'turn/start', 'step/start', 'system/message', 'user/message', 'system/message', 'request/header',
        ])
        expect(restored.events.find(event => event.type === 'user/message')?.data).toEqual(question)
      } finally {
        await reader.close()
      }
      expect(await observe(lowerPath)).toEqual(lower)
      await expectOnlyGenerations([lowerPath])

      const path = await store(version, compression, [...(version === 3 ? releasedPrefix : nativePrefix), tail])
      const original = await observe(path)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (version === 3) {
          await expectRefusal(ctx, access, path,
            diagnostic + `; source v${version} artifact remains unchanged (raw log: ${path})`)
        } else {
          await expectCurrentRefusal(ctx, access, path, currentError, currentSubject)
        }
        expect(await observe(path)).toEqual(original)
        expect(await observe(lowerPath)).toEqual(lower)
        await expectOnlyGenerations([lowerPath, path])
      }
    },
  )
})

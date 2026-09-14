/** Durable EOF refusals preserve historical generations and never fall back from native V3. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
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
const nativePrefix: readonly SessionFormatJsonObject[] = [
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
  })),
  {
    name: 'retired request/header.system',
    tail: { type: 'request/header', data: {
      header: { config, system: 'This prompt must not be discarded.' }, reason: 'change',
    } },
    diagnostic: 'format v3 request/header rejects retired header.system',
  },
] satisfies readonly { name: string; tail: SessionFormatJsonObject; diagnostic: string }[]

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

async function store(version: 2 | 3, compression: JsonlCompression, rows: readonly SessionFormatJsonObject[]) {
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

async function expectOnlyGenerations(paths: readonly string[]) {
  const directory = dirname(paths[0]!)
  // A released write lease keeps session.lock; every other extra entry is forbidden.
  expect((await readdir(directory)).filter(name => name !== 'session.lock').sort())
    .toEqual(paths.map(path => basename(path)).sort())
}

describe.each(modes)('EOF migration refusal ($compression, $access)', ({ compression, access }) => {
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
        await expect(stat(generationLogPath(root, undefined, id, 3, targetCompression)))
          .rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
  })

  it.each(nativeRefusals)('refuses native V3 $name instead of falling back to readable V2', async ({ tail, diagnostic }) => {
    const lowerPath = await store(2, compression, prefix)
    const lower = await observe(lowerPath)
    const ctx = await mount(compression)
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try {
      expect(reader.header.version).toBe(3)
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

    const path = await store(3, compression, [...nativePrefix, tail])
    const original = await observe(path)
    const message = diagnostic + ' (raw log: ' + path + ')'
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expectRefusal(ctx, access, path, message)
      expect(await observe(path)).toEqual(original)
      expect(await observe(lowerPath)).toEqual(lower)
      await expectOnlyGenerations([lowerPath, path])
    }
  })
})

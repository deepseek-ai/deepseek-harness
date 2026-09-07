import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  JsonlGenerationSourceChangedError,
  JsonlGenerationTargetConflictError,
  JsonlGenerationUnsupportedMigrationError,
  prepareJsonlMigration,
  verifyJsonlCurrentGeneration,
  type JsonlGenerationFormatAdapter,
  type PrepareJsonlMigrationOptions,
} from '../src/generation.ts'
import { createJsonlGenerationTestRuntime } from '../src/testing/generation.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'
import type { JsonlCompression } from '../src/format.ts'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatJsonValue,
  SessionFormatRestore,
} from '@deepseek-ai/dsh-session-format'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-generation-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function fsError(code: string, message = code): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

/** Complete a POSIX-branch simulation on Windows, whose NTFS directory handles reject fsync. */
async function openWithPosixDirectorySync(path: string, flags: string, mode?: number) {
  const handle = await open(path, flags, mode)
  if (flags === 'r' && (await stat(path)).isDirectory()) {
    vi.spyOn(handle, 'sync').mockResolvedValue(undefined)
  }
  return handle
}

function posixSimulationFs<T extends Record<string, unknown>>(
  overrides: T,
): T & { readonly open: typeof openWithPosixDirectorySync } {
  return { open: openWithPosixDirectorySync, ...overrides }
}

function header(version: number, id = 'generation-test'): Record<string, unknown> {
  return {
    type: 'session', version, id, createdAt: 1, delegationDepth: 0,
    ...(version >= 2 ? { isSeeded: false } : {}),
  }
}

const event0 = { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } }
const event1 = { type: 'turn/end', seq: 1, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }
const assistantUsage = { inputTokens: 3, outputTokens: 2 }
const assistantReplayState = { response: { id: 'response' } }

function assistantData(
  overrides: {
    readonly content?: readonly SessionFormatJsonValue[]
    readonly stream?: SessionFormatJsonValue
    readonly usage?: SessionFormatJsonValue
    readonly replayState?: SessionFormatJsonValue
    readonly interrupted?: true
  } = {},
): SessionFormatJsonValue {
  const replayState = overrides.replayState === undefined
    ? assistantReplayState
    : overrides.replayState
  return {
    turn: 1,
    step: 1,
    message: {
      id: 'assistant',
      role: 'assistant',
      content: overrides.content ?? [{ type: 'text', text: 'hello' }],
      source: {
        kind: 'model', provider: 'mock', model: 'mock',
        ...(replayState === null ? {} : { replayState }),
      },
    },
    stream: overrides.stream ?? [
      { type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['hello'] },
      { type: 'chunk', time: 4, chunk: { type: 'usage', usage: assistantUsage } },
      { type: 'chunk', time: 5, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: assistantReplayState } },
    ],
    ...(overrides.usage === null ? {} : { usage: overrides.usage ?? assistantUsage }),
    ...(overrides.interrupted === undefined ? {} : { interrupted: overrides.interrupted }),
  }
}

function assistantLifecycle(
  type: 'assistant/message' | 'assistant/attempt',
  data: SessionFormatJsonValue,
): SessionFormatEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type,
      seq: 2,
      time: 5,
      data,
      ...(type === 'assistant/message' ? { surfaceOp: 'append' as const } : {}),
    },
    { type: 'step/end', seq: 3, time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

interface TestGenerationFormatAdapter extends JsonlGenerationFormatAdapter {
  createRestore(header: Record<string, unknown>): SessionFormatRestore
}

function adapter(overrides: Partial<TestGenerationFormatAdapter> = {}): TestGenerationFormatAdapter {
  const currentVersion = overrides.currentVersion ?? 2
  return {
    currentVersion,
    createRestore(headerValue) {
      const events: SessionFormatArtifact['events'][number][] = []
      const header = {
        ...headerValue,
        version: currentVersion,
        isSeeded: false,
      } as SessionFormatArtifact['header']
      return {
        header,
        decodeRow(row) { events.push(row as SessionFormatArtifact['events'][number]) },
        finish: () => ({ header, inheritedEventCount: 0, events }),
      }
    },
    encodeHeader(value) {
      const { isSeeded: _isSeeded, ...header } = value
      return currentVersion === 0 ? header : {
        ...header,
        type: 'session',
        version: currentVersion,
        ...(currentVersion >= 2 ? { isSeeded: value.isSeeded } : {}),
      }
    },
    encodeEvent: event => event,
    ...overrides,
  }
}

function streamingAdapter(): JsonlGenerationFormatAdapter & {
  createRestore(header: Record<string, unknown>): SessionFormatRestore
} {
  return adapter()
}

function verifier(): PrepareJsonlMigrationOptions['verifyCurrentFile'] {
  return (path, compression, expectedId, expectedEventCount, expectedPrefix) =>
    verifyJsonlCurrentGeneration(path, compression, expectedId, expectedEventCount, expectedPrefix)
}

const byteVerifier: PrepareJsonlMigrationOptions['verifyCurrentFile'] = async (path) => {
  const [bytes, identity] = await Promise.all([readFile(path), stat(path, { bigint: true })])
  return {
    identity,
    bytes: bytes.length,
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
}

function generationPath(root: string, version: number, compression: JsonlCompression): string {
  const suffix = compression === 'zstd' ? '.jsonl.zstd' : '.jsonl'
  return join(root, version === 0 ? `session${suffix}` : `session.v${version}${suffix}`)
}

function options(
  root: string,
  compression: JsonlCompression = 'none',
  format: JsonlGenerationFormatAdapter = adapter(),
  sourceVersion = 0,
): Omit<PrepareJsonlMigrationOptions, 'verifyCurrentFile'> {
  return {
    sourcePath: generationPath(root, sourceVersion, compression),
    sourceVersion,
    currentPath: generationPath(root, format.currentVersion, compression),
    compression,
    format,
  }
}

type TestMigrationOptions = ReturnType<typeof options> & {
  readonly signal?: AbortSignal
  readonly verifyCurrentFile?: PrepareJsonlMigrationOptions['verifyCurrentFile']
}
type TestGenerationOverrides = Parameters<typeof createJsonlGenerationTestRuntime>[0]

async function ensureWithOverrides(
  request: TestMigrationOptions,
  overrides: TestGenerationOverrides,
) {
  const runtime = createJsonlGenerationTestRuntime(overrides)
  const verifyCurrentFile = request.verifyCurrentFile ?? (
    (path: string, compression: JsonlCompression, expectedId: string, expectedEventCount: number, expectedPrefix) =>
      runtime.verify(
        path,
        compression,
        expectedId,
        expectedEventCount,
        expectedPrefix,
      )
  )
  const prepared = await runtime.prepare({
    ...request,
    verifyCurrentFile,
  })
  const identity = await prepared.publish()
  const bytes = await readFile(request.currentPath)
  return {
    status: 'migrated' as const,
    fromVersion: request.sourceVersion,
    toVersion: request.format.currentVersion,
    path: request.currentPath,
    sourcePath: request.sourcePath,
    snapshot: { identity, bytes },
  }
}

function ensureJsonlGenerationCurrent(request: TestMigrationOptions) {
  return ensureWithOverrides(request, {})
}

async function encodeZstd(version: number, rows: readonly unknown[]): Promise<Buffer> {
  return Buffer.concat([
    await compressZstdFrame(line(header(version))),
    ...rows.length === 0
      ? []
      : [await compressZstdFrame(rows.map(row => line(row)).join(''))],
  ])
}

async function decodeZstdJsonl(path: string): Promise<string> {
  const bytes = await readFile(path)
  const { frames, tornStart } = scanZstdFrames(bytes)
  expect(tornStart).toBeUndefined()
  const plaintext: Buffer[] = []
  for (const frame of frames) plaintext.push(await decompressZstdFrame(bytes.subarray(frame.start, frame.end)))
  return Buffer.concat(plaintext).toString('utf8')
}

describe('JSONL immutable generation publication', () => {
  it('returns migrated events while publication is still waiting for verification', async () => {
    const root = await tempRoot()
    const request = options(root, 'none', streamingAdapter())
    const boundaryBase = { ...event0, data: { turn: 1, text: '' } }
    const boundaryEvent = {
      ...boundaryBase,
      data: { ...boundaryBase.data, text: 'x'.repeat(1024 * 1024 - JSON.stringify(boundaryBase).length) },
    }
    const largeEvent = { ...event0, seq: 1, data: { turn: 1, text: 'y'.repeat(1024 * 1024) } }
    const finalEvent = { ...event1, seq: 2 }
    await writeFile(request.sourcePath, line(header(0)) + line(boundaryEvent) + line(largeEvent) + line(finalEvent))
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now += 600)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()

    const prepared = await prepareJsonlMigration({
      ...request,
      verifyCurrentFile: async (path, compression, expectedId, expectedEventCount) => {
        entered.resolve(undefined)
        await release.promise
        return verifyJsonlCurrentGeneration(path, compression, expectedId, expectedEventCount)
      },
    })
    expect(prepared.artifact.events).toEqual([boundaryEvent, largeEvent, finalEvent])
    const publication = prepared.publish()
    expect(prepared.publish()).toBe(publication)
    await entered.promise
    await expect(readFile(request.currentPath)).rejects.toMatchObject({ code: 'ENOENT' })

    release.resolve(undefined)
    await publication
    const [writtenHeader, ...writtenEvents] = (await readFile(request.currentPath, 'utf8')).trimEnd().split('\n')
    expect(JSON.parse(writtenHeader as string)).toEqual({ ...header(2), isSeeded: false })
    expect(writtenEvents.map(row => JSON.parse(row) as unknown)).toEqual([boundaryEvent, largeEvent, finalEvent])
  })

  it('batches exact-threshold encoded rows without retaining a final partial write', async () => {
    const root = await tempRoot()
    const mib = 1024 * 1024
    const widths = [4 * mib - 3, mib - 3, mib - 3, mib - 3, mib - 3]
    const format = adapter({
      encodeEvent: event => 'x'.repeat(widths[event.seq] as number),
    })
    const request = options(root, 'none', format)
    const events = widths.map((_, seq) => ({ ...event0, seq }))
    await writeFile(request.sourcePath, line(header(0)) + events.map(line).join(''))

    const prepared = await prepareJsonlMigration({
      ...request,
      verifyCurrentFile: byteVerifier,
    })
    await prepared.publish()

    expect((await stat(request.currentPath)).size).toBeGreaterThan(8 * mib)
  })

  it('fails publication without rerunning migration when the source changes', async () => {
    const root = await tempRoot()
    const base = streamingAdapter()
    const sourceStreams = vi.fn()
    const request = options(root, 'none', {
      ...base,
      createRestore: (value) => {
        if (value.version === 0) sourceStreams()
        return base.createRestore(value)
      },
    })
    const source = line(header(0)) + line(event0)
    await writeFile(request.sourcePath, source)

    const prepared = await prepareJsonlMigration({
      ...request,
      verifyCurrentFile: async (path, compression, expectedId, expectedEventCount) => {
        const verified = await verifyJsonlCurrentGeneration(path, compression, expectedId, expectedEventCount)
        await writeFile(request.sourcePath, source + line(event1))
        return verified
      },
    })

    await expect(prepared.publish()).rejects.toBeInstanceOf(JsonlGenerationSourceChangedError)
    expect(sourceStreams).toHaveBeenCalledOnce()
    await expect(readFile(request.currentPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses malformed streaming inputs before publication', async () => {
    const root = await tempRoot()
    const request = options(root, 'none', streamingAdapter())

    await writeFile(request.sourcePath, '')
    await expect(prepareJsonlMigration({ ...request, verifyCurrentFile: vi.fn() }))
      .rejects.toThrow('empty or header-less')

    await writeFile(request.sourcePath, line(header(1)))
    await expect(prepareJsonlMigration({ ...request, verifyCurrentFile: vi.fn() }))
      .rejects.toThrow(/filename identifies v0.*header identifies v1/)

    await writeFile(request.sourcePath, line(header(0)) + '{bad json}\n' + line(event1))
    await expect(prepareJsonlMigration({ ...request, verifyCurrentFile: vi.fn() }))
      .rejects.toThrow('row 1 is not valid JSON')

    await writeFile(request.sourcePath, line(header(0)) + '{bad json}\n' + line(event0))
    const dropped = await prepareJsonlMigration({
      ...request,
      verifyCurrentFile: verifier(),
    })
    expect(dropped.artifact.events).toEqual([])
    await dropped.publish()

  })

  it('verifies exact current identity, completeness, and event count', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 2, 'none')
    await writeFile(path, line({ ...header(2), isSeeded: false }) + line(event0))

    await expect(verifyJsonlCurrentGeneration(path, 'none', 'other', 1))
      .rejects.toThrow('expected "other"')
    await expect(verifyJsonlCurrentGeneration(path, 'none', 'generation-test', 2))
      .rejects.toThrow('contains 1 events')
    await writeFile(path, line({ ...header(2), isSeeded: false }) + JSON.stringify(event0))
    await expect(verifyJsonlCurrentGeneration(path, 'none', 'generation-test', 1))
      .rejects.toThrow('torn physical tail')

    await writeFile(path, Buffer.alloc(0))
    await expect(verifyJsonlCurrentGeneration(path, 'none', 'generation-test', 0))
      .rejects.toThrow('empty or header-less')
    await expect(verifyJsonlCurrentGeneration(path, 'zstd', 'generation-test', 0))
      .rejects.toThrow('empty or header-less Zstandard')
    const headerFrame = await compressZstdFrame(line({ ...header(2), isSeeded: false }))
    await writeFile(path, Buffer.concat([headerFrame, await compressZstdFrame(JSON.stringify(event0))]))
    await expect(verifyJsonlCurrentGeneration(path, 'zstd', 'generation-test', 1))
      .rejects.toThrow('torn physical tail')
    await writeFile(path, Buffer.concat([
      headerFrame,
      (await compressZstdFrame(line(event0))).subarray(0, -3),
    ]))
    await expect(verifyJsonlCurrentGeneration(path, 'zstd', 'generation-test', 1))
      .rejects.toThrow('torn physical tail')
  })

  it('keeps complete Assistant stream checks in current-generation verification', async () => {
    const root = await tempRoot()
    const path = generationPath(root, 2, 'none')
    const verify = async (events: readonly SessionFormatEvent[]) => {
      await writeFile(path, line(header(2)) + events.map(line).join(''))
      return verifyJsonlCurrentGeneration(path, 'none', 'generation-test', events.length)
    }

    const valid = [
      assistantLifecycle('assistant/message', assistantData()),
      assistantLifecycle('assistant/message', assistantData({
        interrupted: true,
        stream: [{ type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['hello'] }],
        usage: null,
        replayState: null,
      })),
      assistantLifecycle('assistant/message', assistantData({
        content: [], stream: [], usage: null, replayState: null,
      })),
      assistantLifecycle('assistant/attempt', {
        turn: 1,
        step: 1,
        stream: [{ type: 'text-chunks', time0: 3, index: 0, dt: [1], texts: ['a', 'b'] }],
      }),
    ]
    for (const events of valid) expect((await verify(events)).bytes).toBeGreaterThan(0)

    await expect(verify(assistantLifecycle('assistant/attempt', {
      turn: 1, step: 1, stream: [{ type: 'future' }],
    }))).rejects.toThrow(/invalid embedded stream/)
    await expect(verify(assistantLifecycle('assistant/message', assistantData({
      content: [{ type: 'text', text: 'different' }],
    })))).rejects.toThrow(/content disagrees/)
    await expect(verify(assistantLifecycle('assistant/message', assistantData({
      usage: { inputTokens: 9, outputTokens: 2 },
    })))).rejects.toThrow(/usage disagrees/)
    await expect(verify(assistantLifecycle('assistant/message', assistantData({
      replayState: { response: { id: 'different' } },
    })))).rejects.toThrow(/replay state disagrees/)
  })

  it('accepts an identical publication winner and rejects different bytes', async () => {
    const identicalRoot = await tempRoot()
    const identical = options(identicalRoot, 'none', streamingAdapter())
    await writeFile(identical.sourcePath, line(header(0)) + line(event0))
    const prepared = await prepareJsonlMigration({
      ...identical,
      verifyCurrentFile: async (path, compression, expectedId, expectedEventCount) => {
        const verified = await verifyJsonlCurrentGeneration(path, compression, expectedId, expectedEventCount)
        if (path !== identical.currentPath) await link(path, identical.currentPath)
        return verified
      },
    })
    expect((await prepared.publish()).size).toBeGreaterThan(0n)

    const differentRoot = await tempRoot()
    const different = options(differentRoot, 'none', streamingAdapter())
    await writeFile(different.sourcePath, line(header(0)) + line(event0))
    await writeFile(different.currentPath, line({ ...header(2), isSeeded: false }) + line({ ...event0, time: 99 }))
    const conflicted = await prepareJsonlMigration({
      ...different,
      verifyCurrentFile: verifier(),
    })
    await expect(conflicted.publish()).rejects.toBeInstanceOf(JsonlGenerationTargetConflictError)

    const uncheckedRoot = await tempRoot()
    const unchecked = options(uncheckedRoot, 'none', streamingAdapter())
    await writeFile(unchecked.sourcePath, line(header(0)) + line(event0))
    await writeFile(
      unchecked.currentPath,
      line({ ...header(2), isSeeded: false }) + line({ ...event0, time: 99 }),
    )
    const uncheckedPublication = await prepareJsonlMigration({
      ...unchecked,
      verifyCurrentFile: byteVerifier,
    })
    await expect(uncheckedPublication.publish())
      .rejects.toThrow(/target bytes differ from the migrated generation/)
  })

  it('handles empty, incomplete-record, and torn Zstandard migration sources', async () => {
    const emptyRoot = await tempRoot()
    const empty = options(emptyRoot, 'zstd', streamingAdapter())
    await writeFile(empty.sourcePath, Buffer.alloc(0))
    await expect(prepareJsonlMigration({ ...empty, verifyCurrentFile: vi.fn() }))
      .rejects.toThrow('empty or header-less Zstandard')

    const incompleteRoot = await tempRoot()
    const incomplete = options(incompleteRoot, 'zstd', streamingAdapter())
    await writeFile(incomplete.sourcePath, Buffer.concat([
      await compressZstdFrame(line(header(0))),
      await compressZstdFrame(JSON.stringify(event0)),
    ]))
    await expect(prepareJsonlMigration({ ...incomplete, verifyCurrentFile: vi.fn() }))
      .rejects.toThrow('complete frame contains a torn JSONL record')

    const tornRoot = await tempRoot()
    const torn = options(tornRoot, 'zstd', streamingAdapter())
    const tornBody = await compressZstdFrame(line(event0) + line(event1))
    await writeFile(torn.sourcePath, Buffer.concat([
      await compressZstdFrame(line(header(0))),
      tornBody.subarray(0, -3),
    ]))
    const recovered = await prepareJsonlMigration({
      ...torn,
      verifyCurrentFile: verifier(),
    })
    expect(recovered.artifact.events).toEqual([event0, event1])
    await recovered.publish()

    const emptyTailRoot = await tempRoot()
    const emptyTail = options(emptyTailRoot, 'zstd', streamingAdapter())
    await writeFile(emptyTail.sourcePath, Buffer.concat([
      await compressZstdFrame(line(header(0))),
      tornBody.subarray(0, 8),
    ]))
    const withoutTail = await prepareJsonlMigration({
      ...emptyTail,
      verifyCurrentFile: verifier(),
    })
    expect(withoutTail.artifact.events).toEqual([])
    await withoutTail.publish()
  })

  it('checks migration and verification identities exactly', async () => {
    const verifyRoot = await tempRoot()
    const currentPath = generationPath(verifyRoot, 2, 'none')
    await writeFile(currentPath, line(header(2)))
    let statCount = 0
    await expect(createJsonlGenerationTestRuntime({
      fs: { stat: async path => ({ ...await stat(path, { bigint: true }), ctimeNs: BigInt(++statCount) }) },
    }).verify(
      currentPath,
      'none',
      'generation-test',
      0,
    )).rejects.toThrow('changed during verification')

    const mismatchRoot = await tempRoot()
    const mismatch = options(mismatchRoot, 'none', streamingAdapter())
    await writeFile(mismatch.sourcePath, line(header(0)))
    const mismatched = await prepareJsonlMigration({
      ...mismatch,
      verifyCurrentFile: async (path, compression, expectedId, expectedEventCount) => ({
        ...await verifyJsonlCurrentGeneration(path, compression, expectedId, expectedEventCount),
        digest: 'different',
      }),
    })
    await expect(mismatched.publish()).rejects.toThrow('changed during verification')

    const current = options(await tempRoot(), 'none', streamingAdapter(), 2)
    await expect(prepareJsonlMigration({ ...current, verifyCurrentFile: vi.fn() }))
      .rejects.toThrow('requires a historical source')

    const wrongRoot = await tempRoot()
    const wrongFormat = streamingAdapter()
    const wrong = options(wrongRoot, 'none', {
      ...wrongFormat,
      createRestore: headerValue => ({
        header: { ...headerValue, version: 0, isSeeded: false } as SessionFormatArtifact['header'],
        decodeRow: () => {},
        finish: () => ({
          header: { ...headerValue, version: 0, isSeeded: false } as SessionFormatArtifact['header'],
          inheritedEventCount: 0,
          events: [],
        }),
      }),
    })
    await writeFile(wrong.sourcePath, line(header(0)))
    await expect(prepareJsonlMigration({ ...wrong, verifyCurrentFile: vi.fn() }))
      .rejects.toThrow('migration returned v0')
  })

  it('propagates a streamed compressor write failure through stage cleanup', async () => {
    const failedRoot = await tempRoot()
    const failed = options(failedRoot, 'zstd', streamingAdapter())
    await writeFile(failed.sourcePath, await encodeZstd(0, [event0]))
    let writes = 0
    const failedHandle = {
      writeFile: async () => { if (++writes > 1) throw new Error('write failed') },
      sync: async () => {},
      close: async () => { throw new Error('close failed') },
    } as unknown as FileHandle
    const failedPreparation = await createJsonlGenerationTestRuntime({
      fs: { open: async () => failedHandle },
    }).prepare({
      ...failed,
      verifyCurrentFile: vi.fn(),
    })
    await expect(failedPreparation.publish()).rejects.toBeInstanceOf(AggregateError)
  })

  it('propagates a streamed encoder failure through the Zstandard pipeline', async () => {
    const root = await tempRoot()
    const failure = new Error('event encoder failed')
    const request = options(root, 'zstd', adapter({
      encodeEvent: () => { throw failure },
    }))
    await writeFile(request.sourcePath, await encodeZstd(0, [event0]))

    const prepared = await prepareJsonlMigration({
      ...request,
      verifyCurrentFile: vi.fn(),
    })
    await expect(prepared.publish()).rejects.toBe(failure)
    expect(await readdir(root)).toEqual(['session.jsonl.zstd'])
  })

  it('publishes a prepared stage through the Windows no-overwrite path', async () => {
    const winRoot = await tempRoot()
    const win = options(winRoot, 'none', streamingAdapter())
    await writeFile(win.sourcePath, line(header(0)))
    const winPrepared = await createJsonlGenerationTestRuntime({
      platform: 'win32',
      publishNewWin32: rename,
    }).prepare({
      ...win,
      verifyCurrentFile: verifier(),
    })
    await winPrepared.publish()
    expect(await readFile(win.currentPath, 'utf8')).toContain('"version":2')
  })

  it('publishes v2 beside an immutable suffixless v0 source', async () => {
    const root = await tempRoot()
    const request = { ...options(root), signal: new AbortController().signal }
    const source = Buffer.from(line(header(0)) + line(event0))
    await writeFile(request.sourcePath, source)

    const result = await ensureJsonlGenerationCurrent(request)

    expect(result).toMatchObject({
      status: 'migrated',
      fromVersion: 0,
      toVersion: 2,
      path: request.currentPath,
      sourcePath: request.sourcePath,
    })
    expect(await readFile(request.sourcePath)).toEqual(source)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
    expect((await readdir(root)).sort()).toEqual(['session.jsonl', 'session.v2.jsonl'])
  })

  it.each(['none', 'zstd'] as const)(
    'validates the selected %s historical header before invoking migration',
    async (compression) => {
      const root = await tempRoot()
      const request = options(root, compression)
      const source = compression === 'zstd'
        ? await encodeZstd(0, [event0])
        : Buffer.from(line(header(0)) + line(event0))
      await writeFile(request.sourcePath, source)
      const failure = new Error('selected path does not match source header identity')
      const base = adapter()
      const createRestore = vi.fn((value: Record<string, unknown>) => base.createRestore(value))
      const validateHistoricalHeader = vi.fn(() => { throw failure })

      await expect(ensureJsonlGenerationCurrent({
        ...request,
        format: { ...base, createRestore },
        validateHistoricalHeader,
      })).rejects.toBe(failure)

      expect(validateHistoricalHeader).toHaveBeenCalledWith(expect.objectContaining({ id: 'generation-test' }))
      expect(createRestore).not.toHaveBeenCalled()
      expect(await readFile(request.sourcePath)).toEqual(source)
      expect(await readdir(root)).toEqual([basename(request.sourcePath)])
    },
  )

  it('awaits asynchronous historical-header validation before migration', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    const order: string[] = []
    const base = adapter()

    await ensureJsonlGenerationCurrent({
      ...request,
      format: adapter({
        createRestore: (value) => {
          order.push('restore')
          return base.createRestore(value)
        },
      }),
      validateHistoricalHeader: async () => {
        await Promise.resolve()
        order.push('validate')
      },
    })

    expect(order).toEqual(['validate', 'restore'])
  })

  it('rejects a resolver/header version disagreement before migration', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(1)) + line(event0))

    await expect(ensureJsonlGenerationCurrent(request)).rejects.toThrow(
      'source filename identifies v0, but its header identifies v1',
    )
    expect(await readdir(root)).toEqual(['session.jsonl'])
  })

  it('rejects a malformed version discriminator before migration', async () => {
    const root = await tempRoot()
    const malformed = options(join(root, 'malformed'))
    await mkdir(join(root, 'malformed'))
    await writeFile(malformed.sourcePath, line(header(-1)))

    await expect(ensureJsonlGenerationCurrent(malformed)).rejects.toThrow(
      'header version is not a non-negative safe integer',
    )
  })

  it.each([
    [null, 'first line is not a JSON object'],
    [[], 'first line is not a JSON object'],
    [{ ...header(0), version: Number.MAX_SAFE_INTEGER + 1 }, 'header version is not a non-negative safe integer'],
    [{ ...header(0), version: '0' }, 'header version is not a non-negative safe integer'],
  ] as const)('rejects malformed physical header %#', async (value, message) => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(value))

    await expect(ensureJsonlGenerationCurrent(request)).rejects.toThrow(message)
  })

  it('rejects a negative-zero physical version', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, '{"type":"session","version":-0,"id":"generation-test"}\n')

    await expect(ensureJsonlGenerationCurrent(request)).rejects.toThrow(
      'header version is not a non-negative safe integer',
    )
  })

  it('distinguishes policy refusal from ordinary and invalid-output migration failures', async () => {
    const root = await tempRoot()
    const blockedRoot = join(root, 'blocked')
    const ordinaryRoot = join(root, 'ordinary')
    const wrongRoot = join(root, 'wrong')
    await mkdir(blockedRoot)
    await mkdir(ordinaryRoot)
    await mkdir(wrongRoot)
    const blocked = new Error('blocked by edge policy')
    const ordinary = new Error('malformed source')
    for (const dir of [blockedRoot, ordinaryRoot, wrongRoot]) {
      await writeFile(generationPath(dir, 0, 'none'), line(header(0)) + line(event0))
    }

    await expect(ensureJsonlGenerationCurrent(options(blockedRoot, 'none', adapter({
      createRestore: () => { throw blocked },
      isUnsupportedMigrationError: (error): error is Error => error === blocked,
    })))).rejects.toMatchObject({
      name: 'JsonlGenerationUnsupportedMigrationError',
      fromVersion: 0,
      reason: blocked,
    } satisfies Partial<JsonlGenerationUnsupportedMigrationError>)
    await expect(ensureJsonlGenerationCurrent(options(ordinaryRoot, 'none', adapter({
      createRestore: () => { throw ordinary },
    })))).rejects.toBe(ordinary)
    const wrongBase = adapter()
    await expect(ensureJsonlGenerationCurrent(options(wrongRoot, 'none', adapter({
      createRestore: (value) => {
        const restore = wrongBase.createRestore(value)
        return {
          header: { ...restore.header, version: 3 },
          decodeRow: (row) => { restore.decodeRow(row) },
          finish: () => {
            const artifact = restore.finish()
            return { ...artifact, header: { ...artifact.header, version: 3 } }
          },
        }
      },
    })))).rejects.toThrow('format migration returned v3, expected v2')
    expect(await readdir(blockedRoot)).toEqual(['session.jsonl'])
    expect(await readdir(ordinaryRoot)).toEqual(['session.jsonl'])
    expect(await readdir(wrongRoot)).toEqual(['session.jsonl'])
  })

  it('refuses migration output that JSON cannot encode losslessly', async () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    for (const [name, value] of [
      ['bigint', 1n],
      ['circular', circular],
      ['undefined', undefined],
    ] as const) {
      const root = await tempRoot()
      const request = options(root)
      await writeFile(request.sourcePath, line(header(0)) + line(event0))

      await expect(ensureJsonlGenerationCurrent({
        ...request,
        format: adapter({
          encodeEvent: () => value as never,
        }),
      })).rejects.toThrow('migrated Session event 0 is not lossless JSON')
      expect(await readdir(root), name).toEqual(['session.jsonl'])
    }
  })

  it('publishes only the final generation across a multi-edge migration', async () => {
    const root = await tempRoot()
    const format = adapter()
    const request = options(root, 'none', format)
    const source = Buffer.from(line(header(0)) + line(event0))
    await writeFile(request.sourcePath, source)
    const sourceBefore = await stat(request.sourcePath, { bigint: true })

    await ensureJsonlGenerationCurrent(request)

    expect(await readFile(request.sourcePath)).toEqual(source)
    const sourceAfter = await stat(request.sourcePath, { bigint: true })
    expect([sourceAfter.dev, sourceAfter.ino]).toEqual([sourceBefore.dev, sourceBefore.ino])
    expect(await readFile(request.currentPath, 'utf8')).toBe(line({ ...header(2), isSeeded: false }) + line(event0))
    expect((await readdir(root)).sort()).toEqual(['session.jsonl', 'session.v2.jsonl'])
  })

  it.each(['none', 'zstd'] as const)(
    'uses one immutable publication algorithm for %s',
    async (compression) => {
      const root = await tempRoot()
      const request = options(root, compression)
      const source = compression === 'zstd'
        ? await encodeZstd(0, [event0])
        : Buffer.from(line(header(0)) + line(event0))
      await writeFile(request.sourcePath, source)
      const sourceBefore = await stat(request.sourcePath, { bigint: true })

      await ensureJsonlGenerationCurrent(request)

      expect(await readFile(request.sourcePath)).toEqual(source)
      const sourceAfter = await stat(request.sourcePath, { bigint: true })
      const current = await stat(request.currentPath, { bigint: true })
      expect([sourceAfter.dev, sourceAfter.ino]).toEqual([sourceBefore.dev, sourceBefore.ino])
      expect([current.dev, current.ino]).not.toEqual([sourceBefore.dev, sourceBefore.ino])
      const currentText = compression === 'zstd'
        ? await decodeZstdJsonl(request.currentPath)
        : await readFile(request.currentPath, 'utf8')
      expect(currentText).toBe(line(header(2)) + line(event0))
    },
  )

  it('handles header-only and torn-tail historical Zstandard generations', async () => {
    const root = await tempRoot()
    const headerRoot = join(root, 'header')
    const emptyTailRoot = join(root, 'empty-tail')
    const tornRoot = join(root, 'torn')
    await mkdir(headerRoot)
    await mkdir(emptyTailRoot)
    await mkdir(tornRoot)
    const headerRequest = options(headerRoot, 'zstd')
    const emptyTailRequest = options(emptyTailRoot, 'zstd')
    const tornRequest = options(tornRoot, 'zstd')
    const headerFrame = await compressZstdFrame(line(header(0)))
    const eventFrame = await compressZstdFrame(line(event0))
    const recoveredFrame = await compressZstdFrame(line(event1))
    await writeFile(headerRequest.sourcePath, headerFrame)
    await writeFile(emptyTailRequest.sourcePath, Buffer.concat([headerFrame, eventFrame.subarray(0, 8)]))
    await writeFile(tornRequest.sourcePath, Buffer.concat([headerFrame, eventFrame, recoveredFrame.subarray(0, -3)]))

    await ensureJsonlGenerationCurrent(headerRequest)
    await ensureJsonlGenerationCurrent(emptyTailRequest)
    await ensureJsonlGenerationCurrent(tornRequest)

    expect(await decodeZstdJsonl(headerRequest.currentPath)).toBe(line(header(2)))
    expect(await decodeZstdJsonl(emptyTailRequest.currentPath)).toBe(line(header(2)))
    expect(await decodeZstdJsonl(tornRequest.currentPath)).toBe(line(header(2)) + line(event0) + line(event1))
  })

  it('rejects header-less raw and Zstandard sources and a non-independent Zstandard header frame', async () => {
    const root = await tempRoot()
    const rawRoot = join(root, 'raw')
    const emptyZstdRoot = join(root, 'empty-zstd')
    const joinedZstdRoot = join(root, 'joined-zstd')
    await mkdir(rawRoot)
    await mkdir(emptyZstdRoot)
    await mkdir(joinedZstdRoot)
    const raw = options(rawRoot)
    const emptyZstd = options(emptyZstdRoot, 'zstd')
    const joinedZstd = options(joinedZstdRoot, 'zstd')
    await writeFile(raw.sourcePath, JSON.stringify(header(0)))
    await writeFile(emptyZstd.sourcePath, Buffer.alloc(0))
    await writeFile(joinedZstd.sourcePath, await compressZstdFrame(line(header(0)) + line(event0)))

    await expect(ensureJsonlGenerationCurrent(raw)).rejects.toThrow('empty or header-less session log')
    await expect(ensureJsonlGenerationCurrent(emptyZstd)).rejects.toThrow(
      'empty or header-less Zstandard session log',
    )
    await expect(ensureJsonlGenerationCurrent(joinedZstd)).rejects.toThrow(
      'first frame is not exactly one header line',
    )
  })

  it('rejects a complete Zstandard frame whose final JSONL record is torn', async () => {
    const root = await tempRoot()
    const request = options(root, 'zstd')
    await writeFile(request.sourcePath, Buffer.concat([
      await compressZstdFrame(line(header(0))),
      await compressZstdFrame(JSON.stringify(event0)),
    ]))

    await expect(ensureJsonlGenerationCurrent(request)).rejects.toThrow(
      'complete frame contains a torn JSONL record',
    )
    expect(await readdir(root)).toEqual(['session.jsonl.zstd'])
  })

  it('drops an uncommitted corrupt raw suffix but refuses corruption before a committed turn end', async () => {
    const root = await tempRoot()
    const droppedRoot = join(root, 'dropped')
    const refusedRoot = join(root, 'refused')
    await mkdir(droppedRoot)
    await mkdir(refusedRoot)
    const dropped = options(droppedRoot)
    const refused = options(refusedRoot)
    const incomplete = line(header(0)) + line(event0) + '{not-json}\n' + line({ type: 'step/start', seq: 1 })
    const committed = line(header(0)) + line(event0) + '{not-json}\n' + line(event1)
    await writeFile(dropped.sourcePath, incomplete)
    await writeFile(refused.sourcePath, committed)

    await ensureJsonlGenerationCurrent(dropped)
    await expect(ensureJsonlGenerationCurrent(refused)).rejects.toThrow('row 2 is not valid JSON')

    expect(await readFile(dropped.sourcePath, 'utf8')).toBe(incomplete)
    expect(await readFile(dropped.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
    expect(await readFile(refused.sourcePath, 'utf8')).toBe(committed)
    expect(await readdir(refusedRoot)).toEqual(['session.jsonl'])
  })

  it('drops a byte-torn raw suffix without altering the source', async () => {
    const root = await tempRoot()
    const request = options(root)
    const source = Buffer.from(line(header(0)) + line(event0) + '{"type":"turn/end"')
    await writeFile(request.sourcePath, source)

    await ensureJsonlGenerationCurrent(request)

    expect(await readFile(request.sourcePath)).toEqual(source)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
  })

  it('validates canonical lowercase generation filenames and one shared directory', async () => {
    const root = await tempRoot()
    const other = join(root, 'other')
    await mkdir(other)
    const source = line(header(0))
    const cases = [
      {
        request: { ...options(root), sourcePath: join(root, 'session.v0.jsonl') },
        message: 'source path must end with "session.jsonl"',
      },
      {
        request: { ...options(root), currentPath: join(root, 'session.V2.jsonl') },
        message: 'current JSONL generation path must end with "session.v2.jsonl"',
      },
      {
        request: { ...options(root), currentPath: generationPath(other, 2, 'none') },
        message: 'must share one Session directory',
      },
    ]
    await writeFile(generationPath(root, 0, 'none'), source)

    for (const { request, message } of cases) {
      await expect(ensureJsonlGenerationCurrent(request)).rejects.toThrow(message)
    }
  })

  it('bounds a bracketed physical read and does not rerun migration after a publication race', async () => {
    const root = await tempRoot()
    const request = options(root)
    const first = Buffer.from(line(header(0)) + line(event0))
    const second = Buffer.from(line(header(0)) + line(event0) + line(event1))
    await writeFile(request.sourcePath, first)
    let stats = 0
    const statFile = async (path: string) => {
      const value = await stat(path, { bigint: true })
      if (path !== request.sourcePath) return value
      stats += 1
      return stats === 2 ? { ...value, mtimeNs: value.mtimeNs + 1n } : value
    }
    const base = adapter()
    const createRestore = vi.fn((value: Record<string, unknown>) => base.createRestore(value))
    const barrier = vi.fn(async (phase: string, attempt: number) => {
      if (phase === 'before-source-check' && attempt === 1) await writeFile(request.sourcePath, second)
    })

    await expect(ensureWithOverrides(
      { ...request, format: { ...base, createRestore } },
      { fs: { stat: statFile }, barrier },
    )).rejects.toBeInstanceOf(JsonlGenerationSourceChangedError)

    expect(stats).toBeGreaterThan(2)
    expect(createRestore).toHaveBeenCalledOnce()
    expect(await readFile(request.sourcePath)).toEqual(second)
    await expect(readFile(request.currentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).every(name => !name.includes('.tmp'))).toBe(true)
  })

  it('surfaces stage cleanup failure when a changed source discards an attempt', async () => {
    const root = await tempRoot()
    const request = options(root)
    const first = Buffer.from(line(header(0)) + line(event0))
    const second = Buffer.from(line(header(0)) + line(event0) + line(event1))
    await writeFile(request.sourcePath, first)
    const cleanup = new Error('discarded stage cleanup failed')
    const barrier = async (phase: string, attempt: number) => {
      if (phase === 'before-source-check' && attempt === 1) await writeFile(request.sourcePath, second)
    }

    const failure = await ensureWithOverrides(request, {
      barrier,
      fs: {
        rm: async (path: string) => {
          if (path.includes('.tmp')) throw cleanup
          await rm(path, { force: true })
        },
      },
    }).then(() => undefined, (error: unknown) => error)
    if (!(failure instanceof AggregateError)) throw new Error('expected source and cleanup failures')
    expect(failure.errors[0]).toBeInstanceOf(JsonlGenerationSourceChangedError)
    expect(failure.errors[1]).toBe(cleanup)
    expect(await readFile(request.sourcePath)).toEqual(second)
    await expect(readFile(request.currentPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never overwrites a colliding exclusive stage name', async () => {
    const root = await tempRoot()
    const request = options(root)
    const collision = join(root, 'session.migration.collision.jsonl.tmp')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    await writeFile(collision, 'owned-by-another-attempt\n')
    const randomToken = vi.fn().mockReturnValueOnce('collision').mockReturnValue('stage')

    await ensureWithOverrides(request, { randomToken })

    expect(randomToken).toHaveBeenCalledTimes(2)
    expect(await readFile(collision, 'utf8')).toBe('owned-by-another-attempt\n')
    expect((await readdir(root)).sort()).toEqual([
      'session.jsonl',
      'session.migration.collision.jsonl.tmp',
      'session.v2.jsonl',
    ])
  })

  it('accepts an identical regular target created by another migration', async () => {
    const root = await tempRoot()
    const request = options(root)
    const source = Buffer.from(line(header(0)) + line(event0))
    const current = Buffer.from(line(header(2)) + line(event0))
    await writeFile(request.sourcePath, source)
    await writeFile(request.currentPath, current)

    const result = await ensureJsonlGenerationCurrent(request)

    expect(result).toMatchObject({ status: 'migrated', path: request.currentPath })
    expect(await readFile(request.sourcePath)).toEqual(source)
    expect(await readFile(request.currentPath)).toEqual(current)
    expect((await readdir(root)).sort()).toEqual(['session.jsonl', 'session.v2.jsonl'])
  })

  it.each(['none', 'zstd'] as const)(
    'accepts a valid append on a %s target created by another migration',
    async (compression) => {
      const root = await tempRoot()
      const request = options(root, compression)
      const source = compression === 'zstd'
        ? await encodeZstd(0, [event0])
        : Buffer.from(line(header(0)) + line(event0))
      const expected = compression === 'zstd'
        ? await encodeZstd(2, [event0])
        : Buffer.from(line(header(2)) + line(event0))
      const appended = compression === 'zstd'
        ? await compressZstdFrame(line(event1))
        : Buffer.from(line(event1))
      const winner = Buffer.concat([expected, appended])
      await writeFile(request.sourcePath, source)
      await writeFile(request.currentPath, winner)

      const result = await ensureJsonlGenerationCurrent(request)

      expect(result).toMatchObject({ status: 'migrated', path: request.currentPath })
      expect(result.snapshot.bytes).toEqual(winner)
      expect(await readFile(request.currentPath)).toEqual(winner)
    },
  )

  it('accepts an identical regular hardlink target', async () => {
    const root = await tempRoot()
    const request = options(root)
    const expected = join(root, 'expected.jsonl')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    await writeFile(expected, line(header(2)) + line(event0))
    await link(expected, request.currentPath)

    await expect(ensureJsonlGenerationCurrent(request)).resolves.toMatchObject({ path: request.currentPath })
    expect(await readFile(expected, 'utf8')).toBe(line(header(2)) + line(event0))
  })

  it.each(['different', 'malformed', 'symlink', 'directory'] as const)(
    'fails loud without altering a colliding %s target',
    async (kind) => {
      const root = await tempRoot()
      const request = options(root)
      const source = Buffer.from(line(header(0)) + line(event0))
      await writeFile(request.sourcePath, source)
      if (kind === 'different') await writeFile(request.currentPath, line(header(2)) + line(event1))
      if (kind === 'malformed') await writeFile(request.currentPath, '{not-json}\n')
      if (kind === 'symlink') await symlink(request.sourcePath, request.currentPath)
      if (kind === 'directory') await mkdir(request.currentPath)

      await expect(ensureJsonlGenerationCurrent(request)).rejects.toBeInstanceOf(
        JsonlGenerationTargetConflictError,
      )

      expect(await readFile(request.sourcePath)).toEqual(source)
      expect((await readdir(root)).every(name => !name.includes('.tmp'))).toBe(true)
    },
  )

  it('normalizes a non-Error rejection while reopening an existing target', async () => {
    const root = await tempRoot()
    let validations = 0
    const format = adapter()
    const request = {
      ...options(root, 'none', format),
      verifyCurrentFile: async (...args: Parameters<PrepareJsonlMigrationOptions['verifyCurrentFile']>) => {
        validations += 1
        if (validations === 2) throw 'non-error rejection'
        return verifier()(...args)
      },
    }
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    await writeFile(request.currentPath, line(header(2)) + line(event0))

    const failure = await ensureJsonlGenerationCurrent(request).then(
      () => undefined,
      (error: unknown) => error,
    )
    if (!(failure instanceof JsonlGenerationTargetConflictError)) throw new Error('expected target conflict')
    expect(failure.reason.message).toBe('current-generation validation failed with a non-Error rejection')
  })

  it('retains a POSIX publication after the directory sync fails', async () => {
    const root = await tempRoot()
    const request = options(root)
    const directorySyncFailure = new Error('published directory sync failed')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    let directorySyncs = 0
    const openFile = async (path: string, flags: string, mode?: number) => {
      const handle = await openWithPosixDirectorySync(path, flags, mode)
      if (path === root && flags === 'r') {
        directorySyncs += 1
        if (directorySyncs === 1) vi.spyOn(handle, 'sync').mockRejectedValueOnce(directorySyncFailure)
      }
      return handle
    }

    await expect(ensureWithOverrides(
      request,
      { platform: 'darwin', fs: { open: openFile } },
    )).rejects.toBe(directorySyncFailure)
    expect((await readdir(root)).sort()).toEqual(['session.jsonl', 'session.v2.jsonl'])

    await expect(ensureJsonlGenerationCurrent(request)).resolves.toMatchObject({ path: request.currentPath })
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
  })

  it('retains a committed generation when its post-publication stat fails', async () => {
    const root = await tempRoot()
    const request = options(root)
    const statFailure = new Error('published target stat failed')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    let targetStats = 0

    await expect(ensureWithOverrides(request, {
      fs: {
        stat: async (path) => {
          if (path === request.currentPath && ++targetStats === 1) throw statFailure
          return stat(path, { bigint: true })
        },
      },
    })).rejects.toBe(statFailure)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
    expect((await readdir(root)).every(name => !name.includes('.tmp'))).toBe(true)
  })

  it('finishes a committed publication despite later caller cancellation', async () => {
    const root = await tempRoot()
    const controller = new AbortController()
    const reason = new Error('stop after publication')
    const request = { ...options(root), signal: controller.signal }
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    await expect(ensureWithOverrides(request, {
      barrier: (phase) => {
        if (phase === 'after-publication') controller.abort(reason)
      },
    })).resolves.toMatchObject({ status: 'migrated', path: request.currentPath })
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
  })

  it('rejects a noncanonical case-insensitive collision instead of accepting its bytes', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    const failure = await ensureWithOverrides(request, {
      platform: 'darwin',
      fs: posixSimulationFs({
        link: async () => { throw fsError('EEXIST') },
        readdir: async () => ['session.V2.jsonl'],
      }),
    }).then(() => undefined, (error: unknown) => error)

    if (!(failure instanceof JsonlGenerationTargetConflictError)) throw new Error('expected target conflict')
    expect(failure.reason.message).toContain('noncanonical directory entry "session.V2.jsonl"')
    expect((await readdir(root)).every(name => !name.includes('.tmp'))).toBe(true)
  })

  it('preserves ENOENT when an exclusive-publication winner disappears', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    await expect(ensureWithOverrides(request, {
      platform: 'darwin',
      fs: posixSimulationFs({ link: async () => { throw fsError('EEXIST') } }),
    })).rejects.toMatchObject({ code: 'ENOENT', path: request.currentPath })
  })

  it('does not reopen a target after exclusive publication', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    const reads: string[] = []

    await expect(ensureWithOverrides(request, {
      fs: {
        readFile: async (path, signal) => {
          reads.push(path)
          return readFile(path, signal === undefined ? undefined : { signal })
        },
      },
    })).resolves.toMatchObject({ status: 'migrated', path: request.currentPath })
    expect(reads).not.toContain(request.currentPath)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
  })

  it('leaves a crash-style staging file inert', async () => {
    const root = await tempRoot()
    const request = options(root)
    const crashStage = join(root, 'session.migration.crash.jsonl.tmp')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    await writeFile(crashStage, line(header(99)))

    await ensureJsonlGenerationCurrent(request)

    expect(await readFile(crashStage, 'utf8')).toBe(line(header(99)))
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
  })

  it('removes an exclusively created stage when writing or syncing it fails', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    let injected = false
    const openFile = async (path: string, flags: string, mode?: number) => {
      const handle = await open(path, flags, mode)
      if (!injected && path.includes('.tmp')) {
        injected = true
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('simulated stage fsync failure'))
      }
      return handle
    }

    await expect(ensureWithOverrides(request, { fs: { open: openFile } })).rejects.toThrow(
      'simulated stage fsync failure',
    )
    expect(await readdir(root)).toEqual(['session.jsonl'])
  })

  it.each(['open', 'close', 'write-close'] as const)(
    'surfaces %s stage failures without leaving a stage',
    async (mode) => {
      const root = await tempRoot()
      const request = options(root)
      await writeFile(request.sourcePath, line(header(0)) + line(event0))
      const openFile = async (path: string, flags: string, fileMode?: number) => {
        if (mode === 'open' && flags === 'wx') throw fsError('EACCES', 'stage open denied')
        const handle = await open(path, flags, fileMode)
        if (mode === 'write-close' && path.includes('.tmp')) {
          vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('stage write failed'))
        }
        if (mode !== 'open' && path.includes('.tmp')) {
          const close = handle.close.bind(handle)
          vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
            await close()
            throw new Error('stage close failed')
          })
        }
        return handle
      }

      await expect(ensureWithOverrides(request, { fs: { open: openFile } })).rejects.toThrow(
        mode === 'open'
          ? 'stage open denied'
          : mode === 'close'
            ? 'stage close failed'
            : 'failed to write and close migration stage',
      )
      expect(await readdir(root)).toEqual(['session.jsonl'])
    },
  )

  it.each([false, true])('normalizes a non-Error stage failure (cleanup fails: %s)', async (cleanupFails) => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    const openFile = async (path: string, flags: string, mode?: number) => {
      const handle = await open(path, flags, mode)
      if (path.includes('.tmp')) vi.spyOn(handle, 'sync').mockRejectedValueOnce('non-error failure')
      return handle
    }
    const removeFile = async (path: string) => {
      if (cleanupFails && path.includes('.tmp')) throw new Error('stage cleanup failed')
      await rm(path, { force: true })
    }

    await expect(ensureWithOverrides(
      request,
      { fs: { open: openFile, rm: removeFile } },
    )).rejects.toThrow(cleanupFails
      ? 'failed to clean migration temporary'
      : 'migration stage write failed with a non-Error rejection')
  })

  it('preserves a publication failure when temporary cleanup also fails', async () => {
    const root = await tempRoot()
    const request = options(root)
    const publication = new Error('exclusive publication failed')
    const cleanup = new Error('stage cleanup failed')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    const removeFile = async (path: string) => {
      if (path.includes('.tmp')) throw cleanup
      await rm(path, { force: true })
    }

    const failure = await ensureWithOverrides(
      request,
      {
        platform: 'darwin',
        fs: posixSimulationFs({
          link: async () => { throw publication },
          rm: removeFile,
        }),
      },
    ).then(() => undefined, (error: unknown) => error)

    if (!(failure instanceof AggregateError)) throw new Error('expected an aggregate cleanup failure')
    expect(failure.errors).toEqual([publication, cleanup])
    expect(await readFile(request.sourcePath, 'utf8')).toBe(line(header(0)) + line(event0))
  })

  it('reports success after exclusive publication when redundant stage cleanup fails', async () => {
    const root = await tempRoot()
    const request = options(root)
    const cleanup = new Error('published stage cleanup failed')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    await expect(ensureWithOverrides(request, {
      platform: 'darwin',
      fs: posixSimulationFs({
        rm: async (path: string) => {
          if (path.includes('.tmp')) throw cleanup
          await rm(path, { force: true })
        },
      }),
    })).resolves.toMatchObject({ status: 'migrated', path: request.currentPath })

    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
  })

  it('surfaces candidate validation errors and cleanup errors without publishing', async () => {
    const root = await tempRoot()
    const request = {
      ...options(root),
      verifyCurrentFile: async () => { throw new Error('candidate validation failed') },
    }
    const cleanup = new Error('cleanup failed')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    const failure = await ensureWithOverrides(request, {
      fs: {
        rm: async () => { throw cleanup },
      },
    }).then(() => undefined, (error: unknown) => error)

    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate validation cleanup failure')
    expect(failure.errors[0]).toMatchObject({ message: 'candidate validation failed' })
    expect(failure.errors[1]).toBe(cleanup)
    await expect(readFile(request.currentPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['torn', 'old', 'invalid-json'] as const)(
    'rejects a %s staged candidate before publication',
    async (mode) => {
      const root = await tempRoot()
      const request = options(root)
      await writeFile(request.sourcePath, line(header(0)) + line(event0))
      const readFileForStage = async (path: string, signal?: AbortSignal) => {
        const bytes = await readFile(path, signal === undefined ? undefined : { signal })
        if (!path.includes('.tmp')) return bytes
        if (mode === 'torn') return bytes.subarray(0, -1)
        if (mode === 'old') return Buffer.from(line(header(0)) + line(event0))
        return Buffer.from(line(header(2)) + '{not-json}\n')
      }

      await expect(ensureWithOverrides(
        request,
        { fs: { readFile: readFileForStage } },
      )).rejects.toThrow(
        mode === 'torn'
          ? 'current session generation has a torn physical tail'
          : mode === 'old'
            ? 'uses log format v0, older than the supported v2'
            : 'unparsable committed event at line 1',
      )
      expect(await readdir(root)).toEqual(['session.jsonl'])
    },
  )

  it('uses Windows write-through exclusive publication without replacing the source', async () => {
    const root = await tempRoot()
    const request = options(root)
    const source = Buffer.from(line(header(0)) + line(event0))
    await writeFile(request.sourcePath, source)
    const publishNewWin32 = vi.fn(async (from: string, to: string) => { await rename(from, to) })

    await ensureWithOverrides(request, { platform: 'win32', publishNewWin32 })

    expect(publishNewWin32).toHaveBeenCalledOnce()
    expect(publishNewWin32.mock.calls[0]?.[1]).toBe(request.currentPath)
    expect(await readFile(request.sourcePath)).toEqual(source)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
  })

  it('accepts an identical target that wins Windows publication', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    const publishNewWin32 = vi.fn(async (_from: string, to: string) => {
      await writeFile(to, line(header(2)) + line(event0))
      throw fsError('EEXIST')
    })

    await expect(ensureWithOverrides(
      request,
      { platform: 'win32', publishNewWin32 },
    )).resolves.toMatchObject({ path: request.currentPath })
    expect((await readdir(root)).every(name => !name.includes('.tmp'))).toBe(true)
  })

  it('propagates non-collision Windows and POSIX publication failures', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const root = await tempRoot()
      const request = options(root)
      const failure = new Error(`${platform} publication failed`)
      await writeFile(request.sourcePath, line(header(0)) + line(event0))

      await expect(ensureWithOverrides(request, platform === 'win32'
        ? { platform, publishNewWin32: async () => { throw failure } }
        : { platform, fs: posixSimulationFs({ link: async () => { throw failure } }) }))
        .rejects.toBe(failure)
      expect(await readdir(root)).toEqual(['session.jsonl'])
    }
  })

  it('accepts an identical target that wins POSIX publication', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    let raced = false
    const linkFile = async (existingPath: string, newPath: string) => {
      await link(existingPath, newPath)
      raced = true
      throw fsError('EEXIST')
    }

    await ensureWithOverrides(
      request,
      { platform: 'darwin', fs: posixSimulationFs({ link: linkFile }) },
    )

    expect(raced).toBe(true)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(2)) + line(event0))
  })

  it('honors cancellation before reading a generation', async () => {
    const root = await tempRoot()
    const controller = new AbortController()
    const request = { ...options(root), signal: controller.signal }
    await writeFile(request.sourcePath, line(header(0)))
    controller.abort(new Error('cancelled migration'))

    await expect(ensureJsonlGenerationCurrent(request)).rejects.toThrow('cancelled migration')
    expect(await readdir(root)).toEqual(['session.jsonl'])
  })
})

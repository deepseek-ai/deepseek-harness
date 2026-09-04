import { afterEach, describe, expect, it, vi } from 'vitest'
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
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  __jsonlGenerationTest,
  ensureJsonlGenerationCurrent,
  JsonlGenerationNewerVersionError,
  JsonlGenerationTargetConflictError,
  JsonlGenerationUnsupportedMigrationError,
  type EnsureJsonlGenerationOptions,
  type JsonlCurrentGeneration,
  type JsonlGenerationFormatAdapter,
} from '../src/generation.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'
import type { JsonlCompression } from '../src/format.ts'

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
  return { type: 'session', version, id, createdAt: 1, delegationDepth: 0 }
}

const event0 = { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } }
const event1 = { type: 'turn/end', seq: 1, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }

function adapter(overrides: Partial<JsonlGenerationFormatAdapter> = {}): JsonlGenerationFormatAdapter {
  return {
    currentVersion: 1,
    migrate: (source): JsonlCurrentGeneration => ({
      header: { ...source.header, version: 1 },
      rows: source.rows,
    }),
    validateCurrent: (candidate) => {
      if (candidate.header.version !== 1) throw new Error('candidate is not v1')
    },
    ...overrides,
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
): EnsureJsonlGenerationOptions {
  return {
    sourcePath: generationPath(root, sourceVersion, compression),
    sourceVersion,
    currentPath: generationPath(root, format.currentVersion, compression),
    compression,
    format,
  }
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
  it('publishes v1 beside an immutable suffixless v0 source', async () => {
    const root = await tempRoot()
    const request = { ...options(root), signal: new AbortController().signal }
    const source = Buffer.from(line(header(0)) + line(event0))
    await writeFile(request.sourcePath, source)

    const result = await ensureJsonlGenerationCurrent(request)

    expect(result).toMatchObject({
      status: 'migrated',
      fromVersion: 0,
      toVersion: 1,
      path: request.currentPath,
      sourcePath: request.sourcePath,
    })
    expect(await readFile(request.sourcePath)).toEqual(source)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
    expect((await readdir(root)).sort()).toEqual(['session.jsonl', 'session.v1.jsonl'])
  })

  it('takes the current fast path with one read and no format callback', async () => {
    const root = await tempRoot()
    const migrate = vi.fn()
    const validateCurrent = vi.fn()
    const validateHistoricalHeader = vi.fn()
    const request = {
      ...options(root, 'none', adapter({ migrate, validateCurrent }), 1),
      validateHistoricalHeader,
    }
    const contents = line(header(1)) + line(event0)
    await writeFile(request.sourcePath, contents)
    const readStableFile = vi.fn(async (path: string, signal?: AbortSignal) =>
      readFile(path, signal === undefined ? undefined : { signal }))

    const result = await __jsonlGenerationTest.ensure(request, { fs: { readFile: readStableFile } })

    expect(result).toMatchObject({ status: 'current', version: 1, path: request.sourcePath })
    expect(readStableFile).toHaveBeenCalledOnce()
    expect(migrate).not.toHaveBeenCalled()
    expect(validateCurrent).not.toHaveBeenCalled()
    expect(validateHistoricalHeader).not.toHaveBeenCalled()
    expect(await readFile(request.sourcePath, 'utf8')).toBe(contents)
  })

  it('bounds current snapshot retries under continuous revision churn', async () => {
    const root = await tempRoot()
    const request = options(root, 'none', adapter(), 1)
    const contents = line(header(1)) + line(event0)
    await writeFile(request.sourcePath, contents)
    let revision = 0n
    const statFile = vi.fn(async (path: string) => {
      const value = await stat(path, { bigint: true })
      revision += 1n
      return { ...value, mtimeNs: value.mtimeNs + revision }
    })
    const readChangingFile = vi.fn(async () => Buffer.from(contents + line(event1)))

    const result = await __jsonlGenerationTest.ensure(request, {
      fs: { stat: statFile, readFile: readChangingFile },
    })

    expect(result.snapshot.bytes.toString('utf8')).toBe(contents)
    expect(readChangingFile).toHaveBeenCalledTimes(2)
    expect(statFile).toHaveBeenCalledTimes(3)
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
      const migrate = vi.fn()
      const validateHistoricalHeader = vi.fn(() => { throw failure })

      await expect(ensureJsonlGenerationCurrent({
        ...request,
        format: adapter({ migrate }),
        validateHistoricalHeader,
      })).rejects.toBe(failure)

      expect(validateHistoricalHeader).toHaveBeenCalledWith(expect.objectContaining({ id: 'generation-test' }))
      expect(migrate).not.toHaveBeenCalled()
      expect(await readFile(request.sourcePath)).toEqual(source)
      expect(await readdir(root)).toEqual([basename(request.sourcePath)])
    },
  )

  it('awaits asynchronous historical-header validation before migration', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    const order: string[] = []

    await ensureJsonlGenerationCurrent({
      ...request,
      format: adapter({
        migrate: (source) => {
          order.push('migrate')
          return { header: { ...source.header, version: 1 }, rows: source.rows }
        },
      }),
      validateHistoricalHeader: async () => {
        await Promise.resolve()
        order.push('validate')
      },
    })

    expect(order).toEqual(['validate', 'migrate'])
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

  it('rejects malformed and future version discriminators before migration', async () => {
    const root = await tempRoot()
    const malformed = options(join(root, 'malformed'))
    const future = options(join(root, 'future'), 'none', adapter(), 2)
    await mkdir(join(root, 'malformed'))
    await mkdir(join(root, 'future'))
    await writeFile(malformed.sourcePath, line(header(-1)))
    await writeFile(future.sourcePath, line(header(2, 'future-id')))

    await expect(ensureJsonlGenerationCurrent(malformed)).rejects.toThrow(
      'header version is not a non-negative safe integer',
    )
    await expect(ensureJsonlGenerationCurrent(future)).rejects.toMatchObject({
      name: 'JsonlGenerationNewerVersionError',
      storedVersion: 2,
      currentVersion: 1,
      storedId: 'future-id',
    } satisfies Partial<JsonlGenerationNewerVersionError>)
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
      migrate: () => { throw blocked },
      isUnsupportedMigrationError: (error): error is Error => error === blocked,
    })))).rejects.toMatchObject({
      name: 'JsonlGenerationUnsupportedMigrationError',
      fromVersion: 0,
      reason: blocked,
    } satisfies Partial<JsonlGenerationUnsupportedMigrationError>)
    await expect(ensureJsonlGenerationCurrent(options(ordinaryRoot, 'none', adapter({
      migrate: () => { throw ordinary },
    })))).rejects.toBe(ordinary)
    await expect(ensureJsonlGenerationCurrent(options(wrongRoot, 'none', adapter({
      migrate: source => ({ header: { ...source.header, version: 2 }, rows: source.rows }),
    })))).rejects.toThrow('format migration returned v2, expected v1')
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
          migrate: source => ({ header: { ...source.header, version: 1 }, rows: [value] }),
        }),
      })).rejects.toThrow('migrated session row 1 is not lossless JSON')
      expect(await readdir(root), name).toEqual(['session.jsonl'])
    }
  })

  it('publishes only the final generation across a multi-edge migration', async () => {
    const root = await tempRoot()
    const format = adapter({
      currentVersion: 3,
      migrate: source => ({ header: { ...source.header, version: 3 }, rows: source.rows }),
      validateCurrent: (candidate) => {
        if (candidate.header.version !== 3) throw new Error('candidate is not v3')
      },
    })
    const request = options(root, 'none', format, 1)
    const source = Buffer.from(line(header(1)) + line(event0))
    await writeFile(request.sourcePath, source)
    const sourceBefore = await stat(request.sourcePath, { bigint: true })

    await ensureJsonlGenerationCurrent(request)

    expect(await readFile(request.sourcePath)).toEqual(source)
    const sourceAfter = await stat(request.sourcePath, { bigint: true })
    expect([sourceAfter.dev, sourceAfter.ino]).toEqual([sourceBefore.dev, sourceBefore.ino])
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(3)) + line(event0))
    expect((await readdir(root)).sort()).toEqual(['session.v1.jsonl', 'session.v3.jsonl'])
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
      expect(currentText).toBe(line(header(1)) + line(event0))
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

    expect(await decodeZstdJsonl(headerRequest.currentPath)).toBe(line(header(1)))
    expect(await decodeZstdJsonl(emptyTailRequest.currentPath)).toBe(line(header(1)))
    expect(await decodeZstdJsonl(tornRequest.currentPath)).toBe(line(header(1)) + line(event0) + line(event1))
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
    expect(await readFile(dropped.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
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
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
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
        request: { ...options(root), currentPath: join(root, 'session.V1.jsonl') },
        message: 'current JSONL generation path must end with "session.v1.jsonl"',
      },
      {
        request: { ...options(root), currentPath: generationPath(other, 1, 'none') },
        message: 'must share one Session directory',
      },
    ]
    await writeFile(generationPath(root, 0, 'none'), source)

    for (const { request, message } of cases) {
      await expect(ensureJsonlGenerationCurrent(request)).rejects.toThrow(message)
    }
  })

  it('retries a bracketed physical read and a source changed before publication', async () => {
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
    const migrate = vi.fn((source: Parameters<JsonlGenerationFormatAdapter['migrate']>[0]) =>
      adapter().migrate(source))
    const barrier = vi.fn(async (phase: string, attempt: number) => {
      if (phase === 'before-source-check' && attempt === 1) await writeFile(request.sourcePath, second)
    })

    await __jsonlGenerationTest.ensure(
      { ...request, format: adapter({ migrate }) },
      { fs: { stat: statFile }, barrier },
    )

    expect(stats).toBeGreaterThan(2)
    expect(migrate).toHaveBeenCalledTimes(2)
    expect(await readFile(request.sourcePath)).toEqual(second)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0) + line(event1))
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

    await expect(__jsonlGenerationTest.ensure(request, {
      barrier,
      fs: {
        rm: async (path: string) => {
          if (path.includes('.tmp')) throw cleanup
          await rm(path, { force: true })
        },
      },
    })).rejects.toBe(cleanup)
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

    await __jsonlGenerationTest.ensure(request, { randomToken })

    expect(randomToken).toHaveBeenCalledTimes(2)
    expect(await readFile(collision, 'utf8')).toBe('owned-by-another-attempt\n')
    expect((await readdir(root)).sort()).toEqual([
      'session.jsonl',
      'session.migration.collision.jsonl.tmp',
      'session.v1.jsonl',
    ])
  })

  it('accepts an identical regular target created by another migration', async () => {
    const root = await tempRoot()
    const request = options(root)
    const source = Buffer.from(line(header(0)) + line(event0))
    const current = Buffer.from(line(header(1)) + line(event0))
    await writeFile(request.sourcePath, source)
    await writeFile(request.currentPath, current)

    const result = await ensureJsonlGenerationCurrent(request)

    expect(result).toMatchObject({ status: 'migrated', path: request.currentPath })
    expect(await readFile(request.sourcePath)).toEqual(source)
    expect(await readFile(request.currentPath)).toEqual(current)
    expect((await readdir(root)).sort()).toEqual(['session.jsonl', 'session.v1.jsonl'])
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
        ? await encodeZstd(1, [event0])
        : Buffer.from(line(header(1)) + line(event0))
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
    await writeFile(expected, line(header(1)) + line(event0))
    await link(expected, request.currentPath)

    await expect(ensureJsonlGenerationCurrent(request)).resolves.toMatchObject({ path: request.currentPath })
    expect(await readFile(expected, 'utf8')).toBe(line(header(1)) + line(event0))
  })

  it.each(['different', 'malformed', 'symlink', 'directory'] as const)(
    'fails loud without altering a colliding %s target',
    async (kind) => {
      const root = await tempRoot()
      const request = options(root)
      const source = Buffer.from(line(header(0)) + line(event0))
      await writeFile(request.sourcePath, source)
      if (kind === 'different') await writeFile(request.currentPath, line(header(1)) + line(event1))
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
    const format = adapter({
      validateCurrent: () => {
        validations += 1
        if (validations === 2) throw 'non-error rejection'
      },
    })
    const request = options(root, 'none', format)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    await writeFile(request.currentPath, line(header(1)) + line(event0))

    const failure = await ensureJsonlGenerationCurrent(request).then(
      () => undefined,
      (error: unknown) => error,
    )
    if (!(failure instanceof JsonlGenerationTargetConflictError)) throw new Error('expected target conflict')
    expect(failure.reason.message).toBe('current-generation validation failed with a non-Error rejection')
  })

  it('leaves source and published target immutable when committed reopen rejects it', async () => {
    const root = await tempRoot()
    let validations = 0
    const format = adapter({
      validateCurrent: (candidate) => {
        adapter().validateCurrent(candidate)
        validations += 1
        if (validations === 2) throw new Error('committed reopen rejected')
      },
    })
    const request = options(root, 'none', format)
    const source = Buffer.from(line(header(0)) + line(event0))
    await writeFile(request.sourcePath, source)

    const failure = await ensureJsonlGenerationCurrent(request).then(
      () => undefined,
      (error: unknown) => error,
    )
    if (!(failure instanceof JsonlGenerationTargetConflictError)) throw new Error('expected target conflict')
    expect(failure.reason.message).toBe('committed reopen rejected')

    expect(await readFile(request.sourcePath)).toEqual(source)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
  })

  it('reopens the target after publication instead of trusting staged validation', async () => {
    const root = await tempRoot()
    const validateCurrent = vi.fn((candidate: JsonlCurrentGeneration) => {
      adapter().validateCurrent(candidate)
    })
    const barrier = vi.fn()
    const request = options(root, 'none', adapter({ validateCurrent }))
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    await __jsonlGenerationTest.ensure(request, { barrier })

    expect(validateCurrent).toHaveBeenCalledTimes(2)
    expect(barrier).toHaveBeenCalledWith('after-publication', 1)
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

    await expect(__jsonlGenerationTest.ensure(
      request,
      { platform: 'darwin', fs: { open: openFile } },
    )).rejects.toBe(directorySyncFailure)
    expect((await readdir(root)).sort()).toEqual(['session.jsonl', 'session.v1.jsonl'])

    await expect(ensureJsonlGenerationCurrent(request)).resolves.toMatchObject({ path: request.currentPath })
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
  })

  it('rethrows the exact abort reason after publication and leaves the committed target', async () => {
    const root = await tempRoot()
    const controller = new AbortController()
    const reason = new Error('stop after publication')
    const request = { ...options(root), signal: controller.signal }
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    await expect(__jsonlGenerationTest.ensure(request, {
      barrier: (phase) => {
        if (phase === 'after-publication') controller.abort(reason)
      },
    })).rejects.toBe(reason)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
  })

  it('rejects a noncanonical case-insensitive collision instead of accepting its bytes', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    const failure = await __jsonlGenerationTest.ensure(request, {
      platform: 'darwin',
      fs: posixSimulationFs({
        link: async () => { throw fsError('EEXIST') },
        readdir: async () => ['session.V1.jsonl'],
      }),
    }).then(() => undefined, (error: unknown) => error)

    if (!(failure instanceof JsonlGenerationTargetConflictError)) throw new Error('expected target conflict')
    expect(failure.reason.message).toContain('noncanonical directory entry "session.V1.jsonl"')
    expect((await readdir(root)).every(name => !name.includes('.tmp'))).toBe(true)
  })

  it('preserves ENOENT when an exclusive-publication winner disappears', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    await expect(__jsonlGenerationTest.ensure(request, {
      platform: 'darwin',
      fs: posixSimulationFs({ link: async () => { throw fsError('EEXIST') } }),
    })).rejects.toMatchObject({ code: 'ENOENT', path: request.currentPath })
  })

  it('preserves a filesystem error while reopening a committed target', async () => {
    const root = await tempRoot()
    const request = options(root)
    const failure = fsError('EACCES', 'current target is unreadable')
    failure.path = request.currentPath
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    await expect(__jsonlGenerationTest.ensure(request, {
      fs: {
        readFile: async (path, signal) => {
          if (path === request.currentPath) throw failure
          return readFile(path, signal === undefined ? undefined : { signal })
        },
      },
    })).rejects.toBe(failure)
  })

  it('rethrows the exact abort reason during committed reopen and leaves the target', async () => {
    const root = await tempRoot()
    const controller = new AbortController()
    const reason = new Error('stop during committed reopen')
    const request = { ...options(root), signal: controller.signal }
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    await expect(__jsonlGenerationTest.ensure(request, {
      fs: {
        readFile: async (path, signal) => {
          if (path === request.currentPath) controller.abort(reason)
          return readFile(path, signal === undefined ? undefined : { signal })
        },
      },
    })).rejects.toBe(reason)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
  })

  it('leaves a crash-style staging file inert', async () => {
    const root = await tempRoot()
    const request = options(root)
    const crashStage = join(root, 'session.migration.crash.jsonl.tmp')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    await writeFile(crashStage, line(header(99)))

    await ensureJsonlGenerationCurrent(request)

    expect(await readFile(crashStage, 'utf8')).toBe(line(header(99)))
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
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

    await expect(__jsonlGenerationTest.ensure(request, { fs: { open: openFile } })).rejects.toThrow(
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

      await expect(__jsonlGenerationTest.ensure(request, { fs: { open: openFile } })).rejects.toThrow(
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

    await expect(__jsonlGenerationTest.ensure(
      request,
      { fs: { open: openFile, rm: removeFile } },
    )).rejects.toThrow(cleanupFails
      ? 'failed to clean migration stage'
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

    const failure = await __jsonlGenerationTest.ensure(
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

    await expect(__jsonlGenerationTest.ensure(request, {
      platform: 'darwin',
      fs: posixSimulationFs({
        rm: async (path: string) => {
          if (path.includes('.tmp')) throw cleanup
          await rm(path, { force: true })
        },
      }),
    })).resolves.toMatchObject({ status: 'migrated', path: request.currentPath })

    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
  })

  it('surfaces candidate validation errors and cleanup errors without publishing', async () => {
    const root = await tempRoot()
    const request = options(root, 'none', adapter({
      validateCurrent: () => { throw new Error('candidate validation failed') },
    }))
    const cleanup = new Error('cleanup failed')
    await writeFile(request.sourcePath, line(header(0)) + line(event0))

    const failure = await __jsonlGenerationTest.ensure(request, {
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
        return Buffer.from(line(header(1)) + '{not-json}\n')
      }

      await expect(__jsonlGenerationTest.ensure(
        request,
        { fs: { readFile: readFileForStage } },
      )).rejects.toThrow(
        mode === 'torn'
          ? 'staged current session generation has a torn physical tail'
          : mode === 'old'
            ? 'staged session generation is not current v1'
            : 'row 1 is not valid JSON',
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

    await __jsonlGenerationTest.ensure(request, { platform: 'win32', publishNewWin32 })

    expect(publishNewWin32).toHaveBeenCalledOnce()
    expect(publishNewWin32.mock.calls[0]?.[1]).toBe(request.currentPath)
    expect(await readFile(request.sourcePath)).toEqual(source)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
  })

  it('accepts an identical target that wins Windows publication', async () => {
    const root = await tempRoot()
    const request = options(root)
    await writeFile(request.sourcePath, line(header(0)) + line(event0))
    const publishNewWin32 = vi.fn(async (_from: string, to: string) => {
      await writeFile(to, line(header(1)) + line(event0))
      throw fsError('EEXIST')
    })

    await expect(__jsonlGenerationTest.ensure(
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

      await expect(__jsonlGenerationTest.ensure(request, platform === 'win32'
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

    await __jsonlGenerationTest.ensure(
      request,
      { platform: 'darwin', fs: posixSimulationFs({ link: linkFile }) },
    )

    expect(raced).toBe(true)
    expect(await readFile(request.currentPath, 'utf8')).toBe(line(header(1)) + line(event0))
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

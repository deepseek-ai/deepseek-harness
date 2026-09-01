import { MessageId, createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  encodeSegment, eventLines, logPath, projectDir, projectKey, scanLog, sessionDir, SessionLogScanner, toHeaderLine,
} from '../src/format.ts'
import { runPersistenceContract, meta, oneTurnLog, appendLog } from '../../session-persistence/tests/contract.ts'
import { runCoordinatorContract, type CoordinatorFixture } from '../../session-persistence/tests/coordinator-contract.ts'

const statRace = vi.hoisted(() => ({
  path: undefined as string | undefined,
  reads: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      const identity = await actual.stat(...args)
      if (String(args[0]) !== statRace.path || !('mtimeNs' in identity)) return identity
      statRace.reads += 1
      if (statRace.reads !== 2) return identity
      return { ...identity, mtimeNs: identity.mtimeNs + 1n }
    }) as typeof actual.stat,
  }
})

let root: string
const dirs: string[] = []

type MutableSessionHeader = { -readonly [K in keyof SessionHeader]: SessionHeader[K] }

/** Test-only mutable view used to verify that backends detach returned/caller metadata. */
function mutableHeader(header: SessionHeader): MutableSessionHeader {
  return header
}

/** Rewrite only a stored header while preserving every event byte below it. */
async function rewriteHeader(path: string, update: (header: Record<string, unknown>) => void): Promise<void> {
  const lines = (await readFile(path, 'utf8')).split('\n')
  const header = JSON.parse(lines[0] as string) as Record<string, unknown>
  update(header)
  lines[0] = JSON.stringify(header)
  await writeFile(path, lines.join('\n'))
}

async function expectFlushError(promise: Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(message)
    return
  }
  throw new Error('expected flush to reject')
}

async function expectFlushCode(promise: Promise<unknown>, codes: readonly string[]): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(codes).toContain((error as NodeJS.ErrnoException).code)
    return
  }
  throw new Error('expected flush to reject')
}

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-'))
  dirs.push(dir)
  return dir
}

function rawLogPath(root: string, cwd: string | undefined, id: SessionId): string {
  return logPath(root, cwd, id, 'none')
}

afterEach(async () => {
  statRace.path = undefined
  statRace.reads = 0
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

function appendClosedTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

runPersistenceContract('jsonl-none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => {
      await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
})

// Two mounts share this temp root to exercise reload. `corruptTail` appends a partial,
// newline-less fragment past the committed region so coordinator repair runs on real file bytes.
runCoordinatorContract('jsonl-none', async (): Promise<CoordinatorFixture> => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-coord-'))
  return {
    mount: async (ctx) => {
      const fiber = await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
      return fiber
    },
    corruptTail: async (id, cwd) => {
      // A half-written record with no trailing newline: scanLog treats it as an
      // uncommitted crash fragment and reports committedBytes < byteLength, so
      // the coordinator sees a tornMarker to truncate.
      await appendFile(rawLogPath(dir, cwd, id), '{"type":"assistant/chunk","seq":8,"ti')
    },
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
})

describe('JsonlSessionPersistence: format helpers', () => {
  it('encodeSegment neutralizes traversal, separators, and absolute paths', () => {
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('a/b')).toBe('a~002Fb')
    expect(encodeSegment('/etc/passwd')).toBe('~002Fetc~002Fpasswd')
    expect(encodeSegment('a\u0000b')).toBe('a~0000b')
    expect(encodeSegment('plain-ID_1.2')).toBe('plain-ID_1.2') // safe chars pass through
    expect(encodeSegment('a~b')).toBe('a~007Eb') // ~ itself is escaped
  })

  it('encodeSegment is injective over UTF-16, incl. lone surrogates', () => {
    // Distinct lone surrogates must NOT collide (Buffer.from would normalize
    // both to U+FFFD; code-unit escaping keeps them distinct).
    const hi = encodeSegment(String.fromCharCode(0xD800))
    const lo = encodeSegment(String.fromCharCode(0xDC00))
    expect(hi).toBe('~D800')
    expect(lo).toBe('~DC00')
    expect(hi).not.toBe(lo)
    // A literal "~002F" input cannot collide with the encoding of "/".
    expect(encodeSegment('~002F')).not.toBe(encodeSegment('/'))
  })

  it('encodeSegment rejects an empty id', () => {
    expect(() => encodeSegment('')).toThrow(/empty/)
  })

  it('projectKey normalizes project paths into bounded readable names', () => {
    expect(projectKey('/Users/qyj/work/deepseek-harness')).toBe('--Users-qyj-work-deepseek-harness--')
    expect(projectKey('/a/b-c')).toBe(projectKey('/a-b/c'))
    expect(projectKey('C:\\work\\agent')).toBe('--C-work-agent--')
    expect(projectKey('/开发/~agent')).toBe('--~5F00~53D1-~007Eagent--')
    expect(projectKey('/')).toBe('--root--')
    expect(projectKey('/' + 'x'.repeat(1_000))).toHaveLength(255)
    expect(() => projectKey('')).toThrow(/empty project path/)
  })

  it('resolves a relative custom root before locating a session', async () => {
    const absoluteRoot = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(JsonlSessionPersistence, {
      root: relative(process.cwd(), absoluteRoot),
      compression: 'none',
      writeBatchMaxDelayMs: 1,
    })
    const m = meta('relative-location', '/work')
    expect(ctx.sessionPersistence.locate(m)).toEqual({
      kind: 'jsonl',
      path: rawLogPath(resolve(absoluteRoot), '/work', m.id),
    })
    await fiber.dispose()
  })

  it('refuses a structurally foreign future header as unsupported, not corrupt', async () => {
    const absoluteRoot = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root: absoluteRoot, compression: 'none' })
    // A future format need not satisfy this build's header shape at all (no
    // createdAt, unknown fields): the version must be refused before shape
    // validation, so the user sees the upgrade direction.
    const id = SessionId('future-shape')
    const path = rawLogPath(resolve(absoluteRoot), '/work', id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ type: 'session', version: 42, id, futureOnly: true })}\n{"future":"row"}\n`)
    const failure = await ctx.sessionPersistence.load(id).then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.name).toBe('SessionFormatUnsupportedError')
    expect(failure?.message).toMatch(/written by a newer harness.*upgrade the harness/)
    expect(failure?.message).toContain(`(raw log: ${path})`)
    await fiber.dispose()
  })

  it('keeps a non-object header line a corruption, not a format refusal', async () => {
    const absoluteRoot = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root: absoluteRoot, compression: 'none' })
    // Valid JSON that is no object carries no version to compare, so the
    // version guard must pass it through to the corruption diagnostics.
    const id = SessionId('scalar-header')
    const path = rawLogPath(resolve(absoluteRoot), '/work', id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '42\n')
    const failure = await ctx.sessionPersistence.load(id).then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.name).not.toBe('SessionFormatUnsupportedError')
    expect(failure?.message).toContain('first line is not a session header')
    await fiber.dispose()
  })

  it('names a foreign-version header by its stringified non-string id', async () => {
    const absoluteRoot = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root: absoluteRoot, compression: 'none' })
    // A future header's id field is as untrusted as the rest of its shape:
    // the refusal must still name the session it read, not crash on the type.
    const id = SessionId('numeric-id')
    const path = rawLogPath(resolve(absoluteRoot), '/work', id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ type: 'session', version: 42, id: 123 })}\n`)
    const failure = await ctx.sessionPersistence.load(id).then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.name).toBe('SessionFormatUnsupportedError')
    expect(failure?.message).toContain('session "123" uses log format v42')
    await fiber.dispose()
  })

  it('points a format refusal at the raw log path', async () => {
    const absoluteRoot = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root: absoluteRoot, compression: 'none' })
    const m = { ...meta('newer-format', '/work'), version: 7 }
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const failure = await ctx.sessionPersistence.load(m.id).then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.name).toBe('SessionFormatUnsupportedError')
    expect(failure?.message).toContain(`(raw log: ${rawLogPath(resolve(absoluteRoot), '/work', m.id)})`)
    await fiber.dispose()
  })
})

describe('JsonlSessionPersistence: durability and crash semantics', () => {
  let ctx: Context
  beforeEach(async () => {
    root = await freshRoot()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  it('lazy materialization: create() writes no file until the first append', async () => {
    const m = meta('lazy', '/work')
    const location = ctx.sessionPersistence.locate(m)
    expect(location).toEqual({ kind: 'jsonl', path: rawLogPath(root, '/work', m.id) })
    expect(isAbsolute(location!.path)).toBe(true)

    await ctx.sessionPersistence.create(m)
    // locate() is a pure target-path calculation: neither it nor create()
    // materializes a file before the first append.
    const dir = sessionDir(root, '/work', m.id)
    await expect(stat(rawLogPath(root, '/work', m.id))).rejects.toThrow()
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).not.toContain(m.id)

    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect((await stat(rawLogPath(root, '/work', m.id))).isFile()).toBe(true)
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).toContain(m.id)
  })

  it('materializes an explicitly durable empty live session without an event row', async () => {
    const id = SessionId('durable-empty')
    const session = ctx.sessions.create(id, { meta: { cwd: '/work' } })

    await ctx.sessionPersistence.ensureMaterialized(session)

    expect(await readFile(rawLogPath(root, '/work', id), 'utf8')).toBe(`${JSON.stringify(toHeaderLine(session.header))}\n`)
    await expect(ctx.sessionPersistence.load(id)).resolves.toEqual({ meta: session.header, events: [] })
  })

  it('delegates direct preparation through the JSONL provider', async () => {
    const m = meta('direct-prepare', '/work')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())

    const preparation = await ctx.sessionPersistence.prepare(m.id)

    expect(preparation.session.header).toMatchObject(m)
    preparation[Symbol.dispose]()
  })

  it('readRaw returns the stored artifact text verbatim with its original filename', async () => {
    const m = meta('raw-read', '/work')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const raw = await ctx.sessionPersistence.readRaw(m.id)
    expect(raw).toBeDefined()
    expect(raw!.filename).toBe('session.jsonl')
    expect(raw!.meta.id).toBe(m.id)
    // Byte-identical to the physical file — never a reconstruction.
    expect(raw!.content).toBe(await readFile(rawLogPath(root, '/work', m.id), 'utf8'))
    expect(raw!.content.split('\n')[0]).toBe(JSON.stringify(toHeaderLine(m)))
    const scanned = scanLog(Buffer.from(raw!.content))
    expect(scanned.events.map(event => event.type)).toEqual(oneTurnLog().map(event => event.type))
  })

  it('readRaw is undefined for an absent session', async () => {
    const m = meta('raw-missing', '/work')
    expect(await ctx.sessionPersistence.readRaw(m.id)).toBeUndefined()
  })

  it('readRaw rejects a corrupt header line instead of exporting it', async () => {
    const m = meta('raw-corrupt', '/work')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    await writeFile(rawLogPath(root, '/work', m.id), 'not a header line\n{"type":"turn/start","seq":0}\n')
    await expect(ctx.sessionPersistence.readRaw(m.id)).rejects.toThrow(/corrupt session log/)
  })

  it('readRaw retries when the file revision changes during the read', async () => {
    const m = meta('raw-revision-race', '/work')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    statRace.path = rawLogPath(root, '/work', m.id)

    const raw = await ctx.sessionPersistence.readRaw(m.id)
    expect(raw).toBeDefined()
    // Two stat calls per iteration; the mocked revision change forces a retry.
    expect(statRace.reads).toBe(4)
  })

  it('keeps the same location on resume and gives a fork its own location', async () => {
    const parent = meta('location-parent', '/work')
    const parentLocation = ctx.sessionPersistence.locate(parent)
    await ctx.sessionPersistence.create(parent)
    await ctx.sessionPersistence.append(parent.id, oneTurnLog())

    const loaded = await ctx.sessionPersistence.load(parent.id)
    expect(ctx.sessionPersistence.locate(loaded.meta)).toEqual(parentLocation)

    const child = {
      ...loaded.meta,
      id: SessionId('location-child'),
      parentSession: parent.id,
      seedLength: loaded.events.length,
    }
    const childLocation = ctx.sessionPersistence.locate(child)
    expect(childLocation?.path).not.toBe(parentLocation?.path)
    expect(childLocation).toEqual({ kind: 'jsonl', path: rawLogPath(root, '/work', child.id) })
  })

  it('round-trip is byte-identical (incl. assistant/chunk verbatim)', async () => {
    const m = meta('chunks')
    const log: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'he' } } },
      { type: 'assistant/chunk', seq: 3, time: 4, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'llo' } } },
      { type: 'assistant/message', seq: 4, time: 5, data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      }, surfaceOp: 'append', sourceEventSeqs: [2, 3] },
      { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, log)
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toEqual(log) // chunks preserved, contiguous seqs
  })

  it('source-qualifies revisions across roots while preserving same-log reopen identity', async () => {
    const m = meta('revision-source')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const revision = (await ctx.sessionPersistence.listSnapshots())[0]?.revision

    const reopenedCtx = new Context()
    await reopenedCtx.plugin(SessionStore)
    await reopenedCtx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    expect((await reopenedCtx.sessionPersistence.listSnapshots())[0]?.revision).toBe(revision)

    const otherRoot = await freshRoot()
    const otherCtx = new Context()
    await otherCtx.plugin(SessionStore)
    await otherCtx.plugin(JsonlSessionPersistence, { root: otherRoot, compression: 'none' })
    await otherCtx.sessionPersistence.create(m)
    await otherCtx.sessionPersistence.append(m.id, oneTurnLog())
    expect((await otherCtx.sessionPersistence.listSnapshots())[0]?.revision).not.toBe(revision)

    await reopenedCtx.fiber.dispose()
    await otherCtx.fiber.dispose()
  })

  it('binds a full stored prefix to the same revision as a lightweight read', async () => {
    const m = meta('stored-prefix-revision')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const persistence = ctx.sessionPersistence as JsonlSessionPersistence

    const stored = await persistence.loadStored(m.id)
    expect(stored?.revision).toBe(await persistence.readStoredRevision(m.id))
    expect(await persistence.readStoredRevision(SessionId('missing-revision'))).toBeUndefined()
  })

  it('retries a full-prefix read when the file revision changes during the read', async () => {
    const m = meta('stored-prefix-revision-race')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const persistence = ctx.sessionPersistence as JsonlSessionPersistence
    statRace.path = rawLogPath(root, m.cwd, m.id)

    await expect(persistence.loadStored(m.id)).resolves.toMatchObject({ events: oneTurnLog() })
    expect(statRace.reads).toBe(4)
  })

  it('handles revision-stat races and errors after log discovery', async () => {
    const m = meta('stored-revision-race')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const persistence = ctx.sessionPersistence as JsonlSessionPersistence
    const internals = persistence as unknown as {
      findLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
    }
    const path = rawLogPath(root, m.cwd, m.id)
    const findLog = vi.spyOn(internals, 'findLog').mockResolvedValue(path)

    await rm(path)
    expect(await persistence.readStoredRevision(m.id)).toBeUndefined()

    const invalidPath = `${path}\0`
    findLog.mockResolvedValue(invalidPath)
    await expect(persistence.readStoredRevision(m.id)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARG_VALUE',
    })

    const reason = new Error('revision read cancelled after discovery')
    const controller = new AbortController()
    findLog.mockImplementation(async () => {
      controller.abort(reason)
      return invalidPath
    })
    await expect(persistence.readStoredRevision(m.id, controller.signal)).rejects.toBe(reason)
  })

  it('omits a snapshot artifact removed after discovery', async () => {
    const m = meta('vanishing-snapshot')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const persistence = ctx.sessionPersistence as unknown as {
      listArtifacts(): Promise<Array<{ header: SessionHeader; path: string }>>
    }
    const listArtifacts = persistence.listArtifacts.bind(persistence)
    const discovery = vi.spyOn(persistence, 'listArtifacts').mockImplementation(async () => {
      const artifacts = await listArtifacts()
      await rm(artifacts[0]!.path)
      return artifacts
    })

    await expect(ctx.sessionPersistence.listSnapshots()).resolves.toEqual([])
    discovery.mockRestore()
  })

  it('surfaces non-ENOENT snapshot stat failures after discovery', async () => {
    const persistence = ctx.sessionPersistence as unknown as {
      listArtifacts(): Promise<Array<{ header: SessionHeader; path: string }>>
    }
    const discovery = vi.spyOn(persistence, 'listArtifacts').mockResolvedValue([{
      header: meta('snapshot-stat-failure'),
      path: `${root}\0snapshot-stat-failure`,
    }])

    await expect(ctx.sessionPersistence.listSnapshots()).rejects.toThrow(/null bytes/)
    discovery.mockRestore()
  })

  it('forwards snapshot-list cancellation and awaits in-flight discovery cleanup', async () => {
    const persistence = ctx.sessionPersistence as unknown as {
      listArtifacts(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; path: string }>>
    }
    const started = Promise.withResolvers<AbortSignal>()
    const cleanup = Promise.withResolvers<undefined>()
    vi.spyOn(persistence, 'listArtifacts').mockImplementation(async (signal) => {
      if (signal === undefined) throw new Error('expected snapshot-list signal')
      started.resolve(signal)
      await cleanup.promise
      return []
    })
    const reason = new Error('JSONL snapshot discovery cancelled')
    const controller = new AbortController()
    const pending = ctx.sessionPersistence.listSnapshots(controller.signal)
    expect(await started.promise).toBe(controller.signal)
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )

    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)

    cleanup.resolve(undefined)
    await expect(pending).rejects.toBe(reason)
  })

  it('checks cancellation after an uncancellable snapshot stat settles', async () => {
    const m = meta('snapshot-stat-cancellation')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const persistence = ctx.sessionPersistence as unknown as {
      listArtifacts(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; path: string }>>
    }
    const discovery = vi.spyOn(persistence, 'listArtifacts').mockResolvedValue([{
      header: m,
      path: rawLogPath(root, m.cwd, m.id),
    }])
    const reason = new Error('JSONL snapshot stat cancelled')
    const controller = new AbortController()
    const pending = ctx.sessionPersistence.listSnapshots(controller.signal)
    queueMicrotask(() => { controller.abort(reason) })

    await expect(pending).rejects.toBe(reason)
    expect(discovery).toHaveBeenCalledWith(controller.signal)
  })

  it('rejects a stored v0 log containing a legacy request/header-delta event', async () => {
    const m = meta('legacy-header-delta', '/legacy')
    const path = rawLogPath(root, m.cwd, m.id)
    await mkdir(sessionDir(root, m.cwd, m.id), { recursive: true })
    await writeFile(path, [
      JSON.stringify(toHeaderLine(m)),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'request/header-delta', seq: 1, time: 2, data: { config: { model: 'legacy' } } }),
      JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
      '',
    ].join('\n'))

    await expect(ctx.sessionPersistence.load(m.id)).rejects.toThrow(/unsupported legacy request\/header-delta event at seq 1/)
  })

  it('rejects a stored v0 full header carrying the legacy fallback reason', async () => {
    const m = meta('legacy-header-fallback', '/legacy')
    const path = rawLogPath(root, m.cwd, m.id)
    await mkdir(sessionDir(root, m.cwd, m.id), { recursive: true })
    await writeFile(path, [
      JSON.stringify(toHeaderLine(m)),
      JSON.stringify({
        type: 'request/header',
        seq: 0,
        time: 1,
        data: { header: { config: { model: 'legacy' } }, reason: 'fallback' },
      }),
      '',
    ].join('\n'))

    await expect(ctx.sessionPersistence.load(m.id))
      .rejects.toThrow(/unsupported legacy request\/header reason "fallback" at seq 0/)
  })

  it('persists a forked child seed through the existing session write path', async () => {
    const source = ctx.sessions.create(SessionId('persist-parent'), { meta: { cwd: '/workspace' } })
    appendClosedTurn(source)

    const child = ctx.sessions.fork(source, undefined, SessionId('persist-child'))
    await ctx.sessions.flush(child)
    const loaded = await ctx.sessionPersistence.load(child.id)

    // The constructor seed reaches disk verbatim, then the child's end-seed.
    expect(loaded.events.slice(0, source.snapshotEvents().length)).toEqual(source.snapshotEvents())
    expect(loaded.events.at(-1)).toMatchObject({ type: 'session/end-seed', seq: source.snapshotEvents().length })
    expect(loaded.meta).toMatchObject({
      id: SessionId('persist-child'),
      cwd: '/workspace',
      parentSession: SessionId('persist-parent'),
      seedLength: source.snapshotEvents().length,
    })
  })

  it('crash recovery: load preserves the interrupted turn and closes it with a synthetic turn/end {interrupted}', async () => {
    const m = meta('crash', '/proj')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog()) // seqs 0..5, turn/end at 5

    // Simulate a crash mid-second-turn: append raw lines that are NOT closed by
    // a turn/end (turn/start + step/start are fully written), plus a final
    // partial line with no newline (a torn fragment never fully flushed).
    const path = rawLogPath(root, '/proj', m.id)
    await writeFile(path, [
      JSON.stringify({ type: 'turn/start', seq: 6, time: 8, data: { turn: 2 } }),
      JSON.stringify({ type: 'step/start', seq: 7, time: 9, data: { turn: 2, step: 1 } }),
      '{"type":"assistant/chunk","seq":8,"ti', // truncated partial line (no newline)
    ].join('\n'), { flag: 'a' })

    // load PRESERVES the interrupted turn's real events (turn/start 6, step/start
    // 7) — a turn can be huge, so they must not be truncated — and durably closes
    // the orphaned turn with synthetic step/end (8) + turn/end {interrupted} (9).
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const last = loaded.events.at(-1)!
    expect(last.type === 'turn/end' && last.data.reason).toEqual({ kind: 'interrupted' })
    const stepEnd = loaded.events[8]!
    expect(stepEnd.type).toBe('step/end')
    // the torn seq-8 chunk fragment did not survive
    expect(loaded.events.some(e => e.type === 'assistant/chunk' && e.seq === 8)).toBe(false)

    // The next append continues at seq 10 (the balanced length).
    const turn3 = [
      { type: 'turn/start', seq: 10, time: 11, data: { turn: 3 } },
      { type: 'turn/end', seq: 11, time: 12, data: { turn: 3, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    await ctx.sessionPersistence.append(m.id, turn3)
    const reloaded = await ctx.sessionPersistence.load(m.id)
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('committed events are never rewritten: only the crash tail is repaired', async () => {
    const m = meta('append-only')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const before = await readFile(rawLogPath(root, undefined, m.id), 'utf8')
    const committedPrefix = before // the whole committed log

    // A crash tail then a repair-append.
    await writeFile(rawLogPath(root, undefined, m.id), '\n{"partial', { flag: 'a' })
    await ctx.sessionPersistence.load(m.id)
    await ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2 } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    const after = await readFile(rawLogPath(root, undefined, m.id), 'utf8')
    // the committed prefix is byte-for-byte intact at the head of the file
    expect(after.startsWith(committedPrefix)).toBe(true)
  })

  it('a failed appendLines truncates partial bytes so a retry has no seq gap', async () => {
    const m = meta('truncate-retry')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog()) // materialized, seqs 0..5
    const sizeBefore = (await stat(rawLogPath(root, undefined, m.id))).size

    // Force the NEXT fsync (inside appendLines) to fail once, AFTER writeFile
    // has already put bytes on disk — simulating an ENOSPC/fsync error
    // mid-append. The recovery truncate() also fsyncs, so allow that one.
    const handle = await (await import('node:fs/promises')).open(rawLogPath(root, undefined, m.id), 'r')
    const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
    await handle.close()
    const realSync = proto.sync
    let failed = false
    const spy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
      if (!failed) { failed = true; throw new Error('simulated fsync ENOSPC') }
      return realSync.call(this)
    })

    const turn2 = [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2 } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    // The append rejects, but the partial bytes are truncated back: the file is
    // its pre-append size and the cursor is unchanged.
    await expect(ctx.sessionPersistence.append(m.id, turn2)).rejects.toThrow(/ENOSPC/)
    expect((await stat(rawLogPath(root, undefined, m.id))).size).toBe(sizeBefore)
    spy.mockRestore()

    // The retry now succeeds with NO seq gap — the log is contiguous 0..7.
    await ctx.sessionPersistence.append(m.id, turn2)
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('reports both the append failure and a failed rollback', async () => {
    const m = meta('rollback-failure')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())

    const path = rawLogPath(root, undefined, m.id)
    const handle = await (await import('node:fs/promises')).open(path, 'r')
    const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
    await handle.close()
    const realSync = proto.sync
    let failed = false
    const syncSpy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
      if (!failed) { failed = true; throw new Error('simulated append fsync failure') }
      return realSync.call(this)
    })
    const backend = ctx.sessionPersistence as unknown as {
      rollbackAppend: (path: string, size: number) => Promise<void>
    }
    const realRollback = backend.rollbackAppend.bind(backend)
    backend.rollbackAppend = () => Promise.reject(new Error('simulated rollback failure'))

    try {
      await ctx.sessionPersistence.append(m.id, [
        { type: 'turn/start', seq: 6, time: 9, data: { turn: 2 } },
      ] as SessionEvent[])
      throw new Error('expected append to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      const aggregate = error as AggregateError
      expect(aggregate.message).toContain(`failed to roll back append to "${path}"`)
      expect(aggregate.errors).toHaveLength(2)
      expect(aggregate.errors[0]).toMatchObject({ message: 'simulated append fsync failure' })
      expect(aggregate.errors[1]).toMatchObject({ message: 'simulated rollback failure' })
    } finally {
      backend.rollbackAppend = realRollback
      syncSpy.mockRestore()
    }
  })

  it('load returns immutable meta without exposing backend pathing', async () => {
    const m = meta('meta-copy', '/proj')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(() => { mutableHeader(loaded.meta).cwd = '/evil' }).toThrow()
    await ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2 } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    // The append landed in the ORIGINAL /proj log, not beside an /evil path.
    const reloaded = await ctx.sessionPersistence.load(m.id)
    expect(reloaded.meta.cwd).toBe('/proj')
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('rejects a mismatched header before repairing either session log', async () => {
    const a = meta('identity-a', '/same')
    const b = meta('identity-b', '/same')
    await ctx.sessionPersistence.create(a)
    await ctx.sessionPersistence.append(a.id, [{
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    }])
    await ctx.sessionPersistence.create(b)
    await ctx.sessionPersistence.append(b.id, oneTurnLog())

    const aPath = rawLogPath(root, a.cwd, a.id)
    const bPath = rawLogPath(root, b.cwd, b.id)
    await rewriteHeader(aPath, (header) => { header.id = b.id })
    const beforeA = await readFile(aPath)
    const beforeB = await readFile(bPath)

    await expect(ctx.sessionPersistence.load(a.id))
      .rejects.toThrow(/requested id "identity-a" does not match header id "identity-b"/)
    expect(await readFile(aPath)).toEqual(beforeA)
    expect(await readFile(bPath)).toEqual(beforeB)
  })

  it('rejects a re-append of an already-stored seq', async () => {
    const m = meta('reappend')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    await expect(ctx.sessionPersistence.append(m.id, oneTurnLog())).rejects.toThrow(/seq mismatch/)
  })

  it('path-traversal session ids are neutralized (no escape from root)', async () => {
    const evil = SessionId('../../etc/pwn')
    const m = { version: 0, id: evil, createdAt: 1 }
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(evil, oneTurnLog())
    // The file lives UNDER root, not at ../../etc.
    const all: string[] = []
    async function walk(dir: string): Promise<void> {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else all.push(p)
      }
    }
    await walk(root)
    expect(all.length).toBeGreaterThan(0)
    expect(all.every(p => p.startsWith(root))).toBe(true)
  })
})

describe('JsonlSessionPersistence: write path (session/event → flush)', () => {
  it('concurrent sessions do not cross buffers', async () => {
    root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })

    const a = ctx.sessions.create(SessionId('sa'))
    const b = ctx.sessions.create(SessionId('sb'))
    a.append('turn/start', { turn: 1 })
    b.append('turn/start', { turn: 1 })
    a.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'A' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    b.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'B' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    a.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    b.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(a)
    await ctx.sessions.flush(b)

    const la = await ctx.sessionPersistence.load(SessionId('sa'))
    const lb = await ctx.sessionPersistence.load(SessionId('sb'))
    expect(JSON.stringify(la.events)).toContain('"A"')
    expect(JSON.stringify(la.events)).not.toContain('"B"')
    expect(JSON.stringify(lb.events)).toContain('"B"')
    expect(JSON.stringify(lb.events)).not.toContain('"A"')
    await ctx.fiber.dispose()
  })

})


describe('JsonlSessionPersistence: scanLog unit', () => {
  it('requires exactly one newline-terminated header record', () => {
    const header = JSON.stringify(toHeaderLine(meta('scanner-header')))
    expect(() => new SessionLogScanner(Buffer.alloc(0))).toThrow(/header-less/)
    expect(() => new SessionLogScanner(Buffer.from(header))).toThrow(/header-less/)
    expect(() => new SessionLogScanner(Buffer.from(`${header}\n${header}\n`))).toThrow(/header-less/)
  })

  it('handles empty writes, boundary newlines, torn fragments, and scanner completion', () => {
    const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('scanner-lifecycle')))}\n`)
    const event = Buffer.from(JSON.stringify(oneTurnLog()[0]))
    const scanner = new SessionLogScanner(header)

    scanner.write(Buffer.alloc(0))
    scanner.write(event)
    scanner.write(Buffer.from('\nignored torn tail'))
    const result = scanner.finish()

    expect(result.events).toEqual([oneTurnLog()[0]])
    expect(result.committedBytes).toBe(header.length + event.length + 1)
    expect(() => { scanner.write(Buffer.from('\n')) }).toThrow(/finished/)
  })

  it('keeps scanning after a tolerable corrupt suffix until a committed turn end appears', () => {
    const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('scanner-corrupt-suffix')))}\n`)
    const scanner = new SessionLogScanner(header)
    scanner.write(Buffer.from([
      JSON.stringify(oneTurnLog()[0]),
      '{not json',
      JSON.stringify({ type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } }),
      '',
    ].join('\n')))
    expect(scanner.finish().events).toEqual([oneTurnLog()[0]])

    const committed = new SessionLogScanner(header)
    expect(() => { committed.write(Buffer.from([
      JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      '',
    ].join('\n'))) }).toThrow(/seq gap in committed region/)
  })

  it('incrementally scans records split across reusable decoder chunks', () => {
    const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('incremental')))}\n`)
    const body = Buffer.from(`${oneTurnLog().map(event => JSON.stringify(event)).join('\n').replace('"hi"', '"你好"')}\n`)
    const split = body.indexOf(Buffer.from('你')) + 1
    const firstChunk = Buffer.from(body.subarray(0, split))
    const scanner = new SessionLogScanner(header)

    scanner.write(firstChunk)
    const checkpoint = scanner.checkpoint()
    firstChunk.fill(0)
    scanner.write(body.subarray(split))

    expect(checkpoint).toMatchObject({
      inputBytes: header.length + split,
      eventCount: 1,
    })
    expect(scanner.finish()).toEqual(scanLog(Buffer.concat([header, body])))
  })

  it('rejects a header-less / empty log', () => {
    expect(() => scanLog(Buffer.from(''))).toThrow()
  })

  it('rejects a corrupt header line', () => {
    expect(() => scanLog(Buffer.from('not json\n'))).toThrow(/header/)
  })

  it('rejects a non-session first line', () => {
    expect(() => scanLog(Buffer.from('{"type":"event"}\n'))).toThrow(/session header/)
  })

  it.each([
    ['fractional', 1.5],
    ['negative', -1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a session header with a %s createdAt', (_label, createdAt) => {
    const log = JSON.stringify({
      type: 'session',
      version: 0,
      id: 'invalid-created-at',
      createdAt,
      delegationDepth: 0,
    }) + '\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('rejects a session header with negative-zero createdAt', () => {
    const log = '{"type":"session","version":0,"id":"invalid-created-at","createdAt":-0,"delegationDepth":0}\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it.each([
    ['missing', undefined],
    ['a string', '1'],
    ['fractional', 1.5],
    ['negative', -1],
  ])('rejects a session header with %s delegationDepth', (_label, delegationDepth) => {
    const log = JSON.stringify({
      type: 'session',
      version: 0,
      id: 'invalid-depth',
      createdAt: 1,
      ...delegationDepth === undefined ? {} : { delegationDepth },
    }) + '\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('rejects a session header with negative-zero delegationDepth', () => {
    const log = '{"type":"session","version":0,"id":"invalid-depth","createdAt":1,"delegationDepth":-0}\n'
    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('round-trips the agent preset a session was composed from', () => {
    const line = toHeaderLine({
      version: 0,
      id: SessionId('composed'),
      createdAt: 1,
      delegationDepth: 0,
      agentPreset: 'minimal',
    })
    const log = `${JSON.stringify(line)}\n`

    // The preset decides the resumed session's tools and prompt; dropping it
    // on disk would restore a composition the logged history contradicts.
    expect(scanLog(Buffer.from(log)).meta.agentPreset).toBe('minimal')
  })

  it('rejects a session header whose agentPreset is not a string', () => {
    const log = '{"type":"session","version":0,"id":"bad-preset","createdAt":1,"delegationDepth":0,"agentPreset":7}\n'

    expect(() => scanLog(Buffer.from(log))).toThrow(/session header/)
  })

  it('a seq gap after the last turn/end bounds the preserved tail (torn fragment tolerated)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 'g', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }), // gap: missing seq 1
    ].join('\n') + '\n'
    // No committed turn/end, so the gap is a tolerated crash boundary: scanLog PRESERVES the
    // contiguous prefix (turn/start seq 0) — real interrupted-turn work, not discarded — and
    // stops at the gap. `loadCore`, not this scanner, later closes the orphaned turn.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('rejects a seq gap BEFORE a later committed turn/end (committed data damaged)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 'g2', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }), // gap: missing seq 1
      JSON.stringify({ type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    // A turn/end exists, so the prefix up to it is committed — but it has a hole.
    // Truncating it would silently drop committed data → unloadable.
    expect(() => scanLog(Buffer.from(log))).toThrow(/seq gap in committed region/)
  })

  it('rejects malformed records before a later committed turn/end', () => {
    const corruptRecords = [
      '{not json',
      'null',
      JSON.stringify({ type: 'assistant/message', sourceEventSeqs: [0], data: {} }),
    ]
    for (const record of corruptRecords) {
      const log = [
        JSON.stringify({ type: 'session', version: 0, id: 'c', createdAt: 1, delegationDepth: 0 }),
        record,
        JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      ].join('\n') + '\n'
      expect(() => scanLog(Buffer.from(log))).toThrow(/unparsable committed event/)
    }
  })

  it('a header-only log (no event lines at all) preserves nothing — committedBytes is the header', () => {
    const log = JSON.stringify({ type: 'session', version: 0, id: 'h0', createdAt: 1, delegationDepth: 0 }) + '\n'
    const scanned = scanLog(Buffer.from(log))
    expect(scanned.events).toEqual([])
    // committedBytes falls back to the header line's end (no preserved events).
    expect(scanned.committedBytes).toBe(Buffer.byteLength(log, 'utf8'))
  })

  it('a corrupt line after the last turn/end bounds the preserved tail', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 'c2', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      '{not json', // corrupt crash fragment, no turn/end committed
    ].join('\n') + '\n'
    // The contiguous prefix (turn/start seq 0) is preserved; the corrupt
    // fragment after it is the tolerated crash boundary.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('tolerates a seq gap AFTER a turn/end (uncommitted tail)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 't', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      JSON.stringify({ type: 'step/start', seq: 9, time: 3, data: { turn: 2, step: 1 } }), // gap in uncommitted tail
    ].join('\n') + '\n'
    const { events } = scanLog(Buffer.from(log))
    expect(events.map(e => e.seq)).toEqual([0, 1]) // tail dropped
  })
})

describe('JsonlSessionPersistence: default packed chunk rows', () => {
  let ctx: Context
  beforeEach(async () => {
    root = await freshRoot()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    // compression: 'none' — these tests assert the textual storage-record layout
    // (row tags per line); packing is orthogonal to the physical encoding.
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  /** A one-turn log whose step streams a five-member text-delta run. */
  function chunkRunLog(): SessionEvent[] {
    const deltas: SessionEvent[] = Array.from({ length: 5 }, (_, k) => ({
      type: 'assistant/chunk',
      seq: 2 + k,
      time: 3 + k,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `t${k}` } },
    }))
    return [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      ...deltas,
      { type: 'assistant/message', seq: 7, time: 8, data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 't0t1t2t3t4' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      }, surfaceOp: 'append', sourceEventSeqs: [2, 3, 4, 5, 6] },
      { type: 'step/end', seq: 8, time: 9, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 9, time: 10, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
  }

  it('writes a delta run as one text-chunks row by default and loads back identical events', async () => {
    const m = meta('packed', '/work')
    const log = chunkRunLog()
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, log)

    const raw = (await readFile(rawLogPath(root, '/work', m.id), 'utf8')).split('\n').filter(Boolean)
    const tags = raw.slice(1).map(line => (JSON.parse(line) as { type: string }).type)
    expect(tags).toEqual(['turn/start', 'step/start', 'text-chunks', 'assistant/message', 'step/end', 'turn/end'])

    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toEqual(log)
  })

  it('packChunks: false writes one event per line and still loads identical events', async () => {
    const unpackedRoot = await freshRoot()
    const unpacked = new Context()
    await unpacked.plugin(SessionStore)
    await unpacked.plugin(JsonlSessionPersistence, {
      root: unpackedRoot,
      packChunks: false,
      compression: 'none',
    })
    try {
      const m = meta('unpacked', '/work')
      const log = chunkRunLog()
      await unpacked.sessionPersistence.create(m)
      await unpacked.sessionPersistence.append(m.id, log)

      const records = (await readFile(rawLogPath(unpackedRoot, '/work', m.id), 'utf8'))
        .split('\n').filter(Boolean).slice(1)
        .map(line => JSON.parse(line) as { type: string })
      expect(records.filter(record => record.type === 'assistant/chunk')).toHaveLength(5)
      expect(records.some(record => record.type === 'text-chunks')).toBe(false)
      expect((await unpacked.sessionPersistence.load(m.id)).events).toEqual(log)
    } finally {
      await unpacked.fiber.dispose()
    }
  })

  it('loads a mixed file: verbatim lines from an unpacked writer, then packed appends', async () => {
    const m = meta('mixed', '/work')
    const log = chunkRunLog()
    // First turn written line-per-event by an unpacked-config writer (an old
    // file, hand-planted so this packed-config backend adopts it on load).
    await mkdir(sessionDir(root, '/work', m.id), { recursive: true })
    await writeFile(rawLogPath(root, '/work', m.id), [
      JSON.stringify({ type: 'session', version: 0, id: 'mixed', createdAt: 1000, cwd: '/work', delegationDepth: 0 }),
      ...log.map(e => JSON.stringify(e)),
    ].join('\n') + '\n')
    // Adopt the stored log (cursor = stored length), then append a second turn
    // through THIS packed-config backend.
    expect((await ctx.sessionPersistence.load(m.id)).events).toEqual(log)
    const secondTurn: SessionEvent[] = JSON.parse(JSON.stringify(log)) as SessionEvent[]
    for (const [k, e] of secondTurn.entries()) {
      ;(e as { seq: number }).seq = 10 + k
      ;(e.data as { turn: number }).turn = 2
    }
    await ctx.sessionPersistence.append(m.id, secondTurn)

    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toEqual([...log, ...secondTurn])
    // The packed append really packed: the file's tail carries a text-chunks row.
    const tags = (await readFile(rawLogPath(root, '/work', m.id), 'utf8')).split('\n').filter(Boolean)
      .map(line => (JSON.parse(line) as { type: string }).type)
    expect(tags.filter(t => t === 'text-chunks')).toHaveLength(1)
    expect(tags.filter(t => t === 'assistant/chunk')).toHaveLength(5)
  })

  it('scanLog: a packed row advances the seq cursor by its whole run', () => {
    const logText = [
      JSON.stringify({ type: 'session', version: 0, id: 'rows', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'text-chunks', seq0: 1, time0: 2, data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] } }),
      JSON.stringify({ type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    const { events } = scanLog(Buffer.from(logText))
    expect(events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4])
    expect(events[2]).toEqual({ type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } } })
  })

  it('scanLog: a malformed packed row in the committed region rejects like corrupt JSON', () => {
    const logText = [
      JSON.stringify({ type: 'session', version: 0, id: 'bad-row', createdAt: 1, delegationDepth: 0 }),
      // dt arity mismatch — row validation throws, so the line is a committed hole.
      JSON.stringify({ type: 'text-chunks', seq0: 0, time0: 1, data: { turn: 1, step: 1, index: 0, dt: [], texts: ['a', 'b'] } }),
      JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    expect(() => scanLog(Buffer.from(logText))).toThrow(/unparsable committed event/)
  })

  it('scanLog: a packed row with a mid-run seq gap after the last turn/end drops the whole row', () => {
    const logText = [
      JSON.stringify({ type: 'session', version: 0, id: 'row-gap', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      // seq0 skips 1 — the run's first member is already a gap; no turn/end follows.
      JSON.stringify({ type: 'text-chunks', seq0: 2, time0: 2, data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] } }),
    ].join('\n') + '\n'
    const scanned = scanLog(Buffer.from(logText))
    expect(scanned.events.map(e => e.seq)).toEqual([0])
    // committedBytes stays on the line boundary BEFORE the dropped row.
    const headerAndTurn = logText.split('\n').slice(0, 2).join('\n') + '\n'
    expect(scanned.committedBytes).toBe(Buffer.byteLength(headerAndTurn, 'utf8'))
  })

  it('eventLines(packChunks: false) keeps one event per line and round-trips provenance', () => {
    const log = chunkRunLog()
    const text = eventLines(log, false)
    const lines = text.split('\n')
    expect(lines).toHaveLength(log.length)
    for (const line of lines) {
      expect((JSON.parse(line) as { type: string }).type).not.toMatch(/-chunks$/)
    }
    // the message's consecutive provenance is stored as an inclusive range
    const messageLine = lines.map(l => JSON.parse(l) as { type: string; sourceEventSeqs?: unknown })
      .find(r => r.type === 'assistant/message')
    expect(messageLine?.sourceEventSeqs).toEqual([[2, 6]])
    const header = JSON.stringify(toHeaderLine(meta('packed', '/work'))) + '\n'
    expect(scanLog(Buffer.from(header + text + '\n')).events).toEqual(log)
  })
})

describe('JsonlSessionPersistence: edge cases', () => {
  let ctx: Context
  beforeEach(async () => {
    root = await freshRoot()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  it('append rejects non-JSON-serializable undefined-producing data', async () => {
    const m = meta('undef')
    await ctx.sessionPersistence.create(m)
    // A value whose JSON.stringify yields undefined (a bare function as data).
    const bad = [{ type: 'user/message', seq: 0, time: 1, data: (() => 0) as unknown }] as unknown as SessionEvent[]
    await expect(ctx.sessionPersistence.append(m.id, bad)).rejects.toThrow(/non-JSON-serializable/)
  })

  it('create snapshots its meta: mutating the caller object after the call is ignored', async () => {
    const m = meta('create-snap', '/orig')
    const p = ctx.sessionPersistence.create(m)
    // Mutate the caller's meta object immediately after calling create.
    mutableHeader(m).cwd = '/mutated'
    await p
    await ctx.sessionPersistence.append(SessionId('create-snap'), oneTurnLog())
    // The log materialized under the ORIGINAL cwd, not the mutated one.
    expect((await stat(rawLogPath(root, '/orig', SessionId('create-snap')))).isFile()).toBe(true)
    await expect(stat(rawLogPath(root, '/mutated', SessionId('create-snap')))).rejects.toThrow()
  })

  it('list discovers sessions across multiple project directories', async () => {
    await ctx.sessionPersistence.create(meta('p1', '/projA'))
    await ctx.sessionPersistence.append(SessionId('p1'), oneTurnLog())
    await ctx.sessionPersistence.create(meta('p2', '/projB'))
    await ctx.sessionPersistence.append(SessionId('p2'), oneTurnLog())
    await ctx.sessionPersistence.create(meta('p3')) // no cwd → _no-cwd project directory
    await ctx.sessionPersistence.append(SessionId('p3'), oneTurnLog())

    const ids = (await ctx.sessionPersistence.list()).map(x => x.id).sort()
    expect(ids).toEqual(['p1', 'p2', 'p3'])
  })

  it('groups sessions whose cwd paths normalize to the same project directory', async () => {
    const first = meta('normalized-first', '/a/b-c')
    const second = meta('normalized-second', '/a-b/c')
    await ctx.sessionPersistence.create(first)
    await ctx.sessionPersistence.append(first.id, oneTurnLog())
    await ctx.sessionPersistence.create(second)
    await ctx.sessionPersistence.append(second.id, oneTurnLog())

    expect(projectDir(root, first.cwd)).toBe(projectDir(root, second.cwd))
    expect(await readdir(projectDir(root, first.cwd))).toEqual(expect.arrayContaining([
      encodeSegment(first.id),
      encodeSegment(second.id),
    ]))
    expect((await ctx.sessionPersistence.list()).map(header => header.id).sort())
      .toEqual([first.id, second.id].sort())
  })

  it('list on an empty root returns nothing', async () => {
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })

  it('keeps the transcript in an extensible session-owned directory', async () => {
    const m = meta('owned-directory', '/project')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const dir = sessionDir(root, m.cwd, m.id)
    await writeFile(join(dir, 'metadata.json'), '{}\n')
    await writeFile(join(projectDir(root, m.cwd), 'README'), 'project metadata\n')
    await mkdir(join(projectDir(root, m.cwd), 'reserved-session'), { recursive: true })

    expect(await readdir(dir)).toEqual(expect.arrayContaining(['metadata.json', 'session.jsonl']))
    expect((await ctx.sessionPersistence.list()).map(header => header.id)).toContain(m.id)
    expect((await ctx.sessionPersistence.load(m.id)).events).toEqual(oneTurnLog())
  })

  it('rejects the obsolete flat-file layout instead of ignoring stored sessions', async () => {
    const m = meta('legacy-flat', '/legacy')
    const project = projectDir(root, m.cwd)
    const path = join(project, `${encodeSegment(m.id)}.jsonl`)
    await mkdir(project, { recursive: true })
    await writeFile(path, [
      JSON.stringify(toHeaderLine(m)),
      ...oneTurnLog().map(event => JSON.stringify(event)),
      '',
    ].join('\n'))

    await expect(ctx.sessionPersistence.load(m.id)).rejects.toThrow(/unsupported flat-file layout/)
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/unsupported flat-file layout/)
  })

  it('rejects a compressed obsolete flat-file artifact during targeted lookup', async () => {
    const m = meta('legacy-compressed-flat', '/legacy')
    const project = projectDir(root, m.cwd)
    expect(await ctx.sessionPersistence.list()).toEqual([])
    await mkdir(project, { recursive: true })
    await writeFile(join(project, `${encodeSegment(m.id)}.jsonl.zstd`), 'legacy')

    await expect(ctx.sessionPersistence.load(m.id)).rejects.toThrow(/unsupported flat-file layout/)
  })

  it('list skips empty and non-header session logs (metadata-only read)', async () => {
    // A real session…
    await ctx.sessionPersistence.create(meta('real', '/p'))
    await ctx.sessionPersistence.append(SessionId('real'), oneTurnLog())
    // …alongside junk session directories whose fixed transcript is empty or
    // lacks a header. Both remain unmaterialized and are skipped.
    for (const [id, content] of [
      ['empty', ''],
      ['notheader', '{"type":"turn/start"}\n'],
      ['badjson', 'not json at all\n'],
    ] as const) {
      const path = rawLogPath(root, undefined, SessionId(id))
      await mkdir(sessionDir(root, undefined, SessionId(id)), { recursive: true })
      await writeFile(path, content)
    }

    const ids = (await ctx.sessionPersistence.list()).map(x => x.id).sort()
    expect(ids).toEqual(['real'])
  })

  it('list reads a header line longer than the 8KB read chunk', async () => {
    // A tolerated extra field makes this valid header exceed the 8192-byte read buffer, proving
    // `readFirstLine` accumulates chunks before `list()` parses it.
    const id = SessionId('big')
    await mkdir(sessionDir(root, undefined, id), { recursive: true })
    const bigHeader = JSON.stringify({ type: 'session', version: 0, id: 'big', createdAt: 1, delegationDepth: 0, pad: 'x'.repeat(9000) })
    await writeFile(rawLogPath(root, undefined, id), bigHeader + '\n')
    const ids = (await ctx.sessionPersistence.list()).map(x => x.id)
    expect(ids).toContain('big')
  })

  it.each(['sandboxMode', 'approvalPolicy'] as const)('rejects the retired %s header field', (field) => {
    const line = { ...toHeaderLine(meta('retired-policy-header')), [field]: 'read-only' }
    expect(() => scanLog(Buffer.from(`${JSON.stringify(line)}\n`)))
      .toThrow(/retired policy baseline fields/)
  })

  it('list rejects a header whose cwd does not identify its physical log', async () => {
    const m = meta('misplaced', '/stored')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    await rewriteHeader(rawLogPath(root, m.cwd, m.id), (header) => { header.cwd = '/elsewhere' })

    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/and cwd identify/)
  })

  it('accepts an alternate project path only when it identifies the same physical log', async () => {
    const m = meta('physical-alias', '/stored')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const path = rawLogPath(root, m.cwd, m.id)
    const aliasCwd = '/alias'
    await symlink(
      projectDir(root, m.cwd),
      projectDir(root, aliasCwd),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await rewriteHeader(path, (header) => { header.cwd = aliasCwd })

    expect((await ctx.sessionPersistence.load(m.id)).meta.cwd).toBe(aliasCwd)
    expect((await ctx.sessionPersistence.list()).map(header => header.id)).toContain(m.id)
  })

  it('list rejects a session header whose id cannot name a storage path', async () => {
    const dir = join(projectDir(root, undefined), 'invalid-id')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl'), JSON.stringify({
      type: 'session', version: 0, id: '', createdAt: 1, delegationDepth: 0,
    }) + '\n')

    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/header id cannot name a storage path/)
  })

  it('load and list reject one id materialized in multiple project directories', async () => {
    const id = SessionId('duplicate')
    for (const cwd of ['/a', '/b']) {
      const m = meta(id, cwd)
      await mkdir(sessionDir(root, cwd, id), { recursive: true })
      const content = [JSON.stringify(toHeaderLine(m)), ...oneTurnLog().map(event => JSON.stringify(event))].join('\n') + '\n'
      await writeFile(rawLogPath(root, cwd, id), content)
    }

    await expect(ctx.sessionPersistence.load(id)).rejects.toThrow(/appears in multiple project directories/)
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/appears in multiple project directories/)
  })

  it('a DIFFERENT live session object reusing a disposed id gets its own init (no stale cache)', async () => {
    // Session A materializes a log under id "reuse".
    const sessFiberA = await ctx.plugin(Object.assign((inner: Context) => {
      const a = inner.sessions.create(SessionId('reuse'), { meta: { cwd: '/a' } })
      appendLog(a, oneTurnLog())
    }, { inject: ['sessions'] }))
    // Drain A, then dispose ITS fiber (the live session A is gone) while the
    // backend stays loaded.
    for (const s of ctx.sessions.list()) await ctx.sessions.flush(s)
    await sessFiberA.dispose()

    // A new Session object reuses the id. Object-keyed initialization must run independently,
    // detect the disk collision, and reject instead of appending through session A's stale cursor.
    let b!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      b = inner.sessions.create(SessionId('reuse'), { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(ctx.sessions.flush(b)).rejects.toThrow(/already bound to a different live session|already has a persisted log on disk/)
  })

  it('a no-cwd live session cannot adopt a same-id log from another cwd', async () => {
    // Backend 1: materialize a log under id "x" in the cwd "/w" bucket, then
    // dispose the WHOLE backend (so backend 2 mounts with an EMPTY states map —
    // the HMR/reload path with no tracked collision state).
    await ctx.sessionPersistence.create(meta('x', '/w'))
    await ctx.sessionPersistence.append(SessionId('x'), oneTurnLog())
    await ctx.fiber.dispose()

    // Backend 2 creates a no-cwd session whose id exists only in `/w`. The
    // stored cwd check rejects instead of grafting no-cwd events onto that log.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    let b!: Session
    await ctx2.plugin(Object.assign((inner: Context) => {
      b = inner.sessions.create(SessionId('x')) // no cwd
    }, { inject: ['sessions'] }))
    await expect(ctx2.sessions.flush(b)).rejects.toThrow(/different cwd|id collision/)

    // The "/w" log is untouched — no no-cwd events were grafted onto it, and no
    // `_no-cwd` log for "x" was created.
    const inW = scanLog(await readFile(rawLogPath(root, '/w', SessionId('x'))))
    expect(inW.meta.cwd).toBe('/w')
    expect(inW.events).toHaveLength(6)
    await expect(stat(rawLogPath(root, undefined, SessionId('x')))).rejects.toThrow()
    await ctx2.fiber.dispose()
  })

  it('a seed with matching seq/type/time but DIFFERENT data is rejected (deep prefix compare)', async () => {
    // Materialize and load (ownerless, cursor = 6).
    await ctx.sessionPersistence.create(meta('divergent', '/a'))
    await ctx.sessionPersistence.append(SessionId('divergent'), oneTurnLog())
    await ctx.sessionPersistence.load(SessionId('divergent'))

    // A seed that keeps every seq/type/time but mutates a payload must NOT be
    // accepted as "the same session" — otherwise drain filters those seqs as
    // already persisted and the divergent payload is silently lost.
    const tampered = structuredClone(oneTurnLog())
    const userMsg = tampered[1]
    if (userMsg?.type === 'user/message') {
      (userMsg.data as { content: unknown[] }).content = [{ type: 'text', text: 'DIFFERENT' }]
    }
    let bad!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      bad = inner.sessions.create(SessionId('divergent'), { seed: tampered, meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(ctx.sessions.flush(bad)).rejects.toThrow(/do not match this live session|already has a persisted log/)
  })

  it('a second live session reusing a bound id is rejected', async () => {
    // A live session materializes and owns the id.
    const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
      const a = inner.sessions.create(SessionId('bound'), { meta: { cwd: '/a' } })
      a.append('turn/start', { turn: 1 })
      a.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }, { inject: ['sessions'] }))
    for (const s of ctx.sessions.list()) await ctx.sessions.flush(s)
    await firstFiber.dispose()

    let second!: Session
    await ctx.plugin(Object.assign((inner: Context) => {
      second = inner.sessions.create(SessionId('bound'), { meta: { cwd: '/a' } })
    }, { inject: ['sessions'] }))
    await expect(ctx.sessions.flush(second))
      .rejects.toThrow(/already bound to a different live session|already has a persisted log|do not match/)
  })

  it('list returns nothing when the root directory does not exist', async () => {
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(JsonlSessionPersistence, {
      root: join(root, 'does-not-exist-yet'),
      compression: 'none',
    })
    expect(await ctx2.sessionPersistence.list()).toEqual([])
    await ctx2.fiber.dispose()
  })

  it('plugin load rejects an existing root that is not a directory', async () => {
    const filePath = join(root, 'not-a-dir')
    await writeFile(filePath, 'x')
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await expect(ctx2.plugin(JsonlSessionPersistence, { root: filePath, compression: 'none' })).rejects.toThrow(/ENOTDIR/)
    await ctx2.fiber.dispose()
  })

  it('list surfaces a root that becomes unusable after plugin load', async () => {
    await rm(root, { recursive: true })
    await writeFile(root, 'not a directory')

    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/ENOTDIR/)
  })

  it('per-id lookup surfaces non-ENOENT storage errors', async () => {
    const blocker = join(root, 'not-a-directory')
    await writeFile(blocker, 'x')
    const backend = ctx.sessionPersistence as unknown as { exists(path: string): Promise<boolean> }

    await expect(backend.exists(join(blocker, 'child.jsonl'))).rejects.toThrow(/ENOTDIR/)
  })

  it('materialization surfaces a project-directory storage fault', async () => {
    const cwd = '/x'
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await writeFile(projectDir(root, cwd), 'x') // project path is now a file
    let s!: Session
    await ctx2.plugin(Object.assign((inner: Context) => {
      s = inner.sessions.create(SessionId('exists-fault'), { meta: { cwd } })
      appendClosedTurn(s)
    }, { inject: ['sessions'] }))
    await expectFlushCode(ctx2.sessions.flush(s), ['EEXIST', 'ENOTDIR'])
    await ctx2.fiber.dispose()
  })

  it('append() to a disk-only session adopts it and repairs a crash tail', async () => {
    // Persist a session, then corrupt its tail, all through ONE backend.
    const m = meta('disk-append', '/d')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    await writeFile(rawLogPath(root, '/d', m.id), '\n{"partial crash', { flag: 'a' })

    // A FRESH backend with no in-memory state: append directly (no prior load)
    // → append must adopt from disk, and the adopt's load schedules a repair
    // that the same append then performs before writing.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await ctx2.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 9, data: { turn: 2 } },
      { type: 'turn/end', seq: 7, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    const loaded = await ctx2.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await ctx2.fiber.dispose()
  })

  it('a header-only log (open turn, no turn/end) preserves the open turn on load and closes it', async () => {
    // A session whose only durable content is an unclosed first turn. scanLog
    // preserves the turn/start; loadCore closes it with a synthetic
    // turn/end {interrupted} so the returned log is balanced.
    const m = meta('open-turn', '/h')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ] as SessionEvent[])
    const { events } = await ctx.sessionPersistence.load(m.id)
    expect(events.map(e => e.type)).toEqual(['turn/start', 'turn/end'])
    const end = events[1]!
    expect(end.type === 'turn/end' && end.data.reason).toEqual({ kind: 'interrupted' })
  })


  it('createCore rejects an id already on disk under a different project directory', async () => {
    // Persist the id under cwd A.
    const a = meta('dup-id', '/projA')
    await ctx.sessionPersistence.create(a)
    await ctx.sessionPersistence.append(a.id, oneTurnLog())
    // A fresh backend creating the SAME id under cwd B must still refuse: load
    // identifies by id across all projects, so a second log would make resume
    // nondeterministic. create scans every project, not just meta.cwd's.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expect(ctx2.sessionPersistence.create(meta('dup-id', '/projB')))
      .rejects.toThrow(/already has a persisted log on disk/)
    await ctx2.fiber.dispose()
  })

  it('flush keeps buffered events when the append fails (no silent loss)', async () => {
    root = await freshRoot()
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const session = ctx2.sessions.create(SessionId('flush-fail'))
    // A full turn lands in the write-behind buffer.
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Make the durable materialize fail on the next flush.
    const backend = ctx2.sessionPersistence as unknown as { materialize: (...args: unknown[]) => Promise<void> }
    const origMat = backend.materialize.bind(backend)
    backend.materialize = () => Promise.reject(new Error('disk full'))
    await expectFlushError(ctx2.sessions.flush(session), /disk full/)
    // The events are STILL buffered (not silently dropped): a retry persists them.
    backend.materialize = origMat
    await ctx2.sessions.flush(session)
    const loaded = await ctx2.sessionPersistence.load(SessionId('flush-fail'))
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2])
    await ctx2.fiber.dispose()
  })

  it('rejects non-JSON event data: BigInt, function, circular, Map, undefined property', async () => {
    const m = meta('serial')
    await ctx.sessionPersistence.create(m)
    const bad = (extra: unknown) => [{
      type: 'user/message',
      seq: 0,
      time: 1,
      data: {
        id: MessageId('invalid-json'),
        role: 'user',
        content: [{ type: 'text', text: 'x' }],
        source: { kind: 'user' },
        extra,
      },
    }] as unknown as SessionEvent[]
    await expect(ctx.sessionPersistence.append(m.id, bad(1n))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(() => 0))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(Symbol('s')))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(new Map()))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(undefined))).rejects.toThrow(/non-JSON-serializable/)
    await expect(ctx.sessionPersistence.append(m.id, bad(Infinity))).rejects.toThrow(/non-JSON-serializable/)
    // a circular structure
    const circ: Record<string, unknown> = {}
    circ.self = circ
    await expect(ctx.sessionPersistence.append(m.id, bad(circ))).rejects.toThrow(/non-JSON-serializable/)
    // The session was never materialized by any of the rejected appends.
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).not.toContain(m.id)
  })

  it('accepts well-formed JSON values (null, booleans, nested arrays/objects)', async () => {
    const m = meta('json-ok')
    await ctx.sessionPersistence.create(m)
    const ev = [{ type: 'user/message', seq: 0, time: 1, data: createUserMessage({
      content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, extra: { a: null, b: true, c: [1, 2, { d: 'nested' }] },
    }) }] as unknown as SessionEvent[]
    await ctx.sessionPersistence.append(m.id, ev)
    expect((await ctx.sessionPersistence.list()).map(h => h.id)).toContain(m.id)
  })

  it('Session.append rejects a non-serializable event at the source (never enters the log)', () => {
    const session = ctx.sessions.create(SessionId('reject-bad'))
    // Serializability is enforced at the source: Session.append throws on a BigInt-bearing
    // event before it enters session.snapshotEvents(), so the durable log can never diverge from the live
    // log. The error therefore surfaces synchronously at append, not later during backend flush.
    expect(() => {
      session.append('user/message', { content: [{ type: 'text', text: 'bad' }], source: { kind: 'user' }, bad: 1n } as never, { surfaceOp: 'append' })
    }).toThrow(/non-JSON-serializable/)
    // The bad event was rejected, so the log stayed empty.
    expect(session.snapshotEvents().length).toBe(0)
  })

})

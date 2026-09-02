import { MessageId, createMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { SessionLogOffset, SessionSeq, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  encodeSegment, eventLines, logPath, projectDir, projectKey, scanLog, sessionDir, SessionLogScanner, toHeaderLine,
} from '../src/format.ts'
import { runPersistenceContract, meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { runLiveWritePathContract } from '../../session-persistence/tests/live-write-contract.ts'
import { LIVE_WRITE_BATCH_MAX_DELAY_MS, type JsonlSessionHandle } from '../src/storage.ts'
import SessionStore from '@deepseek-ai/dsh-session'

const statRace = vi.hoisted(() => ({
  path: undefined as string | undefined,
  reads: 0,
  /** 'settle': the revision changes once and then holds; 'churn': every stat differs. */
  mode: 'settle' as 'settle' | 'churn',
}))

const statFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
  error: undefined as Error | undefined,
}))

const readTally = vi.hoisted(() => ({
  /** Physical whole-file reads per path suffix; keyed by session id segment. */
  bySuffix: new Map<string, number>(),
  enabled: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]) === statFailure.path && statFailure.error !== undefined) throw statFailure.error
      const identity = await actual.stat(...args)
      if (String(args[0]) !== statRace.path || !('mtimeNs' in identity)) return identity
      statRace.reads += 1
      if (statRace.mode === 'churn') return { ...identity, mtimeNs: identity.mtimeNs + BigInt(statRace.reads) }
      if (statRace.reads < 3) return identity
      return { ...identity, mtimeNs: identity.mtimeNs + 1n }
    }) as typeof actual.stat,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (readTally.enabled && typeof args[0] === 'string') {
        readTally.bySuffix.set(args[0], (readTally.bySuffix.get(args[0]) ?? 0) + 1)
      }
      return actual.readFile(...args)
    }) as typeof actual.readFile,
  }
})

let root: string
const dirs: string[] = []

type MutableSessionHeader = { -readonly [K in keyof SessionHeader]: SessionHeader[K] }

/** Test-only mutable view used to verify that backends detach caller metadata. */
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

async function expectCode(promise: Promise<unknown>, codes: readonly string[]): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(codes).toContain((error as NodeJS.ErrnoException).code)
    return
  }
  throw new Error('expected the operation to reject')
}

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-'))
  dirs.push(dir)
  return dir
}

function rawLogPath(root: string, cwd: string | undefined, id: SessionId): string {
  return logPath(root, cwd, id, 'none')
}

/** Create + append + close: persist one whole log through the write handle. */
async function writeLog(persistence: SessionPersistence, m: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await persistence.create(m)
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

/** Open a read handle, read the whole log, and close. */
async function readAll(persistence: SessionPersistence, id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
  const handle = await persistence.open(id, 'read')
  try {
    return { meta: handle.header, events: await handle.read() }
  } finally {
    await handle.close()
  }
}

/** Append one contiguous batch through a temporary write handle. */
async function appendBatch(persistence: SessionPersistence, id: SessionId, events: readonly SessionEvent[]): Promise<void> {
  const handle = await persistence.open(id, 'write')
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

afterEach(async () => {
  statRace.path = undefined
  statRace.reads = 0
  statRace.mode = 'settle'
  readTally.bySuffix.clear()
  readTally.enabled = false
  statFailure.path = undefined
  statFailure.error = undefined
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

runPersistenceContract('jsonl-none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-'))
  const instance = async (): Promise<{ persistence: SessionPersistence; dispose: () => Promise<void> }> => {
    const ctx = new Context()
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
    return {
      persistence: ctx.sessionPersistence,
      dispose: async () => { await fiber.dispose() },
    }
  }
  const primary = await instance()
  return {
    persistence: primary.persistence,
    dispose: async () => {
      await primary.dispose()
      await rm(dir, { recursive: true, force: true })
    },
    reopen: instance,
    // A half-written record with no trailing newline: scanLog treats it as an
    // uncommitted crash fragment, so the write path sees a torn tail to truncate.
    corruptTail: async (id, cwd) => {
      await appendFile(rawLogPath(dir, cwd, id), '{"type":"assistant/chunk","seq":8,"ti')
    },
  }
})

runLiveWritePathContract('jsonl', LIVE_WRITE_BATCH_MAX_DELAY_MS, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-live-'))
  dirs.push(dir)
  const mount = async (): Promise<Context> => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
    return ctx
  }
  return { ctx: await mount(), remount: mount }
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

  it('round-trips every optional header field through the header line', () => {
    const full: SessionHeader = {
      version: 0,
      id: SessionId('full-header'),
      createdAt: 5,
      cwd: '/w',
      parentSession: SessionId('parent'),
      isSeeded: true,
      origin: 'subagent',
      delegationDepth: 2,
      agentPreset: 'minimal',
    }
    const scan = scanLog(Buffer.from(`${JSON.stringify(toHeaderLine(full, SessionLogOffset(3)))}\n`))
    expect(scan.meta).toEqual(full)
    expect(scan.inheritedEventCount).toBe(3)
  })

  it.each([
    ['absent', undefined, false, 0],
    ['zero', 0, true, 0],
    ['nonzero', 3, true, 3],
  ] as const)('round-trips the v0 physical seedLength when it is %s', (
    _case,
    seedLength,
    isSeeded,
    inheritedEventCount,
  ) => {
    const line = {
      type: 'session',
      version: 0,
      id: SessionId(`physical-seed-${_case}`),
      createdAt: 1000,
      ...seedLength === undefined ? {} : { seedLength },
      delegationDepth: 0,
    }
    const bytes = `${JSON.stringify(line)}\n`

    const scanned = scanLog(Buffer.from(bytes))

    expect(scanned.meta.isSeeded).toBe(isSeeded)
    expect(scanned.inheritedEventCount).toBe(SessionLogOffset(inheritedEventCount))
    expect(`${JSON.stringify(toHeaderLine(scanned.meta, scanned.inheritedEventCount))}\n`).toBe(bytes)
  })

  it('requires logical lineage and the physical inherited cut to agree', () => {
    const unseeded = meta('lineage-cut')
    expect(() => toHeaderLine({ ...unseeded, isSeeded: true }))
      .toThrow('seeded session header requires an inherited event count')
    expect(() => toHeaderLine(unseeded, SessionLogOffset(1)))
      .toThrow('unseeded session header inherited event count must be 0')
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

  it('resolves a relative custom root before storing a session', async () => {
    const absoluteRoot = await freshRoot()
    const ctx = new Context()
    const fiber = await ctx.plugin(JsonlSessionPersistence, {
      root: relative(process.cwd(), absoluteRoot),
      compression: 'none',
    })
    const m = meta('relative-location', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    expect((await stat(rawLogPath(resolve(absoluteRoot), '/work', m.id))).isFile()).toBe(true)
    await fiber.dispose()
  })
})

describe('JsonlSessionPersistence: stored-format refusals', () => {
  let ctx: Context
  beforeEach(async () => {
    root = await freshRoot()
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  it('propagates a non-format header failure from stat and list unchanged', async () => {
    // Only foreign-version refusals are enriched (stat) or skipped (list);
    // any other header failure stays fail-loud on both paths.
    const id = SessionId('retired-policy-header')
    const path = rawLogPath(root, '/work', id)
    await mkdir(dirname(path), { recursive: true })
    const line = { type: 'session', version: 0, id, createdAt: 1, delegationDepth: 0, sandboxMode: 'strict' }
    await writeFile(path, `${JSON.stringify(line)}\n`)
    await expect(ctx.sessionPersistence.stat(id)).rejects.toThrow('retired policy baseline fields')
    await expect(ctx.sessionPersistence.list()).rejects.toThrow('retired policy baseline fields')
  })

  it('refuses a structurally foreign future header as unsupported, not corrupt or absent', async () => {
    // A future format need not satisfy this build's header shape at all (no
    // createdAt, unknown fields): the version must be refused before shape
    // validation, so the user sees the upgrade direction — never "not found".
    const id = SessionId('future-shape')
    const path = rawLogPath(root, '/work', id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ type: 'session', version: 42, id, futureOnly: true })}\n{"future":"row"}\n`)
    for (const access of ['read', 'write'] as const) {
      const failure = await ctx.sessionPersistence.open(id, access).then(() => undefined, (error: unknown) => error as Error)
      expect(failure?.name).toBe('SessionFormatUnsupportedError')
      expect(failure?.message).toMatch(/written by a newer harness.*upgrade the harness/)
      expect(failure?.message).toContain(`(raw log: ${path})`)
    }
    // Listing skips the unreadable header instead of failing the whole root.
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })

  it('refuses a well-shaped newer-version header at read open with the upgrade direction', async () => {
    // A header that satisfies the current shape but carries a future version:
    // stat can parse it, and the open still refuses before handing out a
    // handle whose every read would fail.
    const id = SessionId('future-version')
    const path = rawLogPath(root, '/work', id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ type: 'session', version: 42, id, createdAt: 1, cwd: '/work', delegationDepth: 0 })}\n`)
    const failure = await ctx.sessionPersistence.open(id, 'read').then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.name).toBe('SessionFormatUnsupportedError')
    expect(failure?.message).toMatch(/upgrade the harness/)
    expect(failure?.message).toContain(`(raw log: ${path})`)
  })

  it('keeps a non-object header line a corruption, not a format refusal', async () => {
    // Valid JSON that is no object carries no version to compare, so the
    // version guard must pass it through to the corruption diagnostics.
    const id = SessionId('scalar-header')
    const path = rawLogPath(root, '/work', id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '42\n')
    const failure = await ctx.sessionPersistence.open(id, 'read').then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.name).not.toBe('SessionFormatUnsupportedError')
    expect(failure?.message).toContain('first line is not a session header')
  })

  it('names a foreign-version header by its stringified non-string id', async () => {
    // A future header's id field is as untrusted as the rest of its shape:
    // the refusal must still name the session it read, not crash on the type.
    const id = SessionId('numeric-id')
    const path = rawLogPath(root, '/work', id)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ type: 'session', version: 42, id: 123 })}\n`)
    const failure = await ctx.sessionPersistence.open(id, 'read').then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.name).toBe('SessionFormatUnsupportedError')
    expect(failure?.message).toContain('session "123" uses log format v42')
  })

  it('points a format refusal for a self-written foreign version at the raw log path', async () => {
    // create() stores the caller's header verbatim, so a foreign version can
    // reach disk through this build; reads then refuse it with the location.
    const m = { ...meta('newer-format', '/work'), version: 7 }
    await writeLog(ctx.sessionPersistence, m, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const failure = await ctx.sessionPersistence.open(m.id, 'read').then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.name).toBe('SessionFormatUnsupportedError')
    expect(failure?.message).toContain(`(raw log: ${rawLogPath(root, '/work', m.id)})`)
  })

  it('serves a read open through the full log read when the header-only read races a writer', async () => {
    const m = meta('stat-race-open', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    // Simulate the race: the header-only stat sees nothing although the full
    // log is present and readable.
    vi.spyOn(ctx.sessionPersistence, 'stat').mockResolvedValue(undefined)
    const handle = await ctx.sessionPersistence.open(m.id, 'read')
    try {
      expect(handle.header).toMatchObject({ id: m.id, cwd: '/work' })
      expect(await handle.read()).toEqual(oneTurnLog())
    } finally {
      await handle.close()
    }
  })

  it('rejects a stored v0 log containing a legacy request/header-delta event', async () => {
    const m = meta('legacy-header-delta', '/legacy')
    const path = rawLogPath(root, m.cwd, m.id)
    await mkdir(sessionDir(root, m.cwd, m.id), { recursive: true })
    await writeFile(path, [
      JSON.stringify(toHeaderLine(m)),
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'request/header-delta', seq: SessionSeq(1), time: 2, data: { config: { model: 'legacy' } } }),
      JSON.stringify({ type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
      '',
    ].join('\n'))

    await expect(readAll(ctx.sessionPersistence, m.id))
      .rejects.toThrow(/contains event type "request\/header-delta" \(seq 1\) unknown to this harness/)
  })

  it('rejects a stored v0 full header carrying the legacy fallback reason', async () => {
    const m = meta('legacy-header-fallback', '/legacy')
    const path = rawLogPath(root, m.cwd, m.id)
    await mkdir(sessionDir(root, m.cwd, m.id), { recursive: true })
    await writeFile(path, [
      JSON.stringify(toHeaderLine(m)),
      JSON.stringify({
        type: 'request/header',
        seq: SessionSeq(0),
        time: 1,
        data: { header: { config: { provider: 'mock', model: 'legacy' } }, reason: 'fallback' },
      }),
      '',
    ].join('\n'))

    await expect(readAll(ctx.sessionPersistence, m.id))
      .rejects.toThrow(/unsupported legacy reason "fallback"/)
  })
})

describe('JsonlSessionPersistence: durability and crash semantics', () => {
  let ctx: Context
  beforeEach(async () => {
    root = await freshRoot()
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  it('lazy materialization: create() writes no file until the first append', async () => {
    const m = meta('lazy', '/work')
    const handle = await ctx.sessionPersistence.create(m)
    // create() materializes no file before the first append — while the
    // created session is already visible to this process.
    const dir = sessionDir(root, '/work', m.id)
    await expect(stat(rawLogPath(root, '/work', m.id))).rejects.toThrow()
    expect((await ctx.sessionPersistence.list()).map(s => s.header.id)).toContain(m.id)
    expect((await ctx.sessionPersistence.stat(m.id))?.sizeBytes).toBeUndefined()

    await handle.append(oneTurnLog())
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect((await stat(rawLogPath(root, '/work', m.id))).isFile()).toBe(true)
    expect((await ctx.sessionPersistence.list()).map(s => s.header.id)).toContain(m.id)
    await handle.close()
  })

  it('flush materializes an explicitly durable empty session without an event row', async () => {
    const m = meta('durable-empty', '/work')
    const handle = await ctx.sessionPersistence.create(m)
    await handle.flush()
    await handle.close()

    expect(await readFile(rawLogPath(root, '/work', m.id), 'utf8')).toBe(`${JSON.stringify(toHeaderLine(m))}\n`)
    await expect(readAll(ctx.sessionPersistence, m.id)).resolves.toMatchObject({ events: [] })
  })

  it('close drains a routed event that arrives while it waits for an in-flight append', async () => {
    const m = meta('late-closer', '/work')
    const handle = await ctx.sessionPersistence.create(m) as JsonlSessionHandle
    const service = ctx.sessionPersistence as unknown as {
      persistBatch: (...args: [SessionHeader, readonly SessionEvent[], boolean]) => Promise<void>
    }
    const original = service.persistBatch.bind(service)
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    vi.spyOn(service, 'persistBatch').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await gate.promise
      return original(...args)
    })

    const [start, ...rest] = oneTurnLog()
    const inflight = handle.append([start!])
    // The append is in flight (inside the gated storage write) before close
    // starts, so close waits on the chain rather than refusing the append.
    await entered.promise
    const closing = handle.close()
    // A concurrently unwinding producer routes more events while close waits
    // on the blocked chain; the close loop must still drain them.
    for (const event of rest) handle.enqueueLive(event, () => {})
    gate.resolve(undefined)
    await inflight
    await closing

    const reopened = new Context()
    await reopened.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expect(readAll(reopened.sessionPersistence, m.id))
      .resolves.toMatchObject({ events: oneTurnLog() })
    await reopened.fiber.dispose()
  })

  it('service flush skips a write claim whose handle is still opening', async () => {
    const m = meta('opening-claim', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const service = ctx.sessionPersistence as unknown as {
      readStoredLog: (...args: [string, SessionId]) => Promise<unknown>
    }
    const original = service.readStoredLog.bind(service)
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    vi.spyOn(service, 'readStoredLog').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await gate.promise
      return original(...args)
    })

    const opening = ctx.sessionPersistence.open(m.id, 'write')
    await entered.promise
    // The claim exists but its handle is still constructing: nothing routes
    // to it yet, so the barrier has nothing to flush there.
    await ctx.sessionPersistence.flush()
    gate.resolve(undefined)
    await (await opening).close()
  })

  it('stat and list carry the physical artifact size once materialized', async () => {
    const m = meta('sized', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const size = (await stat(rawLogPath(root, '/work', m.id))).size
    expect((await ctx.sessionPersistence.stat(m.id))?.sizeBytes).toBe(size)
    expect((await ctx.sessionPersistence.list()).find(s => s.header.id === m.id)?.sizeBytes).toBe(size)
  })

  it('binds revisions to the physical artifact identity', async () => {
    const m = meta('revision-source')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const revision = (await ctx.sessionPersistence.stat(m.id))?.revision

    // A fresh backend over the SAME root reports the same revision…
    const reopenedCtx = new Context()
    await reopenedCtx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    expect((await reopenedCtx.sessionPersistence.stat(m.id))?.revision).toBe(revision)

    // …while an identical log in a DIFFERENT root is a different source.
    const otherRoot = await freshRoot()
    const otherCtx = new Context()
    await otherCtx.plugin(JsonlSessionPersistence, { root: otherRoot, compression: 'none' })
    await writeLog(otherCtx.sessionPersistence, m, oneTurnLog())
    expect((await otherCtx.sessionPersistence.stat(m.id))?.revision).not.toBe(revision)

    await reopenedCtx.fiber.dispose()
    await otherCtx.fiber.dispose()
  })





  it('an unchanged cold log parses once across an observe-then-resume handoff', async () => {
    const m = meta('memo-handoff', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const path = rawLogPath(root, '/work', m.id)
    readTally.enabled = true

    // The observation's read parses the artifact...
    expect((await readAll(ctx.sessionPersistence, m.id)).events).toEqual(oneTurnLog())
    expect(readTally.bySuffix.get(path)).toBe(1)
    // ...and the immediate write-open (resume) reuses the parsed log through
    // the revision guard instead of re-reading the file.
    const writer = await ctx.sessionPersistence.open(m.id, 'write')
    expect((await writer.read()).length).toBe(oneTurnLog().length)
    expect(readTally.bySuffix.get(path)).toBe(1)

    // A local append invalidates the memo: the next cold read re-parses and
    // observes the appended suffix.
    await writer.append([
      { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
      { type: 'turn/end', seq: SessionSeq(7), time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    await writer.close()
    expect((await readAll(ctx.sessionPersistence, m.id)).events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(readTally.bySuffix.get(path)).toBe(2)
  })

  it('a foreign write misses the memo through the revision guard', async () => {
    const m = meta('memo-foreign', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const path = rawLogPath(root, '/work', m.id)
    await readAll(ctx.sessionPersistence, m.id)

    // Another backend instance over the same root appends behind this one's memo.
    const foreign = new Context()
    await foreign.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const writer = await foreign.sessionPersistence.open(m.id, 'write')
    await writer.append([
      { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
      { type: 'turn/end', seq: SessionSeq(7), time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    await writer.close()
    await foreign.fiber.dispose()

    readTally.enabled = true
    expect((await readAll(ctx.sessionPersistence, m.id)).events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(readTally.bySuffix.get(path)).toBe(1)
  })

  it('the cold-log memo keeps only the handoff window and evicts the oldest id', async () => {
    const first = meta('memo-evict-a', '/work')
    const second = meta('memo-evict-b', '/work')
    const third = meta('memo-evict-c', '/work')
    for (const m of [first, second, third]) await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    readTally.enabled = true

    await readAll(ctx.sessionPersistence, first.id)
    await readAll(ctx.sessionPersistence, second.id)
    await readAll(ctx.sessionPersistence, third.id) // evicts the first id
    await readAll(ctx.sessionPersistence, third.id) // still memoized
    await readAll(ctx.sessionPersistence, first.id) // re-parses after eviction
    expect(readTally.bySuffix.get(rawLogPath(root, '/work', first.id))).toBe(2)
    expect(readTally.bySuffix.get(rawLogPath(root, '/work', third.id))).toBe(1)
  })

  it('a handle read retries once when the file revision changes during the read', async () => {
    const m = meta('read-revision-race', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const handle = await ctx.sessionPersistence.open(m.id, 'read')
    try {
      statRace.path = rawLogPath(root, '/work', m.id)
      expect(await handle.read()).toEqual(oneTurnLog())
      // The memo probe, the initial identity, the mismatching post-read stat
      // (reused as the retry's pre-read identity), and the retry's matching
      // post-read stat.
      expect(statRace.reads).toBe(4)
    } finally {
      statRace.path = undefined
      await handle.close()
    }
  })

  it('a continuously churning revision yields the committed prefix instead of looping', async () => {
    const m = meta('read-revision-churn', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const handle = await ctx.sessionPersistence.open(m.id, 'read')
    try {
      statRace.mode = 'churn'
      statRace.path = rawLogPath(root, '/work', m.id)
      // Every stat disagrees, so the bounded read stops after one retry and
      // serves the retry's pre-read committed prefix — here the whole log.
      // Four stats: the memo probe, the initial identity, and one mismatching
      // post-read stat per bounded attempt.
      expect(await handle.read()).toEqual(oneTurnLog())
      expect(statRace.reads).toBe(4)
    } finally {
      statRace.path = undefined
      await handle.close()
    }
  })

  it('appends on reopen extend the same artifact and a fork materializes its own', async () => {
    const parent = meta('location-parent', '/work')
    await writeLog(ctx.sessionPersistence, parent, oneTurnLog())
    const parentPath = rawLogPath(root, '/work', parent.id)
    const sizeBefore = (await stat(parentPath)).size

    const loaded = await readAll(ctx.sessionPersistence, parent.id)
    const writer = await ctx.sessionPersistence.open(parent.id, 'write')
    await writer.append([
      { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
      { type: 'turn/end', seq: SessionSeq(7), time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    await writer.close()
    // The resume-side append extended the same physical artifact.
    expect((await stat(parentPath)).size).toBeGreaterThan(sizeBefore)

    const child = {
      ...loaded.meta,
      id: SessionId('location-child'),
      parentSession: parent.id,
      seedLength: loaded.events.length,
    }
    await writeLog(ctx.sessionPersistence, child, oneTurnLog())
    const childPath = rawLogPath(root, '/work', child.id)
    expect(childPath).not.toBe(parentPath)
    expect((await stat(childPath)).isFile()).toBe(true)
  })

  it('round-trip is byte-identical (incl. assistant/chunk verbatim)', async () => {
    const m = meta('chunks')
    const log: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'he' } } },
      { type: 'assistant/chunk', seq: SessionSeq(3), time: 4, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'llo' } } },
      { type: 'assistant/message', seq: SessionSeq(4), time: 5, data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      }, surfaceOp: 'append', sourceEventSeqs: [SessionSeq(2), SessionSeq(3)] },
      { type: 'step/end', seq: SessionSeq(5), time: 6, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(6), time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await writeLog(ctx.sessionPersistence, m, log)
    const loaded = await readAll(ctx.sessionPersistence, m.id)
    expect(loaded.events).toEqual(log) // chunks preserved, contiguous seqs
  })

  it('a torn crash tail is served as the committed prefix and repaired only by the write path', async () => {
    const m = meta('crash', '/proj')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog()) // seqs 0..5
    const path = rawLogPath(root, '/proj', m.id)
    const committed = await readFile(path)
    // A crash mid-second-turn: two complete uncommitted lines plus a torn
    // fragment with no newline.
    const tail = [
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(6), time: 8, data: { turn: 2 } }),
      JSON.stringify({ type: 'step/start', seq: SessionSeq(7), time: 9, data: { turn: 2, step: 1 } }),
      '{"type":"assistant/chunk","seq":8,"ti', // truncated partial line (no newline)
    ].join('\n')
    await writeFile(path, tail, { flag: 'a' })

    // A reader serves the valid contiguous prefix — the complete tail lines
    // ARE committed reads, the torn fragment never is — without repairing.
    const loaded = await readAll(ctx.sessionPersistence, m.id)
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(await readFile(path)).toEqual(Buffer.concat([committed, Buffer.from(tail)]))

    // The write path truncates the torn fragment durably before its first
    // append, preserving every committed byte before it.
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await appendBatch(ctx.sessionPersistence, m.id, [
      { type: 'step/end', seq: SessionSeq(8), time: 10, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(9), time: 11, data: { turn: 2, reason: { kind: 'interrupted' } } },
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovered from a torn tail'))
    const repaired = await readFile(path, 'utf8')
    expect(repaired.startsWith(committed.toString('utf8'))).toBe(true)
    expect(repaired).not.toContain('assistant/chunk')
    const reloaded = await readAll(ctx.sessionPersistence, m.id)
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('a stored open turn is served as stored, with no synthetic closers', async () => {
    // Logical repair (closing an interrupted turn) is a resume concern; the
    // storage seam returns exactly the committed events.
    const m = meta('open-turn', '/h')
    await writeLog(ctx.sessionPersistence, m, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ])
    const { events } = await readAll(ctx.sessionPersistence, m.id)
    expect(events.map(e => e.type)).toEqual(['turn/start'])
  })

  it('a failed appendLines truncates partial bytes so a retry has no seq gap', async () => {
    const m = meta('truncate-retry')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog()) // materialized, seqs 0..5
    const sizeBefore = (await stat(rawLogPath(root, undefined, m.id))).size

    const handle = await ctx.sessionPersistence.open(m.id, 'write')
    try {
      // Force the NEXT fsync (inside appendLines) to fail once, AFTER writeFile
      // has already put bytes on disk — simulating an ENOSPC/fsync error
      // mid-append. The recovery truncate() also fsyncs, so allow that one.
      const probe = await (await import('node:fs/promises')).open(rawLogPath(root, undefined, m.id), 'r')
      const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
      await probe.close()
      const realSync = proto.sync
      let failed = false
      const spy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: unknown) {
        if (!failed) { failed = true; throw new Error('simulated fsync ENOSPC') }
        return realSync.call(this)
      })

      const turn2: SessionEvent[] = [
        { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
        { type: 'turn/end', seq: SessionSeq(7), time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
      ]
      // The append rejects, but the partial bytes are truncated back: the file
      // is its pre-append size and the handle cursor is unchanged.
      await expect(handle.append(turn2)).rejects.toThrow(/ENOSPC/)
      expect((await stat(rawLogPath(root, undefined, m.id))).size).toBe(sizeBefore)
      spy.mockRestore()

      // The retry now succeeds with NO seq gap — the log is contiguous 0..7.
      await handle.append(turn2)
      expect((await handle.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    } finally {
      await handle.close()
    }
  })

  it('reports both the append failure and a failed rollback', async () => {
    const m = meta('rollback-failure')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())

    const path = rawLogPath(root, undefined, m.id)
    const probe = await (await import('node:fs/promises')).open(path, 'r')
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    await probe.close()
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
      await appendBatch(ctx.sessionPersistence, m.id, [
        { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
      ])
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

  it('rejects a mismatched header id before serving either session log', async () => {
    const a = meta('identity-a', '/same')
    const b = meta('identity-b', '/same')
    await writeLog(ctx.sessionPersistence, a, [{
      type: 'turn/start',
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
    }])
    await writeLog(ctx.sessionPersistence, b, oneTurnLog())

    const aPath = rawLogPath(root, a.cwd, a.id)
    const bPath = rawLogPath(root, b.cwd, b.id)
    await rewriteHeader(aPath, (header) => { header.id = b.id })
    const beforeA = await readFile(aPath)
    const beforeB = await readFile(bPath)

    await expect(readAll(ctx.sessionPersistence, a.id))
      .rejects.toThrow(/requested id "identity-a" does not match header id "identity-b"/)
    expect(await readFile(aPath)).toEqual(beforeA)
    expect(await readFile(bPath)).toEqual(beforeB)
  })

  it('path-traversal session ids are neutralized (no escape from root)', async () => {
    const evil = SessionId('../../etc/pwn')
    const m = { version: 0, id: evil, createdAt: 1, isSeeded: false }
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
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

  it('rejects pre-aborted operations with the exact cancellation reason', async () => {
    const m = meta('pre-aborted')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const reason = new Error('persistence operation cancelled')
    const controller = new AbortController()
    controller.abort(reason)
    const signal = controller.signal

    await expect(ctx.sessionPersistence.create(meta('aborted-create'), { signal })).rejects.toBe(reason)
    await expect(ctx.sessionPersistence.open(m.id, 'read', { signal })).rejects.toBe(reason)
    await expect(ctx.sessionPersistence.open(m.id, 'write', { signal })).rejects.toBe(reason)
    await expect(ctx.sessionPersistence.stat(m.id, { signal })).rejects.toBe(reason)
    await expect(ctx.sessionPersistence.list({ signal })).rejects.toBe(reason)

    const handle = await ctx.sessionPersistence.open(m.id, 'write')
    try {
      await expect(handle.read(0, undefined, { signal })).rejects.toBe(reason)
      await expect(handle.append([
        { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
      ], { signal })).rejects.toBe(reason)
      await expect(handle.flush({ signal })).rejects.toBe(reason)
      // The aborted mutations left the log untouched.
      expect((await handle.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
    } finally {
      await handle.close()
    }
  })

  it('stat handles artifact removal and non-ENOENT failures after log discovery', async () => {
    const m = meta('stored-revision-race')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const persistence = ctx.sessionPersistence as JsonlSessionPersistence
    const internals = persistence as unknown as {
      findLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
    }
    const path = rawLogPath(root, m.cwd, m.id)
    const findLog = vi.spyOn(internals, 'findLog').mockResolvedValue(path)

    await rm(path)
    expect(await persistence.stat(m.id)).toBeUndefined()

    const invalidPath = `${path}\0`
    findLog.mockResolvedValue(invalidPath)
    await expect(persistence.stat(m.id)).rejects.toMatchObject({
      code: 'ERR_INVALID_ARG_VALUE',
    })

    const reason = new Error('stat cancelled after discovery')
    const controller = new AbortController()
    findLog.mockImplementation(async () => {
      controller.abort(reason)
      return invalidPath
    })
    await expect(persistence.stat(m.id, { signal: controller.signal })).rejects.toBe(reason)
  })

  it('stat reports absence for an artifact vanishing before its identity stat and surfaces other faults', async () => {
    const m = meta('stat-fault', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    // The header read succeeds; the identity stat then loses the file (a
    // concurrent removal) or hits a storage fault.
    statFailure.path = rawLogPath(root, '/work', m.id)
    statFailure.error = Object.assign(new Error('ENOENT: vanished'), { code: 'ENOENT' })
    expect(await ctx.sessionPersistence.stat(m.id)).toBeUndefined()
    statFailure.error = Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    await expect(ctx.sessionPersistence.stat(m.id)).rejects.toThrow(/EACCES/)
  })

  it('an empty append batch is a no-op that does not materialize', async () => {
    const m = meta('empty-batch', '/work')
    const handle = await ctx.sessionPersistence.create(m)
    await handle.append([])
    await expect(stat(rawLogPath(root, '/work', m.id))).rejects.toThrow()
    await handle.append(oneTurnLog())
    expect((await handle.read()).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
    await handle.close()
  })

  it('lists a pending id once when an artifact for the same id appears beneath it', async () => {
    const m = meta('shadowed', '/w')
    const creator = await ctx.sessionPersistence.create(m)
    // An artifact materialized outside this instance's create/append path.
    await mkdir(sessionDir(root, '/w', m.id), { recursive: true })
    await writeFile(rawLogPath(root, '/w', m.id), [
      JSON.stringify(toHeaderLine(m)),
      ...oneTurnLog().map(e => JSON.stringify(e)),
    ].join('\n') + '\n')

    const entries = (await ctx.sessionPersistence.list()).filter(s => s.header.id === m.id)
    expect(entries).toHaveLength(1)
    // The artifact entry wins over the pending one.
    expect(entries[0]!.sizeBytes).toBeDefined()
    await creator.close()
  })

  it('a read handle over an erased pending session fails loudly', async () => {
    const m = meta('erased-pending')
    const creator = await ctx.sessionPersistence.create(m)
    const reader = await ctx.sessionPersistence.open(m.id, 'read')
    expect(await reader.read()).toEqual([])
    // The creator closes without ever appending: the session never existed.
    await creator.close()
    await expect(reader.read()).rejects.toThrow(/not found/)
    await reader.close()
  })

  it('a read handle rejects a stored log that shrank below an observed prefix', async () => {
    const m = meta('shrunk', '/work')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const reader = await ctx.sessionPersistence.open(m.id, 'read')
    try {
      expect(await reader.read()).toHaveLength(6)
      // Committed events are never rewritten; a shorter file is damage, not a
      // legal state, and a handle must not silently backtrack.
      await writeFile(rawLogPath(root, '/work', m.id), [
        JSON.stringify(toHeaderLine(m)),
        JSON.stringify(oneTurnLog()[0]),
      ].join('\n') + '\n')
      await expect(reader.read()).rejects.toThrow(/shrank below a previously observed prefix/)
    } finally {
      await reader.close()
    }
  })

  it('backend dispose aggregates open-handle close failures into one reported error', async () => {
    const ctx2 = new Context()
    const fiber = await ctx2.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const reported = vi.spyOn(ctx2.logger, 'error').mockImplementation(() => undefined)
    const handle = await ctx2.sessionPersistence.create(meta('dispose-fail'))
    const failure = new Error('close exploded')
    vi.spyOn(handle, 'close').mockRejectedValue(failure)
    await fiber.dispose()
    // Cordis contains effect-disposal failures and reports them; the backend's
    // teardown aggregate names every handle that refused to close.
    const aggregate = reported.mock.calls
      .map((call): unknown => call[0])
      .find((value): value is AggregateError => value instanceof AggregateError)
    expect(aggregate?.message).toContain('session-persistence-jsonl dispose failed')
    expect(aggregate?.errors).toEqual([failure])
  })

  it('omits a listed artifact removed after discovery', async () => {
    const m = meta('vanishing-snapshot')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const persistence = ctx.sessionPersistence as unknown as {
      listArtifacts(): Promise<Array<{ header: SessionHeader; path: string }>>
    }
    const listArtifacts = persistence.listArtifacts.bind(persistence)
    const discovery = vi.spyOn(persistence, 'listArtifacts').mockImplementation(async () => {
      const artifacts = await listArtifacts()
      await rm(artifacts[0]!.path)
      return artifacts
    })

    await expect(ctx.sessionPersistence.list()).resolves.toEqual([])
    discovery.mockRestore()
  })

  it('surfaces non-ENOENT stat failures during listing', async () => {
    const persistence = ctx.sessionPersistence as unknown as {
      listArtifacts(): Promise<Array<{ header: SessionHeader; path: string }>>
    }
    const discovery = vi.spyOn(persistence, 'listArtifacts').mockResolvedValue([{
      header: meta('snapshot-stat-failure'),
      path: `${root}\0snapshot-stat-failure`,
    }])

    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/null bytes/)
    discovery.mockRestore()
  })

  it('forwards list cancellation and awaits in-flight discovery cleanup', async () => {
    const persistence = ctx.sessionPersistence as unknown as {
      listArtifacts(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; path: string }>>
    }
    const started = Promise.withResolvers<AbortSignal>()
    const cleanup = Promise.withResolvers<undefined>()
    vi.spyOn(persistence, 'listArtifacts').mockImplementation(async (signal) => {
      if (signal === undefined) throw new Error('expected list signal')
      started.resolve(signal)
      await cleanup.promise
      return []
    })
    const reason = new Error('JSONL list discovery cancelled')
    const controller = new AbortController()
    const pending = ctx.sessionPersistence.list({ signal: controller.signal })
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

  it('checks cancellation after an uncancellable list stat settles', async () => {
    const m = meta('snapshot-stat-cancellation')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const persistence = ctx.sessionPersistence as unknown as {
      listArtifacts(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; path: string }>>
    }
    const discovery = vi.spyOn(persistence, 'listArtifacts').mockResolvedValue([{
      header: m,
      path: rawLogPath(root, m.cwd, m.id),
    }])
    const reason = new Error('JSONL list stat cancelled')
    const controller = new AbortController()
    const pending = ctx.sessionPersistence.list({ signal: controller.signal })
    queueMicrotask(() => { controller.abort(reason) })

    await expect(pending).rejects.toBe(reason)
    expect(discovery).toHaveBeenCalledWith(controller.signal)
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
      JSON.stringify({ type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } }),
      '',
    ].join('\n')))
    expect(scanner.finish().events).toEqual([oneTurnLog()[0]])

    const committed = new SessionLogScanner(header)
    expect(() => { committed.write(Buffer.from([
      JSON.stringify({ type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
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
      isSeeded: false,
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
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } }), // gap: missing seq 1
    ].join('\n') + '\n'
    // No committed turn/end, so the gap is a tolerated crash boundary: scanLog
    // PRESERVES the contiguous prefix (turn/start seq 0) — real interrupted-turn
    // work, not discarded — and stops at the gap.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('rejects a seq gap BEFORE a later committed turn/end (committed data damaged)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 'g2', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } }), // gap: missing seq 1
      JSON.stringify({ type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
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
        JSON.stringify({ type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
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
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      '{not json', // corrupt crash fragment, no turn/end committed
    ].join('\n') + '\n'
    // The contiguous prefix (turn/start seq 0) is preserved; the corrupt
    // fragment after it is the tolerated crash boundary.
    expect(scanLog(Buffer.from(log)).events.map(e => e.seq)).toEqual([0])
  })

  it('tolerates a seq gap AFTER a turn/end (uncommitted tail)', () => {
    const log = [
      JSON.stringify({ type: 'session', version: 0, id: 't', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      JSON.stringify({ type: 'step/start', seq: SessionSeq(9), time: 3, data: { turn: 2, step: 1 } }), // gap in uncommitted tail
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
    // compression: 'none' — these tests assert the textual storage-record layout
    // (row tags per line); packing is orthogonal to the physical encoding.
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  /** A one-turn log whose step streams a five-member text-delta run. */
  function chunkRunLog(): SessionEvent[] {
    const deltas: SessionEvent[] = Array.from({ length: 5 }, (_, k) => ({
      type: 'assistant/chunk',
      seq: SessionSeq(2 + k),
      time: 3 + k,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `t${k}` } },
    }))
    return [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
      ...deltas,
      { type: 'assistant/message', seq: SessionSeq(7), time: 8, data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 't0t1t2t3t4' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      }, surfaceOp: 'append', sourceEventSeqs: [2, 3, 4, 5, 6].map(SessionSeq) },
      { type: 'step/end', seq: SessionSeq(8), time: 9, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(9), time: 10, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
  }

  it('writes a delta run as one text-chunks row by default and loads back identical events', async () => {
    const m = meta('packed', '/work')
    const log = chunkRunLog()
    await writeLog(ctx.sessionPersistence, m, log)

    const raw = (await readFile(rawLogPath(root, '/work', m.id), 'utf8')).split('\n').filter(Boolean)
    const tags = raw.slice(1).map(line => (JSON.parse(line) as { type: string }).type)
    expect(tags).toEqual(['turn/start', 'step/start', 'text-chunks', 'assistant/message', 'step/end', 'turn/end'])

    const loaded = await readAll(ctx.sessionPersistence, m.id)
    expect(loaded.events).toEqual(log)
  })

  it('packChunks: false writes one event per line and still loads identical events', async () => {
    const unpackedRoot = await freshRoot()
    const unpacked = new Context()
    await unpacked.plugin(JsonlSessionPersistence, {
      root: unpackedRoot,
      packChunks: false,
      compression: 'none',
    })
    try {
      const m = meta('unpacked', '/work')
      const log = chunkRunLog()
      await writeLog(unpacked.sessionPersistence, m, log)

      const records = (await readFile(rawLogPath(unpackedRoot, '/work', m.id), 'utf8'))
        .split('\n').filter(Boolean).slice(1)
        .map(line => JSON.parse(line) as { type: string })
      expect(records.filter(record => record.type === 'assistant/chunk')).toHaveLength(5)
      expect(records.some(record => record.type === 'text-chunks')).toBe(false)
      expect((await readAll(unpacked.sessionPersistence, m.id)).events).toEqual(log)
    } finally {
      await unpacked.fiber.dispose()
    }
  })

  it('loads a mixed file: verbatim lines from an unpacked writer, then packed appends', async () => {
    const m = meta('mixed', '/work')
    const log = chunkRunLog()
    // First turn written line-per-event by an unpacked-config writer (an old
    // file, hand-planted so this packed-config backend adopts it on open).
    await mkdir(sessionDir(root, '/work', m.id), { recursive: true })
    await writeFile(rawLogPath(root, '/work', m.id), [
      JSON.stringify({ type: 'session', version: 0, id: 'mixed', createdAt: 1000, cwd: '/work', delegationDepth: 0 }),
      ...log.map(e => JSON.stringify(e)),
    ].join('\n') + '\n')
    // Adopt the stored log (cursor = stored length), then append a second turn
    // through THIS packed-config backend.
    expect((await readAll(ctx.sessionPersistence, m.id)).events).toEqual(log)
    const secondTurn: SessionEvent[] = JSON.parse(JSON.stringify(log)) as SessionEvent[]
    for (const [k, e] of secondTurn.entries()) {
      ;(e as { seq: number }).seq = 10 + k
      ;(e.data as { turn: number }).turn = 2
    }
    await appendBatch(ctx.sessionPersistence, m.id, secondTurn)

    const loaded = await readAll(ctx.sessionPersistence, m.id)
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
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'text-chunks', seq0: 1, time0: 2, data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] } }),
      JSON.stringify({ type: 'turn/end', seq: SessionSeq(4), time: 5, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    const { events } = scanLog(Buffer.from(logText))
    expect(events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4])
    expect(events[2]).toEqual({ type: 'assistant/chunk', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } } })
  })

  it('scanLog: a malformed packed row in the committed region rejects like corrupt JSON', () => {
    const logText = [
      JSON.stringify({ type: 'session', version: 0, id: 'bad-row', createdAt: 1, delegationDepth: 0 }),
      // dt arity mismatch — row validation throws, so the line is a committed hole.
      JSON.stringify({ type: 'text-chunks', seq0: 0, time0: 1, data: { turn: 1, step: 1, index: 0, dt: [], texts: ['a', 'b'] } }),
      JSON.stringify({ type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
    ].join('\n') + '\n'
    expect(() => scanLog(Buffer.from(logText))).toThrow(/unparsable committed event/)
  })

  it('scanLog: a packed row with a mid-run seq gap after the last turn/end drops the whole row', () => {
    const logText = [
      JSON.stringify({ type: 'session', version: 0, id: 'row-gap', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }),
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
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })
  afterEach(async () => { await ctx.fiber.dispose() })

  it('create snapshots its meta: mutating the caller object after the call is ignored', async () => {
    const m = meta('create-snap', '/orig')
    const p = ctx.sessionPersistence.create(m)
    // Mutate the caller's meta object immediately after calling create.
    mutableHeader(m).cwd = '/mutated'
    const handle = await p
    await handle.append(oneTurnLog())
    await handle.close()
    // The log materialized under the ORIGINAL cwd, not the mutated one.
    expect((await stat(rawLogPath(root, '/orig', SessionId('create-snap')))).isFile()).toBe(true)
    await expect(stat(rawLogPath(root, '/mutated', SessionId('create-snap')))).rejects.toThrow()
  })

  it('create rejects non-JSON metadata and a fractional creation timestamp without reserving the id', async () => {
    await expect(ctx.sessionPersistence.create({ ...meta('bad-meta'), extra: 1n } as unknown as SessionHeader))
      .rejects.toThrow('session metadata must be losslessly JSON-serializable')
    await expect(ctx.sessionPersistence.create({ ...meta('fractional-created-at'), createdAt: 1.5 }))
      .rejects.toThrow('session metadata createdAt must be a non-negative safe integer')

    // The rejected create reserved nothing: the id is free.
    const valid = meta('fractional-created-at')
    await writeLog(ctx.sessionPersistence, valid, oneTurnLog())
    expect((await readAll(ctx.sessionPersistence, valid.id)).meta.createdAt).toBe(valid.createdAt)
  })

  it('list discovers sessions across multiple project directories', async () => {
    await writeLog(ctx.sessionPersistence, meta('p1', '/projA'), oneTurnLog())
    await writeLog(ctx.sessionPersistence, meta('p2', '/projB'), oneTurnLog())
    await writeLog(ctx.sessionPersistence, meta('p3'), oneTurnLog()) // no cwd → _no-cwd project directory

    const ids = (await ctx.sessionPersistence.list()).map(s => s.header.id).sort()
    expect(ids).toEqual(['p1', 'p2', 'p3'])
  })

  it('groups sessions whose cwd paths normalize to the same project directory', async () => {
    const first = meta('normalized-first', '/a/b-c')
    const second = meta('normalized-second', '/a-b/c')
    await writeLog(ctx.sessionPersistence, first, oneTurnLog())
    await writeLog(ctx.sessionPersistence, second, oneTurnLog())

    expect(projectDir(root, first.cwd)).toBe(projectDir(root, second.cwd))
    expect(await readdir(projectDir(root, first.cwd))).toEqual(expect.arrayContaining([
      encodeSegment(first.id),
      encodeSegment(second.id),
    ]))
    expect((await ctx.sessionPersistence.list()).map(s => s.header.id).sort())
      .toEqual([first.id, second.id].sort())
  })

  it('list on an empty root returns nothing', async () => {
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })

  it('keeps the transcript in an extensible session-owned directory', async () => {
    const m = meta('owned-directory', '/project')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const dir = sessionDir(root, m.cwd, m.id)
    await writeFile(join(dir, 'metadata.json'), '{}\n')
    await writeFile(join(projectDir(root, m.cwd), 'README'), 'project metadata\n')
    await mkdir(join(projectDir(root, m.cwd), 'reserved-session'), { recursive: true })

    expect(await readdir(dir)).toEqual(expect.arrayContaining(['metadata.json', 'session.jsonl']))
    expect((await ctx.sessionPersistence.list()).map(s => s.header.id)).toContain(m.id)
    expect((await readAll(ctx.sessionPersistence, m.id)).events).toEqual(oneTurnLog())
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

    await expect(ctx.sessionPersistence.open(m.id, 'read')).rejects.toThrow(/unsupported flat-file layout/)
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/unsupported flat-file layout/)
  })

  it('rejects a compressed obsolete flat-file artifact during targeted lookup', async () => {
    const m = meta('legacy-compressed-flat', '/legacy')
    const project = projectDir(root, m.cwd)
    expect(await ctx.sessionPersistence.list()).toEqual([])
    await mkdir(project, { recursive: true })
    await writeFile(join(project, `${encodeSegment(m.id)}.jsonl.zstd`), 'legacy')

    await expect(ctx.sessionPersistence.open(m.id, 'read')).rejects.toThrow(/unsupported flat-file layout/)
  })

  it('list skips empty and non-header session logs (metadata-only read)', async () => {
    // A real session…
    await writeLog(ctx.sessionPersistence, meta('real', '/p'), oneTurnLog())
    // …alongside junk session directories whose fixed transcript is empty or
    // lacks a header. Both remain unlisted.
    for (const [id, content] of [
      ['empty', ''],
      ['notheader', '{"type":"turn/start"}\n'],
      ['badjson', 'not json at all\n'],
    ] as const) {
      const path = rawLogPath(root, undefined, SessionId(id))
      await mkdir(sessionDir(root, undefined, SessionId(id)), { recursive: true })
      await writeFile(path, content)
    }

    const ids = (await ctx.sessionPersistence.list()).map(s => s.header.id).sort()
    expect(ids).toEqual(['real'])
  })

  it('list reads a header line longer than the 8KB read chunk', async () => {
    // A tolerated extra field makes this valid header exceed the 8192-byte read buffer, proving
    // `readFirstLine` accumulates chunks before `list()` parses it.
    const id = SessionId('big')
    await mkdir(sessionDir(root, undefined, id), { recursive: true })
    const bigHeader = JSON.stringify({ type: 'session', version: 0, id: 'big', createdAt: 1, delegationDepth: 0, pad: 'x'.repeat(9000) })
    await writeFile(rawLogPath(root, undefined, id), bigHeader + '\n')
    const ids = (await ctx.sessionPersistence.list()).map(s => s.header.id)
    expect(ids).toContain('big')
  })

  it.each(['sandboxMode', 'approvalPolicy'] as const)('rejects the retired %s header field', (field) => {
    const line = { ...toHeaderLine(meta('retired-policy-header')), [field]: 'read-only' }
    expect(() => scanLog(Buffer.from(`${JSON.stringify(line)}\n`)))
      .toThrow(/retired policy baseline fields/)
  })

  it('list rejects a header whose cwd does not identify its physical log', async () => {
    const m = meta('misplaced', '/stored')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    await rewriteHeader(rawLogPath(root, m.cwd, m.id), (header) => { header.cwd = '/elsewhere' })

    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/and cwd identify/)
  })

  it('accepts an alternate project path only when it identifies the same physical log', async () => {
    const m = meta('physical-alias', '/stored')
    await writeLog(ctx.sessionPersistence, m, oneTurnLog())
    const path = rawLogPath(root, m.cwd, m.id)
    const aliasCwd = '/alias'
    await symlink(
      projectDir(root, m.cwd),
      projectDir(root, aliasCwd),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await rewriteHeader(path, (header) => { header.cwd = aliasCwd })

    expect((await readAll(ctx.sessionPersistence, m.id)).meta.cwd).toBe(aliasCwd)
    expect((await ctx.sessionPersistence.list()).map(s => s.header.id)).toContain(m.id)
  })

  it('list rejects a session header whose id cannot name a storage path', async () => {
    const dir = join(projectDir(root, undefined), 'invalid-id')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl'), JSON.stringify({
      type: 'session', version: 0, id: '', createdAt: 1, delegationDepth: 0,
    }) + '\n')

    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/header id cannot name a storage path/)
  })

  it('open and list reject one id materialized in multiple project directories', async () => {
    const id = SessionId('duplicate')
    for (const cwd of ['/a', '/b']) {
      const m = meta(id, cwd)
      await mkdir(sessionDir(root, cwd, id), { recursive: true })
      const content = [JSON.stringify(toHeaderLine(m)), ...oneTurnLog().map(event => JSON.stringify(event))].join('\n') + '\n'
      await writeFile(rawLogPath(root, cwd, id), content)
    }

    await expect(ctx.sessionPersistence.open(id, 'read')).rejects.toThrow(/appears in multiple project directories/)
    await expect(ctx.sessionPersistence.list()).rejects.toThrow(/appears in multiple project directories/)
  })

  it('create rejects an id already on disk under a different project directory', async () => {
    // Persist the id under cwd A.
    const a = meta('dup-id', '/projA')
    await writeLog(ctx.sessionPersistence, a, oneTurnLog())
    // A fresh backend creating the SAME id under cwd B must still refuse:
    // opens identify by id across all projects, so a second log would make
    // resume nondeterministic. create scans every project, not just meta.cwd's.
    const ctx2 = new Context()
    await ctx2.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expect(ctx2.sessionPersistence.create(meta('dup-id', '/projB')))
      .rejects.toThrow(/already exists/)
    await ctx2.fiber.dispose()
  })

  it('list returns nothing when the root directory does not exist', async () => {
    const ctx2 = new Context()
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
    await writeFile(projectDir(root, cwd), 'x') // project path is now a file
    const handle = await ctx.sessionPersistence.create(meta('exists-fault', cwd))
    try {
      await expectCode(handle.append(oneTurnLog()), ['EEXIST', 'ENOTDIR'])
    } finally {
      await handle.close()
    }
  })

  it('backend teardown closes handles left open and fails later operations loudly', async () => {
    const m = meta('teardown')
    const handle = await ctx.sessionPersistence.create(m)
    await handle.append(oneTurnLog())
    await ctx.fiber.dispose()
    await expect(handle.append([
      { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
    ])).rejects.toThrow(/on a closed handle/)
    // Reload the backend so the shared afterEach dispose stays valid.
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })

  it('accepts well-formed JSON values (null, booleans, nested arrays/objects)', async () => {
    const m = meta('json-ok')
    const events = [{ type: 'user/message', seq: SessionSeq(0), time: 1, data: {
      id: MessageId('json-ok'),
      role: 'user',
      content: [{ type: 'text', text: 'x' }],
      source: { kind: 'user' },
      extra: { a: null, b: true, c: [1, 2, { d: 'nested' }] },
    }, surfaceOp: 'append' }] as unknown as SessionEvent[]
    await writeLog(ctx.sessionPersistence, m, events)
    expect((await readAll(ctx.sessionPersistence, m.id)).events).toEqual(events)
  })
})

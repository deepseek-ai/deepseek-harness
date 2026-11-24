/**
 * Threshold-free, built-runtime measurement of SQLite frame storage under live-sized writes:
 * database size against an import of the same events, append latency, and the longest append
 * when every event is large. The workload is synthetic and seeded, so base and change runs of
 * this file are comparable; it is a diagnostic, not a performance gate.
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as SqlitePersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const SESSIONS = 24
const EVENTS_PER_SESSION = 1_500
const LARGE_EVENTS = 128
const LARGE_EVENT_BYTES = 2 * 1024 * 1024
const SAMPLES = 3

/** Seeded generator so every run writes the same events in the same order. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = 'session frame append read write merge tool result file path line error test build event model request response'.split(' ')

/** Text with repetition typical of transcripts and tool output; `bytes` is approximate. */
function text(next: () => number, bytes: number): string {
  const parts: string[] = []
  let length = 0
  while (length < bytes) {
    const word = WORDS[Math.floor(next() * WORDS.length)] ?? 'event'
    parts.push(word)
    length += word.length + 1
  }
  return parts.join(' ')
}

function message(seq: number, body: string): SessionEvent {
  return { type: 'feedback/record', seq: SessionSeq(seq), time: seq, data: { text: body } }
}

function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false }
}

/** Mostly short events with occasional tool-output-sized ones, written in batches of one to three. */
function workload(): { id: string; events: SessionEvent[] }[] {
  const next = random(8674)
  return Array.from({ length: SESSIONS }, (_, index) => ({
    id: `synthetic-${index}`,
    events: Array.from({ length: EVENTS_PER_SESSION }, (_, seq) =>
      message(seq, text(next, next() < 0.1 ? 8_000 + next() * 40_000 : 100 + next() * 1_500))),
  }))
}

async function databaseBytes(root: string): Promise<number> {
  const path = join(root, '.segments', 'sessions.sqlite')
  const db = new DatabaseSync(path)
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { db.close() }
  return (await stat(path)).size
}

async function withProvider<T>(operation: (ctx: Context, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-frame-merge-perf-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqlitePersistence, { root, compression: 'zstd' })
    return await operation(ctx, root)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

async function measure() {
  const sessions = workload()
  const live = await withProvider(async (ctx, root) => {
    const next = random(1)
    const handles = await Promise.all(sessions.map(session => ctx.sessionPersistence.create(header(session.id))))
    const offsets = sessions.map(() => 0)
    const latencies: number[] = []
    for (let remaining = SESSIONS * EVENTS_PER_SESSION; remaining > 0;) {
      const index = Math.floor(next() * SESSIONS)
      const session = sessions[index], handle = handles[index], offset = offsets[index]
      if (session === undefined || handle === undefined || offset === undefined || offset >= EVENTS_PER_SESSION) continue
      const batch = session.events.slice(offset, offset + 1 + Math.floor(next() * 3))
      const start = performance.now()
      await handle.append(batch)
      await handle.flush()
      latencies.push(performance.now() - start)
      offsets[index] = offset + batch.length
      remaining -= batch.length
    }
    await Promise.all(handles.map(handle => handle.close()))
    latencies.sort((a, b) => a - b)
    return { bytes: await databaseBytes(root), appends: latencies.length,
      p50Ms: percentile(latencies, 0.5), p99Ms: percentile(latencies, 0.99), maxMs: latencies.at(-1) ?? 0 }
  })
  const imported = await withProvider(async (ctx, root) => {
    for (const session of sessions) {
      const handle = await ctx.sessionPersistence.create(header(session.id), { inheritedEventCount: SessionLogOffset(0) })
      await handle.append(session.events)
      await handle.close()
    }
    return { bytes: await databaseBytes(root) }
  })
  const large = await withProvider(async (ctx) => {
    const next = random(2)
    const handle = await ctx.sessionPersistence.create(header('large'))
    let maxMs = 0
    for (let seq = 0; seq < LARGE_EVENTS; seq++) {
      const event = message(seq, text(next, LARGE_EVENT_BYTES))
      const start = performance.now()
      await handle.append([event])
      await handle.flush()
      maxMs = Math.max(maxMs, performance.now() - start)
    }
    await handle.close()
    return { events: LARGE_EVENTS, eventBytes: LARGE_EVENT_BYTES, maxAppendMs: maxMs }
  })
  return { liveBytes: live.bytes, importedBytes: imported.bytes, liveOverImported: live.bytes / imported.bytes,
    appends: live.appends, appendP50Ms: live.p50Ms, appendP99Ms: live.p99Ms, appendMaxMs: live.maxMs, large }
}

if (process.argv[2] === '--sample') {
  process.stdout.write(JSON.stringify(await measure()) + '\n')
} else {
  const samples = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--sample'], { encoding: 'utf8', timeout: 600_000 })
    if (result.error !== undefined) throw result.error
    if (result.signal !== null || result.status !== 0) throw new Error(`measurement failed: ${result.signal ?? result.status}: ${result.stderr}`)
    samples.push(JSON.parse(result.stdout) as Record<string, unknown>)
  }
  process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    sessions: SESSIONS, eventsPerSession: EVENTS_PER_SESSION, samples }, null, 2) + '\n')
}

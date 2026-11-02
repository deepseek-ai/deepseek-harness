/** Fork history retains delivery ownership without requiring a source relationship. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { generationLogPath } from '../src/format.ts'

async function fixture(compression: 'none' | 'zstd') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fork-delivery-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  async function persist(session: Session) {
    const writer = await ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
    try { await writer.append(session.snapshotEvents()) } finally { await writer.close() }
    return generationLogPath(root, undefined, session.id, 4, compression)
  }
  return { ctx, persist }
}

function delivered(session: Session): void {
  const start = session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('session-log-deepseek/delivery-accepted', {
    sessionId: session.id, sessionFormatVersion: 4, throughSeq: start.seq,
  })
}

describe.each(['none', 'zstd'] as const)('fork delivery persistence (%s)', (compression) => {
  it.each(['ordinary', 'nested', 'subagent', 'legacy'] as const)('restores %s fork history through read and write access', async (kind) => {
    const { ctx, persist } = await fixture(compression)
    const source = ctx.sessions.create(SessionId('source'))
    delivered(source)
    const ordinary = ctx.sessions.fork(source, undefined, SessionId('ordinary'))
    const child = kind === 'ordinary' ? ordinary : kind === 'nested'
      ? ctx.sessions.fork(ordinary, undefined, SessionId('nested'))
      : ctx.sessions.create(SessionId(kind), {
        seed: source.snapshotEvents(), inheritedEventCount: source.seq,
        meta: { parentSession: source.id, isSeeded: true, ...(kind === 'subagent' ? { origin: 'subagent' } : {}) },
      })
    const path = await persist(child)
    const bytes = await readFile(path)
    for (const access of ['read', 'write'] as const) {
      try {
        const handle = await ctx.sessionPersistence.open(child.id, access)
        try {
          const stored = await handle.read()
          const restored = Session.fromRestore(child.id, stored.events, handle.header, handle.inheritedEventCount, stored.eventState)
          expect(restored.snapshotEvents()).toEqual(child.snapshotEvents())
          expect(restored.inheritedEventCount).toBe(child.inheritedEventCount)
          expect(restored.header.parentSession).toBe(kind === 'subagent' || kind === 'legacy' ? source.id : undefined)
        } finally { await handle.close() }
      } finally {
        expect(await readFile(path)).toEqual(bytes)
      }
    }
  })

  it.each(['foreign-own', 'invalid-through', 'inherited-through'] as const)('refuses %s delivery without modifying the file', async (damage) => {
    const { ctx, persist } = await fixture(compression)
    const source = ctx.sessions.create(SessionId('source'))
    delivered(source)
    const invalidTarget = damage === 'inherited-through' ? source : ctx.sessions.fork(source, undefined, SessionId('child'))
    invalidTarget.append('session-log-deepseek/delivery-accepted', {
      sessionId: damage === 'foreign-own' ? source.id : invalidTarget.id,
      sessionFormatVersion: 4,
      throughSeq: damage === 'foreign-own' ? SessionSeq(0) : SessionSeq(invalidTarget.seq),
    })
    const child = damage === 'inherited-through' ? ctx.sessions.fork(source) : invalidTarget
    const path = await persist(child)
    const bytes = await readFile(path)
    for (const access of ['read', 'write'] as const) {
      await expect(ctx.sessionPersistence.open(child.id, access)).rejects.toThrow(
        damage === 'foreign-own' ? 'wrong Session' : 'throughSeq must precede',
      )
      expect(await readFile(path)).toEqual(bytes)
    }
  })
})

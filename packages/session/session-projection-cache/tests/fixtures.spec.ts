/**
 * Cross-version recovery over archived on-disk artifacts. `fixtures/` holds
 * real `session_projcache` media, each produced by driving the named release
 * through its own web app (session created over RPC, real model turns, a
 * rename): the v3 whole-unit file (published 0.1.1-rc.2), a v4 per-record
 * document (published 0.1.2-alpha.3), a published v5 document, and the
 * v5-stamped lineage-less document reproducing byte-for-byte what the
 * formerly unguarded legacy bootstrap wrote over v3 records. Each must open
 * through the real storage stack without becoming a fold shortcut for the
 * current Session format, then accept a current checkpoint rewrite. A record
 * that fails schema validation is backed up and skipped instead of failing the
 * boot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache from '../src/index.ts'
import { projectionCacheDomainSpec } from '../src/spec.ts'

// Declarations must match the shipped title unit's exactly (the repo-wide
// compile face sees both).
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    title: string | null
  }
  interface SessionProjectionMap {
    title: string | null
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'fixtures-test/set-title': { title: string }
  }

  interface OutOfBandSessionEventMap {
    'fixtures-test/set-title': true
  }
}

// Mirrors the shipped title unit's storage face: stateVersion 1, bare-string
// state (the fixture rows carry exactly this shape in every archived
// version), folding a test event so the rewrite path has fresh data.
const titleUnit = {
  key: 'title',
  stateSchema: z.string().nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'fixtures-test/set-title' ? event.data.title : state),
  wire: { viewSchema: z.string().nullable(), view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'title', string | null>

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

/** One archived per-record document (`{version, record}`). */
interface FixtureDoc {
  version: number
  record: {
    identity: { createdAt: number; cwd?: string }
    rows: Record<string, { ver: number; seq: number; val: unknown }>
  }
}

async function fixtureJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as T
}

/** Header for the session a fixture record is bound to (identity witness). */
function headerFor(id: SessionId, identity: FixtureDoc['record']['identity']): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: identity.createdAt,
    isSeeded: false,
    ...identity.cwd === undefined ? {} : { cwd: identity.cwd },
  }
}

const contexts: Context[] = []
const roots: string[] = []

async function harness(root: string) {
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(titleUnit)
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  return { ctx, cache: ctx.sessionProjectionCache }
}

/** Lay one per-record fixture document into a fresh backend root. */
async function placeDoc(root: string, id: string, name: string): Promise<FixtureDoc> {
  const path = join(root, projectionCacheDomainSpec.name, 'sessions', `${id}.json`)
  await mkdir(dirname(path), { recursive: true })
  await cp(join(FIXTURES, name), path)
  return fixtureJson<FixtureDoc>(name)
}

/**
 * Drive a live write over a recovered session id and assert the archived
 * document is replaced by a current-version one: current domain and Session
 * format stamps, lineage, and the freshly folded title.
 */
async function assertRewrite(ctx: Context, root: string, id: SessionId): Promise<void> {
  const session = ctx.sessions.create(id)
  session.append('fixtures-test/set-title', { title: '重写标题' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const path = join(root, projectionCacheDomainSpec.name, 'sessions', `${id}.json`)
  await vi.waitFor(async () => {
    const doc = JSON.parse(await readFile(path, 'utf8')) as FixtureDoc
    expect(doc.version).toBe(projectionCacheDomainSpec.version)
    expect(doc.record.identity).toMatchObject({
      formatVersion: SESSION_FORMAT_VERSION,
      isSeeded: false,
      inheritedEventCount: 0,
    })
    expect(doc.record.rows['title']?.val).toBe('重写标题')
  }, { timeout: 5_000 })
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

describe('archived version recovery', () => {
  it('recovers the v3 whole-unit archive through the legacy bootstrap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-fx-'))
    await cp(join(FIXTURES, 'v3-single-unit.json'), join(root, `${projectionCacheDomainSpec.name}.json`))
    type SingleUnit = {
      unit: { version: number }
      tables: { sessions: Record<string, FixtureDoc['record']> }
    }
    const archive = await fixtureJson<SingleUnit>('v3-single-unit.json')
    expect(archive.unit.version).toBe(3) // the fixture IS the old format
    const [sid, record] = Object.entries(archive.tables.sessions)[0]!

    const { ctx, cache } = await harness(root)
    expect(cache.cachedSnapshot(
      headerFor(SessionId(sid), record.identity),
      SessionLogOffset(0),
      ['title'],
    )).toBeUndefined()
    expect(cache.cachedPredecessorTitle(
      headerFor(SessionId(sid), record.identity),
      SessionLogOffset(0),
    )).toEqual({
      asOfSeq: -1,
      values: { title: record.rows.title?.val },
    })

    // The one-time bootstrap materialized a current-version document.
    const migrated = JSON.parse(
      await readFile(join(root, projectionCacheDomainSpec.name, 'sessions', `${sid}.json`), 'utf8'),
    ) as { version: number }
    expect(migrated.version).toBe(projectionCacheDomainSpec.version)

    await assertRewrite(ctx, root, SessionId(sid))
  })

  for (const [fixture, storedVersion] of [
    ['v4-session-doc.json', 4],
    ['v5-session-doc.json', 5],
    ['v5-lineageless-doc.json', 5],
  ] as const) {
    it(`opens ${fixture} without serving its unbound fold, then rewrites it current`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-fx-'))
      const id = SessionId('fixture-session')
      const doc = await placeDoc(root, id, fixture)
      expect(doc.version).toBe(storedVersion)

      const { ctx, cache } = await harness(root)
      expect(cache.cachedSnapshot(
        headerFor(id, doc.record.identity),
        SessionLogOffset(0),
        ['title'],
      )).toBeUndefined()
      expect(cache.cachedPredecessorTitle(
        headerFor(id, doc.record.identity),
        SessionLogOffset(0),
      )).toEqual({
        asOfSeq: -1,
        values: { title: doc.record.rows.title?.val },
      })

      await assertRewrite(ctx, root, id)
    })
  }

  it('serves an explicitly older format title but never a current or newer one through the predecessor path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-fx-'))
    const sessionsDir = join(root, projectionCacheDomainSpec.name, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const write = async (id: string, formatVersion: number, rowVersion = 1): Promise<void> => {
      await writeFile(join(sessionsDir, `${id}.json`), JSON.stringify({
        version: projectionCacheDomainSpec.version,
        record: {
          identity: {
            formatVersion,
            createdAt: 10,
            cwd: '/work',
            isSeeded: false,
            inheritedEventCount: 0,
          },
          rows: { title: { ver: rowVersion, seq: 2, val: `${id} title` } },
        },
      }))
    }
    await write('older', SESSION_FORMAT_VERSION - 1)
    await write('current', SESSION_FORMAT_VERSION)
    await write('newer', SESSION_FORMAT_VERSION + 1)
    await write('stale-title', SESSION_FORMAT_VERSION - 1, 2)

    const { cache } = await harness(root)
    const listed = (id: string): SessionHeader => ({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: 10,
      cwd: '/work',
      isSeeded: false,
    })
    expect(cache.cachedPredecessorTitle(listed('older'), SessionLogOffset(0))).toEqual({
      asOfSeq: -1,
      values: { title: 'older title' },
    })
    expect(cache.cachedPredecessorTitle(listed('current'), SessionLogOffset(0))).toBeUndefined()
    expect(cache.cachedPredecessorTitle(listed('newer'), SessionLogOffset(0))).toBeUndefined()
    expect(cache.cachedPredecessorTitle(listed('stale-title'), SessionLogOffset(0))).toBeUndefined()
    expect(cache.cachedPredecessorTitle(listed('missing'), SessionLogOffset(0))).toBeUndefined()
  })

  it('refuses a lineage-less archive for a seeded caller (identity mismatch, cold rebuild)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-fx-'))
    const id = SessionId('fixture-seeded')
    const doc = await placeDoc(root, id, 'v5-lineageless-doc.json')

    const { cache } = await harness(root)
    const seeded = { ...headerFor(id, doc.record.identity), isSeeded: true }
    expect(cache.cachedSnapshot(seeded, SessionLogOffset(2), ['title'])).toBeUndefined()
    expect(cache.cachedPredecessorTitle(seeded, SessionLogOffset(2))).toBeUndefined()
  })

  it('backs up and skips a record that fails schema validation instead of failing the boot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-fx-'))
    roots.push(root)
    const sessionsDir = join(root, projectionCacheDomainSpec.name, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    // Current-version stamp, hopeless record content: no compat rung can save it.
    await writeFile(join(sessionsDir, 'broken.json'), JSON.stringify({
      version: projectionCacheDomainSpec.version,
      record: { identity: { createdAt: 'not-a-number' }, rows: 'not-an-object' },
    }))
    const good = await placeDoc(root, SessionId('survivor'), 'v5-session-doc.json')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(titleUnit)
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    // The boot survives the broken record — this line rejecting IS the fixed bug.
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })

    // Concrete console diagnostics: which record, where it went, and why.
    expect(error).toHaveBeenCalledWith(expect.stringContaining("record 'broken'"))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('.json.bak.'))

    // The document was moved aside as <key>.json.bak.<YYYYMMDDHHmm>, bytes intact.
    const entries = await readdir(sessionsDir)
    expect(entries).not.toContain('broken.json')
    const backup = entries.find(name => /^broken\.json\.bak\.\d{12}$/.test(name))
    expect(backup).toBeDefined()
    expect(JSON.parse(await readFile(join(sessionsDir, backup!), 'utf8')))
      .toMatchObject({ record: { rows: 'not-an-object' } })

    // The broken record reads as absent; its predecessor-stamped neighbor
    // remains available for a safe current rewrite.
    const cache = ctx.sessionProjectionCache
    expect(cache.cachedSnapshot(headerFor(SessionId('broken'), { createdAt: 0 }), SessionLogOffset(0)))
      .toBeUndefined()
    expect(cache.cachedSnapshot(
      headerFor(SessionId('survivor'), good.record.identity),
      SessionLogOffset(0),
      ['title'],
    )).toBeUndefined()
    await assertRewrite(ctx, root, SessionId('survivor'))
  })
})

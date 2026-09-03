/**
 * Cross-version recovery over archived on-disk artifacts. `fixtures/` holds
 * real `session_projcache` media, each produced by driving the named release
 * through its own web app (session created over RPC, real model turns, a
 * rename): the v3 whole-unit file (published 0.1.1-rc.2), a v4 per-record
 * document (published 0.1.2-alpha.3), a published v5 document, and the
 * v5-stamped lineage-less document reproducing byte-for-byte what the
 * formerly unguarded legacy bootstrap wrote over v3 records. Each must
 * recover through the real storage stack — the domain opens and the listing
 * read serves the archived title — and a record that fails schema validation
 * anyway is backed up and skipped instead of failing the boot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
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
    version: 0,
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
 * document is replaced by a current-version one: v6 stamp, lineage present,
 * and the freshly folded title — the write path never keeps the old format.
 */
async function assertRewrite(ctx: Context, root: string, id: SessionId): Promise<void> {
  const session = ctx.sessions.create(id)
  session.append('fixtures-test/set-title', { title: '重写标题' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const path = join(root, projectionCacheDomainSpec.name, 'sessions', `${id}.json`)
  await vi.waitFor(async () => {
    const doc = JSON.parse(await readFile(path, 'utf8')) as FixtureDoc
    expect(doc.version).toBe(projectionCacheDomainSpec.version)
    expect(doc.record.identity).toMatchObject({ isSeeded: false, inheritedEventCount: 0 })
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
    const snapshot = cache.cachedSnapshot(headerFor(SessionId(sid), record.identity), SessionLogOffset(0), ['title'])
    expect(snapshot?.values.title).toBe(record.rows['title']!.val)

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
    it(`serves the archived title from ${fixture}, then rewrites it current`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-fx-'))
      const id = SessionId('fixture-session')
      const doc = await placeDoc(root, id, fixture)
      expect(doc.version).toBe(storedVersion)

      const { ctx, cache } = await harness(root)
      const snapshot = cache.cachedSnapshot(headerFor(id, doc.record.identity), SessionLogOffset(0), ['title'])
      expect(snapshot?.values.title).toBe(doc.record.rows['title']!.val)

      await assertRewrite(ctx, root, id)
    })
  }

  it('refuses a lineage-less archive for a seeded caller (identity mismatch, cold rebuild)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-fx-'))
    const id = SessionId('fixture-seeded')
    const doc = await placeDoc(root, id, 'v5-lineageless-doc.json')

    const { cache } = await harness(root)
    const seeded = { ...headerFor(id, doc.record.identity), isSeeded: true }
    expect(cache.cachedSnapshot(seeded, SessionLogOffset(2), ['title'])).toBeUndefined()
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

    // The broken record reads as absent; its neighbors still serve.
    const cache = ctx.sessionProjectionCache
    expect(cache.cachedSnapshot(headerFor(SessionId('broken'), { createdAt: 0 }), SessionLogOffset(0)))
      .toBeUndefined()
    expect(cache.cachedSnapshot(
      headerFor(SessionId('survivor'), good.record.identity),
      SessionLogOffset(0),
      ['title'],
    )?.values.title).toBe(good.record.rows['title']!.val)
  })
})

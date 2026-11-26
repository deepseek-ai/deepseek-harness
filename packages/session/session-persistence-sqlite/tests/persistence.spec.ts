/** Shared persistence semantics and SQLite plugin activation. @module */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { meta, oneTurnLog, runPersistenceContract } from '../../session-persistence/tests/contract.ts'
import { persistenceFixture } from './fixtures/persistence.ts'
import { headSegment, storedEvents } from './fixtures/store.ts'

runPersistenceContract('sqlite', async () => {
  const fixture = await persistenceFixture()
  const backend = await fixture.mount('sqlite')
  return {
    persistence: backend.persistence,
    dispose: () => backend.context.fiber.dispose(),
    reopen: async () => {
      const reopened = await fixture.mount('sqlite')
      return { persistence: reopened.persistence, dispose: () => reopened.context.fiber.dispose() }
    },
  }
})

describe('SQLite persistence plugin', () => {
  it('registers the service before creating the database and initializes on first create', async () => {
    const fixture = await persistenceFixture()
    const { persistence } = await fixture.mount('sqlite')
    expect(persistence).toBeDefined()
    expect(await persistence.list()).toEqual([])
    expect(await readdir(fixture.root)).toEqual([])
    const writer = await persistence.create(meta('first-create'))
    await writer.flush()
    await writer.close()
    expect(await readdir(join(fixture.root, '.segments'))).toContain('sessions.sqlite')
  })

  it('stores one complete logical event stream in an independent root segment', async () => {
    const fixture = await persistenceFixture()
    const { persistence, context } = await fixture.mount('sqlite')
    const header = meta('root-segment', '/workspace')
    const events = oneTurnLog()
    const writer = await persistence.create(header)
    await writer.append(events)
    await writer.close()
    await context.fiber.dispose()
    const db = new DatabaseSync(join(fixture.root, '.segments', 'sessions.sqlite'))
    try {
      const stored = db.prepare('SELECT header FROM sessions WHERE session_id = ?').get(header.id)
      expect(JSON.parse(String(stored?.header))).toEqual({ ...header, delegationDepth: 0 })
      const head = headSegment(db, header.id)
      expect(db.prepare('SELECT parent_id, base_seq FROM segments WHERE segment_id = ?').get(head)).toEqual({ parent_id: null, base_seq: 0 })
      expect(storedEvents(db, head)).toEqual(events)
    } finally {
      db.close()
    }
  })

  it('keeps the default JSONL provider independent of SQLite storage', async () => {
    const fixture = await persistenceFixture()
    const { persistence } = await fixture.mount('jsonl')
    const writer = await persistence.create(meta('default-jsonl', '/workspace'))
    await writer.append(oneTurnLog())
    await writer.close()
    expect(await readdir(fixture.root)).not.toContain('.segments')
  })

  it('drains live Session events before provider disposal', async () => {
    const fixture = await persistenceFixture()
    const { persistence, context } = await fixture.mount('sqlite')
    const session = context.sessions.create(meta('shutdown-drain').id)
    await persistence.create(session.header)
    const events = [
      session.append('turn/start', { turn: 1 }),
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    await context.fiber.dispose()
    const reopened = await fixture.mount('sqlite')
    const reader = await reopened.persistence.open(session.id, 'read')
    expect((await reader.read()).events).toEqual(events)
    await reader.close()
  })
})

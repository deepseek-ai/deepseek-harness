/** SQLite validates whole-artifact relationships and event-local V4 fields on slices. @module */
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { sqliteLogs, tailSegment } from './fixtures/store.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-v4-'))
  // One event per frame lets a test rewrite a single stored event by its frame.
  const path = join(root, 'sessions.sqlite'), logs = sqliteLogs(path, root, { frameEvents: 1 }), id = SessionId('v4')
  onTestFinished(async () => { try { await logs.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const writer = await logs.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  await writer.append([0, 1].map(seq => ({ type: 'turn/start' as const, seq: SessionSeq(seq), time: 0, data: { turn: seq + 1 } })))
  await writer.close()
  const db = new DatabaseSync(path)
  onTestFinished(() => { db.close() })
  db.exec('DROP TRIGGER frames_no_update')
  const replace = (seq: number, type: string, data: object) => {
    db.prepare('UPDATE frames SET codec = 0, payload = ? WHERE segment_uuid = ? AND start_seq = ?')
      .run(Buffer.from(JSON.stringify({ type, seq, time: 0, data })), tailSegment(db, id), seq)
  }
  replace(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { logs, db, id, replace }
}

it('rejects an inherited marker in an unseeded artifact on complete read and writable restore', async () => {
  const { logs, id, replace } = await fixture()
  replace(1, 'session/end-seed', { inherited: true })
  const reader = await logs.open(id, 'read')
  expect((await reader.read(0, 1)).events).toHaveLength(1)
  await expect(reader.read()).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  await reader.close()
  await expect(logs.open(id, 'write')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
})

it('rejects a seeded header whose stored cut differs from its inherited marker', async () => {
  const { logs, db, id, replace } = await fixture()
  replace(1, 'session/end-seed', { inherited: true })
  const row = db.prepare('SELECT header FROM traces WHERE trace_uuid = ?').get(id)
  if (typeof row?.header !== 'string') throw new Error('Missing stored header')
  const header: unknown = JSON.parse(row.header)
  if (typeof header !== 'object' || header === null || Array.isArray(header)) throw new Error('Invalid stored header')
  db.prepare('UPDATE traces SET header = ?, inherited_count = 0 WHERE trace_uuid = ?')
    .run(JSON.stringify({ ...header, isSeeded: true }), id)
  const reader = await logs.open(id, 'read')
  await expect(reader.read()).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  await reader.close()
})

it('classifies an unknown required event in a complete artifact as unsupported', async () => {
  const { logs, id, replace } = await fixture()
  replace(1, 'future/required', {})
  const reader = await logs.open(id, 'read')
  await expect(reader.read()).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
  await reader.close()
})

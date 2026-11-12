/** SQLite Session ownership across roots sharing one database. @module */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyExistsError, SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { SessionWriteLease } from '@deepseek-ai/dsh-session-persistence/lease'
import * as persistence from '../src/index.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shared-database-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.sqlite')
  const mount = async (root: string, database = path) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(persistence, { root: join(directory, root), compression: 'none', segmentStorage: { path: database } })
    return ctx.sessionPersistence
  }
  const a = await mount('a'), b = await mount('b')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('shared'), createdAt: 0, isSeeded: false }
  return { directory, path, mount, a, b, header }
}

it('excludes a second writer across roots while allowing readers and other Sessions', async () => {
  const { a, b, header } = await fixture()
  const first = await a.create(header)
  await first.append([{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }])
  await expect(b.open(header.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  const reader = await b.open(header.id, 'read')
  try { expect((await reader.read()).events).toEqual((await first.read()).events) } finally { await reader.close() }
  const other = await b.create({ ...header, id: SessionId('independent') })
  await other.flush(); await other.close()
  await first.close()
  const resumed = await b.open(header.id, 'write')
  await resumed.append([{ type: 'turn/end', seq: SessionSeq(1), time: 1, data: { turn: 1, reason: { kind: 'completed' } } }])
  await resumed.close()
  const stored = await a.open(header.id, 'read')
  try { expect((await stored.read()).events.map(event => event.type)).toEqual(['turn/start', 'turn/end']) } finally { await stored.close() }
})

it('excludes competing first commits across roots and releases a losing creation', async () => {
  const { a, b, header } = await fixture()
  const first = await a.create(header), second = await b.create(header)
  await first.flush()
  await expect(second.flush()).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  await first.close()
  await expect(second.flush()).rejects.toBeInstanceOf(SessionAlreadyExistsError)
  await second.close()
  const reopened = await a.open(header.id, 'write')
  await reopened.close()
})

// Windows database symlink creation requires developer mode or elevated privileges.
it.skipIf(process.platform === 'win32')('shares ownership through a database symlink alias', async () => {
  const { directory, path, mount, a, header } = await fixture()
  const alias = join(directory, 'alias.sqlite')
  await symlink(path, alias)
  const b = await mount('alias-root', alias)
  const first = await a.create(header)
  await first.flush()
  await expect(b.open(header.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  await first.close()
  const resumed = await b.open(header.id, 'write')
  await resumed.close()
})

it.each([1, 2])('releases both ownership locks when %i releases report failure', async (count) => {
  const { a, b, header } = await fixture()
  const first = await a.create(header)
  await first.flush()
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its lease receiver.
  const release = SessionWriteLease.prototype.release
  let failures = count
  const fault = vi.spyOn(SessionWriteLease.prototype, 'release').mockImplementation(async function (this: SessionWriteLease) {
    await release.call(this)
    if (failures > 0) { failures--; throw new Error('lease release failed') }
  })
  try { await expect(first.close()).rejects.toThrow(count === 1 ? 'lease release failed' : 'SQLite write ownership release failed') }
  finally { fault.mockRestore() }
  const resumed = await b.open(header.id, 'write')
  await resumed.close()
})

it('preserves acquisition and rollback failures while releasing database ownership', async () => {
  const { a, b, header } = await fixture()
  const first = await a.create(header)
  const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
  const acquisitionFailure = new Error('artifact acquisition failed')
  const releaseFailure = new Error('shared lease rollback failed')
  const fault = vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (...args) => {
    const shared = await acquire(...args)
    const release = shared.release.bind(shared)
    vi.spyOn(shared, 'release').mockImplementationOnce(async () => { await release(); throw releaseFailure })
    return shared
  }).mockRejectedValueOnce(acquisitionFailure)
  try { await expect(first.flush()).rejects.toMatchObject({ errors: [acquisitionFailure, releaseFailure] }) }
  finally { fault.mockRestore() }
  const winner = await b.create(header)
  await winner.flush(); await winner.close(); await first.close()
})

/**
 * What survives a restart, and what an older file is allowed to mean.
 *
 * Withdrawing a share must still be in force after the host reloads its registry, and a file written
 * before the operation records existed — or one carrying an entry that no longer validates — must not
 * be replayed as a served request.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import { READ_ONLY_FORK_CEILING } from '../src/host/fork-policy.ts'

const creator = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' }
const child = 'session-child'

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** One registry file holding a single child of one share. */
function file(): string {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-registry-'))
  temporary.push(directory)
  return join(directory, 'forks.json')
}

function record(forks: ForkRegistry): Promise<void> {
  return forks.record({
    childSessionId: child,
    shareId: 'share-1',
    sourceSessionId: 'session-shared',
    boundary: 3,
    creator,
    createdAt: '2026-09-12T00:00:00.000Z',
  })
}

describe('fork registry durability', () => {
  it('keeps a withdrawal in force after the host reloads the file', async () => {
    const path = file()
    const before = new ForkRegistry(path)
    await record(before)
    await before.revokeShare('share-1', '2026-09-12T01:00:00.000Z')

    const after = new ForkRegistry(path)

    expect(after.find(child)?.revokedAt).toBe('2026-09-12T01:00:00.000Z')
    expect(after.allowsPrompt(child, creator)).toMatchObject({ ok: false, code: 'fork-source-revoked' })
  })

  it('withdraws only the children that existed when the share was withdrawn', async () => {
    const path = file()
    const before = new ForkRegistry(path)
    await record(before)
    await before.revokeShare('share-1', '2026-09-12T01:00:00.000Z')

    // The owner turns the fork switch back on and a new child is recorded. It is not a child the earlier
    // withdrawal named, so neither this process nor a reload may mark it revoked.
    const reopened = new ForkRegistry(path)
    await reopened.record({
      childSessionId: 'session-child-new',
      shareId: 'share-1',
      sourceSessionId: 'session-shared',
      boundary: 3,
      creator,
      createdAt: '2026-09-12T02:00:00.000Z',
    })
    reopened.installEnforcement(child, READ_ONLY_FORK_CEILING)
    reopened.installEnforcement('session-child-new', READ_ONLY_FORK_CEILING)
    expect(reopened.allowsPrompt('session-child-new', creator)).toEqual({ ok: true })

    const restarted = new ForkRegistry(path)
    restarted.installEnforcement(child, READ_ONLY_FORK_CEILING)
    restarted.installEnforcement('session-child-new', READ_ONLY_FORK_CEILING)
    expect(restarted.find(child)?.revokedAt).toBe('2026-09-12T01:00:00.000Z')
    expect(restarted.find('session-child-new')?.revokedAt).toBeUndefined()
    expect(restarted.allowsPrompt(child, creator)).toMatchObject({ ok: false, code: 'fork-source-revoked' })
    expect(restarted.allowsPrompt('session-child-new', creator)).toEqual({ ok: true })
  })

  it('withdraws a child recorded after the share was withdrawn when the share is withdrawn again', async () => {
    const path = file()
    const forks = new ForkRegistry(path)
    await record(forks)
    await forks.revokeShare('share-1', '2026-09-12T01:00:00.000Z')
    await forks.record({
      childSessionId: 'session-child-new',
      shareId: 'share-1',
      sourceSessionId: 'session-shared',
      boundary: 3,
      creator,
      createdAt: '2026-09-12T02:00:00.000Z',
    })
    // The fork switch is turned off again: this is a new withdrawal, so it names the new child too.
    await forks.revokeShare('share-1', '2026-09-12T03:00:00.000Z')

    const restarted = new ForkRegistry(path)
    expect(restarted.find('session-child-new')?.revokedAt).toBe('2026-09-12T03:00:00.000Z')
  })

  it('loads a file written before operation records existed', async () => {
    const path = file()
    const forks = new ForkRegistry(path)
    await record(forks)
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    delete document.operations
    writeFileSync(path, JSON.stringify(document))

    const reloaded = new ForkRegistry(path)

    expect(reloaded.find(child)?.childSessionId).toBe(child)
    expect(reloaded.operationOf('anything')).toBeUndefined()
  })

  it('keeps an operation entry that predates readiness, refused rather than replayed', async () => {
    const path = file()
    const forks = new ForkRegistry(path)
    await record(forks)
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    // An entry from a version that recorded a child but no readiness flag. It must keep the child it
    // named — a retry cannot be allowed to create a second one — and must not read as a success.
    document.operations = [{
      key: 'legacy', childSessionId: child, boundary: 3, status: 200, body: { result: { ok: true } },
    }]
    writeFileSync(path, JSON.stringify(document))

    const reloaded = new ForkRegistry(path)

    expect(reloaded.operationOf('legacy')).toMatchObject({
      key: 'legacy', childSessionId: child, boundary: 3, ready: false,
    })
  })

  it('keeps a reserved request that never created a child free to create one', async () => {
    const path = file()
    const forks = new ForkRegistry(path)
    await forks.reserveOperation('identity', 3)

    const reloaded = new ForkRegistry(path)

    expect(reloaded.operationOf('identity')).toMatchObject({ boundary: 3, childSessionId: '', ready: false })
  })
})

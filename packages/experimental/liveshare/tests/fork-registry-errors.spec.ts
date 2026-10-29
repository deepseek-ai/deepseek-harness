/** Fork registry persistence failures, corrupt input, and withdrawal replay. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ForkRegistry, type ForkRecord } from '../src/host/fork-registry.ts'
import { READ_ONLY_FORK_CEILING } from '../src/host/fork-policy.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function registryFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-registry-errors-'))
  directories.push(directory)
  return join(directory, 'forks.json')
}

function record(childSessionId: string, overrides: Partial<ForkRecord> = {}): ForkRecord {
  return {
    childSessionId, shareId: 'share-1', sourceSessionId: 'session-1', boundary: 3,
    creator: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function document(value: unknown): string {
  return JSON.stringify(value)
}

describe('fork registry input it cannot use', () => {
  it('starts empty from a missing, corrupt, or non-object file and refuses to overwrite it', async () => {
    for (const contents of [undefined, '{not json', 'null', '[]', '{"version":2,"forks":[]}']) {
      const file = registryFile()
      if (contents !== undefined) writeFileSync(file, contents)
      const registry = new ForkRegistry(file)
      expect(registry.find('child')).toBeUndefined()
      if (contents === undefined) continue
      // A file the write path cannot read is never replaced.
      await expect(registry.record(record('child'))).rejects.toThrow()
      expect(readFileSync(file, 'utf8')).toBe(contents)
    }
  })

  it('drops entries that fail their own validation and keeps the rest', () => {
    const file = registryFile()
    writeFileSync(file, document({
      version: 1,
      forks: [
        null, {}, { ...record('valid'), boundary: 1.5 }, { ...record('valid'), creator: { providerId: 'p' } },
        { ...record('invalid-creator'), creator: null }, { ...record('invalid-creator'), creator: 'owner' },
        { ...record('valid'), revokedAt: 42 },
        record('valid'),
      ],
      operations: [
        null, {}, { key: '' }, { key: 'no-child' }, { key: 'bad-boundary', childSessionId: '', boundary: 1.5 },
        { key: 'nostatus', childSessionId: 'child', boundary: 1 },
        { key: 'ok', childSessionId: 'child', boundary: 2, ready: true, status: 200, body: { ok: true } },
      ],
    }))
    const registry = new ForkRegistry(file)
    expect(registry.find('valid')).toBeDefined()
    expect(registry.operationOf('nostatus')).toMatchObject({ status: 0 })
    expect(registry.find('invalid-creator')).toBeUndefined()
    expect(registry.operationOf('ok')).toEqual({
      key: 'ok', childSessionId: 'child', boundary: 2, ready: true, status: 200, body: { ok: true },
    })
    expect(registry.operationOf('no-child')).toBeUndefined()
    expect(registry.operationOf('bad-boundary')).toBeUndefined()
  })

  it('treats an unreadable path as empty and retries a failed batch on the next change', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    // A directory where the file belongs makes the first commit fail.
    mkdirSync(file)
    await expect(registry.record(record('first'))).rejects.toThrow()
    rmSync(file, { recursive: true, force: true })
    // The retained batch is written together with the next change.
    await registry.record(record('second'))
    const document = JSON.parse(readFileSync(file, 'utf8')) as { forks: ForkRecord[] }
    expect(document.forks.map(entry => entry.childSessionId).sort()).toEqual(['first', 'second'])
  })

  it('refuses a path that cannot be read at all and still writes once it can', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'liveshare-registry-dir-'))
    directories.push(directory)
    const path = join(directory, 'as-a-directory')
    mkdirSync(path)
    const registry = new ForkRegistry(path)
    expect(registry.find('child')).toBeUndefined()
    await expect(registry.record(record('child'))).rejects.toThrow()
  })
})

describe('withdrawal replay', () => {
  it('writes the first withdrawal even with no known child, and not the repeat', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    await registry.revokeShare('share-1', '2026-02-01T00:00:00.000Z')
    expect(readFileSync(file, 'utf8')).toContain('"version": 1')
    rmSync(file)
    // The same withdrawal is already in force for this process, so no write is owed.
    await registry.revokeShare('share-1', '2026-02-01T00:00:00.000Z')
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('retries a withdrawal whose commit failed and revokes the children it knew', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    await registry.record(record('child'))
    // A directory where the file belongs makes the withdrawal's commit fail.
    rmSync(file)
    mkdirSync(file)
    await expect(registry.revokeShare('share-1', '2026-02-01T00:00:00.000Z')).rejects.toThrow()
    rmSync(file, { recursive: true, force: true })

    // The next withdrawal of the same share retries the batch it still owes.
    await registry.revokeShare('share-1', '2026-02-01T00:00:00.000Z')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { forks: ForkRecord[] }
    expect(saved.forks.find(entry => entry.childSessionId === 'child')?.revokedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('does not retry a withdrawal a new child superseded', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    await registry.record(record('child'))
    rmSync(file)
    mkdirSync(file)

    // A new child of the share is recorded while the withdrawal's commit is failing. The child exists
    // after that withdrawal, so the failed batch must not be replayed over it later.
    const withdrawal = registry.revokeShare('share-1', '2026-02-01T00:00:00.000Z')
    const recorded = registry.record(record('new-child'))
    await expect(withdrawal).rejects.toThrow()
    await expect(recorded).rejects.toThrow()
    rmSync(file, { recursive: true, force: true })
    await registry.record(record('new-child'))

    const saved = JSON.parse(readFileSync(file, 'utf8')) as { forks: ForkRecord[] }
    // The withdrawal still names the child it saw; the child recorded after it stays live.
    expect(saved.forks.find(entry => entry.childSessionId === 'child')?.revokedAt).toBe('2026-02-01T00:00:00.000Z')
    expect(saved.forks.find(entry => entry.childSessionId === 'new-child')?.revokedAt).toBeUndefined()
  })

  it('applies a withdrawal to a child another process recorded and skips one already revoked', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    // Another process records these after this host read its own copy.
    writeFileSync(file, document({ version: 1, forks: [
      record('other-process'),
      record('already-revoked', { revokedAt: '2026-01-01T00:00:00.000Z' }),
    ] }))
    await registry.revokeShare('share-1', '2026-02-01T00:00:00.000Z')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { forks: ForkRecord[] }
    expect(saved.forks.map(entry => entry.revokedAt)).toEqual([
      '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    ])
  })

  it('revokes only unrevoked children of the named share and keeps their history', async () => {
    const file = registryFile()
    writeFileSync(file, document({
      version: 1,
      forks: [
        record('a'),
        record('b', { revokedAt: '2026-01-01T00:00:00.000Z' }),
        record('c', { shareId: 'other' }),
      ],
    }))
    const registry = new ForkRegistry(file)
    await registry.revokeShare('share-1', '2026-02-01T00:00:00.000Z')
    expect(registry.find('a')?.revokedAt).toBe('2026-02-01T00:00:00.000Z')
    expect(registry.find('b')?.revokedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(registry.find('c')?.revokedAt).toBeUndefined()
  })
})

describe('records and enforcement after a merge', () => {
  it('merges this process changes with entries another process added', async () => {
    const file = registryFile()
    writeFileSync(file, document({ version: 1, forks: [record('existing')] }))
    const registry = new ForkRegistry(file)
    await registry.record(record('added'))
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { forks: ForkRecord[] }
    expect(saved.forks.map(entry => entry.childSessionId).sort()).toEqual(['added', 'existing'])
  })

  it('keeps an existing revocation when this process replaces the same record', async () => {
    const file = registryFile()
    writeFileSync(file, document({ version: 1, forks: [record('a', { revokedAt: '2026-01-01T00:00:00.000Z' })] }))
    const registry = new ForkRegistry(file)
    await registry.record(record('a', { boundary: 9 }))
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { forks: ForkRecord[] }
    expect(saved.forks[0]).toMatchObject({ boundary: 9, revokedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('answers one operation only for its own key, and reserves a request once', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    await registry.reserveOperation('key', 4)
    expect(registry.operationOf('key')).toMatchObject({ key: 'key', boundary: 4, childSessionId: '' })
    await registry.reserveOperation('key', 9)
    expect(registry.operationOf('key')?.boundary).toBe(4)
    await registry.recordOperation({
      key: 'key', childSessionId: 'child', boundary: 4, ready: true, status: 200, body: { ok: true },
    })
    expect(registry.operationOf('key')).toMatchObject({ childSessionId: 'child', ready: true })
  })

  it('retains a failed operation batch for the next change', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    mkdirSync(file)
    await expect(registry.recordOperation({
      key: 'first', childSessionId: 'child-a', boundary: 1, ready: true, status: 200, body: {},
    })).rejects.toThrow()
    rmSync(file, { recursive: true, force: true })
    await registry.recordOperation({
      key: 'second', childSessionId: 'child-b', boundary: 2, ready: true, status: 200, body: {},
    })
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { operations: { key: string }[] }
    expect(saved.operations.map(entry => entry.key).sort()).toEqual(['first', 'second'])
  })

  it('drops a retained change a later change replaced', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    mkdirSync(file)
    const first = registry.record(record('child', { boundary: 1 }))
    const second = registry.record(record('child', { boundary: 2 }))
    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
    rmSync(file, { recursive: true, force: true })
    await registry.record(record('other'))
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { forks: ForkRecord[] }
    expect(saved.forks.find(entry => entry.childSessionId === 'child')?.boundary).toBe(2)
  })

  it('drops a retained operation a later operation replaced', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    mkdirSync(file)
    const first = registry.recordOperation({
      key: 'key', childSessionId: 'child-a', boundary: 1, ready: true, status: 200, body: { version: 1 },
    })
    const second = registry.recordOperation({
      key: 'key', childSessionId: 'child-b', boundary: 1, ready: true, status: 200, body: { version: 2 },
    })
    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
    rmSync(file, { recursive: true, force: true })
    await registry.record(record('other'))
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { operations: { key: string; body: unknown }[] }
    expect(saved.operations.find(entry => entry.key === 'key')?.body).toEqual({ version: 2 })
  })

  it('tracks each child ceiling only after its record exists', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    expect(registry.installEnforcement('absent', READ_ONLY_FORK_CEILING)).toBe(false)
    await registry.record(record('child'))
    expect(registry.enforcedCeiling('child')).toBeUndefined()
    expect(registry.installEnforcement('child', READ_ONLY_FORK_CEILING)).toBe(true)
    expect(registry.enforcedCeiling('child')).toEqual(READ_ONLY_FORK_CEILING)
    registry.releaseEnforcement('child')
    expect(registry.enforcedCeiling('child')).toBeUndefined()
  })

  it('lists children by creator and by share', async () => {
    const file = registryFile()
    const registry = new ForkRegistry(file)
    await registry.record(record('a'))
    await registry.record(record('b', { creator: { providerId: 'p', tenantId: 't', subjectId: 'bob' } }))
    expect(registry.listForCreator({ providerId: 'p', tenantId: 't', subjectId: 'alice' }).map(entry => entry.childSessionId)).toEqual(['a'])
    expect(registry.listForShare('share-1').map(entry => entry.childSessionId)).toEqual(['a', 'b'])
  })
})

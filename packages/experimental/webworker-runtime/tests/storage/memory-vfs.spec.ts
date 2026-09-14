/**
 * The identity, timestamp, link, mutation, and durability-sink guarantees
 * MemoryVfs owes its consumers, asserted directly rather than through the
 * `node:fs` bridge.
 *
 * `dsh-fs-local` builds a version token from `dev:ino:size:mtimeNs:ctimeNs` and
 * refuses a write whose token moved since it read. Two properties carry that:
 * `ino` identifies the entry at a path, and `mtimeMs` moves on every write. The
 * timestamp cases freeze the clock, because these writes are in memory and two
 * revisions routinely land in the same millisecond — a real-clock test passes
 * whether or not the strict increment exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import type { VfsBigIntStats, VfsMutation, VfsMutationSink, VfsStats } from '../../src/storage/types.ts'

const identity = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).ino

const linkCount = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).nlink

const modified = (vfs: MemoryVfs, path: string): number => (vfs.statSync(path) as VfsStats).mtimeMs

afterEach(() => { vi.restoreAllMocks() })

describe('entry identity', () => {
  it('distinguishes paths and holds each identity across repeated stats', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/one.txt', 'one')
    vfs.seed('/dsh/two.txt', 'two')
    const first = identity(vfs, '/dsh/one.txt')
    expect(identity(vfs, '/dsh/two.txt')).not.toBe(first)
    expect(identity(vfs, '/dsh/one.txt')).toBe(first)
  })

  it('forgets the identities under a directory removed as a subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/skills/git/SKILL.md', '# git\n')
    const before = identity(vfs, '/dsh/skills/git/SKILL.md')
    vfs.rmSync('/dsh/skills', { recursive: true })
    vfs.seed('/dsh/skills/git/SKILL.md', '# git rebuilt\n')
    expect(identity(vfs, '/dsh/skills/git/SKILL.md')).not.toBe(before)
  })

  it('moves the source identity when a file replaces another path', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/from.txt', 'moved')
    vfs.seed('/dsh/to.txt', 'replaced')
    const [source, destination] = [identity(vfs, '/dsh/from.txt'), identity(vfs, '/dsh/to.txt')]
    vfs.renameSync('/dsh/from.txt', '/dsh/to.txt')
    const renamed = identity(vfs, '/dsh/to.txt')
    expect(vfs.readFileSync('/dsh/to.txt', 'utf8')).toBe('moved')
    expect([renamed === source, renamed === destination]).toEqual([true, false])
  })
})

describe('modification time', () => {
  it('hydrates explicit metadata without confusing timestamps with permission bits', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/restored', 'value', { mode: 0o600, mtimeMs: 1_600_000_000_000 })
    vfs.seedDirectory('/dsh/restored-directory', { mode: 0o700, mtimeMs: 1_600_000_000_001 })
    const stats = vfs.statSync('/dsh/restored') as VfsStats
    const directory = vfs.statSync('/dsh/restored-directory') as VfsStats
    expect([stats.mode & 0o777, stats.mtimeMs]).toEqual([0o600, 1_600_000_000_000])
    expect([directory.mode & 0o777, directory.mtimeMs]).toEqual([0o700, 1_600_000_000_001])
  })

  it('advances on every write even while the clock stands still', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/log.jsonl', 'first\n')
    const seeded = modified(vfs, '/dsh/log.jsonl')
    vfs.writeFileSync('/dsh/log.jsonl', 'second\n')
    const written = modified(vfs, '/dsh/log.jsonl')
    vfs.appendFileSync('/dsh/log.jsonl', 'third\n')
    const appended = modified(vfs, '/dsh/log.jsonl')
    vfs.truncateSync('/dsh/log.jsonl', 6)
    const truncated = modified(vfs, '/dsh/log.jsonl')
    expect([written > seeded, appended > written, truncated > appended]).toEqual([true, true, true])
    // One millisecond per revision: the increment is the minimum that separates
    // two tokens, not a coarser bump that would skew a real timestamp.
    expect(truncated - seeded).toBe(3)
  })

  it('takes the clock once the clock has passed the entry', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/log.jsonl', 'first\n')
    clock.mockReturnValue(1_700_000_005_000)
    vfs.writeFileSync('/dsh/log.jsonl', 'second\n')
    expect(modified(vfs, '/dsh/log.jsonl')).toBe(1_700_000_005_000)
  })

  it('extends truncation with zero bytes', async () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/file', new Uint8Array([1, 2]))
    vfs.truncateSync('/dsh/file', 5)
    expect([...vfs.readFileSync('/dsh/file') as Uint8Array]).toEqual([1, 2, 0, 0, 0])
    const handle = vfs.open('/dsh/file', 'r+')
    await handle.truncate(7)
    expect([...vfs.readFileSync('/dsh/file') as Uint8Array]).toEqual([1, 2, 0, 0, 0, 0, 0])
  })

  it('advances a directory only when its immediate entry set changes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh/workspace')
    const empty = modified(vfs, '/dsh/workspace')
    vfs.writeFileSync('/dsh/workspace/file.txt', 'one')
    const created = modified(vfs, '/dsh/workspace')
    vfs.writeFileSync('/dsh/workspace/file.txt', 'two')
    const rewritten = modified(vfs, '/dsh/workspace')
    vfs.rmSync('/dsh/workspace/file.txt')
    const removed = modified(vfs, '/dsh/workspace')
    expect([created > empty, rewritten === created, removed > rewritten]).toEqual([true, true, true])
  })
})

describe('mutation publication', () => {
  it('publishes only committed runtime changes and keeps image seeding silent', () => {
    const vfs = new MemoryVfs()
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    vfs.seed('/dsh/seeded.txt', 'seeded')
    expect(mutations).toEqual([])
    vfs.writeFileSync('/dsh/seeded.txt', 'changed')
    vfs.mkdirSync('/dsh/created')
    vfs.chmodSync('/dsh/created', 0o700)
    vfs.renameSync('/dsh/seeded.txt', '/dsh/renamed.txt')
    vfs.rmSync('/dsh/created', { recursive: true })
    expect(mutations.map(mutation => ({
      kind: mutation.kind,
      path: mutation.path,
      ...mutation.kind === 'write' ? { entryChanged: mutation.entryChanged } : {},
      ...mutation.kind === 'chmod' ? { mode: mutation.mode } : {},
    }))).toEqual([
      { kind: 'write', path: '/dsh/seeded.txt', entryChanged: false },
      { kind: 'mkdir', path: '/dsh/created' },
      { kind: 'chmod', path: '/dsh/created', mode: 0o700 },
      { kind: 'remove', path: '/dsh/seeded.txt' },
      { kind: 'write', path: '/dsh/renamed.txt', entryChanged: true },
      { kind: 'remove', path: '/dsh/created' },
    ])
    const renamed = mutations[4]
    expect(renamed?.kind === 'write' && new TextDecoder().decode(renamed.bytes)).toBe('changed')
    expect(() => { vfs.writeFileSync('/missing/file', 'no') }).toThrow(/ENOENT/)
    expect(mutations).toHaveLength(6)
  })

  it('contains a faulty observer and lets disposal stop later notifications', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = vfs.subscribe(() => { throw new Error('observer failed') })
    const seen: string[] = []
    const second = vfs.subscribe((mutation) => { seen.push(mutation.path) })
    vfs.writeFileSync('/dsh/one', '1')
    first()
    second()
    vfs.writeFileSync('/dsh/two', '2')
    expect(seen).toEqual(['/dsh/one'])
    expect(reported).toHaveBeenCalledOnce()
  })

  it('feeds the same complete mutations to a durable sink and live subscribers', async () => {
    const recorded: VfsMutation[] = []
    let flushes = 0
    const sink: VfsMutationSink = {
      record: (mutation) => { recorded.push(mutation) },
      flush: async () => { flushes += 1 },
    }
    const vfs = new MemoryVfs({ sink })
    vfs.seedDirectory('/dsh')
    const observed: VfsMutation[] = []
    vfs.subscribe((mutation) => { observed.push(mutation) })
    vfs.writeFileSync('/dsh/log', 'a')
    vfs.appendFileSync('/dsh/log', 'bc')
    await vfs.flush()
    expect(observed).toEqual(recorded)
    expect(observed[0]).toBe(recorded[0])
    expect(recorded[0]).toMatchObject({ kind: 'write', path: '/dsh/log', mode: 0o644, entryChanged: true })
    expect(recorded[1]).toMatchObject({ kind: 'write', path: '/dsh/log', mode: 0o644, entryChanged: false, appendedFrom: 1 })
    expect(recorded[1]?.kind === 'write' && new TextDecoder().decode(recorded[1].bytes)).toBe('abc')
    expect(flushes).toBe(1)
  })

  it('publishes descriptor writes at the file identity current path', () => {
    const mutations: VfsMutation[] = []
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/source', 'old')
    const descriptor = vfs.openFileSync('/dsh/source', 'r+')
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    vfs.renameSync('/dsh/source', '/dsh/destination')
    mutations.length = 0
    descriptor.write(0, new TextEncoder().encode('new'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/dsh/destination'])
    expect(vfs.readFileSync('/dsh/destination', 'utf8')).toBe('new')
    vfs.unlinkSync('/dsh/destination')
    mutations.length = 0
    descriptor.write(0, new TextEncoder().encode('detached'))
    expect(mutations).toEqual([])
    expect(new TextDecoder().decode(descriptor.read(0, descriptor.stat().size))).toBe('detached')
  })

  it('reports the path identity through a BigInt file handle stat', async () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/session.lock', '')
    const handle = vfs.open('/dsh/session.lock', 'w')
    const held = await handle.stat({ bigint: true }) as VfsBigIntStats
    const current = vfs.statSync('/dsh/session.lock', { bigint: true }) as VfsBigIntStats

    expect([held.dev, held.ino]).toEqual([current.dev, current.ino])
    await handle.chmod(0o600)
    expect((vfs.statSync('/dsh/session.lock') as VfsStats).mode & 0o777).toBe(0o600)
    await handle.close()
  })

  it('decomposes a directory rename into replayable destination state', () => {
    const recorded: VfsMutation[] = []
    const vfs = new MemoryVfs({
      sink: { record: (mutation) => { recorded.push(mutation) }, flush: () => Promise.resolve() },
    })
    vfs.seedDirectory('/dsh/staging/nested', { mode: 0o700 })
    vfs.seed('/dsh/staging/nested/file', 'value', { mode: 0o600 })
    vfs.renameSync('/dsh/staging', '/dsh/published')

    expect(recorded.map(mutation => [mutation.kind, mutation.path])).toEqual([
      ['remove', '/dsh/staging'],
      ['mkdir', '/dsh/published'],
      ['mkdir', '/dsh/published/nested'],
      ['write', '/dsh/published/nested/file'],
    ])
    expect(recorded[3]).toMatchObject({ kind: 'write', mode: 0o600, entryChanged: true })
    expect(recorded[3]?.kind === 'write' && new TextDecoder().decode(recorded[3].bytes)).toBe('value')
  })
})

describe('directory rename', () => {
  it('rejects file, non-empty directory, and missing-parent destinations before mutation', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/source/nested/file', 'source')
    vfs.seed('/dsh/file', 'destination')
    vfs.seed('/dsh/non-empty/child', 'destination')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    expect(() => { vfs.renameSync('/dsh/source', '/dsh/file') })
      .toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
    expect(() => { vfs.renameSync('/dsh/source', '/dsh/non-empty') })
      .toThrow(expect.objectContaining({ code: 'ENOTEMPTY' }))
    expect(() => { vfs.renameSync('/dsh/source', '/missing/destination') })
      .toThrow(expect.objectContaining({ code: 'ENOENT' }))

    expect(vfs.readFileSync('/dsh/source/nested/file', 'utf8')).toBe('source')
    expect(vfs.readFileSync('/dsh/file', 'utf8')).toBe('destination')
    expect(vfs.readFileSync('/dsh/non-empty/child', 'utf8')).toBe('destination')
    expect(mutations).toEqual([])
  })

  it('replaces an empty directory with the source subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh/source/nested', { mode: 0o700 })
    vfs.seed('/dsh/source/nested/file', 'source')
    vfs.seedDirectory('/dsh/destination', { mode: 0o711 })

    vfs.renameSync('/dsh/source', '/dsh/destination')

    expect(vfs.existsSync('/dsh/source')).toBe(false)
    expect(vfs.readFileSync('/dsh/destination/nested/file', 'utf8')).toBe('source')
    expect((vfs.statSync('/dsh/destination') as VfsStats).mode & 0o777).toBe(0o755)
    expect((vfs.statSync('/dsh/destination/nested') as VfsStats).mode & 0o777).toBe(0o700)
  })
})

describe('hard links', () => {
  it('shares identity, bytes, and mode until one name is removed', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/session.jsonl', 'committed\n')
    vfs.linkSync('/dsh/session.jsonl', '/dsh/session-latest.jsonl')
    vfs.linkSync('/dsh/session-latest.jsonl', '/dsh/session-archive.jsonl')
    expect(identity(vfs, '/dsh/session-latest.jsonl')).toBe(identity(vfs, '/dsh/session.jsonl'))
    expect(linkCount(vfs, '/dsh/session.jsonl')).toBe(3n)
    expect(vfs.readFileSync('/dsh/session-latest.jsonl', 'utf8')).toBe('committed\n')
    const changedPaths: string[] = []
    vfs.subscribe((mutation) => { changedPaths.push(mutation.path) })
    vfs.appendFileSync('/dsh/session.jsonl', 'appended\n')
    expect(changedPaths).toEqual([
      '/dsh/session.jsonl',
      '/dsh/session-latest.jsonl',
      '/dsh/session-archive.jsonl',
    ])
    expect(vfs.readFileSync('/dsh/session.jsonl', 'utf8')).toBe('committed\nappended\n')
    expect(vfs.readFileSync('/dsh/session-latest.jsonl', 'utf8')).toBe('committed\nappended\n')
    vfs.chmodSync('/dsh/session-latest.jsonl', 0o600)
    expect((vfs.statSync('/dsh/session.jsonl') as VfsStats).mode & 0o777).toBe(0o600)
    vfs.unlinkSync('/dsh/session-latest.jsonl')
    expect(linkCount(vfs, '/dsh/session.jsonl')).toBe(2n)
    vfs.unlinkSync('/dsh/session-archive.jsonl')
    expect(linkCount(vfs, '/dsh/session.jsonl')).toBe(1n)
    expect(vfs.readFileSync('/dsh/session.jsonl', 'utf8')).toBe('committed\nappended\n')
  })

  it('treats rename between names of the same node as a no-op', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/source', 'value')
    vfs.linkSync('/dsh/source', '/dsh/alias')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    vfs.renameSync('/dsh/source', '/dsh/alias')

    expect(vfs.readFileSync('/dsh/source', 'utf8')).toBe('value')
    expect(vfs.readFileSync('/dsh/alias', 'utf8')).toBe('value')
    expect(linkCount(vfs, '/dsh/source')).toBe(2n)
    expect(mutations).toEqual([])
  })

  it('retargets linked names through file replacement and directory moves', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/replacement', 'replacement')
    vfs.seed('/dsh/target', 'old')
    vfs.linkSync('/dsh/target', '/dsh/target-alias')
    const replaced = vfs.openFileSync('/dsh/target', 'r+')
    vfs.renameSync('/dsh/replacement', '/dsh/target')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    replaced.write(0, new TextEncoder().encode('changed'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/dsh/target-alias'])
    expect(vfs.readFileSync('/dsh/target', 'utf8')).toBe('replacement')
    expect(vfs.readFileSync('/dsh/target-alias', 'utf8')).toBe('changed')
    expect(linkCount(vfs, '/dsh/target-alias')).toBe(1n)

    vfs.seed('/dsh/tree/file', 'tree')
    vfs.linkSync('/dsh/tree/file', '/dsh/outside')
    const moved = vfs.openFileSync('/dsh/tree/file', 'r+')
    vfs.renameSync('/dsh/tree', '/dsh/moved')
    mutations.length = 0
    moved.write(0, new TextEncoder().encode('moved'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/dsh/outside', '/dsh/moved/file'])
    expect(linkCount(vfs, '/dsh/moved/file')).toBe(2n)

    vfs.rmSync('/dsh/moved', { recursive: true })
    mutations.length = 0
    moved.write(0, new TextEncoder().encode('kept!'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/dsh/outside'])
    expect(vfs.readFileSync('/dsh/outside', 'utf8')).toBe('kept!')
    expect(linkCount(vfs, '/dsh/outside')).toBe(1n)
  })

  it('rejects renaming a file over an existing directory', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/file', 'value')
    vfs.seedDirectory('/dsh/directory')
    expect(() => { vfs.renameSync('/dsh/file', '/dsh/directory') }).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    expect(vfs.readFileSync('/dsh/file', 'utf8')).toBe('value')
    expect(vfs.statSync('/dsh/directory').isDirectory()).toBe(true)
  })
})

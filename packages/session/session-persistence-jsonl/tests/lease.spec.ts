/**
 * Cross-process write-lock behavior, exercised through fresh backend
 * instances over one shared root: kernel `flock` locks conflict between two
 * descriptors even inside one process, so a second instance behaves exactly
 * like a second process. Exclusion while a holder is live, immediate
 * admission after close, lock-file residue rules, and the inode verification
 * that defeats an unlinked-and-recreated lock path. Filesystem and flock
 * refusals are injected through the module mocks below: POSIX modes cannot
 * express them on Windows, and an injected error is the only deterministic
 * cross-platform refusal. Real cross-process exclusion and crash release are
 * pinned by lease.two-process.e2e.ts.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '../src/index.ts'
import { LEASE_FILENAME, SessionWriteLease } from '../src/lease.ts'
import type { JsonlSessionHandle } from '../src/storage.ts'
import { sessionDir } from '../src/format.ts'

// The lock's base name, duplicated for the hoisted mock factories: they run
// while `../src/lease.ts` is still evaluating, before LEASE_FILENAME exists.
const LOCK = vi.hoisted(() => 'session.lock')

const refuse = vi.hoisted(() => ({
  /** Next open of a lock file fails EACCES (read-only directory). */
  lockOpen: false,
  /** Next flock call fails EACCES (a non-contention kernel refusal). */
  flock: false,
  /** Next flock call fails EWOULDBLOCK (the Windows LockFileEx contention code). */
  flockBusy: false,
  /** Next stat of a lock file fails EACCES (unreadable path). */
  lockStat: false,
  /** For N further lock-path stats: unlink and recreate the file first, so the locked inode is orphaned. */
  swapLockOnStat: 0,
  /** Next lock-path stat: unlink the file first, so the verify read finds nothing. */
  dropLockOnStat: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const denied = (syscall: string): never => {
    throw Object.assign(new Error(`EACCES: injected ${syscall} refusal`), { code: 'EACCES' })
  }
  return {
    ...actual,
    open: (async (path: unknown, ...rest: never[]) => {
      if (refuse.lockOpen && String(path).endsWith(LOCK)) {
        refuse.lockOpen = false
        denied('open')
      }
      return (actual.open as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.open,
    stat: (async (path: unknown, ...rest: never[]) => {
      const at = String(path)
      if (at.endsWith(LOCK)) {
        if (refuse.lockStat) {
          refuse.lockStat = false
          denied('stat')
        }
        if (refuse.dropLockOnStat) {
          refuse.dropLockOnStat = false
          await actual.unlink(at)
        } else if (refuse.swapLockOnStat > 0) {
          refuse.swapLockOnStat -= 1
          await actual.unlink(at)
          await actual.writeFile(at, '')
        }
      }
      return (actual.stat as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.stat,
  }
})

vi.mock('fs-ext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs-ext')>()
  return {
    ...actual,
    flock: ((fd: number, flags: never, callback: (error: Error | null) => void) => {
      if (refuse.flock) {
        refuse.flock = false
        callback(Object.assign(new Error('EACCES: injected flock refusal'), { code: 'EACCES' }))
        return
      }
      if (refuse.flockBusy) {
        refuse.flockBusy = false
        callback(Object.assign(new Error('EWOULDBLOCK: injected contention'), { code: 'EWOULDBLOCK' }))
        return
      }
      (actual.flock as (fd: number, flags: never, callback: (error: Error | null) => void) => void)(fd, flags, callback)
    }) as typeof actual.flock,
  }
})

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  refuse.lockOpen = false
  refuse.flock = false
  refuse.flockBusy = false
  refuse.lockStat = false
  refuse.swapLockOnStat = 0
  refuse.dropLockOnStat = false
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function meta(id: string, cwd = '/work'): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1_000, cwd, isSeeded: false }
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-lease-'))
  dirs.push(root)
  return root
}

async function mount(root: string): Promise<SessionPersistence> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx.sessionPersistence
}

function lockPath(root: string, id: string, cwd = '/work'): string {
  return join(sessionDir(root, cwd, SessionId(id)), LEASE_FILENAME)
}

/**
 * Make the next lock release do its real work, then report failure — as a
 * close(2) that freed the descriptor but returned EIO would.
 */
function failReleaseOnce(): void {
  const spy = vi.spyOn(SessionWriteLease.prototype, 'release')
  spy.mockImplementationOnce(async function (this: SessionWriteLease) {
    spy.mockRestore()
    await this.release()
    throw Object.assign(new Error('EIO: injected release failure'), { code: 'EIO' })
  })
}

const EVENTS = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
] as const

describe('cross-process write lock', () => {
  it('excludes a second instance while the holder is live, and admits it after close', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    const second = await mount(root)
    const holder = await first.create(meta('excluded'))
    await holder.append([...EVENTS])

    // Another instance over the same root cannot create or write-open the id:
    // the materialized duplicate is an existence fact, the write open an
    // ownership one.
    await expect(second.create(meta('excluded'))).rejects.toBeInstanceOf(SessionAlreadyExistsError)
    await expect(second.open(SessionId('excluded'), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    // Unmaterialized creates hold no lock and leave no artifact, so a rival
    // instance's create succeeds; the collision surfaces at the loser's first
    // materializing write, where the winner already holds the lock.
    const pendingWinner = await first.create(meta('excluded-pending'))
    const pendingLoser = await second.create(meta('excluded-pending'))
    await pendingWinner.append([...EVENTS])
    await expect(pendingLoser.append([...EVENTS])).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await pendingLoser.close()
    await pendingWinner.close()
    // Reads never touch the lock.
    const reader = await second.open(SessionId('excluded'), 'read')
    expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
    await reader.close()

    await holder.close()
    // POSIX keeps the materialized session's lock file (Windows locks a kernel
    // object with no filesystem footprint); the kernel lock itself is gone.
    if (process.platform !== 'win32') expect(existsSync(lockPath(root, 'excluded'))).toBe(true)
    const reopened = await second.open(SessionId('excluded'), 'write')
    await reopened.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
    await reopened.close()
  })

  it.skipIf(process.platform === 'win32')('removing the lock file forfeits a wedged holder: a fresh inode admits a successor', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    const second = await mount(root)
    const wedged = await first.create(meta('wedged'))
    await wedged.append([...EVENTS])

    // The documented escape hatch for a live-but-stuck holder: deleting the
    // lock file orphans the held inode, and a successor locks the fresh one.
    await rm(lockPath(root, 'wedged'))
    const successor = await second.open(SessionId('wedged'), 'write')
    await successor.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
    await successor.close()
    await wedged.close()
  })

  it('write-opening an absent session leaves no lock residue', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    await expect(backend.open(SessionId('absent'), 'write')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    expect(existsSync(join(root, LEASE_FILENAME))).toBe(false)
  })

  it('write-opening an absent id under an existing project directory reports not-found', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const writer = await backend.create(meta('present-sibling'))
    await writer.append([...EVENTS])
    await writer.close()
    // The project directory exists but the id's session directory does not:
    // the generation scan reports absence rather than misreading a sibling.
    await expect(backend.open(SessionId('absent-sibling'), 'write')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  })

  it('a never-materialized create leaves no filesystem footprint at all', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const handle = await backend.create(meta('erased'))
    // The lock is taken only at the first materializing write, so an
    // unmaterialized session creates neither its directory nor a lock file.
    expect(existsSync(join(lockPath(root, 'erased'), '..'))).toBe(false)
    await handle.close()
    expect(existsSync(join(lockPath(root, 'erased'), '..'))).toBe(false)
    await expect(backend.stat(SessionId('erased'))).resolves.toBeUndefined()
  })

  it('materialization publishes the lock before the first log bytes and keeps it on the handle', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    const second = await mount(root)
    const creator = await first.create(meta('lazy-lock'))
    await creator.append([...EVENTS])
    // The materializing append acquired and retained the lock.
    if (process.platform !== 'win32') expect(existsSync(lockPath(root, 'lazy-lock'))).toBe(true)
    await expect(second.open(SessionId('lazy-lock'), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    // A later append reuses the held lock rather than re-acquiring.
    await creator.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
    await creator.close()
    const reopened = await second.open(SessionId('lazy-lock'), 'write')
    await reopened.close()
  })

  it('an explicitly flushed empty session takes the lock with its header', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    const second = await mount(root)
    const creator = await first.create(meta('flush-lock'))
    await creator.flush()
    await expect(second.open(SessionId('flush-lock'), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await creator.close()
  })

  it.skipIf(process.platform === 'win32')('surfaces a filesystem refusal opening the lock file', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const writer = await backend.create(meta('open-blocked'))
    await writer.append([...EVENTS])
    await writer.close()

    refuse.lockOpen = true
    await expect(backend.open(SessionId('open-blocked'), 'write')).rejects.toThrow(/EACCES/)
  })

  it.skipIf(process.platform === 'win32')('surfaces a non-contention flock failure', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const writer = await backend.create(meta('flock-blocked'))
    await writer.append([...EVENTS])
    await writer.close()

    refuse.flock = true
    await expect(backend.open(SessionId('flock-blocked'), 'write')).rejects.toThrow(/EACCES/)
  })

  it.skipIf(process.platform === 'win32')('maps the EWOULDBLOCK contention spelling to already-owned', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const writer = await backend.create(meta('win-contended'))
    await writer.append([...EVENTS])
    await writer.close()

    // Some libcs spell flock(2) contention EWOULDBLOCK rather than EAGAIN.
    refuse.flockBusy = true
    await expect(backend.open(SessionId('win-contended'), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })

  it.skipIf(process.platform === 'win32')('surfaces a lock-path stat refusal from the inode verification', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const writer = await backend.create(meta('stat-blocked'))
    await writer.append([...EVENTS])
    await writer.close()

    refuse.lockStat = true
    await expect(backend.open(SessionId('stat-blocked'), 'write')).rejects.toThrow(/EACCES/)
  })

  it.skipIf(process.platform === 'win32')('retries when the locked inode is no longer the lock path, and wins on a stable pass', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const writer = await backend.create(meta('churned'))
    await writer.append([...EVENTS])
    await writer.close()

    // One churn (unlink+recreate under the verify stat) orphans the first
    // locked inode; the retry locks the fresh file and verifies clean.
    refuse.swapLockOnStat = 1
    const reopened = await backend.open(SessionId('churned'), 'write')
    await reopened.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
    await reopened.close()
  })

  it.skipIf(process.platform === 'win32')('retries when the lock path vanishes under the verify read', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const writer = await backend.create(meta('vanished'))
    await writer.append([...EVENTS])
    await writer.close()

    refuse.dropLockOnStat = true
    const reopened = await backend.open(SessionId('vanished'), 'write')
    await reopened.close()
  })

  it.skipIf(process.platform === 'win32')('gives up as already-owned when the lock path never stabilizes', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const writer = await backend.create(meta('unstable'))
    await writer.append([...EVENTS])
    await writer.close()

    // Churn on every attempt: the bounded retry refuses rather than spinning.
    refuse.swapLockOnStat = 3
    await expect(backend.open(SessionId('unstable'), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })

  it('a failing lock release still frees the in-process claim on close', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const holder = await backend.create(meta('release-fails'))
    await holder.append([...EVENTS])

    failReleaseOnce()
    await expect(holder.close()).rejects.toThrow(/injected release failure/)
    // The claim is freed despite the failed release: the id is not wedged.
    const reopened = await backend.open(SessionId('release-fails'), 'write')
    await reopened.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
    await reopened.close()
  })

  it('a write-open failure with a failing release aggregates both and frees the claim', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const writer = await backend.create(meta('open-and-release-fail'))
    await writer.append([...EVENTS])
    await writer.close()
    // Corrupt the stored header line so the open fails after the lock is
    // acquired (a garbled tail would be recovered as torn, not refused).
    const dir = join(lockPath(root, 'open-and-release-fail'), '..')
    const log = (await readdir(dir)).find(name => name.endsWith('.jsonl'))
    const stored = await readFile(join(dir, String(log)), 'utf8')
    await writeFile(join(dir, String(log)), `#${stored.slice(1)}`)

    failReleaseOnce()
    const outcome = await backend.open(SessionId('open-and-release-fail'), 'write').then(() => undefined, (error: unknown) => error)
    expect(outcome).toBeInstanceOf(AggregateError)
    const errors = (outcome as AggregateError).errors as Error[]
    expect(errors).toHaveLength(2)
    expect(String(errors[0])).toMatch(/corrupt/i)
    expect(String(errors[1])).toMatch(/injected release failure/)
    // The original diagnostic survives, and the claim is freed: the next
    // attempt reports the corruption again rather than a phantom owner.
    await expect(backend.open(SessionId('open-and-release-fail'), 'write')).rejects.toThrow(/corrupt/i)
  })

  it('a drain failure and a release failure reject close as one AggregateError', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const holder = await backend.create(meta('drain-and-release-fail')) as unknown as JsonlSessionHandle
    await holder.append([...EVENTS])

    vi.spyOn(backend as unknown as { persistBatch: () => Promise<void> }, 'persistBatch')
      .mockRejectedValueOnce(new Error('injected drain refusal'))
    holder.enqueueLive({ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }, () => {})
    failReleaseOnce()
    const outcome = await holder.close().then(() => undefined, (error: unknown) => error)
    expect(outcome).toBeInstanceOf(AggregateError)
    expect((outcome as AggregateError).errors.map(String).join('\n')).toMatch(/drain refusal[\s\S]*release failure/)
    // Both failures reported, and the id is still not wedged.
    const reopened = await backend.open(SessionId('drain-and-release-fail'), 'write')
    await reopened.close()
  })

  it.skipIf(process.platform === 'win32')('release is idempotent and never removes the lock file', async () => {
    const root = await freshRoot()
    const dir = join(root, 'solo')
    const lease = await SessionWriteLease.acquire(dir, SessionId('solo'))
    await lease.release()
    await lease.release()
    // The file survives every release, keeping the stable inode later
    // lockers verify against; the kernel lock died with the descriptor.
    expect(existsSync(join(dir, LOCK))).toBe(true)
    const successor = await SessionWriteLease.acquire(dir, SessionId('solo'))
    await successor.release()
    expect(existsSync(join(dir, LOCK))).toBe(true)
  })


  it('keeps distinct sessions independently lockable', async () => {
    const root = await freshRoot()
    const backend = await mount(root)
    const a = await backend.create(meta('indep-a'))
    const b = await backend.create(meta('indep-b'))
    await a.append([...EVENTS])
    await b.append([...EVENTS])
    if (process.platform !== 'win32') {
      expect((await readdir(join(lockPath(root, 'indep-a'), '..'))).filter(name => name === LOCK)).toHaveLength(1)
    }
    await a.close()
    await b.close()
  })
})

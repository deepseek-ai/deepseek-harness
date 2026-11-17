/** Kernel lease contention, filesystem failures, and inode verification. @module */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { SessionWriteLease, LEASE_FILENAME } from '../src/lease.ts'

const faults = vi.hoisted(() => ({ flock: '', stat: false, swap: 0, remove: false }))
vi.mock('@deepseek-ai/node-addon-system/flock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/node-addon-system/flock')>()
  return { ...actual, tryLockExclusive: async (fd: number) => {
    if (faults.flock !== '') {
      const code = faults.flock
      faults.flock = ''
      throw Object.assign(new Error(`flock failed: ${code}`), { code })
    }
    await actual.tryLockExclusive(fd)
  } }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    if (String(args[0]).endsWith('session.lock')) {
      if (faults.stat) {
        faults.stat = false
        throw Object.assign(new Error('lock path denied'), { code: 'EACCES' })
      }
      if (faults.remove) {
        faults.remove = false
        await actual.unlink(args[0])
      } else if (faults.swap > 0) {
        faults.swap--
        await actual.unlink(args[0])
        await actual.writeFile(args[0], '')
      }
    }
    return actual.stat(...args)
  } }
})
afterEach(() => { faults.flock = ''; faults.stat = false; faults.swap = 0; faults.remove = false })

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-lease-'))
  const leases: SessionWriteLease[] = []
  onTestFinished(async () => {
    try { await Promise.all(leases.map(lease => lease.release())) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  async function acquire() {
    const lease = await SessionWriteLease.acquire(root, SessionId('lease'))
    leases.push(lease)
    return lease
  }
  return { root, acquire }
}

describe.skipIf(process.platform === 'win32')('POSIX SQLite leases', () => {
  it('excludes a second descriptor until the holder releases its lock', async () => {
    const fixture = await fixtureRoot()
    const first = await fixture.acquire()
    await expect(fixture.acquire()).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await first.release()
    const next = await fixture.acquire()
    await next.release()
    await next.release()
    expect(await readFile(join(fixture.root, LEASE_FILENAME), 'utf8')).toBe('')
  })

  it.each(['EACCES', 'EWOULDBLOCK'])('releases the descriptor after flock reports %s', async (code) => {
    const fixture = await fixtureRoot()
    faults.flock = code
    const failed = expect(fixture.acquire()).rejects
    if (code === 'EWOULDBLOCK') await failed.toBeInstanceOf(SessionAlreadyOwnedError)
    else await failed.toMatchObject({ code })
    await fixture.acquire()
  })

  it('releases the descriptor when inode verification cannot read the lock path', async () => {
    const fixture = await fixtureRoot()
    faults.stat = true
    await expect(fixture.acquire()).rejects.toMatchObject({ code: 'EACCES' })
    await fixture.acquire()
  })

  it.each(['removed', 'replaced', 'unstable'] as const)('verifies the current inode when its path is %s', async (mode) => {
    const fixture = await fixtureRoot()
    if (mode === 'removed') faults.remove = true
    else faults.swap = mode === 'replaced' ? 1 : 3
    if (mode === 'unstable') await expect(fixture.acquire()).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    else await (await fixture.acquire()).release()
    await fixture.acquire()
  })
})

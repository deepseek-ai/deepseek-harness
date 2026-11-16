/** The claim one running host takes on a LiveShare owner state directory. */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  claimOwnerHost,
  ownerHostClaimPath,
  OwnerHostClaimHeldError,
} from '../src/host/owner-host-claim.ts'

const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-owner-claim-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A record this process did not write. */
function writeClaim(dir: string, value: string): void {
  writeFileSync(ownerHostClaimPath(dir), value)
}

describe('one claim per owner state directory', () => {
  it('creates the directory it claims and releases what it took', () => {
    const dir = join(tempDir(), 'nested')
    const claim = claimOwnerHost(dir)
    expect(existsSync(ownerHostClaimPath(dir))).toBe(true)
    claim.release()
    expect(existsSync(ownerHostClaimPath(dir))).toBe(false)
  })

  it('reports whether the claim file still names this host', () => {
    const dir = tempDir()
    const claim = claimOwnerHost(dir)
    expect(claim.holds()).toBe(true)
    // A successor's record ends this host's ownership without touching this process.
    writeClaim(dir, JSON.stringify({ hostId: 'successor-host', pid: process.pid + 1 }))
    expect(claim.holds()).toBe(false)
    writeClaim(dir, '[]')
    expect(claim.holds()).toBe(false)
    writeClaim(dir, 'not json')
    expect(claim.holds()).toBe(false)
    rmSync(ownerHostClaimPath(dir), { force: true })
    expect(claim.holds()).toBe(false)
    claim.release()
  })

  it('reclaims a record this process left behind', () => {
    const dir = tempDir()
    writeClaim(dir, JSON.stringify({ hostId: 'earlier-host', pid: process.pid }))
    const claim = claimOwnerHost(dir)
    onTestFinished(() => { claim.release() })
    // Every host in one process shares the state, so a record naming this process is not a second owner.
    const record = JSON.parse(readFileSync(ownerHostClaimPath(dir), 'utf8')) as { hostId: string; pid: number }
    expect(record.pid).toBe(process.pid)
    expect(record.hostId).not.toBe('earlier-host')
  })

  it('refuses a claim another live host holds', () => {
    const dir = tempDir()
    writeClaim(dir, JSON.stringify({ hostId: 'other-host', pid: process.pid + 100_000 }))
    expect(() => claimOwnerHost(dir, { alive: () => true })).toThrow(OwnerHostClaimHeldError)
  })

  it('reads a holder this user cannot signal as alive', () => {
    const dir = tempDir()
    writeClaim(dir, JSON.stringify({ hostId: 'other-host', pid: process.pid + 1 }))
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })
    expect(() => claimOwnerHost(dir)).toThrow(OwnerHostClaimHeldError)
  })

  it('reclaims a claim whose process is gone', () => {
    const dir = tempDir()
    writeClaim(dir, JSON.stringify({ hostId: 'dead-host', pid: 999_999 }))
    const claim = claimOwnerHost(dir, { alive: () => false })
    onTestFinished(() => { claim.release() })
    const record = JSON.parse(readFileSync(ownerHostClaimPath(dir), 'utf8')) as { hostId: string; pid: number }
    expect(record.pid).toBe(process.pid)
    expect(record.hostId).not.toBe('dead-host')
  })

  it('reclaims a record whose holder field cannot be read', () => {
    for (const value of ['not json', '{}', '{"pid":"7"}', '{"pid":0}', '{"pid":-1}', '{"pid":1.5}']) {
      const dir = tempDir()
      writeClaim(dir, value)
      const claim = claimOwnerHost(dir)
      onTestFinished(() => { claim.release() })
      expect(JSON.parse(readFileSync(ownerHostClaimPath(dir), 'utf8'))).toMatchObject({ pid: process.pid })
    }
  })

  it('publishes its record beside the claim and leaves no staging file', () => {
    const dir = tempDir()
    const claim = claimOwnerHost(dir)
    onTestFinished(() => { claim.release() })
    expect(readdirSync(dir)).toEqual(['owner-host.json'])
    expect(JSON.parse(readFileSync(ownerHostClaimPath(dir), 'utf8'))).toMatchObject({ pid: process.pid })
    // The record is whole the moment the claim name exists, so a reader never sees an empty claim.
    expect(claim.holds()).toBe(true)
  })

  // A permission denial is the only portable-to-POSIX way to fail this write; Windows cannot stage it.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('surfaces a claim it cannot create', () => {
    const dir = tempDir()
    chmodSync(dir, 0o500)
    try {
      // A directory that refuses the file names a failure other than contention.
      expect(() => claimOwnerHost(dir)).toThrow()
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(existsSync(ownerHostClaimPath(dir))).toBe(false)
  })

  it('leaves a record another host publishes after this call judged the earlier one', () => {
    const dir = tempDir()
    const path = ownerHostClaimPath(dir)
    writeClaim(dir, JSON.stringify({ hostId: 'dead-host', pid: 999_999 }))
    // The competing host publishes after this call read and judged the dead record, so the reread before
    // the removal sees a record this call never judged. That record is its owner's, so the removal skips
    // it; the retry then finds the same claim refused and this host reports the state as held.
    let published = false
    expect(() => claimOwnerHost(dir, {
      alive: () => {
        if (published) return true
        published = true
        writeClaim(dir, JSON.stringify({ hostId: 'raced-host', pid: 999_999 }))
        return false
      },
    })).toThrow(OwnerHostClaimHeldError)
    expect(readFileSync(path, 'utf8')).toContain('raced-host')
  })

  it('rethrows a claim that cannot be created for a reason other than an existing file', () => {
    const dir = tempDir()
    mkdirSync(ownerHostClaimPath(dir))
    expect(() => claimOwnerHost(dir)).toThrow()
  })
})

describe('release', () => {
  it('leaves a claim that now names a successor alone', () => {
    const dir = tempDir()
    const claim = claimOwnerHost(dir)
    writeClaim(dir, JSON.stringify({ hostId: 'successor-host', pid: 4_242 }))
    claim.release()
    expect(readFileSync(ownerHostClaimPath(dir), 'utf8')).toContain('successor-host')
  })

  it('does nothing when the claim file is already gone', () => {
    const dir = tempDir()
    const claim = claimOwnerHost(dir)
    rmSync(ownerHostClaimPath(dir))
    expect(() => { claim.release() }).not.toThrow()
  })

  it('does nothing when the claim file no longer parses', () => {
    const dir = tempDir()
    const claim = claimOwnerHost(dir)
    writeClaim(dir, 'not json')
    claim.release()
    expect(readFileSync(ownerHostClaimPath(dir), 'utf8')).toBe('not json')
  })

  it('does nothing when the claim file is no longer a record', () => {
    const dir = tempDir()
    const claim = claimOwnerHost(dir)
    writeClaim(dir, '[]')
    claim.release()
    expect(readFileSync(ownerHostClaimPath(dir), 'utf8')).toBe('[]')
  })
})

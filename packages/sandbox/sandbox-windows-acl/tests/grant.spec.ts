/**
 * AclWriteGrant tests: the server-side grant materialization — SID parsing
 * fail-closed, ACE add/dispose round-trip against the REAL directory DACL
 * (observed through icacls, the operator's own tool), the recorded path
 * order, and the standing/revocable lifecycle split (workspace ACEs outlive
 * dispose as the reuse cache; temp ACEs revoke). Win32-only, like the other
 * real-FFI suites.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AclWriteGrant } from '../src/index.ts'

const isWin32 = process.platform === 'win32'

/** The directory DACL as icacls renders it (the operator-visible form). */
function icaclsText(path: string): string {
  const result = spawnSync('icacls', [path], { encoding: 'utf8' })
  expect(result.status, `icacls failed: ${result.stderr}`).toBe(0)
  return result.stdout
}

describe.skipIf(!isWin32)('AclWriteGrant (server-side materialization)', () => {
  const scratchDirs: string[] = []
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-acl-grant-'))
    scratchDirs.push(dir)
    return dir
  }

  it('create parses the SID fail-closed: a malformed SID throws before anything is granted', () => {
    expect(() => AclWriteGrant.create('S-1-4-abc-1')).toThrow(/ConvertStringSidToSidW/u)
  })

  it('add materializes the ACE (idempotently) and reports grant order; dispose revokes revocable paths and keeps standing paths standing', () => {
    const dir = scratch()
    const standingDir = scratch()
    const grant = AclWriteGrant.create('S-1-4-9000-77')
    grant.add(dir) // revocable: the session-temp lifecycle
    grant.add(standingDir, true) // standing: the workspace reuse cache
    expect(grant.paths).toEqual([standingDir, dir])
    expect(icaclsText(dir)).toContain('S-1-4-9000-77')
    expect(icaclsText(standingDir)).toContain('S-1-4-9000-77')
    // A second add over the standing exact ACE is a DACL-read no-op: the
    // grant stays exactly one ACE (the reuse across sessions/restarts).
    grant.add(dir)
    grant.add(standingDir, true)
    expect(icaclsText(dir)).toContain('S-1-4-9000-77')
    expect(icaclsText(standingDir)).toContain('S-1-4-9000-77')
    grant.dispose()
    expect(icaclsText(dir)).not.toContain('S-1-4-9000-77')
    expect(icaclsText(standingDir)).toContain('S-1-4-9000-77')
  })

  it('two grants with different SIDs coexist and revoke independently', () => {
    const dir = scratch()
    const grantA = AclWriteGrant.create('S-1-4-9000-78')
    const grantB = AclWriteGrant.create('S-1-4-9000-79')
    grantA.add(dir)
    grantB.add(dir)
    expect(icaclsText(dir)).toContain('S-1-4-9000-78')
    expect(icaclsText(dir)).toContain('S-1-4-9000-79')
    grantA.dispose()
    expect(icaclsText(dir)).not.toContain('S-1-4-9000-78')
    expect(icaclsText(dir)).toContain('S-1-4-9000-79')
    grantB.dispose()
    expect(icaclsText(dir)).not.toContain('S-1-4-9000-79')
  })
})

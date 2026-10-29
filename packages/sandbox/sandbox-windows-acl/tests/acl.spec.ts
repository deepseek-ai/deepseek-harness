/**
 * ACL edit tests: the read-merge-write grant keeps pre-existing explicit
 * ACEs, interleaved sandbox instances do not clobber each other, the
 * per-path lock primitive is deterministic, and the grant mask carries
 * DELETE + FILE_DELETE_CHILD (never WRITE_DAC/WRITE_OWNER).
 *
 * All state lives in %TEMP% mkdtemp scratch directories; the only exception
 * is the mandated lock infrastructure under <GetTempPathW()>\dsh-acl-locks,
 * whose per-test lock file is removed in cleanup.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import koffi from 'koffi'

import { buildExplicitAccess, grantWrite, lockFilePath, revokeWrite, withPathLock } from '../src/acl.ts'
import { AclSandbox } from '../src/index.ts'
import { createRestrictedToken, makeWellKnownSid } from '../src/token.ts'
import { allocOverlapped, allocPtrSlot, decodePtr, isInvalidHandle, isNullPtr, win32 } from '../src/ffi.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import * as abi from '../src/win32-abi.ts'

const isWin32 = process.platform === 'win32'

/** FILE_READ_DATA (winnt.h line ~5895): the harmless mask the explicit test ACE grants. */
const FILE_READ_DATA = 0x0001

/** koffi SID layout: revision@0, subAuthorityCount@1, identifierAuthority@2 (6 bytes, big-endian), subAuthority@8. */
const SID_STRUCT = koffi.struct('DSH_ACL_SPEC_SID', {
  revision: 'uint8',
  subAuthorityCount: 'uint8',
  identifierAuthority: 'uint8[6]',
  subAuthority: 'uint32[8]',
})

interface SidLayout {
  revision: number
  subAuthorityCount: number
  identifierAuthority: number[]
  subAuthority: number[]
}

/** One direct (explicit, non-inherited) allow ACE of a directory DACL. */
interface DirectAce {
  sid: string
  mask: number
}

/** Convert one SID string to a LocalAlloc'd SID pointer (caller frees). */
function sidFromString(api: Win32Bindings, sid: string): NativePtr {
  const slot = allocPtrSlot()
  if (api.convertStringSidToSidW(sid, slot) === 0) throw new Error(`ConvertStringSidToSidW failed for ${sid}`)
  const ptr = decodePtr(slot)
  if (ptr === null) throw new Error(`ConvertStringSidToSidW returned null for ${sid}`)
  return ptr
}

/** Stringify a decoded SID layout (identifierAuthority bytes 2..5 are the big-endian value). */
function sidString(sid: SidLayout): string {
  const authority = ((sid.identifierAuthority[2] ?? 0) << 24)
    | ((sid.identifierAuthority[3] ?? 0) << 16)
    | ((sid.identifierAuthority[4] ?? 0) << 8)
    | (sid.identifierAuthority[5] ?? 0)
  const subs = sid.subAuthority.slice(0, sid.subAuthorityCount).join('-')
  return `S-${sid.revision}-${authority}${sid.subAuthorityCount > 0 ? `-${subs}` : ''}`
}

/**
 * Read the directory's explicit allow ACEs (inherited ACEs excluded): each
 * ACE header is AceType@0, AceFlags@1, AceSize@2 (winnt.h lines ~3477-3480);
 * ACCESS_ALLOWED_ACE stores Mask@4 and the inline SID@8. The ACL pointer sits
 * inside the descriptor allocation — only the descriptor is LocalFree'd.
 */
function readDirectAces(api: Win32Bindings, path: string): DirectAce[] {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throw new Error(`GetNamedSecurityInfoW failed (${readResult}) for ${path}`)
  const acl = decodePtr(daclSlot)
  const descriptor = decodePtr(descriptorSlot)
  try {
    if (acl === null) return []
    const aclSize = koffi.decode(acl, 2, 'uint16') as number
    const aces: DirectAce[] = []
    for (let offset = 8; offset + 8 <= aclSize;) {
      const flags = koffi.decode(acl, offset + 1, 'uint8') as number
      const aceSize = koffi.decode(acl, offset + 2, 'uint16') as number
      if ((flags & abi.INHERITED_ACE) === 0) {
        aces.push({ sid: sidString(koffi.decode(acl, offset + 8, SID_STRUCT) as SidLayout), mask: koffi.decode(acl, offset + 4, 'uint32') as number })
      }
      offset += aceSize
    }
    return aces
  } finally {
    if (descriptor !== null) api.localFree(descriptor)
  }
}

/** One direct (explicit, non-inherited) label ACE of a directory's mandatory label. */
interface DirectLabelAce {
  sid: string
  mask: number
}

/** The Low integrity SID every grant labels with (S-1-16-4096). */
function lowLabelSid(api: Win32Bindings): NativePtr {
  return makeWellKnownSid(api, abi.WinLowLabelSid)
}

/** The world SID (S-1-1-0) every grant denies the ambient delete right to. */
function worldSid(api: Win32Bindings): NativePtr {
  return makeWellKnownSid(api, abi.WinWorldSid)
}

/**
 * Read the directory's mandatory label ACEs (inherited entries excluded) —
 * same ACE layout as {@link readDirectAces}, read through the label security
 * information class. A directory with no label returns an empty list.
 */
function readLabelAces(api: Win32Bindings, path: string): DirectLabelAce[] {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.LABEL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throw new Error(`GetNamedSecurityInfoW (label) failed (${readResult}) for ${path}`)
  const acl = decodePtr(saclSlot)
  const descriptor = decodePtr(descriptorSlot)
  try {
    if (acl === null) return []
    const aclSize = koffi.decode(acl, 2, 'uint16') as number
    const aces: DirectLabelAce[] = []
    for (let offset = 8; offset + 8 <= aclSize;) {
      const type = koffi.decode(acl, offset, 'uint8') as number
      const flags = koffi.decode(acl, offset + 1, 'uint8') as number
      const aceSize = koffi.decode(acl, offset + 2, 'uint16') as number
      if (type === abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE && (flags & abi.INHERITED_ACE) === 0) {
        aces.push({ sid: sidString(koffi.decode(acl, offset + 8, SID_STRUCT) as SidLayout), mask: koffi.decode(acl, offset + 4, 'uint32') as number })
      }
      offset += aceSize
    }
    return aces
  } finally {
    if (descriptor !== null) api.localFree(descriptor)
  }
}

/** One ACE of a directory DACL, inherited or not. */
interface TypedAce {
  sid: string
  mask: number
  type: number
  flags: number
}

/**
 * Read every ACE of the object's DACL (inherited ones included) — the shape
 * needed to observe what a grant propagated onto children.
 */
function readTypedAces(api: Win32Bindings, path: string): TypedAce[] {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throw new Error(`GetNamedSecurityInfoW failed (${readResult}) for ${path}`)
  const acl = decodePtr(daclSlot)
  const descriptor = decodePtr(descriptorSlot)
  try {
    if (acl === null) return []
    const aclSize = koffi.decode(acl, 2, 'uint16') as number
    const aces: TypedAce[] = []
    for (let offset = 8; offset + 8 <= aclSize;) {
      const aceSize = koffi.decode(acl, offset + 2, 'uint16') as number
      aces.push({
        sid: sidString(koffi.decode(acl, offset + 8, SID_STRUCT) as SidLayout),
        mask: koffi.decode(acl, offset + 4, 'uint32') as number,
        type: koffi.decode(acl, offset, 'uint8') as number,
        flags: koffi.decode(acl, offset + 1, 'uint8') as number,
      })
      offset += aceSize
    }
    return aces
  } finally {
    if (descriptor !== null) api.localFree(descriptor)
  }
}

describe.skipIf(!isWin32)('ACL editing', () => {
  const scratchDirs: string[] = []
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-acl-edit-'))
    scratchDirs.push(dir)
    return dir
  }

  it('the ambient-delete deny inherits to subdirectories only, never onto files', async () => {
    // FILE_DELETE_CHILD is meaningless on a file and 0x40 is part of
    // FILE_ALL_ACCESS, so a file-level copy would deny every FullControl open
    // inside the granted root.
    const api = await win32()
    const dir = scratch()
    const capabilitySid = sidFromString(api, 'S-1-4-4242-11')
    const lowSid = lowLabelSid(api)
    const world = worldSid(api)
    const childDir = join(dir, 'child')
    const childFile = join(dir, 'child.txt')
    try {
      grantWrite(api, dir, capabilitySid, lowSid, world)
      mkdirSync(childDir)
      writeFileSync(childFile, 'x')
      const isWorldDeny = (ace: TypedAce): boolean =>
        ace.type === abi.ACCESS_DENIED_ACE_TYPE && ace.sid === 'S-1-1-0' && ace.mask === abi.FILE_DELETE_CHILD
      expect(readTypedAces(api, dir).filter(isWorldDeny)).toHaveLength(1) // explicit on the root
      expect(readTypedAces(api, childDir).filter(isWorldDeny)).toHaveLength(1) // inherited by the container
      expect(readTypedAces(api, childFile).filter(isWorldDeny)).toHaveLength(0) // never by the file
      const rootDeny = readTypedAces(api, dir).find(isWorldDeny)
      expect(rootDeny?.flags).toBe(abi.CONTAINER_INHERIT_ACE)
    } finally {
      if (!isNullPtr(capabilitySid)) api.localFree(capabilitySid)
      if (!isNullPtr(lowSid)) api.localFree(lowSid)
      if (!isNullPtr(world)) api.localFree(world)
    }
  })

  it('revoking one of two grants on a directory keeps the shared Low label', async () => {
    const api = await win32()
    const dir = scratch()
    const sidA = sidFromString(api, 'S-1-4-4242-21')
    const sidB = sidFromString(api, 'S-1-4-4242-22')
    const lowSid = lowLabelSid(api)
    const world = worldSid(api)
    try {
      grantWrite(api, dir, sidA, lowSid, world)
      grantWrite(api, dir, sidB, lowSid, world)
      revokeWrite(api, dir, sidA)
      expect(readDirectAces(api, dir).some(ace => ace.sid === 'S-1-4-4242-21')).toBe(false)
      expect(readDirectAces(api, dir).some(ace => ace.sid === 'S-1-4-4242-22')).toBe(true)
      expect(readLabelAces(api, dir)).toHaveLength(1) // the surviving grant still needs it
      revokeWrite(api, dir, sidB)
      expect(readLabelAces(api, dir)).toEqual([]) // the last revoke clears it
    } finally {
      if (!isNullPtr(sidA)) api.localFree(sidA)
      if (!isNullPtr(sidB)) api.localFree(sidB)
      if (!isNullPtr(lowSid)) api.localFree(lowSid)
      if (!isNullPtr(world)) api.localFree(world)
    }
  })

  it('grantWrite merges into the current DACL: an explicit Users ACE survives grant+revoke', async () => {
    const api = await win32()
    const dir = scratch()
    const usersSid = sidFromString(api, 'S-1-5-32-545')
    const capabilitySid = sidFromString(api, 'S-1-4-4242-1')
    const lowSid = lowLabelSid(api)
    const world = worldSid(api)
    try {
      // Install one explicit ACE (Users + benign read mask) with the
      // package's own bindings, exactly like a pre-existing explicit DACL
      // entry another sandbox instance or administrator added.
      const newAclSlot = allocPtrSlot()
      const mergeResult = api.setEntriesInAclW(1, buildExplicitAccess(usersSid, abi.GRANT_ACCESS, FILE_READ_DATA), null, newAclSlot)
      expect(mergeResult, `SetEntriesInAclW setup (${mergeResult})`).toBe(abi.ERROR_SUCCESS)
      const newAcl = decodePtr(newAclSlot)
      expect(newAcl).not.toBeNull()
      const applyResult = api.setNamedSecurityInfoW(
        dir, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION, null, null, newAcl, null,
      )
      const freed = newAcl === null ? null : api.localFree(newAcl)
      expect(applyResult, `SetNamedSecurityInfoW setup (${applyResult})`).toBe(abi.ERROR_SUCCESS)
      expect(isNullPtr(freed)).toBe(true)

      grantWrite(api, dir, capabilitySid, lowSid, world)

      const granted = readDirectAces(api, dir)
      expect(granted.some(ace => ace.sid === 'S-1-5-32-545')).toBe(true) // explicit ACE preserved
      expect(granted.some(ace => ace.sid === 'S-1-4-4242-1')).toBe(true)

      revokeWrite(api, dir, capabilitySid)

      const aces = readDirectAces(api, dir)
      expect(aces.some(ace => ace.sid === 'S-1-5-32-545')).toBe(true) // explicit ACE preserved
      expect(aces.some(ace => ace.sid === 'S-1-4-4242-1')).toBe(false) // orphan grant fully removed
      expect(readLabelAces(api, dir)).toEqual([]) // the label went with it
    } finally {
      if (!isNullPtr(usersSid)) api.localFree(usersSid)
      if (!isNullPtr(capabilitySid)) api.localFree(capabilitySid)
      if (!isNullPtr(lowSid)) api.localFree(lowSid)
      if (!isNullPtr(world)) api.localFree(world)
    }
  })

  it('grantWrite applies the Low no-write-up label and denies the ambient parent-delete right; revokeWrite clears both capability and label', async () => {
    const api = await win32()
    const dir = scratch()
    const capabilitySid = sidFromString(api, 'S-1-4-4242-9')
    const lowSid = lowLabelSid(api)
    const world = worldSid(api)
    try {
      expect(readLabelAces(api, dir)).toEqual([])
      grantWrite(api, dir, capabilitySid, lowSid, world)
      expect(readLabelAces(api, dir)).toEqual([
        { sid: 'S-1-16-4096', mask: abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP },
      ])
      // The ambient delete route inside another granted root is what the deny
      // removes; the capability ACE stays the only delete authority there.
      const denied = readDirectAces(api, dir).filter(ace => ace.sid === 'S-1-1-0')
      expect(denied).toEqual([{ sid: 'S-1-1-0', mask: abi.FILE_DELETE_CHILD }])
      revokeWrite(api, dir, capabilitySid)
      expect(readLabelAces(api, dir)).toEqual([])
      expect(readDirectAces(api, dir).some(ace => ace.sid === 'S-1-4-4242-9')).toBe(false)
    } finally {
      if (!isNullPtr(capabilitySid)) api.localFree(capabilitySid)
      if (!isNullPtr(lowSid)) api.localFree(lowSid)
      if (!isNullPtr(world)) api.localFree(world)
    }
  })

  it('grantWrite is idempotent: a second grant over the standing exact ACE, deny, and label skips the SetNamedSecurityInfoW apply (no eager full-tree re-propagation)', async () => {
    const api = await win32()
    const dir = scratch()
    const capabilitySid = sidFromString(api, 'S-1-4-4242-2')
    const lowSid = lowLabelSid(api)
    const world = worldSid(api)
    const apply = vi.spyOn(api, 'setNamedSecurityInfoW')
    try {
      grantWrite(api, dir, capabilitySid, lowSid, world)
      expect(apply).toHaveBeenCalledTimes(1)
      // The exact ACE, deny, and label now stand (the per-session grant
      // surviving from a previous server lifetime): the second grant is a read only.
      grantWrite(api, dir, capabilitySid, lowSid, world)
      expect(apply).toHaveBeenCalledTimes(1)
      const aces = readDirectAces(api, dir)
      expect(aces.filter(ace => ace.sid === 'S-1-4-4242-2')).toHaveLength(1)
      expect(aces.filter(ace => ace.sid === 'S-1-1-0')).toHaveLength(1)
      expect(readLabelAces(api, dir)).toHaveLength(1)
      revokeWrite(api, dir, capabilitySid)
      expect(readDirectAces(api, dir).some(ace => ace.sid === 'S-1-4-4242-2')).toBe(false)
    } finally {
      apply.mockRestore()
      if (!isNullPtr(capabilitySid)) api.localFree(capabilitySid)
      if (!isNullPtr(lowSid)) api.localFree(lowSid)
      if (!isNullPtr(world)) api.localFree(world)
    }
  })

  it('interleaved sandbox instances: A.init → B.init → A.dispose → B.dispose leaves BOTH standing workspace ACEs (the per-workspace reuse cache)', async () => {
    const api = await win32()
    const dir = scratch()
    const sandboxA = new AclSandbox({ writableDirs: [dir], tempDir: null, writeSid: 'S-1-4-9000-1', mode: 'workspace-write' })
    const sandboxB = new AclSandbox({ writableDirs: [dir], tempDir: null, writeSid: 'S-1-4-9000-2', mode: 'workspace-write' })
    await sandboxA.init()
    await sandboxB.init()
    // Workspace ACEs are STANDING: dispose frees the instance's SID
    // allocations but deliberately leaves the ACEs — they are the reuse
    // cache the next provision's exact-ACE skip consumes.
    sandboxA.dispose()
    sandboxB.dispose()
    const aces = readDirectAces(api, dir)
    expect(aces.some(ace => ace.sid === 'S-1-4-9000-1')).toBe(true)
    expect(aces.some(ace => ace.sid === 'S-1-4-9000-2')).toBe(true)
  })

  it('dispose revokes the revocable temp ACE and label and keeps the standing workspace pair (self-managed flow)', async () => {
    const api = await win32()
    const workspaceDir = scratch()
    const tempDir = scratch()
    const sandbox = new AclSandbox({
      writableDirs: [workspaceDir],
      tempDir,
      writeSid: 'S-1-4-9000-3',
      tempWriteSid: 'S-1-4-9000-3-1',
      mode: 'workspace-write',
    })
    await sandbox.init()
    sandbox.dispose()
    const workspaceAces = readDirectAces(api, workspaceDir)
    expect(workspaceAces.some(ace => ace.sid === 'S-1-4-9000-3')).toBe(true)
    expect(readLabelAces(api, workspaceDir)).toEqual([
      { sid: 'S-1-16-4096', mask: abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP },
    ])
    const tempAces = readDirectAces(api, tempDir)
    expect(tempAces.some(ace => ace.sid === 'S-1-4-9000-3-1')).toBe(false)
    expect(readLabelAces(api, tempDir)).toEqual([])
  })

  it('rejects an overlapping private temp directory before applying either capability', async () => {
    const workspaceDir = scratch()
    const nestedTemp = join(workspaceDir, 'temp')
    const writeSid = 'S-1-4-9000-30'
    const privateTempSid = 'S-1-4-9000-30-1'
    mkdirSync(nestedTemp)
    const sandbox = new AclSandbox({
      writableDirs: [workspaceDir],
      tempDir: nestedTemp,
      writeSid,
      tempWriteSid: privateTempSid,
      mode: 'workspace-write',
    })

    await expect(sandbox.init()).rejects.toThrow(/private temp directory must be disjoint/u)
    const api = await win32()
    expect(readDirectAces(api, workspaceDir).some(ace => ace.sid === writeSid)).toBe(false)
    expect(readDirectAces(api, nestedTemp).some(ace => ace.sid === privateTempSid)).toBe(false)
  })

  it('workspace-write without a write SID fails at construction; the token layer guards the same contract', () => {
    const dir = scratch()
    expect(() => new AclSandbox({ writableDirs: [dir], tempDir: null, mode: 'workspace-write' }))
      .toThrow(/requires a write SID/)
    expect(() => new AclSandbox({ writableDirs: [dir], writeSid: 'S-1-4-1-1', mode: 'workspace-write' }))
      .toThrow(/requires an explicit private temp directory or null/)
    expect(() => new AclSandbox({ writableDirs: [dir], tempDir: dir, writeSid: 'S-1-4-1-1', mode: 'workspace-write' }))
      .toThrow(/requires a temp write SID/)
    expect(() => new AclSandbox({
      writableDirs: [dir],
      tempDir: dir,
      writeSid: 'S-1-4-1-1',
      tempWriteSid: 'S-1-4-1-1',
      mode: 'workspace-write',
    })).toThrow(/must be distinct/)
    expect(() => createRestrictedToken({} as never, 0n as never, 0n as never, [], { world: 0n as never }, 'workspace-write'))
      .toThrow(/requires at least one write SID/)
  })

  it('the per-path lock is exclusive: a second immediate lock attempt fails with ERROR_LOCK_VIOLATION until release', async () => {
    const api = await win32()
    const dir = scratch()
    const lockPath = lockFilePath(api, dir)
    const open = (): NativePtr => api.createFileW(
      lockPath, abi.GENERIC_READ | abi.GENERIC_WRITE,
      abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE, null, abi.OPEN_ALWAYS, 0, null,
    )
    const first = open()
    const second = open()
    expect(isInvalidHandle(first)).toBe(false)
    expect(isInvalidHandle(second)).toBe(false)
    try {
      expect(api.lockFileEx(first, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, allocOverlapped())).toBe(1)
      expect(api.lockFileEx(second, abi.LOCKFILE_EXCLUSIVE_LOCK | abi.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, allocOverlapped())).toBe(0)
      expect(api.getLastError()).toBe(abi.ERROR_LOCK_VIOLATION)
      expect(api.unlockFileEx(first, 0, 1, 0, allocOverlapped())).toBe(1)
      expect(api.lockFileEx(second, abi.LOCKFILE_EXCLUSIVE_LOCK | abi.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, allocOverlapped())).toBe(1)
      expect(api.unlockFileEx(second, 0, 1, 0, allocOverlapped())).toBe(1)
    } finally {
      api.closeHandle(first)
      api.closeHandle(second)
      rmSync(lockPath, { force: true })
    }
  })

  it('withPathLock serializes the action and releases the lock even when the action throws', async () => {
    const api = await win32()
    const dir = scratch()
    const lockPath = lockFilePath(api, dir)
    let attempts = 0
    expect(() => withPathLock(api, dir, () => {
      attempts++
      throw new Error('action failure')
    })).toThrow('action failure')
    expect(attempts).toBe(1)
    // The lock was released: a fresh immediate lock succeeds.
    const handle = api.createFileW(
      lockPath, abi.GENERIC_READ | abi.GENERIC_WRITE,
      abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE, null, abi.OPEN_ALWAYS, 0, null,
    )
    expect(isInvalidHandle(handle)).toBe(false)
    try {
      expect(api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK | abi.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, allocOverlapped())).toBe(1)
      expect(api.unlockFileEx(handle, 0, 1, 0, allocOverlapped())).toBe(1)
    } finally {
      api.closeHandle(handle)
      rmSync(lockPath, { force: true })
    }
  })

  it('the applied grant mask carries DELETE and FILE_DELETE_CHILD (never WRITE_DAC/WRITE_OWNER)', async () => {
    const api = await win32()
    const dir = scratch()
    const sandbox = new AclSandbox({ writableDirs: [dir], tempDir: null, writeSid: 'S-1-4-1234-5', mode: 'workspace-write' })
    try {
      await sandbox.init()
      const grant = readDirectAces(api, dir).find(ace => ace.sid === 'S-1-4-1234-5')
      expect(grant).toBeDefined()
      const mask = grant?.mask ?? 0
      expect(mask).toBe(abi.GRANT_MASK)
      expect(mask & abi.DELETE).toBe(abi.DELETE)
      expect(mask & abi.FILE_DELETE_CHILD).toBe(abi.FILE_DELETE_CHILD)
      expect(mask & 0x00040000).toBe(0) // WRITE_DAC must never be granted
      expect(mask & 0x00080000).toBe(0) // WRITE_OWNER must never be granted
    } finally {
      sandbox.dispose()
    }
  })
})

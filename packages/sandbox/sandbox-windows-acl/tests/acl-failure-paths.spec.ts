/**
 * ACL failure-path tests with minimal stub binding tables: every checked
 * Win32 call in the lock, read-merge-write, mandatory-label, and
 * grant-skip sequence has a failing counterpart, and each failure closes the
 * handles it created before throwing. The exact-ACE/exact-label skip and the
 * DACL/SACL-walk defenses are driven through crafted in-memory ACL/SID
 * buffers. Pure stubs — no real Win32 calls, so these run on every platform;
 * the real-FFI round-trip lives in acl.spec.ts (win32 only).
 */

import { tmpdir } from 'node:os'
import { Win32Error } from '@deepseek-ai/dsh-win32-process'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import koffi from 'koffi'

import { grantWrite, revokeWrite, withPathLock } from '../src/acl.ts'
import { allocBytes, ptrAddress } from '../src/ffi.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import * as abi from '../src/win32-abi.ts'

const PVOID = koffi.pointer('void')

/** The stub the grant/revoke happy path needs; every call succeeds until a field is overridden per test. */
function aclApi(overrides: Partial<Win32Bindings> = {}): Win32Bindings {
  return {
    getTempPathW: vi.fn((_length: number, buffer: Buffer) => {
      const temp = tmpdir().replace(/[\\/]$/u, '')
      buffer.write(temp, 'utf16le')
      return temp.length
    }),
    createFileW: vi.fn(() => 7n),
    lockFileEx: vi.fn(() => 1),
    unlockFileEx: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getNamedSecurityInfoW: vi.fn((
      _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
      dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
    ) => {
      koffi.encode(dacl, PVOID, 0n) // no explicit DACL: the merge builds one
      koffi.encode(sacl, PVOID, 0n) // no mandatory label either
      koffi.encode(descriptor, PVOID, 0n)
      return 0
    }),
    setEntriesInAclW: vi.fn((_count: unknown, _entries: unknown, _old: unknown, newAcl: NativePtr) => {
      koffi.encode(newAcl, PVOID, 9n)
      return 0
    }),
    setNamedSecurityInfoW: vi.fn(() => 0),
    localAlloc: vi.fn(() => 11n),
    getLengthSid: vi.fn(() => 12),
    initializeAcl: vi.fn(() => 1),
    addMandatoryAce: vi.fn(() => 1),
    localFree: vi.fn(() => 0n as NativePtr),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    ...overrides,
  } as Win32Bindings
}

/** One SID allocation: revision@0, subAuthorityCount@1, identifierAuthority@2 (6 bytes), subauthorities@8. */
function craftSid(revision: number, count: number, authority: number[] = [0, 0, 0, 0, 0, 5]): NativePtr {
  const sid = allocBytes(8)
  koffi.encode(sid, 'uint8', revision)
  koffi.encode(sid, 1, 'uint8', count)
  authority.forEach((byte, index) => {
    koffi.encode(sid, 2 + index, 'uint8', byte)
  })
  return sid
}

/** The Low integrity SID both the token and the directory labels name. */
function craftLowLabelSid(): NativePtr {
  return craftSid(1, 0, [0, 0, 0, 0, 0, 16])
}

/** The world SID the grant's ambient-delete deny names (crafted like the other stubs: 8 header bytes, no sub-authorities). */
function craftWorldSid(): NativePtr {
  return craftSid(1, 0, [0, 0, 0, 0, 0, 1])
}

/** Write one 16-byte ACE (AceType@0, AceFlags@1, AceSize@2, Mask@4, inline SID@8) at `offset`. */
function writeAce(
  acl: NativePtr,
  offset: number,
  aceType: number,
  mask: number,
  sid: NativePtr,
  match: boolean,
  inheritance: number = abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): void {
  koffi.encode(acl, offset + 0, 'uint8', aceType)
  koffi.encode(acl, offset + 1, 'uint8', inheritance)
  koffi.encode(acl, offset + 2, 'uint16', 16)
  koffi.encode(acl, offset + 4, 'uint32', mask)
  for (let byte = 0; byte < 8; byte++) {
    koffi.encode(acl, offset + 8 + byte, 'uint8', match
      ? koffi.decode(sid, byte, 'uint8') as number
      : byte === 0 ? 9 : 0)
  }
}

/**
 * One in-memory ACL carrying a single inheritable ACE: header (AclRevision@0,
 * AclSize@2, AceCount@4) then a 16-byte ACE. `match` selects whether the
 * inline SID bytes equal `sid`.
 */
function craftAcl(aceType: number, mask: number, sid: NativePtr, match: boolean): NativePtr {
  const acl = allocBytes(32)
  koffi.encode(acl, 'uint8', 2) // AclRevision
  koffi.encode(acl, 2, 'uint16', 24)
  koffi.encode(acl, 4, 'uint16', 1)
  writeAce(acl, 8, aceType, mask, sid, match)
  return acl
}

/**
 * A two-ACE DACL: the ambient-delete deny plus the capability grant, each with
 * caller-chosen type, mask, and trustee match so the skip's field checks can be
 * driven one at a time.
 */
function craftPair(
  grantSid: NativePtr,
  world: NativePtr,
  denyType: number,
  denyMask: number,
  denyMatches: boolean,
  grantMatches: boolean,
): NativePtr {
  const acl = allocBytes(64)
  koffi.encode(acl, 'uint8', 2)
  koffi.encode(acl, 2, 'uint16', 40)
  koffi.encode(acl, 4, 'uint16', 2)
  writeAce(acl, 8, denyType, denyMask, world, denyMatches, abi.CONTAINER_INHERIT_ACE)
  writeAce(acl, 24, abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, grantSid, grantMatches)
  return acl
}

/**
 * The DACL a fully granted directory carries: the ambient-delete deny for the
 * world SID plus the capability grant. `grantMatches` selects whether the
 * grant's inline SID equals `sid` (the deny always matches), and
 * `includeDeny` drops the deny to model a root granted by an earlier build.
 */
function craftGrantedAcl(sid: NativePtr, world: NativePtr, grantMatches: boolean, includeDeny = true): NativePtr {
  if (!includeDeny) {
    const acl = allocBytes(64)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 24)
    koffi.encode(acl, 4, 'uint16', 1)
    writeAce(acl, 8, abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, grantMatches)
    return acl
  }
  return craftPair(sid, world, abi.ACCESS_DENIED_ACE_TYPE, abi.FILE_DELETE_CHILD, true, grantMatches)
}

/** The label ACL the exact-label skip looks for: the Low no-write-up label ACE. */
function craftAclWithLabel(sid: NativePtr, match: boolean): NativePtr {
  return craftAcl(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, sid, match)
}

/** Encode a security-info read whose DACL and label ACL are the given pointers. */
function readStub(dacl: NativePtr | null, label: NativePtr | null, descriptor: bigint | null) {
  return vi.fn((
    _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
    daclSlot: NativePtr, saclSlot: NativePtr, descriptorSlot: NativePtr,
  ) => {
    koffi.encode(daclSlot, PVOID, dacl === null ? 0n : ptrAddress(dacl))
    koffi.encode(saclSlot, PVOID, label === null ? 0n : ptrAddress(label))
    koffi.encode(descriptorSlot, PVOID, descriptor ?? 0n)
    return 0
  })
}

describe('withPathLock failure paths', () => {
  it('fails closed when CreateFileW returns an invalid handle', () => {
    const api = aclApi({ createFileW: vi.fn(() => 0n as NativePtr) })
    let caught: unknown
    try {
      withPathLock(api, 'C:\\locked', () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreateFileW')
  })

  it('closes the handle and reports when LockFileEx fails', () => {
    const closeHandle = vi.fn(() => 1)
    const api = aclApi({ lockFileEx: vi.fn(() => 0), closeHandle })
    let caught: unknown
    try {
      withPathLock(api, 'C:\\locked', () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LockFileEx')
    expect(closeHandle).toHaveBeenCalledWith(7n)
  })

  it('closes the handle and reports when UnlockFileEx fails', () => {
    const closeHandle = vi.fn(() => 1)
    const api = aclApi({ unlockFileEx: vi.fn(() => 0), closeHandle })
    let caught: unknown
    try {
      withPathLock(api, 'C:\\locked', () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('UnlockFileEx')
    expect(closeHandle).toHaveBeenCalledWith(7n)
  })

  it('reports a failed CloseHandle after a successful action', () => {
    const api = aclApi({ closeHandle: vi.fn(() => 0) })
    let caught: unknown
    try {
      withPathLock(api, 'C:\\locked', () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CloseHandle')
  })
})

describe('buildLowLabelAcl failure paths', () => {
  it('reports a failed GetLengthSid for the Low label SID', () => {
    const api = aclApi({ getLengthSid: vi.fn(() => 0) })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('GetLengthSid')
  })

  it('reports a failed LocalAlloc for the label ACL', () => {
    const api = aclApi({ localAlloc: vi.fn(() => 0n as NativePtr) })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalAlloc')
  })

  it('frees the label ACL and reports when InitializeAcl fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ initializeAcl: vi.fn(() => 0), localFree })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('InitializeAcl')
    expect(localFree).toHaveBeenCalledWith(11n)
  })

  it('frees the label ACL and reports when AddMandatoryAce fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ addMandatoryAce: vi.fn(() => 0), localFree })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('AddMandatoryAce')
    expect(localFree).toHaveBeenCalledWith(11n)
  })
})

describe('mergeAndApply failure paths', () => {
  it('reports a SetEntriesInAclW failure when the directory carries no descriptor to free', () => {
    const api = aclApi({ setEntriesInAclW: vi.fn(() => 5) }) // default descriptor: none
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
  })

  it('reports a NULL merged ACL when there is no descriptor to free', () => {
    const api = aclApi({ setEntriesInAclW: vi.fn(() => 0) }) // no out slot write, no descriptor
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
  })

  it('frees the descriptor and reports when SetEntriesInAclW fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n), // an existing descriptor without a DACL
      setEntriesInAclW: vi.fn(() => 5),
      localFree,
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the descriptor and reports a NULL merged ACL', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      setEntriesInAclW: vi.fn(() => 0), // success without writing the out slot
      localFree,
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the merged ACL and the label ACL and reports when SetNamedSecurityInfoW fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ setNamedSecurityInfoW: vi.fn(() => 5), localFree })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetNamedSecurityInfoW')
    expect(localFree).toHaveBeenCalledWith(9n) // merged DACL
    expect(localFree).toHaveBeenCalledWith(11n) // label ACL
  })

  it('reports a failed descriptor LocalFree after a successful apply', () => {
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      localFree: vi.fn(() => 1n as NativePtr), // both frees "fail"; the first is checked
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
  })

  it('reports a failed merged-ACL LocalFree after a successful apply', () => {
    // No existing descriptor (the default stub): the merge's only LocalFree
    // is the merged ACL's, which "fails" and is checked after the apply.
    const api = aclApi({ localFree: vi.fn(() => 1n as NativePtr) })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
  })

  it('reports a failed label-ACL LocalFree after a successful apply', () => {
    // Every free succeeds until the label ACL's: descriptor and merged ACL
    // return null, the label ACL returns a stale pointer.
    const localFree = vi.fn()
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(0n)
      .mockReturnValue(1n)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      localFree,
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
    expect(localFree).toHaveBeenLastCalledWith(11n)
  })

  it('frees the label ACL when SetEntriesInAclW fails during a revoke', () => {
    // The revoke carries no label ACL of its own: the early exit must still
    // release the descriptor and leave the label edit untouched.
    const localFree = vi.fn(() => 0n as NativePtr)
    const sid = craftSid(1, 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), null, 6n),
      setEntriesInAclW: vi.fn(() => 5),
      localFree,
    })
    let caught: unknown
    try {
      revokeWrite(api, 'C:\\granted', sid)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the descriptor on the null-merged-ACL path during a revoke', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const sid = craftSid(1, 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), null, 6n),
      setEntriesInAclW: vi.fn(() => 0), // success without writing the out slot
      localFree,
    })
    let caught: unknown
    try {
      revokeWrite(api, 'C:\\granted', sid)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the descriptor when the label ACL build fails', () => {
    // The read already owns a descriptor allocation; the label failure must
    // not strand it.
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      initializeAcl: vi.fn(() => 0),
      localFree,
    })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('InitializeAcl')
    expect(localFree).toHaveBeenCalledWith(11n) // the half-built label ACL
    expect(localFree).toHaveBeenCalledWith(6n) // the read descriptor
  })

  it('frees the label ACL when SetEntriesInAclW fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ setEntriesInAclW: vi.fn(() => 5), localFree })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(11n) // the label ACL this apply owns
  })

  it('frees the label ACL and the descriptor on the null-merged-ACL path', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      setEntriesInAclW: vi.fn(() => 0), // success without writing the out slot
      localFree,
    })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
    expect(localFree).toHaveBeenCalledWith(11n)
  })
})

describe('revokeWrite label handling', () => {
  /** The SECURITY_INFORMATION and SACL of the last apply. */
  function applyArgs(setNamedSecurityInfoW: Mock<Win32Bindings['setNamedSecurityInfoW']>): { information: number; sacl: unknown } {
    const call = setNamedSecurityInfoW.mock.calls.at(-1)
    return { information: call?.[2] as number, sacl: call?.[6] }
  }

  it('keeps the shared Low label while another capability grant stands', () => {
    const sid = craftSid(1, 0)
    const otherSid = craftSid(1, 0, [0, 0, 0, 0, 0, 6])
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      // The directory carries the deny plus a grant for a DIFFERENT SID.
      getNamedSecurityInfoW: readStub(
        craftPair(otherSid, world, abi.ACCESS_DENIED_ACE_TYPE, abi.FILE_DELETE_CHILD, true, true), null, 6n,
      ),
      setNamedSecurityInfoW,
    })
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(true)
    const { information, sacl } = applyArgs(setNamedSecurityInfoW)
    expect(information & abi.LABEL_SECURITY_INFORMATION).toBe(0) // the label was left untouched
    expect(sacl).toBeNull()
  })

  it('clears the Low label once the last capability grant is revoked', () => {
    const sid = craftSid(1, 0)
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), null, 6n),
      setNamedSecurityInfoW,
    })
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(abi.LABEL_SECURITY_INFORMATION)
  })

  it('clears the Low label when a malformed tiny DACL hides any foreign grant', () => {
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 4) // smaller than the ACL header
    koffi.encode(acl, 4, 'uint16', 1)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({ getNamedSecurityInfoW: readStub(acl, null, 6n), setNamedSecurityInfoW })
    expect(revokeWrite(api, 'C:\\granted', craftSid(1, 0))).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(abi.LABEL_SECURITY_INFORMATION)
  })

  it('clears the Low label when a lying ACE size hides any foreign grant', () => {
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 8)
    koffi.encode(acl, 4, 'uint16', 1)
    koffi.encode(acl, 10, 'uint16', 100)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({ getNamedSecurityInfoW: readStub(acl, null, 6n), setNamedSecurityInfoW })
    expect(revokeWrite(api, 'C:\\granted', craftSid(1, 0))).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(abi.LABEL_SECURITY_INFORMATION)
  })
})

describe('the exact-ACE/exact-label skip and ACL-walk defenses', () => {
  it('grantWrite skips the apply when the standing exact ACE and the exact label match (descriptor freed, nothing merged)', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const localFree = vi.fn(() => 0n as NativePtr)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), craftAclWithLabel(lowSid, true), 6n),
      localFree,
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).not.toHaveBeenCalled()
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('grantWrite skips the apply without freeing when the exact ACE and label stand but no descriptor owns them', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const localFree = vi.fn(() => 0n as NativePtr)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      // the read "returned" ACLs with no descriptor allocation of their own
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), craftAclWithLabel(lowSid, true), null),
      localFree,
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).not.toHaveBeenCalled()
    expect(localFree).not.toHaveBeenCalled()
  })

  it('grantWrite reports a failed descriptor LocalFree on the exact-ACE/exact-label skip path', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), craftAclWithLabel(lowSid, true), 6n),
      localFree: vi.fn(() => 1n as NativePtr),
    })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, lowSid, world)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
  })

  it('does not skip when a root granted by an earlier build carries the ACE and label but no ambient-delete deny', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true, false), craftAclWithLabel(lowSid, true), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('does not skip when the deny names another trustee', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(
        craftPair(sid, world, abi.ACCESS_DENIED_ACE_TYPE, abi.FILE_DELETE_CHILD, false, true), craftAclWithLabel(lowSid, true), 6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('does not treat a deny of another right as the ambient-delete deny', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(
        craftPair(sid, world, abi.ACCESS_DENIED_ACE_TYPE, abi.GRANT_MASK, true, true), craftAclWithLabel(lowSid, true), 6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('does not treat an Allow ACE as the ambient-delete deny', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(
        craftPair(sid, world, abi.ACCESS_ALLOWED_ACE_TYPE, abi.FILE_DELETE_CHILD, true, true), craftAclWithLabel(lowSid, true), 6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('does not skip when the standing ACE and label match but the label ACL is absent', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), null, 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('does not skip when the exact ACE stands but the label names another integrity level', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), craftAclWithLabel(lowSid, false), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('falls back to the merge path when the standing ACE names a different SID', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, false), craftAclWithLabel(lowSid, true), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('treats an implausibly small ACL size as no exact grant', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 4) // smaller than the 8-byte ACL header
    koffi.encode(acl, 4, 'uint16', 1)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(acl, craftAclWithLabel(lowSid, true), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('treats an ACE that would overrun the ACL as no exact grant', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 8) // header only: no room for any ACE
    koffi.encode(acl, 4, 'uint16', 1)
    koffi.encode(acl, 10, 'uint16', 100) // the walk reads a lying ACE size
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(acl, craftAclWithLabel(lowSid, true), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('treats an implausibly small label ACL size as no exact label', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const label = allocBytes(32)
    koffi.encode(label, 'uint8', 2)
    koffi.encode(label, 2, 'uint16', 4) // smaller than the 8-byte ACL header
    koffi.encode(label, 4, 'uint16', 1)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), label, 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('treats a label ACE that would overrun its ACL as no exact label', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const label = allocBytes(32)
    koffi.encode(label, 'uint8', 2)
    koffi.encode(label, 2, 'uint16', 8) // header only: no room for any ACE
    koffi.encode(label, 4, 'uint16', 1)
    koffi.encode(label, 10, 'uint16', 100) // the walk reads a lying ACE size
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), label, 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('does not treat a no-write-up ACL Allow ACE as the mandatory label', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      // Same mask and SID, but an ACCESS_ALLOWED_ACE is not a mandatory label.
      getNamedSecurityInfoW: readStub(
        craftGrantedAcl(sid, world, true),
        craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowSid, true),
        6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })

  it('does not treat a label ACE granting write-up as the exact label', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(
        craftGrantedAcl(sid, world, true),
        craftAcl(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, 0, lowSid, true),
        6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1)
  })
})

describe('revokeWrite no-DACL path', () => {
  it('reports nothing to revoke when the read yields neither DACL nor descriptor', () => {
    // The default stub encodes a NULL DACL and a NULL descriptor.
    const api = aclApi()
    const sid = craftSid(1, 0)
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(false)
  })

  it('frees a descriptor that carries no DACL and reports nothing to revoke', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n), // descriptor WITHOUT a DACL
      localFree,
    })
    const sid = craftSid(1, 0)
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(false)
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('reports a failed descriptor LocalFree on the no-DACL path', () => {
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      localFree: vi.fn(() => 1n as NativePtr),
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      revokeWrite(api, 'C:\\granted', sid)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
  })
})

/**
 * AclWriteGrant failure-path tests with minimal stub binding tables: create
 * fails closed on SID-parse failure,
 * dispose aggregates revocation and SID-free failures into an
 * AggregateError. Pure stubs — no real Win32 calls, so these run on every
 * platform; the real-FFI round-trip lives in grant.spec.ts (win32 only).
 */

import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import koffi from 'koffi'

import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import { AclWriteGrant } from '../src/index.ts'

const PVOID = koffi.pointer('void')

/** Stub binding table: only the members a test drives, so the rest are never called. */
function stubBindings(overrides: Partial<Win32Bindings>): Win32Bindings {
  return overrides as Win32Bindings
}

/** The stub the grant-then-fail-revoke sequence needs: every call succeeds until the DACL read is flipped off. */
function grantThenFailApi(): { api: Win32Bindings; failReads: () => void } {
  const state = { failReads: false }
  const api = stubBindings({
    convertStringSidToSidW: vi.fn((_sid: string, slot: NativePtr) => {
      koffi.encode(slot, PVOID, 42n)
      return 1
    }),
    createWellKnownSid: vi.fn(() => 1),
    isValidSid: vi.fn(() => 1),
    getLengthSid: vi.fn(() => 12),
    localAlloc: vi.fn(() => 11n as NativePtr),
    initializeAcl: vi.fn(() => 1),
    addMandatoryAce: vi.fn(() => 1),
    getTempPathW: vi.fn((_length: number, buffer: Buffer) => {
      const temp = tmpdir().endsWith('/') || tmpdir().endsWith('\\') ? tmpdir() : `${tmpdir()}/`
      buffer.write(temp, 'utf16le')
      return temp.length
    }),
    createFileW: vi.fn(() => 7n as NativePtr),
    lockFileEx: vi.fn(() => 1),
    unlockFileEx: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getNamedSecurityInfoW: vi.fn((
      _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
      dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
    ) => {
      if (state.failReads) return 2 // ERROR_FILE_NOT_FOUND — the revoke's read fails
      koffi.encode(dacl, PVOID, 0n) // no explicit DACL: the merge builds one
      koffi.encode(sacl, PVOID, 0n)
      koffi.encode(descriptor, PVOID, 0n)
      return 0
    }),
    setEntriesInAclW: vi.fn((_count: unknown, _entries: unknown, _old: unknown, newAcl: NativePtr) => {
      koffi.encode(newAcl, PVOID, 9n)
      return 0
    }),
    setNamedSecurityInfoW: vi.fn(() => 0),
    localFree: vi.fn(() => 0n as NativePtr),
    getLastError: vi.fn(() => 2),
    formatMessageW: vi.fn(() => 0),
  })
  return { api, failReads: () => { state.failReads = true } }
}

describe('AclWriteGrant failure paths', () => {
  it('create fails closed: a SID parse failure throws before anything is granted', () => {
    const api = {
      convertStringSidToSidW: vi.fn(() => 0),
      getLastError: vi.fn(() => 87),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    expect(() => AclWriteGrant.create('S-1-4-abc-1', api)).toThrow(/ConvertStringSidToSidW/)
  })

  it('create fails closed: a null SID pointer is rejected', () => {
    const api = {
      convertStringSidToSidW: vi.fn((_sid: string, slot: NativePtr) => {
        koffi.encode(slot, PVOID, 0n)
        return 1
      }),
      getLastError: vi.fn(() => 87),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32Bindings
    expect(() => AclWriteGrant.create('S-1-4-42-42', api)).toThrow(/null SID/)
  })

  it('dispose aggregates a failing revocation into an AggregateError (best-effort cleanup)', () => {
    const { api, failReads } = grantThenFailApi()
    const grant = AclWriteGrant.create('S-1-4-42-42', api)
    grant.add('C:\\granted')
    expect(grant.paths).toEqual(['C:\\granted'])
    failReads()
    expect(() =>{  grant.dispose() }).toThrow(AggregateError)
  })

  it('dispose aggregates a failing SID free into an AggregateError', () => {
    const api = stubBindings({
      convertStringSidToSidW: vi.fn((_sid: string, slot: NativePtr) => {
        koffi.encode(slot, PVOID, 42n)
        return 1
      }),
      createWellKnownSid: vi.fn(() => 1),
      isValidSid: vi.fn(() => 1),
      localFree: vi.fn(() => 1n as NativePtr), // non-NULL: LocalFree "failed"
      getLastError: vi.fn(() => 87),
      formatMessageW: vi.fn(() => 0),
    })
    const grant = AclWriteGrant.create('S-1-4-42-42', api)
    expect(() =>{  grant.dispose() }).toThrow(AggregateError)
  })

  it('create fails closed when the Low label SID cannot be created', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = stubBindings({
      convertStringSidToSidW: vi.fn((_sid: string, slot: NativePtr) => {
        koffi.encode(slot, PVOID, 42n)
        return 1
      }),
      createWellKnownSid: vi.fn(() => 0),
      localFree,
      getLastError: vi.fn(() => 87),
      formatMessageW: vi.fn(() => 0),
    })
    expect(() => AclWriteGrant.create('S-1-4-42-42', api)).toThrow(/CreateWellKnownSid/)
    expect(localFree).toHaveBeenCalledWith(42n) // the parsed capability SID is not stranded
  })

  it('create frees both earlier SIDs when the world SID cannot be created', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    let calls = 0
    const api = stubBindings({
      convertStringSidToSidW: vi.fn((_sid: string, slot: NativePtr) => {
        koffi.encode(slot, PVOID, 42n)
        return 1
      }),
      createWellKnownSid: vi.fn(() => (++calls === 1 ? 1 : 0)), // the Low label SID succeeds, the world SID fails
      isValidSid: vi.fn(() => 1),
      localFree,
      getLastError: vi.fn(() => 87),
      formatMessageW: vi.fn(() => 0),
    })
    expect(() => AclWriteGrant.create('S-1-4-42-42', api)).toThrow(/CreateWellKnownSid/)
    expect(localFree).toHaveBeenCalledTimes(2)
    expect(localFree).toHaveBeenCalledWith(42n)
  })
})

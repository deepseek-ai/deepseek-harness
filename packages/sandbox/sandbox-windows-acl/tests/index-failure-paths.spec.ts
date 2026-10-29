/**
 * AclSandbox orchestration failure-path tests: the win32 resolver is mocked
 * to hand each test a stub binding table, so every checked Win32 call in
 * init/spawn/dispose has a failing counterpart without opening real token or
 * ACL handles. Constructor validation, the fail-closed init cleanup, and the
 * dispose aggregation use the same stubs. Pure stubs — no real Win32 calls,
 * so these run on every platform; the real-FFI round-trip lives in
 * acl.spec.ts and runner.spec.ts (win32 only).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Win32Error } from '@deepseek-ai/dsh-win32-process'
import { ERROR_BROKEN_PIPE } from '@deepseek-ai/dsh-win32-process/src/abi.ts'
import { processInformationType } from '@deepseek-ai/dsh-win32-process/src/ffi.ts'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import koffi from 'koffi'

import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import { AclSandbox } from '../src/index.ts'
import * as abi from '../src/win32-abi.ts'

const PVOID = koffi.pointer('void')

type MockFn = ReturnType<typeof vi.fn>

/** The stub binding table plus the mocks the assertions inspect directly. */
interface HappyStubs {
  api: Win32Bindings
  setNamedSecurityInfoW: MockFn
  convertStringSidToSidW: MockFn
  closeHandle: MockFn
  localFree: MockFn
  createRestrictedToken: MockFn
  createJobObjectW: MockFn
  getNamedSecurityInfoW: MockFn
  setTokenInformation: MockFn
  addMandatoryAce: MockFn
}

const state = vi.hoisted(() => ({ stubs: undefined as HappyStubs | undefined }))

vi.mock('../src/ffi.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ffi.ts')>()
  return {
    ...actual,
    win32: () => Promise.resolve(state.stubs?.api as Win32Bindings),
    win32Sync: () => state.stubs?.api as Win32Bindings,
  }
})

const scratchDirs: string[] = []
afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-acl-index-'))
  scratchDirs.push(dir)
  return dir
}

/** Stub binding table: only the members a test drives, so the rest are never called. */
function stubBindings(overrides: Partial<Win32Bindings>): Win32Bindings {
  return overrides as Win32Bindings
}

/**
 * The stub the whole happy pipeline needs: token opening, capability-SID
 * parsing, workspace+temp grants, logon-SID scan, well-known SID, restricted token,
 * default-DACL merge, piped/inherited spawns, drains, and exit waits all
 * succeed. Every test flips one call per branch.
 */
function happyStubs(): HappyStubs {
  let next = 0n
  const fresh = (): NativePtr => ++next as NativePtr

  const openProcess = vi.fn(() => fresh())
  const openProcessToken = vi.fn((_process: unknown, _access: unknown, slot: NativePtr) => {
    koffi.encode(slot, PVOID, fresh())
    return 1
  })
  const convertStringSidToSidW = vi.fn((_sid: string, slot: NativePtr) => {
    koffi.encode(slot, PVOID, fresh())
    return 1
  })
  const getTempPathW = vi.fn((_length: number, buffer: Buffer) => {
    const temp = tmpdir().replace(/[\\/]$/u, '')
    buffer.write(temp, 'utf16le')
    return temp.length
  })
  const createFileW = vi.fn(() => fresh())
  const getNamedSecurityInfoW = vi.fn((
    _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
    dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
  ) => {
    koffi.encode(dacl, PVOID, 0n)
    koffi.encode(sacl, PVOID, 0n)
    koffi.encode(descriptor, PVOID, 0n)
    return 0
  })
  const setEntriesInAclW = vi.fn((_count: unknown, _entries: unknown, _old: unknown, newAcl: NativePtr) => {
    koffi.encode(newAcl, PVOID, fresh())
    return 0
  })
  const setNamedSecurityInfoW = vi.fn(() => 0)
  const localAlloc = vi.fn(() => fresh())
  const initializeAcl = vi.fn(() => 1)
  const addMandatoryAce = vi.fn(() => 1)
  const getTokenInformation = vi.fn((_token: unknown, cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
    if (info === null) {
      koffi.encode(needed, 'uint32', cls === abi.TokenGroups ? 24 : 8)
      return 0 // the size probe is expected to "fail"
    }
    if (cls === abi.TokenGroups) {
      info.writeUInt32LE(1, 0)
      info.writeBigUInt64LE(77n, abi.TOKEN_GROUPS_OFFSET)
      info.writeUInt32LE(abi.SE_GROUP_LOGON_ID, abi.TOKEN_GROUPS_OFFSET + 8)
    } else {
      info.writeBigUInt64LE(88n, 0) // the token's current default DACL
    }
    return 1
  })
  const getLengthSid = vi.fn(() => 12)
  const copySid = vi.fn(() => 1)
  const createWellKnownSid = vi.fn(() => 1)
  const isValidSid = vi.fn(() => 1)
  const createRestrictedToken = vi.fn((
    _existing: unknown, _flags: unknown, _dc: unknown, _ds: unknown, _pc: unknown, _pd: unknown,
    _rc: unknown, _rs: unknown, slot: NativePtr,
  ) => {
    koffi.encode(slot, PVOID, fresh())
    return 1
  })
  const setTokenInformation = vi.fn(() => 1)
  const createPipe = vi.fn((readSlot: NativePtr, writeSlot: NativePtr) => {
    koffi.encode(readSlot, PVOID, fresh())
    koffi.encode(writeSlot, PVOID, fresh())
    return 1
  })
  const setHandleInformation = vi.fn(() => 1)
  const createProcessAsUserW = vi.fn((
    _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
    _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
  ) => {
    koffi.encode(processInfo, processInformationType(), { hProcess: fresh(), hThread: fresh(), dwProcessId: 1234, dwThreadId: 5678 })
    return 1
  })
  const peekNamedPipe = vi.fn(() => 0)
  const readFile = vi.fn(() => 1)
  const waitForSingleObject = vi.fn(() => 0)
  const getExitCodeProcess = vi.fn((_process: unknown, slot: NativePtr) => {
    koffi.encode(slot, 'uint32', 42)
    return 1
  })
  const createJobObjectW = vi.fn(() => fresh())
  const setInformationJobObject = vi.fn(() => 1)
  const assignProcessToJobObject = vi.fn(() => 1)
  const resumeThread = vi.fn(() => 0)
  const terminateProcess = vi.fn(() => 1)
  const getStdHandle = vi.fn(() => fresh())
  const localFree = vi.fn(() => 0n as NativePtr)
  const closeHandle = vi.fn(() => 1)
  const getLastError = vi.fn(() => ERROR_BROKEN_PIPE) // the drains' clean EOF
  const formatMessageW = vi.fn(() => 0)

  const api = stubBindings({
    openProcess, openProcessToken, convertStringSidToSidW, getTempPathW, createFileW,
    lockFileEx: vi.fn(() => 1), unlockFileEx: vi.fn(() => 1),
    getNamedSecurityInfoW, setEntriesInAclW, setNamedSecurityInfoW, getTokenInformation,
    localAlloc, initializeAcl, addMandatoryAce,
    getLengthSid, copySid, createWellKnownSid, isValidSid, createRestrictedToken,
    setTokenInformation, createPipe, setHandleInformation, createProcessAsUserW,
    peekNamedPipe, readFile, waitForSingleObject, getExitCodeProcess, createJobObjectW,
    setInformationJobObject, assignProcessToJobObject, resumeThread, terminateProcess,
    getStdHandle,
    localFree, closeHandle, getLastError, formatMessageW,
  })
  return {
    api, setNamedSecurityInfoW, convertStringSidToSidW, closeHandle, localFree,
    createRestrictedToken, createJobObjectW, getNamedSecurityInfoW, setTokenInformation, addMandatoryAce,
  }
}

beforeEach(() => {
  state.stubs = happyStubs()
})

describe('AclSandbox constructor validation', () => {
  it('rejects a writable directory that does not exist', () => {
    const missing = join(scratch(), 'missing')
    expect(() => new AclSandbox({ writableDirs: [missing], tempDir: null, mode: 'read-only' }))
      .toThrow(/writable dir does not exist/u)
  })

  it('resolves relative writable directories to absolute paths', () => {
    const dir = scratch()
    const sandbox = new AclSandbox({ writableDirs: [dir], tempDir: null, mode: 'read-only' })
    expect(sandbox.writableDirs).toEqual([resolve(dir)])
    expect(sandbox.mode).toBe('read-only')
    expect(sandbox.tempDir).toBeUndefined()
  })

  it('rejects temp authority under read-only', () => {
    const workspace = scratch()
    const temp = scratch()
    expect(() => new AclSandbox({ writableDirs: [workspace], tempDir: temp, mode: 'read-only' }))
      .toThrow(/read-only does not accept a temp directory/u)
    expect(() => new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-1', mode: 'read-only' }))
      .toThrow(/read-only does not accept write SIDs/u)
    expect(() => new AclSandbox({ writableDirs: [workspace], tempDir: null, tempWriteSid: 'S-1-4-9000-1-1', mode: 'read-only' }))
      .toThrow(/read-only does not accept write SIDs/u)
  })

  it('rejects a temp SID when temp writes are disabled', () => {
    const workspace = scratch()
    expect(() => new AclSandbox({
      writableDirs: [workspace],
      tempDir: null,
      writeSid: 'S-1-4-9000-2',
      tempWriteSid: 'S-1-4-9000-2-1',
      mode: 'workspace-write',
    })).toThrow(/temp write SID requires a temp directory/u)
  })
})

describe('AclSandbox init', () => {
  it('completes the happy workspace-write pipeline: workspace and temp grants, restricted token, resolved temp dir', async () => {
    const { setNamedSecurityInfoW } = state.stubs as HappyStubs
    const workspace = scratch()
    const temp = scratch()
    const sandbox = new AclSandbox({
      writableDirs: [workspace],
      tempDir: temp,
      writeSid: 'S-1-4-9000-1',
      tempWriteSid: 'S-1-4-9000-1-1',
      mode: 'workspace-write',
    })
    await sandbox.init()
    expect(sandbox.tempDir).toBe(resolve(temp))
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('requires an explicit private temp directory or null under workspace-write', () => {
    const workspace = scratch()
    expect(() => new AclSandbox({ writableDirs: [workspace], writeSid: 'S-1-4-9000-2', mode: 'workspace-write' }))
      .toThrow(/requires an explicit private temp directory or null/u)
  })

  it('applies no grants when the temp dir option is null', async () => {
    const { setNamedSecurityInfoW } = state.stubs as HappyStubs
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-3', mode: 'workspace-write' })
    await sandbox.init()
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1) // workspace only
  })

  it('rejects a temp dir that does not exist', async () => {
    const workspace = scratch()
    const sandbox = new AclSandbox({
      writableDirs: [workspace],
      tempDir: join(scratch(), 'missing'),
      writeSid: 'S-1-4-9000-4',
      tempWriteSid: 'S-1-4-9000-4-1',
      mode: 'workspace-write',
    })
    await expect(sandbox.init()).rejects.toThrow(/temp dir does not exist/u)
  })

  it('builds a read-only token without parsing a write SID or applying grants', async () => {
    const { convertStringSidToSidW, setNamedSecurityInfoW } = state.stubs as HappyStubs
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, mode: 'read-only' })
    await sandbox.init()
    expect(convertStringSidToSidW).not.toHaveBeenCalled()
    expect(setNamedSecurityInfoW).not.toHaveBeenCalled()
    expect(() => { sandbox.dispose() }).not.toThrow() // no write SID: nothing to revoke or free
  })

  it('applies no grants when the caller owns the DACLs (manageDacls: false)', async () => {
    const { setNamedSecurityInfoW } = state.stubs as HappyStubs
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-5', mode: 'workspace-write', manageDacls: false })
    await sandbox.init()
    expect(setNamedSecurityInfoW).not.toHaveBeenCalled()
    expect(() => { sandbox.dispose() }).not.toThrow() // caller-owned DACLs: nothing to revoke
  })

  it('refuses a second init on the same instance', async () => {
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-6', mode: 'workspace-write' })
    await sandbox.init()
    await expect(sandbox.init()).rejects.toThrow(/already initialized/u)
  })

  it('reports a ConvertStringSidToSidW failure before granting anything', async () => {
    const { convertStringSidToSidW, setNamedSecurityInfoW } = state.stubs as HappyStubs
    convertStringSidToSidW.mockReturnValue(0)
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-7', mode: 'workspace-write' })
    await expect(sandbox.init()).rejects.toMatchObject({ api: 'ConvertStringSidToSidW' })
    expect(setNamedSecurityInfoW).not.toHaveBeenCalled()
  })

  it('rejects a NULL write SID after ConvertStringSidToSidW succeeds', async () => {
    const { convertStringSidToSidW } = state.stubs as HappyStubs
    convertStringSidToSidW.mockImplementation(() => 1) // no out slot write
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-8', mode: 'workspace-write' })
    await expect(sandbox.init()).rejects.toBeInstanceOf(Win32Error)
  })

  it('aggregates failed current and restricted token closes after init', async () => {
    const { closeHandle, createRestrictedToken } = state.stubs as HappyStubs
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-9', mode: 'workspace-write' })
    const restrictedToken = 99n
    createRestrictedToken.mockImplementation((
      _existing: unknown, _flags: unknown, _dc: unknown, _ds: unknown, _pc: unknown, _pd: unknown,
      _rc: unknown, _rs: unknown, slot: NativePtr,
    ) => {
      koffi.encode(slot, PVOID, restrictedToken)
      return 1
    })
    // fresh() hands out 1n to OpenProcess and 2n to OpenProcessToken; the
    // token-layer close of 1n succeeds and init's close of 2n fails.
    closeHandle.mockImplementation((handle: NativePtr) => (handle === 2n || handle === restrictedToken ? 0 : 1))
    // The failure lands after this.token is stored but before this.api is
    // assigned. Cleanup retries the still-open handle and reports both close
    // failures plus the restricted-token close after releasing parsed SIDs.
    await expect(sandbox.init()).rejects.toMatchObject({
      errors: [
        { api: 'CloseHandle' },
        { api: 'CloseHandle' },
        { api: 'CloseHandle' },
      ],
    })
  })

  it('revokes the revocable grants and aggregates cleanup failures when the token pipeline fails', async () => {
    const { createRestrictedToken, localFree, getNamedSecurityInfoW } = state.stubs as HappyStubs
    const workspace = scratch()
    const temp = scratch()
    let inCleanup = false
    createRestrictedToken.mockImplementation(() => {
      inCleanup = true // the grants already landed: every later call is the cleanup's
      return 0
    })
    localFree.mockImplementation(() => (inCleanup ? 1n : 0n))
    getNamedSecurityInfoW.mockImplementation((
      _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
      dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
    ) => {
      if (inCleanup) return 2 // the cleanup's revocation read fails too
      koffi.encode(dacl, PVOID, 0n)
      koffi.encode(sacl, PVOID, 0n)
      koffi.encode(descriptor, PVOID, 0n)
      return 0
    })
    const sandbox = new AclSandbox({
      writableDirs: [workspace],
      tempDir: temp,
      writeSid: 'S-1-4-9000-10',
      tempWriteSid: 'S-1-4-9000-10-1',
      mode: 'workspace-write',
    })
    // Five SID frees/mutations fail plus the Low label SID the init allocated.
    await expect(sandbox.init()).rejects.toThrow(/6 cleanup operation\(s\) also failed/u)
    expect(sandbox.tempDir).toBeUndefined()
  })
})

describe('AclSandbox spawn', () => {
  it('refuses control with piped stdio before starting a restricted process', async () => {
    const sandbox = new AclSandbox({ writableDirs: [], tempDir: null, mode: 'read-only' })
    await sandbox.init()
    expect(() => sandbox.spawn({ command: 'probe.exe', controlFileDescriptor: 7 })).toThrow('control pipe requires inherited stdio')
    sandbox.dispose()
  })

  it('forwards the inherited control pipe to the restricted child', async () => {
    const { api } = state.stubs as HappyStubs
    Object.assign(api, { uvGetOsfhandle: vi.fn(() => 107n), getFileType: vi.fn(() => 3) })
    const sandbox = new AclSandbox({ writableDirs: [], tempDir: null, mode: 'read-only' })
    await sandbox.init()
    const child = sandbox.spawn({ command: 'probe.exe', stdio: 'inherit', controlFileDescriptor: 7 })
    await expect(child.wait()).resolves.toEqual({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 42 })
    sandbox.dispose()
  })

  it('refuses to spawn before init', () => {
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-11', mode: 'workspace-write' })
    expect(() => sandbox.spawn({ command: 'probe.exe' })).toThrow(/not initialized/u)
  })

  it('pipe spawn drains empty pipes and settles with the child exit code', async () => {
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-12', mode: 'workspace-write' })
    await sandbox.init()
    const child = sandbox.spawn({ command: 'probe.exe', args: ['--flag'], cwd: workspace })
    expect(child.pid).toBe(1234)
    const expected = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 42 }
    await expect(child.wait()).resolves.toEqual(expected)
    // The second wait reuses the settled exit-code promise instead of re-waiting.
    await expect(child.wait()).resolves.toEqual(expected)
  })

  it('inherit spawn settles with empty stdio and closes the kill-on-close job', async () => {
    const { closeHandle } = state.stubs as HappyStubs
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-13', mode: 'workspace-write' })
    await sandbox.init()
    const child = sandbox.spawn({ command: 'probe.exe', stdio: 'inherit' })
    await expect(child.wait()).resolves.toEqual({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 42 })
    expect(closeHandle).toHaveBeenCalled()
  })

  it('inherit spawn reports a failed close of the kill-on-close job', async () => {
    const { closeHandle, createJobObjectW } = state.stubs as HappyStubs
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-14', mode: 'workspace-write' })
    await sandbox.init()
    let jobHandle = 0n
    closeHandle.mockImplementation((handle: NativePtr) => (handle === jobHandle ? 0 : 1))
    const child = sandbox.spawn({ command: 'probe.exe', stdio: 'inherit' })
    jobHandle = createJobObjectW.mock.results.at(-1)?.value as NativePtr
    await expect(child.wait()).rejects.toMatchObject({ api: 'CloseHandle' })
  })
})

describe('AclSandbox dispose', () => {
  it('is a no-op before init', () => {
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-15', mode: 'workspace-write' })
    expect(() => { sandbox.dispose() }).not.toThrow()
  })

  it('aggregates a failing temp revocation into an AggregateError', async () => {
    const { getNamedSecurityInfoW } = state.stubs as HappyStubs
    const workspace = scratch()
    const temp = scratch()
    const sandbox = new AclSandbox({
      writableDirs: [workspace],
      tempDir: temp,
      writeSid: 'S-1-4-9000-16',
      tempWriteSid: 'S-1-4-9000-16-1',
      mode: 'workspace-write',
    })
    await sandbox.init()
    getNamedSecurityInfoW.mockReturnValue(2)
    expect(() => { sandbox.dispose() }).toThrow(/1 cleanup failure/u)
  })

  it('aggregates SID and token cleanup failures into an AggregateError', async () => {
    const { localFree } = state.stubs as HappyStubs
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-17', mode: 'workspace-write' })
    await sandbox.init()
    localFree.mockReturnValue(1n)
    expect(() => { sandbox.dispose() }).toThrow(AggregateError)
  })

  it('reports a failed close of the restricted token', async () => {
    const { createRestrictedToken, closeHandle } = state.stubs as HappyStubs
    const workspace = scratch()
    const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: null, writeSid: 'S-1-4-9000-18', mode: 'workspace-write' })
    let restrictedToken = 0n
    createRestrictedToken.mockImplementation((
      _existing: unknown, _flags: unknown, _dc: unknown, _ds: unknown, _pc: unknown, _pd: unknown,
      _rc: unknown, _rs: unknown, slot: NativePtr,
    ) => {
      restrictedToken = 99n
      koffi.encode(slot, PVOID, restrictedToken)
      return 1
    })
    closeHandle.mockImplementation((handle: NativePtr) => (handle === restrictedToken ? 0 : 1))
    await sandbox.init()
    expect(() => { sandbox.dispose() }).toThrow(AggregateError)
  })
})

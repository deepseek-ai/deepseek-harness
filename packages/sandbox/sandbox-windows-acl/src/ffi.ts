/** ACL/token bindings layered on the shared Win32 process owner. */

import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import {
  ERROR_INSUFFICIENT_BUFFER,
  Win32Error,
  extendWin32ProcessBindings,
  isNullPtr,
  throwLastError,
} from '@deepseek-ai/dsh-win32-process'
import type { NativePtr, Win32ProcessBindings } from '@deepseek-ai/dsh-win32-process'
import * as abi from './win32-abi.ts'

export {
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodeUint32,
  isNullPtr,
  throwLastError,
  throwWin32,
} from '@deepseek-ai/dsh-win32-process'
export type { NativePtr } from '@deepseek-ai/dsh-win32-process'

type Koffi = typeof import('koffi')['default']
type Ptr = ReturnType<Koffi['pointer']>

const requireKoffi = createLazyRequire<Koffi>('koffi', import.meta.url)
let cachedTypes: { PVOID: Ptr; PPVOID: Ptr } | undefined

function ffiTypes(): { PVOID: Ptr; PPVOID: Ptr } {
  if (cachedTypes !== undefined) return cachedTypes
  const koffi = requireKoffi()
  const PVOID = koffi.pointer('void')
  return cachedTypes = { PVOID, PPVOID: koffi.pointer(PVOID) }
}

/** ACL/token calls composed with the generic Win32 process binding table. */
export interface Win32Bindings extends Win32ProcessBindings {
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number
  localAlloc(flags: number, bytes: number): NativePtr
  localFree(memory: NativePtr): NativePtr
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number
  isValidSid(sid: NativePtr): number
  getLengthSid(sid: NativePtr): number
  copySid(length: number, destination: NativePtr, source: NativePtr): number
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number
  createRestrictedToken(
    existing: NativePtr,
    flags: number,
    disableCount: number,
    disableSids: null,
    deletePrivilegeCount: number,
    privilegesToDelete: null,
    restrictCount: number,
    restrictingSids: Buffer,
    newToken: NativePtr,
  ): number
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number
  setNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: null,
    group: null,
    dacl: NativePtr | null,
    sacl: null,
  ): number
  getNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: NativePtr,
    group: NativePtr,
    dacl: NativePtr,
    sacl: NativePtr,
    descriptor: NativePtr,
  ): number
  getTempPathW(length: number, buffer: Buffer): number
  setEnvironmentVariableW(name: string, value: string): number
  setConsoleCtrlHandler(handler: null, add: number): number
  createFileW(
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    attributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ): NativePtr
  lockFileEx(
    file: NativePtr,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number
  unlockFileEx(
    file: NativePtr,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number
}

/**
 * Return whether CreateFileW produced INVALID_HANDLE_VALUE.
 * @param handle - handle returned by CreateFileW.
 * @returns true for null, zero, or the all-bits-one sentinel.
 */
export function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true
  return (handle as bigint) === 0xFFFFFFFFFFFFFFFFn || (handle as bigint) === -1n
}

/**
 * Encode a uint32 into an allocated slot.
 * @param slot - slot allocated by allocUint32.
 * @param value - unsigned value to store.
 */
export function encodeUint32(slot: NativePtr, value: number): void {
  requireKoffi().encode(slot, 'uint32', value)
}

/**
 * Return a Koffi pointer's numeric address for struct packing.
 * @param ptr - native pointer.
 * @returns pointer address.
 */
export function ptrAddress(ptr: NativePtr): bigint {
  return requireKoffi().address(ptr)
}

/**
 * Allocate a raw byte block.
 * @param length - byte count.
 * @returns allocated pointer.
 */
export function allocBytes(length: number): NativePtr {
  return requireKoffi().alloc('uint8', length) as NativePtr
}

/**
 * Allocate one zeroed x64 OVERLAPPED record.
 * @returns allocated pointer.
 * @remarks Koffi 3.1.1 crashes when LockFileEx or UnlockFileEx receives NULL;
 * a zeroed OVERLAPPED is equivalent for the synchronous lock-file handle.
 */
export function allocOverlapped(): NativePtr {
  return allocBytes(32)
}

/**
 * Decode a pointer value from a Buffer field.
 * @param buffer - encoded native record.
 * @param offset - pointer field byte offset.
 * @returns decoded pointer, or null for address zero.
 */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value = requireKoffi().decode(buffer, offset, ffiTypes().PVOID) as NativePtr | null
  return isNullPtr(value) ? null : value
}

/**
 * Decode a uint8 field at a native pointer offset.
 * @param ptr - native record pointer.
 * @param offset - field byte offset.
 * @returns decoded value.
 */
export function decodeUint8At(ptr: NativePtr, offset: number): number {
  return requireKoffi().decode(ptr, offset, 'uint8') as number
}

/**
 * Decode a uint16 field at a native pointer offset.
 * @param ptr - native record pointer.
 * @param offset - field byte offset.
 * @returns decoded value.
 */
export function decodeUint16At(ptr: NativePtr, offset: number): number {
  return requireKoffi().decode(ptr, offset, 'uint16') as number
}

/**
 * Decode a uint32 field at a native pointer offset.
 * @param ptr - native record pointer.
 * @param offset - field byte offset.
 * @returns decoded value.
 */
export function decodeUint32At(ptr: NativePtr, offset: number): number {
  return requireKoffi().decode(ptr, offset, 'uint32') as number
}

/**
 * Compare two in-memory SID records without allocating strings.
 * @param left - first native buffer.
 * @param leftOffset - first SID byte offset.
 * @param right - second native buffer.
 * @param rightOffset - second SID byte offset.
 * @returns true when revision, authority, and every sub-authority match.
 */
export function sameSidAt(
  left: NativePtr,
  leftOffset: number,
  right: NativePtr,
  rightOffset: number,
): boolean {
  if (decodeUint8At(left, leftOffset) !== decodeUint8At(right, rightOffset)) return false
  const leftCount = decodeUint8At(left, leftOffset + 1)
  const rightCount = decodeUint8At(right, rightOffset + 1)
  if (leftCount !== rightCount || leftCount > abi.SID_MAX_SUB_AUTHORITIES) return false
  for (let index = 0; index < 6; index += 1) {
    if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) {
      return false
    }
  }
  for (let index = 0; index < leftCount; index += 1) {
    if (decodeUint32At(left, leftOffset + 8 + index * 4) !==
      decodeUint32At(right, rightOffset + 8 + index * 4)) return false
  }
  return true
}

let cached: Win32Bindings | undefined

function bindings(): Win32Bindings {
  if (cached !== undefined) return cached
  const koffi = requireKoffi()
  const { PVOID, PPVOID } = ffiTypes()
  cached = extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({
    openProcess: bind(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID]),
    localAlloc: bind(kernel32, 'LocalAlloc', PVOID, ['uint32', 'size_t']),
    localFree: bind(kernel32, 'LocalFree', PVOID, [PVOID]),
    convertStringSidToSidW: bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID]),
    createWellKnownSid: bind(advapi32, 'CreateWellKnownSid', 'int', [
      'int', PVOID, PVOID, koffi.pointer('uint32'),
    ]),
    isValidSid: bind(advapi32, 'IsValidSid', 'int', [PVOID]),
    getLengthSid: bind(advapi32, 'GetLengthSid', 'uint32', [PVOID]),
    copySid: bind(advapi32, 'CopySid', 'int', ['uint32', PVOID, PVOID]),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [
      PVOID, 'int', PVOID, 'uint32', koffi.pointer('uint32'),
    ]),
    setTokenInformation: bind(advapi32, 'SetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32']),
    createRestrictedToken: bind(advapi32, 'CreateRestrictedToken', 'int', [
      PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID, 'uint32', PVOID, PPVOID,
    ]),
    setEntriesInAclW: bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID]),
    setNamedSecurityInfoW: bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', [
      'str16', 'int', 'uint32', PVOID, PVOID, PVOID, PVOID,
    ]),
    getNamedSecurityInfoW: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', [
      'str16', 'int', 'uint32', PPVOID, PPVOID, PPVOID, PPVOID, PPVOID,
    ]),
    getTempPathW: bind(kernel32, 'GetTempPathW', 'uint32', ['uint32', PVOID]),
    setEnvironmentVariableW: bind(kernel32, 'SetEnvironmentVariableW', 'int', ['str16', 'str16']),
    setConsoleCtrlHandler: bind(kernel32, 'SetConsoleCtrlHandler', 'int', [PVOID, 'int']),
    createFileW: bind(kernel32, 'CreateFileW', PVOID, [
      'str16', 'uint32', 'uint32', PVOID, 'uint32', 'uint32', PVOID,
    ]),
    lockFileEx: bind(kernel32, 'LockFileEx', 'int', [
      PVOID, 'uint32', 'uint32', 'uint32', 'uint32', PVOID,
    ]),
    unlockFileEx: bind(kernel32, 'UnlockFileEx', 'int', [
      PVOID, 'uint32', 'uint32', 'uint32', PVOID,
    ]),
  })) as unknown as Win32Bindings
  return cached
}

/**
 * Resolve the cached ACL/token binding table asynchronously.
 * @returns generic process plus ACL/token bindings.
 */
export function win32(): Promise<Win32Bindings> {
  return Promise.resolve(bindings())
}

/**
 * Resolve the cached ACL/token binding table synchronously.
 * @returns generic process plus ACL/token bindings.
 */
export function win32Sync(): Win32Bindings {
  return bindings()
}

/**
 * Resolve the current Windows temporary directory.
 * @param api - active ACL/token binding table.
 * @returns UTF-16 path reported by GetTempPathW.
 */
export function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((abi.MAX_PATH + 1) * 2)
  const length = api.getTempPathW(buffer.length / 2, buffer)
  if (length === 0) throwLastError(api, 'GetTempPathW')
  if (length > buffer.length / 2) {
    throw new Win32Error(
      'GetTempPathW',
      ERROR_INSUFFICIENT_BUFFER,
      `required ${length} chars exceed the ${buffer.length / 2}-char buffer; nothing was written`,
    )
  }
  return buffer.subarray(0, length * 2).toString('utf16le')
}

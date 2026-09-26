/**
 * Restricted-token construction: open the current process token, extract its
 * logon SID, build the well-known SIDs, and call CreateRestrictedToken with
 * the POC's restricting-SID allowlist. Every API call is checked; any failure
 * throws with the API name and the exact Win32 code — the original POC ignored
 * all of these and silently ran children with the FULL, unrestricted token.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/token
 */

import { allocBytes, allocPtrSlot, allocUint32, decodePtr, decodePtrAt, decodeUint32, encodeUint32, isNullPtr, ptrAddress, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { buildExplicitAccess } from './acl.ts'
import * as abi from './win32-abi.ts'

/**
 * Open the current process's access token with the rights
 * CreateRestrictedToken requires (the POC's OpenProcessToken call; the token
 * handle is obtained through a real OpenProcess handle because the
 * GetCurrentProcess() pseudo-handle is not addressable through koffi).
 * @param api - the binding table.
 * @returns the opened token handle.
 */
export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`)

  const tokenSlot = allocPtrSlot()
  const opened = api.openProcessToken(
    processHandle,
    abi.TOKEN_QUERY | abi.TOKEN_DUPLICATE | abi.TOKEN_ADJUST_DEFAULT | abi.TOKEN_ASSIGN_PRIMARY,
    tokenSlot,
  )
  if (opened === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(processHandle) // best-effort on the error path
    throwWin32(api, 'OpenProcessToken', win32Code, `pid ${process.pid}`)
  }
  if (api.closeHandle(processHandle) === 0) throwLastError(api, 'CloseHandle', 'OpenProcess process handle')
  const token = decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'OpenProcessToken', api.getLastError(), 'null token handle')
  return token
}

/**
 * Find and copy the token's logon session SID (S-1-5-5-x-y, attribute
 * SE_GROUP_LOGON_ID). The restricted token needs it for WinSta0/desktop and
 * other per-logon objects; the POC extracts it the same way.
 * @param api - the binding table.
 * @param token - the token whose groups are scanned.
 * @returns a copied logon SID (thrown when the token carries none).
 */
export function findLogonSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32()
  api.getTokenInformation(token, abi.TokenGroups, null, 0, neededSlot) // expected to fail with ERROR_INSUFFICIENT_BUFFER
  const needed = decodeUint32(neededSlot)
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenGroups size query')
  if (needed < abi.TOKEN_GROUPS_OFFSET) throwWin32(api, 'GetTokenInformation', api.getLastError(), `implausible TokenGroups size ${needed}`)

  const groups = Buffer.alloc(needed)
  if (api.getTokenInformation(token, abi.TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenGroups')
  }
  const groupCount = groups.readUInt32LE(0)
  for (let index = 0; index < groupCount; index++) {
    const sidPtr = decodePtrAt(groups, abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE)
    const attributes = groups.readUInt32LE(abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE + 8)
    // >>> 0: JS bitwise & is signed 32-bit; SE_GROUP_LOGON_ID has bit 31 set.
    const isLogonId = ((attributes & abi.SE_GROUP_LOGON_ID) >>> 0) === (abi.SE_GROUP_LOGON_ID >>> 0)
    if (sidPtr === null || !isLogonId) continue
    const sidLength = api.getLengthSid(sidPtr)
    if (sidLength === 0) throwLastError(api, 'GetLengthSid', `logon SID group ${index}`)
    const copy = allocBytes(sidLength)
    if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, 'CopySid', `logon SID group ${index}`)
    return copy
  }
  throw new Error(`CreateRestrictedToken prerequisite failed: no logon SID found among ${groupCount} token groups`)
}

/**
 * Create one well-known SID (68-byte buffer) and assert its validity.
 * @param api - the binding table.
 * @param type - the WELL_KNOWN_SID_TYPE to create.
 * @returns the created SID pointer.
 */
export function makeWellKnownSid(api: Win32Bindings, type: number): NativePtr {
  const sid = allocBytes(abi.SECURITY_MAX_SID_SIZE)
  const sizeSlot = allocUint32()
  encodeUint32(sizeSlot, abi.SECURITY_MAX_SID_SIZE)
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0) {
    throwLastError(api, 'CreateWellKnownSid', `type ${type}`)
  }
  if (api.isValidSid(sid) === 0) throwLastError(api, 'IsValidSid', `CreateWellKnownSid type ${type}`)
  return sid
}

/**
 * Merge one full-access allow ACE for `sidPtr` into the token's DEFAULT DACL
 * — the DACL every NEW object the token holder creates (without an explicit
 * security descriptor) takes. The restricted token inherits the user's
 * default DACL verbatim, which names no restricting SID: a new anonymous pipe
 * (child stdio) therefore fails the write pass-2 check at creation
 * (ERROR_ACCESS_DENIED; Node surfaces it as spawn EPERM), breaking every
 * piped-stdio grandchild spawn. The merged ACE names a RESTRICTING SID (the
 * write SID under workspace-write, Everyone under read-only), so each new
 * object's own DACL passes pass-2 while object creation itself stays gated by
 * the parent container's DACL (files outside the granted trees remain
 * uncreatable). Fails closed: any Win32 failure throws before the spawn.
 * @param api - the binding table.
 * @param token - the restricted token to adjust (requires TOKEN_ADJUST_DEFAULT).
 * @param sidPtr - the restricting SID whose full-access ACE joins the default DACL.
 */
export function setTokenDefaultDaclGrant(api: Win32Bindings, token: NativePtr, sidPtr: NativePtr): void {
  const neededSlot = allocUint32()
  api.getTokenInformation(token, abi.TokenDefaultDacl, null, 0, neededSlot) // expected to fail with ERROR_INSUFFICIENT_BUFFER
  const needed = decodeUint32(neededSlot)
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl size query')
  const buffer = Buffer.alloc(needed)
  if (api.getTokenInformation(token, abi.TokenDefaultDacl, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl')
  }
  const currentDacl = decodePtrAt(buffer, 0)
  if (currentDacl === null) {
    throw new Error('setTokenDefaultDaclGrant: the token carries no default DACL to extend')
  }
  const newDaclSlot = allocPtrSlot()
  const result = api.setEntriesInAclW(
    1,
    buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.FILE_ALL_ACCESS),
    currentDacl,
    newDaclSlot,
  )
  if (result !== abi.ERROR_SUCCESS) throwWin32(api, 'SetEntriesInAclW', result, 'default DACL merge')
  const newDacl = decodePtr(newDaclSlot)
  if (newDacl === null) throwWin32(api, 'SetEntriesInAclW', result, 'null merged default DACL')
  // TOKEN_DEFAULT_DACL { PACL DefaultDacl; } — the struct is exactly the
  // pointer; SetTokenInformation copies the ACL before returning.
  const info = Buffer.alloc(8)
  info.writeBigUInt64LE(newDacl, 0)
  if (api.setTokenInformation(token, abi.TokenDefaultDacl, info, info.length) === 0) {
    const win32Code = api.getLastError()
    api.localFree(newDacl)
    throwWin32(api, 'SetTokenInformation', win32Code, 'TokenDefaultDacl')
  }
  api.localFree(newDacl)
}

/**
 * Lower the restricted token's integrity level to Low (S-1-16-4096), the level
 * the mandatory labels `grantWrite` applies are matched against; a token left
 * at Medium would ignore them. Requires TOKEN_ADJUST_DEFAULT on the token;
 * fails closed before any child is spawned.
 * @param api - the binding table.
 * @param token - the restricted token to lower.
 * @param lowLabelSidPtr - the Low integrity SID (S-1-16-4096).
 */
export function restrictTokenIntegrity(api: Win32Bindings, token: NativePtr, lowLabelSidPtr: NativePtr): void {
  const sidLength = api.getLengthSid(lowLabelSidPtr)
  if (sidLength === 0) throwLastError(api, 'GetLengthSid', 'Low integrity label SID')
  const info = Buffer.alloc(abi.TOKEN_MANDATORY_LABEL_SIZE + sidLength)
  info.writeBigUInt64LE(ptrAddress(lowLabelSidPtr), 0) // Label.Sid
  info.writeUInt32LE(abi.SE_GROUP_INTEGRITY, 8) // Label.Attributes
  if (api.setTokenInformation(token, abi.TokenIntegrityLevel, info, info.length) === 0) {
    throwLastError(api, 'SetTokenInformation', 'TokenIntegrityLevel (Low)')
  }
}

/** Pack `SID_AND_ATTRIBUTES[count]` (16-byte stride; Attributes stay 0). */
function buildRestrictingSids(sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(abi.SID_AND_ATTRIBUTES_SIZE * sids.length)
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(ptrAddress(sid), abi.SID_AND_ATTRIBUTES_SIZE * index)
  })
  return buffer
}

/** The well-known SID packed into every restricted token's restricting list. */
export interface RestrictingSidSet {
  world: NativePtr
}

/**
 * Create the write-restricted token with the mode-selected restricting list
 * (verified on Win11 26200, see the POC-worktree restrict-variant harness):
 *  - read-only:       [logon SID, EVERYONE]
 *  - workspace-write: [logon SID, EVERYONE, workspace SID, optional temp SID]
 *
 * The logon SID + EVERYONE keep-alive group is shared by both modes: early
 * DLL init dies with 0xC0000142 and CNG (`\Device\CNG` write trustee —
 * pwsh crashes 0xE0434352) fails without them. The write SIDs join ONLY
 * workspace-write — read-only carries no write SID, so a standing grant ACE
 * from an earlier workspace-write period (a `/permission` mode downgrade, or
 * a crash-resumed session) stays INERT under read-only: the WRITE_RESTRICTED
 * pass-2 check grants only what the restricting list carries, keeping that
 * workspace grant inert under read-only while the unrevoked ACE keeps the
 * re-upgrade free (the grant's exact-ACE skip — no re-propagation).
 * Everyone's own ambient grants remain the documented partial boundary.
 * Authenticated Users is absent from BOTH lists: the WMI
 * namespace security check fails (0x80041003), so CIM is unavailable in
 * every confined mode, and the C:\-root tree-creation escape (standing
 * `AU:(AD)` + `AU:(OI)(CI)(IO)(M)` ACEs) is closed in both — documented in
 * README. INTERACTIVE/LOCAL are absent from BOTH lists too — the host's
 * Public tree grants write to INTERACTIVE, so removing it closes that
 * escape. S-1-2-1 (console logon) is intentionally absent: the package
 * README's "Console isolation is unavailable" entry records the verified
 * failure modes. FAILS CLOSED: any failure throws — never
 * spawn unrestricted.
 * @param api - the binding table.
 * @param currentToken - the process token to restrict.
 * @param logonSid - the copied logon session SID.
 * @param writeSids - the distinct write SIDs forming the workspace and
 * optional temp allowlists (workspace-write only; empty under read-only).
 * @param known - the well-known SIDs entering the restricting list.
 * @param mode - selects the restricting list (workspace-write adds the capability SIDs).
 * @returns the restricted token handle.
 */
export function createRestrictedToken(
  api: Win32Bindings,
  currentToken: NativePtr,
  logonSid: NativePtr,
  writeSids: readonly NativePtr[],
  known: RestrictingSidSet,
  mode: 'read-only' | 'workspace-write',
): NativePtr {
  const restrictingSids = buildRestrictingSids(mode === 'read-only'
    ? [logonSid, known.world]
    : writeSids.length === 0
      ? (() => { throw new Error('createRestrictedToken: workspace-write restricting list requires at least one write SID') })()
      : [logonSid, known.world, ...writeSids])
  const tokenSlot = allocPtrSlot()
  const created = api.createRestrictedToken(
    currentToken,
    abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED,
    0, null, // no SIDs disabled
    0, null, // no privileges deleted
    restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE,
    restrictingSids,
    tokenSlot,
  )
  if (created === 0) throwLastError(api, 'CreateRestrictedToken', `restricting SIDs: ${restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE}`)
  const token = decodePtr(tokenSlot)
  if (token === null) throwWin32(api, 'CreateRestrictedToken', api.getLastError(), 'null token handle')
  return token
}

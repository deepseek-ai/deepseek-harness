/**
 * ACL editing helpers: grant/revoke a capability SID on a directory via
 * SetEntriesInAclW + SetNamedSecurityInfoW (the same calls the POC uses, with
 * the failure handling the POC lacks). Every API call is checked and every
 * failure is reported with the API name, the exact Win32 code, the formatted
 * system text, and the affected path.
 *
 * Each grant applies three edits in ONE SetNamedSecurityInfoW call: the
 * capability-SID allow ACE, a Deny ACE that removes the ambient
 * `FILE_DELETE_CHILD` right from the world SID, and a Low no-write-up
 * mandatory label ({@link buildLowLabelAcl}). The deny is what keeps one
 * granted root out of another's reach: Windows also authorizes a delete from
 * the parent directory's `FILE_DELETE_CHILD` right, which the token's
 * write-restricted intersection does not reach, and every granted root carries
 * the Low label that clears the integrity check.
 *
 * Concurrency: grants are read-merge-write against the directory's CURRENT
 * DACL, and the whole get-merge-set sequence runs under a per-path exclusive
 * LockFileEx lock (see {@link withPathLock}) so concurrent sandbox instances
 * cannot clobber each other's ACEs.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/acl
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { allocOverlapped, allocPtrSlot, decodePtr, decodeUint8At, decodeUint16At, decodeUint32At, getTempPath, isInvalidHandle, isNullPtr, ptrAddress, sameSidAt, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Pack one EXPLICIT_ACCESS_W (48 bytes, layout verified by abi-probe.cpp):
 * perms@0, mode@4, inheritance@8, Trustee@16 { pMultipleTrustee@16,
 * MultipleTrusteeOperation@24, TrusteeForm@28, TrusteeType@32, ptstrName@40 }.
 * `permissions` is the access mask; the POC passes 0 for REVOKE_ACCESS, which
 * removes every ACE for the trustee. `inheritance` defaults to children of
 * both kinds; the ambient-delete deny narrows it to containers because
 * FILE_DELETE_CHILD is meaningless on a file and its bit would otherwise
 * spread through the file's inherited mask.
 * @param sidPtr - the trustee SID the entry names.
 * @param mode - the access mode (GRANT_ACCESS, DENY_ACCESS, or REVOKE_ACCESS).
 * @param permissions - the access mask to grant or deny (0 for REVOKE_ACCESS).
 * @param inheritance - the ACE inheritance flags.
 * @returns the packed entry buffer.
 */
export function buildExplicitAccess(
  sidPtr: NativePtr,
  mode: number,
  permissions: number,
  inheritance: number = abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(inheritance, 8) // grfInheritance
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24) // Trustee.MultipleTrusteeOperation
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28) // Trustee.TrusteeForm
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32) // Trustee.TrusteeType
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40) // Trustee.ptstrName = the capability SID
  return entry
}

/**
 * One lock file per protected path: `<GetTempPathW()>\dsh-acl-locks\<first 16
 * hex of sha256(lowercased path)>.lock`. The lock root derives from
 * GetTempPathW (never from runner argv or DSH_HOME), and the lowercasing
 * maps Windows's case-insensitive path spellings onto one lock.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @returns the lock file path for that directory.
 */
export function lockFilePath(api: Win32Bindings, path: string): string {
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)
  return join(getTempPath(api), 'dsh-acl-locks', `${digest}.lock`)
}

/**
 * Run `action` holding the per-path exclusive lock: CreateFileW
 * (OPEN_ALWAYS, shared read/write but NOT delete — a deletable lock file
 * could be removed and recreated under the holder, letting two processes
 * hold "the same" lock), then a one-byte LockFileEx
 * (LOCKFILE_EXCLUSIVE_LOCK, zeroed OVERLAPPED = lock from offset 0 on the
 * synchronous handle — see allocOverlapped for why not NULL), then
 * UnlockFileEx + CloseHandle. Fail-closed: open/lock/unlock/close failures
 * throw like every other Win32 call in this package; an `action` failure
 * still unlocks (best-effort) and rethrows the original error.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @param action - the get-merge-set sequence to serialize.
 * @returns the action's result.
 */
export function withPathLock<T>(api: Win32Bindings, path: string, action: () => T): T {
  const lockPath = lockFilePath(api, path)
  mkdirSync(dirname(lockPath), { recursive: true })
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
    null, abi.OPEN_ALWAYS, 0, null,
  )
  if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', lockPath)
  const overlapped = allocOverlapped() // stays zeroed: offset 0, hEvent NULL
  if (api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the lock-failure path
    throwWin32(api, 'LockFileEx', win32Code, lockPath)
  }

  let result: T
  try {
    result = action()
  } catch (error) {
    // Best-effort release on the action-failure path: cleanup failures must
    // not mask the action's error.
    api.unlockFileEx(handle, 0, 1, 0, overlapped)
    api.closeHandle(handle)
    throw error
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the unlock-failure path
    throwWin32(api, 'UnlockFileEx', win32Code, lockPath)
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', `lock file ${lockPath}`)
  return result
}

/**
 * Read the directory's current explicit DACL and mandatory label via
 * GetNamedSecurityInfoW.
 * Allocation contract (the POC's RevokeAccess, minus its missing checks): the
 * returned ACL pointer sits INSIDE the security descriptor allocation — only
 * the descriptor may be LocalFree'd, and it must not be freed before
 * SetEntriesInAclW has consumed the ACL. Freeing the ACL pointer itself
 * corrupts the heap (verified the hard way).
 * @param api - the binding table.
 * @param path - the directory whose DACL and label are read.
 * @returns the current explicit DACL and label ACL (null when the directory carries none) plus their owning descriptor.
 */
function readCurrentSecurity(
  api: Win32Bindings,
  path: string,
): { oldAcl: NativePtr | null; labelAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', readResult, path)
  return { oldAcl: decodePtr(daclSlot), labelAcl: decodePtr(saclSlot), descriptor: decodePtr(descriptorSlot) }
}

/**
 * Build the Low mandatory label applied with every write grant: one
 * SYSTEM_MANDATORY_LABEL_ACE naming `lowLabelSidPtr` with the no-write-up
 * policy, inheriting to subcontainers and objects so later children carry the
 * same label. The caller frees the returned ACL with LocalFree
 * (SetNamedSecurityInfoW copies it); every Win32 call is checked and a
 * half-built ACL is released before the error is thrown.
 * @param api - the binding table.
 * @param lowLabelSidPtr - the Low integrity SID (S-1-16-4096) the label names.
 * @returns the ACL carrying the single inheritable label ACE.
 */
export function buildLowLabelAcl(api: Win32Bindings, lowLabelSidPtr: NativePtr): NativePtr {
  const sidLength = api.getLengthSid(lowLabelSidPtr)
  if (sidLength === 0) throwLastError(api, 'GetLengthSid', 'Low mandatory label SID')
  const aclLength = abi.ACL_HEADER_SIZE + abi.MANDATORY_ACE_OVERHEAD + sidLength
  const acl = api.localAlloc(abi.LPTR, aclLength)
  if (isNullPtr(acl)) throwLastError(api, 'LocalAlloc', 'Low mandatory label ACL')
  if (api.initializeAcl(acl, aclLength, abi.ACL_REVISION) === 0) {
    const win32Code = api.getLastError()
    api.localFree(acl) // best-effort on the error path
    throwWin32(api, 'InitializeAcl', win32Code, 'Low mandatory label ACL')
  }
  if (api.addMandatoryAce(
    acl, abi.ACL_REVISION, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowLabelSidPtr,
  ) === 0) {
    const win32Code = api.getLastError()
    api.localFree(acl) // best-effort on the error path
    throwWin32(api, 'AddMandatoryAce', win32Code, 'Low mandatory label ACL')
  }
  return acl
}

/**
 * True when the label ACL already carries the EXACT label this module would
 * add (mandatory-label ACE, OI|CI inheritance, no-write-up policy, the Low
 * SID), so a re-grant can skip the eager full-tree propagation.
 * @param labelAcl - the current label ACL pointer (from {@link readCurrentSecurity}).
 * @param lowLabelSidPtr - the Low integrity SID to match.
 * @returns whether the exact label ACE is already present.
 */
function hasExactLabel(labelAcl: NativePtr, lowLabelSidPtr: NativePtr): boolean {
  return hasExactEntry(
    labelAcl, abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowLabelSidPtr,
  )
}

/**
 * The mandatory-label half of an apply: set the given label ACL, clear the
 * label, or leave it untouched. `clear` is what a revoke does when the
 * directory carries no other capability grant; `keep` is what it does while
 * another grant still relies on the shared Low level.
 */
type LabelEdit = { kind: 'apply'; acl: NativePtr } | { kind: 'clear' } | { kind: 'keep' }

/**
 * Shared tail of grantWrite and revokeWrite: merge `entries` into `oldAcl`
 * (null = no explicit DACL yet; SetEntriesInAclW builds one from scratch),
 * free the descriptor before applying the merged ACL, apply the merged DACL
 * together with the label edit in one SetNamedSecurityInfoW call, then free
 * every ACL this call owns — checking each call and reporting with the
 * caller's label. The entry count derives from the buffer, so a grant can
 * carry its capability ACE and its ambient-delete deny in one merge.
 * @param api - the binding table.
 * @param path - the directory the DACL and label edits apply to.
 * @param entries - packed EXPLICIT_ACCESS_W records to merge (grant, deny, or revoke).
 * @param oldAcl - the current explicit DACL (from {@link readCurrentSecurity}).
 * @param labelEdit - the label change to apply alongside the DACL.
 * @param descriptor - the descriptor allocation owning `oldAcl`.
 * @param label - the caller's name for error details.
 */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entries: Buffer,
  oldAcl: NativePtr | null,
  labelEdit: LabelEdit,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot()
  const mergeResult = api.setEntriesInAclW(entries.length / abi.EXPLICIT_ACCESS_W_SIZE, entries, oldAcl, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor) // frees the ACL block too
    if (labelEdit.kind === 'apply') api.localFree(labelEdit.acl)
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`)
  }
  const newAcl = decodePtr(newAclSlot)
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor)
    if (labelEdit.kind === 'apply') api.localFree(labelEdit.acl)
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${path}): null new ACL`)
  }

  // The descriptor block (oldAcl included) is dead after the merge — free it
  // before applying, exactly like the POC.
  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null
  const applyResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT,
    labelEdit.kind === 'keep' ? abi.DACL_SECURITY_INFORMATION : abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION,
    null, null, newAcl, labelEdit.kind === 'apply' ? labelEdit.acl : null,
  )
  const freedNew = api.localFree(newAcl)
  const freedLabel = labelEdit.kind === 'apply' ? api.localFree(labelEdit.acl) : null
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`)
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`)
  if (!isNullPtr(freedNew)) throwLastError(api, 'LocalFree', `${label}(${path}) new ACL`)
  if (freedLabel !== null && !isNullPtr(freedLabel)) throwLastError(api, 'LocalFree', `${label}(${path}) label ACL`)
}

/**
 * True when the explicit DACL already carries the EXACT entry
 * `(aceType, inheritance, mask, trustee SID)`. Every field is read through
 * koffi.decode at pointer offsets — no memcpy, no pointer arithmetic. The
 * ACE's SID is INLINE (embedded in the ACE after the 4-byte mask — there is
 * no pointer to read; reading one yields garbage addresses and crashed
 * EqualSid, verified by gdb), so it is compared field-by-field against the
 * trustee SID through bounded offset reads ({@link sameSidAt}). Allowed and
 * denied ACEs share the Mask@4/SID@8 layout. A malformed header reads as "no
 * exact entry" so the caller falls back to the merge-apply path, which owns
 * the robust failure handling.
 * @param acl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param aceType - the ACE type to match.
 * @param inheritance - the ACE inheritance flags to match.
 * @param mask - the access mask to match.
 * @param sidPtr - the trustee SID to match.
 * @returns whether the exact entry is already present.
 */
function hasExactEntry(acl: NativePtr, aceType: number, inheritance: number, mask: number, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(acl, 2)
  const aceCount = decodeUint16At(acl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false // implausible: fall back to the merge path
  let offset = 8 // the first ACE follows the 8-byte ACL header
  for (let index = 0; index < aceCount; index++) {
    // ACE_HEADER: AceType@0, AceFlags@1, AceSize@2 (WORD); Mask@4, inline SID@8.
    const aceSize = decodeUint16At(acl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false // implausible: fall back to the merge path
    const exact = decodeUint8At(acl, offset) === aceType
      && decodeUint8At(acl, offset + 1) === inheritance
      && decodeUint32At(acl, offset + 4) === mask
    if (exact && sameSidAt(acl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/**
 * True when the explicit DACL already carries the EXACT write grant this
 * module would add: the Allow ACE for {@link abi.GRANT_MASK} naming the
 * capability SID.
 * @param oldAcl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param sidPtr - the capability SID to match.
 * @returns whether the exact grant ACE is already present.
 */
function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  return hasExactEntry(oldAcl, abi.ACCESS_ALLOWED_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.GRANT_MASK, sidPtr)
}

/**
 * True when the explicit DACL already carries the EXACT ambient-delete deny:
 * the container-inherited Deny ACE for {@link abi.FILE_DELETE_CHILD} naming
 * the world SID. It is part of the idempotent skip, so a root granted by an
 * earlier build receives the deny on its next provision.
 * @param oldAcl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param worldSidPtr - the Everyone SID the deny names.
 * @returns whether the exact deny ACE is already present.
 */
function hasExactDeny(oldAcl: NativePtr, worldSidPtr: NativePtr): boolean {
  return hasExactEntry(oldAcl, abi.ACCESS_DENIED_ACE_TYPE, abi.CONTAINER_INHERIT_ACE, abi.FILE_DELETE_CHILD, worldSidPtr)
}

/**
 * True when a capability grant for a SID OTHER than `sidPtr` stands on this
 * DACL — the condition under which a revoke must leave the shared Low label in
 * place, or the remaining grant's child would lose its write authority.
 * @param oldAcl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param sidPtr - the capability SID being revoked.
 * @returns whether another capability grant remains.
 */
function hasForeignGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(oldAcl, 2)
  const aceCount = decodeUint16At(oldAcl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false // implausible: leave the label alone
  let offset = 8
  for (let index = 0; index < aceCount; index++) {
    const aceSize = decodeUint16At(oldAcl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false // implausible: leave the label alone
    const isGrant = decodeUint8At(oldAcl, offset) === abi.ACCESS_ALLOWED_ACE_TYPE
      && decodeUint32At(oldAcl, offset + 4) === abi.GRANT_MASK
    if (isGrant && !sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/**
 * Grant `GRANT_MASK` (Write+Delete, displays as "Modify") to the capability SID
 * on `path`, deny the world SID the ambient `FILE_DELETE_CHILD` right, and
 * apply the Low mandatory label — one merge. The deny inherits to containers
 * only: the right is evaluated on directories, and inheriting its bit onto
 * files would deny every `FILE_ALL_ACCESS`/`GENERIC_ALL` open inside the root
 * (0x40 is a member of that mask). The capability ACE's DELETE bit is then the
 * only delete authority inside the root, so a file whose own DACL grants no
 * DELETE is no longer deletable through its parent's rights.
 *
 * Idempotent: the exact ACE, deny, and label together SKIP the
 * SetNamedSecurityInfoW apply, which would otherwise re-propagate the
 * identical descriptor across the whole tree (eager inheritance; minutes on
 * large workspaces). Otherwise read-merge-write, so pre-existing explicit ACEs
 * survive (same shape as {@link revokeWrite}). Runs under the per-path lock.
 * The directory must be owned by the caller AND grant WRITE_OWNER (the label
 * lives in the SACL; owner-implicit rights cover only READ_CONTROL and
 * WRITE_DAC) — a Full-control workspace satisfies both.
 * @param api - the binding table.
 * @param path - the directory whose DACL and label gain the grant (the workspace or temp root).
 * @param sidPtr - the capability SID the ACE names.
 * @param lowLabelSidPtr - the Low integrity SID the mandatory label names.
 * @param worldSidPtr - the Everyone SID the ambient-delete deny names.
 */
export function grantWrite(
  api: Win32Bindings,
  path: string,
  sidPtr: NativePtr,
  lowLabelSidPtr: NativePtr,
  worldSidPtr: NativePtr,
): void {
  withPathLock(api, path, () => {
    const { oldAcl, labelAcl, descriptor } = readCurrentSecurity(api, path)
    if (oldAcl !== null && labelAcl !== null
      && hasExactGrant(oldAcl, sidPtr) && hasExactDeny(oldAcl, worldSidPtr)
      && hasExactLabel(labelAcl, lowLabelSidPtr)) {
      // The exact ACE, deny, and label stand: releasing the descriptor is the whole operation.
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `grantWrite(${path}) descriptor`)
      }
      return
    }
    let label: NativePtr
    try {
      label = buildLowLabelAcl(api, lowLabelSidPtr)
    } catch (error) {
      // The read already owns a descriptor allocation; release it before the
      // label failure propagates.
      if (descriptor !== null) api.localFree(descriptor)
      throw error
    }
    mergeAndApply(
      api, path,
      Buffer.concat([
        buildExplicitAccess(worldSidPtr, abi.DENY_ACCESS, abi.FILE_DELETE_CHILD, abi.CONTAINER_INHERIT_ACE),
        buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK),
      ]),
      oldAcl, { kind: 'apply', acl: label }, descriptor, 'grantWrite',
    )
  })
}

/**
 * Remove every ACE for the capability SID from the directory DACL (REVOKE_ACCESS
 * merge — other entries are preserved). The shared Low label is cleared only
 * when no other capability grant remains on the directory: two grants may
 * target one directory, and the surviving one still needs the label for its
 * child's writes. Returns whether an ACE removal was attempted (false when the
 * directory carries no DACL at all).
 *
 * Runs under the per-path lock (the whole get-merge-set sequence); the
 * descriptor/ACL allocation contract lives on {@link readCurrentSecurity}.
 * @param api - the binding table.
 * @param path - the directory whose DACL loses the capability-SID ACEs.
 * @param sidPtr - the capability SID whose ACEs are removed.
 * @returns whether an ACE removal was attempted (false when the directory carries no DACL at all).
 */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentSecurity(api, path)
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`)
      }
      return false
    }
    mergeAndApply(
      api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl,
      hasForeignGrant(oldAcl, sidPtr) ? { kind: 'keep' } : { kind: 'clear' },
      descriptor, 'revokeWrite',
    )
    return true
  })
}

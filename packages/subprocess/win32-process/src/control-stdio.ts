/** Windows CRT startup descriptors for a Node payload with one inherited control pipe. */

import type { NativePtr, Win32ProcessBindings } from './ffi.ts'

/** Native stdio handles plus the single additional descriptor selected by the launcher. */
export interface InheritedControlStdio {
  stdin: NativePtr
  stdout: NativePtr
  stderr: NativePtr
  control: { fileDescriptor: 7; handle: NativePtr }
}

const HANDLE_BYTES = 8
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn
const FOPEN = 0x01
const FPIPE = 0x08
const FDEV = 0x40
const FILE_TYPE_CHAR = 2
const FILE_TYPE_PIPE = 3

/**
 * Encode the CRT's descriptor table before the child runtime allocates descriptors.
 * Supported Windows targets use 64-bit handles. Empty slots remain closed, and the
 * backing Buffer must remain alive until CreateProcess returns.
 * @param api - native file-type inspection for inherited handles.
 * @param stdio - standard handles and the provider-owned fd-7 control pipe.
 * @returns descriptor count, flag bytes, and handle values for STARTUPINFO's reserved CRT fields.
 */
export function inheritedControlStdio(api: Pick<Win32ProcessBindings, 'getFileType'>, stdio: InheritedControlStdio): Buffer {
  const count = stdio.control.fileDescriptor + 1
  const handleOffset = 4 + count
  const bytes = Buffer.alloc(handleOffset + count * HANDLE_BYTES)
  bytes.writeUInt32LE(count, 0)
  for (let index = 0; index < count; index++) {
    bytes.writeBigUInt64LE(INVALID_HANDLE, handleOffset + index * HANDLE_BYTES)
  }
  const entries = [[0, stdio.stdin], [1, stdio.stdout], [2, stdio.stderr], [stdio.control.fileDescriptor, stdio.control.handle]] as const
  for (const [fd, handle] of entries) {
    const kind = api.getFileType(handle)
    if (fd === stdio.control.fileDescriptor && kind !== FILE_TYPE_PIPE) {
      throw new Error('subprocess control descriptor is not a Windows pipe')
    }
    bytes[4 + fd] = FOPEN | (kind === FILE_TYPE_PIPE ? FPIPE : kind === FILE_TYPE_CHAR ? FDEV : 0)
    bytes.writeBigUInt64LE(handle, handleOffset + fd * HANDLE_BYTES)
  }
  return bytes
}

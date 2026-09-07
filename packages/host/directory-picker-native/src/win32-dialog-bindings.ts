/**
 * koffi-backed Win32 bindings for the folder dialog: the COM vtable calls
 * behind {@link Win32DialogBindings} plus the cross-thread window closer the
 * driver uses to service aborts. The module loads on every platform; koffi
 * itself is imported lazily inside each function, so non-Windows processes
 * never load it — the same containment as the repo's other `win32.ts`
 * modules.
 *
 * The COM surface used here (IModalWindow/IFileDialog/IFileOpenDialog and
 * IShellItem vtable order, the GUIDs, `FOS_*` and `SIGDN_FILESYSPATH`) is
 * frozen Windows ABI since Vista; slots are offsets into the vtable at the
 * object's first pointer.
 */

import type { Win32DialogBindings, Win32FolderDialog } from './win32-dialog-logic.ts'

interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary { func(convention: string, name: string, result: string, args: string[]): KoffiFunction }
interface Koffi {
  load(path: string): KoffiLibrary
  proto(declaration: string): unknown
  pointer(type: unknown): unknown
  call(pointer: unknown, proto: unknown, ...args: unknown[]): unknown
  decode(value: unknown, offsetOrType: unknown, type?: unknown): unknown
  register(fn: (...args: unknown[]) => unknown, type: unknown): unknown
  unregister(callback: unknown): void
  sizeof(type: string): number
}

/**
 * Read a valid NUL-terminated UTF-16 allocation without an external buffer.
 * Generic `koffi.decode(..., 'str16')` expects a pointer variable, so the
 * buffer holds the string address rather than the string bytes.
 * @param koffi - the loaded koffi binding.
 * @param address - the string address surfaced by the `_Out_ void **` param.
 * @param pointerSize - the process's pointer width (`koffi.sizeof('void *')`).
 * @returns the decoded UTF-16 path.
 */
function readUtf16(koffi: Koffi, address: unknown, pointerSize: number): string {
  const pointer = Buffer.alloc(8)
  // koffi 3 surfaces `_Out_ void **` values as BigInt native addresses.
  pointer.writeBigUInt64LE(BigInt(address as bigint | number))
  return koffi.decode(pointer.subarray(0, pointerSize), 'str16') as string
}

const COINIT_APARTMENTTHREADED = 0x2
const CLSCTX_INPROC_SERVER = 0x1
const SIGDN_FILESYSPATH = 0x80058000 | 0
/**
 * Thread DPI awareness contexts, best first: per-monitor-v2 (Windows 10
 * 1703+), per-monitor (1607+), then system-aware. `SetThreadDpiAwarenessContext`
 * returns NULL for an unsupported context instead of throwing, so the caller
 * cascades to the best one the host accepts; DPI stays a cosmetic
 * best-effort — an unsupported host still gets the modern dialog.
 */
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2]
const WM_CLOSE = 0x10

/** IFileOpenDialog vtable slots (IUnknown 0-2, IModalWindow 3, IFileDialog 4+). */
const SLOT_RELEASE = 2
const SLOT_SHOW = 3
const SLOT_SET_OPTIONS = 9
const SLOT_SET_TITLE = 17
const SLOT_GET_RESULT = 20
/** IShellItem vtable slot for `GetDisplayName`. */
const SLOT_GET_DISPLAY_NAME = 5

/**
 * Encode a canonical GUID string as its 16 little-endian bytes.
 * @param text - the `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` form.
 * @returns the in-memory GUID bytes CoCreateInstance expects.
 */
function guidBytes(text: string): Buffer {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text) as RegExpExecArray
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(parseInt(match[1] as string, 16), 0)
  bytes.writeUInt16LE(parseInt(match[2] as string, 16), 4)
  bytes.writeUInt16LE(parseInt(match[3] as string, 16), 6)
  Buffer.from((match[4] as string) + (match[5] as string), 'hex').copy(bytes, 8)
  return bytes
}

const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7')
const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960')

/**
 * Load koffi and expose the dialog bindings for this thread.
 * @returns the bindings {@link runFolderDialog} sequences against.
 */
export async function loadWin32DialogBindings(): Promise<Win32DialogBindings> {
  const koffi = (await import('koffi')).default as unknown as Koffi
  const ole32 = koffi.load('ole32.dll')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  // Vtable slots and out-pointers are pointer-width offsets: 8 on x64/arm64,
  // 4 on ia32 — koffi reports the running process's width.
  const pointerSize = koffi.sizeof('void *')
  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', [])
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', ['void *', 'void *', 'uint32', 'void *', 'void *'])
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])
  const getCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', [])

  const protoShow = koffi.proto('int32 __stdcall DshDialogShow(void *self, void *owner)')
  const protoSetOptions = koffi.proto('int32 __stdcall DshDialogSetOptions(void *self, uint32 options)')
  const protoSetTitle = koffi.proto('int32 __stdcall DshDialogSetTitle(void *self, str16 title)')
  const protoGetResult = koffi.proto('int32 __stdcall DshDialogGetResult(void *self, _Out_ void **item)')
  const protoGetDisplayName = koffi.proto('int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)')
  const protoRelease = koffi.proto('uint32 __stdcall DshComRelease(void *self)')

  /** Bind vtable slot `slot` of COM object `self` to a caller through `proto`. */
  const method = (self: unknown, slot: number, proto: unknown): (...args: unknown[]) => number => {
    const vtable = koffi.decode(self, 'void *')
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *')
    return (...args: unknown[]) => koffi.call(fn, proto, self, ...args) as number
  }

  return {
    setThreadDpiAwareness: () => {
      let setContext: KoffiFunction
      try {
        setContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr'])
      } catch {
        // Symbol absent (pre-1607 Windows): no per-thread DPI control exists.
        // Proceed anyway — the cost is a blurry dialog above 100 % scaling on
        // museum hosts, and the modern picker still beats dropping to the
        // legacy 5.1 tree over a cosmetic concern.
        return
      }
      for (const context of DPI_AWARENESS_CONTEXTS) {
        if (setContext(context) !== null) return
      }
      // Unreachable in practice (SYSTEM_AWARE is accepted wherever the symbol
      // exists); if a host ever refuses everything, the dialog still works —
      // just without a DPI opt-in.
    },
    coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED) as number,
    coUninitialize: () => {
      coUninitialize()
    },
    currentThreadId: () => getCurrentThreadId() as number,
    createFolderDialog: (): Win32FolderDialog => {
      const out = Buffer.alloc(pointerSize)
      const created = coCreateInstance(CLSID_FILE_OPEN_DIALOG, null, CLSCTX_INPROC_SERVER, IID_IFILE_OPEN_DIALOG, out) as number
      if (created < 0) throw new Error(`CoCreateInstance(FileOpenDialog) failed: HRESULT 0x${(created >>> 0).toString(16)}`)
      const dialog = koffi.decode(out, 'void *')
      return {
        setOptions: options => method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(options),
        setTitle: title => method(dialog, SLOT_SET_TITLE, protoSetTitle)(title),
        show: () => method(dialog, SLOT_SHOW, protoShow)(null),
        resultPath: () => {
          const itemOut: unknown[] = [null]
          const gotItem = method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut)
          if (gotItem < 0) return { hr: gotItem }
          const item = itemOut[0]
          try {
            const nameOut: unknown[] = [null]
            const gotName = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut)
            if (gotName < 0) return { hr: gotName }
            const path = readUtf16(koffi, nameOut[0], pointerSize)
            coTaskMemFree(nameOut[0])
            return { hr: gotName, path }
          } finally {
            method(item, SLOT_RELEASE, protoRelease)()
          }
        },
        release: () => {
          method(dialog, SLOT_RELEASE, protoRelease)()
        },
      }
    },
  }
}

/**
 * Post `WM_CLOSE` to every window of a native thread — the driver's abort
 * lever against the worker blocked inside `Show`, after which `Show` returns
 * `HRESULT_CANCELLED` and the worker unwinds normally.
 * @param threadId - the dialog thread's native id (from the `showing` notice).
 */
export async function closeThreadWindows(threadId: number): Promise<void> {
  const koffi = (await import('koffi')).default as unknown as Koffi
  const user32 = koffi.load('user32.dll')
  const enumThreadWindows = user32.func('__stdcall', 'EnumThreadWindows', 'int', ['uint32', 'void *', 'intptr'])
  const postMessageW = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr'])
  const protoEnumProc = koffi.proto('int __stdcall DshEnumThreadWndProc(void *hwnd, intptr lparam)')
  const callback = koffi.register((hwnd: unknown) => {
    postMessageW(hwnd, WM_CLOSE, 0, 0)
    return 1
  }, koffi.pointer(protoEnumProc))
  try {
    enumThreadWindows(threadId, callback, 0)
  } finally {
    koffi.unregister(callback)
  }
}

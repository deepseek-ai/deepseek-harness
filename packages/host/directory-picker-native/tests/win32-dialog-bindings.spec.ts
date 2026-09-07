/**
 * The koffi-backed bindings against a mocked `koffi` module (the same
 * technique as dsh-session-persistence-jsonl's win32 suite): a small in-memory
 * COM world stands in for ole32/user32/kernel32, keeping the vtable dispatch,
 * result extraction, memory hygiene, and the WM_CLOSE poster covered on every
 * host. The worker entry is exercised the same way with a mocked process
 * boundary (env title + `process.send`). String conversion also runs through
 * real Koffi over test-owned buffers; only the Windows libraries are faked.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HRESULT_CANCELLED, runFolderDialog } from '../src/win32-dialog-logic.ts'

const E_FAIL = 0x80004005 | 0
const WM_CLOSE = 0x10
/** Four-byte defaults catch hardcoded x64 vtable offsets on every host. */
const FAKE_POINTER_SIZE = 4

interface ComWorld {
  coInitHr: number
  coCreateHr: number
  showHr: number
  getResultHr: number
  getDisplayNameHr: number
  hasThreadDpi: boolean
  /** Contexts `SetThreadDpiAwarenessContext` accepts; others return NULL. */
  supportedDpiContexts: number[]
  enumThrows: boolean
  path: string
  titles: string[]
  options: number[]
  dpiContexts: unknown[]
  freed: unknown[]
  released: string[]
  posted: { hwnd: unknown; message: number }[]
  /** Buffer sizes handed to the fake `decode(..., 'str16')`. */
  str16PointerSizes: number[]
  registered: number
  unregistered: number
  uninitialized: number
}

function comWorld(overrides: Partial<ComWorld> = {}): ComWorld {
  return {
    coInitHr: 0, coCreateHr: 0, showHr: 0, getResultHr: 0, getDisplayNameHr: 0,
    hasThreadDpi: true, supportedDpiContexts: [-4], enumThrows: false,
    path: 'C:\\选中\\directory',
    titles: [], options: [], dpiContexts: [], freed: [], released: [], posted: [],
    str16PointerSizes: [],
    registered: 0, unregistered: 0, uninitialized: 0,
    ...overrides,
  }
}

/** Sentinel pointer addresses standing in for native pointers. */
interface FakePtr { kind: string; [key: string]: unknown }

function installFakeKoffi(world: ComWorld, options: {
  pointerSize?: number
  nameAddress?: bigint
  decodeString?: (pointer: Buffer) => string
} = {}): void {
  const pointerSize = options.pointerSize ?? FAKE_POINTER_SIZE
  const dialogPtr = 0x1100n
  const itemPtr = 0x2200n
  const namePtr = options.nameAddress ?? 0x3300n
  const pointers = new Map<bigint, FakePtr>([
    [dialogPtr, { kind: 'dialog' }],
    [itemPtr, { kind: 'item' }],
    [namePtr, { kind: 'name', text: world.path }],
  ])
  const outBuffers = new Map<unknown, bigint>()
  world.str16PointerSizes = []

  const dispatch = (self: FakePtr, slot: number, args: unknown[]): number => {
    if (self.kind === 'dialog') {
      switch (slot) {
        case 9: world.options.push(args[0] as number); return 0
        case 17: world.titles.push(args[0] as string); return 0
        case 3: return world.showHr
        case 20: {
          if (world.getResultHr < 0) return world.getResultHr
          ;(args[0] as unknown[])[0] = itemPtr
          return 0
        }
        case 2: world.released.push('dialog'); return 0
        default: throw new Error(`unexpected dialog slot ${slot}`)
      }
    }
    switch (slot) {
      case 5: {
        if (world.getDisplayNameHr < 0) return world.getDisplayNameHr
        ;(args[1] as unknown[])[0] = namePtr
        return 0
      }
      case 2: world.released.push('item'); return 0
      default: throw new Error(`unexpected item slot ${slot}`)
    }
  }

  vi.doMock('koffi', () => ({
    default: {
      load: (dll: string) => ({
        func: (_convention: string, name: string, _result: string, _args: string[]) => {
          switch (name) {
            case 'CoInitializeEx': return () => world.coInitHr
            case 'CoUninitialize': return () => { world.uninitialized += 1 }
            case 'CoCreateInstance': return (...args: unknown[]) => {
              if (world.coCreateHr < 0) return world.coCreateHr
              // The out-pointer must be allocated at the fake's pointer width.
              if ((args[4] as Buffer).length !== pointerSize) {
                throw new Error(`CoCreateInstance out buffer must be ${pointerSize} bytes`)
              }
              outBuffers.set(args[4], dialogPtr)
              return 0
            }
            case 'CoTaskMemFree': return (ptr: unknown) => { world.freed.push(ptr) }
            case 'GetCurrentThreadId': return () => 31337
            case 'SetThreadDpiAwarenessContext': {
              if (!world.hasThreadDpi) throw new Error(`${dll}: SetThreadDpiAwarenessContext not found`)
              return (context: unknown) => {
                world.dpiContexts.push(context)
                return world.supportedDpiContexts.includes(context as number) ? { kind: 'previous-context' } : null
              }
            }
            case 'EnumThreadWindows': return (_tid: unknown, callback: { fn: (hwnd: unknown, lparam: unknown) => number }, lparam: unknown) => {
              if (world.enumThrows) throw new Error('EnumThreadWindows refused')
              callback.fn({ kind: 'hwnd', n: 1 }, lparam)
              callback.fn({ kind: 'hwnd', n: 2 }, lparam)
              return 1
            }
            case 'PostMessageW': return (hwnd: unknown, message: number) => { world.posted.push({ hwnd, message }); return 1 }
            default: throw new Error(`unexpected native import ${dll}/${name}`)
          }
        },
      }),
      proto: (declaration: string) => ({ declaration }),
      pointer: (type: unknown) => type,
      sizeof: (type: string) => { void type; return pointerSize },
      register: (fn: (hwnd: unknown, lparam: unknown) => number) => { world.registered += 1; return { fn } },
      unregister: () => { world.unregistered += 1 },
      decode: (value: unknown, offsetOrType: unknown): unknown => {
        if (offsetOrType === 'str16') {
          const buffer = value as Buffer
          if (buffer.length !== pointerSize) throw new Error(`str16 pointer buffer must be ${pointerSize} bytes, got ${buffer.length}`)
          world.str16PointerSizes.push(buffer.length)
          if (options.decodeString) return options.decodeString(buffer)
          const address = pointerSize === 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))
          return pointers.get(address)?.text
        }
        if (typeof offsetOrType === 'number') {
          // Vtable slot read: offsets must be multiples of the fake width.
          if (offsetOrType % pointerSize !== 0) throw new Error(`vtable offset ${offsetOrType} is not pointer-aligned`)
          const owner = (value as { owner: FakePtr }).owner
          return { call: (args: unknown[]) => dispatch(owner, offsetOrType / pointerSize, args) }
        }
        // decode(x, 'void *'): out-buffer read or object-pointer read.
        if (outBuffers.has(value)) return outBuffers.get(value)
        if (typeof value === 'bigint') return { owner: pointers.get(value) }
        return { owner: value as FakePtr }
      },
      call: (fn: { call: (args: unknown[]) => number }, _proto: unknown, _self: unknown, ...args: unknown[]) => fn.call(args),
    },
  }))
}

async function loadBindingsModule(): Promise<typeof import('../src/win32-dialog-bindings.ts')> {
  return await import('../src/win32-dialog-bindings.ts')
}

afterEach(() => {
  vi.doUnmock('koffi')
  vi.doUnmock('node:worker_threads')
  vi.doUnmock('../src/win32-dialog-bindings.ts')
  vi.resetModules()
})

describe('loadWin32DialogBindings over the fake COM world', () => {
  it('drives the full selection conversation with memory hygiene', async () => {
    const world = comWorld()
    installFakeKoffi(world)
    const { loadWin32DialogBindings } = await loadBindingsModule()
    const bindings = await loadWin32DialogBindings()
    const showing = vi.fn()

    expect(runFolderDialog(bindings, '选择工作区目录', showing)).toBe('C:\\选中\\directory')
    expect(world.dpiContexts).toEqual([-4])
    expect(world.titles).toEqual(['选择工作区目录'])
    expect(world.options).toHaveLength(1)
    expect(showing).toHaveBeenCalledWith(31337)
    expect(world.freed).toHaveLength(1)
    expect(world.str16PointerSizes).toEqual([FAKE_POINTER_SIZE])
    expect(world.released).toEqual(['item', 'dialog'])
    expect(world.uninitialized).toBe(1)
  })

  it.each([
    { pointerSize: 4, nameAddress: 0xf1233300n },
    { pointerSize: 8, nameAddress: 0x123456783300n },
  ])('preserves and frees a $pointerSize-byte BigInt address', async ({ pointerSize, nameAddress }) => {
    const world = comWorld()
    installFakeKoffi(world, { pointerSize, nameAddress })
    const bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(runFolderDialog(bindings, 'Pick', vi.fn())).toBe(world.path)
    expect(world.str16PointerSizes).toEqual([pointerSize])
    expect(world.freed).toEqual([nameAddress])
    expect(world.released).toEqual(['item', 'dialog'])
  })

  it.each([
    { label: 'zero-low-byte BMP code units', text: 'C:/fixture/安卓开发' },
    { label: 'surrogate pairs', text: 'C:/fixture/😀' },
    { label: 'more than 32 KiB', text: 'C:/' + '开'.repeat(17_000) },
    { label: 'NUL termination', text: 'C:/开' + String.fromCharCode(0) + 'ignored' },
  ])('decodes $label with real Koffi through resultPath', async ({ text }) => {
    const { default: koffi } = await vi.importActual<typeof import('koffi')>('koffi')
    const nul = String.fromCharCode(0)
    const storage = Buffer.from(text + nul, 'utf16le')
    const nameAddress = koffi.address(storage)
    const pointerSize = koffi.sizeof('void *')
    const expectedPointer = Buffer.alloc(pointerSize)
    koffi.encode(expectedPointer, 'void *', nameAddress)
    const world = comWorld()
    const decodeString = vi.fn((pointer: Buffer): string => {
      // Reject bad serialization before native code could dereference it.
      expect(pointer).toEqual(expectedPointer)
      return koffi.decode(pointer, 'str16') as string
    })
    installFakeKoffi(world, { pointerSize, nameAddress, decodeString })
    const bindings = await (await loadBindingsModule()).loadWin32DialogBindings()

    expect(runFolderDialog(bindings, 'Pick', vi.fn())).toBe(text.split(nul)[0])
    expect(decodeString).toHaveBeenCalledOnce()
    expect(world.freed).toEqual([nameAddress])
    expect(world.released).toEqual(['item', 'dialog'])
    expect(world.uninitialized).toBe(1)
    // Keep the JS-owned allocation live until the synchronous native read ends.
    expect(storage.toString('utf16le')).toBe(text + nul)
  })

  it('maps dismissal and the S_FALSE CoInitializeEx', async () => {
    const world = comWorld({ showHr: HRESULT_CANCELLED, coInitHr: 1 })
    installFakeKoffi(world)
    const { loadWin32DialogBindings } = await loadBindingsModule()
    const bindings = await loadWin32DialogBindings()
    expect(runFolderDialog(bindings, 'Pick', vi.fn())).toBeNull()
    expect(world.released).toEqual(['dialog'])
    expect(world.uninitialized).toBe(1)
  })

  it('cascades DPI contexts to the first the host accepts', async () => {
    const world = comWorld({ supportedDpiContexts: [-3] })
    installFakeKoffi(world)
    const bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(runFolderDialog(bindings, 'Pick', vi.fn())).toBe('C:\\选中\\directory')
    expect(world.dpiContexts).toEqual([-4, -3])
  })

  it('keeps the tier when no DPI context is accepted or the symbol is absent', async () => {
    // DPI is a cosmetic best-effort: the modern dialog still opens.
    const rejecting = comWorld({ supportedDpiContexts: [] })
    installFakeKoffi(rejecting)
    let bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(runFolderDialog(bindings, 'Pick', vi.fn())).toBe('C:\\选中\\directory')
    expect(rejecting.dpiContexts).toEqual([-4, -3, -2])

    vi.doUnmock('koffi')
    vi.resetModules()
    const preThreadDpi = comWorld({ hasThreadDpi: false })
    installFakeKoffi(preThreadDpi)
    bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(runFolderDialog(bindings, 'Pick', vi.fn())).toBe('C:\\选中\\directory')
    expect(preThreadDpi.dpiContexts).toEqual([])
  })

  it('surfaces creation and extraction failures as HRESULT errors', async () => {
    const creationWorld = comWorld({ coCreateHr: E_FAIL })
    installFakeKoffi(creationWorld)
    let bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(() => bindings.createFolderDialog()).toThrow('CoCreateInstance(FileOpenDialog) failed: HRESULT 0x80004005')

    vi.doUnmock('koffi')
    vi.resetModules()
    const resultWorld = comWorld({ getResultHr: E_FAIL })
    installFakeKoffi(resultWorld)
    bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(() => runFolderDialog(bindings, 'Pick', vi.fn())).toThrow('GetResult failed')
    expect(resultWorld.released).toEqual(['dialog'])

    vi.doUnmock('koffi')
    vi.resetModules()
    const nameWorld = comWorld({ getDisplayNameHr: E_FAIL })
    installFakeKoffi(nameWorld)
    bindings = await (await loadBindingsModule()).loadWin32DialogBindings()
    expect(() => runFolderDialog(bindings, 'Pick', vi.fn())).toThrow('GetResult failed')
    // The shell item is released even when its display name cannot be read.
    expect(nameWorld.released).toEqual(['item', 'dialog'])
    expect(nameWorld.freed).toHaveLength(0)
  })
})

describe('closeThreadWindows over the fake COM world', () => {
  it('posts WM_CLOSE to every window of the thread and unregisters the callback', async () => {
    const world = comWorld()
    installFakeKoffi(world)
    const { closeThreadWindows } = await loadBindingsModule()
    await closeThreadWindows(777)
    expect(world.posted).toEqual([
      { hwnd: { kind: 'hwnd', n: 1 }, message: WM_CLOSE },
      { hwnd: { kind: 'hwnd', n: 2 }, message: WM_CLOSE },
    ])
    expect(world.registered).toBe(1)
    expect(world.unregistered).toBe(1)
  })

  it('unregisters the callback even when the enumeration itself throws', async () => {
    const world = comWorld({ enumThrows: true })
    installFakeKoffi(world)
    const { closeThreadWindows } = await loadBindingsModule()
    await expect(closeThreadWindows(777)).rejects.toThrow('EnumThreadWindows refused')
    expect(world.unregistered).toBe(1)
  })
})

describe('the worker entry over a mocked process boundary', () => {
  const originalSend = process.send?.bind(process)
  const originalTitle = process.env.DSH_DIALOG_TITLE

  const installBoundary = (): { posted: { kind: string; message?: string }[] } => {
    const posted: { kind: string; message?: string }[] = []
    process.env.DSH_DIALOG_TITLE = 'Pick'
    // Never invoke the post callback: it runs the worker's disconnect(), and
    // this process is IPC-connected under the forks pool — severing vitest's
    // own channel would kill the test worker. The real close lifecycle
    // belongs to built-worker.e2e.ts.
    ;(process as { send?: unknown }).send = (message: { kind: string }) => {
      posted.push(message)
      return true
    }
    return { posted }
  }

  afterEach(() => {
    delete (process as { send?: unknown }).send
    if (originalSend !== undefined) (process as { send?: unknown }).send = originalSend
    if (originalTitle === undefined) delete process.env.DSH_DIALOG_TITLE
    else process.env.DSH_DIALOG_TITLE = originalTitle
    vi.doUnmock('../src/win32-dialog-bindings.ts')
    vi.resetModules()
  })

  it('posts showing then done for a completed conversation', async () => {
    const { posted } = installBoundary()
    vi.doMock('../src/win32-dialog-bindings.ts', () => ({
      loadWin32DialogBindings: async () => ({
        setThreadDpiAwareness: () => undefined,
        coInitializeSta: () => 0,
        coUninitialize: () => undefined,
        currentThreadId: () => 11,
        createFolderDialog: () => ({
          setOptions: () => 0,
          setTitle: () => 0,
          show: () => 0,
          resultPath: () => ({ hr: 0, path: 'C:\\from-worker' }),
          release: () => undefined,
        }),
      }),
    }))
    await import('../src/win32-dialog-worker.ts')
    expect(posted).toEqual([
      { kind: 'showing', threadId: 11 },
      { kind: 'done', path: 'C:\\from-worker' },
    ])
  })

  it('posts the failure message when the native surface cannot load', async () => {
    const { posted } = installBoundary()
    vi.doMock('../src/win32-dialog-bindings.ts', () => ({
      loadWin32DialogBindings: async () => { throw new Error('no ole32 here') },
    }))
    await import('../src/win32-dialog-worker.ts')
    expect(posted).toHaveLength(1)
    expect(posted[0]?.kind).toBe('error')
    expect(posted[0]?.message).toContain('no ole32 here')
  })

  it('stringifies stackless and non-Error failures', async () => {
    const stackless = new Error('bare message')
    delete stackless.stack
    for (const [thrown, expected] of [[stackless, 'bare message'], ['plain refusal', 'plain refusal']] as const) {
      vi.resetModules()
      const { posted } = installBoundary()
      vi.doMock('../src/win32-dialog-bindings.ts', () => ({
        loadWin32DialogBindings: async () => { throw thrown },
      }))
      await import('../src/win32-dialog-worker.ts')
      expect(posted[0]?.message).toBe(expected)
    }
  })

  it('refuses to run without the dialog title', async () => {
    delete process.env.DSH_DIALOG_TITLE
    ;(process as { send?: unknown }).send = () => true
    await expect(import('../src/win32-dialog-worker.ts')).rejects.toThrow('DSH_DIALOG_TITLE is required')
  })

  it('refuses to run outside a child process', async () => {
    process.env.DSH_DIALOG_TITLE = 'Pick'
    delete (process as { send?: unknown }).send
    await expect(import('../src/win32-dialog-worker.ts')).rejects.toThrow('must run as a child process')
  })
})

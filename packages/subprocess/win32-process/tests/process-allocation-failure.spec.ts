import koffi from 'koffi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  drainPipe,
  spawnInheritedJobProcess,
  spawnPipedProcess,
  waitForProcessExit,
} from '../src/index.ts'
import * as ffi from '../src/ffi.ts'
import { processInformationType } from '../src/ffi.ts'
import * as koffiLoader from '../src/koffi.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/ffi.ts'

vi.mock('../src/ffi.ts', { spy: true })
vi.mock('../src/koffi.ts', { spy: true })

const PVOID = koffi.pointer('void')

beforeEach(() => {
  vi.mocked(koffiLoader.requireKoffi).mockReturnValue(koffi)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('spawnInheritedJobProcess allocation cleanup', () => {
  it('frees startup info when process-info allocation throws', () => {
    const api = {
      createJobObjectW: vi.fn(() => 50n),
      setInformationJobObject: vi.fn(() => 1),
      getStdHandle: vi.fn((selector: number) => BigInt(100 - selector)),
      setHandleInformation: vi.fn(() => 1),
      closeHandle: vi.fn(() => 1),
      getLastError: vi.fn(() => 5),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    const free = vi.spyOn(koffi, 'free')
    vi.mocked(ffi.allocProcessInfo).mockImplementationOnce(() => { throw new Error('process-info allocation failed') })
    expect(() => spawnInheritedJobProcess(api, {
      command: 'cmd.exe',
      args: [],
      cwd: 'C:\\',
      token: 70n as NativePtr,
    })).toThrow('process-info allocation failed')
    expect(free).toHaveBeenCalledOnce()
  })

  it('frees process info after a successful inherited spawn', () => {
    const api = {
      createJobObjectW: vi.fn(() => 50n),
      setInformationJobObject: vi.fn(() => 1),
      getStdHandle: vi.fn((selector: number) => BigInt(100 - selector)),
      setHandleInformation: vi.fn(() => 1),
      createProcessAsUserW: vi.fn((_token, _app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, info) => {
        koffi.encode(info, processInformationType(), {
          hProcess: 60n,
          hThread: 61n,
          dwProcessId: 1234,
          dwThreadId: 5678,
        })
        return 1
      }),
      assignProcessToJobObject: vi.fn(() => 1),
      resumeThread: vi.fn(() => 0),
      closeHandle: vi.fn(() => 1),
      getLastError: vi.fn(() => 5),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    const free = vi.spyOn(koffi, 'free')
    expect(spawnInheritedJobProcess(api, {
      command: 'cmd.exe',
      args: [],
      cwd: 'C:\\',
      token: 70n as NativePtr,
    })).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(free).toHaveBeenCalledTimes(2)
  })
})

describe('shared process allocation cleanup', () => {
  it('frees pipe slots and process structs after a successful piped spawn', () => {
    let nextHandle = 10n
    const api = {
      createPipe: vi.fn((readSlot: NativePtr, writeSlot: NativePtr) => {
        koffi.encode(readSlot, PVOID, nextHandle++)
        koffi.encode(writeSlot, PVOID, nextHandle++)
        return 1
      }),
      setHandleInformation: vi.fn(() => 1),
      createProcessAsUserW: vi.fn((_token, _app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, info) => {
        koffi.encode(info, processInformationType(), {
          hProcess: 60n,
          hThread: 61n,
          dwProcessId: 1234,
          dwThreadId: 5678,
        })
        return 1
      }),
      closeHandle: vi.fn(() => 1),
      getLastError: vi.fn(() => 5),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    const free = vi.spyOn(koffi, 'free')
    expect(spawnPipedProcess(api, {
      command: 'cmd.exe',
      args: [],
      cwd: 'C:\\',
      token: 70n as NativePtr,
    })).toMatchObject({ pid: 1234, process: 60n })
    expect(free).toHaveBeenCalledTimes(8)
  })

  it('reuses one drain count slot and frees it at EOF', async () => {
    let peeks = 0
    const api = {
      peekNamedPipe: vi.fn((_pipe, _buffer, _size, _read, totalAvail: NativePtr) => {
        peeks += 1
        if (peeks > 1) return 0
        koffi.encode(totalAvail, 'uint32', 1)
        return 1
      }),
      readFile: vi.fn((_file, buffer: Buffer, _count, readSlot: NativePtr) => {
        buffer[0] = 0x61
        koffi.encode(readSlot, 'uint32', 1)
        return 1
      }),
      getLastError: vi.fn(() => 109),
      closeHandle: vi.fn(() => 1),
    } as unknown as Win32ProcessBindings
    const alloc = vi.spyOn(koffi, 'alloc')
    const free = vi.spyOn(koffi, 'free')
    await expect(drainPipe(api, 70n as NativePtr)).resolves.toEqual(Buffer.from('a'))
    expect(alloc).toHaveBeenCalledOnce()
    expect(free).toHaveBeenCalledOnce()
  })

  it('frees the exit-code slot after reading a process result', () => {
    const api = {
      waitForSingleObject: vi.fn(() => 0),
      getExitCodeProcess: vi.fn((_process, exitCode: NativePtr) => {
        koffi.encode(exitCode, 'uint32', 42)
        return 1
      }),
      closeHandle: vi.fn(() => 1),
    } as unknown as Win32ProcessBindings
    const free = vi.spyOn(koffi, 'free')
    expect(waitForProcessExit(api, 60n as NativePtr)).toBe(42)
    expect(free).toHaveBeenCalledOnce()
  })
})

/**
 * Failure-path unit tests with minimal stub binding tables: the spawn
 * helpers must close every handle they created before throwing, and
 * every generic process failure remains owned by the shared package.
 * Pure stubs — no real Win32 calls, so these run on every platform.
 */

import { describe, expect, it, vi } from 'vitest'
import koffi from 'koffi'

import {
  Win32Error,
  drainPipe,
  spawnInheritedJobProcess,
  spawnPipedProcess,
  waitForProcessExit,
} from '../src/index.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/index.ts'
import * as abi from '../src/abi.ts'
import { processInformationType } from '../src/ffi.ts'

const PVOID = koffi.pointer('void')

/** The stub the CreateProcessAsUserW failure branch needs: pipes "succeed", the spawn fails with Win32 5. */
function pipeFailureApi(): { api: Win32ProcessBindings; closed: bigint[]; closeHandle: ReturnType<typeof vi.fn> } {
  const closed: bigint[] = []
  let next = 1n
  const closeHandle = vi.fn((handle: NativePtr) => {
    closed.push(handle)
    return 1
  })
  const api = {
    createPipe: vi.fn((readSlot: NativePtr, writeSlot: NativePtr) => {
      koffi.encode(readSlot, PVOID, next++)
      koffi.encode(writeSlot, PVOID, next++)
      return 1
    }),
    setHandleInformation: vi.fn(() => 1),
    createProcessAsUserW: vi.fn(() => 0),
    getLastError: vi.fn(() => 5), // ERROR_ACCESS_DENIED: the failure the branch reports
    closeHandle,
    formatMessageW: vi.fn(() => 0),
  } as unknown as Win32ProcessBindings
  return { api, closed, closeHandle }
}

describe('spawn failure paths close their handles', () => {
  // A dummy token value; the stubbed spawn never reads it.
  const token = 1n as NativePtr

  it('closes all six pipe handles before throwing when CreateProcessAsUserW fails', () => {
    const { api, closed, closeHandle } = pipeFailureApi()
    let caught: unknown
    try {
      spawnPipedProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreateProcessAsUserW')
    expect((caught as Win32Error).win32Code).toBe(5)
    expect(closeHandle).toHaveBeenCalledTimes(6)
    expect(closed).toEqual([1n, 2n, 3n, 4n, 5n, 6n])
  })

})

/** The stub the pipe-happy path needs: CreatePipe fills both out slots with fresh handles. */
function pipeOkApi(overrides: Partial<Win32ProcessBindings> = {}): {
  api: Win32ProcessBindings
  closed: bigint[]
  closeHandle: ReturnType<typeof vi.fn>
} {
  const closed: bigint[] = []
  let next = 1n
  const closeHandle = vi.fn((handle: NativePtr) => {
    closed.push(handle)
    return 1
  })
  const api = {
    createPipe: vi.fn((readSlot: NativePtr, writeSlot: NativePtr) => {
      koffi.encode(readSlot, PVOID, next++)
      koffi.encode(writeSlot, PVOID, next++)
      return 1
    }),
    setHandleInformation: vi.fn(() => 1),
    createProcessAsUserW: vi.fn((
      _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
      _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
    ) => {
      koffi.encode(processInfo, processInformationType(), { hProcess: 200n, hThread: 201n, dwProcessId: 1234, dwThreadId: 5678 })
      return 1
    }),
    getLastError: vi.fn(() => 5),
    closeHandle,
    formatMessageW: vi.fn(() => 0),
    ...overrides,
  } as unknown as Win32ProcessBindings
  return { api, closed, closeHandle }
}

describe('spawn pipe failures close their handles', () => {
  const token = 1n as NativePtr

  it('reports a CreatePipe failure', () => {
    const api = {
      createPipe: vi.fn(() => 0),
      getLastError: vi.fn(() => 5),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    let caught: unknown
    try {
      spawnPipedProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreatePipe')
  })

  it('reports a NULL pipe handle after CreatePipe succeeds', () => {
    const api = {
      createPipe: vi.fn(() => 1),
      getLastError: vi.fn(() => 5),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    let caught: unknown
    try {
      spawnPipedProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreatePipe')
  })

  it('reports a SetHandleInformation failure', () => {
    const { api } = pipeOkApi({ setHandleInformation: vi.fn(() => 0) })
    let caught: unknown
    try {
      spawnPipedProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetHandleInformation')
  })

  it('rejects NULL process/thread handles after a successful spawn', () => {
    const { api } = pipeOkApi({
      createProcessAsUserW: vi.fn((
        _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
        _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
      ) => {
        koffi.encode(processInfo, processInformationType(), { hProcess: null, hThread: null, dwProcessId: 1234, dwThreadId: 5678 })
        return 1
      }),
    })
    expect(() => spawnPipedProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token }))
      .toThrow(/null process\/thread handles/u)
  })
})

describe('spawnInheritedJobProcess failure paths', () => {
  const token = 1n as NativePtr

  /** The stub the inherited-happy path needs; overrides flip one call per test. */
  function inheritedApi(overrides: Partial<Win32ProcessBindings> = {}): {
    api: Win32ProcessBindings
    closed: bigint[]
    closeHandle: ReturnType<typeof vi.fn>
  } {
    const closed: bigint[] = []
    let std = 50n
    const closeHandle = vi.fn((handle: NativePtr) => {
      closed.push(handle)
      return 1
    })
    const api = {
      createJobObjectW: vi.fn(() => 100n),
      setInformationJobObject: vi.fn(() => 1),
      getStdHandle: vi.fn(() => std++),
      setHandleInformation: vi.fn(() => 1),
      createProcessAsUserW: vi.fn((
        _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
        _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
      ) => {
        koffi.encode(processInfo, processInformationType(), { hProcess: 200n, hThread: 201n, dwProcessId: 1234, dwThreadId: 5678 })
        return 1
      }),
      assignProcessToJobObject: vi.fn(() => 1),
      resumeThread: vi.fn(() => 0),
      terminateProcess: vi.fn(() => 1),
      getLastError: vi.fn(() => 5),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
      ...overrides,
    } as unknown as Win32ProcessBindings
    return { api, closed, closeHandle }
  }

  it('closes the job and reports when GetStdHandle yields a NULL handle', () => {
    const { api, closeHandle } = inheritedApi({ getStdHandle: vi.fn(() => 0n as NativePtr) })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('GetStdHandle')
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('reports a SetHandleInformation failure while enabling stdio inheritance', () => {
    const { api } = inheritedApi({ setHandleInformation: vi.fn(() => 0) })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetHandleInformation')
  })

  it('closes the job and reports when CreateProcessAsUserW fails', () => {
    const { api, closeHandle } = inheritedApi({ createProcessAsUserW: vi.fn(() => 0) })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreateProcessAsUserW')
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('closes the job and rejects NULL process/thread handles after a successful spawn', () => {
    const { api, closeHandle } = inheritedApi({
      createProcessAsUserW: vi.fn((
        _token: unknown, _app: unknown, _cmd: unknown, _pa: unknown, _ta: unknown,
        _inherit: unknown, _flags: unknown, _env: unknown, _cwd: unknown, _si: unknown, processInfo: NativePtr,
      ) => {
        koffi.encode(processInfo, processInformationType(), { hProcess: null, hThread: null, dwProcessId: 1234, dwThreadId: 5678 })
        return 1
      }),
    })
    expect(() => spawnInheritedJobProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token }))
      .toThrow(/null process\/thread handles/u)
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('terminates the suspended child before closing handles when Job assignment fails', () => {
    const terminateProcess = vi.fn(() => 1)
    const { api, closeHandle, closed } = inheritedApi({
      assignProcessToJobObject: vi.fn(() => 0),
      terminateProcess,
    })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'AssignProcessToJobObject', win32Code: 5 })
    expect(terminateProcess).toHaveBeenCalledWith(200n, 1)
    expect(closeHandle).toHaveBeenCalledWith(201n)
    expect(closeHandle).toHaveBeenCalledWith(200n)
    expect(closeHandle).toHaveBeenCalledWith(100n)
    expect(closed).toEqual([201n, 200n, 100n])
  })

  it('closes the assigned child and Job when ResumeThread fails', () => {
    const { api, closeHandle, closed } = inheritedApi({ resumeThread: vi.fn(() => 0xFFFFFFFF) })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'ResumeThread', win32Code: 5 })
    expect(closeHandle).toHaveBeenCalledWith(201n)
    expect(closeHandle).toHaveBeenCalledWith(200n)
    expect(closeHandle).toHaveBeenCalledWith(100n)
    expect(closed).toEqual([201n, 200n, 100n])
  })

  it('closes the job and reports when SetInformationJobObject fails', () => {
    const { api, closeHandle } = inheritedApi({ setInformationJobObject: vi.fn(() => 0) })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetInformationJobObject')
    expect(closeHandle).toHaveBeenCalledWith(100n)
  })

  it('closes the job and reports a NULL job object', () => {
    const { api } = inheritedApi({ createJobObjectW: vi.fn(() => 0n as NativePtr) })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreateJobObjectW')
  })

  it('returns the pid, process handle, and kill-on-close job when every call succeeds', () => {
    const assignProcessToJobObject = vi.fn(() => 1)
    const resumeThread = vi.fn(() => 0)
    const { api, closeHandle } = inheritedApi({ assignProcessToJobObject, resumeThread })
    const spawned = spawnInheritedJobProcess(api, { command: 'probe.exe', args: [], cwd: 'C:\\', token })
    expect(spawned.pid).toBe(1234)
    expect(spawned.process).toBe(200n)
    expect(spawned.job).toBe(100n)
    // thread handle closed by the spawn; process and job handles stay with the caller.
    expect(closeHandle).toHaveBeenCalledWith(201n)
    expect(closeHandle).not.toHaveBeenCalledWith(200n)
    expect(closeHandle).not.toHaveBeenCalledWith(100n)
    expect(assignProcessToJobObject).toHaveBeenCalledWith(100n, 200n)
    expect(resumeThread).toHaveBeenCalledWith(201n)
  })
})

describe('drainPipe', () => {
  it('stops at ERROR_NO_DATA and closes the read end', () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      peekNamedPipe: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_DATA),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    return drainPipe(api, 30n as NativePtr).then((buffer) => {
      expect(buffer.length).toBe(0)
      expect(closeHandle).toHaveBeenCalledWith(30n)
    })
  })

  it('reports a PeekNamedPipe failure that is not a clean EOF', () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      peekNamedPipe: vi.fn(() => 0),
      getLastError: vi.fn(() => 5),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    return expect(drainPipe(api, 30n as NativePtr)).rejects.toMatchObject({ api: 'PeekNamedPipe' })
      .then(() => { expect(closeHandle).toHaveBeenCalledWith(30n) })
  })

  it('reports a ReadFile failure after data was reported available', () => {
    const api = {
      peekNamedPipe: vi.fn((_pipe: unknown, _buffer: unknown, _size: unknown, _read: unknown, totalAvail: NativePtr) => {
        koffi.encode(totalAvail, 'uint32', 4)
        return 1
      }),
      readFile: vi.fn(() => 0),
      getLastError: vi.fn(() => 5),
      closeHandle: vi.fn(() => 1),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    return expect(drainPipe(api, 30n as NativePtr)).rejects.toMatchObject({ api: 'ReadFile' })
  })

  it('drains one chunk and stops at ERROR_BROKEN_PIPE', () => {
    let peeks = 0
    const api = {
      peekNamedPipe: vi.fn((_pipe: unknown, _buffer: unknown, _size: unknown, _read: unknown, totalAvail: NativePtr) => {
        peeks++
        if (peeks > 1) return 0
        koffi.encode(totalAvail, 'uint32', 4)
        return 1
      }),
      readFile: vi.fn((_file: unknown, chunk: Buffer, _count: unknown, read: NativePtr) => {
        chunk.write('ab', 0, 'utf8')
        koffi.encode(read, 'uint32', 2)
        return 1
      }),
      getLastError: vi.fn(() => abi.ERROR_BROKEN_PIPE),
      closeHandle: vi.fn(() => 1),
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    return drainPipe(api, 30n as NativePtr).then((buffer) => {
      expect(buffer.toString('utf8')).toBe('ab')
    })
  })
})

describe('waitForProcessExit', () => {
  it('reports a WaitForSingleObject failure', () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      waitForSingleObject: vi.fn(() => 0xFFFFFFFF),
      getLastError: vi.fn(() => 5),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    expect(() => waitForProcessExit(api, 200n as NativePtr)).toThrow(Win32Error)
    expect(closeHandle).toHaveBeenCalledWith(200n)
  })

  it('reports a GetExitCodeProcess failure', () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      waitForSingleObject: vi.fn(() => 0),
      getExitCodeProcess: vi.fn(() => 0),
      getLastError: vi.fn(() => 5),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    expect(() => waitForProcessExit(api, 200n as NativePtr)).toThrow(Win32Error)
    expect(closeHandle).toHaveBeenCalledWith(200n)
  })

  it('returns the exit code and closes the process handle', () => {
    const closeHandle = vi.fn(() => 1)
    const api = {
      waitForSingleObject: vi.fn(() => 0),
      getExitCodeProcess: vi.fn((_process: unknown, slot: NativePtr) => {
        koffi.encode(slot, 'uint32', 42)
        return 1
      }),
      closeHandle,
      formatMessageW: vi.fn(() => 0),
    } as unknown as Win32ProcessBindings
    expect(waitForProcessExit(api, 200n as NativePtr)).toBe(42)
    expect(closeHandle).toHaveBeenCalledWith(200n)
  })
})

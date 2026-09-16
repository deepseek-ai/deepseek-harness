import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  Win32Error,
  drainPipe,
  spawnInheritedJobProcess,
  spawnPipedProcess,
} from '../src/index.ts'
import { CREATE_SUSPENDED } from '../src/abi.ts'
import { processInformationType } from '../src/ffi.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/index.ts'

const PVOID = koffi.pointer('void')

function inheritedApi(overrides: Partial<Win32ProcessBindings> = {}): {
  api: Win32ProcessBindings
  events: string[]
  createProcessAsUserW: ReturnType<typeof vi.fn>
  assignProcessToJobObject: ReturnType<typeof vi.fn>
  resumeThread: ReturnType<typeof vi.fn>
} {
  const events: string[] = []
  const createProcessAsUserWImpl: Win32ProcessBindings['createProcessAsUserW'] =
    overrides.createProcessAsUserW
    ?? ((_token, _app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, info) => {
      events.push('create')
      koffi.encode(info, processInformationType(), {
        hProcess: 60n,
        hThread: 61n,
        dwProcessId: 1234,
        dwThreadId: 5678,
      })
      return 1
    })
  const createProcessAsUserW = vi.fn(createProcessAsUserWImpl)
  const assignProcessToJobObject = vi.fn(() => {
    events.push('assign')
    return 1
  })
  const resumeThread = vi.fn(() => {
    events.push('resume')
    return 1
  })
  const api = {
    createJobObjectW: vi.fn(() => 50n),
    setInformationJobObject: vi.fn(() => 1),
    getStdHandle: vi.fn((selector: number) => BigInt(100 - selector)),
    setHandleInformation: vi.fn((_handle: NativePtr, _mask: number, flags: number) => {
      events.push(flags === 0 ? 'restore' : 'inherit')
      return 1
    }),
    assignProcessToJobObject,
    resumeThread,
    terminateProcess: vi.fn(() => 1),
    closeHandle: vi.fn((handle: NativePtr) => { events.push(`close:${handle}`); return 1 }),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    ...overrides,
    createProcessAsUserW,
  } as unknown as Win32ProcessBindings
  return {
    api,
    events,
    createProcessAsUserW,
    assignProcessToJobObject,
    resumeThread,
  }
}

describe('spawnInheritedJobProcess', () => {
  const token = 70n as NativePtr

  it('inherits the control carrier into a restricted child before resume', () => {
    const descriptorHandle = vi.fn(() => 107n as NativePtr)
    const { api, events } = inheritedApi({ uvGetOsfhandle: descriptorHandle, getFileType: vi.fn(() => 3) })
    const child = spawnInheritedJobProcess(api, { command: 'node.exe', args: [], cwd: 'C:\\work', token, controlFileDescriptor: 7 })
    expect(child.pid).toBe(1234)
    expect(descriptorHandle).toHaveBeenCalledExactlyOnceWith(7)
    expect(events.filter(event => event === 'inherit')).toHaveLength(4)
    expect(events.indexOf('assign')).toBeLessThan(events.indexOf('resume'))
  })

  it('creates suspended, assigns the Job, then resumes the restricted child', () => {
    const {
      api,
      events,
      createProcessAsUserW,
      assignProcessToJobObject,
      resumeThread,
    } = inheritedApi()
    const child = spawnInheritedJobProcess(api, {
      command: 'cmd.exe',
      args: ['/c', 'exit', '0'],
      cwd: 'C:\\work',
      token,
    })
    expect(child).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(events.indexOf('create')).toBeLessThan(events.indexOf('assign'))
    expect(events.indexOf('assign')).toBeLessThan(events.indexOf('resume'))
    expect(assignProcessToJobObject).toHaveBeenCalledWith(50n, 60n)
    expect(resumeThread).toHaveBeenCalledWith(61n)
    expect(createProcessAsUserW).toHaveBeenCalledWith(
      token,
      null,
      'cmd.exe /c exit 0',
      null,
      null,
      1,
      CREATE_SUSPENDED,
      null,
      'C:\\work',
      expect.anything(),
      expect.anything(),
    )
  })

  it('restores already-enabled stdio and closes the Job when inheritance setup fails', () => {
    let calls = 0
    const closeHandle = vi.fn((_handle: NativePtr) => 1)
    const setHandleInformation = vi.fn((_handle: NativePtr, _mask: number, flags: number) => {
      if (flags === 0) return 1
      calls += 1
      return calls === 2 ? 0 : 1
    })
    const { api } = inheritedApi({ closeHandle, setHandleInformation })
    expect(() => spawnInheritedJobProcess(api, {
      command: 'cmd.exe',
      args: [],
      cwd: 'C:\\work',
      token,
    })).toThrow(Win32Error)
    expect(setHandleInformation).toHaveBeenCalledWith(expect.anything(), 1, 0)
    expect(closeHandle).toHaveBeenCalledWith(50n)
  })

  it('captures a GetStdHandle error before Job cleanup changes last-error', () => {
    let lastError = 123
    const { api } = inheritedApi({
      getStdHandle: vi.fn(() => 0n as NativePtr),
      getLastError: vi.fn(() => lastError),
      closeHandle: vi.fn(() => { lastError = 999; return 1 }),
    })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'cmd.exe', args: [], cwd: 'C:\\work', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'GetStdHandle', win32Code: 123 })
  })

  it('captures a CreateProcess error before inheritance restoration changes last-error', () => {
    let lastError = 87
    const { api } = inheritedApi({
      createProcessAsUserW: vi.fn(() => 0),
      getLastError: vi.fn(() => lastError),
      setHandleInformation: vi.fn((_handle, _mask, flags) => {
        if (flags === 0) lastError = 999
        return 1
      }),
      closeHandle: vi.fn(() => { lastError = 998; return 1 }),
    })
    let caught: unknown
    try {
      spawnInheritedJobProcess(api, { command: 'cmd.exe', args: [], cwd: 'C:\\work', token })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'CreateProcessAsUserW', win32Code: 87 })
  })

  it('terminates the suspended process and closes the Job when CreateProcessAsUserW returns a null thread handle', () => {
    const closeHandle = vi.fn((_handle: NativePtr) => 1)
    const terminateProcess = vi.fn(() => 1)
    const { api } = inheritedApi({
      closeHandle,
      terminateProcess,
      createProcessAsUserW: vi.fn((_token, _app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, info) => {
        koffi.encode(info, processInformationType(), {
          hProcess: 60n,
          hThread: 0n,
          dwProcessId: 1234,
          dwThreadId: 0,
        })
        return 1
      }),
    })
    expect(() => spawnInheritedJobProcess(api, {
      command: 'cmd.exe',
      args: [],
      cwd: 'C:\\work',
      token,
    })).toThrow('null process/thread handles')
    expect(terminateProcess).toHaveBeenCalledWith(60n, 1)
    expect(closeHandle).toHaveBeenCalledWith(50n)
    expect(closeHandle).toHaveBeenCalledWith(60n)
  })

})

describe('wait and pipe cleanup', () => {
  const token = 70n as NativePtr

  it('waits when a pipe is temporarily empty before observing EOF', async () => {
    const closeHandle = vi.fn(() => 1)
    let peeks = 0
    const api = {
      peekNamedPipe: vi.fn((_handle, _buffer, _size, _read, available) => {
        peeks += 1
        if (peeks === 1) {
          koffi.encode(available, 'uint32', 0)
          return 1
        }
        return 0
      }),
      getLastError: vi.fn(() => 109),
      closeHandle,
    } as unknown as Win32ProcessBindings
    await expect(drainPipe(api, 80n as NativePtr)).resolves.toEqual(Buffer.alloc(0))
    expect(closeHandle).toHaveBeenCalledWith(80n)
  })

  it('terminates a piped child when CreateProcess returns a null thread handle', () => {
    let nextPipe = 10n
    const terminateProcess = vi.fn(() => 1)
    const closeHandle = vi.fn(() => 1)
    const api = {
      createPipe: vi.fn((readSlot, writeSlot) => {
        koffi.encode(readSlot, PVOID, nextPipe++)
        koffi.encode(writeSlot, PVOID, nextPipe++)
        return 1
      }),
      setHandleInformation: vi.fn(() => 1),
      createProcessAsUserW: vi.fn((_token, _app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, info) => {
        koffi.encode(info, processInformationType(), {
          hProcess: 60n,
          hThread: 0n,
          dwProcessId: 1234,
          dwThreadId: 0,
        })
        return 1
      }),
      terminateProcess,
      closeHandle,
    } as unknown as Win32ProcessBindings
    expect(() => spawnPipedProcess(api, {
      command: 'cmd.exe',
      args: [],
      cwd: 'C:\\work',
      token,
    })).toThrow('null process/thread handles')
    expect(terminateProcess).toHaveBeenCalledWith(60n, 1)
  })
})

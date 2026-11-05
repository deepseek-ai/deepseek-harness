import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@deepseek-ai/dsh-lazy-require')
  vi.resetModules()
})

describe.skipIf(process.platform !== 'linux')('Linux libc execve binding', () => {
  it.each([undefined, 'pipe'] as const)('preserves inherited stdio with control %s and reports execve errno', async (control) => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn((fd: number, command: number) => {
      if (command === 2 || command === 4) return 0
      if (command === 3) return [0x802, 1, 0x801][fd]
      return fd === 7 ? 1 : [1, 0, 5][fd]
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const load = vi.fn(() => ({ func }))
    const errno = vi.fn(() => 2)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    const execve = loadLinuxExecve()
    expect(loadLinuxExecve()).toBe(execve)
    expect(load).toHaveBeenCalledExactlyOnceWith(null)
    expect(func.mock.calls).toEqual([
      ['int execve(const char *pathname, const char **argv, const char **envp)'],
      ['int fcntl(int fd, int cmd, int arg)'],
    ])

    let failure: unknown
    try {
      execve('/missing/tool', ['tool', 'literal arg'], { A: '1', EMPTY: '' }, control)
    } catch (error) {
      failure = error
    }
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 2, 0],
      [1, 1, 0],
      [2, 1, 0],
      [2, 2, 4],
      ...control === 'pipe' ? [[7, 1, 0], [7, 2, 0]] : [],
      [0, 3, 0], [0, 4, 2], [1, 3, 0], [2, 3, 0], [2, 4, 1],
    ])
    expect(nativeExecve).toHaveBeenCalledExactlyOnceWith(
      '/missing/tool',
      ['tool', 'literal arg', null],
      ['A=1', 'EMPTY=', null],
    )
    expect(errno).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({
      code: 'ENOENT',
      errno: -2,
      syscall: 'execve',
      path: '/missing/tool',
    })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("ENOENT: no such file or directory, execve '/missing/tool'")
  })

  it.each([
    { command: 1, calls: [[0, 1, 0]] },
    { command: 2, calls: [[0, 1, 0], [0, 2, 0]] },
    { command: 3, calls: [[0, 1, 0], [1, 1, 0], [2, 1, 0], [0, 3, 0]] },
    { command: 4, calls: [[0, 1, 0], [1, 1, 0], [2, 1, 0], [0, 3, 0], [0, 4, 2]] },
  ])('stops before execve when fcntl command $command fails', async ({ command, calls }) => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn((_fd: number, operation: number, _arg: number) => {
      if (operation === command) return -1
      if (operation === 1) return command === 2 ? 1 : 0
      return 0x802
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve') ? nativeExecve : nativeFcntl)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno: () => 9, load: () => ({ func }) }),
    }))
    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EBADF', errno: -9, syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual(calls)
    expect(nativeExecve).not.toHaveBeenCalled()
  })
})

it.skipIf(process.platform !== 'linux')('passes blocking standard streams to a real native executable after Node initializes them', () => {
  const moduleUrl = new URL('../src/linux-execve.ts', import.meta.url).href
  const script = `import { loadLinuxExecve } from ${JSON.stringify(moduleUrl)};
    void process.stdin; void process.stdout; void process.stderr;
    loadLinuxExecve()('/bin/cat', ['cat', '/proc/self/fdinfo/0', '/proc/self/fdinfo/1', '/proc/self/fdinfo/2'], process.env);`
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  const flags = [...result.stdout.matchAll(/^flags:\s+(\d+)$/gm)].map(match => parseInt(match[1]!, 8))
  expect(flags).toHaveLength(3)
  expect(flags.map(value => value & 0x800)).toEqual([0, 0, 0])
})

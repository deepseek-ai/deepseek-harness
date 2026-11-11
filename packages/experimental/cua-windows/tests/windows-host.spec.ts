/** WSL classification is independent of Windows interoperation and executable preparation. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { prepareWsl, retainWslHelper, windowsHost } from '../src/windows-host.ts'

it('distinguishes Windows Node, WSL Linux Node, and ordinary Linux', () => {
  expect(windowsHost({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu' } })).toBe('windows')
  expect(windowsHost({ platform: 'linux', env: {}, osRelease: '6.6.87-microsoft-standard-WSL2' })).toBe('wsl')
  expect(() => windowsHost({ platform: 'linux', env: {}, osRelease: '6.8.0-generic' })).toThrow('ordinary Linux')
})

function fixture(output = '{"architecture":"arm64","cache":"C:\\\\Users\\\\test user\\\\AppData\\\\Local\\\\DeepSeekHarness\\\\cua"}', exitCode = 0, translated = '/mnt/c/Users/test user/AppData/Local/DeepSeekHarness/cua\n') {
  const terminate = vi.fn(), waitForExit = vi.fn(async () => true)
  const collectedOutput = { available: true }
  const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
    const text = spec.argv[0] === 'wslpath' ? translated : output
    return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: collectedOutput.available
        ? { stdout: { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) } } : {},
      done: Promise.resolve({ exitCode, signal: null }), terminate, waitForExit }
  })
  const spec = { subprocess: { spawn }, signal: new AbortController().signal,
    timeoutMs: 10_000, graceMs: 1000, powershellPath: 'powershell.exe' }
  return { spec, spawn, terminate, waitForExit, collectedOutput }
}

it('uses the Windows architecture and translates the cache without shell interpolation', async () => {
  const f = fixture()
  expect(await prepareWsl(f.spec)).toEqual({ architecture: 'arm64', cacheDirectory: '/mnt/c/Users/test user/AppData/Local/DeepSeekHarness/cua' })
  expect(f.spawn.mock.calls[1]![0].argv).toEqual(['wslpath', '-u', 'C:\\Users\\test user\\AppData\\Local\\DeepSeekHarness\\cua'])
  expect(f.waitForExit).toHaveBeenCalledTimes(2)
})

it.each(['not json', '{"architecture":"ia32","cache":"C:\\\\cache"}', '{"architecture":"x64","cache":"relative"}'])(
  'rejects invalid Windows capability output %s before using it as a path', async (output) => {
    const f = fixture(output)
    await expect(prepareWsl(f.spec)).rejects.toThrow('WSL cannot prepare')
    expect(f.spawn).toHaveBeenCalledOnce()
    expect(f.waitForExit).toHaveBeenCalledOnce()
  },
)

it('reports unavailable interoperation and does not launch path conversion', async () => {
  const f = fixture('', 1)
  await expect(prepareWsl(f.spec)).rejects.toThrow('WSL cannot prepare')
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('rejects canceled preparation before starting a Windows command', async () => {
  const f = fixture(), controller = new AbortController()
  controller.abort(new Error('provider unloaded'))
  await expect(prepareWsl({ ...f.spec, signal: controller.signal })).rejects.toThrow('provider unloaded')
  expect(f.spawn).not.toHaveBeenCalled()
})

it('retains exact helper bytes once and rejects a changed cached executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cua-wsl-cache-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const helper = join(directory, 'source.exe'), signal = new AbortController().signal
  const bytes = Buffer.from('signed payload bytes')
  await writeFile(helper, bytes)
  const result = await retainWslHelper(helper, join(directory, 'cache'), signal)
  expect(await readFile(result)).toEqual(bytes)
  expect(await retainWslHelper(helper, join(directory, 'cache'), signal)).toBe(result)
  await writeFile(result, 'changed')
  await expect(retainWslHelper(helper, join(directory, 'cache'), signal)).rejects.toThrow('digest')
})

it('defaults platform classification to the running Node process', () => {
  const classify = () => windowsHost({ env: {}, osRelease: 'generic' })
  if (process.platform === 'win32') expect(classify()).toBe('windows')
  else expect(classify).toThrow('ordinary Linux')
})

it('rejects a relative WSL cache directory before retaining a helper', async () => {
  const f = fixture(undefined, 0, 'relative')
  await expect(prepareWsl(f.spec)).rejects
    .toHaveProperty('cause.message', 'WSL_INTEROP: wslpath did not return an absolute cache directory')
})

it('reports missing command output and process cleanup failures', async () => {
  const f = fixture()
  f.collectedOutput.available = false
  await expect(prepareWsl(f.spec)).rejects.toHaveProperty('cause.name', 'SyntaxError')
  f.collectedOutput.available = true
  f.waitForExit.mockResolvedValueOnce(false)
  await expect(prepareWsl(f.spec)).rejects.toMatchObject({ cause: { code: 'NATIVE_CLEANUP' } })
})

it('propagates a read failure for an existing cache entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cua-wsl-cache-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source.exe'), signal = new AbortController().signal
  await writeFile(source, 'helper')
  const retained = await retainWslHelper(source, directory, signal)
  await rm(retained)
  await mkdir(retained)
  await expect(retainWslHelper(source, directory, signal)).rejects.toMatchObject({ code: 'EISDIR' })
})

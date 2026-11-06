/** WSL classification is independent of Windows interoperation and executable preparation. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

function fixture(output = '{"architecture":"arm64","cache":"C:\\\\Users\\\\test user\\\\AppData\\\\Local\\\\DeepSeekHarness\\\\cua"}', exitCode = 0) {
  const terminate = vi.fn(), waitForExit = vi.fn(async () => true)
  const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
    const text = spec.argv[0] === 'wslpath' ? '/mnt/c/Users/test user/AppData/Local/DeepSeekHarness/cua\n' : output
    return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout: { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) } },
      done: Promise.resolve({ exitCode, signal: null }), terminate, waitForExit }
  })
  return { spec: { subprocess: { spawn }, signal: new AbortController().signal, timeoutMs: 10_000, graceMs: 1000, powershellPath: 'powershell.exe' }, spawn, terminate, waitForExit }
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

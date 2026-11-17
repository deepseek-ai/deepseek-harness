/** The managed executable: `tmeet` in a configured `binDir`, or the installed platform executable. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { executableFileName, resolveCliExecutable } from '../src/directory.ts'
import { createBinDir } from './harness.ts'

const PLATFORM_EXECUTABLES: Readonly<Partial<Record<string, string>>> = {
  'darwin-arm64': 'tmeet-macOS-AppleSilicon',
  'darwin-x64': 'tmeet-macOS-Intel',
  'linux-arm64': 'tmeet-Linux-ARM64',
  'linux-x64': 'tmeet-Linux-x86_64',
  'win32-x64': 'tmeet-Windows-x86_64.exe',
}
const executable = PLATFORM_EXECUTABLES[`${process.platform}-${process.arch}`]
const PACKAGE_DIST = join(dirname(fileURLToPath(import.meta.resolve('@tencentcloud/tmeet/package.json'))), 'dist')
const FILE = process.platform === 'win32' ? 'tmeet.exe' : 'tmeet'

it('names the executable file with the .exe extension on Windows only', () => {
  expect(executableFileName('win32')).toBe('tmeet.exe')
  expect(executableFileName('darwin')).toBe('tmeet')
})

it.runIf(executable !== undefined)('defaults to the installed platform executable', () => {
  expect(resolveCliExecutable(undefined)).toBe(join(PACKAGE_DIST, executable!))
})

it('names a platform the package ships no executable for', () => {
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  Object.defineProperty(process, 'arch', { ...arch, value: 'fixture-arch' })
  onTestFinished(() => { Object.defineProperty(process, 'arch', arch) })
  expect(() => resolveCliExecutable(undefined))
    .toThrow(`tencent-meeting: @tencentcloud/tmeet has no executable for ${process.platform}-fixture-arch; set binDir`)
})

it('accepts a configured directory and names its missing executable with the remedy', async () => {
  const binDir = await createBinDir()
  const empty = await mkdtemp(join(tmpdir(), 'dsh-tencent-meeting-empty-'))
  onTestFinished(async () => {
    await rm(binDir, { recursive: true, force: true })
    await rm(empty, { recursive: true, force: true })
  })
  expect(resolveCliExecutable(binDir)).toBe(join(binDir, FILE))
  expect(() => resolveCliExecutable(empty))
    .toThrow(`tencent-meeting: ${join(empty, FILE)} is not executable; set binDir to a directory containing an executable ${FILE}`)
})

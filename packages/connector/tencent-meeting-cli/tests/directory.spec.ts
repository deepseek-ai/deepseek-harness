/** The private PATH directory: a configured `binDir`, or a cache link to the installed platform executable. */
import { mkdtemp, readlink, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { resolveCliDirectory } from '../src/directory.ts'
import { createBinDir } from './harness.ts'

const PLATFORM_EXECUTABLES: Readonly<Partial<Record<string, string>>> = {
  'darwin-arm64': 'tmeet-macOS-AppleSilicon',
  'darwin-x64': 'tmeet-macOS-Intel',
  'linux-arm64': 'tmeet-Linux-ARM64',
  'linux-x64': 'tmeet-Linux-x86_64',
}
const executable = PLATFORM_EXECUTABLES[`${process.platform}-${process.arch}`]
const PACKAGE_DIST = join(dirname(fileURLToPath(import.meta.resolve('@tencentcloud/tmeet/package.json'))), 'dist')

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-tencent-meeting-home-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

it.runIf(executable !== undefined)('links the installed platform executable as tmeet in a cache directory and relinks it on every load', async () => {
  const directory = resolveCliDirectory(undefined)
  expect(dirname(directory)).toBe(join(home, 'cache', 'tencent-meeting'))
  expect(basename(directory)).toMatch(/^[0-9a-f]{16}$/u)
  expect(await readlink(join(directory, 'tmeet'))).toBe(join(PACKAGE_DIST, executable!))

  await unlink(join(directory, 'tmeet'))
  await symlink('/nonexistent/tmeet', join(directory, 'tmeet'))
  expect(resolveCliDirectory(undefined)).toBe(directory)
  expect(await readlink(join(directory, 'tmeet'))).toBe(join(PACKAGE_DIST, executable!))
})

it('names a platform the package ships no executable for', () => {
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  Object.defineProperty(process, 'arch', { ...arch, value: 'fixture-arch' })
  onTestFinished(() => { Object.defineProperty(process, 'arch', arch) })
  expect(() => resolveCliDirectory(undefined))
    .toThrow(`tencent-meeting: @tencentcloud/tmeet has no executable for ${process.platform}-fixture-arch; set binDir`)
})

it('accepts a configured directory and names its missing executable with the remedy', async () => {
  const binDir = await createBinDir()
  onTestFinished(() => rm(binDir, { recursive: true, force: true }))
  expect(resolveCliDirectory(binDir)).toBe(binDir)
  expect(() => resolveCliDirectory(home))
    .toThrow(`tencent-meeting: ${join(home, 'tmeet')} is not executable; set binDir to a directory containing an executable tmeet`)
})

import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { executableFileName, resolveCliExecutable } from '../src/directory.ts'

const FILE = process.platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli'

const fs = vi.hoisted(() => ({ accessSync: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), accessSync: fs.accessSync }))

const PLATFORM_PACKAGE = `@wecom/cli-${process.platform}-${process.arch}`
const PACKAGE_BIN = join(
  dirname(createRequire(import.meta.resolve('@wecom/cli/package.json')).resolve(`${PLATFORM_PACKAGE}/package.json`)), 'bin',
)

beforeEach(() => {
  fs.accessSync.mockReset()
})

it('names the executable file with the .exe extension on Windows only', () => {
  expect(executableFileName('win32')).toBe('wecom-cli.exe')
  expect(executableFileName('darwin')).toBe('wecom-cli')
})

it('defaults to the executable in the bin directory of the platform package that @wecom/cli installs', () => {
  expect(resolveCliExecutable(undefined)).toBe(join(PACKAGE_BIN, FILE))
  expect(fs.accessSync).toHaveBeenCalledWith(join(PACKAGE_BIN, FILE), constants.X_OK)
})

it('names the platform package @wecom/cli does not provide', () => {
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  Object.defineProperty(process, 'arch', { ...arch, value: 'fixture-arch' })
  onTestFinished(() => { Object.defineProperty(process, 'arch', arch) })
  expect(() => resolveCliExecutable(undefined))
    .toThrow(`wecom: @wecom/cli-${process.platform}-fixture-arch is not installed; @wecom/cli has no binary for this platform, or set binDir`)
})

it('accepts a configured directory and names the missing executable with the remedy', () => {
  expect(resolveCliExecutable('/opt/wecom/bin')).toBe(join('/opt/wecom/bin', FILE))
  fs.accessSync.mockImplementation(() => { throw new Error('EACCES') })
  expect(() => resolveCliExecutable(PACKAGE_BIN))
    .toThrow(`wecom: ${join(PACKAGE_BIN, FILE)} is not executable; reinstall the plugin or set binDir`)
})

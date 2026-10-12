import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, expect, it, vi } from 'vitest'
import { resolveCliDirectory } from '../src/cli.ts'

const fs = vi.hoisted(() => ({ accessSync: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), accessSync: fs.accessSync }))

const PACKAGE_BIN = join(dirname(fileURLToPath(import.meta.resolve('@larksuite/cli/package.json'))), 'bin')

beforeEach(() => {
  fs.accessSync.mockReset()
})

it('defaults to the installed @larksuite/cli bin directory', () => {
  expect(resolveCliDirectory(undefined)).toBe(PACKAGE_BIN)
  expect(fs.accessSync).toHaveBeenCalledWith(join(PACKAGE_BIN, 'lark-cli'), constants.X_OK)
})

it('accepts a configured directory and names the missing executable with the install remedy', () => {
  expect(resolveCliDirectory('/opt/lark/bin')).toBe('/opt/lark/bin')
  fs.accessSync.mockImplementation(() => { throw new Error('EACCES') })
  expect(() => resolveCliDirectory(PACKAGE_BIN))
    .toThrow(`feishu: ${join(PACKAGE_BIN, 'lark-cli')} is not executable; approve the @larksuite/cli install script or set binDir`)
})

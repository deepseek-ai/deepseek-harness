import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, expect, it, vi } from 'vitest'
import { executableFileName } from '@deepseek-ai/dsh-cli-account'
import { parseJson, resolveCliExecutable } from '../src/cli.ts'

const fs = vi.hoisted(() => ({ accessSync: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), accessSync: fs.accessSync }))

const PACKAGE_BIN = join(dirname(fileURLToPath(import.meta.resolve('@larksuite/cli/package.json'))), 'bin')
const FILE = executableFileName('lark-cli')

beforeEach(() => {
  fs.accessSync.mockReset()
})

it('defaults to the executable in the installed @larksuite/cli bin directory', () => {
  expect(resolveCliExecutable(undefined)).toBe(join(PACKAGE_BIN, FILE))
  expect(fs.accessSync).toHaveBeenCalledWith(join(PACKAGE_BIN, FILE), constants.X_OK)
})

it('accepts a configured directory and names the missing executable with the install remedy', () => {
  expect(resolveCliExecutable('/opt/lark/bin')).toBe(join('/opt/lark/bin', FILE))
  fs.accessSync.mockImplementation(() => { throw new Error('EACCES') })
  expect(() => resolveCliExecutable(PACKAGE_BIN))
    .toThrow(`feishu: ${join(PACKAGE_BIN, FILE)} is not executable; approve the @larksuite/cli install script or set binDir`)
})

it('parses a command\'s JSON output and names the command whose output is not JSON', () => {
  expect(parseJson(['auth', 'status'], '{"ok":false}')).toEqual({ ok: false })
  expect(() => parseJson(['auth', 'status'], '')).toThrow('lark-cli auth status returned invalid JSON')
})

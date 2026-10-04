/** User decisions cross a real worker process; the worker replaces only the OS mutation boundary. */

import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { ExecFileOptions } from 'node:child_process'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { DesktopCommandManager } from '../src/command-management.ts'
import { en, zh, type DesktopMessages } from '../src/locale.ts'

const external = vi.hoisted(() => ({ shell: null as string | null, cancelAuthorization: false, elevations: 0 }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), shell: external.shell }) }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = promisify(actual.execFile)
  const invoke = async (file: string, args: string[], options: ExecFileOptions) => {
    if (file !== '/usr/bin/osascript') return execute(file, args, options)
    external.elevations++
    // Exercise AppleScript's real stdout/error transport without authorizing an OS mutation.
    return execute(file, external.cancelAuthorization ? ['-e', 'error number -128']
      : ['-e', args[1]!.replace(' with administrator privileges', ''), ...args.slice(2)], options)
  }
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: invoke }) }
})

afterEach(() => { external.shell = null; external.cancelAuthorization = false; external.elevations = 0 })

async function fixture(options: {
  failure?: string
  managed?: boolean
  shadowed?: boolean
  elevate?: boolean
  messages?: DesktopMessages
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-command-dialog-'))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const resources = join(root, 'resources')
  const bin = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin')
  const worker = join(resources, 'runtime', 'cli')
  await mkdir(bin, { recursive: true })
  await mkdir(worker, { recursive: true })
  const node = join(bin, process.platform === 'win32' ? 'node.exe' : 'node')
  if (process.platform === 'win32') await copyFile(process.execPath, node)
  else await symlink(process.execPath, node)
  await writeFile(join(worker, 'package.json'), '{"type":"module"}\n')
  const state = {
    fingerprint: 'a'.repeat(64), managed: options.managed ?? false, available: true, kind: options.managed ? 'symlink' : 'file',
    destination: join(root, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
    directory: root, launcher: join(root, 'desktop-dsh'),
    activeCommand: options.managed && !options.shadowed ? join(root, process.platform === 'win32' ? 'dsh.cmd' : 'dsh') : join(root, 'other-dsh'),
  }
  if (process.platform === 'darwin') {
    const shell = join(root, 'lookup-shell')
    await writeFile(shell, '#!/bin/sh\nprintf "\\0DSH_COMMAND\\0"\ncat "$(dirname "$0")/selected-command"\nprintf "\\0"\n', { mode: 0o755 })
    await writeFile(join(root, 'selected-command'), state.activeCommand + '\n')
    external.shell = shell
  }
  await writeFile(join(worker, 'state.json'), JSON.stringify({ state, failure: options.failure, elevate: options.elevate }))
  await writeFile(join(worker, 'command-manager.js'), [
    "import { readFileSync, appendFileSync, existsSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const { state, failure, elevate } = JSON.parse(readFileSync(join(import.meta.dirname, 'state.json'), 'utf8'))",
    'const operation = process.argv[2]',
    "const calls = join(import.meta.dirname, 'calls.jsonl')",
    "const attempted = existsSync(calls) && readFileSync(calls, 'utf8').includes('install')",
    "appendFileSync(join(import.meta.dirname, 'calls.jsonl'), JSON.stringify({operation, expected:process.argv[3]})+'\\n')",
    "if (operation === 'install' && elevate && !attempted) {",
    "  process.stdout.write(JSON.stringify({ok:false,code:'EACCES',message:'authorization required'}))",
    "} else if (operation === 'install' && failure) {",
    "  process.stdout.write(JSON.stringify({ok:false,code:failure,message:'worker declined'}))",
    '} else {',
    '  process.stdout.write(JSON.stringify({ok:true,state}))',
    '}',
    '',
  ].join('\n'))
  const show = vi.fn<(options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>()
  const manager = new DesktopCommandManager({
    resources, isPackaged: true, isInstalledLocation: () => true, isInstalling: () => false, isQuitting: () => false,
    messages: () => options.messages ?? en, show,
  })
  const calls = async (): Promise<Array<{ operation: string; expected?: string }>> =>
    (await readFile(join(worker, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { operation: string; expected?: string })
  return { manager, show, calls }
}

it('requires confirmation before replacing an existing command', async () => {
  const f = await fixture()
  f.show.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
  await f.manager.show()
  expect(f.show.mock.calls[1]![0]).toMatchObject({ message: en.cliCommandSwitch, defaultId: 1, cancelId: 1 })
  expect(await f.calls()).toEqual([{ operation: 'inspect' }])
})

it('passes the displayed fingerprint and reports a stale worker refusal', async () => {
  const f = await fixture({ failure: 'ESTALE' })
  f.show.mockResolvedValue({ response: 0, checkboxChecked: false })
  await f.manager.show()
  expect(await f.calls()).toEqual([{ operation: 'inspect' }, { operation: 'install', expected: 'a'.repeat(64) }])
  expect(f.show.mock.lastCall![0].message).toBe(en.cliCommandChanged)
})

it.each([['en-US', en], ['zh-CN', zh]] as const)('repairs its own selected command without a switch confirmation in %s', async (locale, messages) => {
  const f = await fixture({ managed: true, messages })
  f.show.mockResolvedValueOnce({ response: 1, checkboxChecked: false }).mockResolvedValue({ response: 0, checkboxChecked: false })
  await f.manager.show()
  expect(await f.calls()).toEqual([{ operation: 'inspect' }, { operation: 'install', expected: 'a'.repeat(64) }, { operation: 'inspect' }])
  await expect(JSON.stringify(f.show.mock.calls.map(([options]) => ({ message: options.message, buttons: options.buttons })), null, 2) + '\n')
    .toMatchFileSnapshot(join(import.meta.dirname, 'expected', `command-repair-${locale}.json`))
})

it('keeps confirmation when repairing a command shadowed by another installation', async () => {
  const f = await fixture({ managed: true, shadowed: true })
  f.show.mockResolvedValue({ response: 1, checkboxChecked: false })
  await f.manager.show()
  expect(f.show.mock.calls[1]![0].message).toBe(en.cliCommandSwitch)
  expect(await f.calls()).toEqual([{ operation: 'inspect' }])
})

it.skipIf(process.platform !== 'darwin')('keeps a declined worker response through the AppleScript transport', async () => {
  const f = await fixture({ failure: 'ESTALE', elevate: true })
  f.show.mockResolvedValue({ response: 0, checkboxChecked: false })
  await f.manager.show()
  expect(external.elevations).toBe(1)
  expect(await f.calls()).toEqual([{ operation: 'inspect' }, { operation: 'install', expected: 'a'.repeat(64) }, { operation: 'install', expected: 'a'.repeat(64) }])
  expect(f.show.mock.lastCall![0]).toMatchObject({ message: en.cliCommandChanged, technicalDetails: 'worker declined' })
})

it.skipIf(process.platform !== 'darwin')('returns without an error dialog when administrator authorization is cancelled', async () => {
  const f = await fixture({ elevate: true })
  external.cancelAuthorization = true
  f.show.mockResolvedValue({ response: 0, checkboxChecked: false })
  await f.manager.show()
  expect(external.elevations).toBe(1)
  expect(f.show).toHaveBeenCalledTimes(2)
  expect(await f.calls()).toEqual([{ operation: 'inspect' }, { operation: 'install', expected: 'a'.repeat(64) }])
})

it('coalesces repeated menu clicks and keeps update preparation waiting for the active decision', async () => {
  const f = await fixture()
  const shown = Promise.withResolvers<undefined>()
  const choice = Promise.withResolvers<MessageBoxReturnValue>()
  f.show.mockImplementation(() => { shown.resolve(undefined); return choice.promise })
  const first = f.manager.show()
  expect(f.manager.show()).toBe(first)
  await shown.promise
  let idle = false
  const waiting = f.manager.idle().then(() => { idle = true })
  await Promise.resolve()
  expect(idle).toBe(false)
  choice.resolve({ response: 1, checkboxChecked: false })
  await Promise.all([first, waiting])
  expect(idle).toBe(true)
  expect(await f.calls()).toEqual([{ operation: 'inspect' }])
})

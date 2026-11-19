/** The managed lark-cli: where it is, whether it is in place, and the install script that downloads a missing one. */
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { executableFileName, LarkCli, parseJson } from '../src/cli.ts'
import { ScriptedSubprocess, type CliReply } from './harness.ts'

const fs = vi.hoisted(() => ({ accessSync: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), accessSync: fs.accessSync }))

const PACKAGE = dirname(fileURLToPath(import.meta.resolve('@larksuite/cli/package.json')))
const FILE = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'
const EXECUTABLE = join(PACKAGE, 'bin', FILE)
const INSTALLER = join(PACKAGE, 'scripts', 'install.js')
const CONFIGURED = join('/opt/lark/bin', FILE)

let ctx: Context
let subprocess: ScriptedSubprocess
/** Whether the executable is in place. */
let present: boolean

beforeEach(async () => {
  present = false
  fs.accessSync.mockReset()
  fs.accessSync.mockImplementation(() => { if (!present) throw new Error('ENOENT') })
  ctx = new Context()
  await ctx.plugin(ScriptedSubprocess)
  subprocess = ctx.subprocess as ScriptedSubprocess
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

const warnings = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'warn').map((message): unknown => message.args)
/** Answer the install script with `reply`; `installs` says whether it left the executable in place. */
const script = (reply: CliReply, installs: boolean): void => {
  subprocess.respond = (process) => {
    present = installs
    process.reply(reply)
  }
}

it('names the executable file with the .exe extension on Windows only', () => {
  expect(executableFileName('win32')).toBe('lark-cli.exe')
  expect(executableFileName('darwin')).toBe('lark-cli')
})

it('locates the executable in the installed @larksuite/cli package, whether or not it is there yet', () => {
  const cli = new LarkCli(undefined, subprocess, ctx.logger)
  expect(cli.executable).toBe(EXECUTABLE)
  expect(cli.installed()).toBe(false)
  expect(fs.accessSync).toHaveBeenCalledWith(EXECUTABLE, constants.X_OK)
  present = true
  expect(cli.installed()).toBe(true)
})

it('requires the executable in a configured directory and names the missing one', () => {
  present = true
  expect(new LarkCli('/opt/lark/bin', subprocess, ctx.logger).executable).toBe(CONFIGURED)
  present = false
  expect(() => new LarkCli('/opt/lark/bin', subprocess, ctx.logger))
    .toThrow(`feishu: ${CONFIGURED} is not executable; set binDir to a directory containing an executable ${FILE}`)
})

it('downloads a missing executable by running the package\'s install script with this Node', async () => {
  script({}, true)
  const { signal } = new AbortController()

  await new LarkCli(undefined, subprocess, ctx.logger).install(signal)

  expect(subprocess.processes.map(process => process.spec)).toEqual([{
    argv: [process.execPath, INSTALLER], cwd: homedir(), env: { LARK_CLI_RUN: 'true' },
    stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
    graceMs: 2_000, signal,
  }])
  expect(subprocess.processes[0]?.terminated).toBe(true)
  expect(warnings()).toEqual([])
})

it('accepts an executable that is in place although the script failed', async () => {
  script({ exitCode: 1, stderr: 'Failed to install lark-cli: EEXIST\n' }, true)
  await new LarkCli(undefined, subprocess, ctx.logger).install(new AbortController().signal)
  expect(warnings()).toEqual([])
})

it.each<[string, CliReply, string, string]>([
  ['fails', { exitCode: 1, stderr: 'Failed to install lark-cli: timeout\n\n' }, '1', '\nFailed to install lark-cli: timeout'],
  ['exits without downloading', {}, '0', ''],
  ['is killed', { exitCode: null, signal: 'SIGKILL' }, 'SIGKILL', ''],
])('rejects and logs one warning with the exit and error output when the script %s', async (_name, reply, exit, output) => {
  script(reply, false)
  const message = `feishu: ${INSTALLER} exited with ${exit} and left no executable ${EXECUTABLE}${output}`

  await expect(new LarkCli(undefined, subprocess, ctx.logger).install(new AbortController().signal)).rejects.toThrow(new Error(message))

  expect(warnings()).toEqual([['feishu: could not download lark-cli', new Error(message)]])
  expect(subprocess.processes[0]?.terminated).toBe(true)
})

it('stops the script on abort and rejects with the abort reason, without a warning', async () => {
  subprocess.respond = () => {}
  const controller = new AbortController()
  const reason = new Error('cancelled')

  const installing = new LarkCli(undefined, subprocess, ctx.logger).install(controller.signal)
  controller.abort(reason)

  await expect(installing).rejects.toBe(reason)
  expect(subprocess.processes[0]?.terminated).toBe(true)
  expect(warnings()).toEqual([])
})

it('never downloads into a configured directory that lost its executable', async () => {
  present = true
  const cli = new LarkCli('/opt/lark/bin', subprocess, ctx.logger)
  present = false

  await expect(cli.install(new AbortController().signal)).rejects.toThrow(`feishu: ${CONFIGURED} is not executable`)

  expect(subprocess.processes).toEqual([])
  expect(warnings()).toHaveLength(1)
})

it('parses a command\'s JSON output and names the command whose output is not JSON', () => {
  expect(parseJson(['auth', 'status'], '{"ok":false}')).toEqual({ ok: false })
  expect(() => parseJson(['auth', 'status'], '')).toThrow('lark-cli auth status returned invalid JSON')
})

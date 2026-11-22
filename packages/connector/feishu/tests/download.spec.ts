/** A Feishu plugin loaded without lark-cli downloads it by itself, shows the step, and leaves a retry when the download does not finish. */
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { cliPathContextText } from '@deepseek-ai/dsh-cli-account/src/context.ts'
import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { executableFileName } from '../src/cli.ts'
import * as Feishu from '../src/index.ts'
import { en, zh, type FeishuTextKey } from '../src/locales.ts'
import type { FeishuAppId, FeishuState } from '../src/types.ts'
import { createHost, type CliReply, type FeishuHost, type FeishuPage, type ScriptedProcess } from './harness.ts'

const fs = vi.hoisted(() => ({ accessSync: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), accessSync: fs.accessSync }))

const PACKAGE = dirname(fileURLToPath(import.meta.resolve('@larksuite/cli/package.json')))
const EXECUTABLE = join(PACKAGE, 'bin', executableFileName(process.platform))
const INSTALLER = join(PACKAGE, 'scripts', 'install.js')
const STATUS = 'auth status --verify --json'
const APP = 'cli_a' as FeishuAppId
const SIGNED_OUT: CliReply = { stdout: JSON.stringify({ appId: APP, identities: { user: { status: 'missing', available: false } } }) }
const CHECK = { kind: 'start', operation: 'check' } as const

/** The key's text as the Chinese and English browsers resolve it. */
const say = (key: FeishuTextKey): Partial<Record<string, string>> => ({ zh: zh[key], en: en[key] })

let host: FeishuHost
let ctx: Context
/** Whether lark-cli is in the `@larksuite/cli` package; the specs never write there. */
let present: boolean
/** How the install script and `auth status` answer. */
let install: (process: ScriptedProcess) => void
let status: (process: ScriptedProcess) => void

beforeEach(async () => {
  present = false
  fs.accessSync.mockReset()
  fs.accessSync.mockImplementation(() => { if (!present) throw new Error('ENOENT') })
  host = await createHost()
  ;({ ctx } = host)
  status = (process) => { process.reply(SIGNED_OUT) }
  host.subprocess.respond = (process) => {
    if (process.spec.argv[1] === INSTALLER) install(process)
    else status(process)
  }
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(host.binDir, { recursive: true, force: true })
})

/** Load the plugin without `binDir`, so it manages the executable of the `@larksuite/cli` package. */
const load = async (): Promise<FeishuPage> => {
  await ctx.plugin(Feishu, {})
  return host.pages[0]!
}
const commands = () => host.subprocess.processes.map(process => process.spec.argv.slice(1).join(' '))
const warnings = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'warn').map((message): unknown => message.args)
const runtimeContext = async () => renderContextSections(await ctx.systemPrompt.assemble())
const skills = async () => (await ctx.skills.list()).map(skill => skill.name)
const settled = async (account: FeishuPage['source']): Promise<FeishuState> => {
  await vi.waitFor(() => { expect(account.snapshot().result).toBeDefined() })
  return account.snapshot()
}

it('downloads a missing lark-cli after loading, then checks the account and offers the CLI path and the skill', async () => {
  const downloading = Promise.withResolvers<ScriptedProcess>()
  const checking = Promise.withResolvers<ScriptedProcess>()
  install = (process) => { downloading.resolve(process) }
  status = (process) => { checking.resolve(process) }

  const page = await load()
  const account = page.source
  const id = account.snapshot().operation?.id
  expect(account.snapshot()).toEqual({ account: { state: 'unchecked' }, operation: { id, kind: 'check', phase: 'downloading', cancellable: true } })
  expect(page.present(account.snapshot())).toMatchObject({
    phase: 'checking', status: say('step.downloading'), buttons: [{ label: say('action.cancel'), command: { kind: 'cancel' } }],
  })
  expect(await runtimeContext()).toEqual([])
  expect(await skills()).toEqual([])

  present = true
  ;(await downloading.promise).reply({})
  const check = await checking.promise
  expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'checking', cancellable: false })
  check.reply(SIGNED_OUT)

  expect(await settled(account)).toEqual({ account: { state: 'signed-out', appId: APP }, result: { id, kind: 'check', outcome: 'succeeded' } })
  expect(commands()).toEqual([INSTALLER, STATUS])
  expect(await runtimeContext()).toEqual([{
    name: 'feishu:cli',
    text: cliPathContextText({ product: 'Feishu', program: 'lark-cli', executable: EXECUTABLE }, process.platform),
  }])
  expect(await skills()).toEqual(['feishu'])
  expect(warnings()).toEqual([])
})

it('reports a failed download with a retry, logs the script\'s error output, and downloads again on retry', async () => {
  install = (process) => { process.reply({ exitCode: 1, stderr: 'Failed to install lark-cli: timeout\n' }) }

  const page = await load()
  const account = page.source
  const failed = await settled(account)
  expect(failed).toMatchObject({ account: { state: 'not-installed' }, result: { kind: 'check', outcome: 'failed' } })
  expect(failed.result).not.toHaveProperty('failure')
  expect(page.present(failed)).toMatchObject({
    phase: 'unavailable', status: say('status.unavailable'), detail: say('detail.missing'), failure: { text: say('failed') },
    buttons: [{ label: say('action.retry'), command: CHECK }],
  })
  expect(warnings()).toEqual([[
    'feishu: could not download lark-cli',
    new Error(`feishu: ${INSTALLER} exited with 1 and left no executable ${EXECUTABLE}\nFailed to install lark-cli: timeout`),
  ]])
  expect(await skills()).toEqual([])

  install = (process) => {
    present = true
    process.reply({})
  }
  const retry = await account.start('check')
  await vi.waitFor(() => { expect(account.snapshot().result).toEqual({ id: retry, kind: 'check', outcome: 'succeeded' }) })
  expect(account.snapshot().account).toEqual({ state: 'signed-out', appId: APP })
  expect(commands()).toEqual([INSTALLER, INSTALLER, STATUS])
  expect(warnings()).toHaveLength(1)
  expect(await skills()).toEqual(['feishu'])
})

it('cancels the download from the page without a warning and leaves the retry', async () => {
  install = () => {}
  const page = await load()
  const account = page.source
  const id = account.snapshot().operation!.id
  expect(await skills()).toEqual([])

  await account.cancel(id)

  expect(account.snapshot()).toEqual({ account: { state: 'not-installed' }, result: { id, kind: 'check', outcome: 'cancelled' } })
  expect(page.present(account.snapshot()).buttons).toMatchObject([{ label: say('action.retry'), command: CHECK }])
  expect(host.subprocess.processes[0]?.terminated).toBe(true)
  expect(commands()).toEqual([INSTALLER])
  expect(warnings()).toEqual([])
  expect(await skills()).toEqual([])
})

it('offers the skill once a cancelled download has left lark-cli in place, and the retry starts no download', async () => {
  install = () => {}
  const page = await load()
  const account = page.source
  const id = account.snapshot().operation!.id
  expect(await skills()).toEqual([])

  // The install script copied the binary and has not exited yet.
  present = true
  await account.cancel(id)

  expect(account.snapshot()).toEqual({ account: { state: 'not-installed' }, result: { id, kind: 'check', outcome: 'cancelled' } })
  expect(await skills()).toEqual(['feishu'])

  const retry = await account.start('check')
  await vi.waitFor(() => { expect(account.snapshot().result).toEqual({ id: retry, kind: 'check', outcome: 'succeeded' }) })
  expect(account.snapshot().account).toEqual({ state: 'signed-out', appId: APP })
  expect(commands()).toEqual([INSTALLER, STATUS])
  expect(await skills()).toEqual(['feishu'])
})

it('offers the skill at the retry after lark-cli was installed outside the plugin\'s download, and starts no download', async () => {
  install = (process) => { process.reply({ exitCode: 1 }) }
  const page = await load()
  const account = page.source
  await settled(account)
  expect(await skills()).toEqual([])

  // The user ran the install script in a terminal.
  present = true
  const retry = await account.start('check')
  await vi.waitFor(() => { expect(account.snapshot().result).toEqual({ id: retry, kind: 'check', outcome: 'succeeded' }) })

  expect(account.snapshot().account).toEqual({ state: 'signed-out', appId: APP })
  expect(commands()).toEqual([INSTALLER, STATUS])
  expect(await skills()).toEqual(['feishu'])
})

it.each([
  ['the retry downloaded lark-cli', false, [INSTALLER, INSTALLER, STATUS]],
  ['lark-cli was installed outside the plugin\'s download', true, [INSTALLER, STATUS]],
])('stops reporting a missing download when `auth status` fails after %s', async (_path, outside, ran) => {
  install = (process) => { process.reply({ exitCode: 1 }) }
  status = (process) => { process.reply({ exitCode: 3 }) }
  const page = await load()
  const account = page.source
  expect(await settled(account)).toMatchObject({ account: { state: 'not-installed' } })

  present = outside
  install = (process) => {
    present = true
    process.reply({})
  }
  const retry = await account.start('check')

  const failure = { command: 'auth-status', exitCode: 3 }
  await vi.waitFor(() => { expect(account.snapshot().result).toEqual({ id: retry, kind: 'check', outcome: 'failed', failure }) })
  expect(account.snapshot().account).toEqual({ state: 'unchecked' })
  expect(page.present(account.snapshot())).toMatchObject({
    phase: 'unavailable', status: say('status.unavailable'), detail: say('detail.unavailable'),
    failure: { text: say('failed'), details: ['auth-status', 'exit 3'] }, buttons: [{ label: say('action.retry'), command: CHECK }],
  })
  expect(commands()).toEqual(ran)
})

it('stops the download when the plugin unloads', async () => {
  install = () => {}
  const fiber = await ctx.plugin(Feishu, {})
  expect(commands()).toEqual([INSTALLER])

  await fiber.dispose()

  expect(host.subprocess.processes[0]?.terminated).toBe(true)
  expect(warnings()).toEqual([])
})

it('starts nothing at load when the package\'s install script already put lark-cli in place', async () => {
  present = true
  const page = await load()

  expect(page.source.snapshot()).toEqual({ account: { state: 'unchecked' } })
  expect(host.subprocess.processes).toEqual([])
  expect(await skills()).toEqual(['feishu'])
})

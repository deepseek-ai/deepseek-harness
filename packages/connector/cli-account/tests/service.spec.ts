/** `ctx.cliAccounts` registers a plugin's CLI and account in one call and withdraws both when that plugin unloads. */
import { Context } from '@deepseek-ai/cordis'
import ConnectorAccounts from '@deepseek-ai/dsh-client-ui-connector-account'
import type { ConnectorAccountEntry } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { cliPathContextText } from '../src/context.ts'
import CliAccounts, { type CliAccountHandle, type CliAccountRegistration } from '../src/index.ts'
import { EXECUTABLE, PROGRAM, ScriptedSubprocess, type ScriptedProcess } from './harness.ts'

interface Account { readonly state: 'unchecked' | 'not-installed' | 'signed-out' | 'signed-in' }
type Kind = 'check' | 'connect'
type Phase = 'downloading' | 'authorizing'
type Command = 'status' | 'login'

const DICTIONARIES = {
  en: { title: 'Fixture account', hint: 'Shared with the terminal.', connect: 'Connect', connected: 'Connected', disconnected: 'Not connected', failed: 'Sign in from a terminal.' },
  zh: { title: '演示账号', hint: '与终端共用。', connect: '连接', connected: '已连接', disconnected: '未连接', failed: '请在终端登录。' },
}
type Key = keyof typeof DICTIONARIES.en
type Registration = CliAccountRegistration<Account, Kind, Phase, Command, Key>
type Handle = CliAccountHandle<Account, Kind, Phase, Command>

const PACKAGE = '@acme/fixture'
const CLI = { product: 'Fixture', program: PROGRAM, executable: EXECUTABLE }
const CLI_CONTEXT = { name: 'fixture:cli', text: cliPathContextText(CLI, process.platform) }

/** One dictionary key as the page receives it. */
const both = (key: Key) => ({ en: DICTIONARIES.en[key], zh: DICTIONARIES.zh[key] })

const COPY = { title: both('title'), hint: both('hint'), activation: { title: both('title'), body: both('hint'), connect: both('connect') } }
const CONNECTED = { phase: 'connected', status: both('connected'), buttons: [], notes: [] }
const DISCONNECTED = {
  phase: 'disconnected', status: both('disconnected'), notes: [],
  buttons: [{ label: both('connect'), command: { kind: 'start', operation: 'connect' }, variant: 'primary' }],
}

/** Checks by running `status`, whose stdout names the account state. */
const REGISTRATION: Registration = {
  name: 'fixture',
  packageName: PACKAGE,
  cli: CLI,
  account: { state: 'unchecked' },
  check: 'check',
  cancellable: ['authorizing'],
  authorizationHosts: ['example.com'],
  perform: async (_kind, control, signal) => {
    const result = await control.run('status', ['status'], signal)
    if (result.exitCode !== 0) throw new Error('status failed')
    control.publish({ state: result.stdout.trim() === 'in' ? 'signed-in' : 'signed-out' })
  },
  dictionaries: DICTIONARIES,
  operations: text => [{ kind: 'check' }, { kind: 'connect', notice: text('connected') }],
  copy: text => ({ title: text('title'), hint: text('hint'), activation: { title: text('title'), body: text('hint'), connect: text('connect') } }),
  present: (view, text) => view.account.state === 'signed-in'
    ? { phase: 'connected', status: text('connected'), buttons: [], notes: [] }
    : {
      phase: 'disconnected', status: text('disconnected'), notes: [],
      buttons: [{ label: text('connect'), command: { kind: 'start', operation: 'connect' }, variant: 'primary' }],
      ...view.result?.outcome === 'failed' ? { failure: { text: text('failed') } } : {},
    },
}

/** A Host with the Service and what it injects; `page: false` leaves the Plugins page registry unloaded. */
async function host({ page = true, commandTimeoutMs = 5_000 } = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(ScriptedSubprocess)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
  if (page) await ctx.plugin(ConnectorAccounts)
  await ctx.plugin(CliAccounts, { commandTimeoutMs })
  return { ctx, subprocess: ctx.subprocess as ScriptedSubprocess }
}

/** Load an app plugin whose entry registers one account, as each CLI app plugin does. */
async function app(ctx: Context, registration: Registration = REGISTRATION) {
  let handle!: Handle
  const fiber = await ctx.plugin(Object.assign((inner: Context) => { handle = inner.cliAccounts.register(registration) }, { inject: ['cliAccounts'] }))
  return { fiber, handle }
}

/** Follow the accounts as a Plugins page does, which checks each of them. @returns a reader of the latest accounts. */
function follow(ctx: Context): () => readonly ConnectorAccountEntry[] {
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  let accounts: readonly ConnectorAccountEntry[] = []
  void (async () => { for await (const view of ctx.connectorAccounts.watch(controller.signal)) accounts = view.accounts })()
  return () => accounts
}

async function requiredContext(ctx: Context) {
  return renderContextSections(await ctx.systemPrompt.assemble())
}

/**
 * A registration with a prepare step that a test ends: `finish` puts everything in place, `fail` rejects the step, and
 * an aborted signal rejects it with the signal's reason.
 */
function preparing() {
  const step: PromiseWithResolvers<void> = Promise.withResolvers()
  let ready = false
  const run = vi.fn(async (signal: AbortSignal) => {
    signal.addEventListener('abort', () => { step.reject(signal.reason) }, { once: true })
    await step.promise
    ready = true
  })
  const registration: Registration = {
    ...REGISTRATION,
    cancellable: ['downloading', 'authorizing'],
    prepare: { phase: 'downloading', unprepared: { state: 'not-installed' }, ready: () => ready, run },
  }
  return { registration, run, finish: () => { step.resolve() }, fail: () => { step.reject(new Error('download failed')) } }
}

describe('Config', () => {
  it('defaults the command deadline to 30 seconds', () => {
    expect(CliAccounts.Config({})).toEqual({ commandTimeoutMs: 30_000 })
    expect(CliAccounts.Config({ commandTimeoutMs: 1 })).toEqual({ commandTimeoutMs: 1 })
  })

  it.each([
    [{ commandTimeoutMs: 0 }],
    [{ commandTimeoutMs: 2 ** 31 }],
  ])('rejects an unusable deadline %#', (config) => {
    expect(() => CliAccounts.Config(config)).toThrow()
  })
})

describe('register', () => {
  it('names the CLI by its absolute path in required runtime context', async () => {
    const { ctx } = await host()

    await app(ctx)

    expect(await requiredContext(ctx)).toEqual([CLI_CONTEXT])
  })

  it('shows the account on the Plugins page in the plugin\'s words and updates it as an operation publishes', async () => {
    const { ctx, subprocess } = await host()
    let status!: ScriptedProcess
    subprocess.respond = (process) => { status = process }
    const { handle } = await app(ctx)

    const page = follow(ctx)

    await vi.waitFor(() => { expect(status).toBeDefined() })
    const checking = { id: handle.snapshot().operation?.id }
    expect(page()).toEqual([{ key: PACKAGE, packageName: PACKAGE, copy: COPY, display: DISCONNECTED, operation: checking }])
    status.reply({ stdout: 'in\n' })
    await vi.waitFor(() => { expect(page()[0]?.display).toEqual(CONNECTED) })

    subprocess.respond = (process) => { process.reply({ stdout: 'in\n' }) }
    const id = await ctx.connectorAccounts.start(PACKAGE, 'connect')
    await vi.waitFor(() => { expect(page()[0]?.result).toEqual({ id, notice: both('connected') }) })
    expect(subprocess.processes.map(process => process.spec.argv)).toEqual([[EXECUTABLE, 'status'], [EXECUTABLE, 'status']])
  })

  it('adds the failed command and its exit code to the failure the plugin presents', async () => {
    const { ctx, subprocess } = await host()
    subprocess.respond = (process) => { process.reply({ exitCode: 3, stderr: 'token=secret-token' }) }
    await app(ctx)

    const page = follow(ctx)

    await vi.waitFor(() => { expect(page()[0]?.display).toEqual({ ...DISCONNECTED, failure: { text: both('failed'), details: ['status', 'exit 3'] } }) })
  })

  it('leaves a failure as the plugin presents it when the operation ran no command', async () => {
    const { ctx } = await host()
    await app(ctx, { ...REGISTRATION, perform: () => Promise.reject(new Error('bad state')) })

    const page = follow(ctx)

    await vi.waitFor(() => { expect(page()[0]?.display).toEqual({ ...DISCONNECTED, failure: { text: both('failed') } }) })
  })

  it('calls perform as a method of the registration', async () => {
    const { ctx } = await host()
    const registration: Registration & { readonly observed: Account } = {
      ...REGISTRATION,
      observed: { state: 'signed-in' },
      perform(_kind, control) {
        control.publish(this.observed)
        return Promise.resolve()
      },
    }
    const { handle } = await app(ctx, registration)

    handle.refresh()

    await vi.waitFor(() => { expect(handle.snapshot().account).toEqual({ state: 'signed-in' }) })
  })

  it('applies the Service\'s command deadline to the registered CLI', async () => {
    const { ctx, subprocess } = await host({ commandTimeoutMs: 20 })
    subprocess.respond = () => {}
    const { handle } = await app(ctx)

    handle.refresh()

    await vi.waitFor(() => { expect(handle.snapshot().result).toMatchObject({ outcome: 'failed', failure: { command: 'status', exitCode: null } }) })
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })

  it('lets the plugin read, replace, and recheck its account through the handle', async () => {
    const { ctx, subprocess } = await host()
    subprocess.respond = (process) => { process.reply({ stdout: 'out\n' }) }
    const { handle } = await app(ctx)
    expect(handle.snapshot()).toEqual({ account: { state: 'unchecked' } })
    const page = follow(ctx)
    await vi.waitFor(() => { expect(handle.snapshot().account).toEqual({ state: 'signed-out' }) })

    handle.publish({ state: 'signed-in' })
    expect(handle.snapshot().account).toEqual({ state: 'signed-in' })
    await vi.waitFor(() => { expect(page()[0]?.display).toEqual(CONNECTED) })

    handle.refresh()
    expect(handle.snapshot().operation).toMatchObject({ kind: 'check', phase: 'checking' })
    await vi.waitFor(() => { expect(page()[0]?.display).toEqual(DISCONNECTED) })
  })

  it('registers without the Plugins page registry and shows the account once the registry loads', async () => {
    const { ctx } = await host({ page: false })
    const { handle } = await app(ctx)
    expect(await requiredContext(ctx)).toEqual([CLI_CONTEXT])
    expect(handle.snapshot()).toEqual({ account: { state: 'unchecked' } })

    await ctx.plugin(ConnectorAccounts)
    const page = follow(ctx)

    await vi.waitFor(() => { expect(page().map(entry => entry.key)).toEqual([PACKAGE]) })
  })

  it('refuses a second registration under one name and keeps the first', async () => {
    const { ctx } = await host()
    await app(ctx)
    const page = follow(ctx)
    await vi.waitFor(() => { expect(page()).toHaveLength(1) })

    expect(() => ctx.cliAccounts.register({ ...REGISTRATION, packageName: '@acme/other' })).toThrow('prompt context "fixture:cli" is already registered')

    expect(await requiredContext(ctx)).toEqual([CLI_CONTEXT])
    expect(page().map(entry => entry.key)).toEqual([PACKAGE])
  })

  it('withdraws the account when the registering plugin unloads: off the page, then its processes stopped, then out of context', async () => {
    const { ctx, subprocess } = await host()
    subprocess.respond = (process) => { process.holdExit = true }
    const { fiber, handle } = await app(ctx)
    const page = follow(ctx)
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })

    let unloaded = false
    const unloading = fiber.dispose().then(() => { unloaded = true })
    await vi.waitFor(() => { expect(subprocess.processes[0]?.terminated).toBe(true) })
    await vi.waitFor(() => { expect(page()).toEqual([]) })
    expect(unloaded).toBe(false)
    expect(await requiredContext(ctx)).toEqual([CLI_CONTEXT])

    subprocess.processes[0]?.release()
    await unloading
    expect(await requiredContext(ctx)).toEqual([])
    expect(handle.snapshot().result?.outcome).toBe('cancelled')
    await expect(handle.dispose()).resolves.toBeUndefined()

    // The Service outlives the plugin, so a reloaded plugin registers the same name again.
    subprocess.respond = (process) => { process.reply({ stdout: 'in\n' }) }
    await app(ctx)
    expect(await requiredContext(ctx)).toEqual([CLI_CONTEXT])
    await vi.waitFor(() => { expect(page().map(entry => entry.display)).toEqual([CONNECTED]) })
  })

  it('withdraws only the unloading plugin\'s account', async () => {
    const { ctx } = await host()
    const { fiber } = await app(ctx)
    await app(ctx, { ...REGISTRATION, name: 'other', packageName: '@acme/other' })
    const page = follow(ctx)
    await vi.waitFor(() => { expect(page()).toHaveLength(2) })

    await fiber.dispose()

    expect((await requiredContext(ctx)).map(section => section.name)).toEqual(['other:cli'])
    await vi.waitFor(() => { expect(page().map(entry => entry.key)).toEqual(['@acme/other']) })
  })

  it('withdraws the account through the handle before the plugin unloads, once', async () => {
    const { ctx } = await host()
    const { fiber, handle } = await app(ctx)
    const page = follow(ctx)
    await vi.waitFor(() => { expect(page()).toHaveLength(1) })

    const withdrawn = handle.dispose()
    expect(handle.dispose()).toBe(withdrawn)
    await withdrawn

    expect(await requiredContext(ctx)).toEqual([])
    await vi.waitFor(() => { expect(page()).toEqual([]) })
    handle.refresh()
    expect(handle.snapshot().operation).toBeUndefined()
    await fiber.dispose()
    expect(handle.dispose()).toBe(withdrawn)
  })
})

describe('prepare', () => {
  it('runs the step in its phase before a check while something is missing, then checks', async () => {
    const { ctx, subprocess } = await host()
    let status!: ScriptedProcess
    subprocess.respond = (process) => { status = process }
    const step = preparing()
    const { handle } = await app(ctx, step.registration)

    handle.refresh()

    expect(handle.snapshot().operation).toMatchObject({ kind: 'check', phase: 'downloading', cancellable: true })
    expect(subprocess.processes).toEqual([])
    step.finish()
    await vi.waitFor(() => { expect(status).toBeDefined() })
    expect(handle.snapshot().operation).toMatchObject({ kind: 'check', phase: 'checking', cancellable: false })
    status.reply({ stdout: 'in\n' })
    await vi.waitFor(() => { expect(handle.snapshot().account).toEqual({ state: 'signed-in' }) })

    subprocess.respond = (process) => { process.reply({ stdout: 'out\n' }) }
    handle.refresh()
    await vi.waitFor(() => { expect(handle.snapshot().account).toEqual({ state: 'signed-out' }) })
    expect(step.run).toHaveBeenCalledOnce()
  })

  it('keeps the CLI path out of required runtime context while something is missing', async () => {
    const { ctx, subprocess } = await host()
    subprocess.respond = (process) => { process.reply({ stdout: 'in\n' }) }
    const step = preparing()
    const { handle } = await app(ctx, step.registration)
    expect(await requiredContext(ctx)).toEqual([])

    handle.refresh()
    step.finish()

    await vi.waitFor(() => { expect(handle.snapshot().account).toEqual({ state: 'signed-in' }) })
    expect(await requiredContext(ctx)).toEqual([CLI_CONTEXT])
  })

  it('reports the unprepared account and fails the check without performing it when the step throws', async () => {
    const { ctx, subprocess } = await host()
    const step = preparing()
    const { handle } = await app(ctx, step.registration)
    const page = follow(ctx)
    await vi.waitFor(() => { expect(step.run).toHaveBeenCalledOnce() })
    const id = handle.snapshot().operation?.id

    step.fail()

    await vi.waitFor(() => { expect(handle.snapshot()).toEqual({ account: { state: 'not-installed' }, result: { id, kind: 'check', outcome: 'failed' } }) })
    await vi.waitFor(() => { expect(page()[0]?.display).toEqual({ ...DISCONNECTED, failure: { text: both('failed') } }) })
    expect(subprocess.processes).toEqual([])
  })

  it('stops the step when the page cancels the check, and reports the unprepared account', async () => {
    const { ctx, subprocess } = await host()
    const step = preparing()
    const { handle } = await app(ctx, step.registration)
    const id = await ctx.connectorAccounts.start(PACKAGE, 'check')

    await ctx.connectorAccounts.cancel(PACKAGE, id)

    expect(step.run.mock.calls[0]?.[0].aborted).toBe(true)
    expect(handle.snapshot()).toEqual({ account: { state: 'not-installed' }, result: { id, kind: 'check', outcome: 'cancelled' } })
    expect(subprocess.processes).toEqual([])
  })

  it.each([
    ['its step succeeded', 2],
    ['what was missing arrived without the step', 1],
  ])('reports the first account again, not the unprepared one, when a later check fails after %s', async (_path, runs) => {
    const { ctx, subprocess } = await host()
    subprocess.respond = (process) => { process.reply({ exitCode: 3 }) }
    let ready = false
    const run = vi.fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValueOnce(new Error('download failed'))
      .mockImplementationOnce(() => {
        ready = true
        return Promise.resolve()
      })
    const prepare: Registration['prepare'] = { phase: 'downloading', unprepared: { state: 'not-installed' }, ready: () => ready, run }
    const { handle } = await app(ctx, { ...REGISTRATION, prepare })
    const first = await ctx.connectorAccounts.start(PACKAGE, 'check')
    await vi.waitFor(() => { expect(handle.snapshot()).toEqual({ account: { state: 'not-installed' }, result: { id: first, kind: 'check', outcome: 'failed' } }) })

    if (runs === 1) ready = true
    const id = await ctx.connectorAccounts.start(PACKAGE, 'check')

    await vi.waitFor(() => { expect(handle.snapshot().result).toMatchObject({ id, outcome: 'failed', failure: { command: 'status', exitCode: 3 } }) })
    expect(handle.snapshot().account).toEqual({ state: 'unchecked' })
    expect(run).toHaveBeenCalledTimes(runs)
  })

  it('starts the other operations without the step', async () => {
    const { ctx, subprocess } = await host()
    subprocess.respond = (process) => { process.reply({ stdout: 'in\n' }) }
    const step = preparing()
    const { handle } = await app(ctx, step.registration)

    const id = await ctx.connectorAccounts.start(PACKAGE, 'connect')

    await vi.waitFor(() => { expect(handle.snapshot().result).toEqual({ id, kind: 'connect', outcome: 'succeeded' }) })
    expect(step.run).not.toHaveBeenCalled()
  })

  it('calls ready and run as methods of the step', async () => {
    const { ctx, subprocess } = await host()
    subprocess.respond = (process) => { process.reply({ stdout: 'in\n' }) }
    const prepare: NonNullable<Registration['prepare']> & { installed: boolean } = {
      phase: 'downloading',
      unprepared: { state: 'not-installed' },
      installed: false,
      ready() {
        return this.installed
      },
      run() {
        this.installed = true
        return Promise.resolve()
      },
    }
    const { handle } = await app(ctx, { ...REGISTRATION, prepare })

    handle.refresh()

    await vi.waitFor(() => { expect(handle.snapshot().account).toEqual({ state: 'signed-in' }) })
    expect(await requiredContext(ctx)).toEqual([CLI_CONTEXT])
  })
})

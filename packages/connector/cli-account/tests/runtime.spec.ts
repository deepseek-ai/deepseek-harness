import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliCommandExecutor } from '../src/executor.ts'
import { CliAccountRuntime, exitFailure, type CliOperationControl } from '../src/runtime.ts'
import type { CliAccountView, CliCommandFailure, CliOperationId } from '../src/types.ts'
import { PROGRAM, createBinDir, ScriptedSubprocess, type ScriptedProcess } from './harness.ts'

interface Account { readonly state: 'unchecked' | 'signed-out' | 'signed-in' }
type Kind = 'check' | 'connect'
type Phase = 'authorizing'
type Command = 'status' | 'login'
interface Failure extends CliCommandFailure<Command> { readonly code?: 'E42' }
type Control = CliOperationControl<Phase, Command>
type View = CliAccountView<Account, Kind, Phase, Failure>
type Script = (kind: Kind, control: Control, signal: AbortSignal, publish: (account: Account) => void) => Promise<void>

/** Delegates each operation to the spec's script so one runtime covers every path. */
class FixtureAccount extends CliAccountRuntime<Account, Kind, Phase, Failure> {
  script: Script = async () => {}

  protected perform(kind: Kind, control: Control, signal: AbortSignal): Promise<void> {
    return this.script(kind, control, signal, (account) => { this.publish(account) })
  }
}

let ctx: Context
let subprocess: ScriptedSubprocess
let binDir: string
let account: FixtureAccount

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(ScriptedSubprocess)
  await ctx.plugin(ShellEnv)
  subprocess = ctx.subprocess as ScriptedSubprocess
  binDir = await createBinDir()
  ctx.shellEnv.registerPath({ name: 'fixture', directories: [binDir] })
  account = new FixtureAccount({
    name: 'fixture',
    cli: new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: PROGRAM, commandTimeoutMs: 5_000 }),
    logger: ctx.logger,
    account: { state: 'unchecked' },
    check: 'check',
    cancellable: ['authorizing'],
    authorizationHosts: ['example.com'],
    classify: (command, result) => ({ ...exitFailure(command, result), ...result.stderr.includes('E42') ? { code: 'E42' as const } : {} }),
  })
})

afterEach(async () => {
  await account.dispose()
  await ctx.fiber.dispose()
  await rm(binDir, { recursive: true, force: true })
})

const errors = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args)

async function settled(id: CliOperationId): Promise<View> {
  await vi.waitFor(() => { expect(account.snapshot().result?.id).toBe(id) })
  return account.snapshot()
}

/** Check by running `status`, whose stdout names the account state. */
const checkScript: Script = async (_kind, control, signal, publish) => {
  const result = await control.run('status', ['status'], signal)
  if (result.exitCode !== 0) throw new Error('status failed')
  publish({ state: result.stdout.trim() === 'in' ? 'signed-in' : 'signed-out' })
}

describe('CliAccountRuntime', () => {
  it('checks, publishes the account, and reports the outcome', async () => {
    account.script = checkScript
    subprocess.respond = (process) => { process.reply({ stdout: 'in\n' }) }

    const id = account.start('check')

    expect(account.snapshot()).toEqual({ account: { state: 'unchecked' }, operation: { id, kind: 'check', phase: 'checking', cancellable: false } })
    expect(await settled(id)).toEqual({ account: { state: 'signed-in' }, result: { id, kind: 'check', outcome: 'succeeded' } })
  })

  it('offers only trusted HTTPS authorization links, reports which it accepted, and clears them on the next stage', async () => {
    let login!: ScriptedProcess
    const offers: boolean[] = []
    subprocess.respond = (process) => {
      if (process.spec.argv[1] === 'status') process.reply({ stdout: 'in' })
      else login = process
    }
    account.script = async (kind, control, signal, publish) => {
      if (kind === 'check') return checkScript(kind, control, signal, publish)
      control.stage('authorizing')
      const result = await control.run('login', ['login'], signal, { awaitsUser: true, onLine: (_stream, line) => { offers.push(control.offer(line)) } })
      if (result.exitCode !== 0) throw new Error('login failed')
      control.stage('checking')
      await checkScript(kind, control, signal, publish)
    }

    const id = account.start('connect')
    await vi.waitFor(() => { expect(login).toBeDefined() })
    for (const link of ['not a url', 'http://example.com/a', 'https://evil.test/a', 'https://user@example.com/a', 'https://:pw@example.com/a']) {
      login.write('stdout', `${link}\n`)
    }
    login.write('stdout', 'https://auth.example.com/device?code=1\n')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBe('https://auth.example.com/device?code=1') })
    expect(account.snapshot().operation).toMatchObject({ phase: 'authorizing', cancellable: true })
    login.write('stdout', 'https://example.com/second\n')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBe('https://example.com/second') })

    login.reply({})
    expect(await settled(id)).toEqual({ account: { state: 'signed-in' }, result: { id, kind: 'connect', outcome: 'succeeded' } })
    expect(offers).toEqual([false, false, false, false, false, true, true])
  })

  it('cancels only the named operation in a cancellable phase, withdraws its link, and ignores later links', async () => {
    subprocess.respond = (process) => { process.write('stdout', 'https://example.com/device\n') }
    let late: boolean | undefined
    account.script = async (_kind, control, signal) => {
      control.stage('authorizing')
      try {
        await control.run('login', ['login'], signal, { awaitsUser: true, onLine: (_stream, line) => { control.offer(line) } })
      } finally {
        late = control.offer('https://example.com/late')
      }
    }
    const id = account.start('connect')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBe('https://example.com/device') })

    await account.cancel('other' as CliOperationId)
    expect(account.snapshot().operation?.phase).toBe('authorizing')
    const cancelling = account.cancel(id)
    expect(account.snapshot().operation).toEqual({ id, kind: 'connect', phase: 'cancelling', cancellable: false })
    await cancelling

    expect(account.snapshot()).toEqual({ account: { state: 'unchecked' }, result: { id, kind: 'connect', outcome: 'cancelled' } })
    expect(late).toBe(false)
    expect(subprocess.processes[0]?.terminated).toBe(true)
    expect(errors()).toEqual([])
  })

  it('ignores cancellation outside the declared phases', async () => {
    let status!: ScriptedProcess
    subprocess.respond = (process) => { status = process }
    account.script = checkScript
    const id = account.start('check')
    await vi.waitFor(() => { expect(status).toBeDefined() })

    await account.cancel(id)
    expect(account.snapshot().operation?.phase).toBe('checking')

    status.reply({ stdout: 'out' })
    expect((await settled(id)).result?.outcome).toBe('succeeded')
  })

  it('runs one operation at a time and refreshes only when idle', async () => {
    let status!: ScriptedProcess
    subprocess.respond = (process) => { status = process }
    account.script = checkScript
    const id = account.start('check')

    expect(() => account.start('connect')).toThrow('fixture: another account operation is in progress')
    account.refresh()
    await vi.waitFor(() => { expect(status).toBeDefined() })
    status.reply({ stdout: 'out' })
    await settled(id)
    expect(subprocess.processes).toHaveLength(1)

    subprocess.respond = (process) => { process.reply({ stdout: 'in' }) }
    account.refresh()
    expect(account.snapshot().operation?.kind).toBe('check')
    await vi.waitFor(() => { expect(account.snapshot().account).toEqual({ state: 'signed-in' }) })
  })

  it('reports a failed operation by its classified command and never logs the exception', async () => {
    subprocess.respond = (process) => { process.reply({ exitCode: 7, stderr: 'E42 token=secret-token' }) }
    account.script = async (_kind, control, signal) => {
      control.stage('authorizing')
      await control.run('login', ['login'], signal)
      throw new Error('login printed secret-token')
    }

    const id = account.start('connect')

    expect(await settled(id)).toEqual({
      account: { state: 'unchecked' },
      result: { id, kind: 'connect', outcome: 'failed', failure: { command: 'login', exitCode: 7, code: 'E42' } },
    })
    expect(errors()).toEqual([[
      'fixture: account operation failed: %o',
      { id, kind: 'connect', phase: 'authorizing', command: 'login', exitCode: 7, code: 'E42' },
    ]])
    expect(JSON.stringify(errors())).not.toContain('secret-token')
  })

  it('reports an attempted command that produced no exit', async () => {
    subprocess.lookup = () => Promise.reject(new Error('lookup failed with secret-token'))
    account.script = checkScript

    const id = account.start('check')

    expect((await settled(id)).result).toEqual({ id, kind: 'check', outcome: 'failed', failure: { command: 'status', exitCode: null } })
    expect(JSON.stringify(errors())).not.toContain('secret-token')
  })

  it('fails without a failure when no command ran', async () => {
    account.script = () => Promise.reject(new Error('bad state'))

    const id = account.start('check')

    expect((await settled(id)).result).toEqual({ id, kind: 'check', outcome: 'failed' })
    expect(errors()).toEqual([['fixture: account operation failed: %o', { id, kind: 'check', phase: 'checking' }]])
  })

  it('streams the account view to each follower, checking for a follower that finds no operation', async () => {
    let status!: ScriptedProcess
    subprocess.respond = (process) => { status = process }
    account.script = checkScript
    const leave = new AbortController()
    const views: View[] = []
    const following = (async () => {
      for await (const view of account.follow(leave.signal)) {
        views.push(view)
        if (view.result !== undefined) leave.abort()
      }
    })()

    await vi.waitFor(() => { expect(status).toBeDefined() })
    const second = account.follow(new AbortController().signal)[Symbol.asyncIterator]()
    expect((await second.next()).value).toMatchObject({ operation: { kind: 'check' } })
    await second.return?.()
    status.reply({ stdout: 'in' })
    await following

    expect(subprocess.processes).toHaveLength(1)
    expect(views[0]).toMatchObject({ account: { state: 'unchecked' }, operation: { kind: 'check', phase: 'checking' } })
    expect(views.at(-1)).toMatchObject({ account: { state: 'signed-in' }, result: { outcome: 'succeeded' } })
  })

  it('stops account work, ends streams, and refuses new work on disposal', async () => {
    subprocess.respond = () => {}
    account.script = async (_kind, control, signal) => {
      control.stage('authorizing')
      await control.run('login', ['login'], signal, { awaitsUser: true })
    }
    const id = account.start('connect')
    const views: View[] = []
    const following = (async () => {
      for await (const view of account.follow(new AbortController().signal)) views.push(view)
    })()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })

    await account.dispose()
    await following

    expect(account.snapshot().result).toEqual({ id, kind: 'connect', outcome: 'cancelled' })
    expect(views.length).toBeGreaterThan(0)
    expect(() => account.start('check')).toThrow('fixture: plugin disposed')
    account.refresh()
    expect(account.snapshot().operation).toBeUndefined()
    await account.dispose()
  })
})

it('classifies a command by its exit code alone', () => {
  expect(exitFailure('status', { exitCode: 3, stdout: 'out', stderr: 'token' })).toEqual({ command: 'status', exitCode: 3 })
})

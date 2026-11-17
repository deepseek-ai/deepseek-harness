import { Context } from '@deepseek-ai/cordis'
import type { ConnectorOperationId } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliCommandExecutor } from '../src/executor.ts'
import { CliAccountRuntime, failureDetails } from '../src/runtime.ts'
import type { CliAccountView, CliOperationControl } from '../src/types.ts'
import { EXECUTABLE, PROGRAM, ScriptedSubprocess, type ScriptedProcess } from './harness.ts'

interface Account { readonly state: 'unchecked' | 'signed-out' | 'signed-in' }
type Kind = 'check' | 'connect'
type Phase = 'authorizing'
type Command = 'status' | 'login'
type Control = CliOperationControl<Account, Phase, Command>
type View = CliAccountView<Account, Kind, Phase, Command>
type Script = (kind: Kind, control: Control, signal: AbortSignal) => Promise<void>

let ctx: Context
let subprocess: ScriptedSubprocess
let account: CliAccountRuntime<Account, Kind, Phase, Command>
/** What each operation does; one runtime covers every path by replacing it. */
let script: Script

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(ScriptedSubprocess)
  subprocess = ctx.subprocess as ScriptedSubprocess
  script = async () => {}
  account = new CliAccountRuntime({
    name: 'fixture',
    executor: new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable: EXECUTABLE, commandTimeoutMs: 5_000 }),
    logger: ctx.logger,
    account: { state: 'unchecked' },
    check: 'check',
    cancellable: ['authorizing'],
    authorizationHosts: ['example.com'],
    perform: (kind, control, signal) => script(kind, control, signal),
  })
})

afterEach(async () => {
  await account.dispose()
  await ctx.fiber.dispose()
})

const errors = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args)

async function settled(id: ConnectorOperationId): Promise<View> {
  await vi.waitFor(() => { expect(account.snapshot().result?.id).toBe(id) })
  return account.snapshot()
}

/** Check by running `status`, whose stdout names the account state. */
const checkScript: Script = async (_kind, control, signal) => {
  const result = await control.run('status', ['status'], signal)
  if (result.exitCode !== 0) throw new Error('status failed')
  control.publish({ state: result.stdout.trim() === 'in' ? 'signed-in' : 'signed-out' })
}

describe('CliAccountRuntime', () => {
  it('checks, publishes the account, and reports the outcome', async () => {
    script = checkScript
    subprocess.respond = (process) => { process.reply({ stdout: 'in\n' }) }

    const id = account.start('check')

    expect(account.snapshot()).toEqual({ account: { state: 'unchecked' }, operation: { id, kind: 'check', phase: 'checking', cancellable: false } })
    expect(await settled(id)).toEqual({ account: { state: 'signed-in' }, result: { id, kind: 'check', outcome: 'succeeded' } })
  })

  it('publishes an account outside an operation and notifies observers', () => {
    const changes: View[] = []
    account.observe(() => { changes.push(account.snapshot()) })

    account.publish({ state: 'signed-out' })

    expect(changes).toEqual([{ account: { state: 'signed-out' } }])
  })

  it('notifies an observer of each change without starting a check, until its disposer runs', async () => {
    script = checkScript
    subprocess.respond = (process) => { process.reply({ stdout: 'in\n' }) }
    const changes: View[] = []
    const stop = account.observe(() => { changes.push(account.snapshot()) })
    expect(account.snapshot().operation).toBeUndefined()

    const id = account.start('check')
    await settled(id)
    expect(changes.map(view => view.operation?.phase ?? view.result?.outcome)).toContain('succeeded')
    expect(changes[0]?.operation).toMatchObject({ id, kind: 'check' })
    const seen = changes.length
    stop()
    await settled(account.start('check'))
    expect(changes).toHaveLength(seen)
  })

  it('logs what an observer throws and still notifies the other observers and finishes the operation', async () => {
    script = checkScript
    subprocess.respond = (process) => { process.reply({ stdout: 'in\n' }) }
    const thrown = new Error('observer failed')
    account.observe(() => { throw thrown })
    const changes: View[] = []
    account.observe(() => { changes.push(account.snapshot()) })

    const id = account.start('check')

    const view = await settled(id)
    expect(view).toEqual({ account: { state: 'signed-in' }, result: { id, kind: 'check', outcome: 'succeeded' } })
    expect(changes.at(-1)).toEqual(view)
    expect(errors()).toEqual(changes.map(() => ['fixture: account observer failed: %o', thrown]))
  })

  it('offers only trusted HTTPS authorization links, reports which it accepted, and clears them on the next stage', async () => {
    let login!: ScriptedProcess
    const offers: boolean[] = []
    subprocess.respond = (process) => {
      if (process.spec.argv[1] === 'status') process.reply({ stdout: 'in' })
      else login = process
    }
    script = async (kind, control, signal) => {
      if (kind === 'check') return checkScript(kind, control, signal)
      control.stage('authorizing')
      const result = await control.run('login', ['login'], signal, { awaitsUser: true, onLine: (_stream, line) => { offers.push(control.offer(line)) } })
      if (result.exitCode !== 0) throw new Error('login failed')
      control.stage('checking')
      await checkScript(kind, control, signal)
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
    script = async (_kind, control, signal) => {
      control.stage('authorizing')
      try {
        await control.run('login', ['login'], signal, { awaitsUser: true, onLine: (_stream, line) => { control.offer(line) } })
      } finally {
        late = control.offer('https://example.com/late')
      }
    }
    const id = account.start('connect')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBe('https://example.com/device') })

    await account.cancel('other' as ConnectorOperationId)
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
    script = checkScript
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
    script = checkScript
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

  it('reports a failed operation by its last command and exit code and never logs the exception', async () => {
    subprocess.respond = (process) => { process.reply({ exitCode: 7, stderr: 'E42 token=secret-token' }) }
    script = async (_kind, control, signal) => {
      control.stage('authorizing')
      await control.run('login', ['login'], signal)
      throw new Error('login printed secret-token')
    }

    const id = account.start('connect')

    expect(await settled(id)).toEqual({
      account: { state: 'unchecked' },
      result: { id, kind: 'connect', outcome: 'failed', failure: { command: 'login', exitCode: 7 } },
    })
    expect(errors()).toEqual([[
      'fixture: account operation failed: %o',
      { id, kind: 'connect', phase: 'authorizing', command: 'login', exitCode: 7 },
    ]])
    expect(JSON.stringify(errors())).not.toContain('secret-token')
  })

  it('reports an attempted command that produced no exit', async () => {
    subprocess.lookup = () => Promise.reject(new Error('lookup failed with secret-token'))
    script = checkScript

    const id = account.start('check')

    expect((await settled(id)).result).toEqual({ id, kind: 'check', outcome: 'failed', failure: { command: 'status', exitCode: null } })
    expect(JSON.stringify(errors())).not.toContain('secret-token')
  })

  it('fails without a failure when no command ran', async () => {
    script = () => Promise.reject(new Error('bad state'))

    const id = account.start('check')

    expect((await settled(id)).result).toEqual({ id, kind: 'check', outcome: 'failed' })
    expect(errors()).toEqual([['fixture: account operation failed: %o', { id, kind: 'check', phase: 'checking' }]])
  })

  it('stops account work and refuses new work on disposal', async () => {
    subprocess.respond = () => {}
    script = async (_kind, control, signal) => {
      control.stage('authorizing')
      await control.run('login', ['login'], signal, { awaitsUser: true })
    }
    const id = account.start('connect')
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })

    await account.dispose()

    expect(account.snapshot().result).toEqual({ id, kind: 'connect', outcome: 'cancelled' })
    expect(() => account.start('check')).toThrow('fixture: plugin disposed')
    account.refresh()
    expect(account.snapshot().operation).toBeUndefined()
    await account.dispose()
  })
})

it('lists the last command of a failed operation as diagnostic items, with its exit code when it has one', () => {
  expect(failureDetails({ command: 'login', exitCode: 3 })).toEqual(['login', 'exit 3'])
  expect(failureDetails({ command: 'status', exitCode: null })).toEqual(['status'])
})

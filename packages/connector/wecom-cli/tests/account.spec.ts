/** Authorization operations over a scripted wecom-cli: checks, QR-code connection, cancellation, and the Remote wiring. */
import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { CliCommandExecutor, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WecomAccount } from '../src/account.ts'
import { PROGRAM } from '../src/directory.ts'
import Wecom, { type WecomState } from '../src/index.ts'
import { createBinDir, ScriptedSubprocess, type CliReply, type ScriptedProcess } from './harness.ts'

const STATUS = 'auth show --status'
const INIT = 'auth init --noninteractive --no-browser'
const QR_LINK = 'https://work.weixin.qq.com/ai/qc/gen?source=wecom-cli&scode=fixture-scode'
const AUTHORIZED: CliReply = { stdout: 'authorized\n' }
const UNAUTHORIZED: CliReply = { stdout: 'unauthorized\n' }

type Script = (process: ScriptedProcess) => void

let ctx: Context
let subprocess: ScriptedSubprocess
let binDir: string
let script: Record<string, Script | CliReply[]>

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ScriptedSubprocess)
  await ctx.plugin(ShellEnv)
  subprocess = ctx.subprocess as ScriptedSubprocess
  binDir = await createBinDir()
  script = {}
  subprocess.respond = (process) => {
    const handler = script[process.spec.argv.slice(1).join(' ')]
    if (handler === undefined) process.reply({ exitCode: 1, stderr: `unexpected: ${process.spec.argv.join(' ')}` })
    else if (Array.isArray(handler)) process.reply(handler.length > 1 ? handler.shift()! : handler[0]!)
    else handler(process)
  }
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(binDir, { recursive: true, force: true })
})

const commands = () => subprocess.processes.map(process => process.spec.argv.slice(1).join(' '))
const errors = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args)

describe('WecomAccount', () => {
  let account: WecomAccount

  beforeEach(() => {
    ctx.shellEnv.registerPath({ name: 'wecom', directories: [binDir], programs: [PROGRAM] })
    const cli = new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: PROGRAM, commandTimeoutMs: 5_000 })
    account = new WecomAccount(cli, ctx.logger)
  })

  afterEach(() => account.dispose())

  const settled = async (id: CliOperationId): Promise<WecomState> => {
    await vi.waitFor(() => { expect(account.snapshot().result?.id).toBe(id) })
    return account.snapshot()
  }

  it.each<[string, CliReply, WecomState['account']]>([
    ['an authorized bot', AUTHORIZED, { state: 'authorized' }],
    ['no authorization', UNAUTHORIZED, { state: 'unauthorized' }],
  ])('checks %s', async (_name, reply, expected) => {
    script[STATUS] = [reply]
    const id = account.start('check')
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'checking', cancellable: false })
    expect(await settled(id)).toEqual({ account: expected, result: { id, kind: 'check', outcome: 'succeeded' } })
  })

  it.each<[string, CliReply]>([
    ['a failed status command', { exitCode: 1, stderr: 'config unreadable' }],
    ['an unknown status', { stdout: 'expired\n' }],
  ])('keeps the previous state and reports only the command and exit code on %s', async (_name, reply) => {
    script[STATUS] = [reply]
    const result = await settled(account.start('check'))
    expect(result).toEqual({
      account: { state: 'unchecked' },
      result: { id: result.result?.id, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: reply.exitCode ?? 0 } },
    })
    expect(errors()).toEqual([['wecom: account operation failed: %o', {
      id: result.result?.id, kind: 'check', phase: 'checking', command: 'auth-status', exitCode: reply.exitCode ?? 0,
    }]])
  })

  it('connects through the QR-code page, offers only trusted links, and confirms the authorization', async () => {
    script[STATUS] = [AUTHORIZED]
    const init = Promise.withResolvers<ScriptedProcess>()
    script[INIT] = (process) => { init.resolve(process) }

    const id = account.start('connect')
    expect(account.snapshot().operation).toEqual({ id, kind: 'connect', phase: 'authorizing', cancellable: true })
    const authorizing = await init.promise
    authorizing.write('stderr', `${QR_LINK}\n`)
    authorizing.write('stdout', 'Scan the QR code with WeCom:\n  http://work.weixin.qq.com/insecure\nhttps://evil.example/qr\n')
    authorizing.write('stdout', `${QR_LINK}\n`)
    await vi.waitFor(() => { expect(account.snapshot().operation).toMatchObject({ phase: 'authorizing', authorizationUrl: QR_LINK }) })
    authorizing.reply({ stdout: 'Authorized\n' })

    expect(await settled(id)).toEqual({ account: { state: 'authorized' }, result: { id, kind: 'connect', outcome: 'succeeded' } })
    expect(commands()).toEqual([INIT, STATUS])
    expect(errors()).toEqual([])
  })

  it.each<[string, Record<string, CliReply[]>, NonNullable<WecomState['result']>['failure']]>([
    ['a failed QR-code authorization', { [INIT]: [{ exitCode: 2, stdout: `${QR_LINK}\nscode=secret` }] }, { command: 'auth-init', exitCode: 2 }],
    ['an authorization that left no bot', { [INIT]: [{}], [STATUS]: [UNAUTHORIZED] }, { command: 'auth-status', exitCode: 0 }],
  ])('fails on %s without exposing CLI output', async (_name, replies, failure) => {
    Object.assign(script, replies)
    const result = await settled(account.start('connect'))
    expect(result.result).toMatchObject({ kind: 'connect', outcome: 'failed', failure })
    expect(JSON.stringify({ result, errors: errors() })).not.toContain('scode')
  })

  it('cancels only while waiting for the scan and withdraws the link', async () => {
    script[INIT] = (process) => { process.write('stdout', `${QR_LINK}\n`) }
    const id = account.start('connect')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBe(QR_LINK) })
    await account.cancel('other' as CliOperationId)
    expect(account.snapshot().operation?.phase).toBe('authorizing')

    const cancelling = account.cancel(id)
    expect(account.snapshot().operation).toEqual({ id, kind: 'connect', phase: 'cancelling', cancellable: false })
    await cancelling
    expect(account.snapshot()).toEqual({ account: { state: 'unchecked' }, result: { id, kind: 'connect', outcome: 'cancelled' } })
    expect(subprocess.processes[0]?.terminated).toBe(true)
    expect(errors()).toEqual([])
  })

  it('ignores cancellation while it confirms the authorization', async () => {
    script[INIT] = [{}]
    const status = Promise.withResolvers<ScriptedProcess>()
    script[STATUS] = (process) => { status.resolve(process) }
    const id = account.start('connect')
    const checking = await status.promise
    expect(account.snapshot().operation).toEqual({ id, kind: 'connect', phase: 'checking', cancellable: false })
    await account.cancel(id)
    checking.reply(AUTHORIZED)
    expect((await settled(id)).result).toEqual({ id, kind: 'connect', outcome: 'succeeded' })
  })
})

describe('WeCom Remote', () => {
  beforeEach(async () => {
    await ctx.plugin(Wecom, { commandTimeoutMs: 5_000, binDir })
  })

  it('checks for a new follower, streams each change, and starts checks and connections', async () => {
    script[STATUS] = [UNAUTHORIZED]
    const states: WecomState[] = []
    const leave = new AbortController()
    const following = (async () => {
      for await (const state of ctx.wecom.follow(leave.signal)) states.push(state)
    })()
    const finished = async (id?: CliOperationId): Promise<WecomState['result']> => {
      await vi.waitFor(() => {
        expect(states.at(-1)?.result).toBeDefined()
        if (id !== undefined) expect(states.at(-1)?.result?.id).toBe(id)
      })
      return states.at(-1)?.result
    }
    expect(await finished()).toMatchObject({ kind: 'check', outcome: 'succeeded' })
    expect(states[0]).toMatchObject({ account: { state: 'unchecked' }, operation: { kind: 'check' } })
    expect(states.at(-1)?.account).toEqual({ state: 'unauthorized' })
    expect(await finished(ctx.wecom.check())).toMatchObject({ kind: 'check', outcome: 'succeeded' })

    script[INIT] = () => {}
    const connecting = ctx.wecom.connect()
    expect(() => ctx.wecom.check()).toThrow('another account operation is in progress')
    await vi.waitFor(() => { expect(commands().at(-1)).toBe(INIT) })
    await ctx.wecom.cancel(connecting)
    expect(await finished(connecting)).toMatchObject({ kind: 'connect', outcome: 'cancelled' })
    expect(subprocess.processes.at(-1)?.terminated).toBe(true)
    leave.abort()
    await following
  })

  it('ends its streams and stops authorization work on disposal', async () => {
    script[STATUS] = () => {}
    const states: WecomState[] = []
    const following = (async () => {
      for await (const state of ctx.wecom.follow(new AbortController().signal)) states.push(state)
    })()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })
    await ctx.fiber.dispose()
    await following
    expect(states.length).toBeGreaterThan(0)
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })
})

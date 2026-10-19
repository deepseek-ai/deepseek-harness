/** Account operations over a scripted tmeet: status text, sign-in, sign-out, cancellation, and the Remote wiring. */
import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { CliCommandExecutor, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TencentMeetingAccount } from '../src/account.ts'
import { PROGRAM } from '../src/directory.ts'
import TencentMeeting, { type TencentMeetingState } from '../src/index.ts'
import { createBinDir, ScriptedSubprocess, type CliReply, type ScriptedProcess } from './harness.ts'

const STATUS = 'auth status'
const LOGIN = 'auth login --no-browser'
const LOGOUT = 'auth logout'
const LOGIN_LINK = 'https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=fixture-code'

const CONNECTED: CliReply = {
  stdout: 'Logged in\n  OpenId:  ou_fixture\n  UserName:  测试 用户\n'
    + '  AccessToken:  valid (expires at 2026-11-01 10:00:00, remaining 15d 0h 6m)\n'
    + '  RefreshToken: valid (expires at 2027-01-01 10:00:00, remaining 76d 0h 6m)\n',
}
const NOT_LOGGED_IN: CliReply = { stdout: 'Not logged in. Please use \'tmeet auth login\' to authenticate.\n' }
const SESSION_EXPIRED: CliReply = { stdout: '  Session has expired. Please use \'tmeet auth login\' to re-authenticate.\n' }
const REFRESH_EXPIRED: CliReply = {
  stdout: 'Logged in\n  OpenId:  ou_fixture\n  AccessToken:  expired (at 2026-09-01 10:00:00)\n  RefreshToken: expired (at 2026-10-01 10:00:00)\n',
}
const UNVERIFIED: CliReply = {
  stdout: 'Logged in\n  OpenId:  ou_fixture\n  AccessToken:  valid (expires at 2026-11-01 10:00:00, remaining 15d 0h 6m)\n'
    + '  RefreshToken: valid (expires at 2027-01-01 10:00:00, remaining 76d 0h 6m)\n',
}

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

describe('TencentMeetingAccount', () => {
  let account: TencentMeetingAccount

  beforeEach(() => {
    ctx.shellEnv.registerPath({ name: 'tencent-meeting', directories: [binDir], programs: [PROGRAM] })
    const cli = new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: PROGRAM, commandTimeoutMs: 5_000 })
    account = new TencentMeetingAccount(cli, ctx.logger)
  })

  afterEach(() => account.dispose())

  const settled = async (id: CliOperationId): Promise<TencentMeetingState> => {
    await vi.waitFor(() => { expect(account.snapshot().result?.id).toBe(id) })
    return account.snapshot()
  }

  it.each<[string, CliReply, TencentMeetingState['account']]>([
    ['a sign-in the server accepts', CONNECTED, { state: 'connected', userName: '测试 用户' }],
    ['no sign-in', NOT_LOGGED_IN, { state: 'signed-out' }],
    ['a sign-in the CLI cleared after a failed refresh', SESSION_EXPIRED, { state: 'signed-out' }],
    ['a sign-in whose refresh token expired', REFRESH_EXPIRED, { state: 'signed-out' }],
    ['a stored sign-in the server did not confirm', UNVERIFIED, { state: 'unverified' }],
  ])('checks %s', async (_name, reply, expected) => {
    script[STATUS] = [reply]
    const id = account.start('check')
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'checking', cancellable: false })
    expect(await settled(id)).toEqual({ account: expected, result: { id, kind: 'check', outcome: 'succeeded' } })
  })

  it.each<[string, CliReply]>([
    ['a failed status command', { exitCode: 1, stderr: 'Error: failed to read user config' }],
    ['a status this version does not print', { stdout: 'Signed in as ou_fixture\n' }],
  ])('keeps the previous account and reports only the command and exit code on %s', async (_name, reply) => {
    script[STATUS] = [reply]
    const result = await settled(account.start('check'))
    expect(result).toEqual({
      account: { state: 'unchecked' },
      result: { id: result.result?.id, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: reply.exitCode ?? 0 } },
    })
    expect(errors()).toEqual([['tencent-meeting: account operation failed: %o', {
      id: result.result?.id, kind: 'check', phase: 'checking', command: 'auth-status', exitCode: reply.exitCode ?? 0,
    }]])
  })

  it('signs in through the authorization page, offers only trusted links, and confirms the sign-in', async () => {
    script[STATUS] = [CONNECTED]
    const login = Promise.withResolvers<ScriptedProcess>()
    script[LOGIN] = (process) => { login.resolve(process) }

    const id = account.start('sign-in')
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-in', phase: 'authorizing', cancellable: true })
    const authorizing = await login.promise
    authorizing.write('stderr', `authorize url: ${LOGIN_LINK}\n`)
    authorizing.write('stdout', '\nPlease open the following URL in your browser to authorize\n\n')
    authorizing.write('stdout', 'authorize url: http://meeting.tencent.com/insecure\nauthorize url: https://evil.example/auth\n')
    authorizing.write('stdout', `authorize url: ${LOGIN_LINK}\n\nwaiting for authorization...\n`)
    await vi.waitFor(() => { expect(account.snapshot().operation).toMatchObject({ phase: 'authorizing', authorizationUrl: LOGIN_LINK }) })
    authorizing.reply({ stdout: 'Login successful. Start managing your meetings using tmeet.\n' })

    expect(await settled(id)).toEqual({
      account: { state: 'connected', userName: '测试 用户' }, result: { id, kind: 'sign-in', outcome: 'succeeded' },
    })
    expect(commands()).toEqual([LOGIN, STATUS])
    expect(errors()).toEqual([])
  })

  it.each<[string, Record<string, CliReply[]>, NonNullable<TencentMeetingState['result']>['failure']]>([
    ['a failed sign-in', { [LOGIN]: [{ exitCode: 1, stdout: `authorize url: ${LOGIN_LINK}\n` }] }, { command: 'auth-login', exitCode: 1 }],
    ['a sign-in the server did not confirm', { [LOGIN]: [{}], [STATUS]: [UNVERIFIED] }, { command: 'auth-status', exitCode: 0 }],
  ])('fails on %s without exposing CLI output', async (_name, replies, failure) => {
    Object.assign(script, replies)
    const result = await settled(account.start('sign-in'))
    expect(result.result).toMatchObject({ kind: 'sign-in', outcome: 'failed', failure })
    expect(JSON.stringify({ result, errors: errors() })).not.toContain('fixture-code')
  })

  it('cancels only while waiting for authorization and withdraws the link', async () => {
    script[LOGIN] = (process) => { process.write('stdout', `authorize url: ${LOGIN_LINK}\n`) }
    const id = account.start('sign-in')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBe(LOGIN_LINK) })
    await account.cancel('other' as CliOperationId)
    expect(account.snapshot().operation?.phase).toBe('authorizing')

    const cancelling = account.cancel(id)
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-in', phase: 'cancelling', cancellable: false })
    await cancelling
    expect(account.snapshot()).toEqual({ account: { state: 'unchecked' }, result: { id, kind: 'sign-in', outcome: 'cancelled' } })
    expect(subprocess.processes[0]?.terminated).toBe(true)
    expect(errors()).toEqual([])
  })

  it('signs out without cancellation, then checks again', async () => {
    script[STATUS] = [NOT_LOGGED_IN]
    const logout = Promise.withResolvers<ScriptedProcess>()
    script[LOGOUT] = (process) => { logout.resolve(process) }
    const id = account.start('sign-out')
    const signingOut = await logout.promise
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-out', phase: 'signing-out', cancellable: false })
    await account.cancel(id)
    signingOut.reply({ stdout: 'Logout success, welcome to use it again.\n' })

    expect(await settled(id)).toEqual({ account: { state: 'signed-out' }, result: { id, kind: 'sign-out', outcome: 'succeeded' } })
    expect(commands()).toEqual([LOGOUT, STATUS])
  })

  it('reports a failed sign-out without checking again', async () => {
    script[LOGOUT] = [{ exitCode: 1, stderr: 'Error: logout failed' }]
    const result = await settled(account.start('sign-out'))
    expect(result.result).toMatchObject({ kind: 'sign-out', outcome: 'failed', failure: { command: 'auth-logout', exitCode: 1 } })
    expect(commands()).toEqual([LOGOUT])
  })
})

describe('Tencent Meeting Remote', () => {
  beforeEach(async () => {
    await ctx.plugin(TencentMeeting, { commandTimeoutMs: 5_000, binDir })
  })

  it('checks for a new follower, streams each change, and starts checks, sign-ins, and sign-outs', async () => {
    script[STATUS] = [NOT_LOGGED_IN]
    const states: TencentMeetingState[] = []
    const leave = new AbortController()
    const following = (async () => {
      for await (const state of ctx.tencentMeeting.follow(leave.signal)) states.push(state)
    })()
    const finished = async (id?: CliOperationId): Promise<TencentMeetingState['result']> => {
      await vi.waitFor(() => {
        expect(states.at(-1)?.result).toBeDefined()
        if (id !== undefined) expect(states.at(-1)?.result?.id).toBe(id)
      })
      return states.at(-1)?.result
    }
    expect(await finished()).toMatchObject({ kind: 'check', outcome: 'succeeded' })
    expect(states[0]).toMatchObject({ account: { state: 'unchecked' }, operation: { kind: 'check' } })
    expect(states.at(-1)?.account).toEqual({ state: 'signed-out' })
    expect(await finished(ctx.tencentMeeting.check())).toMatchObject({ kind: 'check', outcome: 'succeeded' })

    script[LOGIN] = () => {}
    const signingIn = ctx.tencentMeeting.signIn()
    expect(() => ctx.tencentMeeting.check()).toThrow('another account operation is in progress')
    await vi.waitFor(() => { expect(commands().at(-1)).toBe(LOGIN) })
    await ctx.tencentMeeting.cancel(signingIn)
    expect(await finished(signingIn)).toMatchObject({ kind: 'sign-in', outcome: 'cancelled' })
    expect(subprocess.processes.at(-1)?.terminated).toBe(true)

    script[LOGOUT] = [{}]
    expect(await finished(ctx.tencentMeeting.signOut())).toMatchObject({ kind: 'sign-out', outcome: 'succeeded' })
    leave.abort()
    await following
  })

  it('ends its streams and stops account work on disposal', async () => {
    script[STATUS] = () => {}
    const states: TencentMeetingState[] = []
    const following = (async () => {
      for await (const state of ctx.tencentMeeting.follow(new AbortController().signal)) states.push(state)
    })()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })
    await ctx.fiber.dispose()
    await following
    expect(states.length).toBeGreaterThan(0)
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })
})

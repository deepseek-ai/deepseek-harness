/** Account operations over a scripted tmeet: status text, sign-in, sign-out, cancellation, and the Plugins page wiring. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectorOperationId } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executableFileName } from '../src/directory.ts'
import * as TencentMeeting from '../src/index.ts'
import type { TencentMeetingOperationKind, TencentMeetingState } from '../src/types.ts'
import { createHost, type CliReply, type ScriptedProcess, type ScriptedSubprocess, type TencentMeetingPage } from './harness.ts'

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
let skillsDir: string
/** The account the plugin registered, as the Plugins page registry drives it. */
let account: TencentMeetingPage['source']
let script: Record<string, Script | CliReply[]>

/** Start a Host and load the plugin on it; without `skillsDir` the plugin downloads the guide. */
async function load(config: Pick<TencentMeeting.Config, 'skillsDir'> | 'configured' = 'configured'): Promise<void> {
  const host = await createHost()
  ;({ ctx, subprocess, binDir, skillsDir } = host)
  subprocess.respond = (process) => {
    const handler = script[process.spec.argv.slice(1).join(' ')]
    if (handler === undefined) process.reply({ exitCode: 1, stderr: `unexpected: ${process.spec.argv.join(' ')}` })
    else if (Array.isArray(handler)) process.reply(handler.length > 1 ? handler.shift()! : handler[0]!)
    else handler(process)
  }
  await ctx.plugin(TencentMeeting, { binDir, ...config === 'configured' ? { skillsDir } : config })
  account = host.pages[0]!.source
}

beforeEach(() => {
  script = {}
})

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(binDir, { recursive: true, force: true })
  await rm(skillsDir, { recursive: true, force: true })
})

/** Start an operation as a page button does; the CLI account Service starts it before returning. */
const start = (kind: TencentMeetingOperationKind): ConnectorOperationId => {
  const id = account.start(kind)
  if (typeof id !== 'string') throw new Error('the operation did not start at once')
  return id
}
const commands = () => subprocess.processes.map(process => process.spec.argv.slice(1).join(' '))
const errors = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args)
const settled = async (id: ConnectorOperationId): Promise<TencentMeetingState> => {
  await vi.waitFor(() => { expect(account.snapshot().result?.id).toBe(id) })
  return account.snapshot()
}

describe('Tencent Meeting account operations', () => {
  beforeEach(() => load())

  it.each<[string, CliReply, TencentMeetingState['account']]>([
    ['a sign-in the server accepts', CONNECTED, { state: 'connected', userName: '测试 用户', skills: 'installed' }],
    ['no sign-in', NOT_LOGGED_IN, { state: 'signed-out', skills: 'installed' }],
    ['a sign-in the CLI cleared after a failed refresh', SESSION_EXPIRED, { state: 'signed-out', skills: 'installed' }],
    ['a sign-in whose refresh token expired', REFRESH_EXPIRED, { state: 'signed-out', skills: 'installed' }],
    ['a stored sign-in the server did not confirm', UNVERIFIED, { state: 'unverified', skills: 'installed' }],
  ])('checks %s', async (_name, reply, expected) => {
    script[STATUS] = [reply]
    const id = start('check')
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'checking', cancellable: false })
    expect(await settled(id)).toEqual({ account: expected, result: { id, kind: 'check', outcome: 'succeeded' } })
  })

  it.each<[string, CliReply]>([
    ['a failed status command', { exitCode: 1, stderr: 'Error: failed to read user config' }],
    ['a status this version does not print', { stdout: 'Signed in as ou_fixture\n' }],
  ])('keeps the previous account and reports only the command and exit code on %s', async (_name, reply) => {
    script[STATUS] = [reply]
    const result = await settled(start('check'))
    expect(result).toEqual({
      account: { state: 'unchecked', skills: 'installed' },
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

    const id = start('sign-in')
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-in', phase: 'authorizing', cancellable: true })
    const authorizing = await login.promise
    authorizing.write('stderr', `authorize url: ${LOGIN_LINK}\n`)
    authorizing.write('stdout', '\nPlease open the following URL in your browser to authorize\n\n')
    authorizing.write('stdout', 'authorize url: http://meeting.tencent.com/insecure\nauthorize url: https://evil.example/auth\n')
    authorizing.write('stdout', `authorize url: ${LOGIN_LINK}\n\nwaiting for authorization...\n`)
    await vi.waitFor(() => { expect(account.snapshot().operation).toMatchObject({ phase: 'authorizing', authorizationUrl: LOGIN_LINK }) })
    authorizing.reply({ stdout: 'Login successful. Start managing your meetings using tmeet.\n' })

    expect(await settled(id)).toEqual({
      account: { state: 'connected', userName: '测试 用户', skills: 'installed' }, result: { id, kind: 'sign-in', outcome: 'succeeded' },
    })
    expect(commands()).toEqual([LOGIN, STATUS])
    expect(errors()).toEqual([])
  })

  it.each<[string, Record<string, CliReply[]>, NonNullable<TencentMeetingState['result']>['failure']]>([
    ['a failed sign-in', { [LOGIN]: [{ exitCode: 1, stdout: `authorize url: ${LOGIN_LINK}\n` }] }, { command: 'auth-login', exitCode: 1 }],
    ['a sign-in the server did not confirm', { [LOGIN]: [{}], [STATUS]: [UNVERIFIED] }, { command: 'auth-status', exitCode: 0 }],
  ])('fails on %s without exposing CLI output', async (_name, replies, failure) => {
    Object.assign(script, replies)
    const result = await settled(start('sign-in'))
    expect(result.result).toMatchObject({ kind: 'sign-in', outcome: 'failed', failure })
    expect(JSON.stringify({ result, errors: errors() })).not.toContain('fixture-code')
  })

  it('cancels only while waiting for authorization and withdraws the link', async () => {
    script[LOGIN] = (process) => { process.write('stdout', `authorize url: ${LOGIN_LINK}\n`) }
    const id = start('sign-in')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBe(LOGIN_LINK) })
    await account.cancel('other' as ConnectorOperationId)
    expect(account.snapshot().operation?.phase).toBe('authorizing')

    const cancelling = account.cancel(id)
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-in', phase: 'cancelling', cancellable: false })
    await cancelling
    expect(account.snapshot()).toEqual({ account: { state: 'unchecked', skills: 'installed' }, result: { id, kind: 'sign-in', outcome: 'cancelled' } })
    expect(subprocess.processes[0]?.terminated).toBe(true)
    expect(errors()).toEqual([])
  })

  it('signs out without cancellation, then checks again', async () => {
    script[STATUS] = [NOT_LOGGED_IN]
    const logout = Promise.withResolvers<ScriptedProcess>()
    script[LOGOUT] = (process) => { logout.resolve(process) }
    const id = start('sign-out')
    const signingOut = await logout.promise
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-out', phase: 'signing-out', cancellable: false })
    await account.cancel(id)
    signingOut.reply({ stdout: 'Logout success, welcome to use it again.\n' })

    expect(await settled(id)).toEqual({ account: { state: 'signed-out', skills: 'installed' }, result: { id, kind: 'sign-out', outcome: 'succeeded' } })
    expect(commands()).toEqual([LOGOUT, STATUS])
  })

  it('reports a failed sign-out without checking again', async () => {
    script[LOGOUT] = [{ exitCode: 1, stderr: 'Error: logout failed' }]
    const result = await settled(start('sign-out'))
    expect(result.result).toMatchObject({ kind: 'sign-out', outcome: 'failed', failure: { command: 'auth-logout', exitCode: 1 } })
    expect(commands()).toEqual([LOGOUT])
  })
})

describe('Tencent Meeting guide the plugin downloads', () => {
  let home: string
  /** Answers each request for the guide's archive. */
  let archive: () => Promise<Response>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-tencent-meeting-home-'))
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', () => archive())
  })

  afterEach(() => rm(home, { recursive: true, force: true }))

  it('restarts a failed download of the guide on each check without waiting for it, and reports the state it leaves', async () => {
    archive = () => Promise.reject(new Error('offline'))
    await load({})
    await vi.waitFor(() => { expect(account.snapshot().account.skills).toBe('failed') })

    archive = () => new Promise(() => {})
    script[STATUS] = [NOT_LOGGED_IN]
    const id = start('check')
    expect(account.snapshot().account).toEqual({ state: 'unchecked', skills: 'downloading' })
    expect(await settled(id)).toEqual({ account: { state: 'signed-out', skills: 'downloading' }, result: { id, kind: 'check', outcome: 'succeeded' } })
  })

  it('reports a new state of the guide with the current account', async () => {
    const download = Promise.withResolvers<Response>()
    archive = () => download.promise
    await load({})
    script[STATUS] = [NOT_LOGGED_IN]
    expect((await settled(start('check'))).account).toEqual({ state: 'signed-out', skills: 'downloading' })

    download.reject(new Error('offline'))

    await vi.waitFor(() => { expect(account.snapshot().account).toEqual({ state: 'signed-out', skills: 'failed' }) })
  })
})

describe('Tencent Meeting on the Plugins page', () => {
  beforeEach(() => load())

  const finished = async (id: ConnectorOperationId): Promise<TencentMeetingState['result']> => (await settled(id)).result

  it('checks on refresh, then starts checks, sign-ins, and sign-outs one at a time and cancels a sign-in', async () => {
    script[STATUS] = [NOT_LOGGED_IN]
    account.refresh()
    const check = account.snapshot().operation
    expect(account.snapshot()).toMatchObject({ account: { state: 'unchecked', skills: 'installed' }, operation: { kind: 'check' } })
    expect(await finished(check!.id)).toMatchObject({ kind: 'check', outcome: 'succeeded' })
    expect(account.snapshot().account).toEqual({ state: 'signed-out', skills: 'installed' })
    expect(subprocess.lookups[0]?.command).toBe(join(binDir, executableFileName(process.platform)))
    expect(await finished(start('check'))).toMatchObject({ kind: 'check', outcome: 'succeeded' })

    script[LOGIN] = () => {}
    const signingIn = start('sign-in')
    expect(() => start('check')).toThrow('another account operation is in progress')
    await vi.waitFor(() => { expect(commands().at(-1)).toBe(LOGIN) })
    await account.cancel(signingIn)
    expect(await finished(signingIn)).toMatchObject({ kind: 'sign-in', outcome: 'cancelled' })
    expect(subprocess.processes.at(-1)?.terminated).toBe(true)

    script[LOGOUT] = [{}]
    expect(await finished(start('sign-out'))).toMatchObject({ kind: 'sign-out', outcome: 'succeeded' })
  })

  it('stops account work on disposal', async () => {
    script[STATUS] = () => {}
    account.refresh()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })
    await ctx.fiber.dispose()
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })
})

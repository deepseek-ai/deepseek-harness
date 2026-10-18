/** Account operations over a scripted dws: status JSON, the download step, sign-in, sign-out, and the Remote wiring. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CliCommandExecutor, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DingtalkAccount } from '../src/account.ts'
import { PROGRAM } from '../src/release.ts'
import Dingtalk, { type DingtalkState } from '../src/index.ts'
import { createBinDir, createSkillsDir, ScriptedSubprocess, type CliReply, type ScriptedProcess } from './harness.ts'

const STATUS = 'auth status --format json'
const LOGIN = 'auth login --no-browser --format json'
const LOGOUT = 'auth logout --profile corp-fixture:user-fixture'
const LOGIN_LINK = 'https://login.dingtalk.com/oauth2/auth?client_id=fixture-client&state=fixture-state'
/** `binDir` and `skillsDir` download nothing, so the release prefix is never requested. */
const CONFIG = { commandTimeoutMs: 5_000, releaseUrls: ['https://releases.invalid/download'] }

const status = (fields: Record<string, unknown>): CliReply => ({ stdout: `${JSON.stringify({ success: true, ...fields }, null, 2)}\n` })
const CONNECTED = status({ authenticated: true, user_name: '测试用户', corp_name: '测试组织', corp_id: 'corp-fixture', user_id: 'user-fixture' })
const NAMELESS = status({ authenticated: true })
const SIGNED_OUT = status({ authenticated: false, message: '未登录' })
const EXPIRED = status({ authenticated: false, reason: 'token_refresh_failed', message: 'Token 刷新失败' })
const UNVERIFIED = status({ authenticated: false, reason: 'keychain_unavailable', message: '系统钥匙串不可用' })

type Script = (process: ScriptedProcess) => void

let ctx: Context
let subprocess: ScriptedSubprocess
let home: string
let binDir: string
let skillsDir: string
let script: Record<string, Script | CliReply[]>

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ScriptedSubprocess)
  await ctx.plugin(ShellEnv)
  subprocess = ctx.subprocess as ScriptedSubprocess
  home = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-home-'))
  vi.stubEnv('DSH_HOME', home)
  binDir = await createBinDir()
  skillsDir = await createSkillsDir()
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
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
  await rm(binDir, { recursive: true, force: true })
  await rm(skillsDir, { recursive: true, force: true })
})

const commands = () => subprocess.processes.map(process => process.spec.argv.slice(1).join(' '))
const errors = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args)

describe('DingtalkAccount', () => {
  let account: DingtalkAccount
  let release: { installed: () => boolean; install: (signal: AbortSignal) => Promise<void> }

  beforeEach(() => {
    ctx.shellEnv.registerPath({ name: 'dingtalk', directories: [binDir], programs: [PROGRAM] })
    const cli = new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: PROGRAM, commandTimeoutMs: 5_000 })
    release = { installed: () => true, install: vi.fn(() => Promise.resolve()) }
    account = new DingtalkAccount(cli, ctx.logger, release)
  })

  afterEach(() => account.dispose())

  const settled = async (id: CliOperationId): Promise<DingtalkState> => {
    await vi.waitFor(() => { expect(account.snapshot().result?.id).toBe(id) })
    return account.snapshot()
  }

  it.each<[string, CliReply, DingtalkState['account']]>([
    ['a signed-in user with names', CONNECTED, { state: 'connected', userName: '测试用户', corpName: '测试组织' }],
    ['a signed-in user without names', NAMELESS, { state: 'connected' }],
    ['no sign-in', SIGNED_OUT, { state: 'signed-out' }],
    ['a sign-in whose refresh failed', EXPIRED, { state: 'signed-out' }],
    ['a sign-in dws cannot judge', UNVERIFIED, { state: 'unverified' }],
  ])('checks %s', async (_name, reply, expected) => {
    script[STATUS] = [reply]
    const id = account.start('check')
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'checking', cancellable: false })
    expect(await settled(id)).toEqual({ account: expected, result: { id, kind: 'check', outcome: 'succeeded' } })
    expect(release.install).not.toHaveBeenCalled()
  })

  it.each<[string, CliReply]>([
    ['a failed status command', { exitCode: 1, stderr: '{"error":{"message":"internal"}}' }],
    ['a status that is not JSON', { stdout: '状态:          未登录\n' }],
    ['a status without the authenticated field', status({ message: 'unexpected' })],
  ])('keeps the previous account and reports only the command and exit code on %s', async (_name, reply) => {
    script[STATUS] = [reply]
    const result = await settled(account.start('check'))
    expect(result).toEqual({
      account: { state: 'unchecked' },
      result: { id: result.result?.id, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: reply.exitCode ?? 0 } },
    })
    expect(errors()).toEqual([['dingtalk: account operation failed: %o', {
      id: result.result?.id, kind: 'check', phase: 'checking', command: 'auth-status', exitCode: reply.exitCode ?? 0,
    }]])
  })

  it('installs dws and its skills in their own non-cancellable step before the first command', async () => {
    let installed = false
    const download = Promise.withResolvers<undefined>()
    release.installed = () => installed
    release.install = vi.fn(async () => { await download.promise; installed = true })
    script[STATUS] = [SIGNED_OUT]

    const id = account.start('check')
    await vi.waitFor(() => { expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'downloading', cancellable: false }) })
    await account.cancel(id)
    expect(commands()).toEqual([])
    download.resolve(undefined)

    expect(await settled(id)).toEqual({ account: { state: 'signed-out' }, result: { id, kind: 'check', outcome: 'succeeded' } })
    expect(release.install).toHaveBeenCalledOnce()
    expect(commands()).toEqual([STATUS])
  })

  it('reports a download that did not finish without running a command', async () => {
    release.installed = () => false
    release.install = vi.fn(() => Promise.reject(new Error('dingtalk: could not download dws 1.0.64 from any release URL')))
    const result = await settled(account.start('check'))
    expect(result).toEqual({ account: { state: 'not-installed' }, result: { id: result.result?.id, kind: 'check', outcome: 'failed' } })
    expect(errors()).toEqual([['dingtalk: account operation failed: %o', { id: result.result?.id, kind: 'check', phase: 'downloading' }]])
    expect(commands()).toEqual([])
  })

  it('signs in through the authorization page, offers only trusted stderr links, and confirms the sign-in', async () => {
    script[STATUS] = [CONNECTED]
    const login = Promise.withResolvers<ScriptedProcess>()
    script[LOGIN] = (process) => { login.resolve(process) }

    const id = account.start('sign-in')
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-in', phase: 'authorizing', cancellable: true })
    const authorizing = await login.promise
    authorizing.write('stdout', `  ${LOGIN_LINK}\n`)
    authorizing.write('stderr', '\n🔐 登录钉钉\n\n请在浏览器中完成扫码授权。\n如果浏览器未自动打开，请手动访问:\n')
    authorizing.write('stderr', '  http://login.dingtalk.com/oauth2/auth?state=insecure\n  https://evil.example/oauth2/auth\n')
    authorizing.write('stderr', `  ${LOGIN_LINK}\n\n⏳ 等待授权中...\n`)
    await vi.waitFor(() => { expect(account.snapshot().operation).toMatchObject({ phase: 'authorizing', authorizationUrl: LOGIN_LINK }) })
    authorizing.reply({ stdout: '{"success": true, "message": "登录成功", "user_name": "测试用户"}\n' })

    expect(await settled(id)).toEqual({
      account: { state: 'connected', userName: '测试用户', corpName: '测试组织' }, result: { id, kind: 'sign-in', outcome: 'succeeded' },
    })
    expect(commands()).toEqual([LOGIN, STATUS])
    expect(errors()).toEqual([])
  })

  it.each<[string, Record<string, CliReply[]>, NonNullable<DingtalkState['result']>['failure']]>([
    ['a failed sign-in', { [LOGIN]: [{ exitCode: 2, stderr: `  ${LOGIN_LINK}\n{"error":{"message":"该组织尚未开启CLI数据访问权限"}}\n` }] },
      { command: 'auth-login', exitCode: 2 }],
    ['a sign-in that left no account', { [LOGIN]: [{}], [STATUS]: [SIGNED_OUT] }, { command: 'auth-status', exitCode: 0 }],
  ])('fails on %s without exposing CLI output', async (_name, replies, failure) => {
    Object.assign(script, replies)
    const result = await settled(account.start('sign-in'))
    expect(result.result).toMatchObject({ kind: 'sign-in', outcome: 'failed', failure })
    expect(JSON.stringify({ result, errors: errors() })).not.toContain('fixture-state')
  })

  it('cancels only while waiting for authorization and withdraws the link', async () => {
    script[LOGIN] = (process) => { process.write('stderr', `  ${LOGIN_LINK}\n`) }
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

  it('signs out only the account the last check found, without cancellation, then checks again', async () => {
    script[STATUS] = [CONNECTED, SIGNED_OUT]
    await settled(account.start('check'))
    const logout = Promise.withResolvers<ScriptedProcess>()
    script[LOGOUT] = (process) => { logout.resolve(process) }
    const id = account.start('sign-out')
    const signingOut = await logout.promise
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-out', phase: 'signing-out', cancellable: false })
    await account.cancel(id)
    signingOut.reply({ stdout: '[OK] 已清除认证信息\n' })

    expect(await settled(id)).toEqual({ account: { state: 'signed-out' }, result: { id, kind: 'sign-out', outcome: 'succeeded' } })
    expect(commands()).toEqual([STATUS, LOGOUT, STATUS])
  })

  it.each<[string, CliReply[]]>([
    ['before any check', []],
    ['after a check found no sign-in', [SIGNED_OUT]],
    ['when the signed-in account has no ids', [NAMELESS]],
  ])('refuses to sign out %s instead of signing out every account', async (_name, checks) => {
    script[STATUS] = checks
    if (checks.length > 0) await settled(account.start('check'))
    const result = await settled(account.start('sign-out'))
    expect(result.result).toEqual({ id: result.result?.id, kind: 'sign-out', outcome: 'failed' })
    expect(commands()).toEqual(checks.map(() => STATUS))
  })

  it('reports a failed sign-out without checking again', async () => {
    script[STATUS] = [CONNECTED]
    await settled(account.start('check'))
    script[LOGOUT] = [{ exitCode: 1, stderr: '{"error":{"message":"logout failed"}}' }]
    const result = await settled(account.start('sign-out'))
    expect(result.result).toMatchObject({ kind: 'sign-out', outcome: 'failed', failure: { command: 'auth-logout', exitCode: 1 } })
    expect(commands()).toEqual([STATUS, LOGOUT])
  })
})

describe('DingTalk Remote', () => {
  it('checks once on load and for a new follower, streams each change, and starts checks, sign-ins, and sign-outs', async () => {
    script[STATUS] = [SIGNED_OUT]
    await ctx.plugin(Dingtalk, { ...CONFIG, binDir, skillsDir })
    await vi.waitFor(() => { expect(ctx.dingtalk).toBeDefined() })
    await vi.waitFor(() => { expect(commands()).toEqual([STATUS]) })

    const states: DingtalkState[] = []
    const leave = new AbortController()
    const following = (async () => {
      for await (const state of ctx.dingtalk.follow(leave.signal)) states.push(state)
    })()
    const finished = async (id: CliOperationId): Promise<DingtalkState['result']> => {
      await vi.waitFor(() => { expect(states.at(-1)?.result?.id).toBe(id) })
      return states.at(-1)?.result
    }
    await vi.waitFor(() => { expect(states.at(-1)?.account).toEqual({ state: 'signed-out' }) })
    expect(await finished(ctx.dingtalk.check())).toMatchObject({ kind: 'check', outcome: 'succeeded' })

    script[LOGIN] = () => {}
    const signingIn = ctx.dingtalk.signIn()
    expect(() => ctx.dingtalk.check()).toThrow('another account operation is in progress')
    await vi.waitFor(() => { expect(commands().at(-1)).toBe(LOGIN) })
    await ctx.dingtalk.cancel(signingIn)
    expect(await finished(signingIn)).toMatchObject({ kind: 'sign-in', outcome: 'cancelled' })
    expect(subprocess.processes.at(-1)?.terminated).toBe(true)

    expect(await finished(ctx.dingtalk.signOut())).toMatchObject({ kind: 'sign-out', outcome: 'failed' })
    leave.abort()
    await following
  })

  it('ends its streams and stops account work on disposal', async () => {
    script[STATUS] = () => {}
    await ctx.plugin(Dingtalk, { ...CONFIG, binDir, skillsDir })
    const states: DingtalkState[] = []
    const following = (async () => {
      for await (const state of ctx.dingtalk.follow(new AbortController().signal)) states.push(state)
    })()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })
    await ctx.fiber.dispose()
    await following
    expect(states.length).toBeGreaterThan(0)
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })
})

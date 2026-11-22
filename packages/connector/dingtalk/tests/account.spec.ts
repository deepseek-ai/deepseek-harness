/** Account operations over a scripted dws: the load-time check, status JSON, the download step, sign-in, sign-out, and disposal. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectorOperationId } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import * as Dingtalk from '../src/index.ts'
import { DWS_RELEASE, executableFileName } from '../src/release.ts'
import type { DingtalkOperationKind, DingtalkState } from '../src/types.ts'
import {
  closeHost, createHost, type CliReply, type DingtalkHost, type DingtalkPage, type ScriptedProcess, type ScriptedSubprocess,
} from './harness.ts'

const STATUS = 'auth status --format json'
const LOGIN = 'auth login --no-browser --format json'
const LOGOUT = 'auth logout --profile corp-fixture:user-fixture'
const LOGIN_LINK = 'https://login.dingtalk.com/oauth2/auth?client_id=fixture-client&state=fixture-state'
const CONFIG = { releaseUrls: ['https://releases.invalid/download'], releaseTimeoutMs: 5_000 }

const status = (fields: Record<string, unknown>): CliReply => ({ stdout: `${JSON.stringify({ success: true, ...fields }, null, 2)}\n` })
const CONNECTED = status({ authenticated: true, user_name: '测试用户', corp_name: '测试组织', corp_id: 'corp-fixture', user_id: 'user-fixture' })
const NAMELESS = status({ authenticated: true })
const SIGNED_OUT = status({ authenticated: false, message: '未登录' })
const EXPIRED = status({ authenticated: false, reason: 'token_refresh_failed', message: 'Token 刷新失败' })
const UNVERIFIED = status({ authenticated: false, reason: 'keychain_unavailable', message: '系统钥匙串不可用' })

type Script = (process: ScriptedProcess) => void

let host: DingtalkHost
let ctx: Context
let subprocess: ScriptedSubprocess
let home: string
let binDir: string
let skillsDir: string
/** The account the plugin registered, as the Plugins page registry drives it. */
let account: DingtalkPage['source']
/** Replies per command; a list gives one reply per run and repeats its last. */
let script: Record<string, Script | CliReply[]>
/** The release download; it reaches no source unless a case answers it. */
let download: Mock<typeof fetch>

beforeEach(async () => {
  host = await createHost()
  ;({ ctx, subprocess, home, binDir, skillsDir } = host)
  script = {}
  subprocess.respond = (process) => {
    const handler = script[process.spec.argv.slice(1).join(' ')]
    if (handler === undefined) process.reply({ exitCode: 1, stderr: `unexpected: ${process.spec.argv.join(' ')}` })
    else if (Array.isArray(handler)) process.reply(handler.length > 1 ? handler.shift()! : handler[0]!)
    else handler(process)
  }
  download = vi.fn<typeof fetch>(() => Promise.reject(new Error('no release source answers in this spec')))
  vi.stubGlobal('fetch', download)
})

afterEach(async () => {
  await closeHost(host)
  vi.unstubAllGlobals()
})

/** Load the plugin, which starts its check; without `skillsDir` that check first downloads the skills. */
const mount = async (config: { skillsDir?: string } = { skillsDir }): Promise<void> => {
  await ctx.plugin(Dingtalk, { ...CONFIG, binDir, ...config })
  account = host.pages[0]!.source
}
/** Load the plugin and wait for its check to settle. */
const load = async (config?: { skillsDir?: string }): Promise<void> => {
  await mount(config)
  await vi.waitFor(() => { expect(account.snapshot().result).toBeDefined() })
}
/** Start an operation as a page button does; the CLI account Service starts it before returning. */
const start = (kind: DingtalkOperationKind): ConnectorOperationId => {
  const id = account.start(kind)
  if (typeof id !== 'string') throw new Error('the operation did not start at once')
  return id
}
const settled = async (id: ConnectorOperationId): Promise<DingtalkState> => {
  await vi.waitFor(() => { expect(account.snapshot().result?.id).toBe(id) })
  return account.snapshot()
}
const commands = () => subprocess.processes.map(process => process.spec.argv.slice(1).join(' '))
const errors = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args)

describe('DingTalk account operations', () => {
  it('checks once on load by the dws path, then runs one operation at a time', async () => {
    script[STATUS] = [SIGNED_OUT]
    await load()
    expect(commands()).toEqual([STATUS])
    expect(subprocess.lookups[0]?.command).toBe(join(binDir, executableFileName(process.platform)))
    expect(account.snapshot()).toMatchObject({ account: { state: 'signed-out' }, result: { kind: 'check', outcome: 'succeeded' } })

    script[LOGIN] = () => {}
    const signingIn = start('sign-in')
    expect(() => account.start('check')).toThrow('another account operation is in progress')
    await account.cancel(signingIn)
    expect((await settled(signingIn)).result).toMatchObject({ kind: 'sign-in', outcome: 'cancelled' })
  })

  it.each<[string, CliReply, DingtalkState['account']]>([
    ['a signed-in user with names', CONNECTED, { state: 'connected', userName: '测试用户', corpName: '测试组织' }],
    ['a signed-in user without names', NAMELESS, { state: 'connected' }],
    ['no sign-in', SIGNED_OUT, { state: 'signed-out' }],
    ['a sign-in whose refresh failed', EXPIRED, { state: 'signed-out' }],
    ['a sign-in dws cannot judge', UNVERIFIED, { state: 'unverified' }],
  ])('checks %s', async (_name, reply, expected) => {
    script[STATUS] = [SIGNED_OUT, reply]
    await load()
    const id = start('check')
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'checking', cancellable: false })
    expect(await settled(id)).toEqual({ account: expected, result: { id, kind: 'check', outcome: 'succeeded' } })
    expect(download).not.toHaveBeenCalled()
  })

  it.each<[string, CliReply]>([
    ['a failed status command', { exitCode: 1, stderr: '{"error":{"message":"internal"}}' }],
    ['a status that is not JSON', { stdout: '状态:          未登录\n' }],
    ['a status without the authenticated field', status({ message: 'unexpected' })],
  ])('keeps the previous account and reports only the command and exit code on %s', async (_name, reply) => {
    script[STATUS] = [SIGNED_OUT, reply]
    await load()
    const result = await settled(start('check'))
    expect(result).toEqual({
      account: { state: 'signed-out' },
      result: { id: result.result?.id, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: reply.exitCode ?? 0 } },
    })
    expect(errors()).toEqual([['dingtalk: account operation failed: %o', {
      id: result.result?.id, kind: 'check', phase: 'checking', command: 'auth-status', exitCode: reply.exitCode ?? 0,
    }]])
  })

  it('reports a download that did not finish without running a command', async () => {
    await load({})
    const result = account.snapshot()
    expect(result).toEqual({ account: { state: 'not-installed' }, result: { id: result.result?.id, kind: 'check', outcome: 'failed' } })
    expect(errors()).toEqual([['dingtalk: account operation failed: %o', { id: result.result?.id, kind: 'check', phase: 'downloading' }]])
    expect(download).toHaveBeenCalledOnce()
    expect(commands()).toEqual([])
  })

  it('finishes the installation in its own step before the first command', async () => {
    await load({})
    await mkdir(join(home, 'cache', 'dingtalk', `dws-skills-${DWS_RELEASE.version}`, 'dingtalk-shared'), { recursive: true })
    script[STATUS] = [SIGNED_OUT]

    const id = start('check')
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'downloading', cancellable: true })
    expect(commands()).toEqual([])

    expect(await settled(id)).toEqual({ account: { state: 'signed-out' }, result: { id, kind: 'check', outcome: 'succeeded' } })
    expect(account.snapshot().operation).toBeUndefined()
    expect(commands()).toEqual([STATUS])
  })

  it('cancels a download, which leaves dws not installed and runs no command', async () => {
    download.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason as Error) }, { once: true })
    }))
    await mount({})
    const id = account.snapshot().operation!.id
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'downloading', cancellable: true })
    await vi.waitFor(() => { expect(download).toHaveBeenCalledOnce() })

    const cancelling = account.cancel(id)
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'cancelling', cancellable: false })
    await cancelling

    expect(account.snapshot()).toEqual({ account: { state: 'not-installed' }, result: { id, kind: 'check', outcome: 'cancelled' } })
    expect(commands()).toEqual([])
    expect(errors()).toEqual([])
  })

  it('signs in through the authorization page, offers only trusted stderr links, and confirms the sign-in', async () => {
    script[STATUS] = [SIGNED_OUT, CONNECTED]
    await load()
    const login = Promise.withResolvers<ScriptedProcess>()
    script[LOGIN] = (process) => { login.resolve(process) }

    const id = start('sign-in')
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
    expect(commands()).toEqual([STATUS, LOGIN, STATUS])
    expect(errors()).toEqual([])
  })

  it.each<[string, CliReply[], NonNullable<DingtalkState['result']>['failure']]>([
    ['a failed sign-in', [{ exitCode: 2, stderr: `  ${LOGIN_LINK}\n{"error":{"message":"该组织尚未开启CLI数据访问权限"}}\n` }], { command: 'auth-login', exitCode: 2 }],
    ['a sign-in that left no account', [{}], { command: 'auth-status', exitCode: 0 }],
  ])('fails on %s without exposing CLI output', async (_name, login, failure) => {
    script[STATUS] = [SIGNED_OUT]
    script[LOGIN] = login
    await load()
    const result = await settled(start('sign-in'))
    expect(result.result).toMatchObject({ kind: 'sign-in', outcome: 'failed', failure })
    expect(JSON.stringify({ result, errors: errors() })).not.toContain('fixture-state')
  })

  it('cancels only while waiting for authorization and withdraws the link', async () => {
    script[STATUS] = [SIGNED_OUT]
    script[LOGIN] = (process) => { process.write('stderr', `  ${LOGIN_LINK}\n`) }
    await load()
    const id = start('sign-in')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBe(LOGIN_LINK) })
    await account.cancel('other' as ConnectorOperationId)
    expect(account.snapshot().operation?.phase).toBe('authorizing')

    const cancelling = account.cancel(id)
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-in', phase: 'cancelling', cancellable: false })
    await cancelling
    expect(account.snapshot()).toEqual({ account: { state: 'signed-out' }, result: { id, kind: 'sign-in', outcome: 'cancelled' } })
    expect(subprocess.processes.at(-1)?.terminated).toBe(true)
    expect(errors()).toEqual([])
  })

  it('signs out only the account the last check found, without cancellation, then checks again', async () => {
    script[STATUS] = [CONNECTED, SIGNED_OUT]
    await load()
    const logout = Promise.withResolvers<ScriptedProcess>()
    script[LOGOUT] = (process) => { logout.resolve(process) }
    const id = start('sign-out')
    const signingOut = await logout.promise
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-out', phase: 'signing-out', cancellable: false })
    await account.cancel(id)
    signingOut.reply({ stdout: '[OK] 已清除认证信息\n' })

    expect(await settled(id)).toEqual({ account: { state: 'signed-out' }, result: { id, kind: 'sign-out', outcome: 'succeeded' } })
    expect(commands()).toEqual([STATUS, LOGOUT, STATUS])
  })

  it.each<[string, CliReply]>([
    ['after a failed check', { exitCode: 1, stderr: '{"error":{"message":"internal"}}' }],
    ['after a check found no sign-in', SIGNED_OUT],
    ['when the signed-in account has no ids', NAMELESS],
  ])('refuses to sign out %s instead of signing out every account', async (_name, check) => {
    script[STATUS] = [check]
    await load()
    const result = await settled(start('sign-out'))
    expect(result.result).toEqual({ id: result.result?.id, kind: 'sign-out', outcome: 'failed' })
    expect(commands()).toEqual([STATUS])
  })

  it('reports a failed sign-out without checking again', async () => {
    script[STATUS] = [CONNECTED]
    script[LOGOUT] = [{ exitCode: 1, stderr: '{"error":{"message":"logout failed"}}' }]
    await load()
    const result = await settled(start('sign-out'))
    expect(result.result).toMatchObject({ kind: 'sign-out', outcome: 'failed', failure: { command: 'auth-logout', exitCode: 1 } })
    expect(commands()).toEqual([STATUS, LOGOUT])
  })

  it('stops account work on disposal', async () => {
    script[STATUS] = () => {}
    await mount()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })
    await ctx.fiber.dispose()
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })
})

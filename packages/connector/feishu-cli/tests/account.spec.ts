/** Account operations over a scripted lark-cli: checks, app linking, sign-in, sign-out, cancellation, and the Remote wiring. */
import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuAccount } from '../src/account.ts'
import { FeishuCli } from '../src/cli.ts'
import Feishu, { type FeishuAppId, type FeishuOperationId, type FeishuState } from '../src/index.ts'
import { createBinDir, ScriptedSubprocess, type CliReply, type ScriptedProcess } from './harness.ts'

const LIMITS = { commandTimeoutMs: 5_000, authorizationTimeoutMs: 5_000, maxOutputBytes: 1_048_576 }
const APP = 'cli_a' as FeishuAppId
const STATUS = 'auth status --verify --json'
const NOT_CONFIGURED: CliReply = { exitCode: 3, stderr: JSON.stringify({ ok: false, error: { type: 'config', subtype: 'not_configured', message: 'not configured' } }) }
const status = (user: Record<string, unknown>): CliReply => ({ stdout: JSON.stringify({ appId: APP, identities: { user } }) })
const CONNECTED = status({ status: 'ready', available: true, verified: true, userName: '张三', openId: 'ou_1' })
const SIGNED_OUT = status({ status: 'missing', available: false })
const LOGIN_LINK = JSON.stringify({ event: 'device_authorization', verification_uri_complete: 'https://accounts.feishu.cn/oauth/device?code=1' })
const login = (missing: string[] = [], openId = 'ou_1') => JSON.stringify({ event: 'authorization_complete', user_open_id: openId, missing })

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

describe('FeishuAccount', () => {
  let account: FeishuAccount
  let changes: number

  beforeEach(() => {
    ctx.shellEnv.registerPath({ name: 'feishu', directories: [binDir] })
    changes = 0
    account = new FeishuAccount(new FeishuCli(ctx.subprocess, ctx.shellEnv, LIMITS), LIMITS, () => { changes++ })
  })

  const start = (kind: Parameters<FeishuAccount['start']>[0]) => account.start(kind)
  const settled = async (id: FeishuOperationId): Promise<FeishuState> => {
    await vi.waitFor(() => { expect(account.snapshot().result?.id).toBe(id) })
    return account.snapshot()
  }

  it.each<[string, CliReply, FeishuState['account']]>([
    ['no app', NOT_CONFIGURED, { state: 'unconfigured' }],
    ['a verified user', CONNECTED, { state: 'connected', appId: APP, userName: '张三' }],
    ['a verified user without a name', status({ status: 'ready', available: true, verified: true }), { state: 'connected', appId: APP }],
    ['a missing user', SIGNED_OUT, { state: 'signed-out', appId: APP }],
    ['an expired user', status({ status: 'needs_refresh', available: true, verified: false }), { state: 'signed-out', appId: APP }],
    ['a failed verification', status({ status: 'verify_failed', available: true, verified: false }), { state: 'unverified', appId: APP }],
  ])('checks %s', async (_name, reply, expected) => {
    script[STATUS] = [reply]
    const id = account.start('check')
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'checking' })
    expect(await settled(id)).toEqual({ account: expected, result: { id, kind: 'check', outcome: 'succeeded' } })
    expect(changes).toBeGreaterThan(0)
  })

  it.each<[string, CliReply]>([
    ['an unexpected status failure', { exitCode: 1, stderr: '{"ok":false,"error":{"subtype":"network"}}' }],
    ['a status failure without JSON', { exitCode: 1, stderr: 'boom' }],
  ])('keeps the previous account and fails on %s', async (_name, reply) => {
    script[STATUS] = [reply]
    expect(await settled(account.start('check'))).toMatchObject({ account: { state: 'unchecked' }, result: { outcome: 'failed' } })
  })

  it('links an app through its setup page, offers only a trusted link, and stops before sign-in', async () => {
    script[STATUS] = [SIGNED_OUT]
    const setup = Promise.withResolvers<ScriptedProcess>()
    script['config init --new'] = (process) => { setup.resolve(process) }

    const id = account.start('link-app')
    const configuring = await setup.promise
    configuring.write('stderr', 'Open this link:\n  http://open.feishu.cn/page/cli?x=1\n  https://evil.example/page\n')
    configuring.write('stderr', '  https://open.feishu.cn/page/cli?x=2\n  https://open.feishu.cn/page/cli?x=3\n')
    await vi.waitFor(() => { expect(account.snapshot().operation).toMatchObject({ phase: 'configuring', authorizationUrl: 'https://open.feishu.cn/page/cli?x=2' }) })
    configuring.reply({})

    expect(await settled(id)).toEqual({ account: { state: 'signed-out', appId: APP }, result: { id, kind: 'link-app', outcome: 'succeeded' } })
    expect(commands()).toEqual(['config init --new', STATUS])
  })

  it('signs in through the authorization page and accepts a sign-in that leaves permissions ungranted', async () => {
    script[STATUS] = [CONNECTED]
    const signIn = Promise.withResolvers<ScriptedProcess>()
    script['auth login --json'] = (process) => { signIn.resolve(process) }

    const id = account.start('sign-in')
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-in', phase: 'authorizing' })
    const authorizing = await signIn.promise
    const invalid = JSON.stringify({ event: 'device_authorization', verification_uri_complete: 'not a url' })
    authorizing.write('stdout', `progress\n{"event":"other"}\n${invalid}\n${LOGIN_LINK}\n`)
    await vi.waitFor(() => { expect(account.snapshot().operation).toMatchObject({ phase: 'authorizing', authorizationUrl: 'https://accounts.feishu.cn/oauth/device?code=1' }) })
    authorizing.reply({ stdout: login(['im:message']) + '\n', exitCode: 3 })

    expect(await settled(id)).toEqual({
      account: { state: 'connected', appId: APP, userName: '张三', ungrantedPermissions: 1 },
      result: { id, kind: 'sign-in', outcome: 'succeeded' },
    })
    expect(commands()).toEqual(['auth login --json', STATUS])
  })

  it('keeps the ungranted count for the signed-in user until a full sign-in, another user, or a sign-out', async () => {
    const OTHER = status({ status: 'ready', available: true, verified: true, openId: 'ou_2' })
    script[STATUS] = [CONNECTED, CONNECTED, OTHER, CONNECTED, CONNECTED, SIGNED_OUT, CONNECTED]
    script['auth login --json'] = [{ stdout: login(['im:message', 'drive:file']) + '\n', exitCode: 3 }, { stdout: login() + '\n' }]
    script['auth logout --json'] = [{ stdout: '{"ok":true}' }]
    const account = async (kind: 'check' | 'sign-in' | 'sign-out') => (await settled(start(kind))).account

    expect(await account('sign-in')).toEqual({ state: 'connected', appId: APP, userName: '张三', ungrantedPermissions: 2 })
    expect(await account('check')).toEqual({ state: 'connected', appId: APP, userName: '张三', ungrantedPermissions: 2 })
    expect(await account('check')).toEqual({ state: 'connected', appId: APP })
    expect(await account('check')).toEqual({ state: 'connected', appId: APP, userName: '张三', ungrantedPermissions: 2 })
    script['auth login --json'] = [{ stdout: login(['im:message']) + '\n', exitCode: 3 }]
    expect(await account('sign-in')).toEqual({ state: 'connected', appId: APP, userName: '张三', ungrantedPermissions: 1 })
    expect(await account('sign-out')).toEqual({ state: 'signed-out', appId: APP })
    expect(await account('check')).toEqual({ state: 'connected', appId: APP, userName: '张三' })
  })

  it('drops the ungranted count when the CLI has no app', async () => {
    script[STATUS] = [CONNECTED, NOT_CONFIGURED, CONNECTED]
    script['auth login --json'] = [{ stdout: login(['im:message']) + '\n', exitCode: 3 }]
    expect((await settled(start('sign-in'))).account).toMatchObject({ ungrantedPermissions: 1 })
    expect((await settled(start('check'))).account).toEqual({ state: 'unconfigured' })
    expect((await settled(start('check'))).account).toEqual({ state: 'connected', appId: APP, userName: '张三' })
  })

  it.each<[string, 'link-app' | 'sign-in', Record<string, CliReply[]>]>([
    ['a failed app setup', 'link-app', { 'config init --new': [{ exitCode: 1 }] }],
    ['an app setup that left no app', 'link-app', { [STATUS]: [NOT_CONFIGURED], 'config init --new': [{}] }],
    ['a sign-in without completion', 'sign-in', { 'auth login --json': [{ stdout: LOGIN_LINK + '\n' }] }],
    ['a failed sign-in', 'sign-in', { 'auth login --json': [{ stdout: login() + '\n', exitCode: 1 }] }],
    ['a partial sign-in that reports no missing permission', 'sign-in', { 'auth login --json': [{ stdout: login() + '\n', exitCode: 3 }] }],
    ['a different signed-in user', 'sign-in', { [STATUS]: [CONNECTED], 'auth login --json': [{ stdout: login([], 'ou_2') + '\n' }] }],
    ['an unverified sign-in', 'sign-in', { [STATUS]: [SIGNED_OUT], 'auth login --json': [{ stdout: login() + '\n' }] }],
  ])('fails on %s', async (_name, kind, replies) => {
    Object.assign(script, replies)
    expect((await settled(account.start(kind))).result).toMatchObject({ kind, outcome: 'failed' })
  })

  it('cancels only the named operation, withdraws its link, and ignores later output', async () => {
    script[STATUS] = [SIGNED_OUT]
    const signIn = Promise.withResolvers<ScriptedProcess>()
    script['auth login --json'] = (process) => { process.write('stdout', LOGIN_LINK + '\n'); signIn.resolve(process) }
    const id = account.start('sign-in')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBeDefined() })
    await account.cancel('other' as FeishuOperationId)
    expect(account.snapshot().operation?.phase).toBe('authorizing')

    const process = await signIn.promise
    process.holdExit = true
    const cancelling = account.cancel(id)
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-in', phase: 'cancelling' })
    process.write('stdout', LOGIN_LINK + '\n')
    process.release()
    await cancelling
    expect(account.snapshot()).toEqual({ account: { state: 'unchecked' }, result: { id, kind: 'sign-in', outcome: 'cancelled' } })
  })

  it('runs one operation at a time and refreshes only when idle', async () => {
    const gate = Promise.withResolvers<ScriptedProcess>()
    script[STATUS] = (process) => { gate.resolve(process) }
    const id = account.start('check')
    expect(() => account.start('sign-in')).toThrow('another account operation is in progress')
    account.refresh()
    expect(subprocess.processes).toHaveLength(0)
    ;(await gate.promise).reply(CONNECTED)
    await settled(id)
    script[STATUS] = [CONNECTED]
    account.refresh()
    await vi.waitFor(() => { expect(commands()).toEqual([STATUS, STATUS]) })
  })

  it('signs out and reports a rejected sign-out', async () => {
    script[STATUS] = [SIGNED_OUT]
    script['auth logout --json'] = [{ stdout: '{"ok":true}' }, { exitCode: 1 }]
    const id = account.start('sign-out')
    expect(account.snapshot().operation?.phase).toBe('signing-out')
    expect(await settled(id)).toEqual({ account: { state: 'signed-out', appId: APP }, result: { id, kind: 'sign-out', outcome: 'succeeded' } })
    expect((await settled(account.start('sign-out'))).result).toMatchObject({ kind: 'sign-out', outcome: 'failed' })
  })

  it('cancels the active operation on disposal and refuses new work', async () => {
    script[STATUS] = () => {}
    account.start('check')
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })
    await account.dispose()
    expect(subprocess.processes[0]?.terminated).toBe(true)
    expect(() => account.start('link-app')).toThrow('plugin disposed')
    account.refresh()
    await account.dispose()
    expect(subprocess.processes).toHaveLength(1)
  })
})

describe('Feishu Remote', () => {
  beforeEach(async () => {
    await ctx.plugin(Feishu, { ...LIMITS, binDir })
  })

  it('checks for each new follower, streams each change, and starts checks, app links, sign-ins, and sign-outs', async () => {
    script[STATUS] = [SIGNED_OUT]
    const leave = new AbortController()
    const seen: FeishuState[] = []
    const following = (async () => {
      for await (const state of ctx.feishu.follow(leave.signal)) {
        seen.push(state)
        if (state.result !== undefined) leave.abort()
      }
    })()
    await following
    expect(seen[0]).toMatchObject({ account: { state: 'unchecked' }, operation: { kind: 'check' } })
    expect(seen.at(-1)).toMatchObject({ account: { state: 'signed-out' }, result: { kind: 'check', outcome: 'succeeded' } })

    script['auth logout --json'] = [{ stdout: '{"ok":true}' }]
    const signingOut = ctx.feishu.signOut()
    expect(() => ctx.feishu.signIn()).toThrow('another account operation is in progress')
    await ctx.feishu.cancel(signingOut)
    script[STATUS] = [SIGNED_OUT]
    await ctx.feishu.cancel(ctx.feishu.check())
    await ctx.feishu.cancel(ctx.feishu.linkApp())
    script['auth login --json'] = () => {}
    const signingIn = ctx.feishu.signIn()
    await vi.waitFor(() => { expect(commands().at(-1)).toBe('auth login --json') })
    await ctx.feishu.cancel(signingIn)
    expect(subprocess.processes.at(-1)?.terminated).toBe(true)
  })

  it('ends its streams and stops account work on disposal', async () => {
    script[STATUS] = () => {}
    const states: FeishuState[] = []
    const following = (async () => {
      for await (const state of ctx.feishu.follow(new AbortController().signal)) states.push(state)
    })()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })
    await ctx.fiber.dispose()
    await following
    expect(states.length).toBeGreaterThan(0)
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })
})

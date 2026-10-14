/** Account operations over a scripted lark-cli: checks, app linking, sign-in, sign-out, cancellation, and the Remote wiring. */
import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { CliCommandExecutor, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuAccount } from '../src/account.ts'
import { PROGRAM } from '../src/cli.ts'
import Feishu, { type FeishuAppId, type FeishuState } from '../src/index.ts'
import { createBinDir, ScriptedSubprocess, type CliReply, type ScriptedProcess } from './harness.ts'

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
const errors = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args)

describe('FeishuAccount', () => {
  let account: FeishuAccount

  beforeEach(() => {
    ctx.shellEnv.registerPath({ name: 'feishu', directories: [binDir], programs: [PROGRAM] })
    const cli = new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: PROGRAM, commandTimeoutMs: 5_000 })
    account = new FeishuAccount(cli, ctx.logger)
  })

  afterEach(() => account.dispose())

  const settled = async (id: CliOperationId): Promise<FeishuState> => {
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
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'checking', cancellable: false })
    expect(await settled(id)).toEqual({ account: expected, result: { id, kind: 'check', outcome: 'succeeded' } })
  })

  it.each<[string, CliReply]>([
    ['an unexpected status failure', { exitCode: 1, stderr: '{"ok":false,"error":{"subtype":"network"}}' }],
    ['a status failure without JSON', { exitCode: 1, stderr: 'boom' }],
  ])('keeps the previous account and fails on %s', async (_name, reply) => {
    script[STATUS] = [reply]
    expect(await settled(account.start('check'))).toMatchObject({ account: { state: 'unchecked' }, result: { outcome: 'failed' } })
  })

  it('links an app through its setup page, offers only the first trusted link, and stops before sign-in', async () => {
    script[STATUS] = [SIGNED_OUT]
    const setup = Promise.withResolvers<ScriptedProcess>()
    script['config init --new'] = (process) => { setup.resolve(process) }

    const id = account.start('link-app')
    const configuring = await setup.promise
    expect(account.snapshot().operation).toEqual({ id, kind: 'link-app', phase: 'configuring', cancellable: true })
    configuring.write('stderr', 'Open this link:\n  http://open.feishu.cn/page/cli?x=1\n  https://evil.example/page\n')
    configuring.write('stderr', '  https://open.feishu.cn/page/cli?x=2\n  https://open.feishu.cn/page/cli?x=3\n')
    await vi.waitFor(() => { expect(account.snapshot().operation).toMatchObject({ phase: 'configuring', authorizationUrl: 'https://open.feishu.cn/page/cli?x=2' }) })
    configuring.reply({})

    expect(await settled(id)).toEqual({ account: { state: 'signed-out', appId: APP }, result: { id, kind: 'link-app', outcome: 'succeeded' } })
    expect(commands()).toEqual(['config init --new', STATUS])
    expect(errors()).toEqual([])
  })

  it('reports safe setup diagnostics to the page and Host without retrying or exposing native output', async () => {
    script[STATUS] = [NOT_CONFIGURED]
    await settled(account.start('check'))
    const sensitive = 'secret-in-native-output'
    script['config init --new'] = [{ exitCode: 5, stdout: sensitive, stderr: `QR\nhttps://open.feishu.cn/?user_code=${sensitive}\nApp created\n${JSON.stringify({
      ok: false, error: { type: 'internal', subtype: 'sdk_error', message: sensitive, hint: sensitive },
    }, null, 2)}\n` }]

    const result = await settled(account.start('link-app'))
    expect(result).toMatchObject({ account: { state: 'unconfigured' }, result: {
      outcome: 'failed', failure: { command: 'config-init', exitCode: 5, type: 'internal', subtype: 'sdk_error' },
    } })
    expect(errors()).toEqual([['feishu: account operation failed: %o', {
      id: result.result?.id, kind: 'link-app', phase: 'configuring',
      command: 'config-init', exitCode: 5, type: 'internal', subtype: 'sdk_error',
    }]])
    expect(JSON.stringify({ result, errors: errors() })).not.toContain(sensitive)
    expect(commands()).toEqual([STATUS, 'config init --new'])
  })

  it('attributes a post-setup check failure to auth status', async () => {
    script['config init --new'] = [{}]
    script[STATUS] = [{ exitCode: 5, stderr: '{"ok":false,"error":{"type":"internal","subtype":"storage"}}' }]

    expect(await settled(account.start('link-app'))).toMatchObject({ result: {
      outcome: 'failed', failure: { command: 'auth-status', exitCode: 5, type: 'internal', subtype: 'storage' },
    } })
  })

  it('retains the observed exit code when the command response is invalid', async () => {
    script[STATUS] = [{ stdout: 'invalid-json-secret' }]
    const result = await settled(account.start('check'))
    expect(result).toMatchObject({ result: { outcome: 'failed', failure: { command: 'auth-status', exitCode: 0 } } })
    expect(JSON.stringify({ result, errors: errors() })).not.toContain('invalid-json-secret')
  })

  it('signs in through the authorization page and accepts a sign-in that leaves permissions ungranted', async () => {
    script[STATUS] = [CONNECTED]
    const signIn = Promise.withResolvers<ScriptedProcess>()
    script['auth login --json'] = (process) => { signIn.resolve(process) }

    const id = account.start('sign-in')
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-in', phase: 'authorizing', cancellable: true })
    const authorizing = await signIn.promise
    const invalid = JSON.stringify({ event: 'device_authorization', verification_uri_complete: 'not a url' })
    authorizing.write('stdout', `progress\n{"event":"other"}\n${invalid}\n${LOGIN_LINK}\n`)
    await vi.waitFor(() => { expect(account.snapshot().operation).toMatchObject({ phase: 'authorizing', authorizationUrl: 'https://accounts.feishu.cn/oauth/device?code=1' }) })
    authorizing.reply({ stdout: login(['im:message']) + '\n', exitCode: 3 })

    expect(await settled(id)).toEqual({
      account: { state: 'connected', appId: APP, userName: '张三' },
      result: { id, kind: 'sign-in', outcome: 'succeeded' },
    })
    expect(commands()).toEqual(['auth login --json', STATUS])
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

  it('signs out without offering cancellation and reports a rejected sign-out', async () => {
    script[STATUS] = [SIGNED_OUT]
    script['auth logout --json'] = [{ stdout: '{"ok":true}' }, { exitCode: 1 }]
    const id = account.start('sign-out')
    expect(account.snapshot().operation).toEqual({ id, kind: 'sign-out', phase: 'signing-out', cancellable: false })
    expect(await settled(id)).toEqual({ account: { state: 'signed-out', appId: APP }, result: { id, kind: 'sign-out', outcome: 'succeeded' } })
    expect((await settled(account.start('sign-out'))).result).toMatchObject({
      kind: 'sign-out', outcome: 'failed', failure: { command: 'auth-logout', exitCode: 1 },
    })
  })
})

describe('Feishu Remote', () => {
  beforeEach(async () => {
    await ctx.plugin(Feishu, { commandTimeoutMs: 5_000, binDir })
  })

  it('checks for a new follower, streams each change, and starts checks, app links, sign-ins, and sign-outs', async () => {
    script[STATUS] = [SIGNED_OUT]
    const states: FeishuState[] = []
    const leave = new AbortController()
    const following = (async () => {
      for await (const state of ctx.feishu.follow(leave.signal)) states.push(state)
    })()
    const finished = async (id?: CliOperationId): Promise<FeishuState['result']> => {
      await vi.waitFor(() => {
        expect(states.at(-1)?.result).toBeDefined()
        if (id !== undefined) expect(states.at(-1)?.result?.id).toBe(id)
      })
      return states.at(-1)?.result
    }
    expect(await finished()).toMatchObject({ kind: 'check', outcome: 'succeeded' })
    expect(states[0]).toMatchObject({ account: { state: 'unchecked' }, operation: { kind: 'check' } })
    expect(states.at(-1)?.account).toEqual({ state: 'signed-out', appId: APP })

    script['auth logout --json'] = [{ stdout: '{"ok":true}' }]
    const signingOut = ctx.feishu.signOut()
    expect(() => ctx.feishu.signIn()).toThrow('another account operation is in progress')
    await ctx.feishu.cancel(signingOut)
    expect(await finished(signingOut)).toMatchObject({ kind: 'sign-out', outcome: 'succeeded' })
    expect(await finished(ctx.feishu.check())).toMatchObject({ kind: 'check', outcome: 'succeeded' })

    script['config init --new'] = () => {}
    const linking = ctx.feishu.linkApp()
    await vi.waitFor(() => { expect(commands().at(-1)).toBe('config init --new') })
    await ctx.feishu.cancel(linking)
    expect(await finished(linking)).toMatchObject({ kind: 'link-app', outcome: 'cancelled' })
    script['auth login --json'] = () => {}
    const signingIn = ctx.feishu.signIn()
    await vi.waitFor(() => { expect(commands().at(-1)).toBe('auth login --json') })
    await ctx.feishu.cancel(signingIn)
    expect(await finished(signingIn)).toMatchObject({ kind: 'sign-in', outcome: 'cancelled' })
    expect(subprocess.processes.at(-1)?.terminated).toBe(true)
    leave.abort()
    await following
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

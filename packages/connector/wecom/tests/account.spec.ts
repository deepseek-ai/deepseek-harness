/** Authorization operations over a scripted wecom-cli: checks, QR-code connection, cancellation, and the Plugins page wiring. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectorOperationId } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executableFileName } from '../src/directory.ts'
import * as Wecom from '../src/index.ts'
import type { WecomOperationKind, WecomState } from '../src/types.ts'
import { createHost, type CliReply, type ScriptedProcess, type ScriptedSubprocess, type WecomPage } from './harness.ts'

const STATUS = 'auth show'
const INIT = 'auth init --noninteractive --no-browser'
const QR_LINK = 'https://work.weixin.qq.com/ai/qc/gen?source=wecom-cli&scode=fixture-scode'
const AUTHORIZED: CliReply = { stdout: 'Status: authorized\nBot ID: bot-1\n' }
const UNAUTHORIZED: CliReply = { stdout: 'Status: unauthorized\n' }

type Script = (process: ScriptedProcess) => void

let ctx: Context
let subprocess: ScriptedSubprocess
let binDir: string
let skillsDir: string
/** The account the plugin registered, as the Plugins page registry drives it. */
let account: WecomPage['source']
let script: Record<string, Script | CliReply[]>

/** Start a Host and load the plugin on it; without `skillsDir` the plugin downloads the guides. */
async function load(config: Pick<Wecom.Config, 'skillsDir'> | 'configured' = 'configured'): Promise<void> {
  const host = await createHost()
  ;({ ctx, subprocess, binDir, skillsDir } = host)
  subprocess.respond = (process) => {
    const handler = script[process.spec.argv.slice(1).join(' ')]
    if (handler === undefined) process.reply({ exitCode: 1, stderr: `unexpected: ${process.spec.argv.join(' ')}` })
    else if (Array.isArray(handler)) process.reply(handler.length > 1 ? handler.shift()! : handler[0]!)
    else handler(process)
  }
  await ctx.plugin(Wecom, { binDir, ...config === 'configured' ? { skillsDir } : config })
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
const start = (kind: WecomOperationKind): ConnectorOperationId => {
  const id = account.start(kind)
  if (typeof id !== 'string') throw new Error('the operation did not start at once')
  return id
}
const commands = () => subprocess.processes.map(process => process.spec.argv.slice(1).join(' '))
const errors = (): unknown[] => ctx.logger.buffer.filter(message => message.type === 'error').map((message): unknown => message.args)
const settled = async (id: ConnectorOperationId): Promise<WecomState> => {
  await vi.waitFor(() => { expect(account.snapshot().result?.id).toBe(id) })
  return account.snapshot()
}

describe('WeCom account operations', () => {
  beforeEach(() => load())

  it.each<[string, CliReply, WecomState['account']]>([
    ['an authorized bot', AUTHORIZED, { state: 'authorized', botId: 'bot-1', skills: 'installed' }],
    ['an authorized bot whose id the CLI omits', { stdout: 'Status: authorized\n' }, { state: 'authorized', skills: 'installed' }],
    ['no authorization', UNAUTHORIZED, { state: 'unauthorized', skills: 'installed' }],
  ])('checks %s', async (_name, reply, expected) => {
    script[STATUS] = [reply]
    const id = start('check')
    expect(account.snapshot().operation).toEqual({ id, kind: 'check', phase: 'checking', cancellable: false })
    expect(await settled(id)).toEqual({ account: expected, result: { id, kind: 'check', outcome: 'succeeded' } })
  })

  it.each<[string, CliReply]>([
    ['a failed status command', { exitCode: 1, stderr: 'config unreadable' }],
    ['an unknown status', { stdout: 'expired\n' }],
  ])('keeps the previous state and reports only the command and exit code on %s', async (_name, reply) => {
    script[STATUS] = [reply]
    const result = await settled(start('check'))
    expect(result).toEqual({
      account: { state: 'unchecked', skills: 'installed' },
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

    const offered: string[] = []
    const stop = account.observe(() => {
      const url = account.snapshot().operation?.authorizationUrl
      if (url !== undefined && offered.at(-1) !== url) offered.push(url)
    })
    const id = start('connect')
    expect(account.snapshot().operation).toEqual({ id, kind: 'connect', phase: 'authorizing', cancellable: true })
    const authorizing = await init.promise
    authorizing.write('stderr', 'https://work.weixin.qq.com/ai/qc/gen?source=stderr\n')
    authorizing.write('stdout', 'Scan the QR code with WeCom:\n  http://work.weixin.qq.com/insecure\nhttps://evil.example/qr\n')
    authorizing.write('stdout', `${QR_LINK}\n`)
    await vi.waitFor(() => { expect(account.snapshot().operation).toMatchObject({ phase: 'authorizing', authorizationUrl: QR_LINK }) })
    authorizing.reply({ stdout: 'Authorized\n' })

    expect(await settled(id)).toEqual({ account: { state: 'authorized', botId: 'bot-1', skills: 'installed' }, result: { id, kind: 'connect', outcome: 'succeeded' } })
    stop()
    expect(offered).toEqual([QR_LINK])
    expect(commands()).toEqual([INIT, STATUS])
    expect(errors()).toEqual([])
  })

  it.each<[string, Record<string, CliReply[]>, NonNullable<WecomState['result']>['failure']]>([
    ['a failed QR-code authorization', { [INIT]: [{ exitCode: 2, stdout: `${QR_LINK}\nscode=secret` }] }, { command: 'auth-init', exitCode: 2 }],
    ['an authorization that left no bot', { [INIT]: [{}], [STATUS]: [UNAUTHORIZED] }, { command: 'auth-status', exitCode: 0 }],
  ])('fails on %s without exposing CLI output', async (_name, replies, failure) => {
    Object.assign(script, replies)
    const result = await settled(start('connect'))
    expect(result.result).toMatchObject({ kind: 'connect', outcome: 'failed', failure })
    expect(JSON.stringify({ result, errors: errors() })).not.toContain('scode')
  })

  it('cancels only while waiting for the scan and withdraws the link', async () => {
    script[INIT] = (process) => { process.write('stdout', `${QR_LINK}\n`) }
    const id = start('connect')
    await vi.waitFor(() => { expect(account.snapshot().operation?.authorizationUrl).toBe(QR_LINK) })
    await account.cancel('other' as ConnectorOperationId)
    expect(account.snapshot().operation?.phase).toBe('authorizing')

    const cancelling = account.cancel(id)
    expect(account.snapshot().operation).toEqual({ id, kind: 'connect', phase: 'cancelling', cancellable: false })
    await cancelling
    expect(account.snapshot()).toEqual({ account: { state: 'unchecked', skills: 'installed' }, result: { id, kind: 'connect', outcome: 'cancelled' } })
    expect(subprocess.processes[0]?.terminated).toBe(true)
    expect(errors()).toEqual([])
  })

  it('ignores cancellation while it confirms the authorization', async () => {
    script[INIT] = [{}]
    const status = Promise.withResolvers<ScriptedProcess>()
    script[STATUS] = (process) => { status.resolve(process) }
    const id = start('connect')
    const checking = await status.promise
    expect(account.snapshot().operation).toEqual({ id, kind: 'connect', phase: 'checking', cancellable: false })
    await account.cancel(id)
    checking.reply(AUTHORIZED)
    expect((await settled(id)).result).toEqual({ id, kind: 'connect', outcome: 'succeeded' })
  })
})

describe('WeCom guides the plugin downloads', () => {
  let home: string
  /** Answers each request for the guides' archive. */
  let archive: () => Promise<Response>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-wecom-home-'))
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', () => archive())
  })

  afterEach(() => rm(home, { recursive: true, force: true }))

  it('restarts a failed download of the guides on each check without waiting for it, and reports the state it leaves', async () => {
    archive = () => Promise.reject(new Error('offline'))
    await load({})
    await vi.waitFor(() => { expect(account.snapshot().account.skills).toBe('failed') })

    archive = () => new Promise(() => {})
    script[STATUS] = [AUTHORIZED]
    const id = start('check')
    expect(account.snapshot().account).toEqual({ state: 'unchecked', skills: 'downloading' })
    expect(await settled(id)).toEqual({ account: { state: 'authorized', botId: 'bot-1', skills: 'downloading' }, result: { id, kind: 'check', outcome: 'succeeded' } })
  })

  it('reports a new state of the guides with the current authorization', async () => {
    const download = Promise.withResolvers<Response>()
    archive = () => download.promise
    await load({})
    script[STATUS] = [AUTHORIZED]
    expect((await settled(start('check'))).account).toEqual({ state: 'authorized', botId: 'bot-1', skills: 'downloading' })

    download.reject(new Error('offline'))

    await vi.waitFor(() => { expect(account.snapshot().account).toEqual({ state: 'authorized', botId: 'bot-1', skills: 'failed' }) })
  })
})

describe('WeCom on the Plugins page', () => {
  beforeEach(() => load())

  const finished = async (id: ConnectorOperationId): Promise<WecomState['result']> => (await settled(id)).result

  it('checks on refresh, then starts checks and connections one at a time and cancels one waiting for the scan', async () => {
    script[STATUS] = [UNAUTHORIZED]
    account.refresh()
    const check = account.snapshot().operation
    expect(account.snapshot()).toMatchObject({ account: { state: 'unchecked', skills: 'installed' }, operation: { kind: 'check' } })
    expect(await finished(check!.id)).toMatchObject({ kind: 'check', outcome: 'succeeded' })
    expect(account.snapshot().account).toEqual({ state: 'unauthorized', skills: 'installed' })
    expect(subprocess.lookups[0]?.command).toBe(join(binDir, executableFileName(process.platform)))
    expect(await finished(start('check'))).toMatchObject({ kind: 'check', outcome: 'succeeded' })

    script[INIT] = () => {}
    const connecting = start('connect')
    expect(() => start('check')).toThrow('another account operation is in progress')
    await vi.waitFor(() => { expect(commands().at(-1)).toBe(INIT) })
    await account.cancel(connecting)
    expect(await finished(connecting)).toMatchObject({ kind: 'connect', outcome: 'cancelled' })
    expect(subprocess.processes.at(-1)?.terminated).toBe(true)
  })

  it('stops authorization work on disposal', async () => {
    script[STATUS] = () => {}
    account.refresh()
    await vi.waitFor(() => { expect(subprocess.processes).toHaveLength(1) })
    await ctx.fiber.dispose()
    expect(subprocess.processes[0]?.terminated).toBe(true)
  })
})

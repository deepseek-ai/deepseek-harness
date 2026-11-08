/** Account Remote exports retain their wire names and exclude Host credentials. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it } from 'vitest'
import { DeepSeekAccount } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-account-remote-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  const provider = ctx.plugin(DeepSeekAccount)
  await provider
  return { ctx, account: ctx.deepseekAccount, provider }
}

it('binds only client-safe operations to the existing account namespace', async () => {
  const { account } = await fixture()
  expect(account.typertRemote.service instanceof DeepSeekAccount).toBe(true)
  expect(account.typertRemote.serviceKey).toBe('deepseekAccount')
  expect(account.typertRemote.namespace).toBe('account')
  expect(remoteMethods(account).map(method => method.exportName ?? method.method).sort()).toEqual([
    'cancelSignIn', 'getBalance', 'getNotificationContent', 'getNotifications', 'getProfile', 'getState',
    'hasRunningAccountTasks', 'reportNotificationEvent', 'signOut', 'startSignIn', 'watch', 'watchExpiry',
  ])
  expect(remoteMethods(account).filter(method => method.mode === 'stream').map(method => method.exportName ?? method.method).sort())
    .toEqual(['watch', 'watchExpiry'])
})

it('streams initial state and credential changes and ends on cancellation', async () => {
  const { ctx, account } = await fixture()
  const lifetime = new AbortController()
  const stream = account.watchState(lifetime.signal)[Symbol.asyncIterator]()
  try {
    expect(await stream.next()).toMatchObject({ done: false, value: { type: 'snapshot', state: { status: 'signed-out' } } })
    const next = stream.next()
    await ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
      kind: 'grant', payload: { version: 1, token: 'fixture-token', issuer: 'https://platform.deepseek.com' },
    }))
    expect(await next).toMatchObject({ done: false, value: { type: 'credentials-changed', state: { status: 'credential-stored' } } })
  } finally { lifetime.abort() }
  expect(await stream.next()).toEqual({ done: true, value: undefined })
})

it('delivers expiry only to current subscribers and stops on disconnect or provider disposal', async () => {
  const { ctx, account, provider } = await fixture()
  ctx.emit('deepseek-account/session-expired')
  const lifetime = new AbortController()
  const stream = account.watchExpiry(lifetime.signal)[Symbol.asyncIterator]()
  const first = stream.next()
  ctx.emit('deepseek-account/session-expired')
  expect(await first).toEqual({ done: false, value: 'session-expired' })
  const next = stream.next()
  lifetime.abort()
  expect(await next).toEqual({ done: true, value: undefined })
  const reopened = account.watchExpiry(new AbortController().signal)[Symbol.asyncIterator]().next()
  await provider.dispose()
  expect(await reopened).toEqual({ done: true, value: undefined })
})

it('reports running account requests and excludes absent, idle, and other-provider tasks', async () => {
  const { ctx, account } = await fixture()
  expect(account.hasRunningAccountTasks()).toBe(false)
  const active: Array<Pick<Agent, 'status' | 'session'>> = []
  const task = (status: Agent['status'], provider?: string): Pick<Agent, 'status' | 'session'> => ({
    status, session: { requestContext: () => provider === undefined ? undefined : { provider, model: 'model' } } as Agent['session'],
  })
  ctx.provide('agents', { list: () => active } as Context['agents'])
  active.push(task('running'), task('running', 'deepseek-official'), task('idle', 'deepseek-account'))
  expect(account.hasRunningAccountTasks()).toBe(false)
  active.push(task('running', 'deepseek-account'))
  expect(account.hasRunningAccountTasks()).toBe(true)
  active.pop()
  expect(account.hasRunningAccountTasks()).toBe(false)
})

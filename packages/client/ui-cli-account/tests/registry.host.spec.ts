/** The registry serves every registered account to the Plugins page and routes page operations to the account that owns them. */
import { Context } from '@deepseek-ai/cordis'
import type {
  CliAccountDisplay, CliAccountRegistration, CliAccountSource, CliAccountsView, CliAccountView, CliOperationId,
} from '@deepseek-ai/dsh-cli-account/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import CliAccounts from '../src/index.ts'

type View = CliAccountView<{ readonly state: 'out' | 'in' }, 'check' | 'connect', 'authorizing'>

const OP = 'op-1' as CliOperationId
const COPY = {
  title: { en: 'Fixture account', zh: '演示账号' },
  hint: 'Shared with the terminal.',
  activation: { title: 'Connect Fixture', body: 'The plugin is on.', connect: 'Connect' },
}

function source(initial: View = { account: { state: 'out' } }) {
  let view = initial
  const listeners = new Set<() => void>()
  const fake = {
    snapshot: () => view,
    observe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    refresh: vi.fn(),
    start: vi.fn((_kind: 'check' | 'connect') => OP),
    cancel: vi.fn(async (_id: CliOperationId) => {}),
  } satisfies CliAccountSource<View>
  return { fake, listeners, publish: (next: View) => { view = next; for (const listener of listeners) listener() } }
}

function display(view: View): CliAccountDisplay {
  return view.account.state === 'in'
    ? { phase: 'connected', status: 'Connected', badge: 'Connected', buttons: [], notes: [] }
    : { phase: 'disconnected', status: 'Not connected', buttons: [{ label: 'Connect', command: { kind: 'start', operation: 'connect' }, variant: 'primary' }], notes: [] }
}

function registration(packageName: string, account = source()): CliAccountRegistration<View> {
  return {
    packageName, source: account.fake, copy: COPY, present: display,
    operations: [{ kind: 'check' }, { kind: 'connect', notice: { en: 'Fixture connected', zh: '演示已连接' } }],
  }
}

async function registry() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(CliAccounts)
  return ctx
}

/** Read the stream until a view satisfies the predicate. */
async function until(stream: AsyncIterator<CliAccountsView>, predicate: (view: CliAccountsView) => boolean): Promise<CliAccountsView> {
  for (;;) {
    const next = await stream.next()
    if (next.done === true) throw new Error('stream ended')
    if (predicate(next.value)) return next.value
  }
}

it('publishes each account with its copy, display, operation, and result, and checks it for each new subscriber', async () => {
  const ctx = await registry()
  const account = source()
  const withdraw = ctx.cliAccounts.register(registration('@acme/fixture', account))
  expect(account.fake.refresh).not.toHaveBeenCalled()
  const controller = new AbortController()
  const stream = ctx.cliAccounts.watch(controller.signal)[Symbol.asyncIterator]()
  const first = await until(stream, () => true)
  expect(account.fake.refresh).toHaveBeenCalledOnce()
  expect(first.accounts).toEqual([{ packageName: '@acme/fixture', copy: COPY, display: display({ account: { state: 'out' } }) }])

  account.publish({ account: { state: 'out' }, operation: { id: OP, kind: 'connect', phase: 'authorizing', cancellable: true, authorizationUrl: 'https://example.com/a' } })
  const waiting = await until(stream, view => view.accounts[0]?.operation !== undefined)
  expect(waiting.accounts[0]?.operation).toEqual({ id: OP, authorizationUrl: 'https://example.com/a' })

  account.publish({ account: { state: 'out' }, operation: { id: OP, kind: 'connect', phase: 'checking', cancellable: false } })
  const checking = await until(stream, (view) => {
    const operation = view.accounts[0]?.operation
    return operation !== undefined && operation.authorizationUrl === undefined
  })
  expect(checking.accounts[0]?.operation).toEqual({ id: OP })

  account.publish({ account: { state: 'in' }, result: { id: OP, kind: 'connect', outcome: 'succeeded' } })
  const connected = await until(stream, view => view.accounts[0]?.result !== undefined)
  expect(connected.accounts[0]).toMatchObject({
    display: { phase: 'connected' }, result: { id: OP, notice: { en: 'Fixture connected', zh: '演示已连接' } },
  })

  // Only a success reports a notice, and only for an operation that registered one.
  account.publish({ account: { state: 'out' }, result: { id: OP, kind: 'connect', outcome: 'failed' } })
  expect((await until(stream, view => view.accounts[0]?.display.phase === 'disconnected')).accounts[0]?.result).toEqual({ id: OP })
  account.publish({ account: { state: 'in' }, result: { id: OP, kind: 'check', outcome: 'succeeded' } })
  expect((await until(stream, view => view.accounts[0]?.display.phase === 'connected')).accounts[0]?.result).toEqual({ id: OP })

  withdraw()
  expect((await until(stream, view => view.accounts.length === 0)).accounts).toEqual([])
  withdraw()
  expect(account.listeners.size).toBe(0)
  controller.abort()
  expect((await stream.next()).done).toBe(true)
})

it('checks an account registered while the page follows, and none registered while nobody follows', async () => {
  const ctx = await registry()
  const idle = source()
  ctx.cliAccounts.register(registration('@acme/idle', idle))
  const controller = new AbortController()
  const stream = ctx.cliAccounts.watch(controller.signal)[Symbol.asyncIterator]()
  await until(stream, view => view.accounts.length === 1)
  const late = source()
  ctx.cliAccounts.register(registration('@acme/late', late))
  expect(late.fake.refresh).toHaveBeenCalledOnce()
  expect((await until(stream, view => view.accounts.length === 2)).accounts.map(entry => entry.packageName)).toEqual(['@acme/idle', '@acme/late'])
  controller.abort()
  await stream.next()
  const after = source()
  ctx.cliAccounts.register(registration('@acme/after', after))
  expect(after.fake.refresh).not.toHaveBeenCalled()
})

it('starts only the operations an account registered and cancels through its source', async () => {
  const ctx = await registry()
  const account = source()
  ctx.cliAccounts.register(registration('@acme/fixture', account))
  expect(ctx.cliAccounts.start('@acme/fixture', 'connect')).toBe(OP)
  expect(account.fake.start).toHaveBeenCalledWith('connect')
  expect(() => ctx.cliAccounts.start('@acme/fixture', 'sign-out')).toThrow('@acme/fixture has no page operation sign-out')
  expect(() => ctx.cliAccounts.start('@acme/other', 'connect')).toThrow('@acme/other is not registered')
  await ctx.cliAccounts.cancel('@acme/fixture', OP)
  expect(account.fake.cancel).toHaveBeenCalledWith(OP)
  expect(() => ctx.cliAccounts.cancel('@acme/other', OP)).toThrow('@acme/other is not registered')
})

it('refuses a second account for a package', async () => {
  const ctx = await registry()
  ctx.cliAccounts.register(registration('@acme/fixture'))
  expect(() => ctx.cliAccounts.register(registration('@acme/fixture'))).toThrow('@acme/fixture is already registered')
})

it('ends every stream when the registry unloads', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(CliAccounts)
  await fiber
  const stream = ctx.cliAccounts.watch(new AbortController().signal)[Symbol.asyncIterator]()
  await until(stream, () => true)
  const pending = stream.next()
  await fiber.dispose()
  expect((await pending).done).toBe(true)
  await ctx.fiber.dispose()
})

/** The registry serves every registered account to the Plugins page and routes page operations to the account that owns them. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import ConnectorAccounts from '../src/index.ts'
import type {
  ConnectorAccountDisplay, ConnectorAccountRegistration, ConnectorAccountSource, ConnectorAccountsView, ConnectorAccountView,
  ConnectorOperationId,
} from '../src/types.ts'

type View = ConnectorAccountView<{ readonly state: 'out' | 'in' }, 'check' | 'connect', 'authorizing'>

const OP = 'op-1' as ConnectorOperationId
const NEXT = 'op-2' as ConnectorOperationId
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
    start: vi.fn((_kind: 'check' | 'connect'): ConnectorOperationId | Promise<ConnectorOperationId> => OP),
    cancel: vi.fn(async (_id: ConnectorOperationId) => {}),
  } satisfies ConnectorAccountSource<View>
  return { fake, listeners, publish: (next: View) => { view = next; for (const listener of listeners) listener() } }
}

function display(view: View): ConnectorAccountDisplay {
  return view.account.state === 'in'
    ? { phase: 'connected', status: 'Connected', badge: 'Connected', buttons: [], notes: [] }
    : { phase: 'disconnected', status: 'Not connected', buttons: [{ label: 'Connect', command: { kind: 'start', operation: 'connect' }, variant: 'primary' }], notes: [] }
}

/** A registration whose bundle package defaults to its key; `null` registers an account no bundle owns. */
function registration(key: string, account = source(), packageName: string | null = key): ConnectorAccountRegistration<View> {
  return {
    key, ...packageName === null ? {} : { packageName }, source: account.fake, copy: COPY, present: display,
    operations: [{ kind: 'check' }, { kind: 'connect', notice: { en: 'Fixture connected', zh: '演示已连接' } }],
  }
}

async function registry() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(ConnectorAccounts)
  return ctx
}

/** Read the stream until a view satisfies the predicate. */
async function until(
  stream: AsyncIterator<ConnectorAccountsView>, predicate: (view: ConnectorAccountsView) => boolean,
): Promise<ConnectorAccountsView> {
  for (;;) {
    const next = await stream.next()
    if (next.done === true) throw new Error('stream ended')
    if (predicate(next.value)) return next.value
  }
}

it('publishes each account with its key, package, copy, display, operation, and result, and checks it for each new subscriber', async () => {
  const ctx = await registry()
  const account = source()
  const withdraw = ctx.connectorAccounts.register(registration('@acme/fixture', account))
  expect(account.fake.refresh).not.toHaveBeenCalled()
  const controller = new AbortController()
  const stream = ctx.connectorAccounts.watch(controller.signal)[Symbol.asyncIterator]()
  const first = await until(stream, () => true)
  expect(account.fake.refresh).toHaveBeenCalledOnce()
  expect(first.accounts).toEqual([
    { key: '@acme/fixture', packageName: '@acme/fixture', copy: COPY, display: display({ account: { state: 'out' } }) },
  ])

  account.publish({ account: { state: 'out' }, operation: { id: OP, kind: 'connect', phase: 'authorizing', cancellable: true, authorizationUrl: 'https://example.com/a' } })
  const waiting = await until(stream, view => view.accounts[0]?.operation !== undefined)
  expect(waiting.accounts[0]?.operation).toEqual({ id: OP, authorizationUrl: 'https://example.com/a' })

  account.publish({ account: { state: 'out' }, operation: { id: OP, kind: 'connect', phase: 'authorizing', cancellable: false } })
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

it('publishes an account that no bundle owns without a package', async () => {
  const ctx = await registry()
  ctx.connectorAccounts.register(registration('mcp:custom', source(), null))
  const stream = ctx.connectorAccounts.watch(new AbortController().signal)[Symbol.asyncIterator]()
  const [entry] = (await until(stream, () => true)).accounts
  expect(entry).toEqual({ key: 'mcp:custom', copy: COPY, display: display({ account: { state: 'out' } }) })
})

it('checks an account registered while the page follows, and none registered while nobody follows', async () => {
  const ctx = await registry()
  const idle = source()
  ctx.connectorAccounts.register(registration('@acme/idle', idle))
  const controller = new AbortController()
  const stream = ctx.connectorAccounts.watch(controller.signal)[Symbol.asyncIterator]()
  await until(stream, view => view.accounts.length === 1)
  const late = source()
  ctx.connectorAccounts.register(registration('@acme/late', late))
  expect(late.fake.refresh).toHaveBeenCalledOnce()
  expect((await until(stream, view => view.accounts.length === 2)).accounts.map(entry => entry.key)).toEqual(['@acme/idle', '@acme/late'])
  controller.abort()
  await stream.next()
  const after = source()
  ctx.connectorAccounts.register(registration('@acme/after', after))
  expect(after.fake.refresh).not.toHaveBeenCalled()
})

it('starts only the operations an account registered and cancels through its source', async () => {
  const ctx = await registry()
  const account = source()
  ctx.connectorAccounts.register(registration('@acme/fixture', account))
  await expect(ctx.connectorAccounts.start('@acme/fixture', 'connect')).resolves.toBe(OP)
  expect(account.fake.start).toHaveBeenCalledWith('connect')
  // A source that starts its operation asynchronously answers once it has the identity.
  account.fake.start.mockImplementationOnce(async () => NEXT)
  await expect(ctx.connectorAccounts.start('@acme/fixture', 'connect')).resolves.toBe(NEXT)
  await expect(ctx.connectorAccounts.start('@acme/fixture', 'sign-out')).rejects.toThrow('@acme/fixture has no page operation sign-out')
  await expect(ctx.connectorAccounts.start('@acme/other', 'connect')).rejects.toThrow('@acme/other is not registered')
  await ctx.connectorAccounts.cancel('@acme/fixture', OP)
  expect(account.fake.cancel).toHaveBeenCalledWith(OP)
  expect(() => ctx.connectorAccounts.cancel('@acme/other', OP)).toThrow('@acme/other is not registered')
})

it('refuses a second account for a key or for a package', async () => {
  const ctx = await registry()
  ctx.connectorAccounts.register(registration('@acme/fixture'))
  expect(() => ctx.connectorAccounts.register(registration('@acme/fixture'))).toThrow('@acme/fixture is already registered')
  expect(() => ctx.connectorAccounts.register(registration('mcp:fixture', source(), '@acme/fixture')))
    .toThrow('@acme/fixture already has an account')
  expect(() => ctx.connectorAccounts.register(registration('mcp:custom', source(), null))).not.toThrow()
})

it('ends every stream when the registry unloads', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(ConnectorAccounts)
  await fiber
  const stream = ctx.connectorAccounts.watch(new AbortController().signal)[Symbol.asyncIterator]()
  await until(stream, () => true)
  const pending = stream.next()
  await fiber.dispose()
  expect((await pending).done).toBe(true)
  await ctx.fiber.dispose()
})

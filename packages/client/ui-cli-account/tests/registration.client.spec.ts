/** The registry shows an account's four surfaces under the plugin's dictionary and withdraws them with its disposer or this plugin. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { CliAccountView } from '@deepseek-ai/dsh-cli-account/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CliAccountActivationEntry, CliAccountBadgeEntry, CliAccountSectionEntry, CliAccountToastEntry } from '../src/client/components.tsx'
import { apply, inject } from '../src/client/index.ts'
import type { CliAccountKey, CliAccountRegistration } from '../src/client/types.ts'
import { apply as nodeApply } from '../src/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'fixture-account': CliAccountKey | 'notice.connected'
  }
}

type View = CliAccountView<{ readonly state: 'out' | 'in' }, 'check' | 'connect', 'authorizing'>

const SLOTS = [
  ['plugins.bundle.config', CliAccountSectionEntry],
  ['plugins.bundle.activation', CliAccountActivationEntry],
  ['plugins.detail.badge', CliAccountBadgeEntry],
  ['shell.overlay', CliAccountToastEntry],
] as const

function account(packageName: string): CliAccountRegistration<View> {
  return {
    packageName, locale: 'fixture-account',
    follow: () => ({ async *[Symbol.asyncIterator]() { /* the plugin reports nothing in this composition */ } }),
    cancel: async (): Promise<RemoteResult<void>> => ({ ok: true, value: undefined }),
    notices: { connect: () => 'Connected' },
    present: () => ({ phase: 'checking' }),
  }
}

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const closed = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    $stream() {
      return { async *[Symbol.asyncIterator]() { /* the plugin reports nothing in this composition */ }, dispose: closed }
    }
  }
  new Remote()
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'plugins.bundle.activation': { kind: 'keyed', scope: 'root' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
    'plugins.detail.badge': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  const count = () => SLOTS.reduce((total, [slot]) => total + ctx.slots.entries(slot).length, 0)
  return { ctx, fiber, closed, count }
}

it('registers the four surfaces with one shared face and removes them with the disposer', async () => {
  const b = await bench()
  const registration = account('@acme/fixture')
  const dispose = b.ctx.cliAccounts.register(registration)
  const faces = SLOTS.map(([slot, component]) => {
    const [entry] = b.ctx.slots.entries(slot)
    expect(entry).toMatchObject({ locale: 'fixture-account', component })
    return entry!.inject!()
  })
  expect(new Set(faces.map(face => face.hooks)).size).toBe(1)
  expect(faces[0]).toMatchObject({ packageName: '@acme/fixture', present: registration.present, notices: registration.notices })
  expect(b.ctx.slots.entries('plugins.bundle.config')[0]!.options.key).toBe('@acme/fixture')
  expect(b.ctx.slots.entries('plugins.bundle.activation')[0]!.options.key).toBe('@acme/fixture')
  expect(b.ctx.slots.entries('plugins.detail.badge')[0]!.options.id).toBe('@acme/fixture.account')
  expect(b.ctx.slots.entries('shell.overlay')[0]!.options.id).toBe('@acme/fixture.account-toast')
  dispose()
  await vi.waitFor(() => { expect(b.closed).toHaveBeenCalledOnce() })
  expect(b.count()).toBe(0)
  dispose()
  expect(b.closed).toHaveBeenCalledOnce()
})

it('withdraws every account when this plugin unloads', async () => {
  const b = await bench()
  b.ctx.cliAccounts.register(account('@acme/fixture'))
  b.ctx.cliAccounts.register(account('@acme/other'))
  expect(b.count()).toBe(8)
  await b.fiber.dispose()
  expect(b.count()).toBe(0)
  expect(b.closed).toHaveBeenCalledTimes(2)
})

it('rolls back a registration whose package another account already shows', async () => {
  const b = await bench()
  b.ctx.cliAccounts.register(account('@acme/fixture'))
  expect(() => b.ctx.cliAccounts.register(account('@acme/fixture'))).toThrow()
  await vi.waitFor(() => { expect(b.closed).toHaveBeenCalledOnce() })
  expect(b.count()).toBe(4)
})

it('keeps the Node half inert', () => {
  expect(() => { nodeApply() }).not.toThrow()
})

/** The registry shows an account's four surfaces under the connector's dictionary and withdraws them with its disposer or this plugin. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { McpAccountActivation, McpAccountBadge, McpAccountSection, McpAccountToast } from '../src/client/McpAccount.tsx'
import type { McpAccountKey } from '../src/client/types.ts'
import { apply as nodeApply } from '../src/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'docs-account': McpAccountKey
  }
}

const SLOTS = [
  ['plugins.bundle.config', McpAccountSection],
  ['plugins.bundle.activation', McpAccountActivation],
  ['plugins.detail.badge', McpAccountBadge],
  ['shell.overlay', McpAccountToast],
] as const

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const closed = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    $stream() {
      return { async *[Symbol.asyncIterator]() { /* the manager reports nothing in this composition */ }, dispose: closed }
    }
  }
  new Remote()
  ctx.provide('remote.mcpServers', { watch: vi.fn() })
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
  const dispose = b.ctx.mcpAccounts.register({ server: 'docs', packageName: '@acme/docs', locale: 'docs-account' })
  const faces = SLOTS.map(([slot, component]) => {
    const [entry] = b.ctx.slots.entries(slot)
    expect(entry).toMatchObject({ locale: 'docs-account', component })
    return entry!.inject!()
  })
  expect(new Set(faces.map(face => face.hooks)).size).toBe(1)
  expect(faces[0]).toMatchObject({ packageName: '@acme/docs' })
  expect(b.ctx.slots.entries('plugins.bundle.config')[0]!.options.key).toBe('@acme/docs')
  expect(b.ctx.slots.entries('plugins.bundle.activation')[0]!.options.key).toBe('@acme/docs')
  expect(b.ctx.slots.entries('plugins.detail.badge')[0]!.options.id).toBe('docs.connection')
  expect(b.ctx.slots.entries('shell.overlay')[0]!.options.id).toBe('docs.connection-toast')
  dispose()
  await vi.waitFor(() => { expect(b.closed).toHaveBeenCalledOnce() })
  expect(b.count()).toBe(0)
  dispose()
  expect(b.closed).toHaveBeenCalledOnce()
})

it('withdraws every account when this plugin unloads', async () => {
  const b = await bench()
  b.ctx.mcpAccounts.register({ server: 'docs', packageName: '@acme/docs', locale: 'docs-account' })
  b.ctx.mcpAccounts.register({ server: 'sheets', packageName: '@acme/sheets', locale: 'docs-account' })
  expect(b.count()).toBe(8)
  await b.fiber.dispose()
  expect(b.count()).toBe(0)
  expect(b.closed).toHaveBeenCalledTimes(2)
})

it('rolls back a registration that conflicts with another account', async () => {
  const b = await bench()
  b.ctx.mcpAccounts.register({ server: 'docs', packageName: '@acme/docs', locale: 'docs-account' })
  expect(() => b.ctx.mcpAccounts.register({ server: 'docs', packageName: '@acme/other', locale: 'docs-account' }))
    .toThrow(/docs\.connection/)
  await vi.waitFor(() => { expect(b.closed).toHaveBeenCalledOnce() })
  expect(b.count()).toBe(4)
  expect(b.ctx.slots.entries('plugins.bundle.config').map(entry => entry.options.key)).toEqual(['@acme/docs'])
})

it('keeps the Node half inert', () => {
  expect(() => { nodeApply() }).not.toThrow()
})

/**
 * The browser plugin mounts the `mcpAccounts` Remote and shows each account the Host registers, withdrawing its surfaces
 * with the account or the plugin.
 */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { NS } from '../src/client/locales.ts'
import { McpAccountActivation, McpAccountBadge, McpAccountSection, McpAccountToast } from '../src/client/McpAccount.tsx'
import { inject, mountMcpAccounts } from '../src/client/mount.ts'
import type { McpAccountFace } from '../src/client/types.ts'
import type { McpAccountEntry, McpAccountsView } from '../src/types.ts'

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-client-ui-mcp-account', descriptors: [] }
const DOCS = '@acme/docs'
const WIKI = '@acme/wiki'

const SLOTS = [
  ['plugins.bundle.config', McpAccountSection],
  ['plugins.bundle.activation', McpAccountActivation],
  ['plugins.detail.badge', McpAccountBadge],
  ['shell.overlay', McpAccountToast],
] as const

function isFace(value: Record<string, unknown>): asserts value is Record<string, unknown> & McpAccountFace {
  assert(typeof value.packageName === 'string' && typeof value.resolveText === 'function' && typeof value.connect === 'function')
  assert(typeof value.hooks === 'object' && value.hooks !== null)
}

/** Read the face a slot entry injects. */
function faceOf(item: { readonly inject?: (() => Record<string, unknown>) | undefined }): McpAccountFace {
  const face = item.inject!()
  isFace(face)
  return face
}

function entry(packageName: string): McpAccountEntry {
  const server = packageName === DOCS ? 'docs' : 'wiki'
  return {
    server, packageName, copy: {
      title: server, connect: `Connect ${server}`, activation: { title: server, body: server },
      detail: { disconnected: '-', waitingBrowser: '-', authorizing: '-', connecting: '-', connected: '-', rejected: '-', scope: '-' },
      signOut: { title: server, body: server }, notice: { connected: server, signedOut: server },
    },
  }
}

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const queue: McpAccountsView[] = []
  let wake: (() => void) | undefined, closed = false, accepted = 0
  const closeStream = vi.fn(async () => { closed = true; wake?.() })
  const unmount = vi.fn(async () => {})
  const startAuthorization = vi.fn(async (_server: string): Promise<RemoteResult<McpOAuthAttemptView>> =>
    ({ ok: true, value: { id: 'attempt-1' as McpOAuthAttemptId, phase: 'starting' } }))
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(received: TypertRemoteContribution) {
      expect(received).toBe(contribution)
      return unmount
    }
    $stream() {
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const next = queue.shift()
            if (next !== undefined) { yield { value: next, accept: () => { accepted++ } }; continue }
            if (closed) return
            await new Promise<void>((resolve) => { wake = resolve })
          }
        },
        dispose: closeStream,
      }
    }
  }
  new Remote()
  ctx.provide('remote.mcpAccounts', { watch: vi.fn() })
  ctx.provide('remote.mcpManager', { startAuthorization, cancelAuthorization: vi.fn(), signOut: vi.fn(), restart: vi.fn() })
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'plugins.bundle.activation': { kind: 'keyed', scope: 'root' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
    'plugins.detail.badge': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const owners = () => SLOTS.flatMap(([slot]) => ctx.slots.entries(slot).map(item => faceOf(item).packageName))
  return {
    ctx, locale, startAuthorization, closeStream, unmount, owners,
    mount: () => ctx.plugin({ inject: [...inject], apply: scope => mountMcpAccounts(scope, contribution) }),
    async publish(...entries: McpAccountEntry[]) {
      const target = accepted + 1
      queue.push({ accounts: entries })
      wake?.()
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
  }
}

it('shows each registered account with one face under the shared dictionary and withdraws the surfaces of an account the Host drops', async () => {
  const b = await bench()
  await b.mount()
  expect(b.locale.bind(NS)('action.retry')).toBe('Retry')
  expect(b.owners()).toEqual([])
  await b.publish(entry(DOCS), entry(WIKI))
  const faces = SLOTS.map(([slot, component]) => {
    const found = b.ctx.slots.entries(slot).find(item => faceOf(item).packageName === DOCS)
    expect(found).toMatchObject({ locale: NS, component })
    return faceOf(found!)
  })
  expect(new Set(faces.map(face => face.hooks.mcpAccount)).size).toBe(1)
  expect(faces[0]!.hooks.mcpAccount.getSnapshot().entry).toEqual(entry(DOCS))
  expect(faces[0]!.resolveText({ en: 'Connected', zh: '已连接' })).toBe('Connected')
  expect(b.ctx.slots.entries('plugins.bundle.config').map(item => item.options.key)).toEqual([DOCS, WIKI])
  expect(b.ctx.slots.entries('plugins.bundle.activation').map(item => item.options.key)).toEqual([DOCS, WIKI])
  expect(b.ctx.slots.entries('plugins.detail.badge').map(item => item.options.id)).toEqual(['docs.connection', 'wiki.connection'])
  expect(b.ctx.slots.entries('shell.overlay').map(item => item.options.id)).toEqual(['docs.connection-toast', 'wiki.connection-toast'])
  faces[0]!.connect()
  await vi.waitFor(() => { expect(b.startAuthorization).toHaveBeenCalledWith('docs') })

  await b.publish(entry(WIKI))
  expect(b.owners()).toEqual([WIKI, WIKI, WIKI, WIKI])
  await b.publish(entry(WIKI), entry(DOCS))
  expect(b.owners().filter(owner => owner === DOCS)).toHaveLength(4)
})

it('withdraws every surface, the dictionaries, and the stream before the Remote when the plugin unloads', async () => {
  const b = await bench()
  const fiber = b.mount()
  await fiber
  await b.publish(entry(DOCS), entry(WIKI))
  expect(b.owners()).toHaveLength(8)
  await fiber.dispose()
  expect(b.owners()).toEqual([])
  expect(b.locale.bind(NS)('action.retry')).toBe('action.retry')
  expect(b.closeStream).toHaveBeenCalledOnce()
  expect(b.unmount).toHaveBeenCalledOnce()
  expect(b.closeStream.mock.invocationCallOrder[0]).toBeLessThan(b.unmount.mock.invocationCallOrder[0]!)
})

it('withdraws the Remote when the surfaces fail to mount', async () => {
  const b = await bench()
  vi.spyOn(b.locale, 'register').mockImplementation(() => { throw new Error('registration failed') })
  await expect(mountMcpAccounts(b.ctx, contribution)).rejects.toThrow('registration failed')
  expect(b.unmount).toHaveBeenCalledOnce()
})

/**
 * The browser plugin shows one tag and one notice entry for the page, and a section and activation prompt for each bundle
 * that owns an account, withdrawing them with the account or the plugin.
 */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  ConnectorAccountActivationEntry, ConnectorAccountBadgeEntry, ConnectorAccountSectionEntry, ConnectorAccountToastEntry,
} from '../src/client/components.tsx'
import { NS } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'
import type { ConnectorAccountFace, ConnectorBundleAccountFace } from '../src/client/types.ts'
import type { ConnectorAccountEntry, ConnectorAccountsView, ConnectorOperationId } from '../src/types.ts'

const FIXTURE = '@acme/fixture'
const OTHER = '@acme/other'
const OP = 'op-1' as ConnectorOperationId

function isFace(value: Record<string, unknown>): asserts value is Record<string, unknown> & ConnectorAccountFace {
  assert(typeof value.resolveText === 'function' && typeof value.follow === 'function')
  assert(typeof value.start === 'function' && typeof value.cancel === 'function')
  assert(typeof value.hooks === 'object' && value.hooks !== null)
}

/** Read the face a slot entry injects. */
function faceOf(item: { readonly inject?: (() => Record<string, unknown>) | undefined }): ConnectorAccountFace {
  assert(item.inject !== undefined)
  const face = item.inject()
  isFace(face)
  return face
}

function bundleFaceOf(item: { readonly inject?: (() => Record<string, unknown>) | undefined }): ConnectorBundleAccountFace {
  const face = faceOf(item)
  assert('account' in face && typeof face.account === 'string')
  return face as ConnectorBundleAccountFace
}

function entry(key: string, packageName: string | null = key): ConnectorAccountEntry {
  return {
    key, ...packageName === null ? {} : { packageName },
    copy: { title: 'Fixture account', hint: 'Shared.', activation: { title: 'Connect', body: 'On.', connect: 'Connect' } },
    display: { phase: 'disconnected', status: 'Not connected', buttons: [], notes: [] },
  }
}

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const queue: ConnectorAccountsView[] = []
  let wake: (() => void) | undefined, closed = false, accepted = 0
  const closeStream = vi.fn(async () => { closed = true; wake?.() })
  const start = vi.fn(async (_key: string, _operation: string): Promise<RemoteResult<ConnectorOperationId>> => ({ ok: true, value: OP }))
  const cancel = vi.fn(async (_key: string, _id: ConnectorOperationId): Promise<RemoteResult<void>> => ({ ok: true, value: undefined }))
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
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
  ctx.provide('remote.connectorAccounts', { watch: vi.fn(), start, cancel })
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'plugins.bundle.activation': { kind: 'keyed', scope: 'root' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
    'plugins.detail.badge': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const bundles = (slot: 'plugins.bundle.config' | 'plugins.bundle.activation') =>
    ctx.slots.entries(slot).map(item => [item.options.key, bundleFaceOf(item).account])
  return {
    ctx, locale, start, cancel, closeStream, bundles,
    mount: () => ctx.plugin({ inject: [...inject], apply }),
    async publish(...entries: ConnectorAccountEntry[]) {
      const target = accepted + 1
      queue.push({ accounts: entries })
      wake?.()
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
  }
}

it('shows one tag and one notice entry for the page and each bundle\'s section and prompt under the shared dictionary', async () => {
  const b = await bench()
  await b.mount()
  expect(b.locale.bind(NS)('action.cancel')).toBe('Cancel')
  expect(b.ctx.slots.entries('plugins.detail.badge').map(item => [item.options.id, item.component])).toEqual([
    ['connector-account.badge', ConnectorAccountBadgeEntry],
  ])
  expect(b.ctx.slots.entries('shell.overlay').map(item => [item.options.id, item.component])).toEqual([
    ['connector-account.notice', ConnectorAccountToastEntry],
  ])
  expect(b.bundles('plugins.bundle.config')).toEqual([])

  // An account no bundle owns gets no bundle surfaces.
  await b.publish(entry(FIXTURE), entry(OTHER), entry('mcp:custom', null))
  expect(b.bundles('plugins.bundle.config')).toEqual([[FIXTURE, FIXTURE], [OTHER, OTHER]])
  expect(b.bundles('plugins.bundle.activation')).toEqual([[FIXTURE, FIXTURE], [OTHER, OTHER]])
  const [section] = b.ctx.slots.entries('plugins.bundle.config')
  assert(section !== undefined)
  expect(section).toMatchObject({ locale: NS, component: ConnectorAccountSectionEntry })
  expect(b.ctx.slots.entries('plugins.bundle.activation')[0]).toMatchObject({ locale: NS, component: ConnectorAccountActivationEntry })
  const face = bundleFaceOf(section)
  const [badge] = b.ctx.slots.entries('plugins.detail.badge')
  assert(badge !== undefined)
  const [toast] = b.ctx.slots.entries('shell.overlay')
  assert(toast !== undefined)
  expect(faceOf(badge).hooks.connectorAccounts).toBe(face.hooks.connectorAccounts)
  expect(faceOf(toast).hooks.connectorAccounts).toBe(face.hooks.connectorAccounts)
  expect([...face.hooks.connectorAccounts.getSnapshot().accounts.keys()]).toEqual([FIXTURE, OTHER, 'mcp:custom'])
  expect(face.resolveText({ en: 'Connected', zh: '已连接' })).toBe('Connected')
  expect(await face.start(FIXTURE, 'connect')).toEqual({ ok: true, value: OP })
  expect(b.start).toHaveBeenCalledWith(FIXTURE, 'connect')
  expect(await face.cancel(FIXTURE, OP)).toEqual({ ok: true, value: undefined })
  expect(b.cancel).toHaveBeenCalledWith(FIXTURE, OP)
  // A refusal reaches the buttons as the Remote's result.
  const refused: RemoteResult<ConnectorOperationId> = { ok: false, error: new RemoteError('gateway/internal', 'offline', {}) }
  b.start.mockResolvedValueOnce(refused)
  expect(await face.start(FIXTURE, 'connect')).toBe(refused)
  face.follow(FIXTURE, OP)
  face.failed()
  expect(face.hooks.connectorAccounts.getSnapshot().notice).toEqual({ seq: 1, kind: 'action-failed' })
  face.dismissNotice()
  expect(face.hooks.connectorAccounts.getSnapshot().notice).toBeUndefined()

  // A dropped account withdraws its bundle's surfaces, and a bundle whose account changed key shows the new one.
  await b.publish(entry(OTHER))
  expect(b.bundles('plugins.bundle.config')).toEqual([[OTHER, OTHER]])
  await b.publish(entry('mcp:other', OTHER))
  expect(b.bundles('plugins.bundle.config')).toEqual([[OTHER, 'mcp:other']])
  expect(b.bundles('plugins.bundle.activation')).toEqual([[OTHER, 'mcp:other']])
})

it('withdraws every surface, the dictionaries, and the stream when the plugin unloads', async () => {
  const b = await bench()
  const fiber = b.mount()
  await fiber
  await b.publish(entry(FIXTURE), entry(OTHER))
  expect(b.bundles('plugins.bundle.config')).toHaveLength(2)
  await fiber.dispose()
  for (const slot of ['plugins.bundle.config', 'plugins.bundle.activation', 'plugins.detail.badge', 'shell.overlay'] as const) {
    expect(b.ctx.slots.entries(slot)).toEqual([])
  }
  expect(b.locale.bind(NS)('action.cancel')).toBe('action.cancel')
  expect(b.closeStream).toHaveBeenCalledOnce()
})

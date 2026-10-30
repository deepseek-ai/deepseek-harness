/**
 * The browser plugin mounts the `cliAccounts` Remote and shows each account the Host registers, withdrawing its surfaces
 * with the account or the plugin.
 */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CliAccountEntry, CliAccountsView, CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CliAccountActivationEntry, CliAccountBadgeEntry, CliAccountSectionEntry, CliAccountToastEntry } from '../src/client/components.tsx'
import { NS } from '../src/client/locales.ts'
import { inject, mountCliAccounts } from '../src/client/mount.ts'
import type { CliAccountFace } from '../src/client/types.ts'

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-client-ui-cli-account', descriptors: [] }
const FIXTURE = '@acme/fixture'
const OTHER = '@acme/other'

const SLOTS = [
  ['plugins.bundle.config', CliAccountSectionEntry],
  ['plugins.bundle.activation', CliAccountActivationEntry],
  ['plugins.detail.badge', CliAccountBadgeEntry],
  ['shell.overlay', CliAccountToastEntry],
] as const

function isFace(value: Record<string, unknown>): asserts value is Record<string, unknown> & CliAccountFace {
  assert(typeof value.packageName === 'string' && typeof value.resolveText === 'function' && typeof value.run === 'function')
  assert(typeof value.hooks === 'object' && value.hooks !== null)
}

/** Read the face a slot entry injects. */
function faceOf(item: { readonly inject?: (() => Record<string, unknown>) | undefined }): CliAccountFace {
  const face = item.inject!()
  isFace(face)
  return face
}

function entry(packageName: string): CliAccountEntry {
  return {
    packageName,
    copy: { title: 'Fixture account', hint: 'Shared.', activation: { title: 'Connect', body: 'On.', connect: 'Connect' } },
    display: { phase: 'disconnected', status: 'Not connected', buttons: [], notes: [] },
  }
}

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const queue: CliAccountsView[] = []
  let wake: (() => void) | undefined, closed = false, accepted = 0
  const closeStream = vi.fn(async () => { closed = true; wake?.() })
  const unmount = vi.fn(async () => {})
  const start = vi.fn(async (_packageName: string, _operation: string): Promise<RemoteResult<CliOperationId>> =>
    ({ ok: true, value: 'op-1' as CliOperationId }))
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
  ctx.provide('remote.cliAccounts', { watch: vi.fn(), start, cancel: vi.fn() })
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
    ctx, locale, start, closeStream, unmount, owners,
    mount: () => ctx.plugin({ inject: [...inject], apply: scope => mountCliAccounts(scope, contribution) }),
    async publish(...entries: CliAccountEntry[]) {
      const target = accepted + 1
      queue.push({ accounts: entries })
      wake?.()
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
  }
}

it('shows each registered account with one face under the kit dictionary and withdraws the surfaces of an account the Host drops', async () => {
  const b = await bench()
  await b.mount()
  expect(b.locale.bind(NS)('action.retry')).toBe('Retry')
  expect(b.owners()).toEqual([])
  await b.publish(entry(FIXTURE), entry(OTHER))
  const faces = SLOTS.map(([slot, component]) => {
    const found = b.ctx.slots.entries(slot).find(item => faceOf(item).packageName === FIXTURE)
    expect(found).toMatchObject({ locale: NS, component })
    return faceOf(found!)
  })
  expect(new Set(faces.map(face => face.hooks.cliAccount)).size).toBe(1)
  expect(faces[0]!.hooks.cliAccount.getSnapshot().entry).toEqual(entry(FIXTURE))
  expect(faces[0]!.resolveText({ en: 'Connected', zh: '已连接' })).toBe('Connected')
  expect(b.ctx.slots.entries('plugins.bundle.config').map(item => item.options.key)).toEqual([FIXTURE, OTHER])
  expect(b.ctx.slots.entries('plugins.bundle.activation').map(item => item.options.key)).toEqual([FIXTURE, OTHER])
  expect(b.ctx.slots.entries('plugins.detail.badge').map(item => item.options.id)).toEqual([`${FIXTURE}.account`, `${OTHER}.account`])
  expect(b.ctx.slots.entries('shell.overlay').map(item => item.options.id)).toEqual([`${FIXTURE}.account-toast`, `${OTHER}.account-toast`])
  faces[0]!.run({ kind: 'start', operation: 'connect' })
  await vi.waitFor(() => { expect(b.start).toHaveBeenCalledWith(FIXTURE, 'connect') })

  await b.publish(entry(OTHER))
  expect(b.owners()).toEqual([OTHER, OTHER, OTHER, OTHER])
  await b.publish(entry(OTHER), entry(FIXTURE))
  expect(b.owners().filter(owner => owner === FIXTURE)).toHaveLength(4)
})

it('withdraws every surface, the dictionaries, and the stream before the Remote when the plugin unloads', async () => {
  const b = await bench()
  const fiber = b.mount()
  await fiber
  await b.publish(entry(FIXTURE), entry(OTHER))
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
  await expect(mountCliAccounts(b.ctx, contribution)).rejects.toThrow('registration failed')
  expect(b.unmount).toHaveBeenCalledOnce()
})

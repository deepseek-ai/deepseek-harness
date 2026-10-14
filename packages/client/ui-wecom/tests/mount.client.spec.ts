/** The browser half mounts the WeCom Remote, registers its surfaces, and withdraws both on disposal or failure. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { apply as hostApply } from '../src/index.ts'
import { WecomConnectionActivation, WecomConnectionBadge, WecomConnectionSection, WecomConnectionToast } from '../src/client/WecomConnection.tsx'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-wecom-cli', descriptors: [] }
const SLOTS = [
  ['plugins.bundle.config', WecomConnectionSection],
  ['plugins.bundle.activation', WecomConnectionActivation],
  ['plugins.detail.badge', WecomConnectionBadge],
  ['shell.overlay', WecomConnectionToast],
] as const

async function fixture() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      ctx.provide('remote.wecom', { follow: vi.fn() })
      return unmount
    }
    $stream() {
      return { async *[Symbol.asyncIterator]() { /* the Host reports nothing in this composition */ }, dispose }
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
  vi.doMock('@deepseek-ai/dsh-wecom-cli/remote', () => ({ default: REMOTE }))
  const browser = await import('../src/client/index.ts')
  return { ctx, unmount, dispose, browser }
}

it('registers the connection surfaces with one shared face, then withdraws them and the Remote', async () => {
  hostApply()
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...b.browser.inject], apply: b.browser.apply })
    await fiber
    const faces = SLOTS.map(([slot, component]) => {
      const [entry] = b.ctx.slots.entries(slot)
      expect(entry).toMatchObject({ locale: 'wecom', component })
      return entry!.inject!()
    })
    expect(new Set(faces.map(face => face.hooks)).size).toBe(1)
    expect(b.ctx.slots.entries('plugins.bundle.config')[0]!.options.key).toBe('@deepseek-ai/dsh-wecom')
    await fiber.dispose()
    for (const [slot] of SLOTS) expect(b.ctx.slots.entries(slot)).toHaveLength(0)
    expect(b.dispose).toHaveBeenCalledOnce()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
    vi.doUnmock('@deepseek-ai/dsh-wecom-cli/remote')
  }
})

it('withdraws the Remote when the surfaces fail to register', async () => {
  const b = await fixture()
  vi.spyOn(b.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  try {
    await expect(b.browser.apply(b.ctx)).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
    vi.doUnmock('@deepseek-ai/dsh-wecom-cli/remote')
  }
})

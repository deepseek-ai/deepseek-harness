/** The browser half registers its four surfaces while the Notion row is on and withdraws them with it. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { NotionConnectionActivation, NotionConnectionBadge, NotionConnectionSection, NotionConnectionToast } from '../src/client/NotionConnection.tsx'

it('registers the connection surfaces with one shared face and removes them on disposal', async () => {
  const ctx = new Context()
  const dispose = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    $stream() {
      return { async *[Symbol.asyncIterator]() { /* the manager reports nothing in this composition */ }, dispose }
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
  try {
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber
    const slots = [
      ['plugins.bundle.config', NotionConnectionSection],
      ['plugins.bundle.activation', NotionConnectionActivation],
      ['plugins.detail.badge', NotionConnectionBadge],
      ['shell.overlay', NotionConnectionToast],
    ] as const
    const faces = slots.map(([slot, component]) => {
      const [entry] = ctx.slots.entries(slot)
      expect(entry).toMatchObject({ locale: 'notion', component })
      return entry!.inject!()
    })
    expect(new Set(faces.map(face => face.hooks)).size).toBe(1)
    expect(ctx.slots.entries('plugins.bundle.config')[0]!.options.key).toBe('@deepseek-ai/dsh-notion')
    await fiber.dispose()
    for (const [slot] of slots) expect(ctx.slots.entries(slot)).toHaveLength(0)
    expect(dispose).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})

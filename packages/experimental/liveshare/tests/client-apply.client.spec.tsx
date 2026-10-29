import { Context, FiberState, type Fiber } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveshareShareAction } from '../src/client/ShareAction.tsx'
import { apply, inject } from '../src/client/index.ts'
import { openManagedSession } from '../src/client/share-navigation.ts'
import { SharedSessionOrigin } from '../src/client/user-origin.tsx'

/** The generated contribution is a build artifact; the mount boundary is what this face test covers. */
vi.mock('@deepseek-ai/dsh-experimental-liveshare/remote', () => ({ default: { package: '@deepseek-ai/dsh-experimental-liveshare', methods: {} } }))

afterEach(() => { vi.unstubAllGlobals() })

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'conversation.chat.user.before': { kind: 'chain', scope: 'session' },
    },
  } as never, () => null)
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declaration = declare(slots)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const mounted: unknown[] = []
  // The namespace the generated contribution mounts; the header action reads it through `inject`.
  const shares = { marker: 'liveshareShares' }
  ctx.provide('remote', {
    $mount: async (contribution: unknown) => {
      mounted.push(contribution)
      ctx.provide('remote.liveshareShares', shares as never)
      return async () => {}
    },
    liveshareShares: shares,
  } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { slots, declaration, fiber, mounted, shares }
}

describe('Liveshare browser plugin', () => {
  it('registers the shared-session origin seat and one Session Header action', async () => {
    const browser = await bench()
    expect(inject).toEqual(['slots', 'locale', 'remote'])
    expect(browser.mounted).toHaveLength(1)
    const entry = browser.slots.entries('conversation.session.header.utilities')[0]
    expect(entry?.component).toBe(LiveshareShareAction)
    expect(entry?.options).toMatchObject({ id: 'liveshare-share' })
    // The action's injected props carry the owner Remote namespace it addresses every call through.
    expect((entry?.inject as (() => unknown) | undefined)?.()).toEqual({ shares: browser.shares })

    // The attribution is a chain entry in Chat's before-row seat, not a replacement of its user cell.
    const origin = browser.slots.entries('conversation.chat.user.before')[0]
    expect(origin?.component).toBe(SharedSessionOrigin)
    expect(origin?.locale).toBe('liveshare')
    expect(origin?.select).toEqual(expect.any(Function))
    expect(browser.slots.entriesOfSlot('conversation.chat.user.before').map(occupant => occupant.component))
      .toEqual([SharedSessionOrigin])
    expect(browser.slots.entries('conversation.chat.node')).toHaveLength(0)

    await browser.fiber.dispose()
    expect(browser.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(browser.slots.entries('conversation.chat.user.before')).toHaveLength(0)
  })

  it('re-registers after the declaring origin slot collapses and returns', async () => {
    const browser = await bench()
    browser.declaration()
    expect(browser.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(browser.slots.entries('conversation.chat.user.before')).toHaveLength(0)
    const redeclare = declare(browser.slots)
    await Promise.resolve()
    expect(browser.slots.entries('conversation.session.header.utilities')[0]?.component)
      .toBe(LiveshareShareAction)
    expect(browser.slots.entries('conversation.chat.user.before')).toHaveLength(1)
    redeclare()
    await browser.fiber.dispose()
  })

  it('binds workspace navigation for the share manager', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const declaration = declare(ctx.get('slots') as SlotRegistry)
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('remote', { $mount: async () => {} } as never)
    const openSession = vi.fn()
    ctx.provide('uiWorkspace', { openSession } as never)

    const dispose = await apply(ctx)
    openManagedSession('target-session')
    expect(openSession).toHaveBeenCalledWith('target-session')
    await dispose()
    openManagedSession('later-session')
    expect(openSession).toHaveBeenCalledTimes(1)
    declaration()
    await ctx.fiber.dispose()
  })

  it('disposes the carrier fiber it created for the owner Remote', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const declaration = declare(ctx.get('slots') as SlotRegistry)
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('remote', { $mount: async () => {} } as never)
    const created: Fiber[] = []
    ctx.on('internal/plugin', (fiber) => { created.push(fiber) })

    const dispose = await apply(ctx)
    // The face owns the origin registration, the Remote carrier, and the namespace-injected header child.
    expect(created).toHaveLength(2)
    expect(ctx.slots.entries('conversation.chat.user.before')).toHaveLength(1)
    await dispose()

    // The returned disposer releases the carrier; the origin registration remains with the face.
    expect(created.filter(fiber => fiber.state === FiberState.ACTIVE)).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.user.before')).toHaveLength(1)
    declaration()
    expect(ctx.slots.entries('conversation.chat.user.before')).toHaveLength(0)
    await ctx.fiber.dispose()
    for (const fiber of created) expect(fiber.state).toBe(FiberState.DISPOSED)
  })
})

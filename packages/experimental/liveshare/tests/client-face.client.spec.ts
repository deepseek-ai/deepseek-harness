// @vitest-environment jsdom
/** Which half of the Liveshare client face mounts: the owner's Share action, or the viewer page surfaces. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as liveshare from '../src/client/index.ts'
import * as viewerBrand from '../src/client/viewer-brand.tsx'
import * as viewerModel from '../src/client/viewer-model.tsx'
import * as viewerPermission from '../src/client/viewer-permission.tsx'
import * as viewerSession from '../src/client/viewer-session-plugin.ts'
import * as viewerSessionRow from '../src/client/viewer-session-row.tsx'
import * as viewerSharePath from '../src/client/viewer-share-path.tsx'

/** The generated contribution is a build artifact; the mount boundary is what this face test covers. */
vi.mock('@deepseek-ai/dsh-experimental-liveshare/remote', () => ({ default: { package: '@deepseek-ai/dsh-experimental-liveshare', methods: {} } }))

const VIEWER_PLUGINS = [
  viewerSession, viewerBrand, viewerModel, viewerPermission, viewerSessionRow, viewerSharePath,
]

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__DSH_LIVESHARE_VIEWER__')
})

/**
 * Mount the client face over recording slot and locale services.
 * @returns The bench root, the face's fiber, the slot registrations, and the dictionary releases.
 */
async function mountFace() {
  const ctx = new Context()
  const registered: {
    readonly name: string
    readonly id?: string
    readonly key?: string
    readonly locale?: string
  }[] = []
  const dictionaryReleased = vi.fn()
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => register(),
    register: (entry: { readonly name: string; readonly id?: string; readonly key?: string; readonly locale?: string }) => {
      registered.push(entry)
      return () => {}
    },
  } as never)
  ctx.provide('locale', { register: () => dictionaryReleased } as never)
  let mounts = 0
  const shares = { marker: 'liveshareShares' }
  ctx.provide('remote', {
    $mount: async () => {
      mounts += 1
      ctx.provide('remote.liveshareShares', shares as never)
      return async () => {}
    },
    liveshareShares: shares,
  } as never)
  const fiber = ctx.plugin(liveshare)
  await fiber.await()
  return { ctx, fiber, registered, dictionaryReleased, mounts: () => mounts }
}

describe('liveshare client face', () => {
  it('registers the owner Share action and mounts no viewer surface on the owner page', async () => {
    const { ctx, fiber, registered, dictionaryReleased, mounts } = await mountFace()
    const origin = registered.filter(entry => entry.name === 'conversation.chat.user.before')
    expect(origin).toHaveLength(1)
    expect(origin[0]).toMatchObject({ name: 'conversation.chat.user.before', locale: 'liveshare' })
    expect((origin[0] as { select?: unknown } | undefined)?.select).toBeTypeOf('function')
    expect(registered.filter(entry => entry.name === 'conversation.chat.node')).toEqual([])
    expect(registered.filter(entry => entry.name === 'conversation.session.header.utilities'))
      .toEqual([expect.objectContaining({ id: 'liveshare-share' })])
    for (const plugin of VIEWER_PLUGINS) expect(ctx.registry.has(plugin)).toBe(false)
    // The owner page mounts the share-management Remote exactly once.
    expect(mounts()).toBe(1)
    await fiber.dispose()
    expect(dictionaryReleased).toHaveBeenCalledOnce()
  })

  it('mounts the viewer surfaces and registers no Share action on a viewer page', async () => {
    Reflect.set(globalThis, '__DSH_LIVESHARE_VIEWER__', { basePath: '', shareId: 'share-1', sessionId: 'fx-alpha' })
    const { ctx, fiber, registered, mounts } = await mountFace()
    // The viewer face contributes the seats whose only service is the slot registry; the owner's own
    // header action is not among them.
    const origin = registered.filter(entry => entry.name === 'conversation.chat.user.before')
    expect(origin).toHaveLength(1)
    expect(origin[0]).toMatchObject({ name: 'conversation.chat.user.before', locale: 'liveshare' })
    expect((origin[0] as { select?: unknown } | undefined)?.select).toBeTypeOf('function')
    expect(registered.filter(entry => entry.name === 'conversation.chat.node')).toEqual([])
    expect(registered.filter(entry => entry.name === 'conversation.input.permission'))
      .toEqual([expect.objectContaining({ name: 'conversation.input.permission' })])
    for (const plugin of VIEWER_PLUGINS) expect(ctx.registry.has(plugin)).toBe(true)
    // A viewer page never mounts the owner Remote: its Peer is refused every management method.
    expect(mounts()).toBe(0)
    await fiber.dispose()
    for (const plugin of VIEWER_PLUGINS) expect(ctx.registry.has(plugin)).toBe(false)
  })
})

describe('Liveshare page constants', () => {
  it('names the same carrier global the protocol package writes', async () => {
    const protocol = await import('../../liveshare-protocol/src/viewer-carrier.ts')
    const channel = await import('../src/viewer-channel.ts')
    expect(channel.LIVESHARE_VIEWER_GLOBAL).toBe(protocol.LIVESHARE_VIEWER_GLOBAL)
    protocol.installViewerCarrier({ basePath: '', shareId: 's', sessionId: 'a', readTimeoutMs: 1 })
    const page = globalThis as { __DSH_LIVESHARE_VIEWER__?: unknown; __DSH_TRANSPORT__?: unknown }
    expect((globalThis as Record<string, unknown>)[channel.LIVESHARE_VIEWER_GLOBAL])
      .toEqual({ basePath: '', shareId: 's', sessionId: 'a' })
    delete page.__DSH_LIVESHARE_VIEWER__
    delete page.__DSH_TRANSPORT__
  })
})

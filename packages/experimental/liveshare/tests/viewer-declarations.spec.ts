/**
 * The temporary plugin capability surface: which endpoints a plugin may offer for share viewers, how the
 * declaring package is verified, how an offer binds to the declaring plugin's own fiber, what a rejected
 * name does, and how an offer that a share selected reaches an already open access snapshot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService, { type RemoteAccessFrame } from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createViewerAccessPolicy, type ViewerAccessFacts } from '../src/host/viewer-access-policy.ts'
import {
  VIEWER_DECLARATIONS_SERVICE,
  ViewerDeclarations,
  viewerDeclarationsOf,
  type ViewerCapabilityGroup,
  type ViewerDeclarationsSurface,
} from '../src/host/viewer-declarations.ts'
import { shareViewerPrincipal, type ShareViewerPrincipal } from '../src/host/viewer-principal.ts'
import { endpointContribution, mountDeclaringPlugin } from './viewer-endpoint-fixture.ts'

const reader = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_reader' }
const READER = shareViewerPrincipal('share', reader)
const PACKAGE = '@fixture/mek-git'
const OTHER_PACKAGE = '@fixture/mek-search'
const READABLE = 'mekGit/getGraph'
const WRITABLE = 'mekGit/commit'
const OTHER_READABLE = 'mekSearch/find'
const DECLARER = 'mekGit'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function context(): Context {
  const ctx = new Context()
  roots.push(ctx)
  return ctx
}

function mount(host: Context, changed?: () => void): ViewerDeclarations {
  const declarations = new ViewerDeclarations(host)
  if (changed !== undefined) declarations.onChanged(changed)
  return declarations
}

/** The two fixtures a declaration case needs: the surface on `ctx`, and one declaring plugin's own view of it. */
async function declaringFixture(): Promise<{
  readonly ctx: Context
  readonly declarations: ViewerDeclarations
  readonly surface: ViewerDeclarationsSurface
}> {
  const ctx = context()
  await ctx.plugin(TypertRegistry)
  ctx.typert.register(endpointContribution(PACKAGE, [READABLE, WRITABLE]))
  const declarations = mount(ctx)
  let surface: ViewerDeclarationsSurface | undefined
  await mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
    surface = viewerDeclarationsOf(pluginCtx)
  })
  if (surface === undefined) throw new Error('the declaring plugin did not reach the declaration surface')
  return { ctx, declarations, surface }
}

describe('viewer capability declarations', () => {
  it('is absent from an application that mounts no share host', () => {
    expect(viewerDeclarationsOf(context())).toBeUndefined()
  })

  it('narrows the surface structurally, not by class identity', () => {
    const ctx = context()
    // The Loader instantiates a module once per entry, so the entry that provides the surface and a
    // consumer in another entry hold different ViewerDeclarations classes for the same service value.
    const provider = {
      registerViewerReadable: () => () => {},
      registerViewerWritable: () => () => {},
      onChanged: () => () => {},
      declaredCapabilities: () => [],
    }
    ctx.provide(VIEWER_DECLARATIONS_SERVICE, provider as never)
    expect(viewerDeclarationsOf(ctx)).toBe(provider)

    // A value missing any operation is not the surface.
    ctx.set(VIEWER_DECLARATIONS_SERVICE, { ...provider, onChanged: undefined })
    expect(viewerDeclarationsOf(ctx)).toBeUndefined()
  })

  it('offers, reference-counts, and withdraws each kind independently', async () => {
    const { surface, declarations } = await declaringFixture()
    // The accessor returns the traced service, so identity is not the contract; membership is.
    expect(declarations.declaredCapabilities()).toEqual([])

    const first = surface.registerViewerReadable([READABLE])
    expect(declarations.declaredCapabilities()).toEqual([{ plugin: PACKAGE, readable: [READABLE], writable: [] }])
    // Declaring the same name twice is idempotent, and the name stays offered while either registration lives.
    const second = surface.registerViewerReadable([READABLE, READABLE])
    expect(declarations.declaredCapabilities()).toEqual([{ plugin: PACKAGE, readable: [READABLE], writable: [] }])
    second()
    expect(declarations.declaredCapabilities()).toEqual([{ plugin: PACKAGE, readable: [READABLE], writable: [] }])
    first()
    expect(declarations.declaredCapabilities()).toEqual([])

    const writable = surface.registerViewerWritable([WRITABLE])
    expect(declarations.declaredCapabilities()).toEqual([{ plugin: PACKAGE, readable: [], writable: [WRITABLE] }])
    writable()
    expect(declarations.declaredCapabilities()).toEqual([])
  })

  it('reports every registration and disposal, and nothing else', async () => {
    const { surface, declarations } = await declaringFixture()
    const changes: string[] = []
    const stop = declarations.onChanged(() => { changes.push('changed') })
    const empty = surface.registerViewerReadable([])
    const emptyWritable = surface.registerViewerWritable([])
    expect(changes).toEqual([])
    expect(() => { empty(); emptyWritable() }).not.toThrow()

    const dispose = surface.registerViewerReadable([READABLE])
    expect(changes).toEqual(['changed'])
    const second = surface.registerViewerWritable([WRITABLE])
    expect(changes).toEqual(['changed', 'changed'])
    dispose()
    second()
    expect(changes).toEqual(['changed', 'changed', 'changed', 'changed'])
    expect(declarations.declaredCapabilities()).toEqual([])
    stop()
  })

  it('reports later changes to a listener that subscribed after a declaration', async () => {
    const { surface, declarations } = await declaringFixture()
    // A consumer may attach after a plugin already offered something, as the share host does when it
    // starts later than the plugins that declare endpoints.
    surface.registerViewerReadable([READABLE])
    const changes: string[] = []
    const stop = declarations.onChanged(() => { changes.push('changed') })
    const writable = surface.registerViewerWritable([WRITABLE])
    expect(changes).toEqual(['changed'])
    stop()
    writable()
    expect(changes).toEqual(['changed'])
    expect(declarations.declaredCapabilities())
      .toEqual([{ plugin: PACKAGE, readable: [READABLE], writable: [] }])
  })

  it.each([
    'mekGit',
    '/getGraph',
    'mekGit/',
    'mekGit/get/Graph',
    'event:api-session/status',
    'mek git/getGraph',
    'mekGit/get Graph',
    'mekGit:getGraph',
  ])('rejects %j as not a <namespace>/<method> Remote endpoint', async (name) => {
    const { surface, declarations } = await declaringFixture()
    expect(() => surface.registerViewerReadable([name]))
      .toThrow(`liveshare: viewer-readable endpoint ${JSON.stringify(name)} must be a <namespace>/<method> Remote endpoint`)
    expect(() => surface.registerViewerWritable([name]))
      .toThrow(`liveshare: viewer-writable endpoint ${JSON.stringify(name)} must be a <namespace>/<method> Remote endpoint`)
    expect(declarations.declaredCapabilities()).toEqual([])
  })

  it('registers none of a list that names one invalid endpoint', async () => {
    const { surface, declarations } = await declaringFixture()
    expect(() => surface.registerViewerReadable([READABLE, 'not-an-endpoint'])).toThrow(TypeError)
    expect(() => surface.registerViewerWritable([WRITABLE, 'mekGit/get/Graph'])).toThrow(TypeError)
    expect(declarations.declaredCapabilities()).toEqual([])
  })

  it('accepts a plugin\'s declaration of its own package\'s live endpoints and records that package', async () => {
    const ctx = context()
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(endpointContribution(PACKAGE, [READABLE, WRITABLE]))
    const declarations = mount(ctx)
    await mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
      viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([READABLE])
      viewerDeclarationsOf(pluginCtx)?.registerViewerWritable([WRITABLE])
    })
    const offered = declarations.declaredCapabilities()
    expect(offered).toEqual([{ plugin: PACKAGE, readable: [READABLE], writable: [WRITABLE] }])
    // The attribution is the verified package, not the plugin's display name.
    expect(offered[0]?.plugin).not.toBe(DECLARER)
  })

  it('rejects an endpoint the Host does not define', async () => {
    const ctx = context()
    await ctx.plugin(TypertRegistry)
    const declarations = mount(ctx)
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const plugin = mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
      viewerDeclarationsOf(pluginCtx)?.registerViewerReadable(['mekGit/missing'])
    })
    await expect(plugin).rejects.toThrow(
      'liveshare: viewer-readable endpoint "mekGit/missing" is not a live Host Remote endpoint')
    expect(declarations.declaredCapabilities()).toEqual([])
  })

  it('rejects an endpoint that belongs to another package', async () => {
    const ctx = context()
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(endpointContribution(OTHER_PACKAGE, [OTHER_READABLE]))
    const declarations = mount(ctx)
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const plugin = mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
      viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([OTHER_READABLE])
    })
    await expect(plugin).rejects.toThrow(
      `liveshare: viewer-readable endpoint "${OTHER_READABLE}" belongs to package "${OTHER_PACKAGE}", `
      + `not to the declaring package "${PACKAGE}"`)
    expect(declarations.declaredCapabilities()).toEqual([])
  })

  it.each(['unowned', `#${READABLE}`])(
    'rejects an endpoint whose generated id %j names no owning package',
    async (id) => {
      const ctx = context()
      await ctx.plugin(TypertRegistry)
      const contribution = endpointContribution(PACKAGE, [READABLE])
      const [invocation] = contribution.invocations
      if (invocation === undefined) throw new Error('the fixture contribution has no invocation')
      ctx.typert.register({ ...contribution, invocations: [{ ...invocation, id }] })
      const declarations = mount(ctx)
      vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
      const plugin = mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
        viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([READABLE])
      })
      await expect(plugin).rejects.toThrow(
        `liveshare: viewer-readable endpoint "${READABLE}" has generated id ${JSON.stringify(id)}, `
        + 'which does not name an owning package')
      expect(declarations.declaredCapabilities()).toEqual([])
    })

  it('rejects a declaration in a Host that mounts no local Typert registry', async () => {
    const ctx = context()
    const declarations = mount(ctx)
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const plugin = mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
      viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([READABLE])
    })
    await expect(plugin).rejects.toThrow(
      `liveshare: viewer-readable endpoint "${READABLE}" is not a live Host Remote endpoint`)
    expect(declarations.declaredCapabilities()).toEqual([])
  })

  it('rejects every declaration from a fiber without a Loader entry name', async () => {
    const ctx = context()
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(endpointContribution(PACKAGE, [READABLE]))
    const declarations = mount(ctx)
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    // A programmatic ctx.plugin() composition has no Loader entry; the plugin cannot name its own package.
    const plugin = ctx.plugin({
      name: DECLARER,
      apply: (pluginCtx: Context) => {
        viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([READABLE])
      },
    })
    await expect(plugin).rejects.toThrow(
      `liveshare: viewer-readable endpoints ["${READABLE}"] have no declaring package: `
      + 'the plugin has no Loader entry name, which a programmatic ctx.plugin() composition cannot supply')
    expect(declarations.declaredCapabilities()).toEqual([])
  })

  it('names the declaring package and withdraws its offer with its own fiber', async () => {
    const ctx = context()
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(endpointContribution(PACKAGE, [READABLE, WRITABLE]))
    const declarations = mount(ctx)
    const plugin = await mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
      const surface = viewerDeclarationsOf(pluginCtx)
      expect(surface).toBeInstanceOf(ViewerDeclarations)
      surface?.registerViewerReadable([READABLE])
      surface?.registerViewerWritable([WRITABLE])
    })
    expect(declarations.declaredCapabilities())
      .toEqual([{ plugin: PACKAGE, readable: [READABLE], writable: [WRITABLE] }])
    // The effect binds the CALLER's fiber, not the fiber that provides the service.
    await plugin.dispose()
    expect(declarations.declaredCapabilities()).toEqual([])
  })

  it('reports the offered packages in one stable order regardless of who declared first', async () => {
    const ctx = context()
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(endpointContribution(PACKAGE, [READABLE]))
    ctx.typert.register(endpointContribution(OTHER_PACKAGE, [OTHER_READABLE]))
    const declarations = mount(ctx)
    // The later-sorting package declares first, so insertion order cannot supply the answer.
    await mountDeclaringPlugin(ctx, 'mekSearch', OTHER_PACKAGE, (pluginCtx) => {
      viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([OTHER_READABLE])
    })
    await mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
      viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([READABLE])
    })

    expect(declarations.declaredCapabilities().map(group => group.plugin)).toEqual([PACKAGE, OTHER_PACKAGE])
  })

  it('treats a repeated withdrawal of the same declaration as the one withdrawal it was', async () => {
    const ctx = context()
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(endpointContribution(PACKAGE, [READABLE]))
    const declarations = mount(ctx)
    const withdrawn: (() => void)[] = []
    await mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
      const surface = viewerDeclarationsOf(pluginCtx)
      if (surface === undefined) throw new Error('the declaring plugin did not reach the declaration surface')
      withdrawn.push(surface.registerViewerReadable([READABLE]))
    })
    expect(declarations.declaredCapabilities()).toEqual([{ plugin: PACKAGE, readable: [READABLE], writable: [] }])

    withdrawn[0]?.()
    // The registration is gone; a caller that repeats its own teardown cannot withdraw another's offer.
    withdrawn[0]?.()
    expect(declarations.declaredCapabilities()).toEqual([])
  })

  it('removes the whole surface with the fiber that provides it', async () => {
    const ctx = context()
    const provider = ctx.plugin({ apply: (hostCtx: Context) => { mount(hostCtx) } })
    await provider
    expect(viewerDeclarationsOf(ctx)).toBeInstanceOf(ViewerDeclarations)
    await provider.dispose()
    expect(viewerDeclarationsOf(ctx)).toBeUndefined()
  })
})

/**
 * One share host's minimum for the snapshot case: the access service, the Gateway that dispatches `follow`,
 * the real `share-viewer` policy, and the capability surface. The share's owner already selected the
 * `mekGit` package's endpoint, so exposure then follows the plugin's declaration alone.
 * @returns The mounted context and the owner's selection, which replacing it recomputes the snapshot from.
 */
async function snapshotFixture(): Promise<{
  readonly ctx: Context
  readonly select: (groups: readonly ViewerCapabilityGroup[]) => void
}> {
  const ctx = context()
  await ctx.plugin(TypertRegistry)
  ctx.typert.register(endpointContribution(PACKAGE, [READABLE]))
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  const access = ctx.remoteAccess
  const declarations = mount(ctx, () => { access.invalidate() })
  let selected: readonly ViewerCapabilityGroup[] = [{ plugin: PACKAGE, readable: [READABLE], writable: [] }]
  const facts: ViewerAccessFacts = {
    share: () => ({
      shareId: 'share',
      sessionId: 'source',
      allowsFork: true,
      viewerAdmitted: true,
      stopped: false,
      sessionMode: 'view',
      viewerCapabilities: selected,
    }),
    viewerAdmitted: () => true,
    sourceConfined: () => true,
    forks: { find: () => undefined, listForShare: () => [], allowsPrompt: () => ({ ok: true }) },
    workspaces: () => [],
    declaredCapabilities: () => declarations.declaredCapabilities(),
  }
  access.registerPolicy('share-viewer', createViewerAccessPolicy(facts))
  return { ctx, select: (groups) => { selected = groups; access.invalidate() } }
}

/** One open `remoteAccess/follow` generation for a share reader. */
async function follow(ctx: Context, principal: ShareViewerPrincipal): Promise<{
  readonly next: () => Promise<RemoteAccessFrame>
  readonly stop: () => Promise<void>
}> {
  const abort = new AbortController()
  const stream = await ctx.typertGateway.stream({
    peer: new Peer(ctx, { principal }), namespace: 'remoteAccess', method: 'follow', args: {}, signal: abort.signal,
  })
  const iterator = stream[Symbol.asyncIterator]()
  return {
    next: async () => {
      const result = await iterator.next()
      if (result.done === true) throw new Error('access stream ended')
      return result.value as RemoteAccessFrame
    },
    stop: async () => {
      abort.abort()
      await iterator.return?.()
    },
  }
}

/** The next `count` frames of one open generation, in the order the Gateway delivers them. */
async function frames(
  guest: { next: () => Promise<RemoteAccessFrame> },
  count: number,
): Promise<readonly RemoteAccessFrame[]> {
  const read: RemoteAccessFrame[] = []
  for (let index = 0; index < count; index++) read.push(await guest.next())
  return read
}

describe('viewer capabilities in an open access snapshot', () => {
  it('pushes an upsert when a declared plugin appears and a remove when it withdraws', async () => {
    const { ctx } = await snapshotFixture()
    const guest = await follow(ctx, READER)
    const baseline = await guest.next()
    if (baseline.type !== 'baseline' || baseline.owner) throw new Error('expected a non-owner baseline frame')
    expect(baseline.grants.flatMap(grant => [...grant.actions])).not.toContain(READABLE)

    const plugin = mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
      viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([READABLE])
    })
    await plugin
    // The endpoint rides the global resource and the source Session, so both grants are recomputed.
    for (const frame of await frames(guest, 2)) {
      expect(frame).toMatchObject({ type: 'upsert' })
      if (frame.type !== 'upsert') throw new Error('expected an upsert frame')
      expect(frame.grant.actions).toContain(READABLE)
    }

    await plugin.dispose()
    // Those resources stay granted by the policy's own reads, so withdrawing the offer is an upsert that
    // no longer names the endpoint.
    for (const frame of await frames(guest, 2)) {
      expect(frame).toMatchObject({ type: 'upsert' })
      if (frame.type !== 'upsert') throw new Error('expected an upsert frame')
      expect(frame.grant.actions).not.toContain(READABLE)
    }
    await guest.stop()
  })

  it('pushes an upsert when the owner clears the selection that was exposing an endpoint', async () => {
    const { ctx, select } = await snapshotFixture()
    const guest = await follow(ctx, READER)
    const baseline = await guest.next()
    if (baseline.type !== 'baseline' || baseline.owner) throw new Error('expected a non-owner baseline frame')
    expect(baseline.grants.flatMap(grant => [...grant.actions])).not.toContain(READABLE)

    // The plugin's offer is what the owner's already stored selection was waiting for, so the endpoint
    // is exposed from here on; the frames below are the ones the withdrawal below is compared against.
    const plugin = mountDeclaringPlugin(ctx, DECLARER, PACKAGE, (pluginCtx) => {
      viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([READABLE])
    })
    await plugin
    for (const frame of await frames(guest, 2)) {
      expect(frame).toMatchObject({ type: 'upsert' })
      if (frame.type !== 'upsert') throw new Error('expected an upsert frame')
      expect(frame.grant.actions).toContain(READABLE)
    }

    // Clearing the selection is the owner's own withdrawal, and it reaches the open generation the same
    // way a withdrawn declaration does: the next computed bindings no longer carry the endpoint.
    select([])
    for (const frame of await frames(guest, 2)) {
      expect(frame).toMatchObject({ type: 'upsert' })
      if (frame.type !== 'upsert') throw new Error('expected an upsert frame')
      expect(frame.grant.actions).not.toContain(READABLE)
    }
    await guest.stop()
  })
})

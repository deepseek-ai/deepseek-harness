/** Provider rows add routes to the adapter row, which serves each route from the declaration placed last. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group, type Entry, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as ProviderRow from '@deepseek-ai/dsh-llm-pi-ai/provider'
import type { PiAiProviderRegistration } from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiProviderRegistry, type PiAiRowRoutes } from '../src/registry.ts'

class StubAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<never> {
    throw new Error('stub adapter must never stream')
  }
}

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  vi.restoreAllMocks()
})

async function runtime(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  return ctx
}

/** The adapter and provider rows as Loader entries, so each has a place in the entry list. */
async function loaded(ctx: Context, providers: Record<string, LlmPiAi.PiAiProviderProfile> = {}) {
  await ctx.plugin(Loader)
  ctx.loader.builtins['pi-ai'] = LlmPiAi
  ctx.loader.builtins['pi-ai-provider'] = ProviderRow
  ctx.loader.builtins['group'] = Group
  const create = async (options: Omit<EntryOptions, 'id'> & { id: string }, parent: string | null = null, position?: number): Promise<Entry> => {
    const entry = ctx.loader.resolve(await ctx.loader.create(options, parent, position))
    await entry.fiber?.await()
    return entry
  }
  const adapter = await create({ id: 'llm-pi-ai', name: 'cordis:pi-ai', config: { providers } })
  const row = (id: string, provider: string, profile: LlmPiAi.PiAiProviderProfile, parent: string | null = null, position?: number) =>
    create({ id, name: 'cordis:pi-ai-provider', config: { provider, ...profile } }, parent, position)
  /** Remove a row and wait until the routes reflect it. */
  const remove = async (id: string): Promise<void> => {
    ctx.loader.remove(id)
    await ctx.loader.await()
  }
  return { adapter, create, row, remove }
}

const names = (ctx: Context): string[] => ctx.llm.listProviders().map(provider => `${provider.id}=${provider.name}`)
/** Where the directory sends a configuration surface for one route. */
const address = (ctx: Context, provider: string): string | undefined => {
  const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === provider)
  return entry === undefined ? undefined : `${entry.settingsNs} @ ${entry.settingsPath.join('.') || '(the row)'}`
}

const gateway = { api: 'openai-completions', baseURL: 'https://acme.test/v1', models: [{ id: 'm' }] }

describe('a provider row', () => {
  it('waits for the adapter row, then registers its route and withdraws it when the row is disposed', async () => {
    const ctx = await runtime()
    const row = ctx.plugin(ProviderRow, { provider: 'acme', ...gateway })
    expect(ctx.llm.listProviders()).toEqual([])
    await ctx.plugin(LlmPiAi, { providers: { openai: {} } })
    await row
    expect(names(ctx)).toEqual(['openai=openai', 'acme=acme'])
    // A row mounted outside a Loader entry has no id, so the directory addresses its route as it does a dict entry.
    expect(address(ctx, 'acme')).toBe('llm-pi-ai @ providers.acme')
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'acme')?.declared).toBe(true)

    await row.dispose()
    expect(names(ctx)).toEqual(['openai=openai'])
    expect(address(ctx, 'acme')).toBeUndefined()
  })

  it('fails alone when its profile cannot be served, leaving the other routes registered', async () => {
    const ctx = await runtime()
    await ctx.plugin(LlmPiAi, { providers: { openai: {} } })
    await expect(ctx.plugin(ProviderRow, { provider: 'broken', baseURL: '' })).rejects.toThrow('provider "broken" has an empty baseURL')
    await expect(ctx.plugin(ProviderRow, { provider: 'anthropic', models: 'oops' })).rejects.toThrow()
    expect(names(ctx)).toEqual(['openai=openai'])
  })

  it('fails alone when another adapter owns its route, and the adapter keeps no trace of it', async () => {
    const ctx = await runtime()
    await ctx.plugin(LlmPiAi, { providers: { openai: {} } })
    ctx.llm.registerAdapter(['anthropic'], new StubAdapter())
    await expect(ctx.plugin(ProviderRow, { provider: 'anthropic' })).rejects.toThrow('an adapter for provider "anthropic" is already registered')
    expect(names(ctx).toSorted()).toEqual(['anthropic=anthropic', 'openai=openai'])
    // A later row still registers: the refused one left the route set as it was.
    await ctx.plugin(ProviderRow, { provider: 'deepseek' })
    expect(names(ctx).toSorted()).toEqual(['anthropic=anthropic', 'deepseek=deepseek', 'openai=openai'])
  })

  it('keeps unknown config keys as profile fields, so a removed field is still refused', async () => {
    const ctx = await runtime()
    await ctx.plugin(LlmPiAi)
    await expect(ctx.plugin(ProviderRow, { provider: 'openai', maxRetries: 2 })).rejects.toThrow(/removed.*agent recovery/i)
  })

  it('applies a changed profile field in place and checks a changed profile before it is stored', async () => {
    const ctx = await runtime()
    const { row } = await loaded(ctx)
    const entry = await row('team-acme', 'acme', gateway)
    const fiber = entry.fiber!
    expect(names(ctx)).toEqual(['acme=acme'])
    expect(address(ctx, 'acme')).toBe('team-acme @ (the row)')

    await entry.update({ config: { provider: 'acme', ...gateway, displayName: 'Acme' } })
    expect(entry.fiber).toBe(fiber)
    expect(names(ctx)).toEqual(['acme=Acme'])

    // The candidate is judged whole: the schema first, then whether the route could be served.
    expect(() => fiber.resolveConfig({ provider: 'acme', ...gateway, models: 'oops' })).toThrow()
    expect(() => fiber.resolveConfig({ provider: 'acme', api: 'openai-completions', baseURL: 'https://acme.test/v1' }))
      .toThrow(/resolves no models/)
    expect(() => fiber.resolveConfig({ provider: 'renamed', api: 'openai-completions' })).toThrow(/resolves no models/)
    expect(names(ctx)).toEqual(['acme=Acme'])
  })

  it('starts with a stored profile that the installed catalog no longer describes, and refuses it as a written config', async () => {
    const ctx = await runtime()
    const { row } = await loaded(ctx)
    const stored = { modelOverrides: { 'removed-model': { maxTokens: 4096 } } }
    const entry = await row('team-anthropic', 'anthropic', stored)
    expect(ctx.llm.listConfigurableProviders().find(provider => provider.provider === 'anthropic')).toMatchObject({
      settingsNs: 'team-anthropic', settingsPath: [], error: expect.stringContaining('modelOverrides names "removed-model"') as string,
    })
    // What a write stores must be serviceable, whether it restates the stored fields or edits beside the defect.
    expect(() => entry.fiber!.resolveConfig({ provider: 'anthropic', ...stored })).toThrow('modelOverrides names "removed-model"')
    expect(() => entry.fiber!.resolveConfig({ provider: 'anthropic', ...stored, displayName: 'Edited' }))
      .toThrow('modelOverrides names "removed-model"')
    expect(() => entry.fiber!.resolveConfig({ provider: 'anthropic', displayName: 'Repaired' })).not.toThrow()
    // Another row's hook does not judge this row's candidate.
    await row('team-openai', 'openai', {})
    expect(() => entry.fiber!.resolveConfig({ provider: 'anthropic' })).not.toThrow()
  })
})

describe('one route that several declarations name', () => {
  it('serves the row placed last in the entry list, whichever started first', async () => {
    const ctx = await runtime()
    const { create, row, remove } = await loaded(ctx)
    await row('second', 'openai', { displayName: 'Second' })
    // Placed before the row that already runs, after the adapter's row.
    await row('first', 'openai', { displayName: 'First' }, null, 1)
    expect(names(ctx)).toEqual(['openai=Second'])
    // The directory addresses the route by the row in effect.
    expect(address(ctx, 'openai')).toBe('second @ (the row)')

    // A row inside a group is ordered by the group's place.
    await create({ id: 'group', name: 'cordis:group', group: true, config: [] })
    await row('nested', 'openai', { displayName: 'Nested' }, 'group')
    expect(names(ctx)).toEqual(['openai=Nested'])
    await row('nested-earlier', 'openai', { displayName: 'Nested earlier' }, 'group', 0)
    expect(names(ctx)).toEqual(['openai=Nested'])

    await remove('nested')
    expect(names(ctx)).toEqual(['openai=Nested earlier'])
    expect(address(ctx, 'openai')).toBe('nested-earlier @ (the row)')
    await remove('nested-earlier')
    expect(names(ctx)).toEqual(['openai=Second'])
    await remove('second')
    expect(names(ctx)).toEqual(['openai=First'])
    await remove('first')
    expect(ctx.llm.listProviders()).toEqual([])
    // A catalog route that nothing configures is addressed by the dict, where a configuration surface adds it.
    expect(address(ctx, 'openai')).toBe('llm-pi-ai @ providers.openai')
  })

  it('counts the dict at the place of the adapter row: a row after it replaces the entry, a row before it does not', async () => {
    const ctx = await runtime()
    const { row, remove } = await loaded(ctx, { openai: { displayName: 'Dict' }, anthropic: { displayName: 'Dict only' } })
    expect(names(ctx)).toEqual(['openai=Dict', 'anthropic=Dict only'])
    expect(address(ctx, 'openai')).toBe('llm-pi-ai @ providers.openai')

    await row('before', 'openai', { displayName: 'Before' }, null, 0)
    expect(names(ctx)).toEqual(['openai=Dict', 'anthropic=Dict only'])
    expect(address(ctx, 'openai')).toBe('llm-pi-ai @ providers.openai')
    // A route that only a preceding row declares is served by that row.
    await row('before-own', 'deepseek', { displayName: 'Before only' }, null, 0)
    expect(names(ctx).toSorted()).toEqual(['anthropic=Dict only', 'deepseek=Before only', 'openai=Dict'])
    expect(address(ctx, 'deepseek')).toBe('before-own @ (the row)')

    await row('after', 'openai', { displayName: 'After' })
    expect(names(ctx).toSorted()).toEqual(['anthropic=Dict only', 'deepseek=Before only', 'openai=After'])
    expect(address(ctx, 'openai')).toBe('after @ (the row)')
    expect(address(ctx, 'anthropic')).toBe('llm-pi-ai @ providers.anthropic')

    await remove('after')
    expect(names(ctx).toSorted()).toEqual(['anthropic=Dict only', 'deepseek=Before only', 'openai=Dict'])
    expect(address(ctx, 'openai')).toBe('llm-pi-ai @ providers.openai')
  })

  it('applies a dict change behind a row in effect once that row leaves, and takes a route back when its dict entry goes', async () => {
    const ctx = await runtime()
    const { adapter, row, remove } = await loaded(ctx, { openai: { displayName: 'Dict' } })
    await row('before', 'openai', { displayName: 'Before' }, null, 0)
    await row('after', 'openai', { displayName: 'After' })
    const fiber = adapter.fiber
    await adapter.update({ config: { providers: { openai: { displayName: 'Dict 2' } } } })
    expect(adapter.fiber).toBe(fiber)
    expect(names(ctx)).toEqual(['openai=After'])
    await remove('after')
    expect(names(ctx)).toEqual(['openai=Dict 2'])
    // Without a dict entry the preceding row serves the route.
    await adapter.update({ config: { providers: {} } })
    expect(names(ctx)).toEqual(['openai=Before'])
    expect(address(ctx, 'openai')).toBe('before @ (the row)')
  })

  it('serves a row of the entry list before a plugin mounted outside it, and the later of two such plugins', async () => {
    const ctx = await runtime()
    const { row, remove } = await loaded(ctx)
    const outside = await ctx.plugin(ProviderRow, { provider: 'openai', displayName: 'Outside' })
    expect(names(ctx)).toEqual(['openai=Outside'])
    const listed = await row('listed', 'openai', { displayName: 'Listed' })
    expect(names(ctx)).toEqual(['openai=Listed'])
    await remove(listed.id)
    const later = await ctx.plugin(ProviderRow, { provider: 'openai', displayName: 'Later' })
    expect(names(ctx)).toEqual(['openai=Later'])
    await later.dispose()
    expect(names(ctx)).toEqual(['openai=Outside'])
    await outside.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('replaces the dict entry with a plugin mounted outside the entry list when the adapter is mounted so too', async () => {
    const ctx = await runtime()
    await ctx.plugin(LlmPiAi, { providers: { openai: { displayName: 'Dict' } } })
    const outside = await ctx.plugin(ProviderRow, { provider: 'openai', displayName: 'Outside' })
    expect(names(ctx)).toEqual(['openai=Outside'])
    await outside.dispose()
    expect(names(ctx)).toEqual(['openai=Dict'])
  })

  it('keeps the serving profile when a row that is not in effect changes', async () => {
    const ctx = await runtime()
    const { row, remove } = await loaded(ctx)
    const hidden = await row('hidden', 'openai', { displayName: 'Hidden' })
    await row('serving', 'openai', { displayName: 'Serving' })
    await hidden.update({ config: { provider: 'openai', displayName: 'Hidden 2' } })
    expect(names(ctx)).toEqual(['openai=Serving'])
    await remove('serving')
    expect(names(ctx)).toEqual(['openai=Hidden 2'])
  })

  it('follows rows that a reconciled configuration moves without restarting them', async () => {
    const ctx = await runtime()
    const { row } = await loaded(ctx)
    const first = await row('first', 'openai', { displayName: 'First' })
    const second = await row('second', 'openai', { displayName: 'Second' })
    expect(names(ctx)).toEqual(['openai=Second'])
    const fibers = [first.fiber, second.fiber]
    // What reconciling a patch file that lists the two rows in the other order does to the entry list.
    const list = first.parent.data
    list.splice(list.indexOf(second.options), 1)
    list.splice(list.indexOf(first.options), 0, second.options)
    ctx.emit('app-boot/config-reload')
    expect(names(ctx)).toEqual(['openai=First'])
    expect(address(ctx, 'openai')).toBe('first @ (the row)')
    expect([first.fiber === fibers[0], second.fiber === fibers[1]]).toEqual([true, true])
  })
})

describe('the provider registry', () => {
  /** A registry whose publication the test controls, with a plugin that registers through it. */
  async function registry() {
    const ctx = new Context()
    contexts.push(ctx)
    const published: PiAiRowRoutes[] = []
    let refuse = false
    const owner = await ctx.plugin({
      name: 'owner',
      apply(owned: Context) {
        new PiAiProviderRegistry(owned, (routes) => {
          if (refuse) throw new Error('publication refused')
          published.push(routes)
        })
      },
    })
    let handle!: PiAiProviderRegistration
    const caller = await ctx.plugin({
      name: 'caller',
      inject: ['piAiProviders'],
      apply(calling: Context) { handle = calling.piAiProviders.register('openai', { displayName: 'One' }) },
    })
    /** The latest publication, as `route=display name` on each side of the owner. */
    const last = (): { before: string[]; after: string[] } => {
      const routes = published.at(-1)!
      const shown = (side: PiAiRowRoutes['before']): string[] => [...side].map(([provider, route]) => `${provider}=${route.profile.displayName}`)
      return { before: shown(routes.before), after: shown(routes.after) }
    }
    return { ctx, owner, caller, published, last, handle: () => handle, refuse: (value: boolean) => { refuse = value } }
  }

  it('publishes a registration made outside a Loader entry after its owner, without a row id', async () => {
    const { published, last } = await registry()
    expect(published).toHaveLength(1)
    expect(last()).toEqual({ before: [], after: ['openai=One'] })
    expect(published[0]!.after.get('openai')).not.toHaveProperty('row')
  })

  it('restores the registered profile when a replacement is refused', async () => {
    const { last, handle, refuse } = await registry()
    refuse(true)
    expect(() => { handle().replace({ displayName: 'Two' }) }).toThrow('publication refused')
    refuse(false)
    // The next publication carries a profile that was accepted.
    handle().replace({ displayName: 'Three' })
    expect(last().after).toEqual(['openai=Three'])
    expect(() => { handle().replace({ baseURL: '' }) }).toThrow('empty baseURL')
    expect(last().after).toEqual(['openai=Three'])
  })

  it('refuses a replacement after the registration was withdrawn, by its handle or with its plugin', async () => {
    const { last, handle, caller } = await registry()
    handle()()
    expect(last()).toEqual({ before: [], after: [] })
    expect(() => { handle().replace({ displayName: 'Two' }) }).toThrow('a withdrawn provider registration cannot replace its profile')
    await caller.dispose()
    expect(last()).toEqual({ before: [], after: [] })
  })

  it('publishes nothing for registrations withdrawn while its owner stops', async () => {
    const { published, owner } = await registry()
    const before = published.length
    await owner.dispose()
    expect(published).toHaveLength(before)
  })

  it('publishes after a configuration reload only what the reload changed, and reports a publication that fails then', async () => {
    const { ctx, published, last, handle, refuse } = await registry()
    ctx.emit('app-boot/config-reload')
    expect(published).toHaveLength(1)

    // A change that was refused stays unpublished until something applies it.
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    refuse(true)
    expect(() => { handle()() }).toThrow('publication refused')
    ctx.emit('app-boot/config-reload')
    expect(error.mock.calls.map(([logged]: unknown[]) => logged instanceof Error ? logged.message : logged)).toEqual([
      'llm-pi-ai: the provider rows in effect after a configuration reload could not be applied', 'publication refused',
    ])
    refuse(false)
    ctx.emit('app-boot/config-reload')
    expect(published).toHaveLength(2)
    expect(last()).toEqual({ before: [], after: [] })
  })
})

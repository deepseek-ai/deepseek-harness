/**
 * A person's providers stay in the adapter row's `providers` dict, which the profile patch stores, while a
 * deployment adds provider rows in the home patch. Every case boots a real profile: Loader, bundle, profile and
 * home patches, the configuration editor, and Settings.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { parseEntryYaml, stringifyEntryYaml, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { assemble } from './assemble.ts'
import { ADAPTER, composeProfile, NS, PROVIDER } from './composition.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

let home: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

const gateway = (baseURL: string, displayName: string, apiKeyEnv: string) => ({
  displayName, apiKeyEnv, api: 'openai-completions', baseURL, models: [{ id: 'gateway-model' }],
})

/** What the Models page stores for a person's providers: an override of the adapter row that names its plugin. */
const stored = (providers: object): PatchOptions => ({ id: NS, name: ADAPTER, config: { providers } })
/** Id of the row a deployment writes for one route. */
const hubId = (route: string): string => `llm-pi-ai-dsh-hub-${route}`
const hubRow = (route: string, profile: object, id = hubId(route)) => ({ id, name: PROVIDER, config: { provider: route, ...profile } })
/** The deployment's rows, inserted by the home patch: one provider row for each route. */
const hubRows = (routes: Record<string, object>): PatchOptions =>
  ({ insert: Object.entries(routes).map(([route, profile]) => hubRow(route, profile)) })

async function boot(files: Parameters<typeof composeProfile>[2] = {}) {
  home = await mkdtemp(join(tmpdir(), 'dsh-pi-deployment-rows-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  return { ctx, ...await composeProfile(ctx, home, files) }
}

const routes = (ctx: Context): string[] => ctx.llm.listProviders().map(provider => `${provider.id}=${provider.name}`).toSorted()

/** Where the directory sends a configuration surface for each configured route. */
function addresses(ctx: Context): Record<string, string> {
  const configured = new Set(ctx.llm.listProviders().map(provider => provider.id))
  return Object.fromEntries(ctx.llm.listConfigurableProviders()
    .filter(entry => configured.has(entry.provider))
    .map(entry => [entry.provider, `${entry.settingsNs} @ ${entry.settingsPath.join('.') || '(the row)'}`]))
}

/** State of one row's plugin as the Loader holds it, with the first line of the error of a row that failed. */
async function rowState(ctx: Context, id: string): Promise<{ state: FiberState | undefined; error?: string | undefined }> {
  const fiber = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)?.fiber
  if (fiber === undefined) return { state: undefined }
  const error = await fiber.await().then(() => undefined, (reason: unknown) => (reason as Error).message.split('\n')[0])
  return { state: fiber.state, error }
}

/** Route keys of the dict in the stored profile patch. */
async function storedProviders(path: string): Promise<unknown> {
  return (parseEntryYaml(await readFile(path, 'utf8')) as PatchOptions[])
    .map(item => ({ id: item.id, name: item.name, providers: Object.keys((item.config as { providers: object }).providers) }))
}

const authorization = (server: { headers: Record<string, unknown>[] }): unknown[] => server.headers.map(headers => headers['authorization'])

describe('a providers dict in the profile patch beside provider rows in the home patch', () => {
  it('loads a stored profile patch as it is, serves both, and writes a person\'s providers into the dict only', async () => {
    vi.stubEnv('HUB_KEY', 'hub-key')
    vi.stubEnv('MINE_KEY', 'mine-key')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const { ctx, patchPath, homePatch, reload } = await boot({
      profile: [stored({ mine: gateway(server.url, 'Mine', 'MINE_KEY') })],
      deployment: [hubRows({ hub: gateway(server.url, 'Hub', 'HUB_KEY'), hub2: gateway(server.url, 'Hub 2', 'HUB_KEY') })],
    })
    expect(await storedProviders(patchPath)).toEqual([{ id: NS, name: ADAPTER, providers: ['mine'] }])
    expect(routes(ctx)).toEqual(['hub2=Hub 2', 'hub=Hub', 'mine=Mine'])
    // A dict entry is addressed inside the adapter row; a provider row is its own settings namespace.
    expect(addresses(ctx)).toEqual({
      mine: 'llm-pi-ai @ providers.mine', hub: 'llm-pi-ai-dsh-hub-hub @ (the row)', hub2: 'llm-pi-ai-dsh-hub-hub2 @ (the row)',
    })

    // The writes the Models page makes for a person's own providers.
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['providers', 'other'], value: gateway(server.url, 'Other', 'OTHER_KEY') }])
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['providers', 'mine', 'displayName'], value: 'Mine 2' }])
    expect(routes(ctx)).toEqual(['hub2=Hub 2', 'hub=Hub', 'mine=Mine 2', 'other=Other'])
    expect(await storedProviders(patchPath)).toEqual([{ id: NS, name: ADAPTER, providers: ['mine', 'other'] }])

    // A deployment's row is not the profile's to change or remove.
    const before = await readFile(patchPath, 'utf8')
    const refusal = 'Configuration for "llm-pi-ai-dsh-hub-hub" is overridden by a home patch or command-line overlay'
    await expect(ctx.settings.mutate(hubId('hub'), [{ op: 'set', path: ['baseURL'], value: 'http://127.0.0.1:1' }])).rejects.toThrow(refusal)
    await expect(ctx.settings.replace(hubId('hub'), gateway(server.url, 'Edited', 'HUB_KEY'))).rejects.toThrow(refusal)
    expect(await readFile(patchPath, 'utf8')).toBe(before)

    await assemble(ctx, { provider: 'hub', model: 'gateway-model', messages: [] })
    await assemble(ctx, { provider: 'mine', model: 'gateway-model', messages: [] })
    expect(authorization(server)).toEqual(['Bearer hub-key', 'Bearer mine-key'])

    // The deployment rewrites its own file: one row changes in place and one goes.
    await writeFile(homePatch, stringifyEntryYaml([hubRows({ hub: gateway(server.url, 'Hub renamed', 'HUB_KEY') })]))
    await reload()
    expect(routes(ctx)).toEqual(['hub=Hub renamed', 'mine=Mine 2', 'other=Other'])
    await writeFile(homePatch, '[]\n')
    await reload()
    expect(routes(ctx)).toEqual(['mine=Mine 2', 'other=Other'])
  })

  it('serves the deployment row of a route that the dict names too, in either start order, and the dict entry once the row is gone', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'mine-key')
    vi.stubEnv('HUB_OPENAI_API_KEY', 'hub-key')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }, { events: textEvents }])
    const endpoint = { api: 'openai-completions', baseURL: server.url, models: [{ id: 'gateway-model' }] }
    const hub = [hubRows({ openai: { apiKeyEnv: 'HUB_OPENAI_API_KEY', ...endpoint } })]
    const { ctx, patchPath, homePatch, reload } = await boot({
      profile: [{ id: NS, config: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', ...endpoint }, anthropic: { apiKeyEnv: 'Axxx' } } } }],
      deployment: hub,
    })
    expect(routes(ctx)).toEqual(['anthropic=anthropic', 'openai=openai'])
    expect(addresses(ctx)).toEqual({ anthropic: 'llm-pi-ai @ providers.anthropic', openai: 'llm-pi-ai-dsh-hub-openai @ (the row)' })
    await assemble(ctx, { provider: 'openai', model: 'gateway-model', messages: [] })

    // The dict stays writable, the entry behind the deployment row included; that entry serves nothing meanwhile.
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['providers', 'openai', 'displayName'], value: 'Mine' }])
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['providers', 'anthropic', 'apiKeyEnv'], value: 'MY_ANTHROPIC_KEY' }])
    expect(routes(ctx)).toEqual(['anthropic=anthropic', 'openai=openai'])
    // The hand-written override, which names no plugin, is edited in place.
    expect(await storedProviders(patchPath)).toEqual([{ id: NS, providers: ['openai', 'anthropic'] }])

    await writeFile(homePatch, '[]\n')
    await reload()
    expect(routes(ctx)).toEqual(['anthropic=anthropic', 'openai=Mine'])
    expect(addresses(ctx)['openai']).toBe('llm-pi-ai @ providers.openai')
    await assemble(ctx, { provider: 'openai', model: 'gateway-model', messages: [] })

    // The other order: the deployment row arrives while the profile runs.
    await writeFile(homePatch, stringifyEntryYaml(hub))
    await reload()
    expect(routes(ctx)).toEqual(['anthropic=anthropic', 'openai=openai'])
    await assemble(ctx, { provider: 'openai', model: 'gateway-model', messages: [] })
    expect(authorization(server)).toEqual(['Bearer hub-key', 'Bearer mine-key', 'Bearer hub-key'])
  })

  it('serves a deployment row under its own route key beside the same provider in the dict, each with its credential', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'mine-key')
    vi.stubEnv('HUB_OPENAI_API_KEY', 'hub-key')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const endpoint = { api: 'openai-completions', baseURL: server.url, models: [{ id: 'gateway-model' }] }
    const { ctx } = await boot({
      profile: [stored({ openai: { apiKeyEnv: 'OPENAI_API_KEY', ...endpoint } })],
      deployment: [hubRows({ 'dsh-hub-openai': { displayName: 'OpenAI (Hub)', apiKeyEnv: 'HUB_OPENAI_API_KEY', ...endpoint } })],
    })
    expect(routes(ctx)).toEqual(['dsh-hub-openai=OpenAI (Hub)', 'openai=openai'])
    await assemble(ctx, { provider: 'openai', model: 'gateway-model', messages: [] })
    await assemble(ctx, { provider: 'dsh-hub-openai', model: 'gateway-model', messages: [] })
    expect(authorization(server)).toEqual(['Bearer mine-key', 'Bearer hub-key'])
  })

  it('follows a home patch that swaps two rows of one route, without restarting either', async () => {
    const first = hubRow('shared', gateway('https://first.test/v1', 'First', 'HUB_KEY'), 'hub-first')
    const second = hubRow('shared', gateway('https://second.test/v1', 'Second', 'HUB_KEY'), 'hub-second')
    const { ctx, homePatch, reload } = await boot({ deployment: [{ insert: [first, second] }] })
    expect(routes(ctx)).toEqual(['shared=Second'])
    const fibers = (): unknown[] => ['hub-first', 'hub-second'].map(id => [...ctx.loader.entries()].find(entry => entry.options.id === id)?.fiber)
    const running = fibers()
    await writeFile(homePatch, stringifyEntryYaml([{ insert: [second, first] }]))
    await reload()
    expect(routes(ctx)).toEqual(['shared=First'])
    expect(addresses(ctx)).toEqual({ shared: 'hub-first @ (the row)' })
    expect(fibers().map((fiber, index) => fiber === running[index])).toEqual([true, true])
  })

  it('lets a home patch that overrides the adapter row replace the stored dict, and refuses a write to that row', async () => {
    const { ctx } = await boot({
      profile: [stored({ mine: gateway('https://mine.test/v1', 'Mine', 'MINE_KEY') })],
      deployment: [{ id: NS, config: { providers: { hub: gateway('https://hub.test/v1', 'Hub', 'HUB_KEY') } } }],
    })
    expect(routes(ctx)).toEqual(['hub=Hub'])
    expect(addresses(ctx)).toEqual({ hub: 'llm-pi-ai @ providers.hub' })
    await expect(ctx.settings.mutate(NS, [{ op: 'set', path: ['providers', 'other'], value: gateway('https://other.test/v1', 'Other', 'K') }]))
      .rejects.toThrow('Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay')
  })

  it('serves no route while the stored dict cannot start: the adapter row fails and the deployment rows wait for it', async () => {
    const { ctx } = await boot({
      profile: [stored({ good: gateway('https://good.test/v1', 'Good', 'K'), bad: gateway('', 'Bad', 'K') })],
      deployment: [hubRows({ hub: gateway('https://hub.test/v1', 'Hub', 'HUB_KEY') })],
    })
    expect(await rowState(ctx, NS)).toEqual({ state: FiberState.FAILED, error: 'llm-pi-ai: provider "bad" has an empty baseURL' })
    expect(await rowState(ctx, hubId('hub'))).toEqual({ state: FiberState.PENDING, error: undefined })
    expect(routes(ctx)).toEqual([])
  })

  it('serves a bundle row placed before the adapter row only for a route that the dict does not name', async () => {
    const { ctx } = await boot({
      rows: [
        { name: PROVIDER, config: { provider: 'shared', ...gateway('https://bundle.test/v1', 'Bundle', 'K') } },
        { name: PROVIDER, config: { provider: 'bundle-only', ...gateway('https://bundle.test/v1', 'Bundle only', 'K') } },
      ].map((row, index) => ({ ...row, id: `bundle-row-${String(index)}` })),
      profile: [stored({ shared: gateway('https://mine.test/v1', 'Mine', 'MINE_KEY') })],
    })
    expect(routes(ctx)).toEqual(['bundle-only=Bundle only', 'shared=Mine'])
    expect(addresses(ctx)).toEqual({ shared: 'llm-pi-ai @ providers.shared', 'bundle-only': 'bundle-row-1 @ (the row)' })
    // A row that a layer below the profile supplies is the profile's to override.
  })
})

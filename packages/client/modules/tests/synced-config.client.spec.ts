/** Host side of synced configuration: projection, secret removal, and graph publication from a real Loader. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { afterEach, expect, it, vi } from 'vitest'
import { ClientModuleRegistry } from '../src/index.ts'
import type { WebBootGraph } from '../src/client/manifest.ts'
import { syncedValues } from '../src/config-projection.ts'
import { SyncedConfigEntry } from '../src/client/synced-config.ts'

const roots: Context[] = []
let dir: string | undefined
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const Schema = z.object({
  cacheDir: z.string().default('.cache'),
  size: z.natural().default(1).volatile(),
  apiKey: z.string().role('secret').volatile(),
  office: z.object({ maxBytes: z.natural().default(8), token: z.string().role('secret') }).volatile(),
  tokens: z.array(z.string().role('secret')).default([]).volatile(),
  headers: z.dict(z.string().role('secret')).default({}).volatile(),
  choice: z.union([z.object({ kind: z.const('a'), secret: z.string().role('secret') }), z.string()]).default('plain').volatile(),
  wrapped: z.transform(z.natural().default(2), value => value).volatile(),
})

it('projects top-level volatile fields and removes every secret position', () => {
  const effective = Schema({
    size: 3, apiKey: 'k', office: { maxBytes: 9, token: 't' }, tokens: ['x'], headers: { a: 'h' },
    choice: { kind: 'a', secret: 's' }, wrapped: 2, extra: 1,
  })
  expect(syncedValues(Schema, effective, 'pkg')).toEqual({
    size: 3, office: { maxBytes: 9 }, tokens: [], headers: {}, choice: { kind: 'a' }, wrapped: 2,
  })
  expect(syncedValues(z.object({ ordinary: z.string().default('x') }), {}, 'pkg')).toBeUndefined()
  expect(syncedValues(z.string(), 'x', 'pkg')).toBeUndefined()
})

it('reads intersection members, tolerates non-object values, and rejects lossy JSON', () => {
  const Joined = z.intersect([
    z.object({ a: z.natural().default(1).volatile() }),
    z.object({ b: z.object({ c: z.string().role('secret') }).volatile(), d: z.dict(z.string()).volatile(), e: z.array(z.string()).volatile() }),
  ])
  expect(syncedValues(Joined, { a: 1, b: 'scalar', d: 'scalar', e: 'scalar' }, 'pkg')).toEqual({ a: 1, b: 'scalar', d: 'scalar', e: 'scalar' })
  expect(syncedValues(Joined, null, 'pkg')).toEqual({})
  expect(() => syncedValues(Joined, { a: Number.NaN }, 'pkg')).toThrow('pkg Config field a is not lossless JSON')
})

/** A resolvable built browser package under a temporary node_modules. */
function writePackage(name: string): void {
  dir ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-synced-config-')))
  const root = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name, exports: { './client': './lib/client.js', './package.json': './package.json' }, dsh: { client: { platform: 'web' } },
  }))
  writeFileSync(join(root, 'lib', 'client.js'), 'module.exports = {}\n')
}

/** A real Loader whose rows import the given plugins, and the graph service over it. */
async function harness(plugins: Record<string, object>, configs: Record<string, object> = {}, disabled: string[] = []) {
  for (const name of Object.keys(plugins)) writePackage(name)
  const ctx = new Context()
  roots.push(ctx)
  ctx.baseUrl = pathToFileURL(dir!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.internal = { version: 'v2', import: async (name: string) => plugins[name] } as never
  const entries: Record<string, Entry> = {}
  for (const name of Object.keys(plugins)) {
    entries[name] = ctx.loader.resolve(await ctx.loader.create({
      name, disabled: disabled.includes(name), ...(configs[name] === undefined ? {} : { config: configs[name] }),
    }))
  }
  await ctx.loader.await()
  const fiber = ctx.plugin(ClientModuleRegistry)
  await fiber.await()
  const service = ctx.get('clientModules')!
  const config = (id: string) => service.graph().entries.find(row => row.id === id)?.config
  const changes = vi.fn()
  service.onGraphChanged(changes)
  return { ctx, service, entries, fiber, config, changes, plugins }
}

const initial = { size: 3, office: { maxBytes: 8 }, tokens: [], headers: {}, choice: 'plain' }

it('publishes volatile updates once, skips equal values, and keeps unsynced rows without config', async () => {
  const h = await harness({
    '@fixture/pkg': { Config: Schema, apply: () => {} },
    '@fixture/plain': { apply: () => {} },
    '@fixture/off': { Config: Schema, apply: () => {} },
  }, { '@fixture/pkg': { size: 3, apiKey: 'k' }, '@fixture/plain': {} }, ['@fixture/off'])
  expect(h.config('@fixture/pkg')).toEqual(initial)
  expect(h.service.graph().entries.find(row => row.id === '@fixture/plain')).not.toHaveProperty('config')
  const before = h.service.graph()
  await h.entries['@fixture/pkg']!.update({ config: { size: 3, apiKey: 'changed' } })
  expect(h.changes).not.toHaveBeenCalled()
  expect(h.service.graph()).toBe(before)
  await h.entries['@fixture/pkg']!.update({ config: { size: 4, apiKey: 'changed' } })
  expect(h.changes).toHaveBeenCalledOnce()
  expect(h.config('@fixture/pkg')).toEqual({ ...initial, size: 4 })
  expect(h.service.graph().rev).not.toBe(before.rev)
})

it('republishes after an ordinary change restarts the plugin and drops values of a removed row', async () => {
  const h = await harness({ '@fixture/pkg': { Config: Schema, apply: () => {} } }, { '@fixture/pkg': { size: 3 } })
  await h.entries['@fixture/pkg']!.update({ config: { size: 5, cacheDir: 'other' } })
  await h.ctx.loader.await()
  await vi.waitFor(() => { expect(h.config('@fixture/pkg')).toEqual({ ...initial, size: 5 }) })
  h.ctx.loader.remove(h.entries['@fixture/pkg']!.id)
  await h.ctx.loader.await()
  await vi.waitFor(() => { expect(h.service.graph().entries).toEqual([]) })
  await h.fiber.dispose()
})

it('publishes values its own schema resolves for a plugin that has not activated yet', async () => {
  const h = await harness({ '@fixture/waiting': { inject: ['absent'], Config: Schema, apply: () => {} } }, {
    '@fixture/waiting': { size: 3 },
  })
  expect(h.entries['@fixture/waiting']!.fiber!.ctx.fiber.effectiveConfig).toBeUndefined()
  expect(h.config('@fixture/waiting')).toEqual(initial)
})

it('publishes values for an entry created after startup that has not activated yet', async () => {
  const h = await harness({ '@fixture/pkg': { Config: Schema, apply: () => {} } }, { '@fixture/pkg': { size: 3 } })
  writePackage('@fixture/late')
  h.plugins['@fixture/late'] = { inject: ['absent'], Config: Schema, apply: () => {} }
  await h.ctx.loader.create({ name: '@fixture/late', config: { size: 7 } })
  await vi.waitFor(() => { expect(h.config('@fixture/late')).toEqual({ ...initial, size: 7 }) })
})

const bootConfigOf = (ctx: Context, id: string) => (principal: { kind: string }): unknown => {
  const table: { kind: string; name?: string; value?: unknown }[] = []
  ctx.emit('webserver/index-inject', table as never, { principal } as never)
  const graph = table.find(row => row.name === '__DSH_BOOT__')!.value as { entries: { id: string; config?: unknown }[] }
  return graph.entries.find(row => row.id === id)!.config
}

it('serves configured values to the owner and schema defaults to every other Peer, at first render and through graphFor', async () => {
  const h = await harness({ '@fixture/pkg': { Config: Schema, apply: () => {} } }, { '@fixture/pkg': { size: 3 } })
  const bootConfig = bootConfigOf(h.ctx, '@fixture/pkg')
  const defaults = { ...initial, size: 1 }
  const rowOf = (graph: WebBootGraph) => graph.entries.find(row => row.id === '@fixture/pkg')!.config
  expect(bootConfig({ kind: 'owner' })).toEqual(initial)
  expect(bootConfig({ kind: 'viewer' })).toEqual(defaults)
  expect(h.service.graphFor(undefined)).toBe(h.service.graph())
  expect(h.service.graphFor({ kind: 'owner' })).toBe(h.service.graph())
  expect(rowOf(h.service.graphFor({ kind: 'viewer' } as never))).toEqual(defaults)
  // A Remote access grant does not change which values a non-owner receives.
  h.ctx.provide('remoteAccess', { snapshotFor: () => ({ type: 'baseline', owner: false, grants: [] }) } as never)
  expect(bootConfig({ kind: 'viewer' })).toEqual(defaults)
})

it('serves no values to a non-owner Peer when the schema rejects an empty Config', async () => {
  const Required = z.object({ size: z.natural().required().volatile() })
  const h = await harness({ '@fixture/required': { Config: Required, apply: () => {} } }, { '@fixture/required': { size: 3 } })
  const debug = vi.spyOn(h.ctx.logger, 'debug').mockImplementation(() => {})
  await h.entries['@fixture/required']!.update({ config: { size: 4 } })
  const bootConfig = bootConfigOf(h.ctx, '@fixture/required')
  expect(bootConfig({ kind: 'owner' })).toEqual({ size: 4 })
  expect(bootConfig({ kind: 'viewer' })).toBeUndefined()
  expect(debug).toHaveBeenCalled()
})

it('keeps the batch artifacts and the prior batch generation when only synced values change', async () => {
  const h = await harness({ '@fixture/pkg': { Config: Schema, apply: () => {} } }, { '@fixture/pkg': { size: 3 } })
  const status = async (url: string) => (await h.service.fetchBundle(new Request(new URL(url, 'http://localhost/').href))).status
  const first = h.service.graph().batches[0]!.url
  writeFileSync(join(dir!, 'node_modules', '@fixture', 'pkg', 'lib', 'client.js'), 'module.exports = { generation: 2000 }\n')
  h.service.rebuilt('@fixture/pkg')
  const second = h.service.graph()
  expect(second.batches[0]!.url).not.toBe(first)
  await h.entries['@fixture/pkg']!.update({ config: { size: 4 } })
  expect(h.config('@fixture/pkg')).toEqual({ ...initial, size: 4 })
  expect(h.service.graph().batches).toBe(second.batches)
  expect(await status(first)).toBe(200)
})

it('falls back to a live entry of the same name when the selected instance is removed', async () => {
  const h = await harness({ '@fixture/other': { apply: () => {} }, '@fixture/pkg': { Config: Schema, apply: () => {} } }, {
    '@fixture/pkg': { size: 1 },
  })
  // A disabled entry of the same name has no instance to fall back to.
  await h.ctx.loader.create({ name: '@fixture/pkg', disabled: true })
  const second = h.ctx.loader.resolve(await h.ctx.loader.create({ name: '@fixture/pkg', config: { size: 2 } }))
  await h.ctx.loader.await()
  await vi.waitFor(() => { expect(h.config('@fixture/pkg')).toEqual({ ...initial, size: 2 }) })
  h.ctx.loader.remove(second.id)
  await h.ctx.loader.await()
  await vi.waitFor(() => { expect(h.config('@fixture/pkg')).toEqual({ ...initial, size: 1 }) })
  await h.entries['@fixture/pkg']!.update({ config: { size: 3 } })
  expect(h.config('@fixture/pkg')).toEqual({ ...initial, size: 3 })
  // With no live entry left, the last values stay until the row leaves the graph.
  h.ctx.loader.remove(h.entries['@fixture/pkg']!.id)
  await h.ctx.loader.await()
})

it('keeps the last values of a row whose value cannot be synced', async () => {
  const h = await harness({ '@fixture/lossy': { Config: z.object({ n: z.any().volatile() }), apply: () => {} } }, { '@fixture/lossy': { n: 1 } })
  const errors = vi.spyOn(h.ctx.logger, 'error').mockImplementation(() => {})
  expect(h.config('@fixture/lossy')).toEqual({ n: 1 })
  await h.entries['@fixture/lossy']!.update({ config: { n: Number.POSITIVE_INFINITY } })
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('@fixture/lossy Config field n') as string }))
  expect(h.config('@fixture/lossy')).toEqual({ n: 1 })
})

it('keeps the fields each union branch or intersection member does not declare', () => {
  const a = z.object({ a: z.string() })
  const b = z.object({ b: z.string() })
  const schema = z.object({
    either: z.union([a, b]).volatile(),
    both: z.intersect([a, b]).volatile(),
    hidden: z.union([z.object({ kind: z.const('x'), token: z.string().role('secret') }), b]).volatile(),
  })
  expect(syncedValues(schema, { either: { a: 'one' }, both: { a: 'one', b: 'two' }, hidden: { kind: 'x', token: 't' } }, 'pkg'))
    .toEqual({ either: { a: 'one' }, both: { a: 'one', b: 'two' }, hidden: { kind: 'x' } })
})

it('compares field values as JSON, so an empty array and an empty object differ while reordered keys do not', () => {
  const entry = new SyncedConfigEntry({ list: [], map: { a: 1, b: 2 } })
  expect(entry.config).toBeUndefined()
  type Ref = { get(): unknown; subscribe(listener: () => void): () => void }
  const config = entry.activate() as { list: Ref; map: Ref }
  expect(entry.config).toBe(config)
  const list = vi.fn()
  const map = vi.fn()
  config.list.subscribe(list)
  config.map.subscribe(map)
  entry.update({ list: {}, map: { b: 2, a: 1 }, extra: 1 })
  expect(config.list.get()).toEqual({})
  expect(list).toHaveBeenCalledOnce()
  expect(map).not.toHaveBeenCalled()
  expect(entry.empty).toBe(false)
  entry.release()
  expect(entry.config).toBeUndefined()
  entry.update({})
  expect(entry.empty).toBe(true)
  expect(config.list.get()).toEqual({})
})

it('queues the new graph before the plugin\'s own volatile-update listeners run', async () => {
  const order: string[] = []
  const h = await harness({
    '@fixture/ordered': { Config: Schema, apply: (ctx: Context) => { ctx.on('loader/volatile-update', () => { order.push('plugin') }) } },
  }, { '@fixture/ordered': { size: 1 } })
  h.service.onGraphChanged(() => { order.push('graph') })
  await h.entries['@fixture/ordered']!.update({ config: { size: 2 } })
  expect(order).toEqual(['graph', 'plugin'])
})

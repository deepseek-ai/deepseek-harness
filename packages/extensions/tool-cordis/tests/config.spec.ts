import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { queryLiveConfig } from '../src/config.ts'

/** The Config provider reads the running Loader tree: only live fibers expose a Config, carriers never do. */

const modules: Record<string, unknown> = {
  'cordis:group': Group,
  'with-schema': { name: 'with-schema', apply() {}, Config: z.object({ port: z.number().default(80).description('Listen port.') }) },
  'no-config': { name: 'no-config', apply() {} },
  'foreign-schema': { name: 'foreign-schema', apply() {}, Config: { '~standard': { validate: (value: unknown) => ({ value }) } } },
}

interface Ids {
  withSchema: string
  noConfig: string
  foreign: string
  off: string
  group: string
}

/** A Loader tree whose base directory holds `node_modules/with-schema/package.json`, so the package lookup resolves that plugin. */
async function loaded(): Promise<{ ctx: Context; ids: Ids; packageDir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-cordis-config-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const packageDir = join(dir, 'node_modules', 'with-schema')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), '{"name":"with-schema","version":"1.0.0"}\n')
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(dir).href}/`
  await ctx.plugin(PluginPackages)
  await ctx.plugin(Loader)
  vi.spyOn(ctx.loader, 'import').mockImplementation((name: string) => Promise.resolve(modules[name]))
  const ids: Ids = {
    withSchema: await ctx.loader.create({ name: 'with-schema' }),
    noConfig: await ctx.loader.create({ name: 'no-config' }),
    foreign: await ctx.loader.create({ name: 'foreign-schema' }),
    off: await ctx.loader.create({ name: 'with-schema', disabled: true }),
    group: await ctx.loader.create({ name: 'cordis:group', group: true, config: [{ id: 'nested', name: 'no-config' }] }),
  }
  await ctx.loader.await()
  return { ctx, ids, packageDir }
}

interface Page { entries: Array<{ id: string; name: string }>; total: number; nextOffset: number | null }

/** Directory pages are plain JSON; a round trip gives the test its typed view. */
function asPage(value: unknown): Page {
  return JSON.parse(JSON.stringify(value)) as Page
}

async function directory(ctx: Context): Promise<Record<string, unknown>> {
  const { entries } = asPage(await queryLiveConfig(ctx, { limit: 100 }))
  return Object.fromEntries(entries.map(entry => [entry.id, entry]))
}

describe('the Config inspect provider', () => {
  it('lists every live entry with its Loader id, patch id, and Config status', async () => {
    const { ctx, ids } = await loaded()
    const listed = await directory(ctx)
    expect(Object.keys(listed).sort()).toEqual([ids.withSchema, ids.noConfig, ids.foreign, ids.off, ids.group, 'nested'].sort())
    expect(listed[ids.withSchema]).toEqual({ id: ids.withSchema, patchId: ids.withSchema, name: 'with-schema', status: 'schema' })
    expect(listed[ids.noConfig]).toMatchObject({ status: 'absent' })
    expect(listed[ids.foreign]).toMatchObject({ status: 'unsupported' })
    expect(listed[ids.off]).toMatchObject({ name: 'with-schema', status: 'inactive' })
    expect(listed[ids.group]).toMatchObject({ name: 'cordis:group', status: 'tree' })
    expect(listed.nested).toMatchObject({ patchId: 'nested', status: 'absent' })
    await ctx.fiber.dispose()
  })

  it('pages the directory, filters it by plugin name, and rejects malformed query fields', async () => {
    const { ctx, ids } = await loaded()
    const first = asPage(await queryLiveConfig(ctx, { limit: 2 }))
    expect(first.entries).toHaveLength(2)
    expect(first).toMatchObject({ total: 6, nextOffset: 2 })
    const last = asPage(await queryLiveConfig(ctx, { offset: 4, limit: 2 }))
    expect(last).toMatchObject({ total: 6, nextOffset: null })
    const named = asPage(await queryLiveConfig(ctx, { name: 'with-schema' }))
    expect(named.entries.map(entry => entry.id).sort()).toEqual([ids.withSchema, ids.off].sort())
    expect(named).toMatchObject({ total: 2, nextOffset: null })
    await expect(queryLiveConfig(ctx, { limit: 0 })).rejects.toThrow('limit must be an integer from 1 to 100')
    await expect(queryLiveConfig(ctx, { offset: -1 })).rejects.toThrow('offset must be a non-negative integer')
    await expect(queryLiveConfig(ctx, { name: '' })).rejects.toThrow('name must be a non-empty string')
    await ctx.fiber.dispose()
  })

  it('reports a plugin disabled after it ran as inactive', async () => {
    const { ctx, ids } = await loaded()
    await ctx.loader.resolve(ids.withSchema).update({ disabled: true })
    await ctx.loader.await()
    expect((await directory(ctx))[ids.withSchema]).toMatchObject({ status: 'inactive' })
    expect(await queryLiveConfig(ctx, { entry: ids.withSchema })).not.toHaveProperty('schema')
    await ctx.fiber.dispose()
  })

  it('projects one entry with its package directory and reports status alone without a native Config', async () => {
    const { ctx, ids, packageDir } = await loaded()
    const projected = await queryLiveConfig(ctx, { entry: ids.withSchema })
    expect(projected).toMatchObject({
      id: ids.withSchema, status: 'schema', packageDir, acceptsMissing: true, limitations: [],
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: { loaderExpression: { type: 'object', required: ['__jsExpr'] } },
        anyOf: [
          { type: ['object', 'null'], properties: { port: { default: 80, description: 'Listen port.' } } },
          { $ref: '#/$defs/loaderExpression' },
        ],
      },
    })
    expect(await queryLiveConfig(ctx, { entry: ids.off })).toEqual({ id: ids.off, patchId: ids.off, name: 'with-schema', status: 'inactive', packageDir })
    expect(await queryLiveConfig(ctx, { entry: ids.noConfig })).not.toHaveProperty('packageDir')
    expect(await queryLiveConfig(ctx, { entry: ids.group })).toEqual({ id: ids.group, patchId: ids.group, name: 'cordis:group', status: 'tree' })
    await expect(queryLiveConfig(ctx, { entry: 'missing' })).rejects.toThrow('unknown entry id "missing"')
    await ctx.fiber.dispose()
  })

  it('rejects a Host composed without a Loader', async () => {
    await expect(queryLiveConfig(new Context(), undefined)).rejects.toThrow('requires the Loader')
  })
})

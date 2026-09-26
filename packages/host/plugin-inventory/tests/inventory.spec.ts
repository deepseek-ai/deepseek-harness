import { afterEach, describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState, type Plugin } from '@deepseek-ai/cordis'
import { PluginPackages, readPluginMeta, type RuntimeResolution } from '@deepseek-ai/dsh-app-boot'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import PluginInventoryGateway from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function harness(baseUrl?: string): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  if (baseUrl !== undefined) ctx.baseUrl = baseUrl
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  await ctx.plugin(PluginInventoryGateway)
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory }
}

function metadataFixture(mode: 'native' | 'runtime') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inventory-meta-'))
  roots.push(root)
  const profilesDir = join(root, 'profiles')
  const profileDir = join(profilesDir, 'test')
  const baseDir = mode === 'runtime' ? profileDir : root
  mkdirSync(baseDir, { recursive: true })
  const baseUrl = pathToFileURL(join(baseDir, 'entry.mjs')).href
  const dir = mode === 'runtime'
    ? join(root, 'installation', 'node_modules', 'local-plugin')
    : join(root, 'node_modules', 'local-plugin')
  const resolution: RuntimeResolution = {
    profilesDir, profileDir, localPackageNames: [], linkedRoots: [],
    entries: [{ name: 'local-plugin', packageDir: dir, version: undefined,
      declarer: join(dir, 'package.json'), scope: 'installation' }],
  }
  const expectUnlinked = () => {
    expect(lstatSync(dir).isDirectory()).toBe(true)
    for (const path of [
      join(profileDir, 'node_modules'), join(profilesDir, 'node_modules'),
      join(root, 'node_modules'), join(profileDir, '.dsh-module-fallback'),
    ]) expect(lstatSync(path, { throwIfNoEntry: false }), path).toBeUndefined()
  }
  return { dir, baseUrl, resolution, expectUnlinked }
}

describe('PluginInventoryGateway', () => {
  it.each(['native', 'runtime'] as const)('reads local metadata while the package entry remains disabled with %s resolution', async (mode) => {
    const { dir, baseUrl, resolution, expectUnlinked } = metadataFixture(mode)
    mkdirSync(join(dir, 'locale'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'local-plugin', exports: { './feature': './index.js', './feature/locale/*.json': './locale/*.json' },
    }))
    writeFileSync(join(dir, 'index.js'), 'throw new Error("metadata must not execute the plugin")\n')
    writeFileSync(join(dir, 'locale', 'en.json'), '{"meta":{"title":"Local plugin","description":"Local description"}}')
    if (mode === 'runtime') {
      expectUnlinked()
      expect(readPluginMeta('local-plugin/feature', baseUrl)).toBeUndefined()
    }
    const { ctx, inventory } = await harness(baseUrl)
    await ctx.plugin(PluginPackages, mode === 'runtime' ? { resolution } : {})
    await ctx.loader.create({ name: 'local-plugin/feature', disabled: true })
    expect((await inventory.list()).entries).toMatchObject([{
      enabled: false, fiberPhase: null, meta: { title: { en: 'Local plugin' }, description: { en: 'Local description' } },
    }])
    if (mode === 'runtime') {
      expectUnlinked()
      await ctx.fiber.dispose()
      expect(readPluginMeta('local-plugin/feature', baseUrl)).toBeUndefined()
      expectUnlinked()
    }
  })

  it.each(['native', 'runtime'] as const)('resolves preset row metadata from the profile base without loading the plugins with %s resolution', async (mode) => {
    const { dir, baseUrl, resolution, expectUnlinked } = metadataFixture(mode)
    mkdirSync(join(dir, 'locale'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'local-plugin', exports: { './feature': './index.js', './feature/locale/*.json': './locale/*.json' },
    }))
    writeFileSync(join(dir, 'index.js'), 'throw new Error("metadata must not execute the plugin")\n')
    writeFileSync(join(dir, 'locale', 'en.json'), '{"meta":{"title":"Preset plugin","description":"Preset description"}}')
    writeFileSync(join(dir, 'locale', 'zh.json'), '{"meta":{"title":"预设插件"}}')
    if (mode === 'runtime') {
      expectUnlinked()
      expect(readPluginMeta('local-plugin/feature', baseUrl)).toBeUndefined()
    }
    const { ctx, inventory } = await harness(baseUrl)
    await ctx.plugin(PluginPackages, mode === 'runtime' ? { resolution } : {})
    ctx.provide('agentPresets', {
      compositionInventory: async () => [{
        id: 'local', isDefault: true,
        rows: [
          { entryId: 'feature', moduleName: 'local-plugin/feature', enabled: false },
          { entryId: null, moduleName: 'local-plugin/private', enabled: false },
        ],
      }],
    } as Partial<AgentPresetRegistry> as never)

    expect(await inventory.list()).toEqual({
      entries: [],
      agentPresets: [{
        id: 'local', isDefault: true,
        rows: [
          {
            entryId: 'feature', moduleName: 'local-plugin/feature', enabled: false, fiberPhase: null,
            meta: { title: { en: 'Preset plugin', zh: '预设插件' }, description: { en: 'Preset description' } },
          },
          { entryId: null, moduleName: 'local-plugin/private', enabled: false, fiberPhase: null },
        ],
      }],
    })
    if (mode === 'runtime') {
      expectUnlinked()
      await ctx.fiber.dispose()
      expect(readPluginMeta('local-plugin/feature', baseUrl)).toBeUndefined()
      expectUnlinked()
    }
  })

  it('publishes one direct list method under the pluginInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'pluginInventory',
      namespace: 'pluginInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
    ])
  })

  it('projects current non-group Loader entries without a second cache', async () => {
    const { ctx, inventory } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const snapshot = await inventory.list()
    // No agent-preset roster is composed, so the snapshot carries no presets.
    expect(snapshot.agentPresets).toBeUndefined()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        enabled: true,
        fiberPhase: 'active',
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        fiberPhase: 'pending',
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        enabled: false,
        fiberPhase: null,
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect((await inventory.list()).entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      enabled: false,
      fiberPhase: null,
    })

    ctx.loader.remove(pendingId)
    expect((await inventory.list()).entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('carries each composed preset with root-fiber states mapped to phases', async () => {
    const { ctx, inventory } = await harness()
    ctx.provide('agentPresets', {
      compositionInventory: async () => [
        {
          id: 'standard',
          name: '标准模式',
          isDefault: true,
          rows: [
            { entryId: 'alpha', moduleName: 'pkg-alpha', enabled: true, fiberState: FiberState.ACTIVE },
            { entryId: null, moduleName: 'pkg-file', enabled: 'conditional', condition: 'x' },
          ],
        },
        { id: 'damaged', isDefault: false, broken: 'the composition file is missing', rows: [] },
      ],
    } as Partial<AgentPresetRegistry> as never)

    const snapshot = await inventory.list()
    expect(snapshot.agentPresets).toEqual([
      {
        id: 'standard',
        name: '标准模式',
        isDefault: true,
        rows: [
          { entryId: 'alpha', moduleName: 'pkg-alpha', enabled: true, fiberPhase: 'active' },
          { entryId: null, moduleName: 'pkg-file', enabled: 'conditional', condition: 'x', fiberPhase: null },
        ],
      },
      { id: 'damaged', isDefault: false, broken: 'the composition file is missing', rows: [] },
    ])
  })
})

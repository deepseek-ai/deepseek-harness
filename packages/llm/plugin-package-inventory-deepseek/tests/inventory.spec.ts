import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope } from '@deepseek-ai/dsh-scope'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as PluginInventory from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const SIGNAL = new AbortController().signal

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function packagePlugin(
  root: string,
  dir: string,
  manifest: object,
  source = 'export default () => {}\n',
): Promise<string> {
  const packageDir = join(root, dir)
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ type: 'module', ...manifest })}\n`)
  await writeFile(join(packageDir, 'plugin.mjs'), source)
  return `./${dir}/plugin.mjs`
}

async function harness(
  enabled?: boolean, packageService = false,
): Promise<{ ctx: Context; root: string; disposeInventory: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-packages-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(join(root, 'cordis.yml')).href
  await ctx.plugin(Loader)
  if (packageService) await ctx.plugin(PluginPackages)
  ctx.loader.builtins.include = Include
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresets, { default: 'fixture' })
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  const inventory = enabled === undefined
    ? ctx.plugin(PluginInventory)
    : ctx.plugin(PluginInventory, { enabled })
  await inventory
  return { ctx, root, disposeInventory: () => inventory.dispose() }
}

describe('DeepSeek plugin package inventory', () => {
  it('contributes by default and can be explicitly disabled', async () => {
    const defaultHarness = await harness()
    const defaultFields = await defaultHarness.ctx.deepseekLlmApiExtensions.prepare({
      body: { messages: [] }, signal: SIGNAL,
    })
    expect(defaultFields.fields).toHaveProperty('dsh_plugin_packages')

    const disabledHarness = await harness(false)
    const disabledFields = await disabledHarness.ctx.deepseekLlmApiExtensions.prepare({
      body: { messages: [] }, signal: SIGNAL,
    })
    expect(disabledFields.fields).not.toHaveProperty('dsh_plugin_packages')
  })

  it('reports active package versions once, retains parallel versions, and excludes inactive or loose entries', async () => {
    const { ctx, root } = await harness()
    const oneA = await packagePlugin(root, 'one-a', { name: 'one', version: '1.0.0' })
    const oneB = await packagePlugin(root, 'one-b', { name: 'one', version: '2.0.0' })
    const disabled = await packagePlugin(root, 'disabled', { name: 'disabled', version: '1.0.0' })
    await mkdir(join(root, 'loose'), { recursive: true })
    await writeFile(join(root, 'loose/plugin.mjs'), 'export default () => {}\n')

    await ctx.loader.create({ name: oneA })
    await ctx.loader.create({ name: oneA })
    await ctx.loader.create({ name: oneB })
    await ctx.loader.create({ name: disabled, disabled: true })
    await ctx.loader.create({ name: './loose/plugin.mjs' })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })
    expect(prepared.fields.dsh_plugin_packages).toEqual({
      version: 1,
      packages: [
        { name: 'one', version: '1.0.0' },
        { name: 'one', version: '2.0.0' },
      ],
    })
  })

  it.each([false, true])('deduplicates name-only identities separately from versioned identities (reversed=%s)', async (reversed) => {
    const { ctx, root } = await harness()
    const versioned = await packagePlugin(root, 'versioned', { name: 'same', version: 'undefined' })
    const unversioned = await packagePlugin(root, 'unversioned', { name: 'same' })
    const entries = reversed ? [unversioned, versioned] : [versioned, unversioned]
    // Canonical array-index IDs precede other keys in Loader's object-backed store.
    // Named IDs preserve both requested arrival orders before inventory sorting.
    await ctx.loader.root.update([...entries, ...entries].map((name, index) => ({
      id: `inventory-${String(index)}`,
      name,
    })))
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })
    expect(prepared.fields.dsh_plugin_packages?.packages).toStrictEqual([
      { name: 'same' },
      { name: 'same', version: 'undefined' },
    ])
  })

  it.each(['invalid JSON', 'null', 'deleted'])('retains readable packages and warns at most once when another manifest is %s', async (kind) => {
    const { ctx, root } = await harness()
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
    const bad = await packagePlugin(root, 'bad', { name: 'bad', version: '1.0.0' })
    const good = await packagePlugin(root, 'good', { name: 'good', version: '2.0.0' })
    await ctx.loader.create({ name: bad })
    await ctx.loader.create({ name: good })
    const manifest = join(root, 'bad/package.json')
    if (kind === 'deleted') await rm(manifest)
    else await writeFile(manifest, kind === 'null' ? 'null' : '{')
    for (let request = 0; request < 2; request++) {
      const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })
      expect(prepared.fields.dsh_plugin_packages?.packages).toEqual([{ name: 'good', version: '2.0.0' }])
    }
    // A deleted manifest leaves a loose module, which is omitted without a warning.
    expect(warnings).toEqual(kind === 'deleted'
      ? []
      : [['plugin-package-inventory-deepseek: omitting unreadable package identity for %s: %o', bad, expect.any(Error)]])
  })

  it('omits a loose ESM module whose nearest manifest only marks the module type', async () => {
    const { ctx, root } = await harness()
    const marker = await packagePlugin(root, 'marker-only', {})
    await ctx.loader.create({ name: marker })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL }))
      .resolves.toMatchObject({ fields: { dsh_plugin_packages: { version: 1, packages: [] } } })
  })

  it.each(['file', 'bare'])('reports an unversioned private %s package by name alongside versioned packages', async (kind) => {
    const { ctx, root } = await harness(undefined, true)
    const parent = await packagePlugin(root, 'node_modules/inspector', { name: 'inspector', version: '1.0.0' })
    const nested = await packagePlugin(root, kind === 'file' ? 'node_modules/inspector/skill' : 'node_modules/inspector-skill',
      { name: 'inspector-skill', private: true })
    const versioned = await packagePlugin(root, 'versioned-private', { name: 'versioned-private', private: true, version: '2.0.0' })
    await ctx.loader.create({ name: kind === 'file' ? pathToFileURL(join(root, nested)).href : 'inspector-skill/plugin.mjs' })
    await ctx.loader.create({ name: versioned })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })
    expect(prepared.fields.dsh_plugin_packages?.packages).toEqual([
      { name: 'inspector-skill' },
      { name: 'versioned-private', version: '2.0.0' },
    ])
    await ctx.loader.create({ name: parent })
    const withParent = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })
    expect(withParent.fields.dsh_plugin_packages?.packages).toEqual([
      { name: 'inspector', version: '1.0.0' },
      { name: 'inspector-skill' },
      { name: 'versioned-private', version: '2.0.0' },
    ])
  })

  it.each([true, false, undefined].flatMap(isPrivate => [undefined, '', '  ', null, 1, false, {}, []]
    .map(version => ({ name: 'optional-metadata', private: isPrivate, version }))))('omits unavailable version metadata %j', async (manifest) => {
    const { ctx, root } = await harness()
    const plugin = await packagePlugin(root, 'invalid', manifest)
    await ctx.loader.create({ name: plugin })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })
    expect(prepared.fields.dsh_plugin_packages?.packages).toStrictEqual([{ name: 'optional-metadata' }])
  })

  it.each([undefined, '', '  ', 1])('omits unavailable package name %j', async (name) => {
    const { ctx, root } = await harness()
    const plugin = await packagePlugin(root, 'invalid', { name, version: '1.0.0' })
    await ctx.loader.create({ name: plugin })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL }))
      .resolves.toMatchObject({ fields: { dsh_plugin_packages: { version: 1, packages: [] } } })
  })

  it('uses the host inventory when a request has no matching or joined live agent', async () => {
    const { ctx, root } = await harness()
    const plugin = await packagePlugin(root, 'host-only', { name: 'host-only', version: '3.0.0' })
    await ctx.loader.create({ name: plugin })
    const missing = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL, sessionId: 'missing' })
    expect(missing.fields.dsh_plugin_packages?.packages).toEqual([{ name: 'host-only', version: '3.0.0' }])

    const id = SessionId('bare-agent')
    const agentScope = createScope(ctx, {})
    await ctx.agents.register({ id, ctx: agentScope.ctx, session: { id } } as unknown as Agent)
    const bare = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL, sessionId: id })
    expect(bare.fields.dsh_plugin_packages?.packages).toEqual([{ name: 'host-only', version: '3.0.0' }])
  })

  it('resolves scoped and unscoped bare subpaths, absolute/file modules, and skips URL or Cordis modules', async () => {
    const { ctx, root } = await harness(undefined, true)
    await packagePlugin(root, 'node_modules/plain-package', { name: 'plain-package', version: '1.0.0' })
    await packagePlugin(root, 'node_modules/@scope/scoped-package', { name: '@scope/scoped-package', version: '2.0.0' })
    await packagePlugin(root, 'absolute-package', { name: 'absolute-package', version: '3.0.0' })
    const absolute = join(root, 'absolute-package/plugin.mjs')
    const internal = ctx.loader.internal
    ctx.loader.internal = {
      version: 'v2',
      import: async (specifier: string, ...args: unknown[]) => {
        if (specifier === 'https://plugins.example/test.mjs') return { default: () => {} }
        // Node ESM on Windows requires a file URL; retain the raw Loader name for package attribution.
        const portableSpecifier = specifier === absolute ? pathToFileURL(specifier).href : specifier
        return await (internal as never as { import(specifier: string, ...args: unknown[]): Promise<unknown> })
          .import(portableSpecifier, ...args)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>

    await ctx.loader.create({ name: 'plain-package/plugin.mjs' })
    await ctx.loader.create({ name: '@scope/scoped-package/plugin.mjs' })
    await ctx.loader.create({ name: absolute })
    await ctx.loader.create({ name: pathToFileURL(absolute).href })
    ctx.loader.builtins.noop = () => {}
    await ctx.loader.create({ name: 'cordis:noop' })
    await ctx.loader.create({ name: 'https://plugins.example/test.mjs' })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })
    expect(prepared.fields.dsh_plugin_packages?.packages).toEqual([
      { name: '@scope/scoped-package', version: '2.0.0' },
      { name: 'absolute-package', version: '3.0.0' },
      { name: 'plain-package', version: '1.0.0' },
    ])
  })

  it('omits a Loader-resolved bare entry with no package manifest', async () => {
    const { ctx } = await harness()
    ctx.loader.internal = {
      version: 'v2',
      import: async () => ({ default: () => {} }),
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'missing-package' })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL }))
      .resolves.toMatchObject({ fields: { dsh_plugin_packages: { version: 1, packages: [] } } })
  })

  it('does not bypass the profile package service for a missing bare package', async () => {
    const { ctx } = await harness(undefined, true)
    ctx.loader.internal = {
      version: 'v2',
      import: async () => ({ default: () => {} }),
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'missing-profile-package' })

    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL }))
      .resolves.toMatchObject({ fields: { dsh_plugin_packages: { version: 1, packages: [] } } })
  })

  it('supports a direct embedding whose context has no base URL', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    await ctx.plugin(PluginInventory)
    ctx.loader.builtins.noop = () => {}
    await ctx.loader.create({ name: 'cordis:noop' })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })
    expect(prepared.fields.dsh_plugin_packages).toEqual({ version: 1, packages: [] })
  })

  it('uses each ordinary Loader tree base for conflicting bare package versions', async () => {
    const { ctx, root } = await harness()
    await packagePlugin(root, 'node_modules/versioned-plugin', {
      name: 'versioned-plugin', version: '1.0.0',
    })
    const nestedRoot = join(root, 'nested')
    await packagePlugin(nestedRoot, 'node_modules/versioned-plugin', {
      name: 'versioned-plugin', version: '2.0.0',
    })
    const composition = join(nestedRoot, 'cordis.yml')
    await writeFile(composition, '- id: nested\n  name: versioned-plugin/plugin.mjs\n')

    await ctx.loader.create({ name: 'versioned-plugin/plugin.mjs' })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(composition).href } })
    await ctx.loader.await()

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })
    expect(prepared.fields.dsh_plugin_packages?.packages).toEqual([
      { name: 'versioned-plugin', version: '1.0.0' },
      { name: 'versioned-plugin', version: '2.0.0' },
    ])
  })

  it('resolves preset plugins from the host and nested composition bases', async () => {
    const { ctx, root } = await harness()
    await packagePlugin(root, 'node_modules/preset-only', { name: 'preset-only', version: '4.0.0' })
    const nestedRoot = join(root, 'nested-preset')
    await packagePlugin(nestedRoot, 'node_modules/preset-only', { name: 'preset-only', version: '5.0.0' })
    const composition = join(nestedRoot, 'cordis.yml')
    await writeFile(composition, '- id: nested\n  name: preset-only/plugin.mjs\n')
    await ctx.agentPresets.register({ id: 'fixture', plugins: [
      { id: 'preset-only', name: 'preset-only/plugin.mjs' },
      { id: 'nested', name: 'cordis:include', config: { path: pathToFileURL(composition).href } },
    ] })
    const agentScope = createScope(ctx, {})
    await ctx.agentPresets.mount(agentScope.ctx)
    const id = SessionId('preset-agent')
    const agent = { id, ctx: agentScope.ctx, session: { id } } as unknown as Agent
    await ctx.agents.register(agent)
    const modules = ctx.agentPresets.inspectCompositions(agentScope.ctx)
      .flatMap(row => row.modules).filter(row => row.moduleName === 'preset-only/plugin.mjs')
    expect(modules.map(row => row.useHostBase)).toEqual([true, false])
    expect(modules.map(row => new URL('probe.mjs', row.baseUrl).href)).toEqual([
      new URL('probe.mjs', ctx.baseUrl).href,
      new URL('probe.mjs', pathToFileURL(composition)).href,
    ])

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL, sessionId: id })
    expect(prepared.fields.dsh_plugin_packages?.packages).toEqual([
      { name: 'preset-only', version: '4.0.0' },
      { name: 'preset-only', version: '5.0.0' },
    ])
  })

  it('withdraws the inventory field when the contributing plugin reloads', async () => {
    const { ctx, disposeInventory } = await harness()
    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })).fields)
      .toHaveProperty('dsh_plugin_packages')
    await disposeInventory()
    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL })).fields)
      .not.toHaveProperty('dsh_plugin_packages')
  })
})

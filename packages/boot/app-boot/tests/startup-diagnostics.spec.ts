import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, expectTypeOf, it } from 'vitest'
import { boot, StartupError, type StartupCompositionDiagnostic, type StartupPluginState, type StartupServiceState } from '../src/index.ts'
import { captureStartupComposition } from '../src/startup-diagnostics.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function configuration(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-startup-diagnostic-'))
  roots.push(root)
  await writeFile(join(root, 'consumer.mjs'), 'export const inject = ["agents"]; export function apply() {}\n')
  await writeFile(join(root, 'provider.mjs'), 'export function apply(ctx) { ctx.provide("agents", {}) }\n')
  await writeFile(join(root, 'cordis.yml'), [
    '- id: agent', '  name: ./provider.mjs', '  disabled: true',
    '  config:', '    privateValue: do-not-export-this',
    '- id: agent-loop', '  name: ./consumer.mjs', '',
  ].join('\n'))
  return join(root, 'cordis.yml')
}

it('retains disabled and waiting entries after the real Loader has been disposed', async () => {
  const error: unknown = await boot('diagnostic-test', await configuration()).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(StartupError)
  if (!(error instanceof StartupError)) throw error
  expect(error.composition?.plugins).toEqual(expect.arrayContaining([
    expect.objectContaining({ module: './provider.mjs', state: 'disabled', version: 'unknown' }),
    expect.objectContaining({ module: './consumer.mjs', state: 'pending', missing: ['agents'] }),
  ]))
  expect(error.composition?.services).toEqual([
    expect.objectContaining({ service: 'agents', providers: [] }),
  ])
  expect(JSON.stringify(error.composition)).not.toContain('do-not-export-this')
})

it('preserves the startup failure when the Loader is already unavailable to diagnostic capture', async () => {
  const failure = new StartupError('startup was interrupted', [])
  const result: unknown = await boot('diagnostic-test', await configuration(), undefined, async (ctx) => {
    await ctx.fiber.dispose()
    throw failure
  }).catch((error: unknown) => error)
  expect(result).toBe(failure)
  expect(failure.composition).toBeUndefined()
  expect(failure.startup?.messages.some(message => message.args[0] === 'Startup composition diagnostic unavailable')).toBe(true)
})

it('identifies a registered provider that is isolated from the waiting consumer', async () => {
  const error: unknown = await boot('diagnostic-test', await configuration(), undefined, async (ctx) => {
    await ctx.isolate('agents').plugin({
      name: 'isolated-agent-provider',
      apply(provider) { provider.reflect.provide('agents', {}) },
    })
  }).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(StartupError)
  if (!(error instanceof StartupError)) throw error
  expect(error.composition?.services).toEqual([
    expect.objectContaining({ service: 'agents', providers: [{ entry: 'unknown', state: 'active', visibility: 'other-scope' }] }),
  ])
})

it('reports omitted plugin and missing-service counts instead of silently dropping rows', async () => {
  const config = await configuration()
  const root = roots.at(-1)!
  const services = Array.from({ length: 257 }, (_, index) => `missing${index}`)
  await writeFile(join(root, 'consumer.mjs'), `export const inject = ${JSON.stringify(services)}; export function apply() {}\n`)
  await writeFile(config, [
    '- id: agent-loop\n  name: ./consumer.mjs',
    ...Array.from({ length: 257 }, (_, index) => `- id: disabled-${index}\n  name: ./provider.mjs\n  disabled: true`), '',
  ].join('\n'))
  const error: unknown = await boot('diagnostic-test', config).catch((failure: unknown) => failure)
  if (!(error instanceof StartupError)) throw error
  expect(error.composition?.plugins).toHaveLength(256)
  expect(error.composition?.omittedPlugins).toBeGreaterThanOrEqual(2)
  expect(error.composition?.services).toHaveLength(256)
  expect(error.composition?.omittedServices).toBe(1)
})

it('reports a registered same-scope provider whose value is unavailable', async () => {
  const config = await configuration()
  await writeFile(join(roots.at(-1)!, 'provider.mjs'), 'export function apply(ctx) { ctx.provide("agents", undefined) }\n')
  await writeFile(join(roots.at(-1)!, 'consumer.mjs'), 'export const inject = ["agents", "unprovided"]; export function apply() {}\n')
  await writeFile(config, '- id: agent\n  name: ./provider.mjs\n- id: agent-loop\n  name: ./consumer.mjs\n')
  const error: unknown = await boot('diagnostic-test', config)
    .catch((failure: unknown) => failure)
  if (!(error instanceof StartupError)) throw error
  expect(error.composition?.services[0]?.providers).toMatchObject([
    { state: 'active', visibility: 'same-scope' },
  ])
  expect(error.composition?.services[0]?.providers[0]?.entry).toContain('agent')
})

it('retains the Loader disablement after disposal and reports missing source metadata', async () => {
  const config = await configuration()
  await writeFile(config, '- id: agent\n  name: ./provider.mjs\n')
  const ctx = await boot('diagnostic-test', config)
  try {
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'agent')!
    await entry.fiber!.dispose()
    Object.defineProperty(entry.parent.tree.ctx, 'baseUrl', { value: undefined, configurable: true })
    const snapshot = captureStartupComposition(ctx)
    expect(snapshot.plugins).toContainEqual(expect.objectContaining({ module: './provider.mjs', state: 'disabled', source: 'unknown' }))
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each(['same-scope', 'other-scope'] as const)('attributes a nested %s provider to its Loader entry', async (visibility) => {
  const config = await configuration()
  const parent = visibility === 'same-scope' ? 'ctx' : 'ctx.isolate("agents")'
  await writeFile(join(roots.at(-1)!, 'consumer.mjs'), 'export const inject = ["agents", "unprovided"]; export function apply() {}\n')
  await writeFile(join(roots.at(-1)!, 'provider.mjs'), `export async function apply(ctx) { await ${parent}.plugin({ name: "nested-provider", apply(child) { child.provide("agents", undefined) } }) }\n`)
  await writeFile(config, '- id: agent\n  name: ./provider.mjs\n- id: agent-loop\n  name: ./consumer.mjs\n')
  const failure: unknown = await boot('diagnostic-test', config).then(async (ctx) => {
    await ctx.fiber.dispose()
    throw new Error('Expected the missing service to prevent startup')
  }, (error: unknown) => error)
  if (!(failure instanceof StartupError)) throw failure
  const owner = failure.composition?.plugins.find(plugin => plugin.module === './provider.mjs')
  expect(owner).toBeDefined()
  expect(failure.composition?.services[0]?.providers).toEqual([
    { entry: owner!.id, state: 'active', visibility },
  ])
})

it('exports the named types used by startup composition diagnostics', () => {
  expectTypeOf<StartupError['composition']>().toEqualTypeOf<StartupCompositionDiagnostic | undefined>()
  expectTypeOf<StartupCompositionDiagnostic['plugins'][number]>().toEqualTypeOf<StartupPluginState>()
  expectTypeOf<StartupCompositionDiagnostic['services'][number]>().toEqualTypeOf<StartupServiceState>()
})

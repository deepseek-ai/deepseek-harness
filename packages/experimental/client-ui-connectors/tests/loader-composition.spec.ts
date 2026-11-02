/** Profile files, Loader, HMR, and the plugin manager are real; the connector is a fixture bundle with one injecting row. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { boot, initProfile, loadProfileDirectory, readProfileManifest, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Hmr from '@deepseek-ai/dsh-hmr'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import Connectors from '../src/index.ts'

// Fixture names, so neither resolves to a workspace package.
const HUB = 'fixture-connectors-bundle'
const CONNECTOR = 'fixture-connector'

async function bundle(dir: string, name: string, rows: readonly object[], files: Readonly<Record<string, string>> = {}): Promise<void> {
  const path = join(dir, 'node_modules', name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(path, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  for (const [file, text] of Object.entries(files)) await writeFile(join(path, file), text)
}

it('stops a connector row while the Connectors bundle is off and resumes it when switched back on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-connectors-loader-'))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  await writeFile(anchor, JSON.stringify({ name: 'installation', dependencies: {} }))
  initProfile(dir, ['fixture-base', HUB, CONNECTOR])
  await bundle(dir, 'fixture-base', [{ id: 'manager', name: 'cordis:manager' }])
  await bundle(dir, HUB, [{ id: 'ui-connectors', name: 'cordis:connectors' }])
  await bundle(dir, CONNECTOR, [{ id: 'connector', name: './plugin.mjs', inject: ['connectors'] }], {
    'plugin.mjs': 'export function apply(ctx) { ctx.provide("connectorProbe", true) }\n',
  })
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor,
    startedBundles: loadProfileDirectory('test', dir, anchor).layers.map(layer => layer.packageName),
    overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    owner = ctx
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, { manager: PluginManager, connectors: Connectors })
  })
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await ctx.hmr.runExclusive(async () => {})
  expect(ctx.get('connectors')).toBeInstanceOf(Connectors)
  expect(ctx.get('connectorProbe')).toBe(true)

  expect((await ctx.pluginManager.setBundleEnabled(HUB, false)).application).toBe('applied')
  expect(ctx.get('connectors')).toBeUndefined()
  expect(ctx.get('connectorProbe')).toBeUndefined()
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['fixture-base', CONNECTOR])

  expect((await ctx.pluginManager.setBundleEnabled(HUB, true)).application).toBe('applied')
  expect(ctx.get('connectors')).toBeInstanceOf(Connectors)
  expect(ctx.get('connectorProbe')).toBe(true)
})

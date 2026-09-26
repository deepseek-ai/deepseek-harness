import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { getDshRuntimeVersion, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createScope } from '@deepseek-ai/dsh-scope'
import { expect, it, onTestFinished } from 'vitest'
import { harness, declare } from './harness.ts'
import { auditRows, mountPreset, livePresetMounts, type PresetMount } from '../src/mount.ts'
import { mountedCompositionRows } from '../src/composition-inventory.ts'

it('preserves individual causes of import and plugin failures', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.loader.builtins.stringFailure = () => { throw 'string rejection' }
  ctx.loader.builtins.aggregateFailure = () => {
    throw new AggregateError([
      new Error('first member'),
      new Error('wrapped member', { cause: new AggregateError(['nested member'], 'nested aggregate') }),
    ], 'aggregate rejection')
  }
  await ctx.loader.root.update([
    { id: 'missing', name: 'cordis:missingBuiltin' },
    { id: 'disabled', name: 'cordis:missingBuiltin', disabled: true },
    { id: 'string', name: 'cordis:stringFailure' },
    { id: 'aggregate', name: 'cordis:aggregateFailure' },
  ])
  expect(await auditRows(ctx.loader)).toEqual({ failed: [
    'missing (cordis:missingBuiltin): never started',
    'string (cordis:stringFailure): string rejection',
    'aggregate (cordis:aggregateFailure): aggregate rejection\n- first member\n- wrapped member\n  - nested member',
  ], pending: [] })
  await expect(mountPreset(ctx, 'unscoped', [])).rejects.toThrow('requires a scope')
})

it('does not replace the declaring Loader entry subtree or persist runtime tree changes', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  const scopes: ReturnType<typeof createScope>[] = []
  ctx.loader.builtins.parent = { inject: ['loader'], async apply(owner: Context) {
    const entry = owner.fiber.entry!
    const previousTree = entry.subtree
    const previousGroup = entry.subgroup
    const scope = createScope(owner, {})
    scopes.push(scope)
    const mount = await mountPreset(scope.ctx, 'owned', [{ id: 'child', name: 'missing', disabled: true }])
    expect([...mount.tree.entries()][0]!.id).toBe('parent:child')
    expect(mountedCompositionRows(mount.tree)[0]!.entryId).toBe('child')
    expect(entry.subtree).toBe(previousTree)
    expect(entry.subgroup).toBe(previousGroup)
    mount.tree.write()
    entry.subtree = mount.tree
    entry.subgroup = mount.tree.root
    const other = createScope(owner, {})
    scopes.push(other)
    await mountPreset(other.ctx, 'owned-again', [])
    expect(entry.subtree).toBe(mount.tree)
    expect(entry.subgroup).toBe(mount.tree.root)
    delete entry.subtree
    delete entry.subgroup
  } }
  await ctx.loader.root.update([{ id: 'parent', name: 'cordis:parent' }])
  expect(await auditRows(ctx.loader)).toEqual({ failed: [], pending: [] })
  expect(scopes).toHaveLength(2)
  for (const scope of scopes) await scope.dispose()
})

it('reports grouped and conditional plugin rows from the activated tree', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  await declare(ctx, { id: 'standard', plugins: [{ name: 'cordis:group', group: true, config: [
    { id: 'off', name: 'missing', disabled: { __jsExpr: 'true' } },
  ] }] })
  const tree = livePresetMounts(ctx.fiber)[0]!.tree
  expect(mountedCompositionRows(tree)).toEqual([{ entryId: 'off', moduleName: 'missing', enabled: false, condition: 'true' }])
})

it('mounts a profile-denied row disabled and the same row active once exempted', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-preset-compat-')))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const pluginDir = join(dir, 'plugin')
  mkdirSync(pluginDir, { recursive: true })
  const loaded = join(pluginDir, 'loaded.txt')
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: 'incompatible-preset-plugin', version: '1.0.0', type: 'module', main: 'index.mjs',
    peerDependencies: { '@deepseek-ai/dsh': '<0.0.0' },
  }))
  writeFileSync(join(pluginDir, 'index.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync(new URL('./loaded.txt', import.meta.url), '')",
    'export function apply() {}',
    '',
  ].join('\n'))
  const profileDir = join(dir, 'profile')
  mkdirSync(profileDir, { recursive: true })
  const compatibilityPath = join(profileDir, 'compatibility.json')
  writeFileSync(compatibilityPath, '{}\n')
  ctx.provide('profileContext', {
    name: 'test', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'), home: dir,
    cwd: dir, installAnchor: join(dir, 'package.json'), startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined,
  } satisfies ProfileContext)
  const row = { id: 'row', name: pathToFileURL(join(pluginDir, 'index.mjs')).href }
  const scopes: ReturnType<typeof createScope>[] = []
  onTestFinished(async () => { for (const scope of scopes) await scope.dispose() })
  const mounts: PresetMount[] = []
  const loadedWhileDenied: boolean[] = []
  // A scope inherits the dependency API of the context that mints it, and the
  // preset tree needs `loader`, so the mounts run under a loader-injecting row.
  await ctx.plugin({ inject: ['loader'], async apply(owner: Context) {
    const deniedScope = createScope(owner, {})
    scopes.push(deniedScope)
    mounts.push(await mountPreset(deniedScope.ctx, 'denied', [row]))
    loadedWhileDenied.push(existsSync(loaded))
    writeFileSync(compatibilityPath, JSON.stringify({ 'incompatible-preset-plugin@1.0.0': [getDshRuntimeVersion()] }))
    const exemptedScope = createScope(owner, {})
    scopes.push(exemptedScope)
    mounts.push(await mountPreset(exemptedScope.ctx, 'exempted', [row]))
  } })

  expect(mountedCompositionRows(mounts[0]!.tree)).toEqual([{ entryId: 'row', moduleName: row.name, enabled: false }])
  expect(await auditRows(mounts[0]!.tree)).toEqual({ failed: [], pending: [] })
  expect(loadedWhileDenied).toEqual([false])
  expect(mountedCompositionRows(mounts[1]!.tree)[0]!.enabled).toBe(true)
  expect(existsSync(loaded)).toBe(true)
})

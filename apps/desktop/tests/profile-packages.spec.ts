import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createPluginProfile } from '../src/project-manager.ts'
import { linkDesktopHostPackages, unlinkDesktopHostPackages, validateDesktopPluginGraph } from '../src/profile-packages.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-profile-'))
  roots.push(root)
  const dsh = join(root, 'dsh')
  const runtime = runtimeFixture(dsh)
  const profile = join(root, 'profile')
  createPluginProfile(profile)
  linkDesktopHostPackages(profile, dsh, runtime)
  return { root, dsh, runtime, profile }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('loads one shared ESM instance from both host and external plugin while keeping ordinary dependencies private', () => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(dsh, 'node_modules'), 'ordinary', {}, 'export default "host"')
  writePackage(join(profile, 'node_modules'), 'ordinary', {}, 'export default "plugin"')
  const plugin = writePackage(join(profile, 'node_modules'), 'plugin', {
    peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' }, dependencies: { ordinary: '1.0.0' },
  }, 'export { identity } from "@deepseek-ai/cordis"; export { default as ordinary } from "ordinary"')
  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin'])
  const entry = join(dsh, 'check.mjs')
  writeFileSync(entry, `import {identity} from '@deepseek-ai/cordis'; import ordinary from 'ordinary'; import * as plugin from ${JSON.stringify(pathToFileURL(join(plugin, 'index.js')).href)}; console.log(JSON.stringify({same:identity===plugin.identity, host:ordinary, plugin:plugin.ordinary}))`)
  const output = execFileSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } })
  expect(JSON.parse(output)).toEqual({ same: true, host: 'host', plugin: 'plugin' })
})
it.each(['nested', 'alias'])('rejects a %s second copy of a host package', (placement) => {
  const { dsh, runtime, profile } = fixture()
  const plugin = writePackage(join(profile, 'node_modules'), 'plugin')
  if (placement === 'nested') writePackage(join(plugin, 'node_modules'), '@deepseek-ai/cordis')
  else writePackage(join(profile, 'node_modules'), 'alias', { name: '@deepseek-ai/cordis' })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/duplicate or aliased/u)
})
it('rejects a host package declared as an ordinary dependency', () => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', { dependencies: { '@deepseek-ai/cordis': '^1.0.0' } })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/peer dependency/u)
})
it('rejects incompatible peers only when the plugin is enabled', () => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', { peerDependencies: { '@deepseek-ai/cordis': '^2.0.0' } })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/found 1.0.0/u)
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, []) }).not.toThrow()
})
it('refuses to satisfy a plugin dependency from an ancestor CLI project', () => {
  const { root, dsh, runtime, profile } = fixture()
  writePackage(join(root, 'node_modules'), 'ambient')
  writePackage(join(profile, 'node_modules'), 'plugin', { dependencies: { ambient: '1.0.0' } })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/outside its owned packages/u)
})
it('removes broken owned links without following them', () => {
  const { root, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin')
  rmSync(join(root, 'dsh'), { recursive: true })
  expect(() =>{  unlinkDesktopHostPackages(profile) }).not.toThrow()
})
it('refuses to replace an unowned package at a managed name', () => {
  const { profile } = fixture()
  unlinkSync(join(profile, 'node_modules/@deepseek-ai/cordis'))
  writePackage(join(profile, 'node_modules'), '@deepseek-ai/cordis')
  expect(() =>{  unlinkDesktopHostPackages(profile) }).toThrow(/unowned package/u)
})
it('rejects private package links instead of following cycles or old transaction paths', () => {
  const { dsh, runtime, profile } = fixture()
  const plugin = writePackage(join(profile, 'node_modules'), 'plugin')
  symlinkSync(plugin, join(profile, 'node_modules/alias'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/linked private package/u)
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Rolldown } from 'tsdown'
import { afterAll, describe, expect, it } from 'vitest'
import {
  importPackageName,
  isBareSpecifier,
  packagedImportsPlugin,
  unpackagedImports,
  type BundleImportPolicy,
} from '../scripts/desktop-bundle-imports.mjs'

const MAIN: BundleImportPolicy = {
  packages: new Set(['electron', 'electron-updater', '@deepseek-ai/dsh-api-gateway']),
  nodeBuiltins: true,
}
const PRELOAD: BundleImportPolicy = { packages: new Set(['electron', 'events', 'timers', 'url']), nodeBuiltins: false }

describe('desktop bundle imports', () => {
  it('names the package behind a bare specifier', () => {
    expect(importPackageName('electron-updater/out/electronHttpExecutor.js')).toBe('electron-updater')
    expect(importPackageName('@deepseek-ai/dsh-api-gateway/stream-protocol')).toBe('@deepseek-ai/dsh-api-gateway')
    expect(importPackageName('ws')).toBe('ws')
  })

  it('tells external specifiers from bundled and virtual module ids', () => {
    expect(isBareSpecifier('electron')).toBe(true)
    expect(isBareSpecifier('@deepseek-ai/dsh-home-paths')).toBe(true)
    expect(isBareSpecifier('node:fs')).toBe(true)
    expect(isBareSpecifier('./helper.js')).toBe(false)
    expect(isBareSpecifier(join(tmpdir(), 'lib', 'index.js'))).toBe(false)
    expect(isBareSpecifier('\0rolldown/runtime')).toBe(false)
  })

  it('accepts Node builtins and packaged dependencies, including their subpaths, for the main process', () => {
    expect(unpackagedImports([
      'node:fs/promises',
      'crypto',
      'electron',
      'electron-updater/out/electronHttpExecutor.js',
      '@deepseek-ai/dsh-api-gateway/stream-protocol',
    ], MAIN)).toEqual([])
  })

  it('rejects Node builtins outside the sandbox polyfill for a preload', () => {
    expect(unpackagedImports(['electron', 'events', 'url', 'node:fs', 'crypto'], PRELOAD)).toEqual(['node:fs', 'crypto'])
  })

  it('reports each specifier the packaged application cannot resolve once, in import order', () => {
    expect(unpackagedImports([
      '@deepseek-ai/dsh-home-paths',
      'ws',
      '@deepseek-ai/dsh-home-paths',
      'electron',
    ], MAIN)).toEqual(['@deepseek-ai/dsh-home-paths', 'ws'])
  })
})

describe('packaged imports plugin', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundle-imports-'))
  const entries = {
    static: ['import { app } from "electron";', 'import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";', 'export const home = resolveDshHome(app);'],
    dynamic: ['import { app } from "electron";', 'export const home = () => import("@deepseek-ai/dsh-home-paths").then(m => m.resolveDshHome(app));'],
    require: ['import { app } from "electron";', 'export const home = () => require("@deepseek-ai/dsh-home-paths").resolveDshHome(app);'],
    builtin: ['import { contextBridge } from "electron";', 'import { readFileSync } from "node:fs";', 'contextBridge.exposeInMainWorld("x", readFileSync);'],
  } as const
  for (const [name, lines] of Object.entries(entries)) writeFileSync(join(root, `${name}.js`), lines.join('\n'))
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function generate(entry: keyof typeof entries, policy: BundleImportPolicy, format: 'esm' | 'cjs' = 'esm'): Promise<Rolldown.RolldownOutput> {
    // Every import stays external, which is what an unresolved workspace lib/ output produces.
    const bundle = await Rolldown.rolldown({
      input: join(root, `${entry}.js`),
      platform: 'node',
      external: () => true,
      logLevel: 'silent',
      plugins: [packagedImportsPlugin(policy)],
    })
    try {
      return await bundle.generate({ format })
    } finally {
      await bundle.close()
    }
  }

  const unshipped = /imports @deepseek-ai\/dsh-home-paths, which the packaged application does not ship/u

  it('fails the bundle whose static import the packaged application does not ship', async () => {
    await expect(generate('static', { ...MAIN, packages: new Set(['electron']) })).rejects.toThrow(unshipped)
  })

  it('fails the bundle whose dynamic import() the packaged application does not ship', async () => {
    await expect(generate('dynamic', { ...MAIN, packages: new Set(['electron']) })).rejects.toThrow(unshipped)
  })

  it('fails the CommonJS bundle whose require() the packaged application does not ship', async () => {
    await expect(generate('require', { ...MAIN, packages: new Set(['electron']) }, 'cjs')).rejects.toThrow(unshipped)
  })

  it('fails a preload bundle that requires a Node builtin the sandbox does not polyfill', async () => {
    await expect(generate('builtin', PRELOAD, 'cjs')).rejects.toThrow(
      /builtin\.js imports node:fs, which the packaged application does not ship\. /u,
    )
    await expect(generate('builtin', PRELOAD, 'cjs')).rejects.toThrow(
      /This bundle may leave only electron, events, timers, url as bare imports/u,
    )
  })

  it('passes the bundles whose external imports are all packaged', async () => {
    const policy = { ...MAIN, packages: new Set(['electron', '@deepseek-ai/dsh-home-paths']) }
    for (const entry of ['static', 'dynamic'] as const) {
      const output = await generate(entry, policy)
      expect(output.output.map(chunk => chunk.fileName)).toEqual([`${entry}.js`])
    }
    const output = await generate('require', policy, 'cjs')
    expect(output.output.map(chunk => chunk.fileName)).toEqual(['require.js'])
  })
})

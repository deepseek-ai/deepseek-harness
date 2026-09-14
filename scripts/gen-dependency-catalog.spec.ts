/** Production dependency selection and offline catalog freshness regressions. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCommandWithTimeout } from './benchmark-npm-resolution.ts'
import {
  collectDependencies, computeDependencyCatalog, createNpmResolutionEnvironment,
  deduplicateDependencies, isDependencyCatalogCurrent,
} from './gen-dependency-catalog.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

function lockfile() {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@deepseek-ai/dsh': 'latest' } },
      'node_modules/@deepseek-ai/dsh': {
        version: '1.0.0', dependencies: { library: '^2.0.0', alias: 'npm:original@1.0.0' },
        optionalDependencies: { unavailable: '1.0.0' },
      },
      'node_modules/library': { version: '1.0.0' },
      'node_modules/@deepseek-ai/dsh/node_modules/library': { version: '2.0.0', dependencies: { plugin: '*' } },
      'node_modules/alias': { name: 'original', version: '1.0.0' },
      'node_modules/plugin': {
        version: '1.0.0', dependencies: { library: '^1.0.0' }, peerDependencies: { peer: '*' },
        optionalDependencies: { 'native-linux': '*', 'native-helper': '*' },
      },
      'node_modules/peer': { version: '3.0.0', peer: true },
      'node_modules/native-linux': { version: '1.0.0', optional: true, os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
      'node_modules/native-helper': { version: '1.0.0', optional: true, devOptional: true },
      'node_modules/test-only': { version: '1.0.0', dev: true },
    },
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location !== '') Object.assign(entry, { resolved: `https://registry.npmjs.org/${location}/package.tgz` })
  }
  return lock
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dependency-catalog-test-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts/dependency-catalog'), { recursive: true })
  writeFileSync(join(root, 'scripts/dependency-catalog/package-lock.json'), JSON.stringify(lockfile()))
  writeFileSync(join(root, 'scripts/dependency-catalog/resolution.json'), JSON.stringify({
    capturedAt: '2026-09-12T00:00:00.000Z', npm: '11.17.0', node: '24.19.0',
    platform: 'darwin', arch: 'arm64', registry: 'https://registry.npmjs.org/', installStrategy: 'hoisted',
  }))
  return root
}

describe('published npm dependency catalog', () => {
  it('retains nested versions, aliases, peers, and optional candidates while excluding development-only packages', () => {
    const { version, rows } = collectDependencies(lockfile())
    expect(version).toBe('1.0.0')
    expect(rows).toHaveLength(7)
    expect(rows.filter(row => row.direct).map(row => [row.name, row.version])).toEqual([
      ['library', '2.0.0'], ['original', '1.0.0'],
    ])
    expect(rows.find(row => row.name === 'peer')).toMatchObject({ peer: true, optional: false })
    expect(rows.find(row => row.name === 'native-linux')).toMatchObject({
      optional: true, os: ['linux'], cpu: ['arm64'], libc: ['glibc'],
    })
    expect(rows.find(row => row.name === 'native-helper')).toMatchObject({ optional: true })
    expect(rows.map(row => row.name)).not.toContain('test-only')
    expect(rows.map(row => row.name)).not.toContain('unavailable')
  })

  it('does not silently produce an incomplete catalog from invalid or unrelated resolutions', () => {
    expect(() => collectDependencies({ lockfileVersion: 2 })).toThrow('lockfileVersion 3')
    expect(() => collectDependencies({ lockfileVersion: 3, packages: {} })).toThrow('consumer must be an object')
    const input = lockfile()
    input.packages[''].dependencies['@deepseek-ai/dsh'] = 'next'
    expect(() => collectDependencies(input)).toThrow('must request only @deepseek-ai/dsh@latest')
    const missing = lockfile()
    Reflect.deleteProperty(missing.packages, 'node_modules/alias')
    expect(() => collectDependencies(missing)).toThrow('missing direct dependency alias')
    const linked = lockfile()
    Object.assign(linked.packages['node_modules/library'], { link: true })
    expect(() => collectDependencies(linked)).toThrow('is a local link')
  })

  it('sorts packages independently of lockfile object order and keeps duplicate installation locations', () => {
    const input = lockfile()
    const reordered = { ...input, packages: Object.fromEntries(Object.entries(input.packages).reverse()) }
    expect(collectDependencies(reordered)).toEqual(collectDependencies(input))
    Object.assign(input.packages, {
      'node_modules/plugin/node_modules/library': {
        version: '1.0.0', resolved: 'https://registry.npmjs.org/library/-/library-1.0.0.tgz',
      },
    })
    expect(collectDependencies(input).rows.filter(row => row.name === 'library' && row.version === '1.0.0')).toHaveLength(2)
  })

  it('deduplicates identical versions without losing installation locations or optional flags', () => {
    const input = lockfile()
    Object.assign(input.packages, {
      'node_modules/plugin/node_modules/library': {
        version: '1.0.0', optional: true, resolved: 'https://registry.npmjs.org/library/-/library-1.0.0.tgz',
      },
    })
    const rows = collectDependencies(input).rows
    const packages = deduplicateDependencies(rows)
    const repeated = packages.filter(entry => entry.name === 'library' && entry.version === '1.0.0')
    expect(repeated).toHaveLength(1)
    expect(repeated[0]?.installations).toEqual([
      { location: 'node_modules/library', direct: false, optional: false, peer: false },
      { location: 'node_modules/plugin/node_modules/library', direct: false, optional: true, peer: false },
    ])
    expect(packages.filter(entry => entry.name === 'library').map(entry => entry.version)).toEqual(['1.0.0', '2.0.0'])
    expect(deduplicateDependencies([...rows].reverse())).toEqual(packages)
    expect(packages.flatMap(entry => entry.installations)).toHaveLength(rows.length)
  })

  it('rejects missing, edited, or stale JSON without rewriting it', () => {
    const root = fixture()
    const output = computeDependencyCatalog(root)
    const path = join(root, 'docs/dependency-catalog.json')
    expect(isDependencyCatalogCurrent(root)).toBe(false)
    mkdirSync(join(root, 'docs'))
    writeFileSync(path, output)
    expect(isDependencyCatalogCurrent(root)).toBe(true)
    writeFileSync(path, `${output}stale\n`)
    expect(isDependencyCatalogCurrent(root)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(`${output}stale\n`)
    writeFileSync(path, output)
    const updated = lockfile()
    updated.packages['node_modules/peer'].version = '3.1.0'
    writeFileSync(join(root, 'scripts/dependency-catalog/package-lock.json'), JSON.stringify(updated))
    expect(isDependencyCatalogCurrent(root)).toBe(false)
  })

  it('rejects non-public package sources and incorrect registry metadata', () => {
    const input = lockfile()
    Object.assign(input.packages['node_modules/library'], { resolved: 'https://private.invalid/library.tgz' })
    expect(() => collectDependencies(input)).toThrow('not resolved from the public npm registry')
    const root = fixture()
    const metadataPath = join(root, 'scripts/dependency-catalog/resolution.json')
    writeFileSync(metadataPath, JSON.stringify({ registry: 'https://private.invalid/', installStrategy: 'hoisted' }))
    expect(() => computeDependencyCatalog(root)).toThrow('expected the public npm registry and hoisted install strategy')
  })

  it('isolates scoped registries, resolver settings, and caches from user, global, and environment configuration', async () => {
    const root = fixture()
    const userConfig = join(root, 'user.npmrc')
    const globalConfig = join(root, 'global.npmrc')
    writeFileSync(userConfig, '@deepseek-ai:registry=https://user-override.invalid/\nstrict-peer-deps=true\n')
    writeFileSync(globalConfig, '@other:registry=https://global-override.invalid/\nprefer-dedupe=true\n')
    const inherited: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_config_'))),
      npm_config_userconfig: userConfig,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_INSTALL_STRATEGY: 'nested',
      NPM_CONFIG_OFFLINE: 'true',
      NPM_CONFIG_CACHE: join(root, 'inherited-cache'),
      NPM_CONFIG_USER_AGENT: 'inherited-agent',
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const args = ['config', 'list', '--json', '--registry=https://registry.npmjs.org/', '--loglevel=error']
    const before = await runCommandWithTimeout(npm, args, { cwd: root, env: inherited, timeoutMs: 30_000 })
    expect(before).toMatchObject({ status: 0, signal: null, timedOut: false })
    expect(JSON.parse(before.output)).toMatchObject({
      '@deepseek-ai:registry': 'https://user-override.invalid/', 'install-strategy': 'nested',
    })
    const isolated = createNpmResolutionEnvironment(root, inherited)
    const after = await runCommandWithTimeout(npm, args, { cwd: root, env: isolated, timeoutMs: 30_000 })
    expect(after).toMatchObject({ status: 0, signal: null, timedOut: false })
    const settings = JSON.parse(after.output) as Record<string, unknown>
    expect(settings).toMatchObject({
      registry: 'https://registry.npmjs.org/', '@deepseek-ai:registry': 'https://registry.npmjs.org/',
      'install-strategy': 'hoisted', 'strict-peer-deps': false, 'prefer-dedupe': false, offline: false,
      cache: join(root, '.npm-cache'), userconfig: join(root, '.npmrc-user'), globalconfig: join(root, '.npmrc-global'),
    })
    expect(settings['@other:registry']).toBeUndefined()
    expect(isolated['NPM_CONFIG_USER_AGENT']).toBeUndefined()
    expect(inherited['npm_config_userconfig']).toBe(userConfig)
  })

  it('keeps the checked-in JSON synchronized with its recorded npm resolution', () => {
    expect(isDependencyCatalogCurrent(resolve(import.meta.dirname, '..'))).toBe(true)
  })
})

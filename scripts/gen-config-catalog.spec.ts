/** Shared schema aliases must retain the catalog's declared-field checks. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConfigCatalog } from './gen-config-catalog.ts'

const roots: string[] = []
const sharedSchema = `
import Schema from '@deepseek-ai/schemastery'
export interface LaunchConfig {
  /** Browser ownership mode. */
  mode: 'launch'
  /** Hide the launched browser. */
  headless: boolean
}
export interface AttachConfig {
  /** Browser ownership mode. */
  mode: 'attach'
  /** Existing browser address. */
  endpoint: string
}
export type BrowserConfig = LaunchConfig | AttachConfig
export const Shared = Schema.union([
  Schema.object({ mode: Schema.const('launch'), headless: Schema.boolean() }),
  Schema.object({ mode: Schema.const('attach'), endpoint: Schema.string() }),
])
`

function fixture(schema = sharedSchema) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-catalog-'))
  roots.push(root)
  const write = (path: string, value: string): void => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, value)
  }
  write('tsconfig.json', JSON.stringify({ compilerOptions: {
    baseUrl: '.', module: 'ESNext', moduleResolution: 'Bundler',
    paths: { '@test/runtime/config': ['./packages/test/runtime/src/config.ts'] },
  }, include: ['packages/**/*.ts'] }))
  write('packages/test/runtime/package.json', JSON.stringify({
    name: '@test/runtime', exports: { './config': { types: './lib/types/config.d.ts', default: './lib/config.js' } },
  }))
  write('packages/test/runtime/src/index.ts', "export { Shared } from './config.ts'\n")
  write('packages/test/runtime/src/config.ts', schema)
  write('packages/test/provider/package.json', JSON.stringify({ name: '@test/provider' }))
  write('packages/test/provider/src/index.ts', `
import { Shared as SharedConfig, type BrowserConfig } from '@test/runtime/config'
export type Config = BrowserConfig
export const Config = SharedConfig
export function apply(ctx: unknown, config: Config): void {}
`)
  return { root, write }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('shared config schema catalog', () => {
  it('collects every branch through a renamed named import from a public source subpath', () => {
    const { root } = fixture()
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(new Set(provider?.schemaKeys)).toEqual(new Set(['mode', 'headless', 'endpoint']))
    expect(provider?.configTypeName).toBe('Config')
    expect(provider?.pastes?.[0]?.text).toBe('export type Config = BrowserConfig')
  })

  it('rejects a schema field absent from the shared config type', () => {
    const { root } = fixture(sharedSchema.replace('headless: Schema.boolean()', 'headless: Schema.boolean(), hidden: Schema.string()'))
    expect(() => collectConfigCatalog(root)).toThrow("schema validates key 'hidden' but config type 'Config' declares no such member")
  })

  it('follows a local const alias without treating a completed branch as a cycle', () => {
    const { root } = fixture(sharedSchema.replace('export const Shared = Schema.union', 'export const Shared = Base\nconst Base = Schema.union'))
    const provider = collectConfigCatalog(root).find(entry => entry.pkg === '@test/provider')
    expect(new Set(provider?.schemaKeys)).toEqual(new Set(['mode', 'headless', 'endpoint']))
  })

  it('rejects type-only imports used as runtime schemas', () => {
    const { root, write } = fixture()
    write('packages/test/provider/src/index.ts', `
import type { Shared as SharedConfig, BrowserConfig } from '@test/runtime/config'
export type Config = BrowserConfig
export const Config = SharedConfig
export function apply(ctx: unknown, config: Config): void {}
`)
    expect(() => collectConfigCatalog(root)).toThrow("schema alias 'SharedConfig' must name a const or named value import")
  })

  it('rejects a private subpath even when TypeScript can resolve its source', () => {
    const { root, write } = fixture()
    write('packages/test/runtime/package.json', JSON.stringify({ name: '@test/runtime', exports: {} }))
    expect(() => collectConfigCatalog(root)).toThrow("does not explicitly export './config'")
  })

  it('rejects a missing source mapping', () => {
    const { root, write } = fixture()
    write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@test/runtime/config': ['./missing.ts'] } } }))
    expect(() => collectConfigCatalog(root)).toThrow('has no workspace source mapping')
  })

  it('rejects a source mapping into another package', () => {
    const { root, write } = fixture()
    write('tsconfig.json', JSON.stringify({ compilerOptions: {
      baseUrl: '.', paths: { '@test/runtime/config': ['./packages/test/provider/src/index.ts'] },
    } }))
    expect(() => collectConfigCatalog(root)).toThrow('must resolve inside packages/test/runtime/src')
  })

  it('rejects a schema value that the imported module does not export', () => {
    const { root } = fixture(sharedSchema.replace('export const Shared', 'const Shared'))
    expect(() => collectConfigCatalog(root)).toThrow("has no exported const 'Shared'")
  })

  it('rejects recursive const aliases', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = Loop
const Loop = Shared
`)
    expect(() => collectConfigCatalog(root)).toThrow('cyclic schema alias')
  })

  it('rejects a dynamic schema factory instead of dropping its keys', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = makeSchema()
`)
    expect(() => collectConfigCatalog(root)).toThrow('not a statically walkable schemastery call')
  })

  it('rejects an unresolved alias within a schema union', () => {
    const { root } = fixture(`${sharedSchema.slice(0, sharedSchema.indexOf('export const Shared'))}
export const Shared = Schema.union([MissingSchema])
`)
    expect(() => collectConfigCatalog(root)).toThrow("schema alias 'MissingSchema' must name a const or named value import")
  })
})

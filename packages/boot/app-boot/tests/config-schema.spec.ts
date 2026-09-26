/** Native schema catalogs retain declared entries without activating their plugins. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { buildConfigSchemaDocument } from '../src/config-schema/document.ts'
import type { CollectedConfigEntry, ConfigJsonSchemaObject, ConfigSchemaDump } from '../src/config-schema/types.ts'
import { EntryGroup, ModuleLoader, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { collectConfigSchemas } from '../src/config-schema/collect.ts'
import { generateConfigSchema } from '../src/config-schema/index.ts'
import * as profileOperations from '../src/profile.ts'
import type { Profile, RuntimeResolution } from '../src/profile.ts'
import { installRuntimeInterception } from '../src/profile-resolution/resolver.ts'

const dispose = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', { spy: true })
vi.mock('../src/profile-resolution/resolver.ts', () => ({
  installRuntimeInterception: vi.fn(() => ({ dispose })),
}))

let dir: string
let profile: Profile
let resolution: RuntimeResolution
const modules = new Map<string, unknown>()
const importModule = vi.fn(async (name: string): Promise<unknown> => {
  if (!modules.has(name)) throw new Error(`cannot import ${name}`)
  return modules.get(name)
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-config-schema-'))
  profile = { skippedBundles: [], name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), patches: [], layers: [] }
  resolution = { profilesDir: dir, profileDir: dir, localPackageNames: [], entries: [], linkedRoots: [] }
  const loader = ModuleLoader.fromInternal()
  if (loader === undefined) throw new Error('test requires supported Node internals')
  vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue({ ...loader, import: importModule })
  modules.set('noop', { apply: vi.fn() })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  modules.clear()
  rmSync(dir, { recursive: true, force: true })
})

function row(name: string, config?: unknown): EntryOptions {
  return { id: name, name, ...(config === undefined ? {} : { config }) }
}

function schemaOf(dump: ConfigSchemaDump, index = 0): ConfigJsonSchemaObject {
  const entry = dump['x-cordis'].entries[index]
  if (!entry?.configRef) throw new Error('expected schema reference')
  const schema = dump.$defs[entry.configRef.slice('#/$defs/'.length)] as ConfigJsonSchemaObject
  return schema.anyOf?.[0] as ConfigJsonSchemaObject
}

function validates(dump: ConfigSchemaDump, value: unknown, definition = 'entryList'): boolean {
  const validator = new Ajv2020({ strict: false, validateFormats: false })
  return validator.validate({ $schema: dump.$schema, $defs: dump.$defs, $ref: `#/$defs/${definition}` }, value)
}

describe('generateConfigSchema', () => {
  it('owns ordered composition, skipped-bundle diagnostics, and runtime resolution without mutating layers', async () => {
    profile.layers = [{ packageName: 'loaded', packageDir: dir, patchPaths: [join(dir, 'bundle.yml')], patches: [] }]
    profile.skippedBundles = [{ packageName: 'missing', reason: 'Error: cannot resolve profile bundle "missing"' }]
    modules.set('server', { Config: Schema.string() })
    const layers: PatchOptions[][] = [
      [{ insert: [{ ...row('cordis:group', []), id: 'group', group: true }] }],
      [{ id: 'group', insert: [row('server', 'configured')] }],
      [{ id: 'absent', config: {} }],
    ]
    const original = structuredClone(layers)
    const installAnchor = join(dir, 'installation.json')
    const resolve = vi.spyOn(profileOperations, 'createRuntimeResolution').mockResolvedValue(resolution)
    const result = await generateConfigSchema(profile, layers, installAnchor)
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ installAnchor, profile })
    expect(result['x-cordis'].entries.map(entry => [entry.path, entry.name])).toEqual([
      ['/0', 'cordis:group'], ['/0/config/0', 'server'],
    ])
    expect(result['x-cordis'].diagnostics).toEqual([
      { level: 'error', message: 'Selected profile bundle "missing" could not be loaded; repair or remove its bundle selection.' },
      { level: 'warning', message: 'patch: entry "absent" not found' },
    ])
    expect(result['x-cordis'].complete).toBe(false)
    expect(layers).toEqual(original)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('propagates resolution setup failure without starting collection', async () => {
    vi.spyOn(profileOperations, 'createRuntimeResolution').mockRejectedValue(new Error('resolution setup failed'))
    await expect(generateConfigSchema(profile, [], join(dir, 'installation.json'))).rejects.toThrow('resolution setup failed')
    expect(installRuntimeInterception).not.toHaveBeenCalled()
  })
})

describe('collectConfigSchemas', () => {
  it('serializes namespace and class Config exports, retaining descriptions, defaults, and shared refs', async () => {
    const port = Schema.number().default(3080).description('Listening port')
    const config = Schema.object({ port, anotherPort: port })
    const apply = vi.fn(() => { throw new Error('must not activate') })
    class Server {
      static Config = config
      constructor() { apply() }
    }
    modules.set('namespace', { Config: config, apply })
    modules.set('class', { default: Server, Config: Schema.never() })
    modules.set('interop', { default: { __esModule: true, default: { Config: config, apply } } })
    const result = await collectConfigSchemas(profile, [row('namespace'), row('class'), row('interop')], resolution)
    expect(result['x-cordis'].complete).toBe(true)
    expect(result['x-cordis'].diagnostics).toEqual([])
    expect(result['x-cordis'].entries.map(entry => entry.status)).toEqual(['schema', 'schema', 'schema'])
    const restored = schemaOf(result)
    expect(restored.properties!.port).toEqual(restored.properties!.anotherPort)
    expect(restored.properties!.port).toMatchObject({ default: 3080, description: 'Listening port' })
    expect(new Set(result['x-cordis'].entries.map(entry => entry.configRef)).size).toBe(1)
    expect(apply).not.toHaveBeenCalled()
    expect(importModule).toHaveBeenCalledWith('namespace', pathToFileURL(join(dir, 'cordis.yml')).href, {})
    expect(installRuntimeInterception).toHaveBeenCalledWith(resolution)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('includes anonymous, repeated, disabled, and conditional rows without reading their config values', async () => {
    const apply = vi.fn()
    modules.set('plugin', { Config: Schema.string(), apply })
    const rows = [
      { name: 'plugin', disabled: true, config: { secret: 'do-not-print' } },
      { id: 'same', name: 'plugin', disabled: { __jsExpr: 'throw new Error("do-not-evaluate")' } },
      { id: 'same', name: 'plugin', config: { __jsExpr: 'throw new Error("do-not-evaluate")' } },
    ] as EntryOptions[]
    const result = await collectConfigSchemas(profile, rows, resolution)
    expect(result['x-cordis'].entries.map(({ path, id }) => ({ path, id }))).toEqual([
      { path: '/0', id: undefined }, { path: '/1', id: 'same' }, { path: '/2', id: 'same' },
    ])
    expect(result['x-cordis'].entries[0]).not.toHaveProperty('id')
    expect(JSON.stringify(result)).not.toContain('do-not-')
    expect(apply).not.toHaveBeenCalled()
  })

  it('reports failed disabled declarations rather than equating discovery with bootability', async () => {
    const result = await collectConfigSchemas(profile, [
      { ...row('missing-disabled-plugin'), disabled: true },
      { ...row('cordis:include', { path: './missing.yml' }), disabled: true },
    ], resolution)
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].entries[0]!.status).toBe('error')
    expect(result['x-cordis'].diagnostics.map(item => item.path)).toEqual(['/0', '/1'])
    expect(importModule).toHaveBeenCalledWith('missing-disabled-plugin', pathToFileURL(join(dir, 'cordis.yml')).href, {})
  })

  it('records dormant carriers without config as childless trees and names a missing config otherwise', async () => {
    const result = await collectConfigSchemas(profile, [
      { ...row('cordis:group'), disabled: true },
      { ...row('cordis:include'), disabled: { __jsExpr: 'ctx.disabled' } },
      { ...row('cordis:group'), disabled: true, group: true },
      row('cordis:include'),
    ], resolution)
    expect(result['x-cordis'].entries.map(entry => entry.tree)).toEqual(['group', 'include', 'group', 'include'])
    expect(result['x-cordis'].diagnostics).toEqual([
      { level: 'error', path: '/2', message: 'entry list config is missing' },
      { level: 'error', path: '/3', message: 'include config is missing' },
    ])
  })

  it('distinguishes absent Config, unsupported validators, import failures, and Config getter failures', async () => {
    modules.set('null-config', { Config: null })
    modules.set('standard', { Config: { '~standard': { version: 1, vendor: 'other', validate: vi.fn() } } })
    modules.set('primitive', { Config: 1 })
    modules.set('no-serializer', { Config: { [Symbol.for('schemastery')]: true } })
    modules.set('getter', { get Config() { throw new Error('getter failed') } })
    modules.set('empty-module', null)
    const result = await collectConfigSchemas(profile, [
      row('noop'), row('null-config'), row('standard'), row('primitive'), row('no-serializer'),
      row('missing'), row('getter'), row('empty-module'), row('cordis:missing'),
    ], resolution)
    expect(result['x-cordis'].entries.map(entry => entry.status)).toEqual([
      'absent', 'absent', 'unsupported', 'unsupported', 'unsupported', 'error', 'error', 'absent', 'error',
    ])
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].diagnostics.map(diagnostic => diagnostic.path)).toEqual(['/2', '/3', '/4', '/5', '/6', '/8'])
    expect(result['x-cordis'].diagnostics.map(diagnostic => diagnostic.message)).toContain('getter failed')
  })

  it('retains recursive references and restores serialization state after a failing lazy schema', async () => {
    const recursive: Schema = Schema.lazy(() => Schema.object({ children: Schema.array(recursive) }))
    modules.set('recursive', { Config: recursive })
    modules.set('broken', { Config: Schema.lazy(() => { throw new Error('lazy failed') }) })
    modules.set('healthy', { Config: Schema.object({ value: Schema.string().required() }) })
    const before = Object.getOwnPropertyDescriptor(globalThis, '__schemastery_refs__')
    const result = await collectConfigSchemas(profile, [row('broken'), row('recursive'), row('healthy')], resolution)
    expect(result['x-cordis'].entries.map(entry => entry.status)).toEqual(['error', 'partial', 'schema'])
    expect(schemaOf(result, 1).$ref).toContain('Recursive')
    expect(schemaOf(result, 2).required).toEqual(['value'])
    expect(Object.getOwnPropertyDescriptor(globalThis, '__schemastery_refs__')).toEqual(before)
  })

  it('does not invoke native validation or UID serialization hooks', async () => {
    const config = Schema.object({ port: Schema.number().default(3080) })
    const serialize = vi.spyOn(config, 'toJSON').mockImplementation(() => { throw new Error('must not serialize') })
    const validate = vi.spyOn(Schema, 'resolve').mockImplementation(() => { throw new Error('must not validate') })
    modules.set('config', { Config: config })
    const result = await collectConfigSchemas(profile, [row('config')], resolution)
    expect(result['x-cordis'].complete).toBe(true)
    expect(serialize).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
  })

  it('reports non-Error lazy builder failures without losing other schemas', async () => {
    modules.set('broken', { Config: Schema.lazy(() => { throw 'plain failure' }) })
    const result = await collectConfigSchemas(profile, [row('broken'), row('noop')], resolution)
    expect(result['x-cordis'].diagnostics[0]!.message).toBe('plain failure')
    expect(result['x-cordis'].entries[1]!.status).toBe('absent')
  })

  it('walks native groups but not ordinary plugin config arrays', async () => {
    modules.set('group-package', { default: Group })
    const child = row('noop')
    const result = await collectConfigSchemas(profile, [
      row('cordis:group', [row('group-package', [child])]), row('noop', [row('missing')]),
    ], resolution)
    expect(result['x-cordis'].complete).toBe(true)
    expect(result['x-cordis'].entries.map(entry => entry.path)).toEqual(['/0', '/0/config/0', '/0/config/0/config/0', '/1'])
  })

  it('recognizes external canonical Include aliases and caches them per tree base', async () => {
    class ExternalInclude {
      static [EntryGroup.key] = true
      constructor() { throw new Error('must not activate Include') }
    }
    modules.set('@deepseek-ai/cordis-plugin-include', { default: ExternalInclude })
    modules.set('include-alias', { default: ExternalInclude })
    const result = await collectConfigSchemas(profile, [
      row('include-alias', { path: './missing.yml', initial: [row('noop')] }),
      row('include-alias', { path: './other.yml', initial: [row('noop')] }),
    ], resolution)
    expect(result['x-cordis'].complete).toBe(true)
    expect(result['x-cordis'].entries.filter(entry => entry.tree === 'include')).toHaveLength(2)
    expect(importModule.mock.calls.filter(([name]) => name === '@deepseek-ai/cordis-plugin-include')).toHaveLength(1)
    expect(importModule.mock.calls.filter(([name]) => name === '@deepseek-ai/cordis-plugin-group')).toHaveLength(1)
  })

  it('recognizes an external canonical Group even when Include cannot resolve', async () => {
    class ExternalGroup {
      static [EntryGroup.key] = true
      constructor() { throw new Error('must not activate Group') }
    }
    modules.set('@deepseek-ai/cordis-plugin-group', { default: ExternalGroup })
    modules.set('group-alias', { default: ExternalGroup })
    const result = await collectConfigSchemas(profile, [row('group-alias', [row('group-alias', [row('noop')])])], resolution)
    expect(result['x-cordis'].complete).toBe(true)
    expect(result['x-cordis'].entries.map(entry => entry.path)).toEqual(['/0', '/0/config/0', '/0/config/0/config/0'])
    expect(importModule.mock.calls.filter(([name]) => name === '@deepseek-ai/cordis-plugin-group')).toHaveLength(1)
  })

  it('reports unknown tree-carrier identities instead of silently omitting their children', async () => {
    modules.set('@deepseek-ai/cordis-plugin-group', { default: Group })
    modules.set('@deepseek-ai/cordis-plugin-include', { default: Include })
    modules.set('other-include', { default: class OtherInclude {
      static [EntryGroup.key] = true
      constructor() { throw new Error('must not activate a tree carrier') }
    } })
    const result = await collectConfigSchemas(profile, [row('other-include', {
      path: './unused.yml', initial: [row('noop')],
    })], resolution)
    expect(result['x-cordis'].entries).toMatchObject([{ path: '/0', id: 'other-include', name: 'other-include', status: 'absent' }])
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].diagnostics[0]!.message).toContain('unrecognized Loader tree carrier')
  })

  it('reads literal includes using their directory, applies patches, and keeps shared includes independent', async () => {
    const childDir = join(dir, 'child')
    mkdirSync(childDir)
    writeFileSync(join(childDir, 'list.yml'), '- id: a\n  name: noop\n')
    writeFileSync(join(dir, 'list.json'), JSON.stringify([row('cordis:include', { path: './child/list.yml' })]))
    modules.set('include-package', { default: Include })
    const result = await collectConfigSchemas(profile, [
      row('cordis:include', { path: './list.json' }),
      row('include-package', { path: './child/list.yml', patches: [
        { id: 'a', disabled: true }, { insert: [row('noop')] }, { id: 'unknown', disabled: true },
      ] }),
    ], resolution)
    expect(result['x-cordis'].complete).toBe(true)
    expect(result['x-cordis'].entries.map(entry => entry.path)).toEqual([
      '/0', '/0/include/0', '/0/include/0/include/0', '/1', '/1/include/0', '/1/include/1',
    ])
    expect(importModule).toHaveBeenCalledWith('noop', pathToFileURL(`${childDir}/`).href, {})
    expect(result['x-cordis'].diagnostics).toEqual([{ level: 'warning', path: '/1', message: 'patch: entry "unknown" not found' }])
  })

  it('expands initial entries in memory without writing missing include files', async () => {
    const result = await collectConfigSchemas(profile, [row('cordis:include', {
      path: './missing.yml', initial: [row('noop')], patches: [{ insert: [row('noop')] }],
    })], resolution)
    expect(result['x-cordis'].complete).toBe(true)
    expect(result['x-cordis'].entries).toHaveLength(3)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir, 'missing.yml'))).toBe(false)
  })

  it('reports cycles, missing files, and malformed documents without losing subsequent entries', async () => {
    writeFileSync(join(dir, 'cycle.yml'), '- name: cordis:include\n  config:\n    path: ./cycle.yml\n')
    writeFileSync(join(dir, 'bad.yml'), '[')
    writeFileSync(join(dir, 'object.json'), '{}')
    const result = await collectConfigSchemas(profile, [
      row('cordis:include', { path: './cycle.yml' }),
      row('cordis:include', { path: './missing.yml' }),
      row('cordis:include', { path: './bad.yml', initial: [row('noop')] }),
      row('cordis:include', { path: './object.json' }), row('noop'),
    ], resolution)
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].entries.at(-1)!.name).toBe('noop')
    expect(result['x-cordis'].diagnostics.map(diagnostic => diagnostic.path)).toEqual(['/0/include/0', '/1', '/2', '/3'])
    expect(result['x-cordis'].diagnostics[0]!.message).toContain('include cycle')
    expect(result['x-cordis'].diagnostics[1]!.message).toContain('include file not found')
  })

  it.each([
    ['yaml', '- name: noop\n  config:\n    secret: PRIVATE_CONFIG_SECRET\n    broken: ['],
    ['json', '[{"name":"noop","config":{"secret":"PRIVATE_CONFIG_SECRET" broken}}]'],
  ])('omits configuration snippets from invalid %s include diagnostics', async (extension, content) => {
    writeFileSync(join(dir, `invalid.${extension}`), content)
    const result = await collectConfigSchemas(profile, [row('cordis:include', { path: `./invalid.${extension}` })], resolution)
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].diagnostics[0]!.message).toContain('invalid')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CONFIG_SECRET')
  })

  it.each(['realpath', 'readFile'] as const)('preserves non-missing include %s failures instead of using initial', async (operation) => {
    vi.spyOn(fs, operation).mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
    const result = await collectConfigSchemas(profile, [row('cordis:include', {
      path: './missing.yml', initial: [row('noop')],
    })], resolution)
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].entries).toHaveLength(1)
    expect(result['x-cordis'].diagnostics[0]!.message).toBe('access denied')
  })

  it('detects include cycles through directory symlinks', async () => {
    symlinkSync(dir, join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(dir, 'cycle.yml'), '- name: cordis:include\n  config:\n    path: ./alias/cycle.yml\n')
    const result = await collectConfigSchemas(profile, [row('cordis:include', { path: './cycle.yml' })], resolution)
    expect(result['x-cordis'].diagnostics[0]!.message).toContain('include cycle')
    expect(result['x-cordis'].entries).toHaveLength(2)
  })

  it.each([
    undefined,
    { __jsExpr: 'throw new Error("never")' },
    { path: { __jsExpr: 'throw new Error("never")' } },
    { path: './config.js' },
    { path: './missing.yml', initial: { __jsExpr: 'throw new Error("never")' } },
    { path: './missing.yml', initial: [row('noop')], patches: { __jsExpr: 'never' } },
    { path: './missing.yml', initial: [row('noop')], patches: [{ __jsExpr: 'never' }] },
  ])('marks a nonliteral or unsupported include incomplete: %j', async (config) => {
    const result = await collectConfigSchemas(profile, [row('cordis:include', config)], resolution)
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].entries).toHaveLength(1)
    expect(result['x-cordis'].diagnostics).toHaveLength(1)
  })

  it.each([
    { id: { __jsExpr: 'PRIVATE_EXPRESSION' }, disabled: true },
    { name: { __jsExpr: 'PRIVATE_EXPRESSION' }, id: 'noop' },
    { id: 'noop', group: { __jsExpr: 'PRIVATE_EXPRESSION' } },
    { insert: { __jsExpr: 'PRIVATE_EXPRESSION' } },
    { insert: [{ name: 'noop', id: { __jsExpr: 'PRIVATE_EXPRESSION' } }] },
    { insert: [{ name: 'noop', group: { __jsExpr: 'PRIVATE_EXPRESSION' } }] },
  ])('rejects dynamic include patch structure without printing its expression: %j', async (patch) => {
    const result = await collectConfigSchemas(profile, [row('cordis:include', {
      path: './missing.yml', initial: [row('noop')], patches: [patch],
    })], resolution)
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].diagnostics).toHaveLength(1)
    expect(result['x-cordis'].diagnostics[0]!.level).toBe('error')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_EXPRESSION')
  })

  it('preserves null group overrides and disabled/config expressions in include patches', async () => {
    const result = await collectConfigSchemas(profile, [row('cordis:include', {
      path: './missing.yml', initial: [row('noop')], patches: [{
        id: 'noop', group: null, config: { __jsExpr: 'never' }, disabled: { __jsExpr: 'never' },
      }],
    })], resolution)
    expect(result['x-cordis'].complete).toBe(true)
    expect(result['x-cordis'].entries).toHaveLength(2)
    expect(result['x-cordis'].diagnostics).toEqual([])
  })

  it('rejects malformed and dynamic child groups', async () => {
    const result = await collectConfigSchemas(profile, [
      row('cordis:group', { __jsExpr: 'never' }), row('cordis:group', [{ name: 3 }]),
    ], resolution)
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].diagnostics.map(diagnostic => diagnostic.path)).toEqual(['/0', '/1/config/0'])
  })

  it('keeps valid siblings and original positions when composed rows are malformed', async () => {
    modules.set('good', { Config: Schema.number() })
    const result = await collectConfigSchemas(profile, [
      row('good'), {}, { name: 17 }, null, { id: 'bad', name: 'noop', group: 'invalid' }, row('good'),
    ], resolution)
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].entries.map(entry => [entry.path, entry.status])).toEqual([
      ['/0', 'schema'], ['/1', 'error'], ['/2', 'error'], ['/3', 'error'], ['/4', 'error'], ['/5', 'schema'],
    ])
    expect(result['x-cordis'].entries[1]).not.toHaveProperty('name')
    expect(result['x-cordis'].entries[2]).not.toHaveProperty('name')
    expect(result['x-cordis'].entries[0]!.configRef).toBe(result['x-cordis'].entries[5]!.configRef)
    expect(importModule).toHaveBeenCalledTimes(2)
    expect(validates(result, [{ name: 'good', config: 3 }])).toBe(true)
  })

  it('keeps healthy group and include siblings after malformed child rows', async () => {
    modules.set('good', { Config: Schema.string() })
    const result = await collectConfigSchemas(profile, [
      row('cordis:group', [{ name: false }, row('good')]),
      row('cordis:include', { path: './missing.yml', initial: [null, row('good')] }),
    ], resolution)
    expect(result['x-cordis'].diagnostics.map(item => item.path)).toEqual(['/0/config/0', '/1/include/0'])
    expect(result['x-cordis'].entries.filter(entry => entry.status === 'schema').map(entry => entry.path))
      .toEqual(['/0/config/1', '/1/include/1'])
  })

  it.each([
    { initial: [null, row('noop')], patches: [{ id: 'noop', disabled: true }] },
    { initial: [], patches: [{ insert: [null] }] },
    { initial: [{ ...row('cordis:group', [null]), group: true }], patches: [{ id: 'noop', disabled: true }] },
  ])('reports unavailable include children when composition fails', async (config) => {
    const result = await collectConfigSchemas(profile, [row('cordis:include', { path: './missing.yml', ...config }), row('noop')], resolution)
    expect(result['x-cordis'].entries.map(entry => entry.path)).toEqual(['/0', '/1'])
    expect(result['x-cordis'].diagnostics).toHaveLength(1)
    expect(result['x-cordis'].diagnostics[0]).toMatchObject({ level: 'error', path: '/0' })
    expect(result['x-cordis'].diagnostics[0]?.message).toContain('child declarations are unavailable')
    expect(result['x-cordis'].complete).toBe(false)
  })

  it('does not validate contents of an insertion that Loader skips', async () => {
    const result = await collectConfigSchemas(profile, [row('cordis:include', {
      path: './missing.yml', initial: [row('noop')], patches: [{ id: 'missing', insert: [null] }, { config: {} }],
    })], resolution)
    expect(result['x-cordis'].entries.map(entry => entry.path)).toEqual(['/0', '/0/include/0'])
    expect(result['x-cordis'].complete).toBe(true)
    expect(result['x-cordis'].diagnostics.every(item => item.level === 'warning')).toBe(true)
    for (const definition of ['patchList', 'includePatch']) {
      for (const value of [{}, { config: {} }, { id: '', config: {} }]) {
        expect(validates(result, definition === 'patchList' ? [value] : value, definition)).toBe(true)
      }
    }
  })

  it('allows disabled config omission without disabling group:true or supplied-config validation', async () => {
    modules.set('required', { Config: Schema.string().required() })
    const result = await collectConfigSchemas(profile, [row('required')], resolution)
    for (const name of ['required', 'cordis:group', 'cordis:include']) {
      expect(validates(result, [{ name, disabled: true }])).toBe(true)
      expect(validates(result, [{ name, disabled: { __jsExpr: 'ctx.disabled' } }])).toBe(true)
      for (const disabled of [false, null, undefined]) expect(validates(result, [{ name, disabled }])).toBe(false)
      expect(validates(result, [{ name, disabled: true, group: true }])).toBe(false)
    }
    expect(validates(result, [{ name: 'required', disabled: true, config: 3 }])).toBe(false)
    const children = [{ name: 'required' }]
    expect(validates(result, [{ name: 'cordis:group', config: children }])).toBe(false)
    expect(validates(result, [{ name: 'cordis:group', disabled: true, config: children }])).toBe(true)
    expect(validates(result, [{ name: 'cordis:group', disabled: true, group: true, config: children }])).toBe(false)
    expect(validates(result, [{ name: 'cordis:include', config: { path: './plugins.yml', initial: children } }])).toBe(false)
    expect(validates(result, [{ name: 'cordis:include', disabled: { __jsExpr: 'ctx.disabled' }, config: { path: './plugins.yml', initial: children } }])).toBe(true)
  })

  it('repeats projection limitations for every entry sharing a partial Config', async () => {
    modules.set('partial', { Config: Schema.transform(Schema.string(), value => value) })
    const result = await collectConfigSchemas(profile, [row('partial'), row('noop'), { ...row('partial'), id: 'again' }], resolution)
    expect(result['x-cordis'].entries.map(entry => entry.status)).toEqual(['partial', 'absent', 'partial'])
    expect(result['x-cordis'].diagnostics.map(item => item.path)).toEqual(['/0', '/2'])
    expect(new Set(result['x-cordis'].diagnostics.map(item => item.message)).size).toBe(1)
  })

  it('does not retain a stale patch constraint after an invalid duplicate-id row', async () => {
    modules.set('good', { Config: Schema.number() })
    const result = await collectConfigSchemas(profile, [{ ...row('good'), id: 'same' }, { id: 'same', name: 17 }], resolution)
    expect(result['x-cordis'].complete).toBe(false)
    expect(validates(result, [{ id: 'same', config: 'unknown' }], 'patchList')).toBe(true)
    const unnamed: CollectedConfigEntry = { path: '/0', id: 'bad', status: 'error' }
    const document = await buildConfigSchemaDocument('test', [unnamed], new Map([['bad', unnamed]]), [])
    expect(validates(document, [{ id: 'bad', config: 'unknown' }], 'patchList')).toBe(true)
  })

  it('validates known entry Config and whole-config patches while keeping metadata-only patches valid', async () => {
    modules.set('server', { Config: Schema.object({ port: Schema.number().required() }) })
    const result = await collectConfigSchemas(profile, [row('server')], resolution)
    expect(validates(result, [{ name: 'server', config: { port: 8080 }, extra: 'metadata' }])).toBe(true)
    expect(validates(result, [{ name: 'server' }])).toBe(false)
    expect(validates(result, [{ name: 'server', config: { port: 'wrong' } }])).toBe(false)
    expect(validates(result, [{ name: 'new-plugin', config: { arbitrary: true } }])).toBe(true)
    expect(validates(result, [{ id: 'server', disabled: true }], 'patchList')).toBe(true)
    expect(validates(result, [{ id: 'server', config: { port: 'wrong' } }], 'patchList')).toBe(false)
    expect(validates(result, [{ id: 'server', config: {} }], 'patchList')).toBe(false)
    expect(validates(result, [{ id: 'server', name: 'not-server', config: 'ignored' }], 'patchList')).toBe(true)
    expect(validates(result, [{ config: {} }], 'patchList')).toBe(true)
    expect(validates(result, [{ id: 'new-id', config: {} }], 'patchList')).toBe(true)
  })

  it('describes Loader metadata and anonymous insertion separately from config replacement', async () => {
    modules.set('server', { Config: Schema.object({ port: Schema.number().required() }) })
    const result = await collectConfigSchemas(profile, [{ ...row('cordis:group', [row('server')]), id: 'group', group: true }], resolution)
    expect(validates(result, [{ id: 'group', insert: [{ name: 'server', config: { port: 8080 } }] }], 'patchList')).toBe(true)
    expect(validates(result, [{ id: 'group', config: { __jsExpr: 'not a literal group' } }], 'patchList')).toBe(false)
    expect(validates(result, [{ name: 'server', config: { port: 8080 }, inject: { tools: { required: false } }, isolate: { tools: true, llm: 'shared' }, intercept: null }])).toBe(true)
    expect(validates(result, [{ name: 'server', config: { port: 8080 }, isolate: { tools: false } }])).toBe(false)
    expect(validates(result, [{ name: 'server', config: { port: 8080 }, inject: 1 }])).toBe(false)
    expect(validates(result, [{ name: 'server', config: { port: 8080 }, id: { __jsExpr: 'not literal' } }])).toBe(false)
  })

  it('allows config and disabled expressions but keeps Include and Group containers literal', async () => {
    modules.set('server', { Config: Schema.object({ ports: Schema.array(Number).required() }) })
    const result = await collectConfigSchemas(profile, [row('server')], resolution)
    expect(validates(result, [{ name: 'server', config: { ports: [{ __jsExpr: 'ctx.port' }] }, disabled: { __jsExpr: 'ctx.disabled' } }])).toBe(true)
    expect(validates(result, [{ name: 'server', config: { __jsExpr: 'ctx.config' } }])).toBe(true)
    expect(validates(result, [{ name: 'cordis:group', config: { __jsExpr: 'ctx.entries' } }])).toBe(false)
    expect(validates(result, [{ name: 'cordis:include', config: { path: { __jsExpr: 'ctx.path' } } }])).toBe(false)
    expect(validates(result, [{ name: 'cordis:include', config: { path: './plugins.yml', initial: [{ name: 'server', config: { __jsExpr: 'ctx.config' } }] } }])).toBe(true)
  })

  it('uses last root-tree ids without importing include-local ids into overlay targeting', async () => {
    modules.set('number', { Config: Schema.number() })
    modules.set('string', { Config: Schema.string() })
    modules.set('boolean', { Config: Schema.boolean() })
    writeFileSync(join(dir, 'local.json'), JSON.stringify([{ ...row('boolean'), id: 'same' }]))
    const result = await collectConfigSchemas(profile, [
      { ...row('number'), id: 'same' }, { ...row('string'), id: 'same' },
      row('cordis:include', { path: './local.json' }),
    ], resolution)
    expect(validates(result, [{ id: 'same', config: 'value' }], 'patchList')).toBe(true)
    expect(validates(result, [{ id: 'same', config: true }], 'patchList')).toBe(false)
    expect(validates(result, [{ id: 'same', config: 3 }], 'patchList')).toBe(false)
    expect(validates(result, [{ id: 'same', config: true }], 'includePatch')).toBe(false)
    expect(validates(result, { id: 'same', config: true }, 'includePatch')).toBe(true)
  })

  it('does not keep stale target constraints when an unmounted group-metadata child replaces an indexed id', async () => {
    modules.set('number', { Config: Schema.number() })
    const result = await collectConfigSchemas(profile, [
      { ...row('number'), id: 'same' }, { ...row('noop', [{ ...row('noop'), id: 'same' }]), group: true },
    ], resolution)
    expect(validates(result, [{ id: 'same', config: 'not-number' }], 'patchList')).toBe(true)
  })

  it('keeps different resolutions of one plugin name explicit instead of selecting one arbitrarily', async () => {
    const result = await buildConfigSchemaDocument('test', [
      { path: '/0', name: './plugin.js', status: 'schema', native: Schema.number() },
      { path: '/1/include/0', name: './plugin.js', status: 'schema', native: Schema.string() },
    ], new Map(), [])
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].entries[0]!.configRef).not.toBe(result['x-cordis'].entries[1]!.configRef)
    expect(validates(result, [{ name: './plugin.js', config: 3 }])).toBe(true)
    expect(validates(result, [{ name: './plugin.js', config: 'value' }])).toBe(true)
    expect(validates(result, [{ name: './plugin.js', config: true }])).toBe(false)
    expect(result['x-cordis'].diagnostics[0]!.message).toContain('multiple collected schemas')
  })

  it.each(['unsupported', 'error'] as const)('keeps an %s alternate resolution open without weakening a known patch target', async (status) => {
    const known: CollectedConfigEntry = { path: '/0', id: 'known', name: './plugin.js', status: 'schema', native: Schema.number() }
    const other: CollectedConfigEntry = { path: '/1/include/0', name: './plugin.js', status }
    const result = await buildConfigSchemaDocument('test', [known, other], new Map([['known', known]]), [])
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].entries[1]!.configRef).toBe('#/$defs/unknownConfig')
    expect(validates(result, [{ name: './plugin.js', config: 'value' }])).toBe(true)
    expect(validates(result, [{ id: 'known', config: 'value' }], 'patchList')).toBe(false)
    expect(result['x-cordis'].diagnostics.some(item => item.message.includes('multiple collected schemas'))).toBe(true)
  })

  it('uses an unknown schema for an indexed target without a collected declaration', async () => {
    const missing: CollectedConfigEntry = { path: '/0', id: 'missing', name: 'missing', status: 'error' }
    const result = await buildConfigSchemaDocument('test', [], new Map([['missing', missing]]), [])
    expect(validates(result, [{ id: 'missing', config: 'value' }], 'patchList')).toBe(true)
  })

  it('includes caller composition diagnostics without mutating them', async () => {
    const diagnostics = [
      { level: 'error' as const, message: 'bundle could not be loaded' },
      { level: 'warning' as const, message: 'overlay target was not found' },
    ]
    const result = await collectConfigSchemas(profile, [row('noop')], resolution, diagnostics)
    expect(result['x-cordis'].complete).toBe(false)
    expect(result['x-cordis'].diagnostics).toEqual(diagnostics)
    expect(result['x-cordis'].diagnostics).not.toBe(diagnostics)
  })

  it('releases interception when the Node module loader is unavailable', async () => {
    vi.mocked(ModuleLoader.fromInternal).mockReturnValue(undefined)
    await expect(collectConfigSchemas(profile, [], resolution)).rejects.toThrow('requires the Node module loader')
    expect(dispose).toHaveBeenCalledOnce()
  })
})

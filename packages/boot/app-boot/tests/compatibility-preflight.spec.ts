/** Admission of profile composition rows before the Loader imports any plugin code. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  PROFILE_COMPATIBILITY_FILENAME, PluginPackages, boot, getDshRuntimeVersion,
  prepareProfileEntries, prepareProfilePatches, type ProfileContext,
} from '../src/index.ts'

const runtime = getDshRuntimeVersion()

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-preflight-'))
  let ctx: Context | undefined
  onTestFinished(async () => {
    try { await ctx?.fiber.dispose() } finally { rmSync(temporary, { recursive: true, force: true }) }
  })
  const dir = realpathSync(temporary)
  const effects = join(dir, 'effects')
  const warnings: string[] = []
  // Admission diagnostics precede the composed tree, so stderr is the channel under test.
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    warnings.push(String(chunk))
    return true
  })
  onTestFinished(() => { stderr.mockRestore() })

  function plugin(name: string, options: { version?: string; peer?: string; alias?: string } = {}): void {
    const packageDir = join(dir, 'node_modules', options.alias ?? name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name, version: options.version ?? '1.0.0', type: 'module', exports: './index.mjs',
      ...options.peer === undefined ? {} : { peerDependencies: { '@deepseek-ai/dsh-test': options.peer } },
    }))
    writeFileSync(join(packageDir, 'index.mjs'), `import { appendFileSync } from 'node:fs'
const record = (value) => appendFileSync(new URL('${pathToFileURL(effects).href}'), value + '\\n')
record('import:${name}')
export function apply() { record('apply:${name}') }
`)
  }

  function exemptions(value: Record<string, string[]>): void {
    writeFileSync(join(dir, PROFILE_COMPATIBILITY_FILENAME), JSON.stringify(value))
  }

  const profile: ProfileContext = {
    name: 'preflight', dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(dir, 'package.json'), cwd: dir, home: dir,
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, '[]\n')
  exemptions({})

  /** Boot the profile with these patches and return the recorded plugin effects. */
  async function run(patches: PatchOptions[], packages = false): Promise<string[]> {
    ctx = await boot('preflight', configPath, patches, async (host) => {
      host.provide('profileContext', profile)
      if (packages) await host.plugin(PluginPackages)
      host.logger.exporter({ levels: { default: 3 }, export(message) {
        if (message.type === 'warn' || message.type === 'error') warnings.push(String(message.args[0]))
      } })
    })
    return existsSync(effects) ? readFileSync(effects, 'utf8').trim().split('\n') : []
  }

  return { dir, profile, configPath, warnings, plugin, exemptions, run }
}

const insert = (...names: string[]) => [{ insert: names.map((name, index) => ({ id: `row-${String(index)}`, name })) }]

it('blocks an incompatible plugin before its module is imported while a compatible sibling loads', async () => {
  const f = fixture()
  f.plugin('denied-plugin', { peer: '^9.0.0' })
  f.plugin('allowed-plugin')
  const effects = await f.run(insert('allowed-plugin', 'denied-plugin'))
  expect(effects).toEqual(['import:allowed-plugin', 'apply:allowed-plugin'])
  expect(f.warnings.join('\n')).toContain('denied-plugin@1.0.0')
  expect(f.warnings.join('\n')).toContain('data loss')
})

it('admits the same plugin only for its exact version and the running runtime', async () => {
  const granted = fixture()
  granted.plugin('denied-plugin', { peer: '^9.0.0' })
  granted.exemptions({ 'denied-plugin@1.0.0': [runtime] })
  expect(await granted.run(insert('denied-plugin'))).toEqual(['import:denied-plugin', 'apply:denied-plugin'])

  const otherVersion = fixture()
  otherVersion.plugin('denied-plugin', { version: '2.0.0', peer: '^9.0.0' })
  otherVersion.exemptions({ 'denied-plugin@1.0.0': [runtime] })
  expect(await otherVersion.run(insert('denied-plugin'))).toEqual([])

  const otherRuntime = fixture()
  otherRuntime.plugin('denied-plugin', { peer: '^9.0.0' })
  otherRuntime.exemptions({ 'denied-plugin@1.0.0': ['9.9.9'] })
  expect(await otherRuntime.run(insert('denied-plugin'))).toEqual([])
})

const denialSpecifiers: Array<[string, (name: string, dir: string) => string]> = [
  ['a package name', () => 'denied-plugin'],
  ['a relative module', () => './node_modules/denied-plugin/index.mjs'],
  ['an absolute module', (name, dir) => join(dir, 'node_modules', name, 'index.mjs')],
  ['a file URL', (name, dir) => pathToFileURL(join(dir, 'node_modules', name, 'index.mjs')).href],
]

it.each(denialSpecifiers)('blocks an incompatible %s before import', async (_label, specifier) => {
  const f = fixture()
  f.plugin('denied-plugin', { peer: '^9.0.0' })
  expect(await f.run(insert(specifier('denied-plugin', f.dir)))).toEqual([])
})

it('blocks a denied plugin reached through a package-imports alias', async () => {
  const f = fixture()
  const aliased = join(f.dir, 'aliased')
  mkdirSync(aliased)
  writeFileSync(join(aliased, 'package.json'), JSON.stringify({
    name: 'denied-plugin', version: '1.0.0', type: 'module', exports: './index.mjs',
    peerDependencies: { '@deepseek-ai/dsh-test': '^9.0.0' },
  }))
  writeFileSync(join(aliased, 'index.mjs'), `import { appendFileSync } from 'node:fs'
appendFileSync(new URL('${pathToFileURL(join(f.dir, 'effects')).href}'), 'import:denied-plugin\\n')
export function apply() {}
`)
  writeFileSync(join(f.dir, 'package.json'), JSON.stringify({
    name: 'preflight-profile', private: true, type: 'module',
    imports: { '#denied': './aliased/index.mjs' },
  }))
  expect(await f.run(insert('#denied'))).toEqual([])
  expect(f.warnings.join('\n')).toContain('denied-plugin@1.0.0')
})

it('blocks an incompatible descendant of a native group while its compatible sibling loads', async () => {
  const f = fixture()
  f.plugin('denied-plugin', { peer: '^9.0.0' })
  f.plugin('allowed-plugin')
  const effects = await f.run([{ insert: [{ id: 'group', name: 'cordis:group', group: true, config: [
    { id: 'allowed', name: 'allowed-plugin' },
    { id: 'denied', name: 'denied-plugin' },
  ] }] }])
  expect(effects).toEqual(['import:allowed-plugin', 'apply:allowed-plugin'])
})

it('omits a native Include that reaches an incompatible plugin and keeps an unrelated Include', async () => {
  const f = fixture()
  f.plugin('denied-plugin', { peer: '^9.0.0' })
  f.plugin('allowed-plugin')
  const deniedList = join(f.dir, 'denied.cordis.yml')
  const allowedList = join(f.dir, 'allowed.cordis.yml')
  writeFileSync(deniedList, JSON.stringify([{ id: 'denied', name: 'denied-plugin' }]))
  writeFileSync(allowedList, JSON.stringify([{ id: 'allowed', name: 'allowed-plugin' }]))
  const effects = await f.run([{ insert: [
    { id: 'denied-include', name: 'cordis:include', config: { path: pathToFileURL(deniedList).href } },
    { id: 'allowed-include', name: 'cordis:include', config: { path: pathToFileURL(allowedList).href } },
  ] }])
  expect(effects).toEqual(['import:allowed-plugin', 'apply:allowed-plugin'])
  expect(f.warnings.join('\n')).toContain('never rewritten')
})

it('leaves an unresolvable row to the Loader instead of denying it', async () => {
  const f = fixture()
  expect(await f.run(insert('./missing.mjs'))).toEqual([])
  expect(f.warnings.join('\n')).toContain('missing.mjs')
  expect(f.warnings.join('\n')).not.toContain('disabled:')
})

it('denies a row whose peer metadata cannot be validated', async () => {
  const f = fixture()
  f.plugin('malformed-plugin')
  writeFileSync(join(f.dir, 'node_modules', 'malformed-plugin', 'package.json'),
    JSON.stringify({ name: 'malformed-plugin', version: '1.0.0', peerDependencies: ['@deepseek-ai/dsh'] }))
  expect(await f.run(insert('malformed-plugin'))).toEqual([])
  expect(f.warnings.join('\n')).toContain('cannot be validated')
})

it('leaves an explicitly disabled row and a non-profile composition untouched', async () => {
  const f = fixture()
  f.plugin('denied-plugin', { peer: '^9.0.0' })
  expect(await f.run([{ insert: [{ id: 'off', name: 'denied-plugin', disabled: true }] }])).toEqual([])

  const unrelated = new Context()
  onTestFinished(() => unrelated.fiber.dispose())
  const rows = [{ id: 'row', name: 'denied-plugin' }]
  expect(prepareProfileEntries(unrelated, rows, f.dir)).toEqual(rows)
})

it('reports a rejected record while the records it accepted still apply', async () => {
  const f = fixture()
  f.plugin('denied-plugin', { peer: '^9.0.0' })
  f.plugin('allowed-plugin')
  writeFileSync(join(f.dir, PROFILE_COMPATIBILITY_FILENAME),
    JSON.stringify({ 'denied-plugin@1.0.0': [runtime], 'broken@*': [runtime] }))
  // The accepted grant still admits its plugin; only the broken record is reported and dropped.
  expect((await f.run(insert('allowed-plugin', 'denied-plugin'))).sort())
    .toEqual(['apply:allowed-plugin', 'apply:denied-plugin', 'import:allowed-plugin', 'import:denied-plugin'])
  expect(f.warnings.join('\n')).toContain('is not an exact package-name@version key')
})

it('starts with no exemptions and a warning when the permission file is unparsable', async () => {
  const f = fixture()
  f.plugin('denied-plugin', { peer: '^9.0.0' })
  writeFileSync(join(f.dir, PROFILE_COMPATIBILITY_FILENAME), '{ not json')
  expect(await f.run(insert('denied-plugin'))).toEqual([])
  expect(f.warnings.join('\n')).toContain('is not valid JSON')
  expect(f.warnings.join('\n')).toContain('is incompatible with dsh')
})

describe('manifest resolution', () => {
  function context(f: ReturnType<typeof fixture>): Context {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('profileContext', f.profile)
    return ctx
  }

  it('leaves rows with no resolvable manifest to the Loader', () => {
    const f = fixture()
    writeFileSync(join(f.dir, 'standalone.mjs'), 'export function apply() {}\n')
    const rows = [
      { id: 'outside', name: './standalone.mjs' },
      { id: 'builtin', name: 'node:fs' },
      { id: 'missing', name: 'missing-package' },
    ]
    expect(prepareProfileEntries(context(f), rows, pathToFileURL(f.dir).href + '/')).toEqual(rows)
  })

  it('denies through the mounted package service when the launcher supplies one', async () => {
    const f = fixture()
    f.plugin('denied-plugin', { peer: '^9.0.0' })
    expect(await f.run(insert('denied-plugin'), true)).toEqual([])
    expect(f.warnings.join('\n')).toContain('denied-plugin@1.0.0')
  })

  it('stops at a recursive Include instead of recursing forever', () => {
    const f = fixture()
    const inner = join(f.dir, 'inner.cordis.yml')
    const outer = join(f.dir, 'outer.cordis.yml')
    writeFileSync(inner, `- id: nested\n  name: cordis:include\n  config: { path: ${JSON.stringify(outer)} }\n`)
    writeFileSync(outer, `- id: outer\n  name: cordis:include\n  config: { path: ${JSON.stringify(inner)} }\n`)
    const rows = prepareProfileEntries(context(f), [{ id: 'cycle', name: 'cordis:include', config: { path: inner } }],
      pathToFileURL(f.dir).href + '/')
    expect(rows[0]?.disabled).toBeUndefined()
  })

  it('leaves an Include whose file is not an entry list undecided', () => {
    const f = fixture()
    const mapping = join(f.dir, 'mapping.cordis.yml')
    writeFileSync(mapping, 'id: nested\nname: denied-plugin\n')
    const rows = prepareProfileEntries(context(f), [{ id: 'row', name: 'cordis:include', config: { path: mapping } }],
      pathToFileURL(f.dir).href + '/')
    expect(rows[0]?.disabled).toBeUndefined()
  })

  it('warns about ignored patches while the included rows still decide', () => {
    const f = fixture()
    f.plugin('allowed-plugin')
    const list = join(f.dir, 'patched.cordis.yml')
    writeFileSync(list, '- id: nested\n  name: allowed-plugin\n')
    const ctx = context(f)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    const rows = prepareProfileEntries(ctx, [{ id: 'outer', name: 'cordis:include',
      config: { path: list, patches: [{ id: 'absent', disabled: true }] } }], pathToFileURL(f.dir).href + '/')
    expect(rows[0]?.disabled).toBeUndefined()
    expect(warn.mock.calls.flat().map(String).join(' ')).toContain('absent')
  })

  it.each([
    ['an unreadable manifest', (f: ReturnType<typeof fixture>) => {
      f.plugin('denied-plugin')
      rmSync(join(f.dir, 'node_modules', 'denied-plugin', 'package.json'))
      mkdirSync(join(f.dir, 'node_modules', 'denied-plugin', 'package.json'))
    }],
    ['a module path that loops', (f: ReturnType<typeof fixture>) => {
      f.plugin('denied-plugin')
      symlinkSync('loop.mjs', join(f.dir, 'node_modules', 'denied-plugin', 'loop.mjs'))
    }],
  ])('refuses a row whose %s cannot be read', (_label, prepare) => {
    const f = fixture()
    prepare(f)
    const name = _label === 'a module path that loops'
      ? './node_modules/denied-plugin/loop.mjs' : './node_modules/denied-plugin/index.mjs'
    const rows = prepareProfileEntries(context(f), [{ id: 'row', name }], pathToFileURL(f.dir).href + '/')
    expect(rows[0]?.disabled).toBe(true)
    expect(f.warnings.join('\n')).toContain('cannot be validated')
  })

  it('labels a denied row by its id, or by its module when a preset row omits the id', () => {
    const f = fixture()
    f.plugin('denied-plugin', { peer: '^9.0.0' })
    const base = pathToFileURL(f.dir).href + '/'
    prepareProfileEntries(context(f), [{ id: 'row', name: './node_modules/denied-plugin/index.mjs' }], base)
    // A preset declaration may omit the id that the Loader type requires.
    prepareProfileEntries(context(f), [{ name: 'denied-plugin' } as EntryOptions], base)
    expect(f.warnings).toEqual([
      expect.stringMatching(/^dsh: disabling profile plugin row "row": Plugin denied-plugin@1\.0\.0 /),
      expect.stringMatching(/^dsh: disabling profile plugin denied-plugin: Plugin denied-plugin@1\.0\.0 /),
    ])
  })

  it('denies a group-shaped row and clears its group flag', () => {
    const f = fixture()
    f.plugin('denied-plugin', { peer: '^9.0.0' })
    const rows = prepareProfileEntries(context(f), [{ id: 'row', name: 'denied-plugin', group: true, config: [] }],
      pathToFileURL(f.dir).href + '/')
    expect(rows[0]).toMatchObject({ disabled: true, group: false })
  })

  it('ignores a native Include whose path is not a literal YAML or JSON file', () => {
    const f = fixture()
    const ctx = context(f)
    for (const config of [undefined, { path: 7 }, { path: './plugin.mjs' }]) {
      expect(prepareProfileEntries(ctx, [{ id: 'row', name: 'cordis:include', config }],
        pathToFileURL(f.dir).href + '/')).toEqual([{ id: 'row', name: 'cordis:include', config }])
    }
  })

  it('ignores an absent literal Include without initial entries and reads them when provided', () => {
    const f = fixture()
    f.plugin('denied-plugin', { peer: '^9.0.0' })
    const ctx = context(f)
    const base = pathToFileURL(f.dir).href + '/'
    const missing = join(f.dir, 'missing.cordis.yml')
    expect(prepareProfileEntries(ctx, [{ id: 'row', name: 'cordis:include', config: { path: missing } }], base))
      .toEqual([{ id: 'row', name: 'cordis:include', config: { path: missing } }])
    const rows = prepareProfileEntries(ctx, [{ id: 'row', name: 'cordis:include',
      config: { path: missing, initial: [{ id: 'denied', name: 'denied-plugin' }] } }], base)
    expect(rows[0]?.disabled).toBe(true)
    expect(f.warnings.join('\n')).toContain('never rewritten')
  })

  it('returns no patches for a profile whose composition has no rows and warns about an unmatched patch', () => {
    const f = fixture()
    const ctx = context(f)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    const base = pathToFileURL(f.dir).href + '/'
    expect(prepareProfilePatches(ctx, [], base)).toEqual([])
    expect(prepareProfilePatches(ctx, [{ id: 'absent', disabled: true }], base)).toEqual([])
    expect(warn.mock.calls.flat().map(String).join(' ')).toContain('absent')
  })

  it('requires a resolution base for a profile composition', () => {
    const f = fixture()
    expect(() => { prepareProfileEntries(context(f), [{ id: 'row', name: 'allowed-plugin' }], undefined) })
      .toThrow('requires a resolution base')
  })

})

it('reuses the documented literal Include dialect when reading included entries', async () => {
  const f = fixture()
  f.plugin('allowed-plugin')
  const list = join(f.dir, 'nested.cordis.yml')
  writeFileSync(list, '- id: nested\n  name: allowed-plugin\n')
  expect(load(readFileSync(list, 'utf8'), { schema: entryListSchema })).toEqual([{ id: 'nested', name: 'allowed-plugin' }])
  // The launcher mounts an Include with a file URL, which a Windows path cannot stand in for: `C:` reads as a scheme.
  expect(await f.run([{ insert: [{ id: 'outer', name: 'cordis:include', config: { path: pathToFileURL(list).href } }] }]))
    .toEqual(['import:allowed-plugin', 'apply:allowed-plugin'])
})

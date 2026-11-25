/** Admission of profile composition rows before the Loader imports any plugin code. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { parseEntryYaml, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  PROFILE_COMPATIBILITY_FILENAME, PluginPackages, boot, createRuntimeResolution, getDshRuntimeVersion,
  loadProfileDirectory, prepareProfileEntries, prepareProfilePatches, recomposeProfile, type ProfileContext,
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
    startedBundles: [], overlayPaths: [], telemetryDisabledEnv: undefined,
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
  expect(parseEntryYaml(readFileSync(list, 'utf8'))).toEqual([{ id: 'nested', name: 'allowed-plugin' }])
  // The launcher mounts an Include with a file URL, which a Windows path cannot stand in for: `C:` reads as a scheme.
  expect(await f.run([{ insert: [{ id: 'outer', name: 'cordis:include', config: { path: pathToFileURL(list).href } }] }]))
    .toEqual(['import:allowed-plugin', 'apply:allowed-plugin'])
})

describe('bundle rows of a profile whose node_modules holds another copy of their package', () => {
  /**
   * An installation whose base bundle inserts a `storage-domain` row, and a `web` profile selecting that bundle.
   * `plugin` writes one copy of a package; a copy with `peer` requires a dsh this runtime does not provide.
   */
  function installation() {
    const f = fixture()
    const install = join(f.dir, 'install')
    const profileDir = join(f.dir, 'profiles', 'web')
    const effects = pathToFileURL(join(f.dir, 'effects')).href
    const write = (path: string, text: string): void => {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, text)
    }
    const plugin = (dir: string, name: string, label: string, options: { peer?: string; imports?: string } = {}): void => {
      write(join(dir, 'package.json'), JSON.stringify({
        name, version: '1.0.0', type: 'module', exports: './index.mjs',
        ...options.peer === undefined ? {} : { peerDependencies: { '@deepseek-ai/dsh-test': options.peer } },
      }))
      // Each started plugin records its own copy, and the copy of the package it imports.
      write(join(dir, 'index.mjs'), `import { appendFileSync } from 'node:fs'
${options.imports === undefined ? '' : `import { copy as imported } from '${options.imports}'`}
export const copy = '${label}'
export function apply() {
  appendFileSync(new URL('${effects}'), '${name}=${label}${options.imports === undefined ? '' : ' imports \' + imported + \''}\\n')
}
`)
    }
    const bundle = (
      dir: string, name: string, rows: string[], dependencies: Record<string, string>, manifest: Record<string, unknown> = {},
    ): void => {
      write(join(dir, 'package.json'), JSON.stringify({
        name, version: '1.0.0', dependencies, ...manifest, dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      write(join(dir, 'cordis.patch.yml'), JSON.stringify([{ insert: rows.map(row => ({ id: `${name}:${row}`, name: row })) }]))
    }
    // The installation ships `tool` as well; no bundle of the installation inserts a row for it.
    write(join(install, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-base': '*', tool: '*' },
    }))
    bundle(join(install, 'node_modules', '@deepseek-ai', 'dsh-base'), '@deepseek-ai/dsh-base', ['storage-domain'], { 'storage-domain': '*' })
    plugin(join(install, 'node_modules', 'storage-domain'), 'storage-domain', 'installed')
    plugin(join(install, 'node_modules', 'tool'), 'tool', 'installed')
    write(join(profileDir, 'cordis.yml'), '[]\n')
    const select = (bundles: string[], dependencies: Record<string, string> = {}): void => {
      write(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web', private: true, dependencies, dsh: { profile: { bundles } },
      }))
    }
    select(['@deepseek-ai/dsh-base'])

    const installAnchor = join(install, 'package.json')
    /** Every patch layer of the profile: its bundles in order, then its own patch file. */
    const patches = () => {
      const profile = loadProfileDirectory('dsh', profileDir, installAnchor)
      return [...profile.layers.flatMap(layer => layer.patches), ...profile.patches]
    }
    const userPatch = (text: string): void => { write(join(profileDir, 'cordis.patch.yml'), text) }
    /** The plugins that started, and the rows the compatibility admission disabled, since the last launch. */
    const observe = () => ({
      ran: existsSync(join(f.dir, 'effects')) ? readFileSync(join(f.dir, 'effects'), 'utf8').trim().split('\n').sort() : [],
      disabled: f.warnings.flatMap(warning => /disabling profile plugin row "([^"]+)"/u.exec(warning)?.[1] ?? []),
    })

    /** Boot the profile through the Loader; `selection: false` removes the bundle plugins from the computed resolution. */
    async function launch(selection: boolean) {
      rmSync(join(f.dir, 'effects'), { force: true })
      f.warnings.length = 0
      const profile = loadProfileDirectory('dsh', profileDir, installAnchor)
      const computed = await createRuntimeResolution({ installAnchor, profile, home: f.dir })
      const { profilesDir, profileDir: dir, localPackageNames, entries, linkedRoots } = computed
      const resolution = selection ? computed : { profilesDir, profileDir: dir, localPackageNames, entries, linkedRoots }
      const context: ProfileContext = { ...f.profile, name: 'web', dir: profileDir, installAnchor }
      const ctx = await boot('dsh', join(profileDir, 'cordis.yml'), patches(), async (host) => {
        host.provide('profileContext', context)
        await host.plugin(PluginPackages, { resolution })
      })
      return { ctx, computed }
    }

    /** Launch, observe, and stop the application, so that the next launch installs its own resolution. */
    async function start(selection: boolean) {
      const { ctx } = await launch(selection)
      try {
        return observe()
      } finally {
        await ctx.fiber.dispose()
      }
    }
    return { dir: f.dir, install, profileDir, plugin, bundle, select, userPatch, start, launch, observe, patches }
  }

  type Installation = ReturnType<typeof installation>
  const hoisted = (f: Installation, name: string) => join(f.profileDir, 'node_modules', name)
  const baseRow = '@deepseek-ai/dsh-base:storage-domain'
  /**
   * A development bundle `hello` in a checkout outside the profiles tree, linked into the profile. The bundle is a
   * plugin that inserts itself and a `tool` row. With `installs`, it also imports `tool` and holds its own copy.
   */
  const linkCheckout = (f: Installation, declared: Record<string, unknown>, installs = true): void => {
    // The link target is spelled as the native real path spells it, which on Windows expands 8.3 short names.
    const checkout = join(realpathSync.native(f.dir), 'work', 'hello')
    f.plugin(checkout, 'hello', 'hello', installs ? { imports: 'tool' } : {})
    f.bundle(checkout, 'hello', ['hello', 'tool'], {}, { type: 'module', exports: './index.mjs', ...declared })
    if (installs) f.plugin(join(checkout, 'node_modules', 'tool'), 'tool', 'checkout')
    mkdirSync(join(f.profileDir, 'node_modules'), { recursive: true })
    symlinkSync(checkout, hoisted(f, 'hello'), process.platform === 'win32' ? 'junction' : 'dir')
    f.select(['@deepseek-ai/dsh-base', 'hello'], { hello: `link:${checkout}` })
  }

  it.each<[string, (f: Installation) => void, { ran: string[]; disabled: string[] }, { ran: string[]; disabled: string[] }]>([
    [
      'no other copy in the profile',
      () => {},
      { ran: ['storage-domain=installed'], disabled: [] },
      { ran: ['storage-domain=installed'], disabled: [] },
    ],
    [
      'an incompatible copy hoisted by a third-party plugin that pins it as a dependency',
      (f) => {
        f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned', { peer: '^9.0.0' })
        f.plugin(hoisted(f, 'third-plugin'), 'third-plugin', 'third')
        f.select(['@deepseek-ai/dsh-base'], { 'third-plugin': '*' })
      },
      { ran: [], disabled: [baseRow] },
      { ran: ['storage-domain=installed'], disabled: [] },
    ],
    [
      'an incompatible copy the profile lists as its own dependency',
      (f) => {
        f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned', { peer: '^9.0.0' })
        f.select(['@deepseek-ai/dsh-base'], { 'storage-domain': '1.0.0' })
      },
      { ran: [], disabled: [baseRow] },
      { ran: ['storage-domain=installed'], disabled: [] },
    ],
    [
      'a compatible copy hoisted into the profile',
      (f) => { f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned') },
      { ran: ['storage-domain=pinned'], disabled: [] },
      { ran: ['storage-domain=installed'], disabled: [] },
    ],
    [
      'a third-party bundle whose own plugin imports the copy it pins',
      (f) => {
        f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned')
        f.bundle(hoisted(f, 'third-bundle'), 'third-bundle', ['third-plugin'], { 'third-plugin': '*', 'storage-domain': '1.0.0' })
        f.plugin(hoisted(f, 'third-plugin'), 'third-plugin', 'third', { imports: 'storage-domain' })
        f.select(['@deepseek-ai/dsh-base', 'third-bundle'], { 'third-bundle': '*' })
      },
      { ran: ['storage-domain=pinned', 'third-plugin=third imports pinned'], disabled: [] },
      { ran: ['storage-domain=installed', 'third-plugin=third imports pinned'], disabled: [] },
    ],
    [
      'a third-party bundle that inserts a row of the same package, listed after the base bundle',
      (f) => {
        f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned', { peer: '^9.0.0' })
        f.bundle(hoisted(f, 'third-bundle'), 'third-bundle', ['storage-domain'], { 'storage-domain': '1.0.0' })
        f.select(['@deepseek-ai/dsh-base', 'third-bundle'], { 'third-bundle': '*' })
      },
      { ran: [], disabled: [baseRow, 'third-bundle:storage-domain'] },
      { ran: ['storage-domain=installed', 'storage-domain=installed'], disabled: [] },
    ],
    [
      'a third-party bundle that inserts a row of the same package, listed before the base bundle',
      (f) => {
        f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned', { peer: '^9.0.0' })
        f.bundle(hoisted(f, 'third-bundle'), 'third-bundle', ['storage-domain'], { 'storage-domain': '1.0.0' })
        f.select(['third-bundle', '@deepseek-ai/dsh-base'], { 'third-bundle': '*' })
      },
      { ran: [], disabled: ['third-bundle:storage-domain', baseRow] },
      { ran: [], disabled: ['third-bundle:storage-domain', baseRow] },
    ],
    [
      'a row of the same package in the profile patch file',
      (f) => {
        f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned')
        f.userPatch('- insert:\n    - id: mine\n      name: storage-domain\n')
      },
      { ran: ['storage-domain=pinned', 'storage-domain=pinned'], disabled: [] },
      { ran: ['storage-domain=installed', 'storage-domain=installed'], disabled: [] },
    ],
    [
      'a profile patch file that disables the base row and names the hoisted copy by path',
      (f) => {
        f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned')
        f.userPatch(`- id: '${baseRow}'\n  disabled: true\n- insert:\n    - id: mine\n      name: ./node_modules/storage-domain/index.mjs\n`)
      },
      { ran: ['storage-domain=pinned'], disabled: [] },
      { ran: ['storage-domain=pinned'], disabled: [] },
    ],
    // The remaining rows name `tool`, which the installation ships and only the third-party bundle inserts.
    [
      'a third-party bundle that pins and inserts a package no earlier bundle inserts',
      (f) => {
        f.plugin(hoisted(f, 'tool'), 'tool', 'pinned')
        f.bundle(hoisted(f, 'third-bundle'), 'third-bundle', ['tool'], { tool: '1.0.0' })
        f.select(['@deepseek-ai/dsh-base', 'third-bundle'], { 'third-bundle': '*' })
      },
      { ran: ['storage-domain=installed', 'tool=pinned'], disabled: [] },
      { ran: ['storage-domain=installed', 'tool=pinned'], disabled: [] },
    ],
    [
      'a third-party bundle that keeps the package it inserts in its own node_modules',
      (f) => {
        f.bundle(hoisted(f, 'third-bundle'), 'third-bundle', ['tool'], { tool: '1.0.0' })
        f.plugin(join(hoisted(f, 'third-bundle'), 'node_modules', 'tool'), 'tool', 'nested')
        f.select(['@deepseek-ai/dsh-base', 'third-bundle'], { 'third-bundle': '*' })
      },
      { ran: ['storage-domain=installed', 'tool=installed'], disabled: [] },
      { ran: ['storage-domain=installed', 'tool=nested'], disabled: [] },
    ],
    [
      'a third-party bundle that inserts a package it does not declare, pinned by another plugin',
      (f) => {
        f.plugin(hoisted(f, 'tool'), 'tool', 'pinned', { peer: '^9.0.0' })
        f.bundle(hoisted(f, 'third-bundle'), 'third-bundle', ['tool'], {})
        f.plugin(hoisted(f, 'other-plugin'), 'other-plugin', 'other')
        f.select(['@deepseek-ai/dsh-base', 'third-bundle'], { 'third-bundle': '*', 'other-plugin': '*' })
      },
      { ran: ['storage-domain=installed'], disabled: ['third-bundle:tool'] },
      { ran: ['storage-domain=installed'], disabled: ['third-bundle:tool'] },
    ],
    [
      'a third-party bundle that declares the package it inserts as a peer, pinned by another plugin',
      (f) => {
        f.plugin(hoisted(f, 'tool'), 'tool', 'pinned', { peer: '^9.0.0' })
        f.bundle(hoisted(f, 'third-bundle'), 'third-bundle', ['tool'], {}, { peerDependencies: { tool: '*' } })
        f.plugin(hoisted(f, 'other-plugin'), 'other-plugin', 'other')
        f.select(['@deepseek-ai/dsh-base', 'third-bundle'], { 'third-bundle': '*', 'other-plugin': '*' })
      },
      { ran: ['storage-domain=installed'], disabled: ['third-bundle:tool'] },
      { ran: ['storage-domain=installed'], disabled: ['third-bundle:tool'] },
    ],
    [
      'a row in the profile patch file for a package no bundle inserts, pinned by a third-party plugin',
      (f) => {
        f.plugin(hoisted(f, 'tool'), 'tool', 'pinned')
        f.plugin(hoisted(f, 'third-plugin'), 'third-plugin', 'third')
        f.select(['@deepseek-ai/dsh-base'], { 'third-plugin': '*' })
        f.userPatch('- insert:\n    - id: mine\n      name: tool\n')
      },
      { ran: ['storage-domain=installed', 'tool=pinned'], disabled: [] },
      { ran: ['storage-domain=installed', 'tool=pinned'], disabled: [] },
    ],
    [
      'a linked development bundle that declares the package it inserts as a peer and a development dependency',
      (f) => { linkCheckout(f, { peerDependencies: { tool: '*' }, devDependencies: { tool: '*' } }) },
      { ran: ['hello=hello imports installed', 'storage-domain=installed', 'tool=installed'], disabled: [] },
      { ran: ['hello=hello imports installed', 'storage-domain=installed', 'tool=installed'], disabled: [] },
    ],
    [
      'a linked development bundle that lists the package it inserts as a dependency',
      (f) => { linkCheckout(f, { dependencies: { tool: '*' } }) },
      { ran: ['hello=hello imports checkout', 'storage-domain=installed', 'tool=installed'], disabled: [] },
      { ran: ['hello=hello imports checkout', 'storage-domain=installed', 'tool=checkout'], disabled: [] },
    ],
    [
      'a linked development bundle that inserts a package it neither declares nor installs',
      (f) => { linkCheckout(f, {}, false) },
      { ran: ['hello=hello', 'storage-domain=installed', 'tool=installed'], disabled: [] },
      { ran: ['hello=hello', 'storage-domain=installed', 'tool=installed'], disabled: [] },
    ],
    // The row resolves from the bundle that declares the package, and the Loader reports the import failure.
    [
      'a linked development bundle that declares a dependency it has not installed',
      (f) => { linkCheckout(f, { dependencies: { tool: '*' } }, false) },
      { ran: ['hello=hello', 'storage-domain=installed', 'tool=installed'], disabled: [] },
      { ran: ['hello=hello', 'storage-domain=installed'], disabled: [] },
    ],
    [
      'the base row inside a group that is named without the group marker, beside an incompatible hoisted copy',
      (f) => {
        f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned', { peer: '^9.0.0' })
        writeFileSync(join(f.install, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'), JSON.stringify([
          { insert: [{ id: 'grouped', name: 'cordis:group', config: [{ id: 'inner-row', name: 'storage-domain' }] }] },
        ]))
      },
      { ran: [], disabled: ['inner-row'] },
      { ran: ['storage-domain=installed'], disabled: [] },
    ],
  ])('starts the rows of a profile with %s', async (_title, arrange, before, after) => {
    const f = installation()
    arrange(f)
    const without = await f.start(false)
    expect({ ran: without.ran, disabled: without.disabled }).toEqual(before)
    const selected = await f.start(true)
    expect({ ran: selected.ran, disabled: selected.disabled }).toEqual(after)
  })

  it('starts the row of a bundle enabled while the application runs from that bundle', async () => {
    const f = installation()
    f.plugin(hoisted(f, 'storage-domain'), 'storage-domain', 'pinned')
    f.select([])
    const { ctx, computed } = await f.launch(true)
    onTestFinished(async () => { await ctx.fiber.dispose() })
    expect(f.observe().ran).toEqual([])
    expect(computed.bundlePlugins).toEqual([])

    f.select(['@deepseek-ai/dsh-base'])
    await expect(recomposeProfile(ctx, f.patches(), 'dsh')).resolves.toEqual({ warnings: [] })
    // The installation already supplies the bundle and its dependencies, so only the bundle plugins differ.
    const published = ctx.get('pluginPackages')?.resolution
    expect(published?.bundlePlugins?.map(plugin => plugin.name)).toEqual(['storage-domain'])
    expect([published?.entries, published?.localPackageNames, published?.linkedRoots])
      .toEqual([computed.entries, computed.localPackageNames, computed.linkedRoots])
    expect(f.observe()).toEqual({ ran: ['storage-domain=installed'], disabled: [] })
  })
})

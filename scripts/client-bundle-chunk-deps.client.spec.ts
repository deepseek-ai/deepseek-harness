/**
 * Package-local chunk dependencies end to end: the dynamic Client preset builds a fixture package whose entry and
 * lazy chunks share modules and a CommonJS dependency, and the real module system loads the written artifacts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'tsdown'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientBundle } from '../packages/client/tsdown.client.ts'
import {
  createClientModuleSystem,
  type ClientBundleRegistration, type ClientModuleLoader, type ClientModuleLoaderTarget,
} from '../packages/client/modules/src/client/index.ts'

const PACKAGE = '@deepseek-ai/dsh-client-chunk-fixture'
const BATCH_URL = `plugins/??${PACKAGE}/client.js&rev=app`
const entryUrl = (rev = '0'): string => `plugins/??${PACKAGE}/client.js&rev=${rev}`
const chunkUrl = (fileName: string, rev = '0'): string => `plugins/${PACKAGE}/${fileName}?rev=${rev}`

/**
 * Module graph: the entry shares `shared.js` with `a.js` and also imports it dynamically; `a.js` and `b.js` share
 * `common.js`, which imports `deep.js`; `c.js` imports `deep.js` alone. The entry and `b.js` each import their own
 * CommonJS package, so Rolldown's helper becomes a runtime chunk that both require.
 */
const SOURCES: Readonly<Record<string, string>> = {
  'index.js': [
    'import { shared } from "./shared.js"',
    'import { marker } from "cjs-entry"',
    'export const value = [shared, marker]',
    'export const loadA = () => import("./a.js")',
    'export const loadB = () => import("./b.js")',
    'export const loadC = () => import("./c.js")',
    'export const loadShared = () => import("./shared.js")',
  ].join('\n'),
  'shared.js': 'export const shared = "shared"',
  'common.js': 'import { deep } from "./deep.js"\nexport const common = ["common", deep]',
  'deep.js': 'export const deep = "deep"',
  'a.js': 'import { shared } from "./shared.js"\nimport { common } from "./common.js"\nexport const a = ["a", shared, common]',
  'b.js': 'import { common } from "./common.js"\nimport { marker } from "cjs-b"\nexport const b = ["b", common, marker]',
  'c.js': 'import { deep } from "./deep.js"\nexport const c = ["c", deep]',
}

/** Chunk group behind each lazy import, without the chunks the entry file carries. */
const LAZY = {
  a: { file: 'client.a.js', hint: ['./client.deep.js', './client.common.js'], exports: { a: ['a', 'shared', ['common', 'deep']] } },
  b: { file: 'client.b.js', hint: ['./client.deep.js', './client.common.js'], exports: { b: ['b', ['common', 'deep'], 'cjs-b'] } },
  c: { file: 'client.c.js', hint: ['./client.deep.js'], exports: { c: ['c', 'deep'] } },
} as const

/** Exports of the fixture entry. */
interface FixtureEntry {
  value: unknown
  loadA(): Promise<unknown>
  loadB(): Promise<unknown>
  loadC(): Promise<unknown>
  loadShared(): Promise<unknown>
}

let root: string
/** Written browser artifacts by file name. */
const artifacts = new Map<string, string>()
/** Mappings of the entry chunk's in-memory source map, which build API consumers read instead of the written file. */
let entryMappings: string | undefined

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-client-chunk-deps-'))
  const sourceDir = join(root, 'lib/types/client')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PACKAGE, type: 'module' }))
  for (const [file, source] of Object.entries(SOURCES)) writeFileSync(join(sourceDir, file), `${source}\n`)
  for (const name of ['cjs-entry', 'cjs-b']) {
    const directory = join(root, 'node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
    writeFileSync(join(directory, 'index.js'), `exports.marker = ${JSON.stringify(name)}\n`)
  }
  const config = clientBundle(root, ['lib/types/index.js'])({ env: { DSH_BUILD_FACE: 'client' } })
    .find(candidate => candidate.platform === 'browser')
  if (config === undefined) throw new Error('client config missing')
  const builds = await build({ ...config, cwd: root, config: false, tsconfig: false, clean: false, exports: false, report: false, logLevel: 'silent' })
  for (const bundle of builds) {
    for (const output of bundle.chunks) if (output.type === 'chunk' && output.isEntry) entryMappings = output.map?.mappings
    await bundle[Symbol.asyncDispose]()
  }
  for (const file of readdirSync(join(root, 'lib'))) {
    if (file !== 'types') artifacts.set(file, readFileSync(join(root, 'lib', file), 'utf8'))
  }
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function artifact(file: string): string {
  const text = artifacts.get(file)
  if (text === undefined) throw new Error(`fixture artifact missing: ${file}`)
  return text
}

/** Registrations one script performs, in order. */
function registrationsOf(code: string): ClientBundleRegistration[] {
  const registrations: ClientBundleRegistration[] = []
  const load = (registration: ClientBundleRegistration): void => { registrations.push(registration) }
  runInNewContext(code, { window: { __ModuleLoader__: { load } } })
  return registrations
}

/** Package-local `require.async` calls of one script; the minifier chooses the quotes. */
function asyncRequests(code: string): { target: string; deps?: string[] }[] {
  return [...code.matchAll(/require\.async\((["'`])([^"'`]+)\1(?:,\{deps:\[([^\]]*)\]\})?\)/gu)].map(match => ({
    target: match[2]!,
    ...(match[3] === undefined ? {} : { deps: [...match[3].matchAll(/["'`]([^"'`]+)["'`]/gu)].map(item => item[1]!) }),
  }))
}

/** Remove every prefetch hint, as a builder that writes only registration `deps` would. */
const withoutHints = (code: string): string => code.replace(/,\{deps:\[[^\]]*\]\}\)/gu, ')')

interface Harness {
  system: ClientModuleLoader
  target: ClientModuleLoaderTarget
  fetched: string[]
}

/**
 * Real module system over the written artifacts. Combo URLs serve `client.js`; chunk URLs serve their file.
 * `scripts` overrides the text served at a URL; `pending` scripts run before the system exists, as
 * parser-preloaded scripts do.
 */
function boot(options: {
  scripts?: Readonly<Record<string, string>>
  pending?: readonly string[]
  failing?: readonly string[]
} = {}): Harness {
  const fetched: string[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue: [],
    load(registration) { target.pendingQueue.push(registration) },
    create() { throw new Error('the harness creates its module system directly') },
  }
  const run = (code: string): void => { runInNewContext(code, { window: { __ModuleLoader__: target } }) }
  for (const code of options.pending ?? []) run(code)
  const system = createClientModuleSystem(target, { id: '@deepseek-ai/dsh-client-modules', exports: {} }, {
    boot: {
      rev: 'graph',
      entries: [{ id: PACKAGE, url: entryUrl(), rev: '0' }],
      batches: [{ phase: 'application', url: BATCH_URL, rev: 'app', entries: [PACKAGE] }],
    },
    staticModules: [],
    loadBundle: async (url) => {
      fetched.push(url)
      if (options.failing?.includes(url) === true) throw new Error(`bundle script ${url} failed to load`)
      const file = url.includes('/??') ? 'client.js' : /\/([^/?]+)\?rev=/u.exec(url)?.[1] ?? url
      run(options.scripts?.[url] ?? artifact(file))
    },
  })
  return { system, target, fetched }
}

describe('package-local chunk dependency build', () => {
  it('moves the chunks the entry requires into the entry file and deletes their own files', () => {
    expect([...artifacts.keys()].sort()).toEqual([
      'client.a.js', 'client.a.js.map', 'client.b.js', 'client.b.js.map', 'client.c.js', 'client.c.js.map',
      'client.common.js', 'client.common.js.map', 'client.deep.js', 'client.deep.js.map', 'client.js', 'client.js.map',
    ])
    expect(existsSync(join(root, 'lib/client.shared.js'))).toBe(false)
    expect(existsSync(join(root, 'lib/client.rolldown-runtime.js.map'))).toBe(false)
    expect(registrationsOf(artifact('client.js')).map(({ chunk, deps }) => ({ chunk, deps }))).toEqual([
      { chunk: 'client.rolldown-runtime.js', deps: undefined },
      // Rolldown's namespace helper for the dynamic import makes the shared chunk require the runtime chunk.
      { chunk: 'client.shared.js', deps: ['./client.rolldown-runtime.js'] },
      { chunk: undefined, deps: ['./client.rolldown-runtime.js', './client.shared.js'] },
    ])
  })

  it('writes each chunk registration with its direct synchronous chunk requires', () => {
    const depsOf = (file: string): readonly string[] | undefined => registrationsOf(artifact(file))[0]?.deps
    expect(depsOf('client.a.js')).toEqual(['./client.shared.js', './client.common.js'])
    expect(depsOf('client.b.js')).toEqual(['./client.rolldown-runtime.js', './client.common.js'])
    expect(depsOf('client.common.js')).toEqual(['./client.deep.js'])
    expect(depsOf('client.c.js')).toEqual(['./client.deep.js'])
    expect(Object.hasOwn(registrationsOf(artifact('client.deep.js'))[0]!, 'deps')).toBe(false)
  })

  it('hints every lazy chunk group except the chunks the entry file carries', () => {
    expect(asyncRequests(artifact('client.js'))).toEqual(Object.values(LAZY).map(({ file, hint }) => ({ target: `./${file}`, deps: hint })))
    expect(asyncRequests(artifact('client.c.js'))).toEqual([])
  })

  it('keeps a dynamic import of a chunk the entry file carries as a synchronous require', () => {
    expect(artifact('client.js')).toMatch(/Promise\.resolve\(\)\.then\(\(\)\s*=>\s*require\((["'`])\.\/client\.shared\.js\1\)\)/u)
  })

  it('shifts the entry source map past the moved chunks', () => {
    const lines = artifact('client.js').split('\n')
    const map = JSON.parse(artifact('client.js.map')) as { mappings: string }
    expect(entryMappings).toBe(map.mappings)
    const firstMapped = /^;*/u.exec(map.mappings)![0].length
    expect(registrationsOf(lines[firstMapped]!).map(registration => registration.chunk)).toEqual([undefined])
    expect(registrationsOf(lines.slice(0, firstMapped).join('\n')).map(registration => registration.chunk))
      .toEqual(['client.rolldown-runtime.js', 'client.shared.js'])
  })
})

describe('package entry requests', () => {
  it.each([
    ['statically', 'import { value } from "./index.js"\nexport const late = value\n'],
    ['dynamically', 'export const late = () => import("./index.js")\n'],
  ])('rejects a chunk that imports the package entry %s', async (_form, late) => {
    const entryRoot = mkdtempSync(join(tmpdir(), 'dsh-client-entry-import-'))
    try {
      const sourceDir = join(entryRoot, 'lib/types/client')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(entryRoot, 'package.json'), JSON.stringify({ name: PACKAGE, type: 'module' }))
      writeFileSync(join(sourceDir, 'index.js'), 'export const value = "entry"\nexport const load = () => import("./late.js")\n')
      writeFileSync(join(sourceDir, 'late.js'), late)
      const config = clientBundle(entryRoot, ['lib/types/index.js'])({ env: { DSH_BUILD_FACE: 'client' } })
        .find(candidate => candidate.platform === 'browser')
      if (config === undefined) throw new Error('client config missing')
      await expect(build({
        ...config, cwd: entryRoot, config: false, tsconfig: false,
        write: false, clean: false, exports: false, report: false, logLevel: 'silent',
      })).rejects.toThrow('client.late.js imports the package entry client.js;')
    } finally {
      rmSync(entryRoot, { recursive: true, force: true })
    }
  })
})

describe('package-local chunk dependency runtime', () => {
  it('runs the entry from one script that also registers its chunks', async () => {
    const { system, fetched } = boot()
    const entry = await system.import(PACKAGE, '', {}) as FixtureEntry
    expect(entry.value).toEqual(['shared', 'cjs-entry'])
    await expect(entry.loadShared()).resolves.toMatchObject({ shared: 'shared' })
    expect(fetched).toEqual([BATCH_URL])
  })

  it('downloads a hinted chunk group in one round', async () => {
    const { system, fetched } = boot()
    const entry = await system.import(PACKAGE, '', {}) as FixtureEntry
    const loaded = entry.loadA()
    expect(fetched).toEqual([BATCH_URL, chunkUrl(LAZY.a.file), ...LAZY.a.hint.map(spec => chunkUrl(spec.slice(2)))])
    await expect(loaded).resolves.toEqual(LAZY.a.exports)
    await expect(entry.loadB()).resolves.toEqual(LAZY.b.exports)
    await expect(entry.loadC()).resolves.toEqual(LAZY.c.exports)
    expect(fetched.slice(4)).toEqual([chunkUrl(LAZY.b.file), chunkUrl(LAZY.c.file)])
  })

  it('loads a chunk group through registration deps alone, one level per round', async () => {
    const { system, fetched } = boot({ scripts: { [BATCH_URL]: withoutHints(artifact('client.js')) } })
    const entry = await system.import(PACKAGE, '', {}) as FixtureEntry
    const loaded = entry.loadA()
    expect(fetched).toEqual([BATCH_URL, chunkUrl('client.a.js')])
    await expect(loaded).resolves.toEqual(LAZY.a.exports)
    expect(fetched).toEqual([BATCH_URL, chunkUrl('client.a.js'), chunkUrl('client.common.js'), chunkUrl('client.deep.js')])
  })

  it('names the dependency chain when a required chunk fails to download', async () => {
    const { system } = boot({
      scripts: { [BATCH_URL]: withoutHints(artifact('client.js')) },
      failing: [chunkUrl('client.deep.js')],
    })
    const entry = await system.import(PACKAGE, '', {}) as FixtureEntry
    await expect(entry.loadA()).rejects.toThrow(
      `"${PACKAGE}/client.a.js" not loaded because dependency "${PACKAGE}/client.common.js" failed: `
      + `client-modules: "${PACKAGE}/client.common.js" not loaded because dependency "${PACKAGE}/client.deep.js" failed`,
    )
  })

  it('names the dependency chain when a hinted chunk fails to download', async () => {
    const { system } = boot({ failing: [chunkUrl('client.deep.js')] })
    const entry = await system.import(PACKAGE, '', {}) as FixtureEntry
    const failure = await entry.loadA().then(() => undefined, (error: unknown) => error)
    expect((failure as Error).message).toContain(
      `client-modules: "${PACKAGE}/client.a.js" not loaded because dependency "${PACKAGE}/client.common.js" failed: `
      + `client-modules: "${PACKAGE}/client.common.js" not loaded because dependency "${PACKAGE}/client.deep.js" failed`,
    )
    expect(((failure as Error).cause as Error).message).toContain(`"${PACKAGE}/client.common.js" not loaded`)
  })

  it('rejects a synchronous chunk request before the chunk is registered', async () => {
    const { system, target } = boot()
    runInNewContext(artifact('client.a.js'), { window: { __ModuleLoader__: target } })
    await expect(system.import(`${PACKAGE}/client.a.js`, '', {}))
      .rejects.toThrow(`"${PACKAGE}" required chunk client.shared.js before it was registered`)
  })

  it('completes the chunks of an entry that a preloaded script registered without them', async () => {
    const parts = artifact('client.js').split(/\n(?=window\.__ModuleLoader__\.load\()/u).filter(part => part.trim() !== '')
    const scripts: Record<string, string> = {}
    let entryScript: string | undefined
    for (const part of parts) {
      const chunk = registrationsOf(part)[0]?.chunk
      if (chunk === undefined) entryScript = part
      else scripts[chunkUrl(chunk)] = part
    }
    const { system, fetched } = boot({ scripts, pending: [entryScript!] })
    const entry = await system.import(PACKAGE, '', {}) as FixtureEntry
    expect(entry.value).toEqual(['shared', 'cjs-entry'])
    expect(fetched).toEqual([chunkUrl('client.rolldown-runtime.js'), chunkUrl('client.shared.js')])
  })

  it('re-executes the entry file after invalidation without a duplicate registration', async () => {
    const { system, fetched } = boot()
    await system.import(PACKAGE, '', {})
    system.invalidate(PACKAGE, 'next')
    const entry = await system.import(PACKAGE, '', {}) as FixtureEntry
    expect(entry.value).toEqual(['shared', 'cjs-entry'])
    await expect(entry.loadC()).resolves.toEqual(LAZY.c.exports)
    expect(fetched).toEqual([BATCH_URL, entryUrl('next'), chunkUrl('client.c.js', 'next'), chunkUrl('client.deep.js', 'next')])
  })
})

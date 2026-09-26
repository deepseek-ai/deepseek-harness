// Shared scaffolding for the assembled-jsdom snapshots: the real built
// workspace `lib/client.js` artifacts booted through AppWebEntry's
// ModuleLoader path (loadBundle) against a test-owned RemoteMock carrier
// transport. Every file that mounts this graph needs the same boot entry list,
// the same bundle map, the same jsdom globals, and the same mount call, and
// differs only in what it asserts afterwards, so the scaffolding lives here.
//
// Keyless and deterministic: the fixture is the fake server, so nothing here
// reaches a model or the network.
import { globSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { bootInjections, orderByModuleGraph } from '@deepseek-ai/dsh-client-modules'
import type { ClientModuleLoaderTarget, WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import type { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import {
  createAssembledRemote, type AssembledRemote, type AssembledRemoteOptions,
} from './assembled-remote.ts'

interface AssembledPlugin extends WebBootEntry {
  /** Absolute path to the built client artifact declared by this package. */
  bundlePath: string
}

interface AssembledBootOptions {
  /** Package ids omitted from this mounted composition. */
  readonly exclude?: readonly string[]
  /** Remote answers owned by this assembled case. */
  readonly remote?: AssembledRemoteOptions
}

interface ClientPackageManifest {
  name?: string
  exports?: Record<string, string | { default?: string }>
  dsh?: {
    client?: {
      platform?: string
      inject?: string[]
      external?: string[]
      immediately?: boolean
    }
  }
}

interface ComposedEntry {
  name?: unknown
  disabled?: unknown
}

interface BootComposition {
  bundlePatchPaths(packageDir: string, bundle: { patch: string | string[] }): string[]
  loadOverlayPatches(binName: string, file: string): unknown[]
  composeEntries(layers: readonly unknown[][]): ComposedEntry[]
}

const REPO_ROOT = process.cwd()
const BUNDLE_LAYERS = ['packages/bundle/base', 'packages/bundle/web-app'].map(dir => ({
  dir: join(REPO_ROOT, dir),
  manifest: join(REPO_ROOT, dir, 'package.json'),
}))
const bundleResolvers = BUNDLE_LAYERS.map(layer => createRequire(layer.manifest))
const webBundleResolver = bundleResolvers[1]
if (webBundleResolver === undefined) throw new Error('assembled boot: web bundle resolver missing')
const workspacePackageManifests = new Map(globSync('packages/*/*/package.json', { cwd: REPO_ROOT }).map((relative) => {
  const path = join(REPO_ROOT, relative)
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as ClientPackageManifest
  if (pkg.name === undefined) throw new Error(`assembled boot: workspace package has no name: ${path}`)
  return [pkg.name, path]
}))
const appBoot = await import(pathToFileURL(webBundleResolver.resolve('@deepseek-ai/dsh-app-boot')).href) as unknown as BootComposition

function resolvePackageManifest(specifier: string): string | undefined {
  return workspacePackageManifests.get(specifier)
}

function resolveClientExport(packagePath: string, pkg: ClientPackageManifest): string {
  const declared = pkg.exports?.['./client']
  const relative = typeof declared === 'string' ? declared : declared?.default
  if (relative === undefined) {
    throw new Error(`assembled boot: ${pkg.name ?? packagePath} declares dsh.client without a ./client export`)
  }
  return resolve(dirname(packagePath), relative)
}

/** App-directory-relative combo references, matching the wire the Host composes. */
const comboReference = (ids: readonly string[], rev: string): string =>
  `plugins/??${ids.map(id => `${id}/client.js`).join(',')}&rev=${rev}`

/** Derive the assembled browser graph from the same bundle patches and package declarations as `dsh web`. */
function loadAssembledPlugins(): readonly AssembledPlugin[] {
  const entries = appBoot.composeEntries(BUNDLE_LAYERS.map((layer) => {
    const declared = (JSON.parse(readFileSync(layer.manifest, 'utf8')) as { dsh: { bundle: { patch: string | string[] } } }).dsh.bundle
    return appBoot.bundlePatchPaths(layer.dir, declared).flatMap(patch => appBoot.loadOverlayPatches('assembled boot', patch))
  }))
  const plugins = new Map<string, AssembledPlugin>()
  for (const entry of entries) {
    if (entry.disabled === true || typeof entry.name !== 'string') continue
    const packagePath = resolvePackageManifest(entry.name)
    if (packagePath === undefined) continue
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as ClientPackageManifest
    const declaration = pkg.dsh?.client
    if (declaration?.platform !== 'web') continue
    if (pkg.name !== entry.name) {
      throw new Error(`assembled boot: ${entry.name} resolved package ${pkg.name ?? '<unnamed>'}`)
    }
    plugins.set(entry.name, {
      id: entry.name,
      bundlePath: resolveClientExport(packagePath, pkg),
      url: comboReference([entry.name], 'fx'),
      rev: 'fx',
      ...(declaration.inject === undefined ? {} : { inject: declaration.inject }),
      ...(declaration.external === undefined ? {} : { external: declaration.external }),
      ...(declaration.immediately === true ? { immediately: true } : {}),
    })
  }
  return orderByModuleGraph([...plugins.values()]).map(({ id }) => {
    const plugin = plugins.get(id)
    /* v8 ignore next -- orderByModuleGraph returns the input row identities */
    if (plugin === undefined) throw new Error(`assembled boot: ordered unknown client package ${id}`)
    return plugin
  })
}

const PLUGINS = loadAssembledPlugins()

const BOOTSTRAP_IDS = ['@deepseek-ai/dsh-client-modules'] as const

/** Build the fixture graph after applying per-scenario package exclusions. */
function bootGraph(plugins: readonly AssembledPlugin[]): WebBootGraph {
  const bootstrapEntries = plugins
    .map(plugin => plugin.id)
    .filter(id => BOOTSTRAP_IDS.includes(id as typeof BOOTSTRAP_IDS[number]))
  const applicationEntries = plugins
    .map(plugin => plugin.id)
    .filter(id => !BOOTSTRAP_IDS.includes(id as typeof BOOTSTRAP_IDS[number]))
  return {
    rev: 'fx',
    entries: plugins.map(({ bundlePath: _bundlePath, ...plugin }) => plugin),
    batches: [
      ...(bootstrapEntries.length === 0 ? [] : [{
        phase: 'bootstrap' as const,
        url: comboReference(bootstrapEntries, 'fx'),
        rev: 'fx',
        entries: bootstrapEntries,
      }]),
      ...(applicationEntries.length === 0 ? [] : [{
        phase: 'application' as const,
        url: comboReference(applicationEntries, 'fx'),
        rev: 'fx',
        entries: applicationEntries,
      }]),
    ],
  }
}

/** Build single-resource and startup combo script bodies for one fixture composition. */
function bundleTable(graph: WebBootGraph, plugins: readonly AssembledPlugin[]): Map<string, string> {
  const bundles = new Map(plugins.map(plugin => [
    plugin.url,
    readFileSync(plugin.bundlePath, 'utf8'),
  ]))
  for (const batch of graph.batches) {
    bundles.set(batch.url, batch.entries.map((id) => {
      const plugin = plugins.find(candidate => candidate.id === id)
      if (plugin === undefined) throw new Error(`assembled boot: batch names unknown plugin ${id}`)
      const code = bundles.get(plugin.url)
      if (code === undefined) throw new Error(`assembled boot: missing built bundle ${plugin.url}`)
      return code
    }).join('\n;\n'))
  }
  return bundles
}

interface FixtureWindow extends Window {
  __DSH_BOOT__?: WebBootGraph
  __ModuleLoader__?: ClientModuleLoaderTarget
  __DSH_TRANSPORT__?: { readonly rpc: RemoteMock['rpc'] }
}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

class EventSourceStub {
  addEventListener(): void {}
  close(): void {}
}

const win = window as FixtureWindow
let unmount: (() => Promise<void>) | undefined
let mountedRemote: RemoteMock | undefined

/**
 * Register the per-test jsdom setup and teardown the assembled boot needs:
 * English pinned before boot so role/text locators stay deterministic across
 * localized component migrations (the newEnglishPage e2e convention), the
 * observers, font events, and frame callbacks jsdom lacks, and a full reset of the document,
 * the boot globals, and the injected plugin styles afterwards.
 */
export function installAssembledBootEnv(): void {
  // jsdom implements no scroll geometry: the trigger menu reveals its
  // highlight with scrollIntoView on open, which a pasted leading token now
  // reaches in this lane (the editor re-tracks at the settled caret).
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {}
  }
  // jsdom implements no Range geometry either: Lexical's selection reveal
  // measures the caret with one after a programmatic edit settles focus.
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = () => ({
      top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    })
  }
  let fontsDescriptor: PropertyDescriptor | undefined
  beforeEach(() => {
    fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
    localStorage.clear()
    // The locale service derives its provisional locale from the browser and
    // takes an explicit choice only from Host settings. This scenario serves no
    // locale setting, so pinning the navigator selects English.
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true })
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    document.title = 'DeepSeek Harness'
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('EventSource', EventSourceStub)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => { callback(0) }, 0) as unknown as number)
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
  })

  afterEach(async () => {
    const failures: unknown[] = []
    try {
      await act(async () => { await unmount?.() })
    } catch (error) {
      failures.push(error)
    }
    try {
      mountedRemote?.assertNoUnmatched()
    } catch (error) {
      failures.push(error)
    }
    unmount = undefined
    mountedRemote = undefined
    cleanup()
    delete win.__DSH_BOOT__
    delete win.__ModuleLoader__
    delete win.__DSH_TRANSPORT__
    document.body.innerHTML = ''
    document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
    document.title = ''
    history.replaceState(null, '', '/')
    // Deleting the own properties uncovers jsdom's own accessors again
    // (Navigator declares both readonly, hence the erased receiver).
    const ownNavigator = navigator as unknown as Record<string, unknown>
    delete ownNavigator.languages
    delete ownNavigator.language
    vi.unstubAllGlobals()
    if (fontsDescriptor === undefined) Reflect.deleteProperty(document, 'fonts')
    else Object.defineProperty(document, 'fonts', fontsDescriptor)
    if (failures.length > 0) throw new AggregateError(failures, 'assembled boot teardown failed')
  })
}

/**
 * Mount the assembled application on an isolated RemoteMock transport; the teardown
 * registered by installAssembledBootEnv disposes it.
 * @param options - composition changes applied to this mount.
 * @returns the test-owned RemoteMock world.
 */
export function mountAssembledApp(options: AssembledBootOptions = {}): AssembledRemote {
  const excluded = new Set(options.exclude)
  const plugins = PLUGINS.filter(plugin => !excluded.has(plugin.id))
  const remote = createAssembledRemote(options.remote)
  mountedRemote = remote.mock
  win.__DSH_TRANSPORT__ = { rpc: remote.mock.rpc }
  history.replaceState(null, '', '/')
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  const graph = bootGraph(plugins)
  const bundles = bundleTable(graph, plugins)
  win.__DSH_BOOT__ = graph
  const [facadeRow] = bootInjections(win.__DSH_BOOT__)
  if (facadeRow?.kind !== 'script') throw new Error('missing injected ModuleLoader facade row')
  ;(0, eval)(facadeRow.text)
  // Mirror the blocking Host-injected bootstrap batch before the Vite entry calls create().
  const bootstrapUrl = graph.batches.find(batch => batch.phase === 'bootstrap')?.url
  const bootstrap = bootstrapUrl === undefined ? undefined : bundles.get(bootstrapUrl)
  if (bootstrap === undefined) throw new Error('missing parser-preloaded fixture batch')
  ;(0, eval)(bootstrap)
  act(() => {
    const entry = new AppWebEntry(root, {
      loadBundle: async (url) => {
        const code = bundles.get(url)
        if (code === undefined) throw new Error(`missing built bundle ${url}`)
        ;(0, eval)(code)
      },
    })
    void entry.run()
    unmount = () => entry.dispose()
  })
  return remote
}

/**
 * Match a CSS-module class by its logical name.
 * Module class names carry a per-build hash in one of two schemes —
 * ui-primitives emits `_<name>_<hash>` (name bounded by underscores),
 * feature bundles emit `<hash>_<name>` (name at the end) — and a longer name
 * containing this one must not match (`line` must not hit `lineNumber`).
 * @param el - element whose class list is inspected.
 * @param name - logical (unhashed) module class name.
 * @returns whether the element carries that module class.
 */
export function hasClass(el: Element, name: string): boolean {
  return [...el.classList].some(cls => cls === name || cls.endsWith(`_${name}`) || cls.startsWith(`_${name}_`) || cls.includes(`_${name}_`))
}

/**
 * Whether this run rewrites its golden instead of comparing against it, set by
 * the snapshot gate's `DSH_SNAPSHOT` mode (`record` re-runs the scenarios from
 * scratch, `refresh` re-derives the expected text from the existing ones).
 */
export const REFRESHING_GOLDEN = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

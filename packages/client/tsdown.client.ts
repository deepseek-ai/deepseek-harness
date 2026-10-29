/**
 * Shared tsdown preset for UI plugin client bundles. Emits a closure-factory
 * artifact: the bundle calls window.__ModuleLoader__.load({id, factory})
 * and resolves externals through the injected require (loader module table —
 * cordis DI entities, no globals, no import map). CSS is compiled by
 * lightningcss inside the bundle: `x.module.css` yields its hashed class map
 * and injects a tagged style at factory execution, while `x.css?inline`
 * exports compiled text for a plugin-owned lifecycle effect. The virtual
 * loaders register each real stylesheet as a watch dependency. Images under
 * `src/client/assets/`, imported from Client code or referenced by relative
 * `url()` in the package's own stylesheets, are emitted under `lib/assets/`
 * with their content revision in the file name and become document-relative
 * URLs served by the
 * client-modules asset route; such a package exports `./assets/*` as
 * `./lib/assets/*`, and its Node Client face rejects asset imports.
 * Non-experimental client outputs reject experimental module and stylesheet
 * inputs, including origins recorded by chained source maps.
 */
import { randomBytes } from 'node:crypto'
import { readFile, readdir, rm, rmdir, stat, utimes } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, join, posix, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Rolldown, type TsdownPlugin, type UserConfig } from 'tsdown'
import { transform, type CustomAtRules, type Url, type Visitor } from 'lightningcss'
import {
  PACKAGE_ASSET_EXPORT,
  PACKAGE_ASSET_EXPORT_TARGET,
  PACKAGE_ASSET_FILES_ENTRY,
  PACKAGE_ASSET_MEDIA_TYPES,
  packageAssetMediaType,
  packageAssetReference,
  packageAssetRevision,
  packageAssetRevisionedPath,
} from './modules/src/assets.ts'
import { optionalStringArray } from './modules/src/client/manifest.ts'
import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from './web/src/platform.ts'
import { clientBuildEnvironmentDefines, clientBuildValueDefines } from '../../scripts/client-build-environment.ts'
import { isExperimentalPackageName } from '../../scripts/experimental-package-policy.ts'
import { BundleInputIsolation, physicalBundleInput } from '../../scripts/bundle-input-isolation.ts'

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches ids
 * ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

/**
 * Emit one plugin-owned style injector and an optional CSS Modules export.
 * @param css - JavaScript expression yielding the stylesheet text; see {@link stylesheetSource}.
 */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${css};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/**
 * Contract layers and pure folds a client bundle may inline: browser-safe
 * values with no runtime identity to share (no Symbol/instanceof/singleton state).
 * Everything else under @deepseek-ai/* is either a module-table entry
 * (external) or a leak the purity gate rejects.
 */
export const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|official-bundles|deque|output-retention|typert-protocol|util-crypto|util-time|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-util-file-drag$|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-commands\/builtin$|@deepseek-ai\/dsh-native-command\/types$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-plugin-manager\/registry$|@deepseek-ai\/dsh-agent-preset-registry\/display$|@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$|@deepseek-ai\/dsh-spill-policy\/notice$)/

/**
 * Vendored framework libraries: rescoped into @deepseek-ai, so the gate below
 * would read them as plugin packages. They carry no cross-plugin runtime
 * identity to share — the framework itself is a requested module-table row
 * (external), while these are ordinary libraries a browser bundle inlines.
 */
const VENDORED_LIBRARY = /^@deepseek-ai\/(?:(?:cosmokit|schemastery)(?:\/|$)|cordis-plugin-timer$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Workspace mode replaces an empty config array with the root defaults. A
 * falsey entry instead removes this package before entry resolution.
 */
const SKIP_WORKSPACE_BUILD: UserConfig = { entry: '' }

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Rebase a physical lib-relative source onto a browser URL that mirrors the repository directories. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return repositoryPath.startsWith('packages/') ? `../../../${repositoryPath}` : source
}

/**
 * Build the tsdown config for one UI plugin package: the node-half lib build
 * plus the browser client bundle. Client packages emit both halves during the
 * Client pass by default; packages needed for Host reflection may opt into the
 * earlier Host pass. A package-level tsdown.config.ts REPLACES the root
 * workspace layout, so the lib half must be restated here — dropping it leaves
 * the package without lib/index.js and the host Loader cannot import its node
 * half. The Client build consumes `lib/types` and chains those tsc maps, with
 * original source content, into the standalone plugin map.
 * @param packageDir - the package's own directory, normally the config's
 * `import.meta.dirname`. Its `package.json` name is the plugin id stamped into
 * the __ModuleLoader__.load handoff and onto the injected style tags, and the
 * owner segment of its asset URLs; its `src/client/assets/` holds the only
 * images the browser bundle may reference.
 * @param libEntry - node-half entries.
 * @param options - phase placement, lib overrides, optional independently bundled Node Client, companion configs, and per-file Client banner.
 * @returns ENV-selected tsdown config for the current build face.
 * @throws {Error} when `<packageDir>/package.json` is unreadable or declares no name.
 */
export function clientBundle(
  packageDir: string,
  libEntry: readonly string[],
  options: ClientBundleOptions = {},
): BuildFaceConfig {
  const manifest = readPackageManifest(packageDir)
  const lib = clientLibraryConfig(manifest, libEntry, options.lib)
  return ({ env }) => {
    const face = buildFace(env?.DSH_BUILD_FACE)
    const clientEntry = face === undefined ? 'src/client/index.ts' : 'lib/types/client/index.js'
    const client = clientConfig(manifest, packageDir, clientEntry, options.clientBanner, options.dualClient === true)
    const node = [lib, ...(options.companions ?? [])]
    const clientFaces = options.dualClient === true
      ? [nodeClientConfig(manifest, clientEntry), client]
      : [client]
    if (face === 'host') return options.hostPhase === true ? node : [SKIP_WORKSPACE_BUILD]
    if (face === 'client') {
      return options.hostPhase === true ? clientFaces : [...node, ...clientFaces]
    }
    return [...node, ...clientFaces]
  }
}

/**
 * Build the tsdown config for a client library the compile shell links
 * statically (the static assembly channel: `apps/web` resolves the package
 * name, bundles the artifact, and owns the chunk layout and the CSS pipeline).
 *
 * Calling this preset is what puts a package in the static assembly channel,
 * so the call sites are the roster: gates read it through
 * {@link isStaticLinkedConfig} rather than a second hand-kept list. A package on
 * this roster must not be a module-table row as well — the browser would take
 * the statically linked copy and a provider's bytes would sit unused in its
 * bundle.
 *
 * Four artifact contracts:
 * 1. every bare specifier stays an import. The shell attributes chunk bytes by
 *    `node_modules/<pkg>`, so a dependency inlined into a workspace file is
 *    attributed to no npm package and its bytes fall into the index chunk,
 *    which collapses the vendor/index cache split.
 * 2. `esm` on `platform: 'browser'` — the shell is the only consumer.
 * 3. sourcemaps, chained through the tsc maps under `lib/types` to the sources.
 * 4. stylesheets ship with the package: a relative `.css` import survives as a
 *    relative external and the sheet is emitted under `lib/` at its
 *    `src`-relative path, so vite stays the only owner of class hashing.
 * @param packageDir - the package's own directory, normally the config's
 * `import.meta.dirname`; its `package.json` name is used in tsdown diagnostics.
 * @param libEntry - emitted JavaScript entries consumed from `lib/types`, one
 * bundle each: a multi-entry build would emit a hash-named shared chunk that
 * the exact `files` list cannot publish.
 * @returns ENV-selected tsdown config for the Client build face.
 * @throws {Error} when `<packageDir>/package.json` is unreadable or declares no name.
 */
export function staticLinked(packageDir: string, libEntry: readonly string[]): BuildFaceConfig {
  const id = readPackageManifest(packageDir).name
  // Each entry names its own output file, so two entries with the same basename
  // would overwrite one artifact instead of emitting two.
  const names = new Set(libEntry.map(entry => basename(entry, '.js')))
  if (names.size !== libEntry.length) {
    throw new Error(`tsdown: ${id} entries collide on an output name: ${libEntry.join(', ')}`)
  }
  return clientOnly(libEntry.map(entry => staticLinkedConfig(id, entry)))
}

/**
 * Whether a package's tsdown configs put it in the static assembly channel.
 * The roster has no separate list: gates load each package's own
 * `tsdown.config.ts`, call it for the Client face, and ask this.
 * @param configs - configs a package's build-face function returned.
 * @returns true when at least one config was built by {@link staticLinked}.
 */
export function isStaticLinkedConfig(configs: readonly UserConfig[]): boolean {
  return configs.some(config => (config.plugins as readonly { name?: string }[] | undefined ?? [])
    .some(plugin => plugin.name === STATIC_LINKED_PLUGIN))
}

/**
 * Build a Client-only Node library during the Client pass.
 * @param packageDir - The package's own directory, normally the config's
 * `import.meta.dirname`; its `package.json` name is used in tsdown diagnostics.
 * @param libEntry - Emitted JavaScript entries consumed from `lib/types`.
 * @returns ENV-selected tsdown config for the Client build face.
 * @throws {Error} when `<packageDir>/package.json` is unreadable or declares no name.
 */
export function clientLibrary(packageDir: string, libEntry: readonly string[]): BuildFaceConfig {
  const lib = clientLibraryConfig(readPackageManifest(packageDir), libEntry)
  return clientOnly([lib])
}

/**
 * Select arbitrary package-local configs only during the Client pass.
 * @param configs - Node-side configs emitted after Client tsc.
 * @returns ENV-selected tsdown config for the Client build face.
 */
export function clientOnly(configs: readonly UserConfig[]): BuildFaceConfig {
  return ({ env }) => buildFace(env?.DSH_BUILD_FACE) === 'host'
    ? [SKIP_WORKSPACE_BUILD]
    : [...configs]
}

interface ClientBundleOptions {
  /** Emit the Node-side artifacts during the Host pass instead of the Client pass. */
  readonly hostPhase?: boolean
  /** Emit independent ESM `client.node.js` and browser-factory `client.browser.js` from the same Client entry. */
  readonly dualClient?: boolean
  /** Additional Node-side configs emitted alongside the package library. */
  readonly companions?: readonly UserConfig[]
  /** Overrides for the package's primary Node-side library config. */
  readonly lib?: UserConfig
  /** Optional legal or attribution text selected by emitted client filename. */
  readonly clientBanner?: (fileName: string) => string | undefined
}

type BuildFace = 'host' | 'client' | undefined

type BuildFaceConfig = (inlineConfig: Pick<UserConfig, 'env'>) => UserConfig[]

function buildFace(value: unknown): BuildFace {
  if (value === undefined || value === 'host' || value === 'client') return value
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

function clientLibraryConfig(
  manifest: PackageManifest,
  libEntry: readonly string[],
  overrides: UserConfig = {},
): UserConfig {
  let externals: readonly RegExp[] | undefined
  const isProductionDependency = (specifier: string): boolean =>
    matchesSpecifier(externals ??= productionExternals(manifest), specifier)
  return {
    name: manifest.name,
    entry: [...libEntry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // Public client build values are fixed into the Node half as they are into the browser half.
    define: clientBuildValueDefines(process.env),
    deps: {
      // The Node half runs from a real install: a production dependency is on
      // disk there and stays an import, everything else inlines. Stating both
      // halves takes the artifact off tsdown's getProductionDeps fallback, where
      // moving a dependency between npm sections silently re-bundles it.
      // Builtins keep tsdown's own handling (neither side claims them).
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
    ...overrides,
  }
}

/** The slice of the rolldown plugin context the stylesheet plugin uses. */
interface AssetEmitter {
  emitFile(file: {
    type: 'asset'
    fileName: string
    source: Uint8Array
    originalFileName: string
  }): string
}

/** The slice of the rolldown plugin context that emits and watches one package asset. */
interface AssetContext extends AssetEmitter {
  addWatchFile(id: string): void
}

function staticLinkedConfig(id: string, entry: string, outputName = basename(entry, '.js')): UserConfig {
  const emitted = new Set<string>()
  const isolation = clientInputIsolation(id)
  return {
    name: id,
    entry: { [outputName]: entry },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // The shell compiles this artifact, so its map is the only path from a
    // browser stack frame back to the TSX (tsc emits the lib/types half).
    sourcemap: true,
    outputOptions: {
      sourcemapExcludeSources: false,
      sourcemapPathTransform: isolation.sourcePath,
    },
    plugins: [{
      // Contract 1. `pre` because tsdown's own deps plugin would otherwise
      // resolve and inline every specifier missing from the npm production
      // sections, which is the coupling this preset exists to remove. The name
      // is also the roster marker {@link isStaticLinkedConfig} reads.
      name: STATIC_LINKED_PLUGIN,
      resolveId: {
        order: 'pre' as const,
        handler(source: string, importer: string | undefined) {
          // An entry arrives without an importer and must stay internal.
          if (importer === undefined) return null
          return isBareSpecifier(source) ? { id: source, external: true } : null
        },
      },
    }, tscSourceMapPlugin(), isolation.plugin, {
      // Contract 4. The import survives verbatim and the sheet lands beside the
      // JavaScript, so the shell's CSS Modules pipeline sees a real stylesheet.
      name: 'dsh-css-asset',
      async resolveId(this: AssetEmitter, source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || importer === undefined) return null
        const { file, fileName } = stylesheetAsset(source, importer)
        if (!emitted.has(fileName)) {
          emitted.add(fileName)
          // originalFileName also puts the physical sheet in the watch graph.
          this.emitFile({ type: 'asset', fileName, source: await readFile(file), originalFileName: file })
        }
        // Every emitted chunk sits at the lib/ root, so the src-relative name
        // is what resolves from there. Rolldown keeps relative externals as
        // written instead of re-normalizing them.
        return { id: `./${fileName}`, external: true }
      },
    }],
  }
}

/** Whether a specifier names a package rather than a file next to its importer. */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('\0') && !isAbsolute(specifier)
}

/**
 * Locate a stylesheet import against the package sources and name its emitted position.
 * @param source - relative import specifier as written in the source.
 * @param importer - absolute path of the importing module, emitted or source.
 * @returns the stylesheet on disk plus its `src`-relative name under `lib/`.
 */
function stylesheetAsset(source: string, importer: string): { readonly file: string, readonly fileName: string } {
  const file = sourceAssetPath(source, importer)
  const boundary = file.lastIndexOf(SOURCE_MARKER)
  if (boundary < 0) throw new Error(`tsdown: stylesheet ${file} is outside the package sources`)
  return { file, fileName: file.slice(boundary + SOURCE_MARKER.length).split(sep).join('/') }
}

/** The manifest fields the build faces read to name the package and state its own module edges. */
interface PackageManifest {
  /** Package name: the tsdown config name, the Client loader id, and the diagnostic subject. */
  readonly name: string
  /** Sections a real install materializes on disk next to the built package. */
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  /** Package exports; the browser face emits assets only while `./assets/*` publishes `lib/assets`. */
  readonly exports?: Readonly<Record<string, unknown>>
  readonly dsh?: { readonly client?: { readonly external?: unknown } }
}

/**
 * Read the manifest of the package whose config calls a preset. The caller
 * passes its directory because tsdown evaluates every package config with the
 * repository root as `process.cwd()` during a workspace build.
 * @param packageDir - the package's own directory.
 * @returns the parsed manifest.
 * @throws {Error} when `package.json` is unreadable, is not JSON, or declares no string name.
 */
function readPackageManifest(packageDir: string): PackageManifest {
  const manifestPath = resolvePath(packageDir, 'package.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `tsdown: cannot read ${manifestPath}; pass the package directory (the import.meta.dirname of its tsdown.config.ts)`,
      { cause: error },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || !('name' in parsed) || typeof parsed.name !== 'string') {
    throw new Error(`tsdown: ${manifestPath} declares no string package name`)
  }
  return parsed as PackageManifest
}

/**
 * External patterns for one package's Node half: its own production sections,
 * subpaths included.
 * @param manifest - the package's own manifest.
 * @returns one `^name(/|$)` pattern per production dependency, name-sorted.
 */
function productionExternals(manifest: PackageManifest): readonly RegExp[] {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  return [...names].sort().map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
}

/**
 * Module-table specifiers one `dsh.client` declaration requests. Matching is
 * exact, never normalized: a package declares the specifier its own code
 * imports, and the loader keys static entries the same way.
 * @param subject - package name, used in diagnostics.
 * @param declaration - the package's `dsh.client` object.
 * @returns the requested specifiers, empty when the package declares none.
 * @throws {Error} when `external` is not a string array.
 */
export function requestedExternals(
  subject: string,
  declaration: { readonly external?: unknown },
): ReadonlySet<string> {
  return new Set(optionalStringArray(subject, 'dsh.client.external', declaration.external) ?? [])
}

/**
 * Module-table specifiers one package requests. The shell baseline is implicit
 * for every dynamic bundle; `dsh.client.external` only adds package-specific
 * dynamic rows or subpaths.
 * @param manifest - the package's own manifest, whose `dsh.client` declaration adds requests.
 * @returns the baseline plus the package's explicit requests.
 */
function clientExternals(manifest: PackageManifest): ReadonlySet<string> {
  return new Set([
    ...PLATFORM_MODULES,
    ...PRELOADED_CLIENT_EXTERNALS,
    ...requestedExternals(manifest.name, manifest.dsh?.client ?? {}),
  ])
}

/** Escape a package name for literal use inside a RegExp source. */
function escapeSpecifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether an import specifier is the package a pattern names, or one of its subpaths. */
function matchesSpecifier(patterns: readonly RegExp[], specifier: string): boolean {
  return patterns.some(pattern => pattern.test(specifier))
}

/** Render package-local dynamic imports through the Client module loader's asynchronous operation. */
function asyncChunkRequirePlugin(): TsdownPlugin {
  return {
    name: 'dsh-client-async-chunk-require',
    renderChunk(code, chunk, outputOptions) {
      if (outputOptions.format !== 'cjs') return null
      const transformed = new Rolldown.RolldownMagicString(code)
      for (const dynamicImport of chunk.dynamicImports) {
        const fileName = dynamicImport.startsWith('./') ? dynamicImport.slice(2) : dynamicImport
        if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(fileName)) continue
        const specifier = `./${fileName}`
        const call = new RegExp(
          `Promise\\.resolve\\(\\)\\.then\\(\\(\\)\\s*=>\\s*require\\((['"])${escapeSpecifier(specifier)}\\1\\)\\)`,
          'gu',
        )
        const matches = [...code.matchAll(call)]
        if (matches.length === 0) {
          throw new Error(`client bundle compiler: dynamic chunk ${JSON.stringify(specifier)} has no generated import expression`)
        }
        for (const match of matches) {
          transformed.overwrite(match.index, match.index + match[0].length, `require.async(${JSON.stringify(specifier)})`)
        }
      }
      return transformed.hasChanged() ? transformed : null
    },
    async writeBundle(outputOptions, bundle) {
      const entry = Object.values(bundle).find(output => output.type === 'chunk' && output.isEntry)
      if (entry === undefined || outputOptions.dir === undefined) return
      const entryPath = resolvePath(outputOptions.dir, entry.fileName)
      const current = await stat(entryPath)
      const completedAt = new Date(Math.max(Date.now(), current.mtimeMs + 1))
      await utimes(entryPath, current.atime, completedAt)
    },
  }
}

/** Emitted asset directory below the browser config's `lib` outDir, published as {@link PACKAGE_ASSET_FILES_ENTRY}. */
const ASSET_OUTPUT_DIR = posix.relative('lib', PACKAGE_ASSET_FILES_ENTRY)

/** Characters the asset route rejects in a decoded path segment, because Node resolves export subpaths as URL text. */
const UNSERVABLE_ASSET_SEGMENT = /[%#?\\\0]/

/** A `url()` value with a scheme, such as `data:` or `https:`, which names no package file. */
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i

/**
 * Free identifier an asset reference compiles to before rendering; the CommonJS
 * render turns each call into `require.asset(...)`, the module loader's
 * synchronous asset resolver, which returns the reference unchanged unless its
 * carrier maps it. The fixed hexadecimal suffix keeps plugin strings that happen
 * to contain the shorter prefix out of that rewrite, and keeps the source maps
 * that carry the loaded module text byte-stable across builds.
 */
const PACKAGE_ASSET_CALL = '__dshPackageAsset_5f8e2c1a9b7d'

/** Compile one asset reference into the resolver call. */
function packageAssetCall(reference: string): string {
  return `${PACKAGE_ASSET_CALL}(${JSON.stringify(reference)})`
}

/**
 * Compile stylesheet text into a JavaScript expression that passes each package-asset
 * reference the `url()` rewrite inserted through the resolver call. The rewrite writes
 * a placeholder of letters, digits, and underscores, which lightningcss never escapes,
 * with a per-stylesheet random part that stylesheet text cannot contain by chance.
 * A placeholder may appear several times or not at all, as when minification copies
 * or drops a declaration.
 * @param css - stylesheet text after the rewrite.
 * @param references - reference of each placeholder the rewrite inserted into this stylesheet.
 * @returns a string literal, or a concatenation of literals and resolver calls.
 */
function stylesheetSource(css: string, references: ReadonlyMap<string, string>): string {
  if (references.size === 0) return JSON.stringify(css)
  const parts: string[] = []
  let last = 0
  for (const match of css.matchAll(new RegExp([...references.keys()].join('|'), 'gu'))) {
    parts.push(JSON.stringify(css.slice(last, match.index)), packageAssetCall(references.get(match[0]) as string))
    last = match.index + match[0].length
  }
  parts.push(JSON.stringify(css.slice(last)))
  return parts.join(' + ')
}

/** One stylesheet's `url()` rewrite: the lightningcss options and the references they insert while transforming. */
interface StylesheetAssets {
  /** lightningcss options; empty when the stylesheet lies outside the package's own `src`. */
  readonly options: { readonly visitor?: Visitor<CustomAtRules> }
  /** Reference of each placeholder inserted during the transform that uses {@link options}. */
  readonly references: ReadonlyMap<string, string>
}

/** Browser-face package assets: the import plugin and the stylesheet `url()` rewrite share one per-build emission record. */
interface PackageAssets {
  /** `dsh-package-asset`: resolves asset imports, emits referenced files, and prunes stale `lib/assets` files after writing. */
  readonly plugin: TsdownPlugin
  /**
   * Select the lightningcss options that rewrite one stylesheet's relative `url()` values.
   * @param context - plugin context of the stylesheet loader, which emits each referenced asset.
   * @param stylesheet - physical stylesheet path.
   * @returns a `url()` visitor when the stylesheet lies inside the package's own `src`, otherwise no options,
   *   and the references the visitor inserts.
   * @throws {Error} from the visitor when a relative `url()` does not name a publishable package asset.
   */
  urlRewrite(context: AssetContext, stylesheet: string): StylesheetAssets
}

/**
 * Build the package-asset rules of one dynamic browser bundle. A referenced
 * file must lie under the package's own `src/client/assets/`, have a supported
 * extension, and be published by the `./assets/*` export; it is emitted once
 * per build under `lib/assets/` at its relative path with the content revision
 * inserted before the extension, and the reference compiles to the module loader's
 * synchronous resolver call on its document-relative URL.
 * A one-shot build deletes files under `lib/assets/` that it did not emit; a
 * watch build keeps them for pages still running an earlier generation.
 * @param manifest - the package's own manifest, naming the URL owner and declaring the asset export.
 * @param packageDir - the package's own directory.
 * @returns the plugin and stylesheet visitor sharing the per-build emission record.
 */
function packageAssets(manifest: PackageManifest, packageDir: string): PackageAssets {
  const name = manifest.name
  const sourceDir = resolvePath(packageDir, 'src')
  const assetsDir = resolvePath(sourceDir, 'client', 'assets')
  /** Reference of every asset emitted in the current build, keyed by its real path. */
  const references = new Map<string, string>()

  const reference = (context: AssetContext, file: string): string => {
    let realPath: string
    try {
      realPath = realpathSync(file)
    } catch (error) {
      throw new Error(`tsdown: ${name}: cannot resolve asset ${file}`, { cause: error })
    }
    const emitted = references.get(realPath)
    if (emitted !== undefined) return emitted
    const below = pathBelow(realDirectory(assetsDir), realPath)
    if (below === undefined) throw new Error(`tsdown: ${name}: ${file} is outside src/client/assets; move the asset there`)
    const assetPath = below.split(sep).join('/')
    if (assetPath.split('/').some(segment => UNSERVABLE_ASSET_SEGMENT.test(segment) || segment.toLowerCase() === 'node_modules')) {
      throw new Error(`tsdown: ${name}: ${file} has a node_modules path segment or one containing %, #, ?, \\ or NUL, which the asset route cannot serve; rename it`)
    }
    const extension = posix.extname(assetPath)
    if (extension !== extension.toLowerCase()) {
      throw new Error(`tsdown: ${name}: ${file} has an uppercase extension; asset imports are typed by lowercase extensions, so rename it`)
    }
    if (manifest.exports?.[PACKAGE_ASSET_EXPORT] !== PACKAGE_ASSET_EXPORT_TARGET) {
      throw new Error(
        `tsdown: ${name}: ${file} needs package.json exports ${JSON.stringify({ [PACKAGE_ASSET_EXPORT]: PACKAGE_ASSET_EXPORT_TARGET })} `
        + `and ${JSON.stringify(PACKAGE_ASSET_FILES_ENTRY)} in files`,
      )
    }
    if (packageAssetMediaType(assetPath) === undefined) {
      throw new Error(`tsdown: ${name}: ${file} is not a supported asset; supported extensions: ${[...PACKAGE_ASSET_MEDIA_TYPES.keys()].join(', ')}`)
    }
    const bytes = readFileSync(realPath)
    const emittedPath = packageAssetRevisionedPath(assetPath, packageAssetRevision(bytes))
    context.emitFile({ type: 'asset', fileName: `${ASSET_OUTPUT_DIR}/${emittedPath}`, source: bytes, originalFileName: realPath })
    context.addWatchFile(realPath)
    const url = packageAssetReference(name, emittedPath)
    references.set(realPath, url)
    return url
  }

  return {
    plugin: {
      name: 'dsh-package-asset',
      buildStart() { references.clear() },
      resolveId(source, importer) {
        if (importer === undefined || packageAssetMediaType(source) === undefined) return null
        return sourceAssetPath(source, importer)
      },
      load(id) {
        if (!isAbsolute(id) || packageAssetMediaType(id) === undefined) return null
        return `export default ${packageAssetCall(reference(this, id))};`
      },
      renderChunk(code, _chunk, outputOptions) {
        if (outputOptions.format !== 'cjs' || !code.includes(PACKAGE_ASSET_CALL)) return null
        const transformed = new Rolldown.RolldownMagicString(code)
        for (const match of code.matchAll(new RegExp(`\\b${PACKAGE_ASSET_CALL}\\(`, 'gu'))) {
          transformed.overwrite(match.index, match.index + match[0].length, 'require.asset(')
        }
        return transformed
      },
      async writeBundle(outputOptions, bundle) {
        // A watch rebuild keeps earlier files: the Host still serves the previous
        // bundle generation, and pages running it request those asset names.
        if (this.meta.watchMode || outputOptions.dir === undefined) return
        const outDir = outputOptions.dir
        const assets = resolvePath(outDir, ASSET_OUTPUT_DIR)
        if (!existsSync(assets)) return
        await pruneDirectory(assets, file => relative(outDir, file).split(sep).join('/') in bundle)
      },
    },
    urlRewrite(context, stylesheet) {
      const inserted = new Map<string, string>()
      const nonce = randomBytes(6).toString('hex')
      if (pathBelow(realDirectory(sourceDir), realpathSync(stylesheet)) === undefined) return { options: {}, references: inserted }
      const base = dirname(stylesheet)
      const rewrite = (url: Url): Url | undefined => {
        // Empty values, fragments, root-relative paths, schemes such as `data:`, and placeholders name no package file.
        if (url.url === '' || url.url.startsWith('#') || url.url.startsWith('/') || URL_SCHEME.test(url.url)) return undefined
        if (inserted.has(url.url)) return undefined
        if (/[#?]/u.test(url.url)) {
          throw new Error(`tsdown: ${name}: ${stylesheet} references ${JSON.stringify(url.url)}; a package asset url() takes no fragment or query`)
        }
        const placeholder = `__dshPackageAsset_${nonce}_${String(inserted.size)}__`
        inserted.set(placeholder, reference(context, resolvePath(base, url.url)))
        return { ...url, url: placeholder }
      }
      return {
        options: {
          visitor: {
            Url: url => rewrite(url),
            // lightningcss does not visit the urls inside image-set(), so its options are rewritten here.
            Image(image) {
              if (image.type !== 'image-set') return undefined
              const options = image.value.options.map((option) => {
                const url = option.image.type === 'url' ? rewrite(option.image.value) : undefined
                return url === undefined ? option : { ...option, image: { type: 'url' as const, value: url } }
              })
              return { ...image, value: { ...image.value, options } }
            },
          },
        },
        references: inserted,
      }
    },
  }
}

/** Real path of an existing directory, or undefined when it does not exist. */
function realDirectory(directory: string): string | undefined {
  return existsSync(directory) ? realpathSync(directory) : undefined
}

/**
 * Locate a real path strictly inside a real directory.
 * @param root - real directory path, or undefined when the directory does not exist.
 * @param file - real file path.
 * @returns the platform-separated path of `file` below `root`, or undefined when it is not inside.
 */
function pathBelow(root: string | undefined, file: string): string | undefined {
  if (root === undefined) return undefined
  const path = relative(root, file)
  return path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) ? undefined : path
}

/**
 * Delete every file a predicate rejects below a directory, then every directory left empty.
 * @param directory - directory to prune; removed itself when nothing remains.
 * @param keep - whether a file path survives.
 * @returns whether the directory was removed.
 */
async function pruneDirectory(directory: string, keep: (file: string) => boolean): Promise<boolean> {
  let remaining = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!(await pruneDirectory(path, keep))) remaining++
    } else if (keep(path)) {
      remaining++
    } else {
      await rm(path)
    }
  }
  if (remaining > 0) return false
  await rmdir(directory)
  return true
}

/**
 * Reject asset imports in a Node Client face, which has no asset route.
 * @param id - package name, used in diagnostics.
 * @returns a plugin whose resolveId throws for every supported asset extension.
 */
function browserOnlyAssets(id: string): TsdownPlugin {
  return {
    name: 'dsh-package-asset-browser-only',
    resolveId(source) {
      if (packageAssetMediaType(source) === undefined) return null
      throw new Error(`tsdown: ${id}: asset imports are browser-only (${source})`)
    },
  }
}

/** Bundle the Client entry for plain Node independently of the Host entry and browser factory. */
function nodeClientConfig(manifest: PackageManifest, entry: string): UserConfig {
  const isolation = clientInputIsolation(manifest.name)
  return clientLibraryConfig(manifest, [entry], {
    name: `${manifest.name}/client-node`,
    entry: { 'client.node': entry },
    sourcemap: true,
    inputOptions: { resolve: { conditionNames: ['node', 'import', 'module', 'default'] } },
    plugins: [browserOnlyAssets(manifest.name), tscSourceMapPlugin(), isolation.plugin],
    outputOptions: {
      entryFileNames: 'client.node.js',
      chunkFileNames: 'client.node.[name].js',
      sourcemapExcludeSources: false,
      sourcemapPathTransform: isolation.sourcePath,
    },
  })
}

function clientConfig(
  manifest: PackageManifest,
  packageDir: string,
  entry: string,
  clientBanner?: (fileName: string) => string | undefined,
  dualClient = false,
): UserConfig {
  const id = manifest.name
  let requested: ReadonlySet<string> | undefined
  const isRequested = (specifier: string): boolean => (requested ??= clientExternals(manifest)).has(specifier)
  const isolation = clientInputIsolation(id)
  const assets = packageAssets(manifest, packageDir)
  return {
    name: `${id}/client`,
    entry: { client: entry },
    // Browser bundle lands beside the Node artifacts. clean must stay off:
    // cleaning this invocation would wipe the independently emitted Node entry.
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // Types ship from lib/types (tsc); dts here would wrap the banner/footer into .d.cts and break parsing.
    dts: false,
    // Plugin code is fetched outside Vite's module graph, so its own bundle
    // must carry the TS/TSX mapping consumed by browser profiling tools.
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      // Anything NOT requested from the loader module table must inline
      // (wire/type layers, clsx — every non-shared dep). A require() the
      // table cannot answer is a guaranteed runtime throw, so the rule is the
      // package's own request list: requested specifiers stay imports,
      // everything else is bundled.
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    // Dual-mode libraries (lexical's exports carry development/production/
    // node conditions; the node file picks its flavor with a top-level await
    // a CJS bundle cannot carry) resolve their static flavor matching the
    // NODE_ENV the defines below bake in.
    inputOptions: {
      resolve: {
        conditionNames: [
          (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
          'browser', 'import', 'module', 'default',
        ],
      },
    },
    // Browser bundles inline node-idiom deps (zustand/immer read
    // process.env.NODE_ENV; zustand's esm build also probes
    // import.meta.env.MODE, which a CJS output cannot carry — rolldown flags
    // EMPTY_IMPORT_META). vite defined both on the seed path; tsdown inlining
    // needs the substitutions here or the factory throws ReferenceError at
    // boot / the build gate reds. Both keys honor the build's NODE_ENV so a
    // dev build keeps the dev-branch semantics; artifacts default to production.
    // The bare `import.meta.env` key is required alongside the precise MODE
    // key: zustand probes `import.meta.env ? import.meta.env.MODE : ...`, and
    // the truthiness probe would otherwise survive as an empty import.meta.
    define: {
      ...clientBuildEnvironmentDefines(process.env),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      // Bundle purity gate (build-time mirror of the module-edge rules): the
      // baseline and package-specific requests stay external, inline-safe wire layers
      // inline, and every other @deepseek-ai value import is a build error — a
      // cross-plugin value import either inlines a duplicate runtime instance
      // or requires a specifier the module table cannot answer for this package.
      // Cross-plugin collaboration goes through cordis services instead.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null // requested module-table row: external wins
        if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${id}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
    }, tscSourceMapPlugin(), asyncChunkRequirePlugin(), isolation.plugin, {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const stylesheetAssets = assets.urlRewrite(this, fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
          ...stylesheetAssets.options,
        })
        const classMap: Record<string, string> = {}
        const exportEntries = Object.entries(cssExports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        for (const [local, exp] of exportEntries) classMap[local] = exp.name
        return styleInjectionModule(id, fileId, stylesheetSource(code.toString(), stylesheetAssets.references), classMap)
      },
    }, {
      name: 'dsh-css-text-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
        const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
        const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
        return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const stylesheetAssets = assets.urlRewrite(this, fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true, ...stylesheetAssets.options })
        return `export default ${stylesheetSource(code.toString(), stylesheetAssets.references)};`
      },
    }, {
      name: 'dsh-css-global-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const stylesheetAssets = assets.urlRewrite(this, fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true, ...stylesheetAssets.options })
        return styleInjectionModule(id, fileId, stylesheetSource(code.toString(), stylesheetAssets.references))
      },
    }, assets.plugin],
    outputOptions: {
      entryFileNames: dualClient ? 'client.browser.js' : 'client.js',
      // The imported source basename becomes the published chunk name; package
      // files lists and artifact tests pin every intentional chunk.
      chunkFileNames: dualClient ? 'client.browser.[name].js' : 'client.[name].js',
      sourcemapExcludeSources: false,
      // The map is served from /plugins/<scoped-package>/client.js.map. The
      // browser resolves its local sources back into URLs that mirror the
      // /packages/<group>/<package>/src directories; sourcesContent keeps them usable
      // without exposing that tree as an HTTP route.
      sourcemapPathTransform(source, mapPath) {
        isolation.sourcePath(source, mapPath)
        return browserSourcePath(source, mapPath)
      },
      banner: (chunk) => {
        const registration = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`
        const prefix = clientBanner?.(chunk.fileName)
        return prefix === undefined ? registration : `${prefix}\n${registration}`
      },
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/** Check browser bundle inputs before their original package identity is folded into an artifact. */
function clientInputIsolation(id: string): {
  plugin: TsdownPlugin
  sourcePath: (source: string, mapPath: string) => string
} {
  const experimental = isExperimentalPackageName(id)
  const inputs = new BundleInputIsolation(REPOSITORY_ROOT, `client bundle isolation (${id})`)
  return {
    plugin: {
      name: 'dsh-client-input-isolation',
      buildStart() { inputs.reset() },
      generateBundle(_options, bundle) {
        if (experimental) return
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') {
            for (const module of Object.keys(output.modules)) {
              inputs.assertInput(clientInputFile(module))
              const info = this.getModuleInfo(module)
              if (info === null) {
                // Rolldown's runtime helper is compiler-generated and has no source module record.
                if (module === '\0rolldown/runtime.js') continue
                throw new Error(`client bundle isolation (${id}): module ${module} has no bundler module record`)
              }
              for (const dependency of [...info.importedIds, ...info.dynamicallyImportedIds]) {
                inputs.assertInput(clientInputFile(dependency))
              }
            }
            for (const external of [...output.imports, ...output.dynamicImports]) {
              if (!(external in bundle)) inputs.assertInput(external)
            }
          } else {
            for (const original of output.originalFileNames) inputs.assertInput(original)
          }
        }
      },
    },
    sourcePath(source, mapPath) {
      if (!experimental) {
        const decoded = clientInputFile(source)
        const file = physicalBundleInput(decoded) ?? resolvePath(dirname(mapPath), decoded)
        inputs.assertSourceMapInput(file)
      }
      return source
    },
  }
}

/** CSS loader ids append a JavaScript suffix to the physical stylesheet path. */
function clientInputFile(id: string): string {
  const prefix = [CSS_VIRTUAL_PREFIX, GLOBAL_CSS_VIRTUAL_PREFIX, INLINE_CSS_VIRTUAL_PREFIX]
    .find(prefix => id.startsWith(prefix))
  return prefix === undefined ? id : id.slice(prefix.length, -CSS_VIRTUAL_SUFFIX.length)
}

/** Chain tsc's emitted maps into any Client bundle that consumes `lib/types`. */
function tscSourceMapPlugin() {
  return {
    name: 'dsh-tsc-sourcemap',
    async load(id: string) {
      if (!id.includes(TYPES_MARKER) || !id.endsWith('.js') || !existsSync(`${id}.map`)) return null
      const code = await readFile(id, 'utf8')
      const mapPath = `${id}.map`
      const map = JSON.parse(await readFile(mapPath, 'utf8')) as {
        sourceRoot?: unknown
        sources?: unknown
        sourcesContent?: unknown
        [key: string]: unknown
      }
      if (!Array.isArray(map.sources) || map.sources.some(source => typeof source !== 'string')) {
        throw new Error(`client sourcemap: ${mapPath} has invalid sources`)
      }
      const sources = map.sources as string[]
      if (
        !Array.isArray(map.sourcesContent)
        || map.sourcesContent.length !== sources.length
        || map.sourcesContent.some(source => typeof source !== 'string')
      ) {
        const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
        map.sourcesContent = await Promise.all(sources.map(async source =>
          await readFile(resolvePath(dirname(mapPath), sourceRoot, source), 'utf8')))
      }
      return { code: code.replace(SOURCEMAP_COMMENT, ''), map }
    },
  }
}

/** Path segment separating a package's tsc output from the sources it was emitted from. */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/** Plugin name carrying contract 1, and the marker that identifies a statically linked config. */
const STATIC_LINKED_PLUGIN = 'dsh-static-linked-external'

/** Path segment a package's sources hang under, and the root emitted assets mirror. */
const SOURCE_MARKER = `${sep}src${sep}`

/** Trailing sourcemap reference tsc appends to every emitted module. */
const SOURCEMAP_COMMENT = /\n\/\/# sourceMappingURL=.*\s*$/

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  if (!source.startsWith('.') && !isAbsolute(source)) return createRequire(importer).resolve(source)
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}

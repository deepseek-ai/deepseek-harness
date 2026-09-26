/**
 * VFS image packer: turns one composed profile plus a package index into the single
 * gzip-compressed tar the browser runtime inflates and mounts as its filesystem.
 *
 * Nothing is compiled here. The image carries the repository's real build products,
 * so a preview deployment debugs exactly what the served deployment ships. What the
 * pass does add is the pack-time module transform and the manifest that records the
 * wrapper contract it was transformed against.
 *
 * This module holds no repository knowledge: paths, globs, and the composition come
 * in as parameters, so the same library packs a different tree by being called
 * differently. Locating those inputs is the CLI's job.
 * @module @deepseek-ai/dsh-experimental-webworker-packer/src/pack
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  lowerModuleSource, MemoryVfs, packTar, WorkerModuleLoader,
  DEFAULT_ROOT, IMAGE_CONFIG_PATH, IMAGE_EMPTY_DIRECTORIES, IMAGE_MANIFEST_PATH,
  IMAGE_OVERLAY_DIRECTORIES,
  MODULE_PROXIES, MODULE_PROXY_PREFIXES, REPLACED_EXTERNAL_PACKAGES,
} from '@deepseek-ai/dsh-experimental-webworker-runtime'
import picomatch from 'picomatch'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { WRAPPER_CONTRACT, type ImageFiles, type TransformOutcome } from './transform-image.ts'
import { EXCLUDE, EXCLUDE_WORKSPACE, IMAGE_ENTRY_SEEDS, PAGE_ASSETS } from './rules.ts'

export { DEFAULT_ROOT } from '@deepseek-ai/dsh-experimental-webworker-runtime'

/** Image path of the manifest; the layout contract's name, re-exported for callers. */
export const MANIFEST_PATH: string = IMAGE_MANIFEST_PATH

/** Image path of the composed profile; the layout contract's name, re-exported for callers. */
export const CONFIG_PATH: string = IMAGE_CONFIG_PATH

/**
 * Manifest field the runtime judges the image by: the wrapper contract every packed
 * body was emitted against. The runtime refuses an image whose value is not its own
 * contract, because those bodies assume different wrapper semantics.
 */
const CONTRACT_FIELD = 'lowered'

/** Exclude matcher over tree-root-relative paths ({@link EXCLUDE}). */
const excluded = picomatch([...EXCLUDE], { dot: true })

/** Workspace exclude matcher: {@link EXCLUDE} plus {@link EXCLUDE_WORKSPACE}. */
const workspaceExcluded = picomatch([...EXCLUDE, ...EXCLUDE_WORKSPACE], { dot: true })

/** Page-asset matcher over image paths ({@link PAGE_ASSETS}). */
const pageAsset = picomatch([...PAGE_ASSETS], { dot: true })

/** One directory tree to copy into the image at a caller-selected mount. */
export interface ImageTree {
  /** Image path to mount it at, relative to the virtual root. */
  readonly mount: string
  /** Absolute source directory. */
  readonly directory: string
}

/** One configuration tree whose plugin rows may extend the package roster. */
export interface ConfigTree extends ImageTree {
  /**
   * Whether plugin names inside its `.yml` files join the materialization closure.
   * An agent preset mounts plugins the base composition never lists, and creating a
   * session fails if any of them is missing from the image.
   */
  readonly scanRoster?: boolean
}

/** Everything the packer needs that it cannot know by itself. */
export interface PackOptions {
  /** Composed profile, `!!js` intact, as the CLI's `--dump-default-config` produced it. */
  readonly config: string
  /** Profile name, recorded in the manifest. */
  readonly profile: string
  /** Virtual root the image mounts under; defaults to {@link DEFAULT_ROOT}. */
  readonly root?: string
  /** Package name to absolute directory, for workspace and vendored packages. */
  readonly workspaces: ReadonlyMap<string, string>
  /** Directory Node-style dependency resolution walks up from for the roster. */
  readonly resolveFrom: string
  /** Config trees to copy in beside the composition. */
  readonly configTrees?: readonly ConfigTree[]
  /** Empty directories to create; defaults to `home/`, `workspace/`, `tmp/`. */
  readonly emptyDirectories?: readonly string[]
  /**
   * Extra sweep roots: image specifiers requested by code outside the image.
   * Defaults to the worker assembly's own entries.
   */
  readonly entries?: readonly string[]
}

/** What one pack produced, for the caller to report or assert on. */
export interface PackResult {
  /** The gzip-compressed tar archive to write; the runtime inflates it at mount. */
  readonly image: Uint8Array
  /** Every entry, before zipping; the manifest is already among them. */
  readonly files: ImageFiles
  /** Package name to how many files it contributed, in materialization order. */
  readonly packages: ReadonlyMap<string, number>
  /** How many of them came from the workspace rather than from `node_modules`. */
  readonly workspacePackages: number
  /** Roster package names the closure started from. */
  readonly roster: readonly string[]
  /** Dependencies that did not resolve; a non-empty list means an incomplete image. */
  readonly missing: readonly string[]
  /** Executable scripts dropped from the image. */
  readonly executables: readonly string[]
  /** Page bundles left out of the transform; like every JavaScript entry they carry the trailing debugger name. */
  readonly pageBundles: readonly string[]
  /** JavaScript entries the image carries. */
  readonly javascriptEntries: number
  /** JavaScript candidates no root reaches, dropped from the image. */
  readonly droppedJavascriptEntries: number
  /** Third-party requests that resolve nowhere; loud at require time if hit. */
  readonly unresolvedExternalRequests: readonly string[]
  /** What the pack-time transform did. */
  readonly transform: TransformOutcome
  /** Wrapper contract recorded in the manifest; every packed body meets it. */
  readonly contract: string
}

/** One deterministic data-overlay archive and its uncompressed entries. */
export interface PackOverlayResult {
  /** Gzip-compressed ustar bytes consumed by the Worker host. */
  readonly image: Uint8Array
  /** Every path in the overlay before compression. */
  readonly files: ImageFiles
}

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

/**
 * Package name of a module specifier.
 * @param specifier - Module specifier, possibly with a subpath.
 * @returns The package name (`@scope/pkg/sub` → `@scope/pkg`).
 */
function packageNameOf(specifier: string): string {
  const [first = specifier, second = ''] = specifier.split('/')
  return first.startsWith('@') ? `${first}/${second}` : first
}

/**
 * Collect module-specifier `name` fields from parsed entry rows, recursively
 * through nested `config` row lists (groups). Builtin rows (`cordis:group`)
 * and preset metadata documents carry names that are not module specifiers;
 * only names with a scope or a path separator count.
 * @param rows - Parsed YAML value; anything but an entry array is ignored.
 * @param names - Package names collected so far.
 */
function moduleNamesOf(rows: unknown, names: Set<string>): void {
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const { name, config } = row as { name?: unknown; config?: unknown }
    if (typeof name === 'string' && (name.startsWith('@') || name.includes('/'))) {
      names.add(packageNameOf(name))
    }
    moduleNamesOf(config, names)
  }
}

/**
 * Package names the composition names.
 * @param config - Composed profile; `!!js` scalars parse under Include's dialect.
 * @returns Package names, deduplicated.
 */
function rosterOf(config: string): string[] {
  const names = new Set<string>()
  moduleNamesOf(yaml.load(config, { schema: entryListSchema }), names)
  return [...names]
}

/**
 * Package names the compositions under one config tree name.
 * @param root - Directory to walk.
 * @returns Package names, deduplicated.
 */
function treeRosterOf(root: string): string[] {
  const names = new Set<string>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue
      moduleNamesOf(yaml.load(readFileSync(absolute, 'utf8'), { schema: entryListSchema }), names)
    }
  }
  walk(root)
  return [...names]
}

/**
 * Resolve one dependency the way Node does: walk up from the importer.
 * @param fromDirectory - Directory to start at.
 * @param name - Package name.
 * @returns The real path of the package directory, or undefined.
 */
function resolveDependency(fromDirectory: string, name: string): string | undefined {
  let directory = fromDirectory
  for (;;) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Collect files under one directory. Traversal mechanics live here — nested
 * package/config collection flattens nested `node_modules` and prunes dot
 * directories, while seed collection preserves every directory. Every file
 * judgement comes in through `keep` (the {@link EXCLUDE} tables and the npm
 * publish view, or an unconditional seed predicate).
 * @param root - Source directory.
 * @param into - Image entries to add to.
 * @param prefix - Image path prefix.
 * @param keep - Filter over root-relative paths.
 * @param preserveDirectories - Whether dot directories and nested `node_modules`
 *   are ordinary fixture content rather than package-manager residue.
 */
function collectTree(
  root: string,
  into: ImageFiles,
  prefix: string,
  keep: (relativePath: string) => boolean,
  preserveDirectories = false,
): void {
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!preserveDirectories && (entry.name === 'node_modules' || entry.name.startsWith('.'))) continue
        walk(join(directory, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const absolute = join(directory, entry.name)
      const relativePath = relative(root, absolute).replaceAll('\\', '/')
      if (!keep(relativePath)) continue
      into[`${prefix}/${relativePath}`] = readFileSync(absolute)
    }
  }
  walk(root)
}

/**
 * Predicate for npm's `files` allowlist, with standard glob semantics
 * (picomatch). A pattern admits the path itself and everything under it, so a
 * bare directory name publishes its whole tree; `!` patterns subtract from the
 * admitted set; package.json is always published.
 * @param patterns - The package.json `files` array.
 * @returns Predicate over package-root-relative paths.
 */
function publishedFilter(patterns: readonly unknown[]): (path: string) => boolean {
  const strings = patterns.filter((pattern): pattern is string => typeof pattern === 'string')
  const normalize = (pattern: string): string => pattern.replace(/^\.\//, '').replace(/\/+$/, '')
  const widen = (pattern: string): string[] => [pattern, `${pattern}/**`]
  const positive = strings.filter(pattern => !pattern.startsWith('!')).map(normalize).flatMap(widen)
  const negative = strings.filter(pattern => pattern.startsWith('!')).map(pattern => normalize(pattern.slice(1))).flatMap(widen)
  const admits = picomatch(positive, { dot: true })
  const denies = negative.length > 0 ? picomatch(negative, { dot: true }) : (): boolean => false
  return path => path === 'package.json' || (admits(path) && !denies(path))
}

/** What the reachability sweep kept, transformed, and dropped. */
interface SweepOutcome {
  readonly swept: ImageFiles
  readonly transform: TransformOutcome
  readonly javascriptEntries: number
  readonly droppedJavascriptEntries: number
  /** Third-party requests that resolve nowhere; loud at require time if hit. */
  readonly unresolvedExternalRequests: readonly string[]
}

/**
 * Keep only the JavaScript the worker can reach, transforming it on the way.
 *
 * Roots are the export faces of every materialized workspace and vendored
 * package — the harness addresses them by constructed name at runtime (Loader
 * rows, typert faces, delegating providers such as `-auto` pickers), so the
 * sweep prunes files only inside third-party packages — plus the worker
 * assembly's own image entries. Resolution runs the runtime loader's own
 * algorithm over the candidate set, so pack-time reachability and boot-time
 * resolution cannot drift, and a request that resolves nowhere — an undeclared
 * or missing dependency — fails the pack rather than the boot.
 *
 * Two entry classes stay out of the walk by rule: page assets
 * ({@link PAGE_ASSETS}) are evaluated by the page's module system, and
 * non-JavaScript entries always stay because data reads go through fs paths
 * this pass cannot see.
 * @param files - Candidate entries after the publish-view filter.
 * @param options - Pack options carrying the sweep roots.
 * @param rootPackages - Roster package names from the workspace.
 * @param root - Virtual root the candidates mount under.
 * @returns The final entries plus the sweep's counts.
 */
/** Trailing `sourceMappingURL` comment; the image carries no `.map` files. */
const DANGLING_SOURCE_MAP = /\n\/\/# sourceMappingURL=\S+\s*$/

/**
 * Name one JavaScript entry for the debugger: append the `sourceURL` magic
 * comment V8 stacks and DevTools read, so the entry shows under its
 * repository path instead of as an anonymous VM script (worker `new Function`
 * bodies) or blob entry (page bundles). A trailing `sourceMappingURL` comment
 * is stripped first — its `.map` never ships, and once the script has a name
 * the debugger would resolve the reference against it and report a load
 * failure per script. Only the final line is touched, so every other line
 * keeps its number; evaluation cost stays at pack time, where the names are
 * already deterministic.
 * @param bytes - Entry body as the image would otherwise hold it.
 * @param name - Debugger name for the entry.
 * @param decoder - Shared UTF-8 decoder.
 * @param encoder - Shared UTF-8 encoder.
 * @returns The named body.
 */
function nameForDebugger(bytes: Uint8Array, name: string, decoder: TextDecoder, encoder: TextEncoder): Uint8Array {
  const source = decoder.decode(bytes).replace(DANGLING_SOURCE_MAP, '\n')
  return encoder.encode(`${source}\n//# sourceURL=${name}`)
}

/**
 * Debugger names for image entries: a workspace or vendored package file is
 * named by its repository path (`packages/<group>/<pkg>/lib/index.js`), the
 * shape a reader navigates; an external package file keeps its image key —
 * it has no repository path, and its pnpm store path would name a hash.
 * @param workspaces - Package name → absolute repository directory.
 * @param resolveFrom - Repository root the names are relative to.
 * @returns Mapper from an image key to the entry's debugger name.
 */
function debuggerNamer(workspaces: ReadonlyMap<string, string>, resolveFrom: string): (key: string) => string {
  const repoDirs = new Map(
    [...workspaces].map(([name, directory]) => [name, relative(resolveFrom, directory).replaceAll('\\', '/')]),
  )
  return (key: string): string => {
    if (!key.startsWith('node_modules/')) return key
    const rest = key.slice('node_modules/'.length)
    const segments = rest.split('/')
    const packageName = segments[0]?.startsWith('@') === true ? segments.slice(0, 2).join('/') : segments[0] ?? ''
    const directory = repoDirs.get(packageName)
    return directory === undefined ? key : `${directory}${rest.slice(packageName.length)}`
  }
}

/** Declaration-only condition trees add no runtime roots; explicit imports still resolve normally. */
function isDeclarationOnlyExport(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return value.length > 0 && value.every(isDeclarationOnlyExport)
  const conditions = Object.entries(value)
  return conditions.length > 0 && conditions.every(([condition, target]) =>
    condition === 'types' || condition.startsWith('types@') || isDeclarationOnlyExport(target))
}

function sweepImage(
  files: ImageFiles,
  options: PackOptions,
  rootPackages: readonly string[],
  root: string,
): SweepOutcome {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const vfs = new MemoryVfs()
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('/')) vfs.seedDirectory(`${root}/${name}`)
    else vfs.seed(`${root}/${name}`, bytes)
  }
  // The walk resolves static specifiers and never loads them, so one shared
  // factory stands for every replaced module.
  const stub = (): unknown => ({})
  const loader = new WorkerModuleLoader({
    vfs,
    root,
    staticModules: Object.fromEntries(Object.keys(MODULE_PROXIES).map(name => [name, stub])),
    staticModulePrefixes: Object.fromEntries(Object.keys(MODULE_PROXY_PREFIXES).map(name => [name, stub])),
  })

  const queue: { specifier: string; from: string; importer: string; meta?: boolean }[] = (options.entries ?? IMAGE_ENTRY_SEEDS)
    .map(specifier => ({ specifier, from: root, importer: 'worker assembly entry' }))
  for (const name of rootPackages) {
    const manifestBytes = files[`node_modules/${name}/package.json`]
    if (manifestBytes === undefined) continue // materialize already reported it under `missing`
    let manifest: { exports?: Record<string, unknown> }
    try {
      manifest = JSON.parse(decoder.decode(manifestBytes)) as typeof manifest
    } catch {
      continue
    }
    // Every non-wildcard runtime face is a root; a face resolving onto a page
    // asset is kept untransformed below rather than excluded here.
    const subpaths = manifest.exports === undefined
      ? ['.']
      : Object.entries(manifest.exports)
        .filter(([key, target]) => key.startsWith('.') && !key.includes('*') && !isDeclarationOnlyExport(target))
        .map(([key]) => key)
    for (const subpath of subpaths) {
      queue.push({ specifier: subpath === '.' ? name : `${name}/${subpath.slice(2)}`, from: root, importer: `workspace face ${name}` })
    }
  }

  const reached = new Map<string, Uint8Array>()
  const seen = new Set<string>()
  const failures: string[] = []
  const tolerated = new Set<string>()
  let visited = 0
  let rewritten = 0
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    const { specifier, from, importer } = entry
    let resolution
    try {
      resolution = loader.resolve(specifier, from)
    } catch (reason) {
      // Our own packages must declare what they request: an unresolvable
      // request from a workspace or vendored file, a roster face, or the
      // assembly entries is a pack defect. Third-party files keep the runtime
      // philosophy instead — platform-dispatch branches the worker never
      // evaluates may request node-only modules, and such a request fails loud
      // at require time if it ever runs.
      const external = importer.startsWith('node_modules/') && !importer.startsWith('node_modules/@deepseek-ai/')
      // A meta-resolve request is a URL mapping, not a load: a missing target
      // is tolerable from any importer — the call throws if it ever runs.
      if (external || entry.meta === true) tolerated.add(`${importer}: "${specifier}"`)
      else failures.push(`${importer}: "${specifier}" — ${(reason as Error).message}`)
      continue
    }
    if (resolution.kind === 'static') continue
    const path = resolution.path
    if (seen.has(path)) continue
    seen.add(path)
    const key = path.slice(root.length + 1)
    const bytes = files[key]
    if (bytes === undefined) continue
    if (!/\.[cm]?js$/.test(key) || pageAsset(key)) {
      reached.set(key, bytes)
      continue
    }
    visited += 1
    const { code, lowered, moduleRequests, metaResolveRequests } = lowerModuleSource({ filename: `/${key}`, source: decoder.decode(bytes) })
    if (lowered) rewritten += 1
    reached.set(key, lowered ? encoder.encode(code) : bytes)
    const directory = path.slice(0, path.lastIndexOf('/'))
    for (const request of moduleRequests) queue.push({ specifier: request, from: directory, importer: key })
    for (const request of metaResolveRequests) queue.push({ specifier: request, from: directory, importer: key, meta: true })
  }
  if (failures.length > 0) {
    throw new Error(
      `vfs image: ${String(failures.length)} unresolvable module request(s); `
      + 'an undeclared or missing dependency fails the pack rather than the boot:\n  '
      + failures.join('\n  '),
    )
  }

  const swept: ImageFiles = {}
  const debuggerName = debuggerNamer(options.workspaces, options.resolveFrom)
  let javascriptEntries = 0
  let dropped = 0
  for (const [name, bytes] of Object.entries(files)) {
    const isJs = /\.[cm]?js$/.test(name)
    if (!isJs || pageAsset(name)) {
      swept[name] = isJs ? nameForDebugger(bytes, debuggerName(name), decoder, encoder) : bytes
      if (isJs) javascriptEntries += 1
      continue
    }
    const kept = reached.get(name)
    if (kept === undefined) {
      dropped += 1
      continue
    }
    swept[name] = nameForDebugger(kept, debuggerName(name), decoder, encoder)
    javascriptEntries += 1
  }
  return {
    swept,
    transform: { visited, rewritten },
    javascriptEntries,
    droppedJavascriptEntries: dropped,
    unresolvedExternalRequests: [...tolerated],
  }
}

/**
 * Drop executable scripts from the image.
 *
 * A shebang says "program", not "module": nothing in a browser can spawn one and no
 * consumer reads their bytes (the packages that expose a launcher path are replaced
 * by stubs that answer with a string). They are also the one place top-level `await`
 * appears in the closure, which a CommonJS body cannot express.
 * @param files - Image entries, mutated.
 * @returns The dropped entry names.
 */
function dropExecutables(files: ImageFiles): string[] {
  const decoder = new TextDecoder()
  const dropped: string[] = []
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.[cm]?js$/.test(name)) continue
    if (decoder.decode(bytes.subarray(0, 2)) !== '#!') continue
    dropped.push(name)
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the image is a plain path map
    delete files[name]
  }
  return dropped
}

/**
 * Materialize the dependency closure of every roster package into the image.
 * @param roster - Package names to start from.
 * @param options - Pack options carrying the workspace index and resolution root.
 * @returns Image entries, per-package file counts, and unresolved dependencies.
 */
function materialize(
  roster: readonly string[],
  options: PackOptions,
): { files: ImageFiles; packages: Map<string, number>; missing: string[] } {
  const files: ImageFiles = {}
  const packages = new Map<string, number>()
  const missing: string[] = []
  const replaced = new Set(REPLACED_EXTERNAL_PACKAGES)
  const queue: { name: string; from: string }[] = roster.map(name => ({ name, from: options.resolveFrom }))

  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    const { name, from } = entry
    if (packages.has(name) || replaced.has(name)) continue
    const directory = options.workspaces.get(name) ?? resolveDependency(from, name)
    if (directory === undefined) {
      missing.push(`${name} (from ${relative(options.resolveFrom, from) || '.'})`)
      continue
    }
    const manifest = readJson(join(directory, 'package.json'))
    const prefix = `node_modules/${name}`
    const before = Object.keys(files).length
    if (options.workspaces.has(name)) {
      // A workspace package ships the slice npm would publish — `files`
      // filters out build residue like the tsc mirror under lib/types/ —
      // minus the workspace exclude table (no sources, no dist: the page
      // serves its own assets).
      const published = Array.isArray(manifest.files) ? publishedFilter(manifest.files) : undefined
      collectTree(directory, files, prefix, relativePath =>
        !workspaceExcluded(relativePath) && (published === undefined || published(relativePath)))
    } else {
      collectTree(directory, files, prefix, relativePath => !excluded(relativePath))
    }
    packages.set(name, Object.keys(files).length - before)
    for (const field of ['dependencies', 'peerDependencies'] as const) {
      // npm semantics: a peer is provided by the consumer. For an external
      // package the consumer is the page (react behind the prebuilt client
      // bundles), so its peer edges never bind the worker. Workspace and
      // vendored packages declare real runtime seams as peers
      // (@deepseek-ai/cordis is a peerDependency of every harness package),
      // so their peer edges stay on the chain.
      if (field === 'peerDependencies' && !options.workspaces.has(name)) continue
      const dependencies = manifest[field]
      if (typeof dependencies !== 'object' || dependencies === null) continue
      for (const dependency of Object.keys(dependencies)) queue.push({ name: dependency, from: directory })
    }
  }
  return { files, packages, missing }
}

/** Gzip header byte that records the packing platform; RFC 1952 §2.3.1 spells 255 "unknown". */
const GZIP_OS_UNKNOWN = 255

/** Offset of that byte in the gzip member header. */
const GZIP_OS_OFFSET = 9

/**
 * Compress the archive into one gzip member the same tree always produces
 * byte for byte.
 *
 * Two header fields would otherwise carry build facts: zlib writes no
 * modification time and no original file name for a buffer (`gzipSync` is handed
 * neither), and it fills the operating-system byte from the platform it was built
 * for, which would make the same tree pack differently on Linux and macOS. That
 * byte is overwritten with "unknown" — every gzip reader ignores it, and the
 * artifact stops depending on where it was packed.
 * @param archive - the ustar archive.
 * @returns the compressed image bytes.
 */
function compressImage(archive: Uint8Array): Uint8Array {
  const compressed = gzipSync(archive, { level: 9 })
  compressed[GZIP_OS_OFFSET] = GZIP_OS_UNKNOWN
  return compressed
}

/**
 * Pack one VFS image.
 *
 * The manifest's claim is all-or-nothing: it names the one contract every packed body
 * was emitted against. A module the transform cannot express therefore fails the pack
 * rather than downgrading the image, because a mostly-transformed image boots into
 * errors far from their cause.
 * @param options - Composition, package index, and paths.
 * @returns The compressed image plus what went into it.
 * @throws When a config tree or workspace directory named in the options is missing,
 * because a silently thinner image fails much later and much less clearly.
 */
export function packVfsImage(options: PackOptions): PackResult {
  const root = options.root ?? DEFAULT_ROOT
  const encoder = new TextEncoder()
  const configTrees = options.configTrees ?? []
  for (const tree of configTrees) {
    if (!existsSync(tree.directory)) {
      throw new Error(`vfs image: config tree ${tree.mount} is missing at ${tree.directory}`)
    }
  }

  const roster = [...new Set([
    ...rosterOf(options.config),
    ...configTrees.filter(tree => tree.scanRoster === true).flatMap(tree => treeRosterOf(tree.directory)),
  ])]
  const { files, packages, missing } = materialize(roster, options)

  files[CONFIG_PATH] = encoder.encode(options.config)
  for (const tree of configTrees) collectTree(tree.directory, files, tree.mount, relativePath => !excluded(relativePath))

  const executables = dropExecutables(files)
  const rootPackages = [...packages.keys()].filter(name => options.workspaces.has(name))
  const { swept, transform, javascriptEntries, droppedJavascriptEntries, unresolvedExternalRequests } =
    sweepImage(files, options, rootPackages, root)

  swept[MANIFEST_PATH] = encoder.encode(`${JSON.stringify({
    root,
    profile: options.profile,
    [CONTRACT_FIELD]: WRAPPER_CONTRACT,
    javascriptEntries,
    visitedEntries: transform.visited,
    rewrittenEntries: transform.rewritten,
  }, null, 2)}\n`)

  for (const directory of options.emptyDirectories ?? IMAGE_EMPTY_DIRECTORIES) {
    swept[directory] = new Uint8Array(0)
  }

  return {
    image: compressImage(packTar(swept)),
    files: swept,
    packages,
    workspacePackages: [...packages.keys()].filter(name => options.workspaces.has(name)).length,
    roster,
    missing,
    executables,
    pageBundles: Object.keys(swept).filter(name => pageAsset(name)),
    javascriptEntries,
    droppedJavascriptEntries,
    unresolvedExternalRequests,
    transform,
    contract: WRAPPER_CONTRACT,
  }
}

/**
 * Pack opaque data trees into one ordered VFS overlay.
 *
 * Overlay mounts are restricted to the runtime-owned data directories, so an
 * overlay cannot replace configuration, the lowering manifest, or modules.
 * Files bypass package excludes and module reachability processing; later
 * trees replace earlier files at the same path.
 * @param trees - Absolute source directories and their data-directory mounts.
 * @returns Deterministic compressed archive plus its uncompressed entries.
 */
export function packVfsOverlay(trees: readonly ImageTree[]): PackOverlayResult {
  const files: ImageFiles = {}
  for (const tree of trees) {
    if (!existsSync(tree.directory)) {
      throw new Error(`vfs overlay: tree ${tree.mount} is missing at ${tree.directory}`)
    }
    const mount = tree.mount.replace(/^\.\//, '').replace(/\/$/, '')
    const first = mount.split('/')[0]
    if (mount === '' || first === undefined || !IMAGE_OVERLAY_DIRECTORIES.includes(first)
      || mount.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(
        `vfs overlay: mount ${JSON.stringify(tree.mount)} must stay under ${IMAGE_OVERLAY_DIRECTORIES.join(' or ')}`,
      )
    }
    collectTree(tree.directory, files, mount, () => true, true)
  }
  return { image: compressImage(packTar(files)), files }
}

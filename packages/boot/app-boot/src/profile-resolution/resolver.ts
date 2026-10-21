/** In-memory profile package routing for Node's default ESM and CommonJS loaders. */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads'
import type { ModuleLoaderV1, ModuleLoaderV2, ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import { imports as resolvePackageImports, type Package as ResolvePackageManifest } from 'resolve.exports'
import type { RuntimeResolutionEntry, RuntimeResolution } from '../profile.ts'

const WORKER_RESOLUTION_KEY = '@deepseek-ai/dsh-app-boot/profile-resolution'
const EMPTY_ATTRIBUTES: ImportAttributes = Object.freeze({})

interface CommonJsParent {
  filename?: string | null
  parent?: CommonJsParent | null
  paths?: string[]
}

interface CommonJsOptions {
  paths?: string[]
  conditions?: ReadonlySet<string>
}

interface CommonJsModule {
  new(id?: string, parent?: CommonJsParent): CommonJsParent
  _nodeModulePaths(path: string): string[]
  _resolveFilename(
    request: string, parent: CommonJsParent | null | undefined, isMain: boolean, options?: CommonJsOptions,
  ): string
}

interface InternalModules {
  esm: ModuleLoaderV1 | ModuleLoaderV2
  esmDefaultResolve: (
    specifier: string,
    context: { parentURL?: string; conditions?: readonly string[] },
  ) => ResolveResult
  esmConditions: readonly string[]
  cjs: CommonJsModule
  cjsConditions: ReadonlySet<string>
  modern: boolean
}

type EsmResolve = (
  request: string, parent: string | undefined, attributes: ImportAttributes,
) => ResolveResult | Promise<ResolveResult>

/**
 * Where Node continues a scoped bare request. `native` keeps the importer's own lookup: the chain is
 * answered below the interception layer. `interception` answers at the interception layer from the
 * entry's declaring manifest; `after` anchors Node's chain above the layer for a CommonJS subpath the
 * entry lacks. `native-after-interception` resumes Node's chain from `parent`: the interception layer for a
 * name without an entry, or the layer above it after an `interception` subpath miss.
 */
type ResolutionRoute =
  | { readonly kind: 'interception'; readonly entry: RuntimeResolutionEntry; readonly after: string }
  | { readonly kind: 'native-after-interception'; readonly parent: string }
  | { readonly kind: 'native'; readonly packageDir?: string }

interface ResolutionRouteState {
  readonly route: ResolutionRoute
  packageDir?: string
  esm?: ResolveResult
  cjs?: string
}

interface CommonJsLookup {
  readonly cacheable: boolean
  resolveNative(searchPaths: readonly string[]): string
  resolveEntry(entry: RuntimeResolutionEntry, after: string): string
}

/** The lookup positions that one interception layer fixes on an importer's ancestor chain. */
interface LayerPositions {
  /** Search paths with this prefix lie below the layer and are answered by their physical content. */
  readonly localPrefix: string
  /** Manifest anchoring Node's lookup at the layer's physical directory. */
  readonly nativeAfter: string
  /** Manifest anchoring Node's lookup above the layer after a CommonJS subpath miss. */
  readonly after: string
}

/**
 * The interception layer of one importer. A profile's layer is its parent's node_modules and answers every entry
 * for the active profile. Linked importers apply current peer declarations at each ancestor node_modules
 * position without memoizing the selected route.
 */
type InterceptionLayer =
  | LayerPositions & { readonly kind: 'profile'; readonly active: boolean }
  | { readonly kind: 'linked' }

interface ParentRoutes {
  readonly parent: string
  readonly layer: InterceptionLayer
  readonly requests: Map<string, ResolutionRouteState>
  selfReferenceName?: string | false | null
}

type ResolutionRoutes = Map<string, ParentRoutes | false>

/** A published entry with the real directory its modules load from. */
interface CompiledEntry extends RuntimeResolutionEntry {
  readonly realDir: string
}

interface CompiledResolution {
  readonly entries: ReadonlyMap<string, CompiledEntry>
  readonly profilesDir: string
  readonly profileDir: string | undefined
  readonly profilePaths: readonly string[]
  readonly profile: readonly string[]
  readonly installationPaths: readonly string[]
  readonly linkedPaths: readonly string[]
  readonly localPackageNames: ReadonlySet<string>
  readonly esmRoutes: ResolutionRoutes
  readonly cjsRoutes: ResolutionRoutes
}

/** A successor resolution the running process cannot adopt, such as a retained mapping in another directory; it waits for a restart. */
export class ResolutionRestartRequired extends Error {
  /** @param message Diagnostic naming the rejected changes. */
  constructor(message: string) {
    super(message)
    this.name = 'ResolutionRestartRequired'
  }
}

/** Active interception in one Node isolate. */
export interface RuntimeInterception {
  /**
   * Locate a bare package without requiring one of its exports.
   * A package subpath selects its package directory without resolving or validating the requested file.
   * @param specifier - bare package or package-subpath specifier.
   * @param parentURL - file URL whose lookup order applies.
   * @returns selected package directory, or undefined when it is absent.
   */
  packageDir(specifier: string, parentURL: string): string | undefined
  /**
   * Atomically publish a complete successor and fresh caches. Profile-scoped mappings, local names, and linked
   * roots may be removed; removed roots stop intercepting uncovered directories. A retained profile mapping may
   * change its version and declarer when its normalized directory and scope stay unchanged, as when a package is
   * upgraded in place. Existing modules and Node caches remain intact: callers remove a package only after its
   * plugins stop, and replace the loaded modules of a package upgraded in place separately.
   * A previously published link name may point to another real directory; callers stop the plugins of its previous
   * target first, as removing and installing the package again does.
   * @param successor - fully constructed generation retaining the installation mappings.
   * @throws when the profile scope changes; and `ResolutionRestartRequired` when a retained profile mapping's real
   * directory or scope, or an installation version or declarer changes; an installation mapping is removed; or a new
   * local name overrides an existing mapping.
   */
  replace(successor: RuntimeResolution): void
  /** Restore the native resolver methods. Interceptions dispose in reverse order. */
  dispose(): void
}

/**
 * Split a bare request into its package name without allocating path segments.
 * @param request - module specifier to classify.
 * @returns the bare package name, or undefined for non-package requests.
 */
export function barePackageName(request: string): string | undefined {
  if (!request || request[0] === '.' || request[0] === '/' || request[0] === '\\'
    || request[0] === '#' || request.includes(':') || isBuiltin(request)) return
  const first = request.indexOf('/')
  if (request[0] !== '@') return first < 0 ? request : request.slice(0, first)
  if (first < 0) return
  const second = request.indexOf('/', first + 1)
  return second < 0 ? request : request.slice(0, second)
}

/** The JavaScript and native real paths of an existing directory; none for a directory that no longer exists. */
function realSpellings(path: string): string[] {
  try {
    // A packed worker's file system has no native realpath.
    const native: unknown = Reflect.get(realpathSync, 'native')
    return [realpathSync(path), ...typeof native === 'function' ? [String(Reflect.apply(native, realpathSync, [path]))] : []]
  } catch (_error) {
    // A removed previous directory keeps only its recorded spelling.
    return []
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // A runtime resolution may name a profile scope before that directory is materialized.
    return resolve(path)
  }
}

function prefixes(path: string): readonly string[] {
  const configured = resolve(path) + sep
  const canonical = canonicalPath(path) + sep
  return canonical === configured ? [configured] : [configured, canonical]
}

function compileResolution(resolution: RuntimeResolution): CompiledResolution {
  return {
    entries: new Map(resolution.entries.map(entry => [entry.name, { ...entry, realDir: canonicalPath(entry.packageDir) }])),
    profilesDir: resolution.profilesDir,
    profileDir: resolution.profileDir,
    profilePaths: prefixes(resolution.profilesDir),
    profile: resolution.profileDir === undefined ? [] : prefixes(resolution.profileDir),
    installationPaths: [...new Set(resolution.entries
      .filter(entry => entry.scope === 'installation')
      .flatMap(entry => prefixes(entry.packageDir)))],
    linkedPaths: resolution.linkedRoots.flatMap(root => prefixes(root.realPath)),
    localPackageNames: new Set(resolution.localPackageNames),
    esmRoutes: new Map(),
    cjsRoutes: new Map(),
  }
}

/**
 * The interception layer of a profile is `<profileParent>/node_modules`: an entry occupies its name there, so its
 * subpath misses continue above it, and a name without an entry continues at it.
 */
function computeProfileLayer(dir: string, active: boolean): InterceptionLayer {
  const profileParent = dirname(dir)
  return {
    kind: 'profile', active,
    localPrefix: dir + sep,
    nativeAfter: join(profileParent, 'package.json'),
    after: join(dirname(profileParent), 'package.json'),
  }
}

/** The interception layer of a module path: from its profile directory inside a profiles tree, or its linked root. */
function findInterceptionLayer(path: string, resolution: CompiledResolution): InterceptionLayer | undefined {
  const treeRoot = resolution.profilePaths.find(prefix => path.startsWith(prefix))
  const activeProfile = resolution.profile.find(prefix => path.startsWith(prefix))
  const dir = treeRoot !== undefined ? profileChild(path, treeRoot) : activeProfile?.slice(0, -1)
  if (dir !== undefined) return computeProfileLayer(dir, activeProfile !== undefined)
  if (!startsWithin(path, resolution.linkedPaths)) return undefined
  if (startsWithin(path, resolution.installationPaths)) return undefined
  return { kind: 'linked' }
}

/** Package names a directory's current manifest lists as peers; an unreadable manifest lists none. */
function readPeerNames(directory: string): ReadonlySet<string> {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      peerDependencies?: unknown
    }
    const peers = manifest.peerDependencies
    return new Set(peers !== null && typeof peers === 'object' ? Object.keys(peers) : [])
  } catch (_error) {
    // Node reports the unreadable or invalid manifest itself when it resolves the package's own imports.
    return new Set()
  }
}

function startsWithin(path: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (path.startsWith(root)) return true
  }
  return false
}

/**
 * The profile directory owning a module inside the profiles tree: the first path segment below the tree root.
 * @param path - module path below `treePrefix`.
 * @param treePrefix - profiles directory with a trailing separator.
 * @returns the profile directory without a trailing separator.
 */
function profileChild(path: string, treePrefix: string): string {
  const rest = path.slice(treePrefix.length)
  const end = rest.indexOf(sep)
  return treePrefix + (end < 0 ? rest : rest.slice(0, end))
}

function nativePackageDir(parent: string, name: string): string | undefined {
  for (const searchPath of createRequire(parent).resolve.paths(name) as string[]) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

function localPackageCandidate(searchPath: string, name: string, flavor: 'esm' | 'cjs'): string | undefined {
  const candidate = join(searchPath, name)
  const stat = statSync(candidate, { throwIfNoEntry: false })
  const found = flavor === 'esm'
    ? stat?.isDirectory() === true
    : stat !== undefined
      || ['.js', '.json', '.node'].some(extension => existsSync(candidate + extension))
  return found ? candidate : undefined
}

function selfReferenceName(parent: string): string | false | null {
  let current = dirname(parent)
  while (true) {
    const manifestPath = join(current, 'package.json')
    if (existsSync(manifestPath)) {
      let manifest: Record<string, unknown>
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      } catch (_error) {
        // Only Node decides whether this request consumes an invalid package manifest.
        return null
      }
      return typeof manifest.name === 'string' && manifest.exports != null
        ? manifest.name
        : false
    }
    /* v8 ignore next -- scoped module requests normally find an owning manifest before node_modules. */
    if (basename(current) === 'node_modules') return false
    const next = dirname(current)
    if (next === current) return false
    current = next
  }
}

function packageImportsTarget(
  parent: string, request: string, conditions: Iterable<string>,
): { specifier: string; parentURL: string } | undefined {
  let current = dirname(parent)
  while (true) {
    const manifestPath = join(current, 'package.json')
    if (existsSync(manifestPath)) {
      let manifest: ResolvePackageManifest
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ResolvePackageManifest
      } catch (_error) {
        // The native resolver retains invalid package-target and manifest diagnostics.
        /* v8 ignore next -- native resolution cannot report MODULE_NOT_FOUND after an invalid scope manifest */
        return undefined
      }
      try {
        const target = resolvePackageImports(manifest, request, {
          conditions: [...conditions],
          unsafe: true,
        })?.[0]
        return target !== undefined && barePackageName(target) !== undefined
          ? { specifier: target, parentURL: pathToFileURL(manifestPath).href }
          : undefined
      } catch (_error) {
        // The native resolver retains missing mappings and unmatched-condition diagnostics.
        /* v8 ignore next -- native resolution cannot report MODULE_NOT_FOUND before selecting a valid mapping */
        return undefined
      }
    }
    if (basename(current) === 'node_modules') return undefined
    const next = dirname(current)
    /* v8 ignore next -- a MODULE_NOT_FOUND package-import target always has an owning package scope */
    if (next === current) return undefined
    current = next
  }
}

function packageSearchPaths(
  entry: RuntimeResolutionEntry, request: string, cjs: CommonJsModule,
): string[] {
  const name = barePackageName(request)
  /* v8 ignore next -- interception routes are created only for bare package requests */
  if (name === undefined) return cjs._nodeModulePaths(dirname(entry.declarer))
  const suffix = sep + name.split('/').join(sep)
  return entry.packageDir.endsWith(suffix)
    ? [entry.packageDir.slice(0, -suffix.length)]
    : cjs._nodeModulePaths(dirname(entry.declarer))
}

function localCandidateOwnsResolution(candidate: string, resolved: string, request: string, name: string): boolean {
  if (startsWithin(resolved, prefixes(candidate))) return true
  if (sameResolution(candidate, resolved)) return true
  if (['.js', '.json', '.node'].some(extension => sameResolution(candidate + extension, resolved))) return true
  /* v8 ignore next -- a bounded native lookup can escape a candidate only through its root legacy main */
  if (request !== name) return false
  try {
    const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as Record<string, unknown>
    /* v8 ignore next -- a bounded native lookup outside the package directory requires a legacy main */
    if (typeof manifest.main !== 'string') return false
    const main = createRequire(join(candidate, 'package.json')).resolve(resolve(candidate, manifest.main))
    return sameResolution(main, resolved)
  } catch (_error) {
    // Native resolution already owns malformed manifests and missing legacy entries.
    /* v8 ignore next -- this helper runs only after the same native resolution succeeded */
    return false
  }
}

function isUnselectedPackageMiss(error: unknown): boolean {
  const failure = error as NodeJS.ErrnoException & { path?: unknown }
  return failure.code === 'MODULE_NOT_FOUND' && failure.path === undefined
}

function sameResolution(left: string, right: string): boolean {
  if (left === right) return true
  return canonicalPath(left) === canonicalPath(right)
}

/** A directory as given and in its JavaScript and native real paths, each with a trailing separator. */
function spellings(dir: string): string[] {
  const result = new Set([dir + sep])
  for (const real of realSpellings(dir)) result.add(real + sep)
  return [...result]
}

/**
 * The previous real directories of packages that moved, each mapped to the current one. Node keeps the real path of
 * every link it resolved through and never refreshes it, so a lookup through a link that now points elsewhere still
 * selects a file below the target Node saw first; {@link MovedDirectories.relocate} selects the same file below the
 * current target instead.
 */
class MovedDirectories {
  /** Previous directory to current directory, both with a trailing separator. */
  private readonly targets = new Map<string, string>()

  /**
   * Record that a package moved from one directory to another. Every spelling of the previous directory leads to the
   * current one. A directory that an earlier move led to the previous one now leads to the current one as well, since
   * Node still selects files below the earliest target.
   * @param from Previous real directory.
   * @param to Current real directory.
   */
  record(from: string, to: string): void {
    const previous = spellings(from)
    const current = to + sep
    for (const [key, value] of this.targets) {
      if (previous.includes(value)) this.targets.set(key, current)
    }
    for (const key of previous) this.targets.set(key, current)
  }

  /**
   * Forget the previous directories that are current again, in any spelling, and records that lead to themselves.
   * @param current The real directories the published resolution maps.
   */
  forget(current: readonly string[]): void {
    const active = new Set<string>()
    for (const dir of current) for (const spelling of spellings(dir)) active.add(spelling)
    for (const [key, value] of [...this.targets]) {
      if (active.has(key) || key === value) this.targets.delete(key)
    }
  }

  /**
   * The same file below the current directory when it exists, for a file below a previous directory that an importer
   * outside that directory selected. An importer inside the previous directory keeps its own package's files. The
   * innermost previous directory decides.
   * @param filename Selected file.
   * @param parent Importer path.
   * @returns The file to load.
   */
  relocate(filename: string, parent: string | undefined): string {
    let from = ''
    for (const dir of this.targets.keys()) {
      if (filename.startsWith(dir) && dir.length > from.length) from = dir
    }
    if (from === '' || parent?.startsWith(from) === true) return filename
    const relocated = (this.targets.get(from) as string) + filename.slice(from.length)
    return existsSync(relocated) ? relocated : filename
  }
}

/** One mutable pointer to the immutable runtime resolution. */
class ResolutionRouter {
  private current: CompiledResolution
  private linkedTargets: Map<string, string>
  private readonly moved = new MovedDirectories()

  constructor(resolution: RuntimeResolution, private readonly nodeModulePaths: (directory: string) => string[]) {
    this.current = compileResolution(resolution)
    this.linkedTargets = new Map(resolution.linkedRoots.map(root => [root.name, root.realPath]))
  }

  replace(successor: RuntimeResolution): void {
    const entries = new Map(successor.entries.map(entry => [entry.name, entry]))
    if (successor.profilesDir !== this.current.profilesDir
      || successor.profileDir !== this.current.profileDir) {
      throw new Error('profile resolution: a successor cannot change its profile scope')
    }
    const rejected: string[] = []
    const moves: [string, string][] = []
    for (const [name, current] of this.current.entries) {
      const next = entries.get(name)
      if (next === undefined && current.scope === 'profile') continue
      if (next !== undefined && current.scope === 'profile' && next.scope === 'profile') {
        // Real directories are compared: a link keeps its path when its target changes.
        if (current.realDir === canonicalPath(next.packageDir)) continue
        rejected.push(`profile resolution: replacing ${JSON.stringify(name)} requires a process restart`)
        continue
      }
      if (next === undefined
        || !sameResolution(current.packageDir, next.packageDir)
        || (current.scope === 'installation' && !sameResolution(current.declarer, next.declarer))
        || (current.scope === 'installation' && current.version !== next.version)
        || current.scope !== next.scope) {
        rejected.push(`profile resolution: replacing ${JSON.stringify(name)} requires a process restart`)
      }
    }
    const localPackageNames = new Set(successor.localPackageNames)
    for (const name of localPackageNames) {
      if (!this.current.localPackageNames.has(name) && this.current.entries.has(name)) {
        rejected.push(`profile resolution: overriding ${JSON.stringify(name)} locally requires a process restart`)
      }
    }
    // A link name pointing elsewhere, or installed again as a directory, moves its package. Names whose link and mapping
    // are gone stay recorded, so the package that returns under the name is compared with its last target.
    const targets = new Map(this.linkedTargets)
    for (const [name, previous] of this.linkedTargets) {
      const root = successor.linkedRoots.find(candidate => candidate.name === name)
      const entry = entries.get(name)
      const target = root?.realPath ?? (entry?.scope === 'profile' ? canonicalPath(entry.packageDir) : undefined)
      if (target === undefined || sameResolution(previous, target)) continue
      moves.push([previous, target])
      targets.set(name, target)
    }
    if (rejected.length > 0) throw new ResolutionRestartRequired(rejected.join('; '))
    const next = compileResolution(successor)
    for (const { name, realPath } of successor.linkedRoots) targets.set(name, realPath)
    this.linkedTargets = targets
    for (const [from, to] of moves) this.moved.record(from, to)
    const current: string[] = []
    for (const entry of next.entries.values()) current.push(entry.realDir)
    for (const root of successor.linkedRoots) current.push(root.realPath)
    this.moved.forget(current)
    this.current = next
  }

  /**
   * The file to load instead of one Node selected through a link that has moved since; see {@link MovedDirectories}.
   * @param filename Selected file.
   * @param parent Importer path.
   * @returns The file to load.
   */
  relocate(filename: string, parent: string | undefined): string {
    return this.moved.relocate(filename, parent)
  }

  /** Whether a module path has an interception layer: it lies in the profiles tree, the active profile, or a linked root. */
  hasInterceptionLayerForPath(path: string): boolean {
    return findInterceptionLayer(path, this.current) !== undefined
  }

  /** Whether an importer URL is scoped; the answer is memoized with the importer's routes. */
  hasInterceptionLayerForUrl(parentURL: string): boolean {
    return this.getOrCreateParentRoutesForUrl(parentURL) !== false
  }

  private createParentRoutes(parent: string, resolution: CompiledResolution): ParentRoutes | undefined {
    const layer = findInterceptionLayer(parent, resolution)
    return layer === undefined ? undefined : { parent, layer, requests: new Map() }
  }

  private getOrCreateParentRoutesForUrl(parentURL: string): ParentRoutes | false {
    const resolution = this.current
    let parentRoutes = resolution.esmRoutes.get(parentURL)
    if (parentRoutes !== undefined) return parentRoutes
    let parent: string | undefined
    try {
      parent = fileURLToPath(parentURL)
    } catch {
      // Only file URLs can lie inside a profile tree or linked root.
      parent = undefined
    }
    parentRoutes = parent === undefined ? false : this.createParentRoutes(parent, resolution) ?? false
    resolution.esmRoutes.set(parentURL, parentRoutes)
    return parentRoutes
  }

  private routeScoped(
    request: string,
    parentRoutes: ParentRoutes,
    resolution: CompiledResolution,
    flavor: 'esm' | 'cjs',
    cjs?: CommonJsLookup,
  ): ResolutionRouteState | undefined {
    const { parent, layer, requests } = parentRoutes
    const memo = layer.kind === 'profile' && (cjs === undefined || cjs.cacheable)
    const name = barePackageName(request)
    if (name === undefined) return undefined

    if (parentRoutes.selfReferenceName === undefined || !memo) {
      parentRoutes.selfReferenceName = selfReferenceName(parent)
    }
    if (parentRoutes.selfReferenceName === name || parentRoutes.selfReferenceName === null) {
      const state = { route: { kind: 'native' as const } }
      if (memo) requests.set(request, state)
      return state
    }

    if (layer.kind === 'linked') return this.routeLinked(request, name, parent, resolution, flavor, cjs)

    const target = resolution.entries.get(name)
    const candidates: string[] = []
    const localSearchPaths: string[] = []
    for (const searchPath of createRequire(parent).resolve.paths(name) as string[]) {
      if (!searchPath.startsWith(layer.localPrefix)) break
      localSearchPaths.push(searchPath)
      const candidate = localPackageCandidate(searchPath, name, flavor)
      if (candidate !== undefined) candidates.push(candidate)
    }
    if (candidates.length > 0) {
      if (cjs !== undefined) {
        try {
          const resolved = cjs.resolveNative(localSearchPaths)
          const selected = candidates.find(candidate => (
            localCandidateOwnsResolution(candidate, resolved, request, name)
          ))
          if (selected !== undefined) {
            const state = {
              route: { kind: 'native' as const, packageDir: selected },
              packageDir: selected,
              cjs: resolved,
            }
            if (memo) requests.set(request, state)
            return state
          }
        } catch (error) {
          if (!isUnselectedPackageMiss(error)) throw error
        }
      } else {
        const selected = candidates[0] as string
        const state = {
          route: { kind: 'native' as const, packageDir: selected },
          packageDir: selected,
        }
        requests.set(request, state)
        return state
      }
    }

    const route: ResolutionRoute = target !== undefined
      && (target.scope === 'installation' || layer.active)
      ? { kind: 'interception', entry: target, after: layer.after }
      : { kind: 'native-after-interception', parent: layer.nativeAfter }
    const state: ResolutionRouteState = { route }
    if (route.kind === 'interception' && memo) requests.set(request, state)
    return state
  }

  private routeLinked(
    request: string, name: string, parent: string, resolution: CompiledResolution,
    flavor: 'esm' | 'cjs', cjs: CommonJsLookup | undefined,
  ): ResolutionRouteState {
    const target = resolution.entries.get(name)
    if (target === undefined) return { route: { kind: 'native' } }
    const ancestors = this.nodeModulePaths(dirname(parent))
    const ancestorSet = new Set(ancestors)
    const searchPaths = flavor === 'esm' ? ancestors : createRequire(parent).resolve.paths(name) as string[]
    for (const searchPath of searchPaths) {
      const directory = dirname(searchPath)
      if (ancestorSet.has(searchPath) && readPeerNames(directory).has(name)) {
        const route: ResolutionRoute = { kind: 'interception', entry: target, after: join(dirname(directory), 'package.json') }
        if (cjs === undefined) return { route }
        try {
          const resolved = cjs.resolveEntry(target, route.after)
          if (localCandidateOwnsResolution(target.packageDir, resolved, request, name)) {
            return { route, packageDir: target.packageDir, cjs: resolved }
          }
        } catch (error) {
          if (!isUnselectedPackageMiss(error)) throw error
        }
        // This position is occupied even when a legacy CommonJS subpath is absent from the supplied package.
        continue
      }
      const candidate = localPackageCandidate(searchPath, name, flavor)
      if (candidate === undefined) continue
      if (cjs === undefined) return { route: { kind: 'native', packageDir: candidate }, packageDir: candidate }
      try {
        const resolved = cjs.resolveNative([searchPath])
        if (localCandidateOwnsResolution(candidate, resolved, request, name)) {
          return { route: { kind: 'native', packageDir: candidate }, packageDir: candidate, cjs: resolved }
        }
      } catch (error) {
        if (!isUnselectedPackageMiss(error)) throw error
      }
    }
    // An exhausted CommonJS lookup must not retry the physical copies at occupied peer positions.
    return cjs === undefined ? { route: { kind: 'native' } } : { route: { kind: 'native' }, cjs: cjs.resolveNative([]) }
  }

  private routeLocalPackage(
    request: string, parentRoutes: ParentRoutes, resolution: CompiledResolution,
  ): ResolutionRouteState | undefined {
    const name = barePackageName(request)
    const { layer } = parentRoutes
    if (name === undefined || layer.kind !== 'profile' || !layer.active || !resolution.localPackageNames.has(name)) return undefined
    const state = { route: { kind: 'native' as const } }
    parentRoutes.requests.set(request, state)
    return state
  }

  routeUrl(request: string, parentURL: string): ResolutionRouteState | undefined {
    const resolution = this.current
    const parentRoutes = this.getOrCreateParentRoutesForUrl(parentURL)
    if (parentRoutes === false) return undefined
    const cached = parentRoutes.requests.get(request)
    if (cached !== undefined) return cached
    const local = this.routeLocalPackage(request, parentRoutes, resolution)
    if (local !== undefined) return local
    return this.routeScoped(request, parentRoutes, resolution, 'esm')
  }

  routePath(
    request: string, parent: string, cjs: CommonJsLookup,
  ): ResolutionRouteState | undefined {
    const resolution = this.current
    let parentRoutes = resolution.cjsRoutes.get(parent)
    if (parentRoutes === false) return undefined
    const cached = cjs.cacheable ? parentRoutes?.requests.get(request) : undefined
    if (cached !== undefined) return cached
    if (parentRoutes === undefined) {
      parentRoutes = this.createParentRoutes(parent, resolution) ?? false
      resolution.cjsRoutes.set(parent, parentRoutes)
      if (parentRoutes === false) return undefined
    }
    return this.routeScoped(request, parentRoutes, resolution, 'cjs', cjs)
  }

  packageDir(specifier: string, parentURL: string): string | undefined {
    const name = barePackageName(specifier)
    if (name === undefined) return undefined
    const state = this.routeUrl(name, parentURL)
    if (state?.route.kind === 'interception') return state.route.entry.packageDir
    if (state?.packageDir !== undefined) return state.packageDir
    let parent: string
    try {
      parent = state?.route.kind === 'native-after-interception' ? state.route.parent : fileURLToPath(parentURL)
    } catch {
      return undefined
    }
    const found = nativePackageDir(parent, name)
    if (state !== undefined && found !== undefined) state.packageDir = found
    return found
  }
}

function internalModules(): InternalModules {
  const require = createRequire(import.meta.url)
  const addon = require('node-addon-require-builtin') as { requireBuiltin(moduleId: string): unknown }
  const esmModule = addon.requireBuiltin('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): ModuleLoaderV1 | ModuleLoaderV2
  }
  const cjsModule = addon.requireBuiltin('internal/modules/cjs/loader') as { Module: CommonJsModule }
  const cjsHelpers = addon.requireBuiltin('internal/modules/helpers') as {
    getCjsConditions(): ReadonlySet<string>
  }
  const esmUtils = addon.requireBuiltin('internal/modules/esm/utils') as {
    getDefaultConditions(): readonly string[]
  }
  const esmResolve = addon.requireBuiltin('internal/modules/esm/resolve') as {
    defaultResolve(
      specifier: string,
      context: { parentURL?: string; conditions?: readonly string[] },
    ): ResolveResult
  }
  const esm = esmModule.getOrInitializeCascadedLoader()
  const modern = 'getOrCreateModuleJob' in esm
  /* v8 ignore start -- the supported Node 24/26 matrix validates each available Internal interface */
  if (typeof esm.resolveSync !== 'function'
    || typeof Reflect.get(esm, modern ? 'getOrCreateModuleJob' : 'getModuleJobForImport') !== 'function'
    || (!modern && typeof Reflect.get(esm, 'resolve') !== 'function')
    || typeof cjsModule.Module._resolveFilename !== 'function'
    || typeof cjsHelpers.getCjsConditions !== 'function'
    || typeof esmUtils.getDefaultConditions !== 'function'
    || typeof esmResolve.defaultResolve !== 'function') {
    throw new Error('profile resolution: unsupported Node module loader')
  }
  /* v8 ignore stop */
  return {
    esm,
    esmDefaultResolve: (specifier, context) => esmResolve.defaultResolve(specifier, context),
    esmConditions: esmUtils.getDefaultConditions(),
    cjs: cjsModule.Module,
    cjsConditions: cjsHelpers.getCjsConditions(),
    modern,
  }
}

/**
 * Replace a resolver error's message and the same text in its stack.
 * Node's module-hooks thread serializes errors and returns the stack accessor as a read-only configurable
 * data property, so a rejected stack assignment redefines the property value.
 * @param error - resolver error to update in place.
 * @param message - replacement message.
 */
function replaceErrorMessage(error: Error, message: string): void {
  const { message: originalMessage, stack } = error
  error.message = message
  /* v8 ignore next -- Node's resolver errors always carry a stack */
  if (stack === undefined) return
  const replaced = stack.replace(originalMessage, message)
  if (!Reflect.set(error, 'stack', replaced)) Object.defineProperty(error, 'stack', { value: replaced })
}

function throwWithImporter(error: unknown, routedParent: string, parent: string): never {
  const code = (error as NodeJS.ErrnoException).code
  if (error instanceof Error && (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) {
    const routedPath = fileURLToPath(routedParent)
    const parentPath = fileURLToPath(parent)
    replaceErrorMessage(error, error.message.replaceAll(routedParent, parent).replaceAll(routedPath, parentPath))
  }
  throw error
}

function throwWithoutCjsAnchor(error: unknown, anchor: string): never {
  const resolved = error as NodeJS.ErrnoException & { requireStack?: string[] }
  const requireStack = resolved.requireStack
  if (error instanceof Error
    && resolved.code === 'MODULE_NOT_FOUND'
    && requireStack?.[0] !== undefined
    && sameResolution(requireStack[0], anchor)) {
    const originalMessage = error.message
    const originalBlock = `\nRequire stack:\n${requireStack.map(path => `- ${path}`).join('\n')}`
    const remaining = requireStack.slice(1)
    /* v8 ignore next -- routed calls always retain the original importing module */
    const replacement = remaining.length === 0
      ? ''
      : `\nRequire stack:\n${remaining.map(path => `- ${path}`).join('\n')}`
    error.message = originalMessage.replace(originalBlock, replacement)
    resolved.requireStack = remaining
    const stack = error.stack
    /* v8 ignore next -- Node's resolver errors always carry a stack */
    if (stack !== undefined) error.stack = stack.replace(originalMessage, error.message)
  }
  throw error
}

/**
 * Install one runtime resolution as the interception on Node's default ESM and CommonJS resolvers.
 * @param resolution - complete package table and profile scope.
 * @returns an interception that publishes a successor or restores the native methods.
 */
export function installRuntimeInterception(
  resolution: RuntimeResolution,
): RuntimeInterception {
  const { esm, esmDefaultResolve, esmConditions, cjs, cjsConditions, modern } = internalModules()
  const router = new ResolutionRouter(resolution, directory => cjs._nodeModulePaths(directory))
  let delegatedEsm: { parent: string | undefined; request: string } | undefined

  const adaptEsm = (native: EsmResolve): EsmResolve => {
    const adapted: EsmResolve = (request, parent, attributes) => {
      const delegated = delegatedEsm
      /* v8 ignore next -- reentry requires a separate synchronous Node hook; supported launches install none */
      if (delegated !== undefined && delegated.parent === parent && delegated.request === request) {
        return native(request, parent, attributes)
      }
      if (parent === undefined || !router.hasInterceptionLayerForUrl(parent)) return native(request, parent, attributes)
      const state = router.routeUrl(request, parent)
      if (state === undefined) {
        const target = request[0] === '#'
          ? packageImportsTarget(fileURLToPath(parent), request, esmConditions)
          : undefined
        if (target === undefined) return native(request, parent, attributes)
        const restoreImporter = (error: unknown): never => throwWithImporter(error, target.parentURL, parent)
        let expected: ResolveResult | Promise<ResolveResult>
        try {
          expected = adapted(target.specifier, target.parentURL, attributes)
          /* v8 ignore next -- the current loader resolves synchronously; the private interface also permits Promise results */
          if (expected instanceof Promise) expected = expected.catch(restoreImporter)
        } catch (error) {
          return restoreImporter(error)
        }
        return expected
      }
      const cacheable = attributes === EMPTY_ATTRIBUTES || Object.keys(attributes).length === 0
      if (cacheable && state.esm !== undefined) return state.esm
      const route = state.route
      if (route.kind === 'native') {
        const result = native(request, parent, attributes)
        if (cacheable && !(result instanceof Promise)) state.esm = result
        return result
      }
      const routedParent = pathToFileURL(route.kind === 'interception' ? route.entry.declarer : route.parent).href
      const previous = delegatedEsm
      delegatedEsm = { parent: routedParent, request }
      const restoreImporter = (error: unknown): never => throwWithImporter(error, routedParent, parent)
      try {
        let result: ResolveResult | Promise<ResolveResult>
        try {
          result = native(request, routedParent, attributes)
        } catch (error) {
          return restoreImporter(error)
        }
        /* v8 ignore next -- the current loader resolves synchronously; the private interface also permits Promise results */
        if (result instanceof Promise) return result.catch(restoreImporter)
        if (cacheable) state.esm = result
        return result
      } finally {
        delegatedEsm = previous
      }
    }
    // Node's last real-path step, for routed and native requests alike, may follow a link it resolved earlier.
    const relocate = (result: ResolveResult, parent: string | undefined): ResolveResult => {
      if (!result.url.startsWith('file:')) return result
      const url = new URL(result.url)
      const filename = fileURLToPath(url)
      const relocated = router.relocate(filename, parent?.startsWith('file:') === true ? fileURLToPath(parent) : undefined)
      if (relocated === filename) return result
      url.pathname = pathToFileURL(relocated).pathname
      return { ...result, url: url.href }
    }
    return (request, parent, attributes) => {
      const result = adapted(request, parent, attributes)
      /* v8 ignore next -- the current loader resolves synchronously; the private interface also permits Promise results */
      return result instanceof Promise ? result.then(resolved => relocate(resolved, parent)) : relocate(result, parent)
    }
  }

  let restoreEsm: () => void
  /* v8 ignore else -- CI coverage runs Node 24 v2; the Node 24.0 matrix exercises the v1 adapter */
  if (modern) {
    const loader = esm as ModuleLoaderV2
    const original = Reflect.get(loader, 'resolveSync')
    const resolveRequest = adaptEsm((request, parent, attributes) => original.call(
      loader, parent as string, { specifier: request, attributes },
    ))
    // Node 24.12+ adds skipSyncHooks after request. Its presence marks hook
    // delegation whose outer call already selected a route.
    const wrapped = (parent: string, request: { specifier: string; attributes?: ImportAttributes }, ...rest: unknown[]): ResolveResult => (
      rest.length
        ? Reflect.apply(original, loader, [parent, request, ...rest]) as ResolveResult
        : resolveRequest(request.specifier, parent, request.attributes ?? EMPTY_ATTRIBUTES) as ResolveResult
    )
    loader.resolveSync = wrapped
    restoreEsm = () => {
      /* v8 ignore else -- interceptions are disposed in reverse installation order */
      if (loader.resolveSync === wrapped) loader.resolveSync = original
    }
  } else {
    const loader = esm as ModuleLoaderV1
    const original = Reflect.get(loader, 'resolve')
    const originalSync = Reflect.get(loader, 'resolveSync')
    const resolveRequest = adaptEsm((request, parent, attributes) => original.call(loader, request, parent as string, attributes))
    const resolveRequestSync = adaptEsm((request, parent, attributes) => originalSync.call(loader, request, parent as string, attributes))
    const wrapped = (request: string, parent: string, attributes: ImportAttributes = EMPTY_ATTRIBUTES): Promise<ResolveResult> => (
      resolveRequest(request, parent, attributes) as Promise<ResolveResult>
    )
    const wrappedSync = (request: string, parent: string, attributes: ImportAttributes = EMPTY_ATTRIBUTES): ResolveResult => (
      resolveRequestSync(request, parent, attributes) as ResolveResult
    )
    loader.resolve = wrapped
    loader.resolveSync = wrappedSync
    restoreEsm = () => {
      if (loader.resolve === wrapped) loader.resolve = original
      if (loader.resolveSync === wrappedSync) loader.resolveSync = originalSync
    }
  }

  const originalFilename = Reflect.get(cjs, '_resolveFilename')
  let delegatedCjs = 0
  const resolveRoutedCjs = (
    request: string, routed: Exclude<ResolutionRoute, { kind: 'native' }>,
    parent: CommonJsParent, main: boolean, options?: CommonJsOptions,
  ): string => {
    const anchor = routed.kind === 'interception' ? routed.entry.declarer : routed.parent
    const synthetic = new cjs(anchor)
    // Late parent assignment preserves Node's require stack without publishing this routing anchor in parent.children.
    synthetic.parent = parent
    synthetic.filename = anchor
    synthetic.paths = routed.kind === 'interception'
      ? packageSearchPaths(routed.entry, request, cjs)
      : cjs._nodeModulePaths(dirname(anchor))
    try {
      return originalFilename.call(cjs, request, synthetic, main, options)
    } catch (error) {
      return throwWithoutCjsAnchor(error, anchor)
    }
  }
  const resolveNativeCjs = (
    request: string, searchPaths: readonly string[], parent: CommonJsParent,
    parentFilename: string, main: boolean, conditions: ReadonlySet<string> | undefined,
  ): string => {
    const synthetic = new cjs(parentFilename)
    if (parent.parent !== undefined) synthetic.parent = parent.parent
    synthetic.filename = parentFilename
    synthetic.paths = [...searchPaths]
    const options = conditions === undefined ? undefined : { conditions }
    return originalFilename.call(cjs, request, synthetic, main, options)
  }
  const resolvePackageImportCjs = (
    target: { specifier: string; parentURL: string }, conditions: Iterable<string>,
  ): string => {
    const state = router.routeUrl(target.specifier, target.parentURL)
    const resolveFrom = (parentURL: string): string => fileURLToPath(esmDefaultResolve(
      target.specifier, { parentURL, conditions: [...conditions] },
    ).url)
    /* v8 ignore next -- the target manifest was found inside the established profile scope */
    if (state === undefined) return resolveFrom(target.parentURL)
    if (state.route.kind === 'native') return resolveFrom(target.parentURL)
    const route = state.route
    if (route.kind === 'native-after-interception') return resolveFrom(pathToFileURL(route.parent).href)
    return resolveFrom(pathToFileURL(route.entry.declarer).href)
  }
  const wrappedFilename: CommonJsModule['_resolveFilename'] = (request, parent, main, options) => {
    if (delegatedCjs || !parent?.filename || options?.paths !== undefined) {
      return originalFilename.call(cjs, request, parent, main, options)
    }
    const parentFilename = parent.filename
    const cacheable = options?.conditions === undefined
    const routedOptions = options?.conditions === undefined ? undefined : { conditions: options.conditions }
    const state = router.routePath(request, parentFilename, {
      cacheable,
      resolveNative: searchPaths => resolveNativeCjs(request, searchPaths, parent, parentFilename, main, options?.conditions),
      resolveEntry: (entry, after) => {
        delegatedCjs++
        try {
          return resolveRoutedCjs(request, { kind: 'interception', entry, after }, parent, main, routedOptions)
        } finally {
          delegatedCjs--
        }
      },
    })
    if (state === undefined) {
      const scoped = router.hasInterceptionLayerForPath(parentFilename)
      const conditions = options?.conditions ?? cjsConditions
      const target = request[0] === '#' && scoped
        ? packageImportsTarget(parentFilename, request, conditions)
        : undefined
      if (target === undefined) return originalFilename.call(cjs, request, parent, main, options)
      return resolvePackageImportCjs(target, conditions)
    }
    if (state.cjs !== undefined) return state.cjs
    const route = state.route
    if (route.kind === 'native') {
      const result = originalFilename.call(cjs, request, parent, main, options)
      if (cacheable) state.cjs = result
      return result
    }
    delegatedCjs++
    try {
      let expected: string
      try {
        expected = resolveRoutedCjs(request, route, parent, main, routedOptions)
      } catch (error) {
        if (route.kind !== 'interception' || !isUnselectedPackageMiss(error)) throw error
        expected = resolveRoutedCjs(
          request, { kind: 'native-after-interception', parent: route.after }, parent, main, routedOptions,
        )
      }
      if (cacheable) state.cjs = expected
      return expected
    } finally {
      delegatedCjs--
    }
  }
  const relocatedFilename: CommonJsModule['_resolveFilename'] = (request, parent, main, options) => {
    const filename = wrappedFilename(request, parent, main, options)
    return isAbsolute(filename) ? router.relocate(filename, parent?.filename ?? undefined) : filename
  }
  cjs._resolveFilename = relocatedFilename

  return {
    packageDir(specifier, parentURL) {
      return router.packageDir(specifier, parentURL)
    },
    replace(next) { router.replace(next) },
    dispose() {
      /* v8 ignore else -- interceptions are disposed in reverse installation order */
      if (cjs._resolveFilename === relocatedFilename) cjs._resolveFilename = originalFilename
      restoreEsm()
    },
  }
}

/**
 * Publish one runtime resolution for Harness-owned Workers.
 * @param resolution - complete package table and profile scope.
 * @returns a disposer restoring the previous thread environment data.
 */
export function registerWorkerResolution(
  resolution: RuntimeResolution,
): () => void {
  const previous = getEnvironmentData(WORKER_RESOLUTION_KEY)
  setEnvironmentData(WORKER_RESOLUTION_KEY, { resolution })
  return () => { setEnvironmentData(WORKER_RESOLUTION_KEY, previous) }
}

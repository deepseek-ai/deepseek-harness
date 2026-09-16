/** In-memory profile package routing for Node's default ESM and CommonJS loaders. */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads'
import type { ModuleLoaderV1, ModuleLoaderV2, ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import { imports as resolvePackageImports, type Package as ResolvePackageManifest } from 'resolve.exports'
import { isProfileModuleFallbackLink } from './legacy-links.ts'
import type { ProfileResolutionEntry, ProfileResolutionGeneration } from '../profile.ts'

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

type ResolutionRoute =
  | { readonly kind: 'fallback'; readonly entry: ProfileResolutionEntry; readonly after: string }
  | { readonly kind: 'after-fallback'; readonly parent: string }
  | { readonly kind: 'native'; readonly packageDir?: string }

interface ResolutionRouteState {
  readonly route: ResolutionRoute
  packageDir?: string
  esm?: ResolveResult
  cjs?: string
}

interface ParentRoutes {
  readonly parent: string
  readonly profilesDir: string
  readonly activeProfile: boolean
  readonly requests: Map<string, ResolutionRouteState>
  selfReferenceName?: string | false | null
}

type ResolutionRoutes = Map<string, ParentRoutes | false>

interface CompiledGeneration {
  readonly entries: ReadonlyMap<string, ProfileResolutionEntry>
  readonly profilesDir: string
  readonly profileDir: string | undefined
  readonly profilePaths: readonly string[]
  readonly profileUrls: readonly string[]
  readonly profile: readonly string[]
  readonly activeProfileUrls: readonly string[]
  readonly localPackageNames: ReadonlySet<string>
  readonly shared: ReadonlySet<string>
  readonly esmRoutes: ResolutionRoutes
  readonly cjsRoutes: ResolutionRoutes
}

/** Whether runtime resolution redirects requests or verifies the materialized backend. */
export type ProfileResolutionBehavior = 'enforce' | 'verify'

/** Active resolver registration in one Node isolate. */
export interface ProfileResolutionRegistration {
  /**
   * Locate a bare package without requiring one of its exports.
   * @param specifier - bare package or package-subpath specifier.
   * @param parentURL - file URL whose lookup order applies.
   * @returns selected package directory, or undefined when it is absent.
   */
  packageDir(specifier: string, parentURL: string): string | undefined
  /**
   * Atomically publish an additive package table and fresh generation-owned caches.
   * @param generation - fully constructed successor generation.
   * @throws when the profile scope or an existing package mapping changes.
   */
  replace(generation: ProfileResolutionGeneration): void
  /** Restore the native resolver methods. Registrations dispose in reverse order. */
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

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // A generation may name a profile scope before that directory is materialized.
    return resolve(path)
  }
}

function prefixes(path: string): readonly string[] {
  const configured = resolve(path) + sep
  const canonical = canonicalPath(path) + sep
  return canonical === configured ? [configured] : [configured, canonical]
}

function compileGeneration(generation: ProfileResolutionGeneration): CompiledGeneration {
  const profilePaths = prefixes(generation.profilesDir)
  const profile = generation.profileDir === undefined ? [] : prefixes(generation.profileDir)
  return {
    entries: new Map(generation.entries.map(entry => [entry.name, entry])),
    profilesDir: generation.profilesDir,
    profileDir: generation.profileDir,
    profilePaths,
    profileUrls: profilePaths.map(path => pathToFileURL(path).href),
    profile,
    activeProfileUrls: profile.map(path => pathToFileURL(path).href),
    localPackageNames: new Set(generation.localPackageNames),
    shared: new Set(profilePaths.map(prefix => join(prefix, 'node_modules'))),
    esmRoutes: new Map(),
    cjsRoutes: new Map(),
  }
}

function startsWithin(path: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (path.startsWith(root)) return true
  }
  return false
}

function nativePackageDir(parent: string, name: string): string | undefined {
  for (const searchPath of createRequire(parent).resolve.paths(name) as string[]) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

function localPackageCandidate(
  searchPath: string, name: string, flavor: 'esm' | 'cjs',
): { packageDir: string; canBeManagedLink: boolean } | undefined {
  const candidate = join(searchPath, name)
  const stat = statSync(candidate, { throwIfNoEntry: false })
  const found = flavor === 'esm'
    ? stat?.isDirectory() === true
    : stat !== undefined
      || ['.js', '.json', '.node'].some(extension => existsSync(candidate + extension))
  return found ? { packageDir: candidate, canBeManagedLink: stat !== undefined } : undefined
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
  entry: ProfileResolutionEntry, request: string, cjs: CommonJsModule,
): string[] {
  const name = barePackageName(request)
  /* v8 ignore next -- fallback routes are created only for bare package requests */
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
  const leftPath = left.startsWith('file:') ? fileURLToPath(left) : left
  const rightPath = right.startsWith('file:') ? fileURLToPath(right) : right
  return canonicalPath(leftPath) === canonicalPath(rightPath)
}

/** One mutable pointer to immutable generation data. */
class ResolutionRouter {
  private current: CompiledGeneration

  constructor(generation: ProfileResolutionGeneration) {
    this.current = compileGeneration(generation)
  }

  replace(generation: ProfileResolutionGeneration): void {
    const entries = new Map(generation.entries.map(entry => [entry.name, entry]))
    if (generation.profilesDir !== this.current.profilesDir
      || generation.profileDir !== this.current.profileDir) {
      throw new Error('profile resolution: a generation cannot change its profile scope')
    }
    for (const [name, current] of this.current.entries) {
      const next = entries.get(name)
      if (next === undefined
        || !sameResolution(current.packageDir, next.packageDir)
        || !sameResolution(current.declarer, next.declarer)
        || current.version !== next.version
        || current.scope !== next.scope) {
        throw new Error(`profile resolution: replacing ${JSON.stringify(name)} requires a process restart`)
      }
    }
    const localPackageNames = new Set(generation.localPackageNames)
    for (const name of this.current.localPackageNames) {
      if (!localPackageNames.has(name)) {
        throw new Error(`profile resolution: removing local package ${JSON.stringify(name)} requires a process restart`)
      }
    }
    for (const name of localPackageNames) {
      if (!this.current.localPackageNames.has(name) && this.current.entries.has(name)) {
        throw new Error(`profile resolution: overriding ${JSON.stringify(name)} locally requires a process restart`)
      }
    }
    this.current = compileGeneration(generation)
  }

  private routeScoped(
    request: string,
    parentRoutes: ParentRoutes,
    generation: CompiledGeneration,
    flavor: 'esm' | 'cjs',
    nativeResolve?: (searchPaths: readonly string[]) => string,
    cacheable = false,
  ): ResolutionRouteState | undefined {
    const { parent, profilesDir, requests } = parentRoutes
    const name = barePackageName(request)
    if (name === undefined) return undefined

    if (parentRoutes.selfReferenceName === undefined) {
      parentRoutes.selfReferenceName = selfReferenceName(parent)
    }
    if (parentRoutes.selfReferenceName === name || parentRoutes.selfReferenceName === null) {
      const state = { route: { kind: 'native' as const } }
      requests.set(request, state)
      return state
    }

    const target = generation.entries.get(name)
    const candidates: Array<{ packageDir: string; canBeManagedLink: boolean }> = []
    const localSearchPaths: string[] = []
    for (const searchPath of createRequire(parent).resolve.paths(name) as string[]) {
      if (generation.shared.has(resolve(searchPath))) break
      localSearchPaths.push(searchPath)
      const candidate = localPackageCandidate(searchPath, name, flavor)
      if (candidate !== undefined) {
        const legacy = candidate.canBeManagedLink && generation.profile.some(prefix => (
          candidate.packageDir === join(prefix, 'node_modules', name)
          && isProfileModuleFallbackLink(prefix.slice(0, -1), name)
        ))
        if (!legacy) candidates.push(candidate)
      }
    }
    if (candidates.length > 0) {
      if (flavor === 'cjs' && nativeResolve !== undefined) {
        try {
          const resolved = nativeResolve(localSearchPaths)
          const selected = candidates.find(candidate => (
            localCandidateOwnsResolution(candidate.packageDir, resolved, request, name)
          ))
          if (selected !== undefined) {
            const state = {
              route: { kind: 'native' as const, packageDir: selected.packageDir },
              packageDir: selected.packageDir,
              ...(cacheable ? { cjs: resolved } : {}),
            }
            requests.set(request, state)
            return state
          }
        } catch (error) {
          if (!isUnselectedPackageMiss(error)) throw error
        }
      } else {
        const selected = candidates[0] as { packageDir: string }
        const state = {
          route: { kind: 'native' as const, packageDir: selected.packageDir },
          packageDir: selected.packageDir,
        }
        requests.set(request, state)
        return state
      }
    }

    const eligible = target?.scope === 'installation'
      || (target?.scope === 'profile' && parentRoutes.activeProfile)
    const after = join(dirname(profilesDir), 'package.json')
    const route: ResolutionRoute = eligible
      ? { kind: 'fallback', entry: target, after }
      : { kind: 'after-fallback', parent: after }
    const state: ResolutionRouteState = { route }
    if (route.kind === 'fallback') requests.set(request, state)
    return state
  }

  private routeLocalPackage(
    request: string, parentRoutes: ParentRoutes, generation: CompiledGeneration,
  ): ResolutionRouteState | undefined {
    const name = barePackageName(request)
    if (name === undefined || !parentRoutes.activeProfile || !generation.localPackageNames.has(name)) return undefined
    const state = { route: { kind: 'native' as const } }
    parentRoutes.requests.set(request, state)
    return state
  }

  routeUrl(request: string, parentURL: string): ResolutionRouteState | undefined {
    const generation = this.current
    let parentRoutes = generation.esmRoutes.get(parentURL)
    if (parentRoutes === false) return undefined
    const cached = parentRoutes?.requests.get(request)
    if (cached !== undefined) return cached
    if (parentRoutes === undefined) {
      const profileIndex = generation.profileUrls.findIndex(prefix => parentURL.startsWith(prefix))
      const activeProfileIndex = generation.activeProfileUrls.findIndex(prefix => parentURL.startsWith(prefix))
      if (profileIndex < 0 && activeProfileIndex < 0) {
        generation.esmRoutes.set(parentURL, false)
        return undefined
      }
      let parent: string
      try {
        parent = fileURLToPath(parentURL)
      } catch {
        generation.esmRoutes.set(parentURL, false)
        return undefined
      }
      const profileRoot = profileIndex >= 0
        ? generation.profilePaths[profileIndex]
        : generation.profile[activeProfileIndex]
      /* v8 ignore next -- one matching index was established above */
      if (profileRoot === undefined) return undefined
      parentRoutes = {
        parent,
        profilesDir: profileRoot.slice(0, -1),
        activeProfile: activeProfileIndex >= 0,
        requests: new Map(),
      }
      generation.esmRoutes.set(parentURL, parentRoutes)
    }
    const local = this.routeLocalPackage(request, parentRoutes, generation)
    if (local !== undefined) return local
    return this.routeScoped(request, parentRoutes, generation, 'esm')
  }

  routePath(
    request: string, parent: string, nativeResolve?: (searchPaths: readonly string[]) => string, cacheable = false,
  ): ResolutionRouteState | undefined {
    const generation = this.current
    let parentRoutes = generation.cjsRoutes.get(parent)
    if (parentRoutes === false) return undefined
    const cached = parentRoutes?.requests.get(request)
    if (cached !== undefined) return cached
    if (parentRoutes === undefined) {
      const profilesDir = generation.profilePaths.find(prefix => parent.startsWith(prefix))
      const activeProfile = generation.profile.find(prefix => parent.startsWith(prefix))
      if (profilesDir !== undefined || activeProfile !== undefined) {
        const profileRoot = profilesDir ?? activeProfile
        /* v8 ignore next -- one matching root was established above */
        if (profileRoot === undefined) return undefined
        parentRoutes = {
          parent,
          profilesDir: profileRoot.slice(0, -1),
          activeProfile: activeProfile !== undefined,
          requests: new Map(),
        }
        generation.cjsRoutes.set(parent, parentRoutes)
      }
    }
    if (parentRoutes === undefined) {
      generation.cjsRoutes.set(parent, false)
      return undefined
    }
    return this.routeScoped(request, parentRoutes, generation, 'cjs', nativeResolve, cacheable)
  }

  explicitRoute(
    request: string, paths: readonly string[],
  ): { index: number; parent: string } | undefined {
    if (barePackageName(request) === undefined) return undefined
    for (const [index, path] of paths.entries()) {
      const parent = join(resolve(path), '.dsh-profile-resolution.cjs')
      if (startsWithin(parent, this.current.profilePaths) || startsWithin(parent, this.current.profile)) {
        return { index, parent }
      }
    }
    return undefined
  }

  nativeSelfReference(request: string, parent: string): boolean {
    const name = barePackageName(request)
    if (name === undefined) return false
    const self = selfReferenceName(parent)
    return self === name || self === null
  }

  packageDir(specifier: string, parentURL: string): string | undefined {
    const name = barePackageName(specifier)
    if (name === undefined) return undefined
    const state = this.routeUrl(specifier, parentURL)
    if (state?.route.kind === 'fallback') return state.route.entry.packageDir
    if (state?.packageDir !== undefined) return state.packageDir
    let parent: string
    try {
      parent = state?.route.kind === 'after-fallback' ? state.route.parent : fileURLToPath(parentURL)
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
  /* v8 ignore start -- the supported Node 22/24/26 matrix validates each available Internal interface */
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

function throwWithImporter(error: unknown, routedParent: string, parent: string): never {
  const code = (error as NodeJS.ErrnoException).code
  if (error instanceof Error && (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) {
    const routedPath = fileURLToPath(routedParent)
    const parentPath = fileURLToPath(parent)
    const originalMessage = error.message
    const message = originalMessage.replaceAll(routedParent, parent).replaceAll(routedPath, parentPath)
    const stack = error.stack
    error.message = message
    /* v8 ignore next -- Node's resolver errors always carry a stack */
    if (stack !== undefined) error.stack = stack.replace(originalMessage, message)
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

function assertEquivalent(actual: string, expected: string, request: string, parent: string): void {
  if (sameResolution(actual, expected)) return
  throw new Error(
    `profile resolution mismatch for ${JSON.stringify(request)} from ${parent}: disk resolved ${actual}, generation resolved ${expected}`,
  )
}

function assertOptionalEquivalent(
  actual: string | undefined, expected: string | undefined, request: string, parent: string,
): void {
  if (actual === undefined && expected === undefined) return
  if (actual !== undefined && expected !== undefined && sameResolution(actual, expected)) return
  throw new Error(
    `profile resolution mismatch for ${JSON.stringify(request)} from ${parent}: disk selected ${actual ?? 'nothing'}, generation selected ${expected ?? 'nothing'}`,
  )
}

/**
 * Install one profile generation on Node's default ESM and CommonJS resolvers.
 * @param generation - complete package table and profile scope.
 * @param behavior - enforce the generation, or verify a materialized generation.
 * @returns a registration that replaces the generation or restores the native methods.
 */
export function installProfileResolution(
  generation: ProfileResolutionGeneration,
  behavior: ProfileResolutionBehavior = 'enforce',
): ProfileResolutionRegistration {
  const router = new ResolutionRouter(generation)
  const { esm, esmDefaultResolve, esmConditions, cjs, cjsConditions, modern } = internalModules()
  const esmScope = new Map<string, boolean>()
  const profilePaths = [
    ...prefixes(generation.profilesDir),
    ...(generation.profileDir === undefined ? [] : prefixes(generation.profileDir)),
  ]
  const profileUrls = profilePaths.map(path => pathToFileURL(path).href)
  let recentEsmParent: string | undefined
  let recentEsmScoped = false
  let delegatedEsm: { parent: string | undefined; request: string } | undefined

  const adaptEsm = (native: EsmResolve): EsmResolve => {
    const adapted: EsmResolve = (request, parent, attributes) => {
      const delegated = delegatedEsm
      /* v8 ignore next -- reentry requires a separate synchronous Node hook; supported launches install none */
      if (delegated !== undefined && delegated.parent === parent && delegated.request === request) {
        return native(request, parent, attributes)
      }
      if (parent === undefined) return native(request, parent, attributes)
      let scoped = recentEsmParent === parent ? recentEsmScoped : esmScope.get(parent)
      if (scoped === undefined) {
        scoped = startsWithin(parent, profileUrls)
        esmScope.set(parent, scoped)
      }
      if (recentEsmParent !== parent) {
        recentEsmParent = parent
        recentEsmScoped = scoped
      }
      if (!scoped) return native(request, parent, attributes)
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
          /* v8 ignore next -- Node 24+ resolves synchronously; the Node 22 matrix covers its Promise result */
          if (expected instanceof Promise) expected = expected.catch(restoreImporter)
        } catch (error) {
          return restoreImporter(error)
        }
        if (behavior === 'enforce') return expected
        const actual = native(request, parent, attributes)
        /* v8 ignore start -- Node 22 is the asynchronous adapter and is covered by the external version matrix */
        if (expected instanceof Promise || actual instanceof Promise) {
          return Promise.all([actual, expected]).then(([resolved, wanted]) => {
            assertEquivalent(resolved.url, wanted.url, request, parent)
            return resolved
          })
        }
        /* v8 ignore stop */
        assertEquivalent(actual.url, expected.url, request, parent)
        return actual
      }
      const cacheable = attributes === EMPTY_ATTRIBUTES || Object.keys(attributes).length === 0
      if (cacheable && state.esm !== undefined) return state.esm
      const route = state.route
      if (route.kind === 'native') {
        const result = native(request, parent, attributes)
        if (cacheable && !(result instanceof Promise)) state.esm = result
        return result
      }
      const routedParent = pathToFileURL(route.kind === 'fallback' ? route.entry.declarer : route.parent).href
      if (behavior === 'enforce') {
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
          /* v8 ignore next -- Node 24+ resolves synchronously; the Node 22 matrix covers its Promise result */
          if (result instanceof Promise) return result.catch(restoreImporter)
          if (cacheable) state.esm = result
          return result
        } finally {
          delegatedEsm = previous
        }
      }
      const actual = native(request, parent, attributes)
      const previous = delegatedEsm
      delegatedEsm = { parent: routedParent, request }
      const restoreImporter = (error: unknown): never => throwWithImporter(error, routedParent, parent)
      try {
        let expected: ResolveResult | Promise<ResolveResult>
        try {
          const result = native(request, routedParent, attributes)
          expected = result
          /* v8 ignore next -- Node 24+ resolves synchronously; the Node 22 matrix covers its Promise result */
          if (result instanceof Promise) expected = result.catch(restoreImporter)
        } catch (error) {
          return restoreImporter(error)
        }
        /* v8 ignore start -- Node 22 is the asynchronous adapter and is covered by the external version matrix */
        if (expected instanceof Promise || actual instanceof Promise) {
          return Promise.all([actual, expected]).then(([resolved, wanted]) => {
            assertEquivalent(resolved.url, wanted.url, request, parent)
            if (cacheable) state.esm = resolved
            return resolved
          })
        }
        /* v8 ignore stop */
        assertEquivalent(actual.url, expected.url, request, parent)
        if (cacheable) state.esm = actual
        return actual
      } finally {
        delegatedEsm = previous
      }
    }
    return adapted
  }

  let restoreEsm: () => void
  /* v8 ignore else -- CI coverage runs Node 24 v2; the Node 22 matrix exercises the v1 adapter */
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
      /* v8 ignore else -- registrations are disposed in reverse installation order */
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
    const anchor = routed.kind === 'fallback' ? routed.entry.declarer : routed.parent
    const synthetic = new cjs(anchor)
    // Late parent assignment preserves Node's require stack without publishing this routing anchor in parent.children.
    synthetic.parent = parent
    synthetic.filename = anchor
    synthetic.paths = routed.kind === 'fallback'
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
    synthetic.parent = parent
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
    if (route.kind === 'after-fallback') return resolveFrom(pathToFileURL(route.parent).href)
    return resolveFrom(pathToFileURL(route.entry.declarer).href)
  }
  const wrappedFilename: CommonJsModule['_resolveFilename'] = (request, parent, main, options) => {
    if (delegatedCjs || !parent?.filename) {
      return originalFilename.call(cjs, request, parent, main, options)
    }
    const parentFilename = parent.filename
    const cacheable = options?.paths === undefined && options?.conditions === undefined
    const explicitPaths = Array.isArray(options?.paths) ? options.paths : undefined
    if (explicitPaths !== undefined && router.nativeSelfReference(request, parentFilename)) {
      return originalFilename.call(cjs, request, parent, main, options)
    }
    const explicit = explicitPaths === undefined
      ? undefined
      : router.explicitRoute(request, explicitPaths)
    if (options?.paths !== undefined && explicit === undefined) {
      return originalFilename.call(cjs, request, parent, main, options)
    }
    if (explicit !== undefined && explicitPaths !== undefined && explicit.index > 0) {
      try {
        return originalFilename.call(cjs, request, parent, main, {
          ...options,
          paths: explicitPaths.slice(0, explicit.index),
        })
      } catch (error) {
        if (!isUnselectedPackageMiss(error)) throw error
      }
    }
    const state = router.routePath(
      request,
      explicit?.parent ?? parentFilename,
      searchPaths => resolveNativeCjs(request, searchPaths, parent, parentFilename, main, options?.conditions),
      explicit === undefined && cacheable,
    )
    if (state === undefined) {
      const scoped = startsWithin(parentFilename, profilePaths)
      const conditions = options?.conditions ?? cjsConditions
      const target = request[0] === '#' && scoped
        ? packageImportsTarget(parentFilename, request, conditions)
        : undefined
      if (target === undefined) return originalFilename.call(cjs, request, parent, main, options)
      const expected = resolvePackageImportCjs(target, conditions)
      if (behavior === 'enforce') return expected
      const actual = originalFilename.call(cjs, request, parent, main, options)
      assertEquivalent(actual, expected, request, parentFilename)
      return actual
    }
    if (cacheable && state.cjs !== undefined) return state.cjs
    const route = state.route
    if (route.kind === 'native') {
      const result = originalFilename.call(cjs, request, parent, main, options)
      if (cacheable) state.cjs = result
      return result
    }
    if (route.kind === 'after-fallback' && explicit !== undefined && explicitPaths !== undefined) {
      try {
        return originalFilename.call(cjs, request, parent, main, {
          ...options,
          paths: [dirname(route.parent)],
        })
      } catch (error) {
        if (!isUnselectedPackageMiss(error)) throw error
        const remaining = explicitPaths.slice(explicit.index + 1)
        if (remaining.length === 0) throw error
        return wrappedFilename(request, parent, main, { ...options, paths: remaining })
      }
    }
    delegatedCjs++
    try {
      const routedOptions = options?.conditions === undefined ? undefined : { conditions: options.conditions }
      let expected: string
      try {
        expected = resolveRoutedCjs(request, route, parent, main, routedOptions)
      } catch (error) {
        if (route.kind !== 'fallback' || !isUnselectedPackageMiss(error)) throw error
        try {
          expected = resolveRoutedCjs(
            request, { kind: 'after-fallback', parent: route.after }, parent, main, routedOptions,
          )
        } catch (afterError) {
          const remaining = explicit === undefined || explicitPaths === undefined
            ? []
            : explicitPaths.slice(explicit.index + 1)
          if (!isUnselectedPackageMiss(afterError) || remaining.length === 0) {
            throw afterError
          }
          delegatedCjs--
          try {
            return wrappedFilename(request, parent, main, { ...options, paths: remaining })
          } finally {
            delegatedCjs++
          }
        }
      }
      if (behavior === 'enforce') {
        if (cacheable) state.cjs = expected
        return expected
      }
      const actual = originalFilename.call(cjs, request, parent, main, options)
      assertEquivalent(actual, expected, request, parentFilename)
      if (cacheable) state.cjs = actual
      return actual
    } finally {
      delegatedCjs--
    }
  }
  cjs._resolveFilename = wrappedFilename

  return {
    packageDir(specifier, parentURL) {
      const expected = router.packageDir(specifier, parentURL)
      if (behavior !== 'verify' || !startsWithin(parentURL, profileUrls)) return expected
      const name = barePackageName(specifier)
      if (name === undefined) return expected
      let parent: string
      try {
        parent = fileURLToPath(parentURL)
      } catch {
        return expected
      }
      const actual = nativePackageDir(parent, name)
      assertOptionalEquivalent(actual, expected, specifier, parentURL)
      return expected
    },
    replace(next) { router.replace(next) },
    dispose() {
      /* v8 ignore else -- registrations are disposed in reverse installation order */
      if (cjs._resolveFilename === wrappedFilename) cjs._resolveFilename = originalFilename
      restoreEsm()
    },
  }
}

/**
 * Publish one generation for Harness-owned Workers.
 * @param generation - complete package table and profile scope.
 * @param behavior - enforce or verify the generation in newly created Workers.
 * @returns a disposer restoring the previous thread environment data.
 */
export function registerWorkerResolution(
  generation: ProfileResolutionGeneration,
  behavior: ProfileResolutionBehavior = 'enforce',
): () => void {
  const previous = getEnvironmentData(WORKER_RESOLUTION_KEY)
  setEnvironmentData(WORKER_RESOLUTION_KEY, { generation, behavior })
  return () => { setEnvironmentData(WORKER_RESOLUTION_KEY, previous) }
}

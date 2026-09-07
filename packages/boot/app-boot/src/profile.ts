/**
 * Profile discovery, initialization, and patch-layer composition for the
 * `dsh --profile` launcher family.
 *
 * A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
 * `package.json` (out-of-tree plugin dependencies plus the profile manifest
 * `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
 * (the user's own patch layer, applied after every bundle layer). Bundles are
 * npm packages whose manifest declares
 * `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is
 * composed by applying each bundle's patch list in `dsh.profile.bundles` order over
 * an empty entry list, then the profile's own patches, then any launcher
 * layers (`--patch` files and flag-derived patches).
 *
 * Module resolution is two-anchor by construction: a bundle name resolves
 * first from the dsh installation (the launcher's own package), then from the
 * profile directory. Pnpm-managed entries in the profile's `node_modules`
 * resolve first. Dsh-owned links add packages carried only by selected
 * bundles, while `$DSH_HOME/profiles/node_modules` supplies the installation
 * dependency closure through Node's ordinary parent-walk. Plain Node uses
 * symlinks for that shared fallback; packaged executables use ESM proxies so
 * external plugins retain the installation's module instances.
 * @module @deepseek-ai/dsh-app-boot/profile
 */

import { createRequire } from 'node:module'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { DshManifest, DshModuleFallbackManifest, ProfilePatchReload } from '@deepseek-ai/dsh-package-manifest'
import { resolve as resolvePackage, type Package as ResolvePackageManifest } from 'resolve.exports'
import { loadOverlayPatches } from './index.ts'

/** Directory under the Harness home holding every profile. */
export const PROFILES_DIR = 'profiles'

/** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** Profile-private package links projected into its pnpm-managed node_modules. */
const PROFILE_MODULE_FALLBACK_DIR = '.dsh-module-fallback'

/** Installation-owned defaults used when a shipped profile is first opened. */
export interface ProfileTemplate {
  /** Ordered bundle layer list. */
  bundles: readonly string[]
  /** User patch-file lifecycle for the generated profile. */
  patchReload: ProfilePatchReload
}

/** The slice of package.json both profiles and bundles use. */
export interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: DshManifest
}

/** One resolved bundle layer of a profile. */
export interface ProfileLayer {
  /** The bundle's package name, as listed in `dsh.profile.bundles`. */
  packageName: string
  /** Absolute directory of the resolved bundle package. */
  packageDir: string
  /** Absolute path of the bundle's patch file. */
  patchPath: string
  /** The parsed patch list. */
  patches: PatchOptions[]
}

/** A loaded profile: resolved bundle layers plus the user's own patch layer. */
export interface Profile {
  /** The profile name (its directory basename). */
  name: string
  /** Absolute profile directory. */
  dir: string
  /** Bundle layers in `dsh.profile.bundles` order. */
  layers: ProfileLayer[]
  /** Absolute path of the profile's own patch file. */
  patchPath: string
  /** The profile's own patches; empty when the file is absent. */
  patches: PatchOptions[]
  /** Whether the launcher watches user patch files after boot. */
  patchReload: ProfilePatchReload
}

/**
 * Resolve a profile's directory under the Harness home.
 * @param name - the profile name (`dsh --profile <name>`).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @returns the absolute profile directory (which may not exist yet).
 */
export function resolveProfileDir(name: string, home: string = resolveDshHome()): string {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
    // The launcher-maintained flat module fallback lives at this sibling path.
    || name === 'node_modules') {
    throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}

/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
    patchReload: 'startup',
  },
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    patchReload: 'live',
  },
  headless: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
    patchReload: 'startup',
  },
  sdk: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
    patchReload: 'startup',
  },
  'sdk-minimal': {
    bundles: ['@deepseek-ai/dsh-sdk-minimal'],
    patchReload: 'startup',
  },
}

/** Installation-owned bundle tuples normalized to the shipped template. */
const INSTALLATION_OWNED_PROFILE_TUPLES: Record<string, readonly string[]> = {
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'],
}

/** The bundle list a `dsh plugin` init uses for a name with no shipped template. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']

/** Custom profiles retain the historical live patch-file behavior. */
export const DEFAULT_PROFILE_PATCH_RELOAD: ProfilePatchReload = 'live'

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

// The hoisted linker gives out-of-tree plugins a flat node_modules whose
// missing peers (cordis and friends) fall through to the healed
// profiles/node_modules installation fallback, so every plugin shares the
// installation's single cordis instance instead of a duplicate. pnpm ≥10
// reads its settings from pnpm-workspace.yaml, not .npmrc.
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * Initialize a profile directory: manifest, empty user patch layer, and the
 * pnpm settings out-of-tree plugins need. Existing files are never touched,
 * so re-running is a no-op on an initialized profile.
 * @param dir - the profile directory from {@link resolveProfileDir}.
 * @param bundles - the initial `dsh.profile.bundles` layer list.
 * @param patchReload - user patch-file lifecycle; custom profiles default to live reload.
 */
export function initProfile(
  dir: string,
  bundles: readonly string[],
  patchReload: ProfilePatchReload = DEFAULT_PROFILE_PATCH_RELOAD,
): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: ProfileManifest & { private: boolean } = {
      name: `dsh-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles], patchReload } },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}

function readModuleProxyRecord(link: string): ModuleProxyRecord | undefined {
  try {
    return JSON.parse(readFileSync(join(link, 'package.json'), 'utf8')) as ModuleProxyRecord
  } catch {
    // Missing or invalid metadata is not managed state; callers reject it.
    return undefined
  }
}

/** Ensure `link` is a symlink to `target`, replacing a wrong link or a dsh-managed packaged proxy. */
function ensureSymlink(link: string, target: string): void {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    // Missing link (first run) — created below. Any other lstat failure on a
    // path we just created the parent of would resurface on symlinkSync.
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      const existing = stat.isDirectory() ? readModuleProxyRecord(link) : undefined
      if (existing?.dsh?.moduleFallback?.targets === undefined) {
        throw new Error(`dsh: ${link} exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback`)
      }
      rmSync(link, { recursive: true })
      stat = undefined
    }
    if (stat !== undefined) {
      if (symlinkPointsTo(link, target)) return
      // unlink deletes the reparse point itself on Windows too; rmSync treats a
      // junction as a directory and throws EISDIR unless recursive.
      unlinkSync(link)
    }
  }
  try {
    symlinkSync(target, link, 'junction')
  } catch (error) {
    // Concurrent launches heal the same fallback; losing the race to a
    // process writing the identical link is success, anything else is not.
    // The window between the lstat miss above and this write cannot be
    // staged deterministically from the public API.
    /* v8 ignore next 4 */
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
      || !lstatSync(link).isSymbolicLink() || !symlinkPointsTo(link, target)) {
      throw error
    }
  }
}

/** Resolve a link target without following the final path component. */
function canonicalLinkPath(path: string): string | undefined {
  try {
    return join(realpathSync.native(dirname(path)), basename(path))
  } catch (error) {
    // A missing parent means the candidate cannot identify an existing owned link.
    /* v8 ignore next 2 -- a non-ENOENT realpath failure requires a host filesystem fault */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    /* v8 ignore next -- see the host-filesystem exception above */
    throw error
  }
}

/** Return whether a symlink or junction points at the same path as `target`. */
function symlinkPointsTo(link: string, target: string): boolean {
  const actual = resolve(dirname(link), readlinkSync(link))
  const canonicalActual = canonicalLinkPath(actual)
  const canonicalTarget = canonicalLinkPath(resolve(target))
  return canonicalActual !== undefined && canonicalActual === canonicalTarget
}

/** Add one profile-owned fallback link without replacing a pnpm-managed entry. */
function ensureProfileSymlink(link: string, target: string): void {
  try {
    lstatSync(link)
    return
  } catch (error) {
    /* v8 ignore next -- a non-ENOENT lstat failure requires a host filesystem fault */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  ensureSymlink(link, target)
}

/** Package names represented by owned symlinks below one fallback node_modules. */
function ownedPackageNames(modulesDir: string): string[] {
  return readdirSync(modulesDir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      return readdirSync(join(modulesDir, entry.name), { withFileTypes: true })
        .filter(child => child.isSymbolicLink())
        .map(child => `${entry.name}/${child.name}`)
    }
    return entry.isSymbolicLink() ? [entry.name] : []
  })
}

/** Remove an obsolete owned target and its profile projection when still connected. */
function removeProfileSymlink(profileModulesDir: string, ownedModulesDir: string, packageName: string): void {
  const ownedLink = join(ownedModulesDir, packageName)
  const profileLink = join(profileModulesDir, packageName)
  try {
    if (lstatSync(profileLink).isSymbolicLink() && symlinkPointsTo(profileLink, ownedLink)) unlinkSync(profileLink)
  } catch (error) {
    /* v8 ignore next -- a non-ENOENT lstat failure requires a host filesystem fault */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    unlinkSync(ownedLink)
  } catch (error) {
    /* v8 ignore next -- concurrent identical cleanup may remove the link first */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

interface ModuleProxyManifest {
  name: string
  version: string
  private: true
  type: 'module'
  exports: Record<string, string>
  dsh: { moduleFallback: DshModuleFallbackManifest }
}

interface ModuleProxyRecord {
  version?: unknown
  dsh?: { moduleFallback?: { targets?: unknown } }
}

/** Return whether the process reads application modules from pkg's virtual filesystem. */
function isPackagedExecutable(): boolean {
  return (process as NodeJS.Process & { pkg?: unknown }).pkg !== undefined
}

/** Resolve one available explicit package export under Node ESM import conditions. */
function packageEntryFromPackage(
  packageName: string,
  packageDir: string,
  declared: ResolvePackageManifest['exports'],
  subpath: string,
): string | undefined {
  let candidates: string[] | void
  try {
    candidates = resolvePackage({ name: packageName, exports: declared }, subpath)
  } catch (error) {
    if ((error as Error).message.startsWith('No known conditions for ')) return undefined
    const specifier = subpath === '.' ? packageName : packageName + subpath.slice(1)
    throw new Error(`dsh: cannot resolve ESM export ${specifier} from installed package ${packageName}`, { cause: error })
  }
  for (const candidate of candidates ?? []) {
    const target = candidate
    const entry = resolve(packageDir, target)
    const relativeEntry = relative(packageDir, entry)
    if (!target.startsWith('./') || /^\.\.(?:[\\/]|$)/u.test(relativeEntry)) {
      throw new Error(`dsh: installed package ${packageName} export ${subpath} resolves outside its package: ${target}`)
    }
    if (existsSync(entry) && statSync(entry).isFile()) return pathToFileURL(entry).href
  }
  return undefined
}

/** Resolve every explicit ESM runtime export that an out-of-tree plugin can import. */
function packageProxySource(
  packageName: string,
  packageDir: string,
): { version: string; targets: Record<string, string> } {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    bin?: unknown
    exports?: unknown
    main?: unknown
    types?: unknown
    typings?: unknown
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`dsh: installed package ${packageName} must declare a non-empty version`)
  }
  const declared = manifest.exports
  if (declared === undefined) {
    const main = typeof manifest.main === 'string' && manifest.main.length > 0 ? manifest.main : undefined
    const entry = join(packageDir, main ?? 'index')
    try {
      const resolved = createRequire(join(packageDir, 'package.json')).resolve(entry)
      return { version: manifest.version, targets: { '.': pathToFileURL(resolved).href } }
    } catch (error) {
      if (main === undefined
        && (manifest.bin !== undefined || manifest.types !== undefined || manifest.typings !== undefined)) {
        return { version: manifest.version, targets: {} }
      }
      throw new Error(`dsh: installed package ${packageName} main entry is missing at ${entry}`, { cause: error })
    }
  }
  const subpaths = declared !== null && typeof declared === 'object' && !Array.isArray(declared)
    && Object.keys(declared).some(key => key.startsWith('.'))
    ? Object.keys(declared).filter(key => key === '.' || (
      key.startsWith('./') && !key.includes('*') && !key.endsWith('/') && key !== './package.json'
    ))
    : ['.']
  const targets: Record<string, string> = {}
  for (const subpath of subpaths) {
    const target = packageEntryFromPackage(
      packageName,
      packageDir,
      declared as ResolvePackageManifest['exports'],
      subpath,
    )
    if (target !== undefined) targets[subpath] = target
  }
  return { version: manifest.version, targets }
}

/**
 * Materialize a real package proxy whose exports retain pkg's virtual module
 * URL. Files outside the executable cannot traverse a symlink into
 * `/snapshot`, while an ESM re-export can import that URL and preserves the
 * executable's single module instance for out-of-tree plugin peers.
 */
function ensureModuleProxy(
  link: string,
  packageName: string,
  version: string,
  targets: Record<string, string>,
): void {
  const proxyExports = Object.fromEntries(
    Object.keys(targets).map((subpath, index) => [subpath, `./entry-${index}.js`]),
  )
  const manifest: ModuleProxyManifest = {
    name: packageName,
    version,
    private: true,
    type: 'module',
    exports: proxyExports,
    dsh: { moduleFallback: { targets } },
  }
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    stat = undefined
  }
  if (stat?.isSymbolicLink()) {
    unlinkSync(link)
    stat = undefined
  }
  if (stat !== undefined) {
    const existing = readModuleProxyRecord(link)
    if (existing?.dsh?.moduleFallback?.targets === undefined) {
      throw new Error(`dsh: ${link} exists and is not a dsh-managed module proxy; remove it so dsh can manage the installation fallback`)
    }
    if (existing.version === version
      && JSON.stringify(existing.dsh.moduleFallback.targets) === JSON.stringify(targets)
      && Object.keys(targets).every((_, index) => existsSync(join(link, `entry-${index}.js`)))) return
    rmSync(link, { recursive: true })
  }
  mkdirSync(link, { recursive: true })
  writeFileSync(join(link, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  for (const [index, target] of Object.values(targets).entries()) {
    const specifier = JSON.stringify(target)
    writeFileSync(
      join(link, `entry-${index}.js`),
      `export * from ${specifier}\nimport * as target from ${specifier}\nexport default target.default\n`,
    )
  }
}

type ModuleFallbackEntry =
  | { kind: 'symlink'; packageName: string; packageDir: string }
  | { kind: 'proxy'; packageName: string; version: string; targets: Record<string, string> }

/** Read one package manifest used while traversing a module-fallback dependency graph. */
function readModuleFallbackManifest(anchor: string): ProfileManifest {
  return JSON.parse(readFileSync(anchor, 'utf8')) as ProfileManifest
}

/** Return dependency names that may be imported by a loader-visible plugin. */
function profileDependencyNames(manifest: ProfileManifest): string[] {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
}

/** Resolve the installation generation that every profile must find through the fallback directory. */
function resolveModuleFallbackEntries(
  installAnchor: string,
): { entries: ModuleFallbackEntry[]; packageNames: ReadonlySet<string> } {
  const appManifest = readModuleFallbackManifest(installAnchor)
  const links = new Map<string, string>()
  /* v8 ignore next -- a real app manifest always declares its name */
  if (appManifest.name !== undefined) links.set(appManifest.name, dirname(installAnchor))
  // BFS over the resolvable dependency graph; the visited set is the link
  // map itself (first resolution wins, matching Node's own nearest-wins).
  const queue: { anchor: string; manifest: ProfileManifest }[] = [{ anchor: installAnchor, manifest: appManifest }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    // Peer dependencies participate: Service Definition packages (dsh-subprocess,
    // dsh-compaction, ...) are peers of their implementations, never plain
    // dependencies, yet out-of-tree plugins import them directly.
    /* v8 ignore next -- a real app manifest always declares dependencies */
    for (const dep of profileDependencyNames(next.manifest)) {
      if (links.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      // A declared-but-uninstalled dependency cannot be a loader-visible
      // plugin; skip it rather than fail the whole boot.
      if (dir === undefined) continue
      links.set(dep, dir)
      const manifestPath = join(dir, 'package.json')
      queue.push({ anchor: manifestPath, manifest: readModuleFallbackManifest(manifestPath) })
    }
  }
  const entries = !isPackagedExecutable()
    ? [...links].map(([packageName, packageDir]) => ({ kind: 'symlink' as const, packageName, packageDir }))
    : [...links].flatMap(([packageName, packageDir]) => {
      const source = packageProxySource(packageName, packageDir)
      return Object.keys(source.targets).length === 0
        ? []
        : [{ kind: 'proxy' as const, packageName, version: source.version, targets: source.targets }]
    })
  return { entries, packageNames: new Set(links.keys()) }
}

/** Return whether one existing fallback entry already matches its resolved installation generation. */
function moduleFallbackEntryCurrent(modulesDir: string, entry: ModuleFallbackEntry): boolean {
  const link = join(modulesDir, entry.packageName)
  try {
    const stat = lstatSync(link)
    if (entry.kind === 'symlink') {
      return stat.isSymbolicLink() && readlinkSync(link) === entry.packageDir
    }
    if (!stat.isDirectory()) return false
    const existing = readModuleProxyRecord(link)
    return existing?.version === entry.version
      && JSON.stringify(existing.dsh?.moduleFallback?.targets) === JSON.stringify(entry.targets)
      && Object.keys(entry.targets).every((_, index) => existsSync(join(link, `entry-${index}.js`)))
  } catch {
    return false
  }
}

/** Return whether every required fallback entry is already ready for this installation. */
function moduleFallbackCurrent(modulesDir: string, entries: readonly ModuleFallbackEntry[]): boolean {
  return entries.every(entry => moduleFallbackEntryCurrent(modulesDir, entry))
}

/** Inputs for {@link healProfilesModuleFallback}. */
export interface ProfileModuleFallbackOptions {
  /** Absolute package.json path of the running dsh installation. */
  installAnchor: string
  /** Loaded profile whose selected bundles may carry profile-local plugins. */
  profile?: Profile
  /** Harness home; defaults to {@link resolveDshHome}. */
  home?: string
}

/**
 * Maintain module fallbacks for one profile launch. The shared
 * `$DSH_HOME/profiles/node_modules` mirrors the dsh installation dependency
 * closure. Plain Node writes symlinks; a packaged executable writes ESM
 * proxies under a cross-process lock because operating-system links cannot
 * enter pkg's virtual filesystem. Missing packages carried only by selected
 * bundles are linked through a profile-owned directory into that profile's
 * `node_modules`; pnpm-managed entries remain authoritative, and another
 * profile's links cannot change its resolution.
 * @param options - installation anchor, optional loaded profile, and Harness home.
 * @returns settlement after the shared fallback and profile-local links are current.
 */
export async function healProfilesModuleFallback(options: ProfileModuleFallbackOptions): Promise<void> {
  const { installAnchor, profile, home = resolveDshHome() } = options
  const profilesDir = join(home, PROFILES_DIR)
  const modulesDir = join(profilesDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const { entries, packageNames } = resolveModuleFallbackEntries(installAnchor)
  if (!moduleFallbackCurrent(modulesDir, entries)) {
    await withFileLock(modulesDir, () => {
      if (!moduleFallbackCurrent(modulesDir, entries)) healProfilesModuleFallbackLocked(entries, modulesDir)
      return Promise.resolve()
    })
  }
  if (profile !== undefined) healProfileModuleFallback(profile, packageNames)
}

/** Heal one module-fallback generation while the cross-process writer lock is held. */
function healProfilesModuleFallbackLocked(entries: readonly ModuleFallbackEntry[], modulesDir: string): void {
  for (const entry of entries) {
    const link = join(modulesDir, entry.packageName)
    mkdirSync(dirname(link), { recursive: true })
    if (entry.kind === 'proxy') {
      ensureModuleProxy(link, entry.packageName, entry.version, entry.targets)
    } else {
      ensureSymlink(link, entry.packageDir)
    }
  }
}

/** Collect the first resolvable package directory for each dependency name. */
function dependencyClosure(
  anchors: readonly string[], reserved: ReadonlySet<string>,
  exclude: (candidate: string, packageName: string) => boolean,
): Map<string, string> {
  const links = new Map<string, string>()
  const visited = new Set(reserved)
  for (const anchor of anchors) {
    const canonicalAnchor = realpathSync.native(anchor)
    const manifest = readModuleFallbackManifest(canonicalAnchor)
    /* v8 ignore next -- an installable package manifest always declares its name */
    if (manifest.name === undefined) continue
    if (!visited.has(manifest.name)) {
      visited.add(manifest.name)
      links.set(manifest.name, dirname(canonicalAnchor))
    }
    const queue: { anchor: string; manifest: ProfileManifest }[] = [{ anchor: canonicalAnchor, manifest }]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      // Service Provider packages commonly expose Service Definitions as peers.
      /* v8 ignore next -- an installable package manifest always declares dependencies or peers */
      for (const dep of profileDependencyNames(next.manifest)) {
        if (visited.has(dep)) continue
        const dir = packageDirFromAnchor(next.anchor, dep, exclude)
        // A declared-but-uninstalled dependency cannot be loader-visible.
        if (dir === undefined) continue
        visited.add(dep)
        links.set(dep, dir)
        const manifestPath = join(dir, 'package.json')
        queue.push({ anchor: manifestPath, manifest: readModuleFallbackManifest(manifestPath) })
      }
    }
  }
  return links
}

/** Reconcile packages carried only by selected bundles into one profile. */
function healProfileModuleFallback(profile: Profile, installationPackageNames: ReadonlySet<string>): void {
  const profileModulesDir = join(profile.dir, 'node_modules')
  const ownedModulesDir = join(profile.dir, PROFILE_MODULE_FALLBACK_DIR, 'node_modules')
  mkdirSync(profileModulesDir, { recursive: true })
  mkdirSync(ownedModulesDir, { recursive: true })
  const bundleAnchors = profile.layers
    .filter(layer => !installationPackageNames.has(layer.packageName))
    .map(layer => join(layer.packageDir, 'package.json'))
  const bundleLinks = dependencyClosure(bundleAnchors, installationPackageNames, (candidate, packageName) => {
    const profileLink = join(profileModulesDir, packageName)
    if (canonicalLinkPath(candidate) !== canonicalLinkPath(profileLink)) return false
    try {
      return lstatSync(profileLink).isSymbolicLink()
        && symlinkPointsTo(profileLink, join(ownedModulesDir, packageName))
    } catch (error) {
      // A concurrent cleanup may remove the projection after package discovery.
      /* v8 ignore next 2 -- a non-ENOENT lstat failure requires a host filesystem fault */
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      /* v8 ignore next -- see the host-filesystem exception above */
      throw error
    }
  })
  for (const layer of profile.layers) bundleLinks.delete(layer.packageName)
  for (const packageName of ownedPackageNames(ownedModulesDir)) {
    if (!bundleLinks.has(packageName)) removeProfileSymlink(profileModulesDir, ownedModulesDir, packageName)
  }
  for (const [packageName, target] of bundleLinks) {
    const ownedLink = join(ownedModulesDir, packageName)
    mkdirSync(dirname(ownedLink), { recursive: true })
    ensureSymlink(ownedLink, target)
    const profileLink = join(profileModulesDir, packageName)
    mkdirSync(dirname(profileLink), { recursive: true })
    ensureProfileSymlink(profileLink, ownedLink)
  }
}

/**
 * Read a profile's manifest.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param dir - the profile directory.
 * @returns the parsed manifest.
 */
export function readProfileManifest(binName: string, dir: string): ProfileManifest {
  const path = join(dir, 'package.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read profile manifest ${path}: ${String(error)}`)
  }
  // The field checks below validate the file data before trusting the parse type.
  const parsed = JSON.parse(raw) as ProfileManifest | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${binName}: profile manifest ${path} must hold a JSON object`)
  }
  return parsed
}

/**
 * Write a profile's manifest back (2-space JSON, trailing newline).
 * @param dir - the profile directory.
 * @param manifest - the manifest value to persist.
 */
export function writeProfileManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

/** Return whether two bundle lists have the same values in the same order. */
function sameBundles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Normalize an exact installation-owned bundle tuple to its shipped template,
 * or add the shipped reload default to an exact current tuple. A changed value
 * is written back during profile loading while every other manifest field is
 * preserved; any other bundle list is user-owned and remains untouched.
 */
function normalizeShippedProfile(name: string, dir: string, manifest: ProfileManifest): ProfileManifest {
  const installationOwned = INSTALLATION_OWNED_PROFILE_TUPLES[name]
  const template = PROFILE_TEMPLATES[name]
  const bundles = manifest.dsh?.profile?.bundles
  if (template === undefined || bundles === undefined) return manifest
  const isRetiredTuple = installationOwned !== undefined && sameBundles(bundles, installationOwned)
  const isCurrentTuple = sameBundles(bundles, template.bundles)
  const needsReloadDefault = manifest.dsh?.profile?.patchReload === undefined && isCurrentTuple
  if (!isRetiredTuple && !needsReloadDefault) return manifest
  const normalized: ProfileManifest = {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...template.bundles],
        patchReload: manifest.dsh?.profile?.patchReload ?? template.patchReload,
      },
    },
  }
  writeProfileManifest(dir, normalized)
  return normalized
}

/**
 * Resolve a package's root directory from one anchor without depending on the
 * package exporting `./package.json` (`require.resolve` would need that):
 * probe the require resolution paths for a directory holding the named
 * manifest. This is Node's own node_modules lookup order, so the result
 * matches what the Loader would import from the same anchor, and
 * `existsSync` follows the symlinks pnpm's isolated layout uses.
 */
function packageDirFromAnchor(
  anchor: string, packageName: string,
  exclude: (candidate: string, packageName: string) => boolean = () => false,
): string | undefined {
  // resolve.paths returns null only for builtins, which no bundle name is.
  /* v8 ignore next */
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json')) && !exclude(candidate, packageName)) return candidate
  }
  return undefined
}

/**
 * Resolve one bundle package's directory: installation anchor first, then the
 * profile directory. The installation-first order is the contract that
 * `@deepseek-ai/dsh-base` (and every other in-box bundle) always comes from
 * the same installation as the running dsh, never from a profile-local copy.
 * Resolution does not require the package to export `./package.json`.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param packageName - the bundle's package name from `dsh.profile.bundles`.
 * @param installAnchor - absolute path of a file inside the dsh app package (its package.json).
 * @param profileDir - the profile directory (second anchor).
 * @returns the bundle package's absolute directory.
 */
export function resolveBundleDir(
  binName: string, packageName: string, installAnchor: string, profileDir: string,
): string {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== undefined) return dir
  }
  throw new Error(
    `${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation or ${profileDir}; `
    + `run 'dsh plugin --profile ${basename(profileDir)} install' if its dependency is not installed`,
  )
}

/**
 * Load an already initialized profile directory without resolving it through
 * the shared Harness home. This is used by application-owned profiles whose
 * package project and lifecycle belong to that application.
 * @param binName - the diagnostic prefix on thrown errors.
 * @param dir - absolute profile package directory.
 * @param installAnchor - absolute path of the owning dsh app's package.json.
 * @param options - `userLayer: false` skips reading `cordis.patch.yml`.
 * @returns the resolved bundle layers and optional user patch layer.
 */
export function loadProfileDirectory(
  binName: string,
  dir: string,
  installAnchor: string,
  options: { userLayer?: boolean } = {},
): Profile {
  const manifest = readProfileManifest(binName, dir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const rawPatchReload: unknown = manifest.dsh?.profile?.patchReload
  if (rawPatchReload !== undefined && rawPatchReload !== 'live' && rawPatchReload !== 'startup') {
    throw new Error(
      `${binName}: profile manifest ${join(dir, 'package.json')} dsh.profile.patchReload must be "live" or "startup"`,
    )
  }
  const patchReload = rawPatchReload ?? DEFAULT_PROFILE_PATCH_RELOAD
  const layers = bundles.map((packageName): ProfileLayer => {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
    const bundleManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as ProfileManifest
    const declared = bundleManifest.dsh?.bundle?.patch
    if (declared === undefined) {
      throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
    }
    const patchPath = join(packageDir, declared)
    return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) }
  })
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const patches = options.userLayer !== false && existsSync(patchPath)
    ? loadOverlayPatches(binName, patchPath)
    : []
  return { name: basename(dir), dir, layers, patchPath, patches, patchReload }
}

/**
 * Load a profile: resolve every `dsh.profile.bundles` entry to its patch
 * layer and parse the profile's own patch file. A listed bundle without a
 * `dsh.bundle` manifest fails loud — naming a bundle-less package as a layer
 * is a misconfiguration, not "no patches".
 * @param binName - the diagnostic prefix on thrown errors.
 * @param name - the profile name.
 * @param installAnchor - absolute path of the dsh app's package.json (first resolution anchor).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @param options - `userLayer: false` skips reading `cordis.patch.yml`, so a
 * bundles-only consumer (`--dump-default-config`, a recovery diagnostic)
 * cannot fail on a broken user layer.
 * @returns the loaded profile (empty `patches` when the user layer is skipped).
 */
export function loadProfile(
  binName: string, name: string, installAnchor: string, home: string = resolveDshHome(),
  options: { userLayer?: boolean } = {},
): Profile {
  const dir = resolveProfileDir(name, home)
  if (!existsSync(join(dir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[name]
    if (template === undefined) {
      throw new Error(
        `${binName}: profile ${JSON.stringify(name)} does not exist; create it with 'dsh plugin --profile ${name} add <package>'`,
      )
    }
    initProfile(dir, template.bundles, template.patchReload)
  }
  normalizeShippedProfile(name, dir, readProfileManifest(binName, dir))
  return loadProfileDirectory(binName, dir, installAnchor, options)
}

/**
 * Compose patch layers into the effective entry list over an empty root —
 * the same single `applyEntryPatches` call the boot include makes, so flag
 * derivation and config dumps see exactly what mounts.
 * @param layers - patch lists in application order.
 * @param warn - sink for skipped-patch diagnostics; defaults to silent (boot repeats them).
 * @returns the composed entry list.
 */
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}

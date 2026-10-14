/**
 * Profile discovery, initialization, and patch-layer composition for the
 * `dsh --profile` launcher family.
 *
 * A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
 * `package.json` (out-of-tree plugin dependencies plus the profile manifest
 * `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
 * (the user's own patch layer, applied after every bundle layer). Bundles are
 * npm packages whose manifest declares
 * `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` (one file, or an
 * ordered list of files); the tree is composed by applying each bundle's patch
 * lists in `dsh.profile.bundles` order over an empty entry list, then the
 * profile's own patches, then any launcher layers (`--patch` files and
 * flag-derived patches).
 *
 * Module resolution is two-anchor by construction: a bundle name resolves
 * first from the dsh installation (the launcher's own package), then from the
 * profile directory. Pnpm-managed entries in the profile's `node_modules`
 * resolve first. The runtime resolution supplies packages carried by the
 * installation and selected bundles to Node's ESM and CommonJS resolvers.
 * @module @deepseek-ai/dsh-app-boot/profile
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { DshBundleManifest, DshPackageManifest } from '@deepseek-ai/dsh-package-manifest'
import { evaluatePluginCompatibility, pluginCompatibilityWarning } from './plugin-compatibility.ts'
import { readProfileVersionExemptions } from './profile-compatibility.ts'
import { loadOverlayPatches } from './index.ts'
import { realModuleDirectory } from './profile-resolution/legacy-links.ts'

/** Directory under the Harness home holding every profile. */
export const PROFILES_DIR = 'profiles'

/** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** Installation-owned defaults used when a shipped profile is first opened. */
export interface ProfileTemplate {
  /** Ordered bundle layer list. */
  bundles: readonly string[]
}

/** Package metadata accepted by the profile reader; local profiles need no published identity. */
export type ProfileManifest = Partial<DshPackageManifest>

/**
 * The patch files a bundle declares, as written: one file for a string
 * `patch`, the listed files in order for an array.
 * @param bundle - the bundle's `dsh.bundle` declaration, as read from package.json.
 * @returns the package-relative patch file paths in application order.
 * @throws {Error} when `patch` is neither a string nor a list of strings.
 */
export function bundlePatchFiles(bundle: DshBundleManifest): string[] {
  const declared = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
  if (!Array.isArray(declared) || !declared.every(file => typeof file === 'string')) {
    throw new Error('dsh.bundle.patch must be a file path or a list of file paths')
  }
  return declared
}

/**
 * Resolve a bundle declaration to its ordered absolute patch files.
 * @param packageDir - absolute directory of the bundle package.
 * @param bundle - the bundle's `dsh.bundle` declaration, as read from package.json.
 * @returns the absolute patch file paths in application order.
 * @throws {Error} when `patch` is neither a string nor a list of strings.
 */
export function bundlePatchPaths(packageDir: string, bundle: DshBundleManifest): string[] {
  return bundlePatchFiles(bundle).map(file => join(packageDir, file))
}

/** One resolved bundle layer of a profile. */
export interface ProfileLayer {
  /** The bundle's package name, as listed in `dsh.profile.bundles`. */
  packageName: string
  /** Absolute directory of the resolved bundle package. */
  packageDir: string
  /** Absolute paths of the bundle's patch files, in application order. */
  patchPaths: readonly string[]
  /** The parsed patch lists of every file, concatenated in application order. */
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
  /** Selected bundles that contributed no layer, in `dsh.profile.bundles` order, with why. */
  skippedBundles: SkippedBundle[]
}

/** A selected bundle the profile could not load, or whose own DSH peers the profile does not exempt. */
export interface SkippedBundle {
  /** The bundle's package name from `dsh.profile.bundles`. */
  packageName: string
  /** The resolution, manifest, compatibility, or patch-loading failure. */
  reason: string
}

/**
 * Print each skipped bundle once; loading never prints, so launchers call this once per start.
 * @param binName - the diagnostic prefix.
 * @param profile - the loaded profile.
 */
export function reportSkippedBundles(binName: string, profile: Pick<Profile, 'skippedBundles'>): void {
  for (const { packageName, reason } of profile.skippedBundles) {
    process.stderr.write(`${binName}: skipping profile bundle ${JSON.stringify(packageName)}: ${reason}\n`)
  }
}

/** One package the runtime resolution supplies at the interception layer. */
export interface RuntimeResolutionEntry {
  /** Bare package name. */
  readonly name: string
  /** Package directory selected by the existing dependency traversal. */
  readonly packageDir: string
  /** Selected package version when its manifest declares one. */
  readonly version: string | undefined
  /** Manifest whose dependency edge selected this package. */
  readonly declarer: string
  /** Whether every profile or only the active profile receives this entry. */
  readonly scope: 'installation' | 'profile'
}

/**
 * A profile node_modules entry linked to a directory outside the shared profiles tree and the active profile.
 * Importers below `realPath` use Node's real ancestor chain, with peer mappings read at each node_modules position.
 */
export interface LinkedRoot {
  /** Package name of the profile `node_modules` entry, including its scope. */
  readonly name: string
  /** Real directory outside the shared profiles tree and active profile; a package.json is optional. */
  readonly realPath: string
}

/** Complete immutable package table for one profile launch. */
export interface RuntimeResolution {
  /** Directory containing every profile; its node_modules is the interception layer. */
  readonly profilesDir: string
  /** Active profile directory, when profile-scope entries were included. */
  readonly profileDir: string | undefined
  /** Profile-declared packages installed in the profile's own node_modules. */
  readonly localPackageNames: readonly string[]
  /** Installation-scope entries followed by profile-scope entries in precedence order. */
  readonly entries: readonly RuntimeResolutionEntry[]
  /** Active profile links to external directories, sorted by name. */
  readonly linkedRoots: readonly LinkedRoot[]
}

/**
 * Resolve a profile's directory under the Harness home.
 * @param name - the profile name (`dsh --profile <name>`).
 * @param home - the Harness home; defaults to {@link resolveDshHome}.
 * @returns the absolute profile directory (which may not exist yet).
 */
export function resolveProfileDir(name: string, home: string = resolveDshHome()): string {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
    // Node reserves this name for dependency lookup.
    || name === 'node_modules') {
    throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}

/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  },
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  },
  headless: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  },
  sdk: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  },
  'sdk-minimal': {
    bundles: ['@deepseek-ai/dsh-sdk-minimal'],
  },
}

/** Installation-owned bundle tuples normalized to the shipped template. */
const INSTALLATION_OWNED_PROFILE_TUPLES: Record<string, readonly string[]> = {
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'],
}

/**
 * Bundles an earlier release shipped and the installation no longer carries;
 * {@link loadProfileDirectory} removes them from the profile's bundle list.
 */
const RETIRED_BUNDLES: ReadonlySet<string> = new Set([
  // The Web composition mounts Schedule itself
  // ([upgrade guide](../../../../docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md)).
  '@deepseek-ai/dsh-experimental-schedule-bundle',
])

/** The bundle list a `dsh plugin` init uses for a name with no shipped template. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']

/**
 * The bundles the dsh installation ships for a person to switch on: each a
 * runtime dependency of the installation that declares `dsh.bundle.patch`,
 * an `icon`, and `./locale/*.json` display metadata, selected by no shipped
 * template, and offered switched off by the plugin manager
 * ([rationale](../../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md),
 * [admission](../../../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)).
 */
export const OPTIONAL_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-tool-worktree',
]

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

// The hoisted linker gives out-of-tree plugins a flat node_modules whose
// missing peers (cordis and friends) use the runtime resolution, so every plugin shares the
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
 */
export function initProfile(
  dir: string,
  bundles: readonly string[],
): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: ProfileManifest & { private: boolean } = {
      name: `dsh-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}

/** Directory where the link backend of the dsh 0.1.5 releases projected bundle-carried packages into a profile. */
const LINK_PROJECTION_DIR = '.dsh-module-fallback'

/**
 * Remove the package projections a link-backend launch left in a profile.
 * Only symlinks under the profile's `node_modules` whose target lies inside
 * `<profile>/.dsh-module-fallback/node_modules` are unlinked, then that directory is removed;
 * pnpm-installed packages and every other symlink stay. A profile without the directory is untouched.
 * @param dir - the profile directory.
 */
export function removeLinkProjections(dir: string): void {
  const owned = join(dir, LINK_PROJECTION_DIR)
  if (!existsSync(owned)) return
  const ownedModules = join(owned, 'node_modules')
  for (const link of symlinksUnder(join(dir, 'node_modules'))) {
    if (pointsInto(link, ownedModules)) unlinkSync(link)
  }
  rmSync(owned, { recursive: true, force: true })
}

/** Top-level and scoped entries under a node_modules directory that are symlinks or junctions. */
function symlinksUnder(modules: string): string[] {
  const links: string[] = []
  if (!existsSync(modules)) return links
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    const path = join(modules, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(path)
    } else if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (child.isSymbolicLink()) links.push(join(path, child.name))
      }
    }
  }
  return links
}

/**
 * Active profile `node_modules` entries linked outside the shared profiles tree and the active profile.
 * Missing targets and files are not linked roots; invalid link chains retain Node's diagnostic.
 */
function linkedProfileRoots(profile: Profile, profilesDir: string): LinkedRoot[] {
  const modules = join(profile.dir, 'node_modules')
  const links = symlinksUnder(modules)
  if (links.length === 0) return []
  let tree: string
  try {
    tree = realModuleDirectory(profilesDir) + sep
  } catch (error) {
    // A profiles tree that is not materialized yet holds no links.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    tree = resolve(profilesDir) + sep
  }
  const excludedTrees = [tree, realModuleDirectory(profile.dir) + sep]
  const roots: LinkedRoot[] = []
  for (const linkPath of links) {
    let realPath: string
    try {
      realPath = realModuleDirectory(linkPath)
    } catch (error) {
      // A dangling link is not a package Node can load from the profile.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }
    if (excludedTrees.some(prefix => realPath + sep === prefix || realPath.startsWith(prefix))
      || !statSync(realPath).isDirectory()) continue
    roots.push({ name: relative(modules, linkPath).split(sep).join('/'), realPath })
  }
  return roots.sort((left, right) => left.name.localeCompare(right.name))
}

/** Whether a symlink's target directory is `root` or lies below it. */
function pointsInto(link: string, root: string): boolean {
  try {
    const target = resolve(dirname(link), readlinkSync(link))
    const parent = realpathSync.native(dirname(target))
    const rootPath = realpathSync.native(root)
    return parent === rootPath || parent.startsWith(rootPath + sep)
  } catch (error) {
    // A target whose parent no longer exists cannot be one of the projections this launch owns.
    /* v8 ignore next 2 -- a non-ENOENT realpath failure requires a host filesystem fault */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    /* v8 ignore next -- see the host-filesystem exception above */
    throw error
  }
}

/** Read one package manifest while traversing a dependency graph. */
function readPackageManifest(anchor: string): ProfileManifest {
  return JSON.parse(readFileSync(anchor, 'utf8')) as ProfileManifest
}

/** Return dependency names that may be imported by a loader-visible plugin. */
function profileDependencyNames(manifest: ProfileManifest): string[] {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
}

/** Resolve the installation packages that the runtime resolver supplies to every profile. */
function collectInstallationScopePackages(
  installAnchor: string, skippedBundles: ReadonlySet<string>,
): {
  packageNames: ReadonlySet<string>
  packageDirs: ReadonlyMap<string, string>
  declarers: ReadonlyMap<string, string>
  versions: ReadonlyMap<string, string | undefined>
} {
  // Real declaring paths keep workspace symlinks under node_modules from disabling tsx path mappings.
  const canonicalAnchor = join(realModuleDirectory(dirname(installAnchor)), basename(installAnchor))
  const appManifest = readPackageManifest(canonicalAnchor)
  const links = new Map<string, string>()
  const declarers = new Map<string, string>()
  const versions = new Map<string, string | undefined>()
  /* v8 ignore next -- a real app manifest always declares its name */
  if (appManifest.name !== undefined) {
    // The CLI derives the installation anchor from import.meta.url (already real) and the Desktop Host from its
    // runtime directory (not a symlink); the directory is kept as given rather than canonicalized here.
    links.set(appManifest.name, dirname(installAnchor))
    declarers.set(appManifest.name, canonicalAnchor)
    versions.set(appManifest.name, appManifest.version)
  }
  // BFS over the resolvable dependency graph; the visited set is the link
  // map itself (first resolution wins, matching Node's own nearest-wins).
  const queue: { anchor: string; manifest: ProfileManifest }[] = [{ anchor: canonicalAnchor, manifest: appManifest }]
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
      const manifestPath = join(realModuleDirectory(dir), 'package.json')
      let manifest: ProfileManifest
      try {
        manifest = skippedBundles.has(dep) ? readProfileManifest('dsh', dir) : readPackageManifest(manifestPath)
      } catch (error) {
        if (!skippedBundles.has(dep)) throw error
        continue
      }
      links.set(dep, dir)
      declarers.set(dep, next.anchor)
      versions.set(dep, manifest.version)
      queue.push({ anchor: manifestPath, manifest })
    }
  }
  return { packageNames: new Set(links.keys()), packageDirs: links, declarers, versions }
}

/** Inputs for {@link createRuntimeResolution}. */
export interface RuntimeResolutionOptions {
  /** Absolute package.json path of the running dsh installation. */
  installAnchor: string
  /** Loaded profile whose selected bundles may carry profile-local plugins. */
  profile?: Profile
  /** Harness home; defaults to {@link resolveDshHome}. */
  home?: string
}

/**
 * Compute the runtime resolution without writing module-resolution files.
 * @param options - installation anchor, optional loaded profile, and Harness home.
 * @returns the complete immutable runtime resolution.
 */
export async function createRuntimeResolution(
  options: RuntimeResolutionOptions,
): Promise<ProfileRuntimeResolution> {
  const { installAnchor, profile, home = resolveDshHome() } = options
  const profilesDir = join(home, PROFILES_DIR)
  const manifest = readOptionalProfileManifest(profile)
  const { packageNames, packageDirs, declarers, versions } = collectInstallationScopePackages(
    installAnchor, new Set(profile?.skippedBundles.map(skipped => skipped.packageName)),
  )
  const profileDeclarers = new Map<string, string>()
  const profileVersions = new Map<string, string | undefined>()
  const localPackageNames = profile === undefined ? [] : installedProfilePackageNames(profile, manifest)
  const profilePackages: ReadonlyMap<string, string> = profile === undefined
    ? new Map<string, string>()
    : collectProfileScopePackages(profile, packageNames, profileDeclarers, profileVersions)
  const linkedRoots = profile === undefined ? [] : linkedProfileRoots(profile, profilesDir)
  // The Promise return type is the pre-stable API; construction has no asynchronous step.
  return await Promise.resolve(new ProfileRuntimeResolution({ installAnchor, profileDir: profile?.dir, home }, {
    profilesDir,
    profileDir: profile?.dir,
    localPackageNames: Object.freeze(localPackageNames),
    linkedRoots: Object.freeze(linkedRoots.map(root => Object.freeze(root))),
    entries: Object.freeze([
      ...[...packageDirs].map(([name, packageDir]) => Object.freeze({
        name, packageDir, version: versions.get(name),
        declarer: declarers.get(name) as string, scope: 'installation' as const,
      })),
      ...[...profilePackages].map(([name, packageDir]) => Object.freeze({
        name, packageDir, version: profileVersions.get(name),
        declarer: profileDeclarers.get(name) as string, scope: 'profile' as const,
      })),
    ]),
  }))
}

/** Inputs a {@link ProfileRuntimeResolution} reuses to compute its successor. */
interface ResolutionSource {
  installAnchor: string
  home: string
  profileDir: string | undefined
}

/**
 * A runtime resolution that remembers the inputs it was computed from. Worker environment data carries only its
 * fields; the inputs stay private to the thread that computed it.
 */
export class ProfileRuntimeResolution implements RuntimeResolution {
  readonly profilesDir: string
  readonly profileDir: string | undefined
  readonly localPackageNames: readonly string[]
  readonly entries: readonly RuntimeResolutionEntry[]
  readonly linkedRoots: readonly LinkedRoot[]
  readonly #source: ResolutionSource

  /**
   * @param source - inputs of {@link createRuntimeResolution}, reused by {@link computeLatestResolution}.
   * @param table - the computed package table.
   */
  constructor(source: ResolutionSource, table: RuntimeResolution) {
    this.#source = source
    this.profilesDir = table.profilesDir
    this.profileDir = table.profileDir
    this.localPackageNames = table.localPackageNames
    this.entries = table.entries
    this.linkedRoots = table.linkedRoots
    Object.freeze(this)
  }

  /**
   * Compute the latest generation from the same installation, profile directory, and Harness home, rereading the
   * profile's manifest, bundle selection, and installed packages from disk, without retaining synthetic layers.
   * With no profile directory, only installation packages are recomputed. This instance is unchanged.
   * @returns a new resolution for the latest generation.
   */
  computeLatestResolution(): Promise<ProfileRuntimeResolution> {
    const { installAnchor, home, profileDir } = this.#source
    return createRuntimeResolution({
      installAnchor, home,
      ...profileDir === undefined ? {} : { profile: loadProfileDirectory('dsh', profileDir, installAnchor) },
    })
  }
}

/** Synthetic profiles used by direct callers may have no on-disk manifest. */
function readOptionalProfileManifest(profile: Profile | undefined): ProfileManifest | undefined {
  if (profile === undefined) return undefined
  try {
    return readPackageManifest(join(profile.dir, 'package.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Return installed direct dependencies that Node resolves before profile fallback. */
function installedProfilePackageNames(profile: Profile, manifest: ProfileManifest | undefined): string[] {
  if (manifest === undefined) return []
  return profileDependencyNames(manifest)
    .filter(name => existsSync(join(profile.dir, 'node_modules', name, 'package.json')))
}

/** Collect the first resolvable package directory for each dependency name. */
function dependencyClosure(
  anchors: readonly string[], reserved: ReadonlySet<string>,
  declarers?: Map<string, string>,
  versions?: Map<string, string | undefined>,
): Map<string, string> {
  const links = new Map<string, string>()
  const visited = new Set(reserved)
  for (const anchor of anchors) {
    const canonicalAnchor = join(realModuleDirectory(dirname(anchor)), basename(anchor))
    const manifest = readPackageManifest(canonicalAnchor)
    /* v8 ignore next -- an installable package manifest always declares its name */
    if (manifest.name === undefined) continue
    if (!visited.has(manifest.name)) {
      visited.add(manifest.name)
      links.set(manifest.name, dirname(canonicalAnchor))
      declarers?.set(manifest.name, canonicalAnchor)
      versions?.set(manifest.name, manifest.version)
    }
    const queue: { anchor: string; manifest: ProfileManifest }[] = [{ anchor: canonicalAnchor, manifest }]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      // Service Provider packages commonly expose Service Definitions as peers.
      /* v8 ignore next -- an installable package manifest always declares dependencies or peers */
      for (const dep of profileDependencyNames(next.manifest)) {
        if (visited.has(dep)) continue
        const dir = packageDirFromAnchor(next.anchor, dep)
        // A declared-but-uninstalled dependency cannot be loader-visible.
        if (dir === undefined) continue
        visited.add(dep)
        links.set(dep, dir)
        declarers?.set(dep, next.anchor)
        const manifestPath = join(realModuleDirectory(dir), 'package.json')
        const dependencyManifest = readPackageManifest(manifestPath)
        versions?.set(dep, dependencyManifest.version)
        queue.push({ anchor: manifestPath, manifest: dependencyManifest })
      }
    }
  }
  return links
}

/** Collect packages carried by the profile's selected bundles that the installation does not supply. */
function collectProfileScopePackages(
  profile: Profile, installationPackageNames: ReadonlySet<string>,
  declarers?: Map<string, string>,
  versions?: Map<string, string | undefined>,
): Map<string, string> {
  const bundleAnchors = profile.layers
    .filter(layer => !installationPackageNames.has(layer.packageName))
    .map(layer => join(layer.packageDir, 'package.json'))
  const bundleLinks = dependencyClosure(bundleAnchors, installationPackageNames, declarers, versions)
  for (const layer of profile.layers) bundleLinks.delete(layer.packageName)
  return bundleLinks
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

/** Return `manifest` with `dsh.profile.bundles` replaced, preserving all other fields. */
function withBundles(manifest: ProfileManifest, bundles: readonly string[]): ProfileManifest {
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...bundles],
      },
    },
  }
}

/**
 * Normalize an exact installation-owned bundle tuple to its shipped template,
 * preserving all other manifest fields. Other bundle lists remain untouched.
 */
function normalizeShippedProfile(name: string, dir: string, manifest: ProfileManifest): ProfileManifest {
  const installationOwned = INSTALLATION_OWNED_PROFILE_TUPLES[name]
  const template = PROFILE_TEMPLATES[name]
  const bundles = manifest.dsh?.profile?.bundles
  if (template === undefined || bundles === undefined) return manifest
  const isRetiredTuple = installationOwned !== undefined && sameBundles(bundles, installationOwned)
  if (!isRetiredTuple) return manifest
  const normalized = withBundles(manifest, template.bundles)
  writeProfileManifest(dir, normalized)
  return normalized
}

/**
 * Remove {@link RETIRED_BUNDLES} from a profile's bundle list, writing the
 * manifest back only when it listed one.
 */
function dropRetiredBundles(dir: string, manifest: ProfileManifest): ProfileManifest {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const kept = bundles.filter(bundle => !RETIRED_BUNDLES.has(bundle))
  if (kept.length === bundles.length) return manifest
  const normalized = withBundles(manifest, kept)
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
function packageDirFromAnchor(anchor: string, packageName: string): string | undefined {
  // resolve.paths returns null only for builtins, which no bundle name is.
  /* v8 ignore next */
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
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
 * Retired bundles are removed from the stored bundle list first, rewriting the
 * manifest when it listed one. Unreadable bundles, and bundles whose own dsh peers the profile does not exempt, are skipped
 * without changing the manifest and listed in `skippedBundles`; nothing is printed.
 * @param binName - the diagnostic prefix on thrown errors.
 * @param dir - absolute profile package directory.
 * @param installAnchor - absolute path of the owning dsh app's package.json.
 * @param options - `userLayer: false` skips reading `cordis.patch.yml`.
 * @returns the successfully loaded bundle layers and optional user patch layer.
 */
export function loadProfileDirectory(
  binName: string,
  dir: string,
  installAnchor: string,
  options: { userLayer?: boolean } = {},
): Profile {
  const manifest = dropRetiredBundles(dir, readProfileManifest(binName, dir))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const layers: ProfileLayer[] = []
  const skippedBundles: SkippedBundle[] = []
  const exemptions = bundles.length === 0 ? {} : readProfileVersionExemptions(dir)
  for (const packageName of bundles) {
    try {
      const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
      const bundleManifest = readProfileManifest(binName, packageDir)
      const bundle = bundleManifest.dsh?.bundle
      if (bundle === undefined) {
        throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
      }
      // A bundle is not a plugin row, so row admission never reads its own peers.
      const issue = evaluatePluginCompatibility(bundleManifest, exemptions)
      if (issue !== undefined && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue))
      const patchPaths = bundlePatchPaths(packageDir, bundle)
      const patches = patchPaths.flatMap(patchPath => loadOverlayPatches(binName, patchPath))
      layers.push({ packageName, packageDir, patchPaths, patches })
    } catch (error) {
      skippedBundles.push({ packageName, reason: String(error) })
    }
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const patches = options.userLayer !== false && existsSync(patchPath)
    ? loadOverlayPatches(binName, patchPath)
    : []
  return { name: basename(dir), dir, layers, patchPath, patches, skippedBundles }
}

/**
 * Load a profile: resolve every `dsh.profile.bundles` entry to its patch
 * layer and parse the profile's own patch file. Unreadable or incompatible bundles
 * are skipped and listed in `skippedBundles`; profile manifest and user patch errors still throw.
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
    initProfile(dir, template.bundles)
  }
  removeLinkProjections(dir)
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

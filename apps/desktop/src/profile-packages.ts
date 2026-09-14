/** Desktop-owned host links and validation of the external plugin dependency graph. */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { satisfies } from 'semver'
import { desktopRuntimeId, runtimePath, type DesktopRuntimeDescriptor } from './runtime-tree.ts'

/** Applied runtime identity and the only links Desktop may replace. */
export const DESKTOP_PROFILE_STATE = 'desktop-runtime-state.json'

/** Durable ownership of a package-directory link. */
export interface DesktopPackageLink {
  readonly name: string
  readonly target: string
}

/** Runtime identity and managed links; package preparation may still be pending. */
export interface DesktopProfileState {
  readonly schemaVersion: 1
  readonly runtimeId: string
  readonly version: string
  readonly nodeVersion: string
  readonly platform: string
  readonly arch: string
  readonly lockHash: string
  readonly links: readonly DesktopPackageLink[]
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/**
 * Read profile state without interpreting an unpublished predecessor format.
 * @param profile - Desktop profile directory.
 * @returns Validated state, or undefined for an uninitialized profile.
 */
export function readDesktopProfileState(profile: string): DesktopProfileState | undefined {
  const path = join(profile, DESKTOP_PROFILE_STATE)
  if (!existsSync(path)) return undefined
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!record(value) || value.schemaVersion !== 1 || typeof value.runtimeId !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.runtimeId) || typeof value.version !== 'string'
    || typeof value.nodeVersion !== 'string' || typeof value.platform !== 'string' || typeof value.arch !== 'string'
    || typeof value.lockHash !== 'string' || !Array.isArray(value.links)) {
    throw new Error('desktop profile: invalid runtime state')
  }
  const links = value.links.map((link: unknown): DesktopPackageLink => {
    if (!record(link) || typeof link.name !== 'string' || !PACKAGE_NAME.test(link.name)
      || typeof link.target !== 'string' || !isAbsolute(link.target)) {
      throw new Error('desktop profile: invalid managed link')
    }
    return { name: link.name, target: link.target }
  })
  if (new Set(links.map(link => link.name)).size !== links.length) throw new Error('desktop profile: duplicate managed link')
  return { schemaVersion: 1, runtimeId: value.runtimeId, version: value.version, nodeVersion: value.nodeVersion,
    platform: value.platform, arch: value.arch, lockHash: value.lockHash, links }
}

/**
 * Hash the plugin lockfile, including the empty-profile case.
 * @param profile - Desktop profile directory.
 * @returns Lockfile content identity.
 */
export function desktopPluginLockHash(profile: string): string {
  const lock = join(profile, 'pnpm-lock.yaml')
  return createHash('sha256').update(existsSync(lock) ? readFileSync(lock) : '').digest('hex')
}

/**
 * Remove only recorded host links, without following even broken targets.
 * @param profile - Desktop profile.
 */
export function unlinkDesktopHostPackages(profile: string): void {
  for (const link of readDesktopProfileState(profile)?.links ?? []) {
    const path = join(profile, 'node_modules', link.name)
    const entry = stat(path)
    if (entry === undefined) continue
    if (!entry.isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== resolve(link.target)) {
      throw new Error(`desktop profile: refusing to replace unowned package ${link.name}`)
    }
    unlinkSync(path)
  }
}

/**
 * Bind an external profile to this application's real package directories.
 * @param profile - Candidate profile.
 * @param root - Current immutable runtime directory.
 * @param runtime - Verified release descriptor.
 */
export function linkDesktopHostPackages(profile: string, root: string, runtime: DesktopRuntimeDescriptor): void {
  unlinkDesktopHostPackages(profile)
  const links = runtime.sharedPackages.map(entry => ({ name: entry.name, target: runtimePath(root, entry.path) }))
  for (const link of links) {
    const path = join(profile, 'node_modules', link.name)
    if (stat(path) !== undefined) throw new Error(`desktop profile: plugin installed reserved host package ${link.name}`)
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(link.target, path, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const state: DesktopProfileState = { schemaVersion: 1, runtimeId: desktopRuntimeId(runtime), version: runtime.release.version,
    nodeVersion: runtime.release.nodeVersion, platform: runtime.platform, arch: runtime.arch,
    lockHash: desktopPluginLockHash(profile), links }
  writeFileSync(join(profile, DESKTOP_PROFILE_STATE), `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
}

interface PackageManifest {
  readonly name: string
  readonly version: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly optionalDependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly optionalPeers: ReadonlySet<string>
}

function manifest(path: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
  if (!record(value) || typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error(`desktop profile: invalid package manifest ${path}`)
  }
  const dependencies = (key: string): Record<string, string> => {
    const field = value[key]
    if (field === undefined) return {}
    if (!record(field) || Object.entries(field).some(([name, spec]) => !PACKAGE_NAME.test(name) || typeof spec !== 'string')) {
      throw new Error(`desktop profile: invalid ${key} in ${path}`)
    }
    return field as Record<string, string>
  }
  const optionalPeers = new Set<string>()
  if (record(value.peerDependenciesMeta)) {
    for (const [name, meta] of Object.entries(value.peerDependenciesMeta)) {
      if (record(meta) && meta.optional === true) optionalPeers.add(name)
    }
  }
  return { name: value.name, version: value.version, dependencies: dependencies('dependencies'),
    optionalDependencies: dependencies('optionalDependencies'), peerDependencies: dependencies('peerDependencies'), optionalPeers }
}

function packageFrom(anchor: string, name: string): string | undefined {
  if (!PACKAGE_NAME.test(name)) throw new Error(`desktop profile: invalid package name ${name}`)
  for (const modules of createRequire(join(anchor, 'package.json')).resolve.paths(name) ?? []) {
    const path = join(modules, name)
    if (existsSync(join(path, 'package.json'))) return realpathSync.native(path)
  }
  return undefined
}

/**
 * Prove active plugin dependencies stay local and share the host's exact package instances.
 * @param profile - Profile with its generated host links present.
 * @param root - Immutable runtime directory.
 * @param runtime - Verified shared package inventory.
 * @param activePlugins - Explicit enabled plugin roots whose peer compatibility is required.
 */
export function validateDesktopPluginGraph(
  profile: string, root: string, runtime: DesktopRuntimeDescriptor, activePlugins: readonly string[],
): void {
  const profileRoot = realpathSync.native(profile)
  const shared = new Map(runtime.sharedPackages.map((entry) => {
    return [entry.name, realpathSync.native(runtimePath(root, entry.path))] as const
  }))
  for (const [name, path] of shared) {
    if (packageFrom(profile, name) !== path) throw new Error(`desktop profile: missing or incorrect host link ${name}`)
  }
  if (activePlugins.length === 0) return
  const scanned = new Set<string>()
  const scan = (modules: string): void => {
    if (!existsSync(modules)) return
    if (lstatSync(modules).isSymbolicLink()) throw new Error(`desktop profile: linked package container ${modules}`)
    const directory = realpathSync.native(modules)
    if (scanned.has(directory)) return
    scanned.add(directory)
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(modules, entry.name)
      if (entry.name.startsWith('@')) { scan(path); continue }
      if (!existsSync(join(path, 'package.json'))) throw new Error(`desktop profile: invalid installed package ${path}`)
      const canonical = realpathSync.native(path)
      const info = manifest(canonical)
      const host = shared.get(info.name)
      if (host !== undefined) {
        if (canonical !== host || path !== join(profile, 'node_modules', info.name)) {
          throw new Error(`desktop profile: duplicate or aliased host package ${info.name} at ${path}`)
        }
        continue
      }
      if (entry.isSymbolicLink()) throw new Error(`desktop profile: linked private package ${path}`)
      if (!inside(profileRoot, canonical)) throw new Error(`desktop profile: package resolves outside profile: ${path}`)
      scan(join(path, 'node_modules'))
    }
  }
  scan(join(profile, 'node_modules'))
  const visited = new Set<string>()
  const visit = (path: string, chain: string): void => {
    if (visited.has(path)) return
    visited.add(path)
    const info = manifest(path)
    const deps = { ...info.dependencies, ...info.optionalDependencies }
    for (const [name, range] of Object.entries({ ...deps, ...info.peerDependencies })) {
      const peer = name in info.peerDependencies
      const optional = peer ? info.optionalPeers.has(name) : name in info.optionalDependencies
      const target = packageFrom(path, name)
      if (target === undefined && optional) continue
      if (target === undefined) throw new Error(`desktop profile: ${chain} requires missing ${name}@${range}`)
      const host = shared.get(name)
      if (host !== undefined && name in deps) throw new Error(`desktop profile: ${chain} must declare ${name} as a peer dependency`)
      if (host !== undefined ? target !== host : !inside(profileRoot, target)) {
        throw new Error(`desktop profile: ${chain} resolves ${name} outside its owned packages`)
      }
      const dependency = manifest(target)
      if (peer && !satisfies(dependency.version, range)) {
        throw new Error(`desktop profile: ${chain} requires ${name}@${range}, found ${dependency.version}`)
      }
      if (host === undefined) visit(target, `${chain} -> ${name}`)
    }
  }
  for (const name of activePlugins) {
    const path = packageFrom(profile, name)
    if (path === undefined || !inside(profileRoot, path)) throw new Error(`desktop profile: missing local plugin ${name}`)
    visit(path, name)
  }
}

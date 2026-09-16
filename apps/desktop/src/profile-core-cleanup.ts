/** Remove application-owned packages left in external plugin profiles before production boot. */

import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dump, load } from 'js-yaml'
import { DESKTOP_PACKAGE_SET_FILE, readDesktopCorePackageSet } from './core-package-set.ts'

/** Enables the temporary production-profile cleanup; remove this module and its caller together. */
const CLEAN_PROFILE_CORE_PACKAGES = true

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop profile cleanup: expected an object')
  }
  return value as Record<string, unknown>
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

function remove(path: string): boolean {
  const entry = stat(path)
  if (entry === undefined) return false
  if (entry.isSymbolicLink()) unlinkSync(path)
  else rmSync(path, { recursive: entry.isDirectory() })
  return true
}

function requireDirectory(path: string): void {
  const entry = stat(path)
  if (entry !== undefined && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error(`desktop profile cleanup: package parent is not a real directory: ${path}`)
  }
}

function prune(value: Record<string, unknown>, field: string, names: ReadonlySet<string>): boolean {
  if (value[field] === undefined) return false
  const entries = object(value[field])
  let changed = false
  for (const name of names) {
    if (!Object.hasOwn(entries, name)) continue
    Reflect.deleteProperty(entries, name)
    changed = true
  }
  return changed
}

/**
 * Delete current and recorded Desktop core packages, their declarations, and stale lockfile resolutions.
 * Managed links are unlinked without touching their targets; unrelated plugins and profile configuration survive.
 * The caller holds the profile lock and must not have started the Host. Development launches do nothing.
 * @param profile - Absolute Desktop profile directory.
 * @param packageNames - Package names from the verified application runtime descriptor.
 * @param production - Whether this launch uses the packaged application.
 */
export function cleanProfileCorePackages(profile: string, packageNames: readonly string[], production: boolean): void {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- release cleanup has an explicit source switch.
  if (!CLEAN_PROFILE_CORE_PACKAGES || !production || !existsSync(profile)) return
  const names = new Set(packageNames)
  const recordPath = join(profile, DESKTOP_PACKAGE_SET_FILE)
  if (existsSync(recordPath)) {
    for (const entry of readDesktopCorePackageSet(profile).packages) names.add(entry.name)
  }
  const roots = [join(profile, 'node_modules'), join(profile, '.dsh-module-fallback', 'node_modules')]
  requireDirectory(join(profile, '.dsh-module-fallback'))
  for (const root of roots) {
    requireDirectory(root)
    for (const name of names) requireDirectory(dirname(join(root, name)))
  }
  const manifestPath = join(profile, 'package.json')
  const manifest = existsSync(manifestPath) ? object(JSON.parse(readFileSync(manifestPath, 'utf8'))) : undefined
  const workspacePath = join(profile, 'pnpm-workspace.yaml')
  const workspace = existsSync(workspacePath) ? object(load(readFileSync(workspacePath, 'utf8'))) : undefined
  let manifestChanged = false
  if (manifest !== undefined) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      manifestChanged = prune(manifest, field, names) || manifestChanged
    }
    if (manifest.pnpm !== undefined) manifestChanged = prune(object(manifest.pnpm), 'overrides', names) || manifestChanged
  }
  const workspaceChanged = workspace !== undefined && prune(workspace, 'overrides', names)
  const packageResidue = roots.some(root => [...names].some(name => stat(join(root, name)) !== undefined))
  if (manifestChanged || workspaceChanged || packageResidue) remove(join(profile, 'pnpm-lock.yaml'))
  if (manifestChanged) writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  if (workspaceChanged) writeFileSync(workspacePath, dump(workspace))
  for (const root of roots) for (const name of names) remove(join(root, name))
}

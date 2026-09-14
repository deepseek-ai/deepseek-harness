/** Relocatable, integrity-recorded production packages carried by one Desktop release. */

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFile, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { valid } from 'semver'
import { DESKTOP_HOST_PACKAGE } from './core-package-set.ts'
import { parseDesktopRelease, type DesktopRelease } from './release.ts'

/** Descriptor at the root of the immutable Desktop resource tree. */
export const DESKTOP_RUNTIME_FILE = 'desktop-runtime.json'

/** Host-owned package available to external plugins through a directory link. */
export interface DesktopSharedPackage {
  readonly name: string
  readonly version: string
  readonly path: string
}

/** Final bytes and executable permissions of a runtime file. */
export interface DesktopRuntimeFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly executable: boolean
}

/** One signed application's production dependency tree. */
export interface DesktopRuntimeDescriptor {
  readonly schemaVersion: 1
  readonly release: DesktopRelease
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly sharedPackages: readonly DesktopSharedPackage[]
  readonly files: readonly DesktopRuntimeFile[]
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const readRuntimeFile = promisify(readFile)

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve one portable resource path without permitting traversal or absolute paths.
 * @param root - Runtime root.
 * @param path - Slash-separated relative path from durable metadata.
 * @returns Absolute resource path.
 */
export function runtimePath(root: string, path: string): string {
  if (path === '' || isAbsolute(path) || path.includes('\\') || path.includes(':')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`desktop runtime: invalid relative path ${JSON.stringify(path)}`)
  }
  return join(root, ...path.split('/'))
}

function runtimeFiles(root: string): { path: string; name: string }[] {
  const files: { path: string; name: string }[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const name = relative(root, path).split(sep).join('/')
      if (name === DESKTOP_RUNTIME_FILE) continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push({ path, name })
      else throw new Error(`desktop runtime: unsupported filesystem entry ${name}`)
    }
  }
  visit(root)
  return files
}

function runtimeFile(path: string, name: string, body: Buffer): DesktopRuntimeFile {
  return { path: name, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'),
    // Windows has no portable Unix executable permission bits.
    executable: process.platform !== 'win32' && (lstatSync(path).mode & 0o111) !== 0 }
}

/**
 * Inventory a materialized runtime without following links or including its descriptor.
 * @param root - Self-contained runtime directory.
 * @returns Sorted final-file inventory; executable permissions are false on Windows.
 */
export function inventoryDesktopRuntime(root: string): DesktopRuntimeFile[] {
  return runtimeFiles(root).map(({ path, name }) => runtimeFile(path, name, readFileSync(path)))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

async function inventoryRuntimeForVerification(root: string): Promise<DesktopRuntimeFile[]> {
  const entries = runtimeFiles(root)
  const files: DesktopRuntimeFile[] = []
  const remaining = entries.values()
  let failed = false
  const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (!failed) {
      const next = remaining.next()
      if (next.done) return
      const { path, name } = next.value
      try {
        files.push(runtimeFile(path, name, await readRuntimeFile(path)))
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  // Failure returns only after every outstanding file read has closed its descriptor.
  const results = await Promise.allSettled(workers)
  for (const result of results) if (result.status === 'rejected') throw result.reason
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/**
 * Seal the final runtime tree after materialization and native signing.
 * @param root - Runtime output directory.
 * @param release - Matching shell, dsh, Host, and executable versions.
 * @param sharedNames - Release-owned packages supplied to plugins.
 * @param target - Platform and architecture selected by runtime preparation.
 * @returns Descriptor written beside the production packages.
 */
export function writeDesktopRuntime(
  root: string, release: DesktopRelease, sharedNames: readonly string[],
  target: { platform: NodeJS.Platform; arch: string } = process,
): DesktopRuntimeDescriptor {
  const sharedPackages = [...new Set(sharedNames)].sort().map((name) => {
    if (!PACKAGE_NAME.test(name)) throw new Error(`desktop runtime: invalid shared package ${name}`)
    const path = `node_modules/${name}`
    const manifest = JSON.parse(readFileSync(join(runtimePath(root, path), 'package.json'), 'utf8')) as unknown
    if (!record(manifest) || manifest.name !== name || typeof manifest.version !== 'string' || valid(manifest.version) === null) {
      throw new Error(`desktop runtime: invalid shared package manifest ${name}`)
    }
    return { name, version: manifest.version, path }
  })
  const descriptor: DesktopRuntimeDescriptor = {
    schemaVersion: 1, release, platform: target.platform, arch: target.arch,
    sharedPackages, files: inventoryDesktopRuntime(root),
  }
  writeFileSync(join(root, DESKTOP_RUNTIME_FILE), `${JSON.stringify(descriptor, undefined, 2)}\n`)
  return descriptor
}

/**
 * Read packaged metadata and check shared package records.
 * @param root - Current application's runtime resources.
 * @returns Runtime metadata whose release compatibility is verified during packaging.
 */
export function readDesktopRuntime(root: string): DesktopRuntimeDescriptor {
  const value: unknown = JSON.parse(readFileSync(join(root, DESKTOP_RUNTIME_FILE), 'utf8'))
  if (!record(value) || typeof value.platform !== 'string' || typeof value.arch !== 'string'
    || !Array.isArray(value.sharedPackages) || !Array.isArray(value.files)) {
    throw new Error('desktop runtime: invalid descriptor')
  }
  if (!record(value.release) || typeof value.release.version !== 'string'
    || typeof value.release.nodeVersion !== 'string' || typeof value.release.pnpmVersion !== 'string') {
    throw new Error('desktop runtime: invalid release fields')
  }
  const release = value.release as unknown as DesktopRelease
  const sharedPackages = value.sharedPackages.map((entry: unknown): DesktopSharedPackage => {
    if (!record(entry) || typeof entry.name !== 'string' || !PACKAGE_NAME.test(entry.name)
      || typeof entry.version !== 'string' || valid(entry.version) === null || entry.path !== `node_modules/${entry.name}`) {
      throw new Error('desktop runtime: invalid shared package record')
    }
    return { name: entry.name, version: entry.version, path: entry.path }
  })
  if (new Set(sharedPackages.map(entry => entry.name)).size !== sharedPackages.length) {
    throw new Error('desktop runtime: duplicate shared package')
  }
  const files = value.files as DesktopRuntimeFile[]
  for (const name of ['@deepseek-ai/dsh', DESKTOP_HOST_PACKAGE]) {
    if (sharedPackages.find(entry => entry.name === name)?.version !== release.version) {
      throw new Error(`desktop runtime: missing or mismatched ${name}`)
    }
  }
  return { schemaVersion: value.schemaVersion as 1, release, platform: value.platform as NodeJS.Platform,
    arch: value.arch, sharedPackages, files }
}

/**
 * Verify every packaged runtime file against its recorded bytes and permissions at build time.
 * @param root - Materialized runtime resources.
 * @param electronVersion - Expected shell version.
 * @param target - Required execution target; defaults to the current process.
 * @returns Validated runtime descriptor.
 */
export async function verifyDesktopRuntime(
  root: string, electronVersion: string, target: { platform: NodeJS.Platform; arch: string } = process,
): Promise<DesktopRuntimeDescriptor> {
  const descriptor = readDesktopRuntime(root)
  // readDesktopRuntime preserves the disk schema value without validating release compatibility.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (descriptor.schemaVersion !== 1 || descriptor.platform !== target.platform || descriptor.arch !== target.arch) {
    throw new Error('desktop runtime: invalid descriptor or incompatible platform/architecture')
  }
  const release = parseDesktopRelease(descriptor.release)
  if (release.version !== electronVersion) throw new Error(`desktop runtime: ${release.version} does not match Electron ${electronVersion}`)
  for (const entry of descriptor.sharedPackages) {
    const manifest: unknown = JSON.parse(readFileSync(join(runtimePath(root, entry.path), 'package.json'), 'utf8'))
    if (!record(manifest) || manifest.name !== entry.name || manifest.version !== entry.version) {
      throw new Error(`desktop runtime: shared package metadata mismatch for ${entry.name}`)
    }
  }
  const actual = await inventoryRuntimeForVerification(root)
  // Windows has no portable Unix executable permission bits.
  const comparable = (items: readonly DesktopRuntimeFile[]): unknown => process.platform === 'win32'
    ? items.map(({ executable: _executable, ...item }) => item) : items
  if (JSON.stringify(comparable(descriptor.files)) !== JSON.stringify(comparable(actual))) {
    throw new Error('desktop runtime: integrity verification failed')
  }
  return descriptor
}

/**
 * Identify exact runtime content independently of its installation path.
 * @param descriptor - Validated runtime metadata.
 * @returns SHA-256 runtime identity.
 */
export function desktopRuntimeId(descriptor: DesktopRuntimeDescriptor): string {
  return createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')
}

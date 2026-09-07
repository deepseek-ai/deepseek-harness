/** Signed local npm package set that supplies the Desktop-owned dsh runtime and private Host. */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Descriptor copied beside every Desktop profile's local core tarballs. */
export const DESKTOP_PACKAGE_SET_FILE = 'desktop-packages.json'

/** Profile-relative directory containing immutable core npm tarballs. */
export const DESKTOP_PACKAGES_DIR = 'desktop-packages'

/** Private package installed beside dsh to boot the Desktop Host process. */
export const DESKTOP_HOST_PACKAGE = '@deepseek-ai/dsh-desktop-host'

/** Package-relative Desktop Host files required before a profile can boot. */
export const DESKTOP_HOST_RUNTIME_FILES = [
  'lib/index.js',
  'config/desktop.cordis.patch.yml',
] as const

/** One immutable npm tarball in the Desktop core package set. */
export interface DesktopCorePackageRecord {
  readonly name: string
  readonly version: string
  readonly file: string
  readonly bytes: number
  readonly integrity: string
}

/** Complete union of the first-party package closures rooted at dsh and its private Desktop Host. */
export interface DesktopCorePackageSet {
  readonly schemaVersion: 1
  readonly packages: readonly DesktopCorePackageRecord[]
}

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u
const FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u
const DSH_PACKAGE = '@deepseek-ai/dsh'
const RELEASE_PACKAGES = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate package-set data read from a release artifact or active profile.
 * @param value - Parsed descriptor JSON.
 * @param expectedReleaseVersion - Required dsh and Desktop Host version when validating one release.
 * @returns The normalized package set in deterministic name order.
 */
export function parseDesktopCorePackageSet(
  value: unknown,
  expectedReleaseVersion?: string,
): DesktopCorePackageSet {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.packages)) {
    throw new Error('desktop package set: invalid descriptor')
  }
  const packages = value.packages.map((entry): DesktopCorePackageRecord => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !PACKAGE_NAME_PATTERN.test(entry.name)
      || typeof entry.version !== 'string' || !VERSION_PATTERN.test(entry.version)
      || typeof entry.file !== 'string' || !FILE_PATTERN.test(entry.file)
      || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.integrity !== 'string' || !INTEGRITY_PATTERN.test(entry.integrity)) {
      throw new Error('desktop package set: invalid package record')
    }
    return {
      name: entry.name,
      version: entry.version,
      file: entry.file,
      bytes: entry.bytes,
      integrity: entry.integrity,
    }
  })
  const names = new Set(packages.map(entry => entry.name))
  const files = new Set(packages.map(entry => entry.file))
  if (names.size !== packages.length || files.size !== packages.length) {
    throw new Error('desktop package set: duplicate package name or filename')
  }
  const sorted = [...packages].sort((left, right) => left.name.localeCompare(right.name))
  if (JSON.stringify(sorted) !== JSON.stringify(packages)) {
    throw new Error('desktop package set: packages must be sorted by name')
  }
  for (const name of RELEASE_PACKAGES) {
    const entry = packages.find(candidate => candidate.name === name)
    if (entry === undefined) throw new Error(`desktop package set: missing ${name}`)
    if (expectedReleaseVersion !== undefined && entry.version !== expectedReleaseVersion) {
      throw new Error(`desktop package set: ${name}@${entry.version} does not match Desktop ${expectedReleaseVersion}`)
    }
  }
  return { schemaVersion: 1, packages }
}

/** Read and structurally validate one profile's core package descriptor. */
export function readDesktopCorePackageSet(projectDir: string, expectedReleaseVersion?: string): DesktopCorePackageSet {
  const path = join(projectDir, DESKTOP_PACKAGE_SET_FILE)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`desktop package set: failed to read ${path}: ${String(error)}`)
  }
  return parseDesktopCorePackageSet(value, expectedReleaseVersion)
}

/** Return the project-relative `file:` spec for one local core tarball. */
export function desktopCorePackageSpec(record: DesktopCorePackageRecord): string {
  return `file:./${DESKTOP_PACKAGES_DIR}/${record.file}`
}

/** Return the exact pnpm override map that keeps every core package off registries. */
export function desktopCorePackageOverrides(packageSet: DesktopCorePackageSet): Record<string, string> {
  return Object.fromEntries(packageSet.packages.map(record => [record.name, desktopCorePackageSpec(record)]))
}

/** Return the local direct dependency spec for the dsh package. */
export function desktopDshPackageSpec(packageSet: DesktopCorePackageSet): string {
  const record = packageSet.packages.find(entry => entry.name === DSH_PACKAGE)
  if (record === undefined) throw new Error(`desktop package set: missing ${DSH_PACKAGE}`)
  return desktopCorePackageSpec(record)
}

/**
 * Verify every local tarball and reject extra package files before pnpm executes them.
 * @param projectDir - Seed or profile directory containing the package set.
 * @param expectedReleaseVersion - Exact dsh and Desktop Host version bound to Electron.
 * @returns The verified package set.
 */
export function verifyDesktopCorePackageSet(
  projectDir: string,
  expectedReleaseVersion: string,
): DesktopCorePackageSet {
  const packageSet = readDesktopCorePackageSet(projectDir, expectedReleaseVersion)
  const packageDir = join(projectDir, DESKTOP_PACKAGES_DIR)
  const expectedFiles = packageSet.packages.map(entry => entry.file).sort()
  let actualFiles: string[]
  try {
    actualFiles = readdirSync(packageDir).sort()
  } catch (error) {
    throw new Error(`desktop package set: failed to read ${packageDir}: ${String(error)}`)
  }
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('desktop package set: package directory does not match its descriptor')
  }
  for (const record of packageSet.packages) {
    const path = join(packageDir, record.file)
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`desktop package set: ${record.file} is not a regular file`)
    }
    const body = readFileSync(path)
    const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`
    if (body.byteLength !== record.bytes || integrity !== record.integrity) {
      throw new Error(`desktop package set: integrity check failed for ${record.file}`)
    }
  }
  return packageSet
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Reject a lockfile that resolved any packaged core name through a registry version.
 * @param lockfile - Generated pnpm lockfile text.
 * @param packageSet - Verified local core package set.
 */
export function verifyDesktopCoreLockfile(
  lockfile: string,
  packageSet: DesktopCorePackageSet,
): void {
  for (const record of packageSet.packages) {
    const registryResolution = new RegExp(
      `^  ['"]?${escapeRegExp(record.name)}@${escapeRegExp(record.version)}(?:\\([^\\r\\n]*\\))?['"]?:`,
      'mu',
    )
    if (registryResolution.test(lockfile)) {
      throw new Error(`desktop package set: lockfile resolved ${record.name}@${record.version} outside the local package set`)
    }
  }
}

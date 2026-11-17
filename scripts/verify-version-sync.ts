/**
 * Check that every released manifest carries the root version. A release synchronization bumps
 * them together, so a mismatch means a merge combined two version lines: a pull request that bumps
 * versions merged onto a master that added a package, for instance.
 *
 * The released manifests are the ones the release tooling rewrites, `packages/<group>/<package>`
 * and `apps/<application>`. Reading them needs no installed dependency, so the check runs before an
 * install.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** One manifest's version, with `undefined` when the file does not declare one. */
export interface ManifestVersion {
  /** Repository-relative path of the manifest. */
  readonly path: string
  readonly version: string | undefined
}

/** Whether a tree is synchronized, with the lines describing it. */
export interface VersionOutcome {
  readonly ok: boolean
  readonly lines: string[]
}

/** The root version and every released manifest's version. */
export interface VersionReport {
  readonly rootVersion: string | undefined
  readonly manifests: ManifestVersion[]
}

/** Where released manifests live: the package groups and the applications. */
const PACKAGE_ROOT = 'packages'
const APPLICATION_ROOT = 'apps'

/**
 * Report whether an error only means the path is not there.
 * @param error - Caught value.
 * @returns Whether the entry is absent, as a missing file or a parent that is one.
 */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Describe an error for a reader.
 * @param error - Caught value.
 * @returns Its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Test whether a path is a regular file, treating only "no such file" as a no.
 * @param path - Absolute path.
 * @returns Whether the file exists.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch (error) {
    if (isMissing(error)) return false
    throw new Error(`cannot read ${path}: ${messageOf(error)}`)
  }
}

/**
 * Test whether a path is a directory.
 * @param path - Absolute path.
 * @returns Whether the entry is a directory.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    if (isMissing(error)) return false
    throw new Error(`cannot read ${path}: ${messageOf(error)}`)
  }
}

/**
 * List the entries of a directory, naming the directory when it cannot be read.
 * @param path - Absolute directory path.
 * @param label - Repository-relative label for the message.
 * @returns Entry names.
 */
function entries(path: string, label: string): string[] {
  try {
    return readdirSync(path)
  } catch (error) {
    throw new Error(`cannot read ${label}: ${messageOf(error)}`)
  }
}

/**
 * Read the version one `package.json` declares.
 * @param path - Absolute path of the manifest.
 * @returns The declared version, or `undefined` when it declares none.
 */
function versionOf(path: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null) return undefined
    const version: unknown = (manifest as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch (error) {
    throw new Error(`cannot read ${path}: ${messageOf(error)}`)
  }
}

/**
 * Collect the manifests the release tooling rewrites: `packages/<group>/<package>/package.json`
 * and `apps/<application>/package.json`. A directory that cannot be read, and a walk that finds
 * nothing, are errors rather than a clean tree, so a narrowed corpus cannot pass the check.
 * @param root - Repository root.
 * @returns Manifest paths relative to the root, sorted.
 */
export function releasedManifests(root: string): string[] {
  const paths: string[] = []
  for (const group of entries(join(root, PACKAGE_ROOT), `${PACKAGE_ROOT}/`)) {
    if (!isDirectory(join(root, PACKAGE_ROOT, group))) continue
    for (const entry of entries(join(root, PACKAGE_ROOT, group), `${PACKAGE_ROOT}/${group}/`)) {
      const path = `${PACKAGE_ROOT}/${group}/${entry}/package.json`
      if (isFile(join(root, path))) paths.push(path)
    }
  }
  for (const application of entries(join(root, APPLICATION_ROOT), `${APPLICATION_ROOT}/`)) {
    const path = `${APPLICATION_ROOT}/${application}/package.json`
    if (isFile(join(root, path))) paths.push(path)
  }
  if (paths.length === 0) throw new Error(`no released manifest was found under ${PACKAGE_ROOT}/ or ${APPLICATION_ROOT}/`)
  return paths.sort()
}

/**
 * Compare every released manifest with the root version.
 * @param rootVersion - Version of the root `package.json`.
 * @param manifests - Each manifest's path and version.
 * @returns The manifests that carry another version or none, in path order.
 */
export function mismatchedVersions(rootVersion: string, manifests: readonly ManifestVersion[]): ManifestVersion[] {
  return manifests.filter(manifest => manifest.version !== rootVersion).sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * Read the root version and the released manifests of a repository.
 * @param root - Repository root.
 * @returns Root version and manifests.
 */
export function readVersions(root: string): VersionReport {
  const rootVersion = versionOf(join(root, 'package.json'))
  const manifests = releasedManifests(root).map(path => ({ path, version: versionOf(join(root, path)) }))
  return { rootVersion, manifests }
}

/**
 * Report whether every released manifest carries the root version. A tree without a root version,
 * or with no released manifest at all, is not synchronized.
 * @param report - Root version and manifests.
 * @returns Whether the tree is synchronized.
 */
export function versionsSynchronized(report: VersionReport): boolean {
  const { rootVersion, manifests } = report
  return rootVersion !== undefined && manifests.length > 0 && mismatchedVersions(rootVersion, manifests).length === 0
}

/**
 * Describe a version report for a reader.
 * @param report - Root version and manifests.
 * @returns One line when the tree is consistent, otherwise a header and one line per mismatched manifest.
 */
export function describeVersions(report: VersionReport): string[] {
  const { rootVersion, manifests } = report
  if (rootVersion === undefined) return ['the root package.json declares no version']
  const mismatched = mismatchedVersions(rootVersion, manifests)
  if (mismatched.length === 0) return [`${manifests.length} released manifest(s) carry ${rootVersion}`]
  return [
    `${mismatched.length} of ${manifests.length} released manifest(s) do not carry the root version ${rootVersion}:`,
    ...mismatched.map(manifest => `  ${manifest.path}: ${manifest.version ?? 'no version'}`),
  ]
}

/**
 * Run the check over one repository.
 * @param root - Repository root.
 * @returns Whether the tree is synchronized, with the lines describing it.
 */
export function runVersionCheck(root: string): VersionOutcome {
  const report = readVersions(root)
  return { ok: versionsSynchronized(report), lines: describeVersions(report) }
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const root = process.argv[2] ?? resolve(import.meta.dirname, '..')
  try {
    const { ok, lines } = runVersionCheck(resolve(root))
    for (const line of lines) (ok ? console.log : console.error)(`verify-version-sync: ${line}`)
    if (!ok) process.exitCode = 1
  } catch (error) {
    console.error(`verify-version-sync: ${messageOf(error)}`)
    process.exitCode = 1
  }
}

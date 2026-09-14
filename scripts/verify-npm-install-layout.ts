/** Verify npm's physical package placement for two incompatible DSH releases. */

import { readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import {
  buildRegistryIndex,
  resolveNpmPackageLock,
  type NpmLockPackage,
  type NpmPackageLock,
  type RegistryIndex,
} from './benchmark-npm-resolution.ts'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORDIS_PACKAGE = '@deepseek-ai/cordis'
const NESTED_DSH_ALIAS = 'dsh-previous'
const NESTED_DSH_PATH = `node_modules/${NESTED_DSH_ALIAS}`
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const
const TIMEOUT_MS = 300_000

/** Synthetic incompatible versions used to expose cross-release placement errors. */
export const SYNTHETIC_DSH_VERSIONS = ['0.1.0', '0.2.0'] as const

interface MutableRegistryManifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

/** Summary of a verified two-release npm layout. */
export interface DshInstallLayoutSummary {
  readonly dshPackagesPerVersion: number
  readonly checkedDshEdges: number
}

function isDshPackage(name: string): boolean {
  return name === DSH_PACKAGE || name.startsWith(`${DSH_PACKAGE}-`)
}

function cloneForVersion(manifest: object, version: string): MutableRegistryManifest {
  const cloned = structuredClone(manifest) as MutableRegistryManifest
  cloned.version = version
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = cloned[field]
    if (dependencies === undefined) continue
    for (const name of Object.keys(dependencies)) {
      if (isDshPackage(name)) dependencies[name] = `^${version}`
    }
  }
  return cloned
}

/**
 * Replace the working release with two incompatible, internally consistent DSH releases.
 * @param index - Registry metadata containing the working release.
 * @param sourceVersion - Workspace version copied into each synthetic release.
 * @returns Registry metadata containing both synthetic DSH releases and unchanged external packages.
 */
export function buildDualDshRegistry(index: RegistryIndex, sourceVersion: string): RegistryIndex {
  const output = new Map(index)
  let dshPackages = 0
  for (const [name, versions] of index) {
    if (!isDshPackage(name)) {
      output.set(name, versions)
      continue
    }
    const source = versions.get(sourceVersion)
    if (source === undefined) throw new Error(`${name} has no workspace version ${sourceVersion}`)
    dshPackages++
    output.set(name, new Map(SYNTHETIC_DSH_VERSIONS.map(version => [
      version,
      cloneForVersion(source, version),
    ])))
  }
  if (dshPackages === 0) throw new Error('registry contains no DSH packages')
  return output
}

function packageNameAtPath(path: string, manifest: NpmLockPackage): string | undefined {
  if (manifest.name !== undefined) return manifest.name
  const marker = 'node_modules/'
  const markerIndex = path.lastIndexOf(marker)
  if (markerIndex < 0) return undefined
  const segments = path.slice(markerIndex + marker.length).split('/')
  if (segments[0]?.startsWith('@')) {
    return segments[1] === undefined ? undefined : `${segments[0]}/${segments[1]}`
  }
  return segments[0]
}

function resolvePackagePath(
  packages: Readonly<Record<string, NpmLockPackage>>,
  sourcePath: string,
  dependency: string,
): string | undefined {
  let directory = sourcePath
  while (directory !== '.') {
    const candidate = posix.join(directory, 'node_modules', dependency)
    if (packages[candidate] !== undefined) return candidate
    directory = posix.dirname(directory)
  }
  const rootCandidate = posix.join('node_modules', dependency)
  return packages[rootCandidate] === undefined ? undefined : rootCandidate
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter(value => !right.has(value)).sort()
}

/**
 * Assert that npm isolates both DSH releases while sharing the Cordis runtime.
 * @param packageLock - Metadata-only package lock produced by npm.
 * @returns Counts for the verified DSH packages and dependency edges.
 */
export function assertDualDshInstallLayout(packageLock: NpmPackageLock): DshInstallLayoutSummary {
  const [nestedVersion, rootVersion] = SYNTHETIC_DSH_VERSIONS
  const errors: string[] = []
  const namesByVersion = new Map<string, Set<string>>([
    [nestedVersion, new Set()],
    [rootVersion, new Set()],
  ])
  const installed = Object.entries(packageLock.packages)
  let checkedDshEdges = 0

  for (const [path, manifest] of installed) {
    const name = packageNameAtPath(path, manifest)
    if (name === 'react' || name === 'react-dom') {
      errors.push(`${path}: ${name} is a browser build input, not a dependency of the synthetic DSH-only consumer`)
    }
    if (name === undefined || !isDshPackage(name)) continue
    const version = manifest.version
    if (version !== nestedVersion && version !== rootVersion) {
      errors.push(`${path}: expected DSH version ${nestedVersion} or ${rootVersion}, got ${String(version)}`)
      continue
    }
    namesByVersion.get(version)?.add(name)
    const expectedPath = version === rootVersion
      ? `node_modules/${name}`
      : name === DSH_PACKAGE
        ? NESTED_DSH_PATH
        : `${NESTED_DSH_PATH}/node_modules/${name}`
    if (path !== expectedPath) {
      errors.push(`${path}: expected ${name}@${version} at ${expectedPath}`)
    }

    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (!isDshPackage(dependency)) continue
        const targetPath = resolvePackagePath(packageLock.packages, path, dependency)
        const optionalPeer = field === 'peerDependencies'
          && manifest.peerDependenciesMeta?.[dependency]?.optional === true
        if (targetPath === undefined) {
          if (field === 'optionalDependencies' || optionalPeer) continue
          errors.push(`${path}: ${field} ${dependency} does not resolve`)
          continue
        }
        checkedDshEdges++
        const targetVersion = packageLock.packages[targetPath]?.version
        if (targetVersion !== version) {
          errors.push(
            `${path}: ${field} ${dependency} resolves to ${targetPath}@${String(targetVersion)}, expected ${version}`,
          )
        }
      }
    }
  }

  const nestedNames = namesByVersion.get(nestedVersion) ?? new Set<string>()
  const rootNames = namesByVersion.get(rootVersion) ?? new Set<string>()
  if (!nestedNames.has(DSH_PACKAGE)) errors.push(`${NESTED_DSH_PATH}: missing ${DSH_PACKAGE}@${nestedVersion}`)
  if (!rootNames.has(DSH_PACKAGE)) errors.push(`node_modules/${DSH_PACKAGE}: missing ${DSH_PACKAGE}@${rootVersion}`)
  const onlyNested = setDifference(nestedNames, rootNames)
  const onlyRoot = setDifference(rootNames, nestedNames)
  if (onlyNested.length > 0) errors.push(`only ${nestedVersion} contains: ${onlyNested.join(', ')}`)
  if (onlyRoot.length > 0) errors.push(`only ${rootVersion} contains: ${onlyRoot.join(', ')}`)

  const cordisPaths = installed.flatMap(([path, manifest]) =>
    packageNameAtPath(path, manifest) === CORDIS_PACKAGE ? [path] : [])
  if (cordisPaths.length !== 1 || cordisPaths[0] !== `node_modules/${CORDIS_PACKAGE}`) {
    errors.push(`expected one shared ${CORDIS_PACKAGE} at node_modules/${CORDIS_PACKAGE}, got ${cordisPaths.join(', ')}`)
  }

  if (errors.length > 0) throw new Error(`invalid npm install layout:\n${errors.map(error => `  - ${error}`).join('\n')}`)
  return { dshPackagesPerVersion: rootNames.size, checkedDshEdges }
}

function workspaceVersion(root: string): string {
  const manifest = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('apps/cli/package.json has no string version')
  return manifest.version
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '..')
  const index = buildDualDshRegistry(buildRegistryIndex(root), workspaceVersion(root))
  const [nestedVersion, rootVersion] = SYNTHETIC_DSH_VERSIONS
  const result = await resolveNpmPackageLock(index, {
    [DSH_PACKAGE]: rootVersion,
    [NESTED_DSH_ALIAS]: `npm:${DSH_PACKAGE}@${nestedVersion}`,
  }, TIMEOUT_MS)
  if (result.archiveRequests !== 0) throw new Error(`npm requested ${String(result.archiveRequests)} package archive(s)`)
  const summary = assertDualDshInstallLayout(result.packageLock)
  console.log(
    `verify-npm-install-layout: ${String(summary.dshPackagesPerVersion)} DSH package(s) per release and `
    + `${String(summary.checkedDshEdges)} internal edge(s) verified in ${(result.durationMs / 1000).toFixed(2)} s; `
    + `both releases share one Cordis installation; ${String(result.unknownPackages.length)} unavailable optional `
    + 'package name(s) ignored by npm.',
  )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`verify-npm-install-layout: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

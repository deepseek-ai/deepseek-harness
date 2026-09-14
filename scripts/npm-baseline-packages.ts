/** Manifest discovery for the npm baseline's vendor, harness, and application packages. */

import { globSync } from 'node:fs'
import { PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES } from './experimental-package-policy.ts'

const PACKAGE_PATTERNS = [
  'vendor/*/package.json',
  'packages/*/*/package.json',
  'apps/*/package.json',
] as const

/**
 * Discover baseline manifests while excluding the configured private experimental directories.
 * @param root - repository root to scan.
 * @param privateDirectories - repository-relative experimental directories excluded from publication.
 * @returns Sorted repository-relative manifest paths with forward slashes.
 */
export function discoverNpmBaselineManifests(
  root: string,
  privateDirectories: readonly string[] = PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
): string[] {
  return globSync(PACKAGE_PATTERNS, {
    cwd: root,
    exclude: privateDirectories.map(directory => `${directory}/package.json`),
  }).map(path => path.replaceAll('\\', '/')).sort()
}

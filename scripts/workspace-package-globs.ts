/** Convert discovered package manifests into portable bundler workspace patterns. */
import { posix } from 'node:path'

/**
 * Keep filesystem separators from becoming escapes in workspace globs.
 * @param manifests - Repository-relative manifest paths returned by filesystem discovery.
 * @returns Package directory patterns using forward slashes on every host.
 */
export function workspacePackageGlobs(manifests: readonly string[]): string[] {
  return manifests.map(path => posix.dirname(path.replaceAll('\\', '/')))
}

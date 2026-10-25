import { lt, valid } from 'semver'

/**
 * Identify frozen upgrade guides whose examples target an earlier release.
 * @param file - Repository-relative path normalized to forward slashes.
 * @param currentVersion - Current root package version.
 * @returns Whether the guide predates the current upgrade-guide directory.
 */
export function isFrozenUpgradeGuidePath(file: string, currentVersion: string): boolean {
  const version = /^docs\/upgrade-guide\/v([^/]+)\/[^/]+\/guide(?:\.zh)?\.md$/.exec(file)?.[1]
  return version !== undefined && valid(version) !== null && lt(version, currentVersion)
}

/** Map one workspace source alias target to its declaration-build target. */
export function builtDeclarationPath(candidate: string): string {
  // Two workspace path forms exist: whole-package entries end in /src, subpath
  // wildcards (browser-safe /types and /client channels) in /src/*.
  if (candidate.endsWith('/src')) {
    return `${candidate.slice(0, -'/src'.length)}/lib/types`
  }
  if (candidate.endsWith('/src/*')) {
    return `${candidate.slice(0, -'/src/*'.length)}/lib/types/*`
  }
  // Example plugin entries ship no declarations; a documentation fence never imports them, so they stay as authored.
  if (candidate.includes('/examples/')) return candidate
  const sourceFile = /^(.*)\/src\/(.+)\.ts$/.exec(candidate)
  if (sourceFile?.[1] && sourceFile[2]) {
    return `${sourceFile[1]}/lib/types/${sourceFile[2]}.d.ts`
  }
  // Directory subpath entries (for example, runtime's /client): the
  // source dir maps to the same dir under lib/types (index resolution applies).
  const sourceDir = /^(.*)\/src\/(.+)$/.exec(candidate)
  if (sourceDir?.[1] && sourceDir[2]) {
    return `${sourceDir[1]}/lib/types/${sourceDir[2]}`
  }
  throw new Error(`doc-typecheck: cannot map workspace source path to built declarations: ${candidate}`)
}

/** Optional machine-owned macOS signature storage. */
/**
 * Require existing private storage with no linked ancestors.
 * @param path Explicit absolute cache directory.
 * @returns Normalized directory; throws on invalid paths, ownership, permissions or access.
 */
export function validateMacOSSignatureCacheDirectory(path: string): string

/**
 * Select machine storage or retain the target-local default when the setting is absent.
 * @param environment File-owned packaging configuration.
 * @param targetBuildRoot Target build location.
 * @returns Validated external directory, or the default directory created later by signing.
 */
export function resolveMacOSSignatureCacheDirectory(environment: NodeJS.ProcessEnv, targetBuildRoot: string): string

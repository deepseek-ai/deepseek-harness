/**
 * Resolve the current account's cache or a file-owned absolute local override.
 * @param environment Packaging configuration; an absent override uses the current account's signing-state directory.
 * @returns Normalized drive path; rejects relative, network, device and alternate-stream paths.
 */
export function resolveWindowsSignatureCacheDirectory(environment: NodeJS.ProcessEnv): string

/**
 * Validate directory ownership, links, drive type and destination access permissions.
 * @param path Absolute directory to create or inspect.
 * @param existingSource Validate an existing migration source without changing its permissions.
 * @returns Resolves after validation; never reads cache entries from another account's directory.
 */
export function prepareWindowsSignatureCacheDirectory(path: string, existingSource?: boolean): Promise<void>

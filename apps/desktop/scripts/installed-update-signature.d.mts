/** Hash a local file without executing it. @param path File path. @returns Base64 SHA-512. */
export function installedUpdateFileHash(path: string): Promise<string>
/**
 * Verify with the updater and Authenticode, including timestamp presence, without private-key access.
 * @param file Executable inspected as data.
 * @param publisher Trusted public certificate DN.
 * @param directory New private evidence directory.
 * @returns Public signature attributes; rejects skipped, invalid, untimestamped, or changed inputs.
 */
export function verifyInstalledUpdateSignature(file: string, publisher: string, directory: string): Promise<object>

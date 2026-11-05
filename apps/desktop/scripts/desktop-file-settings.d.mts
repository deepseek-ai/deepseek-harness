/** Read file-owned packaging settings without loading packaging dependencies. */

/**
 * Read an explicitly selected dotenv without exposing credential-bearing parser errors.
 * @param path - Selected file; relative file settings resolve beside it.
 * @param accepts - Whether this file may declare a setting.
 * @returns Validated file settings.
 */
export function readDesktopPackageSettings(path: string, accepts: (name: string) => boolean): Record<string, string>

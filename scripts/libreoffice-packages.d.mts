/** Target engine and transitive installed packages for Office process sidecars. */

/**
 * Select the declared native engine, or WASM when the target has no native package.
 * @param manifest - Installed kit manifest.
 * @param target - Distribution platform and CPU.
 * @returns Engine package suffix.
 */
export function selectOfficeEngine(manifest: { optionalDependencies?: Record<string, string> }, target: { platform: string; arch: string }): string

/**
 * Return absolute package directories inside the installed project, rejecting an incomplete closure.
 * @param staging - Symlink-free installed Node project.
 * @param target - Distribution platform and CPU.
 * @returns Installed package directories.
 */
export function officePackageDirectories(staging: string, target: { platform: string; arch: string }): Promise<string[]>

/** Target engine and transitive installed packages for Office process sidecars. */

/**
 * Require the declared native engine for the target. Linux targets select the glibc engine for their CPU.
 * @param manifest - Installed kit manifest.
 * @param target - Distribution platform and CPU.
 * @returns Engine package suffix.
 * @throws {Error} When the kit manifest does not declare a native engine for the target.
 */
export function selectOfficeEngine(manifest: { optionalDependencies?: Record<string, string> }, target: { platform: string; arch: string }): string

/**
 * Return absolute package directories inside the installed project, rejecting an incomplete closure.
 * @param staging - Symlink-free installed Node project.
 * @param target - Distribution platform and CPU.
 * @returns Installed package directories.
 */
export function officePackageDirectories(staging: string, target: { platform: string; arch: string }): Promise<string[]>

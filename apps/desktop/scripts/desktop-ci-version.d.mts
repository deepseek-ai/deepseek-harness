/** Resolve the version used by the manual Desktop packaging workflow. */

/**
 * Resolve an explicit version or a UTC date/run/attempt identifier without release storage access.
 * @param environment Manual version and GitHub run identity.
 * @param productVersion Version declared by the selected checkout.
 * @param now Time used for the UTC date segment.
 * @returns Validated build version.
 */
export function desktopCiVersion(environment: NodeJS.ProcessEnv, productVersion: string, now?: Date): string

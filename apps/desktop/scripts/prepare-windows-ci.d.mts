/** Resolve the version used by the manual Windows packaging workflow. */

/**
 * Resolve an explicit version or a UTC date/run/attempt identifier without release storage access.
 * @param environment Manual version and GitHub run identity.
 * @param productVersion Version declared by the selected checkout.
 * @param now Time used for the UTC date segment.
 * @returns Validated build version.
 */
export function windowsCiVersion(environment: NodeJS.ProcessEnv, productVersion: string, now?: Date): string

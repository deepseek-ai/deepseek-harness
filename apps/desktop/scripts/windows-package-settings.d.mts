/**
 * Validate worker limits and compression before packaging starts.
 * File-owned compression takes precedence over the existing electron-builder environment override.
 * @param environment Loaded packaging settings and inherited build environment.
 * @returns Cache workers from one to eight and a positive integer pack limit, both defaulting to four; archive compression from zero to nine, defaulting to three. Invalid values throw.
 */
export function resolveWindowsPackageSettings(environment: NodeJS.ProcessEnv): { signatureCacheConcurrency: number, packConcurrency: number, compressionLevel: number }

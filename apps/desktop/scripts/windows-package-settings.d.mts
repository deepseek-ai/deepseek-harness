/**
 * Validate file-owned Windows packaging and cache worker limits before packaging starts.
 * @param environment Windows packaging settings loaded from .env.windows.
 * @returns Cache workers from one to eight and a positive integer pack limit; both default to four. Invalid values throw.
 */
export function resolveWindowsPackageSettings(environment: NodeJS.ProcessEnv): { signatureCacheConcurrency: number, packConcurrency: number }

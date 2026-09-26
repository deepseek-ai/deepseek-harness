/**
 * Validate the file-owned Windows cache worker limit before packaging starts.
 * @param environment Windows packaging settings loaded from .env.windows.
 * @returns Worker limit from one to eight, defaulting to four when omitted; invalid values throw.
 */
export function resolveWindowsPackageSettings(environment: NodeJS.ProcessEnv): { signatureCacheConcurrency: number }

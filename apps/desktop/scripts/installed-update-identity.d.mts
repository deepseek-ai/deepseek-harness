/** Configure per-run Electron data and journal paths before production imports. */
export function configureInstalledUpdateIdentity(
  app: { getPath(name: string): string; setPath(name: string, path: string): void },
  run: { id: string; versions: readonly string[] },
  metadata: { version?: string; dshDesktopAppId?: string },
  environment: NodeJS.ProcessEnv,
): { root: string; userData: string; harnessHome: string; journals: string }

/** Configure only a qualification package's identity before the production main entry loads. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Keep test application data and journals outside the replaceable installation tree.
 * @param {{ getPath(name: string): string, setPath(name: string, path: string): void }} app Electron path API before readiness.
 * @param {{ id: string, versions: readonly string[] }} run Embedded qualification identity and version pair.
 * @param {{ version?: string, dshDesktopAppId?: string }} metadata Installed package metadata.
 * @param {NodeJS.ProcessEnv} environment Main-process environment modified before production imports.
 * @returns {{ root: string, userData: string, harnessHome: string, journals: string }} Shared paths for both versions.
 */
export function configureInstalledUpdateIdentity(app, run, metadata, environment) {
  if (!/^[a-f0-9]{24}$/u.test(run.id) || run.versions.length !== 2
    || metadata.dshDesktopAppId !== `com.deepseek.dsh.qualification.q${run.id}`
    || !run.versions.includes(metadata.version)) {
    throw new Error('installed update: qualification package identity does not match its bootstrap')
  }
  const root = join(app.getPath('appData'), 'dsh-update-qualification', run.id)
  const paths = { root, userData: join(root, 'user-data'), harnessHome: join(root, 'dsh-home'), journals: join(root, 'journals') }
  for (const directory of [paths.userData, paths.harnessHome, paths.journals]) mkdirSync(directory, { recursive: true })
  app.setPath('userData', paths.userData)
  app.setPath('sessionData', paths.userData)
  environment.DSH_HOME = paths.harnessHome
  environment.DSH_DESKTOP_UPDATE_JOURNAL_DIR = paths.journals
  return paths
}

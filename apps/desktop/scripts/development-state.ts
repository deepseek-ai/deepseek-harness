/** Persistent Harness home and Electron browser data for unpackaged Desktop launches. */
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Development state locations selected for one launch. */
export interface DevelopmentState {
  readonly home: string
  readonly userData: string
}

/**
 * Resolve development state outside `.desktop-build`, which `pnpm run clean` removes.
 * A default location that does not exist yet receives the state an earlier launcher left under
 * `.desktop-build/development`; explicit `DSH_HOME` and `DSH_DESKTOP_USER_DATA_DIR` are used as given.
 * @param appRoot - Desktop application directory.
 * @param environment - Launch environment with optional location overrides.
 * @returns Harness home and Electron user-data directories.
 */
export function prepareDevelopmentState(appRoot: string, environment: NodeJS.ProcessEnv = process.env): DevelopmentState {
  const select = (override: string | undefined, name: string): string => {
    if (override !== undefined) return resolve(override)
    const path = join(appRoot, '.desktop-dev', name)
    const legacy = join(appRoot, '.desktop-build', 'development', name)
    if (!existsSync(path) && existsSync(legacy)) {
      mkdirSync(join(appRoot, '.desktop-dev'), { recursive: true })
      try {
        renameSync(legacy, path)
      } catch (error) {
        throw new Error(`desktop development: cannot move ${legacy} to ${path}; quit any running Harness Dev and retry`, { cause: error })
      }
      console.log(`desktop development: moved ${legacy} to ${path}`)
    }
    return path
  }
  return {
    home: select(environment.DSH_HOME, 'home'),
    userData: select(environment.DSH_DESKTOP_USER_DATA_DIR, 'electron-user-data'),
  }
}

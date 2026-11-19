/** Persistent Harness home and Electron browser data for unpackaged Desktop launches. */
import { existsSync, mkdirSync, readlinkSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Development state locations selected for one launch. */
export interface DevelopmentState {
  readonly home: string
  readonly userData: string
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** Chromium links `SingletonLock` to `<host>-<pid>` while a browser process owns the profile on macOS and Linux. */
function profileInUse(userData: string): boolean {
  let target: string
  try {
    target = readlinkSync(join(userData, 'SingletonLock'))
  } catch (error) {
    // A missing lock or a non-link lock file means no live owner records itself this way.
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EINVAL')) return false
    throw error
  }
  const pid = /-(\d+)$/.exec(target)?.[1]
  return pid !== undefined && running(Number(pid))
}

/**
 * Resolve development state outside `.desktop-build`, which `pnpm run clean` removes.
 * A default location that does not exist yet receives the state an earlier launcher left under
 * `.desktop-build/development` unless a running Harness Dev still owns that browser profile;
 * explicit `DSH_HOME` and `DSH_DESKTOP_USER_DATA_DIR` are used as given.
 * @param appRoot - Desktop application directory.
 * @param environment - Launch environment with optional location overrides.
 * @returns Harness home and Electron user-data directories.
 */
export function prepareDevelopmentState(appRoot: string, environment: NodeJS.ProcessEnv = process.env): DevelopmentState {
  const legacyRoot = join(appRoot, '.desktop-build', 'development')
  const select = (override: string | undefined, name: string): string => {
    if (override !== undefined) return resolve(override)
    const path = join(appRoot, '.desktop-dev', name)
    const legacy = join(legacyRoot, name)
    if (!existsSync(path) && existsSync(legacy)) {
      // POSIX renames a directory that a running process still writes, which would split its state.
      if (profileInUse(join(legacyRoot, 'electron-user-data'))) {
        throw new Error(`desktop development: a running Harness Dev still uses ${legacyRoot}; quit it and retry`)
      }
      try {
        mkdirSync(join(appRoot, '.desktop-dev'), { recursive: true })
        renameSync(legacy, path)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`desktop development: cannot move ${legacy} to ${path}: ${reason}`, { cause: error })
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

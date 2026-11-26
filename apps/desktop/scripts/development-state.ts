/** Harness home and persistent Electron browser data for unpackaged Desktop launches. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { defaultDshHome, DSH_HOME_ENV, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

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

function empty(path: string): boolean {
  try {
    return readdirSync(path).length === 0
  } catch (error) {
    // A missing directory holds nothing.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true
    throw error
  }
}

/**
 * Use the default Harness home unless only the local development home holds data.
 * A nonempty local home moves into a missing or empty default home; when both hold data, or the default home is a symbolic link,
 * nothing moves and the local home stays in use. A move across volumes copies into a sibling of the default home first, so the
 * default home appears only complete, and deletes the local home last.
 */
function selectHome(local: string, home: string, userDataDirs: readonly string[]): string {
  if (empty(local)) return home
  const link = lstatSync(home, { throwIfNoEntry: false })?.isSymbolicLink() === true
  if (link || !empty(home)) {
    console.log(`desktop development: ${home} ${link ? 'is a symbolic link' : 'holds data'}; using ${local}`)
    return local
  }
  if (userDataDirs.some(profileInUse)) throw new Error(`desktop development: a running Harness Dev still uses ${local}; quit it and retry`)
  try {
    if (existsSync(home)) rmdirSync(home)
    mkdirSync(dirname(home), { recursive: true })
    try {
      renameSync(local, home)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) throw error
      const staging = mkdtempSync(join(dirname(home), `.${basename(home)}-move-`))
      try {
        cpSync(local, join(staging, 'home'), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
        renameSync(join(staging, 'home'), home)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
      rmSync(local, { recursive: true })
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`desktop development: cannot move ${local} to ${home}: ${reason}`, { cause: error })
  }
  console.log(`desktop development: moved ${local} to ${home}`)
  return home
}

/**
 * Resolve development state. Browser data and the local development home live under `.desktop-dev`, which `pnpm run clean` keeps;
 * a missing one receives the state an earlier launcher left under `.desktop-build/development` unless a running Harness Dev still
 * owns that browser profile. Without `DSH_HOME`, the Harness home is the default home, into which a nonempty local home moves while
 * the default home is missing or empty; when both hold data, the local home stays in use.
 * A nonblank `DSH_HOME` resolves as in every other mode, and `DSH_HOME` and `DSH_DESKTOP_USER_DATA_DIR` move nothing.
 * @param appRoot - Desktop application directory.
 * @param environment - Launch environment with optional location overrides.
 * @param defaultHome - Harness home used without `DSH_HOME`.
 * @returns Harness home and Electron user-data directories.
 */
export function prepareDevelopmentState(
  appRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  defaultHome: string = defaultDshHome(),
): DevelopmentState {
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
  const userData = select(environment.DSH_DESKTOP_USER_DATA_DIR, 'electron-user-data')
  if (environment[DSH_HOME_ENV]?.trim()) return { home: resolveDshHome(undefined, environment), userData }
  // A launch with its own browser data must not move the local home from under a running default Harness Dev.
  const userDataDirs = [...new Set([join(appRoot, '.desktop-dev', 'electron-user-data'), userData])]
  return { home: selectHome(select(undefined, 'home'), defaultHome, userDataDirs), userData }
}

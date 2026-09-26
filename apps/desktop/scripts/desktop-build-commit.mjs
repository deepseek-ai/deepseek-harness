/**
 * Carry the commit a build came from into its artifacts.
 *
 * A build that reaches a colleague or a test feed is not reachable from a tag,
 * so the only way back to its sources is what the build recorded about itself.
 * The packaging entry reads the checkout once and passes the result to every
 * child process, which run against a build tree rather than a checkout.
 */

import { execFileSync } from 'node:child_process'

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV = 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV = 'DSH_DESKTOP_BUILD_DIRTY'

/**
 * Read the checkout's current commit and whether it carries uncommitted changes.
 * @param {string} repositoryRoot - Directory to inspect.
 * @returns {{ commit: string, dirty: boolean }} The commit being packaged and whether its tree was modified.
 */
export function readDesktopBuildCommit(repositoryRoot) {
  const git = (args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  return {
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
  }
}

/**
 * Resolve the commit a parent packaging process recorded.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ commit: string, dirty: boolean } | undefined} The packaged commit, or undefined outside a packaging run.
 */
export function resolveDesktopBuildCommit(env) {
  const commit = env[DESKTOP_BUILD_COMMIT_ENV]?.trim()
  if (commit === undefined || commit === '') return undefined
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`desktop build commit: ${DESKTOP_BUILD_COMMIT_ENV} must be a commit hash`)
  const dirty = env[DESKTOP_BUILD_DIRTY_ENV]?.trim()
  if (dirty !== undefined && dirty !== '' && dirty !== '0' && dirty !== '1') {
    throw new Error(`desktop build commit: ${DESKTOP_BUILD_DIRTY_ENV} must be 0 or 1`)
  }
  return { commit, dirty: dirty === '1' }
}

/**
 * Describe the packaged commit as the environment variables child processes read.
 * @param {{ commit: string, dirty: boolean }} packaged - Commit and tree state to pass down.
 * @returns {Record<string, string>} Variables to merge into a child environment.
 */
export function desktopBuildCommitEnvironment(packaged) {
  return {
    [DESKTOP_BUILD_COMMIT_ENV]: packaged.commit,
    [DESKTOP_BUILD_DIRTY_ENV]: packaged.dirty ? '1' : '0',
  }
}

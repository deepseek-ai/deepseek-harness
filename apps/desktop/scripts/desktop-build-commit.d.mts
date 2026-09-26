/** Commit a build came from, and whether its checkout carried uncommitted changes. */
export interface DesktopBuildCommit {
  readonly commit: string
  readonly dirty: boolean
}

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV: 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV: 'DSH_DESKTOP_BUILD_DIRTY'

/**
 * Read the checkout's current commit and whether it carries uncommitted changes.
 * @param repositoryRoot - Directory to inspect.
 * @returns The commit being packaged and whether its tree was modified.
 */
export function readDesktopBuildCommit(repositoryRoot: string): DesktopBuildCommit

/**
 * Resolve the commit a parent packaging process recorded.
 * @param env - Packaging environment.
 * @returns The packaged commit, or undefined outside a packaging run.
 */
export function resolveDesktopBuildCommit(env: NodeJS.ProcessEnv): DesktopBuildCommit | undefined

/**
 * Describe the packaged commit as the environment variables child processes read.
 * @param packaged - Commit and tree state to pass down.
 * @returns Variables to merge into a child environment.
 */
export function desktopBuildCommitEnvironment(packaged: DesktopBuildCommit): Record<string, string>

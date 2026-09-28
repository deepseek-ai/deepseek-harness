/**
 * Keep host Git command-line configuration out of the Git children these specs spawn.
 *
 * Git exports its indexed command-line configuration (`GIT_CONFIG_COUNT` with
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, or the older `GIT_CONFIG_PARAMETERS`)
 * to `git -c` calls and to hook children. The shared subprocess scrub removes
 * credential-shaped names, so a child that inherits the counter without its key
 * fails before it reads any configuration file (`error: missing config key
 * GIT_CONFIG_KEY_0`). These specs judge profile behavior rather than host state,
 * so they run Git without the host's group.
 */

import { vi } from 'vitest'

/** Names Git uses for its indexed command-line configuration. */
const COMMAND_LINE_CONFIG_NAME = /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/u

/**
 * Delete Git's command-line configuration group from this process's environment.
 * @returns a disposer restoring every environment entry the call removed.
 */
export function isolateGitCommandLineConfig(): () => void {
  for (const name of Object.keys(process.env)) {
    if (COMMAND_LINE_CONFIG_NAME.test(name)) vi.stubEnv(name, undefined)
  }
  // `unstubAllEnvs` is the documented inverse of `stubEnv`; neither spec stubs another name.
  return () => { vi.unstubAllEnvs() }
}

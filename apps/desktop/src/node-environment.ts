/** Electron Node-mode startup, with private shell launchers scoped to package installation. */

import { delimiter } from 'node:path'

/**
 * Select Electron's Node mode and the shell launcher used by package scripts.
 * @param executable - Electron executable running the application.
 * @param bin - Directory containing the node shell launcher.
 * @param environment - Caller environment preserved for plugin execution.
 * @returns Environment for a Node-mode child process.
 */
export function desktopNodeEnvironment(executable: string, bin: string | undefined, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: '1',
    ...(bin === undefined ? {} : { DSH_DESKTOP_NODE_EXECUTABLE: executable, PATH: `${bin}${delimiter}${environment.PATH ?? ''}` }),
  }
}

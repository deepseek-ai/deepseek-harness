/** Managed wecom-cli location: the platform binary package that `@wecom/cli` installs. */

import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The name wecom-cli's guides and scripts run it by. */
export const PROGRAM = 'wecom-cli'

function platformDirectory(): string {
  const platformPackage = `@wecom/cli-${process.platform}-${process.arch}`
  try {
    const require = createRequire(import.meta.resolve('@wecom/cli/package.json'))
    return join(dirname(require.resolve(`${platformPackage}/package.json`)), 'bin')
  } catch (error) {
    throw new Error(`wecom: ${platformPackage} is not installed; @wecom/cli has no binary for this platform, or set binDir`, { cause: error })
  }
}

/**
 * Locate the managed executable.
 * @param binDir - absolute override; defaults to the `bin` of the installed `@wecom/cli-<platform>-<arch>` package.
 * @returns the absolute path of the executable `wecom-cli`.
 * @throws when the platform package is missing or the executable is not executable.
 */
export function resolveCliExecutable(binDir: string | undefined): string {
  const program = join(binDir ?? platformDirectory(), PROGRAM)
  try {
    accessSync(program, constants.X_OK)
  } catch (error) {
    throw new Error(`wecom: ${program} is not executable; reinstall the plugin or set binDir`, { cause: error })
  }
  return program
}

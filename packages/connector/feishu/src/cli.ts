/** Managed lark-cli location and the JSON output of its commands. */

import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The name lark-cli's guides run it by. */
export const PROGRAM = 'lark-cli'

/**
 * Name the executable file as `@larksuite/cli` installs it.
 * @param platform - the Host platform.
 * @returns `lark-cli`, or `lark-cli.exe` on Windows.
 */
export function executableFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${PROGRAM}.exe` : PROGRAM
}

/**
 * Locate the managed executable.
 * @param binDir - absolute override; defaults to the installed `@larksuite/cli` package.
 * @returns the absolute path of the executable `lark-cli`, `lark-cli.exe` on Windows.
 * @throws when the executable is missing.
 */
export function resolveCliExecutable(binDir: string | undefined): string {
  const program = join(binDir ?? join(dirname(fileURLToPath(import.meta.resolve('@larksuite/cli/package.json'))), 'bin'), executableFileName(process.platform))
  try {
    accessSync(program, constants.X_OK)
  } catch (error) {
    throw new Error(`feishu: ${program} is not executable; approve the @larksuite/cli install script or set binDir`, { cause: error })
  }
  return program
}

/**
 * Parse one command's JSON output.
 * @param args - the command's native arguments, for the error message.
 * @param output - the complete stream the command wrote the JSON to.
 * @returns unvalidated JSON for the caller to check.
 * @throws when the output is not JSON.
 */
export function parseJson(args: readonly string[], output: string): unknown {
  try {
    return JSON.parse(output)
  } catch (error) {
    throw new Error(`${[PROGRAM, ...args].join(' ')} returned invalid JSON`, { cause: error })
  }
}

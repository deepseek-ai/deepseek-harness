/** Managed lark-cli location and JSON commands. */

import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CliCommandExecutor } from '@deepseek-ai/dsh-cli-account'

export const PROGRAM = 'lark-cli'

/**
 * Locate the directory holding the managed executable.
 * @param binDir - absolute override; defaults to the installed `@larksuite/cli` package.
 * @returns the bin directory containing an executable `lark-cli`.
 * @throws when the executable is missing.
 */
export function resolveCliDirectory(binDir: string | undefined): string {
  const directory = binDir ?? join(dirname(fileURLToPath(import.meta.resolve('@larksuite/cli/package.json'))), 'bin')
  const program = join(directory, PROGRAM)
  try {
    accessSync(program, constants.X_OK)
  } catch (error) {
    throw new Error(`feishu: ${program} is not executable; approve the @larksuite/cli install script or set binDir`, { cause: error })
  }
  return directory
}

function commandLine(args: readonly string[]): string {
  return [PROGRAM, ...args].join(' ')
}

/**
 * Parse one command's JSON stdout.
 * @param args - the command's native arguments, for the error message.
 * @param stdout - the complete stdout.
 * @returns unvalidated JSON for the caller to check.
 * @throws when stdout is not JSON.
 */
export function parseJson(args: readonly string[], stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`${commandLine(args)} returned invalid JSON`, { cause: error })
  }
}

export async function runJson(cli: CliCommandExecutor, args: readonly string[], signal: AbortSignal): Promise<unknown> {
  const result = await cli.run(args, signal)
  if (result.exitCode !== 0) {
    throw new Error(`${commandLine(args)} exited with ${String(result.exitCode)}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`)
  }
  return parseJson(args, result.stdout)
}

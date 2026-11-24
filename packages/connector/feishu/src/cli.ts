/** Managed lark-cli: its location, the download of a missing one, and the JSON output of its commands. */

import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** The name lark-cli's guides run it by. */
export const PROGRAM = 'lark-cli'

/** How much of each output stream of the install script is kept; a failed download logs the error stream. */
const SCRIPT_OUTPUT_BYTES = 8192
const TERMINATE_GRACE_MS = 2_000

/**
 * Name the executable file as `@larksuite/cli` installs it.
 * @param platform - the Host platform.
 * @returns `lark-cli`, or `lark-cli.exe` on Windows.
 */
export function executableFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${PROGRAM}.exe` : PROGRAM
}

/**
 * The managed executable. Without `binDir` it is the one in the installed `@larksuite/cli` package, which only that
 * package's install script puts there: an installation that did not run the script has none until {@link install}
 * runs it.
 */
export class LarkCli {
  /** Absolute path of `lark-cli`, `lark-cli.exe` on Windows; the file is there while {@link installed} returns true. */
  readonly executable: string
  /** The `@larksuite/cli` install script; absent when `binDir` names the directory. */
  private readonly installer: string | undefined

  /**
   * @param binDir - absolute directory override; defaults to the `bin` directory of the installed `@larksuite/cli` package.
   * @param subprocess - runs the install script.
   * @param logger - receives the warning of a failed download.
   * @throws when `binDir` holds no executable `lark-cli`.
   */
  constructor(
    binDir: string | undefined,
    private readonly subprocess: SubprocessRuntime,
    private readonly logger: Context['logger'],
  ) {
    if (binDir === undefined) {
      const root = dirname(fileURLToPath(import.meta.resolve('@larksuite/cli/package.json')))
      this.executable = join(root, 'bin', executableFileName(process.platform))
      this.installer = join(root, 'scripts', 'install.js')
    } else {
      this.executable = join(binDir, executableFileName(process.platform))
      if (!this.installed()) throw this.notExecutable()
    }
  }

  /**
   * Check whether the executable is in place.
   * @returns whether {@link executable} is an executable file.
   */
  installed(): boolean {
    try { accessSync(this.executable, constants.X_OK) } catch (_notExecutable) { return false }
    return true
  }

  /**
   * Download the executable by running the `@larksuite/cli` install script with this process's Node. The script
   * fetches the release archive for this platform from GitHub or an npm mirror, at most 120 seconds per source,
   * verifies its SHA-256 digest, and copies the binary into the package's `bin` directory. A failure other than an
   * abort is logged as a warning with the script's exit and error output before it is thrown, because the account
   * operation that runs the download discards what it throws.
   * @param signal - aborts the script and the commands it runs.
   * @returns after the script's process has exited and the executable is in place.
   * @throws when `binDir` lost its executable, the script cannot start, or it leaves no executable; with the abort
   *   reason after an abort.
   */
  async install(signal: AbortSignal): Promise<void> {
    try {
      await this.download(signal)
    } catch (error) {
      if (!signal.aborted) this.logger.warn('feishu: could not download lark-cli', error)
      throw error
    }
  }

  private async download(signal: AbortSignal): Promise<void> {
    const { installer } = this
    if (installer === undefined) throw this.notExecutable()
    const handle = this.subprocess.spawn({
      argv: [process.execPath, installer], cwd: homedir(),
      // Under `pnpm exec` the script downloads only with this set, as the package's own launcher sets it.
      env: { LARK_CLI_RUN: 'true' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: SCRIPT_OUTPUT_BYTES }, stderr: { maxBytes: SCRIPT_OUTPUT_BYTES } },
      graceMs: TERMINATE_GRACE_MS, signal,
    })
    try {
      const outcome = await handle.done
      signal.throwIfAborted()
      // The file decides, not the exit code: another process running the same script may have put the executable in place.
      if (!this.installed()) {
        const exit = String(outcome.exitCode ?? outcome.signal)
        const output = (handle.collected.stderr as SubprocessOutputReader).readFrom(0).text
        throw new Error(`feishu: ${installer} exited with ${exit} and left no executable ${this.executable}\n${output}`.trimEnd())
      }
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }

  private notExecutable(): Error {
    return new Error(`feishu: ${this.executable} is not executable; set binDir to a directory containing an executable ${executableFileName(process.platform)}`)
  }
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

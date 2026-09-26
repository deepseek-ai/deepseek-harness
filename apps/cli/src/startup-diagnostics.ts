/** Save original startup diagnostics while keeping the terminal report concise. */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import type { StartupError } from '@deepseek-ai/dsh-app-boot'

/** Launcher-owned context; no environment values or plugin configurations are collected. */
interface StartupDiagnosticContext {
  home: string
  version: string
  profile: string
}

/** Wait for stderr to finish the write before the failed process exits. */
function writeStderr(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stderr.write(text, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * Print the startup summary and save a private, uniquely named report under DSH_HOME/logs.
 * Failed writes print the complete report to stderr instead of claiming a saved path.
 * @param error - startup audit failure retaining plugin metadata and original errors.
 * @param context - resolved Harness home, application version, and selected profile.
 * @param write - terminal output sink; awaited before returning, defaults to stderr.
 * @returns after saving or printing the report and completing terminal writes.
 */
export async function reportStartupFailure(
  error: StartupError,
  context: StartupDiagnosticContext,
  write: (text: string) => void | Promise<void> = writeStderr,
): Promise<void> {
  const now = new Date().toISOString()
  const report = 'WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.\n\n' + inspect({
    timestamp: now,
    dshVersion: context.version,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    profile: context.profile,
    error,
  }, {
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    showHidden: true,
    customInspect: false,
    getters: false,
    colors: false,
  }) + '\n'
  await write(`${error.message}\n`)
  const logDir = join(context.home, 'logs')
  const logPath = join(logDir, `startup-${now.replaceAll(':', '-')}-${randomUUID()}.log`)
  try {
    await mkdir(logDir, { recursive: true, mode: 0o700 })
    await writeFile(logPath, report, { flag: 'wx', mode: 0o600 })
  } catch (writeError) {
    await write(`\ndsh: warning: could not write startup diagnostics: ${String(writeError)}\nFull diagnostics:\n${report}`)
    return
  }
  await write(`\nFull diagnostics: ${logPath}\n`)
}

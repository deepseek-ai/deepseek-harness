/** Bundled Office locations that the Desktop profile's Office rows read from the Host environment. */

import { realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { inspect } from 'node:util'

/**
 * Locate the LibreOffice Kit CLI entry that a standalone Node child process can execute.
 * @param runtimeDir - Prepared or ASAR-contained dsh runtime directory that carries the Office skill package.
 * @returns Absolute CLI entry; ASAR runtimes resolve only from their physical unpacked runtime.
 * @throws When the unpacked runtime or Kit is missing; callers must not supply any Kit CLI path.
 * Missing Kit errors use `MODULE_NOT_FOUND` with reinstall guidance; failed resolution retains its original error as `cause`.
 * Other errors propagate unchanged.
 */
export function officeCliPath(runtimeDir: string): string {
  const packed = basename(dirname(runtimeDir)) === 'app.asar'
  // Plain Node cannot traverse ASAR entries; canonicalize only the archive and physical unpacked directory.
  const directory = packed
    ? realpathSync(join(`${realpathSync(dirname(runtimeDir))}.unpacked`, basename(runtimeDir)))
    : runtimeDir
  // createRequire needs an anchor path, not an existing file: skill-office itself can remain in the archive.
  const anchor = join(directory, 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'package.json')
  let manifest: string
  try { manifest = createRequire(anchor).resolve('@deepseek-ai/libreoffice-kit/package.json') } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')) throw error
    throw Object.assign(new Error(`LibreOffice Kit is missing from the Desktop runtime: ${directory}. Reinstall Desktop.`,
      { cause: error }), { code: 'MODULE_NOT_FOUND' })
  }
  if (packed) {
    const path = relative(directory, realpathSync(manifest))
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
      throw Object.assign(new Error(`LibreOffice Kit is missing from the unpacked runtime: ${directory}. Reinstall Desktop.`),
        { code: 'MODULE_NOT_FOUND' })
    }
  }
  return join(dirname(manifest), 'lib', 'cli.js')
}

/**
 * Office carrier entries for the Host environment. The explicit `undefined` CLI entry replaces any inherited value,
 * so the Desktop profile's `skill-office` row receives `cli: false` instead of a stale or externally resolved Kit.
 */
export type DesktopOfficeEnvironment =
  | {
    readonly kind: 'ready'
    readonly environment: { readonly DSH_BUNDLED_PRIMARY_RUNTIME: string; readonly DSH_BUNDLED_OFFICE_CLI: string }
  }
  | {
    readonly kind: 'kit-unavailable'
    readonly environment: { readonly DSH_BUNDLED_PRIMARY_RUNTIME: string; readonly DSH_BUNDLED_OFFICE_CLI: undefined }
    /** The {@link officeCliPath} failure, unchanged. */
    readonly error: unknown
  }

/**
 * Environment entries that point the Desktop profile's Office rows at bundled resources.
 * Locating the Kit CLI only reads the filesystem; its failure leaves the primary runtime entry and the Office skills
 * usable, so it is returned instead of thrown. Release verification must reject `kit-unavailable`.
 * @param runtimeDir - dsh runtime directory passed to the Desktop Host.
 * @param primaryRuntime - Bundled Python, Node.js, and pnpm payload whose sibling `office-skills` holds the skills.
 * @returns `ready` with both entries, or `kit-unavailable` with the {@link officeCliPath} error.
 */
export function desktopOfficeEnvironment(runtimeDir: string, primaryRuntime: string): DesktopOfficeEnvironment {
  let cli: string
  try { cli = officeCliPath(runtimeDir) } catch (error) {
    return { kind: 'kit-unavailable', environment: { DSH_BUNDLED_PRIMARY_RUNTIME: primaryRuntime, DSH_BUNDLED_OFFICE_CLI: undefined }, error }
  }
  return { kind: 'ready', environment: { DSH_BUNDLED_PRIMARY_RUNTIME: primaryRuntime, DSH_BUNDLED_OFFICE_CLI: cli } }
}

/** Diagnostic file that {@link writeOfficeKitDiagnostic} replaces in the application logs directory. */
export const OFFICE_KIT_DIAGNOSTIC = 'office-kit-unavailable.log'

/**
 * Record a Kit CLI location failure in the application logs directory, replacing the previous record.
 * A write failure is reported to `console.error` with the original failure; the returned promise never rejects.
 * @param directory - Application logs directory.
 * @param runtimeDir - dsh runtime directory whose Kit could not be located.
 * @param error - The `kit-unavailable` error.
 * @param time - Time of the Host start that omitted the CLI.
 * @returns The written path, or `undefined` when writing failed.
 */
export async function writeOfficeKitDiagnostic(
  directory: string, runtimeDir: string, error: unknown, time: Date,
): Promise<string | undefined> {
  const path = join(directory, OFFICE_KIT_DIAGNOSTIC)
  try {
    const report = [
      `time: ${time.toISOString()}`,
      `runtime: ${runtimeDir}`,
      'impact: the LibreOffice Kit CLI is unavailable to Office skills; Office skills and the Desktop Host continue without CLI paths.',
      'action: reinstall Desktop to restore the bundled LibreOffice Kit.',
      '',
      '--- error ---',
      inspect(error, { depth: 6, breakLength: 120 }),
      '',
    ].join('\n')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(path, report, { mode: 0o600 })
    return path
  } catch (failure) {
    console.error('dsh desktop: LibreOffice Kit diagnostic could not be written; Office skills continue without CLI paths', path, failure, error)
    return undefined
  }
}

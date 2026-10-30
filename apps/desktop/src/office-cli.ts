/** Bundled Office locations that the Desktop profile's Office rows read from the Host environment. */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * Locate the LibreOffice Kit CLI entry that a standalone Node child process can execute.
 * @param runtimeDir - Prepared or ASAR-contained dsh runtime directory that carries the Desktop Host package.
 * @returns Absolute CLI entry; ASAR runtimes resolve only from their physical unpacked runtime.
 * @throws When the unpacked runtime or required Kit package is missing; callers must stop Office startup.
 */
export function officeCliPath(runtimeDir: string): string {
  const packed = basename(dirname(runtimeDir)) === 'app.asar'
  // Plain Node cannot traverse ASAR entries; canonicalize only the archive and physical unpacked directory.
  const directory = packed
    ? realpathSync(join(`${realpathSync(dirname(runtimeDir))}.unpacked`, basename(runtimeDir)))
    : runtimeDir
  // createRequire needs an anchor path, not an existing file: DesktopHost itself can remain in the archive.
  const anchor = join(directory, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json')
  const manifest = createRequire(anchor).resolve('@deepseek-ai/libreoffice-kit/package.json')
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
 * Environment entries that point the Desktop profile's Office rows at bundled resources.
 * @param runtimeDir - dsh runtime directory passed to the Desktop Host.
 * @param primaryRuntime - Bundled Python, Node.js, and pnpm payload whose sibling `office-skills` holds the skills.
 * @returns `DSH_BUNDLED_PRIMARY_RUNTIME` and `DSH_BUNDLED_OFFICE_CLI`.
 * @throws When the runtime does not carry LibreOffice Kit.
 */
export function desktopOfficeEnvironment(runtimeDir: string, primaryRuntime: string): NodeJS.ProcessEnv {
  return { DSH_BUNDLED_PRIMARY_RUNTIME: primaryRuntime, DSH_BUNDLED_OFFICE_CLI: officeCliPath(runtimeDir) }
}

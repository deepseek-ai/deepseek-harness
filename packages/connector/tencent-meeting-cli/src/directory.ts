/** Managed tmeet location: a `tmeet` link to the platform executable that `@tencentcloud/tmeet` ships under its own name. */

import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, renameSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'

/** The executable name the plugin resolves on its private PATH. */
export const PROGRAM = 'tmeet'

/** Platform executables in the package's `dist`, named as the package's own launcher maps them. */
const PLATFORM_EXECUTABLES: Readonly<Partial<Record<string, string>>> = {
  'darwin-arm64': 'tmeet-macOS-AppleSilicon',
  'darwin-x64': 'tmeet-macOS-Intel',
  'linux-arm64': 'tmeet-Linux-ARM64',
  'linux-x64': 'tmeet-Linux-x86_64',
}

function requireExecutable(program: string, remedy: string): void {
  try {
    accessSync(program, constants.X_OK)
  } catch (error) {
    throw new Error(`tencent-meeting: ${program} is not executable; ${remedy}`, { cause: error })
  }
}

/**
 * Link the platform executable as `tmeet` in a cache directory owned by that executable's path, replacing any earlier link
 * atomically, so installations with different paths never share a link.
 */
function linkPlatformExecutable(): string {
  const executable = PLATFORM_EXECUTABLES[`${process.platform}-${process.arch}`]
  if (executable === undefined) {
    throw new Error(`tencent-meeting: @tencentcloud/tmeet has no executable for ${process.platform}-${process.arch}; set binDir`)
  }
  const target = join(dirname(fileURLToPath(import.meta.resolve('@tencentcloud/tmeet/package.json'))), 'dist', executable)
  requireExecutable(target, 'reinstall the plugin or set binDir')
  const directory = dshCachePath('tencent-meeting', createHash('sha256').update(target).digest('hex').slice(0, 16))
  mkdirSync(directory, { recursive: true })
  const staged = join(directory, `.${PROGRAM}-${randomUUID()}`)
  symlinkSync(target, staged)
  renameSync(staged, join(directory, PROGRAM))
  return directory
}

/**
 * Locate the directory to put on the private PATH.
 * @param binDir - absolute override holding an executable `tmeet`; defaults to a cache directory linking the installed
 *   `@tencentcloud/tmeet` executable for this platform.
 * @returns the directory containing an executable `tmeet`.
 * @throws when the platform has no packaged executable or the executable is missing or not executable.
 */
export function resolveCliDirectory(binDir: string | undefined): string {
  if (binDir === undefined) return linkPlatformExecutable()
  requireExecutable(join(binDir, PROGRAM), 'set binDir to a directory containing an executable tmeet')
  return binDir
}

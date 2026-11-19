/** Managed tmeet location: the platform executable that `@tencentcloud/tmeet` ships under its own name. */

import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The name tmeet's guides run it by. */
export const PROGRAM = 'tmeet'

/**
 * Name the executable file a `binDir` holds.
 * @param platform - the Host platform.
 * @returns `tmeet`, or `tmeet.exe` on Windows.
 */
export function executableFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${PROGRAM}.exe` : PROGRAM
}

/** Platform executables in the package's `dist`, named as the package's own launcher maps them. */
const PLATFORM_EXECUTABLES: Readonly<Partial<Record<string, string>>> = {
  'darwin-arm64': 'tmeet-macOS-AppleSilicon',
  'darwin-x64': 'tmeet-macOS-Intel',
  'linux-arm64': 'tmeet-Linux-ARM64',
  'linux-x64': 'tmeet-Linux-x86_64',
  'win32-x64': 'tmeet-Windows-x86_64.exe',
}

function requireExecutable(program: string, remedy: string): void {
  try {
    accessSync(program, constants.X_OK)
  } catch (error) {
    throw new Error(`tencent-meeting: ${program} is not executable; ${remedy}`, { cause: error })
  }
}

function platformExecutable(): string {
  const executable = PLATFORM_EXECUTABLES[`${process.platform}-${process.arch}`]
  if (executable === undefined) {
    throw new Error(`tencent-meeting: @tencentcloud/tmeet has no executable for ${process.platform}-${process.arch}; set binDir`)
  }
  return join(dirname(fileURLToPath(import.meta.resolve('@tencentcloud/tmeet/package.json'))), 'dist', executable)
}

/**
 * Locate the managed executable.
 * @param binDir - absolute override holding an executable `tmeet`, `tmeet.exe` on Windows; defaults to the installed `@tencentcloud/tmeet`
 *   executable for this platform.
 * @returns the absolute path of the executable.
 * @throws when the platform has no packaged executable or the executable is missing or not executable.
 */
export function resolveCliExecutable(binDir: string | undefined): string {
  if (binDir !== undefined) {
    const file = executableFileName(process.platform)
    const executable = join(binDir, file)
    requireExecutable(executable, `set binDir to a directory containing an executable ${file}`)
    return executable
  }
  const executable = platformExecutable()
  requireExecutable(executable, 'reinstall the plugin or set binDir')
  return executable
}

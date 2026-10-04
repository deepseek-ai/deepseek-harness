/** Build the macOS helper for exact-path command symlink installation. */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Compile the command-link helper before signing Desktop resources.
 * @param destination - Physical runtime/cli directory.
 * @param arch - Desktop architecture, independent of the build host architecture.
 * @param minimumVersion - Minimum macOS version declared by Electron.
 */
export function prepareCommandLink(destination: string, arch: 'arm64' | 'x64', minimumVersion: string): void {
  if (process.platform !== 'darwin' || !/^\d+\.\d+(?:\.\d+)?$/u.test(minimumVersion)) {
    throw new Error('desktop command link: a macOS host and Electron minimum version are required')
  }
  mkdirSync(destination, { recursive: true })
  execFileSync('clang', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
    '-arch', arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=' + minimumVersion,
    join(import.meta.dirname, '..', 'cli', 'link-entry.c'), '-o', join(destination, 'link-entry')], { stdio: 'inherit' })
}

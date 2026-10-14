/** Resolve the native node-pty input used by the SDK and SSH executable builders. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Prefer the workflow's manylinux build and fall back to node-pty's target prebuild.
 * @param packageDirectory - installed node-pty package directory.
 * @param arch - Linux target architecture.
 * @returns the existing addon path.
 */
export function resolveLinuxNodePtyAddon(
  packageDirectory: string,
  arch: 'x64' | 'arm64',
): string {
  const built = join(packageDirectory, 'build', 'Release', 'pty.node')
  if (existsSync(built)) return built
  const prebuilt = join(packageDirectory, 'prebuilds', `linux-${arch}`, 'pty.node')
  if (existsSync(prebuilt)) return prebuilt
  throw new Error(
    `executable-native-pty: node-pty addon is absent from both ${built} and ${prebuilt}.`,
  )
}

/**
 * Require both node-pty addons used by the Windows ConPTY backend.
 * @param packageDirectory - staged node-pty package directory.
 * @param arch - Windows target architecture.
 * @returns the existing addon paths in load order.
 */
export function resolveWindowsNodePtyAddons(
  packageDirectory: string,
  arch: 'x64',
): string[] {
  const directory = join(packageDirectory, 'prebuilds', `win32-${arch}`)
  const addons = [
    join(directory, 'conpty.node'),
    join(directory, 'conpty_console_list.node'),
  ]
  const missing = addons.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`executable-native-pty: Windows node-pty addons are missing: ${missing.join(', ')}.`)
  }
  return addons
}

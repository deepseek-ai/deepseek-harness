/** Resolve the Host account's Documents directory for first-use Workspace creation. */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { DEFAULT_WORKSPACE_DIRECTORY } from './default-workspace.ts'

/** Platform observations replaceable in directory-resolution tests. */
interface DocumentsDirectoryInternals {
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly run?: NativeCommandRunner
}

/**
 * Validate a configured or OS-returned Documents path without resolving it against cwd.
 * @param directory - fully qualified directory spelling.
 * @param platform - Host platform.
 * @returns the normalized directory.
 */
export function validateDocumentsDirectory(directory: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? win32 : posix
  const root = paths.parse(directory).root
  if (!paths.isAbsolute(directory) || (platform === 'win32' && (root === '\\' || root === '/'))) {
    throw new Error(`Documents directory must be fully qualified: '${directory}'`)
  }
  return paths.normalize(directory)
}

/**
 * Resolve the first-use directory on the Host without creating files.
 * @param documentsDirectory - explicit deployment override for the system Documents directory.
 * @param signal - caller lifetime and lookup deadline.
 * @param internals - platform facts and native command runner.
 * @returns the absolute candidate path.
 */
export async function defaultWorkspaceDirectory(
  documentsDirectory: string | undefined,
  signal: AbortSignal,
  internals: DocumentsDirectoryInternals = {},
): Promise<string> {
  const platform = internals.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  signal.throwIfAborted()
  let directory = documentsDirectory
  if (directory === undefined) {
    const run = internals.run ?? runNativeCommand
    let stdout: string
    switch (platform) {
      case 'darwin':
        ({ stdout } = await run('osascript', [
          '-e', 'POSIX path of (path to documents folder from user domain without folder creation)',
        ], signal))
        break
      case 'win32':
        ({ stdout } = await run('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
          + '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, '
          + '[Environment+SpecialFolderOption]::DoNotVerify)',
        ], signal))
        break
      case 'linux':
        ({ stdout } = await run('xdg-user-dir', ['DOCUMENTS'], signal))
        break
      default:
        throw new Error(`system Documents directory is unavailable on ${platform}`)
    }
    directory = stdout.replace(/[\r\n]+$/, '')
    // XDG reports the home directory when this user directory is disabled.
    if (directory === '' || (platform === 'linux' && paths.normalize(directory) === (internals.home ?? homedir()))) {
      throw new Error('system Documents directory is unavailable')
    }
  }
  directory = validateDocumentsDirectory(directory, platform)
  signal.throwIfAborted()
  return paths.join(directory, 'deepseek-harness', DEFAULT_WORKSPACE_DIRECTORY)
}

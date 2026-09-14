/** Shell selection and executable verification use the target execution provider. */
import { SubprocessExecutableNotFoundError, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TerminalShell } from './types.ts'

/**
 * Resolve the configured shell or the execution environment's default shell.
 * @param subprocess - target execution provider.
 * @param configured - optional profile overriding the environment's default shell.
 * @param signal - resolution cancellation.
 * @returns one verified shell; a declared default that cannot resolve rejects.
 */
export async function resolveShell(
  subprocess: SubprocessRuntime, configured: TerminalShell | undefined, signal: AbortSignal,
): Promise<TerminalShell> {
  let shell = configured
  if (shell === undefined) {
    const environment = await subprocess.terminalEnvironment(signal)
    shell = profile(environment.defaultShell ?? (environment.platform === 'windows' ? 'cmd.exe' : '/bin/sh'))
  }
  const path = await subprocess.resolveExecutable(shell.path, undefined, signal)
  return { ...shell, path }
}

function profile(path: string): TerminalShell {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const kind = name.toLowerCase().replace(/\.exe$/u, '')
  return { path, name, args: kind === 'cmd' ? [] : kind === 'pwsh' || kind === 'powershell' ? ['-NoLogo'] : ['-i'] }
}

/**
 * List verified candidates after the configured or environment-default shell.
 * @param subprocess - target execution provider.
 * @param configured - optional default profile.
 * @param candidates - executable names or paths permitted for shell selection.
 * @param signal - discovery cancellation.
 * @returns unique installed shells, with the default first; transport failures reject.
 */
export async function discoverShells(
  subprocess: SubprocessRuntime, configured: TerminalShell | undefined,
  candidates: readonly string[], signal: AbortSignal,
): Promise<TerminalShell[]> {
  const preferred = await resolveShell(subprocess, configured, signal)
  const found = await Promise.all(candidates.map(async (candidate) => {
    try { return await resolveShell(subprocess, profile(candidate), signal) }
    catch (error) {
      if (error instanceof SubprocessExecutableNotFoundError) return undefined
      throw error
    }
  }))
  const shells = new Map<string, TerminalShell>()
  for (const shell of [preferred, ...found]) {
    if (shell === undefined) continue
    const key = shell.path.includes('\\') ? shell.path.toLowerCase() : shell.path
    if (!shells.has(key)) shells.set(key, shell)
  }
  return [...shells.values()]
}

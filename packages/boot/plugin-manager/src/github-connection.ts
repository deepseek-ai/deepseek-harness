/** Bounded GitHub repository checks using the installer's Git configuration and environment. */
import { mkdir, mkdtemp, open } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { classifyInstallFailure } from './install-failure.ts'
import type { ParsedInstallSpec } from './install-spec.ts'
import type { PackageResult } from './types.ts'

/** Deadline, diagnostics and cancellation for one read-only GitHub check. */
export interface GithubConnectionOptions {
  timeoutMs: number
  outputBytes: number
  signal: AbortSignal
  /** The application-owned package manager's environment, also used by its Git children. */
  env?: Readonly<Record<string, string>>
}

/**
 * Check a GitHub repository before pnpm starts, without downloading or building its package.
 * Git reads the profile's Git and proxy configuration without invoking credential helpers or prompting.
 * Timeout and cancellation terminate its descendants too; pnpm owns authentication and transport fallback.
 * @param spec The parsed installation address; npm packages, local paths and other hosts are not checked.
 * @param dir The profile directory where installation runs.
 * @param options The connection deadline, output bound and operation cancellation.
 * @returns A failed check with bounded output and a complete log at logPath, or undefined for a reachable repository or an unhandled spec.
 */
export async function checkGithubConnection(
  spec: ParsedInstallSpec, dir: string, options: GithubConnectionOptions,
): Promise<PackageResult | undefined> {
  if (spec.kind !== 'git') return undefined
  const host = spec.host.toLowerCase().replace(/:.*$/, '')
  if (host !== 'github.com' && !host.endsWith('.github.com')) return undefined
  const repository = spec.spec.replace(/#.*$/s, '')
    .replace(/^github:/i, 'https://github.com/')
    .replace(/^gist:/i, 'https://gist.github.com/')
    .replace(/^git\+/i, '')
  const logRoot = join(dir, '.plugin-manager', 'logs')
  await mkdir(logRoot, { recursive: true, mode: 0o700 })
  const logDir = await mkdtemp(join(logRoot, 'github-connection-'))
  const logPath = join(logDir, 'git.log')
  const log = await open(logPath, 'ax+', 0o600)
  try {
    const result = await execa('git', ['-c', 'credential.helper=', 'ls-remote', '--', repository, 'HEAD'], {
      cwd: dir,
      env: {
        ...scrubbedParentEnv(), ...options.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
      },
      extendEnv: false,
      stdin: 'ignore', stdout: 'ignore', stderr: { file: logPath, append: true }, buffer: false, reject: false,
      timeout: options.timeoutMs, cancelSignal: options.signal, killDescendants: true, killSignal: 'SIGKILL',
    })
    if (!result.failed) return undefined
    if (result.timedOut) await log.write(`dsh: connection to ${spec.host} timed out after ${String(options.timeoutMs)}ms\n`)
    if ((await log.stat()).size === 0) await log.write(result.shortMessage ?? 'GitHub connection check failed')
    const { size } = await log.stat()
    const bytes = Buffer.alloc(Math.min(size, options.outputBytes))
    await log.read(bytes, 0, bytes.length, size - bytes.length)
    const output = bytes.toString('utf8')
    return {
      exitCode: result.exitCode ?? (result.code === 'ENOENT' ? 127 : 1), output, truncated: size > options.outputBytes, logPath,
      kind: classifyInstallFailure({ log: output, timedOut: result.timedOut }),
    }
  } finally {
    await log.close()
  }
}

/** Bounded Git repository connection checks using the installer's Git configuration and environment. */
import { mkdir, mkdtemp, open } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { classifyInstallFailure } from './install-failure.ts'
import { HTTP_USER_INFO, type ParsedInstallSpec } from './install-spec.ts'
import type { PackageResult } from './types.ts'

/**
 * A failed check, with the Git command line the install dialog shows as the installation's only run.
 * The returned result itself stays a plain {@link PackageResult}: the command line never joins the wire fields.
 */
export interface GithubConnectionFailure extends PackageResult {
  /**
   * The `git` command line the check ran, with the user information of an http(s) repository URL removed:
   * `git -c credential.helper= ls-remote -- <repository> HEAD`.
   */
  readonly argv: readonly string[]
}

/** Deadline, diagnostics and cancellation for one read-only Git repository check. */
export interface GithubConnectionOptions {
  timeoutMs: number
  outputBytes: number
  signal: AbortSignal
  /** The application-owned package manager's environment, also used by its Git children. */
  env?: Readonly<Record<string, string>>
}

/**
 * Check a GitHub repository before pnpm starts, without downloading or building its package.
 * @param spec The parsed installation address; npm packages, local paths and other hosts are not checked.
 * @param dir The profile directory where installation runs.
 * @param options The connection deadline, output bound and operation cancellation.
 * @returns As {@link checkGitConnection}, or undefined for a spec that does not name a GitHub repository.
 */
export async function checkGithubConnection(
  spec: ParsedInstallSpec, dir: string, options: GithubConnectionOptions,
): Promise<GithubConnectionFailure | undefined> {
  if (spec.kind !== 'git') return undefined
  const host = spec.host.toLowerCase().replace(/:.*$/, '')
  if (host !== 'github.com' && !host.endsWith('.github.com')) return undefined
  return checkGitConnection(spec, dir, options)
}

/**
 * Check a Git repository with `git ls-remote`, without downloading or building its package. A host shorthand is read
 * over HTTPS; any other spec over the URL it names. Git reads the profile's Git and proxy configuration without
 * invoking credential helpers or prompting, so a repository that needs credentials fails as `unknown`, not as a
 * connection failure. Timeout and cancellation terminate its descendants too.
 * @param spec The parsed address of a Git repository.
 * @param dir The profile directory where installation runs.
 * @param options The connection deadline, output bound and operation cancellation.
 * @returns A failed check carrying the command line it ran (without URL user information), its bounded output and its
 * failure kind, with a complete log at logPath, or undefined for a reachable repository.
 */
export async function checkGitConnection(
  spec: ParsedInstallSpec & { readonly kind: 'git' }, dir: string, options: GithubConnectionOptions,
): Promise<GithubConnectionFailure | undefined> {
  const repository = spec.spec.replace(/#.*$/s, '')
    .replace(/^(?:github|gitlab|bitbucket|gist):/i, `https://${spec.host}/`)
    .replace(/^git\+/i, '')
  const logRoot = join(dir, '.plugin-manager', 'logs')
  await mkdir(logRoot, { recursive: true, mode: 0o700 })
  const logDir = await mkdtemp(join(logRoot, 'github-connection-'))
  const logPath = join(logDir, 'git.log')
  const log = await open(logPath, 'ax+', 0o600)
  const argv = ['git', '-c', 'credential.helper=', 'ls-remote', '--', repository, 'HEAD'] as const
  // The executed command keeps any credentials the spec names; the recorded one drops them before it is displayed.
  const recordedArgv = argv.map(argument => argument.replace(HTTP_USER_INFO, '$1'))
  const [command, ...args] = argv
  try {
    const result = await execa(command, args, {
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
    if ((await log.stat()).size === 0) await log.write(result.shortMessage ?? 'Git connection check failed')
    const { size } = await log.stat()
    const bytes = Buffer.alloc(Math.min(size, options.outputBytes))
    await log.read(bytes, 0, bytes.length, size - bytes.length)
    const output = bytes.toString('utf8')
    // `PackageResult.exitCode` is a status number, so a Git the deadline stopped records the status its failure is read
    // as. The run streamed for the same failure reports no exit code, because that process ended without one.
    return {
      argv: recordedArgv, exitCode: result.exitCode ?? (result.code === 'ENOENT' ? 127 : 1),
      output, truncated: size > options.outputBytes, logPath,
      kind: classifyInstallFailure({ log: output, timedOut: result.timedOut }),
      ...result.timedOut ? { timedOut: true } : {},
    }
  } finally {
    await log.close()
  }
}

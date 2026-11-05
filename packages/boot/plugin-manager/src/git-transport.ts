/** The Git transport an installation of a self-hosted repository uses, chosen by probing access before pnpm starts. */
import { execa } from 'execa'
import hostedGitInfo from 'hosted-git-info'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ParsedInstallSpec } from './install-spec.ts'

/** Deadline and cancellation for each read-only access probe. */
export interface GitTransportOptions {
  timeoutMs: number
  signal: AbortSignal
  /** The application-owned package manager's environment, also used by its Git children. */
  env?: Readonly<Record<string, string>>
}

/** An HTTP(S) Git URL with an optional `git+` prefix, which pnpm clones over that transport as written. */
const HTTP_GIT_URL = /^(?:git\+)?https?:\/\//i

/**
 * The SSH form of an HTTP(S) Git spec on a host pnpm has no transport fallback for. pnpm tries HTTPS and SSH itself
 * for the hosts `hosted-git-info` knows, such as GitHub and GitLab.com, and clones any other URL over the transport
 * it names.
 * @param spec The parsed installation address.
 * @returns `git+ssh://git@<host>/<path>` on SSH's default port with the spec's fragment, or `undefined` for a spec that
 * is not an HTTP(S) Git URL on such a host, or whose URL carries credentials or a query.
 */
export function sshGitSpec(spec: ParsedInstallSpec): string | undefined {
  if (spec.kind !== 'git' || !HTTP_GIT_URL.test(spec.spec) || hostedGitInfo.fromUrl(spec.spec) !== undefined) return undefined
  const url = new URL(spec.spec.replace(/^git\+/i, ''))
  if (url.username !== '' || url.password !== '' || url.search !== '') return undefined
  // The fragment is copied as written: WHATWG serialization would percent-encode some of its characters.
  const hash = /#.*$/s.exec(spec.spec)?.[0] ?? ''
  return `git+ssh://git@${url.hostname}${url.pathname}${hash}`
}

/**
 * Probe whether Git can read a repository with the installer's Git configuration and credential helpers. Git's
 * terminal and askpass prompts are disabled, `core.askPass` included because Windows drops the empty `GIT_ASKPASS`,
 * and on POSIX the probe has no controlling terminal, so SSH cannot ask about host keys or passphrases either.
 * @param repository The repository URL Git reads.
 * @param dir The profile directory where installation runs.
 * @param options The probe deadline, cancellation and environment.
 * @returns Whether `git ls-remote` listed the repository's HEAD.
 */
async function readable(repository: string, dir: string, options: GitTransportOptions): Promise<boolean> {
  const result = await execa('git', ['-c', 'core.askPass=', 'ls-remote', '--exit-code', '--', repository, 'HEAD'], {
    cwd: dir,
    env: {
      ...scrubbedParentEnv(), ...options.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
    },
    extendEnv: false, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', reject: false,
    timeout: options.timeoutMs, cancelSignal: options.signal, killDescendants: true, killSignal: 'SIGKILL',
  })
  return !result.failed
}

/**
 * Choose how pnpm clones an HTTP(S) Git repository that {@link sshGitSpec} has an SSH form for: probe the spec's URL,
 * and when HTTP(S) cannot read it, probe the SSH form.
 * @param spec The parsed installation address.
 * @param dir The profile directory where installation runs.
 * @param options The deadline of each probe, cancellation and the installer's environment.
 * @returns The SSH form when only SSH can read the repository; otherwise the spec unchanged.
 */
export async function chooseGitTransport(spec: ParsedInstallSpec, dir: string, options: GitTransportOptions): Promise<string> {
  const ssh = sshGitSpec(spec)
  if (ssh === undefined) return spec.spec
  const strip = (value: string): string => value.replace(/^git\+/i, '').replace(/#.*$/s, '')
  if (await readable(strip(spec.spec), dir, options)) return spec.spec
  if (options.signal.aborted || !await readable(strip(ssh), dir, options)) return spec.spec
  return ssh
}

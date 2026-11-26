/**
 * OpenSSH helpers for the SSH transport: `ssh -G` configuration, known-hosts
 * lookup and scanning, fingerprints, and POSIX quoting of the remote command.
 */

import { readFile, rm } from 'node:fs/promises'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { SshEnvironmentError } from './errors.ts'

/** Effective OpenSSH settings of one destination, from `ssh -G`. */
export interface SshDestination {
  /** Real host name. */
  readonly hostname: string
  /** TCP port. */
  readonly port: string
  /** Name under which known_hosts records the host key. */
  readonly knownHostsName: string
  /** User known-hosts files in OpenSSH order. */
  readonly userKnownHostsFiles: readonly string[]
  /** Global known-hosts files. */
  readonly globalKnownHostsFiles: readonly string[]
}

/** Captured result of one helper command. */
export interface SshCommandResult {
  /** Exit code; null after a signal. */
  readonly exitCode: number | null
  /** Collected standard output. */
  readonly stdout: string
  /** Collected standard error, trimmed. */
  readonly stderr: string
}

/** argv prefix of one OpenSSH tool, such as `['ssh']`. */
export type ToolArgv = readonly [string, ...string[]]

/** Runs one OpenSSH helper command with collected output. */
export type CommandRunner = (
  tool: ToolArgv, args: readonly string[], options: { readonly input?: string; readonly signal: AbortSignal },
) => Promise<SshCommandResult>

/**
 * Build a {@link CommandRunner} over the subprocess provider.
 * @param subprocess - provider that starts the commands.
 * @param cwd - working directory of the commands.
 * @param graceMs - termination grace for cancelled commands.
 * @param maxBytes - collected bytes per output stream; truncated output fails the command.
 * @returns the runner.
 */
export function commandRunner(subprocess: SubprocessRuntime, cwd: string, graceMs: number, maxBytes: number): CommandRunner {
  return async ([program, ...prefix], args, { input, signal }) => {
    let executable: string
    try {
      executable = await subprocess.resolveExecutable(program, undefined, signal)
    } catch (cause) {
      signal.throwIfAborted()
      throw new SshEnvironmentError('ENVIRONMENT_SSH_DEPENDENCY_MISSING', `Required local executable ${program} is unavailable. Install the OpenSSH client or configure its executable path.`, { cause })
    }
    const handle = subprocess.spawn({
      argv: [executable, ...prefix, ...args], cwd, graceMs, signal,
      stdio: { stdin: input === undefined ? 'ignore' : { data: input }, stdout: { maxBytes }, stderr: { maxBytes } },
    })
    const outcome = await handle.done
    const read = (stream: 'stdout' | 'stderr'): { text: string; truncated: boolean } => {
      /* v8 ignore next -- collect dispositions always expose their readers. */
      const reader = handle.collected[stream] ?? { readFrom: () => ({ text: '', lossy: false }) }
      const chunk = reader.readFrom(0)
      return { text: chunk.text, truncated: chunk.lossy }
    }
    const stdout = read('stdout')
    if (stdout.truncated) throw new Error(`${program} printed more than ${maxBytes} bytes`)
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: read('stderr').text.trim() }
  }
}

/**
 * Read a destination's effective settings through `ssh -G`.
 * @param run - command runner.
 * @param ssh - ssh argv prefix.
 * @param host - destination or alias.
 * @param signal - cancellation.
 * @returns the effective settings.
 */
export async function resolveDestination(run: CommandRunner, ssh: ToolArgv, host: string, signal: AbortSignal): Promise<SshDestination> {
  const result = await run(ssh, ['-G', '--', host], { signal })
  if (result.exitCode !== 0) throw new Error(`ssh -G ${host} failed: ${result.stderr}`)
  const settings = new Map<string, string>()
  for (const line of result.stdout.split('\n')) {
    const separator = line.indexOf(' ')
    if (separator > 0 && !settings.has(line.slice(0, separator))) settings.set(line.slice(0, separator), line.slice(separator + 1).trim())
  }
  const hostname = settings.get('hostname') ?? host
  const port = settings.get('port') ?? '22'
  const alias = settings.get('hostkeyalias')
  return {
    hostname, port,
    knownHostsName: alias ?? (port === '22' ? hostname : `[${hostname}]:${port}`),
    userKnownHostsFiles: splitFiles(settings.get('userknownhostsfile')),
    globalKnownHostsFiles: splitFiles(settings.get('globalknownhostsfile')),
  }
}

function splitFiles(value: string | undefined): string[] {
  // Older OpenSSH releases print `~/` paths unexpanded; ssh-keygen -f needs the expanded path.
  return value === undefined ? [] : value.split(/\s+/).filter(file => file !== '' && file !== 'none').map(expandHomePath)
}

/** One fetched host key with its fingerprint. */
export interface ScannedKey {
  /** known_hosts line recorded under the destination's known-hosts name. */
  readonly line: string
  /** `SHA256:` fingerprint, as `ssh-keygen -l` prints it. */
  readonly fingerprint: string
  /** Key type, such as `ED25519`. */
  readonly type: string
}

/**
 * Fetch the host key the destination presents, through ssh itself so the user's proxy and jump-host settings
 * apply, and fingerprint it. ssh records the key in a scratch known-hosts file under `accept-new` and stops before
 * authenticating. Fetching is unauthenticated; a person or a pinned fingerprint must accept a key before it is trusted.
 * @param run - command runner.
 * @param tools - argv prefixes of ssh and ssh-keygen.
 * @param host - destination or alias.
 * @param destination - effective settings.
 * @param scratch - scratch known-hosts file, removed afterwards.
 * @param signal - cancellation.
 * @returns the fetched keys.
 */
export async function fetchHostKeys(
  run: CommandRunner,
  tools: { readonly ssh: ToolArgv; readonly sshKeygen: ToolArgv },
  host: string,
  destination: SshDestination,
  scratch: string,
  signal: AbortSignal,
): Promise<ScannedKey[]> {
  let lines: string[]
  let stderr: string
  try {
    const probe = await run(tools.ssh, [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'HashKnownHosts=no',
      '-o', `UserKnownHostsFile=${sshOptionQuote(scratch)}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'PreferredAuthentications=none', '--', host, 'true',
    ], { signal })
    stderr = probe.stderr
    lines = (await readFile(scratch, 'utf8').catch(() => '')).split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
  } finally {
    await rm(scratch, { force: true })
  }
  if (lines.length === 0) throw new Error(`ssh could not fetch the host key of ${host}: ${stderr}`)
  const keys: ScannedKey[] = []
  for (const fetched of lines) {
    const line = [destination.knownHostsName, ...fetched.split(/\s+/).slice(1)].join(' ')
    const printed = await run(tools.sshKeygen, ['-l', '-f', '-'], { input: `${line}\n`, signal })
    const [, fingerprint, type] = /^\d+ (SHA256:\S+) .* \((\S+)\)$/.exec(printed.stdout.trim()) ?? []
    if (printed.exitCode !== 0 || fingerprint === undefined || type === undefined) {
      throw new Error(`ssh-keygen could not fingerprint a key of ${destination.hostname}: ${printed.stderr}`)
    }
    keys.push({ line, fingerprint, type })
  }
  return keys
}

/**
 * Test whether any known-hosts file records a key for the name.
 * @param run - command runner.
 * @param sshKeygen - ssh-keygen argv prefix.
 * @param name - known-hosts name.
 * @param files - known-hosts files; missing files record nothing.
 * @param signal - cancellation.
 * @returns whether a key is recorded.
 */
export async function isKnownHost(
  run: CommandRunner, sshKeygen: ToolArgv, name: string, files: readonly string[], signal: AbortSignal,
): Promise<boolean> {
  for (const file of files) {
    const result = await run(sshKeygen, ['-F', name, '-f', file], { signal })
    if (result.exitCode === 0 && result.stdout.trim() !== '') return true
  }
  return false
}

/**
 * Quote one word for a POSIX shell.
 * @param word - text to quote.
 * @returns the single-quoted word.
 */
export function shellQuote(word: string): string {
  return `'${word.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * Quote one path inside an OpenSSH option value.
 * @param path - file path.
 * @returns the double-quoted path.
 */
export function sshOptionQuote(path: string): string {
  if (path.includes('"')) throw new Error(`OpenSSH option paths cannot contain double quotes: ${path}`)
  return `"${path}"`
}

/**
 * Describe how an ssh process ended, for runs that fail with the connection.
 * @param host - destination named in the message.
 * @param done - the process outcome, which rejects when the provider could not run it.
 * @param stderr - reads the retained standard error once the process has ended.
 * @returns the error that ended the channel.
 */
export async function describeEnd(
  host: string, done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>, stderr: () => string,
): Promise<Error> {
  const detail = (): string => {
    const text = stderr().trim()
    return text === '' ? '' : `: ${text}`
  }
  try {
    const outcome = await done
    return new Error(`ssh to ${host} exited with ${outcome.signal ?? `code ${outcome.exitCode}`}${detail()}`)
  } catch (error) {
    return new Error(`ssh to ${host} failed: ${error instanceof Error ? error.message : String(error)}${detail()}`)
  }
}

/** Daemon location and start-up options on the destination. */
export interface RemoteDaemon {
  readonly node: string
  readonly daemonPath: string
  readonly digest: string
}

/**
 * Build the remote shell command that serves the execution protocol over SSH stdio.
 * @param remote - daemon location and start-up options.
 * @returns the quoted command for ssh.
 */
export function remoteCommand(remote: RemoteDaemon): string {
  // A standalone ESM bundle must also run inside a destination's CommonJS package.
  const launch = `import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = readFileSync(process.argv[1]);
if (createHash('sha256').update(source).digest('hex') !== ${JSON.stringify(remote.digest)}) {
  throw new Error('Execution daemon changed after bootstrap; retry the connection.');
}
await import('data:text/javascript;base64,' + source.toString('base64'));`
  return `exec ${[remote.node, '--input-type=module', '-e', launch, remote.daemonPath, 'serve', '--stdio'].map(shellQuote).join(' ')}`
}

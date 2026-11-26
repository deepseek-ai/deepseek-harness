/**
 * SSH transport for the execution environment. Each open starts a stdio execution
 * process on the destination through OpenSSH. SSH authenticates the channel; host keys are checked
 * strictly against known_hosts, and an unknown host key, fetched through ssh so
 * proxy settings apply, is trusted only by a pinned fingerprint or a person's confirmation.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { EnvironmentChannel, EnvironmentConfirmation, EnvironmentOpenContext, EnvironmentTransport } from '@deepseek-ai/dsh-environment'
import { dshPath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  commandRunner, describeEnd, fetchHostKeys, isKnownHost, remoteCommand, resolveDestination, sshOptionQuote,
  type CommandRunner, type ScannedKey, type SshDestination,
} from './openssh.ts'
import { bootstrapDaemon, loadDaemon } from './bootstrap.ts'

export { SshEnvironmentError } from './bootstrap.ts'

/** Cordis plugin name. */
export const name = 'environment-ssh'
/** Services the transport registers with and starts OpenSSH through. */
export const inject = ['environments', 'subprocess']

/** One SSH environment; no model argument selects these values. */
export interface Config {
  /** Provider-owned registry key; omission derives it from the SSH destination. */
  handle?: string
  /** User-facing name; omission uses the SSH destination. */
  displayName?: string
  /** OpenSSH configuration file; omission uses the normal OpenSSH search. */
  configFile?: string
  /** OpenSSH destination or `ssh_config` alias; user, key and proxy settings come from the user's OpenSSH configuration. */
  host: string
  /** Absolute daemon destination; omission uses ~/.cache/dsh/environment/daemon.js on the remote machine. */
  daemonPath?: string
  /** Node executable on the destination. */
  node: string
  /** `SHA256:` host-key fingerprints trusted without confirmation when the host is not yet in known_hosts. */
  hostKeys: string[]
  /** Absolute known_hosts file where trusted keys are recorded; read before the user's own files. Omission uses the DSH state directory. */
  knownHostsFile?: string
  /** `ssh` argv prefix; it cannot contain options, so the transport's host-key options always apply. Use ssh_config for options. */
  ssh: string[]
  /** `ssh-keygen` argv prefix. */
  sshKeygen: string[]
  /** Grace between termination and forced kill of OpenSSH processes. */
  killGraceMs: number
  /** Retained bytes of OpenSSH standard error and helper output. */
  maxOutputBytes: number
}

/** Loader configuration with defaults. */
export const Config: schema<Partial<Config>, Config> = schema.object({
  handle: schema.string().min(1),
  displayName: schema.string().min(1),
  configFile: schema.string().min(1),
  host: schema.string().min(1).pattern(/^[^-]/).required(),
  daemonPath: schema.string().pattern(/^\//),
  node: schema.string().min(1).default('node'),
  hostKeys: schema.array(schema.string().pattern(/^SHA256:/)).default([]),
  /* v8 ignore next -- SSH provider execution is POSIX-tested; retain Windows host-path syntax for config compatibility. */
  knownHostsFile: schema.string().pattern(process.platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/ : /^\//),
  ssh: schema.array(schema.string().min(1).pattern(/^[^-]/)).min(1).default(['ssh']),
  sshKeygen: schema.array(schema.string().min(1).pattern(/^[^-]/)).min(1).default(['ssh-keygen']),
  killGraceMs: schema.natural().min(1).max(2_147_483_647).default(2000),
  maxOutputBytes: schema.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(64 * 1024),
})

// OpenSSH keeps the first value of each option, so a prefix option could override the enforced ones.
const argv = z.tuple([z.string().min(1)], z.string().refine(word => !word.startsWith('-'), 'tool prefixes must not contain options'))
const configSchema = z.object({
  handle: z.string().min(1).optional(), displayName: z.string().min(1).optional(), configFile: z.string().min(1).optional(), host: z.string().min(1).refine(host => !host.startsWith('-'), 'host must not start with a dash'),
  daemonPath: z.string().startsWith('/', 'daemonPath must be an absolute path on the destination').optional(), node: z.string().min(1),
  hostKeys: z.array(z.string().startsWith('SHA256:')),
  knownHostsFile: z.string().refine(isAbsolute, 'knownHostsFile must be an absolute path').optional(), ssh: argv, sshKeygen: argv,
  killGraceMs: z.number().int().positive().max(2_147_483_647), maxOutputBytes: z.number().int().positive(),
}).strict()

/** No trusted host key was available and no person confirmed one; code `ENVIRONMENT_SSH_HOST_KEY_UNTRUSTED`. */
export class SshHostKeyUntrustedError extends HarnessError {
  /** @param message - the host and the fingerprints to verify and pin. */
  constructor(message: string) {
    super(message, 'ENVIRONMENT_SSH_HOST_KEY_UNTRUSTED')
  }
}

/**
 * Register the configured SSH environment.
 * @param ctx - execution environment and subprocess provider.
 * @param config - destination, daemon location and trust settings.
 */
export function apply(ctx: Context, config: Config): void {
  const parsed = configSchema.parse(config)
  const ssh: [string, ...string[]] = [
    parsed.ssh[0], ...parsed.ssh.slice(1), ...parsed.configFile === undefined ? [] : ['-F', expandHomePath(parsed.configFile)],
  ]
  const info = { handle: ctx.environments.handle(parsed.handle ?? `ssh-${parsed.host}`), displayName: parsed.displayName ?? parsed.host }
  const resolved = { ...parsed, ssh }
  const knownHostsFile = resolved.knownHostsFile ?? dshPath('state', 'environment-ssh', 'known_hosts')
  const cwd = dirname(knownHostsFile)
  const run = commandRunner(ctx.subprocess, cwd, resolved.killGraceMs, resolved.maxOutputBytes)
  const transport: EnvironmentTransport = {
    async open(context) {
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      const destination = await resolveDestination(run, resolved.ssh, resolved.host, context.signal)
      await trust(run, resolved, knownHostsFile, destination, context)
      const knownHostsFiles = [knownHostsFile, ...destination.userKnownHostsFiles]
      const bundle = await loadDaemon()
      const daemonPath = await bootstrapDaemon((command, input) => run(resolved.ssh, [
        ...connectionArgs(knownHostsFiles), '--', resolved.host, command,
      ], { signal: context.signal, ...input === undefined ? {} : { input } }), resolved, bundle, context.signal)
      return connect(ctx, { ...resolved, daemonPath, digest: bundle.digest }, cwd, knownHostsFiles, context.signal)
    },
  }
  ctx.effect(() => ctx.environments.register(info, transport), 'environment-ssh.environment')
}

async function trust(
  run: CommandRunner, config: z.infer<typeof configSchema>,
  knownHostsFile: string, destination: SshDestination, context: EnvironmentOpenContext,
): Promise<void> {
  const files = [knownHostsFile, ...destination.userKnownHostsFiles, ...destination.globalKnownHostsFiles]
  // A recorded key, matching or not, is left to ssh's strict check: a changed key must fail, never be re-trusted here.
  if (await isKnownHost(run, config.sshKeygen, destination.knownHostsName, files, context.signal)) return
  const scratch = `${knownHostsFile}.fetch-${randomUUID()}`
  const keys = await fetchHostKeys(run, config, config.host, destination, scratch, context.signal)
  const pinned = keys.filter(key => config.hostKeys.includes(key.fingerprint))
  if (pinned.length > 0) {
    await record(knownHostsFile, pinned)
    return
  }
  const listing = keys.map(key => `${key.type} ${key.fingerprint}`).join('\n')
  const question: EnvironmentConfirmation = {
    hostname: destination.hostname,
    port: Number(destination.port),
    keys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })),
    detail: `Trust the SSH host key of ${destination.knownHostsName}? Compare with \`ssh-keygen -lf\` of the host's /etc/ssh/ssh_host_*_key.pub:\n${listing}`,
  }
  if (context.confirm !== undefined && await context.confirm(question)) {
    await record(knownHostsFile, keys)
    return
  }
  throw new SshHostKeyUntrustedError(
    `SSH host key of ${destination.knownHostsName} is not trusted. After verifying it on the host, add its fingerprint to hostKeys:\n${listing}`,
  )
}

async function record(file: string, keys: readonly ScannedKey[]): Promise<void> {
  await appendFile(file, keys.map(key => `${key.line}\n`).join(''), { mode: 0o600 })
}

function connectionArgs(knownHostsFiles: readonly string[]): string[] {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHostsFiles.map(sshOptionQuote).join(' ')}`]
}

async function connect(
  ctx: Context, config: z.infer<typeof configSchema> & { readonly daemonPath: string; readonly digest: string },
  cwd: string, knownHostsFiles: readonly string[], signal: AbortSignal,
): Promise<EnvironmentChannel> {
  const [program, ...prefix] = config.ssh
  const executable = await ctx.subprocess.resolveExecutable(program, undefined, signal)
  const remote = remoteCommand(config)
  signal.throwIfAborted()
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...prefix, ...connectionArgs(knownHostsFiles), '--', config.host, remote],
    cwd, graceMs: config.killGraceMs,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: config.maxOutputBytes } },
  })
  /* v8 ignore next 3 -- 'pipe' dispositions expose both streams by the subprocess contract. */
  if (handle.stdin === undefined || handle.stdout === undefined) {
    throw new Error('environment-ssh: the subprocess provider dropped a piped stream')
  }
  /* v8 ignore next -- the collect disposition always exposes a stderr reader. */
  const ended = describeEnd(config.host, handle.done, () => handle.collected.stderr?.readFrom(0).text ?? '')
  return { input: handle.stdout, output: handle.stdin, security: { kind: 'authenticated-transport' }, ended, close: () => { handle.terminate() } }
}

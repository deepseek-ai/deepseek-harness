/** A Host for Feishu plugin specs: scripted lark-cli processes, a temporary bin directory, and a recording Plugins page registry. */

import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import CliAccounts from '@deepseek-ai/dsh-cli-account'
import type { ConnectorAccountRegistration } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
} from '@deepseek-ai/dsh-subprocess'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executableFileName } from '../src/cli.ts'
import type { FeishuState } from '../src/types.ts'

/** Output and exit facts one scripted command reports. */
export interface CliReply {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
}

/** A piped process whose managed range exits on termination. */
export class ScriptedProcess implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly control = undefined
  readonly collected: SubprocessCollectedOutputs = {}
  readonly done: Promise<SubprocessOutcome>
  terminated = false
  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  private readonly exit = Promise.withResolvers<boolean>()

  constructor(readonly spec: SubprocessSpawnSpec) {
    this.done = this.outcome.promise
    spec.signal?.addEventListener('abort', () => { this.terminate() }, { once: true })
  }

  /** Write output while the command keeps running. */
  write(stream: 'stdout' | 'stderr', text: string): void {
    this[stream].write(text)
  }

  /** Finish the command with the given output; the managed range stays alive until termination. */
  reply(reply: CliReply): void {
    if (reply.stdout !== undefined) this.stdout.write(reply.stdout)
    if (reply.stderr !== undefined) this.stderr.write(reply.stderr)
    this.close()
    this.outcome.resolve({ exitCode: reply.exitCode === undefined ? 0 : reply.exitCode, signal: reply.signal ?? null })
  }

  terminate(): void {
    this.terminated = true
    this.close()
    this.outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
    this.exit.resolve(true)
  }

  private close(): void {
    if (!this.stdout.writableEnded) this.stdout.end()
    if (!this.stderr.writableEnded) this.stderr.end()
  }

  waitForExit(): Promise<boolean> {
    return this.exit.promise
  }
}

/** Host subprocess runtime whose lookups and spawns are recorded and answered by `respond`. */
export class ScriptedSubprocess extends SubprocessRuntime {
  readonly lookups: Array<{ command: string; env: Readonly<Record<string, string>> | undefined }> = []
  readonly processes: ScriptedProcess[] = []
  lookup: (signal?: AbortSignal) => Promise<string> = () => Promise.resolve('/fixture/bin/lark-cli')
  respond: (process: ScriptedProcess) => void | Promise<void> = (process) => { process.reply({ stdout: '{}' }) }

  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    this.lookups.push({ command, env })
    return this.lookup(signal)
  }

  override terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return Promise.resolve({ platform: 'posix' })
  }

  override spawn(spec: SubprocessSpawnSpec): ScriptedProcess {
    spec.signal?.throwIfAborted()
    const process = new ScriptedProcess(spec)
    this.processes.push(process)
    queueMicrotask(() => { void this.respond(process) })
    return process
  }

  override spawnTerminal(): Promise<never> {
    throw new Error('lark-cli commands never allocate a terminal')
  }
}

/**
 * Create a temporary directory holding an executable `lark-cli` placeholder, `lark-cli.exe` on Windows.
 * @returns the absolute bin directory.
 */
export async function createBinDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-feishu-bin-'))
  await writeFile(join(directory, executableFileName(process.platform)), '')
  await chmod(join(directory, executableFileName(process.platform)), 0o755)
  return directory
}

/** What the Feishu plugin registers for the Plugins page. */
export type FeishuPage = ConnectorAccountRegistration<FeishuState>

/** The services the Feishu plugin runs on, before the plugin itself loads. */
export interface FeishuHost {
  readonly ctx: Context
  readonly subprocess: ScriptedSubprocess
  /** The `binDir` to load the plugin with. */
  readonly binDir: string
  /** Every account registered for the Plugins page, in order; the registry keeps them after withdrawal. */
  readonly pages: FeishuPage[]
  /** How many of those accounts were withdrawn. */
  withdrawn: number
}

/**
 * Start a Host with the skill registry, a scripted subprocess runtime, the system prompt, a Plugins page registry that
 * records registrations, and the CLI account Service with a 5-second command deadline.
 * @returns the Host; the caller loads the Feishu plugin with `binDir`, disposes `ctx.fiber`, and removes `binDir`.
 */
export async function createHost(): Promise<FeishuHost> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ScriptedSubprocess)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  const host: FeishuHost = { ctx, subprocess: ctx.subprocess as ScriptedSubprocess, binDir: await createBinDir(), pages: [], withdrawn: 0 }
  ctx.provide('connectorAccounts', {
    register: (page: FeishuPage) => {
      host.pages.push(page)
      return () => { host.withdrawn += 1 }
    },
  })
  await ctx.plugin(CliAccounts, { commandTimeoutMs: 5_000 })
  return host
}

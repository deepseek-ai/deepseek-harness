/**
 * A Host for DingTalk plugin specs: scripted dws processes, a temporary DSH home, bin directory, and skills directory,
 * and a recording Plugins page registry.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { vi } from 'vitest'
import { executableFileName } from '../src/release.ts'
import type { DingtalkState } from '../src/types.ts'

/** Output and exit facts one scripted command reports. */
export interface CliReply {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
}

/** A piped process whose managed range exits on termination unless held. */
export class ScriptedProcess implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly control = undefined
  readonly collected: SubprocessCollectedOutputs = {}
  readonly done: Promise<SubprocessOutcome>
  terminated = false
  holdExit = false
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
    if (!this.holdExit) this.exit.resolve(true)
  }

  private close(): void {
    if (!this.stdout.writableEnded) this.stdout.end()
    if (!this.stderr.writableEnded) this.stderr.end()
  }

  /** Empty a held managed range. */
  release(): void {
    this.exit.resolve(true)
  }

  waitForExit(): Promise<boolean> {
    return this.exit.promise
  }
}

/** Host subprocess runtime whose lookups and spawns are recorded and answered by `respond`, by default with a signed-out status. */
export class ScriptedSubprocess extends SubprocessRuntime {
  readonly lookups: Array<{ command: string; env: Readonly<Record<string, string>> | undefined }> = []
  readonly processes: ScriptedProcess[] = []
  lookup: (signal?: AbortSignal) => Promise<string> = () => Promise.resolve('/fixture/bin/dws')
  respond: (process: ScriptedProcess) => void | Promise<void> = (process) => {
    process.reply({ stdout: '{"success": true, "authenticated": false, "message": "未登录"}\n' })
  }

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
    throw new Error('dws commands never allocate a terminal')
  }
}

/**
 * Answer each command by its arguments after the executable.
 * @param replies - reply per space-joined argument list.
 * @returns a `respond` function that fails unknown commands.
 */
export function byArguments(replies: Record<string, CliReply>): (process: ScriptedProcess) => void {
  return (process) => {
    const reply = replies[process.spec.argv.slice(1).join(' ')]
    process.reply(reply ?? { exitCode: 1, stderr: `unexpected command: ${process.spec.argv.join(' ')}` })
  }
}

/**
 * Create a temporary directory holding an executable `dws` placeholder, `dws.exe` on Windows.
 * @returns the absolute bin directory.
 */
export async function createBinDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-bin-'))
  await writeFile(join(directory, executableFileName(process.platform)), '')
  await chmod(join(directory, executableFileName(process.platform)), 0o755)
  return directory
}

/**
 * Create a temporary directory standing in for the upstream skills: one guide, laid out like `multi/` in `dws-skills.zip`.
 * @returns the absolute skills directory.
 */
export async function createSkillsDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-skills-'))
  await mkdir(join(directory, 'dingtalk-shared'))
  await writeFile(join(directory, 'dingtalk-shared', 'SKILL.md'), '---\nname: dingtalk-shared\ndescription: fixture guide\n---\n\n# Fixture guide\n')
  return directory
}

/** What the DingTalk plugin registers for the Plugins page. */
export type DingtalkPage = ConnectorAccountRegistration<DingtalkState>

/** The services the DingTalk plugin runs on, before the plugin itself loads. */
export interface DingtalkHost {
  readonly ctx: Context
  readonly subprocess: ScriptedSubprocess
  /** The temporary `DSH_HOME`, whose `cache/dingtalk` the plugin installs into. */
  readonly home: string
  /** The `binDir` to load the plugin with. */
  readonly binDir: string
  /** The `skillsDir` to load the plugin with, so that it downloads nothing. */
  readonly skillsDir: string
  /** Every account registered for the Plugins page, in order; the registry keeps them after withdrawal. */
  readonly pages: DingtalkPage[]
  /** How many of those accounts were withdrawn. */
  withdrawn: number
}

/**
 * Start a Host with the skill registry, a scripted subprocess runtime, the system prompt, a Plugins page registry that
 * records registrations, and the CLI account Service with a 5-second command deadline, and point `DSH_HOME` at a
 * temporary directory.
 * @returns the Host; the caller loads the DingTalk plugin with `binDir`, and ends with {@link closeHost}.
 */
export async function createHost(): Promise<DingtalkHost> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ScriptedSubprocess)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  const home = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-home-'))
  vi.stubEnv('DSH_HOME', home)
  const host: DingtalkHost = {
    ctx, subprocess: ctx.subprocess as ScriptedSubprocess, home, binDir: await createBinDir(), skillsDir: await createSkillsDir(),
    pages: [], withdrawn: 0,
  }
  ctx.provide('connectorAccounts', {
    register: (page: DingtalkPage) => {
      host.pages.push(page)
      return () => { host.withdrawn += 1 }
    },
  })
  await ctx.plugin(CliAccounts, { commandTimeoutMs: 5_000 })
  return host
}

/**
 * Dispose a Host's plugins, restore `DSH_HOME`, and remove the Host's temporary directories.
 * @param host - the Host {@link createHost} returned.
 */
export async function closeHost(host: DingtalkHost): Promise<void> {
  await host.ctx.fiber.dispose()
  vi.unstubAllEnvs()
  for (const directory of [host.home, host.binDir, host.skillsDir]) await rm(directory, { recursive: true, force: true })
}

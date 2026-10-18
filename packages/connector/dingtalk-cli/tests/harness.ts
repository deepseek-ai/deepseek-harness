/** Scripted dws processes and a temporary bin directory for DingTalk plugin specs. */

import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
} from '@deepseek-ai/dsh-subprocess'

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

/** Host subprocess runtime whose lookups and spawns are recorded and answered by `respond`. */
export class ScriptedSubprocess extends SubprocessRuntime {
  readonly lookups: Array<{ command: string; env: Readonly<Record<string, string>> | undefined }> = []
  readonly processes: ScriptedProcess[] = []
  host = true
  lookup: (signal?: AbortSignal) => Promise<string> = () => Promise.resolve('/fixture/bin/dws')
  respond: (process: ScriptedProcess) => void | Promise<void> = (process) => { process.reply({ stdout: '{}' }) }

  override get runsOnHost(): boolean {
    return this.host
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
 * Create a temporary directory holding an executable `dws` placeholder.
 * @returns the absolute bin directory.
 */
export async function createBinDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-bin-'))
  await writeFile(join(directory, 'dws'), '')
  await chmod(join(directory, 'dws'), 0o755)
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

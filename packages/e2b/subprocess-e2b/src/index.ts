/**
 * E2B Service Provider for the subprocess capability seam. Each handle starts through the
 * shared sandbox and retains command output/status paths in that remote world.
 * @module @deepseek-ai/dsh-subprocess-e2b
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { inspect } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { e2bControlEnvs, quoteE2BShellArg } from '@deepseek-ai/dsh-e2b'
import { E2BSubprocessHandle } from './process.ts'
import { asError, signalOpts } from './remote.ts'
import { spawnE2BTerminal } from './terminal.ts'

/** Configuration for the E2B subprocess adapter. */
export interface Config {
  /** Remote status/liveness poll cadence in milliseconds; each tick is one control-plane request. */
  pollMs?: number
}

interface SchemaResolvedConfig extends Config {
  pollMs: number
}

interface TerminalSetup {
  done: Promise<void>
  controller: AbortController
}

/**
 * Enforce the seam's documented grace bound (positive, finite, one Node timer),
 * matching subprocess-local's spawn-time check; an unbounded grace would make
 * the remote force-escalation deadline unreachable.
 * @param graceMs - The spec's cleanup grace in milliseconds.
 */
function requireRepresentableGrace(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function validateNoNullByte(subject: string, value: string): void {
  if (!value.includes('\0')) return
  const error = new TypeError(`${subject} must be a string without null bytes. Received ${inspect(value)}`)
  Object.assign(error, { code: 'ERR_INVALID_ARG_VALUE' })
  throw error
}

/** E2B command manager registered as `ctx.subprocess`. */
export class E2BSubprocessRuntime extends SubprocessRuntime {
  static inject = ['e2b']

  static Config: z<Config> = z.object({
    pollMs: z.number().default(20),
  })

  private readonly live = new Set<E2BSubprocessHandle>()
  private readonly terminals = new Set<SubprocessTerminalHandle>()
  private readonly terminalSetups = new Set<TerminalSetup>()
  private readonly pollMs: number
  private disposing = false

  /** Create the E2B subprocess service and bind its disposal policy. */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery fills pollMs before construction; the type does not encode that step.
    const { pollMs } = config as SchemaResolvedConfig
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0) {
      throw new Error('subprocess-e2b: pollMs must be a positive safe integer')
    }
    this.pollMs = pollMs
    ctx.effect(() => async () => {
      this.disposing = true
      for (const setup of this.terminalSetups) {
        setup.controller.abort(new Error('subprocess-e2b: service disposed during terminal setup'))
      }
      await Promise.all([...this.terminalSetups].map(setup => setup.done))
      const handles = [...this.live]
      const terminals = [...this.terminals]
      const pending: Promise<unknown>[] = []
      for (const handle of handles) {
        handle.terminate()
        pending.push(handle.waitForExit().then(async () => {
          await handle.done.catch(() => undefined)
          this.live.delete(handle)
        }))
      }
      for (const terminal of terminals) {
        pending.push(terminal.terminate().then(() => { this.terminals.delete(terminal) }))
      }
      const outcomes = await Promise.allSettled(pending)
      const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
        ? [outcome.reason as unknown]
        : [])
      if (failures.length === 1) throw asError(failures[0])
      if (failures.length > 1) throw new AggregateError(failures, 'subprocess-e2b: teardown failed')
    }, 'e2b subprocess teardown')
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-e2b: executable name must be non-empty')
    signal?.throwIfAborted()
    const sandbox = await this.ctx.e2b.getSandbox()
    if (posix.isAbsolute(command)) {
      await sandbox.commands.run(
        `test -f ${quoteE2BShellArg(command)} -a -x ${quoteE2BShellArg(command)}`,
        { envs: e2bControlEnvs(), ...signalOpts(signal) },
      )
      signal?.throwIfAborted()
      return command
    }
    if (command.includes('/')) {
      throw new Error(
        `subprocess-e2b: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const path = env?.PATH
    const prefix = path === undefined ? '' : `PATH=${quoteE2BShellArg(path)} `
    const result = await sandbox.commands.run(
      `${prefix}command -v -- ${quoteE2BShellArg(command)}`,
      { cwd: this.ctx.e2b.cwd, envs: e2bControlEnvs(), ...signalOpts(signal) },
    )
    signal?.throwIfAborted()
    const executable = result.stdout.trim()
    if (executable.includes('\n') || (!posix.isAbsolute(executable) && !executable.includes('/'))) {
      throw new Error(`subprocess-e2b: executable ${JSON.stringify(command)} did not resolve to one absolute path`)
    }
    // A relative result comes from a relative PATH entry; the lookup ran with the shared cwd.
    return posix.resolve(this.ctx.e2b.cwd, executable)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('subprocess-e2b: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    requireRepresentableGrace(spec.graceMs)
    if (spec.signal?.aborted === true) {
      let reason = 'aborted'
      try {
        reason = String(spec.signal.reason ?? reason)
      } catch {
        // Arbitrary caller-owned reasons cannot escape the stable Error boundary.
      }
      throw new Error(`aborted before spawn: ${reason}`)
    }
    spec.argv.forEach((value, index) => {
      validateNoNullByte(index === 0 ? "The argument 'file'" : `The argument 'args[${String(index - 1)}]'`, value)
    })
    validateNoNullByte("The property 'options.cwd'", spec.cwd)
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (value === undefined) continue
      validateNoNullByte(`The property 'options.env['${key}']'`, key)
      validateNoNullByte(`The property 'options.env['${key}']'`, value)
    }
    const stateDir = posix.join(this.ctx.e2b.runtimeRoot, 'processes', randomUUID())
    const handle = new E2BSubprocessHandle(this.ctx.e2b, spec, stateDir, this.pollMs)
    this.live.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit()
      this.live.delete(handle)
    }
    void handle.done.then(release, release).catch((_automaticReleaseFailure: unknown) => {
      // Retain the handle so service disposal can retry its cleanup transaction.
    })
    return handle
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('subprocess-e2b: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('subprocess-e2b: terminal argv must contain a program')
    }
    requireRepresentableGrace(spec.graceMs)
    spec.signal?.throwIfAborted()
    const stateDir = posix.join(this.ctx.e2b.runtimeRoot, 'terminals', randomUUID())
    const done = Promise.withResolvers<void>()
    const setup: TerminalSetup = { done: done.promise, controller: new AbortController() }
    const setupSignal = spec.signal === undefined
      ? setup.controller.signal
      : AbortSignal.any([spec.signal, setup.controller.signal])
    this.terminalSetups.add(setup)
    try {
      const terminal = await spawnE2BTerminal(
        this.ctx.e2b,
        { ...spec, signal: setupSignal },
        stateDir,
        this.pollMs,
      )
      this.terminals.add(terminal)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote allocation yields to disposal.
      if (this.disposing) {
        await terminal.terminate()
        this.terminals.delete(terminal)
        throw new Error('subprocess-e2b: service disposed during terminal setup')
      }
      const release = async (): Promise<void> => {
        await terminal.terminate()
        this.terminals.delete(terminal)
      }
      void terminal.done.then(release, release).catch((_automaticReleaseFailure: unknown) => {
        // Retain the terminal so service disposal can retry its cleanup transaction.
      })
      return terminal
    } finally {
      this.terminalSetups.delete(setup)
      done.resolve()
    }
  }
}

export default E2BSubprocessRuntime

/** Local node-pty terminal-process implementation for the subprocess seam. */

import { Buffer } from 'node:buffer'
import { constants } from 'node:os'
import { PassThrough } from 'node:stream'
import type { IDisposable, IPty } from 'node-pty'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
} from '@deepseek-ai/dsh-subprocess'
import type { BoundProcessOwner } from './managed-owner.ts'
import type { ProcessIdentity, ProcessInspector, ProcessSnapshot } from './process-inspector.ts'

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

async function raceWithDelay<T, U>(operation: Promise<T>, ms: number, timeout: U): Promise<T | U> {
  const controller = new AbortController()
  try {
    return await Promise.race([
      operation,
      delay(ms, controller.signal).then(() => timeout),
    ])
  } finally {
    controller.abort()
  }
}

function signalName(number: number | undefined): NodeJS.Signals | null {
  if (number === undefined || number === 0) return null
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === number) return name as NodeJS.Signals
  }
  return null
}

/**
 * A local terminal whose native managed range or fallback process-session
 * ownership stays below the PTY backend.
 * The seam's terminate() promise — no write, inspection, or signal in flight
 * after settlement — holds here without operation tracking only because every
 * handle call completes synchronously under the hood (node-pty write, ps-based
 * inspection). A first genuinely asynchronous step in any handle call must add
 * the tracking a remote provider needs.
 */
export class LocalTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>

  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  private readonly dataDisposable: IDisposable
  private readonly exitDisposable: IDisposable
  private cleanup: Promise<void> | undefined
  private managedOwnerCleaned = false
  private exited = false
  private trackedDescendants: ProcessIdentity[] = []
  /** The spawned shell's start identity; scans stop adopting members once the root pid no longer carries it. */
  private readonly rootIdentity: ProcessIdentity | undefined

  /**
   * @param terminal - allocated node-pty process.
   * @param inspector - platform process/session operations.
   * @param graceMs - TERM-to-KILL and exit-wait grace.
   * @param platform - host platform; defaults to the running platform, injectable for deterministic tests.
   */
  constructor(
    private readonly terminal: IPty,
    private readonly inspector: ProcessInspector,
    private readonly graceMs: number,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly managedOwner?: BoundProcessOwner,
    private readonly resolveManagedOutcome?: (outcome: SubprocessOutcome) => SubprocessOutcome,
  ) {
    this.pid = terminal.pid
    this.rootIdentity = inspector.snapshot().tree(this.pid).find(member => member.pid === this.pid)
    this.done = this.outcome.promise
    this.dataDisposable = terminal.onData((data) => { this.output.write(Buffer.from(data, 'utf8')) })
    this.exitDisposable = terminal.onExit(({ exitCode, signal: exitSignal }) => {
      if (this.exited) return
      this.exited = true
      this.output.end()
      const outcome = {
        exitCode: exitSignal === undefined || exitSignal === 0 ? exitCode : null,
        signal: signalName(exitSignal),
      }
      try {
        this.outcome.resolve(this.resolveManagedOutcome?.(outcome) ?? outcome)
      } catch (error) {
        this.outcome.reject(error)
      }
    })
  }

  /** Whether node-pty has not yet published the top-level exit event. */
  get running(): boolean {
    return !this.exited
  }

  // node-pty writes synchronously; the seam returns a promise for remote transports.
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async write(data: string): Promise<void> {
    if (this.exited) throw new Error('terminal process has exited')
    this.terminal.write(data)
  }

  // Local inspection is synchronous; the seam returns a promise for remote transports.
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    this.descendants(this.inspector.snapshot())
    const processGroupId = this.inspector.foregroundPgid(this.pid)
    if (processGroupId === undefined) return undefined
    return {
      processGroupId,
      inputWaiting: this.inspector.isStdinWaiting(processGroupId, this.pid),
    }
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const foreground = await this.inspectForeground()
    if (foreground === undefined) {
      throw new Error(`cannot resolve foreground process group for terminal ${this.pid}`)
    }
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
      throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
    }
    if (this.platform === 'win32') {
      if (signal === 'SIGINT') {
        // Windows has no process-group signalling: a `\x03` input write is the
        // Ctrl-C delivery path conhost turns into a console-wide CTRL_C event
        // for attached processes. node-pty's signal kills throw on Windows, so
        // no signal ever reaches the inspector.
        this.terminal.write('\x03')
        return foreground.processGroupId
      }
      if (signal === 'SIGTSTP' || signal === 'SIGHUP') {
        throw new Error(`signal ${signal} is unsupported on Windows; only SIGINT, SIGTERM, and SIGKILL are available`)
      }
    }
    this.inspector.signalGroup(foreground.processGroupId, signal)
    return foreground.processGroupId
  }

  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    const cleanup = this.closeOnce()
    this.cleanup = cleanup
    void cleanup.catch(() => { this.cleanup = undefined })
    return cleanup
  }

  /**
   * Force-terminate the observable session synchronously during Node's exit
   * event. This does not claim quiescence and does not replace terminate().
   */
  terminateForHostExit(): void {
    this.forceStopDescendants()
    this.forceStopShell()
    this.forceStopDescendants()
    this.managedOwner?.terminateForHostExit()
  }

  private forceStopShell(): void {
    if (this.exited) return
    if (this.rootIdentity !== undefined) {
      try {
        this.inspector.signalProcess(this.rootIdentity, 'SIGKILL')
      } catch (_rootExitedDuringHostExit) {
        // Exact identity signalling contains both exit races and PID reuse.
      }
      return
    }
    try {
      this.terminal.kill('SIGKILL')
    } catch (_unidentifiedShellExitedDuringHostExit) {
      // Without a captured identity, node-pty is the only root kill primitive.
    }
  }

  private survivors(members: ProcessIdentity[], observed: ProcessSnapshot): ProcessIdentity[] {
    return members.filter(member => observed.alive(member))
  }

  private descendants(observed: ProcessSnapshot): ProcessIdentity[] {
    // Adopt newly scanned members only while the numeric root pid provably
    // still carries the spawned shell's start identity: after the shell dies,
    // a recycled pid's tree and session must not donate an unrelated
    // process's children to this session's signalling. Already-adopted
    // members keep their own start identities, which every signal rechecks.
    const tree = observed.tree(this.pid)
    const root = tree.find(member => member.pid === this.pid)
    const rootVerified = this.rootIdentity !== undefined
      && root !== undefined
      && root.started === this.rootIdentity.started
    this.trackedDescendants = this.survivors(this.unionMembers(
      this.trackedDescendants,
      ...rootVerified ? [tree, observed.session(this.pid)] : [],
    ).filter(member => member.pid !== this.pid), observed)
    return this.trackedDescendants
  }

  private async waitForMembers(members: ProcessIdentity[]): Promise<ProcessIdentity[]> {
    if (members.length === 0) return []
    const until = Date.now() + this.graceMs
    let survivors = this.survivors(members, this.inspector.snapshot())
    while (survivors.length > 0 && Date.now() < until) {
      await delay(Math.min(25, Math.max(1, until - Date.now())))
      survivors = this.survivors(members, this.inspector.snapshot())
    }
    return survivors
  }

  private signalMembers(members: ProcessIdentity[], signal: 'SIGTERM' | 'SIGKILL'): void {
    for (const member of members) {
      try {
        // Each signal reads its own identity fence, inside this try: a failed
        // read must cost one target, never the rest of a teardown round.
        this.inspector.signalProcess(member, signal)
      } catch (_alreadyExitedDuringSignal) {
        // The exact process identity is rechecked; a same-tick exit is success.
      }
    }
  }

  private forceStopDescendants(): void {
    let members = this.trackedDescendants
    try {
      members = this.descendants(this.inspector.snapshot())
    } catch (_processTableUnavailableDuringHostExit) {
      // Preserve already-captured identities when a final process-table scan fails.
    }
    this.signalMembers(members, 'SIGKILL')
  }

  private unionMembers(...groups: ProcessIdentity[][]): ProcessIdentity[] {
    const members: ProcessIdentity[] = []
    const seen = new Set<string>()
    for (const group of groups) {
      for (const member of group) {
        const key = `${member.pid}:${member.started}`
        if (seen.has(key)) continue
        seen.add(key)
        members.push(member)
      }
    }
    return members
  }

  private async stopDescendants(): Promise<ProcessIdentity[]> {
    const captured = this.descendants(this.inspector.snapshot())
    this.signalMembers(captured, 'SIGTERM')
    const capturedSurvivors = await this.waitForMembers(captured)
    const members = this.unionMembers(capturedSurvivors, this.descendants(this.inspector.snapshot()))
    this.signalMembers(members, 'SIGKILL')
    const survivors = await this.waitForMembers(members)
    const observed = this.inspector.snapshot()
    return this.survivors(this.unionMembers(survivors, this.descendants(observed)), observed)
  }

  private async stopShell(): Promise<void> {
    if (this.platform === 'win32') {
      await this.stopShellWindows()
      return
    }
    if (!this.exited) {
      try {
        this.terminal.kill('SIGTERM')
      } catch (_topLevelAlreadyExitedDuringTerm) {
        // The exit callback is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) {
      try {
        this.terminal.kill('SIGKILL')
      } catch (_topLevelAlreadyExitedDuringKill) {
        // The exit callback is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  private async stopShellWindows(): Promise<void> {
    // node-pty's Windows kill(signal) throws ("Signals not supported on
    // windows"), and its bare kill() delegates to a console-list agent that
    // fails when the parent has no console. taskkill tree escalation is the
    // teardown path, fenced on the shell's start identity like every
    // descendant; a root identity miss falls back to the bare kill. taskkill
    // termination also does not reliably fire node-pty's exit notification
    // (the same console-list agent), so the tiers verify the shell's absence
    // through the inspector instead of waiting on `done` alone.
    const shellGone = (): boolean =>
      this.exited || (this.rootIdentity !== undefined && !this.inspector.isAlive(this.rootIdentity))
    if (!shellGone() && this.rootIdentity !== undefined) {
      this.inspector.signalProcess(this.rootIdentity, 'SIGTERM')
      await this.waitForWindowsShellExit()
    }
    if (!shellGone() && this.rootIdentity === undefined) {
      try {
        this.terminal.kill()
      } catch (_topLevelAlreadyExitedDuringKill) {
        // The exit callback is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!shellGone() && this.rootIdentity !== undefined) {
      this.inspector.signalProcess(this.rootIdentity, 'SIGKILL')
      await this.waitForWindowsShellExit()
    }
    if (!shellGone()) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  private async waitForWindowsShellExit(): Promise<void> {
    const until = Date.now() + this.graceMs
    while (!this.exited && Date.now() < until) {
      if (this.rootIdentity !== undefined && !this.inspector.isAlive(this.rootIdentity)) return
      await delay(Math.min(25, Math.max(1, until - Date.now())))
    }
  }

  private async closeOnce(): Promise<void> {
    if (this.managedOwner !== undefined) {
      try {
        await this.closeManagedRange(this.managedOwner)
        this.dataDisposable.dispose()
        this.exitDisposable.dispose()
      } finally {
        void this.done.finally(() => { this.cleanupManagedOwner(this.managedOwner as BoundProcessOwner) }).catch(() => {})
      }
      return
    }
    let survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map(member => member.pid).join(', ')}`)
    }
    await this.stopShell()
    survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map(member => member.pid).join(', ')}`)
    }
    this.settleExitIfGone()
    this.dataDisposable.dispose()
    this.exitDisposable.dispose()
  }

  private cleanupManagedOwner(owner: BoundProcessOwner): void {
    if (this.managedOwnerCleaned) return
    this.managedOwnerCleaned = true
    owner.cleanup?.()
  }

  private async closeManagedRange(owner: BoundProcessOwner): Promise<void> {
    owner.signal('SIGTERM')
    const observation = owner.waitForExit()
    const first = await raceWithDelay(observation.then(
      () => ({ kind: 'stopped' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    ), this.graceMs, { kind: 'timeout' as const })
    if (first.kind !== 'stopped') {
      owner.signal('SIGKILL')
      if (first.kind === 'failed') {
        // The observation failure is still authoritative, but force cleanup
        // and a fresh final observation must be attempted before exposing it.
        try {
          await owner.waitForExit()
        } catch (finalError: unknown) {
          throw new AggregateError([first.error, finalError], 'terminal managed-range cleanup failed')
        }
        throw first.error
      }
      await observation
    }
    if (!this.exited) {
      await raceWithDelay(this.done.then(() => undefined), this.graceMs, undefined)
    }
    if (!this.exited) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  private settleExitIfGone(): void {
    // An externally taskkilled Windows shell may never fire node-pty's exit
    // notification (its console-list agent fails without a parent console),
    // which would leave `done` — and every consumer awaiting it — unsettled
    // forever. Teardown has just verified the shell's absence through the
    // inspector, so a missing exit event is itself the outcome.
    if (this.platform !== 'win32') return
    if (this.exited) return
    /* v8 ignore next -- stopShellWindows() verified the shell is gone or threw;
       the identity re-check is a defensive fence for a future caller. */
    if (this.rootIdentity !== undefined && this.inspector.isAlive(this.rootIdentity)) return
    this.exited = true
    this.output.end()
    this.outcome.resolve({ exitCode: null, signal: null })
  }
}

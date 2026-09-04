/**
 * Process plumbing for the local subprocess service: detached process-tree
 * spawn with per-stream stdio dispositions, tail-keep collection with spill
 * files, tree-scoped signalling (POSIX groups; Windows taskkill), and the
 * SIGTERM→SIGKILL escalation. This layer reacts to an abort signal; callers
 * own deadlines, teardown ladders, and cause classification.
 * @module dsh-subprocess-local/spawn
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  CollectedOutput,
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { linuxProcessGroupHasLiveMembers } from './process-inspector.ts'

type SpawnProcess = (
  program: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/**
 * Build a child environment: explicit caller entries override the scrubbed
 * parent base using the target platform's environment-key semantics. A string
 * deliberately restores or overrides an entry; an explicit `undefined`
 * tombstone removes an ordinary ambient entry.
 * @param extra - explicit caller entries and tombstones, merged after the scrub.
 * @returns the environment to hand to `spawn` for the child process.
 */
export function childEnv(extra?: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env = scrubbedParentEnv()
  if (process.platform !== 'win32') return { ...env, ...extra }
  let entries: [string, string | undefined][] = Object.entries(env)
  for (const [key, value] of Object.entries(extra ?? {})) {
    const normalized = key.toUpperCase()
    entries = entries.filter(([inherited]) => inherited.toUpperCase() !== normalized)
    entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

/** Injectable process, spill, and platform operations. */
export interface SpawnInternals {
  /** Process spawner (defaults to `node:child_process` `spawn`). */
  spawn?: SpawnProcess
  /** Directory for spill files (defaults to the OS temp dir). */
  spillDir?: string
  /** Windows tree-termination runner (defaults to `taskkill /PID <pid> /T /F`). */
  taskkill?: (pid: number) => void
  /** Host platform override for signalling decisions. */
  platform?: NodeJS.Platform
  /** Linux process-group member probe (defaults to `/proc` inspection). */
  linuxProcessGroupHasLiveMembers?: (processGroupId: number) => boolean | undefined
}

/**
 * Local-only synchronous final termination used by the owning service during
 * host exit and as the last fallback after failed normal disposal. It is
 * intentionally absent from the public subprocess seam.
 */
export interface LocalSubprocessHandle extends SubprocessHandle {
  /** Force-terminate the current tree synchronously without starting timers or waits. */
  terminateForHostExit(): void
}

/**
 * Liveness-poll cadence for tree-exit waits. The timer stays ref'd: an
 * awaited teardown must keep the event loop alive until the tree really
 * exits, or the parent can exit while claiming quiescence and orphan the
 * survivors it promised to reap.
 */
function sleepTick(): Promise<void> {
  return sleepMs(15)
}

let spillCounter = 0
let defaultSpillDir: string | undefined

/**
 * The default spill location: a private (0700) per-process directory under
 * the OS tmpdir, created lazily. Predictable world-readable paths would let
 * other local users read command output or pre-create symlinks. At a
 * JavaScript-observable process exit the directory is removed only when it
 * holds no completed spill file (spill files are retained as full-output
 * recovery artifacts until an external cleanup).
 */
function privateSpillDir(): string {
  defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'dsh-subprocess-'))
  return defaultSpillDir
}

// The per-process spill directory is removed at process exit when it holds no
// completed spill file: a directory that never spilled is empty and is safe to
// remove, while a directory holding completed spill files keeps them (their
// content is retained until an external cleanup). A SIGKILLed process cannot
// run this at all; its residue is left to OS temp hygiene.
/* v8 ignore next 4 -- exit listeners run after the coverage dump; removal is verified by the CI /tmp residue measurement. */
process.once('exit', () => {
  if (defaultSpillDir === undefined) return
  try { rmdirSync(defaultSpillDir) } catch { /* best-effort: ENOENT/ENOTEMPTY/EBUSY/EPERM must not change the exit code. */ }
})

/**
 * Collects one stream with a bounded in-memory tail. With a spill cap, on
 * first overflow a spill file is created and every chunk (including those
 * already collected) is appended there while the full stream remains within
 * the cap; without one, only the in-memory tail is ever retained (the
 * diagnostic-tail shape — a language server's stderr).
 *
 * Tail-keep rationale (pi/OpenCode): errors and final results cluster at the
 * end of command output; the spill file covers the head.
 */
export class OutputCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private dropped = false
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDisabled: boolean
  /** Total bytes ever pushed (not just retained). */
  private total = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly label: string,
    private readonly spillDir: string,
  ) {
    this.spillDisabled = maxSpillBytes === undefined
  }

  /**
   * Ingest one stream chunk, counting it toward the whole-stream total. On
   * first overflow of the in-memory cap a spill file is opened (when spilling
   * is enabled) and every chunk (already-collected ones included) is appended
   * there from then on; the in-memory tail then drops whole chunks from its
   * head (or the head of a single over-cap chunk) until it fits the cap again.
   * @param chunk - the raw bytes from one stream 'data' event.
   */
  push(chunk: Buffer): void {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    if (!this.spillDisabled && (overflows || this.spillFd !== undefined)) this.spillAll(chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        // Drop the whole head chunk (length ≥ 1 is guaranteed while over cap).
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        // Trim the head so the retained window is byte-exact at the cap — a
        // diagnostic tail (an LSP server's stderr) must hold the LAST
        // maxBytes regardless of how the stream was chunked.
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  /** Open the spill file lazily and append `chunk` (and any prior chunks once). */
  private spillAll(chunk: Buffer): void {
    if (this.maxSpillBytes !== undefined && this.total > this.maxSpillBytes) {
      this.discardSpill()
      return
    }
    if (this.spillFd === undefined) {
      // Random suffix + O_EXCL + no-follow-equivalent ('wx' fails on any
      // existing path, symlink or not) + owner-only mode: defeats spill-path
      // prediction and symlink planting in shared tmp dirs.
      this.spillFile = join(
        this.spillDir,
        `dsh-subprocess-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
      )
      this.spillFd = openSync(this.spillFile, 'wx', 0o600)
      for (const prior of this.chunks) writeSync(this.spillFd, prior)
    }
    writeSync(this.spillFd, chunk)
  }

  /** Stop spilling and remove the file once it can no longer hold the complete stream. */
  private discardSpill(): void {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Retain the descriptor so finalize can retry the failed close.
        this.spillFd = fd
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // A failed unlink leaves at most maxSpillBytes behind, never an unbounded file.
      }
    }
  }

  /**
   * Incremental read in whole-stream byte coordinates: returns everything
   * pushed since `fromByte`. When `fromByte` has already slid out of the
   * in-memory tail window, the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the offset for the next read, the `lossy` flag, and the spill path when one was created.
   */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }

  /**
   * Close the spill file once the stream has ended. A failed close (delayed
   * writeback fault) stops advertising the spill path — the file may be
   * missing its tail — while every in-memory read keeps working. Idempotent;
   * the spawn path seals both collectors at settlement so reads after exit
   * never point at a still-open file.
   */
  seal(): void {
    if (this.spillFd === undefined) return
    try {
      closeSync(this.spillFd)
    } catch {
      // A delayed writeback failure makes the spill unreliable; keep the
      // in-memory result but stop advertising that file.
      this.spillFile = undefined
    }
    this.spillFd = undefined
  }

  /**
   * Seal the spill file and return the final output.
   * @returns the final collected output: tail text, truncation flag, and the spill path when intact.
   */
  finalize(): CollectedOutput {
    this.seal()
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }
}

/**
 * Send `sig` to a detached POSIX process group. Never throws: delivery races
 * process exit and may run in a timer callback, so failures are contained and
 * a non-positive pid is a no-op.
 * @param pid - the group leader's pid; non-positive means the spawn failed and the call is a no-op.
 * @param sig - the signal to deliver to the whole group.
 */
export function killGroup(pid: number, sig: NodeJS.Signals): void {
  if (pid <= 0) return
  try {
    process.kill(-pid, sig)
  } catch {
    // Swallow: see contract above.
  }
}

/**
 * Terminate one Windows process tree with `taskkill /T /F`. Contained like
 * POSIX group signalling — delivery races tree exit, so an absent tree, a
 * nonzero status, or a missing taskkill binary must not break idempotent
 * teardown.
 * @param pid - root process id; non-positive is a no-op.
 */
export function taskkillProcessTree(pid: number): void {
  if (pid <= 0) return
  // Outcome deliberately unchecked: an already-absent tree (status 128), exit
  // races, and a missing taskkill binary (spawnSync reports, never throws) are
  // as tolerable here as ESRCH is for a POSIX group signal.
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

/**
 * Signal a detached process tree with platform-correct semantics: POSIX
 * signals the negative process-group id and falls back to the direct child
 * when the group is gone; Windows terminates the tree via taskkill (any
 * signal value force-terminates — Node maps signals to TerminateProcess).
 */
function signalTree(
  platform: NodeJS.Platform,
  pid: number,
  sig: NodeJS.Signals,
  child: ChildProcess,
  taskkill: (pid: number) => void,
): void {
  if (platform === 'win32') {
    taskkill(pid)
    return
  }
  /* v8 ignore next -- kill/terminate gate on treeAlive(), which is false for pid -1; this guard protects direct callers only. */
  if (pid <= 0) return
  try {
    process.kill(-pid, sig)
  } catch {
    /* v8 ignore start -- the fallback needs a live child whose group signal fails
       (EPERM-style), which POSIX CI cannot stage; the swallow keeps teardown idempotent. */
    try {
      child.kill(sig)
    } catch {
      // The direct child already exited; teardown remains idempotent.
    }
    /* v8 ignore stop */
  }
}

/**
 * Spawn one isolated detached process tree with the spec's per-stream stdio
 * dispositions. Runtime exits resolve `done` as {@link SubprocessOutcome};
 * only spawn failures reject.
 * @param spec - fully resolved argv, cwd, stdio, grace, cancellation, environment.
 * @param internals - test-only spill-directory, platform, and taskkill overrides.
 * @returns live subprocess handle.
 * @throws when `graceMs` cannot be represented by one Node timer.
 */
export function spawnSubprocess(spec: SubprocessSpawnSpec, internals: SpawnInternals = {}): LocalSubprocessHandle {
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const spillDir = internals.spillDir ?? privateSpillDir()
  const platform = internals.platform ?? process.platform
  const spawnProcess = internals.spawn ?? spawn
  const taskkill = internals.taskkill ?? taskkillProcessTree
  const linuxGroupHasLiveMembers = internals.linuxProcessGroupHasLiveMembers ?? linuxProcessGroupHasLiveMembers

  if (spec.signal?.aborted) {
    throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
  }
  const [program, ...args] = spec.argv
  if (program === undefined || program.length === 0) {
    throw new Error('invalid argv: expected a non-empty program name at argv[0]')
  }

  const isCollect = (mode: SubprocessOutputMode): mode is SubprocessCollect =>
    mode !== 'pipe' && mode !== 'inherit'
  const outMode = spec.stdio.stdout
  const errMode = spec.stdio.stderr
  const stdinMode = spec.stdio.stdin

  const env = childEnv(spec.env)
  const child = spawnProcess(program, args, {
    cwd: spec.cwd,
    env,
    stdio: [
      stdinMode === 'ignore' ? 'ignore' : 'pipe',
      outMode === 'inherit' ? 'inherit' : 'pipe',
      errMode === 'inherit' ? 'inherit' : 'pipe',
    ],
    // `detached` gives teardown a tree root on POSIX (its own process group);
    // Windows terminates by root pid through taskkill /T instead.
    detached: platform !== 'win32',
    windowsHide: platform === 'win32',
  })

  const collectStream = (mode: SubprocessOutputMode, stream: Readable | null, label: string): OutputCollector | undefined => {
    if (!isCollect(mode) || stream === null) return undefined
    const collector = new OutputCollector(mode.maxBytes, mode.spill?.maxBytes, label, spillDir)
    stream.on('data', (chunk: Buffer) => { collector.push(chunk) })
    return collector
  }
  const stdoutCollector = collectStream(outMode, child.stdout, 'stdout')
  const stderrCollector = collectStream(errMode, child.stderr, 'stderr')

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let treeExitObserved = false
  let treeExitObservation: Promise<void> | undefined
  let settled = false

  // Failed spawns use pid -1 so signalling remains a no-op.
  const pid = child.pid ?? -1

  /** Whether the detached tree's root (or POSIX group) is still alive. */
  const treeAlive = (): boolean => {
    /* v8 ignore next -- only a timer callback already queued when the observer settles can enter here;
       the guard is the final defense against probing an id after its tree was confirmed absent. */
    if (treeExitObserved) return false
    if (pid <= 0) return false
    if (platform === 'win32') {
      // Windows has no group-liveness probe; the direct child's exit is the
      // observable boundary (taskkill /T already took the tree with it).
      return child.exitCode === null && child.signalCode === null
    }
    try {
      process.kill(-pid, 0)
      // A group containing only unreaped zombies still answers kill(0), but
      // it can execute no work and cannot be signalled into quiescence. Only
      // inspect after direct-child settlement so live-process polls remain a
      // syscall rather than repeated process-table scans.
      if (settled && platform === 'linux' && linuxGroupHasLiveMembers(pid) === false) return false
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      /* v8 ignore next 2 -- POSIX reports an absent group as ESRCH; child-reaping timing
         makes observing the other arm platform-dependent. */
      if (code === 'ESRCH') return false
      /* v8 ignore start -- EPERM and non-POSIX negative-pid failures are platform defenses; CI runs
         tree-lifecycle tests on POSIX hosts where absence reports ESRCH. */
      if (code === 'EPERM') return true
      return child.exitCode === null && child.signalCode === null
      /* v8 ignore stop */
    }
  }

  /**
   * Start or reuse the handle's single whole-tree exit observer. The first
   * confirmed absence is a permanent no-more-signals boundary: it cancels a
   * pending escalation before this process-group id can be reused.
   */
  const observeTreeExit = (): Promise<void> => {
    treeExitObservation ??= (async () => {
      while (treeAlive()) await sleepTick()
      treeExitObserved = true
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      graceTimer = undefined
    })()
    return treeExitObservation
  }

  // The escalation's tier primitive (not on the handle — terminate() is the
  // only consumer-facing termination verb). Guards on TREE liveness, not
  // outcome settlement: a TERM-trapping helper can outlive the settled direct
  // child and must stay signalable, while a fully-dead tree (possible pid
  // reuse) must not be re-signalled by a later tier.
  const kill = (sig: NodeJS.Signals): void => {
    /* v8 ignore next -- the shared exit observer cancels the ordinary dead-tree timer;
       this remains the timer/death race guard and cannot be staged deterministically. */
    if (!treeAlive()) return
    signalTree(platform, pid, sig, child, taskkill)
  }

  const terminate = (): void => {
    if (treeExitObserved || graceTimer !== undefined) return
    // Observe from the first termination tier onward, even when inherited
    // pipes delay `done` and no consumer has begun its own teardown wait.
    void observeTreeExit()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- observer can record absence before its first await.
    if (treeExitObserved) return
    kill('SIGTERM')
    // The escalation must survive direct-child settlement — the leader dying
    // does not mean the tree died — so settle does not clear this timer, and
    // kill() re-probes tree liveness before force-killing. It stays ref'd:
    // the pending SIGKILL is a commitment, and a parent exiting before it
    // fires would orphan a trapped survivor. Self-bounds at graceMs.
    graceTimer = setTimeout(() => { kill('SIGKILL') }, spec.graceMs)
  }

  const terminateForHostExit = (): void => {
    kill('SIGKILL')
  }

  // The caller owns timeout classification; this layer only reacts to abort.
  const onAbort = (): void => { terminate() }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  // Batch stdin is written and closed up front; process exit and captured
  // output remain authoritative, so write errors (EPIPE) are best-effort.
  if (typeof stdinMode === 'object' && child.stdin !== null) {
    child.stdin.on('error', () => { /* stdin write is best-effort; outcome rides on exit/output. */ })
    child.stdin.end(stdinMode.data)
  }

  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    let pipeDrainTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      // Only harness-collected pipes are force-closed at the drain boundary;
      // a 'pipe'-mode stream belongs to the caller and closes with the child.
      if (stdoutCollector !== undefined) child.stdout?.destroy()
      if (stderrCollector !== undefined) child.stderr?.destroy()
      stdoutCollector?.seal()
      stderrCollector?.seal()
      cleanup()
      resolve({ exitCode, signal })
    }
    child.on('error', (error) => {
      // No meaningful close outcome follows a spawn failure.
      settled = true
      cleanup()
      reject(error)
    })
    child.on('exit', (exitCode, signal) => {
      // A surviving descendant that inherited a pipe must not hold the
      // outcome open indefinitely: after exit, the same bounded grace that
      // governs kills also bounds the close wait.
      pipeDrainTimer = setTimeout(() => {
        settle(exitCode, signal)
      }, spec.graceMs)
    })
    child.on('close', settle)
    function cleanup(): void {
      // graceTimer deliberately NOT cleared: the SIGKILL escalation must be
      // able to reach tree survivors after the direct child settles.
      if (pipeDrainTimer !== undefined) clearTimeout(pipeDrainTimer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  })

  const waitForExit = async (signal?: AbortSignal): Promise<boolean> => {
    const observed = observeTreeExit()
    if (treeExitObserved) return true
    if (signal?.aborted) return false
    if (signal === undefined) {
      await observed
      return true
    }
    const aborted = Promise.withResolvers<boolean>()
    const onAbort = (): void => { aborted.resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    /* v8 ignore next -- closes the event-loop race between the preceding aborted check and listener registration. */
    if (signal.aborted) onAbort()
    try {
      return await Promise.race([observed.then(() => true), aborted.promise])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  return {
    pid,
    /* v8 ignore start -- pipe-mode fds exist on every spawn Node returns; the null-coalesces guard a nonconforming ChildProcess only. */
    stdin: stdinMode === 'pipe' ? child.stdin ?? undefined : undefined,
    stdout: outMode === 'pipe' ? child.stdout ?? undefined : undefined,
    stderr: errMode === 'pipe' ? child.stderr ?? undefined : undefined,
    /* v8 ignore stop */
    collected: {
      ...stdoutCollector !== undefined ? { stdout: stdoutCollector } : {},
      ...stderrCollector !== undefined ? { stderr: stderrCollector } : {},
    },
    done,
    terminate,
    terminateForHostExit,
    waitForExit,
  }
}

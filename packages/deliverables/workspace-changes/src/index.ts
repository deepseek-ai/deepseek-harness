/**
 * Summarizes the files each top-level turn changed from git working-tree
 * snapshots taken at turn start and turn end, plus whole-file captures taken
 * around each file-tool edit for paths git does not cover, and serves each
 * listed file's before-and-after comparison on demand. Each summary is
 * announced by a `workspace/changes` Session event that carries only the turn
 * number; summaries and comparisons are served through the `workspaceChanges`
 * service until the Session is disposed. Outside a git repository, or without
 * git, the summary lists file-tool edits only.
 */
import { homedir, tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { GitRunner } from './git.ts'
import { TurnRecorder } from './recorder.ts'
import type { WorkspaceChanges } from './types.ts'

export type {
  WorkspaceChangedFile, WorkspaceChanges, WorkspaceChangesSummary, WorkspaceDiffHunk, WorkspaceFileDiff,
} from './types.ts'

/** Stable Loader identity. */
export const name = 'workspace-changes'

/** Services used to run git and observe turns. */
export const inject = ['subprocess']

/** Snapshot, capture, and comparison bounds. Invalid values fail plugin load. */
export interface Config {
  /** Milliseconds one git command may run before the turn's record is abandoned. */
  timeoutMs: number
  /** Bytes of git output retained per command; a larger diff listing abandons the record. */
  outputMaxBytes: number
  /** Maximum files carried by one summary; `total` still reports the complete count. */
  maxFiles: number
  /**
   * Bytes a file may hold to be captured around a file-tool edit or read from a snapshot for its comparison.
   * A larger file gets no comparison; one captured around a file-tool edit is also listed without counts.
   */
  maxFileBytes: number
  /** Milliseconds a line comparison may run before it degrades to whole-file replacement. */
  diffTimeoutMs: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(30_000),
  outputMaxBytes: z.number().default(8 * 1024 * 1024),
  maxFiles: z.number().default(500),
  maxFileBytes: z.number().default(2 * 1024 * 1024),
  diffTimeoutMs: z.number().default(100),
})

function eligible(session: Session): string | undefined {
  const { cwd, origin, delegationDepth } = session.header
  return origin === 'subagent' || (delegationDepth ?? 0) > 0 ? undefined : cwd
}

/**
 * Resolve the git executable once. On macOS the Xcode stub at `/usr/bin/git`
 * opens an installer dialog instead of running, so it counts as absent until
 * developer tools are selected.
 * @param ctx - subprocess capability.
 * @param signal - plugin lifetime.
 * @returns the executable path, or null when git is unavailable.
 */
async function resolveGit(ctx: Context, signal: AbortSignal): Promise<string | null> {
  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  const probe = ctx.subprocess.spawn({
    argv: ['/usr/bin/xcode-select', '-p'], cwd: homedir(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1_000, signal,
  })
  const outcome = await probe.done.catch(() => ({ exitCode: null }))
  return outcome.exitCode === 0 ? executable : null
}

/**
 * Observe top-level turns of every Session with a working directory, capture
 * file-tool edits, announce change summaries, and serve them with their
 * comparisons as `workspaceChanges`.
 * @param ctx - host context with `subprocess`.
 * @param config - validated bounds.
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [
    ['timeoutMs', config.timeoutMs], ['outputMaxBytes', config.outputMaxBytes], ['maxFiles', config.maxFiles],
    ['maxFileBytes', config.maxFileBytes], ['diffTimeoutMs', config.diffTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`workspace-changes requires a positive integer ${field}`)
  }
  const lifetime = new AbortController()
  const recorders = new Map<Session, TurnRecorder>()
  const byId = new Map<SessionId, TurnRecorder>()
  const forget = (session: Session): Promise<void> => {
    const recorder = recorders.get(session)
    recorders.delete(session)
    byId.delete(session.id)
    return recorder?.dispose() ?? Promise.resolve()
  }
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.all([...recorders.keys()].map(forget))
  })
  const service: WorkspaceChanges = {
    summary: (sessionId, seq) => byId.get(sessionId)?.summary(seq),
    diff: (sessionId, seq, index, signal) => byId.get(sessionId)?.diff(seq, index, signal) ?? Promise.resolve(undefined),
  }
  ctx.provide('workspaceChanges', service)
  let runner: Promise<GitRunner | null> | undefined
  const gitRunner = (): Promise<GitRunner | null> => {
    runner ??= resolveGit(ctx, lifetime.signal).then((executable) => {
      if (executable === null) {
        ctx.logger.info('workspace-changes: git is unavailable; only file-tool edits are summarized')
        return null
      }
      return new GitRunner(ctx.subprocess, executable, { timeoutMs: config.timeoutMs, outputMaxBytes: config.outputMaxBytes })
    })
    return runner
  }
  const recorderFor = (session: Session, cwd: string): TurnRecorder => {
    let recorder = recorders.get(session)
    if (recorder === undefined) {
      recorder = new TurnRecorder(session, cwd, {
        git: gitRunner(), tempRoot: tmpdir(), maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes, diffTimeoutMs: config.diffTimeoutMs,
        warn: (message) => { ctx.logger.warn(message) },
      })
      recorders.set(session, recorder)
      byId.set(session.id, recorder)
    }
    return recorder
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const cwd = eligible(session)
      if (cwd !== undefined) recorderFor(session, cwd).start(event.data.turn)
      return
    }
    if (event.type === 'tool/result') recorders.get(session)?.observe(event)
    else if (event.type === 'turn/end') recorders.get(session)?.end(event.data.turn)
  })
  ctx.on('session/disposed', (session) => { void forget(session) })
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    await recorders.get(agent.session)?.stopping(turn)
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session
    const recorder = session === undefined ? undefined : recorders.get(session)
    if (recorder !== undefined) {
      recorder.capture(exec.name, exec.arguments)
      await recorder.settled()
    }
    return next()
  })
}

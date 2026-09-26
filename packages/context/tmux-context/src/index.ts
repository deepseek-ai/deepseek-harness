/**
 * Opt-in request-preparation tmux-location context. Eligible step attempts
 * append durable, source-attributed context naming the tmux session, window,
 * and pane this agent process runs in, plus the window's pane-tree layout.
 *
 * The plugin pulls state once per turn, for the first request (`step === 1`), by
 * running one `tmux display-message` through the `ctx.shell` executor service. It
 * confirms this process genuinely runs inside the pane `$TMUX_PANE` names by
 * matching the pane's `#{pane_tty}` against this process's controlling terminal,
 * so a terminal that merely inherited `$TMUX`/`$TMUX_PANE` from a tmux ancestor
 * (e.g. a VS Code integrated terminal) reads as "not in tmux". It re-injects
 * only when the rendered tmux state changes since the last injection (a moved,
 * renamed, or re-laid-out pane), with an optional `refreshIntervalMs` floor
 * between injections. Absent tmux environment, an inherited-only environment,
 * absent `ctx.shell`, or a failed query is a no-op, never an error: an executor
 * rejection is contained and logged as a warning so the turn continues.
 *
 * @module @deepseek-ai/dsh-tmux-context
 */

import type { Context, LoggerService } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Location attribution; readers preserve the content without this producer.
     * Its projection uses the kind to avoid repeated injection.
     * @persistenceAttribution
     */
    'tmux-context': { kind: 'tmux-context' } & ContextFormed
  }
}


/** Cordis plugin name used by loader diagnostics. */
export const name = 'tmux-context'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents', 'sessionProjections']

/** Per-turn tmux-location scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Minimum milliseconds between durable injections in one session. Omit or set to 0 to inject on every eligible change. */
  refreshIntervalMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  refreshIntervalMs: z.number(),
})

/**
 * Tab-separated tmux format fields, in query order. Layout (`window_layout`)
 * is the pane-tree description; pane/window pixel sizes are intentionally
 * excluded (own location and layout only, per the package scope).
 */
const TMUX_FIELDS = [
  '#{session_name}',
  '#{window_index}',
  '#{window_name}',
  '#{pane_index}',
  '#{pane_id}',
  '#{window_active}',
  '#{pane_active}',
  '#{window_layout}',
] as const

/** Structured tmux location parsed from one `display-message` reading. */
interface TmuxLocation {
  sessionName: string
  windowIndex: string
  windowName: string
  paneIndex: string
  paneId: string
  windowActive: string
  paneActive: string
  windowLayout: string
}

/** Prefix marking the volatile turn/step preamble line of a rendered reading. */
const READING_PREFIX = 'tmux location (turn '

/**
 * Field separator between tmux format fields. tmux does not interpret C escapes
 * in a format, so the literal two-character sequence `\t` is emitted verbatim
 * and split back out here; this avoids embedding raw whitespace in the command.
 */
const FIELD_SEP = '\\t'

/**
 * Read this process's tmux location through the bash seam, or `undefined` when
 * this process is not genuinely running inside a tmux pane or the query fails.
 *
 * `$TMUX_PANE` alone is insufficient: a terminal launched from a tmux shell
 * (e.g. VS Code's integrated terminal, a desktop launcher) inherits `$TMUX` and
 * `$TMUX_PANE` from that ancestor, so the variables are present even though this
 * process does not live in that pane. The command therefore also compares the
 * pane's `#{pane_tty}` against this process's own controlling terminal
 * (`ps -o tty=` for {@link processId}); a genuine pane owns this process's tty,
 * an inherited environment names some other pane's tty. Fields are emitted only
 * on a match, so an inherited environment reads as "not in tmux" and injects
 * nothing.
 *
 * The location is optional context, so an executor rejection is a failed query,
 * not a turn failure: `resolve()` may reject the command on policy grounds and
 * `run()` only promises to resolve for nonzero exits, timeouts, and aborts, so
 * both are contained and reported as a warning.
 *
 * @param bash - The executor service used to run the read-only tmux/ps commands.
 * @param logger - receives a warning when the executor rejects the query.
 * @param processId - this agent process's pid, whose controlling tty must match the pane.
 * @param signal - abort signal forwarded to the executor.
 * @returns the parsed location, or `undefined` when not in a real pane or on any failure.
 */
async function queryTmuxLocation(
  bash: ShellExecutor,
  logger: LoggerService,
  processId: number,
  signal: AbortSignal,
): Promise<TmuxLocation | undefined> {
  const format = TMUX_FIELDS.join(FIELD_SEP)
  const command = [
    '[ -n "$TMUX_PANE" ] || exit 1',
    `self_tty=$(ps -o tty= -p ${processId} | tr -d ' ')`,
    '[ -n "$self_tty" ] || exit 1',
    'pane_tty=$(tmux display-message -t "$TMUX_PANE" -p \'#{pane_tty}\') || exit 1',
    '[ "$pane_tty" = "/dev/$self_tty" ] || exit 1',
    `exec tmux display-message -t "$TMUX_PANE" -p '${format}'`,
  ].join('\n')
  let result: ShellRunResult
  try {
    result = await (await bash.execute(bash.resolve({ command, signal }))).result()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`tmux location query failed: ${message}; injecting no location this turn`)
    return undefined
  }
  if (result.exitCode !== 0) return undefined
  const line = result.stdout.text.split('\n', 1)[0] as string
  const parts = line.split(FIELD_SEP)
  if (parts.length !== TMUX_FIELDS.length) return undefined
  const [
    sessionName,
    windowIndex,
    windowName,
    paneIndex,
    paneId,
    windowActive,
    paneActive,
    windowLayout,
  ] = parts as [string, string, string, string, string, string, string, string]
  if (paneId.length === 0) return undefined
  return {
    sessionName,
    windowIndex,
    windowName,
    paneIndex,
    paneId,
    windowActive,
    paneActive,
    windowLayout,
  }
}

/**
 * Render the stable tmux state block: the part of a reading compared for
 * change suppression. It excludes the turn preamble so re-injection is driven
 * only by tmux state, not by loop position.
 */
function renderState(location: TmuxLocation): string {
  return `session ${location.sessionName}, `
    + `window ${location.windowIndex} ${JSON.stringify(location.windowName)}, `
    + `pane ${location.paneIndex} ${location.paneId}\n`
    + `window active=${location.windowActive}, pane active=${location.paneActive}, `
    + `layout ${location.windowLayout}`
}

/** Render the full durable reading, including the volatile turn preamble. */
function renderReading(location: TmuxLocation, turn: number): string {
  return `${READING_PREFIX}${turn}):\n${renderState(location)}`
}

/**
 * The stable state block of this plugin's latest durable injection, or
 * `undefined` when the session has none. Scans raw durable events so the
 * schedule survives compaction and resumed processes without process-local
 * cache state.
 */
/** Reject refresh intervals that cannot represent an exact elapsed-millisecond threshold. */
function validateRefreshInterval(refreshIntervalMs: number | undefined): void {
  if (refreshIntervalMs !== undefined && (
    !Number.isSafeInteger(refreshIntervalMs)
    || refreshIntervalMs < 0
  )) {
    throw new TypeError(
      `tmux-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}

const tmuxContextStateSchema = zod.object({
  state: zod.string(),
  time: zod.number(),
}).nullable()

type TmuxContextState = zod.infer<typeof tmuxContextStateSchema>

/**
 * Register a prepended pre-step listener for the lifetime of `ctx`.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - durable refresh scheduling configuration.
 * @throws when the refresh interval is invalid.
 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The stable state block of this plugin's latest durable injection, or null. */
    tmuxContext: TmuxContextState
  }
}

export function apply(ctx: Context, config: Config): void {
  const refreshIntervalMs = config.refreshIntervalMs
  validateRefreshInterval(refreshIntervalMs)

  ctx.sessionProjections.register({
    key: 'tmuxContext',
    stateVersion: 1,
    stateSchema: tmuxContextStateSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type !== 'user/message'
        || event.data.source.kind !== name) return state
      const [block] = event.data.content
      if (block?.type !== 'text') return state
      const newline = block.text.indexOf('\n')
      const stableState = newline === -1 ? '' : block.text.slice(newline + 1)
      return { state: stableState, time: event.time }
    },
  })

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    const bash = ctx.get('shell')
    if (bash === undefined) return decision
    const previous = ctx.sessionProjections.stateOf(agent.session, 'tmuxContext') as TmuxContextState
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0 && previous !== null) {
      const now = Date.now()
      if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision
    }
    const location = await queryTmuxLocation(bash, ctx.logger, process.pid, signal)
    if (location === undefined) return decision
    const state = renderState(location)
    if (previous !== null && previous.state === state) return decision
    const text = renderReading(location, turn)
    return {
      ...decision,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
        }),
        ...decision.messages,
      ],
    }
  }, { prepend: true })
}

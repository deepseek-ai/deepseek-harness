/**
 * Activity model: one {@link ImActivity} per (hosted session, turn), emitted as `im/activity`.
 *
 * Sources: `agent/assistant-stream` (`text-delta` / `reasoning-delta` chunks), `session/event` (`turn/start`,
 * `turn/end`, `tool/call`, `tool/result`), `agent/error` (failure text) and `agent/status` (idle safety net).
 * `agent/turn-stopping` is deliberately unused: it also fires for a turn a listener keeps alive by steering, while
 * `turn/end` is the exact settlement of the turn and carries why it ended (`completed` / `aborted` / `error` …).
 *
 * Scope: only sessions whose exact id is hosted by `ctx.im.sessions` — subagent sessions of a hosted session are
 * ignored here, and renderers see them through the session log instead.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ImActivity, ImActivityChange, ImMessage, ImSegment, ImSessionRecord } from './api.ts'

/**
 * Characters of one tool call's arguments and of its result kept in the activity: output renderers bound their own
 * previews below this, so a 300-tool turn costs a bounded amount of memory while keeping a detailed view possible.
 */
export const ACTIVITY_PREVIEW_CHARS = 2000

/** What the tracker reads back from the session host: hosted-record lookup and the trigger of a starting turn. */
export interface ImActivityDeps {
  /** Exact hosted record (non-hosted agents are ignored). */
  hosted(sessionId: SessionId): ImSessionRecord | undefined
  /** Trigger of the turn being started (the delivery's `trigger`), consumed once per turn. */
  trigger(sessionId: SessionId): ImMessage | undefined
}

/** One turn under construction; published snapshots are values, so segments are replaced instead of mutated. */
interface Turn {
  session: ImSessionRecord
  turn: number
  status: ImActivity['status']
  segments: ImSegment[]
  trigger: ImMessage | undefined
  error: string | undefined
  startedAt: number
  updatedAt: number
}

/**
 * Builds one {@link ImActivity} per turn of every hosted session and emits it as `im/activity` (start, then its
 * deltas and tool updates, then exactly one end), so output renderers can redraw a chat message while the turn runs.
 */
export class ImActivityTracker {
  /** Current (or last) turn per hosted session id. */
  private readonly turns = new Map<SessionId, Turn>()

  constructor(readonly ctx: Context, readonly deps: ImActivityDeps) {}

  /** Subscribe the agent events (listeners are disposed with `ctx`). */
  start(): void {
    const ctx = this.ctx
    ctx.on('session/event', (session, event) => { this.event(session, event) })
    ctx.on('agent/assistant-stream', ({ agent, frame }) => { this.frame(agent.session.id, frame) })
    ctx.on('agent/error', ({ agent, turn, error }) => { this.fail(agent, turn, error) })
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') this.idle(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.turns.delete(agent.session.id) })
  }

  /**
   * Current (or last) activity of a session.
   * @param sessionId - the hosted session.
   * @returns the latest snapshot of its turn, or undefined when no turn was tracked for it.
   */
  current(sessionId: SessionId): ImActivity | undefined {
    const turn = this.turns.get(sessionId)
    return turn === undefined ? undefined : snapshot(turn)
  }

  /**
   * Whether the session has a running turn (`/status`, `stop`).
   * @param sessionId - the hosted session.
   * @returns true while its tracked turn has not settled.
   */
  running(sessionId: SessionId): boolean {
    return this.turns.get(sessionId)?.status === 'running'
  }

  // -------------------------------------------------------------------------------------------------------------

  /** One session log event of a hosted session (turn boundaries and tool calls). */
  private event(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/start') {
      this.open(session.id, event.data.turn)
      return
    }
    if (event.type === 'turn/end') {
      this.settle(session.id, event.data.turn, event.data.reason)
      return
    }
    if (event.type === 'tool/call') {
      const turn = this.open(session.id, event.data.turn)
      if (turn === undefined) return
      turn.segments.push({
        kind: 'tool',
        callId: event.data.callId,
        name: event.data.name,
        args: preview(event.data.arguments),
        status: 'running',
      })
      this.emit(turn, 'tool')
      return
    }
    if (event.type !== 'tool/result') return
    const turn = this.open(session.id, event.data.turn)
    if (turn !== undefined) {
      this.result(turn, event.data.message.toolCallId, event.data.message.content, event.data.message.isError === true)
    }
  }

  /** One live assistant frame of a hosted session. */
  private frame(sessionId: SessionId, frame: AssistantStreamFrame): void {
    // Only `start` carries the turn; a `chunk` belongs to the turn the session already opened.
    if (frame.type === 'start') {
      this.open(sessionId, frame.turn)
      return
    }
    if (frame.type !== 'chunk') return
    const turn = this.turns.get(sessionId)
    if (turn === undefined) return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') this.append(turn, 'text', chunk.text)
    else if (chunk.type === 'reasoning-delta') this.append(turn, 'reasoning', chunk.text)
    // Other chunks (block boundaries, usage, finish) carry no segment text.
  }

  /** Accumulate one text or reasoning delta into the last segment of the same kind. */
  private append(turn: Turn, kind: 'text' | 'reasoning', delta: string): void {
    if (!delta) return
    const last = turn.segments.at(-1)
    if (last?.kind === kind) turn.segments[turn.segments.length - 1] = { kind, text: last.text + delta }
    else turn.segments.push({ kind, text: delta })
    this.emit(turn, 'delta')
  }

  /** Record the failure text of the turn that errored (its `turn/end` reason settles the status). */
  private fail(agent: Agent, turn: number, error: unknown): void {
    const current = this.turns.get(agent.session.id)
    if (current === undefined || current.turn !== turn) return
    current.error = error instanceof Error ? error.message : String(error)
  }

  /** Safety net: a hosted session went idle while its turn is still open (no `turn/end` recorded). */
  private idle(agent: Agent): void {
    const current = this.turns.get(agent.session.id)
    if (current?.status === 'running') this.finish(current, 'done')
  }

  /** Settle the turn with the reason its log recorded. */
  private settle(sessionId: SessionId, turn: number, reason: TurnEndReason): void {
    const current = this.turns.get(sessionId)
    if (current === undefined || current.turn !== turn) return
    if (reason.kind === 'error') current.error ??= reason.error.message
    this.finish(current, reason.kind === 'aborted' ? 'cancelled' : reason.kind === 'error' ? 'error' : 'done')
  }

  /** Settle the tool segment of one call. */
  private result(turn: Turn, callId: string, content: readonly ContentBlock[], isError: boolean): void {
    const index = turn.segments.findLastIndex(segment => segment.kind === 'tool' && segment.callId === callId)
    if (index < 0) return
    const segment = turn.segments[index] as Extract<ImSegment, { kind: 'tool' }>
    turn.segments[index] = { ...segment, status: isError ? 'error' : 'done', result: preview(textOf(content)) }
    this.emit(turn, 'tool')
  }

  /** The open turn of one hosted session, opening (and announcing) it when the log's turn is new. */
  private open(sessionId: SessionId, turn: number): Turn | undefined {
    const record = this.deps.hosted(sessionId)
    if (record === undefined) return undefined
    const known = this.turns.get(sessionId)
    if (known?.turn === turn) return known
    // A turn whose `turn/end` never reached us (restart, disposal) is closed as done before it is replaced.
    if (known !== undefined) this.finish(known, 'done')
    const now = Date.now()
    const opened: Turn = {
      session: record, turn, status: 'running', segments: [], trigger: this.deps.trigger(sessionId),
      error: undefined, startedAt: now, updatedAt: now,
    }
    this.turns.set(sessionId, opened)
    this.emit(opened, 'start')
    return opened
  }

  /** End one open turn with `status` and emit the closing change exactly once. */
  private finish(turn: Turn, status: ImActivity['status']): void {
    if (turn.status !== 'running') return
    turn.status = status
    this.emit(turn, 'end')
  }

  private emit(turn: Turn, change: ImActivityChange): void {
    turn.updatedAt = Date.now()
    this.ctx.emit('im/activity', snapshot(turn), change)
  }
}

/** Immutable view of one turn: segments are copied, and already published segments are never mutated. */
function snapshot(turn: Turn): ImActivity {
  return {
    session: turn.session,
    turn: turn.turn,
    status: turn.status,
    segments: [...turn.segments],
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    ...turn.trigger === undefined ? {} : { trigger: turn.trigger },
    ...turn.error === undefined ? {} : { error: turn.error },
  }
}

/** Bounded preview of one tool argument/result string. */
function preview(text: string): string {
  return text.length > ACTIVITY_PREVIEW_CHARS ? `${text.slice(0, ACTIVITY_PREVIEW_CHARS)}…` : text
}

/** The text blocks of one tool result message, joined for the segment preview. */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
}

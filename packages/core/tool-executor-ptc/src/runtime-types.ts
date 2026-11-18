/** Host PTC dispatch policy declarations with live Agent and tool execution types. @module */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ToolExecution, ToolsService } from '@deepseek-ai/dsh-tools'

/**
 * One settled `run_code` sub-dispatch about to be logged, as seen by the
 * `tools/ptc-dispatch-log` waterfall: the parent execution (session owner,
 * outer call identity), the sub-call identity, and the outcome whose durable
 * copy a listener may reshape. `content` is the RENDERED result projection
 * (what a native `tool/result` would carry) — the program itself received
 * the structured `value` (or just the error message on failure); only the
 * `tool/ptc-dispatch` event's copy changes.
 */
export interface PtcDispatchLog {
  /** The outer `run_code` execution. */
  readonly exec: ToolExecution
  /** The calling agent (the scope routing key and the spill owner), when the outer call has one. */
  readonly agent?: Agent
  /** Opaque sub-call id; new calls use `<parent>:ptc:<n>`. */
  readonly subCallId: ToolCallId
  /** The dispatched sub-tool name. */
  readonly name: string
  /** Whether the sub-call settled as an error. */
  readonly isError: boolean
  /** The sub-call's complete model-facing content (the settle event's default payload). */
  readonly content: ContentBlock[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Allow a listener to replace content in the DURABLE LOG COPY of one
     * `run_code` sub-dispatch outcome before the bridge appends its
     * `tool/ptc-dispatch` event. `next()` keeps the
     * content unchanged; a listener may return replacement blocks (e.g. the
     * spill policy's preview + locator for an oversized text result). Only the
     * logged copy is affected — the program already received the complete
     * value, and the model sees neither. A throwing listener is contained:
     * the bridge falls back to logging the original settled content.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's dispatches.
     * @param dispatch - the parent execution, sub-call identity, and the settled content to log.
     * @mode waterfall
     */
    'tools/ptc-dispatch-log'(this: Scoped<ToolsService>, dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
  }
}

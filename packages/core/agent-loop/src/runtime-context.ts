/**
 * Durable admission state for the dynamic runtime-context snapshot.
 * @module @deepseek-ai/dsh-agent-loop/runtime-context
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': { kind: 'runtime-context' } & ContextFormed
  }
}

const SOURCE = 'runtime-context'
const CLEARED = '<system-reminder>\nCurrent runtime context: none. Earlier runtime-context snapshots no longer apply.\n</system-reminder>'

function isOwned(message: UserMessage): boolean {
  return message.source.kind === SOURCE
}

/** Older runtime-context messages may omit the structured snapshot contributions. */
function sectionsOf(message: UserMessage): readonly ContextSnapshotSection[] | undefined {
  return message.source.kind === SOURCE && message.source.form === 'snapshot' ? message.source.sections : undefined
}

/** Committed events from the newest backward; the restore scans stop at the first match. */
function eventsNewestFirst(session: Session): readonly SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents().toReversed()
}

/** Tracks the last retained runtime-context snapshot without owning its commit. */
export class RuntimeContextProjection {
  /** `undefined` means no snapshot ever existed; `null` means none is retained. */
  private retained: { seq: SessionSeq; sections: readonly ContextSnapshotSection[] | undefined } | null | undefined

  /**
   * Restore projection state once, then follow authoritative session events.
   * @param ctx - agent-scoped event context.
   * @param session - session receiving projected messages.
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (const event of eventsNewestFirst(session)) {
      if (event.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, sections: sectionsOf(event.data) }
        break
      }
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, sections: sectionsOf(event.data) }
      } else if (this.retained
        && isReplacementSurfaceEvent(event)
        && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = null
      }
    })
  }

  /**
   * Create an uncommitted reminder only when the retained value differs.
   * The first snapshot omits supersession; later snapshots also override facts
   * retained in compaction summaries. Proposals do not advance committed state.
   * @param sections - named contributions that formed the current snapshot.
   * @returns a candidate user message, or `undefined` when no update is needed.
   */
  project(sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    const previous = this.retained?.sections
    if (this.retained === undefined && sections.length === 0) return
    if (previous !== undefined && deepEqualJson(previous, sections)) return
    const intro = this.retained === undefined
      ? 'The following information describes your current session:'
      : 'The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.'
    const body = sections.map(section => section.text).join('\n\n')
      .replace(/<\/system-reminder\s*>/gi, tag => `<\\${tag.slice(1)}`)
    const snapshot = sections.length === 0
      ? CLEARED
      : `<system-reminder>\n${intro}\n\n${body}\n</system-reminder>`
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      source: { kind: SOURCE, form: 'snapshot', sections },
    })
  }
}

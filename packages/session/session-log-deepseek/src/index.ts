/**
 * Incremental session-log contribution for official DeepSeek LLM API requests.
 * Accepted sequence watermarks live in the canonical log, so restart recovery
 * can conservatively resend uncertain tails without maintaining another store.
 * @module @deepseek-ai/dsh-session-log-deepseek
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { isSurfaceEvent, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeq as SessionSeqType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  DeepSeekSessionLogExtension,
  DeepSeekSessionLogWireEvent,
  DeepSeekSessionLogWireHeader,
} from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-log-deepseek'
/** Services required to resolve sessions and contribute the provider request field. */
export const inject = ['deepseekLlmApiExtensions', 'sessions']

/** Session-log request contribution configuration. */
export interface Config {
  /** Contribute `dsh_session_log` to official DeepSeek requests. Defaults to `false`. */
  enabled?: boolean
}

/** Validated Session-log request contribution configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

interface AcceptanceFold {
  readonly scannedEvents: SessionLogOffsetType
  readonly throughSeq: SessionSeqCursor
}

const acceptanceFolds = new WeakMap<Session, AcceptanceFold>()

/** Translate logical Session metadata back to the stable version-0 wire header. */
function wireHeader(session: Session): DeepSeekSessionLogWireHeader {
  const header = session.header
  return {
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) },
    ...header.isSeeded ? { seedLength: Number(session.inheritedEventCount) } : {},
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth },
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
  }
}

/** Translate compile-time sequence brands to raw numeric request fields. */
function wireEvent(event: SessionEvent): DeepSeekSessionLogWireEvent {
  const surfaceEvent = isSurfaceEvent(event) ? event : undefined
  const surfaceOp = surfaceEvent?.surfaceOp
  return {
    type: event.type,
    seq: Number(event.seq),
    time: event.time,
    data: event.data as JsonValue,
    ...event.ignorable === undefined ? {} : { ignorable: event.ignorable },
    ...surfaceEvent?.sourceEventSeqs === undefined
      ? {}
      : { sourceEventSeqs: surfaceEvent.sourceEventSeqs.map(Number) },
    ...surfaceOp === undefined
      ? {}
      : surfaceOp === 'append'
        ? { surfaceOp }
        : { surfaceOp: { op: 'replace' as const, start: Number(surfaceOp.start), end: Number(surfaceOp.end) } },
  }
}

/**
 * Highest confirmed sequence for this exact session identity.
 * @param session - canonical log whose matching acceptance events are folded.
 * @returns greatest accepted sequence, or `-1` before any accepted request.
 */
export function acceptedThrough(session: Session): SessionSeqCursor {
  const previous = acceptanceFolds.get(session)
  let throughSeq = previous?.throughSeq ?? -1
  const length = session.seq
  const start = previous?.scannedEvents ?? SessionLogOffset(0)
  for (let index = start; index < length; index++) {
    const event = session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(`session-log-deepseek: missing event ${String(index)} below captured length ${String(length)}`)
    }
    if (event.type !== 'session-log-deepseek/delivery-accepted') continue
    let acceptedSeq: SessionSeqType
    try {
      acceptedSeq = SessionSeq(event.data.throughSeq)
    } catch {
      throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`)
    }
    if (typeof event.data.sessionId !== 'string' || event.data.sessionId.length === 0
      || acceptedSeq >= event.seq) {
      throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`)
    }
    if (event.data.sessionId !== session.id) continue
    if (acceptedSeq > throughSeq) throughSeq = acceptedSeq
  }
  acceptanceFolds.set(session, { scannedEvents: length, throughSeq })
  return throughSeq
}

/**
 * Register the incremental `dsh_session_log` request contribution when enabled.
 * @param ctx - plugin context carrying Sessions and the DeepSeek request-extension registry.
 * @param config - validated opt-in configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled !== true) return
  ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
    prepare: (request) => {
      // TODO: Define an explicit wire result for direct or stale-session calls if they become a supported product path.
      if (request.sessionId === undefined) return undefined
      const session = ctx.sessions.get(brandString<SessionId>(request.sessionId))
      if (session === undefined) return undefined

      const afterSeq = acceptedThrough(session)
      const snapshot = session.snapshotEvents()
      const throughSeq = snapshot.at(-1)?.seq
      if (throughSeq === undefined) return undefined
      const suffix = session.snapshotEvents(SessionLogOffset(afterSeq + 1))
      const value: DeepSeekSessionLogExtension = {
        version: 1,
        session: wireHeader(session),
        afterSeq: Number(afterSeq),
        throughSeq: Number(throughSeq),
        events: suffix.map(wireEvent),
      }
      return {
        value,
        accept: () => {
          session.append('session-log-deepseek/delivery-accepted', { sessionId: session.id, throughSeq })
          // TODO: Add an immediate lightweight checkpoint if duplicate replay after a 2xx crash window becomes unacceptable.
        },
      }
    },
  })
}

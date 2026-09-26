/**
 * Incremental session-log contribution for official DeepSeek LLM API requests.
 * Accepted sequence watermarks live in the canonical log, so restart recovery
 * can conservatively resend uncertain tails without maintaining another store.
 * @module @deepseek-ai/dsh-session-log-deepseek
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { KNOWN_SESSION_EVENT_TYPES, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeq as SessionSeqType,
  SessionSeqCursor,
  SurfaceOp,
} from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  DeepSeekSessionLogExtension,
  DeepSeekSessionLogWireEvent,
  DeepSeekSessionLogWireHeader,
  DeepSeekSessionLogWireSurfaceOp,
} from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-log-deepseek'
/** Services required to resolve sessions and contribute the provider request field. */
export const inject = ['deepseekLlmApiExtensions', 'sessions']

/** Session-log request contribution configuration. */
export interface Config {
  /** Contribute `dsh_session_log` to official DeepSeek requests. Defaults to `true`. */
  enabled?: boolean
  /**
   * Largest serialized `dsh_session_log` field, in UTF-8 bytes, that one request carries.
   * A request uploads the longest pending event prefix that fits; later requests continue
   * after its acceptance. Defaults to 8 MiB.
   */
  maxBytes?: number
}

/** Validated Session-log request contribution configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024),
})

interface AcceptanceFold {
  readonly scannedEvents: SessionLogOffsetType
  readonly throughSeq: SessionSeqCursor
}

const acceptanceFolds = new WeakMap<Session, AcceptanceFold>()

/** Translate logical Session metadata to raw external request fields. */
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
  const common = {
    seq: Number(event.seq),
    time: event.time,
    data: event.data as JsonValue,
    ...event.ignorable === undefined ? {} : { ignorable: event.ignorable },
  }
  switch (event.type) {
    case 'developer/message':
    case 'system/message':
    case 'user/message':
    case 'tool/result':
      return {
        ...common,
        type: event.type,
        surfaceOp: wireSurfaceOp(event.surfaceOp),
        ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs.map(Number) },
      }
    case 'assistant/message':
      return { ...common, type: event.type, surfaceOp: wireSurfaceOp(event.surfaceOp) }
    default: {
      // Restored unknown ignorable records are opaque, not current surface events.
      if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) {
        const opaque = event as { surfaceOp?: JsonValue; sourceEventSeqs?: JsonValue }
        return {
          ...common, type: event.type, ignorable: true,
          ...opaque.surfaceOp === undefined ? {} : { surfaceOp: opaque.surfaceOp },
          ...opaque.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opaque.sourceEventSeqs },
        }
      }
      return { ...common, type: event.type }
    }
  }
}

function wireSurfaceOp(op: SurfaceOp): DeepSeekSessionLogWireSurfaceOp {
  return op === 'append'
    ? op
    : { op: 'replace', startSeq: Number(op.startSeq), endSeq: Number(op.endSeq) }
}

/**
 * UTF-8 length of one value's JSON text as the request body encodes it.
 * @returns `Infinity` when the value fails to serialize, which counts as exceeding every limit.
 */
function jsonBytes(value: DeepSeekSessionLogExtension | DeepSeekSessionLogWireEvent): number {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch (_unserializable) {
    // No request can carry a value that fails to serialize.
    return Number.POSITIVE_INFINITY
  }
  return Buffer.byteLength(text)
}

/**
 * Highest confirmed sequence for this exact Session format generation.
 * @param session - canonical log whose matching acceptance events are folded.
 * @returns greatest accepted sequence, or `-1` before any accepted request.
 */
export function acceptedThrough(session: Session): SessionSeqCursor {
  const previous = acceptanceFolds.get(session)
  let throughSeq = previous?.throughSeq ?? -1
  const length = session.seq
  const start = previous?.scannedEvents ?? SessionLogOffset(0)
  for (let index = start; index < length; index++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(`session-log-deepseek: missing event ${String(index)} below captured length ${String(length)}`)
    }
    if (event.type !== 'session-log-deepseek/delivery-accepted') continue
    const acceptedFormatVersion = event.data.sessionFormatVersion ?? 0
    if (!Number.isSafeInteger(acceptedFormatVersion)
      || acceptedFormatVersion < 0
      || Object.is(acceptedFormatVersion, -0)) {
      throw new Error(`session-log-deepseek: malformed acceptance format version at seq ${event.seq}`)
    }
    if (acceptedFormatVersion !== session.header.version) continue
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
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled !== true) return
  // Schemastery validates and fills the defaults before `apply` runs.
  const { maxBytes } = config as Required<Config>
  ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
    prepare: (request) => {
      // TODO: Define an explicit wire result for direct or stale-session calls if they become a supported product path.
      if (request.sessionId === undefined) return undefined
      const session = ctx.sessions.get(brandString<SessionId>(request.sessionId))
      if (session === undefined) return undefined

      const afterSeq = acceptedThrough(session)
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const pending = session.snapshotEvents(SessionLogOffset(afterSeq + 1))
      const envelope = {
        version: 1,
        sessionFormatVersion: session.header.version,
        session: wireHeader(session),
        afterSeq: Number(afterSeq),
      } as const
      // Field bytes without events or throughSeq digits; each candidate prefix adds its own.
      let bytes = jsonBytes({ ...envelope, throughSeq: 0, events: [] }) - 1
      const events: DeepSeekSessionLogWireEvent[] = []
      // Field bytes with the last examined event; when none fits, the first event's own field size.
      let candidateBytes = 0
      for (const event of pending) {
        const wire = wireEvent(event)
        const next = bytes + (events.length === 0 ? 0 : 1) + jsonBytes(wire)
        candidateBytes = next + String(event.seq).length
        if (candidateBytes > maxBytes) break
        bytes = next
        events.push(wire)
      }
      const last = events.length === 0 ? undefined : pending[events.length - 1]
      if (last === undefined) {
        const first = pending[0]
        if (first !== undefined) {
          const seq = String(first.seq)
          ctx.logger.warn(Number.isFinite(candidateBytes)
            ? `session-log-deepseek: event ${seq} of session "${session.id}" needs a ${String(candidateBytes)}-byte`
              + ` dsh_session_log field, above maxBytes ${String(maxBytes)}; this session's upload stays at event ${seq}`
              + ' until maxBytes admits it'
            : `session-log-deepseek: event ${seq} of session "${session.id}" is too large to serialize into a dsh_session_log field;`
              + ` this session's upload stays at event ${seq}`)
        }
        return undefined
      }
      const throughSeq = last.seq
      const value: DeepSeekSessionLogExtension = { ...envelope, throughSeq: Number(throughSeq), events }
      return {
        value,
        accept: () => {
          session.append('session-log-deepseek/delivery-accepted', {
            sessionId: session.id,
            sessionFormatVersion: session.header.version,
            throughSeq,
          })
          // TODO: Add an immediate lightweight checkpoint if duplicate replay after a 2xx crash window becomes unacceptable.
        },
      }
    },
  })
}

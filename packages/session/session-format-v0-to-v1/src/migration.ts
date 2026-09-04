import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  defineSessionFormatMigration,
  sessionFormatCount,
  snapshotSessionFormatArtifact,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedEventPayload,
  assertNormalizedReleasedV0Artifact,
  assertReleasedV0SourceArtifact,
  assertReleasedV1Artifact,
  assertReleasedV1Header,
} from './validation.ts'
import { assertReleasedV0Keys, releasedV0Record } from './validation-helpers.ts'

/** Identity format edge that promotes released v0 into released v1. */
export const sessionFormatV0ToV1 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v0-to-v1',
  fromVersion: 0,
  toVersion: 1,
  migrateHeader(header) {
    assertHeaderVersion(header, 0)
    return { ...header, version: 1 }
  },
  migrate(source) {
    assertReleasedV0SourceArtifact(source)
    const events = normalizeReleasedV0Events(source.events, source.header.id)
    assertNormalizedReleasedV0Artifact({ ...source, events })
    const target = snapshotSessionFormatArtifact({
      header: { ...source.header, version: 1 },
      inheritedEventCount: source.inheritedEventCount,
      events,
    }, 'released v0-to-v1 target')
    assertReleasedV1Artifact(target)
    return target
  },
  validateTarget: assertReleasedV1Artifact,
  validateTargetHeader: assertReleasedV1Header,
})

function assertHeaderVersion(header: SessionFormatHeader, version: 0 | 1): void {
  if (header.version !== version) throw new SessionFormatError(`expected format v${version} header`)
}

function normalizeReleasedV0Events(
  events: readonly SessionFormatEvent[],
  sessionId: string,
): readonly SessionFormatEvent[] {
  const messageIds = new Map<number, string>()
  const output: SessionFormatEvent[] = []
  for (const event of events) {
    assertSupportedLegacyType(event, sessionId)
    const start = normalizeLegacyTurnStart(event, sessionId)
    const end = normalizeLegacyTurnEnd(start, sessionId)
    const header = normalizeLegacyRequestHeader(end, sessionId)
    const steering = normalizeLegacySteering(header, sessionId)
    const message = normalizeLegacyMessage(steering, sessionId, messageIds)
    assertReleasedEventPayload(message, 0)
    output.push(message)
    const messageId = eventMessageId(message)
    if (messageId !== undefined) messageIds.set(message.seq, messageId)
  }
  return Object.freeze(output)
}

function normalizeLegacyRequestHeader(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'request/header') return event
  const data = releasedV0Record(event.data, `request/header ${event.seq} data`)
  const header = releasedV0Record(data['header'], `request/header ${event.seq} header`)
  if (!Object.hasOwn(header, 'messagePrefix')) return event
  if (!Array.isArray(header['messagePrefix'])) {
    throw new SessionFormatError(
      `session ${JSON.stringify(sessionId)} contains malformed request/header messagePrefix at seq ${event.seq}`,
    )
  }
  const { messagePrefix: _messagePrefix, ...currentHeader } = header
  return { ...event, data: { ...data, header: currentHeader } }
}

function assertSupportedLegacyType(event: SessionFormatEvent, sessionId: string): void {
  if (event.type === 'request/header-delta' || event.type === 'mode/set') {
    throw new SessionFormatUnsupportedMigrationError(
      `session ${JSON.stringify(sessionId)} contains unsupported legacy ${event.type} event at seq ${event.seq}`,
    )
  }
  if (event.type === 'request/header') {
    const data = releasedV0Record(event.data, `request/header ${event.seq} data`)
    if (data['reason'] === 'fallback') {
      throw new SessionFormatUnsupportedMigrationError(
        `session ${JSON.stringify(sessionId)} contains unsupported request/header reason "fallback" at seq ${event.seq}`,
      )
    }
  }
}

function normalizeLegacySteering(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'steering/message') return event
  const data = releasedV0Record(event.data, `steering/message ${event.seq} data`)
  const wrapped = data['message']
  if (wrapped !== undefined) {
    assertReleasedV0Keys(data, ['turn', 'message'], [], `steering/message ${event.seq} data`)
    sessionFormatCount(data['turn'], `steering/message ${event.seq} turn`)
    return { ...event, type: 'user/message', data: wrapped }
  }
  assertReleasedV0Keys(data, ['turn', 'content', 'source'], [], `steering/message ${event.seq} data`)
  sessionFormatCount(data['turn'], `steering/message ${event.seq} turn`)
  const { turn: _turn, ...message } = data
  return {
    ...event,
    type: 'user/message',
    data: {
      ...message,
      id: legacyMessageId(sessionId, event.seq),
      role: 'user',
    },
  }
}

function normalizeLegacyTurnStart(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'turn/start') return event
  const data = releasedV0Record(event.data, `turn/start ${event.seq} data`)
  if (!Object.hasOwn(data, 'trigger')) return event
  assertReleasedV0Keys(data, ['turn', 'trigger'], [], `turn/start ${event.seq} data`)
  const turn = sessionFormatCount(data['turn'], `turn/start ${event.seq} turn`)
  const trigger = releasedV0Record(data['trigger'], `turn/start ${event.seq} trigger`)
  if (turn < 1 || typeof trigger['kind'] !== 'string' || trigger['kind'].length === 0) {
    throw malformedLegacy(sessionId, 'turn/start', event.seq)
  }
  return { ...event, data: { turn } }
}

function normalizeLegacyTurnEnd(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'turn/end') return event
  const data = releasedV0Record(event.data, `turn/end ${event.seq} data`)
  assertReleasedV0Keys(data, ['turn', 'reason'], [], `turn/end ${event.seq} data`)
  const turn = sessionFormatCount(data['turn'], `turn/end ${event.seq} turn`)
  if (turn < 1) throw malformedLegacy(sessionId, 'turn/end', event.seq)
  const reason = releasedV0Record(data['reason'], `turn/end ${event.seq} reason`)
  if (typeof reason['kind'] !== 'string') throw malformedLegacy(sessionId, 'turn/end', event.seq)

  let current: SessionFormatJsonObject
  switch (reason['kind']) {
    case 'completed':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      assertReleasedV0Keys(reason, ['kind'], [], `turn/end ${event.seq} reason`)
      return event
    case 'aborted':
      if (Object.hasOwn(reason, 'reason')) return event
      assertReleasedV0Keys(reason, ['kind'], [], `turn/end ${event.seq} reason`)
      current = { kind: 'aborted', reason: { kind: 'legacy' } }
      break
    case 'disposed':
      assertReleasedV0Keys(reason, ['kind'], [], `turn/end ${event.seq} reason`)
      current = { kind: 'aborted', reason: { kind: 'disposed' } }
      break
    case 'error':
      if (Object.hasOwn(reason, 'error')) return event
      current = normalizeLegacyErrorReason(reason, event.seq, sessionId)
      break
    default:
      return event
  }
  return { ...event, data: { ...data, reason: current } }
}

function normalizeLegacyErrorReason(
  reason: Record<string, SessionFormatJsonValue>,
  seq: number,
  sessionId: string,
): SessionFormatJsonObject {
  sessionFormatCount(reason['step'], `turn/end ${seq} error step`)
  const failure = reason['failure']
  if (failure !== undefined) {
    assertReleasedV0Keys(reason, ['kind', 'step', 'failure'], [], `turn/end ${seq} reason`)
    const record = releasedV0Record(failure, `turn/end ${seq} failure`)
    assertReleasedV0Keys(
      record,
      ['message', 'code'],
      ['status', 'providerRetryAfterMs', 'requestId'],
      `turn/end ${seq} failure`,
    )
    if (typeof record['message'] !== 'string' || typeof record['code'] !== 'string') {
      throw malformedLegacy(sessionId, 'turn/end', seq)
    }
    return { kind: 'error', error: record }
  }
  assertReleasedV0Keys(reason, ['kind', 'step', 'message'], ['code'], `turn/end ${seq} reason`)
  if (typeof reason['message'] !== 'string'
    || (reason['code'] !== undefined && typeof reason['code'] !== 'string')) {
    throw malformedLegacy(sessionId, 'turn/end', seq)
  }
  return {
    kind: 'error',
    error: {
      message: reason['message'],
      code: typeof reason['code'] === 'string' ? reason['code'] : 'UNKNOWN',
    },
  }
}

function normalizeLegacyMessage(
  event: SessionFormatEvent,
  sessionId: string,
  messageIds: ReadonlyMap<number, string>,
): SessionFormatEvent {
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  switch (event.type) {
    case 'user/message':
      if (Object.hasOwn(data, 'id') || Object.hasOwn(data, 'role')
        || Object.hasOwn(data, 'message') || !Object.hasOwn(data, 'content')
        || !Object.hasOwn(data, 'source')) return event
      return {
        ...event,
        data: {
          ...data,
          id: legacyMessageId(sessionId, event.seq),
          role: 'user',
        },
      }
    case 'assistant/message': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, 'provenance')) return event
      const { content, provenance, ...eventData } = data as typeof data & {
        content: SessionFormatJsonValue
        provenance: SessionFormatJsonValue
      }
      const source = releasedV0Record(provenance, `assistant/message ${event.seq} provenance`)
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: legacyMessageId(sessionId, event.seq),
            role: 'assistant',
            content,
            source: { ...source, kind: 'model' },
          },
        },
      }
    }
    case 'tool/result': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'callId') || !Object.hasOwn(data, 'content')
        || !Object.hasOwn(data, 'isError')) return event
      const { callId, content, isError, ...eventData } = data
      if (typeof callId !== 'string' || typeof isError !== 'boolean' || content === undefined) return event
      const inheritedId = replacementStart(event)
      const messageId = inheritedId === undefined
        ? legacyMessageId(sessionId, event.seq)
        : messageIds.get(inheritedId)
      if (messageId === undefined) {
        throw new SessionFormatError(`tool/result ${event.seq} replacement cites a message without identity`)
      }
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: messageId,
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
            source: { kind: 'tool', callId },
          },
        },
      }
    }
    default:
      return event
  }
}

function replacementStart(event: SessionFormatEvent): number | undefined {
  const operation = event['surfaceOp']
  if (operation === undefined || !releasedIsRecord(operation) || operation['op'] !== 'replace') return undefined
  // Source envelope validation admits only non-negative safe replacement endpoints.
  return operation['start'] as number
}

function eventMessageId(event: SessionFormatEvent): string | undefined {
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  const message = event.type === 'user/message'
    ? data
    : releasedIsRecord(data['message']) ? data['message'] : undefined
  return typeof message?.['id'] === 'string' ? message['id'] : undefined
}

function releasedIsRecord(value: unknown): value is Record<string, SessionFormatJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyMessageId(sessionId: string, seq: number): string {
  return `legacy-message:${sessionId}:${seq}`
}

function malformedLegacy(sessionId: string, type: string, seq: number): SessionFormatError {
  return new SessionFormatError(
    `session ${JSON.stringify(sessionId)} contains malformed pre-react-loop ${type} at seq ${seq}`,
  )
}

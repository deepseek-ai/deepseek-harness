/** Audited V2 migration admission and V3 payload validation, independent of installed core Session types. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount, sessionFormatSafeInteger } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { assertReleasedPayloadSemantics, assertReleasedSurfaceMetadata } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { RELEASED_V2_EVENT_DISPOSITIONS } from '@deepseek-ai/dsh-session-format-v1-to-v2'

/** Audited surface event names; all other admitted events are log-only. */
export const SURFACE_TYPES: ReadonlySet<string> = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
const SOURCE_KINDS = new Set(['user', 'plugin', 'model', 'tool', 'agent-instructions', 'session-reference', 'team-message', 'goal', 'skill-invocation', 'skill-catalog', 'coordinator', 'subagent-report', 'subagent-settled', 'webhook', 'agent-message'])

/**
 * Require a JSON object at the durable input boundary.
 * @param value - decoded value.
 * @param label - diagnostic subject.
 * @returns the narrowed object.
 */
export function record(value: SessionFormatJsonValue | undefined, label: string): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError(label + ' must be an object')
  return value
}

/**
 * Reject missing and unaudited members rather than guessing whether they contain coordinates.
 * @param value - decoded record.
 * @param required - required member names.
 * @param optional - additional admitted names.
 * @param label - diagnostic subject.
 */
export function keys(value: SessionFormatJsonObject, required: readonly string[], optional: readonly string[], label: string): void {
  const missing = required.find(key => !Object.hasOwn(value, key))
  const unexpected = Object.keys(value).find(key => !required.includes(key) && !optional.includes(key))
  if (missing !== undefined) throw new SessionFormatError(label + ' lacks required field ' + missing)
  if (unexpected !== undefined) throw new SessionFormatError(label + ' has unexpected field ' + unexpected)
}

/**
 * Validate classified payloads before migration, or native V3 system/header payloads.
 * @param event - decoded logical event.
 * @param version - source or target generation.
 */
export function assertEvent(event: SessionFormatEvent, version: 2 | 3): void {
  if (version === 3) {
    assertV3Event(event)
    return
  }
  const disposition = RELEASED_V2_EVENT_DISPOSITIONS[event.type]
  const feedback = event.type === 'feedback/message-put' || event.type === 'feedback/message-delete'
  if (disposition === undefined && !feedback) {
    throw new SessionFormatUnsupportedMigrationError('format v2 to v3 cannot safely transform unclassified event ' + event.type)
  }
  const surface = SURFACE_TYPES.has(event.type)
  keys(event, ['type', 'seq', 'time', 'data'], surface ? ['ignorable', 'sourceEventSeqs', 'surfaceOp'] : ['ignorable'], event.type)
  sessionFormatCount(event.seq, 'event seq')
  sessionFormatSafeInteger(event.time, 'event time')
  if (event['ignorable'] !== undefined && event['ignorable'] !== true) throw new SessionFormatError('ignorable must be true')
  if (surface) {
    assertReleasedSurfaceMetadata(event, event.seq, event.type, 'forbid-assistant')
    if (event['surfaceOp'] === undefined) throw new SessionFormatError(event.type + ' requires surfaceOp')
  }
  const data = record(event.data, event.type + ' data')
  if (feedback) {
    assertFeedback(event.type, data)
    return
  }
  // Non-inventory feedback events have returned above.
  const admitted = disposition as NonNullable<typeof disposition>
  keys(data, admitted.required, admitted.optional, event.type + ' data')
  assertOwnedContent(event, data)
  // Assistant attempts are introduced by V2; the V0 helper has no case for them.
  if (event.type !== 'assistant/attempt') assertReleasedPayloadSemantics(event, version)
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    for (const coordinate of ['turn', 'step']) {
      if (sessionFormatCount(data[coordinate], coordinate) === 0) throw new SessionFormatError(coordinate + ' must be positive')
    }
  }
  if (event.type === 'session/end-seed' && data['inherited'] !== undefined && data['inherited'] !== true) {
    throw new SessionFormatError('session/end-seed inherited must be true')
  }
  // Source classification applies only to Harness messages, not team delivery envelopes.
  if (event.type === 'user/message') assertSource(data)
  if (event.type === 'assistant/message' || event.type === 'tool/result') assertSource(record(data['message'], 'message'))
  if (event.type === 'tool/result' && isSessionFormatJsonObject(data['error']) && data['error']['code'] === 'TOOL_NOT_STARTED') {
    const message = record(data['message'], 'tool result message')
    const source = record(message['source'], 'tool result source')
    if (!isRepairIdentity(message['id'], source['callId'])) {
      throw new SessionFormatError('TOOL_NOT_STARTED repair requires its canonical historical message id')
    }
  }
  if (event.type === 'agent/inbox/spliced' || event.type === 'session/title-llm-request') {
    const messages = data[event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages']
    for (const message of messages as readonly SessionFormatJsonObject[]) assertSource(message)
  }
}

/**
 * Recognize stable generated repair IDs without interpreting their historical suffix as a current coordinate.
 * @param id - durable message identity.
 * @param callId - advertised tool identity.
 * @returns whether the identity has the canonical historical repair form.
 */
export function isRepairIdentity(id: SessionFormatJsonValue | undefined, callId: SessionFormatJsonValue | undefined): callId is string {
  if (typeof callId !== 'string') return false
  const prefix = 'interrupted-tool-result-' + callId + '-'
  if (typeof id !== 'string' || !id.startsWith(prefix)) return false
  const suffix = id.slice(prefix.length)
  return /^(0|[1-9]\d*)$/.test(suffix) && Number.isSafeInteger(Number(suffix))
}

function assertSource(message: SessionFormatJsonObject): void {
  const source = record(message['source'], 'message source')
  if (typeof source['kind'] !== 'string' || !SOURCE_KINDS.has(source['kind'])) {
    throw new SessionFormatUnsupportedMigrationError('cannot safely transform unclassified message source')
  }
  if (source['kind'] === 'agent-message') {
    keys(source, ['kind', 'form', 'senderSessionId'], [], 'agent-message source')
    if (source['form'] !== 'relay' || typeof source['senderSessionId'] !== 'string' || source['senderSessionId'].length === 0) {
      throw new SessionFormatError('agent-message source requires relay form and senderSessionId')
    }
  }
}

const CONTENT_KINDS = new Set(['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-result'])

function contentArray(value: SessionFormatJsonValue | undefined, label: string): readonly SessionFormatJsonValue[] {
  if (!Array.isArray(value)) throw new SessionFormatError(label + ': content must be an array')
  return value as readonly SessionFormatJsonValue[]
}

function assertOwnedContent(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
  const label = 'format v2 ' + event.type + ' at seq ' + String(event.seq) + ' data'
  switch (event.type) {
    case 'user/message':
    case 'tool/code-dispatch':
      assertContentKinds(data['content'], label + '.content')
      break
    case 'assistant/message':
    case 'tool/result':
    case 'team/message/queued':
      assertContentKinds(record(data['message'], label + '.message')['content'], label + '.message.content')
      break
    case 'agent/inbox/spliced':
    case 'session/title-llm-request': {
      const field = event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
      for (const [index, value] of contentArray(data[field], label + '.' + field).entries()) {
        const path = label + '.' + field + '[' + String(index) + ']'
        assertContentKinds(record(value, path)['content'], path + '.content')
      }
      break
    }
    case 'compaction/summary':
      assertContentKinds(data['summary'], label + '.summary')
      if (data['rawOutput'] !== undefined) assertContentKinds(data['rawOutput'], label + '.rawOutput')
      break
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    for (const [index, value] of contentArray(data['stream'], label + '.stream').entries()) {
      const path = label + '.stream[' + String(index) + ']'
      const entry = record(value, path)
      // Only raw chunks carry blocks; packed deltas and other chunk payloads remain opaque.
      if (entry['type'] !== 'chunk') continue
      const chunk = record(entry['chunk'], path + '.chunk')
      if (chunk['type'] === 'block-end') assertContentBlock(chunk['block'], path + '.chunk.block')
      if (chunk['type'] === 'block-start') assertContentKind(chunk['blockType'], path + '.chunk.blockType')
    }
  }
}

function assertContentKind(kind: SessionFormatJsonValue | undefined, label: string): void {
  if (typeof kind !== 'string' || !CONTENT_KINDS.has(kind)) {
    throw new SessionFormatUnsupportedMigrationError(label + ': cannot safely transform unclassified message content kind ' + JSON.stringify(kind))
  }
}

function assertContentKinds(content: SessionFormatJsonValue | undefined, label: string): void {
  for (const [index, value] of contentArray(content, label).entries()) assertContentBlock(value, label + '[' + String(index) + ']')
}

function assertContentBlock(value: SessionFormatJsonValue | undefined, label: string): void {
  const block = record(value, label)
  assertContentKind(block['type'], label)
  if (block['type'] === 'tool-result') {
    if (!Array.isArray(block['content'])) throw new SessionFormatError(label + '.content: invalid message content kind "tool-result": content must be an array')
    assertContentKinds(block['content'], label + '.content')
  }
  if (block['type'] === 'file') {
    keys(block, ['type', 'attachment'], [], label + ' kind "file"')
    const attachment = record(block['attachment'], label + ' kind "file" attachment')
    keys(attachment, ['attachmentId', 'name', 'bytes'], [], label + ' kind "file" attachment')
    if (typeof attachment['attachmentId'] !== 'string' || attachment['attachmentId'].length === 0
      || typeof attachment['name'] !== 'string') throw new SessionFormatError(label + ' kind "file": file attachment requires attachmentId and name')
    sessionFormatCount(attachment['bytes'], label + ' kind "file" attachment bytes')
    return
  }
  // Reuse frozen field rules without recursively revisiting tool-result children or interpreting opaque JSON.
  const leaf = block['type'] === 'tool-result' ? { ...block, content: [] } : block
  const probe: SessionFormatEvent = { type: 'user/message', seq: 0, time: 0, data: {
    id: 'content-admission', role: 'user', source: { kind: 'user' }, content: [leaf],
  } }
  try {
    assertReleasedPayloadSemantics(probe, 2)
  } catch (error) {
    // Frozen payload failures need the original event and content path, not the synthetic message.
    throw new SessionFormatError(label + ': invalid message content kind ' + JSON.stringify(block['type']) + ': ' + String(error))
  }
}

/**
 * Reject V3 structural payload violations even beyond a recoverable physical-row failure.
 * @param value - raw physical row; ordinary rows retain the frozen decoder's recovery policy.
 */
export function assertV3StructuralRow(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  const row = value as SessionFormatJsonObject
  if (row['type'] === 'request/header') {
    const data = record(row['data'], 'request/header data')
    if (Object.hasOwn(record(data['header'], 'request header'), 'system')) {
      throw new SessionFormatUnsupportedMigrationError('format v3 request/header rejects retired header.system')
    }
  } else if (row['type'] === 'system/message') {
    const data = record(row['data'], 'system/message data')
    assertSystem({ type: 'system/message', seq: 0, time: 0, data }, data)
  }
}

function assertSystem(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
  keys(data, ['turn', 'step', 'message'], [], 'system/message data')
  for (const coordinate of ['turn', 'step']) {
    if (sessionFormatCount(data[coordinate], coordinate) === 0) throw new SessionFormatError(coordinate + ' must be positive')
  }
  const message = record(data['message'], 'system message')
  keys(message, ['id', 'role', 'source', 'content'], [], 'system message')
  if (typeof message['id'] !== 'string' || message['id'].length === 0 || message['role'] !== 'system') {
    throw new SessionFormatError('system message requires an id and system role')
  }
  const source = record(message['source'], 'system source')
  if (source['kind'] !== 'plugin' || typeof source['plugin'] !== 'string' || source['plugin'].length === 0) {
    throw new SessionFormatError('system message requires plugin source')
  }
  assertReleasedPayloadSemantics({ ...event, type: 'user/message', data: { ...message, role: 'user' } }, 3)
}

function assertFeedback(type: string, data: SessionFormatJsonObject): void {
  keys(data, type === 'feedback/message-put' ? ['sessionId', 'item'] : ['sessionId', 'messageId'], [], type)
  if (typeof data['sessionId'] !== 'string') throw new SessionFormatError('feedback sessionId must be a string')
  if (type === 'feedback/message-delete') {
    if (typeof data['messageId'] !== 'string') throw new SessionFormatError('feedback messageId must be a string')
    return
  }
  const item = record(data['item'], 'feedback item')
  keys(item, ['messageId', 'rating', 'version', 'createdAt', 'updatedAt'], ['note'], 'feedback item')
  for (const key of ['messageId', 'version']) if (typeof item[key] !== 'string') throw new SessionFormatError('feedback ' + key + ' must be a string')
  if (item['rating'] !== 'positive' && item['rating'] !== 'negative') throw new SessionFormatError('invalid feedback rating')
  if (item['note'] !== undefined && typeof item['note'] !== 'string') throw new SessionFormatError('feedback note must be a string')
  sessionFormatCount(item['createdAt'], 'feedback createdAt')
  sessionFormatCount(item['updatedAt'], 'feedback updatedAt')
}

/**
 * Validate one canonical V3 event without interpreting plugin-owned payloads or log relationships.
 * Unclassified metadata is deferred to vocabulary-aware restoration; unknown required types must not become recoverable corruption.
 * @param event - decoded logical event.
 * @param knownEventTypes - additional installed event types whose envelopes are interpreted.
 */
export function assertV3Event(event: SessionFormatEvent, knownEventTypes?: ReadonlySet<string>): void {
  const value = record(event, 'format v3 event')
  const subject = `format v3 ${event.type} at seq ${event.seq}`
  const obsolete = event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch'
  const known = !obsolete && (SURFACE_TYPES.has(event.type)
    || RELEASED_V2_EVENT_DISPOSITIONS[event.type] !== undefined
    || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
    || event.type === 'feedback/message-put' || event.type === 'feedback/message-delete'
    || knownEventTypes?.has(event.type) === true)
  const opaque = !known
  keys(value, ['type', 'seq', 'time', 'data'],
    SURFACE_TYPES.has(event.type) || opaque ? ['ignorable', 'surfaceOp', 'sourceEventSeqs'] : ['ignorable'], subject)
  if (typeof event.type !== 'string') throw new SessionFormatError(`${subject} type must be a string`)
  sessionFormatCount(event.seq, `${subject} seq`)
  sessionFormatSafeInteger(event.time, `${subject} time`)
  if (Object.hasOwn(value, 'ignorable') && value['ignorable'] !== true) {
    throw new SessionFormatError(`${subject} ignorable must be true when present`)
  }
  if (SURFACE_TYPES.has(event.type)) {
    const operation = value['surfaceOp']
    if (operation === undefined) throw new SessionFormatError(`${subject} requires a surfaceOp marker`)
    if (operation !== 'append') {
      const replace = record(operation, `${subject} surfaceOp`)
      if (Object.keys(replace).length !== 3 || replace['op'] !== 'replace'
        || !Object.hasOwn(replace, 'startSeq') || !Object.hasOwn(replace, 'endSeq')) {
        throw new SessionFormatError(`${subject} requires exact replace fields op/startSeq/endSeq`)
      }
      for (const key of ['startSeq', 'endSeq']) {
        if (sessionFormatCount(replace[key], `${subject} surfaceOp ${key}`) >= event.seq) {
          throw new SessionFormatError(`${subject} replacement endpoints must reference earlier events`)
        }
      }
    }
    const sources = value['sourceEventSeqs']
    if (event.type === 'assistant/message' && sources !== undefined) {
      throw new SessionFormatError(`${subject} embeds its stream and cannot carry sourceEventSeqs`)
    }
    if (sources !== undefined) {
      if (!Array.isArray(sources) || sources.length === 0) {
        throw new SessionFormatError(`${subject} sourceEventSeqs must be a non-empty array`)
      }
      const seen = new Set<number>()
      for (const source of sources) {
        const seq = sessionFormatCount(source, `${subject} sourceEventSeqs member`)
        if (seq >= event.seq || seen.has(seq)) throw new SessionFormatError(`${subject} sourceEventSeqs must be unique earlier seqs`)
        seen.add(seq)
      }
    }
  }
  assertV3StructuralRow(event)
  assertCanonicalPayload(event)
}

function assertCanonicalPayload(event: SessionFormatEvent): void {
  const subject = `format v3 ${event.type} at seq ${event.seq}`
  if (event.type === 'request/header') {
    const data = record(event.data, `${subject} data`)
    const header = record(data['header'], `${subject} header`)
    if (Array.isArray(header['tools']) && header['tools'].length === 0
      || isSessionFormatJsonObject(header['adapterDefaults']) && Object.keys(header['adapterDefaults']).length === 0) {
      throw new SessionFormatError(`${subject} empty optional header fields must be omitted`)
    }
  }
  if (event.type !== 'tool/result') return
  const data = record(event.data, `${subject} data`)
  if (data['error'] === undefined) return
  const message = record(data['message'], `${subject} message`)
  const content = message['content']
  if (!Array.isArray(content) || content.length !== 1 || !isSessionFormatJsonObject(content[0])
    || content[0]['type'] !== 'tool-result' || content[0]['isError'] !== true) {
    throw new SessionFormatError(`${subject} carries error metadata for a non-error tool result`)
  }
}

/**
 * Canonicalize structurally transformed events without changing their target coordinates.
 * @param event - transformed event using released replacement names and target coordinates.
 * @returns a V3 event sharing all unchanged payloads and reference values.
 */
export function canonicalizeTransformedEvent(event: SessionFormatEvent): SessionFormatEvent {
  let target = event
  const operation = event['surfaceOp']
  if (operation !== undefined && operation !== 'append') {
    const replace = record(operation, `format v2 ${event.type} at seq ${event.seq} surfaceOp`)
    if (Object.keys(replace).length !== 3 || replace['op'] !== 'replace'
      || !Object.hasOwn(replace, 'start') || !Object.hasOwn(replace, 'end')) {
      throw new SessionFormatError(`format v2 ${event.type} at seq ${event.seq} requires exact replace fields op/start/end`)
    }
    target = { ...event, surfaceOp: {
      op: 'replace',
      startSeq: sessionFormatCount(replace['start'], `format v2 ${event.type} at seq ${event.seq} replace start`),
      endSeq: sessionFormatCount(replace['end'], `format v2 ${event.type} at seq ${event.seq} replace end`),
    } }
  }
  if (event.type === 'request/header') {
    const data = record(event.data, `format v2 request/header at seq ${event.seq} data`)
    const header = record(data['header'], `format v2 request/header at seq ${event.seq} header`)
    const empty = Object.keys(header).filter(key => key === 'tools' && Array.isArray(header[key]) && header[key].length === 0
      || key === 'adapterDefaults' && isSessionFormatJsonObject(header[key]) && Object.keys(header[key]).length === 0)
    if (empty.length > 0) {
      const canonical = Object.fromEntries(Object.entries(header).filter(([key]) => !empty.includes(key)))
      target = { ...target, data: { ...data, header: canonical } }
    }
  }
  assertV3Event(target)
  return target
}

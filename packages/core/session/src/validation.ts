/**
 * Session header, seed-event, and inherited-cut validation shared by Session
 * construction and log validation.
 * @module @deepseek-ai/dsh-session/validation
 */

import { isAbsolute } from 'node:path'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionLogOffset } from './types.ts'
import type { SessionEvent, SessionHeader, SessionHeaderMeta, SessionId, SessionSeedEventState, SurfaceEventType } from './types.ts'
import { SurfaceManager, validateSessionEventData } from './surface.ts'
import type { SessionMessageProjection } from './surface.ts'

/** Validate and freeze one detached creation header in place. */
function validateSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session header is not a plain JSON record')
  }
  const record = input as Record<string, unknown>
  if (Object.hasOwn(record, 'seedLength')) {
    throw new Error('session header has invalid field "seedLength"')
  }
  if (record.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`session header version must be ${SESSION_FORMAT_VERSION}, got ${String(record.version)}`)
  }
  if (record.id !== id) {
    throw new Error(`session header id "${String(record.id)}" does not match session id "${id}"`)
  }
  if (typeof record.createdAt !== 'number'
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0) {
    throw new Error('session header createdAt must be a non-negative safe integer')
  }
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== 'string') throw new Error('session header cwd must be a string')
    if (!isAbsolute(record.cwd)) {
      throw new Error(`session header cwd must be an absolute path, got "${record.cwd}"`)
    }
  }
  if (record.parentSession !== undefined && typeof record.parentSession !== 'string') {
    throw new Error('session header parentSession must be a string')
  }
  if (typeof record.isSeeded !== 'boolean') {
    throw new Error('session header isSeeded must be a boolean')
  }
  if (record.origin !== undefined && record.origin !== 'subagent') {
    throw new Error('session header origin must be "subagent"')
  }
  if (record.delegationDepth !== undefined
    && (typeof record.delegationDepth !== 'number' || !Number.isSafeInteger(record.delegationDepth) || record.delegationDepth < 0)) {
    throw new Error('session header delegationDepth must be a non-negative safe integer')
  }
  if (record.agentPreset !== undefined && typeof record.agentPreset !== 'string') {
    throw new Error('session header agentPreset must be a string')
  }
  return deepFreeze(record as unknown as SessionHeader)
}

/**
 * Validate and freeze one exclusively owned persistence header in place.
 * @param id - Session identity the header must carry.
 * @param input - decoded header, owned by the caller and frozen in place.
 * @returns the validated, deeply frozen header.
 * @throws when `input` is not a plain JSON record or fails header validation.
 */
export function validateRestoredSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const prototype = Reflect.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('session header is not a plain JSON record')
    }
  }
  return validateSessionHeader(id, input)
}

/**
 * Detach, validate, and freeze the creation metadata published by a session.
 * @param id - Session identity the header must carry.
 * @param source - borrowed header; omitted synthesizes a minimal current-format header.
 * @returns a validated, deeply frozen copy.
 * @throws when `source` is not losslessly JSON-serializable or fails header validation.
 */
export function snapshotSessionHeader(id: SessionId, source?: SessionHeader): SessionHeader {
  const input: unknown = source === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false }
    : source
  const snapshot = snapshotJsonValue(input)
  if (snapshot === undefined) throw new Error('session header is not losslessly JSON-serializable')
  return validateSessionHeader(id, snapshot)
}

/** Validate the fixed event envelope after one-pass JSON materialization. */
function assertSessionEventEnvelope(value: unknown, index: number): asserts value is SessionEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  const event = value as Record<string, unknown>
  for (const key in event) {
    switch (key) {
      case 'type':
      case 'seq':
      case 'time':
      case 'data':
      case 'surfaceOp':
      case 'sourceEventSeqs':
      case 'ignorable':
        break
      default:
        throw new Error(`seed event at index ${index} has an invalid event envelope`)
    }
  }
  const type = event['type']
  const seq = event['seq']
  const time = event['time']
  if (typeof type !== 'string'
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)
    || typeof time !== 'number' || !Number.isSafeInteger(time)
    || event['data'] === undefined
    || (event['ignorable'] !== undefined && event['ignorable'] !== true)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  validateSessionEventData(event as SessionEvent, `seed ${type} at index ${index}`)
  switch (type) {
    case 'request/header':
    case 'developer/message':
    case 'system/message':
    case 'user/message':
    case 'assistant/attempt':
    case 'assistant/message':
    case 'tool/result':
      assertCurrentLlmShape(event, index)
      break
  }
}

/** Reject obsolete request headers and malformed messages at the seed/load boundary. */
function assertCurrentLlmShape(event: Record<string, unknown>, index: number): void {
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  if (event['type'] === 'request/header') {
    const headerRecord = record?.['header'] as Record<string, unknown>
    const config = headerRecord['config']
    if (!hasProviderModel(config)) throw new Error(`seed request/header at index ${index} lacks provider/model`)
    const configRecord = config as Record<string, unknown>
    const reasoningEffort = configRecord['reasoningEffort']
    if (reasoningEffort !== undefined
      && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
      throw new Error(`seed request/header at index ${index} has an invalid reasoningEffort`)
    }
    assertAdapterDefaults(headerRecord['adapterDefaults'], configRecord, index)
    const reason = record?.['reason']
    if (reason !== 'initial' && reason !== 'resume' && reason !== 'change' && reason !== 'series') {
      throw new Error(`seed request/header at index ${index} has an invalid reason`)
    }
    if (record?.['startsSeries'] !== undefined && record['startsSeries'] !== true) {
      throw new Error(`seed request/header at index ${index} has an invalid startsSeries marker`)
    }
  }
  const type = event['type']
  if (type === 'assistant/attempt') {
    assertAssistantSettlementShape(record, type, index)
    return
  }
  if (!isMessageEventType(type)) return
  assertMessageEventShape(event, `seed ${type} at index ${index}`)
  if (type === 'assistant/message') {
    assertAssistantSettlementShape(record, type, index)
  }
}

/** Validate fields used directly by restored Session lifecycle logic without replaying the embedded stream. */
function assertAssistantSettlementShape(
  data: Record<string, unknown> | undefined,
  type: 'assistant/attempt' | 'assistant/message',
  index: number,
): void {
  const turn = data?.['turn']
  const step = data?.['step']
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0 || Object.is(turn, -0)
    || typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || Object.is(step, -0)
    || !Array.isArray(data?.['stream'])) {
    throw new Error(`seed ${type} at index ${index} has invalid settlement fields`)
  }
}

const allowedAdapterKeys = new Set(['reasoningEffort', 'maxTokens'])

/** Validate adapter-default markers imported from a durable request header. */
function assertAdapterDefaults(
  value: unknown,
  config: Record<string, unknown>,
  index: number,
): void {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
  const defaults = value as Record<string, unknown>
  if (Object.keys(defaults).some(key => !allowedAdapterKeys.has(key))
    || Object.values(defaults).some(marker => marker !== true)
    || defaults['reasoningEffort'] === true && config['reasoningEffort'] === undefined
    || defaults['maxTokens'] === true && config['maxTokens'] === undefined) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
}

/** The surface event types whose payload carries an identified message. */
function isMessageEventType(type: unknown): type is SurfaceEventType {
  return type === 'developer/message' || type === 'system/message' || type === 'user/message'
    || type === 'assistant/message' || type === 'tool/result'
}

const MESSAGE_ROLE_BY_TYPE: Record<SurfaceEventType, Message['role']> = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/** Validate source attribution without rejecting unrelated metadata fields. */
function assertSystemSectionMetadata(
  sourceRecord: Record<string, unknown>, content: unknown, subject: string,
): void {
  for (const marker of ['complete', 'reset']) {
    if (sourceRecord[marker] !== undefined && sourceRecord[marker] !== true) {
      throw new Error(`${subject} has invalid ${marker} system prompt marker`)
    }
  }
  const sections = sourceRecord['sections']
  if (sections === undefined) {
    if (sourceRecord['reset'] !== undefined) {
      throw new Error(`${subject} requires system section attribution`)
    }
    return
  }
  if (!Array.isArray(sections) || !Array.isArray(content)
    || content.some((block: unknown) => typeof block !== 'object' || block === null
      || !('type' in block) || block.type !== 'text' || !('text' in block) || typeof block.text !== 'string')) {
    throw new Error(`${subject} has invalid system section attribution`)
  }
  const names = new Set<string>()
  const indices = new Set<number>()
  const entries: readonly unknown[] = sections
  for (const section of entries) {
    if (typeof section !== 'object' || section === null
      || !('name' in section) || typeof section.name !== 'string' || section.name.length === 0) {
      throw new Error(`${subject} has invalid system section attribution`)
    }
    if (!('state' in section) || (section.state !== 'active' && section.state !== 'retired')) {
      throw new Error(`${subject} has invalid system section attribution`)
    }
    if (section.state === 'active'
      && (!('order' in section) || typeof section.order !== 'number' || !Number.isFinite(section.order))) {
      throw new Error(`${subject} has invalid system section attribution`)
    }
    const contentIndex = 'contentIndex' in section ? section.contentIndex : undefined
    if (section.state === 'retired' && contentIndex !== undefined) {
      throw new Error(`${subject} has invalid system section attribution`)
    }
    const references: unknown[] = section.state === 'active' ? [contentIndex] : []
    const noticeIndex = 'noticeIndex' in section ? section.noticeIndex : undefined
    if (noticeIndex !== undefined) {
      if (!Array.isArray(noticeIndex)) throw new Error(`${subject} has invalid system section attribution`)
      const notices: readonly unknown[] = noticeIndex
      references.push(...notices)
    }
    if (names.has(section.name)) throw new Error(`${subject} has invalid system section attribution`)
    names.add(section.name)
    for (const index of references) {
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= content.length
        || indices.has(index)) {
        throw new Error(`${subject} has invalid system section attribution`)
      }
      indices.add(index)
    }
  }
}

/**
 * Validate only the event-specific invariants needed to safely replay a message.
 * @param event - candidate event record; events that produce no message pass unchecked.
 * @param subject - description of the event that prefixes each error message.
 * @throws when a message event lacks its message or has an invalid role, source, or content.
 */
export function assertMessageEventShape(event: Record<string, unknown>, subject: string): void {
  const type = event['type']
  if (!isMessageEventType(type)) return
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  const message = type === 'user/message' ? record : record?.['message']
  if (typeof message !== 'object' || message === null
    || typeof (message as Record<string, unknown>)['id'] !== 'string'
    || (message as Record<string, unknown>)['id'] === '') {
    throw new Error(`${subject} lacks an identified message`)
  }
  const messageRecord = message as Record<string, unknown>
  const expectedRole = MESSAGE_ROLE_BY_TYPE[type]
  if (messageRecord['role'] !== expectedRole) {
    throw new Error(`${subject} message must have role "${expectedRole}"`)
  }
  const source = messageRecord['source']
  if (typeof source !== 'object' || source === null
    || typeof (source as Record<string, unknown>)['kind'] !== 'string'
    || (source as Record<string, unknown>)['kind'] === '') {
    throw new Error(`${subject} message has invalid source`)
  }
  if (!Array.isArray(messageRecord['content'])) {
    throw new Error(`${subject} message has invalid content`)
  }
  const sourceRecord = source as Record<string, unknown>
  if (type === 'system/message') {
    if (sourceRecord['kind'] !== 'system-prompt') {
      throw new Error(`${subject} message must have system-prompt source`)
    }
    assertSystemSectionMetadata(sourceRecord, messageRecord['content'], subject)
    return
  }
  if (type === 'assistant/message') {
    if (sourceRecord['kind'] !== 'model' || !hasProviderModel(sourceRecord)) {
      throw new Error(`${subject} message must have model source`)
    }
    return
  }
  if (type !== 'tool/result') return
  if (sourceRecord['kind'] !== 'tool'
    || typeof sourceRecord['callId'] !== 'string'
    || sourceRecord['callId'] === '') {
    throw new Error(`${subject} message must have tool source`)
  }
  if (messageRecord['toolCallId'] !== sourceRecord['callId']) {
    throw new Error(`${subject} message has mismatched tool call ids`)
  }
}

/** Whether an unknown value carries the current provider/model pair. */
function hasProviderModel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return typeof pair['provider'] === 'string' && pair['provider'].length > 0
    && typeof pair['model'] === 'string' && pair['model'].length > 0
}

/** Construction mode: `snapshot` borrows events like `Session.create`; an event state adopts them like `Session.fromRestore`. */
export type SessionSeedMode = 'snapshot' | SessionSeedEventState

/**
 * Validate one seed event's lossless JSON form, envelope, and position.
 * @param source - borrowed (`snapshot`) or adopted event at `index`.
 * @param index - position in the seed.
 * @param mode - whether the event is copied before validation.
 * @returns the detached copy in `snapshot` mode, otherwise `source`.
 * @throws when the event is not losslessly JSON-serializable, has an invalid envelope, or its seq is not `index`.
 */
export function validateSeedEvent(source: SessionEvent, index: number, mode: SessionSeedMode): SessionEvent {
  // The seed is a persistence/replay boundary: validate and detach the
  // complete event in one lossless-JSON pass.
  const snapshot = mode === 'snapshot' ? snapshotJsonValue(source) : source
  if (snapshot === undefined) {
    throw new Error(`seed event at index ${index} is not losslessly JSON-serializable`)
  }
  assertSessionEventEnvelope(snapshot, index)
  if (snapshot.seq !== index) {
    throw new Error(`seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`)
  }
  return snapshot
}

/**
 * Admit one validated seed event through the surface transition.
 * @param event - validated event at `index`, not yet in the log `surface` reads.
 * @param index - position in the seed.
 * @param surface - incremental surface validator carrying the message interpreters.
 * @throws `invalid seed event at index <index>: …` when the surface rejects the event.
 */
export function replaySurfaceEvent(event: SessionEvent, index: number, surface: SurfaceManager): void {
  // A seed is accepted incrementally through the same transition as a
  // live append and a full-log fold. The candidate is planned before it
  // enters `log`, so a failure cannot partially mutate the surface.
  try {
    surface.validateNext(event)
  } catch (error: unknown) {
    throw new Error(`invalid seed event at index ${index}: ${error instanceof Error ? error.message : 'invalid surface metadata'}`)
  }
}

/**
 * Validate seed events in order and push each accepted event into `log`, which `surface` reads.
 * Each event passes {@link validateSeedEvent} and then {@link replaySurfaceEvent} before it enters `log`.
 * @param seed - borrowed or adopted events.
 * @param mode - `snapshot` pushes deeply frozen copies; an event state pushes the adopted events.
 * @param log - empty log that `surface` was constructed over.
 * @param surface - incremental surface validator carrying the message interpreters.
 * @throws on the first invalid event; `log` then holds the accepted prefix.
 */
export function acceptSeedEvents(
  seed: readonly SessionEvent[],
  mode: SessionSeedMode,
  log: SessionEvent[],
  surface: SurfaceManager,
): void {
  for (const [index, source] of seed.entries()) {
    const snapshot = validateSeedEvent(source, index, mode)
    replaySurfaceEvent(snapshot, index, surface)
    log.push(mode === 'snapshot' ? deepFreeze(snapshot) : snapshot)
  }
}

/** Whether one event is the tagged inherited marker `session/end-seed { inherited: true }`. */
function isInheritedSeedMarker(event: SessionEvent | undefined): boolean {
  return event?.type === 'session/end-seed' && event.data.inherited === true
}

/**
 * Validate the inherited cut of a constructed log against its validated header.
 * @param header - validated header.
 * @param hasSeed - whether construction received a seed (an empty seed counts).
 * @param supplied - inherited event count supplied by the caller.
 * @param log - accepted seed events.
 * @param mode - construction mode; only `snapshot` requires a fresh seeded seed to equal its inherited prefix or mark its cut.
 * @returns the inherited event count, 0 when omitted for an unseeded header.
 * @throws when the cut is missing, inconsistent with `isSeeded`, beyond the log, or not the final inherited marker.
 */
export function validateInheritedCut(
  header: SessionHeader,
  hasSeed: boolean,
  supplied: SessionLogOffset | undefined,
  log: readonly SessionEvent[],
  mode: SessionSeedMode,
): SessionLogOffset {
  if (header.isSeeded && !hasSeed) {
    throw new Error('seeded session requires an explicit constructor seed')
  }
  if (header.isSeeded && supplied === undefined) {
    throw new Error('seeded session requires an inherited event count')
  }
  const inheritedEventCount = SessionLogOffset(supplied ?? 0)
  if (!header.isSeeded && inheritedEventCount !== 0) {
    throw new Error('unseeded session inherited event count must be 0')
  }
  if (inheritedEventCount > log.length) {
    throw new Error('session inherited event count exceeds its event log')
  }
  const markedSeed = isInheritedSeedMarker(log[inheritedEventCount])
  if (mode === 'snapshot' && header.isSeeded && inheritedEventCount !== log.length && !markedSeed) {
    throw new Error('seeded session constructor seed must equal its inherited prefix or mark its inherited cut')
  }
  if (markedSeed && log.slice(inheritedEventCount + 1).some(isInheritedSeedMarker)) {
    throw new Error('session inherited event count must identify the final inherited marker')
  }
  return inheritedEventCount
}

/**
 * Whether a fresh fork child must append its tagged inherited marker: the
 * header is seeded and the event at the inherited cut is not
 * `session/end-seed { inherited: true }`. A copied ancestor marker earlier in
 * the prefix does not count. Session construction applies this rule to a
 * borrowed seed; a restored log keeps its durable marker.
 * @param header - header of the new Session.
 * @param events - seed events, contiguous from seq 0.
 * @param inheritedEventCount - inherited cut.
 * @returns true when the marker must be appended at seq `events.length`.
 */
export function needsInheritedSeedMarker(
  header: SessionHeader,
  events: readonly SessionEvent[],
  inheritedEventCount: SessionLogOffset,
): boolean {
  return header.isSeeded && !isInheritedSeedMarker(events[inheritedEventCount])
}

/** A validated session log: header, inherited cut, and events. */
export interface CheckSessionLogResult {
  /** Validated, deeply frozen header. */
  readonly header: SessionHeader
  /** Inherited event count validated against `header` and `events`. */
  readonly inheritedEventCount: SessionLogOffset
}

/**
 * Validate a header, seed, and inherited cut in Session construction order.
 * An event-state `mode` validates the header first; `snapshot` validates the
 * events first. Each event passes the surface transition before the next is read.
 * @param id - Session identity the header must carry.
 * @param header - borrowed (`snapshot`) or adopted header; omitted synthesizes a minimal header in `snapshot` mode.
 * @param seed - borrowed or adopted events; omitted means no seed.
 * @param inheritedEventCount - exact fork-inherited prefix length; required when the header is seeded.
 * @param mode - construction mode.
 * @param events - empty log that `surface` was constructed over; receives the accepted events.
 * @param surface - incremental surface validator carrying the message interpreters.
 * @returns the validated header and inherited cut.
 * @throws on the first invalid header field, event envelope, sequence, surface transition, or inherited cut.
 */
export function checkSessionLog(
  id: SessionId,
  header: SessionHeader | undefined,
  seed: readonly SessionEvent[] | undefined,
  inheritedEventCount: SessionLogOffset | undefined,
  mode: SessionSeedMode,
  events: SessionEvent[],
  surface: SurfaceManager,
): CheckSessionLogResult {
  const restoredHeader = mode === 'snapshot' ? undefined : validateRestoredSessionHeader(id, header)
  // Validate the seed to the SAME invariants `append` enforces, so a
  // replay/fork (`ctx.sessions.create(id, { seed })`) cannot construct a
  // live log that no persistence backend could store: each event's `data`
  // must be JSON-serializable, and `seq` must be contiguous from 0 (the
  // `seq = log.length` contract the whole system relies on). Without this,
  // a bad seed would surface only later as a backend rejection or a silent
  // divergence between the live log and disk.
  if (seed !== undefined) acceptSeedEvents(seed, mode, events, surface)
  const checkedHeader = restoredHeader ?? snapshotSessionHeader(id, header)
  return {
    header: checkedHeader,
    inheritedEventCount: validateInheritedCut(checkedHeader, seed !== undefined, inheritedEventCount, events, mode),
  }
}

/**
 * Validate a header and event log with every check that constructing a Session
 * performs, in the same order and with the same errors, without constructing one.
 * Without `eventState` the checks match `Session.create`: events and header are
 * copied before validation. With it they match `Session.fromRestore`, which
 * validates and deeply freezes `header` in place and leaves events uncopied.
 * Embedded Assistant streams are not replayed.
 * @param header - header whose `id` is the Session identity.
 * @param events - seed events; omitted means no seed.
 * @param inheritedEventCount - exact fork-inherited prefix length; required when `header.isSeeded`.
 * @param eventState - aliasing state of adopted events; omitted for borrowed events.
 * @param projections - message interpreters for plugin-owned events.
 * @throws on the first invalid header field, event envelope, sequence, surface transition, or inherited cut.
 */
export function validateSessionLog(
  header: SessionHeader,
  events?: readonly SessionEvent[],
  inheritedEventCount?: SessionLogOffset,
  eventState?: SessionSeedEventState,
  projections: readonly SessionMessageProjection[] = [],
): void {
  const log: SessionEvent[] = []
  checkSessionLog(header.id, header, events, inheritedEventCount, eventState ?? 'snapshot', log, new SurfaceManager(log, SessionLogOffset(0), projections))
}

/**
 * Build the header of a new Session: the current format version, `createdAt`
 * (the current time when omitted), `isSeeded` (false when omitted), and the
 * other supplied fields. The result is not validated; Session construction validates it.
 * @param id - identity of the new Session.
 * @param meta - caller-supplied storage fields.
 * @returns a fresh, unfrozen header.
 */
export function buildSessionHeader(id: SessionId, meta?: SessionHeaderMeta): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: meta?.createdAt ?? Date.now(),
    ...meta?.cwd === undefined ? {} : { cwd: meta.cwd },
    ...meta?.parentSession === undefined ? {} : { parentSession: meta.parentSession },
    isSeeded: meta?.isSeeded ?? false,
    ...meta?.origin === undefined ? {} : { origin: meta.origin },
    ...meta?.delegationDepth === undefined ? {} : { delegationDepth: meta.delegationDepth },
    ...meta?.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
  }
}

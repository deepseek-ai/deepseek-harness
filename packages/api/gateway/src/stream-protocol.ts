/** Wire messages for Gateway-owned Remote streams and event-result RPCs. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol'

/** Exact WebSocket route carrying every Typert Remote stream. */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'

/** Gateway-internal logical stream carrying application-selected Cordis events. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'

/** Gateway-internal unary endpoint returning one Client Remote Event outcome. */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

/** Empty standard Remote payload used to open the forwarded-event stream. */
export const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} } as const

/** Discriminator for the first item proving the Host event source is ready. */
export const REMOTE_EVENT_STREAM_READY = { type: 'ready' } as const

/** Opaque identity for one active Client Remote Event generation. */
export type RemoteEventClientId = Branded<'RemoteEventClientId'>

/** Opaque correlation id for one pending Host-to-Client Remote Event. */
export type RemoteEventId = Branded<'RemoteEventId'>

/** Stable Host facts published with every established Client event generation. */
export interface RemoteEventHostInfo {
  /** Host account home used only to abbreviate displayed filesystem paths. */
  readonly home: string
}

/** Opening item that binds later HTTP results to this active event stream. */
export interface RemoteEventReadyFrame {
  readonly type: 'ready'
  readonly clientId: RemoteEventClientId
  /** Stable Host facts attached to this connection generation. */
  readonly host: RemoteEventHostInfo
}

/** Opaque Agent identity carried by one scoped Remote Event. */
export type RemoteEventAgentId = Branded<'RemoteEventAgentId'>

/** One Host notification delivered to a Client generation. */
export interface RemoteEventEmitFrame {
  readonly type: 'emit'
  readonly event: string
  readonly args: readonly unknown[]
}

/** One pending Agent-scoped waterfall delivered to a Client generation. */
export interface RemoteEventInvocationFrame {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: RemoteEventId
  readonly agentId: RemoteEventAgentId
  readonly request: Readonly<Record<string, unknown>>
}

/** Cancellation of a pending waterfall previously delivered under the same id. */
export interface RemoteEventCancellationFrame {
  readonly type: 'cancel'
  readonly eventId: RemoteEventId
}

/** Every item carried by the Gateway-internal forwarded-event stream. */
export type RemoteEventDownlinkFrame =
  | RemoteEventReadyFrame
  | RemoteEventEmitFrame
  | RemoteEventInvocationFrame
  | RemoteEventCancellationFrame

/** JSON request fields plus the Host cancellation lifetime removed for transport. */
export interface ProjectedRemoteEventRequest {
  readonly request: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}

/** Error fields retained when a Client listener rejects a Host waterfall. */
export interface RemoteEventRejection {
  readonly name: string
  readonly message: string
  readonly code?: string
  readonly details?: unknown
}

/** Client response to one scoped Remote Event delivery. */
export interface RemoteEventResult {
  readonly clientId: RemoteEventClientId
  readonly eventId: RemoteEventId
  readonly outcome:
    | { readonly kind: 'next' }
    | { readonly kind: 'result'; readonly value?: unknown }
    | { readonly kind: 'rejected'; readonly error: RemoteEventRejection }
}

/**
 * Parse one result sent through the Client's `$events/result` HTTP RPC.
 * @param value - untrusted result payload.
 * @returns validated event correlation and outcome fields.
 */
export function parseRemoteEventResult(value: unknown): RemoteEventResult {
  if (!isRecord(value)
    || !exactKeys(value, ['clientId', 'eventId', 'outcome'])
    || !isRemoteEventClientId(value.clientId)
    || !isRemoteEventId(value.eventId)
    || !isRecord(value.outcome)) {
    throw new Error('api gateway: invalid Remote event result')
  }
  const outcome = value.outcome
  if (outcome.kind === 'next' && exactKeys(outcome, ['kind'])) {
    return {
      clientId: value.clientId,
      eventId: value.eventId,
      outcome: { kind: 'next' },
    }
  }
  if (outcome.kind === 'result'
    && (exactKeys(outcome, ['kind']) || exactKeys(outcome, ['kind', 'value']))
    && (!Object.hasOwn(outcome, 'value') || isRemoteJsonValue(outcome.value))) {
    return {
      clientId: value.clientId,
      eventId: value.eventId,
      outcome: Object.hasOwn(outcome, 'value')
        ? { kind: 'result', value: outcome.value }
        : { kind: 'result' },
    }
  }
  if (outcome.kind === 'rejected'
    && exactKeys(outcome, ['kind', 'error'])) {
    return {
      clientId: value.clientId,
      eventId: value.eventId,
      outcome: { kind: 'rejected', error: parseRemoteEventRejection(outcome.error) },
    }
  }
  throw new Error('api gateway: invalid Remote event result')
}

/**
 * Remove the direct Agent and cancellation fields from one waterfall request.
 * @param value - request object before the waterfall's `next` callback.
 * @param subject - Agent used by the Cordis scope carrier.
 * @returns JSON-safe request fields and the optional Host cancellation signal.
 */
export function projectRemoteEventRequest(
  value: unknown,
  subject: object,
): ProjectedRemoteEventRequest {
  if (!isPlainRecord(value) || !Object.hasOwn(value, 'agent') || value.agent !== subject) {
    throw new TypeError('api gateway: Remote event request must carry its scoped Agent directly')
  }
  const signal = value.signal
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('api gateway: Remote event request signal must be an AbortSignal')
  }
  const request: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'agent' || key === 'signal') continue
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined
    if (typeof key !== 'string' || descriptor?.enumerable !== true) {
      throw new TypeError('api gateway: Remote event request has a non-JSON property')
    }
    request[key] = Reflect.get(value, key)
  }
  if (!isRemoteJsonValue(request)) {
    throw new TypeError('api gateway: Remote event request is not lossless JSON data')
  }
  return {
    request,
    ...(signal === undefined ? {} : { signal }),
  }
}

/**
 * Project an arbitrary rejection to stable, JSON-safe error fields.
 * @param reason - value thrown or rejected by a Client listener.
 * @returns wire-safe rejection fields.
 */
export function projectRemoteEventRejection(reason: unknown): RemoteEventRejection {
  const record = typeof reason === 'object' && reason !== null ? reason : undefined
  const name = stringProperty(record, 'name') ?? 'Error'
  const message = stringProperty(record, 'message') ?? String(reason)
  const code = stringProperty(record, 'code')
  const details = record === undefined ? undefined : Reflect.get(record, 'details') as unknown
  return {
    name,
    message,
    ...(code === undefined ? {} : { code }),
    ...(details === undefined || !isRemoteJsonValue(details) ? {} : { details }),
  }
}

/**
 * Recreate a Client rejection for the Host continuation.
 * @param rejection - validated wire-safe error fields.
 * @returns an Error preserving the remote name, code, and JSON-safe details.
 */
export function restoreRemoteEventRejection(rejection: RemoteEventRejection): Error {
  const error = new Error(rejection.message) as Error & { code?: string; details?: unknown }
  error.name = rejection.name
  if (rejection.code !== undefined) error.code = rejection.code
  if (rejection.details !== undefined) error.details = rejection.details
  return error
}

/**
 * Recognize a non-empty Remote Event correlation id at a wire boundary.
 * @param value - untrusted wire value.
 * @returns whether the value is a valid Remote Event id.
 */
export function isRemoteEventId(value: unknown): value is RemoteEventId {
  return typeof value === 'string' && value.length > 0
}

/**
 * Recognize a non-empty Remote Event Client id at a wire boundary.
 * @param value - untrusted wire value.
 * @returns whether the value identifies one event-stream generation.
 */
export function isRemoteEventClientId(value: unknown): value is RemoteEventClientId {
  return typeof value === 'string' && value.length > 0
}

/**
 * Recognize the direct Agent identity used by a scoped Remote Event.
 * @param value - untrusted wire value.
 * @returns whether the value is a non-empty Agent identity.
 */
export function isRemoteEventAgentId(value: unknown): value is RemoteEventAgentId {
  return typeof value === 'string' && value.length > 0
}

/** One logical stream request sent from the browser: open, one uplink item, uplink half-close, or cancel. */
export type RemoteStreamClientMessage =
  | {
    readonly type: 'open'
    readonly streamId: string
    readonly endpoint: string
    readonly payload: unknown
  }
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'end'; readonly streamId: string }
  | { readonly type: 'cancel'; readonly streamId: string }

/** Carrier-safe failure delivered by the Host. */
export interface RemoteStreamFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** One logical stream frame sent from the Host. */
export type RemoteStreamServerMessage =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: RemoteStreamFailure }
  | { readonly type: 'end'; readonly streamId: string }

/**
 * Parse and validate one browser-to-Host text message.
 * @param text - complete WebSocket text message.
 * @returns the validated logical-stream request.
 */
export function parseRemoteStreamClientMessage(text: string): RemoteStreamClientMessage {
  return parseMessage(text, (value) => {
    if ((value.type === 'cancel' || value.type === 'end')
      && exactKeys(value, ['type', 'streamId'])
      && validId(value.streamId)) {
      return value as RemoteStreamClientMessage
    }
    if (value.type === 'item'
      && (exactKeys(value, ['type', 'streamId']) || exactKeys(value, ['type', 'streamId', 'value']))
      && validId(value.streamId)
      && (!Object.hasOwn(value, 'value') || isRemoteJsonValue(value.value))) {
      return value as RemoteStreamClientMessage
    }
    if (value.type === 'open'
      && exactKeys(value, ['type', 'streamId', 'endpoint', 'payload'])
      && validId(value.streamId)
      && typeof value.endpoint === 'string'
      && value.endpoint.length > 0) {
      return value as RemoteStreamClientMessage
    }
    throw new Error('api gateway: invalid Remote stream client message')
  })
}

/**
 * Parse and validate one Host-to-browser text message.
 * @param text - complete WebSocket text message.
 * @returns the validated logical-stream frame.
 */
export function parseRemoteStreamServerMessage(text: string): RemoteStreamServerMessage {
  return parseMessage(text, (value) => {
    if (value.type === 'item'
      && (exactKeys(value, ['type', 'streamId']) || exactKeys(value, ['type', 'streamId', 'value']))
      && validId(value.streamId)) {
      return value as RemoteStreamServerMessage
    }
    if (value.type === 'end' && exactKeys(value, ['type', 'streamId']) && validId(value.streamId)) {
      return value as RemoteStreamServerMessage
    }
    if (value.type === 'error'
      && exactKeys(value, ['type', 'streamId', 'error'])
      && validId(value.streamId)
      && isRecord(value.error)
      && exactKeys(value.error, ['code', 'message', 'details'])
      && typeof value.error.code === 'string'
      && typeof value.error.message === 'string'
      && isRecord(value.error.details)) {
      return value as RemoteStreamServerMessage
    }
    throw new Error('api gateway: invalid Remote stream server message')
  })
}

function parseMessage<T>(text: string, validate: (value: Record<string, unknown>) => T): T {
  let decoded: unknown
  try {
    decoded = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('api gateway: Remote stream message is not JSON', { cause })
  }
  if (!isRecord(decoded)) throw new Error('api gateway: Remote stream message must be an object')
  return validate(decoded)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseRemoteEventRejection(value: unknown): RemoteEventRejection {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['name', 'message'], ['code', 'details'])
    || typeof value.name !== 'string'
    || value.name.length === 0
    || typeof value.message !== 'string'
    || (Object.hasOwn(value, 'code') && typeof value.code !== 'string')
    || (Object.hasOwn(value, 'details') && !isRemoteJsonValue(value.details))) {
    throw new Error('api gateway: invalid Remote event rejection')
  }
  return {
    name: value.name,
    message: value.message,
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(Object.hasOwn(value, 'details') ? { details: value.details } : {}),
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value)
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)))
}

function stringProperty(value: object | undefined, key: string): string | undefined {
  if (value === undefined) return undefined
  const candidate: unknown = Reflect.get(value, key)
  return typeof candidate === 'string' ? candidate : undefined
}

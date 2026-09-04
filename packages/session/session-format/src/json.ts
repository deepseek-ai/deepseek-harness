import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionFormatError } from './error.ts'
import type {
  SessionFormatArtifact,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from './types.ts'

/**
 * Test whether a value is a non-null, non-array object.
 * @param value - candidate value.
 * @returns whether the value is an object record.
 */
export function isSessionFormatJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Require a non-negative safe integer without the JSON-unstable negative zero.
 * @param value - candidate count.
 * @param label - diagnostic subject.
 * @returns validated count.
 */
export function sessionFormatCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new SessionFormatError(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

/**
 * Require a safe integer without the JSON-unstable negative zero.
 * @param value - candidate integer.
 * @param label - diagnostic subject.
 * @returns validated integer.
 */
export function sessionFormatSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new SessionFormatError(`${label} must be a safe integer`)
  }
  return value as number
}

/**
 * Require a non-negative integral format version.
 * @param value - candidate version.
 * @param label - diagnostic subject.
 * @returns validated version.
 */
export function sessionFormatVersion(value: unknown, label = 'Session format version'): number {
  return sessionFormatCount(value, label)
}

/**
 * Read only the version required for directional dispatch.
 * @param headerValue - untrusted physical header value.
 * @returns validated stored version.
 */
export function inspectSessionFormatVersion(headerValue: unknown): number {
  if (!isSessionFormatJsonObject(headerValue)) {
    throw new SessionFormatError('Session header must be a JSON object')
  }
  return sessionFormatVersion(headerValue['version'])
}

/**
 * Detach and deeply freeze a caller-supplied lossless JSON value.
 * @param value - borrowed candidate.
 * @param label - diagnostic subject.
 * @returns an immutable detached JSON snapshot.
 */
export function snapshotSessionFormatJson(value: unknown, label = 'Session value'): SessionFormatJsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) {
    throw new SessionFormatError(`${label} is not lossless JSON`)
  }
  return deepFreeze(snapshot) as SessionFormatJsonValue
}

/**
 * Snapshot one complete artifact and validate its shared coordinates.
 * @param artifact - borrowed logical artifact.
 * @param label - diagnostic subject.
 * @returns immutable detached artifact.
 */
export function snapshotSessionFormatArtifact(
  artifact: SessionFormatArtifact,
  label = 'Session artifact',
): SessionFormatArtifact {
  const snapshot = snapshotSessionFormatJson(artifact, label) as SessionFormatJsonObject
  const header = snapshot['header']
  const inheritedEventCount = snapshot['inheritedEventCount']
  const events = snapshot['events']
  if (!isSessionFormatJsonObject(header)) throw new SessionFormatError(`${label} header must be a JSON object`)
  inspectSessionFormatVersion(header)
  sessionFormatCount(inheritedEventCount, `${label} inheritedEventCount`)
  if (!Array.isArray(events)) throw new SessionFormatError(`${label} events must be an array`)
  for (let index = 0; index < events.length; index += 1) {
    const event: unknown = events[index]
    if (!isSessionFormatJsonObject(event)) throw new SessionFormatError(`${label} event ${index} must be a JSON object`)
    if (event['seq'] !== index) {
      throw new SessionFormatError(`${label} event ${index} has non-dense seq ${String(event['seq'])}`)
    }
    if (typeof event['type'] !== 'string' || event['type'].length === 0) {
      throw new SessionFormatError(`${label} event ${index} type must be a non-empty string`)
    }
    sessionFormatSafeInteger(event['time'], `${label} event ${index} time`)
    if (!Object.hasOwn(event, 'data')) throw new SessionFormatError(`${label} event ${index} lacks data`)
  }
  if (inheritedEventCount as number > events.length) {
    throw new SessionFormatError(`${label} inheritedEventCount exceeds its event count`)
  }
  return snapshot as unknown as SessionFormatArtifact
}

/**
 * Snapshot one logical header without inspecting an event body.
 * @param header - borrowed logical header.
 * @param label - diagnostic subject.
 * @returns immutable detached header.
 */
export function snapshotSessionFormatHeader(header: SessionFormatHeader, label = 'Session header'): SessionFormatHeader {
  const snapshot = snapshotSessionFormatJson(header, label)
  if (!isSessionFormatJsonObject(snapshot)) throw new SessionFormatError(`${label} must be a JSON object`)
  inspectSessionFormatVersion(snapshot)
  if (typeof snapshot['id'] !== 'string') throw new SessionFormatError(`${label} id must be a string`)
  sessionFormatCount(snapshot['createdAt'], `${label} createdAt`)
  if (typeof snapshot['isSeeded'] !== 'boolean') throw new SessionFormatError(`${label} isSeeded must be a boolean`)
  sessionFormatCount(snapshot['delegationDepth'], `${label} delegationDepth`)
  return snapshot as unknown as SessionFormatHeader
}

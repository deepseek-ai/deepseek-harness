import { isAbsolute } from 'node:path'
import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  sessionFormatCount,
  sessionFormatSafeInteger,
  snapshotSessionFormatJson,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { RELEASED_V0_EVENT_DISPOSITIONS } from './dispositions.ts'
import { assertReleasedPayloadSemantics } from './payload-validation.ts'
import { assertReleasedArtifactRelationships } from './relationships.ts'
import { assertReleasedV0Keys, releasedV0Record } from './validation-helpers.ts'

const HEADER_REQUIRED = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const
const HEADER_OPTIONAL = ['cwd', 'parentSession', 'origin', 'agentPreset'] as const
const EVENT_REQUIRED = ['type', 'seq', 'time', 'data'] as const
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
const SURFACE_OPTIONAL = ['ignorable', 'sourceEventSeqs', 'surfaceOp'] as const
const LOG_OPTIONAL = ['ignorable'] as const
const LEGACY_SOURCE_TYPES = new Set(['steering/message', 'request/header-delta', 'mode/set'])
const RELEASED_V0_EVENT_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(RELEASED_V0_EVENT_DISPOSITIONS))

/**
 * Validate the logical header shared by released v0 and v1.
 * @param header - detached logical header.
 * @param version - exact expected generation.
 */
export function assertReleasedSessionFormatHeader(header: SessionFormatHeader, version: 0 | 1): void {
  const record = releasedV0Record(header, `format v${version} header`)
  assertReleasedV0Keys(record, HEADER_REQUIRED, HEADER_OPTIONAL, `format v${version} header`)
  if (record['version'] !== version) throw new SessionFormatError(`expected format v${version} header`)
  if (typeof record['id'] !== 'string') throw new SessionFormatError(`format v${version} header id must be a string`)
  sessionFormatCount(record['createdAt'], `format v${version} header createdAt`)
  if (typeof record['isSeeded'] !== 'boolean') {
    throw new SessionFormatError(`format v${version} header isSeeded must be a boolean`)
  }
  sessionFormatCount(record['delegationDepth'], `format v${version} header delegationDepth`)
  for (const key of ['cwd', 'parentSession', 'agentPreset'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new SessionFormatError(`format v${version} header ${key} must be a string`)
    }
  }
  if (typeof record['cwd'] === 'string' && !isAbsolute(record['cwd'])) {
    throw new SessionFormatError(`format v${version} header cwd must be absolute`)
  }
  if (record['origin'] !== undefined && record['origin'] !== 'subagent') {
    throw new SessionFormatError(`format v${version} header origin must be "subagent"`)
  }
}

/**
 * Validate one released-v1 logical header.
 * @param header - detached logical header.
 */
export function assertReleasedV1Header(header: SessionFormatHeader): void {
  assertReleasedSessionFormatHeader(header, 1)
}

/**
 * Validate v0 before historical normalizers run.
 * @param artifact - decoded released-v0 source.
 */
export function assertReleasedV0SourceArtifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 0)
  assertArtifactCoordinates(artifact, true, RELEASED_V0_EVENT_TYPE_SET)
}

/**
 * Validate normalized v0 events before the identity header version changes.
 * @param artifact - normalized released-v0 artifact.
 */
export function assertNormalizedReleasedV0Artifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 0)
  assertArtifactCoordinates(artifact, false, RELEASED_V0_EVENT_TYPE_SET)
  for (const event of artifact.events) assertReleasedEventPayload(event, 0)
  assertReleasedArtifactRelationships(artifact)
}

/**
 * Validate the exact logical image emitted by the released v1 writer.
 * @param artifact - decoded or migration-produced v1 artifact.
 */
export function assertReleasedV1Artifact(artifact: SessionFormatArtifact): void {
  assertReleasedV1Header(artifact.header)
  assertArtifactCoordinates(artifact, false, RELEASED_V0_EVENT_TYPE_SET)
  for (const event of artifact.events) {
    if (RELEASED_V0_EVENT_DISPOSITIONS[event.type] !== undefined) assertReleasedEventPayload(event, 1)
  }
  assertReleasedArtifactRelationships(artifact)
}

/**
 * Restore v1 against the installed build's ordinary event vocabulary without freezing payload additions.
 * @param artifact - vocabulary-neutral released-v1 physical decode.
 * @param knownEventTypes - event types understood by the installed current Session package.
 * @returns the same validated detached artifact.
 */
export function restoreReleasedV1Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV1Header(artifact.header)
  assertArtifactCoordinates(artifact, false, knownEventTypes)
  return artifact
}

/**
 * Validate released-v1 physical layout without interpreting event vocabulary.
 * @param artifact - physical-codec output.
 */
export function assertReleasedV1PhysicalArtifact(artifact: SessionFormatArtifact): void {
  assertReleasedV1Header(artifact.header)
  assertArtifactCoordinates(artifact, false, undefined, true)
}

function assertArtifactCoordinates(
  artifact: SessionFormatArtifact,
  allowLegacySteering: boolean,
  knownEventTypes?: ReadonlySet<string>,
  vocabularyNeutral = false,
): void {
  const inheritedEventCount = sessionFormatCount(artifact.inheritedEventCount, 'Session inheritedEventCount')
  if (inheritedEventCount > artifact.events.length) {
    throw new SessionFormatError('Session inheritedEventCount exceeds its event count')
  }
  if (!artifact.header.isSeeded && inheritedEventCount !== 0) {
    throw new SessionFormatError('unseeded Session inheritedEventCount must be 0')
  }
  for (let index = 0; index < artifact.events.length; index += 1) {
    const event = artifact.events[index] as SessionFormatEvent
    const record = releasedV0Record(event, `Session event ${index}`)
    const type = record['type']
    if (typeof type !== 'string') throw new SessionFormatError(`Session event ${index} type must be a string`)
    const disposition = RELEASED_V0_EVENT_DISPOSITIONS[type]
    const legacy = allowLegacySteering && LEGACY_SOURCE_TYPES.has(type)
    const currentKnown = knownEventTypes?.has(type) === true
    const ignorableCurrent = !allowLegacySteering && !currentKnown && record['ignorable'] === true
    if (!currentKnown && !legacy && !ignorableCurrent && !vocabularyNeutral) {
      if (allowLegacySteering) {
        throw new SessionFormatUnsupportedMigrationError(
          `format v0 contains unknown historical event type ${JSON.stringify(type)} at seq ${index}; migration refuses unknown historical events even when ignorable`,
        )
      }
      throw new SessionFormatUnsupportedMigrationError(
        `format v1 contains unknown required event type ${JSON.stringify(type)} at seq ${index}`,
      )
    }
    const frozenEnvelope = !vocabularyNeutral && knownEventTypes === RELEASED_V0_EVENT_TYPE_SET
    const surface = disposition !== undefined ? SURFACE_EVENT_TYPES.has(type) : type === 'steering/message'
    const optional = frozenEnvelope
      ? surface ? SURFACE_OPTIONAL : LOG_OPTIONAL
      : SURFACE_OPTIONAL
    assertReleasedV0Keys(record, EVENT_REQUIRED, optional, `Session event ${index}`)
    if (record['seq'] !== index) {
      throw new SessionFormatError(`Session event ${index} has non-dense seq ${JSON.stringify(record['seq'])}`)
    }
    sessionFormatSafeInteger(record['time'], `Session event ${index} time`)
    if (record['ignorable'] !== undefined && record['ignorable'] !== true) {
      throw new SessionFormatError(`Session event ${index} ignorable must be true when present`)
    }
    if (frozenEnvelope && surface) assertReleasedSurfaceMetadata(record, index, type, 'allow-empty-assistant')
  }
}

/**
 * Validate shared-layout surface references for one released generation.
 * @param record - exact event envelope.
 * @param seq - event position used for earlier-reference checks.
 * @param type - surface event type used in diagnostics.
 * @param assistantSources - whether this generation admits empty Assistant chunk provenance.
 */
export function assertReleasedSurfaceMetadata(
  record: Record<string, SessionFormatJsonValue>,
  seq: number,
  type: string,
  assistantSources: 'allow-empty-assistant' | 'forbid-assistant',
): void {
  const sources = record['sourceEventSeqs']
  if (type === 'assistant/message' && sources !== undefined && assistantSources === 'forbid-assistant') {
    throw new SessionFormatError(`assistant/message ${seq} retains obsolete chunk provenance`)
  }
  if (sources !== undefined) {
    if (!Array.isArray(sources)) throw new SessionFormatError(`${type} ${seq} sourceEventSeqs must be an array`)
    const seen = new Set<number>()
    for (const source of sources) {
      const current = sessionFormatCount(source, `${type} ${seq} sourceEventSeqs member`)
      if (current >= seq || seen.has(current)) {
        throw new SessionFormatError(`${type} ${seq} sourceEventSeqs must be unique earlier seqs`)
      }
      seen.add(current)
    }
    if (sources.length === 0
      && (type !== 'assistant/message' || assistantSources === 'forbid-assistant')) {
      throw new SessionFormatError(`${type} ${seq} sourceEventSeqs must be non-empty`)
    }
  }
  const operation = record['surfaceOp']
  if (operation === undefined || operation === 'append') return
  const replacement = releasedV0Record(operation, `${type} ${seq} surfaceOp`)
  assertReleasedV0Keys(replacement, ['op', 'start', 'end'], [], `${type} ${seq} surfaceOp`)
  if (replacement['op'] !== 'replace') throw new SessionFormatError(`${type} ${seq} surfaceOp must replace`)
  const start = sessionFormatCount(replacement['start'], `${type} ${seq} surface start`)
  const end = sessionFormatCount(replacement['end'], `${type} ${seq} surface end`)
  if (start >= seq || end >= seq) throw new SessionFormatError(`${type} ${seq} has an invalid surface replacement`)
}

/**
 * Validate one exact known payload after legacy normalization.
 * @param event - known event to validate.
 * @param version - payload generation controlling versioned members.
 */
export function assertReleasedEventPayload(event: SessionFormatEvent, version: 0 | 1): void {
  const disposition = RELEASED_V0_EVENT_DISPOSITIONS[event.type]
  /* v8 ignore next -- artifact coordinate validation admits only the frozen inventory before payload validation. */
  if (disposition === undefined) {
    throw new SessionFormatUnsupportedMigrationError(
      `format v0 contains unknown event type ${JSON.stringify(event.type)} at seq ${event.seq}`,
    )
  }
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  if (event.type === 'subagent/descriptor' && data['version'] !== 3) {
    const descriptorVersion = sessionFormatCount(data['version'], `${event.type} ${event.seq} version`)
    if (version === 0) {
      throw new SessionFormatUnsupportedMigrationError(
        `${event.type} ${event.seq} uses unsupported descriptor version ${descriptorVersion}`,
      )
    }
    return
  }
  const versionOptional = version === 1 && event.type === 'session-log-deepseek/delivery-accepted'
    ? [...disposition.optional, 'sessionFormatVersion']
    : disposition.optional
  assertReleasedV0Keys(data, disposition.required, versionOptional, `${event.type} ${event.seq} data`)
  for (const key of disposition.opaque) {
    if (Object.hasOwn(data, key)) snapshotSessionFormatJson(data[key], `${event.type} ${event.seq} opaque ${key}`)
  }
  assertReleasedPayloadSemantics(event, version)
}

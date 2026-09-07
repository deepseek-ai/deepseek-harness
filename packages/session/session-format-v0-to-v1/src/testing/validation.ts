import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { RELEASED_V0_EVENT_DISPOSITIONS } from '../dispositions.ts'
import { assertReleasedArtifactRelationships } from '../relationships.ts'
import {
  assertReleasedArtifactCoordinates,
  assertReleasedEventPayload,
  assertReleasedSessionFormatHeader,
} from '../validation.ts'

const RELEASED_V0_EVENT_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(RELEASED_V0_EVENT_DISPOSITIONS))

/**
 * Validate one decoded released-v0 source artifact in tests.
 * @param artifact - released-v0 source artifact.
 */
export function assertReleasedV0SourceArtifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 0)
  assertReleasedArtifactCoordinates(artifact, true, RELEASED_V0_EVENT_TYPE_SET, false, true)
}

/**
 * Validate normalized v0 output before the identity header bump in tests.
 * @param artifact - normalized v0 artifact.
 */
export function assertNormalizedReleasedV0Artifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 0)
  assertReleasedArtifactCoordinates(artifact, false, RELEASED_V0_EVENT_TYPE_SET, false, true)
  for (const event of artifact.events) assertReleasedEventPayload(event, 0)
  assertReleasedArtifactRelationships(artifact, { legacyInterruptedTurnRestart: true })
}

/**
 * Validate v1 input accepted by the v1-to-v2 migration in tests.
 * @param artifact - v1 migration source artifact.
 */
export function assertReleasedV1MigrationSource(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 1)
  assertReleasedArtifactCoordinates(artifact, false, RELEASED_V0_EVENT_TYPE_SET, false, true)
  for (const event of artifact.events) {
    if (RELEASED_V0_EVENT_DISPOSITIONS[event.type] !== undefined) assertReleasedEventPayload(event, 1)
  }
  assertReleasedArtifactRelationships(artifact, { legacyInterruptedTurnRestart: true })
}

/**
 * Validate the exact released-v1 logical artifact in tests.
 * @param artifact - released-v1 logical artifact.
 */
export function assertReleasedV1Artifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 1)
  assertReleasedArtifactCoordinates(artifact, false, RELEASED_V0_EVENT_TYPE_SET, false, true)
  for (const event of artifact.events) {
    if (RELEASED_V0_EVENT_DISPOSITIONS[event.type] !== undefined) assertReleasedEventPayload(event, 1)
  }
  assertReleasedArtifactRelationships(artifact)
}

/**
 * Validate released-v1 physical decoding without interpreting event vocabulary in tests.
 * @param artifact - released-v1 physical artifact.
 */
export function assertReleasedV1PhysicalArtifact(artifact: SessionFormatArtifact): void {
  assertReleasedSessionFormatHeader(artifact.header, 1)
  assertReleasedArtifactCoordinates(artifact, false, undefined, true)
}

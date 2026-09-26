/** Native V4 metadata and generation-owned relationship validation. */

import { isAbsolute } from 'node:path'
import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { assertV4DeveloperData } from './developer.ts'
import { assertV4LifecycleRelationships } from './relationships.ts'
import { assertV4MessageSources } from './message-sources.ts'
import { catalogFact } from './facts.ts'
import { assertV4RetiredSyntax } from './retired-syntax.ts'
import { assertV4SystemMessageFields } from './system-message.ts'
import { assertV4ForkResult } from './fork-result.ts'
import { assertV4ToolResultMessage } from './tool-role.ts'

/**
 * Validate the exact native V4 logical header.
 * @param header - decoded or otherwise untrusted V4 Session header candidate.
 */
export function assertReleasedV4Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 4) throw new SessionFormatError('expected format v4 header')
  const required = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth']
  const allowed = new Set([...required, 'cwd', 'parentSession', 'origin', 'agentPreset'])
  const missing = required.find(key => !Object.hasOwn(header, key))
  const unexpected = Object.keys(header).find(key => !allowed.has(key))
  if (missing !== undefined) throw new SessionFormatError(`format v4 header lacks required field ${missing}`)
  if (unexpected !== undefined) throw new SessionFormatError(`format v4 header has unexpected field ${unexpected}`)
  if (typeof header.id !== 'string') throw new SessionFormatError('format v4 header id must be a string')
  sessionFormatCount(header.createdAt, 'format v4 header createdAt')
  sessionFormatCount(header.delegationDepth, 'format v4 header delegationDepth')
  if (typeof header.isSeeded !== 'boolean') throw new SessionFormatError('format v4 header isSeeded must be boolean')
  if (header.cwd !== undefined && (typeof header.cwd !== 'string' || !isAbsolute(header.cwd))) {
    throw new SessionFormatError('format v4 header cwd must be absolute')
  }
  for (const key of ['parentSession', 'agentPreset']) {
    if (header[key] !== undefined && typeof header[key] !== 'string') {
      throw new SessionFormatError(`format v4 header ${key} must be a string`)
    }
  }
  if (header.origin !== undefined && header.origin !== 'subagent') {
    throw new SessionFormatError('format v4 header origin must be "subagent"')
  }
}

/**
 * Validate V4 inheritance, vocabulary, native message admission, and
 * lifecycle, compaction, tool, retry, title, command, catalog, and delivery ownership.
 * Installed Session restoration owns common event envelopes and message acceptance.
 * @param artifact - complete detached V4 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact and event objects.
 */
export function restoreReleasedV4Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV4Header(artifact.header)
  const cut = sessionFormatCount(artifact.inheritedEventCount, 'format v4 inherited event count')
  if (cut > artifact.events.length) throw new SessionFormatError('format v4 inherited event count exceeds its events')
  if (!artifact.header.isSeeded && cut !== 0) throw new SessionFormatError('unseeded format v4 Session has inherited events')
  let lastInheritedMarker: number | undefined
  for (const [index, event] of artifact.events.entries()) {
    if (!knownEventTypes.has(event.type) && event['ignorable'] !== true) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v4 contains unknown event type ${JSON.stringify(event.type)} at seq ${index}`,
      )
    }
    if (event.seq !== index) throw new SessionFormatError(`format v4 event ${index} is not dense`)
    if (!knownEventTypes.has(event.type)) continue
    assertV4RetiredSyntax(event)
    assertV4SystemMessageFields(event)
    assertV4ToolResultMessage(event)
    assertV4ForkResult(event)
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) lastInheritedMarker = index
  }
  if (artifact.header.isSeeded && lastInheritedMarker !== cut) {
    throw new SessionFormatError('format v4 seeded header disagrees with its last inherited end-seed marker')
  }
  if (!artifact.header.isSeeded && lastInheritedMarker !== undefined) {
    throw new SessionFormatError('format v4 unseeded Session contains an inherited end-seed marker')
  }
  assertReleasedV4Relationships(artifact, knownEventTypes)
  return artifact
}

/**
 * Validate delivery generation and active-generation coordinates before evaluating ownership.
 * @param event - decoded event whose delivery payload may be inspected.
 * @param currentVersion - generation whose watermark coordinates are active.
 * @returns the active delivery's nonempty Session id, or undefined for other events and generations.
 */
export function validateDeliveryAccepted(event: SessionFormatEvent, currentVersion: 3 | 4): string | undefined {
  if (event.type !== 'session-log-deepseek/delivery-accepted') return undefined
  const data = event.data
  if (!isSessionFormatJsonObject(data)) throw new SessionFormatError('delivery-accepted data must be an object')
  const version = sessionFormatCount(data['sessionFormatVersion'] === undefined ? 0 : data['sessionFormatVersion'], 'delivery sessionFormatVersion')
  if (version !== currentVersion) return undefined
  const throughSeq = sessionFormatCount(data['throughSeq'], 'delivery throughSeq')
  if (throughSeq >= event.seq) throw new SessionFormatError('delivery throughSeq must precede its marker')
  const id = data['sessionId']
  if (typeof id !== 'string' || id.length === 0) throw new SessionFormatError('delivery requires a nonempty Session id')
  return id
}

/**
 * Validate native developer fields, message sources, lifecycle, catalog, and delivery
 * relationships without changing event vocabulary or tail recovery.
 * The owning admission stage rejects unknown required events;
 * unknown ignorable records retain their uninterpreted payloads.
 * @param artifact - decoded artifact with its final inherited cut.
 * @param knownEventTypes - installed event types whose payloads this reader interprets.
 */
export function assertReleasedV4Relationships(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): void {
  const ids = new Set<string>()
  for (const event of artifact.events) {
    if (!knownEventTypes.has(event.type)) continue
    assertV4DeveloperData(event)
    assertV4MessageSources(event)
    const deliveryId = validateDeliveryAccepted(event, 4)
    if (deliveryId !== undefined
      && !(artifact.header.parentSession !== undefined && event.seq < artifact.inheritedEventCount)
      && deliveryId !== artifact.header.id) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    if (event.type === 'subagent/catalog' && event.seq >= artifact.inheritedEventCount) {
      const fact = catalogFact(event.data)
      const id = fact['childId'] as string
      if (ids.has(id)) throw new SessionFormatError(`duplicate catalog child ${id}`)
      ids.add(id)
    }
  }
  assertV4LifecycleRelationships(artifact, knownEventTypes)
}

/** Native V3 system-head validation with a private view for frozen non-system relationships. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV2Header, restoreReleasedV2Artifact } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertV3Event, isRepairIdentity, record, SURFACE_TYPES } from './payload.ts'

/**
 * Validate v3 logical metadata with the released-v2 fields.
 * @param header - decoded v3 Session header.
 */
export function assertReleasedV3Header(header: SessionFormatHeader): void {
  if (header.version !== 3) throw new SessionFormatError('expected format v3 header')
  assertReleasedV2Header({ ...header, version: 2 })
}

/**
 * Validate system ownership, protected-head operations, ordinary relationships, and inherited cut.
 * The private relationship view never escapes; the returned artifact and its messages are unchanged.
 * @param artifact - detached v3 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV3Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV3Header(artifact.header)
  let step: { turn: unknown; step: unknown } | undefined
  let head: number | undefined
  let hasSurface = false
  const events = artifact.events.map((event): SessionFormatEvent => {
    assertV3EventAdmission(event)
    assertV3Event(event, knownEventTypes)
    const system = event.type === 'system/message'
    if (event.type === 'step/start') {
      const data = record(event.data, event.type)
      step = { turn: data['turn'], step: data['step'] }
    } else if (event.type === 'step/end' || event.type === 'turn/end') step = undefined
    if (system) {
      const data = record(event.data, 'system/message')
      if (step === undefined || step.turn !== data['turn'] || step.step !== data['step']) {
        throw new SessionFormatError('system/message does not match an open step')
      }
      const operation = event['surfaceOp']
      if (hasSurface && head === undefined) throw new SessionFormatError('system/message requires a protected first surface head')
      if (operation === 'append') {
        if (!hasSurface) head = event.seq
      } else {
        const replace = record(operation, 'system replacement')
        if (replace['startSeq'] === head || replace['endSeq'] === head) {
          if (replace['startSeq'] !== head || replace['endSeq'] !== head) {
            throw new SessionFormatError('system/message must replace exactly the current system head')
          }
          head = event.seq
        }
      }
    } else if (SURFACE_TYPES.has(event.type) && event['surfaceOp'] !== 'append') {
      const replace = record(event['surfaceOp'], 'surface replacement')
      if (replace['startSeq'] === head || replace['endSeq'] === head) throw new SessionFormatError('surface replacement cannot shadow the protected system head')
    }
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      const data = record(event.data, event.type)
      const seqs = data['shadowedSeqs']
      if (Array.isArray(seqs) && seqs.some(seq => seq === head)) {
        throw new SessionFormatError('compaction cannot shadow the protected system head')
      }
    }
    if (SURFACE_TYPES.has(event.type)) hasSurface = true
    const projected = relationshipEvent(event)
    if (!SURFACE_TYPES.has(event.type) || event['surfaceOp'] === 'append') return projected
    const replacement = event['surfaceOp'] as { readonly startSeq: number; readonly endSeq: number }
    // Only the frozen relationship view uses released endpoint names.
    return { ...projected, surfaceOp: { op: 'replace', start: replacement.startSeq, end: replacement.endSeq } }
  })
  restoreReleasedV2Artifact({ ...artifact, header: { ...artifact.header, version: 2 }, events }, knownEventTypes, 3)
  return artifact
}

/**
 * Refuse required predecessor PTC tags without interpreting native extension payloads.
 * @param event - event envelope whose type and ignorable admission markers are available.
 */
export function assertV3EventAdmission(event: SessionFormatEvent): void {
  if ((event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch')
    && event['ignorable'] !== true) {
    throw new SessionFormatUnsupportedMigrationError(
      'format v3 contains unknown event type ' + JSON.stringify(event.type) + ' at seq ' + String(event.seq),
    )
  }
}

function relationshipEvent(event: SessionFormatEvent): SessionFormatEvent {
  switch (event.type) {
    case 'tool/ptc-dispatch-start':
      return { ...event, type: 'tool/code-dispatch-start' }
    case 'tool/ptc-dispatch':
      return { ...event, type: 'tool/code-dispatch' }
    case 'tool/code-dispatch-start':
    case 'tool/code-dispatch':
      assertV3EventAdmission(event)
      // Obsolete ignorable events do not participate in released PTC lifecycle validation.
      return { ...event, type: 'v3/opaque-released-event' }
  }
  if (event.type === 'system/message') {
    const message = record(record(event.data, 'system data')['message'], 'system message')
    // The frozen validator needs a surface-eligible event, not a model-visible substitute.
    return { ...event, type: 'user/message', data: { ...message, role: 'user' } }
  }
  if (event.type !== 'tool/result') return event
  const data = record(event.data, 'tool result')
  if (data['error'] === undefined) return event
  const error = record(data['error'], 'tool error')
  if (error['code'] !== 'TOOL_NOT_STARTED') return event
  const message = record(data['message'], 'tool message')
  const source = record(message['source'], 'tool source')
  const callId = source['callId']
  const id = message['id']
  if (!isRepairIdentity(id, callId)) return event
  const prefix = 'interrupted-tool-result-' + callId + '-'
  // Message identity survives promotion; only this private frozen repair check uses target seq.
  return { ...event, data: { ...data, message: { ...message, id: `${prefix}${event.seq}` } } }
}

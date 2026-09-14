/** Explicit local-coordinate remapping; captured generations and owner-local counters remain opaque. */

import { SessionFormatError, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { record } from './payload.ts'

/**
 * Remap only audited same-artifact references, preserving IDs and embedded model input.
 * @param event - validated source event.
 * @param seq - output event position.
 * @param mapping - earlier source positions mapped to output positions.
 * @returns the event in target coordinates.
 */
export function remapEvent(event: SessionFormatEvent, seq: number, mapping: readonly number[]): SessionFormatEvent {
  const one = (value: SessionFormatJsonValue | undefined): number => {
    const source = sessionFormatCount(value, 'source event reference')
    const target = mapping[source]
    if (source >= event.seq || target === undefined) throw new SessionFormatError('reference must name an earlier source event')
    return target
  }
  const list = (value: SessionFormatJsonValue | undefined): number[] => {
    if (!Array.isArray(value)) throw new SessionFormatError('sequence references must be an array')
    return value.map(one)
  }
  const range = (value: SessionFormatJsonValue | undefined): SessionFormatJsonObject => {
    const source = record(value, 'sequence range')
    return { ...source, start: one(source['start']), end: one(source['end']) }
  }
  let data = record(event.data, event.type)
  switch (event.type) {
    case 'command/done':
      if (data['sourceEventSeq'] !== undefined) data = { ...data, sourceEventSeq: one(data['sourceEventSeq']) }
      break
    case 'compaction/summary':
    case 'compaction/prune':
      data = { ...data, shadowedRange: range(data['shadowedRange']), shadowedSeqs: list(data['shadowedSeqs']) }
      break
    case 'session/title':
    case 'session/title-llm-request':
      data = { ...data, messageSeqs: list(data['messageSeqs']) }
      break
    // Delivery watermarks and session-reference captures identify their original generation.
    // Workflow seq, stream block indices, turn/step, and numeric tool JSON are not Session seqs.
  }
  return {
    ...event, seq, data,
    ...(event['sourceEventSeqs'] === undefined ? {} : { sourceEventSeqs: list(event['sourceEventSeqs']) }),
    ...(event['surfaceOp'] === undefined || event['surfaceOp'] === 'append'
      ? {} : { surfaceOp: range(event['surfaceOp']) }),
  }
}

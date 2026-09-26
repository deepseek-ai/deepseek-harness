/** V4 framing with native tool-role admission and released physical rows. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertV4SourceRowAdmission } from './message-sources.ts'
import { assertV4RetiredSyntax } from './retired-syntax.ts'
import { assertV4SystemMessageFields } from './system-message.ts'
import { assertV4DeveloperData } from './developer.ts'
import { assertV4ForkResult } from './fork-result.ts'
import { assertV4ToolResultMessage } from './tool-role.ts'
import { assertReleasedV4Header } from './validation.ts'

function physicalV2(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 4) throw new SessionFormatError('expected format v4 physical header')
  return { ...value, version: 2 } as SessionFormatHeader
}

/**
 * V4 physical encoder and decoder retain the released row framing while
 * validating the native tool-role message directly.
 */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    return { ...releasedV2SessionFormatCodec.decodeHeader(physicalV2(value)), version: 4 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV2SessionFormatCodec.createDecoder(physicalV2(value), recovery)
    return {
      ...decoder,
      header: { ...decoder.header, version: 4 },
      decodeRow(row, context) {
        assertV4RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent: context.emitEvent.bind(context),
        })
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV4Header(header)
    return { ...releasedV2SessionFormatCodec.encodeHeader({ ...header, version: 2 }, inheritedEventCount), version: 4 }
  },
  encodeEvent(event: SessionFormatEvent) {
    if (event.type === 'developer/message' && event['ignorable'] === true) {
      assertV4DeveloperData(event)
      assertV4RetiredSyntax(event)
    }
    assertV4RowAdmission(event)
    return releasedV2SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Apply native V4 admission before a scanner discards a recoverable suffix.
 * Ignorable developer payloads require reader vocabulary; physical decoding defers them.
 * @param row - parsed physical row before framing and source-event range decoding.
 * @param knownEventTypes - installed event types, supplied by native readers before tail recovery.
 */
export function assertV4RowAdmission(row: unknown, knownEventTypes?: ReadonlySet<string>): void {
  if (isSessionFormatJsonObject(row)) {
    if (row['type'] === 'developer/message' && row['ignorable'] === true
      && knownEventTypes?.has('developer/message') !== true) return
    assertV4DeveloperData(row as unknown as SessionFormatEvent)
  }
  assertV4SourceRowAdmission(row)
  assertV4RetiredSyntax(row)
  assertV4SystemMessageFields(row)
  if (!isSessionFormatJsonObject(row) || row['type'] !== 'tool/result') return
  const event = row as unknown as SessionFormatEvent
  assertV4ToolResultMessage(event)
  assertV4ForkResult(event)
}

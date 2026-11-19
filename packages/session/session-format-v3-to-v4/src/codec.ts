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

/**
 * Split the V4-only `side` origin from a header, because the frozen V2 header codec admits only `subagent`.
 * @param header - V4 header object.
 * @returns the header for the V2 codec and the origin fields to restore on its result.
 */
function splitSideOrigin(header: Readonly<Record<string, unknown>>): readonly [Readonly<Record<string, unknown>>, { readonly origin?: 'side' }] {
  const { origin, ...rest } = header
  return origin === 'side' ? [rest, { origin }] : [header, {}]
}

function physicalV2(value: unknown): readonly [SessionFormatHeader, { readonly origin?: 'side' }] {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 4) throw new SessionFormatError('expected format v4 physical header')
  const [header, side] = splitSideOrigin(value)
  return [{ ...header, version: 2 } as SessionFormatHeader, side]
}

/**
 * V4 physical encoder and decoder retain the released row framing while
 * validating the native tool-role message directly.
 */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    const [header, side] = physicalV2(value)
    return { ...releasedV2SessionFormatCodec.decodeHeader(header), ...side, version: 4 }
  },
  createDecoder(value, recovery) {
    const [header, side] = physicalV2(value)
    const decoder = releasedV2SessionFormatCodec.createDecoder(header, recovery)
    return {
      ...decoder,
      header: { ...decoder.header, ...side, version: 4 },
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
    const [v2, side] = splitSideOrigin(header)
    const physical = releasedV2SessionFormatCodec.encodeHeader({ ...v2, version: 2 } as SessionFormatHeader, inheritedEventCount)
    return { ...physical, ...side, version: 4 }
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

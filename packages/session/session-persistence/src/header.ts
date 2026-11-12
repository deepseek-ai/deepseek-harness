/** Physical Session header encoding shared by persistence backends. @module */
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import type { SessionFormatCatalog } from '@deepseek-ai/dsh-session-format'

/**
 * The current physical header stored as the first JSONL record. The exact
 * inherited cut lives on the last tagged `session/end-seed` event.
 */
export interface HeaderLine {
  type: 'session'
  version: number
  id: SessionId
  createdAt: number
  cwd?: string
  parentSession?: SessionId
  isSeeded: boolean
  origin?: 'subagent'
  delegationDepth: number
  agentPreset?: string
}

/**
 * Build the header line object from a {@link SessionHeader}.
 * @param header - the immutable session metadata to serialize.
 * @param inheritedEventCount - exact inherited prefix length; required for a
 * seeded header and omitted only for an unseeded header.
 * @param encode - current physical header encoder selected by the backend.
 * @returns the `type: 'session'`-tagged line object, absent optional fields omitted (never null).
 */
export function encodeSessionHeader(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType | undefined,
  encode: SessionFormatCatalog['encodeCurrentHeader'],
): HeaderLine {
  if (header.isSeeded && inheritedEventCount === undefined) {
    throw new Error('seeded session header requires an inherited event count')
  }
  const cut = SessionLogOffset(inheritedEventCount ?? 0)
  if (!header.isSeeded && cut !== 0) {
    throw new Error('unseeded session header inherited event count must be 0')
  }
  const encoded: unknown = encode({
    ...header,
    delegationDepth: header.delegationDepth ?? 0,
  }, cut)
  return encoded as HeaderLine
}

/** Current installed Session validation used after vocabulary-aware format restoration. */

import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'

/**
 * Validate current logical metadata through the installed Session package.
 * @param header - detached current logical header.
 * @returns nothing after successful validation.
 */
export function validateInstalledCurrentSessionHeader(header: SessionFormatHeader): void {
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `installed Session format is v${SESSION_FORMAT_VERSION}, got v${header.version}`,
    )
  }
  Session.fromRestore(
    SessionId(header.id),
    [],
    header as unknown as SessionHeader,
    SessionLogOffset(0),
    'detached',
  )
}

/**
 * Validate current header, event envelopes, messages, surface operations, and seed cut through the installed Session package.
 * @param artifact - vocabulary-restored current logical artifact.
 * @returns nothing after successful validation.
 */
export function validateInstalledCurrentSessionArtifact(artifact: SessionFormatArtifact): void {
  if (artifact.header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `installed Session format is v${SESSION_FORMAT_VERSION}, got v${artifact.header.version}`,
    )
  }
  Session.fromRestore(
    SessionId(artifact.header.id),
    artifact.events as SessionEvent[],
    artifact.header as unknown as SessionHeader,
    SessionLogOffset(artifact.inheritedEventCount),
    'detached',
  )
}

/** Handle-based session-persistence helpers shared by the subagent test suites. */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** Read one stored session's header and complete event log through a read handle. */
export async function loadStoredSession(
  persistence: SessionPersistence,
  id: SessionId,
): Promise<{ meta: SessionHeader; inheritedEventCount: SessionLogOffset; events: readonly SessionEvent[] }> {
  const handle = await persistence.open(id, 'read')
  try {
    return {
      meta: handle.header,
      inheritedEventCount: handle.inheritedEventCount,
      events: (await handle.read()).events,
    }
  } finally {
    await handle.close()
  }
}

/** Author one stored session directly against the backend: create, append, flush, close. */
export async function seedStoredSession(
  persistence: SessionPersistence,
  header: SessionHeader,
  events: readonly SessionEvent[],
  inheritedEventCount?: SessionLogOffset,
): Promise<void> {
  const handle = await persistence.create(header, inheritedEventCount === undefined ? {} : { inheritedEventCount })
  try {
    if (events.length > 0) await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
}

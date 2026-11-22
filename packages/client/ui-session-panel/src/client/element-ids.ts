/** DOM ids that connect a Session's toggle and panel across their separate slot entries. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Id of a Session's panel element, which the toggle names in `aria-controls`.
 * @param sessionId - Session that owns the panel.
 * @returns the element id.
 */
export function panelElementId(sessionId: SessionId): string {
  return `dsh-session-panel-${sessionId}`
}

/**
 * Id of a Session's toggle, which receives focus when its overlay closes from the keyboard.
 * @param sessionId - Session whose header holds the toggle.
 * @returns the element id.
 */
export function toggleElementId(sessionId: SessionId): string {
  return `dsh-session-panel-toggle-${sessionId}`
}

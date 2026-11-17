/** One pending request to open a Session's share dialog after switching to it. */

let pending: string | undefined
let opener: ((sessionId: string) => void) | undefined

/**
 * Bind the workspace navigation one manager click uses.
 * @param open - Workspace Session opener, or undefined when this page has none.
 */
export function setManagedShareOpener(open: ((sessionId: string) => void) | undefined): void {
  opener = open
}

/**
 * Switch to one Session before its header action opens the share dialog.
 * @param sessionId - Session the manager selected.
 */
export function openManagedSession(sessionId: string): void {
  opener?.(sessionId)
}

/**
 * Remember the Session whose share dialog should open once its header action mounts.
 * @param sessionId - Session the manager selected.
 */
export function rememberManagedShare(sessionId: string): void {
  pending = sessionId
}

/**
 * Consume a pending request for one Session.
 * @param sessionId - Session whose header action is mounting.
 * @returns True when this Session's share dialog should open.
 */
export function takeManagedShare(sessionId: string): boolean {
  if (pending !== sessionId) return false
  pending = undefined
  return true
}

/** Drop a request that navigation could not complete. */
export function forgetManagedShare(): void {
  pending = undefined
}

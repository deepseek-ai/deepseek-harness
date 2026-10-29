/**
 * Select the one Session a viewer page presents.
 *
 * The viewer page presents exactly one shared Session, so it opens that Session as soon as the
 * session list carries it instead of leaving the empty "new session" home page a signed-in viewer
 * cannot act on.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-session
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the Workspace navigation service merge (`ctx.uiWorkspace`).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

/**
 * Share one served viewer page presents. Restated from the protocol package because this Client
 * face may not import its root entry, which also carries the Host-only wire and identity modules.
 */
interface ViewerPageTarget {
  readonly basePath: string
  readonly shareId: string
  readonly sessionId: string
}

interface ViewerTargetWindow {
  __DSH_LIVESHARE_VIEWER__?: ViewerPageTarget
}

/**
 * Open the shared Session once the session list knows it.
 *
 * Selecting a Session is the Workspace navigation action's to perform, so this page asks
 * `uiWorkspace` for the same selection the sidebar's own Session rows ask for; the session list
 * says when the Host has published the Session this page presents.
 * @param ctx - browser context of the viewer's module table.
 */
export function openSharedSession(ctx: ClientContext): void {
  const target = (globalThis as ViewerTargetWindow).__DSH_LIVESHARE_VIEWER__
  if (target === undefined || target.sessionId === '') return
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return
  const wanted = target.sessionId as SessionId
  const listed = (): boolean => sessions.list.getSnapshot().byId[wanted] !== undefined
  const open = (): void => { ctx.uiWorkspace.openSession(wanted) }
  if (listed()) {
    open()
    return
  }
  ctx.effect(() => {
    // The subscription is dropped BEFORE the navigation: retaining the Session notifies the list
    // again, and a listener that opened first would re-enter itself until the stack overflowed. The
    // flag makes the one open final even if the notifier delivers to this listener once more as it
    // removes it.
    let opened = false
    // The listener closes over the subscription that is created right after it: no notification
    // can arrive before `subscribe` returns.
    const onListed = (): void => {
      if (opened || !listed()) return
      opened = true
      unsubscribe()
      open()
    }
    const unsubscribe = sessions.list.subscribe(onListed)
    return () => { unsubscribe() }
  }, 'liveshare: open the shared viewer Session')
}

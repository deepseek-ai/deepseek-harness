/** Visible main-view acknowledgements over Host reading state. */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: declares the `mainView` reference source.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionReadModel } from './model.ts'

/**
 * Acknowledge loaded content after a rendering frame in the visible, focused main view.
 * Switching the main view to a Session, including the first selection after a page load, clears that Session's
 * manual reminder once its body arrives; window focus and a replaced binding for the same Session preserve it.
 * Without a document there is no view to acknowledge, so nothing is installed.
 * @param ctx - owning Client plugin Context.
 * @param sessions - Session catalog and binding owner.
 * @param reading - shared Host-confirmed reading state.
 */
export function installReadingAcknowledgements(ctx: Context, sessions: Pick<ISessions, 'list' | 'binding'>, reading: Pick<SessionReadModel, 'state' | 'acknowledge'>): void {
  if (typeof document === 'undefined') return
  let selected: SessionId | undefined
  let binding: SessionBinding | undefined
  let releaseBinding = (): void => {}
  // The entered Session whose manual reminder the next acknowledgement clears; settled against a ready baseline.
  let entered: SessionId | undefined
  let attemptedTurn: number | undefined
  let frame: number | undefined
  let active = true
  let pending: Promise<void> | undefined
  const visible = (): boolean => document.visibilityState === 'visible' && document.hasFocus()
  const schedule = (): void => {
    if (!active || frame !== undefined || !visible()) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      acknowledge()
    })
  }
  const acknowledge = (): void => {
    const snapshot = reading.state.getSnapshot()
    const record = selected === undefined ? undefined : snapshot.items[selected]
    if (!visible() || !snapshot.ready || binding?.session.getSnapshot().openState !== 'open') return
    if (record === undefined || pending !== undefined || attemptedTurn === record.completedTurn) return
    const clearing = entered === record.sessionId
    if (!clearing && record.completedTurn <= record.readTurn) return
    const received = record.completedTurn === 0 || binding.eventSource.getSnapshot().entries.some(({ event }) =>
      (event.type === 'turn/end' && event.data.turn >= record.completedTurn)
      || (event.type === 'turn/start' && event.data.turn > record.completedTurn))
    if (!received) return
    attemptedTurn = record.completedTurn
    entered = undefined
    pending = reading.acknowledge(record.sessionId, record.completedTurn, clearing).catch((error: unknown) => {
      console.error('[session-status] Reading acknowledgement could not be confirmed. Reopen the Session to refresh its state:', error)
    }).finally(() => { pending = undefined; schedule() })
  }
  const settleEntry = (): void => {
    const snapshot = reading.state.getSnapshot()
    if (snapshot.ready && entered !== undefined && !snapshot.items[entered]?.manualUnread) entered = undefined
  }
  const update = (): void => {
    const list = sessions.list.getSnapshot()
    const id = Object.values(list.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id
    const next = id === undefined ? undefined : sessions.binding(id)
    if (id !== selected || next !== binding) {
      releaseBinding()
      if (id !== selected) {
        entered = id
        settleEntry()
      }
      selected = id
      binding = next
      attemptedTurn = undefined
      const releaseSession = next?.session.subscribe(schedule)
      const releaseEvents = next?.eventSource.subscribe(schedule)
      releaseBinding = () => { releaseSession?.(); releaseEvents?.() }
    }
    schedule()
  }
  const focus = (): void => {
    attemptedTurn = undefined
    schedule()
  }
  ctx.effect(() => {
    const releaseList = sessions.list.subscribe(update)
    const releaseReading = reading.state.subscribe(() => {
      settleEntry()
      schedule()
    })
    document.addEventListener('visibilitychange', focus)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', focus)
    update()
    return async () => {
      active = false
      releaseList()
      releaseReading()
      releaseBinding()
      document.removeEventListener('visibilitychange', focus)
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', focus)
      if (frame !== undefined) cancelAnimationFrame(frame)
      await pending
    }
  }, 'session-status: visible reading acknowledgement')
}

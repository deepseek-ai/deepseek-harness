/**
 * The page's own statement of why it is not showing the shared Session, and what the reader can do.
 *
 * The viewer renders the normal client UI, so a page that cannot read the share would otherwise leave
 * an empty shell with no way forward. Every state below therefore carries a plain statement, most of
 * them a hint, and the ones with something to do offer the action itself: re-read, sign in again, ask
 * the owner, or go back to the share directory. No state ends at an error code the reader cannot use.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-status-banner
 */

import { type LiveshareKey, type ViewerTranslate } from './locales.ts'
import type { ViewerStatus } from './viewer-status.ts'
import css from './viewer-status-banner.module.css'

/** Element id the page's statement owns; one page keeps one. */
const STATUS_ID = 'liveshare-viewer-status'

/** One thing the reader can do about the state the page is in. */
export type ViewerStatusAction = 'reload' | 'sign-in' | 'directory' | 'retry'

/** What one state states, and the ways out it offers. */
interface StatusStep {
  /** Plain statement of what happened, without a single internal code. */
  readonly message: LiveshareKey
  /** What the reader can do about it, when the action alone does not say it. */
  readonly hint?: LiveshareKey
  /** Actions this state offers, in the order the page shows them. */
  readonly actions: readonly { readonly kind: ViewerStatusAction; readonly label: LiveshareKey }[]
}

/** Every state but `ready` states itself; `ready` shows nothing because the Session speaks for itself. */
const STATUS_STEPS: Readonly<Record<Exclude<ViewerStatus, 'ready'>, StatusStep>> = {
  invalid: {
    message: 'viewer.status.invalid',
    hint: 'viewer.status.invalidHint',
    actions: [{ kind: 'directory', label: 'viewer.action.directory' }],
  },
  offline: {
    message: 'viewer.status.offline',
    hint: 'viewer.status.offlineHint',
    actions: [{ kind: 'retry', label: 'viewer.action.retry' }],
  },
  stopped: {
    message: 'viewer.status.stopped',
    hint: 'viewer.status.stoppedHint',
    actions: [{ kind: 'directory', label: 'viewer.action.directory' }],
  },
  expired: {
    message: 'viewer.status.expired',
    hint: 'viewer.status.expiredHint',
    actions: [{ kind: 'directory', label: 'viewer.action.directory' }],
  },
  reauthenticate: {
    message: 'viewer.status.reauthenticate',
    actions: [{ kind: 'sign-in', label: 'viewer.action.signIn' }],
  },
  unavailable: {
    message: 'viewer.status.unavailable',
    hint: 'viewer.status.unavailableHint',
    actions: [{ kind: 'reload', label: 'viewer.action.reload' }],
  },
  connecting: {
    message: 'viewer.status.connecting',
    actions: [],
  },
}

/** One page's statement, rebuilt in place so it never stacks duplicates. */
export interface ViewerStatusBanner {
  /**
   * State the one state the page is in, with the ways out that state offers.
   * @param status - State the page holds.
   */
  update(status: ViewerStatus): void
  /** Remove the element and its listeners. */
  dispose(): void
}

/**
 * Mount the page's statement of its own state.
 * @param doc - Document the page renders in.
 * @param onAction - Performs one action the reader asked for.
 * @param t - Translate seat bound to this package's namespace.
 * @returns The banner, which updates one element in place.
 */
export function mountViewerStatusBanner(
  doc: Document,
  onAction: (action: ViewerStatusAction) => void,
  t: ViewerTranslate,
): ViewerStatusBanner {
  const element = doc.createElement('div')
  element.id = STATUS_ID
  element.className = css.banner ?? ''
  element.setAttribute('role', 'status')
  element.setAttribute('aria-live', 'polite')
  // Layout stays inline because this element belongs to the served page rather than to the client UI's
  // own surfaces; its colors live in the module stylesheet, whose `Canvas`/`CanvasText` fallbacks keep
  // the banner readable when that stylesheet never loads.
  Object.assign(element.style, {
    position: 'fixed',
    left: '50%',
    top: '12px',
    transform: 'translateX(-50%)',
    zIndex: '2147483000',
    maxWidth: 'min(640px, calc(100vw - 32px))',
    padding: '12px 16px',
    borderRadius: '10px',
    font: '13px/1.5 system-ui, sans-serif',
    textAlign: 'center',
    display: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  const listeners: (() => void)[] = []
  doc.body.append(element)
  const clear = (): void => {
    for (const remove of listeners.splice(0)) remove()
    element.replaceChildren()
  }
  return {
    update(status) {
      clear()
      if (status === 'ready') {
        element.style.display = 'none'
        return
      }
      const step = STATUS_STEPS[status]
      const message = doc.createElement('div')
      message.id = 'liveshare-viewer-status-message'
      message.textContent = t(step.message)
      element.append(message)
      if (step.hint !== undefined) {
        const hint = doc.createElement('div')
        hint.id = 'liveshare-viewer-status-hint'
        hint.style.opacity = '0.8'
        hint.style.fontSize = '12px'
        hint.style.marginTop = '2px'
        hint.textContent = t(step.hint)
        element.append(hint)
      }
      for (const action of step.actions) {
        const button = doc.createElement('button')
        button.type = 'button'
        button.dataset.liveshareAction = action.kind
        button.textContent = t(action.label)
        button.style.marginTop = '8px'
        button.style.cursor = 'pointer'
        const click = (): void => { onAction(action.kind) }
        button.addEventListener('click', click)
        listeners.push(() => { button.removeEventListener('click', click) })
        element.append(button)
      }
      element.style.display = 'block'
    },
    dispose() {
      clear()
      element.remove()
    },
  }
}

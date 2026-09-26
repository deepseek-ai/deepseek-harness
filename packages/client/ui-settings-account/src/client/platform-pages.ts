/**
 * One native Platform view for the whole account feature. The Account settings
 * page, the frame-wide quota notice, and the desktop onboarding recharge step
 * request a page here instead of mounting their own container, because the
 * Desktop host owns a single WebContentsView and its `open` destroys whatever
 * was showing before.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Platform destinations the shared native host can show. */
export type PlatformPage = 'usage' | 'top-up'

/** The live request the shared host renders. */
export interface PlatformPageClaim {
  /** Requested destination. */
  page: PlatformPage
}

/** Why one request stopped being the live page. */
export type PlatformPageExit =
  /** The viewer returned with the host's own back action. */
  | 'returned'
  /** A newer request took the page over. */
  | 'superseded'

/** Shared request channel between the account surfaces and their one host. */
export interface PlatformPages {
  /** @returns the live request, or null while the host is closed. */
  getSnapshot(): PlatformPageClaim | null
  /** @param listener - called after every request change. @returns unsubscribes. */
  subscribe(listener: () => void): () => void
  /**
   * Show one Platform page. A newer request retires the previous owner before
   * this call returns, and the returned release clears only this request, so a
   * stale owner can never close a page it no longer owns.
   * @param page - destination to show.
   * @param onClose - runs at most once with the reason this request stopped being
   * the live page. A release or plugin teardown ends it without calling back.
   * @returns identity-safe release for this request.
   */
  open(this: void, page: PlatformPage, onClose: (reason: PlatformPageExit) => void): () => void
  /** Viewer returned: clear the live request and run its owner's `onClose` once. */
  close(this: void): void
  /**
   * Plugin teardown: drop the request without running its owner's `onClose`.
   * Unmounting the host closes the native view, and the owner unmounts with it.
   */
  dispose(this: void): void
}

/**
 * Create the plugin-scoped request channel shared by the account surfaces and
 * the one host that renders their pages. The snapshot store supplies the
 * observable and isolates a throwing subscriber from the rest.
 * @returns the request channel.
 */
export function createPlatformPages(): PlatformPages {
  const store = createSnapshotStore<PlatformPageClaim | null>(null)
  let owner: ((reason: PlatformPageExit) => void) | undefined
  let token: object | null = null
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    open(page, onClose) {
      const previous = owner
      const own = {}
      token = own
      owner = onClose
      store.set({ page })
      // The newer request is already installed, so the retired owner's release
      // cannot clear it.
      previous?.('superseded')
      return () => {
        if (token !== own) return
        token = null
        owner = undefined
        store.set(null)
      }
    },
    close() {
      if (store.getSnapshot() === null) return
      const retiring = owner
      token = null
      owner = undefined
      store.set(null)
      retiring?.('returned')
    },
    dispose() {
      token = null
      owner = undefined
      if (store.getSnapshot() === null) return
      store.set(null)
    },
  }
}

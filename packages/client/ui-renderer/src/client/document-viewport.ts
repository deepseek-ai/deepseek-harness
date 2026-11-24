/** Observable layout viewport of the document that contains the application root. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Layout viewport dimensions in CSS pixels, excluding scrollbars. */
export interface DocumentViewport {
  readonly width: number
  readonly height: number
}

/**
 * Read the current dimensions even between subscribers; unchanged dimensions keep the snapshot identity.
 * @param page - Document of this application mount. A detached document has no resize events.
 * @returns Source invalidated by that window's native resize events.
 */
export function documentViewport(page: Document): HostObservable<DocumentViewport> {
  let snapshot: DocumentViewport | undefined
  return {
    getSnapshot() {
      const { clientWidth: width, clientHeight: height } = page.documentElement
      if (snapshot?.width !== width || snapshot.height !== height) snapshot = { width, height }
      return snapshot
    },
    subscribe(listener) {
      const view = page.defaultView
      view?.addEventListener('resize', listener)
      return () => { view?.removeEventListener('resize', listener) }
    },
  }
}

/** Composition lifetime for local keyboard handlers, including a late closing keydown. */

/**
 * Observe composition until its closing key is released or consumed.
 * @param document - document whose input events belong to the caller.
 * @returns an event guard and a disposer for all listeners.
 */
export function observeComposition(document: Document): {
  guards(event: KeyboardEvent): boolean
  dispose(): void
} {
  let composing = false
  let ended = false
  const start = (): void => { composing = true }
  const end = (): void => { composing = false; ended = true }
  const release = (): void => { ended = false }
  const blur = (): void => { composing = false; ended = false }
  document.addEventListener('compositionstart', start, true)
  document.addEventListener('compositionend', end, true)
  document.addEventListener('keyup', release, true)
  document.defaultView?.addEventListener('blur', blur)
  return {
    guards: (event) => {
      // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
      const guarded = composing || ended || event.isComposing || event.keyCode === 229
      ended = false
      return guarded
    },
    dispose: () => {
      document.removeEventListener('compositionstart', start, true)
      document.removeEventListener('compositionend', end, true)
      document.removeEventListener('keyup', release, true)
      document.defaultView?.removeEventListener('blur', blur)
    },
  }
}

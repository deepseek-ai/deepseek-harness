import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Optional visibility operation; its caller owns cancellation and eventually commits the attribute.
 * @param element - stable subtree root.
 * @param hidden - desired hidden state.
 * @param commit - apply the final visibility before reporting the operation complete.
 */
export type HiddenTransition = (element: HTMLElement, hidden: boolean, commit: () => void) => void

/**
 * Apply searchable hidden state without unmounting a stable subtree.
 * @param hidden - whether the subtree is currently hidden.
 * @param reveal - callback for browser find's beforematch reveal.
 * @param transition - optional caller-owned visibility operation; otherwise apply synchronously.
 * @returns ref for the stable subtree root.
 */
export function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
  transition?: HiddenTransition,
): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (hidden && element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return
    }
    const commit = (): void => {
      if (hidden) element.setAttribute('hidden', 'until-found')
      else element.removeAttribute('hidden')
    }
    if (transition === undefined) commit()
    else transition(element, hidden, commit)
  }, [hidden, reveal, transition])
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    element.addEventListener('beforematch', reveal)
    return () => { element.removeEventListener('beforematch', reveal) }
  }, [reveal])
  return ref
}

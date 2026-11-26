/** Focus for a card whose save was refused: the first field it marked invalid. */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * Move the keyboard to the first invalid field of a card each time a save is
 * refused. The browser scrolls that field into view as it takes focus.
 * @param attempt - count of the card's refused saves.
 * @returns the ref the card puts on its root element.
 */
export function useInvalidFocus(attempt: number): RefObject<HTMLDivElement | null> {
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (attempt > 0) card.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [attempt])
  return card
}

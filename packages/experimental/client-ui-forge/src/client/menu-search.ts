/** Keys of the search field at the top of a menu that lists what the search matches. */

import type { KeyboardEvent } from 'react'

/**
 * Keep the edge and arrow keys in a menu's search field, so they move the caret instead of the menu's focus, and choose
 * the first listed row with Enter outside an input method composition.
 * @param event - the key event of the search field.
 * @param chooseFirst - chooses the first listed row, or undefined while none is listed.
 */
export function searchFieldKeyDown(event: KeyboardEvent<HTMLInputElement>, chooseFirst: (() => void) | undefined): void {
  if (['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation()
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || chooseFirst === undefined) return
  event.preventDefault()
  chooseFirst()
}

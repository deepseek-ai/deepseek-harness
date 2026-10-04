/** Clipping geometry for the Inspector's element-picker overlay outside the Chat subtree. */

/**
 * Intersect a Chat box with its scrollports and the transcript area above the composer.
 * @param element - Existing Chat Node, call, or Group box.
 * @returns The visible rectangle, or undefined when the target is outside the conversation viewport.
 */
export function visibleChatRect(element: HTMLElement): {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
} | undefined {
  const rect = element.getBoundingClientRect()
  let left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right)
  let top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom)
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (!parent.matches('[data-conversation-scroll], [data-step-process-body]')) continue
    const bounds = parent.getBoundingClientRect()
    left = Math.max(left, bounds.left); right = Math.min(right, bounds.right)
    top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom)
    if (parent.hasAttribute('data-conversation-scroll')) {
      const composer = parent.querySelector<HTMLElement>(':scope > [data-composer-seat]')?.getBoundingClientRect()
      if (composer !== undefined && composer.height > 0) bottom = Math.min(bottom, composer.top)
    }
  }
  return bottom <= top || right <= left ? undefined : { left, top, width: right - left, height: bottom - top }
}

/**
 * Place an Inspector overlay without changing the Chat content box.
 * @param overlay - Inspector-owned fixed-position element.
 * @param element - Existing Chat Node, call, or Group box.
 * @returns Whether any part of the target remains visible after clipping.
 */
export function placeChatHighlight(overlay: HTMLElement, element: HTMLElement): boolean {
  const rect = visibleChatRect(element)
  if (rect === undefined) return false
  Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  return true
}

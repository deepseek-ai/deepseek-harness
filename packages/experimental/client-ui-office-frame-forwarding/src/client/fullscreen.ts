/** Standard Fullscreen API helpers for Office slideshow views and occlusion checks. */

/**
 * Report whether another element of the document is currently fullscreen, covering `target`.
 * @param target - The Office view element.
 * @returns True when a different element holds fullscreen.
 */
export function isOccludedByFullscreen(target: Element): boolean {
  const current = target.ownerDocument.fullscreenElement
  return Boolean(current) && current !== target
}

/**
 * Request fullscreen for `target`; rejects when another element already holds fullscreen so only one slideshow runs.
 * Call synchronously inside the user gesture handler before awaiting anything.
 * @param target - The Office view element to show fullscreen.
 * @returns Completion of the fullscreen entry.
 */
export function requestElementFullscreen(target: Element): Promise<void> {
  if (isOccludedByFullscreen(target)) return Promise.reject(new Error('Another view is already fullscreen.'))
  return target.requestFullscreen()
}

/**
 * Exit fullscreen when `target` is the document's fullscreen element; tolerates an exit Chromium performed on Escape.
 * @param target - The Office view element that entered fullscreen.
 * @returns Completion of the exit; resolves immediately when `target` is not fullscreen.
 */
export async function exitElementFullscreen(target: Element): Promise<void> {
  const doc = target.ownerDocument
  if (doc.fullscreenElement !== target) return
  try {
    await doc.exitFullscreen()
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Chromium can leave fullscreen while exitFullscreen() is pending.
    if (doc.fullscreenElement !== null) throw error
  }
}

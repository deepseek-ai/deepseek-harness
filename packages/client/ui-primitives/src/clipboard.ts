// Host clipboard write shared by Web UI copy controls. Success feedback stays
// with each control; this helper only reports whether the host accepted a write.

/**
 * Write text to the host clipboard, preferring the async Clipboard API and
 * falling back to `execCommand('copy')` when that API is missing (jsdom,
 * insecure contexts) or refuses the write (blocked clipboard permission,
 * embedding policy). Call it from a user gesture: the fallback relies on the
 * gesture's transient activation.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  // lib.dom types clipboard non-optional, but insecure contexts omit it —
  // that runtime gap is exactly what this guard detects.
  /* oxlint-disable-next-line typescript/no-unnecessary-condition */
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (_error) {
      // A denied permission or embedding policy blocks only the async API; try the fallback below.
    }
  }
  // execCommand('copy') is the only clipboard fallback where the async API
  // is missing or refused; deprecated but deliberately retained.
  /* oxlint-disable typescript/no-deprecated */
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return false
  // Selecting the textarea moves focus; return it so a keyboard user stays on the copy control.
  const focused = document.activeElement
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    return exec('copy')
  } catch {
    return false
  } finally {
    el.remove()
    if (focused instanceof HTMLElement) focused.focus()
  }
  /* oxlint-enable typescript/no-deprecated */
}

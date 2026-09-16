/** Marks the document root with the host platform so shared Web UI CSS can scope desktop-only rules. */

/**
 * Sets `data-platform` (e.g. `darwin`) on `<html>`, deferring to DOMContentLoaded
 * when the preload runs before the document root exists.
 */
export function markDocumentPlatform(): void {
  const mark = (): void => { document.documentElement.dataset.platform = process.platform }
  // lib.dom types documentElement non-null, but a preload runs before the
  // document root exists.
  const root = document.documentElement as HTMLElement | null
  if (root === null) window.addEventListener('DOMContentLoaded', mark)
  else mark()
}

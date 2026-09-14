/** Browser-local shell preference; Host discovery decides whether the saved path is usable. */
const KEY = 'dsh.terminal.shell'

/**
 * Read the browser preference.
 * @returns the last selected shell path, or null when storage is unavailable.
 */
export function preferredShell(): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY) }
  catch (_storageUnavailable) { return null }
}

/**
 * Remember the selected shell without making storage a startup dependency.
 * @param path - verified executable path offered by the Host.
 */
export function rememberShell(path: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, path) }
  catch (_storageUnavailable) { /* Private browsing or quota failure leaves this launch usable. */ }
}

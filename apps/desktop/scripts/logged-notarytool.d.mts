/** Separate upload and Apple processing timings without replacing electron-notarize's qualification. */
/**
 * Run the requested Apple command, splitting submit --wait into submit --no-wait and wait.
 * @param args Arguments from the pinned electron-notarize library.
 * @param directory Existing packaging journal.
 * @param invoke Apple command executor.
 * @returns Final tool output consumed by electron-notarize; upload failure prevents waiting.
 */
export function runLoggedNotarytool(args: readonly string[], directory?: string, invoke?: (args: readonly string[]) => Promise<string>): Promise<string>

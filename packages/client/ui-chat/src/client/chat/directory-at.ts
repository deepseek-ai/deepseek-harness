/** Select the working directory that applied at one Session log position. */
import type { WorkingDirectoryHistoryEntry } from '@deepseek-ai/dsh-working-directory/client'

/**
 * Find the directory in effect for an event: the last history entry whose seq
 * precedes the event's seq.
 * @param history - Ascending directory history, or undefined while it is unavailable.
 * @param seq - Seq of the event whose recorded paths are being resolved.
 * @returns the absolute directory, or undefined when no entry precedes `seq`.
 */
export function directoryAt(history: readonly WorkingDirectoryHistoryEntry[] | undefined, seq: number): string | undefined {
  let found: string | undefined
  for (const entry of history ?? []) {
    if (entry.seq >= seq) break
    found = entry.cwd
  }
  return found
}

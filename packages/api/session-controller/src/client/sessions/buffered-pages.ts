/** Turn-aligned page cuts over buffered Session entries. */
import type { SessionEventLikeEntry, SessionLiveEventEntry } from '../contract/events.ts'

/** Minimum messages and Turn starts one page covers, as the Host pages history. */
export interface PageRule {
  readonly minMessages: number
  readonly minTurns: number
}

/**
 * Find where the last page of `entries` starts: the latest `turn/start` at or before which the page holds at least
 * `minMessages` user or assistant messages and crosses at least `minTurns` Turn starts.
 * @param entries - contiguous entries or wire records in seq order.
 * @param rule - page minima; absent minima make the whole range one page.
 * @returns index of the page's first entry; 0 when the whole range is one page.
 */
export function tailPageStart(
  entries: readonly { readonly event: { readonly type: string } }[],
  rule: PageRule | undefined,
): number {
  if (rule === undefined) return 0
  let messages = 0
  let turns = 0
  for (let index = entries.length - 1; index > 0; index--) {
    const type = entries[index]?.event.type
    if (type === 'user/message' || type === 'assistant/message') messages++
    if (type !== 'turn/start') continue
    turns++
    if (messages >= rule.minMessages && turns >= rule.minTurns) return index
  }
  return 0
}

/**
 * Whether a window entry is a durable event rather than a transient Assistant chunk.
 * @param entry - window entry.
 * @returns true for a durable event.
 */
export function isDurableEntry(entry: SessionEventLikeEntry): entry is SessionLiveEventEntry {
  return entry.type === 'event'
}

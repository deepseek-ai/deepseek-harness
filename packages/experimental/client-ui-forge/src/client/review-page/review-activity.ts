/**
 * The summary tab's activity helpers: its rows, with every run of commits as one, and which comment texts start cut
 * short.
 */

import type { ChangeRequestActivityItem } from '@deepseek-ai/dsh-experimental-forge/types'

/** A commit of the activity. */
export type ActivityCommit = Extract<ChangeRequestActivityItem, { readonly kind: 'commit' }>

/** An activity item other than a commit. */
export type ActivityEvent = Exclude<ChangeRequestActivityItem, ActivityCommit>

/**
 * One row of the activity: an item other than a commit, or the commits that follow one another. `key` tells the rows of
 * one activity apart and stays the same when a later read adds or drops other rows.
 */
export type ActivityEntry =
  | { readonly kind: 'commits'; readonly key: string; readonly commits: readonly [ActivityCommit, ...ActivityCommit[]] }
  | { readonly kind: 'item'; readonly key: string; readonly item: ActivityEvent }

/** Most characters of a comment text that shows whole from the start. */
const WHOLE_CHARACTERS = 400

/** Most lines of a comment text that shows whole from the start. */
const WHOLE_LINES = 6

/**
 * Lay the activity out as rows.
 * @param items - the activity, oldest first.
 * @returns the rows in the same order, with every run of consecutive commits as one row.
 */
export function activityEntries(items: readonly ChangeRequestActivityItem[]): readonly ActivityEntry[] {
  const entries: ActivityEntry[] = []
  const seen = new Map<string, number>()
  // Two rows of one kind, time, and actor differ by their count.
  const keyOf = (name: string): string => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return count === 0 ? name : `${name}#${count}`
  }
  let run: [ActivityCommit, ...ActivityCommit[]] | null = null
  for (const item of items) {
    if (item.kind !== 'commit') {
      run = null
      entries.push({ kind: 'item', key: keyOf(`${item.kind}:${item.at}:${item.actor?.login ?? ''}`), item })
    } else if (run === null) {
      run = [item]
      entries.push({ kind: 'commits', key: keyOf(`commits:${item.sha}`), commits: run })
    } else {
      run.push(item)
    }
  }
  return entries
}

/**
 * Whether a comment text starts cut short, with a control that shows the rest.
 * @param body - Markdown source of the comment.
 * @returns whether it is longer than the text that shows whole.
 */
export function longBody(body: string): boolean {
  return body.length > WHOLE_CHARACTERS || body.split('\n').length > WHOLE_LINES
}

/**
 * View-layer union of the host turn outline and the loaded rail items. The
 * conversation snapshot never carries projection values, so this merge is the
 * one place the rail's two sources meet: the `turnOutline` projection names
 * every turn of the session, and the loaded window supplies anchors and
 * richer previews for the turns it holds.
 */

import type {} from '@deepseek-ai/dsh-session-turn-outline/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TurnNavigationItem } from '../contract/snapshot.ts'

/** One rail mark: a loaded Turn scrolls to its row; an unloaded one pages history through its seq first. */
export interface TurnRailItem {
  readonly turn: number
  /** Bounded prompt preview (loaded window first, outline fallback). */
  readonly prompt: string
  /** Bounded response preview (loaded window first, outline fallback). */
  readonly response: string
  /** How the rail reaches the Turn. */
  readonly anchor:
    | { readonly kind: 'loaded'; readonly key: string }
    | { readonly kind: 'unloaded'; readonly seq: SessionSeq }
}

const EMPTY_ITEMS: readonly TurnRailItem[] = []

/**
 * Structurally narrow one wire outline entry (projection values cross the
 * wire). `turn` and `seq` are the load-bearing fields — a mark cannot exist
 * or jump without them — so their damage drops the entry; the previews are
 * decorative, so a malformed one degrades to `''` and the turn stays
 * navigable by number.
 */
function outlineEntry(value: unknown): { turn: number; seq: SessionSeq; prompt: string; response: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as { turn?: unknown; seq?: unknown; prompt?: unknown; response?: unknown }
  if (typeof entry.turn !== 'number' || !Number.isSafeInteger(entry.turn) || entry.turn < 0) return undefined
  if (typeof entry.seq !== 'number' || !Number.isSafeInteger(entry.seq) || entry.seq < 0 || Object.is(entry.seq, -0)) return undefined
  return {
    turn: entry.turn,
    seq: SessionSeq(entry.seq),
    prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
    response: typeof entry.response === 'string' ? entry.response : '',
  }
}

/** Wire outline entries, or none when the projection is absent or malformed. */
function outlineEntries(outline: unknown): readonly unknown[] {
  return Array.isArray(outline) ? outline : EMPTY_ITEMS
}

/**
 * Merge the host outline with the loaded rail items into the full ladder.
 * A turn present in both sides keeps the loaded anchor, taking an outline
 * preview only where the window's own is empty (a mid-Turn window head, or a
 * turn whose loaded nodes carry no text); turns on one side only pass
 * through. Result ascends by turn.
 * @param loaded - loaded-window rail items (timeline order).
 * @param outline - `turnOutline` projection value, treated as wire data.
 * @returns every known turn, ascending; a stable empty array when none.
 */
export function mergeTurnRailItems(
  loaded: readonly TurnNavigationItem[],
  outline: unknown,
): readonly TurnRailItem[] {
  const byTurn = new Map<number, TurnRailItem>()
  for (const raw of outlineEntries(outline)) {
    const entry = outlineEntry(raw)
    if (entry === undefined) continue
    byTurn.set(entry.turn, {
      turn: entry.turn,
      prompt: entry.prompt,
      response: entry.response,
      anchor: { kind: 'unloaded', seq: entry.seq },
    })
  }
  for (const item of loaded) {
    const preview = byTurn.get(item.turn)
    byTurn.set(item.turn, {
      turn: item.turn,
      prompt: item.prompt !== '' ? item.prompt : preview?.prompt ?? '',
      response: item.response !== '' ? item.response : preview?.response ?? '',
      anchor: { kind: 'loaded', key: item.anchorKey },
    })
  }
  if (byTurn.size === 0) return EMPTY_ITEMS
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn)
}

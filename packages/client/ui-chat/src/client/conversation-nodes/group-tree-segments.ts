import type { ChatConversationViewNode } from '../contract/chat-nodes.ts'
import { isAtOrOutside, type ChatGroupTree } from '../contract/group-tree.ts'
import { locationCoordinates } from './common.ts'

const NO_TURNS: readonly number[] = []

/**
 * Loaded Turns split into consecutive segments at the Turns holding a Node at
 * one group-tree position, visible or hidden. The latest segment starts at the
 * last such Turn, or at the first loaded Turn when none is loaded. Node changes
 * update per-Turn counts without scanning the loaded Nodes; `settle` returns at
 * once while the start holds and otherwise reads loaded Turns only from the
 * earlier of the previous and new starts.
 */
export class GroupTreeSegments {
  /** Opening Node count by owning Turn. */
  private readonly openings = new Map<number, number>()
  private latestOpening: number | undefined
  private latestStart: number | undefined

  /** @param position - group-tree position whose Nodes open a segment. */
  constructor(private readonly position: ChatGroupTree) {}

  /**
   * Account one Node change.
   * @param previous - replaced Node; absent for an addition.
   * @param next - replacing Node; absent for a removal.
   */
  track(previous: ChatConversationViewNode | undefined, next: ChatConversationViewNode | undefined): void {
    const before = this.openingTurn(previous)
    const after = this.openingTurn(next)
    if (before === after) return
    if (before !== undefined && this.adjust(before, -1) === 0 && before === this.latestOpening) {
      this.latestOpening = this.lastOpeningTurn()
    }
    if (after !== undefined) {
      this.adjust(after, 1)
      if (this.latestOpening === undefined || after > this.latestOpening) this.latestOpening = after
    }
  }

  /**
   * Test latest-segment membership as of the last `settle`.
   * @param turn - owning Turn, when resolved.
   * @returns whether the Turn belongs to the latest segment.
   */
  inLatest(turn: number | undefined): boolean {
    return turn !== undefined && this.latestStart !== undefined && turn >= this.latestStart
  }

  /**
   * Move the latest segment start for the currently loaded Turns.
   * @param turnOrder - loaded Turns in ascending timeline order.
   * @returns loaded Turns that entered or left the latest segment, in ascending order.
   */
  settle(turnOrder: readonly number[]): readonly number[] {
    const previous = this.latestStart
    const start = this.latestOpening ?? turnOrder[0]
    if (start === previous) return NO_TURNS
    this.latestStart = start
    const bounded = previous !== undefined && start !== undefined
    const low = bounded ? Math.min(previous, start) : Number.NEGATIVE_INFINITY
    const high = bounded ? Math.max(previous, start) : Number.POSITIVE_INFINITY
    const changed: number[] = []
    for (const turn of turnOrder.slice(turnOrder.findLastIndex(turn => turn < low) + 1)) {
      if (turn >= high) break
      changed.push(turn)
    }
    return changed
  }

  private openingTurn(node: ChatConversationViewNode | undefined): number | undefined {
    return node !== undefined && isAtOrOutside(node, this.position) ? locationCoordinates(node.location).turn : undefined
  }

  private lastOpeningTurn(): number | undefined {
    let last: number | undefined
    for (const turn of this.openings.keys()) {
      if (last === undefined || turn > last) last = turn
    }
    return last
  }

  /** @returns the Turn's opening count after the change; zero removes the Turn. */
  private adjust(turn: number, delta: number): number {
    const next = (this.openings.get(turn) ?? 0) + delta
    if (next > 0) this.openings.set(turn, next)
    else this.openings.delete(turn)
    return next
  }
}

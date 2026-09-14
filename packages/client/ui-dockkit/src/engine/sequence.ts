/**
 * Linear operation history over `applyOp`. Recording is total — every operation
 * lands in the sequence, focus moves included — and grouped by intent: the
 * operations one gesture or command produced form one entry, so stepping lands
 * on a point the user actually stopped at. Stepping is coarser still across
 * focus: a run of consecutive focus-only entries undoes and redoes as one step.
 *
 * Redoing re-applies the recorded operations; undoing applies the inverses that
 * were captured when they ran, so both directions stay exact. A new entry after
 * an undo drops the redo branch.
 *
 * Two shapes, one implementation. `record`/`stepBack`/`stepForward` are pure
 * functions over a plain `History`, which is what an embedder holding its layout
 * in an external store needs; `Sequencer` is a thin mutable wrapper over exactly
 * those functions, for an embedder that would rather hold the state here.
 */
import type { FocusOpType, LayoutOp, LayoutState } from '../contract/types.ts'
import { applyOp } from './operations.ts'

/** One recorded intent: its operations, and the operations that undo them all. */
export interface HistoryEntry {
  readonly ops: readonly LayoutOp[]
  /** Already ordered for application: the last operation's inverse comes first. */
  readonly inverse: readonly LayoutOp[]
}

/** A recorded sequence and how much of it is applied. Plain data, safe to store. */
export interface History {
  readonly entries: readonly HistoryEntry[]
  /** How many entries are applied; entries beyond it are the redo branch. */
  readonly cursor: number
}

/** A sequence that has recorded nothing. */
export const EMPTY_HISTORY: History = { entries: [], cursor: 0 }

/** A history and the state it produced, returned together so neither can drift. */
export interface HistoryStep {
  readonly history: History
  readonly state: LayoutState
}

/** Operation kinds that only move focus. */
const FOCUS_OP_TYPES: ReadonlySet<string> = new Set<FocusOpType>(['focusTab', 'focusPane', 'restoreFocus'])

/**
 * Whether an operation only moves focus, and so merges into its neighbours' undo step.
 * @param op - the operation.
 * @returns whether its type is a `FocusOpType`.
 */
export function isFocusOp(op: LayoutOp): boolean {
  return FOCUS_OP_TYPES.has(op.type)
}

/** Whether the entry at `index` only moves focus. */
function isFocusEntry(history: History, index: number): boolean {
  const entry = history.entries[index]
  return entry !== undefined && entry.ops.every(isFocusOp)
}

/**
 * Whether a step back exists.
 * @param history - the sequence so far.
 * @returns whether any entry is applied.
 */
export function canStepBack(history: History): boolean {
  return history.cursor > 0
}

/**
 * Whether a step forward exists.
 * @param history - the sequence so far.
 * @returns whether a redo branch remains.
 */
export function canStepForward(history: History): boolean {
  return history.cursor < history.entries.length
}

/**
 * The operations a sequence has recorded, redo branch included.
 * @param history - the sequence so far.
 * @returns every entry's operations, in recorded order.
 */
export function recordedOps(history: History): readonly LayoutOp[] {
  return history.entries.flatMap(entry => entry.ops)
}

/**
 * Apply one intent's operations and record them as one entry, dropping any redo
 * branch first. An intent with no operations records nothing.
 * @param history - the sequence so far.
 * @param state - the state the operations apply to.
 * @param ops - the intent's operations, in application order.
 * @returns the extended history and the state after the operations.
 * @throws when an operation is invalid against the state it reaches; nothing is
 *   recorded.
 */
export function record(history: History, state: LayoutState, ops: readonly LayoutOp[]): HistoryStep {
  if (ops.length === 0) return { history, state }
  let next = state
  const inverse: LayoutOp[] = []
  for (const op of ops) {
    const result = applyOp(next, op)
    next = result.state
    // Undo runs the inverses in reverse operation order.
    inverse.unshift(...result.inverse)
  }
  const kept = history.cursor === history.entries.length
    ? history.entries
    : history.entries.slice(0, history.cursor)
  return {
    history: { entries: [...kept, { ops, inverse }], cursor: history.cursor + 1 },
    state: next,
  }
}

/**
 * Step back one intent, or one whole run of consecutive focus-only intents.
 * @param history - the sequence so far.
 * @param state - the current state.
 * @returns the stepped-back pair, or `undefined` when nothing can be undone.
 */
export function stepBack(history: History, state: LayoutState): HistoryStep | undefined {
  if (!canStepBack(history)) return undefined
  let count = 1
  if (isFocusEntry(history, history.cursor - 1)) {
    while (isFocusEntry(history, history.cursor - 1 - count)) count += 1
  }
  let next = state
  for (const entry of history.entries.slice(history.cursor - count, history.cursor).reverse()) {
    for (const op of entry.inverse) next = applyOp(next, op).state
  }
  return { history: { entries: history.entries, cursor: history.cursor - count }, state: next }
}

/**
 * Step forward over the intents the matching step back undid.
 * @param history - the sequence so far.
 * @param state - the current state.
 * @returns the stepped-forward pair, or `undefined` when nothing can be redone.
 */
export function stepForward(history: History, state: LayoutState): HistoryStep | undefined {
  if (!canStepForward(history)) return undefined
  let count = 1
  if (isFocusEntry(history, history.cursor)) {
    while (isFocusEntry(history, history.cursor + count)) count += 1
  }
  let next = state
  for (const entry of history.entries.slice(history.cursor, history.cursor + count)) {
    for (const op of entry.ops) next = applyOp(next, op).state
  }
  return { history: { entries: history.entries, cursor: history.cursor + count }, state: next }
}

/** Layout state plus its history cursor, held here instead of by the embedder. */
export class Sequencer {
  private current: LayoutState
  private recorded: History = EMPTY_HISTORY

  /** @param initial - state the sequence replays from; never mutated. */
  constructor(initial: LayoutState) {
    this.current = initial
  }

  /** Current state. */
  get state(): LayoutState {
    return this.current
  }

  /** The recorded sequence as plain data. */
  get history(): History {
    return this.recorded
  }

  /** The whole recorded sequence, including a redo branch that is not applied. */
  get ops(): readonly LayoutOp[] {
    return recordedOps(this.recorded)
  }

  /** How many recorded operations are currently applied. */
  get cursor(): number {
    return this.recorded.cursor
  }

  /** Whether a step back exists. */
  get canUndo(): boolean {
    return canStepBack(this.recorded)
  }

  /** Whether a step forward exists. */
  get canRedo(): boolean {
    return canStepForward(this.recorded)
  }

  /**
   * Apply and record one operation as its own entry, dropping any redo branch first.
   * @param op - the operation to record.
   * @returns the state after it.
   * @throws when the operation is invalid against the current state; the
   *   sequence is left untouched.
   */
  dispatch(op: LayoutOp): LayoutState {
    return this.dispatchAll([op])
  }

  /**
   * Apply and record one intent's operations as one entry, dropping any redo
   * branch first.
   * @param ops - the intent's operations; none records nothing.
   * @returns the state after them.
   * @throws when an operation is invalid; the sequence is left untouched.
   */
  dispatchAll(ops: readonly LayoutOp[]): LayoutState {
    const stepped = record(this.recorded, this.current, ops)
    this.recorded = stepped.history
    this.current = stepped.state
    return this.current
  }

  /**
   * Step back one intent, or one whole run of consecutive focus-only intents.
   * @returns false when there is nothing to undo.
   */
  undo(): boolean {
    const stepped = stepBack(this.recorded, this.current)
    if (stepped === undefined) return false
    this.recorded = stepped.history
    this.current = stepped.state
    return true
  }

  /**
   * Step forward over the intents the matching undo stepped back.
   * @returns false when there is nothing to redo.
   */
  redo(): boolean {
    const stepped = stepForward(this.recorded, this.current)
    if (stepped === undefined) return false
    this.recorded = stepped.history
    this.current = stepped.state
    return true
  }
}

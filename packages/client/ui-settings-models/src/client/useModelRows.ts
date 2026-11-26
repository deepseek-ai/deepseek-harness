/** Local model-row identities, disclosures, capacity text, drag ordering, and the fields a refused save marked. */

import { useRef, useState } from 'react'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'

/** Text fields whose unfinished spelling belongs to one draft row. */
export type CapacityField = 'contextWindow' | 'maxTokens'

/** A part of a model row that a refused save can mark. */
export type ModelRowField = 'id' | 'name' | 'contextWindow' | 'maxTokens' | 'reasoning'

/**
 * What a card's refused saves ask of the list: `attempt` counts them, and
 * `failing` names, per row as currently drafted, the parts that fail.
 */
export interface ModelRowsCheck {
  attempt: number
  failing: readonly ReadonlySet<ModelRowField>[]
}

const UNMARKED: ReadonlySet<ModelRowField> = new Set()

interface RowState {
  key: number
  expanded: boolean
  editing: Map<CapacityField, string>
  /** The parts the last refused save found failing in this row. */
  marked: ReadonlySet<ModelRowField>
}

/** Drag state and actions for one model row within its editor. */
export interface ModelRowOrder {
  dragging: boolean
  target: 'before' | 'after' | undefined
  canDrop: boolean
  onStart: () => void
  onEnd: () => void
  onOver: (half: 'before' | 'after') => void
  onLeave: () => void
  onDrop: (half: 'before' | 'after') => void
}

interface ModelRows {
  rows: (RowState & { model: DeepSeekModelDraft; order: ModelRowOrder })[]
  /** Whether the list's section is unfolded. */
  listOpen: boolean
  setListOpen: (open: boolean) => void
  toggle: (index: number) => void
  edit: (index: number, field: CapacityField, text: string | undefined) => void
  forget: (removed: ReadonlySet<number>) => void
  reset: () => void
}

/**
 * The failures a row shows: those the last refused save marked that still fail.
 * @param marked - the parts that save found failing in the row.
 * @param failing - the row's current failures, each with its message key.
 * @returns the marked failures that still hold.
 */
export function shownFailures<Field extends ModelRowField, Key>(
  marked: ReadonlySet<ModelRowField>, failing: ReadonlyMap<Field, Key>,
): ReadonlyMap<Field, Key> {
  return new Map([...failing].filter(([field]) => marked.has(field)))
}

/** One editor-local identity; editing a model ID never replaces its controls. */
function createRow(key: number, expanded = false): RowState {
  return { key, expanded, editing: new Map(), marked: UNMARKED }
}

/** Whether a draft row has no model ID yet, which only its unfolded fields can supply. */
function unnamed(model: DeepSeekModelDraft): boolean {
  const id = model['id']
  return typeof id !== 'string' || id.length === 0
}

/**
 * Keep row state with its model through draft moves and removals. A row that
 * joins the draft without a model ID starts unfolded; every other row starts folded.
 * Each refused save marks the parts that fail on their rows, unfolds those rows
 * and the list, and clears the marks of the rows that pass; a mark stays with
 * its row until the next refused save.
 * @param models - current draft array, owned by the provider card.
 * @param onChange - replaces only that card's draft array.
 * @param disabled - prevents reordering while the card cannot be edited.
 * @param check - the card's refused-save count and the parts that currently fail.
 * @returns row state and local editing and ordering actions.
 */
export function useModelRows(
  models: readonly DeepSeekModelDraft[], onChange: (models: DeepSeekModelDraft[]) => void, disabled: boolean,
  check: ModelRowsCheck,
): ModelRows {
  const nextKey = useRef(0)
  const [stored, setRows] = useState(() => models.map(() => createRow(nextKey.current++)))
  const [dragged, setDragged] = useState<number>()
  const [target, setTarget] = useState<{ key: number; half: 'before' | 'after' }>()
  const entries = models.map((model, index) => ({ model, state: stored[index] ?? createRow(nextKey.current++, unnamed(model)) }))
  const rows = entries.map(entry => entry.state)
  const [listOpen, setListOpen] = useState(true)
  const [attempt, setAttempt] = useState(check.attempt)
  if (attempt !== check.attempt) {
    setAttempt(check.attempt)
    setRows(rows.map((row, index) => {
      const marked = check.failing[index] as ReadonlySet<ModelRowField>
      return marked.size === 0 ? { ...row, marked: UNMARKED } : { ...row, marked, expanded: true }
    }))
    if (check.failing.some(marked => marked.size > 0)) setListOpen(true)
  } else if (stored.length !== models.length) setRows(rows)

  const endDrag = (): void => { setDragged(undefined); setTarget(undefined) }
  const move = (from: number, to: number): void => {
    if (disabled || from === to || from < 0) return
    const order = [...entries]
    const moved = order.splice(from, 1)
    order.splice(to, 0, ...moved)
    setRows(order.map(entry => entry.state))
    onChange(order.map(entry => entry.model))
  }

  return {
    rows: entries.map(({ model, state }, index) => ({
      ...state,
      model,
      order: {
        dragging: dragged === state.key,
        target: target?.key === state.key ? target.half : undefined,
        canDrop: !disabled && dragged !== undefined,
        onStart: (): void => { setDragged(state.key) },
        onEnd: endDrag,
        onOver: (half): void => {
          setTarget(current => current?.key === state.key && current.half === half ? current : { key: state.key, half })
        },
        onLeave: (): void => { setTarget(current => current?.key === state.key ? undefined : current) },
        onDrop: (half): void => {
          const from = rows.findIndex(row => row.key === dragged)
          const insertion = index + (half === 'after' ? 1 : 0)
          move(from, insertion > from ? insertion - 1 : insertion)
          endDrag()
        },
      },
    })),
    listOpen,
    setListOpen,
    toggle: (index: number): void => {
      setRows(rows.map((row, at) => at === index ? { ...row, expanded: !row.expanded } : row))
    },
    edit: (index: number, field: CapacityField, text: string | undefined): void => {
      setRows(rows.map((row, at) => {
        if (at !== index) return row
        const editing = new Map(row.editing)
        if (text === undefined) editing.delete(field)
        else editing.set(field, text)
        return { ...row, editing }
      }))
    },
    forget: (removed: ReadonlySet<number>): void => {
      setRows(rows.filter((_row, index) => !removed.has(index)))
      endDrag()
    },
    reset: (): void => { setRows(models.map(() => createRow(nextKey.current++))); endDrag() },
  }
}

/** Local model-row identities, disclosures, capacity text, and draft ordering. */

import { useRef, useState } from 'react'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'

/** Text fields whose unfinished spelling belongs to one draft row. */
export type CapacityField = 'contextWindow' | 'maxTokens'

interface RowState {
  key: number
  expanded: boolean
  editing: Map<CapacityField, string>
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
  onMove: (offset: -1 | 1) => void
}

interface ModelRows {
  rows: (RowState & { model: DeepSeekModelDraft; order: ModelRowOrder })[]
  toggle: (index: number) => void
  edit: (index: number, field: CapacityField, text: string | undefined) => void
  forget: (removed: ReadonlySet<number>) => void
  reset: () => void
}

/** One editor-local identity; editing a model ID never replaces its controls. */
function createRow(key: number): RowState {
  return { key, expanded: false, editing: new Map() }
}

/**
 * Keep row state with its model through draft moves and removals.
 * @param models - current draft array, owned by the provider card.
 * @param onChange - replaces only that card's draft array.
 * @param disabled - prevents reordering while the card cannot be edited.
 * @returns row state and local editing and ordering actions.
 */
export function useModelRows(
  models: readonly DeepSeekModelDraft[], onChange: (models: DeepSeekModelDraft[]) => void, disabled: boolean,
): ModelRows {
  const nextKey = useRef(0)
  const [stored, setRows] = useState(() => models.map(() => createRow(nextKey.current++)))
  const [dragged, setDragged] = useState<number>()
  const [target, setTarget] = useState<{ key: number; half: 'before' | 'after' }>()
  const entries = models.map((model, index) => ({ model, state: stored[index] ?? createRow(nextKey.current++) }))
  const rows = entries.map(entry => entry.state)
  if (stored.length !== models.length) setRows(rows)

  const endDrag = (): void => { setDragged(undefined); setTarget(undefined) }
  const move = (from: number, to: number): void => {
    if (disabled || from === to || from < 0 || to < 0 || to >= models.length) return
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
        onMove: (offset: -1 | 1): void => { move(index, index + offset) },
      },
    })),
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

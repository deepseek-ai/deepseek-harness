/** Native selection geometry and gestures of a read-only document. */
import { useCallback, useRef, useState, type MouseEvent } from 'react'
import type { OfficeInteractionContext, OfficePointerInput } from './interaction.ts'
import type { OfficeSelectionCommand } from '../types.ts'
import { parseCallbackRectangle, parseCellCursor, parseGraphicSelection } from './selection.ts'
import type { Rect } from '../types.ts'
import { contentPoint } from './content-view.ts'
import css from './Selection.module.css'

interface OfficePointer {
  op: 'mouse'
  type: 0 | 1 | 2
  x: number
  y: number
  count: number
  buttons: number
  modifiers: number
}

/** Navigation keys accepted by a read-only native document. */
export const selectionNavigationKeys: Record<string, number> = {
  ArrowDown: 1024, ArrowUp: 1025, ArrowLeft: 1026, ArrowRight: 1027,
  Home: 1028, End: 1029, PageUp: 1030, PageDown: 1031, Escape: 1281, Tab: 1282,
}
/**
 * Bind native selection callbacks and gestures; plain read-only drags replace an existing range.
 * @param context - Mounted document and ordered request queue.
 * @param focus - Focus the preview keyboard target without scrolling.
 * @returns Selection geometry, overlay and gesture handlers.
 */
export function useOfficeSelection(context: OfficeInteractionContext, focus: () => void) {
  const { documentType, request, send, inputQueue, busy, action, failAction, renderFailure,
    playing, settling, playbackTransition, contentView } = context
  const [selection, setSelection] = useState<Rect[]>([])
  const [cellCursor, setCellCursor] = useState<Rect>()
  const [graphicSelection, setGraphicSelection] = useState<Rect>()
  const [pointerStyle, setPointerStyle] = useState('default')
  const pressed = useRef<OfficePointer>(undefined)
  const command = useCallback(
    (command: OfficeSelectionCommand['command'], arguments_: OfficeSelectionCommand['arguments'] = {}) => send.command({ command, arguments: arguments_ }), [send],
  )
  const callback = (event: { type?: number; payload?: string }): void => {
    const payload = event.payload ?? ''
    if (event.type === 17) setCellCursor(parseCellCursor(payload))
    if (event.type === 6) setGraphicSelection(parseGraphicSelection(payload))
    if (event.type === 2) setSelection(payload.split(';').map(parseCallbackRectangle).filter((value): value is Rect => value !== undefined))
    if (event.type === 18) setPointerStyle(payload)
  }
  const pointer = (event: OfficePointerInput, type: 0 | 1 | 2): void => {
    if (settling.current || playbackTransition.current !== undefined || renderFailure !== undefined) return
    if (playing) {
      if (type === 1) action(() => send.presentation({ action: 'next' }))
      return
    }
    event.preventDefault()
    if (type === 0) focus()
    const bounds = event.currentTarget.getBoundingClientRect(),
      view = contentView()
    if (view === undefined) return
    const point = contentPoint(view, bounds, event.clientX, event.clientY)
    const held = pressed.current
    if (type === 1 && held === undefined) return
    const value: OfficePointer = {
      op: 'mouse',
      type,
      x: Math.max(0, Math.round(point.x)),
      y: Math.max(0, Math.round(point.y)),
      count: Math.min(3, event.detail || 1),
      buttons: type !== 0 && held !== undefined ? held.buttons
        : (event.buttons & 1) | ((event.buttons & 2) << 1) | ((event.buttons & 4) >> 1),
      modifiers: (event.shiftKey ? 4096 : 0) | (event.ctrlKey || event.metaKey ? 8192 : 0) | (event.altKey ? 16384 : 0),
    }
    if (type === 0 || (type === 2 && held !== undefined)) pressed.current = value
    if (type === 1) pressed.current = undefined
    if (type === 2)
      inputQueue.current.move(
        () => request.input(value),
        failAction,
      )
    else if (type === 0 && value.buttons === 1 && value.count === 1 && value.modifiers === 0
      && selection.some(rectangle => (documentType === 'text' || value.x >= rectangle.x)
        && value.x < rectangle.x + rectangle.width
        && value.y >= rectangle.y && value.y < rectangle.y + rectangle.height)) {
      // Writer also snaps a press in the left indent to the first character of the selected line.
      action(() => inputQueue.current.send(async () => {
        await request.input(value)
        await request.input({ ...value, type: 1 })
        await request.input(value)
      }))
    } else action(() => send.input(value))
  }
  const cancelPointer = (): void => {
    const held = pressed.current
    pressed.current = undefined
    if (held !== undefined && !settling.current && renderFailure === undefined)
      action(() => send.input({ ...held, type: 1 }))
  }
  const selectHeader = (range?: string): void => {
    if (busy || settling.current || renderFailure !== undefined) return
    action(() => range === undefined ? inputQueue.current.send(async () => {
      // Calc may select the current data region first; a second native SelectAll selects the sheet.
      await request.command({ command: 'SelectAll', arguments: {} })
      await request.command({ command: 'SelectAll', arguments: {} })
    }) : command('GoToCell', { ToPoint: { type: 'string', value: range } }))
    focus()
  }
  const onHeaderClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (target instanceof HTMLButtonElement && target.dataset.range !== undefined) selectHeader(target.dataset.range)
  }
  const positioned = (rectangle: Rect): { left: string; top: string; width: string; height: string } => ({
    left: `calc(${rectangle.x}px * var(--office-content-scale))`,
    top: `calc(${rectangle.y}px * var(--office-content-scale))`,
    width: `max(1px, calc(${rectangle.width}px * var(--office-content-scale)))`,
    height: `max(1px, calc(${rectangle.height}px * var(--office-content-scale)))`,
  })
  const editingPointer = pointerStyle === 'move' || pointerStyle === 'grab' || pointerStyle === 'grabbing' || pointerStyle.endsWith('-resize')
  const cursor = playing || editingPointer ? 'default' : pointerStyle
  return {
    callback, pointer, cancelPointer, selectHeader, headerClick: onHeaderClick, cursor,
    reset: () => {
      pressed.current = undefined
      setCellCursor(undefined); setGraphicSelection(undefined); setSelection([])
    },
    overlay: documentType !== undefined && !playing ? (
      <div className={css.selectionLayer}>
        {selection.map((rectangle, index) => (
          <div key={index} data-office-selection className={css.selection} style={positioned(rectangle)} />
        ))}
        {cellCursor !== undefined && <div className={css.selectionOutline}
          data-office-cell-cursor style={positioned(cellCursor)} />}
        {graphicSelection !== undefined && <div className={css.selectionOutline} data-office-graphic-selection
          style={positioned(graphicSelection)} />}
      </div>
    ) : null,
  }
}
/**
 * Copy the native selection with plain text and HTML formatting.
 * @param request - Request function called inside the owner's ordered input queue.
 * @returns Completion of the clipboard write.
 */
export async function copyOfficeSelection(request: OfficeInteractionContext['request']): Promise<void> {
  const [plain, html] = await Promise.all([
    request.selection('text/plain;charset=utf-8'), request.selection('text/html'),
  ])
  await navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([plain.text], { type: 'text/plain' }),
    'text/html': new Blob([html.text], { type: 'text/html' }),
  })])
}

/** The Chat View's aside layer: one Session-level occupant beside the transcript, given the end gutter it keeps within. */
import { memo, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatAsideOwnerProps } from '../contract/slots.ts'
import css from './ChatView.module.css'

/**
 * Follow the end gutter from the widths a ResizeObserver reports for the
 * layer, which spans the Chat frame, and for the transcript column, which
 * covers window and sidebar resizes and a dragged column width. The column
 * is centered in the frame, so the gutter is half their difference; no
 * element geometry is read. Without ResizeObserver the gutter stays zero.
 * @param layer - the aside layer, a child of the Chat frame that precedes the transcript column.
 * @returns the gutter in whole CSS px, zero until both widths are known.
 */
function useEndGutter(layer: RefObject<HTMLElement>): number {
  const [gutter, setGutter] = useState(0)
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    // The frame's DOM is in place, though its own refs attach after this child's layout effect.
    const layerElement = layer.current as HTMLElement
    const column = (layerElement.parentElement as HTMLElement).querySelector('[data-chat-flow]') as HTMLElement
    let layerWidth: number | undefined
    let columnWidth: number | undefined
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === layerElement) layerWidth = entry.contentRect.width
        else columnWidth = entry.contentRect.width
      }
      if (layerWidth === undefined || columnWidth === undefined) return
      setGutter(Math.max(0, Math.round((layerWidth - columnWidth) / 2)))
    })
    observer.observe(layerElement)
    observer.observe(column)
    return () => { observer.disconnect() }
  }, [layer])
  return gutter
}

/**
 * Render the aside layer with its occupant. The Chat View's `renderSlot` is
 * stable per registration, so the layer re-renders only when the gutter
 * changes, not with every transcript update.
 * @param props - the Chat View's slot renderer.
 * @returns the zero-height aside layer.
 */
export const ChatAside = memo(function ChatAside({ renderSlot }: Pick<PropsRenderSlots<'conversation.chat.aside'>, 'renderSlot'>) {
  const layer = useRef<HTMLDivElement>(null)
  const endGutter = useEndGutter(layer)
  const owner = useMemo((): ChatAsideOwnerProps => ({ endGutter }), [endGutter])
  return <div ref={layer} className={css.asideSlot} data-chat-aside="">{renderSlot('conversation.chat.aside', owner)}</div>
})

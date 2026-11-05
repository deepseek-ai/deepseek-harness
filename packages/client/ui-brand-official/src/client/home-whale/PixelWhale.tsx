/** Home frame layer: a decorative canvas below the Conversation content, played by clicks on blank home space. */
import { useCallback, useRef, type MouseEvent, type ReactNode } from 'react'
import type { HeroFrameOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import atlasUrl from '../assets/breach-atlas.webp'
import { WHALE_ARTWORK } from './artwork.ts'
import { attachPixelWhale, type PixelWhaleHandle } from './renderer.ts'
import css from './PixelWhale.module.css'

/** Interactive descendants whose clicks belong to the control, not to blank home space. */
const CONTROLS = 'button, a, input, textarea, select, label, [contenteditable], [role="button"], [role="dialog"], [role="menu"], [role="listbox"], [data-composer-card]'

/** Frame owner state and the wrapped content. */
export type PixelWhaleProps = HeroFrameOwnerProps & { children: ReactNode }

/**
 * Classify a click that bubbled to the frame. React bubbles portaled overlays through their React parent, so a
 * target outside the frame's DOM subtree is excluded. A click that ends a text selection made inside the frame is
 * not a blank click; a selection elsewhere in the document does not block playback.
 * @param event - the click observed on the frame.
 * @returns whether the click is a primary click on blank home space.
 */
function isBlankClick(event: MouseEvent<HTMLDivElement>): boolean {
  // React reports element targets; text-node targets resolve to their parent element.
  const target = event.target as Element
  const frame = event.currentTarget
  const selection = window.getSelection()
  return event.button === 0
    && frame.contains(target)
    && target.closest(CONTROLS) === null
    && !(selection !== null && !selection.isCollapsed && frame.contains(selection.anchorNode))
}

/**
 * Wrap the Conversation scroll body; while the home is shown, paint the whale canvas below the Conversation content.
 * @param props - the home state and the wrapped scroll body.
 * @returns a layout-neutral frame around the children.
 */
export function PixelWhale({ hero, children }: PixelWhaleProps) {
  const whale = useRef<PixelWhaleHandle | undefined>(undefined)
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    whale.current?.dispose()
    whale.current = canvas === null ? undefined : attachPixelWhale(canvas, WHALE_ARTWORK, atlasUrl)
  }, [])
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (whale.current !== undefined && isBlankClick(event)) whale.current.play()
  }
  return (
    <div className={css.layer} onClick={onClick}>
      {hero && <canvas ref={canvasRef} className={css.canvas} data-home-whale="" aria-hidden="true" />}
      {children}
    </div>
  )
}

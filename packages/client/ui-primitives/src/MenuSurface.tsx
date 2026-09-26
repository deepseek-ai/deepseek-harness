/** Shared menu material and the macOS backing that lets Chromium blur transparent windows. */
import { forwardRef, useId, useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import css from './MenuSurface.module.css'

/** Menu containers preserve native div props and refs. */
export interface MenuSurfaceProps extends ComponentPropsWithoutRef<'div'> {
  /** Match the shared compact menu's smaller outer radius. */
  compact?: boolean
}

/**
 * Paint a menu and, on macOS, an opaque backing behind the page content within its bounds.
 * CSS anchors keep each backing aligned during placement, resizing, and nested-menu movement.
 * @param props - Div content and placement, and compact geometry.
 * @param ref - The visible menu div, excluding the non-interactive backing.
 * @returns Menu content plus a backing portal removed with the menu.
 */
export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface({
  compact = false, className, style, children, ...props
}, ref) {
  const id = useId()
  const backingRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // Nested React portals can insert the backing before its anchor. CSS anchor
    // positioning requires the anchor to precede the positioned element.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- The portal ref is attached before layout effects run.
    document.body.appendChild(backingRef.current!)
  }, [])
  const anchorStyle: CSSProperties & { '--dsh-menu-anchor': string } = {
    '--dsh-menu-anchor': `--dsh-menu-${id.replaceAll(':', '')}`,
  }
  return <>
    <div {...props} ref={ref} data-menu-material="translucent"
      className={clsx(css.surface, compact && css.compact, className)} style={{ ...style, ...anchorStyle }}>
      <div aria-hidden="true" className={css.material} />
      {children}
    </div>
    {createPortal(
      <div ref={backingRef} aria-hidden="true" data-menu-backing="" className={clsx(css.backing, compact && css.compact)}
        style={{ ...anchorStyle, visibility: style?.visibility }} />,
      document.body,
    )}
  </>
})

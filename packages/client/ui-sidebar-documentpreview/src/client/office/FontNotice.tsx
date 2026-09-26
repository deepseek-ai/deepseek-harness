/** Toolbar warning and non-modal details for the current preview’s missing fonts. */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCloseOutlineRegular, IconWarningTriangleOutlineRegular, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import common from '../TextPreview.module.css'
import css from './FontNotice.module.css'

/** Notice inputs supplied by the document owner and Office locale registration. */
export type FontNoticeProps = PropsLocale<'sidebarOffice'> & {
  readonly fonts: readonly string[]
}

/**
 * Show a warning while fonts are unavailable for the current preview.
 * @param props - missing font families and localized copy.
 * @returns a warning button and its anchored details, or nothing when fonts are available.
 */
export function FontNotice({ fonts, t }: FontNoticeProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const open = fonts.length > 0 && expanded
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const position = useAnchoredPosition({ open, anchorRef: anchor, panelRef: panel, gap: 8, margin: 12 })
  useDismissOnOutsidePointer(anchor, open, () => { setExpanded(false) }, panel)
  const closeDetails = (): void => {
    setExpanded(false)
    anchor.current?.querySelector('button')?.focus()
  }
  const positioned = position !== null
  useLayoutEffect(() => {
    if (!open || !positioned) return
    panel.current?.focus()
  }, [open, positioned])
  if (fonts.length === 0) return null
  const label = t('viewMissingFonts', { count: fonts.length })
  return <>
    <Tooltip label={label} side="bottom" delayMs={500} disabled={open}>
      <span ref={anchor} className={css.anchor} data-office-font-warning>
        <button type="button" className={clsx(common.tool, css.warning)} aria-label={label}
          aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
          onClick={() => { setExpanded(value => !value) }}>
          <IconWarningTriangleOutlineRegular />
        </button>
      </span>
    </Tooltip>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`} tabIndex={-1} className={css.panel}
      style={{ ...position, visibility: position === null ? 'hidden' : undefined }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDetails() } }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)
          && !anchor.current?.contains(event.relatedTarget)) setExpanded(false)
      }}>
      <div className={css.panelHeader}>
        <h3 id={`${id}-title`}>{t('missingFontsTitle')}</h3>
        <Button size="sm" aria-label={t('closeDetails')} onClick={closeDetails} icon={<IconCloseOutlineRegular />} />
      </div>
      <p id={`${id}-description`} className={css.description}>{t('missingFontsDescription')}</p>
      <p className={css.count}>{t('missingFontsCount', { count: fonts.length })}</p>
      <ul className={css.fonts}>{fonts.map(font => <li key={font}>{font}</li>)}</ul>
    </div>, document.body)}
  </>
}

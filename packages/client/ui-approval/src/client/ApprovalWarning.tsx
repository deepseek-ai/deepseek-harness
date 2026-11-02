/** Click-open risk explanation that keeps the pending approval unanswered. */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, IconCloseOutlineRegular, IconWarningOutlineRegular, MenuSurface, Tag,
  useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalCardInput } from './contract/slots.ts'
import css from './ApprovalPanel.module.css'

/**
 * Present caller-owned risks beside the decision without opening on hover.
 * @param props Localized warning content and close-button label.
 * @returns The warning tag and its dismissible, nonmodal popover.
 */
export function ApprovalWarning({ warning, closeLabel }: {
  warning: NonNullable<ApprovalCardInput['warning']>
  closeLabel: string
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const titleId = useId()
  const position = useAnchoredPosition({
    open, anchorRef: anchor, panelRef: panel, side: 'top', align: 'end', gap: 8, margin: 12,
  })
  useDismissOnOutsidePointer(anchor, open, setOpen, panel)
  const close = () => { setOpen(false); anchor.current?.focus() }
  const positioned = position !== null
  useEffect(() => {
    if (!open || !positioned) return
    panel.current?.focus()
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      anchor.current?.focus()
    }
    document.addEventListener('keydown', dismiss, true)
    return () => { document.removeEventListener('keydown', dismiss, true) }
  }, [open, positioned])
  return <>
    <Button ref={anchor} size="sm" className={css.warningTrigger} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { setOpen(value => !value) }}>
      <Tag tone="warning" className={css.warningTag}>
        <IconWarningOutlineRegular size={14} />{warning.label}
      </Tag>
    </Button>
    {open && createPortal(
      <MenuSurface ref={panel} id={id} role="dialog" aria-labelledby={titleId} tabIndex={-1}
        className={css.warningPopover} data-positioned={position !== null || undefined} style={position ?? undefined}>
        <div className={css.warningHeader}>
          <h3 id={titleId}>{warning.title}</h3>
          <Button size="sm" aria-label={closeLabel} onClick={close} icon={<IconCloseOutlineRegular />} />
        </div>
        {warning.detail.split('\n\n').map(paragraph => <p key={paragraph}>{paragraph}</p>)}
      </MenuSurface>, document.body,
    )}
  </>
}

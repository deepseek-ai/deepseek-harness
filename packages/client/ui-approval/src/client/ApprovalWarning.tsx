/** Formatted hover notice that keeps the pending approval unanswered. */
import { useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, IconWarningOutlineRegular, MenuSurface, Tag,
  isBehindModal, observeComposition, useDismissOnOutsidePointer, usePointerGrace,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalCardInput } from './contract/slots.ts'
import css from './ApprovalPanel.module.css'

/**
 * Present caller-owned risks on hover, keyboard focus, or touch activation.
 * @param props Localized warning content.
 * @returns The warning tag and its readable, nonmodal hover card.
 */
export function ApprovalWarning({ warning }: {
  warning: NonNullable<ApprovalCardInput['warning']>
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const titleId = useId()
  const anchorName = `--dsh-approval-warning-${id.replaceAll(':', '')}`
  useDismissOnOutsidePointer(anchor, open, setOpen, panel)
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(() => {
    if (anchor.current?.matches(':focus-visible')
      || (panel.current?.contains(document.activeElement) && document.activeElement?.matches(':focus-visible'))) return
    setOpen(false)
  })
  const show = () => {
    if (isBehindModal(anchor.current)) return
    cancelClose()
    setOpen(true)
  }
  const enter = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch' || !window.matchMedia('(any-hover: hover)').matches) return
    show()
  }
  const leave = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'touch') armClose()
  }
  const blur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && (anchor.current?.contains(next) || panel.current?.contains(next))) return
    cancelClose()
    setOpen(false)
  }
  useEffect(() => {
    if (!open) return
    const composition = observeComposition(document)
    const close = () => { cancelClose(); setOpen(false) }
    const focusOutside = (event: Event) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !panel.current?.contains(event.target)) close()
    }
    const visibilityChanged = () => { if (document.visibilityState === 'hidden') close() }
    const dismiss = (event: KeyboardEvent) => {
      if (composition.guards(event) || isBehindModal(anchor.current) || event.defaultPrevented
        || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      cancelClose()
      if (panel.current?.contains(document.activeElement)) anchor.current?.focus()
      setOpen(false)
    }
    document.addEventListener('keydown', dismiss, true)
    document.addEventListener('focusin', focusOutside)
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('keydown', dismiss, true)
      document.removeEventListener('focusin', focusOutside)
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('blur', close)
      composition.dispose()
    }
  }, [open, cancelClose])
  return <>
    <Button ref={anchor} size="sm" className={css.warningTrigger} style={{ anchorName }} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={show}
      onPointerEnter={enter} onPointerLeave={leave}
      onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) show() }} onBlur={blur}>
      <Tag tone="warning" className={css.warningTag}>
        <IconWarningOutlineRegular size={12} />{warning.label}
      </Tag>
    </Button>
    {open && createPortal(
      <MenuSurface ref={panel} id={id} role="dialog" aria-labelledby={titleId} tabIndex={-1}
        className={css.warningPopover} style={{ positionAnchor: anchorName }}
        onPointerEnter={enter} onPointerLeave={leave} onFocus={cancelClose} onBlur={blur}>
        <h3 id={titleId} className={css.warningTitle}>{warning.title}</h3>
        {warning.detail.split('\n\n').map(paragraph => <p key={paragraph}>{paragraph}</p>)}
      </MenuSurface>, document.body,
    )}
  </>
}

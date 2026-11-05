import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject, SyntheticEvent } from 'react'
import clsx from 'clsx'
import { createPortal } from 'react-dom'
import { writeClipboard } from './clipboard.ts'
import { usePointerGrace } from './pointer-grace.ts'
import { overlayTopMargin } from './overlay-top-margin.ts'
import { HoverCardGroupContext } from './HoverCardGroup.tsx'
import css from './HoverCard.module.css'

/** Preview opacity transition and retained lifetime during dismissal. */
const PREVIEW_FADE_MS = 100
const PREVIEW_MAX_HEIGHT = 420
const PREVIEW_INSET = 24
const INLINE_PREVIEW_WIDTH = 300
const ANCHOR_GAP = 8
const VIEWPORT_MARGIN = 8

interface CardPosition {
  left: number
  top: number
  width?: number
  maxWidth?: number
  maxHeight?: number
  bridge?: { left: number; top: number; width: number; height: number }
}

/**
 * Render an anchor with a hover-triggered preview card independently of nested tooltips.
 * Touch entry does not open a preview or intercept the anchor's action.
 * @param props.anchor - the hover target (rendered in place inside a wrapper span).
 * @param props.content - card content; the pointer may rest on it, so it is
 * readable and selectable, but it carries no dismissal affordance of its own.
 * @param props.openDelayMs - hover dwell before the card shows (default 500).
 * @param props.variant - compact card beside the anchor, or a preview above/below it
 * with 24px side insets, a 420px height cap, the frame-top clearance (capped below an anchor inside the top strip),
 * and 100ms opacity transitions.
 * @param props.widthAnchorRef - optional element whose width and horizontal position size the preview.
 * @param props.inline - keep the anchor in prose; show a contained preview on hover or keyboard focus.
 * Its hover region connects the anchor and preview across the visual gap.
 * @param props.fitContent - size an inline card to its content within the usual width cap.
 * @param props.disabled - suppress opening; turning true dismisses an open card.
 * @param props.grouped - share first-display dwell across the surrounding list and active portal.
 * Group replacement removes the previous card immediately, including a fading preview.
 * @param props.copyText - optional primary value copied by activation and
 * included in the card's accessible name.
 * @param props.copyLabel - localized accessible activation-label prefix.
 * @param props.copiedLabel - localized visible success label.
 * @returns anchor wrapper with the conditional portaled card.
 */
export function HoverCard({
  anchor, content, openDelayMs = 500, disabled = false, grouped = false,
  copyText, copyLabel, copiedLabel, variant = 'compact', widthAnchorRef, inline = false, fitContent = false,
}: {
  anchor: ReactNode
  /** Inline media preview using the shared menu material and keyboard focus. */
  inline?: boolean
  fitContent?: boolean
  content: ReactNode
  openDelayMs?: number
  disabled?: boolean
  grouped?: boolean
  variant?: 'compact' | 'preview'
  widthAnchorRef?: RefObject<HTMLElement | null>
} & ({ copyText?: string | undefined; copyLabel: string; copiedLabel: string } | {
  copyText?: undefined
  copyLabel?: string
  copiedLabel?: string
})) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const portalRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyHeightRef = useRef<number | null>(null)
  const copyEpochRef = useRef(0)
  const copyingRef = useRef(false)
  const mountedRef = useRef(true)
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed')
  const open = phase !== 'closed'
  const closing = phase === 'closing'
  const [pos, setPos] = useState<CardPosition | null>(null)
  const positioned = pos !== null
  const [copied, setCopied] = useState(false)
  const parentGroup = useContext(HoverCardGroupContext)
  const group = grouped ? parentGroup : null
  const [groupOwner] = useState(() => Symbol('hover-card'))

  const clearCopied = useCallback(() => {
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    copyHeightRef.current = null
    setCopied(false)
  }, [])

  const close = useCallback(() => {
    copyEpochRef.current += 1
    clearCopied()
    setPhase(current => variant === 'preview' && current !== 'closed' ? 'closing' : 'closed')
  }, [clearCopied, variant])

  const { arm: armClose, cancel: cancelClose } = usePointerGrace(close)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const dismissImmediately = useCallback(() => {
    clearTimer()
    cancelClose()
    copyEpochRef.current += 1
    clearCopied()
    setPhase('closed')
  }, [clearTimer, cancelClose, clearCopied])
  // A fading preview still owns the group's visible card until it unmounts or another card replaces it.
  const groupVisible = open && positioned
  useLayoutEffect(() => {
    if (!groupVisible || group === null) return
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- The visible portal's ref is attached before layout effects.
    group.shown(groupOwner, dismissImmediately, portalRef.current!)
    return () => { group.release(groupOwner) }
  }, [group, groupOwner, groupVisible, dismissImmediately])

  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => { setPhase('closed') }, PREVIEW_FADE_MS)
    return () => { clearTimeout(timer) }
  }, [closing])

  // Owner disabling mid-hover (menu opened, drag started) starts dismissal.
  useEffect(() => {
    if (!disabled) return
    clearTimer()
    cancelClose()
    close()
  }, [disabled, cancelClose, close])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      copyEpochRef.current += 1
      clearTimer()
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!open || (variant !== 'preview' && !inline)) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (inline) event.stopPropagation()
      clearTimer()
      cancelClose()
      close()
    }
    window.addEventListener('keydown', dismiss, inline)
    return () => { window.removeEventListener('keydown', dismiss, inline) }
  }, [open, variant, inline, cancelClose, close])

  // Fixed-position from the anchor rect before paint; track the anchor while
  // open (capture-phase scroll catches nested panes), as in Menu portal mode.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const wrapper = rootRef.current
      /* v8 ignore next -- the ref is attached before the layout effect runs and the listeners die with it. */
      if (wrapper === null) return
      if (wrapper.closest('[inert], [hidden]') !== null) {
        dismissImmediately()
        return
      }
      const r = wrapper.getBoundingClientRect()
      const h = cardRef.current?.offsetHeight ?? 0
      if (variant === 'preview') {
        const bounds = widthAnchorRef?.current?.getBoundingClientRect() ?? r
        const width = Math.max(0, Math.min(bounds.width - PREVIEW_INSET * 2, window.innerWidth - VIEWPORT_MARGIN * 2))
        const topMargin = overlayTopMargin(VIEWPORT_MARGIN, r, ANCHOR_GAP)
        const belowTop = Math.max(topMargin, r.bottom + ANCHOR_GAP)
        const above = Math.max(0, r.top - ANCHOR_GAP - topMargin)
        const below = Math.max(0, window.innerHeight - belowTop - VIEWPORT_MARGIN)
        const onTop = above >= Math.min(PREVIEW_MAX_HEIGHT, below)
        const maxHeight = Math.min(PREVIEW_MAX_HEIGHT, onTop ? above : below)
        setPos({
          left: Math.max(VIEWPORT_MARGIN, Math.min(bounds.left + PREVIEW_INSET, window.innerWidth - width - VIEWPORT_MARGIN)),
          top: onTop ? Math.max(topMargin, r.top - Math.min(h, maxHeight) - ANCHOR_GAP) : belowTop,
          width, maxHeight,
        })
        return
      }
      if (inline) {
        const height = Math.max(h, cardRef.current?.scrollHeight ?? 0)
        const maxWidth = Math.max(0, Math.min(INLINE_PREVIEW_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2))
        const width = fitContent ? Math.min(cardRef.current?.offsetWidth ?? maxWidth, maxWidth) : maxWidth
        const topMargin = overlayTopMargin(VIEWPORT_MARGIN, r, ANCHOR_GAP)
        const belowTop = Math.max(topMargin, r.bottom + ANCHOR_GAP)
        const above = Math.max(0, r.top - ANCHOR_GAP - topMargin)
        const below = Math.max(0, window.innerHeight - belowTop - VIEWPORT_MARGIN)
        const onTop = height > below && above > below
        const maxHeight = onTop ? above : below
        const left = Math.max(VIEWPORT_MARGIN, Math.min(r.left, window.innerWidth - width - VIEWPORT_MARGIN))
        const top = onTop ? r.top - ANCHOR_GAP - Math.min(height, maxHeight) : belowTop
        const bridgeTop = onTop ? top + Math.min(height, maxHeight) : r.bottom
        const bridgeLeft = Math.min(r.left, left)
        setPos({
          left, top, ...fitContent ? {} : { width }, maxWidth, maxHeight,
          bridge: {
            left: bridgeLeft, top: bridgeTop,
            width: Math.max(r.right, left + width) - bridgeLeft,
            height: Math.max(0, (onTop ? r.top : top) - bridgeTop),
          },
        })
        return
      }
      const top = r.top + h > window.innerHeight - VIEWPORT_MARGIN ? window.innerHeight - h - VIEWPORT_MARGIN : r.top
      setPos({ left: r.right + ANCHOR_GAP, top })
    }
    place()
    // Observe only the anchor's ancestors: an offscreen drawer can hide without resizing its retained row.
    const visibility = new MutationObserver(place)
    for (let ancestor = rootRef.current?.parentElement; ancestor != null; ancestor = ancestor.parentElement) {
      visibility.observe(ancestor, { attributes: true, attributeFilter: ['inert', 'hidden'] })
    }
    const observer = (variant === 'preview' || inline) && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    for (const element of [cardRef.current, rootRef.current, widthAnchorRef?.current]) {
      if (element !== null && element !== undefined) observer?.observe(element)
    }
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      visibility.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, variant, widthAnchorRef, positioned, inline, fitContent, dismissImmediately])

  // The first placement ran before the card mounted (height read 0): once the
  // card's real height is measurable, correct the bottom-edge clamp. The
  // correction converges — a clamped top satisfies the guard, so it runs once.
  useLayoutEffect(() => {
    if (!open || pos === null || variant === 'preview' || inline) return
    /* v8 ignore next -- the card is mounted whenever pos is set, so the ref is attached here. */
    const h = cardRef.current?.offsetHeight ?? 0
    if (pos.top + h > window.innerHeight - VIEWPORT_MARGIN) {
      setPos({ left: pos.left, top: window.innerHeight - h - VIEWPORT_MARGIN })
    }
  }, [open, pos, variant, inline])

  const copy = async (text: string): Promise<void> => {
    if (copied || copyingRef.current) return
    copyingRef.current = true
    const copyEpoch = copyEpochRef.current
    const accepted = await writeClipboard(text)
    copyingRef.current = false
    const card = cardRef.current
    if (!accepted || !mountedRef.current || copyEpoch !== copyEpochRef.current || card === null) return
    const height = card.offsetHeight
    copyHeightRef.current = height > 0 ? height : null
    setCopied(true)
    copyTimerRef.current = setTimeout(clearCopied, 1000)
  }

  const copyable = copyText !== undefined
  const dismissFromAnchor = (event: SyntheticEvent<HTMLSpanElement>): void => {
    // Portal content is a React child, but its clicks and text selection do not activate the anchor.
    if (portalRef.current?.contains(event.target as Node)) return
    clearTimer()
    cancelClose()
    close()
  }
  const card = open && pos !== null && (
    <div
      ref={cardRef}
      className={clsx(css.card, variant === 'preview' && css.preview, inline && css.media, inline && fitContent && css.fitContent, copyable && css.copyable, copied && css.feedback)}
      data-closing={closing || undefined}
      style={{
        left: pos.left, top: pos.top, width: pos.width, maxWidth: pos.maxWidth, maxHeight: pos.maxHeight,
        minHeight: copied && copyHeightRef.current !== null ? copyHeightRef.current : undefined,
        '--dsh-hover-preview-fade': `${PREVIEW_FADE_MS}ms`,
      } as CSSProperties}
      role={copyable ? 'button' : undefined}
      tabIndex={copyable ? 0 : undefined}
      aria-label={copyable ? `${copyLabel}: ${copyText}` : undefined}
      onClick={copyable
        ? (e) => {
          const selection = window.getSelection()
          if (selection !== null && !selection.isCollapsed) {
            for (let i = 0; i < selection.rangeCount; i += 1) {
              if (selection.getRangeAt(i).intersectsNode(e.currentTarget)) return
            }
          }
          void copy(copyText)
        }
        : undefined}
      onKeyDown={copyable
        ? (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          void copy(copyText)
        }
        : undefined}
    >
      {copied ? <span className={css.copied} aria-hidden="true">{copiedLabel}</span> : content}
    </div>
  )

  return (
    <span
      ref={rootRef}
      className={clsx(css.root, inline && css.inline)}
      onFocus={inline ? (event) => {
        if (!disabled && event.target.matches(':focus-visible')) { cancelClose(); setPhase('open') }
      } : undefined}
      onBlur={inline ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) { clearTimer(); cancelClose(); close() }
      } : undefined}
      onPointerEnter={(event) => {
        if (disabled || event.pointerType === 'touch') return
        if (event.pointerType === 'mouse' && !window.matchMedia('(any-hover: hover)').matches) return
        // Coming back inside during the grace (the gap, or the card itself)
        // keeps the current card rather than restarting the dwell.
        cancelClose()
        if (open) { setPhase('open'); return }
        clearTimer()
        if (group?.isWarm()) setPhase('open')
        else timerRef.current = setTimeout(() => { setPhase('open') }, openDelayMs)
      }}
      onPointerLeave={() => {
        clearTimer()
        // Leaving a closed card schedules a no-op close; only arm while
        // open, matching Menu's shape.
        if (open) armClose()
      }}
      onPointerDownCapture={dismissFromAnchor}
      onClickCapture={dismissFromAnchor}
    >
      {anchor}
      {open && copyable && <span className={css.status} role="status">{copied ? copiedLabel : ''}</span>}
      {card !== false && createPortal(
        <span ref={portalRef} className={css.portal}>
          {pos.bridge !== undefined && <span className={css.bridge} style={pos.bridge} data-hovercard-bridge="" aria-hidden />}
          {card}
        </span>, document.body,
      )}
    </span>
  )
}

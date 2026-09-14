import { useCallback, useRef } from 'react'
import type { ConversationSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { ConversationContent } from './ConversationContent.tsx'
import css from './ConversationRoot.module.css'

/** localStorage key for the dragged transcript width preference (px). */
const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
/** Floor for a dragged content width; matches the layout center-column minimum. */
const CONTENT_MIN = 640
/** Column budget the content must leave free: 88px per side keeps the width
 * handles fully placeable (24px inset + 40px strip + 24px safe zone) — a
 * larger dragged width would push its own handles off the column and leave no
 * way to drag back. */
const CONTENT_EDGE_BUDGET = 176

/** Reads the persisted width preference; durable-storage boundary, so a
 * missing or corrupt value resolves to "no preference".
 * @returns the stored width in px, or null when unset or invalid. */
function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolves the content width the CSS axis would show for a column width.
 * @param columnWidth - the conversation column's rendered width in px.
 * @param preference - the dragged preference, or null for the adaptive clamp.
 * @returns the resolved content width in px (mirrors the CSS clamp). */
function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

/**
 * Render the existing main Conversation frame around the extracted content.
 * @param props - the original `main.conversation` Slot props.
 * @returns the unchanged root, Header, content, and width-control subtree.
 */
export function ConversationMainPanel(props: ConversationSlotProps) {
  const { sessionId, useSession, useSessions, useConversation, renderSlot } = props
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : conversationPhase(session, conversation)
  const openState = session?.openState
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)

  // Publishes the column's live width as --dsh-conversation-column-width so
  // the shared width axis can adapt (see the .root CSS), and re-clamps a
  // dragged preference against the shrunken column WITHOUT rewriting the
  // stored preference — widening the window restores it (the AppFrame
  // sidebar-drag rule). Same callback-ref pattern as the seat observer.
  const rootEl = useRef<HTMLDivElement | null>(null)
  const rootObserver = useRef<ResizeObserver | null>(null)
  const publishWidths = useCallback((root: HTMLDivElement): void => {
    const column = root.offsetWidth
    root.style.setProperty('--dsh-conversation-column-width', `${column}px`)
    const preference = readWidthPreference()
    if (preference === null) {
      root.style.removeProperty('--dsh-chat-user-width')
    } else {
      root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
    }
  }, [])
  const rootResizeRef = useCallback((root: HTMLDivElement | null): void => {
    rootObserver.current?.disconnect()
    rootObserver.current = null
    rootEl.current = root
    if (root === null) return
    rootObserver.current = new ResizeObserver(() => { publishWidths(root) })
    rootObserver.current.observe(root)
    publishWidths(root)
  }, [publishWidths])

  // Drag plumbing for the two width handles: onStart snapshots the resolved
  // width (grabbing a clamped column must not jump back to the raw stored
  // preference), onDrag publishes only the live clamped style, onCommit
  // persists the width of a gesture that actually travelled, and onEnd
  // republishes from storage — an uncommitted press leaves the stored
  // preference untouched.
  const onHandleStart = useCallback((): number => {
    const root = rootEl.current
    /* v8 ignore next -- handles render inside the root, so the ref is always attached. */
    if (root === null) return 680
    return resolveContentWidth(root.offsetWidth, readWidthPreference())
  }, [])
  const onHandleDrag = useCallback((width: number): void => {
    const root = rootEl.current
    /* v8 ignore next -- handles render inside the root, so the ref is always attached. */
    if (root === null) return
    const clamped = resolveContentWidth(root.offsetWidth, width)
    root.style.setProperty('--dsh-chat-user-width', `${clamped}px`)
  }, [])
  const onHandleCommit = useCallback((width: number): void => {
    const root = rootEl.current
    /* v8 ignore next -- handles render inside the root, so the ref is always attached. */
    if (root === null) return
    localStorage.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(root.offsetWidth, width)}`)
  }, [])
  const onHandleEnd = useCallback((): void => {
    const root = rootEl.current
    if (root !== null) publishWidths(root)
  }, [publishWidths])

  // While a session is still replaying (loading + blank) the hero/docked
  // choice is unknowable — render the composer hidden instead of flashing
  // the centered hero and snapping to the docked bar (or vice versa).
  // Exemption: a session the list summary already proves blank can only
  // land on the hero, so hiding would blank the column for the whole
  // history round-trip (the startup auto-selection flash) for nothing.
  // The exemption is deliberately open-state-wide, not loading-only: a
  // summary-blank session is the hero before its open starts (`cold`) and
  // after one fails (`error`) for the same reason — there is no history.
  // A restored continuable subagent also stays settled until its eagerly
  // loaded parent catalog establishes availability. This keeps the composer
  // hidden instead of briefly rendering the parent-offline takeover.
  const parentAvailabilityPending = session?.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settling = sessionId !== undefined && (
    (shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true)
    || parentAvailabilityPending
  )
  const hero = sessionId === undefined
    || (shellPhase === 'blank' && (openState === 'open' || summaryBlank === true))
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'

  return (
    <div ref={rootResizeRef} className={css.root} data-phase={phase}>
      {sessionId === undefined ? null : renderSlot('conversation.session.header', {})}
      <ConversationContent
        {...props}
        session={session}
        phase={phase}
        hero={hero}
        onHandleStart={onHandleStart}
        onHandleDrag={onHandleDrag}
        onHandleCommit={onHandleCommit}
        onHandleEnd={onHandleEnd}
      />
    </div>
  )
}

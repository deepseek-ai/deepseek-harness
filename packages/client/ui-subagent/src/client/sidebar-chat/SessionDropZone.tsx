/** Drop target that opens a Session dragged from the Session list in the right Sidebar. */
import { useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionDragType } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { NS } from '../locales.ts'
import css from './SessionDropZone.module.css'

/** Drag data type the Session list sets to a dragged row's Session id. */
export const SESSION_DRAG_TYPE: SessionDragType = 'application/x-dsh-session'

/** Session drag tracking and the open operation supplied by the plugin. */
export interface SessionDropZoneInjected {
  readonly hooks: {
    /** Session dragged from the list that the on-screen Session's Sidebar can open; undefined otherwise. */
    readonly sessionDrag: HostObservable<SessionId | undefined>
  }
  /** Open the Session's Conversation in the on-screen Session's right Sidebar. */
  readonly openAside: (sessionId: SessionId) => void
}

/** Props of the `shell.overlay` drop target. */
export type SessionDropZoneProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & InjectFace<SessionDropZoneInjected>

/**
 * Show the right-edge drop target while a Session row is dragged.
 * @param props - tracked drag, open operation, and copy.
 * @returns the drop target, or nothing outside a Session drag.
 */
export function SessionDropZone({ useSessionDrag, openAside, t }: SessionDropZoneProps) {
  const sessionId = useSessionDrag(value => value)
  return sessionId === undefined
    ? null
    : <DropTarget key={sessionId} label={t('open.sidebar')} onDrop={() => { openAside(sessionId) }} />
}

function DropTarget({ label, onDrop }: { readonly label: string; readonly onDrop: () => void }) {
  const [over, setOver] = useState(false)
  // Stop propagation so document-level handlers of the list's reorder drag
  // keep neither the drop nor their `move` effect.
  const accept = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }
  // A body portal stacks above the narrow-window drawer mask, which covers the frame's overlay layer.
  return createPortal(
    <div
      className={css.zone}
      data-session-drop-zone=""
      data-active={over || undefined}
      onDragEnter={accept}
      onDragOver={accept}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setOver(false)
        onDrop()
      }}
    >
      <div className={css.card}>
        <IconPanelLeftOutlineRegular className={css.icon} aria-hidden="true" />
        <span className={css.label}>{label}</span>
      </div>
    </div>,
    document.body,
  )
}

/** Drop target that opens a Session dragged from the Session list in the right Sidebar. */
import { useState, type DragEvent } from 'react'
import { IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionDragType } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { NS } from '../locales.ts'
import css from './SessionDropZone.module.css'

/** Drag data type the Session list sets to a dragged row's Session id. */
export const SESSION_DRAG_TYPE: SessionDragType = 'application/x-dsh-session'

/** Viewport rectangle, in px, where a dragged Session can land. */
export interface SessionDropTarget {
  /** Docked Sidebar pane the Session opens in; absent for the area a collapsed Sidebar would open in. */
  readonly paneId?: PaneId
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** A Session row in flight and where it can land. */
export interface SessionDrag {
  readonly sessionId: SessionId
  readonly targets: readonly SessionDropTarget[]
}

/** Session drag tracking and the open operation supplied by the plugin. */
export interface SessionDropZoneInjected {
  readonly hooks: {
    /** Session dragged from the list that the on-screen Session's Sidebar can open; undefined otherwise. */
    readonly sessionDrag: HostObservable<SessionDrag | undefined>
  }
  /** Open the Session's Conversation in the on-screen Session's right Sidebar, in the named docked pane if any. */
  readonly openAside: (sessionId: SessionId, paneId?: PaneId) => void
}

/** Props of the `shell.overlay` drop target. */
export type SessionDropZoneProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & InjectFace<SessionDropZoneInjected>

/**
 * Show a drop target over each place in the right Sidebar a dragged Session row can open in.
 * @param props - tracked drag, open operation, and copy.
 * @returns the drop target, or nothing outside a Session drag.
 */
export function SessionDropZone({ useSessionDrag, openAside, t, useDocumentPortal }: SessionDropZoneProps) {
  const Portal = useDocumentPortal()
  const drag = useSessionDrag(value => value)
  if (drag === undefined) return null
  const { sessionId, targets } = drag
  // A body portal stacks above the narrow-window drawer mask, which covers the frame's overlay layer.
  return <Portal>
    {targets.map(target => (
      <DropTarget key={`${sessionId}:${target.paneId ?? ''}`} target={target} quiet={targets.length > 1} label={t('open.sidebar')}
        onDrop={() => { openAside(sessionId, target.paneId) }} />
    ))}
  </Portal>
}

function DropTarget({ target, quiet, label, onDrop }: {
  readonly target: SessionDropTarget
  /** Show the card only while the pointer is over this target, because another target shares the drag. */
  readonly quiet: boolean
  readonly label: string
  readonly onDrop: () => void
}) {
  const [over, setOver] = useState(false)
  // Stop propagation so document-level handlers of the list's reorder drag
  // keep neither the drop nor their `move` effect.
  const accept = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }
  return (
    <div
      className={css.zone}
      style={{ left: target.left, top: target.top, width: target.width, height: target.height }}
      data-session-drop-zone={target.paneId ?? ''}
      data-active={over || undefined}
      data-quiet={quiet || undefined}
      onDragEnter={accept}
      onDragOver={accept}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
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
    </div>
  )
}

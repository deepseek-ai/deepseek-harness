/** One Sidebar Inspector with locally selected Chat and Session-log presentations. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { InspectorInjected } from './InspectorTable.tsx'
import { InspectorTable } from './InspectorTable.tsx'
import type { InspectorObjects, InspectorChatTarget } from './objects.ts'
import type { InspectorPickTarget } from './chat-node/pick-match.ts'
import { InspectorChatRevealer } from './chat-node/reveal.ts'
import css from './inspector.module.css'

/** Local Inspector presentations; these are not separate Conversation View registrations. */
export type InspectorPresentation = 'chat-node' | 'session-log'

/** Both sources remain lazy: only the selected table subscribes. */
export interface SessionInspectorInjected {
  /** @returns This Session's displayed main Chat column, or undefined without one. */
  readonly chatRoot: () => HTMLElement | undefined
  /**
   * @param owner - Visible picker button.
   * @param picked - True accepts the target; false keeps picking.
   * @param cancelled - Clear panel state when the gesture is cancelled or replaced.
   * @returns Silent cleanup, or undefined if the plugin is disposed or Chat is unavailable.
   */
  readonly pickChat: (owner: HTMLElement, picked: (target: InspectorPickTarget) => boolean,
    cancelled: () => void) => (() => void) | undefined
  /** @param target - Log or object coordinates. @returns Exact and nearby loaded Chat identities. */
  readonly resolveChatTargets: (target: InspectorChatTarget) => readonly InspectorChatTarget[]
  readonly hooks: { readonly chatRows: InspectorInjected['hooks']['rows']; readonly logRows: InspectorInjected['hooks']['rows'] }
  readonly keyedHooks: { readonly chatRecord: InspectorInjected['keyedHooks']['record']; readonly logRecord: InspectorInjected['keyedHooks']['record'] }
  readonly loadOlder: InspectorInjected['loadOlder']
  readonly objects: InspectorObjects
  /** @param key - Row identity. @param mode - Current table. @returns Current raw type for filtering. */
  readonly recordType: (key: string, mode: InspectorPresentation) => string | undefined
  /** @param key - Selected log row. @returns Its exact or approximate placement in the main Chat. */
  readonly logChatTarget: (key: string) => InspectorChatTarget | undefined
  /** @param target - Picked Chat identity. @param mode - Current table. @returns Its closest loaded row, when available. */
  readonly pickRow: (target: InspectorPickTarget, mode: InspectorPresentation) => string | undefined
}

/** Sidebar Session source and Inspector-owned actions and data. */
export type SessionInspectorProps = Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useSession'>
  & InjectFace<SessionInspectorInjected> & PropsLocale<'session-inspector'>

/** @param props - Session-bound sources. @returns One Inspector with an in-toolbar presentation selector. */
export function SessionInspectorView(props: SessionInspectorProps) {
  const [mode, setMode] = useState<InspectorPresentation>('session-log')
  const [picking, setPicking] = useState(false)
  const [pickFailed, setPickFailed] = useState(false)
  const [pickedRow, setPickedRow] = useState<{ key: string }>()
  const pickButton = useRef<HTMLButtonElement>(null)
  const chat = mode === 'chat-node'
  const revealer = useMemo(() => new InspectorChatRevealer(props.chatRoot), [props.chatRoot])
  useEffect(() => () => { revealer.dispose() }, [revealer, mode])
  const typeOf = useCallback((key: string) => props.recordType(key, mode), [props.recordType, mode])
  const revealChat = useCallback((target: InspectorChatTarget) => {
    revealer.reveal(props.resolveChatTargets(target))
  }, [revealer, props.resolveChatTargets])
  const navigation = useMemo(() => ({ reveal: revealChat,
    target: chat ? (key: string) => props.objects.row(key)?.target : props.logChatTarget,
  }), [chat, props.objects, props.logChatTarget, revealChat])
  useEffect(() => {
    if (!picking || pickButton.current === null) return
    revealer.dispose()
    const stopPicking = props.pickChat(pickButton.current, (target) => {
      const key = props.pickRow(target, mode)
      if (key === undefined) { setPickFailed(true); return false }
      setPickedRow({ key })
      setPicking(false)
      setPickFailed(false)
      return true
    }, () => { setPicking(false); setPickFailed(false) })
    if (stopPicking === undefined) { setPicking(false); setPickFailed(true) }
    return stopPicking
  }, [picking, mode, props.pickChat, props.pickRow, revealer])
  const selector = <span className={css.modeControls}><select className={css.modeSelector} aria-label={props.t('view.presentation')} value={mode}
    onChange={(event) => {
      setPicking(false); setPickFailed(false); setPickedRow(undefined)
      setMode(event.currentTarget.value === 'chat-node' ? 'chat-node' : 'session-log')
    }}>
    <option value="session-log">{props.t('view.sessionLog')}</option>
    <option value="chat-node">{props.t('view.chatNode')}</option>
  </select><button ref={pickButton} type="button" className={css.pickButton}
    aria-pressed={picking} aria-label={props.t('picker.pick')} title={props.t(picking ? 'picker.cancel' : 'picker.pick')}
    onClick={() => { setPickFailed(false); setPicking(value => !value) }}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="4.5" /><path d="M8 0v5M8 11v5M0 8h5M11 8h5" />
    </svg>
  </button></span>
  return <InspectorTable key={mode} title={props.t(chat ? 'view.chatNode' : 'view.sessionLog')}
    modeSelector={selector} pickedRow={pickedRow}
    notice={picking ? props.t(pickFailed ? 'picker.noMatch' : 'picker.instructions') : pickFailed ? props.t('picker.noChat') : undefined}
    useRows={chat ? props.useChatRows : props.useLogRows}
    useRecord={chat ? props.useChatRecord : props.useLogRecord} useSession={props.useSession}
    loadOlder={props.loadOlder} typeOf={typeOf} t={props.t} flash={chat} showTime={!chat}
    navigation={navigation} {...chat ? { objects: props.objects } : {}} />
}

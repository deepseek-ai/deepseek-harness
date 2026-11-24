/**
 * The read-aloud control in an assistant message's action row: a speaker while idle, four pulsing bars from the click
 * until sound, and a moving waveform while the reply is read. A second click stops the reading.
 */
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { IconSpeakerOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReadAloudStatus } from '@deepseek-ai/dsh-read-aloud/types'
import type {} from '@deepseek-ai/dsh-read-aloud/remote'
import type { NS } from './locales.ts'
import type { ReaderState } from './reader.ts'
import css from './ReadAloud.module.css'

/** Entry-injected reading state and the one verb of the control. */
export interface ReadAloudActionInjected {
  hooks: {
    reader: HostObservable<ReaderState>
    readAloudStatus: HostObservable<ReadAloudStatus['state']>
  }
  /**
   * Start or stop reading one message of the entry's Session; a message whose reading was interrupted continues.
   * @param messageId - message of the clicked control.
   */
  toggle: (messageId: MessageId) => void
}

/** Full props of one message's read-aloud control. */
export type ReadAloudActionProps = PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<ReadAloudActionInjected> & PropsLocale<typeof NS>

const BARS = { loading: [0, 1, 2, 3], playing: [0, 1, 2, 3, 4] } as const

/**
 * One message's control. It is offered while synthesis is available and the current Peer may use it, and it stays
 * while this message is being read so the reading can always be stopped.
 * @param props - the owner's message identity, the injected state hooks and verb, and the translator.
 * @returns the control, or nothing while a reading cannot start.
 */
export function ReadAloudAction({ sessionId, messageId, toggle, useReader, useReadAloudStatus, useAccess, t }: ReadAloudActionProps) {
  const allowed = useAccess('readAloud/synthesize')
  const ready = useReadAloudStatus(state => state === 'ready')
  const phase = useReader(({ reading }) => reading?.sessionId === sessionId && reading.messageId === messageId ? reading.phase : undefined)
  if (!allowed || (!ready && phase === undefined)) return null
  const label = t(phase === undefined ? 'read' : 'stop')
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className={css.action}
        aria-label={label}
        data-read-aloud={phase ?? 'idle'}
        data-action-ongoing={phase === undefined ? undefined : ''}
        onClick={() => { toggle(messageId) }}
      >
        {phase === undefined
          ? <IconSpeakerOutlineRegular />
          : <span className={css[phase]} aria-hidden="true">{BARS[phase].map(bar => <i key={bar} />)}</span>}
      </button>
    </Tooltip>
  )
}

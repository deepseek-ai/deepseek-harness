/**
 * The Session's read-aloud notice, shown as a toast over the composer, and the Session's exit: when this entry leaves
 * the screen, the reading that belongs to its Session stops.
 */
import { useCallback, useEffect, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { NS } from './locales.ts'
import type { ReaderState } from './reader.ts'

/** Entry-injected reading state and the Session-bound verbs of the notice. */
export interface ReadAloudNoticeInjected {
  hooks: {
    reader: HostObservable<ReaderState>
  }
  /** Stop and forget everything read-aloud holds for this entry's Session. */
  leave: () => void
  /**
   * Retire the notice the toast finished showing.
   * @param seq - sequence of that notice.
   */
  dismissNotice: (seq: number) => void
}

/** Full props of the Session's notice entry. */
export type ReadAloudNoticeProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<ReadAloudNoticeInjected> & PropsLocale<typeof NS>

/** A notice names what to do next, so it stays longer than the default three seconds. */
const HOLD_MS = 6000

/**
 * Render the latest notice of this Session.
 * @param props - the Session identity, the injected state hook and verbs, and the translator.
 * @returns the toast while a notice is unseen.
 */
export function ReadAloudNotice({ sessionId, useReader, leave, dismissNotice, t }: ReadAloudNoticeProps) {
  const notice = useReader(state => state.notice?.sessionId === sessionId ? state.notice : null)
  // The toast centers over the composer card this entry renders inside of.
  const [card, setCard] = useState<HTMLElement | null>(null)
  const probe = useCallback((node: HTMLSpanElement | null) => {
    setCard(node?.closest<HTMLElement>('[data-composer-card]') ?? null)
  }, [])
  // Leaving the Session ends its reading: no control for it remains on screen.
  useEffect(() => leave, [leave])
  return (
    <>
      <span ref={probe} hidden />
      {notice !== null && (
        <Toast
          key={notice.seq}
          text={t(`notice.${notice.kind}`)}
          icon={<IconWarningOutlineRegular />}
          anchor={card}
          holdMs={HOLD_MS}
          onDone={() => { dismissNotice(notice.seq) }}
        />
      )}
    </>
  )
}

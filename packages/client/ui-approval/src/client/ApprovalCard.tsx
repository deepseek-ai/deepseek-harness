/** Shared approval presentation; each caller retains its decision policy and answer channel. */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contract/slots.ts'
import css from './ApprovalPanel.module.css'

/**
 * Render one decision with caller-owned actions and an optional persistent choice.
 * @param props Request identity, copy, actions and correlated detail.
 * @returns The shared approval card, reset for each request.
 */
export function ApprovalCard(props: FactoryComponentPropsOf<'conversation.approval.card'>) {
  return <ApprovalFlow key={props.requestKey} {...props} />
}

function ApprovalFlow(props: FactoryComponentPropsOf<'conversation.approval.card'>) {
  const { requestKey, title, description, subject, allowLabel, canAnswer, onAllow, onReject, onAlways, t } = props
  const detail = props.callId === undefined ? null : props.renderSlot('conversation.approval.detail', { callId: props.callId })
  const [answered, setAnswered] = useState(false)
  const waiting = useRef(false)
  const active = useRef(true)
  const composing = useRef(false)
  const compositionEnded = useRef(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  const answer = (send: () => Promise<void>): void => {
    if (waiting.current || !canAnswer()) return
    waiting.current = true
    setAnswered(true)
    void send().catch(() => {
      if (!active.current || !canAnswer()) return
      waiting.current = false
      setAnswered(false)
    })
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const element = event.target as Element
    if (event.defaultPrevented || !event.currentTarget.contains(document.activeElement)
      || element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null) return
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    if (event.key === 'Enter' && element.closest('button, a[href], [role="button"]') !== null) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
    if (event.repeat || composing.current || compositionEnded.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    answer(event.key === 'Enter' ? onAllow : onReject)
  }
  return (
    <div className={css.root} data-approval-key={requestKey} aria-busy={answered}
      onKeyDown={keydown}
      onKeyUpCapture={() => { compositionEnded.current = false }}
      onCompositionStartCapture={() => { composing.current = true }}
      onCompositionEndCapture={() => { composing.current = false; compositionEnded.current = true }}>
      <div className={subject === undefined ? css.card : `${css.card} ${css.withSubject}`}>
        <div className={css.strip}><StateDot state={answered ? 'ongoing' : 'warning'} />{t('waiting')}</div>
        <div
          className={css.body}
          data-approval-scroll=""
          tabIndex={0}
          role="group"
          aria-label={t('detail.aria')}
        >
          {subject !== undefined && <div className={css.subject}>
            {subject.icon !== undefined && <img src={subject.icon} alt="" width={40} height={40} draggable={false} />}
            <strong>{subject.name}</strong>
          </div>}
          <div className={css.headline}>{title}</div>
          {description !== undefined && <p className={css.description}>{description}</p>}
          {detail !== null && <div className={css.command}>{detail}</div>}
        </div>
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered} onClick={() => { answer(onReject) }}>
            {t('reject')}
          </Button>
          <Button variant={onAlways === undefined ? 'primary' : 'outline'} disabled={answered} onClick={() => { answer(onAllow) }}>
            {allowLabel ?? t('allowOnce')}
          </Button>
          {onAlways !== undefined && <Button variant="primary" disabled={answered} onClick={() => { answer(onAlways) }}>
            {t('allowAlways')}
          </Button>}
        </div>
      </div>
    </div>
  )
}

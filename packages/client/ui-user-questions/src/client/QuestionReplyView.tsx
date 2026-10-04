import { memo, useCallback, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconCopyOutlineRegular, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuestionReplyData } from './question-reply.ts'
import { replyAnswerValues, replyClipboardText } from './question-reply.ts'
import css from './QuestionReplyView.module.css'

type QuestionReplyViewProps =
  PropsRuntime<'conversation.chat.node', 'question-reply'>
  & PropsLocale<'question'>

/**
 * Right-aligned late-reply bubble: a label naming the earlier pending
 * questions, then one question and answer pair per question. A payload the
 * Client cannot read falls back to the model-facing text.
 */
export const QuestionReplyView = memo(function QuestionReplyView({ node, t }: QuestionReplyViewProps) {
  return <QuestionReplyBubble data={node.data} t={t} />
})

/**
 * Render one settled question reply as a compact transcript bubble.
 * @param props - Reply data and the question locale translator.
 * @returns The expandable reply bubble.
 */
export function QuestionReplyBubble({ data, t }: { data: QuestionReplyData; t: PropsLocale<'question'>['t'] }) {
  const label = t('reply.label')
  const [open, setOpen] = useState(false)
  const toggleLabel = t(open ? 'reply.close' : 'reply.open')
  const summary = data.questions.map(question => replyAnswerValues(data, question.id)).flat().join(', ')
  const copyText = replyClipboardText(data, t)
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, copyText])
  return (
    <div className={css.row} data-question-reply={data.callId} data-reply-outcome={data.outcome} role="group" aria-label={label}>
      <div className={css.bubble}>
        <button
          type="button"
          className={css.toggle}
          aria-expanded={open}
          aria-label={`${label} · ${toggleLabel}`}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className={css.labelRow}>
            {/* The caret is the only sign the bubble opens; the label alone
                reads as plain text. Its state is on the button already. */}
            <span className={css.caret} aria-hidden="true">
              {open ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
            </span>
            <span className={css.label}>{label}</span>
          </span>
          {!open && <span className={css.summary}>{summary === '' ? t('reply.skipped') : summary}</span>}
        </button>
        {open && (data.questions.length === 0
          ? <p className={css.text}>{data.text}</p>
          : (
            <dl className={css.details}>
              {data.questions.map((question) => {
                const values = replyAnswerValues(data, question.id)
                return (
                  <div key={question.id}>
                    <dt className={css.question}>
                      {question.header && question.header !== question.question && <span className={css.header}>{question.header}</span>}
                      <span className={css.questionText}>{question.question}</span>
                      {question.detail && <span className={css.detail}>{question.detail}</span>}
                      {question.options && question.options.length > 0 && (
                        <ul className={css.options}>
                          {question.options.map(option => <li key={option.label}>{option.label}{option.description && ` — ${option.description}`}</li>)}
                        </ul>
                      )}
                    </dt>
                    <dd className={css.answer}>
                      <span className={css.answerLabel}>{t('reply.answerLabel')}</span>
                      {values.length === 0 ? t('reply.skipped') : values.join(', ')}
                    </dd>
                  </div>
                )
              })}
            </dl>
          ))}
      </div>
      <div className={css.actions}>
        <span className={css.time}>
          {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(data.time)}
        </span>
        <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
          <button type="button" className={css.action} aria-label={copied ? t('copied') : t('copy')} onClick={onCopy}>
            {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

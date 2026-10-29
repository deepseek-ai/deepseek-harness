/** Settled question batches rendered with the shared user-message surface. */
import { memo } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutlineRegular, IconCopyOutlineRegular, Tooltip, UserMessageBubble, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuestionReplyData } from './question-reply.ts'
import { replyAnswerValues, replyClipboardText } from './question-reply.ts'
import css from './QuestionReplyView.module.css'

type QuestionReplyViewProps =
  PropsRuntime<'conversation.chat.node', 'question-reply'>
  & PropsLocale<'question'>

/** Render recorded questions and answers without an expandable process row. */
export const QuestionReplyView = memo(function QuestionReplyView({ node, t }: QuestionReplyViewProps) {
  return <QuestionReplyBubble data={node.data} t={t} />
})

/**
 * Render one answered batch with questions above their corresponding answers.
 * @param props - Reply data and the question locale translator.
 * @returns The right-aligned, fully visible question-and-answer bubble.
 */
export function QuestionReplyBubble({ data, t }: { data: QuestionReplyData; t: PropsLocale<'question'>['t'] }) {
  const copyText = replyClipboardText(data, t)
  const { copied, onCopy } = useClipboardCopy(copyText)
  return (
    <div className={css.row} data-question-reply={data.callId} data-reply-outcome={data.outcome}
      role="group" aria-label={t('reply.label')}>
      <div className={css.bubbleWidth}>
        <UserMessageBubble className={css.bubble}>
          {data.questions.length === 0
            ? <p className={css.text}>{data.text}</p>
            : <dl className={css.details}>
              {data.questions.map((question) => {
                const values = replyAnswerValues(data, question.id)
                return <div key={question.id}>
                  <dt className={css.question}>
                    {question.header && question.header !== question.question && <span className={css.header}>{question.header}</span>}
                    <span>{question.question}</span>
                  </dt>
                  <dd className={css.answer}>{values.length === 0 ? t('reply.skipped') : values.join(', ')}</dd>
                </div>
              })}
            </dl>}
        </UserMessageBubble>
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

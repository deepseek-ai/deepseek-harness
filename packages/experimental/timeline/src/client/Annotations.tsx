import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Annotation, AnnotationTarget, TimelineView } from '../records.ts'
import { newId } from '../records.ts'
import { formatPeriod, savedPeriod } from '../periods.ts'
import type { AnnotationRequest } from './actions.ts'
import { Markdown } from './Markdown.tsx'
import { emptyDraft } from './store.ts'
import type { AnnotationDraftControl } from './store.ts'

/** Use the session-owned draft when mounted in the Timeline panel. */
export function useAnnotationDraft(control?: AnnotationDraftControl): AnnotationDraftControl {
  const [draft, setDraft] = useState(emptyDraft)
  return control ?? { draft, update: (patch) => { setDraft(current => ({ ...current, ...patch })) } }
}

const controlStatuses = {
  applied: { labelKey: 'controlApplied', tone: 'success' },
  completed: { labelKey: 'taskCompleted', tone: 'success' },
  unavailable: { labelKey: 'controlUnavailable', tone: 'warning' },
  answered: { labelKey: 'controlAnswered', tone: 'warning' },
  superseded: { labelKey: 'controlSuperseded', tone: 'neutral' },
  waiting: { labelKey: 'controlWaiting', tone: 'info' },
  unknown: { labelKey: 'controlDeliveryUnknown', tone: 'warning' },
} as const

function annotationStatus(annotation: Annotation) {
  if (annotation.control !== undefined)
    return controlStatuses[
      annotation.control.outcome?.status ??
        (annotation.control.delivery === 'unknown' ? 'unknown' : 'waiting')
    ]
  return annotation.reply === null
    ? ({ labelKey: 'annotationOpen', tone: 'info' } as const)
    : ({ labelKey: 'annotationResolved', tone: 'success' } as const)
}

/** Append-only user feedback with one agent resolution. */
export function Annotations({
  annotations,
  locale = 'en',
  targetTitle,
  t,
}: {
  locale?: string
  annotations: readonly Annotation[]
  targetTitle?: (target: AnnotationTarget) => ReactNode
} & PropsLocale<'timeline'>): ReactNode {
  const label = useId()
  return (
    <section className="timeline-annotations" aria-labelledby={label}>
      <h3 id={label}>
        {t('annotations')} <span className="timeline-muted">{annotations.length}</span>
      </h3>
      {annotations.length === 0 ? (
        <p className="timeline-muted">{t('emptyAnnotations')}</p>
      ) : (
        <ol className="timeline-annotation-list" aria-live="polite">
          {annotations.map(annotation => (
            <li key={annotation.id} className="timeline-annotation" data-resolved={annotation.reply !== null}>
              {targetTitle === undefined ? null : (
                <p className="timeline-annotation-target">{targetTitle(annotation.target)}</p>
              )}
              <div className="timeline-annotation-heading">
                <strong>{t(annotation.control === undefined ? 'annotationUser' : 'controlRequest')}</strong>
                <time dateTime={new Date(annotation.createdAt).toISOString()}>
                  {new Date(annotation.createdAt).toLocaleString(locale)}
                </time>
                <Tag tone={annotationStatus(annotation).tone}>{t(annotationStatus(annotation).labelKey)}</Tag>
              </div>
              <Markdown text={annotation.text} t={t} />
              {annotation.reply === null ? null : (
                <div className="timeline-annotation-reply">
                  <div className="timeline-annotation-heading">
                    <strong>{t('annotationAgent')}</strong>
                    <time dateTime={new Date(annotation.reply.createdAt).toISOString()}>
                      {new Date(annotation.reply.createdAt).toLocaleString(locale)}
                    </time>
                  </div>
                  <Markdown text={annotation.reply.text} t={t} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** One read-only Session history shared by the main pages; collapsed content stays unmounted. */
export function DiscussionHistory({
  view,
  locale = 'en',
  open,
  onToggle,
  t,
}: {
  view: TimelineView
  locale?: string
  open: boolean
  onToggle: (open: boolean) => void
} & PropsLocale<'timeline'>): ReactNode {
  if (view.annotations.length === 0) return null
  return (
    <details
      className="timeline-discussion-history"
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onToggle(event.currentTarget.open)
      }}
    >
      <summary>
        {t('discussionHistory')} <span className="timeline-tab-count">{view.annotations.length}</span>
      </summary>
      {open ? (
        <Annotations
          locale={locale}
          annotations={view.annotations}
          targetTitle={(target) => {
            if (target.kind === 'report') {
              const report = view.reports.find(item => item.id === target.report)
              return report === undefined ? (
                t('detailUnavailable')
              ) : (
                <>
                  {t('levelSummary', { level: report.level + 1, period: formatPeriod(savedPeriod(report) ?? report.end - report.start) })}
                  : {new Date(report.start).toLocaleString(locale)} – {new Date(report.end).toLocaleString(locale)}
                </>
              )
            }
            const tree = view.trees.find(item => item.id === target.tree)
            return target.kind === 'tree'
              ? `${t('tasks')}: ${tree?.title ?? t('detailUnavailable')}`
              : `${tree?.title ?? ''} · ${tree?.tasks.find(item => item.id === target.task)?.title ?? t('detailUnavailable')}`
          }}
          t={t}
        />
      ) : null}
    </details>
  )
}

/** Edit a discussion draft and retain the same identity across failed saves. */
export function AnnotationEditor({
  target,
  draft: { open, text, id, busy, messageKey },
  update,
  save,
  t,
}: {
  target: AnnotationTarget
  save: (request: AnnotationRequest) => Promise<{ notified: boolean }>
} & AnnotationDraftControl & PropsLocale<'timeline'>): ReactNode {
  const label = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const sending = useRef(false)
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (sending.current || busy || !text.trim()) return
    sending.current = true
    const identity = id ?? newId('note')
    update({ id: identity, busy: true, messageKey: null })
    try {
      const result = await save({ id: identity, target, text: text.trim() })
      update({ ...emptyDraft, messageKey: result.notified ? 'annotationSaved' : 'annotationNotifyFailed' })
    } catch {
      update({ busy: false, messageKey: 'annotationSaveFailed' })
    } finally {
      sending.current = false
    }
  }
  return (
    <>
      {open ? (
        <form
          className="timeline-annotation-editor"
          onSubmit={(event) => {
            void submit(event)
          }}
          aria-busy={busy}
        >
          <label htmlFor={`${label}-input`}>{t('addAnnotation')}</label>
          <textarea
            id={`${label}-input`}
            ref={input}
            value={text}
            maxLength={4000}
            rows={4}
            placeholder={t('annotationPlaceholder')}
            disabled={busy}
            onChange={(event) => {
              update({ text: event.currentTarget.value, id: null, messageKey: null })
            }}
          />
          <div>
            <span className="timeline-annotation-count">{text.length} / 4,000</span>
            <Button type="button" disabled={busy} onClick={() => { update(emptyDraft) }}>
              {t('cancelAnnotation')}
            </Button>
            <Button type="submit" disabled={busy || !text.trim()}>
              {t('saveAnnotation')}
            </Button>
          </div>
        </form>
      ) : null}
      {messageKey === null ? null : (
        <p
          className={messageKey === 'annotationSaveFailed' ? 'timeline-error' : 'timeline-muted'}
          role={messageKey === 'annotationSaveFailed' ? 'alert' : 'status'}
        >
          {t(messageKey)}
        </p>
      )}
    </>
  )
}

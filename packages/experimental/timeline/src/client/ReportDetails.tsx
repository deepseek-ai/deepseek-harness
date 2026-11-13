import type { ReactNode } from 'react'
import { Button, IconListPenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { IntervalReport, TimelineView } from '../records.ts'
import { formatDuration, formatPeriod, savedPeriod } from '../periods.ts'
import { DetailHeader } from './DetailHeader.tsx'
import { AnnotationEditor, Annotations, useAnnotationDraft } from './Annotations.tsx'
import type { AnnotationDraftControl } from './store.ts'
import type { AnnotationRequest } from './actions.ts'

interface ReportDetailsProps extends PropsLocale<'timeline'> {
  view: TimelineView
  locale?: string
  reportId: IntervalReport['id'] | null
  openReport: (id: IntervalReport['id']) => void
  back: () => void
  annotate: (request: AnnotationRequest) => Promise<{ notified: boolean }>
  annotationDraft?: AnnotationDraftControl | undefined
}

/** Short report content, with actual duration and links to the included reports. */
export function ReportDetails({
  view,
  locale = 'en',
  reportId,
  openReport,
  back,
  annotate,
  annotationDraft,
  t,
}: ReportDetailsProps): ReactNode {
  const draft = useAnnotationDraft(annotationDraft)
  const noteOpen = draft.draft.open
  const report = view.reports.find(item => item.id === reportId)
  const period = report === undefined ? undefined : savedPeriod(report)
  return (
    <section
      className="timeline-details timeline-summary timeline-detail-layout"
      data-level={report?.level}
      aria-label={t('details')}
    >
      {report === undefined ? (
        <>
          <DetailHeader title={t('details')} back={back} t={t} />
          <p className="timeline-muted">{t('selectReport')}</p>
        </>
      ) : (
        <>
          <DetailHeader title={`${t('rollup')} · ${t('level')} ${report.level + 1}`} back={back} t={t}>
            <span className="timeline-muted">{formatDuration(report.end - report.start)}</span>
          </DetailHeader>
          <div className="timeline-detail-scroll">
            <p className="timeline-muted">
              <time dateTime={new Date(report.start).toISOString()}>
                {new Date(report.start).toLocaleString(locale)}
              </time>{' '}
              –{' '}
              <time dateTime={new Date(report.end).toISOString()}>
                {new Date(report.end).toLocaleString(locale)}
              </time>
            </p>
            <p className="timeline-report-meta">
              {report.toolCount} {t('toolCalls')}
              {period === undefined ? null : ` · ${t('savedPeriod')}: ${formatPeriod(period)}`}
              {report.workMs === undefined || report.workMs === period
                ? null
                : ` · ${t('coveredWork')}: ${formatDuration(report.workMs)}`}
            </p>
            {(['progress', 'uncertainties', 'userActions'] as const).map(key =>
              report.summary[key].length === 0 ? null : (
                <section key={key} data-section={key}>
                  <h4>{t(key === 'progress' ? 'reportProgress' : key)}</h4>
                  <ul>
                    {report.summary[key].map(line => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </section>
              ),
            )}
            {report.children.length === 0 ? null : (
              <details>
                <summary>
                  {t('children')} · {report.children.length}
                </summary>
                {report.children.map((id) => {
                  const child = view.reports.find(item => item.id === id)
                  return child === undefined ? null : (
                    <button
                      className="timeline-report-link"
                      data-report-id={id}
                      key={id}
                      data-level={child.level}
                      onClick={() => { openReport(id) }}
                    >
                      <span className="timeline-level-dot" />
                      {child.summary.progress[0]}
                    </button>
                  )
                })}
              </details>
            )}
            <Annotations
              locale={locale}
              annotations={view.annotations.filter(
                annotation => annotation.target.kind === 'report' && annotation.target.report === report.id,
              )}
              t={t}
            />
          </div>
          <footer className="timeline-detail-actions">
            <AnnotationEditor
              target={{ kind: 'report', report: report.id }}
              {...draft}
              save={annotate}
              t={t}
            />
            <Button
              className="timeline-task-action timeline-report-note"
              aria-pressed={noteOpen}
              aria-expanded={noteOpen}
              onClick={() => { draft.update({ open: !noteOpen }) }}
            >
              <IconListPenOutlineRegular size={18} />
              <span>{t('addAnnotation')}</span>
            </Button>
          </footer>
        </>
      )}
    </section>
  )
}

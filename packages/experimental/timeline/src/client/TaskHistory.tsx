import { useState } from 'react'
import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProgressPrecision } from '../policy.ts'
import type { Task } from '../records.ts'
import { formatProgress, formatWeight } from './Progress.tsx'
import { statusTones } from './status.ts'
import { Markdown } from './Markdown.tsx'

/** Read-only revisions stay folded and unmounted until the user opens them. */
export function TaskHistory({
  task,
  decimals,
  locale = 'en',
  t,
}: { task: Task; locale?: string; decimals: ProgressPrecision } & PropsLocale<'timeline'>): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="timeline-task-history"
      open={open}
      onToggle={(event) => { setOpen(event.currentTarget.open) }}
    >
      <summary>
        {t('taskHistory')} <span className="timeline-tab-count">{task.history.length}</span>
      </summary>
      {!open ? null : task.history.length === 0 ? (
        <p className="timeline-muted">{t('emptyTaskHistory')}</p>
      ) : (
        <ol className="timeline-annotation-list">
          {task.history.toReversed().map((revision, index) => (
            <li key={task.history.length - index} className="timeline-annotation">
              <div className="timeline-annotation-heading">
                <time dateTime={new Date(revision.at).toISOString()}>
                  {new Date(revision.at).toLocaleString(locale)}
                </time>
                <Tag tone={statusTones[revision.status]}>{t(revision.status)}</Tag>
              </div>
              {revision.title === task.title ? null : <p>{revision.title}</p>}
              <dl className="timeline-task-metrics">
                <div>
                  <dt>{t('progress')}</dt>
                  <dd>
                    {revision.previousProgress === null ||
                    formatProgress(revision.previousProgress, decimals) === formatProgress(revision.progress, decimals)
                      ? ''
                      : `${formatProgress(revision.previousProgress, decimals)}% → `}
                    {formatProgress(revision.progress, decimals)}%
                  </dd>
                </div>
                <div>
                  <dt>{t('durationWeight')}</dt>
                  <dd>{formatWeight(revision.weight)}</dd>
                </div>
              </dl>
              {revision.description ? <Markdown text={revision.description} t={t} /> : null}
              {revision.note ? <Markdown text={revision.note} t={t} /> : null}
              {revision.details ? <Markdown text={revision.details} t={t} /> : null}
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}

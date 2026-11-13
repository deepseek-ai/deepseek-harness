import type { ReactNode } from 'react'
import { Button, IconQuestionOutlineRegular, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProgressPrecision } from '../policy.ts'
import type { TimelineView } from '../records.ts'
import { measureAll } from '../tasks.ts'
import type { DetailTarget } from './navigation.ts'
import { ReportDetails } from './ReportDetails.tsx'
import { statusTones } from './status.ts'
import { formatProgress, formatWeight } from './Progress.tsx'
import { DetailHeader } from './DetailHeader.tsx'
import { TaskActions } from './TaskActions.tsx'
import { TaskHistory } from './TaskHistory.tsx'
import { Markdown } from './Markdown.tsx'
import type { PlaybackState } from './TaskActions.tsx'
import { AnnotationEditor, Annotations, useAnnotationDraft } from './Annotations.tsx'
import type { AnnotationDraftControl } from './store.ts'
import type { AnnotationRequest, PriorityRequest, TaskRequest } from './actions.ts'

type TaskDetailsProps = {
  view: TimelineView
  locale?: string
  target: Extract<DetailTarget, { kind: 'task' }>
  decimals: ProgressPrecision
  back: () => void
  requestTask: (request: TaskRequest) => Promise<void>
  playback: PlaybackState
  setPriority: (request: PriorityRequest) => Promise<void>
  annotate: (request: AnnotationRequest) => Promise<{ notified: boolean }>
  annotationDraft?: AnnotationDraftControl | undefined
} & PropsLocale<'timeline'>

/** The active Task Tree or Timeline tab owns this detail page and its return history. */
export function Details({
  view,
  locale = 'en',
  target,
  decimals,
  back,
  open,
  requestTask,
  playback,
  setPriority,
  annotate,
  annotationDraft,
  t,
}: Omit<TaskDetailsProps, 'target'> & {
  target: DetailTarget
  open: (target: DetailTarget) => void
}): ReactNode {
  return (
    <div className="timeline-detail-page">
      {target.kind === 'report' ? (
        <ReportDetails
          locale={locale}
          key={target.report}
          view={view}
          reportId={target.report}
          openReport={(report) => { open({ kind: 'report', report }) }}
          t={t}
          back={back}
          annotate={annotate}
          annotationDraft={annotationDraft}
        />
      ) : (
        <TaskDetails
          locale={locale}
          key={`${target.tree}:${target.task}`}
          view={view}
          target={target}
          decimals={decimals}
          back={back}
          requestTask={requestTask}
          playback={playback}
          setPriority={setPriority}
          annotate={annotate}
          annotationDraft={annotationDraft}
          t={t}
        />
      )}
    </div>
  )
}

function TaskDetails({
  view,
  locale = 'en',
  target,
  decimals,
  back,
  requestTask,
  playback,
  setPriority,
  annotate,
  annotationDraft,
  t,
}: TaskDetailsProps): ReactNode {
  const draft = useAnnotationDraft(annotationDraft)
  const noteOpen = draft.draft.open
  const tree = view.trees.find(tree => tree.id === target.tree)
  const task = tree?.tasks.find(task => task.id === target.task)
  if (tree === undefined || task === undefined)
    return (
      <>
        <DetailHeader title={t('details')} back={back} t={t} />
        <p role="status">{t('detailUnavailable')}</p>
      </>
    )
  const measure = measureAll(tree.tasks).get(task.id)
  const group = tree.tasks.some(child => child.parent === task.id && child.status !== 'retired')
  return (
    <article className="timeline-detail-layout" aria-label={t('details')}>
      <DetailHeader title={task.title} back={back} t={t}>
        <Tag tone={statusTones[measure?.status ?? task.status]}>{t(measure?.status ?? task.status)}</Tag>
      </DetailHeader>
      <div className="timeline-detail-scroll">
        <p className="timeline-eyebrow">{tree.title}</p>
        {task.description ? <Markdown text={task.description} t={t} /> : null}
        {task.note ? <Markdown text={task.note} t={t} /> : null}
        <dl className="timeline-task-metrics">
          <div>
            <dt>{t('progress')}</dt>
            <dd>{formatProgress(measure?.progress ?? 0, decimals)}%</dd>
          </div>
          <div>
            <dt>
              {t('durationWeight')}
              <Tooltip label={t('weightHint')} side="top" maxWidth={320} portal openOnClick>
                <Button className="timeline-icon-button timeline-estimate-help" aria-label={t('weightHint')}>
                  <IconQuestionOutlineRegular size={14} />
                </Button>
              </Tooltip>
            </dt>
            <dd>{formatWeight(task.timeShare)}</dd>
          </div>
          {group ? null : (
            <div>
              <dt>{t('completedUnits')}</dt>
              <dd>
                {task.done[0]} / {task.done[1]}
              </dd>
            </div>
          )}
        </dl>
        {task.details ? <Markdown text={task.details} t={t} /> : null}
        <Annotations
          locale={locale}
          annotations={view.annotations.filter(
            annotation =>
              annotation.target.kind === 'task' &&
              annotation.target.tree === tree.id &&
              annotation.target.task === task.id,
          )}
          t={t}
        />
        <TaskHistory locale={locale} task={task} decimals={decimals} t={t} />
      </div>
      <footer className="timeline-detail-actions">
        <AnnotationEditor
          target={{ kind: 'task', tree: tree.id, task: task.id }}
          {...draft}
          save={annotate}
          t={t}
        />
        <TaskActions
          playback={playback}
          key={`${tree.id}:${task.id}`}
          tree={tree}
          task={task}
          status={measure?.status ?? task.status}
          request={requestTask}
          setPriority={priority => setPriority({ tree: tree.id, task: task.id, priority })}
          annotationOpen={noteOpen}
          annotate={() => { draft.update({ open: !noteOpen }) }}
          t={t}
        />
      </footer>
    </article>
  )
}

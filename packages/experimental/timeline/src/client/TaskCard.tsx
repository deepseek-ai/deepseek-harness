import { useId, useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  DisclosureRow,
  IconCheckOutlineRegular,
  IconChevronRightOutlineRegular,
  IconClockOutlineRegular,
  IconRightUpOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { z } from 'zod'
import type { Config } from '../config.ts'
import { taskReceiptSchema } from '../records.ts'
import type { Task, Tree } from '../records.ts'
import { MINUTE_MS } from '../policy.ts'
import { formatProgress } from './Progress.tsx'
import { TimelineIcon } from './TimelineIcon.tsx'

export interface TaskCardInjected {
  hooks: { locale: ObservableSnapshot<{ active: string }>; settings: ObservableSnapshot<ConfigFormSnapshot<Config>> }
  openTask: (tree: Tree['id'], task?: Task['id']) => void
}
type TaskCardProps = ToolCallViewProps & PropsLocale<'timeline'> & InjectFace<TaskCardInjected>
const metadataSchema = z.object({ timeline: taskReceiptSchema.nullable() })

/** Render a fixed saved receipt; pending, rejected and older calls keep their ordinary tool details. */
export function TaskCard({
  phase,
  block,
  useDisclosure,
  useSettings,
  useLocale,
  openTask,
  inspect,
  t,
}: TaskCardProps): ReactNode {
  const { expanded, toggle } = useDisclosure()
  const descriptionId = useId()
  const locale = useLocale(value => value.active)
  const decimals = useSettings(value => value.value?.progressDecimals ?? 2)
  const receipt = useMemo(() => {
    if (phase !== 'result' || block.isError) return null
    return metadataSchema.safeParse(block.meta).data?.timeline ?? null
  }, [phase, block])
  const failed = phase === 'result' && block.isError
  const pending = phase !== 'result'
  const text =
    phase === 'result'
      ? block.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n')
      : ''
  const gap = receipt?.previousAt == null ? null : receipt.at - receipt.previousAt
  const minutes = gap === null ? 0 : Math.floor(gap / MINUTE_MS)
  const hours = Math.floor(minutes / 60)
  const duration =
    minutes < 1
      ? `< 1 ${t('minutes')}`
      : [hours > 0 ? `${hours} ${t('hours')}` : '', minutes % 60 > 0 ? `${minutes % 60} ${t('minutes')}` : '']
        .filter(Boolean)
        .join(' ')
  const gapLabel = t('taskUpdateGap', { duration })
  const percent = (value: number) => `${formatProgress(value, decimals)}%`
  // A change that rounds to the same displayed value shows only that value.
  const change = (before: number, after: number) =>
    percent(before) === percent(after) ? percent(after) : `${percent(before)} → ${percent(after)}`
  return (
    <DisclosureRow
      className="timeline-tool-update"
      icon={<TimelineIcon size={14} />}
      title={t(failed ? 'taskUpdateFailed' : phase === 'start' ? 'taskUpdatePending' : 'taskUpdate')}
      open={expanded}
      expandable={!pending}
      onToggle={toggle}
      running={pending}
      expandOnRowClick
      collapsedContent={
        receipt === null ? null : (
          <span className="timeline-tool-summary">
            <span>{receipt.title}</span>
            <span>{change(receipt.before, receipt.after)}</span>
          </span>
        )
      }
      headerAccessory={
        receipt === null ? null : (
          <Button
            size="sm"
            className="timeline-card-open"
            aria-label={t('openTaskTree')}
            title={t('openTaskTree')}
            onClick={() => { openTask(receipt.tree) }}
          >
            <IconRightUpOutlineRegular size={14} />
          </Button>
        )
      }
    >
      {receipt === null ? (
        <pre className={failed ? 'timeline-card-failure' : 'timeline-card-raw'}>{text}</pre>
      ) : (
        <section
          className="timeline-task-card"
          aria-label={receipt.title}
          data-increased={receipt.after > receipt.before}
        >
          <header className="timeline-card-heading">
            <strong title={receipt.title}>
              <TimelineIcon size={14} />
              <span>{receipt.title}</span>
            </strong>
            <div
              className="timeline-card-progress"
              aria-label={`${t('progress')}: ${change(receipt.before, receipt.after)}`}
            >
              {percent(receipt.before) === percent(receipt.after) ? null : (
                <>
                  <strong>
                    {formatProgress(receipt.before, decimals)}
                    <span>%</span>
                  </strong>
                  <IconChevronRightOutlineRegular size={12} />
                </>
              )}
              <strong>
                {formatProgress(receipt.after, decimals)}
                <span>%</span>
              </strong>
            </div>
          </header>
          <div className="timeline-card-meta">
            <span>{receipt.branch}</span>
            <span title={new Date(receipt.at).toLocaleString(locale)}>
              <time dateTime={new Date(receipt.at).toISOString()}>
                {new Date(receipt.at).toLocaleTimeString(locale, {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </time>
              {gap !== null && gap >= 0 ? <> · {gapLabel}</> : null}
            </span>
          </div>
          <ul className="timeline-card-tasks">
            {receipt.tasks.map((task, index) => (
              <li key={task.id}>
                <Tooltip
                  label={`${task.title}\n${t(task.status)}${task.note ? ` · ${task.note}` : ''}`}
                  side="top"
                  portal
                  delayMs={500}
                >
                  <button
                    type="button"
                    className="timeline-card-task"
                    data-status={task.status}
                    aria-label={`${task.title} · ${t(task.status)} · ${change(task.before, task.after)}`}
                    aria-describedby={task.note ? `${descriptionId}-${index}` : undefined}
                    onClick={() => { openTask(receipt.tree, task.id) }}
                  >
                    <span className="timeline-card-status" aria-hidden="true">
                      {task.status === 'done' ? (
                        <IconCheckOutlineRegular size={14} />
                      ) : task.status === 'active' ? (
                        <IconClockOutlineRegular size={14} />
                      ) : (
                        <span className="timeline-status-dot" />
                      )}
                    </span>
                    <span className="timeline-card-task-copy">
                      <span>{task.title}</span>
                      <span id={`${descriptionId}-${index}`}>{task.note}</span>
                    </span>
                    {['blocked', 'paused', 'retired'].includes(task.status) ? (
                      <span className="timeline-card-state">{t(task.status)}</span>
                    ) : null}
                    <span className="timeline-card-task-progress">
                      {percent(task.before) === percent(task.after) ? null : (
                        <>
                          <span>{percent(task.before)}</span>
                          <IconChevronRightOutlineRegular size={10} />
                        </>
                      )}
                      <span>{percent(task.after)}</span>
                    </span>
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
          {receipt.total > receipt.tasks.length ? (
            <button type="button" className="timeline-card-more" onClick={() => { openTask(receipt.tree) }}>
              {t('taskUpdateMore', { count: receipt.total - receipt.tasks.length })}
              <IconRightUpOutlineRegular size={14} />
            </button>
          ) : null}
        </section>
      )}
      {receipt !== null || inspect === undefined ? null : (
        <Button size="sm" className="timeline-card-inspect" onClick={inspect}>
          {t('details')}
        </Button>
      )}
    </DisclosureRow>
  )
}

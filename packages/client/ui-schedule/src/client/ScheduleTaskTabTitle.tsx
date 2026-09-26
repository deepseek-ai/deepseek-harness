/**
 * The task tab's chip: the shown task's stored title, or the detail label while
 * the shared catalog has no row for it yet. Registered under
 * `sidebar.right.pane.tab.title`; without it the chip would show the constant
 * text the definition captured at open time, which names no task.
 *
 * A restored record carries no navigation parameters, so the chip resolves the
 * same provider-owned binding its body does and keeps naming the shown task.
 */
import type { ReactNode } from 'react'
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { taskName } from './schedule-format.ts'
import type { ScheduleTaskBindingInjected, ScheduleTaskCatalogInjected } from './ScheduleTaskTab.tsx'
import { useTaskTabTarget } from './task-tab-target.ts'
import css from './TaskManagerPage.module.css'

/** Props of the task tab's chip: the tab it names and the catalog row it reads. */
export type ScheduleTaskTabTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'>
  & PropsLocale<'schedule.manager'>
  & InjectFace<ScheduleTaskCatalogInjected & ScheduleTaskBindingInjected>

/**
 * Render the clock glyph and the named task's stored title as the chip text.
 * @param props - tab information, the Host task catalog, the tab bindings, and localized copy.
 * @returns the clock glyph followed by the task's stored title, or the detail label without a catalog row.
 */
export function ScheduleTaskTabTitle({ sessionId, useTabInfo, useCatalog, taskBindings, t }: ScheduleTaskTabTitleProps): ReactNode {
  const { tab } = useTabInfo()
  const { params } = useTaskTabTarget(sessionId, tab, taskBindings)
  const records = useCatalog(snapshot => snapshot.records)
  const record = params === undefined ? undefined : records.find(item => item.id === params.id)
  return (
    <>
      <IconClockOutlineRegular size={16} className={css.tabTitleIcon} />
      {record === undefined ? t('detail.label') : taskName(record)}
    </>
  )
}

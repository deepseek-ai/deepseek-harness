/**
 * Stage one of the task tab type's registration: what it IS.
 *
 * A page type: it recognizes no resource address, because its content is one
 * task named by navigation parameters rather than by an address, and is opened
 * by kind. `builtin` is the ordinary band for a type shipped with the product.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRightTabDefinition, SidebarRightTabParamsMap, SidebarRightNavigationParams } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** This implementation's identity in the tab system: the key its body and title register under. */
export const SCHEDULE_TASK_ID = '@deepseek-ai/dsh-client-ui-schedule/task'

/** The tab kind this package owns. */
export const SCHEDULE_TASK_KIND = 'scheduleTask'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** One retained task, named by its original Session and its own identity. */
    scheduleTask: { sessionId: SessionId; id: ScheduleId }
  }
}

/**
 * The task type's registry definition.
 *
 * The chip text captured here is a constant because an open names only a kind;
 * `ScheduleTaskTabTitle` replaces it with the shown task's stored title.
 * @param t - namespace-bound translate, read fresh on every title call.
 * @returns the definition to register.
 */
export function scheduleTaskDefinition(t: TranslateNS<'schedule.manager'>): SidebarRightTabDefinition {
  return {
    id: SCHEDULE_TASK_ID,
    kind: SCHEDULE_TASK_KIND,
    priority: 'builtin',
    title: () => t('detail.label'),
  }
}

/**
 * Narrow one tab's navigation parameters to this type's task binding.
 * @param params - the tab record's navigation parameters.
 * @returns the Session and task the tab shows, or undefined for another type's parameters.
 */
export function scheduleTaskParams(
  params: SidebarRightNavigationParams,
): SidebarRightTabParamsMap['scheduleTask'] | undefined {
  if (params === undefined || !('sessionId' in params) || !('id' in params)) return undefined
  return { sessionId: params.sessionId, id: params.id }
}

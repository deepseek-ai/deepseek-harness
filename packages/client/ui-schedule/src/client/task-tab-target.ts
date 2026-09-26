/**
 * Resolve the task one task tab shows.
 *
 * The Sidebar persists a tab's layout record but not the navigation parameters
 * its opener passed, so a restored tab falls back to the binding this page kind
 * last wrote for that layout id. The tab's body and its chip resolve the shown
 * task the same way; the body additionally needs to know whether the current
 * layout still carries parameters, because only a navigated tab reports a
 * missing task.
 * @module
 */
import { useEffect, useMemo } from 'react'
import type { SidebarRightNavigationParams } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { scheduleTaskParams } from './definition.ts'
import type { TaskTabBindings, TaskTabPage, TaskTabTarget } from './task-tab-bindings.ts'

/** The layout and navigation fields one task tab carries. */
export interface TaskTabSource extends TaskTabPage {
  /** Navigation the tab's last open carried; a restored record carries no parameters. */
  readonly navigation: { readonly params: SidebarRightNavigationParams; readonly revision: number }
}

/** The task one task tab resolves, and where it came from. */
export interface TaskTabTargetResolution {
  /** Whether the current layout still carries the opener's navigation parameters. */
  readonly navigated: boolean
  /** Task the navigation named, or undefined when it carried another type's parameters. */
  readonly navigation: TaskTabTarget | undefined
  /** Binding this page kind wrote for this layout id, read only for a restored record. */
  readonly recovered: TaskTabTarget | undefined
  /** Task to show: the navigation's, or the restored binding's. */
  readonly params: TaskTabTarget | undefined
}

/**
 * Resolve the task one task tab shows from its navigation or its stored binding.
 * @param sessionId - the Session holding the tab.
 * @param tab - the tab's layout fields and its last navigation.
 * @param taskBindings - provider-owned binding store for restored task tabs.
 * @returns the navigation, the recovered binding, and the task to show.
 */
export function useTaskTabTarget(
  sessionId: SessionId,
  tab: TaskTabSource,
  taskBindings: TaskTabBindings,
): TaskTabTargetResolution {
  const navigation = scheduleTaskParams(tab.navigation.params)
  const navigated = tab.navigation.params !== undefined
  const recovered = useMemo(
    () => navigated ? undefined : taskBindings.read(sessionId, { id: tab.id, kind: tab.kind, contentId: tab.contentId }),
    [taskBindings, sessionId, tab.id, tab.kind, tab.contentId, navigated, tab.navigation.revision],
  )
  // A read is pure, so the drop of an entry that records another kind or
  // contentId happens here, after the render that read it committed.
  useEffect(() => {
    if (!navigated) taskBindings.dropMismatched(sessionId, { id: tab.id, kind: tab.kind, contentId: tab.contentId })
  }, [taskBindings, sessionId, tab.id, tab.kind, tab.contentId, navigated, tab.navigation.revision])
  return { navigated, navigation, recovered, params: navigation ?? recovered }
}

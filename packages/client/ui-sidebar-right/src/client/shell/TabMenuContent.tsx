/** Preserve existing tab-menu extensions under the clicked Session's retained scope. */
import type { PropsRuntime, PropsRenderSlots, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SidebarSessionViewSnapshot } from '../session-views.ts'

type Props = PropsRuntime<'contextMenu.content'> & PropsRenderSlots<'sidebar.right.tab.menu.item'> & InjectFace<{
  hooks: { views: ObservableSnapshot<readonly SidebarSessionViewSnapshot[]> }
}>
/** @param props - clicked tab and already retained view. @returns existing plugin menu rows. */
export function TabMenuContent({ target, dismiss, useViews, SessionProvider, renderSlot }: Props) {
  const views = useViews(value => value)
  if (target.kind !== 'tab') return null
  const view = views.find(view => view.sessionId === target.value.sessionId)
  const tab = target.value.tab
  if (view === undefined) return null
  return <SessionProvider session={view.reference}>
    {renderSlot('sidebar.right.tab.menu.item', { tab, dismiss })}
  </SessionProvider>
}

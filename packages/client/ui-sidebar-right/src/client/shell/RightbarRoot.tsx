/** Root-scoped controller for the right Sidebar's Session content. */
import { useLayoutEffect } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SidebarSessionViewSnapshot } from '../session-views.ts'
import type {} from '../contract/slots.ts'
import css from './SidebarRight.module.css'

/** Root-only retained Session targets and their committed mount lifetimes. */
export interface RightbarRootInjected {
  readonly hooks: { readonly views: HostObservable<readonly SidebarSessionViewSnapshot[]> }
  readonly mountView: (reference: SessionReference) => () => void
}

type RootProps = PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session'> & InjectFace<RightbarRootInjected>

function SessionView({ view, visible, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }:
  Pick<RootProps, 'SessionProvider' | 'renderSlot' | 'mountView' | 'width' | 'viewportWidth' | 'canShow'>
  & { readonly view: SidebarSessionViewSnapshot; readonly visible: boolean }) {
  useLayoutEffect(() => mountView(view.reference), [mountView, view.reference])
  const active = visible && view.selected
  return <div className={css.session} hidden={!active} data-sidebar-right-session={view.sessionId}>
    <SessionProvider session={view.reference}>
      {renderSlot('rightbar.session', { width, viewportWidth, canShow, active, retainTab: view.retainTab })}
    </SessionProvider>
  </div>
}

/**
 * Keep independent Session subtrees and hide those outside the selected Conversation.
 * @param props - frame geometry, view targets and the authorized Session renderer.
 * @returns the foreground and retained background Sidebars.
 */
export function RightbarRoot({ usePanelInfo, useViews, ...props }: RootProps) {
  const visible = usePanelInfo(info => info.activePanelId === null)
  const views = useViews(value => value)
  return <>{views.map(view => <SessionView key={view.sessionId} {...props} view={view} visible={visible} />)}</>
}

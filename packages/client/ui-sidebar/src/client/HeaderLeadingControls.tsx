/** macOS-desktop conversation-header controls for the fully hidden sidebar. */
import {
  IconNewChatOutline16, IconPanelLeftOutline16, isDarwinDesktop, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the conversation header slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import css from './HeaderLeadingControls.module.css'

/** Full props of the conversation-header leading occupant. */
export type HeaderLeadingControlsProps =
  PropsRuntime<'conversation.session.header.leading'>
  & InjectFace<SidebarRootInjected>
  & PropsLocale<'sidebar'>

/**
 * Sidebar-open and New Session controls in the conversation header's leading
 * seat. On macOS desktop a collapsed sidebar hides entirely (no rail), taking
 * both controls off screen; this occupant puts them back beside the traffic
 * lights. Mounted whenever the platform matches; visibility rides the
 * AppFrame-published `data-sidebar-collapsed` attribute in CSS, so no
 * collapse-state pipe is added here.
 * @param props - Injected sidebar actions plus the sidebar locale seat.
 * @returns the two header controls, or null off macOS desktop.
 */
export function HeaderLeadingControls({ toggleSidebar, startSession, t }: HeaderLeadingControlsProps) {
  if (!isDarwinDesktop()) return null
  return (
    <div className={css.controls}>
      <Tooltip label={t('toggle.open')} delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('toggle.open')}
          onClick={() => { toggleSidebar() }}
        >
          <IconPanelLeftOutline16 size={16} />
        </button>
      </Tooltip>
      <Tooltip label={t('session.new.label')} delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('session.new.label')}
          onClick={() => { startSession() }}
        >
          <IconNewChatOutline16 size={16} />
        </button>
      </Tooltip>
    </div>
  )
}

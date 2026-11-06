/** Session panel slot declarations and composed component props. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { NS } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Sections of the Session panel. `id` addresses the section, `order` sorts
     * the sections ascending, and the required `label` is the section title,
     * which the panel draws. A section with nothing to show renders nothing,
     * and the panel hides its title with it.
     */
    'conversation.session.panel.section': {
      kind: 'list'
      scope: 'session'
      owner: SessionPanelSectionOwnerProps
    }
    /** Trailing controls of one section title, keyed by the section's `id`. */
    'conversation.session.panel.section.actions': { kind: 'keyed'; scope: 'session' }
    /**
     * Marks over the panel toggle, such as an attention dot. They stay visible
     * while the panel is hidden; each occupant includes text that names it for
     * assistive technology, which becomes part of the toggle's name.
     */
    'conversation.session.panel.indicator': { kind: 'list'; scope: 'session'; inline: true }
    /** Rows of the built-in Environment section in ascending `order`. */
    'conversation.session.panel.environment.row': { kind: 'list'; scope: 'session' }
  }
}

/** How the panel currently shows. */
export type SessionPanelPresentation =
  /** Beside the transcript in the Chat View's end gutter. */
  | 'docked'
  /** Over the transcript, opened from the toggle while the gutter is too narrow. */
  | 'overlay'

/** Values every section receives from the panel. */
export interface SessionPanelSectionOwnerProps {
  /** Current presentation; sections may lower their density in the overlay. */
  readonly presentation: SessionPanelPresentation
  /** Close the overlay, for example after a row opened another surface; no effect while docked. */
  readonly dismissOverlay: () => void
}

/** One section the panel draws, projected from the section list's registrations. */
export interface SessionPanelSectionEntry {
  /** Registration id. */
  readonly id: string
  /** Localized title. */
  readonly label: string
}

/** Panel visibility shared by the toggle and the panel. */
export interface SessionPanelVisibility {
  /** Whether the panel docks while the gutter has room; persisted across reloads. */
  readonly pinned: boolean
  /** Session whose overlay is open, or null. */
  readonly overlay: SessionId | null
}

/**
 * End gutter of each Session whose Chat View holds a panel, in CSS px; the
 * widest one when several Chat Views show the Session. A Session without an
 * entry shows no Chat View.
 */
export type SessionPanelGutters = ReadonlyMap<SessionId, number>

/** Business face of the header toggle. */
export interface SessionPanelToggleInjected {
  /** Shared visibility and the Chat View gutters; the renderer binds them as `useVisibility` and `useGutters`. */
  readonly hooks: {
    readonly visibility: ObservableSnapshot<SessionPanelVisibility>
    readonly gutters: ObservableSnapshot<SessionPanelGutters>
  }
  /**
   * Show or hide the panel. With room to dock this flips the docking
   * preference and closes any overlay; otherwise it opens or closes the
   * Session's overlay. No effect while no Chat View shows the Session.
   * @param sessionId - Session whose header holds the toggle.
   */
  readonly toggle: (sessionId: SessionId) => void
}

/** Business face of the panel. */
export interface SessionPanelInjected {
  /** Shared visibility and the projected section roster. */
  readonly hooks: {
    readonly visibility: ObservableSnapshot<SessionPanelVisibility>
    readonly sections: ObservableSnapshot<readonly SessionPanelSectionEntry[]>
  }
  /**
   * Record the end gutter of one mounted panel, or that it unmounted.
   * @param sessionId - Session the panel's Chat View shows.
   * @param instance - identity of the panel within the page.
   * @param endGutter - the Chat View's end gutter in CSS px; null when the panel unmounts or leaves the Session.
   */
  readonly measure: (sessionId: SessionId, instance: string, endGutter: number | null) => void
  /**
   * Close the Session's overlay.
   * @param sessionId - Session whose overlay closes; another Session's overlay stays.
   */
  readonly closeOverlay: (sessionId: SessionId) => void
}

/** Business face of the project row. */
export interface ProjectRowInjected {
  /** Host facts from the connection's ready frame; the renderer binds them as `useHost`. */
  readonly hooks: { readonly host: ObservableSnapshot<RemoteHostFacts> }
}

/** Full props of the header toggle. */
export type SessionPanelToggleProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsRenderSlots<'conversation.session.panel.indicator'>
  & InjectFace<SessionPanelToggleInjected>
  & PropsLocale<typeof NS>

/** Full props of the panel. */
export type SessionPanelProps =
  PropsRuntime<'conversation.chat.aside'>
  & PropsRenderSlots<'conversation.session.panel.section' | 'conversation.session.panel.section.actions'>
  & InjectFace<SessionPanelInjected>
  & PropsLocale<typeof NS>

/** Full props of the built-in Environment section. */
export type EnvironmentSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & PropsRenderSlots<'conversation.session.panel.environment.row'>

/** Full props of the project row. */
export type ProjectRowProps =
  PropsRuntime<'conversation.session.panel.environment.row'>
  & PropsRenderFactories
  & InjectFace<ProjectRowInjected>
  & PropsLocale<typeof NS>

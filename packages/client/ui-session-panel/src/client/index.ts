/**
 * Session panel plugin, browser half: a Session header toggle and a floating
 * panel in the Chat View's aside. The panel draws the titles of the sections
 * other plugins register, lays out the rows they mark, offers the fold control
 * their lists end with and the details their rows show on hover, and ships the
 * Environment section with the working folder row.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { EnvironmentSection } from './EnvironmentSection.tsx'
import { PanelDetails } from './PanelDetails.tsx'
import { PanelFold } from './PanelFold.tsx'
import { ProjectRow } from './ProjectRow.tsx'
import { SessionPanel } from './SessionPanel.tsx'
import { SessionPanelToggle } from './SessionPanelToggle.tsx'
import { ENVIRONMENT_SECTION_ID, sectionSource } from './sections.ts'
import type { ProjectRowInjected, SessionPanelInjected, SessionPanelToggleInjected } from './slots.ts'
import { SessionPanelState } from './visibility.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh, type SessionPanelKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface LocaleNamespaceMap {
    /** Session panel copy. */
    sessionPanel: SessionPanelKey
  }
}

export type {
  EnvironmentSectionProps, PanelDetailsFact, PanelDetailsProps, PanelFoldProps, ProjectRowInjected, ProjectRowProps, SessionPanelDockable,
  SessionPanelIndicatorOwnerProps, SessionPanelInjected, SessionPanelPresentation, SessionPanelProbes, SessionPanelProps,
  SessionPanelSectionEntry, SessionPanelSectionOwnerProps, SessionPanelToggleInjected, SessionPanelToggleProps, SessionPanelVisibility,
} from './slots.ts'

/**
 * Required services: the slot registry, dictionaries, the Host facts of the Remote carrier, and the `uiResponsive`
 * owner of the panel's `useMediaQuery` prop.
 */
export const inject = ['slots', 'locale', 'remote', 'uiResponsive']

/**
 * Client plugin body: register the dictionaries, the fold control and row
 * details Factories, the header toggle, the panel, and the Environment section
 * with its project row.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-session-panel: dictionaries')
  const t = ctx.locale.bind(NS)
  const state = new SessionPanelState()
  ctx.effect(() => () => { state.dispose() }, 'ui-session-panel: overlay follower and dock probes')
  const sections = sectionSource(ctx)
  const host: ObservableSnapshot<RemoteHostFacts> = {
    getSnapshot: () => ctx.remote.$host,
    subscribe: listener => ctx.on('connection/reset', listener),
  }

  ctx.slots.registerFactory({ name: 'conversation.session.panel.fold', scope: 'root' }, PanelFold)
  ctx.slots.registerFactory({ name: 'conversation.session.panel.details', scope: 'root' }, PanelDetails)

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-panel',
    // The first utility: left of change requests, sharing, and the schedule catalog.
    order: -10,
    locale: NS,
    children: {
      'conversation.session.panel.indicator': { kind: 'list', scope: 'session', inline: true },
    },
    inject: (): SessionPanelToggleInjected => ({
      hooks: { visibility: state.visibility, dockable: state.dockable },
      toggle: (sessionId) => { state.toggle(sessionId) },
    }),
  }, SessionPanelToggle))

  ctx.slots.inject('conversation.chat.aside', () => ctx.slots.register({
    name: 'conversation.chat.aside',
    locale: NS,
    children: {
      'conversation.session.panel.section': { kind: 'list', scope: 'session' },
      'conversation.session.panel.section.actions': { kind: 'keyed', scope: 'session' },
    },
    inject: (): SessionPanelInjected => ({
      hooks: { visibility: state.visibility, sections, probes: state.probes },
      createProbeRef: (sessionId, probe) => state.createProbeRef(sessionId, probe),
      closeOverlay: (sessionId) => { state.closeOverlay(sessionId) },
      moveSection: (id, target, placement) => { sections.move(id, target, placement) },
    }),
  }, SessionPanel))

  ctx.slots.inject('conversation.session.panel.section', () => ctx.slots.register({
    name: 'conversation.session.panel.section',
    id: ENVIRONMENT_SECTION_ID,
    order: 0,
    label: () => t('section.environment'),
    children: {
      'conversation.session.panel.environment.row': { kind: 'list', scope: 'session' },
    },
  }, EnvironmentSection))

  ctx.slots.inject('conversation.session.panel.environment.row', () => ctx.slots.register({
    name: 'conversation.session.panel.environment.row',
    id: 'project',
    order: 0,
    locale: NS,
    inject: (): ProjectRowInjected => ({ hooks: { host } }),
  }, ProjectRow))
}

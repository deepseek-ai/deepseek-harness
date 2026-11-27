/** Web subagent catalog, navigation, and addressed-session composer owner. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SubagentHeaderLineage } from './SubagentHeaderLineage.tsx'
import type { SubagentCatalogInjected } from './SubagentCatalog.tsx'
import { SubagentsProgress, SubagentsRunningIndicator, SubagentsSection } from './SubagentsSection.tsx'
import { createSubagentsSectionStore } from './subagents-store.ts'
import {
  SubagentReadOnlyComposer, type SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'
import { registerSidebarChat, subagentChatAddress } from './sidebar-chat/index.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { en, ja, es, fr, de, ru, pt, NS, zh, type SubagentKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface LocaleNamespaceMap {
    /** Subagent catalog and read-only composer copy. */
    'subagent': SubagentKey
  }
}

export type { SubagentCatalogInjected } from './SubagentCatalog.tsx'
export type { SubagentHeaderLineageProps } from './SubagentHeaderLineage.tsx'
export type { SubagentsProgressProps, SubagentsRunningIndicatorProps, SubagentsSectionProps } from './SubagentsSection.tsx'
export type {
  SubagentReadOnlyComposerProps, SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'

/**
 * Required services for subagent presentation and navigation. `uiSession.sessionStatus` provides the
 * `useSessionStatus` hook the lineage header and the Session panel entries render with, so the plugin unloads and
 * reloads with it.
 */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight', 'uiSession.sessionStatus']

/** Claim the composer when the child mode does not allow follow-ups. */
function selectReadOnlySubagent(owner: ComposerChainProps): SubagentReadOnlyMatch | null {
  const subagent = owner.session?.subagent
  if (subagent === undefined || subagent === null) return null
  if (subagent.address.mode === 'unknown') return { reason: 'unknown' }
  if (subagent.address.mode === 'one-shot') return { reason: 'one-shot' }
  return null
}

/**
 * Client plugin body: register the breadcrumb switcher, the Session panel
 * subagents section, and the read-only composer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-subagent: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
    registerSidebarChat(scope, ctx.locale.bind(NS))
  })
  const catalogActions = (_parentSessionId: SessionId): SubagentCatalogInjected => ({
    openChild(address: SubagentAddress) {
      ctx.uiWorkspace.openSession(address)
    },
    openChildAside(address: SubagentAddress) {
      ctx.sidebarRight.openResource(subagentChatAddress(address), {
        kind: 'subagentchat',
        preferNewPane: true,
      })
    },
    async prepareCatalog(parentSessionId: SessionId) {
      await ctx.sessions.refreshProjections(parentSessionId)
      const parent = ctx.sessions.list.getSnapshot().projectionsBySession[parentSessionId]
      if (parent?.state !== 'ready') return
      for (const entry of parent.values.subagentCatalog ?? []) {
        if (entry.mode === 'external') continue
        const state = ctx.sessions.list.getSnapshot()
        if (state.byId[entry.id]?.formatStatus === 'migration-required'
          || state.projectionsBySession[entry.id]?.state === 'migration-required'
          || state.projectionsBySession[entry.id]?.state === 'error') continue
        await ctx.sessions.refreshProjections(entry.id)
      }
    },
    refreshProjection(parentSessionId: SessionId) {
      void ctx.sessions.refreshProjections(parentSessionId)
    },
  })
  ctx.slots.inject(
    'conversation.session.header.lineage',
    () => ctx.slots.register({
      name: 'conversation.session.header.lineage',
      locale: NS,
      inject: catalogActions,
    }, SubagentHeaderLineage),
  )
  ctx.slots.inject('conversation.session.panel.section', function* () {
    yield ctx.slots.register({
      name: 'conversation.session.panel.section',
      id: 'subagents',
      // After change requests (100), before shared tasks (250).
      order: 200,
      label: () => t('section.title'),
      locale: NS,
      store: createSubagentsSectionStore(),
      inject: catalogActions,
    }, SubagentsSection)
    yield ctx.slots.register({
      name: 'conversation.session.panel.section.actions',
      key: 'subagents',
      locale: NS,
    }, SubagentsProgress)
  })
  ctx.slots.inject('conversation.session.panel.indicator', () => ctx.slots.register({
    name: 'conversation.session.panel.indicator',
    id: 'subagents.running',
    // Below an attention mark, which paints above running dots.
    order: 10,
    locale: NS,
  }, SubagentsRunningIndicator))
  ctx.slots.inject(
    'conversation.composer',
    () => ctx.slots.register({
      name: 'conversation.composer',
      priority: -10,
      locale: NS,
      select: selectReadOnlySubagent,
    }, SubagentReadOnlyComposer),
  )
}

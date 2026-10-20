/** Rows for the More menus of the left sidebar, Conversation View tabs, and right-sidebar guide. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { EntryMenuContent, type EntryMenuInjected, type EntryRegion } from './EntryMenuContent.tsx'
import { en, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** More menu rows: pin actions, footer actions, and Creator draft prompts. */
    entryCustomization: keyof typeof en
  }
}

/** Services used by the menu rows' footer actions. */
export const inject = ['slots', 'locale', 'pluginNavigation', 'uiWorkspace']

/**
 * Register the same menu rows into each region's More menu.
 * @param ctx - Browser context with slot, locale, plugin navigation, and Workspace services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('entryCustomization', { en, zh }))
  const t = ctx.locale.bind('entryCustomization')
  const injected = (region: EntryRegion): EntryMenuInjected => ({
    region,
    browsePlugins: () => { ctx.pluginNavigation.openList() },
    createPlugin: () => {
      ctx.uiWorkspace.startSession(undefined, {
        agentPreset: 'cordis', prompt: t(`createPrompt.${region}`), whenDraftExists: 'append',
      })
    },
  })
  ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({
    name: 'sidebar.panellist.actions', id: 'entry-customization', locale: 'entryCustomization',
    inject: () => injected('sidebar'),
  }, EntryMenuContent))
  ctx.slots.inject('conversation.session.header.views.actions', () => ctx.slots.register({
    name: 'conversation.session.header.views.actions', id: 'entry-customization', locale: 'entryCustomization',
    inject: () => injected('conversation'),
  }, EntryMenuContent))
  ctx.slots.inject('sidebar.right.tab.guide.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.actions', id: 'entry-customization', locale: 'entryCustomization',
    inject: () => injected('rightbar'),
  }, EntryMenuContent))
}

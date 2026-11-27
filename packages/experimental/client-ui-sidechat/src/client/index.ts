/** Browser plugin: `/side` forks the conversation at its latest completed Turn into the right Sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconCompareSplitOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import { SidechatControl } from './control.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { parseSidechatAddress, SIDECHAT_ADDRESS, sidechatResourceProvider } from './resource.ts'
import { SidechatConversation, SidechatTab, SidechatTitle, SidechatToast, type SidechatNoticeInjected } from './views.tsx'

// Type-only re-exports publish the slot, resource and locale augmentations through the `/client` entry.
export type {} from './locales.ts'
export type {} from './resource.ts'
export type {} from './views.tsx'

/** Services used by the side conversation plugin. */
export const inject = ['slots', 'locale', 'sessions', 'resources', 'sidebarRight', 'sidebarRightTabs', 'commandUi']

/**
 * Register the `/side` command, the child resource and its Sidebar tab for this plugin's lifetime.
 * @param ctx - Client root with Session, resource and right-Sidebar services.
 */
export function apply(ctx: Context): void {
  const id = '@deepseek-ai/dsh-client-ui-sidechat'
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'sidechat: dictionaries')
  const control = new SidechatControl(ctx)
  ctx.effect(() => () => { control.dispose() }, 'sidechat: in-flight forks')
  const t = ctx.locale.bind(NS)
  // Always available: an unavailable command lets a typed `/side` reach the model as a message.
  // The Host refuses a source without a completed Turn; the control reports that refusal.
  ctx.effect(() => ctx.commandUi.register({
    name: 'side', label: () => t('command'), description: () => t('command.description'), icon: IconCompareSplitOutlineRegular,
    available: () => true,
    ui: { kind: 'action', run: (session) => { control.fork(session.sessionId) } },
  }), 'sidechat: /side command')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'sidechat.notice', locale: NS,
    inject: (): SidechatNoticeInjected => ({ hooks: { notice: control.notice }, dismiss: () => { control.dismiss() } }),
  }, SidechatToast)), 'sidechat: failure notice')
  ctx.effect(() => ctx.resources.register(sidechatResourceProvider(ctx.sessions)), 'sidechat: child resources')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind: 'sidechat',
    patterns: [`${SIDECHAT_ADDRESS}**`],
    canOpen: address => parseSidechatAddress(address) !== undefined,
    title: () => t('title'),
  }), 'sidechat: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: id, locale: NS,
    children: { 'sidechat.conversation': { kind: 'single', scope: 'session' } },
  }, SidechatTab)), 'sidechat: tab body')
  ctx.effect(() => ctx.slots.inject('sidechat.conversation', () => ctx.slots.register({
    name: 'sidechat.conversation',
  }, SidechatConversation)), 'sidechat: embedded Conversation')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: id, locale: NS,
  }, SidechatTitle)), 'sidechat: tab title')
}

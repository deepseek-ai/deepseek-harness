/** Register interactive terminal tabs and explicit process cleanup with the sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { TerminalGuideIcon } from './TerminalIcon.tsx'
import { TerminalBody } from './TerminalBody.tsx'
import { TerminalTitle } from './TerminalTitle.tsx'
import { TerminalRecovery, type TerminalRecoveryInjected } from './TerminalRecovery.tsx'
import { TerminalCleanup, type TerminalCleanupInjected } from './TerminalCleanup.tsx'
import type { TerminalBodyInjected, TerminalInjected } from './face.ts'
import { en, zh } from './locales.ts'

/** Services needed by the terminal's two sidebar seats. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'webTerminals', 'theme']

/**
 * Register the terminal type, observable views and background process cleanup.
 * @param ctx - Client root Context with sidebar and terminal services.
 */
export function apply(ctx: Context): void {
  let disposed = false
  const recovered = new Map<SessionId, Promise<void>>()
  ctx.effect(() => () => { disposed = true; recovered.clear() }, 'ui-sidebar-terminal.lifetime')
  const terminalId = (sessionId: SessionId, key: string): WebTerminalId | undefined => {
    const params = ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation.getSnapshot().params
    return (params as { terminalId?: WebTerminalId } | undefined)?.terminalId
  }
  const view = (sessionId: SessionId, key: string) => ctx.webTerminals.view(sessionId, key, terminalId(sessionId, key))
  const namespace = 'sidebarTerminal'
  const id = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-terminal.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind: 'terminal', multiple: true, priority: 'builtin', title: () => t('title'),
    guide: [{ order: 20, title: () => t('new'), description: () => t('description'), icon: TerminalGuideIcon }],
  }), 'ui-sidebar-terminal.type')
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler('terminal', (sessionId, tab) => {
    ctx.webTerminals.close(sessionId, tab.id, terminalId(sessionId, tab.id))
  }), 'ui-sidebar-terminal.close')
  const inject = (sessionId: SessionId): TerminalInjected => ({
    view: key => view(sessionId, key),
    keyedHooks: { terminal: key => view(sessionId, key).state },
  })
  const theme: TerminalBodyInjected['hooks']['theme'] = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: listener => ctx.on('theme/change', listener),
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: id, locale: namespace,
      inject: (sessionId): TerminalBodyInjected => ({ ...inject(sessionId), hooks: { theme } }),
    }, TerminalBody,
  )), 'ui-sidebar-terminal.body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: id, locale: namespace, inject }, TerminalTitle,
  )), 'ui-sidebar-terminal.title')
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id, locale: namespace,
    inject: (sessionId): TerminalRecoveryInjected => ({
      restore: () => {
        let pending = recovered.get(sessionId)
        if (pending === undefined) {
          pending = ctx.webTerminals.recover(sessionId).then((terminals) => {
            if (disposed) return
            for (const info of terminals) ctx.sidebarRight.openTabIn(sessionId, 'terminal', {
              params: { terminalId: info.id },
            })
          }).catch((error: unknown) => { recovered.delete(sessionId); throw error })
          recovered.set(sessionId, pending)
        }
        return pending
      },
    }),
  }, TerminalRecovery)), 'ui-sidebar-terminal.recovery')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id, locale: namespace,
    inject: (): TerminalCleanupInjected => ({
      hooks: { closeFailures: ctx.webTerminals.closeFailures },
      retryClose: (terminalId) => { ctx.webTerminals.retryClose(terminalId) },
    }),
  }, TerminalCleanup)), 'ui-sidebar-terminal.cleanup')
}

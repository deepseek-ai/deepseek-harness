/** Source-safe task-board browser registration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TeamAction } from './TeamAction.tsx'
import { en, ja, es, fr, de, ru, pt, NS, zh, type TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shared task-board copy. */
    'agent-team': TeamKey
  }
}

/** Required browser services for slots and localized copy. */
export const inject = ['slots', 'locale']

/**
 * Register the task-board locale dictionaries and conversation-header action.
 * The panel reads the root Session’s `agentTeam` projection through standard Session hooks.
 * @param ctx - Client Context carrying the injected locale and slot services.
 */
export function registerAgentTeamUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'client-ui-agent-team: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team',
      order: -20,
      locale: NS,
    }, TeamAction),
  )
}

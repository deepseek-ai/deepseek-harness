/** Source-safe task-board browser registration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { TeamModeToggle, type TeamModeToggleInjected } from './TeamModeToggle.tsx'
import { TeamAction } from './TeamAction.tsx'
import { en, NS, zh, type TeamKey } from './locales.ts'

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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-agent-team: dictionaries')
  ctx.inject(['remote', 'remote.commands'], (scope) => {
    scope.slots.inject('conversation.input.model.options', () => scope.slots.register({
      name: 'conversation.input.model.options',
      id: 'agent-team',
      locale: NS,
      inject: (sessionId): TeamModeToggleInjected => ({
        selectTeamMode: async (enabled) => {
          const response = await scope.remote.commands.execute(sessionId, enabled ? '/team on' : '/team off', [])
          if (!response.ok) return response.error.message
          if (response.value === undefined) return scope.locale.bind(NS)('mode.unavailable')
          return response.value.result.kind === 'error' ? response.value.result.text : null
        },
      }),
    }, TeamModeToggle))
  })
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

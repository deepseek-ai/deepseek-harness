/** Source-safe task-board browser registration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TeamDisableConfirmation, type TeamDisableConfirmationInjected, type TeamDisableRequest } from './TeamDisableConfirmation.tsx'
import { TeamModeToggle, type TeamModeToggleInjected } from './TeamModeToggle.tsx'
import { TeamBoard } from './TeamBoard.tsx'
import { TeamCommandRow } from './TeamCommandRow.tsx'
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
 * Register the task-board dictionaries and subagent catalog sections.
 * The panel reads the root Session’s `agentTeam` projection through standard Session hooks.
 * @param ctx - Client Context carrying the injected locale and slot services.
 */
export function registerAgentTeamUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'client-ui-agent-team: dictionaries')
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview', key: 'team', locale: NS,
  }, TeamCommandRow))
  ctx.inject(['remote', 'remote.agentTeams'], (scope) => {
    scope.slots.inject('shell.overlay', function* () {
      const disableRequest = createSnapshotStore<TeamDisableRequest | null>(null)
      const selectTeamMode = async (sessionId: SessionId, enabled: boolean): Promise<string | null> => {
        const response = await scope.remote.agentTeams.setEnabled(sessionId, enabled)
        return response.ok ? null : response.error.message
      }
      yield () => { disableRequest.set(null) }
      yield scope.slots.register({
        name: 'shell.overlay', id: 'agent-team.disable', locale: NS,
        inject: (): TeamDisableConfirmationInjected => ({
          hooks: { disableRequest },
          cancelDisable: (sessionId) => {
            if (disableRequest.getSnapshot()?.sessionId === sessionId) disableRequest.set(null)
          },
          disableTeam: sessionId => selectTeamMode(sessionId, false),
        }),
      }, TeamDisableConfirmation)
      yield scope.slots.inject('conversation.input.model.options', () => scope.slots.register({
        name: 'conversation.input.model.options',
        id: 'agent-team',
        locale: NS,
        inject: (sessionId): TeamModeToggleInjected => ({
          selectTeamMode: enabled => selectTeamMode(sessionId, enabled),
          requestDisableConfirmation: () => { disableRequest.set({ sessionId }) },
        }),
      }, TeamModeToggle))
    })
  })
  ctx.slots.inject('conversation.session.header.actions.subagent.footer', () => ctx.slots.register({
    name: 'conversation.session.header.actions.subagent.footer', id: 'agent-team', locale: NS,
  }, TeamBoard))
}

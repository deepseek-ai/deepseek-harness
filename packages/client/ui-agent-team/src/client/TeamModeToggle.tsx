/** Session-owned Agent Teams selection in the model and reasoning menu. */

import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-agent-team/client'
import type { NS } from './locales.ts'
import css from './TeamModeToggle.module.css'

/** Session command supplied by the Client plugin. */
export interface TeamModeToggleInjected {
  /** Save the selection; null means success, otherwise the string describes the failure. */
  selectTeamMode: (enabled: boolean) => Promise<string | null>
}

/** Full props of the model-menu Team switch. */
export type TeamModeToggleProps = PropsRuntime<'conversation.input.model.options'>
  & PropsLocale<typeof NS> & TeamModeToggleInjected

/**
 * Render the saved selection without an optimistic update.
 * @param props - Session projection, menu state, localized copy, and selection command.
 * @returns the Team switch when the capability projection is available.
 */
export function TeamModeToggle(props: TeamModeToggleProps) {
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (addressedChild || listedChild) return null
  return <RootTeamModeToggle {...props} />
}

/** Read and change the selection only for root Sessions. */
function RootTeamModeToggle({ useProjection, locked, reportFailure, selectTeamMode, t }: TeamModeToggleProps) {
  const mode = useProjection('agentTeam')
  const [pending, setPending] = useState(false)
  if (mode === undefined) return null
  const select = (enabled: boolean): void => {
    setPending(true)
    void selectTeamMode(enabled).then((failure) => {
      if (failure !== null) reportFailure(t('mode.failed', { message: failure }))
    }, (error: unknown) => {
      reportFailure(t('mode.failed', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { setPending(false) })
  }
  return (
    <div className={css.row}>
      <span>{t('mode.label')}</span>
      <Switch checked={mode.enabled} disabled={locked || pending} label={t('mode.label')} onChange={select} />
    </div>
  )
}

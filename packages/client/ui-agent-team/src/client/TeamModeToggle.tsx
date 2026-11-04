/** Session-owned Agent Teams selection in the model and reasoning menu. */

import { useState } from 'react'
import { Button, IconInfoOutlineRegular, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-agent-team/client'
import type {} from '@deepseek-ai/dsh-agent'
import type { NS } from './locales.ts'
import css from './TeamModeToggle.module.css'

/** Session selection callbacks supplied by the Client plugin. */
export interface TeamModeToggleInjected {
  /** Save the selection; null means success, otherwise the string describes the failure. */
  selectTeamMode: (enabled: boolean) => Promise<string | null>
  /** Open a Session-targeted confirmation outside this menu. */
  requestDisableConfirmation: () => void
}

/** Full props of the model-menu Team switch. */
export type TeamModeToggleProps = PropsRuntime<'conversation.input.model.options'>
  & PropsLocale<typeof NS> & TeamModeToggleInjected

/**
 * Render the saved selection without an optimistic update.
 * @param props - Session projection, menu state, localized copy, and selection callback.
 * @returns the Team switch when the capability projection is available.
 */
export function TeamModeToggle(props: TeamModeToggleProps) {
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (addressedChild || listedChild) return null
  return <RootTeamModeToggle {...props} />
}

/** Read and change the selection only for root Sessions. */
function RootTeamModeToggle({
  useProjection, locked, dismiss, reportFailure, selectTeamMode, requestDisableConfirmation, t,
}: TeamModeToggleProps) {
  const mode = useProjection('agentTeam')
  const modelSelection = useProjection('modelSelection')
  const [pending, setPending] = useState(false)
  if (mode === undefined) return null
  const select = (enabled: boolean): void => {
    if (!enabled && modelSelection !== undefined && modelSelection.lastUsed !== null) {
      dismiss()
      requestDisableConfirmation()
      return
    }
    setPending(true)
    void selectTeamMode(enabled).then((failure) => {
      if (failure !== null) reportFailure(t('mode.failed', { message: failure }))
    }, (error: unknown) => {
      reportFailure(t('mode.failed', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { setPending(false) })
  }
  return (
    <div className={css.row}>
      <span className={css.label}>
        <span>{t('mode.label')}</span>
        <Tooltip label={t('mode.description')} side="top" delayMs={300} maxWidth={300} portal openOnClick>
          <Button variant="ghost" size="sm" className={css.infoButton} aria-label={t('mode.infoLabel')}>
            <IconInfoOutlineRegular size={11} aria-hidden="true" />
          </Button>
        </Tooltip>
      </span>
      <Switch className={css.toggle} checked={mode.enabled} disabled={locked || pending || modelSelection === undefined} label={t('mode.label')} onChange={select} />
    </div>
  )
}

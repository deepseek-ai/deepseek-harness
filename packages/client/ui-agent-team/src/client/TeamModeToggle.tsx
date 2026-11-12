/** Session-owned Agent Teams summary and settings inside the model menu. */

import { useId, useState } from 'react'
import { IconChevronRightOutlineRegular, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-agent-team/client'
import type {} from '@deepseek-ai/dsh-agent'
import type { NS } from './locales.ts'
import css from './TeamModeToggle.module.css'

/** Session selection callbacks supplied to the Team settings pane. */
export interface TeamModePaneInjected {
  /** Save the selection; null means success, otherwise the string describes the failure. */
  selectTeamMode: (enabled: boolean) => Promise<string | null>
  /** Open a Session-targeted confirmation outside this menu. */
  requestDisableConfirmation: () => void
}

/** Full props of the model-menu Team summary. */
export type TeamModeToggleProps = PropsRuntime<'conversation.input.model.options'> & PropsLocale<typeof NS>

/** Full props of the model-menu Team settings pane. */
export type TeamModePaneProps = PropsRuntime<'conversation.input.model.pane'>
  & PropsLocale<typeof NS> & TeamModePaneInjected

/**
 * Show the saved Team state and open its settings without changing the mode.
 * @param props - Session projection, pane navigation, and locale.
 * @returns the summary when Team mode is available on a root Session.
 */
export function TeamModeToggle(props: TeamModeToggleProps) {
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (addressedChild || listedChild) return null
  return <RootTeamModeSummary {...props} />
}

function RootTeamModeSummary({ useProjection, locked, openPane, t }: TeamModeToggleProps) {
  const mode = useProjection('agentTeam')
  if (mode === undefined) return null
  return (
    <button
      type="button"
      role="menuitem"
      className={css.summary}
      data-model-menu-pane="agent-team"
      disabled={locked}
      onClick={() => { openPane({ key: 'agent-team', title: t('command.title') }) }}
    >
      <span className={css.summaryLabel}>{t('command.title')}</span>
      <span className={css.state}>{t(mode.enabled ? 'mode.on' : 'mode.off')}</span>
      <IconChevronRightOutlineRegular className={css.chevron} aria-hidden="true" />
    </button>
  )
}

/**
 * Present the explanation and persisted Team switch for a root Session.
 * @param props - Session projections, mode operations, menu dismissal, and locale.
 * @returns the Team settings content when its projection is available.
 */
export function TeamModePane(props: TeamModePaneProps) {
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (addressedChild || listedChild) return null
  return <RootTeamModePane {...props} />
}

/** Read and change the selection only for root Sessions. */
function RootTeamModePane({
  useProjection, locked, dismiss, reportFailure, selectTeamMode, requestDisableConfirmation, t,
}: TeamModePaneProps) {
  const mode = useProjection('agentTeam')
  const modelSelection = useProjection('modelSelection')
  const [pending, setPending] = useState(false)
  const descriptionId = useId()
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
    <div className={css.pane}>
      <div className={css.row}>
        <span className={css.label}>{t('mode.label')}</span>
        <Switch className={css.toggle} checked={mode.enabled} disabled={locked || pending || modelSelection === undefined} label={t('mode.label')} onChange={select} autoFocus describedBy={descriptionId} />
      </div>
      <p id={descriptionId} className={css.description}>{t('mode.description')}</p>
    </div>
  )
}

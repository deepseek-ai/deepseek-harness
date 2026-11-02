/** Session-targeted confirmation that outlives the model menu which opened it. */
import { useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { NS } from './locales.ts'
import css from './TeamDisableConfirmation.module.css'

/** The originating Session remains the target while the dialog is open. */
export interface TeamDisableRequest {
  sessionId: SessionId
}

/** Confirmation request and Session-bound selection callbacks supplied by the plugin. */
export interface TeamDisableConfirmationInjected {
  hooks: { disableRequest: HostObservable<TeamDisableRequest | null> }
  cancelDisable: (sessionId: SessionId) => void
  disableTeam: (sessionId: SessionId) => Promise<string | null>
}

/** Root overlay props, independent of the model menu lifetime. */
export type TeamDisableConfirmationProps = PropsRuntime<'shell.overlay'>
  & InjectFace<TeamDisableConfirmationInjected> & PropsLocale<typeof NS>

/**
 * Render the requested confirmation outside the model menu.
 * @param props - request observation, command callbacks, and localized text.
 * @returns the confirmation, or nothing when no request is pending.
 */
export function TeamDisableConfirmation({ useDisableRequest, ...props }: TeamDisableConfirmationProps) {
  const request = useDisableRequest(value => value)
  if (request === null) return null
  return <DisableConfirmationForm key={request.sessionId} sessionId={request.sessionId} {...props} />
}

/** One confirmation keeps its failure visible until retry or cancellation. */
function DisableConfirmationForm({ sessionId, cancelDisable, disableTeam, t }: {
  sessionId: SessionId
  cancelDisable: TeamDisableConfirmationInjected['cancelDisable']
  disableTeam: TeamDisableConfirmationInjected['disableTeam']
  t: TeamDisableConfirmationProps['t']
}) {
  const [state, setState] = useState<{ kind: 'ready' } | { kind: 'saving' } | { kind: 'failed'; message: string }>({ kind: 'ready' })
  const saving = state.kind === 'saving'
  const cancel = (): void => {
    if (!saving) cancelDisable(sessionId)
  }
  const confirm = (): void => {
    if (saving) return
    setState({ kind: 'saving' })
    void disableTeam(sessionId).then((failure) => {
      if (failure === null) cancelDisable(sessionId)
      else setState({ kind: 'failed', message: failure })
    }, (error: unknown) => {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
  }
  return (
    <Modal open tone="warning" title={t('disable.title')} closeLabel={t('disable.close')} onClose={cancel}
      className={css.dialog ?? ''} contentClassName={css.content ?? ''}
      footer={(
        <>
          <Button variant="outline" disabled={saving} data-modal-autofocus onClick={cancel}>{t('disable.cancel')}</Button>
          <Button variant="primary" disabled={saving} onClick={confirm}>{t('disable.confirm')}</Button>
        </>
      )}
    >
      <div className={css.copy}>
        <p>{t('disable.description')}</p>
        <p>{t('disable.warning')}</p>
      </div>
      {state.kind === 'failed' && <p role="alert" className={css.error}>{t('mode.failed', { message: state.message })}</p>}
    </Modal>
  )
}

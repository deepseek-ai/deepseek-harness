/** Feishu connection surfaces on the Plugins page: the bundle section, title tag, activation guidance, and notices. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { FEISHU_PACKAGE, presentConnection, type ConnectionFace, type ConnectionPresentation } from './connection.ts'
import type { FeishuKey, NS } from './locales.ts'
import css from './FeishuConnection.module.css'

type Phase = ConnectionPresentation['phase']
type FaceProps = InjectFace<ConnectionFace> & PropsLocale<typeof NS>

const TONE: Record<Phase, StateDotState> = {
  checking: 'ongoing', connecting: 'ongoing', connected: 'done', disconnected: 'idle', unavailable: 'warning', stopped: 'warning',
}

const BADGE: Record<Phase, readonly [FeishuKey, TagTone] | undefined> = {
  checking: undefined,
  connecting: ['badge.connecting', 'info'],
  connected: ['badge.connected', 'success'],
  disconnected: ['badge.disconnected', 'outline'],
  unavailable: ['badge.unavailable', 'warning'],
  stopped: ['badge.stopped', 'warning'],
}

/**
 * The connection section on the Feishu bundle's page.
 * @param props - the shared connection face and the Feishu dictionary.
 * @returns the status line, its actions, and the sign-out confirmation.
 */
export function FeishuConnectionSection(props: FaceProps): ReactNode {
  const { useFeishuConnection, check, linkApp, signIn, cancel, signOut, openAuthorization, retry, t } = props
  const snapshot = useFeishuConnection(value => value)
  const [confirming, setConfirming] = useState(false)
  const shown = presentConnection(snapshot)
  // Reopening a stopped stream is the one action that does not need the Host stream.
  const disabled = snapshot.busy || (!snapshot.linked && shown.phase !== 'stopped')
  const action = (label: FeishuKey, onClick: () => void, variant: 'primary' | 'outline' | 'ghost' = 'outline'): ReactNode =>
    <Button key={label} variant={variant} size="sm" disabled={disabled} onClick={onClick}>{t(label)}</Button>
  const actions: ReactNode[] = []
  let status = t(`status.${shown.phase === 'connecting' ? 'checking' : shown.phase}`)
  let detail: string | undefined
  switch (shown.phase) {
    case 'disconnected':
      actions.push(shown.next === 'link-app' ? action('action.linkApp', linkApp, 'primary') : action('action.signIn', signIn, 'primary'))
      detail = t(shown.next === 'link-app' ? 'detail.no-app' : 'detail.signed-out')
      break
    case 'unavailable': actions.push(action('action.retry', check)); detail = t('detail.unavailable'); break
    case 'stopped': actions.push(action('action.retry', retry)); detail = t('detail.stopped'); break
    case 'connected':
      actions.push(action('action.signOut', () => { setConfirming(true) }))
      detail = shown.userName === undefined ? t('detail.connected') : t('detail.connectedAs', { name: shown.userName })
      break
    case 'connecting':
      status = t(`step.${shown.step}`)
      if (shown.url !== undefined) {
        actions.push(action('action.open', openAuthorization, 'primary'))
        if (shown.step === 'configuring' || shown.step === 'authorizing') detail = t(`detail.${shown.step}`)
      }
      if (shown.cancellable) actions.push(action('action.cancel', cancel, 'ghost'))
      break
    case 'checking': break
  }
  return (
    <div className={css.section} data-feishu-connection={shown.phase}>
      <h4 className={css.title}>{t('section.title')}</h4>
      <div className={css.status}>
        <StateDot state={TONE[shown.phase]} />
        <span className={css.label}>{status}</span>
        <div className={css.actions}>{actions}</div>
      </div>
      {detail === undefined ? null : <p className={css.detail}>{detail}</p>}
      {'failed' in shown && shown.failed ? <p className={css.failure} role="alert">{t('failed')}</p> : null}
      <p className={css.hint}>{t('hint')}</p>
      <Modal open={confirming} title={t('signOut.title')} closeLabel={t('close')} onClose={() => { setConfirming(false) }}
        footer={<>
          <Button variant="ghost" onClick={() => { setConfirming(false) }}>{t('action.cancel')}</Button>
          <Button variant="primary" data-modal-autofocus onClick={() => { setConfirming(false); signOut() }}>{t('action.signOut')}</Button>
        </>}>
        <p>{t('signOut.body')}</p>
      </Modal>
    </div>
  )
}

/**
 * The connection tag beside the Feishu bundle's title.
 * @param props - the open detail page's subject, the connection face, and the dictionary.
 * @returns the tag for the Feishu bundle, or null on any other page.
 */
export function FeishuConnectionBadge({ subject, useFeishuConnection, t }: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const phase = useFeishuConnection(value => presentConnection(value).phase)
  if (subject.kind === 'item' || subject.pkg.name !== FEISHU_PACKAGE || !subject.pkg.enabled) return null
  const badge = BADGE[phase]
  return badge === undefined ? null : <Tag tone={badge[1]}>{t(badge[0])}</Tag>
}

/**
 * Guidance after the user switches the Feishu bundle on while the account is not connected.
 * @param props - activation callbacks, the connection face, and the dictionary.
 * @returns a dismissible prompt that starts the connection from the bundle's page.
 */
export function FeishuConnectionActivation(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useFeishuConnection, linkApp, signIn, onDismiss, onOpenDetails, t } = props
  const phase = useFeishuConnection(value => presentConnection(value).phase)
  const next = useFeishuConnection((value) => {
    const shown = presentConnection(value)
    return shown.phase === 'disconnected' ? shown.next : undefined
  })
  const needed = phase === 'disconnected'
  useEffect(() => {
    if (phase !== 'checking' && !needed) onDismiss()
  }, [phase, needed, onDismiss])
  return (
    <Modal open={needed} title={t('activation.title')} closeLabel={t('close')} onClose={onDismiss}
      footer={<>
        <Button variant="ghost" onClick={onDismiss}>{t('activation.later')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => {
          onOpenDetails()
          if (next === 'sign-in') signIn()
          else linkApp()
        }}>{t('action.connect')}</Button>
      </>}>
      <p>{t('activation.body')}</p>
    </Modal>
  )
}

/**
 * Connection outcomes reported outside the Plugins panel's lifetime.
 * @param props - the shared notice, its dismissal, and the dictionary.
 * @returns the toast for the latest notice, or null.
 */
export function FeishuConnectionToast({ useFeishuConnection, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useFeishuConnection(value => value.notice)
  if (notice === undefined) return null
  const failed = notice.kind === 'action-failed'
  return (
    <Toast key={notice.seq} text={t(`notice.${notice.kind}`)} onDone={dismissNotice}
      {...failed ? { icon: <IconWarningOutlineRegular /> } : { tone: 'success' as const }} />
  )
}

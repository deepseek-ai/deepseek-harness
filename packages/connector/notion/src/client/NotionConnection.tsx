/** Notion connection surfaces on the Plugins page: the bundle section, title tag, activation guidance, and notices. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { NOTION_PACKAGE, presentConnection, type ConnectionFace, type ConnectionPresentation } from './connection.ts'
import type { NotionKey, NS } from './locales.ts'
import css from './NotionConnection.module.css'

type Phase = ConnectionPresentation['phase']
type FaceProps = InjectFace<ConnectionFace> & PropsLocale<typeof NS>

const TONE: Record<Phase, StateDotState> = {
  'checking': 'ongoing', 'connecting': 'ongoing', 'authorizing': 'ongoing', 'waiting-browser': 'ongoing',
  'connected': 'done', 'disconnected': 'idle', 'reconnect': 'warning', 'unavailable': 'error',
}

const BADGE: Record<Phase, readonly [NotionKey, TagTone] | undefined> = {
  'checking': undefined,
  'connecting': ['badge.connecting', 'info'], 'authorizing': ['badge.connecting', 'info'], 'waiting-browser': ['badge.connecting', 'info'],
  'connected': ['badge.connected', 'success'], 'disconnected': ['badge.disconnected', 'outline'],
  'reconnect': ['badge.reconnect', 'warning'], 'unavailable': ['badge.unavailable', 'danger'],
}

function detail(shown: ConnectionPresentation): NotionKey | undefined {
  switch (shown.phase) {
    case 'checking': return undefined
    case 'reconnect': return `detail.reconnect.${shown.reason}`
    default: return `detail.${shown.phase}`
  }
}

/**
 * The connection section on the Notion bundle's page.
 * @param props - the shared connection face and the Notion dictionary.
 * @returns the status line, its actions, and the sign-out confirmation.
 */
export function NotionConnectionSection(props: FaceProps): ReactNode {
  const { useNotionConnection, connect, cancel, signOut, retry, openAuthorization, t } = props
  const snapshot = useNotionConnection(value => value)
  const [confirming, setConfirming] = useState(false)
  const shown = presentConnection(snapshot.server)
  const disabled = snapshot.busy || !snapshot.linked
  const key = detail(shown)
  const action = (label: NotionKey, onClick: () => void, variant: 'primary' | 'outline' | 'ghost' = 'outline'): ReactNode =>
    <Button key={label} variant={variant} size="sm" disabled={disabled} onClick={onClick}>{t(label)}</Button>
  const actions: ReactNode[] = []
  switch (shown.phase) {
    case 'disconnected': actions.push(action('action.connect', connect, 'primary')); break
    case 'reconnect': actions.push(action('action.reconnect', connect, 'primary')); break
    case 'waiting-browser': actions.push(action('action.open', openAuthorization, 'primary'), action('action.cancel', cancel, 'ghost')); break
    case 'authorizing': actions.push(action('action.cancel', cancel, 'ghost')); break
    case 'connected': actions.push(action('action.signOut', () => { setConfirming(true) })); break
    case 'unavailable': actions.push(action('action.retry', retry)); break
    case 'checking':
    case 'connecting': break
  }
  return (
    <div className={css.section} data-notion-connection={shown.phase}>
      <h4 className={css.title}>{t('section.title')}</h4>
      <div className={css.status}>
        <StateDot state={TONE[shown.phase]} />
        <span className={css.label}>{t(`status.${shown.phase}`)}</span>
        <div className={css.actions}>{actions}</div>
      </div>
      {key === undefined ? null : <p className={css.detail}>{t(key)}</p>}
      {'failed' in shown && shown.failed ? <p className={css.failure} role="alert">{t('failed')}</p> : null}
      <p className={css.hint}>{t('hostBrowser')}</p>
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
 * The connection tag beside the Notion bundle's title.
 * @param props - the open detail page's subject, the connection face, and the dictionary.
 * @returns the tag for the Notion bundle, or null on any other page.
 */
export function NotionConnectionBadge({ subject, useNotionConnection, t }: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const phase = useNotionConnection(value => presentConnection(value.server).phase)
  if (subject.kind === 'item' || subject.pkg.name !== NOTION_PACKAGE || !subject.pkg.enabled) return null
  const badge = BADGE[phase]
  return badge === undefined ? null : <Tag tone={badge[1]}>{t(badge[0])}</Tag>
}

/**
 * Guidance after the user switches the Notion bundle on while no account is connected.
 * @param props - activation callbacks, the connection face, and the dictionary.
 * @returns a dismissible prompt that starts authorization from the bundle's page.
 */
export function NotionConnectionActivation({ useNotionConnection, connect, onDismiss, onOpenDetails, t }: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const phase = useNotionConnection(value => presentConnection(value.server).phase)
  const needed = phase === 'disconnected' || phase === 'reconnect'
  useEffect(() => {
    if (phase !== 'checking' && !needed) onDismiss()
  }, [phase, needed, onDismiss])
  return (
    <Modal open={needed} title={t('activation.title')} closeLabel={t('close')} onClose={onDismiss}
      footer={<>
        <Button variant="ghost" onClick={onDismiss}>{t('activation.later')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => { onOpenDetails(); connect() }}>{t('action.connect')}</Button>
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
export function NotionConnectionToast({ useNotionConnection, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useNotionConnection(value => value.notice)
  if (notice === undefined) return null
  const failed = notice.kind === 'action-failed'
  return (
    <Toast key={notice.seq} text={t(`notice.${notice.kind}`)} onDone={dismissNotice}
      {...failed ? { icon: <IconWarningOutlineRegular /> } : { tone: 'success' as const }} />
  )
}

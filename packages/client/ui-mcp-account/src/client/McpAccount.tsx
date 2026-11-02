/** One account's surfaces on the Plugins page: the bundle section, title tag, activation guidance, and notices. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { McpAccountCopy } from '../types.ts'
import { presentConnection, type ConnectionPresentation } from './connection.ts'
import type { McpAccountKey } from './locales.ts'
import css from './McpAccount.module.css'
import type { McpAccountFace } from './types.ts'

type Phase = ConnectionPresentation['phase']
type FaceProps = InjectFace<McpAccountFace> & { t: Translate<McpAccountKey> }

const TONE: Record<Phase, StateDotState> = {
  'checking': 'ongoing', 'connecting': 'ongoing', 'authorizing': 'ongoing', 'waiting-browser': 'ongoing',
  'connected': 'done', 'disconnected': 'idle', 'reconnect': 'warning', 'unavailable': 'error',
}

const BADGE: Record<Phase, readonly [McpAccountKey, TagTone] | undefined> = {
  'checking': undefined,
  'connecting': ['badge.connecting', 'info'], 'authorizing': ['badge.connecting', 'info'], 'waiting-browser': ['badge.connecting', 'info'],
  'connected': ['badge.connected', 'success'], 'disconnected': ['badge.disconnected', 'outline'],
  'reconnect': ['badge.reconnect', 'warning'], 'unavailable': ['badge.unavailable', 'danger'],
}

/** The detail line of a phase: the connector's text where it names the service, the shared copy otherwise. */
function detail(shown: ConnectionPresentation, copy: McpAccountCopy, t: Translate<McpAccountKey>, resolveText: FaceProps['resolveText']): string | undefined {
  switch (shown.phase) {
    case 'checking': return undefined
    case 'reconnect':
      switch (shown.reason) {
        case 'rejected': return resolveText(copy.detail.rejected)
        case 'scope': return resolveText(copy.detail.scope)
        default: return t(`detail.reconnect.${shown.reason}`)
      }
    case 'unavailable': return t('detail.unavailable')
    case 'waiting-browser': return resolveText(copy.detail.waitingBrowser)
    default: return resolveText(copy.detail[shown.phase])
  }
}

/**
 * The account section on the connector bundle's page.
 * @param props - the account face and the shared dictionary.
 * @returns the status line, its actions, and the sign-out confirmation.
 */
export function McpAccountSection(props: FaceProps): ReactNode {
  const { useMcpAccount, resolveText, connect, cancel, signOut, retry, openAuthorization, t } = props
  const snapshot = useMcpAccount(value => value)
  const [confirming, setConfirming] = useState(false)
  const { copy } = snapshot.entry
  const shown = presentConnection(snapshot.entry.view)
  const disabled = snapshot.busy || !snapshot.linked
  const line = detail(shown, copy, t, resolveText)
  const action = (label: string, onClick: () => void, variant: 'primary' | 'outline' | 'ghost' = 'outline'): ReactNode =>
    <Button key={label} variant={variant} size="sm" disabled={disabled} onClick={onClick}>{label}</Button>
  const actions: ReactNode[] = []
  switch (shown.phase) {
    case 'disconnected': actions.push(action(resolveText(copy.connect), connect, 'primary')); break
    case 'reconnect': actions.push(action(t('action.reconnect'), connect, 'primary')); break
    case 'waiting-browser': actions.push(action(t('action.open'), openAuthorization, 'primary'), action(t('action.cancel'), cancel, 'ghost')); break
    case 'authorizing': actions.push(action(t('action.cancel'), cancel, 'ghost')); break
    case 'connected': actions.push(action(t('action.signOut'), () => { setConfirming(true) })); break
    case 'unavailable': if (shown.retryable) actions.push(action(t('action.retry'), retry)); break
    case 'checking':
    case 'connecting': break
  }
  return (
    <div className={css.section} data-mcp-account={shown.phase} data-mcp-account-package={snapshot.entry.packageName}>
      <h4 className={css.title}>{resolveText(copy.title)}</h4>
      <div className={css.status}>
        <StateDot state={TONE[shown.phase]} />
        <span className={css.label}>{t(`status.${shown.phase}`)}</span>
        <div className={css.actions}>{actions}</div>
      </div>
      {line === undefined ? null : <p className={css.detail}>{line}</p>}
      {'failed' in shown && shown.failed ? <p className={css.failure} role="alert">{t('failed')}</p> : null}
      <p className={css.hint}>{t('hostBrowser')}</p>
      <Modal open={confirming} title={resolveText(copy.signOut.title)} closeLabel={t('close')} onClose={() => { setConfirming(false) }}
        footer={<>
          <Button variant="ghost" onClick={() => { setConfirming(false) }}>{t('action.cancel')}</Button>
          <Button variant="primary" data-modal-autofocus onClick={() => { setConfirming(false); signOut() }}>{t('action.signOut')}</Button>
        </>}>
        <p>{resolveText(copy.signOut.body)}</p>
      </Modal>
    </div>
  )
}

/**
 * The account tag beside the connector bundle's title.
 * @param props - the open detail page's subject, the account face, and the shared dictionary.
 * @returns the tag for the connector bundle, or null on any other page.
 */
export function McpAccountBadge({ subject, packageName, useMcpAccount, t }: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const phase = useMcpAccount(value => presentConnection(value.entry.view).phase)
  if (subject.kind !== 'bundle' || subject.pkg.name !== packageName || !subject.pkg.enabled) return null
  const badge = BADGE[phase]
  return badge === undefined ? null : <Tag tone={badge[1]}>{t(badge[0])}</Tag>
}

/**
 * Guidance after the user switches the connector bundle on while no account is connected.
 * @param props - activation callbacks, the account face, and the shared dictionary.
 * @returns a dismissible prompt that starts authorization from the bundle's page.
 */
export function McpAccountActivation(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useMcpAccount, resolveText, connect, onDismiss, onOpenDetails, t } = props
  const phase = useMcpAccount(value => presentConnection(value.entry.view).phase)
  const copy = useMcpAccount(value => value.entry.copy)
  const needed = phase === 'disconnected' || phase === 'reconnect'
  useEffect(() => {
    // A first connection attempt may still end in a state that needs the guidance.
    if (phase !== 'checking' && phase !== 'connecting' && !needed) onDismiss()
  }, [phase, needed, onDismiss])
  return (
    <Modal open={needed} title={resolveText(copy.activation.title)} closeLabel={t('close')} onClose={onDismiss}
      footer={<>
        <Button variant="ghost" onClick={onDismiss}>{t('activation.later')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => { onOpenDetails(); connect() }}>{resolveText(copy.connect)}</Button>
      </>}>
      <p>{resolveText(copy.activation.body)}</p>
    </Modal>
  )
}

/**
 * Connection outcomes reported outside the Plugins panel's lifetime.
 * @param props - the account's notice, its dismissal, and the dictionaries.
 * @returns the toast for the latest notice, or null.
 */
export function McpAccountToast({ useMcpAccount, resolveText, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useMcpAccount(value => value.notice)
  const copy = useMcpAccount(value => value.entry.copy)
  if (notice === undefined) return null
  switch (notice.kind) {
    case 'action-failed': return <Toast key={notice.seq} text={t('notice.action-failed')} icon={<IconWarningOutlineRegular />} onDone={dismissNotice} />
    case 'connected': return <Toast key={notice.seq} text={resolveText(copy.notice.connected)} tone="success" onDone={dismissNotice} />
    case 'signed-out': return <Toast key={notice.seq} text={resolveText(copy.notice.signedOut)} tone="success" onDone={dismissNotice} />
    /* v8 ignore next -- closed notice kind union */
    default: return assertNever(notice.kind)
  }
}

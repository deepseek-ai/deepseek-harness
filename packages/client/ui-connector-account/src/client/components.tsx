/**
 * The account surfaces the Plugins page shows for registered connector accounts: a bundle's section with the
 * confirmation a button asks for, the title tag, the activation prompt, and the notice. Each is the slot entry that reads
 * this browser's state and calls the Host through the injected callbacks.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ConnectorAccountButton, ConnectorAccountCommand, ConnectorAccountEntry, ConnectorAccountPhase } from '../types.ts'
import css from './ConnectorAccount.module.css'
import type { ConnectorAccountKey } from './locales.ts'
import { openAuthorizationPage } from './state.ts'
import type { ConnectorAccountFace, ConnectorAccountsState, ConnectorBundleAccountFace } from './types.ts'

type FaceProps = InjectFace<ConnectorAccountFace> & { t: Translate<ConnectorAccountKey> }
type BundleFaceProps = InjectFace<ConnectorBundleAccountFace> & { t: Translate<ConnectorAccountKey> }

const TONE: Record<ConnectorAccountPhase, StateDotState> = {
  checking: 'ongoing', connecting: 'ongoing', connected: 'done', disconnected: 'idle', unavailable: 'warning',
}

const BADGE_TONE: Record<ConnectorAccountPhase, TagTone> = {
  checking: 'outline', connecting: 'info', connected: 'success', disconnected: 'outline', unavailable: 'warning',
}

/**
 * Run a button's command against the Host: start and cancel call the face's callbacks, and open shows the
 * operation's authorization page again in this browser.
 * @param face - the Host callbacks and the browser state the commands read and report to.
 * @returns whether a call this surface made has not answered, whether the Host stream is delivering, and the runner of
 *   one account's command.
 */
function useAccountCommand(
  face: Pick<FaceProps, 'useConnectorAccounts' | 'start' | 'cancel' | 'follow' | 'failed'>,
): {
  readonly busy: boolean
  readonly linked: boolean
  readonly run: (entry: ConnectorAccountEntry, command: ConnectorAccountCommand) => void
} {
  const linked = face.useConnectorAccounts(state => state.linked)
  const [busy, setBusy] = useState(false)
  // A second click before the re-render still finds the first call pending.
  const pending = useRef(false)
  // `operation` resolves to whether the Host accepted the call.
  const call = (operation: () => Promise<boolean>): void => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    // The Host keeps the diagnostic; the page reports one retryable outcome.
    void operation()
      .then((accepted) => { if (!accepted) face.failed() })
      .catch(() => { face.failed() })
      .finally(() => { pending.current = false; setBusy(false) })
  }
  const run = (entry: ConnectorAccountEntry, command: ConnectorAccountCommand): void => {
    const { key } = entry
    switch (command.kind) {
      case 'start':
        call(async () => {
          const started = await face.start(key, command.operation)
          if (started.ok) face.follow(key, started.value)
          return started.ok
        })
        return
      case 'cancel': {
        const operation = entry.operation
        if (operation !== undefined) call(async () => (await face.cancel(key, operation.id)).ok)
        return
      }
      case 'open':
        openAuthorizationPage(entry.operation?.authorizationUrl)
        return
      /* v8 ignore next -- closed command union */
      default: assertNever(command)
    }
  }
  return { busy, linked, run }
}

/** Ask before an action that changes the account outside DSH; the dialog closes before it confirms. */
function Confirm(props: {
  readonly t: Translate<ConnectorAccountKey>
  readonly title: string
  readonly body: string
  readonly label: string
  readonly disabled: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
}): ReactNode {
  const { t, title, body, label, disabled, onClose, onConfirm } = props
  return (
    <Modal open title={title} closeLabel={t('close')} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
        <Button variant="primary" data-modal-autofocus disabled={disabled} onClick={() => { onClose(); onConfirm() }}>{label}</Button>
      </>}>
      <p>{body}</p>
    </Modal>
  )
}

/**
 * The `plugins.bundle.config` entry: the account section on its bundle's page.
 * @param props - the bundle's face and the translator.
 * @returns the title, status line, buttons, detail, notes, failure, hint, and the confirmation a button asked for, or
 *   null before the Host lists the account.
 */
export function ConnectorAccountSectionEntry(props: BundleFaceProps): ReactNode {
  const { useConnectorAccounts, account, resolveText, t } = props
  const entry = useConnectorAccounts(state => state.accounts.get(account))
  const { busy, linked, run } = useAccountCommand(props)
  const disabled = busy || !linked
  const [confirming, setConfirming] = useState<ConnectorAccountButton>()
  if (entry === undefined) return null
  const { display } = entry
  const button = (item: ConnectorAccountButton): ReactNode => {
    const label = resolveText(item.label)
    const onClick = item.confirm === undefined ? () => { run(entry, item.command) } : () => { setConfirming(item) }
    return <Button key={label} variant={item.variant ?? 'outline'} size="sm" disabled={disabled} onClick={onClick}>{label}</Button>
  }
  const details = display.failure?.details ?? []
  const confirm = confirming?.confirm
  return (
    <div className={css.section} data-connector-account={display.phase} data-connector-account-key={entry.key}>
      <h4 className={css.title}>{resolveText(entry.copy.title)}</h4>
      <div className={css.status}>
        <StateDot state={TONE[display.phase]} />
        <span className={css.label}>{resolveText(display.status)}</span>
        <div className={css.actions}>{display.buttons.map(button)}</div>
      </div>
      {display.detail === undefined ? null : <p className={css.detail}>{resolveText(display.detail)}</p>}
      {display.notes.map((note) => {
        const text = resolveText(note.text)
        return (
          <div key={text} className={css.status}>
            <span className={css.detail}>{text}</span>
            {note.button === undefined ? null : <div className={css.actions}>{button(note.button)}</div>}
          </div>
        )
      })}
      {display.failure === undefined ? null : (
        <p className={css.failure} role="alert">
          {resolveText(display.failure.text)}
          {details.length === 0 ? null : <> {t('failure.details', { details: details.join(' · ') })}</>}
        </p>
      )}
      <p className={css.hint}>{resolveText(entry.copy.hint)}</p>
      {confirming === undefined || confirm === undefined ? null : (
        <Confirm t={t} title={resolveText(confirm.title)} body={resolveText(confirm.body)} label={resolveText(confirm.label)}
          disabled={disabled} onClose={() => { setConfirming(undefined) }} onConfirm={() => { run(entry, confirming.command) }} />
      )}
    </div>
  )
}

function accountOf(state: ConnectorAccountsState, packageName: string): ConnectorAccountEntry | undefined {
  for (const entry of state.accounts.values()) if (entry.packageName === packageName) return entry
  return undefined
}

/**
 * The `plugins.detail.badge` entry shared by every bundle that owns an account.
 * @param props - the open detail page's subject and the face.
 * @returns the display's tag on the page of an enabled bundle that owns an account, or of one of its rows, or null.
 */
export function ConnectorAccountBadgeEntry(props: FaceProps & Pick<PropsRuntime<'plugins.detail.badge'>, 'subject'>): ReactNode {
  const { useConnectorAccounts, resolveText, subject } = props
  const packageName = subject.kind === 'item' || !subject.pkg.enabled ? undefined : subject.pkg.name
  const entry = useConnectorAccounts(state => packageName === undefined ? undefined : accountOf(state, packageName))
  const badge = entry?.display.badge
  return entry === undefined || badge === undefined ? null : <Tag tone={BADGE_TONE[entry.display.phase]}>{resolveText(badge)}</Tag>
}

/**
 * The `plugins.bundle.activation` entry: guidance after the user switches a bundle on while its account is not
 * connected. Connect opens the bundle page and starts the display's `connect` command.
 * @param props - activation callbacks, the bundle's face, and the translator.
 * @returns a prompt shown while disconnected, or null before the Host lists the account. It waits while the account is
 *   checking or connecting, which may still end disconnected, and dismisses itself once the account is connected or
 *   unavailable.
 */
export function ConnectorAccountActivationEntry(
  props: BundleFaceProps & Pick<PropsRuntime<'plugins.bundle.activation'>, 'onDismiss' | 'onOpenDetails'>,
): ReactNode {
  const { useConnectorAccounts, account, resolveText, onDismiss, onOpenDetails, t } = props
  const entry = useConnectorAccounts(state => state.accounts.get(account))
  const { linked, run } = useAccountCommand(props)
  const phase = entry?.display.phase
  useEffect(() => {
    if (phase === 'connected' || phase === 'unavailable') onDismiss()
  }, [phase, onDismiss])
  if (entry === undefined) return null
  const { activation } = entry.copy
  const { connect } = entry.display
  const onConnect = (): void => {
    onOpenDetails()
    if (connect !== undefined) run(entry, connect)
  }
  return (
    <Modal open={phase === 'disconnected'} title={resolveText(activation.title)} closeLabel={t('close')} onClose={onDismiss}
      footer={<>
        <Button variant="ghost" onClick={onDismiss}>{t('activation.later')}</Button>
        <Button variant="primary" data-modal-autofocus disabled={!linked} onClick={onConnect}>{resolveText(activation.connect)}</Button>
      </>}>
      <p>{resolveText(activation.body)}</p>
    </Modal>
  )
}

/**
 * The `shell.overlay` entry: account outcomes reported outside the Plugins panel's lifetime.
 * @param props - the face and the translator.
 * @returns the toast for the latest notice, or null.
 */
export function ConnectorAccountToastEntry({ useConnectorAccounts, resolveText, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useConnectorAccounts(state => state.notice)
  if (notice === undefined) return null
  return notice.kind === 'action-failed'
    ? <Toast key={notice.seq} text={t('notice.action-failed')} icon={<IconWarningOutlineRegular />} onDone={dismissNotice} />
    : <Toast key={notice.seq} text={resolveText(notice.text)} tone="success" onDone={dismissNotice} />
}

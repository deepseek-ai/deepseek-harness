/**
 * The account surfaces the Plugins page shows for registered connector accounts: a bundle's section, title tag, and
 * activation prompt, the confirmation a button asks for, and the notice, with the slot entries that read them.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  ConnectorAccountButton, ConnectorAccountCommand, ConnectorAccountEntry, ConnectorAccountFailure, ConnectorAccountPhase,
} from '../types.ts'
import css from './ConnectorAccount.module.css'
import type { ConnectorAccountKey } from './locales.ts'
import { openAuthorizationPage } from './state.ts'
import type { ConnectorAccountFace, ConnectorAccountNotice, ConnectorAccountsState, ConnectorBundleAccountFace } from './types.ts'

type FaceProps = InjectFace<ConnectorAccountFace> & { t: Translate<ConnectorAccountKey> }
type BundleFaceProps = InjectFace<ConnectorBundleAccountFace> & { t: Translate<ConnectorAccountKey> }
type Resolve = (text: LocalizedText) => string
/** The phase a surface shows: the Host's, or `stopped` once this browser's stream failed for good. */
type ShownPhase = ConnectorAccountPhase | 'stopped'

const TONE: Record<ShownPhase, StateDotState> = {
  checking: 'ongoing', connecting: 'ongoing', connected: 'done', disconnected: 'idle', unavailable: 'warning', stopped: 'warning',
}

const BADGE_TONE: Record<ShownPhase, TagTone> = {
  checking: 'outline', connecting: 'info', connected: 'success', disconnected: 'outline', unavailable: 'warning', stopped: 'warning',
}

function shownPhase(entry: ConnectorAccountEntry, stopped: boolean): ShownPhase {
  return stopped ? 'stopped' : entry.display.phase
}

async function settle<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Run a section button's command against the Host: start and cancel call the Remote directly, and open shows the
 * operation's authorization page again in this browser.
 * @param face - the Remote and the browser state the commands report to.
 * @returns whether a call this surface made has not answered, and the runner of one account's command.
 */
function useAccountCommand(
  face: Pick<FaceProps, 'remote' | 'follow' | 'failed'>,
): { readonly busy: boolean; readonly run: (entry: ConnectorAccountEntry, command: ConnectorAccountCommand) => void } {
  const [busy, setBusy] = useState(false)
  // A second click before the re-render still finds the first call pending.
  const pending = useRef(false)
  const call = (operation: () => Promise<void>): void => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    // The Host keeps the diagnostic; the page reports one retryable outcome.
    void operation().catch(() => { face.failed() }).finally(() => { pending.current = false; setBusy(false) })
  }
  const run = (entry: ConnectorAccountEntry, command: ConnectorAccountCommand): void => {
    const { key } = entry
    switch (command.kind) {
      case 'start':
        call(async () => { face.follow(key, await settle(face.remote.start(key, command.operation))) })
        return
      case 'cancel': {
        const operation = entry.operation
        if (operation !== undefined) call(async () => { await settle(face.remote.cancel(key, operation.id)) })
        return
      }
      case 'open':
        openAuthorizationPage(entry.operation?.authorizationUrl)
        return
      /* v8 ignore next -- closed command union */
      default: assertNever(command)
    }
  }
  return { busy, run }
}

/** What the section shows about one account in this browser. */
export interface ConnectorAccountSectionProps {
  readonly t: Translate<ConnectorAccountKey>
  readonly resolveText: Resolve
  readonly entry: ConnectorAccountEntry
  /** Whether the Host stream is delivering. */
  readonly linked: boolean
  /** Whether the Host stream failed for good. */
  readonly stopped: boolean
  /** Whether a call the section made has not answered. */
  readonly busy: boolean
  readonly onCommand: (command: ConnectorAccountCommand) => void
  readonly onRetry: () => void
}

function describe(t: Translate<ConnectorAccountKey>, failure: ConnectorAccountFailure): string | undefined {
  const details = failure.details ?? []
  return details.length === 0 ? undefined : t('failure.details', { details: details.join(' · ') })
}

/**
 * The account section on a bundle page.
 * @param props - the account, the stream state, the command and retry callbacks, and the translators.
 * @returns the title, status line, detail, rows, failure, hint, and the confirmation a button asked for.
 */
export function ConnectorAccountSection(props: ConnectorAccountSectionProps): ReactNode {
  const { t, resolveText, entry, linked, stopped, busy, onCommand, onRetry } = props
  const [confirming, setConfirming] = useState<ConnectorAccountButton>()
  const display = entry.display
  const phase = shownPhase(entry, stopped)
  // Reopening a stopped stream is the one action that does not need the Host stream.
  const disabled = busy || (!linked && !stopped)
  const button = (item: ConnectorAccountButton): ReactNode => {
    const label = resolveText(item.label)
    const onClick = item.confirm === undefined ? () => { onCommand(item.command) } : () => { setConfirming(item) }
    return <Button key={label} variant={item.variant ?? 'outline'} size="sm" disabled={disabled} onClick={onClick}>{label}</Button>
  }
  const failure = stopped ? undefined : display.failure
  const diagnostic = failure === undefined ? undefined : describe(t, failure)
  const confirm = confirming?.confirm
  return (
    <div className={css.section} data-connector-account={phase} data-connector-account-key={entry.key}>
      <h4 className={css.title}>{resolveText(entry.copy.title)}</h4>
      <div className={css.status}>
        <StateDot state={TONE[phase]} />
        <span className={css.label}>{stopped ? t('status.stopped') : resolveText(display.status)}</span>
        <div className={css.actions}>
          {stopped
            ? <Button variant="outline" size="sm" onClick={onRetry}>{t('action.retry')}</Button>
            : display.buttons.map(button)}
        </div>
      </div>
      {stopped
        ? <p className={css.detail}>{t('detail.stopped')}</p>
        : display.detail === undefined ? null : <p className={css.detail}>{resolveText(display.detail)}</p>}
      {stopped ? null : display.notes.map((note) => {
        const text = resolveText(note.text)
        return (
          <div key={text} className={css.status}>
            <span className={css.detail}>{text}</span>
            {note.button === undefined ? null : <div className={css.actions}>{button(note.button)}</div>}
          </div>
        )
      })}
      {failure === undefined ? null : (
        <p className={css.failure} role="alert">{resolveText(failure.text)}{diagnostic === undefined ? null : <> {diagnostic}</>}</p>
      )}
      <p className={css.hint}>{resolveText(entry.copy.hint)}</p>
      {confirming === undefined || confirm === undefined ? null : (
        <ConnectorAccountConfirm t={t} title={resolveText(confirm.title)} body={resolveText(confirm.body)}
          label={resolveText(confirm.label)} onClose={() => { setConfirming(undefined) }}
          onConfirm={() => { onCommand(confirming.command) }} />
      )}
    </div>
  )
}

/** The Plugins page detail the tag sits on: an item page, or a bundle or row page with its package. */
export type ConnectorAccountBadgeSubject =
  | { readonly kind: 'item' }
  | { readonly kind: 'bundle' | 'row'; readonly pkg: { readonly name: string; readonly enabled: boolean } }

/** The tag's phase and text. */
export interface ConnectorAccountBadgeProps {
  readonly phase: ShownPhase
  /** The tag's text; absent while nothing is settled. */
  readonly text: string | undefined
}

/**
 * The account tag beside a bundle's title.
 * @param props - the account's phase and the tag's text.
 * @returns the tag, or null while nothing is settled.
 */
export function ConnectorAccountBadge({ phase, text }: ConnectorAccountBadgeProps): ReactNode {
  return text === undefined ? null : <Tag tone={BADGE_TONE[phase]}>{text}</Tag>
}

/** The prompt's phase, text, and callbacks. */
export interface ConnectorAccountActivationProps {
  readonly t: Translate<ConnectorAccountKey>
  readonly phase: ShownPhase
  readonly title: string
  readonly body: string
  /** The connect button's label. */
  readonly connect: string
  readonly onDismiss: () => void
  readonly onConnect: () => void
}

/**
 * Guidance after the user switches a bundle on while its account is not connected.
 * @param props - the phase, the registrant's text, the dismiss and connect callbacks, and the translator.
 * @returns a prompt shown while disconnected; it waits while the account is checking or connecting, which may still end
 *   disconnected, and dismisses itself once the account is connected or unavailable.
 */
export function ConnectorAccountActivation(props: ConnectorAccountActivationProps): ReactNode {
  const { t, phase, title, body, connect, onDismiss, onConnect } = props
  const needed = phase === 'disconnected'
  useEffect(() => {
    if (phase === 'connected' || phase === 'unavailable' || phase === 'stopped') onDismiss()
  }, [phase, onDismiss])
  return (
    <Modal open={needed} title={title} closeLabel={t('close')} onClose={onDismiss}
      footer={<>
        <Button variant="ghost" onClick={onDismiss}>{t('activation.later')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={onConnect}>{connect}</Button>
      </>}>
      <p>{body}</p>
    </Modal>
  )
}

/** A confirmation's text and callbacks, with the translator for the shared buttons. */
export interface ConnectorAccountConfirmProps {
  readonly t: Translate<ConnectorAccountKey>
  readonly title: string
  readonly body: string
  /** The confirm button's label. */
  readonly label: string
  readonly onClose: () => void
  readonly onConfirm: () => void
}

/**
 * Confirm an action that changes the account outside DSH.
 * @param props - the question and the close and confirm callbacks.
 * @returns a dialog that closes before it confirms.
 */
export function ConnectorAccountConfirm({ t, title, body, label, onClose, onConfirm }: ConnectorAccountConfirmProps): ReactNode {
  return (
    <Modal open title={title} closeLabel={t('close')} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => { onClose(); onConfirm() }}>{label}</Button>
      </>}>
      <p>{body}</p>
    </Modal>
  )
}

/** The latest notice and its dismissal, with both translators. */
export interface ConnectorAccountToastProps {
  readonly t: Translate<ConnectorAccountKey>
  readonly resolveText: Resolve
  readonly notice: ConnectorAccountNotice | undefined
  readonly onDone: () => void
}

/**
 * Account outcomes reported outside the Plugins panel's lifetime.
 * @param props - the latest notice, its dismissal, and the translators.
 * @returns the toast for the notice, or null.
 */
export function ConnectorAccountToast({ t, resolveText, notice, onDone }: ConnectorAccountToastProps): ReactNode {
  if (notice === undefined) return null
  if (notice.kind === 'action-failed') {
    return <Toast key={notice.seq} text={t('notice.action-failed')} icon={<IconWarningOutlineRegular />} onDone={onDone} />
  }
  return <Toast key={notice.seq} text={resolveText(notice.text)} tone="success" onDone={onDone} />
}

/**
 * The `plugins.bundle.config` entry of a bundle that owns an account.
 * @param props - the bundle's face and the translator.
 * @returns the section for the account, or null before the Host lists it.
 */
export function ConnectorAccountSectionEntry(props: BundleFaceProps): ReactNode {
  const { useConnectorAccounts, account, resolveText, retry, t } = props
  const entry = useConnectorAccounts(state => state.accounts.get(account))
  const linked = useConnectorAccounts(state => state.linked)
  const stopped = useConnectorAccounts(state => state.stopped)
  const { busy, run } = useAccountCommand(props)
  if (entry === undefined) return null
  return <ConnectorAccountSection t={t} resolveText={resolveText} entry={entry} linked={linked} stopped={stopped} busy={busy}
    onCommand={(command) => { run(entry, command) }} onRetry={retry} />
}

function accountOf(state: ConnectorAccountsState, packageName: string): ConnectorAccountEntry | undefined {
  for (const entry of state.accounts.values()) if (entry.packageName === packageName) return entry
  return undefined
}

/**
 * The `plugins.detail.badge` entry shared by every bundle that owns an account.
 * @param props - the open detail page's subject, the face, and the translator.
 * @returns the tag on the page of an enabled bundle that owns an account, or of one of its rows, or null.
 */
export function ConnectorAccountBadgeEntry(props: FaceProps & Pick<PropsRuntime<'plugins.detail.badge'>, 'subject'>): ReactNode {
  const { useConnectorAccounts, resolveText, subject, t } = props
  const page: ConnectorAccountBadgeSubject = subject
  const packageName = page.kind === 'item' || !page.pkg.enabled ? undefined : page.pkg.name
  const entry = useConnectorAccounts(state => packageName === undefined ? undefined : accountOf(state, packageName))
  const stopped = useConnectorAccounts(state => state.stopped)
  if (entry === undefined) return null
  const badge = entry.display.badge
  const text = stopped ? t('badge.stopped') : badge === undefined ? undefined : resolveText(badge)
  return <ConnectorAccountBadge phase={shownPhase(entry, stopped)} text={text} />
}

/**
 * The `plugins.bundle.activation` entry of a bundle that owns an account; Connect opens the bundle page and starts the
 * display's `connect` command.
 * @param props - activation callbacks, the bundle's face, and the translator.
 * @returns the prompt for the account, or null before the Host lists it.
 */
export function ConnectorAccountActivationEntry(
  props: BundleFaceProps & Pick<PropsRuntime<'plugins.bundle.activation'>, 'onDismiss' | 'onOpenDetails'>,
): ReactNode {
  const { useConnectorAccounts, account, resolveText, onDismiss, onOpenDetails, t } = props
  const entry = useConnectorAccounts(state => state.accounts.get(account))
  const stopped = useConnectorAccounts(state => state.stopped)
  const { run } = useAccountCommand(props)
  if (entry === undefined) return null
  const { activation } = entry.copy
  const { connect } = entry.display
  const onConnect = (): void => {
    onOpenDetails()
    if (connect !== undefined) run(entry, connect)
  }
  return (
    <ConnectorAccountActivation t={t} phase={shownPhase(entry, stopped)} title={resolveText(activation.title)}
      body={resolveText(activation.body)} connect={resolveText(activation.connect)} onDismiss={onDismiss} onConnect={onConnect} />
  )
}

/**
 * The `shell.overlay` entry.
 * @param props - the face and the translator.
 * @returns the toast for the latest notice, or null.
 */
export function ConnectorAccountToastEntry({ useConnectorAccounts, resolveText, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useConnectorAccounts(state => state.notice)
  return <ConnectorAccountToast t={t} resolveText={resolveText} notice={notice} onDone={dismissNotice} />
}

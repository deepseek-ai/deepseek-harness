/**
 * The account surfaces of one registered CLI plugin: the section, title tag, activation prompt, confirmation, and notice,
 * with the slot entries that read them from the account's face.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { CliAccountButton, CliAccountCommand, CliAccountFailure, CliAccountPhase } from '@deepseek-ai/dsh-cli-account/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import css from './CliAccount.module.css'
import type { CliAccountKey } from './locales.ts'
import type { CliAccountFace, CliAccountNotice, CliAccountSnapshot } from './types.ts'

type FaceProps = InjectFace<CliAccountFace> & { t: Translate<CliAccountKey> }
type Resolve = (text: LocalizedText) => string
/** The phase a surface shows: the Host's, or `stopped` once this browser's stream failed for good. */
type ShownPhase = CliAccountPhase | 'stopped'

const TONE: Record<ShownPhase, StateDotState> = {
  checking: 'ongoing', connecting: 'ongoing', connected: 'done', disconnected: 'idle', unavailable: 'warning', stopped: 'warning',
}

const BADGE_TONE: Record<ShownPhase, TagTone> = {
  checking: 'outline', connecting: 'info', connected: 'success', disconnected: 'outline', unavailable: 'warning', stopped: 'warning',
}

function shownPhase(snapshot: CliAccountSnapshot): ShownPhase {
  return snapshot.stopped ? 'stopped' : snapshot.entry.display.phase
}

/** What the section shows about one account in this browser. */
export interface CliAccountSectionProps {
  readonly t: Translate<CliAccountKey>
  readonly resolveText: Resolve
  readonly snapshot: CliAccountSnapshot
  readonly onCommand: (command: CliAccountCommand) => void
  readonly onRetry: () => void
}

function describe(t: Translate<CliAccountKey>, failure: CliAccountFailure): string | undefined {
  const command = failure.command
  if (command === undefined) return undefined
  const details = [
    command.command,
    ...command.exitCode === null ? [] : [t('failure.exitCode', { code: String(command.exitCode) })],
    ...failure.details ?? [],
  ].join(' · ')
  return t('failure.details', { details })
}

/**
 * The account section on a plugin's bundle page.
 * @param props - the account's snapshot, the command and retry callbacks, and the translators.
 * @returns the title, status line, detail, rows, failure, hint, and the confirmation a button asked for.
 */
export function CliAccountSection({ t, resolveText, snapshot, onCommand, onRetry }: CliAccountSectionProps): ReactNode {
  const { entry, busy, linked, stopped } = snapshot
  const [confirming, setConfirming] = useState<CliAccountButton>()
  const display = entry.display
  const phase = shownPhase(snapshot)
  // Reopening a stopped stream is the one action that does not need the Host stream.
  const disabled = busy || (!linked && !stopped)
  const button = (item: CliAccountButton): ReactNode => {
    const label = resolveText(item.label)
    const onClick = item.confirm === undefined ? () => { onCommand(item.command) } : () => { setConfirming(item) }
    return <Button key={label} variant={item.variant ?? 'outline'} size="sm" disabled={disabled} onClick={onClick}>{label}</Button>
  }
  const failure = stopped ? undefined : display.failure
  const diagnostic = failure === undefined ? undefined : describe(t, failure)
  const confirm = confirming?.confirm
  return (
    <div className={css.section} data-cli-account={phase} data-cli-account-package={entry.packageName}>
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
        <CliAccountConfirm t={t} title={resolveText(confirm.title)} body={resolveText(confirm.body)} label={resolveText(confirm.label)}
          onClose={() => { setConfirming(undefined) }} onConfirm={() => { onCommand(confirming.command) }} />
      )}
    </div>
  )
}

/** The Plugins page detail the tag sits on: an item page, or a bundle or row page with its package. */
export type CliAccountBadgeSubject =
  | { readonly kind: 'item' }
  | { readonly kind: 'bundle' | 'row'; readonly pkg: { readonly name: string; readonly enabled: boolean } }

/** The tag's subject, phase, and text. */
export interface CliAccountBadgeProps {
  /** The `subject` of the `plugins.detail.badge` slot props. */
  readonly subject: CliAccountBadgeSubject
  readonly packageName: string
  readonly phase: ShownPhase
  /** The tag's text; absent while nothing is settled. */
  readonly text: string | undefined
}

/**
 * The account tag beside a plugin bundle's title.
 * @param props - the open detail page's subject, the account's package, its phase, and the tag's text.
 * @returns the tag on the page of the enabled plugin bundle or of one of its rows, or null.
 */
export function CliAccountBadge({ subject, packageName, phase, text }: CliAccountBadgeProps): ReactNode {
  if (text === undefined || subject.kind === 'item' || subject.pkg.name !== packageName || !subject.pkg.enabled) return null
  return <Tag tone={BADGE_TONE[phase]}>{text}</Tag>
}

/** The prompt's phase, text, and callbacks. */
export interface CliAccountActivationProps {
  readonly t: Translate<CliAccountKey>
  readonly phase: ShownPhase
  readonly title: string
  readonly body: string
  /** The connect button's label. */
  readonly connect: string
  readonly onDismiss: () => void
  readonly onConnect: () => void
}

/**
 * Guidance after the user switches a plugin bundle on while its account is not connected.
 * @param props - the phase, the plugin's text, the dismiss and connect callbacks, and the kit translator.
 * @returns a prompt shown while disconnected; it dismisses itself once the phase settles elsewhere.
 */
export function CliAccountActivation({ t, phase, title, body, connect, onDismiss, onConnect }: CliAccountActivationProps): ReactNode {
  const needed = phase === 'disconnected'
  useEffect(() => {
    if (phase !== 'checking' && !needed) onDismiss()
  }, [phase, needed, onDismiss])
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

/** A confirmation's text and callbacks, with the kit translator for the shared buttons. */
export interface CliAccountConfirmProps {
  readonly t: Translate<CliAccountKey>
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
export function CliAccountConfirm({ t, title, body, label, onClose, onConfirm }: CliAccountConfirmProps): ReactNode {
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
export interface CliAccountToastProps {
  readonly t: Translate<CliAccountKey>
  readonly resolveText: Resolve
  readonly notice: CliAccountNotice | undefined
  readonly onDone: () => void
}

/**
 * Account outcomes reported outside the Plugins panel's lifetime.
 * @param props - the latest notice, its dismissal, and the translators.
 * @returns the toast for the notice, or null.
 */
export function CliAccountToast({ t, resolveText, notice, onDone }: CliAccountToastProps): ReactNode {
  if (notice === undefined) return null
  if (notice.kind === 'action-failed') {
    return <Toast key={notice.seq} text={t('notice.action-failed')} icon={<IconWarningOutlineRegular />} onDone={onDone} />
  }
  return <Toast key={notice.seq} text={resolveText(notice.text)} tone="success" onDone={onDone} />
}

/**
 * The `plugins.bundle.config` entry.
 * @param props - the account's face and the kit translator.
 * @returns the section for the current snapshot.
 */
export function CliAccountSectionEntry({ useCliAccount, resolveText, run, retry, t }: FaceProps): ReactNode {
  const snapshot = useCliAccount(value => value)
  return <CliAccountSection t={t} resolveText={resolveText} snapshot={snapshot} onCommand={run} onRetry={retry} />
}

/**
 * The `plugins.detail.badge` entry.
 * @param props - the open detail page's subject, the account's face, and the kit translator.
 * @returns the tag for the account's bundle, or null on any other page.
 */
export function CliAccountBadgeEntry(props: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const { useCliAccount, resolveText, packageName, subject, t } = props
  const phase = useCliAccount(shownPhase)
  const badge = useCliAccount(value => value.entry.display.badge)
  const text = phase === 'stopped' ? t('badge.stopped') : badge === undefined ? undefined : resolveText(badge)
  return <CliAccountBadge subject={subject} packageName={packageName} phase={phase} text={text} />
}

/**
 * The `plugins.bundle.activation` entry; Connect opens the bundle page and runs the section's first primary button that
 * asks no confirmation.
 * @param props - activation callbacks, the account's face, and the kit translator.
 * @returns the prompt for the current snapshot.
 */
export function CliAccountActivationEntry(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useCliAccount, resolveText, run, onDismiss, onOpenDetails, t } = props
  const snapshot = useCliAccount(value => value)
  const { activation } = snapshot.entry.copy
  const connect = snapshot.entry.display.buttons.find(item => item.variant === 'primary' && item.confirm === undefined)
  const onConnect = (): void => {
    onOpenDetails()
    if (connect !== undefined) run(connect.command)
  }
  return (
    <CliAccountActivation t={t} phase={shownPhase(snapshot)} title={resolveText(activation.title)} body={resolveText(activation.body)}
      connect={resolveText(activation.connect)} onDismiss={onDismiss} onConnect={onConnect} />
  )
}

/**
 * The `shell.overlay` entry.
 * @param props - the account's face and the kit translator.
 * @returns the toast for the latest notice, or null.
 */
export function CliAccountToastEntry({ useCliAccount, resolveText, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useCliAccount(value => value.notice)
  return <CliAccountToast t={t} resolveText={resolveText} notice={notice} onDone={dismissNotice} />
}

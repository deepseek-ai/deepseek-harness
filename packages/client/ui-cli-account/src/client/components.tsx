/**
 * The account surfaces of one registered CLI plugin: the section, title tag, activation prompt, confirmation, and notice,
 * with the slot entries that read them from the registration's face.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import css from './CliAccount.module.css'
import type {
  CliAccountAction, CliAccountConfirmation, CliAccountDisplay, CliAccountFace, CliAccountFailure, CliAccountKey, CliAccountNotice,
  CliAccountPhase,
} from './types.ts'

type FaceProps = InjectFace<CliAccountFace> & { t: Translate<CliAccountKey> }

const TONE: Record<CliAccountPhase, StateDotState> = {
  checking: 'ongoing', connecting: 'ongoing', connected: 'done', disconnected: 'idle', unavailable: 'warning', stopped: 'warning',
}

const BADGE_TONE: Record<Exclude<CliAccountPhase, 'checking'>, TagTone> = {
  connecting: 'info', connected: 'success', disconnected: 'outline', unavailable: 'warning', stopped: 'warning',
}

/** What the section shows about one plugin's account. */
export interface CliAccountSectionProps extends CliAccountDisplay {
  readonly t: Translate<CliAccountKey>
  readonly packageName: string
  /** Whether an action this page started has not answered. */
  readonly busy: boolean
  /** Whether the Host stream is delivering; buttons stay enabled while stopped so retry can reopen it. */
  readonly linked: boolean
}

function describe(t: Translate<CliAccountKey>, failure: CliAccountFailure): string | undefined {
  const command = failure.command
  if (command === undefined) return undefined
  const details = [
    command.command,
    ...command.exitCode === null ? [] : [t('failure.exitCode', { code: String(command.exitCode) })],
    ...(failure.details ?? []).filter(detail => detail !== undefined),
  ].join(' · ')
  return t('failure.details', { details })
}

/**
 * The account section on a plugin's bundle page.
 * @param props - the plugin's display, the page state, and the plugin's translator.
 * @returns the title, status line, detail, rows, failure, hint, and the confirmation an action asked for.
 */
export function CliAccountSection(props: CliAccountSectionProps): ReactNode {
  const { t, packageName, phase, status, busy, linked, actions = [], detail, notes = [], failure } = props
  const [confirming, setConfirming] = useState<{ readonly action: CliAccountAction; readonly confirm: CliAccountConfirmation }>()
  // Reopening a stopped stream is the one action that does not need the Host stream.
  const disabled = busy || (!linked && phase !== 'stopped')
  const button = (action: CliAccountAction): ReactNode => {
    const { confirm } = action
    const onClick = confirm === undefined ? action.onClick : () => { setConfirming({ action, confirm }) }
    return <Button key={action.label} variant={action.variant ?? 'outline'} size="sm" disabled={disabled} onClick={onClick}>{action.label}</Button>
  }
  const diagnostic = failure === undefined ? undefined : describe(t, failure)
  return (
    <div className={css.section} data-cli-account={phase} data-cli-account-package={packageName}>
      <h4 className={css.title}>{t('section.title')}</h4>
      <div className={css.status}>
        <StateDot state={TONE[phase]} />
        <span className={css.label}>{status ?? t(`status.${phase === 'connecting' ? 'checking' : phase}`)}</span>
        <div className={css.actions}>{actions.map(button)}</div>
      </div>
      {detail === undefined ? null : <p className={css.detail}>{detail}</p>}
      {notes.map(note => (
        <div key={note.text} className={css.status}>
          <span className={css.detail}>{note.text}</span>
          {note.action === undefined ? null : <div className={css.actions}>{button(note.action)}</div>}
        </div>
      ))}
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure.text}{diagnostic === undefined ? null : <> {diagnostic}</>}</p>}
      <p className={css.hint}>{t('hint')}</p>
      {confirming === undefined ? null : (
        <CliAccountConfirm t={t} confirmation={confirming.confirm}
          onClose={() => { setConfirming(undefined) }} onConfirm={confirming.action.onClick} />
      )}
    </div>
  )
}

/** The Plugins page detail the tag sits on: an item page, or a bundle or row page with its package. */
export type CliAccountBadgeSubject =
  | { readonly kind: 'item' }
  | { readonly kind: 'bundle' | 'row'; readonly pkg: { readonly name: string; readonly enabled: boolean } }

/** The tag's subject and phase, with the plugin's translator. */
export interface CliAccountBadgeProps {
  readonly t: Translate<CliAccountKey>
  /** The `subject` of the `plugins.detail.badge` slot props. */
  readonly subject: CliAccountBadgeSubject
  readonly packageName: string
  readonly phase: CliAccountPhase
}

/**
 * The account tag beside a plugin bundle's title.
 * @param props - the open detail page's subject, the plugin's package, its phase, and its translator.
 * @returns the tag once the phase settles on the page of the enabled plugin bundle or of one of its rows, or null.
 */
export function CliAccountBadge({ t, subject, packageName, phase }: CliAccountBadgeProps): ReactNode {
  if (subject.kind === 'item' || subject.pkg.name !== packageName || !subject.pkg.enabled || phase === 'checking') return null
  return <Tag tone={BADGE_TONE[phase]}>{t(`badge.${phase}`)}</Tag>
}

/** The prompt's phase and callbacks, with the plugin's translator. */
export interface CliAccountActivationProps {
  readonly t: Translate<CliAccountKey>
  readonly phase: CliAccountPhase
  readonly onDismiss: () => void
  readonly onConnect: () => void
}

/**
 * Guidance after the user switches a plugin bundle on while its account is not connected.
 * @param props - the phase, the dismiss and connect callbacks, and the plugin's translator.
 * @returns a prompt shown while disconnected; it dismisses itself once the phase settles elsewhere.
 */
export function CliAccountActivation({ t, phase, onDismiss, onConnect }: CliAccountActivationProps): ReactNode {
  const needed = phase === 'disconnected'
  useEffect(() => {
    if (phase !== 'checking' && !needed) onDismiss()
  }, [phase, needed, onDismiss])
  return (
    <Modal open={needed} title={t('activation.title')} closeLabel={t('close')} onClose={onDismiss}
      footer={<>
        <Button variant="ghost" onClick={onDismiss}>{t('activation.later')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={onConnect}>{t('action.connect')}</Button>
      </>}>
      <p>{t('activation.body')}</p>
    </Modal>
  )
}

/** The question, its callbacks, and the plugin's translator for the shared buttons. */
export interface CliAccountConfirmProps {
  readonly t: Translate<CliAccountKey>
  readonly confirmation: CliAccountConfirmation
  readonly onClose: () => void
  readonly onConfirm: () => void
}

/**
 * Confirm an action that changes the account outside DSH.
 * @param props - the question and the close and confirm callbacks.
 * @returns a dialog that closes before it confirms.
 */
export function CliAccountConfirm({ t, confirmation, onClose, onConfirm }: CliAccountConfirmProps): ReactNode {
  return (
    <Modal open title={confirmation.title} closeLabel={t('close')} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => { onClose(); onConfirm() }}>{confirmation.label}</Button>
      </>}>
      <p>{confirmation.body}</p>
    </Modal>
  )
}

/** The latest notice, the plugin's success copy, and its dismissal. */
export interface CliAccountToastProps {
  readonly t: Translate<CliAccountKey>
  readonly notice: CliAccountNotice<string> | undefined
  readonly notices: Readonly<Partial<Record<string, () => string>>>
  readonly onDone: () => void
}

/**
 * Account outcomes reported outside the Plugins panel's lifetime.
 * @param props - the latest notice, the plugin's success copy, its dismissal, and the plugin's translator.
 * @returns the toast for the notice, or null when there is none or its operation has no copy.
 */
export function CliAccountToast({ t, notice, notices, onDone }: CliAccountToastProps): ReactNode {
  if (notice === undefined) return null
  if (notice.kind === 'action-failed') {
    return <Toast key={notice.seq} text={t('notice.action-failed')} icon={<IconWarningOutlineRegular />} onDone={onDone} />
  }
  const text = notices[notice.operation]
  return text === undefined ? null : <Toast key={notice.seq} text={text()} tone="success" onDone={onDone} />
}

/**
 * The `plugins.bundle.config` entry.
 * @param props - the registration's face and the plugin's translator.
 * @returns the section for the current snapshot.
 */
export function CliAccountSectionEntry({ useCliAccount, present, page, packageName, t }: FaceProps): ReactNode {
  const snapshot = useCliAccount(value => value)
  return <CliAccountSection {...present(snapshot, page)} t={t} packageName={packageName} busy={snapshot.busy} linked={snapshot.linked} />
}

/**
 * The `plugins.detail.badge` entry.
 * @param props - the open detail page's subject, the registration's face, and the plugin's translator.
 * @returns the tag for the registration's bundle, or null on any other page.
 */
export function CliAccountBadgeEntry(props: FaceProps & PropsRuntime<'plugins.detail.badge'>): ReactNode {
  const { useCliAccount, present, page, packageName, subject, t } = props
  const phase = useCliAccount(value => present(value, page).phase)
  return <CliAccountBadge t={t} subject={subject} packageName={packageName} phase={phase} />
}

/**
 * The `plugins.bundle.activation` entry; Connect opens the bundle page and runs the section's first primary action
 * that asks no confirmation.
 * @param props - activation callbacks, the registration's face, and the plugin's translator.
 * @returns the prompt for the current snapshot.
 */
export function CliAccountActivationEntry(props: FaceProps & PropsRuntime<'plugins.bundle.activation'>): ReactNode {
  const { useCliAccount, present, page, onDismiss, onOpenDetails, t } = props
  const display = present(useCliAccount(value => value), page)
  const connect = display.actions?.find(action => action.variant === 'primary' && action.confirm === undefined)
  const onConnect = (): void => { onOpenDetails(); connect?.onClick() }
  return <CliAccountActivation t={t} phase={display.phase} onDismiss={onDismiss} onConnect={onConnect} />
}

/**
 * The `shell.overlay` entry.
 * @param props - the registration's face and the plugin's translator.
 * @returns the toast for the latest notice, or null.
 */
export function CliAccountToastEntry({ useCliAccount, notices, dismissNotice, t }: FaceProps): ReactNode {
  const notice = useCliAccount(value => value.notice)
  return <CliAccountToast t={t} notice={notice} notices={notices} onDone={dismissNotice} />
}

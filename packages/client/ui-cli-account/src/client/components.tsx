/** Plugins page components shared by CLI plugins: they render a plugin's display phase with the copy the plugin translates. */
import { useEffect, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { CliCommandFailure } from '@deepseek-ai/dsh-cli-account/types'
import type { CliAccountNotice } from './connection.ts'
import css from './CliAccount.module.css'

/** What the page shows about a plugin's account; each plugin maps its own account states onto these phases. */
export type CliAccountPhase = 'checking' | 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'stopped'

/** Dictionary keys every CLI plugin translates for the shared components. */
export type CliAccountKey =
  | 'section.title' | 'hint' | 'close' | 'action.cancel' | 'action.connect'
  | 'activation.title' | 'activation.body' | 'activation.later'
  | 'failure.details' | 'failure.exitCode'
  | `badge.${Exclude<CliAccountPhase, 'checking'>}`
  | `status.${Exclude<CliAccountPhase, 'connecting'>}`

const TONE: Record<CliAccountPhase, StateDotState> = {
  checking: 'ongoing', connecting: 'ongoing', connected: 'done', disconnected: 'idle', unavailable: 'warning', stopped: 'warning',
}

const BADGE_TONE: Record<Exclude<CliAccountPhase, 'checking'>, TagTone> = {
  connecting: 'info', connected: 'success', disconnected: 'outline', unavailable: 'warning', stopped: 'warning',
}

/** One button in the section; the section disables it while an action is pending or the Host stream is down. */
export interface CliAccountAction {
  readonly label: string
  readonly onClick: () => void
  /** Defaults to an outline button. */
  readonly variant?: 'primary' | 'ghost'
}

/** One extra row under the status line, such as the linked app, with an optional button. */
export interface CliAccountNote {
  readonly text: string
  readonly action?: CliAccountAction
}

/** A failed operation as the section reports it. */
export interface CliAccountFailure {
  /** The plugin's recovery guidance. */
  readonly text: string
  /** The Host's classified command, shown as a diagnostic after the guidance. */
  readonly command?: CliCommandFailure | undefined
  /** The plugin's allowlisted classification fields, appended in order; undefined entries are skipped. */
  readonly details?: readonly (string | undefined)[]
}

/** What the section shows about one plugin's account. */
export interface CliAccountSectionProps {
  readonly t: Translate<CliAccountKey>
  readonly packageName: string
  readonly phase: CliAccountPhase
  /** The status label; defaults to the `status.*` copy for the phase, with `connecting` labelled as checking. */
  readonly status?: string | undefined
  /** Whether an action this page started has not answered. */
  readonly busy: boolean
  /** Whether the Host stream is delivering; buttons stay enabled while stopped so retry can reopen it. */
  readonly linked: boolean
  readonly actions: readonly CliAccountAction[]
  readonly detail?: string | undefined
  readonly notes?: readonly CliAccountNote[]
  readonly failure?: CliAccountFailure | undefined
  /** Extra content rendered last, such as confirmation dialogs. */
  readonly children?: ReactNode
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
 * @param props - the phase, status, buttons, rows, and failure, with the plugin's translator.
 * @returns the title, status line, detail, rows, failure, hint, and children.
 */
export function CliAccountSection(props: CliAccountSectionProps): ReactNode {
  const { t, packageName, phase, status, busy, linked, actions, detail, notes = [], failure, children } = props
  // Reopening a stopped stream is the one action that does not need the Host stream.
  const disabled = busy || (!linked && phase !== 'stopped')
  const button = (action: CliAccountAction): ReactNode =>
    <Button key={action.label} variant={action.variant ?? 'outline'} size="sm" disabled={disabled} onClick={action.onClick}>{action.label}</Button>
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
      {children}
    </div>
  )
}

/** The tag's subject and phase, with the plugin's translator. */
export interface CliAccountBadgeProps {
  readonly t: Translate<CliAccountKey>
  readonly subject: PropsRuntime<'plugins.detail.badge'>['subject']
  readonly packageName: string
  readonly phase: CliAccountPhase
}

/**
 * The account tag beside a plugin bundle's title.
 * @param props - the open detail page's subject, the plugin's package, its phase, and its translator.
 * @returns the tag on the enabled bundle's page once the phase settles, or null.
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

/** A confirmation's copy and callbacks, with the plugin's translator for the shared buttons. */
export interface CliAccountConfirmProps {
  readonly t: Translate<CliAccountKey>
  readonly open: boolean
  readonly title: string
  readonly body: string
  readonly confirm: string
  readonly onClose: () => void
  readonly onConfirm: () => void
}

/**
 * Confirm an action that changes the account outside DSH, such as signing out of a CLI the terminal shares.
 * @param props - whether it is open, its copy, and the close and confirm callbacks.
 * @returns a dialog that closes before it confirms.
 */
export function CliAccountConfirm({ t, open, title, body, confirm, onClose, onConfirm }: CliAccountConfirmProps): ReactNode {
  return (
    <Modal open={open} title={title} closeLabel={t('close')} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => { onClose(); onConfirm() }}>{confirm}</Button>
      </>}>
      <p>{body}</p>
    </Modal>
  )
}

/** The latest notice, with the plugin's translator for `notice.*` copy. */
export interface CliAccountToastProps<Notice extends string> {
  readonly t: Translate<`notice.${NoInfer<CliAccountNotice<Notice>['kind']>}`>
  readonly notice: CliAccountNotice<Notice> | undefined
  readonly onDone: () => void
}

/**
 * Account outcomes reported outside the Plugins panel's lifetime.
 * @param props - the latest notice, its dismissal, and the plugin's translator.
 * @returns the toast for the notice, or null.
 */
export function CliAccountToast<Notice extends string>({ t, notice, onDone }: CliAccountToastProps<Notice>): ReactNode {
  if (notice === undefined) return null
  const failed = notice.kind === 'action-failed'
  return (
    <Toast key={notice.seq} text={t(`notice.${notice.kind}`)} onDone={onDone}
      {...failed ? { icon: <IconWarningOutlineRegular /> } : { tone: 'success' as const }} />
  )
}

import { useEffect, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { CliCommandFailure } from '@deepseek-ai/dsh-cli-account/types'
import type { CliAccountNotice } from './connection.ts'
import css from './CliAccount.module.css'

export type CliAccountPhase = 'checking' | 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'stopped'

export type CliAccountKey =
  | 'section.title' | 'hint' | 'close' | 'action.cancel' | 'action.connect'
  | 'activation.title' | 'activation.body' | 'activation.later'
  | 'failure.details' | 'failure.exitCode'
  | `badge.${Exclude<CliAccountPhase, 'checking'>}`

const TONE: Record<CliAccountPhase, StateDotState> = {
  checking: 'ongoing', connecting: 'ongoing', connected: 'done', disconnected: 'idle', unavailable: 'warning', stopped: 'warning',
}

const BADGE_TONE: Record<Exclude<CliAccountPhase, 'checking'>, TagTone> = {
  connecting: 'info', connected: 'success', disconnected: 'outline', unavailable: 'warning', stopped: 'warning',
}

export interface CliAccountAction {
  readonly label: string
  readonly onClick: () => void
  readonly variant?: 'primary' | 'ghost'
}

export interface CliAccountNote {
  readonly text: string
  readonly action?: CliAccountAction
}

export interface CliAccountFailure {
  readonly text: string
  readonly command?: CliCommandFailure | undefined
  readonly details?: readonly (string | undefined)[]
}

export interface CliAccountSectionProps {
  readonly t: Translate<CliAccountKey>
  readonly packageName: string
  readonly phase: CliAccountPhase
  readonly status: string
  readonly busy: boolean
  readonly linked: boolean
  readonly actions: readonly CliAccountAction[]
  readonly detail?: string | undefined
  readonly notes?: readonly CliAccountNote[]
  readonly failure?: CliAccountFailure | undefined
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
        <span className={css.label}>{status}</span>
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

export interface CliAccountBadgeProps {
  readonly t: Translate<CliAccountKey>
  readonly subject: PropsRuntime<'plugins.detail.badge'>['subject']
  readonly packageName: string
  readonly phase: CliAccountPhase
}

export function CliAccountBadge({ t, subject, packageName, phase }: CliAccountBadgeProps): ReactNode {
  if (subject.kind === 'item' || subject.pkg.name !== packageName || !subject.pkg.enabled || phase === 'checking') return null
  return <Tag tone={BADGE_TONE[phase]}>{t(`badge.${phase}`)}</Tag>
}

export interface CliAccountActivationProps {
  readonly t: Translate<CliAccountKey>
  readonly phase: CliAccountPhase
  readonly onDismiss: () => void
  readonly onConnect: () => void
}

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

export interface CliAccountConfirmProps {
  readonly t: Translate<CliAccountKey>
  readonly open: boolean
  readonly title: string
  readonly body: string
  readonly confirm: string
  readonly onClose: () => void
  readonly onConfirm: () => void
}

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

export interface CliAccountToastProps<Notice extends string> {
  readonly t: Translate<`notice.${CliAccountNotice<Notice>['kind']}`>
  readonly notice: CliAccountNotice<Notice> | undefined
  readonly onDone: () => void
}

export function CliAccountToast<Notice extends string>({ t, notice, onDone }: CliAccountToastProps<Notice>): ReactNode {
  if (notice === undefined) return null
  const failed = notice.kind === 'action-failed'
  return (
    <Toast key={notice.seq} text={t(`notice.${notice.kind}`)} onDone={onDone}
      {...failed ? { icon: <IconWarningOutlineRegular /> } : { tone: 'success' as const }} />
  )
}

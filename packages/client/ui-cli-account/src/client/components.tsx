import { useEffect, type ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, StateDot, Tag, Toast, type StateDotState, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { CliAccountNotice } from './connection.ts'
import css from './CliAccount.module.css'

export type CliAccountPhase = 'checking' | 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'stopped'

const TONE: Record<CliAccountPhase, StateDotState> = {
  checking: 'ongoing', connecting: 'ongoing', connected: 'done', disconnected: 'idle', unavailable: 'warning', stopped: 'warning',
}

const BADGE_TONE: Record<Exclude<CliAccountPhase, 'checking'>, TagTone> = {
  connecting: 'info', connected: 'success', disconnected: 'outline', unavailable: 'warning', stopped: 'warning',
}

export interface CliAccountActionProps {
  readonly label: string
  readonly disabled: boolean
  readonly onClick: () => void
  readonly variant?: 'primary' | 'outline' | 'ghost' | undefined
}

export function CliAccountAction({ label, disabled, onClick, variant = 'outline' }: CliAccountActionProps): ReactNode {
  return <Button variant={variant} size="sm" disabled={disabled} onClick={onClick}>{label}</Button>
}

export interface CliAccountSectionProps {
  readonly packageName: string
  readonly phase: CliAccountPhase
  readonly title: string
  readonly status: string
  readonly actions?: ReactNode
  readonly detail?: string | undefined
  readonly failure?: string | undefined
  readonly diagnostic?: string | undefined
  readonly hint: string
  readonly children?: ReactNode
}

export function CliAccountSection(props: CliAccountSectionProps): ReactNode {
  const { packageName, phase, title, status, actions, detail, failure, diagnostic, hint, children } = props
  return (
    <div className={css.section} data-cli-account={phase} data-cli-account-package={packageName}>
      <h4 className={css.title}>{title}</h4>
      <CliAccountRow>
        <StateDot state={TONE[phase]} />
        <span className={css.label}>{status}</span>
        <div className={css.actions}>{actions}</div>
      </CliAccountRow>
      {detail === undefined ? null : <p className={css.detail}>{detail}</p>}
      {children}
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}{diagnostic === undefined ? null : <> {diagnostic}</>}</p>}
      <p className={css.hint}>{hint}</p>
    </div>
  )
}

export function CliAccountRow({ children }: { readonly children: ReactNode }): ReactNode {
  return <div className={css.status}>{children}</div>
}

export function CliAccountNote({ children }: { readonly children: ReactNode }): ReactNode {
  return <span className={css.detail}>{children}</span>
}

export function CliAccountActions({ children }: { readonly children: ReactNode }): ReactNode {
  return <div className={css.actions}>{children}</div>
}

export interface CliAccountBadgeProps {
  readonly subject: PropsRuntime<'plugins.detail.badge'>['subject']
  readonly packageName: string
  readonly phase: CliAccountPhase
  readonly label: (phase: Exclude<CliAccountPhase, 'checking'>) => string
}

export function CliAccountBadge({ subject, packageName, phase, label }: CliAccountBadgeProps): ReactNode {
  if (subject.kind === 'item' || subject.pkg.name !== packageName || !subject.pkg.enabled || phase === 'checking') return null
  return <Tag tone={BADGE_TONE[phase]}>{label(phase)}</Tag>
}

export interface CliAccountActivationProps {
  readonly needed: boolean
  readonly settled: boolean
  readonly title: string
  readonly body: string
  readonly later: string
  readonly connect: string
  readonly close: string
  readonly onDismiss: () => void
  readonly onConnect: () => void
}

export function CliAccountActivation(props: CliAccountActivationProps): ReactNode {
  const { needed, settled, title, body, later, connect, close, onDismiss, onConnect } = props
  useEffect(() => {
    if (settled && !needed) onDismiss()
  }, [settled, needed, onDismiss])
  return (
    <Modal open={needed} title={title} closeLabel={close} onClose={onDismiss}
      footer={<>
        <Button variant="ghost" onClick={onDismiss}>{later}</Button>
        <Button variant="primary" data-modal-autofocus onClick={onConnect}>{connect}</Button>
      </>}>
      <p>{body}</p>
    </Modal>
  )
}

export interface CliAccountConfirmProps {
  readonly open: boolean
  readonly title: string
  readonly body: string
  readonly confirm: string
  readonly cancel: string
  readonly close: string
  readonly onClose: () => void
  readonly onConfirm: () => void
}

export function CliAccountConfirm(props: CliAccountConfirmProps): ReactNode {
  const { open, title, body, confirm, cancel, close, onClose, onConfirm } = props
  return (
    <Modal open={open} title={title} closeLabel={close} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{cancel}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => { onClose(); onConfirm() }}>{confirm}</Button>
      </>}>
      <p>{body}</p>
    </Modal>
  )
}

export interface CliAccountToastProps<Notice extends string> {
  readonly notice: CliAccountNotice<Notice> | undefined
  readonly text: (kind: CliAccountNotice<Notice>['kind']) => string
  readonly onDone: () => void
}

export function CliAccountToast<Notice extends string>({ notice, text, onDone }: CliAccountToastProps<Notice>): ReactNode {
  if (notice === undefined) return null
  const failed = notice.kind === 'action-failed'
  return (
    <Toast key={notice.seq} text={text(notice.kind)} onDone={onDone}
      {...failed ? { icon: <IconWarningOutlineRegular /> } : { tone: 'success' as const }} />
  )
}

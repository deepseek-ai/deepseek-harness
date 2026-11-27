/** Dialog that names the new branch of a requested worktree, from the New Session option or after a failed attempt. */

import { useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import { branchLabel, branchNameProblem } from '../branch-name.ts'
import type { NS } from './locales.ts'
import css from './WorktreeNameDialog.module.css'

/**
 * Outcome of a worktree request: accepted; refused for its branch name, which the dialog shows; or failed otherwise,
 * which the request reports itself.
 */
export type WorktreeRequestResult = 'accepted' | 'invalid-name' | 'branch-exists' | 'failed'

/** Props of the naming dialog. */
export interface WorktreeNameDialogProps extends PropsLocale<typeof NS> {
  /** `name` names the branch of the open request; `retry` renames it after a failed attempt, then tries again. */
  readonly mode: 'name' | 'retry'
  /** Text the field starts with: the chosen name, or the prefix of generated names. */
  readonly initial: string
  /** Prefix of generated names; a field that holds only the prefix names no branch yet. */
  readonly prefix: string
  /** Base of the request, or null for HEAD. */
  readonly from: string | null
  /** Whether the request already names its branch, which offers a return to generated names. */
  readonly named: boolean
  /**
   * Request the worktree on `name`, or on generated names for null; in `retry` mode the caller also tries again
   * once the request is accepted.
   */
  readonly submit: (name: string | null) => Promise<WorktreeRequestResult>
  /** Close the dialog without a request. */
  readonly close: () => void
}

/**
 * Render the dialog: one branch name field checked against Git's branch-name rules while it is typed, and checked by
 * the Host when it is confirmed. A refused name keeps the dialog open with the reason under the field; an accepted
 * request closes it.
 * @param props - mode, starting text, prefix, base, the request, and copy.
 * @returns the dialog.
 */
export function WorktreeNameDialog({ mode, initial, prefix, from, named, submit, close, t }: WorktreeNameDialogProps): ReactNode {
  const [value, setValue] = useState(initial)
  const [refusal, setRefusal] = useState<{ readonly name: string; readonly text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const fieldId = useId()
  const messageId = useId()
  // The starting prefix names no branch yet, so it gets the hint rather than a rule it breaks, such as a trailing `/`.
  const blank = value === prefix
  const problem = blank ? null : branchNameProblem(value)
  const error = problem !== null ? t(`branchName.${problem}`) : refusal?.name === value ? refusal.text : null
  const retry = mode === 'retry'
  const send = (name: string | null): void => {
    setBusy(true)
    void submit(name).then((result) => {
      setBusy(false)
      if (result === 'accepted') close()
      else if (name !== null && result === 'branch-exists') setRefusal({ name, text: t('branchName.exists', { name }) })
      else if (name !== null && result === 'invalid-name') setRefusal({ name, text: t('branchName.invalid') })
    })
  }
  const confirmable = !busy && error === null && !blank
  const base = from === null ? null : branchLabel(from)
  const hint = blank && prefix !== '' ? t('nameDialog.prefixOnly') : base === null ? t('nameDialog.hintHead') : t('nameDialog.hint', { branch: base })
  return (
    <Modal open onClose={close} title={t(retry ? 'nameDialog.retryTitle' : 'nameDialog.title')} closeLabel={t('nameDialog.close')}
      footer={<>
        {named && !retry && (
          <Button variant="outline" className={css.auto} disabled={busy} onClick={() => { send(null) }}>{t('nameDialog.auto')}</Button>
        )}
        <Button variant="outline" onClick={close}>{t('nameDialog.cancel')}</Button>
        <Button variant="primary" disabled={!confirmable} onClick={() => { send(value) }}>
          {t(retry ? 'nameDialog.retry' : 'nameDialog.confirm')}
        </Button>
      </>}>
      <div className={css.form} data-forge-worktree-name="">
        <label className={css.label} htmlFor={fieldId}>{t('nameDialog.field')}</label>
        <Input id={fieldId} data-modal-autofocus className={clsx(css.field, error !== null && css.invalid)} value={value}
          spellCheck={false} autoCapitalize="off" autoComplete="off" aria-invalid={error !== null} aria-describedby={messageId}
          onChange={(event) => { setValue(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (confirmable) send(value)
          }} />
        <p id={messageId} className={clsx(css.message, error !== null && css.error)} role={error === null ? undefined : 'alert'}>{error ?? hint}</p>
      </div>
    </Modal>
  )
}

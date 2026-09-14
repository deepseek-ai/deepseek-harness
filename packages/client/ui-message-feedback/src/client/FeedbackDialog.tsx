/**
 * The feedback dialog and its acknowledgement and failure toasts, rendered as one entry
 * of `conversation.input.overlay` so each Session owns exactly one of each.
 * The Modal and the Toast both portal to `document.body`; the overlay slot
 * only supplies the per-session controller and the composer card the toast
 * centers over.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client/FeedbackDialog
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button, IconCheckOutline16, IconWarningOutline16, Modal, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FeedbackCategory } from '@deepseek-ai/dsh-command-feedback/types'
import type { FeedbackDialogProps } from './slots.ts'
import css from './FeedbackDialog.module.css'

/**
 * The chips in presentation order. A client bundle may not import a Host
 * package's values, so the taxonomy is restated as a complete record of the
 * `FeedbackCategory` union: a missing or foreign id is a compile error.
 */
const CATEGORY_CHIPS = {
  'task-result': true,
  'instruction-following': true,
  'product-interaction': true,
  'service-stability': true,
  'resource-cost': true,
  'security-privacy-permission': true,
  'other': true,
} satisfies Record<FeedbackCategory, true>
const CATEGORIES = Object.keys(CATEGORY_CHIPS) as FeedbackCategory[]

/** Failure codes with their own copy; every other code reads the generic line. */
const FAILURE_COPY: Partial<Record<string, 'error.conflict' | 'error.noteTooLarge'>> = {
  'version-conflict': 'error.conflict',
  'note-too-large': 'error.noteTooLarge',
}

/**
 * Render one Session's feedback dialog and toast.
 * @param props - the dialog hook, the draft verbs, and the locale seat.
 * @returns the modal while a target is open and either toast while it is showing.
 */
export function FeedbackDialog({
  useDialog, edit, submit, dismiss, dismissFailure, dismissToast, t,
}: FeedbackDialogProps) {
  const state = useDialog(s => s)
  // The toast centers over the composer card this entry renders inside of.
  const probeRef = useRef<HTMLSpanElement>(null)
  const [card, setCard] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setCard(probeRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null)
  }, [])
  const toast = state.toast
  const onToastDone = useCallback(() => { dismissToast(toast) }, [dismissToast, toast])
  // A toast retires with the entry that showed it: the Toast's own timer dies
  // on unmount, and the Session's controller must not replay it on return.
  useEffect(() => () => { dismissToast(toast) }, [dismissToast, toast])
  const failureCode = state.failure
  const failure = failureCode === null ? null : t(FAILURE_COPY[failureCode] ?? 'error.generic')
  const onFailureDone = useCallback(() => { dismissFailure() }, [dismissFailure])

  return (
    <>
      <span ref={probeRef} hidden />
      {toast > 0 && failure === null && (
        <Toast
          key={toast}
          text={t('toast.recorded')}
          icon={<span className={css.toastIcon}><IconCheckOutline16 size={12} /></span>}
          anchor={card}
          onDone={onToastDone}
        />
      )}
      {failure !== null && (
        <Toast
          key={`failure-${failureCode}`}
          text={failure}
          icon={<IconWarningOutline16 />}
          anchor={card}
          holdMs={6000}
          onDone={onFailureDone}
        />
      )}
      <Modal
        open={state.target !== null}
        title={t('dialog.title')}
        closeLabel={t('close')}
        onClose={dismiss}
        className={css.dialog as string}
        footer={(
          <Button
            variant="primary"
            className={css.submit}
            disabled={state.submitting}
            onClick={() => { void submit() }}
          >
            {state.submitting ? t('submitting') : t('submit')}
          </Button>
        )}
      >
        <div className={css.categories} role="group" aria-label={t('dialog.categories')}>
          {CATEGORIES.map(category => (
            <button
              key={category}
              type="button"
              className={state.category === category ? `${css.chip} ${css.chipActive}` : css.chip}
              aria-pressed={state.category === category}
              disabled={state.submitting}
              onClick={() => { edit({ category: state.category === category ? null : category }) }}
            >
              {t(`category.${category}`)}
            </button>
          ))}
        </div>
        <textarea
          className={css.detail}
          aria-label={t('dialog.detail')}
          placeholder={t('dialog.hint')}
          value={state.text}
          readOnly={state.submitting}
          onChange={(event) => { edit({ text: event.target.value }) }}
        />
      </Modal>
    </>
  )
}

/**
 * Controlled risk acknowledgement dialog shared by product surfaces that
 * must gate a sensitive action behind an explicit checkbox.
 */
import { Button } from './Button.tsx'
import { IconWarningOutlineRegular } from './icons/index.tsx'
import { Modal } from './Modal.tsx'
import css from './RiskConfirmation.module.css'

export interface RiskConfirmationProps {
  open: boolean
  title: string
  description: string
  acknowledgeLabel: string
  cancelLabel: string
  closeLabel: string
  confirmLabel: string
  acknowledged: boolean
  disabled?: boolean
  onAcknowledgedChange: (acknowledged: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Render one in-page confirmation whose primary action is unavailable until
 * the caller-controlled acknowledgement is checked.
 */
export function RiskConfirmation({
  open,
  title,
  description,
  acknowledgeLabel,
  cancelLabel,
  closeLabel,
  confirmLabel,
  acknowledged,
  disabled = false,
  onAcknowledgedChange,
  onCancel,
  onConfirm,
}: RiskConfirmationProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      closeLabel={closeLabel}
      className={css.confirmation ?? ''}
      contentClassName={css.confirmationContent ?? ''}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            className={css.confirmAction}
            disabled={disabled || !acknowledged}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className={css.warning}>
        <IconWarningOutlineRegular size={18} className={css.warningIcon} />
        <p>{description}</p>
      </div>
      <label className={css.acknowledgement}>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={disabled}
          data-modal-autofocus
          onChange={(event) => { onAcknowledgedChange(event.currentTarget.checked) }}
        />
        <span>{acknowledgeLabel}</span>
      </label>
    </Modal>
  )
}

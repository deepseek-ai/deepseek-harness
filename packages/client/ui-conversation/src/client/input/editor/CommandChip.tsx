/**
 * Visual body of the claimed command chip: the CommandChipNode's React face.
 * Pure display with the reference chip's treatment; the claim and its
 * lifecycle live on the node and the shell.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import css from './ReferenceChip.module.css'
import referenceCss from './composer-editor.module.css'

/** Display inputs of the command chip. */
export interface CommandChipProps {
  /** Claimed token without its argument separator, e.g. `/goal`. */
  readonly token: string
}

/**
 * Render the claimed command chip.
 * @param props - the token to display.
 * @returns the chip body.
 */
export function CommandChip({ token }: CommandChipProps): ReactNode {
  return (
    <span className={clsx(referenceCss.reference, css.chip)}>
      <span className={css.label}>{token}</span>
    </span>
  )
}

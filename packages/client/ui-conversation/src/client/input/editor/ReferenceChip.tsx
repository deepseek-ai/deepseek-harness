/**
 * Visual body of one inline reference chip: the DecoratorNode's React
 * face. Pure display — identity, invalidation, and lifecycle live on the
 * ReferenceChipNode; this component renders whatever the node carries.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ReferenceIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReferenceIconKind } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ReferenceChip.module.css'
import referenceCss from './composer-editor.module.css'

/** Display inputs of one chip (the node's cached owner projections). */
export interface ReferenceChipProps {
  readonly label: string
  /** Domain glyph; absent renders the trigger marker instead of an icon. */
  readonly appearance?: ReferenceIconKind | undefined
  /** Owner-resolution failure styling bit. */
  readonly invalid: boolean
}

/**
 * Render one inline reference chip.
 * @param props - label, optional domain glyph, and the invalid bit.
 * @returns the chip body (icon + truncating label).
 */
export function ReferenceChip({ label, appearance, invalid }: ReferenceChipProps): ReactNode {
  return (
    <span className={clsx(referenceCss.reference, css.chip, appearance === 'file' && !invalid && referenceCss.openable, invalid && css.invalid)} title={label}>
      {appearance === undefined
        ? <span className={css.marker} aria-hidden>@</span>
        : <ReferenceIcon kind={appearance} size={14} className={css.icon} />}
      <span className={css.label}>{label}</span>
    </span>
  )
}

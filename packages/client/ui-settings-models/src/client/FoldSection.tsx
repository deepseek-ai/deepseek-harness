/**
 * A titled part of a provider editor that folds: the model catalog and the
 * advanced settings. The body stays mounted while folded, so a draft, an
 * unfolded model row, or a request in flight inside it survives the fold.
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'

/** Props of {@link FoldSection}. */
interface FoldSectionProps {
  /** Heading text, which also names the section for assistive technology. */
  title: string
  /** Whether the section starts unfolded. */
  defaultOpen: boolean
  /** Whether the heading folds the section; a section that must stay in view passes `false`. */
  collapsible?: boolean
  /** State text and its action, placed after the heading. */
  status?: ReactNode
  /** Section actions, placed at the end of the heading row. */
  actions?: ReactNode
  /** Called with the new state after each fold or unfold. */
  onToggle?: (open: boolean) => void
  /** Section content. */
  children: ReactNode
}

/**
 * Render a section under a heading row that can fold it.
 * @param props - heading, initial state, heading-row content, and the body.
 * @returns the section.
 */
export function FoldSection(props: FoldSectionProps): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen)
  const body = useId()
  const shown = props.collapsible === false || open
  return (
    <section className={styles['fold']} aria-label={props.title}>
      <div className={styles['foldHead']}>
        {props.collapsible === false
          ? <span className={styles['foldTitle']}>{props.title}</span>
          : (
            <button
              type="button"
              className={styles['foldToggle']}
              aria-expanded={open}
              aria-controls={body}
              onClick={() => {
                setOpen(!open)
                props.onToggle?.(!open)
              }}
            >
              {props.title}
            </button>
          )}
        {props.status}
        {props.actions === undefined ? null : <span className={styles['foldActions']}>{props.actions}</span>}
      </div>
      <div id={body} className={styles['foldBody']} hidden={!shown}>{props.children}</div>
    </section>
  )
}

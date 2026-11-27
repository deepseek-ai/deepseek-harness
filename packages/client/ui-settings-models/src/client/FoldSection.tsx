/**
 * A titled part of a provider editor that folds: the model catalog and the
 * advanced settings. The owner holds whether it is open, so the owner can
 * unfold it to show a field a refused save names. The body stays mounted while
 * folded, so a draft, an unfolded model row, or a request in flight inside it
 * survives the fold. The heading row and the notice under it stay in view
 * while folded, so an action in the heading row reports its outcome there.
 */

import { useId } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import styles from './ModelsSection.module.css'

/** Props of {@link FoldSection}. */
interface FoldSectionProps {
  /** Heading text, which also names the section for assistive technology. */
  title: string
  /** Whether the section is unfolded. */
  open: boolean
  /** Whether the heading folds the section; a section that must stay in view passes `false`. */
  collapsible?: boolean
  /** State text and its action, placed after the heading. */
  status?: ReactNode
  /** Section actions, placed at the end of the heading row. */
  actions?: ReactNode
  /** The outcome of a heading-row action, placed under the heading row and shown whether or not the section is folded. */
  notice?: ReactNode
  /** Called with the requested state when the heading is pressed. */
  onToggle: (open: boolean) => void
  /** Section content. */
  children: ReactNode
}

/**
 * Render a section under a heading row that can fold it. The heading carries
 * the chevron the model rows use: right while folded, down while unfolded.
 * @param props - heading, state, heading-row content, and the body.
 * @returns the section.
 */
export function FoldSection(props: FoldSectionProps): ReactNode {
  const body = useId()
  const shown = props.collapsible === false || props.open
  return (
    <section className={styles['fold']} aria-label={props.title}>
      <div className={styles['foldHead']}>
        {props.collapsible === false
          ? <span className={styles['foldTitle']}>{props.title}</span>
          : (
            <button
              type="button"
              className={styles['foldToggle']}
              aria-expanded={props.open}
              aria-controls={body}
              onClick={() => { props.onToggle(!props.open) }}
            >
              {props.title}
              {props.open ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
            </button>
          )}
        {props.status}
        {props.actions === undefined ? null : <span className={styles['foldActions']}>{props.actions}</span>}
      </div>
      {props.notice}
      <div id={body} className={styles['foldBody']} hidden={!shown}>{props.children}</div>
    </section>
  )
}

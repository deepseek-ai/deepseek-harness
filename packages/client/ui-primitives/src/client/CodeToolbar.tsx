/** Shared language, wrapping, and clipboard controls for code cards. */
import {
  IconCheckOutlineRegular, IconCopyOutlineRegular, IconNowrapFillRegular, IconWrapFillRegular,
} from './icons/index.tsx'
import { Tooltip } from './Tooltip.tsx'
import { supportsHighlighting } from './markdown/highlight.ts'
import css from './CodeCard.module.css'

/** Localized language fallback and wrapping actions supplied by the card owner. */
export interface CodeToolbarLabels {
  /** Title for an absent or unsupported language. */
  codeLabel: string
  /** Action that enables wrapping. */
  wrapLabel: string
  /** Action that preserves source columns with horizontal scrolling. */
  unwrapLabel: string
}

/** Display state and callbacks for a code card's toolbar. */
interface CodeToolbarProps {
  lang?: string | undefined
  title?: string | undefined
  status?: string | undefined
  labels: CodeToolbarLabels
  copyLabel: string
  copiedLabel: string
  copied: boolean
  wrapped: boolean
  onCopy?: (() => void) | undefined
  onWrap?: (() => void) | undefined
}

/**
 * Render a language label and keyboard-accessible icon actions with tooltips.
 * @param props - Localized labels, current state, and card-owned actions.
 * @returns The shared code-card header.
 */
export function CodeToolbar({ lang, title, status, labels, copyLabel, copiedLabel, copied, wrapped, onCopy, onWrap }: CodeToolbarProps) {
  const wrapLabel = wrapped ? labels.unwrapLabel : labels.wrapLabel
  const clipboardLabel = copied ? copiedLabel : copyLabel
  return (
    <div className={css.header} data-code-block-banner>
      <div className={css.heading}>
        <span className={css.language}>{supportsHighlighting(lang) ? lang : labels.codeLabel}</span>
        {title !== undefined && <span className={css.title} title={title}>{title}</span>}
      </div>
      <div className={css.actions}>
        {status !== undefined && <span className={css.status}>{status}</span>}
        {onWrap !== undefined && <Tooltip label={wrapLabel} side="top" portal>
          <button type="button" className={css.action} aria-label={labels.wrapLabel} aria-pressed={wrapped} onClick={onWrap}>
            {wrapped ? <IconNowrapFillRegular size={14} /> : <IconWrapFillRegular size={14} />}
          </button>
        </Tooltip>}
        {onCopy !== undefined && <Tooltip label={clipboardLabel} side="top" portal>
          <button type="button" className={css.action} aria-label={clipboardLabel} onClick={onCopy}>
            {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
          </button>
        </Tooltip>}
      </div>
    </div>
  )
}

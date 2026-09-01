import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { FoldToggle } from './FoldToggle.tsx'
import { writeClipboard } from './clipboard.ts'
import {
  grammarLoadCount,
  highlightLines,
  subscribeGrammarLoaded,
  type HighlightSpan,
} from './markdown/highlight.ts'
import { useViewportHighlighting } from './markdown/useViewportHighlighting.ts'
import css from './ReadBlock.module.css'

/**
 * Content lines shown before the height cap collapses the middle. Matches
 * TerminalBlock's default so a long read and a long command output cut at the
 * same place in the same flow.
 */
export const DEFAULT_READ_MAX_LINES = 16

/** One line of the read window: its file line number and its text (no trailing newline). */
export interface ReadBlockLine {
  /** 1-based line number in the file (a window past an offset keeps the file's own numbering). */
  number: number
  /** The line's text, already truncated to the read tool's per-line cap. */
  text: string
}

export interface ReadBlockProps {
  /** Banner label (the file path, or a tool-supplied replacement title); omitted draws no label. */
  label?: string | undefined
  /** The returned window's lines, in file order, each keeping its file line number. */
  lines: readonly ReadBlockLine[]
  /** Localized chrome supplied by the owning render site. */
  labels: ReadBlockLabels
  /** Exact total line count in the file, for the "showing N of M" note when the read is a window. */
  totalLines: number
  /** Grammar hint (a file-extension-derived language id); unknown or absent = plain monospace. */
  lang?: string | undefined
  /** Height cap in content lines before the middle collapses (default {@link DEFAULT_READ_MAX_LINES}). */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/** Localized chrome for {@link ReadBlock}. */
export interface ReadBlockLabels {
  window: (shown: number, total: number) => string
  copy: string
  copied: string
  collapseAria: string
  expandAria: (hidden: number) => string
  collapse: string
  expand: (hidden: number) => string
}

function renderSpans(spans: readonly HighlightSpan[]) {
  return spans.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)
}

/**
 * Render a read tool result as a line-numbered, optionally syntax-highlighted
 * file view.
 * @param props - see {@link ReadBlockProps}.
 * @returns the read block element.
 */
export function ReadBlock({
  label,
  labels,
  lines,
  totalLines,
  lang,
  maxLines = DEFAULT_READ_MAX_LINES,
  className,
}: ReadBlockProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const highlighting = useViewportHighlighting(rootRef, lang)
  // Whole-window highlighting preserves multiline grammar context; copy uses
  // the same text without gutter or banner chrome.
  const raw = useMemo(() => lines.map(line => line.text).join('\n'), [lines])
  // Re-render when a lazy grammar finishes loading, so a read card that showed
  // plain text while its language's grammar imported picks up highlighting. The
  // snapshot value is opaque; only its change across renders drives the memo.
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const highlighted = useMemo(
    () => highlighting ? highlightLines(raw, lang) : undefined,
    [highlighting, raw, lang, loaded],
  )
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(raw).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, raw])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  const hidden = lines.length - maxLines
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines
  // A read is a window when its returned lines are fewer than the file's total;
  // the note states that so a reader is not misled that the file ends here.
  const windowed = lines.length < totalLines

  const rows = (slice: readonly (readonly [ReadBlockLine, readonly HighlightSpan[] | undefined])[]) =>
    slice.map(([line, spans]) => (
      <div key={line.number} className={css.line}>
        <span className={css.gutter} aria-hidden>{line.number}</span>
        <span className={css.content}>{spans === undefined ? line.text : renderSpans(spans)}</span>
      </div>
    ))

  const paired = lines.map((line, index): readonly [ReadBlockLine, readonly HighlightSpan[] | undefined] =>
    [line, highlighted?.[index]])

  return (
    <div ref={rootRef} className={clsx(css.block, className)} data-read="">
      <div className={css.banner}>
        <div className={css.label}>{label ?? ''}</div>
        <div className={css.action}>
          {windowed && (
            <span className={css.count}>{labels.window(lines.length, totalLines)}</span>
          )}
          <span className={css.lang}>{lang ?? ''}</span>
          {/* Empty files omit Copy to avoid replacing the clipboard with an empty string. */}
          {lines.length > 0 && (
            <button type="button" className={css.copyButton} onClick={onCopy}>
              {copied ? labels.copied : labels.copy}
            </button>
          )}
        </div>
      </div>
      <div className={css.body}>
        {rows(capped ? paired.slice(0, headLines) : paired)}
        {hidden > 0 && (
          <FoldToggle
            className={css.expand}
            expanded={expanded}
            hidden={hidden}
            labels={labels}
            onToggle={onToggle}
          />
        )}
        {capped && rows(paired.slice(paired.length - tailLines))}
      </div>
    </div>
  )
}

import { useCallback, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { headTailCap } from './head-tail-cap.ts'
import { useClipboardCopy } from './use-clipboard-copy.ts'
import css from './SearchBlock.module.css'

/**
 * Result rows shown before the height cap collapses the middle. Matches
 * {@link DEFAULT_TERMINAL_MAX_LINES} so a search card and a terminal card cut a
 * long result at the same place.
 */
export const DEFAULT_SEARCH_MAX_LINES = 16

/** One matched line inside a {@link SearchFileGroup}: its 1-based line number and text. */
export interface SearchBlockLineMatch {
  /** 1-based line number of the match within its file. */
  lineNumber: number
  /** The matched line text, as the tool surfaced it. */
  line: string
}

/** One file's grouped matches, in first-seen file order. */
export interface SearchFileGroup {
  /** The file the matches belong to (the display path). */
  path: string
  /** The file's matched lines, in output order. */
  matches: SearchBlockLineMatch[]
}

/** Fields both search shapes carry (the render site positions; this component draws). */
interface SearchBlockCommon {
  /** Localized chrome supplied by the owning render site. */
  labels: SearchBlockLabels
  /**
   * Whether the tool capped the inline result: the shape carries only the
   * retained results, not every result the search found. The banner summary
   * folds the pre-cap `total` in (`显示 X / 共 N …`) so the card never presents a
   * capped result as complete.
   */
  truncated: boolean
  /** Total results the search found before capping (equals the retained count when not `truncated`). */
  total: number
  /** Height cap in rows before the middle collapses (default {@link DEFAULT_SEARCH_MAX_LINES}). */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper. */
  className?: string | undefined
}

/** Localized chrome for {@link SearchBlock}. */
export interface SearchBlockLabels {
  pathsSummary: (shown: number, total: number, truncated: boolean) => string
  matchesSummary: (shown: number, total: number, files: number, truncated: boolean) => string
  copy: string
  copied: string
  noResults: string
  collapseAria: string
  expandAria: (hidden: number) => string
  collapse: string
  expand: (hidden: number) => string
}

/** Props for the grouped-matches (`grep`) shape. */
export interface SearchMatchesBlockProps extends SearchBlockCommon {
  kind: 'matches'
  /** Matched lines grouped by file, in first-seen file order. */
  files: SearchFileGroup[]
}

/** Props for the flat-path (`glob`) shape. */
export interface SearchPathsBlockProps extends SearchBlockCommon {
  kind: 'paths'
  /** The discovered paths, in the tool's result order (the retained page when `truncated`). */
  paths: string[]
}

/** {@link SearchBlock} props: one card, two `kind`-discriminated shapes. */
export type SearchBlockProps = SearchMatchesBlockProps | SearchPathsBlockProps

/**
 * One flattened render row. A matches card produces a `file` header row per
 * group followed by a `match` row per retained line while the group is
 * expanded; a paths card produces one `path` row per path. The height cap
 * counts these rows uniformly, so a file header costs one row exactly as a
 * match line or a path does.
 */
type SearchRow =
  | { type: 'file'; path: string; count: number; index: number; collapsed: boolean }
  | { type: 'match'; lineNumber: number; line: string; key: string; fileIndex: number }
  | { type: 'path'; path: string }

/**
 * The plain-text form the copy control writes: the whole structured result
 * regardless of the height cap or which groups are collapsed, so the clipboard
 * carries the result rather than what the card happens to be showing.
 * @param props - the card's props.
 * @returns the copyable text, or the empty string for an empty result.
 */
function copyText(props: SearchBlockProps): string {
  if (props.kind === 'paths') return props.paths.join('\n')
  return props.files
    .map(file => [file.path, ...file.matches.map(m => `${m.lineNumber}: ${m.line}`)].join('\n'))
    .join('\n\n')
}

/**
 * Number of retained results the card holds: the matched-line count across all
 * files for a matches card, the path count for a paths card. This is the count
 * the banner summary reports against `total` when the result was capped.
 * @param props - the card's props.
 * @returns the retained result count.
 */
function shownCount(props: SearchBlockProps): number {
  return props.kind === 'paths'
    ? props.paths.length
    : props.files.reduce((sum, file) => sum + file.matches.length, 0)
}

/**
 * The banner summary. When the search was capped it reads `显示 X / 共 N …` so
 * the retained count and the pre-cap total sit in one clause (mirroring the read
 * card's `显示 X / Y 行`); when it was not capped it is a plain count of what the
 * card holds. The unit — `处匹配 · K 个文件` for grep, `个路径` for glob — trails
 * the count either way.
 * @param props - the card's props.
 * @param shown - the retained result count from {@link shownCount}.
 * @param truncated - whether the search was capped.
 * @param total - the pre-cap total the truncation clause reports.
 * @returns the summary text.
 */
function summaryText(props: SearchBlockProps, shown: number, truncated: boolean, total: number): string {
  return props.kind === 'paths'
    ? props.labels.pathsSummary(shown, total, truncated)
    : props.labels.matchesSummary(shown, total, props.files.length, truncated)
}

/**
 * Flatten a card's shape into its render rows, dropping a collapsed file
 * group's match rows.
 * @param props - the card's props.
 * @param collapsed - the set of collapsed file-group indices (matches only).
 * @returns the flattened rows in output order.
 */
function toRows(props: SearchBlockProps, collapsed: ReadonlySet<number>): SearchRow[] {
  if (props.kind === 'paths') return props.paths.map((path): SearchRow => ({ type: 'path', path }))
  const rows: SearchRow[] = []
  props.files.forEach((file, index) => {
    const isCollapsed = collapsed.has(index)
    rows.push({ type: 'file', path: file.path, count: file.matches.length, index, collapsed: isCollapsed })
    if (isCollapsed) return
    for (const match of file.matches) {
      rows.push({ type: 'match', lineNumber: match.lineNumber, line: match.line, key: `${index}:${match.lineNumber}`, fileIndex: index })
    }
  })
  return rows
}

/**
 * A stable React key for a flattened render row: the group-scoped match key, a
 * file-index-scoped header key, or the path itself. Rows of different types
 * never collide, since each key carries its type prefix or the group index.
 * @param row - the flattened row.
 * @returns the key.
 */
function rowKey(row: SearchRow): string {
  switch (row.type) {
    case 'match': return `match:${row.key}`
    case 'file': return `file:${row.index}`
    case 'path': return `path:${row.path}`
  }
}

/**
 * Render a completed search as a grouped-matches or flat-path card.
 * @param props - see {@link SearchBlockProps}.
 * @returns the search block element.
 */
export function SearchBlock(props: SearchBlockProps) {
  const { truncated, total, maxLines = DEFAULT_SEARCH_MAX_LINES, className } = props
  const [expanded, setExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())

  // `props` is a fresh object each render, so memoizing on it never hits; the
  // flatten is cheap, so it runs inline keyed on the collapse set instead.
  const rows = toRows(props, collapsed)
  const shown = shownCount(props)
  const empty = rows.length === 0
  const { copied, onCopy } = useClipboardCopy(copyText(props))

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  const toggleFile = useCallback((index: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  const { hidden, capped, headLines, tailLines } = headTailCap(rows.length, maxLines, expanded)
  const head = capped ? rows.slice(0, headLines) : rows
  const naturalTail = capped ? rows.slice(rows.length - tailLines) : []
  // When the tail slice begins inside a file's matches, its own header sits
  // above the cut and is not shown, so those rows could not be attributed to a
  // file. Restore the owning header at the top of the tail — unless the head
  // slice already carries it (a single large file), where it would duplicate.
  const tailLead = naturalTail[0]
  const tailHeader = tailLead?.type === 'match'
    && !head.some(row => row.type === 'file' && row.index === tailLead.fileIndex)
    ? rows.find((row): row is Extract<SearchRow, { type: 'file' }> =>
      row.type === 'file' && row.index === tailLead.fileIndex)
    : undefined
  // The restored header is itself a row. Left extra it would push the card to
  // maxLines + 1 and overstate `hidden` by one, so it consumes a tail slot: drop
  // the tail's first row (the match whose header this is) for it. Visible rows
  // hold at maxLines and `hidden` stays exact; the dropped match joins the
  // hidden middle.
  const tail = tailHeader === undefined ? naturalTail : naturalTail.slice(1)

  const renderRow = (row: SearchRow): ReactNode => {
    if (row.type === 'path') return <div className={css.line}>{row.path}</div>
    if (row.type === 'match') {
      return (
        <div className={css.line}>
          <span className={css.lineNumber}>{row.lineNumber}: </span>
          {row.line}
        </div>
      )
    }
    return (
      <button
        type="button"
        className={css.fileHeader}
        aria-expanded={!row.collapsed}
        onClick={() => { toggleFile(row.index) }}
      >
        <span className={css.filePath}>{row.path}</span>
        <span className={css.fileCount}>{row.count}</span>
      </button>
    )
  }

  return (
    <div className={clsx(css.block, className)} data-search={props.kind}>
      <div className={css.header}>
        <span className={css.summary}>{summaryText(props, shown, truncated, total)}</span>
        {!empty && (
          <button type="button" className={css.copyButton} onClick={onCopy}>
            {copied ? props.labels.copied : props.labels.copy}
          </button>
        )}
      </div>
      {empty
        ? <div className={css.empty}>{props.labels.noResults}</div>
        : (
          <div className={css.body}>
            {head.map(row => (
              <div key={rowKey(row)}>{renderRow(row)}</div>
            ))}
            {hidden > 0 && (
              <button
                type="button"
                className={css.expand}
                aria-expanded={expanded}
                aria-label={expanded ? props.labels.collapseAria : props.labels.expandAria(hidden)}
                onClick={onToggle}
              >
                {expanded ? props.labels.collapse : props.labels.expand(hidden)}
              </button>
            )}
            {tailHeader !== undefined && (
              <div key={`tailHeader:${rowKey(tailHeader)}`}>{renderRow(tailHeader)}</div>
            )}
            {tail.map(row => (
              <div key={rowKey(row)}>{renderRow(row)}</div>
            ))}
          </div>
        )}
    </div>
  )
}

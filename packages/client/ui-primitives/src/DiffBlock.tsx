import { useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { structuredPatch } from 'diff'
import { FoldToggle } from './FoldToggle.tsx'
import { writeClipboard } from './clipboard.ts'
import css from './DiffBlock.module.css'

/** Output lines shown before the height cap collapses the middle. */
export const DEFAULT_DIFF_MAX_LINES = 16

/**
 * One file change in the form {@link DiffBlock} renders. It is declared here
 * so this primitive stays independent of the tool contract.
 */
export interface DiffHunk {
  /** The changed file's path, drawn verbatim as the hunk's header (the tool's model-facing path). */
  path: string
  /** Prior content including context, or `null` when no prior content is available. */
  oldText: string | null
  /** Content after the change, including any shared context. */
  newText: string
}

export interface DiffBlockProps {
  /** One entry per applied hunk, in file order; empty renders nothing. */
  diffs: DiffHunk[]
  /** Localized chrome supplied by the owning render site. */
  labels: DiffBlockLabels
  /** Height cap in body lines before the middle collapses (default {@link DEFAULT_DIFF_MAX_LINES}). */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/** Localized chrome for {@link DiffBlock}. */
export interface DiffBlockLabels {
  copy: string
  copied: string
  collapseAria: string
  expandAria: (hidden: number) => string
  collapse: string
  expand: (hidden: number) => string
  files: (count: number) => string
}

/** A single rendered body line and its role, so the height cap slices a flat list. */
interface DiffRow {
  kind: 'path' | 'del' | 'add' | 'context' | 'gap'
  text: string
}

/** Local exhaustiveness helper — this package does not depend on `dsh-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a row kind is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable diff row kind: ${String(value)}`)
}

/** The dim class per row kind (path/gap chrome vs the diff's own +/- colors). */
const ROW_CLASS: Record<DiffRow['kind'], string | undefined> = {
  path: css.path,
  del: css.del,
  add: css.add,
  context: css.context,
  gap: css.gap,
}

/** Bound synchronous edit-graph search; one replacement consumes two edits. */
const MAX_DIFF_EDIT_LENGTH = 256

/** Derive exact local patches or a whole-fragment replacement when search exceeds the limit. */
function localHunks(diff: DiffHunk) {
  const oldLines = contentLines(diff.oldText ?? '')
  const newLines = contentLines(diff.newText)
  const normalize = (lines: string[]): string => lines.map(line => `${line}\n`).join('')
  return structuredPatch('', '', normalize(oldLines), normalize(newLines),
    undefined, undefined, { context: 3, maxEditLength: MAX_DIFF_EDIT_LENGTH })?.hunks
    ?? [{ lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)] }]
}

/**
 * Count displayed additions and deletions. Exact patches exclude shared context;
 * comparisons exceeding the edit limit count both complete fragments as replaced.
 * Text follows {@link contentLines}'s terminator rule.
 * @param diffs - the hunks to count.
 * @returns the +/- totals for summaries and the card footer.
 */
export function diffTotals(diffs: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const hunk of localHunks(diff)) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++
        if (line.startsWith('-')) removed++
      }
    }
  }
  return { added, removed }
}

/**
 * Flatten local patches into rows and count only added and removed lines.
 * A path header opens each new file. A `⋯` gap separates consecutive same-file
 * fragments and distant patches within a fragment. File counts use distinct paths.
 * @param diffs - the hunks to render.
 * @returns the body rows, the +/- totals, and the distinct-file count.
 */
function buildRows(diffs: DiffHunk[]): { rows: DiffRow[]; added: number; removed: number; files: number } {
  const rows: DiffRow[] = []
  const paths = new Set<string>()
  let prevPath: string | undefined
  for (const diff of diffs) {
    paths.add(diff.path)
    if (diff.path !== prevPath) rows.push({ kind: 'path', text: diff.path })
    else rows.push({ kind: 'gap', text: '⋯' })
    prevPath = diff.path
    for (const [index, hunk] of localHunks(diff).entries()) {
      if (index > 0) rows.push({ kind: 'gap', text: '⋯' })
      for (const line of hunk.lines) {
        const kind = line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : 'context'
        rows.push({ kind, text: line.slice(1) })
      }
    }
  }
  return {
    rows,
    added: rows.filter(row => row.kind === 'add').length,
    removed: rows.filter(row => row.kind === 'del').length,
    files: paths.size,
  }
}

/**
 * Split a side's text into its content lines. Empty text is zero lines (a full
 * deletion's `newText` or a create's absent `oldText` side draws nothing), and a
 * single trailing newline is a line terminator rather than an extra empty line —
 * the same terminator rule TerminalBlock applies to command output. An interior
 * blank line (a genuine `\n\n`) survives.
 * @param text - the removed or added side's text.
 * @returns the content lines, without the terminating newline.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Copy the full local diff, including folded rows: removed/added lines have
 * `- `/`+ ` prefixes, context has two spaces, and paths and gaps stay verbatim.
 * @param rows - the flattened body rows.
 * @returns the diff as plain text.
 */
function copyText(rows: DiffRow[]): string {
  return rows.map((row) => {
    switch (row.kind) {
      case 'del': return `- ${row.text}`
      case 'add': return `+ ${row.text}`
      case 'context': return `  ${row.text}`
      case 'path': return row.text
      case 'gap': return row.text
      /* v8 ignore next -- closed-union backstop; only reached if a row kind is forged */
      default: return assertNever(row.kind)
    }
  }).join('\n')
}

/**
 * Render a file mutation as an inline diff surface.
 * @param props - see {@link DiffBlockProps}.
 * @returns the diff block element.
 */
export function DiffBlock({ diffs, labels, maxLines = DEFAULT_DIFF_MAX_LINES, className }: DiffBlockProps) {
  const { rows, added, removed, files } = useMemo(() => buildRows(diffs), [diffs])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText(rows)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, rows])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  if (rows.length === 0) return null

  const hidden = rows.length - maxLines
  const capped = hidden > 0 && !expanded
  // Same split arithmetic as TerminalBlock and the TUI transcript's collapsed
  // card, so a body's head and tail slices agree across the front ends.
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines
  const head = capped ? rows.slice(0, headLines) : rows
  const tail = capped ? rows.slice(rows.length - tailLines) : []

  return (
    <div className={clsx(css.block, className)} data-diff="">
      <button type="button" className={css.copyButton} onClick={onCopy}>
        {copied ? labels.copied : labels.copy}
      </button>
      <div className={css.body}>
        {head.map((row, index) => (
          <div key={index} className={clsx(css.line, ROW_CLASS[row.kind])}>{row.text}</div>
        ))}
        {hidden > 0 && (
          <FoldToggle
            className={css.expand}
            expanded={expanded}
            hidden={hidden}
            labels={labels}
            onToggle={onToggle}
          />
        )}
        {tail.map((row, index) => (
          <div key={index} className={clsx(css.line, ROW_CLASS[row.kind])}>{row.text}</div>
        ))}
      </div>
      <div className={css.footer}>└ +{added} -{removed} · {labels.files(files)}</div>
    </div>
  )
}

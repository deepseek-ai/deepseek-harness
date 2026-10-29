/**
 * One file of the changes view: a sticky header with the path, badges, line
 * counts, and file actions, then its hunks unified or side by side with the
 * unchanged lines between them collapsed into rows that expand them.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import { flushSync } from 'react-dom'
import {
  FileTypeIcon, IconChevronDownOutlineRegular, IconChevronsUpDownOutlineRegular, IconEllipsisOutlineRegular, IconPlusOutlineRegular,
  Tooltip,
  languageForPath, Menu, MenuItemButton, useCodeHighlighter, type CodeHighlighter, type HighlightSpan,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeDiffFile } from '../types.ts'
import { segmentsOf, splitRows, type DiffRow, type SplitCell, type SplitRow } from './diff-rows.ts'
import { codeSideAt, readCodeSelection } from './code-selection.ts'
import { reviewMatches, selectReviewLines, type ReviewSelection } from './review.ts'
import { ReviewThread, useFileReview } from './ReviewThread.tsx'
import type { FileReviewState } from './review-queue.ts'
import { ReviewComposer, type ReviewActions } from './ReviewComposer.tsx'
import reviewCss from './ReviewComposer.module.css'
import { FileLabel } from './FileLabel.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import css from './ChangesTab.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** One action of a file's menu. */
export interface DiffFileAction {
  /** Dictionary key of the row label. */
  readonly label: ForgePanelKey
  /** Runs the action. */
  readonly run: () => void
}

/** New side of a file: its lines once read, `loading` while a read runs, or undefined before any. */
export type DiffFileText = readonly string[] | 'loading' | undefined

/** Props of one file section. */
export interface DiffFileProps {
  /** Whether the owning tab is visible and may show temporary menus. */
  readonly visible: boolean
  /** Comment destinations and the source being reviewed. */
  readonly review?: ReviewActions
  /** The file and its hunks. */
  readonly file: ForgeDiffFile
  /** Whether the section shows its lines. */
  readonly expanded: boolean
  /** Expand or collapse the section. */
  readonly onToggle: () => void
  /** Whether the file shows the large-file notice instead of its lines until revealed. */
  readonly large: boolean
  /** Whether the user revealed a large file. */
  readonly revealed: boolean
  /** Show a large file anyway. */
  readonly onReveal: () => void
  /** The file's new side, which supplies collapsed unchanged lines. */
  readonly text: DiffFileText
  /** Indexes of the expanded gaps. */
  readonly open: ReadonlySet<number>
  /** Expand one gap. */
  readonly onExpand: (index: number) => void
  /** Whether deletions and additions show in two columns; a file with only additions or only deletions keeps one. */
  readonly split: boolean
  /** Whether long lines wrap. */
  readonly wrap: boolean
  /** Badge text after the path, or empty for none. */
  readonly badge: string
  /** Hover text of the path: both paths of a renamed file, else the path. */
  readonly tooltip: string
  /** Rows of the file's menu. */
  readonly actions: readonly DiffFileAction[]
  /** Receives the section element, which scrolling to the file targets. */
  readonly sectionRef: (element: HTMLElement | null) => void
  /** Forge panel copy. */
  readonly t: Translate
}

/**
 * Render added and deleted line counts, or the binary label for binary content.
 * @param props - the counts and copy.
 * @returns the counts.
 */
export function Counts({ file, t }: {
  readonly file: Pick<ForgeDiffFile, 'additions' | 'deletions' | 'binary'>
  readonly t: Translate
}): ReactNode {
  if (file.binary) return <span>{t('diff.binaryLabel')}</span>
  return (
    <span className={css.counts}>
      <span className={css.added}>{`+${file.additions.toLocaleString('en-US')}`}</span>
      <span className={css.deleted}>{`−${file.deletions.toLocaleString('en-US')}`}</span>
    </span>
  )
}

const SIGN: Record<DiffRow['kind'], string> = { add: '+', del: '-', context: '' }

/** Highlighted tokens of one side's lines by line number, or undefined while the grammar is unavailable. */
type SideSpans = ReadonlyMap<number, readonly HighlightSpan[]> | undefined

/** A segment ready to draw: collapsed lines, or rows with the tokens of each side. */
type Prepared =
  | { readonly kind: 'gap'; readonly index: number; readonly count: number | null }
  | { readonly kind: 'rows'; readonly rows: readonly DiffRow[]; readonly old: SideSpans; readonly new: SideSpans }

/** Highlight one side of a run of rows as one fragment, so tokens spanning lines keep their state. */
function sideSpans(rows: readonly DiffRow[], side: 'old' | 'new', highlighter: CodeHighlighter): SideSpans {
  const numbered: { readonly no: number; readonly text: string }[] = []
  for (const row of rows) {
    const no = row[side]
    if (no !== null) numbered.push({ no, text: row.text })
  }
  if (numbered.length === 0) return new Map()
  const highlighted = highlighter(numbered.map(line => line.text).join('\n'))
  if (highlighted === undefined) return undefined
  // Shiki omits a final empty token row, so a final empty line gets no tokens.
  return new Map(numbered.map((line, index) => [line.no, highlighted[index] ?? []]))
}

function Code({ text, spans, old, next }: {
  readonly text: string
  readonly spans: readonly HighlightSpan[] | undefined
  readonly old: number | null
  readonly next: number | null
}): ReactNode {
  return (
    <span className={css.text} data-review-code="" data-old-line={old ?? undefined} data-new-line={next ?? undefined} data-diff-code={spans === undefined ? undefined : ''}>
      {spans === undefined ? text : spans.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)}
    </span>
  )
}

/** Whether a side-by-side row repeats an unchanged line or shows a change. */
function pairKind(pair: SplitRow): 'context' | 'change' {
  return pair.left !== null && pair.left.kind === 'context' ? 'context' : 'change'
}

/** The hunks of one file with their collapsed and expanded unchanged lines. */
function Lines({ file, text, open, onExpand, split, wrap, review, visible, comments, t }: Pick<DiffFileProps,
  'file' | 'text' | 'open' | 'onExpand' | 'split' | 'wrap' | 'review' | 'visible' | 't'> & { readonly comments: FileReviewState }): ReactNode {
  const lines = typeof text === 'object' ? text : undefined
  const columns = split && file.additions > 0 && file.deletions > 0
  const singleSide = file.status === 'added' ? 'R' : file.status === 'deleted' ? 'L' : null
  let maximum = Math.max(1, lines?.length ?? 0, (lines?.length ?? 0) + file.deletions - file.additions)
  for (const hunk of file.hunks) maximum = Math.max(maximum, hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1)
  const style: CSSProperties & { '--forge-number-width': string } = { '--forge-number-width': `calc(${Math.max(2, String(maximum).length)}ch + 12px)` }
  const highlighter = useCodeHighlighter(languageForPath(file.path))
  const [selection, setSelection] = useState<ReviewSelection | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const origin = useRef<{ side: 'L' | 'R'; line: number } | null>(null)
  const dragging = useRef<'gutter' | 'text' | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [nativeSide, setNativeSide] = useState<'L' | 'R' | null>(null)
  const nativeSelection = useCallback((): void => {
    if (editing || nativeSide === null || root.current === null || review === undefined) return
    const selected = readCodeSelection(root.current, nativeSide)
    if (selected === undefined) {
      setSelection(null)
      setNativeSide(null)
      return
    }
    const comment = selectReviewLines(file, selected.side, selected.from, selected.to)
    setSelection(previous => comment === undefined ? null
      : previous?.comment.side === comment.side && previous.comment.startLine === comment.startLine
        && previous.comment.endLine === comment.endLine
        ? previous : { source: review.source, comment })
  }, [editing, nativeSide, review, file])
  useEffect(() => {
    if (nativeSide === null || editing) return
    const changed = (): void => { if (dragging.current === null) nativeSelection() }
    document.addEventListener('selectionchange', changed)
    return () => { document.removeEventListener('selectionchange', changed) }
  }, [nativeSide, editing, nativeSelection])
  useEffect(() => {
    if (nativeSide === null) return
    const copy = (event: ClipboardEvent): void => {
      if (root.current === null || event.clipboardData === null
        || (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]') !== null)) return
      const selected = readCodeSelection(root.current, nativeSide)
      if (selected === undefined) return
      event.preventDefault()
      event.clipboardData.setData('text/plain', selected.text)
    }
    document.addEventListener('copy', copy)
    return () => { document.removeEventListener('copy', copy) }
  }, [nativeSide])
  useEffect(() => {
    if (!selecting) return
    const finish = (): void => {
      if (dragging.current === 'text') nativeSelection()
      dragging.current = null
      setSelecting(false)
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [selecting, nativeSelection])
  const prepared = useMemo(() => segmentsOf(file, lines, open).map((segment): Prepared => segment.kind === 'gap'
    ? segment
    : { ...segment, old: sideSpans(segment.rows, 'old', highlighter), new: sideSpans(segment.rows, 'new', highlighter) }), [file, lines, open, highlighter])
  const choose = (side: 'L' | 'R', line: number, extend: boolean): void => {
    if (review === undefined || editing) return
    const from = extend && origin.current?.side === side ? origin.current.line : line
    const comment = selectReviewLines(file, side, from, line)
    if (comment === undefined) return
    if (!extend || origin.current?.side !== side) origin.current = { side, line }
    setSelection({ source: review.source, comment })
  }
  const selected = (side: 'L' | 'R', line: number | null): boolean => line !== null && selection !== null
    && selection.comment.side === side && line >= selection.comment.startLine && line <= selection.comment.endLine
  const number = (side: 'L' | 'R', line: number | null): ReactNode => {
    if (line === null || review === undefined || !file.hunks.some((hunk) => {
      const start = side === 'L' ? hunk.oldStart : hunk.newStart
      return line >= start && line < start + (side === 'L' ? hunk.oldLines : hunk.newLines)
    })) {
      return <span className={css.number}>{line ?? ''}</span>
    }
    return <span className={clsx(css.number, reviewCss.gutter)}>
      <button type="button" className={reviewCss.line}
        aria-label={t('review.selectLine', { line: `${side}${line}` })} aria-pressed={selected(side, line)}
        onPointerDown={(event) => {
          if (event.button !== 0 || editing) return
          event.preventDefault()
          window.getSelection()?.removeAllRanges()
          setNativeSide(null)
          dragging.current = 'gutter'
          setSelecting(true)
          choose(side, line, event.shiftKey)
        }}
        onPointerEnter={(event) => { if (dragging.current === 'gutter' && origin.current?.side === side && event.buttons === 1) choose(side, line, true) }}
        onClick={(event) => {
          if (event.detail !== 0) return
          window.getSelection()?.removeAllRanges()
          setNativeSide(null)
          choose(side, line, event.shiftKey)
        }}>{line}</button>
      {!selecting && !editing && selection?.comment.side === side && selection.comment.endLine === line && (
        <Tooltip label={t('review.addComment')} portal>
          <button type="button" className={reviewCss.add} aria-label={t('review.addComment')}
            onPointerDown={(event) => { event.preventDefault() }} onClick={() => { setEditing(true) }}>
            <IconPlusOutlineRegular size={14} />
          </button>
        </Tooltip>
      )}
    </span>
  }
  const cell = (value: SplitCell | null, spans: SideSpans, side: 'L' | 'R'): ReactNode => value === null
    ? <span className={clsx(css.cell, css.empty)} data-diff-side={side} />
    : <span className={clsx(css.cell, css[value.kind], selected(side, value.no) && (editing || nativeSide === null) && reviewCss.selected)}
      data-diff-side={side}>
      {number(side, value.no)}<Code text={value.text} spans={spans?.get(value.no)} old={side === 'L' ? value.no : null} next={side === 'R' ? value.no : null} />
    </span>
  const rows: ReactNode[] = []
  let inserted = false
  const editor = review === undefined || selection === null || !editing ? null : <ReviewComposer key="comment" selection={selection} visible={visible} split={columns}
    actions={review} close={() => {
      const native = window.getSelection()
      if (root.current?.contains(native?.anchorNode ?? null) === true) native?.removeAllRanges()
      setSelection(null)
      setEditing(false)
      setNativeSide(null)
      origin.current = null
    }} t={t} />
  const remaining = new Set(comments.threads)
  const appendComments = (old: number | null, next: number | null): void => {
    if (review === undefined) return
    for (const thread of remaining) {
      const comment = thread.selection.comment
      if ((comment.side === 'L' ? old : next) !== comment.endLine || !reviewMatches(thread.selection, review.source, file)) continue
      rows.push(<ReviewThread key={`record-${thread.key}`} thread={thread} actions={review} locked={comments.locked} outdated={false} split={columns} t={t} />)
      remaining.delete(thread)
    }
  }
  const endsAt = (old: number | null, next: number | null): boolean => selection !== null
    && (selection.comment.side === 'L' ? old : next) === selection.comment.endLine
  for (const [at, segment] of prepared.entries()) {
    if (segment.kind === 'gap') {
      rows.push(<button key={`gap-${segment.index}`} type="button" className={css.gap} disabled={text === 'loading'}
        data-forge-diff-gap={segment.index} onClick={() => { onExpand(segment.index) }}>
        <IconChevronsUpDownOutlineRegular size={12} />
        {segment.count === null ? t('diff.unchangedRest') : t('diff.unchanged', { count: segment.count.toLocaleString('en-US') })}
      </button>)
    } else if (columns) {
      for (const [index, pair] of splitRows(segment.rows).entries()) {
        rows.push(<div key={`${at}-${index}`} className={css.pair} data-diff-pair={pairKind(pair)}>
          {cell(pair.left, segment.old, 'L')}{cell(pair.right, segment.new, 'R')}
        </div>)
        if (!inserted && endsAt(pair.left?.no ?? null, pair.right?.no ?? null)) {
          rows.push(editor)
          inserted = true
        }
        appendComments(pair.left?.no ?? null, pair.right?.no ?? null)
      }
    } else {
      for (const [index, row] of segment.rows.entries()) {
        rows.push(<div key={`${at}-${index}`} className={clsx(css.line, css[row.kind], (selected('L', row.old) || selected('R', row.new)) && (editing || nativeSide === null) && reviewCss.selected)} data-diff-line={row.kind}>
          {singleSide !== 'R' && number('L', row.old)}{singleSide !== 'L' && number('R', row.new)}<span className={css.sign}>{SIGN[row.kind]}</span>
          <Code text={row.text} old={row.old} next={row.new} spans={row.kind === 'del' ? segment.old?.get(row.old) : segment.new?.get(row.new)} />
        </div>)
        if (!inserted && endsAt(row.old, row.new)) {
          rows.push(editor)
          inserted = true
        }
        appendComments(row.old, row.new)
      }
    }
  }
  if (review !== undefined) for (const thread of remaining) {
    rows.push(<ReviewThread key={`record-${thread.key}`} thread={thread} actions={review} locked={comments.locked} outdated split={false} t={t} />)
  }
  if (!inserted) rows.push(editor)
  return <div ref={root} className={css.code} style={style} data-single-side={singleSide ?? undefined} data-split={columns ? '' : undefined} data-wrap={wrap ? '' : undefined}
    data-native-side={nativeSide ?? undefined}
    onPointerDownCapture={(event) => {
      if (event.button !== 0 || !(event.target instanceof Node)) return
      const side = codeSideAt(event.currentTarget, event.target)
      if (side === undefined) return
      if (!event.shiftKey || nativeSide !== side) window.getSelection()?.removeAllRanges()
      if (!editing) dragging.current = 'text'
      // The chosen column must allow selection before the browser starts its native text range.
      flushSync(() => {
        setNativeSide(side)
        if (editing) return
        setSelection(null)
        setSelecting(true)
      })
    }}>{rows}</div>
}

function Body(props: DiffFileProps): ReactNode {
  const { file, large, revealed, onReveal, review, t } = props
  const comments = useFileReview(review, file.path)
  const records = review === undefined ? null : comments.threads.map(thread => <ReviewThread key={thread.key} thread={thread}
    actions={review} locked={comments.locked} outdated={!reviewMatches(thread.selection, review.source, file)} split={false} t={t} />)
  if (file.binary) return <><p className={css.fileNote}>{t('diff.binary')}</p>{records}</>
  if (file.oversized) return <><p className={css.fileNote}>{t('diff.fileTooLarge')}</p>{records}</>
  if (file.hunks.length === 0) return records
  if (large && !revealed) {
    // A large file starts as one collapsed strip, drawn and opened like the collapsed unchanged lines.
    return (
      <><button type="button" className={css.gap} onClick={onReveal}>
        <IconChevronsUpDownOutlineRegular size={12} />
        {t('diff.largeCollapsed', { count: (file.additions + file.deletions).toLocaleString('en-US') })}
      </button>{records}</>
    )
  }
  return <Lines {...props} comments={comments} />
}

/** File actions live only while their owning tab is visible. */
function FileMenu({ name, actions, t }: {
  readonly name: string
  readonly actions: readonly DiffFileAction[]
  readonly t: Translate
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <Menu
      open={menuOpen}
      portal
      align="end"
      dense
      autoFocus
      onClose={() => { setMenuOpen(false) }}
      anchor={(
        <button
          type="button"
          className={css.tool}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('diff.moreActions', { name })}
          onClick={() => { setMenuOpen(value => !value) }}
        >
          <IconEllipsisOutlineRegular />
        </button>
      )}
    >
      {actions.map(action => (
        <MenuItemButton
          key={action.label}
          onSelect={() => {
            setMenuOpen(false)
            action.run()
          }}
        >
          {t(action.label)}
        </MenuItemButton>
      ))}
    </Menu>
  )
}

/**
 * Render one file of a diff.
 * @param props - the file, its section and gap state, layout choices, menu actions, and copy.
 * @returns the file section.
 */
export function DiffFile(props: DiffFileProps): ReactNode {
  const { file, expanded, onToggle, badge, tooltip, actions, sectionRef, t } = props
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  return (
    <section ref={sectionRef} className={css.file} data-forge-diff-file={file.path} data-expanded={expanded ? '' : undefined}>
      <div className={css.fileHeader}>
        <button
          type="button"
          className={css.fileToggle}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'change.collapse' : 'change.expand', { name })}
          onClick={onToggle}
        >
          <IconChevronDownOutlineRegular size={14} className={css.chevron} />
        </button>
        <FileTypeIcon path={file.path} size={16} className={css.fileIcon} />
        <span className={css.filePath}>
          <FileLabel path={file.path} tooltip={tooltip} />
        </span>
        <span className={css.fileSpacer} data-forge-path-spacer="" />
        {badge !== '' && <span className={css.badge}>{badge}</span>}
        {!file.binary && <Counts file={file} t={t} />}
        {props.visible && <FileMenu name={name} actions={actions} t={t} />}
      </div>
      {expanded && <Body {...props} />}
    </section>
  )
}

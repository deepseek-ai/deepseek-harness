/**
 * One file of the changes view: a sticky header with the path, badges, line
 * counts, and file actions, then its hunks unified or side by side with the
 * unchanged lines between them collapsed into rows that expand them. A section
 * draws and highlights its lines once it comes within reach of the scrollport;
 * it redraws only when its own props change.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import { flushSync } from 'react-dom'
import {
  FileTypeIcon, IconChevronDownOutlineRegular, IconChevronsUpDownOutlineRegular, IconEllipsisOutlineRegular, IconPlusOutlineRegular,
  Tag, Tooltip,
  languageForPath, Menu, MenuItemButton, useCodeHighlighter, type CodeHighlighter, type HighlightSpan,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeDiffFile } from '../types.ts'
import { drawnLines, segmentsOf, splitRows, type DiffRow, type SplitCell, type SplitRow } from './diff-rows.ts'
import { codeSideAt, readCodeSelection } from './code-selection.ts'
import { reviewMatches, selectReviewLines, type ReviewSelection } from './review.ts'
import { ReviewThread, useFileReview } from './ReviewThread.tsx'
import { OutdatedThreads, ThreadCard, type FileThreads, type LineThread, type ThreadActions } from './ReviewThreads.tsx'
import { gapOf } from './review-threads.ts'
import type { FileReviewState } from './review-queue.ts'
import { ReviewComposer, type ReviewActions } from './ReviewComposer.tsx'
import reviewCss from './ReviewComposer.module.css'
import { FileLabel } from './FileLabel.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import type { ViewedState } from './viewed-files.ts'
import type { SectionReach } from './section-reach.ts'
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

/**
 * What every file section of one changes view calls. The view passes the same
 * object on every render, so a section redraws only when its own values change.
 */
export interface DiffFileHandlers {
  /** Expand or collapse a file. */
  readonly toggle: (file: ForgeDiffFile) => void
  /** Show a large file anyway. */
  readonly reveal: (path: string) => void
  /** Expand one gap of a file. */
  readonly expand: (file: ForgeDiffFile, index: number) => void
  /** Mark a file viewed, which also collapses it, or clear the mark. */
  readonly view: (file: ForgeDiffFile, viewed: boolean) => void
  /** Rows of a file's menu, read whenever the menu draws. */
  readonly actions: (file: ForgeDiffFile) => readonly DiffFileAction[]
  /** Receive a file's section element, which scrolling to the file targets, or null once it unmounts. */
  readonly section: (path: string, element: HTMLElement | null) => void
  /** Show a file's next unresolved host thread in display order after the last one shown, or its first. */
  readonly nextThread: (path: string) => void
  /** Tells each expanded section when it comes within reach of the scrollport, which draws its lines. */
  readonly reach: SectionReach
}

/** Props of one file section. */
export interface DiffFileProps {
  /** Whether the owning tab is visible and may show temporary menus. */
  readonly visible: boolean
  /** Comment destinations and the source being reviewed. */
  readonly review?: ReviewActions | undefined
  /** The file and its hunks. */
  readonly file: ForgeDiffFile
  /** Whether the section shows its lines. */
  readonly expanded: boolean
  /** Whether the file shows the large-file notice instead of its lines until revealed. */
  readonly large: boolean
  /** Whether the user revealed a large file. */
  readonly revealed: boolean
  /** The file's new side, which supplies collapsed unchanged lines. */
  readonly text: DiffFileText
  /** Indexes of the expanded gaps. */
  readonly open: ReadonlySet<number>
  /** Whether deletions and additions show in two columns; a file with only additions or only deletions keeps one. */
  readonly split: boolean
  /** Whether long lines wrap. */
  readonly wrap: boolean
  /** Badge text after the path, or empty for none. */
  readonly badge: string
  /** Hover text of the path: both paths of a renamed file, else the path. */
  readonly tooltip: string
  /** Whether the reader marked this change viewed, or marked an earlier change of the file. */
  readonly viewed: ViewedState
  /** Tooltip of the viewed mark: where marks are kept, or why the mark cannot change now. */
  readonly viewedNote: string
  /** Whether the mark cannot change now, while its write is in flight or the host's marks could not be read. */
  readonly viewedDisabled: boolean
  /** Review threads of the file from the code host, or undefined while none are read; the view keeps their identity. */
  readonly threads?: FileThreads | undefined
  /** Whether the section draws its lines at once, as the target of a thread jump, whose card must exist to be centered. */
  readonly drawNow?: boolean | undefined
  /** Actions shared by every section of the view. */
  readonly handlers: DiffFileHandlers
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
/** Whether two comments cover the same lines of the same side. */
function sameRange(a: ReviewSelection['comment'], b: ReviewSelection['comment']): boolean {
  return a.side === b.side && a.startLine === b.startLine && a.endLine === b.endLine
}

/** Whether a selection covers one line of a side. */
function covers(item: ReviewSelection, side: 'L' | 'R', line: number): boolean {
  return item.comment.side === side && line >= item.comment.startLine && line <= item.comment.endLine
}

/** The editor key of a range, such as `R3-4`. */
function rangeKey(item: ReviewSelection): string {
  return `${item.comment.side}${item.comment.startLine}-${item.comment.endLine}`
}

function pairKind(pair: SplitRow): 'context' | 'change' {
  return pair.left !== null && pair.left.kind === 'context' ? 'context' : 'change'
}

/** The hunks of one file with their collapsed and expanded unchanged lines. */
function Lines({ file, text, open, handlers, split, wrap, review, visible, comments, threads, t }: Pick<DiffFileProps,
  'file' | 'text' | 'open' | 'handlers' | 'split' | 'wrap' | 'review' | 'visible' | 'threads' | 't'> & { readonly comments: FileReviewState }): ReactNode {
  const lines = typeof text === 'object' ? text : undefined
  const columns = split && file.additions > 0 && file.deletions > 0
  const singleSide = file.status === 'added' ? 'R' : file.status === 'deleted' ? 'L' : null
  let maximum = Math.max(1, lines?.length ?? 0, (lines?.length ?? 0) + file.deletions - file.additions)
  for (const hunk of file.hunks) maximum = Math.max(maximum, hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1)
  const style: CSSProperties & { '--forge-number-width': string } = { '--forge-number-width': `calc(${Math.max(2, String(maximum).length)}ch + 12px)` }
  const highlighter = useCodeHighlighter(languageForPath(file.path))
  const [selection, setSelection] = useState<ReviewSelection | null>(null)
  // Mirrors `selection` for the release of a hover-plus drag, whose listener outlives the render that chose the range.
  const chosen = useRef<ReviewSelection | null>(null)
  const select = (next: ReviewSelection | null): void => {
    chosen.current = next
    setSelection(next)
  }
  // Comments being written, in the order they opened; each keeps the range it opened with while new ranges are chosen.
  const [editors, setEditors] = useState<readonly ReviewSelection[]>([])
  const root = useRef<HTMLDivElement>(null)
  const origin = useRef<{ side: 'L' | 'R'; line: number } | null>(null)
  // `add` is a gutter drag that began on a row's hover plus and opens the editor when the pointer is released.
  const dragging = useRef<'gutter' | 'add' | 'text' | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [nativeSide, setNativeSide] = useState<'L' | 'R' | null>(null)
  const nativeSelection = useCallback((): void => {
    if (nativeSide === null || root.current === null || review === undefined) return
    const selected = readCodeSelection(root.current, nativeSide)
    if (selected === undefined) {
      chosen.current = null
      setSelection(null)
      setNativeSide(null)
      return
    }
    const comment = selectReviewLines(file, selected.side, selected.from, selected.to)
    const previous = chosen.current
    const next = comment === undefined ? null
      : previous !== null && sameRange(previous.comment, comment) ? previous : { source: review.source, comment }
    chosen.current = next
    setSelection(next)
  }, [nativeSide, review, file])
  useEffect(() => {
    if (nativeSide === null) return
    const changed = (): void => { if (dragging.current === null) nativeSelection() }
    document.addEventListener('selectionchange', changed)
    return () => { document.removeEventListener('selectionchange', changed) }
  }, [nativeSide, nativeSelection])
  /** Open an editor for a range, or focus the one already open for it, and clear the selection for the next range. */
  const compose = (target: ReviewSelection): void => {
    const open = root.current?.querySelector<HTMLTextAreaElement>(`[data-forge-comment="${rangeKey(target)}"] textarea`) ?? null
    if (open !== null) open.focus()
    else setEditors(list => [...list, target])
    const native = window.getSelection()
    if (root.current?.contains(native?.anchorNode ?? null) === true) native?.removeAllRanges()
    select(null)
    setNativeSide(null)
    origin.current = null
  }
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
    const finish = (event: PointerEvent): void => {
      if (dragging.current === 'text') nativeSelection()
      const release = dragging.current === 'add' && event.type === 'pointerup' ? chosen.current : null
      dragging.current = null
      setSelecting(false)
      if (release !== null) compose(release)
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
  // Returns whether the range was accepted; a range across hunks or outside them keeps the previous selection.
  const choose = (side: 'L' | 'R', line: number, extend: boolean): boolean => {
    /* v8 ignore next -- the line buttons and hover pluses that choose a range draw only with review actions */
    if (review === undefined) return false
    const from = extend && origin.current?.side === side ? origin.current.line : line
    const comment = selectReviewLines(file, side, from, line)
    if (comment === undefined) return false
    if (!extend || origin.current?.side !== side) origin.current = { side, line }
    select({ source: review.source, comment })
    return true
  }
  // A drag that began on a hover plus extends through every row with a line on its starting side, wherever the pointer crosses that row.
  const extendAdd = (buttons: number, old: number | null, next: number | null): void => {
    const from = origin.current
    if (dragging.current !== 'add' || buttons !== 1 || from === null) return
    const line = from.side === 'L' ? old : next
    if (line !== null) choose(from.side, line, true)
  }
  const selected = (side: 'L' | 'R', line: number | null): boolean => line !== null && selection !== null && covers(selection, side, line)
  // The browser paints a native text range itself; a gutter range and every open editor's range take the highlight.
  const marked = (side: 'L' | 'R', line: number | null): boolean => line !== null
    && ((selected(side, line) && nativeSide === null) || editors.some(item => covers(item, side, line)))
  // `hover` adds the mouse shortcut: a plus shown while a hovering pointer is over this side of the row.
  const number = (side: 'L' | 'R', line: number | null, hover: boolean): ReactNode => {
    if (line === null || review === undefined || !file.hunks.some((hunk) => {
      const start = side === 'L' ? hunk.oldStart : hunk.newStart
      return line >= start && line < start + (side === 'L' ? hunk.oldLines : hunk.newLines)
    })) {
      return <span className={css.number}>{line ?? ''}</span>
    }
    const plus = !selecting && selection !== null && selection.comment.side === side && selection.comment.endLine === line
      ? selection : null
    return <span className={clsx(css.number, reviewCss.gutter)} data-review-side={side}
      onPointerEnter={(event) => { if (dragging.current === 'gutter' && origin.current?.side === side && event.buttons === 1) choose(side, line, true) }}>
      <button type="button" className={reviewCss.line}
        aria-label={t('review.selectLine', { line: `${side}${line}` })} aria-pressed={selected(side, line)}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          window.getSelection()?.removeAllRanges()
          setNativeSide(null)
          dragging.current = 'gutter'
          setSelecting(true)
          choose(side, line, event.shiftKey)
        }}
        onClick={(event) => {
          if (event.detail !== 0) return
          window.getSelection()?.removeAllRanges()
          setNativeSide(null)
          choose(side, line, event.shiftKey)
        }}>{line}</button>
      {plus !== null && (
        <Tooltip label={t('review.addComment')} portal>
          <button type="button" className={reviewCss.add} aria-label={t('review.addComment')}
            onPointerDown={(event) => { event.preventDefault() }} onClick={() => { compose(plus) }}>
            <IconPlusOutlineRegular size={14} />
          </button>
        </Tooltip>
      )}
      {/* Keyboard and assistive technology reach the same editor through the line button and the labeled plus above. */}
      {hover && plus === null && (
        <span className={reviewCss.hoverAdd} aria-hidden="true" data-review-add={`${side}${line}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            // A refused range keeps the previous selection, which the release must not open.
            if (!choose(side, line, event.shiftKey)) return
            window.getSelection()?.removeAllRanges()
            setNativeSide(null)
            dragging.current = 'add'
            setSelecting(true)
          }}>
          <IconPlusOutlineRegular size={14} />
        </span>
      )}
    </span>
  }
  const cell = (value: SplitCell | null, spans: SideSpans, side: 'L' | 'R'): ReactNode => value === null
    ? <span className={clsx(css.cell, css.empty)} data-diff-side={side} />
    : <span className={clsx(css.cell, css[value.kind], marked(side, value.no) && reviewCss.selected)}
      data-diff-side={side}>
      {number(side, value.no, true)}<Code text={value.text} spans={spans?.get(value.no)} old={side === 'L' ? value.no : null} next={side === 'R' ? value.no : null} />
    </span>
  const endsAt = (old: number | null, next: number | null): boolean => selection !== null
    && (selection.comment.side === 'L' ? old : next) === selection.comment.endLine
  const rows: ReactNode[] = []
  const unplacedEditors = new Set(editors)
  const remaining = new Set(comments.threads)
  // A host thread follows the row of its last line, or the collapsed unchanged lines that hold it.
  const unplaced = new Set(threads === undefined ? [] : threads.lines.map(item => ({ ...item, actions: threads.actions })))
  const threadCard = (item: LineThread & { readonly actions: ThreadActions }): ReactNode =>
    <ThreadCard key={`thread-${item.thread.id}`} thread={item.thread} place={item.place} actions={item.actions} t={t} />
  // The editors, the saved comments, then the host threads whose ranges end on this side's line.
  const commentsAt = (side: 'L' | 'R', line: number | null): ReactNode[] => {
    const nodes: ReactNode[] = []
    if (line === null) return nodes
    if (review !== undefined) {
      for (const item of unplacedEditors) {
        if (item.comment.side !== side || item.comment.endLine !== line) continue
        nodes.push(editorOf(item, review))
        unplacedEditors.delete(item)
      }
      for (const thread of remaining) {
        const comment = thread.selection.comment
        if (comment.side !== side || comment.endLine !== line || !reviewMatches(thread.selection, review.source, file)) continue
        nodes.push(<ReviewThread key={`record-${thread.key}`} thread={thread} actions={review} locked={comments.locked} outdated={false} t={t} />)
        remaining.delete(thread)
      }
    }
    for (const item of unplaced) {
      if (item.place.side !== side || item.place.endLine !== line) continue
      nodes.push(threadCard(item))
      unplaced.delete(item)
    }
    return nodes
  }
  const editorOf = (item: ReviewSelection, actions: ReviewActions): ReactNode =>
    <ReviewComposer key={`comment-${rangeKey(item)}`} selection={item} visible={visible} actions={actions}
      close={() => { setEditors(list => list.filter(open => !sameRange(open.comment, item.comment))) }} t={t} />
  // Side by side, a row's comments sit in a row of two cells under its columns, each continuing its line's background.
  const notes = (key: string, pair: SplitRow): void => {
    const left = commentsAt('L', pair.left?.no ?? null)
    const right = commentsAt('R', pair.right?.no ?? null)
    if (left.length === 0 && right.length === 0) return
    const side = (value: SplitCell | null, nodes: ReactNode[]): ReactNode => (
      <div className={clsx(css.noteCell, css[value?.kind ?? 'empty'])}>
        <span className={css.number} />
        <div className={css.noteStack} data-forge-comments="">{nodes}</div>
      </div>
    )
    rows.push(<div key={key} className={css.notes} data-forge-notes="">{side(pair.left, left)}{side(pair.right, right)}</div>)
  }
  for (const [at, segment] of prepared.entries()) {
    if (segment.kind === 'gap') {
      rows.push(<button key={`gap-${segment.index}`} type="button" className={css.gap} disabled={text === 'loading'}
        data-forge-diff-gap={segment.index} onClick={() => { handlers.expand(file, segment.index) }}>
        <IconChevronsUpDownOutlineRegular size={12} />
        {segment.count === null ? t('diff.unchangedRest') : t('diff.unchanged', { count: segment.count.toLocaleString('en-US') })}
      </button>)
      for (const item of unplaced) {
        if (gapOf(file, item.place.side, item.place.endLine) !== segment.index) continue
        rows.push(threadCard(item))
        unplaced.delete(item)
      }
    } else if (columns) {
      for (const [index, pair] of splitRows(segment.rows).entries()) {
        rows.push(<div key={`${at}-${index}`} className={css.pair} data-diff-pair={pairKind(pair)}
          onPointerEnter={(event) => { extendAdd(event.buttons, pair.left?.no ?? null, pair.right?.no ?? null) }}>
          {cell(pair.left, segment.old, 'L')}{cell(pair.right, segment.new, 'R')}
        </div>)
        notes(`notes-${at}-${index}`, pair)
      }
    } else {
      for (const [index, row] of segment.rows.entries()) {
        // Both numbers place their plus in the sign column, so a row showing the labeled plus offers no hover plus.
        const labeled = !selecting && endsAt(row.old, row.new)
        rows.push(<div key={`${at}-${index}`} className={clsx(css.line, css[row.kind], (marked('L', row.old) || marked('R', row.new)) && reviewCss.selected)} data-diff-line={row.kind}
          onPointerEnter={(event) => { extendAdd(event.buttons, row.old, row.new) }}>
          {singleSide !== 'R' && number('L', row.old, row.kind === 'del' && !labeled)}{singleSide !== 'L' && number('R', row.new, row.kind !== 'del' && !labeled)}<span className={css.sign}>{SIGN[row.kind]}</span>
          <Code text={row.text} old={row.old} next={row.new} spans={row.kind === 'del' ? segment.old?.get(row.old) : segment.new?.get(row.new)} />
        </div>)
        rows.push(...commentsAt('L', row.old), ...commentsAt('R', row.new))
      }
    }
  }
  if (review !== undefined) {
    // An editor whose last line no longer draws, after a refresh or a narrower choice of commits, follows the lines.
    for (const item of unplacedEditors) rows.push(editorOf(item, review))
    for (const thread of remaining) {
      rows.push(<ReviewThread key={`record-${thread.key}`} thread={thread} actions={review} locked={comments.locked} outdated t={t} />)
    }
  }
  for (const item of unplaced) rows.push(threadCard(item))
  return <div ref={root} className={css.code} style={style} data-single-side={singleSide ?? undefined} data-split={columns ? '' : undefined} data-wrap={wrap ? '' : undefined}
    data-review={review === undefined ? undefined : ''}
    data-native-side={nativeSide ?? undefined}
    onPointerDownCapture={(event) => {
      if (event.button !== 0 || !(event.target instanceof Node)) return
      const side = codeSideAt(event.currentTarget, event.target)
      if (side === undefined) return
      if (!event.shiftKey || nativeSide !== side) window.getSelection()?.removeAllRanges()
      dragging.current = 'text'
      // The chosen column must allow selection before the browser starts its native text range.
      flushSync(() => {
        setNativeSide(side)
        select(null)
        setSelecting(true)
      })
    }}>{rows}</div>
}

/** Whether a file's body draws its hunks line by line rather than a note or a collapsed strip. */
function drawsLines(file: ForgeDiffFile, large: boolean, revealed: boolean): boolean {
  return !file.binary && !file.oversized && file.hunks.length > 0 && (!large || revealed)
}

/** The file's lines or the note that replaces them, with its saved comments; host threads on lines follow when no lines show. */
function Content(props: DiffFileProps): ReactNode {
  const { file, large, revealed, handlers, review, threads, t } = props
  const comments = useFileReview(review, file.path)
  const records = review === undefined ? null : comments.threads.map(thread => <ReviewThread key={thread.key} thread={thread}
    actions={review} locked={comments.locked} outdated={!reviewMatches(thread.selection, review.source, file)} t={t} />)
  const lineThreads = threads?.lines.map(item => <ThreadCard key={item.thread.id} thread={item.thread} place={item.place}
    actions={threads.actions} t={t} />)
  if (file.binary) return <><p className={css.fileNote}>{t('diff.binary')}</p>{records}{lineThreads}</>
  if (file.oversized) return <><p className={css.fileNote}>{t('diff.fileTooLarge')}</p>{records}{lineThreads}</>
  if (file.hunks.length === 0) return <>{records}{lineThreads}</>
  if (large && !revealed) {
    // A large file starts as one collapsed strip, drawn and opened like the collapsed unchanged lines.
    return (
      <><button type="button" className={css.gap} onClick={() => { handlers.reveal(file.path) }}>
        <IconChevronsUpDownOutlineRegular size={12} />
        {t('diff.largeCollapsed', { count: (file.additions + file.deletions).toLocaleString('en-US') })}
      </button>{records}{lineThreads}</>
    )
  }
  return <Lines {...props} comments={comments} />
}

/** Host threads on the whole file, the lines, then the host threads that later commits made outdated. */
function Body(props: DiffFileProps): ReactNode {
  const { threads, t } = props
  return <>
    {threads?.file.map(thread => <ThreadCard key={thread.id} thread={thread} place={{ kind: 'file' }} actions={threads.actions} t={t} />)}
    <Content {...props} />
    {threads !== undefined && <OutdatedThreads threads={threads.outdated} actions={threads.actions} t={t} />}
  </>
}

/** File actions live only while their owning tab is visible. */
function FileMenu({ name, file, handlers, t }: {
  readonly name: string
  readonly file: ForgeDiffFile
  readonly handlers: DiffFileHandlers
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
      {handlers.actions(file).map(action => (
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
 * Render one file of a diff. Until the section first comes within reach of the scrollport or a thread jump targets it,
 * an expanded file that draws lines shows a box of about their height instead.
 * @param props - the file, its section and gap state, layout choices, shared actions, and copy.
 * @returns the file section.
 */
function DiffFileSection(props: DiffFileProps): ReactNode {
  const { file, expanded, large, revealed, badge, tooltip, viewed, viewedNote, viewedDisabled, threads, handlers, t } = props
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  const element = useRef<HTMLElement | null>(null)
  const [reached, setReached] = useState(false)
  // A thread jump draws the section for good, so it does not fall back to the box once the jump ends.
  if (props.drawNow === true && !reached) setReached(true)
  const waiting = expanded && !reached && props.drawNow !== true && drawsLines(file, large, revealed)
  useEffect(() => {
    /* v8 ignore next -- React attaches the section before it runs effects */
    if (!waiting || element.current === null) return
    return handlers.reach.observe(element.current, () => { setReached(true) })
  }, [waiting, handlers.reach])
  const sectionRef = useCallback((node: HTMLElement | null) => {
    element.current = node
    handlers.section(file.path, node)
  }, [handlers, file.path])
  const placeholder: CSSProperties & { '--forge-rows': number } = { '--forge-rows': drawnLines(file) }
  return (
    <section ref={sectionRef} className={css.file} data-forge-diff-file={file.path} data-expanded={expanded ? '' : undefined}
      data-viewed={viewed}>
      <div className={css.fileHeader}>
        <button
          type="button"
          className={css.fileToggle}
          aria-expanded={expanded}
          aria-label={t(expanded ? 'change.collapse' : 'change.expand', { name })}
          onClick={() => { handlers.toggle(file) }}
        >
          <IconChevronDownOutlineRegular size={14} className={css.chevron} />
        </button>
        <span className={css.fileTitle}>
          <FileTypeIcon path={file.path} size={16} className={css.fileIcon} />
          <span className={css.filePath}>
            <FileLabel path={file.path} tooltip={tooltip} />
          </span>
          {viewed === 'changed' && (
            <Tag tone="warning" className={css.changedTag}><span className={css.changedText}>{t('viewed.changed')}</span></Tag>
          )}
          {threads !== undefined && threads.unresolved > 0 && (
            <Tooltip label={t('thread.next')} side="bottom">
              <button type="button" className={css.threadCount} aria-label={t('thread.unresolvedAria', { name, count: threads.unresolved })}
                onClick={() => { handlers.nextThread(file.path) }}>
                <span className={css.threadCountText}>{t('thread.unresolvedCount', { count: threads.unresolved })}</span>
                <span className={css.threadCountNumber}>{threads.unresolved}</span>
              </button>
            </Tooltip>
          )}
          <span className={css.fileSpacer} data-forge-path-spacer="" />
          {badge !== '' && <span className={css.badge}>{badge}</span>}
        </span>
        {!file.binary && <Counts file={file} t={t} />}
        <label className={css.viewed} title={viewedNote} data-disabled={viewedDisabled ? '' : undefined}>
          <input type="checkbox" checked={viewed === 'viewed'} aria-label={t('viewed.aria', { name })} disabled={viewedDisabled}
            onChange={(event) => { handlers.view(file, event.target.checked) }} />
          <span className={css.viewedLabel} aria-hidden="true">{t('viewed.label')}</span>
        </label>
        {props.visible && <FileMenu name={name} file={file} handlers={handlers} t={t} />}
      </div>
      {expanded && (waiting ? <div className={css.unreached} style={placeholder} data-forge-diff-unreached="" /> : <Body {...props} />)}
    </section>
  )
}

/** One file of a diff, redrawn only when its props change. */
export const DiffFile = memo(DiffFileSection)

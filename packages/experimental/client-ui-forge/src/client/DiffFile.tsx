/**
 * One file of the changes view: a sticky header with the path, badges, line
 * counts, and file actions, then its hunks unified or side by side with the
 * unchanged lines between them collapsed into rows that expand them.
 */

import { useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  FileTypeIcon, IconChevronDownOutlineRegular, IconChevronsUpDownOutlineRegular, IconEllipsisOutlineRegular,
  languageForPath, Menu, MenuItemButton, useCodeHighlighter, type CodeHighlighter, type HighlightSpan,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeDiffFile } from '../types.ts'
import { segmentsOf, splitRows, type DiffRow, type SplitCell, type SplitRow } from './diff-rows.ts'
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
  /** Copy the repository-relative path from the file header. */
  readonly onCopyPath: () => void
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

function Code({ text, spans }: { readonly text: string; readonly spans: readonly HighlightSpan[] | undefined }): ReactNode {
  return (
    <span className={css.text} data-diff-code={spans === undefined ? undefined : ''}>
      {spans === undefined ? text : spans.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)}
    </span>
  )
}

function Cell({ cell, spans }: { readonly cell: SplitCell | null; readonly spans: SideSpans }): ReactNode {
  if (cell === null) return <span className={clsx(css.cell, css.empty)} />
  return (
    <span className={clsx(css.cell, css[cell.kind])}>
      <span className={css.number}>{cell.no}</span>
      <Code text={cell.text} spans={spans?.get(cell.no)} />
    </span>
  )
}

/** Whether a side-by-side row repeats an unchanged line or shows a change. */
function pairKind(pair: SplitRow): 'context' | 'change' {
  return pair.left !== null && pair.left.kind === 'context' ? 'context' : 'change'
}

/** The hunks of one file with their collapsed and expanded unchanged lines. */
function Lines({ file, text, open, onExpand, split, wrap, t }: Pick<DiffFileProps, 'file' | 'text' | 'open' | 'onExpand' | 'split' | 'wrap' | 't'>): ReactNode {
  const lines = typeof text === 'object' ? text : undefined
  const columns = split && file.additions > 0 && file.deletions > 0
  const highlighter = useCodeHighlighter(languageForPath(file.path))
  const prepared = useMemo(() => segmentsOf(file, lines, open).map((segment): Prepared => segment.kind === 'gap'
    ? segment
    : { ...segment, old: sideSpans(segment.rows, 'old', highlighter), new: sideSpans(segment.rows, 'new', highlighter) }), [file, lines, open, highlighter])
  return (
    <div className={css.code} data-split={columns ? '' : undefined} data-wrap={wrap ? '' : undefined}>
      {prepared.map((segment, at) => {
        if (segment.kind === 'gap') {
          return (
            <button
              key={`gap-${segment.index}`}
              type="button"
              className={css.gap}
              disabled={text === 'loading'}
              data-forge-diff-gap={segment.index}
              onClick={() => { onExpand(segment.index) }}
            >
              <IconChevronsUpDownOutlineRegular size={12} />
              {segment.count === null ? t('diff.unchangedRest') : t('diff.unchanged', { count: segment.count.toLocaleString('en-US') })}
            </button>
          )
        }
        if (columns) {
          return splitRows(segment.rows).map((pair, index) => (
            <div key={`${at}-${index}`} className={css.pair} data-diff-pair={pairKind(pair)}>
              <Cell cell={pair.left} spans={segment.old} />
              <Cell cell={pair.right} spans={segment.new} />
            </div>
          ))
        }
        return segment.rows.map((row, index) => (
          <div key={`${at}-${index}`} className={clsx(css.line, css[row.kind])} data-diff-line={row.kind}>
            <span className={css.number}>{row.old ?? ''}</span>
            <span className={css.number}>{row.new ?? ''}</span>
            <span className={css.sign}>{SIGN[row.kind]}</span>
            <Code text={row.text} spans={row.kind === 'del' ? segment.old?.get(row.old) : segment.new?.get(row.new)} />
          </div>
        ))
      })}
    </div>
  )
}

function Body(props: DiffFileProps): ReactNode {
  const { file, large, revealed, onReveal, t } = props
  if (file.binary) return <p className={css.fileNote}>{t('diff.binary')}</p>
  if (file.oversized) return <p className={css.fileNote}>{t('diff.fileTooLarge')}</p>
  if (file.hunks.length === 0) return null
  if (large && !revealed) {
    // A large file starts as one collapsed strip, drawn and opened like the collapsed unchanged lines.
    return (
      <button type="button" className={css.gap} onClick={onReveal}>
        <IconChevronsUpDownOutlineRegular size={12} />
        {t('diff.largeCollapsed', { count: (file.additions + file.deletions).toLocaleString('en-US') })}
      </button>
    )
  }
  return <Lines {...props} />
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
  const { file, expanded, onToggle, badge, tooltip, actions, onCopyPath, sectionRef, t } = props
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
        <button type="button" className={css.filePath} aria-label={`${t('diff.copyPath')}: ${file.path}`} onClick={onCopyPath}>
          <FileLabel path={file.path} tooltip={tooltip} />
        </button>
        <span className={css.fileSpacer} data-forge-path-spacer="" />
        {badge !== '' && <span className={css.badge}>{badge}</span>}
        {!file.binary && <Counts file={file} t={t} />}
        {props.visible && <FileMenu name={name} actions={actions} t={t} />}
      </div>
      {expanded && <Body {...props} />}
    </section>
  )
}

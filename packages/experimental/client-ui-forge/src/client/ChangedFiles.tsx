/** Changed-file navigation shared by the toolbar menu and wide diff pane, with a disclosure column on every row. */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  FileTypeIcon, IconChevronDownOutlineRegular, IconFolderCloseRegular, Input, MarqueeText, Menu, Tooltip, useHoverMarquee,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeDiffFile } from '../types.ts'
import { Counts } from './DiffFile.tsx'
import { changedFileTree, filesInTreeOrder, filterFileTree, viewedNodes, type ChangedFileNode } from './file-tree.ts'
import type { NS } from './locales.ts'
import css from './ChangedFiles.module.css'

/** Viewing choices remain owned by the changes tab while either navigation surface is hidden. */
export interface ChangedFilesState {
  readonly query: string
  readonly collapsed: Readonly<Record<string, boolean>>
  readonly selected: string | null
}

/** Data and actions of the changed-file navigator. */
export interface ChangedFilesProps extends PropsLocale<typeof NS> {
  readonly files: readonly ForgeDiffFile[]
  readonly state: ChangedFilesState
  readonly filter: (query: string) => void
  readonly toggle: (path: string) => void
  readonly jump: (path: string) => void
  /** A menu row participates in the shared menu's keyboard walk. */
  readonly menu?: boolean
  /** Unresolved host review threads by file path; files without any are absent. */
  readonly threadCounts?: ReadonlyMap<string, number>
  /** Paths of the files marked viewed at their current change, which draw subdued with any directory they fill. */
  readonly viewed?: ReadonlySet<string>
}

const NONE_VIEWED: ReadonlySet<string> = new Set()

function Rows({ nodes, depth, done, props }: {
  readonly nodes: readonly ChangedFileNode[]
  readonly depth: number
  /** Paths of the viewed files and of the directories whose files are all viewed. */
  readonly done: ReadonlySet<string>
  readonly props: ChangedFilesProps
}): ReactNode {
  return nodes.map(node => <Row key={node.path} node={node} depth={depth} done={done} props={props} />)
}

/**
 * One file or directory of the tree. The tree already shows each row's directory, so only a renamed file
 * names its paths in a tooltip; a name the row clips crawls into view while the pointer rests on the row.
 */
function Row({ node, depth, done, props }: {
  readonly node: ChangedFileNode
  readonly depth: number
  /** Paths of the viewed files and of the directories whose files are all viewed. */
  readonly done: ReadonlySet<string>
  readonly props: ChangedFilesProps
}): ReactNode {
  const { state, toggle, jump, menu, threadCounts, t } = props
  const nameRef = useRef<HTMLSpanElement>(null)
  const marquee = useHoverMarquee(nameRef)
  const directory = node.kind === 'directory'
  const expanded = directory && (state.query.trim() !== '' || state.collapsed[node.path] !== true)
  const threads = node.kind === 'file' ? threadCounts?.get(node.path) ?? 0 : 0
  const renamed = node.kind === 'file' && node.file.previousPath !== null
    ? t('diff.renamedPath', { from: node.file.previousPath, path: node.path }) : null
  const viewed = done.has(node.path)
  const button = (
    <button type="button" role={menu ? 'menuitem' : undefined}
      className={clsx(css.row, !directory && state.selected === node.path && css.selected, viewed && css.viewed)}
      style={{ paddingInlineStart: `${8 + depth * 14}px` }} aria-label={renamed ?? node.path} aria-expanded={directory ? expanded : undefined}
      aria-description={viewed ? t(directory ? 'viewed.directory' : 'viewed.label') : undefined} data-viewed={viewed ? '' : undefined}
      aria-current={!directory && state.selected === node.path ? 'true' : undefined}
      {...marquee}
      onKeyDown={(event) => {
        if (!directory || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault()
        if ((event.key === 'ArrowRight') !== expanded) toggle(node.path)
      }}
      onClick={(event) => { if (directory) { event.stopPropagation(); toggle(node.path) } else jump(node.path) }}>
      <span className={css.chevron} aria-hidden="true">
        {directory && <IconChevronDownOutlineRegular size={12} className={clsx(!expanded && css.collapsed)} />}
      </span>
      {directory ? <IconFolderCloseRegular size={14} /> : <FileTypeIcon path={node.path} size={14} />}
      <MarqueeText ref={nameRef} className={css.name} data-forge-tree-name="">{node.name}</MarqueeText>
      {threads > 0 && (
        <Tooltip label={t('thread.treeCount', { count: threads })} portal side="bottom" delayMs={500}>
          <span className={css.threads}>{threads}</span>
        </Tooltip>
      )}
      {node.kind === 'file' && <Counts file={node.file} t={t} />}
    </button>
  )
  return <div>
    {renamed === null ? button : <Tooltip label={renamed} portal side="left" delayMs={500}>{button}</Tooltip>}
    {node.kind === 'directory' && expanded && <Rows nodes={node.children} depth={depth + 1} done={done} props={props} />}
  </div>
}

/**
 * Scroll only the row container to show a row that is not wholly visible; a visible row stays where it is.
 * `scrollIntoView` would also scroll every scrollable ancestor, moving the menu card or the page behind it, and
 * its `container` option is not yet supported widely enough, so the offset is measured here.
 * @param container - the scrolling rows.
 * @param row - the row to show.
 * @param align - `center` places the row mid-view with its neighbors; `nearest` scrolls by the least distance.
 */
function revealRow(container: HTMLElement, row: HTMLElement, align: 'center' | 'nearest'): void {
  const top = container.getBoundingClientRect().top + container.clientTop
  const bottom = top + container.clientHeight
  const box = row.getBoundingClientRect()
  if (box.top >= top && box.bottom <= bottom) return
  if (align === 'center') container.scrollTop += (box.top + box.bottom - top - bottom) / 2
  else container.scrollTop += box.top < top ? box.top - top : box.bottom - bottom
}

/**
 * Render searchable directory navigation without reading file contents.
 * @param props - changed files, per-tab choices, navigation actions, and localized copy.
 * @returns the search field and matching branches.
 */
export function ChangedFiles(props: ChangedFilesProps): ReactNode {
  const tree = useMemo(() => changedFileTree(props.files), [props.files])
  const nodes = useMemo(() => filterFileTree(tree, props.state.query), [tree, props.state.query])
  const order = useMemo(() => filesInTreeOrder(tree), [tree])
  const done = useMemo(() => viewedNodes(tree, props.viewed ?? NONE_VIEWED), [tree, props.viewed])
  const selectedIndex = order.findIndex(file => file.path === props.state.selected)
  const rows = useRef<HTMLDivElement>(null)
  const query = useRef(props.state.query)
  // A changed filter shows its results from the top.
  useLayoutEffect(() => {
    if (query.current === props.state.query) return
    query.current = props.state.query
    const container = rows.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (container === null) return
    container.scrollTop = 0
  }, [props.state.query])
  const mounted = useRef(false)
  // The toolbar menu mounts these rows at the top on every opening, so mounting centers the selected file. Later, a
  // file step in the diff, or files arriving or reordering around a selection, scrolls by the least distance; a
  // refresh that keeps the selected file's position leaves the reader's scroll alone.
  useLayoutEffect(() => {
    const align = mounted.current ? 'nearest' : 'center'
    mounted.current = true
    const container = rows.current
    const row = container?.querySelector<HTMLElement>('[aria-current="true"]')
    if (container == null || row == null) return
    revealRow(container, row, align)
  }, [props.state.selected, selectedIndex])
  return <div className={css.root} data-forge-file-tree="">
    <div className={css.search}><Input className={clsx(css.searchInput)} aria-label={props.t('diff.filterFiles')} placeholder={props.t('diff.filterFiles')}
      value={props.state.query} onChange={(event) => { props.filter(event.target.value) }}
      onKeyDown={(event) => { if (['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation() }} /></div>
    <div ref={rows} className={css.rows}>
      {nodes.length === 0 ? <div className={css.empty}>{props.t('diff.noMatchingFiles')}</div> : <Rows nodes={nodes} depth={0} done={done} props={props} />}
    </div>
  </div>
}

/**
 * Open directory navigation through the existing files toolbar entry.
 * @param props - navigator data, whether its owning tab is visible, and whether the files are still being read, when
 * the entry names no count.
 * @returns the toolbar entry and its portalled menu.
 */
export function ChangedFilesMenu({ visible, loading = false, ...props }: ChangedFilesProps & {
  readonly visible: boolean
  readonly loading?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={visible && open} portal dense align="start" className={css.anchor} listClassName={css.menu} onClose={() => { setOpen(false) }}
    anchor={<button type="button" className={css.trigger} aria-haspopup="menu" aria-expanded={visible && open} disabled={props.files.length === 0}
      onClick={() => { setOpen(value => !value) }}>
      <span className={css.triggerLabel}>{loading ? props.t('diff.allFilesLoading') : props.t('diff.allFiles', { count: props.files.length })}</span>
      <IconChevronDownOutlineRegular size={12} className={css.triggerChevron} />
    </button>}>
    <ChangedFiles {...props} menu jump={(path) => { setOpen(false); props.jump(path) }} />
  </Menu>
}

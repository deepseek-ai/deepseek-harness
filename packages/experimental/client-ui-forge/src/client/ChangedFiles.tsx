/** Changed-file navigation shared by the toolbar menu and wide diff pane, with a disclosure column on every row. */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { FileTypeIcon, IconChevronDownOutlineRegular, IconFolderCloseRegular, Input, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeDiffFile } from '../types.ts'
import { Counts } from './DiffFile.tsx'
import { changedFileTree, filesInTreeOrder, filterFileTree, type ChangedFileNode } from './file-tree.ts'
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
}

function Rows({ nodes, depth, props }: {
  readonly nodes: readonly ChangedFileNode[]
  readonly depth: number
  readonly props: ChangedFilesProps
}): ReactNode {
  const { state, toggle, jump, menu, t } = props
  return nodes.map((node) => {
    const directory = node.kind === 'directory'
    const expanded = directory && (state.query.trim() !== '' || state.collapsed[node.path] !== true)
    const label = node.kind === 'file' && node.file.previousPath !== null
      ? t('diff.renamedPath', { from: node.file.previousPath, path: node.path }) : node.path
    return <div key={node.path}>
      <Tooltip label={label} portal side="left">
        <button type="button" role={menu ? 'menuitem' : undefined} className={clsx(css.row, !directory && state.selected === node.path && css.selected)}
          style={{ paddingInlineStart: `${8 + depth * 14}px` }} aria-label={label} aria-expanded={directory ? expanded : undefined}
          aria-current={!directory && state.selected === node.path ? 'true' : undefined}
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
          <span className={css.name}>{node.name}</span>
          {node.kind === 'file' && <Counts file={node.file} t={t} />}
        </button>
      </Tooltip>
      {node.kind === 'directory' && expanded && <Rows nodes={node.children} depth={depth + 1} props={props} />}
    </div>
  })
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
      {nodes.length === 0 ? <div className={css.empty}>{props.t('diff.noMatchingFiles')}</div> : <Rows nodes={nodes} depth={0} props={props} />}
    </div>
  </div>
}

/**
 * Open directory navigation through the existing files toolbar entry.
 * @param props - navigator data and whether its owning tab is visible.
 * @returns the toolbar entry and its portalled menu.
 */
export function ChangedFilesMenu({ visible, ...props }: ChangedFilesProps & { readonly visible: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={visible && open} portal dense align="start" listClassName={css.menu} onClose={() => { setOpen(false) }}
    anchor={<button type="button" className={css.trigger} aria-haspopup="menu" aria-expanded={visible && open} disabled={props.files.length === 0}
      onClick={() => { setOpen(value => !value) }}>{props.t('diff.allFiles', { count: props.files.length })}<IconChevronDownOutlineRegular size={12} /></button>}>
    <ChangedFiles {...props} menu jump={(path) => { setOpen(false); props.jump(path) }} />
  </Menu>
}

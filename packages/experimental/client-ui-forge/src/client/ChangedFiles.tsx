/** Changed-file navigation shared by the toolbar menu and wide diff pane, with a disclosure column on every row. */
import { useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { FileTypeIcon, IconChevronDownOutlineRegular, IconFolderCloseRegular, Input, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeDiffFile } from '../types.ts'
import { Counts } from './DiffFile.tsx'
import { changedFileTree, filterFileTree, type ChangedFileNode } from './file-tree.ts'
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
 * Render searchable directory navigation without reading file contents.
 * @param props - changed files, per-tab choices, navigation actions, and localized copy.
 * @returns the search field and matching branches.
 */
export function ChangedFiles(props: ChangedFilesProps): ReactNode {
  const tree = useMemo(() => changedFileTree(props.files), [props.files])
  const nodes = useMemo(() => filterFileTree(tree, props.state.query), [tree, props.state.query])
  return <div className={css.root} data-forge-file-tree="">
    <div className={css.search}><Input className={clsx(css.searchInput)} aria-label={props.t('diff.filterFiles')} placeholder={props.t('diff.filterFiles')}
      value={props.state.query} onChange={(event) => { props.filter(event.target.value) }}
      onKeyDown={(event) => { if (['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation() }} /></div>
    <div className={css.rows}>
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

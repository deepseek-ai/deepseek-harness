/**
 * Workspace browser tree row components (figma Cell set 14:3080): pure presentational —
 * all data and callbacks arrive via props. Hover swaps (folder->chevron,
 * time->ellipsis, action buttons) are CSS-only, and a session row's clipped
 * title marquees programmatically while the row is hovered. Workspace row
 * menus are visual-only except Rename/Delete. A Session row's "..." menu and
 * its hover buttons are the `sidebar.workspaces.session.menu.item` and
 * `sidebar.workspaces.session.row.action` lists, rendered through the
 * browser's `renderSlot` with the menu's open state as the occurrence's hook
 * context; this package's own actions are entries like any plugin's. The
 * session and workspace hover cards are suppressed while a menu is open.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import clsx from 'clsx'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import {
  HoverCard, IconArchiveOutlineRegular, IconEditOutlineRegular,
  IconEllipsisOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular,
  IconNewChatOutlineRegular, IconPinFillRegular, IconTrashOutlineRegular,
  IconTriangleRightFillRegular, IconUnarchiveOutlineRegular, Menu, relativeTime, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { abbreviateHomePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { MenuOpenState, WorkspaceBrowserProps } from '../contract/slots.ts'
import type { GroupNode, SearchResultNode, SessionNode } from '../tree.ts'
import css from './Rows.module.css'

/** The standard locale seat, prop-passed from the browser root. */
type RowTranslate = WorkspaceBrowserProps['t']

/**
 * Child-seat renderer threaded from the browser root: the row's action lists,
 * its leading decoration, and its hover-card section. The leading seat is
 * rendered only while the row's primary state is idle, so a status dot and a
 * leading occupant never share the row; the hover seat only while the row's
 * card is open.
 */
type RowRenderSlots = PropsRenderSlots<
  | 'sidebar.workspaces.session.menu.item'
  | 'sidebar.workspaces.session.row.action'
  | 'sidebar.session.row.leading'
  | 'sidebar.session.row.hover'
>['renderSlot']

/** Row display title: blank rows show the localized New Session label. */
function displayTitle(node: SessionNode, t: RowTranslate): string {
  return node.blank ? t('session.new') : (node.title || t('session.untitled'))
}

/* Overflow this small hides no meaningful tail; scrolling for it reads as an
   accidental jitter, so the title stays put. */
const MIN_TITLE_REVEAL_PX = 8

/* Marquee travel speed: slow enough to read the text as it passes. */
const TITLE_MARQUEE_PX_PER_MS = 0.03

/**
 * Place the title's scroll position and publish the stylesheet's fade-mask
 * hooks: `data-scrolled` while the title has left its start (left fade) and
 * `data-clipped` while text remains beyond the right edge (right fade).
 * @param title - the row's clipping title element.
 * @param left - scroll offset in CSS pixels.
 * @param range - the title's maximum scroll offset in CSS pixels.
 */
function placeTitle(title: HTMLSpanElement, left: number, range: number): void {
  // jsdom implements no scrollTo; the lane's direct assignment is instant there
  // anyway, so both paths land on the same position.
  if (typeof title.scrollTo === 'function') title.scrollTo({ left, behavior: 'instant' })
  else title.scrollLeft = left
  if (left > 0) title.dataset.scrolled = ''
  else delete title.dataset.scrolled
  if (left < range) title.dataset.clipped = ''
  else delete title.dataset.clipped
}

/**
 * Return the title to its resting state: scrolled to the start with both fade
 * masks off, so the resting ellipsis renders at full strength.
 * @param title - the row's clipping title element.
 */
function restTitle(title: HTMLSpanElement): void {
  if (typeof title.scrollTo === 'function') title.scrollTo({ left: 0, behavior: 'instant' })
  else title.scrollLeft = 0
  delete title.dataset.scrolled
  delete title.dataset.clipped
}

/**
 * Marquee a title wider than its one-line cell while its row is hovered: the
 * title clips its own text, so entering crawls it at a constant speed until the
 * far edge (a fork's incremented title, for example) is in view, then rests
 * there under the pointer. Overflow of at most {@link MIN_TITLE_REVEAL_PX}
 * stays put — a barely-clipped title moving a few pixels reads as jitter, not a
 * reveal. Leaving returns the title to the start in one step, because the
 * resting ellipsis and the narrowed cell would otherwise meet the text while it
 * travelled back. Reduced motion jumps to the far edge instead of crawling.
 * @param title - ref to the row's clipping title element.
 * @returns stable pointer enter/leave handlers for the row.
 */
function useTitleMarquee(title: RefObject<HTMLSpanElement | null>): { enter: () => void; leave: () => void } {
  const frame = useRef(0)
  useEffect(() => () => { cancelAnimationFrame(frame.current) }, [])
  return useMemo(() => ({
    enter: (): void => {
      /* v8 ignore next -- defensive: the title span renders unconditionally. */
      if (title.current === null) return
      const element = title.current
      const range = element.scrollWidth - element.clientWidth
      if (range <= MIN_TITLE_REVEAL_PX) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        placeTitle(element, range, range)
        return
      }
      cancelAnimationFrame(frame.current)
      let previous: number | undefined
      let position = 0
      const step = (now: DOMHighResTimeStamp): void => {
        position += previous === undefined ? 0 : (now - previous) * TITLE_MARQUEE_PX_PER_MS
        previous = now
        placeTitle(element, Math.min(position, range), range)
        if (position < range) frame.current = requestAnimationFrame(step)
      }
      frame.current = requestAnimationFrame(step)
    },
    leave: (): void => {
      cancelAnimationFrame(frame.current)
      /* v8 ignore next -- defensive: the title span renders unconditionally. */
      if (title.current === null) return
      restTitle(title.current)
    },
  }), [title])
}

/** Localized compact relative time ("刚刚"/"5分钟" in zh, "now"/"5min" in en). */
function timeLabel(updatedAt: number, now: number, t: RowTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/** Hover-card variant: distances wrap in the ago template; the now bucket stays bare (no "now ago"). */
function hoverTimeLabel(updatedAt: number, now: number, t: RowTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}`, { n }) })
}

/**
 * Absolute creation time through the dictionary's date template (the message
 * clock pattern): `toLocaleString` would follow the browser language, not the
 * app locale, and produce mixed-language text after a switch.
 */
function createdLabel(createdAt: number, t: RowTranslate): string {
  const d = new Date(createdAt)
  const pad2 = (v: number): string => String(v).padStart(2, '0')
  const date = t('date.ymd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
  return t('hover.created', { time: `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` })
}

/** Hover-card body: workspace title, display directory path, absolute creation time. */
function WorkspaceHoverContent({ label, cwd, createdAt, t }: {
  label: string
  cwd: string | undefined
  createdAt: number
  t: RowTranslate
}) {
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{label}</div>
      <div className={css.hoverPath}>{cwd}</div>
      <div className={css.hoverTime}>{createdLabel(createdAt, t)}</div>
    </div>
  )
}

/**
 * Row drag wiring supplied by the tree owner. `drop` reports the half of the
 * row where the pointer released so the owner can resolve an insert anchor.
 */
export interface RowDragProps {
  /** Start dragging this row. */
  start: () => void
  /** A compatible row drag is in flight. */
  active: boolean
  /** Current marker on this row: insert line above, below, or none. */
  marker: 'before' | 'after' | null
  /** Report the hovered half while a compatible drag passes over this row. */
  hover: (half: 'before' | 'after') => void
  drop: (half: 'before' | 'after') => void
  end: () => void
}

/** Drag lifecycle owned by a workspace row; its enclosing group owns hit testing. */
interface WorkspaceRowDragProps {
  start: () => void
  end: () => void
}

/** Pointer-position half of a row (insert line above or below). */
function rowHalf(e: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * Project (workspace) header row: folder + title;
 * hover reveals the chevron and create button, and dwelling on a real
 * Workspace shows its hover card (the ungrouped bucket has none).
 * `containsCurrent` arrives on the node (derivation fact, no renderer scan).
 * @param props.group - derived group node.
 * @param props.containsCurrentDescendant - highlight an ancestor even when its subtree is collapsed.
 * @param props.onToggle - expand/collapse the group.
 * @param props.onCreate - start a frontend Session inside this Workspace.
 * @param props.drag - optional workspace-row drag wiring.
 * @param props.home - host account home for POSIX hover-path abbreviation.
 * @param props.t - the browser root's locale seat.
 * @returns the row element.
 */
export function ProjectRowItem({ group, containsCurrentDescendant = false, onToggle, onCreate, actions, drag, home, newShortcut, t }: {
  group: GroupNode
  newShortcut?: ShortcutCatalogEntry | undefined
  containsCurrentDescendant?: boolean
  onToggle: () => void
  onCreate: () => void
  /** Real-Workspace actions; absent for the ungrouped bucket (no menu shown). */
  actions?: { rename: () => void; delete: () => void } | undefined
  /** Present only for real Workspace rows in the grouped view. */
  drag?: WorkspaceRowDragProps | undefined
  /** Host account home; POSIX home-rooted hover paths display as `~`. */
  home?: string | undefined
  t: RowTranslate
}) {
  const row = group
  // The ungrouped bucket has no workspace title: its label is dictionary copy.
  const label = row.workspaceId === undefined ? t('group.ungrouped') : row.label
  const active = containsCurrentDescendant || (group.expanded && group.containsCurrent)
  const [menuOpen, setMenuOpen] = useState(false)
  const workspaceMenuItems = [
    { id: 'rename', label: t('rename'), icon: <IconEditOutlineRegular /> },
    { id: 'delete', label: t('delete.workspace'), icon: <IconTrashOutlineRegular />, danger: true },
  ]
  const ownRow = (
    <div
      className={clsx(css.projectRow, menuOpen && css.menuOpen)}
      data-row-key={`workspace:${group.key}`}
      role="treeitem"
      aria-expanded={row.expanded}
      onClick={onToggle}
      draggable={drag !== undefined}
      onDragStart={drag === undefined
        ? undefined
        : (e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', row.key)
          drag.start()
        }}
      onDragEnd={drag?.end}
    >
      <span className={clsx(css.slot, css.folder, active && css.folderActive)}>
        {row.expanded ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
      </span>
      <span className={clsx(css.slot, css.chevron)}>
        <IconTriangleRightFillRegular className={clsx(css.arrow, row.expanded && css.arrowOpen)} />
      </span>
      <span className={css.projectText}>
        <span className={css.title}>{label}</span>
      </span>
      <span className={css.rowActions}>
        {actions !== undefined && (
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={workspaceMenuItems}
            onSelect={(id) => {
              setMenuOpen(false)
              // Unknown ids leave before the dispatch: a future menu row must
              // not inherit the destructive branch as an else fallback.
              /* v8 ignore next -- Menu can emit only the rename and delete rows supplied above. */
              if (id !== 'rename' && id !== 'delete') return
              if (id === 'rename') actions.rename()
              else actions.delete()
            }}
            portal
            closeOnPointerLeave
            anchor={(
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('actions.workspace.aria', { name: label })}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
              >
                <IconEllipsisOutlineRegular />
              </button>
            )}
          />
        )}
        <Tooltip label={t('actions.newSession')} shortcutKeys={newShortcut?.keys} side="bottom" align="end" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-keyshortcuts={newShortcut?.aria}
            aria-label={t('actions.newSession.aria', { name: label })}
            onClick={(e) => { e.stopPropagation(); onCreate() }}
          >
            <IconNewChatOutlineRegular />
          </button>
        </Tooltip>
      </span>
    </div>
  )
  // The ungrouped bucket has no backing Workspace: no card to show.
  if (row.createdAt === undefined) return ownRow
  return (
    <HoverCard
      anchor={ownRow}
      content={<WorkspaceHoverContent
        label={row.label}
        cwd={row.cwd === undefined ? undefined : abbreviateHomePath(row.cwd, home)}
        createdAt={row.createdAt}
        t={t}
      />}
      openDelayMs={800}
      disabled={menuOpen}
      copyText={row.cwd}
      copyLabel={t('copy')}
      copiedLabel={t('hover.copied')}
    />
  )
}

/* v8 ignore next 3 -- closed-union backstop; only reached if the status is forged */
function assertNever(value: never): never {
  throw new Error(`unknown pending interaction: ${String(value)}`)
}

interface SessionStatus {
  state: StateDotState
  label: string
  /** Compact text that replaces the Session row's update time. */
  trailingLabel?: string
}

/**
 * Session status presentation; pending interaction is primary and live activity
 * outranks completion reminders.
 */
function sessionStatuses(
  node: Pick<SessionNode, 'pendingInteraction' | 'running' | 'runningSubagentCount' | 'completed'>,
  t: RowTranslate,
): readonly [SessionStatus, ...SessionStatus[]] {
  const subagents: SessionStatus | undefined = node.runningSubagentCount === 0
    ? undefined
    : {
      state: 'ongoing',
      label: t(
        node.runningSubagentCount === 1
          ? 'status.subagentsRunning.one'
          : 'status.subagentsRunning.other',
        { n: node.runningSubagentCount },
      ),
    }
  let pending: SessionStatus | undefined
  switch (node.pendingInteraction) {
    case 'approval':
      pending = {
        state: 'warning',
        label: t('status.waitingApproval'),
        trailingLabel: t('status.compact.approval'),
      }
      break
    case 'plan-review':
      pending = {
        state: 'warning',
        label: t('status.planReview'),
        trailingLabel: t('status.compact.planReview'),
      }
      break
    case 'question':
      pending = {
        state: 'warning',
        label: t('status.waitingAnswer'),
        trailingLabel: t('status.compact.answer'),
      }
      break
    case undefined: break
    /* v8 ignore next -- closed PendingInteractionStatus union */
    default: return assertNever(node.pendingInteraction)
  }
  if (pending !== undefined) return subagents === undefined ? [pending] : [pending, subagents]
  if (node.running) {
    const primary: SessionStatus = { state: 'ongoing', label: t('status.running') }
    return subagents === undefined ? [primary] : [primary, subagents]
  }
  if (subagents !== undefined) return [subagents]
  if (node.completed) return [{ state: 'done', label: t('status.completed') }]
  return [{ state: 'idle', label: t('status.idle') }]
}

/** Primary status dot plus every status's screen-reader label, shared by the search and session rows. */
function SessionStatusDots({ statuses }: { statuses: readonly [SessionStatus, ...SessionStatus[]] }) {
  return (
    <>
      <StateDot state={statuses[0].state} />
      {statuses.map(status => (
        <span className={css.visuallyHidden} key={status.label}>{status.label}</span>
      ))}
    </>
  )
}

/** Non-interactive pinned-row marker; the enclosing row remains the only action. */
function PinnedIndicator({ t }: { t: RowTranslate }) {
  const label = t('row.pinned')
  return (
    <span className={css.pinIndicator} role="img" aria-label={label} title={label}>
      <IconPinFillRegular size={14} />
    </span>
  )
}

/**
 * Hover-card body: full title, relative time, the Session's own scheduled-task
 * section, and every relevant live status. The task section sits above the
 * status lines so they stay the card's trailing status line.
 */
function SessionHoverContent({ node, now, renderSlot, t }: {
  node: SessionNode
  now: number
  renderSlot: RowRenderSlots
  t: RowTranslate
}) {
  // On archived rows the archived line already says the session is inactive,
  // so resting statuses (idle/completed) drop; live activity still shows.
  const statuses = sessionStatuses(node, t)
    .filter(status => !(node.archived && (status.state === 'done' || status.state === 'idle')))
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{displayTitle(node, t)}</div>
      {/* Same placeholder rule as the row's trailing cell: no timestamp
          before the first prompt. */}
      {!node.blank && <div className={css.hoverTime}>{hoverTimeLabel(node.updatedAt, now, t)}</div>}
      {renderSlot('sidebar.session.row.hover', { sessionId: node.id })}
      {statuses.map(status => (
        <div className={css.hoverStatus} key={status.label}>
          <StateDot state={status.state} />
          <span>{status.label}</span>
        </div>
      ))}
      {node.archived && (
        <div className={clsx(css.hoverStatus, css.hoverArchived)}>
          <IconArchiveOutlineRegular size={14} />
          <span>{t('row.archived')}</span>
        </div>
      )}
    </div>
  )
}

/**
 * One flat search result: title, Workspace context, and optional content
 * excerpt. Search navigation opens the session only; it does not address an
 * event inside the conversation. Archived rows carry a hover unarchive
 * button, because search is where the filter surfaces them for recovery.
 * @param props.result - merged local/content search row.
 * @param props.currentId - selected session id.
 * @param props.onOpen - open the selected session.
 * @param props.onUnarchive - unarchive an archived result row.
 * @param props.t - Workspace-browser translation seat.
 * @returns the result row.
 */
export function SearchResultItem({ result, currentId, onOpen, onUnarchive, t }: {
  result: SearchResultNode
  currentId: string | undefined
  onOpen: (id: SearchResultNode['id']) => void
  onUnarchive: (id: SearchResultNode['id']) => void
  t: RowTranslate
}) {
  const selected = result.id === currentId
  const statuses = sessionStatuses(result, t)
  const primaryStatus = statuses[0]
  return (
    <div
      className={clsx(css.searchResultRow, selected && css.selected, result.archived && css.archived)}
      role="treeitem"
      aria-selected={selected}
      aria-description={result.archived ? t('toast.archivedNotOpenable') : undefined}
      onClick={() => { onOpen(result.id) }}
    >
      <span className={css.searchResultHeading}>
        {/* Like session rows, the leading slot owns every row marker; on
            archived rows it stays blank — the grayed row carries the
            archived look. */}
        <span className={css.slot}>
          {!result.archived && primaryStatus.state !== 'idle' && (
            <SessionStatusDots statuses={statuses} />
          )}
        </span>
        <span className={css.searchResultTitle}>{result.title || t('session.untitled')}</span>
        {result.archived && (
          <span className={css.rowActions}>
            <Tooltip label={t('actions.unarchive')} side="bottom" align="end" delayMs={500}>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('menu.unarchiveSession')}
                onClick={(e) => { e.stopPropagation(); onUnarchive(result.id) }}
              >
                <IconUnarchiveOutlineRegular size={14} />
              </button>
            </Tooltip>
          </span>
        )}
      </span>
      <span className={css.searchResultMeta}>
        <span className={css.searchResultWorkspace}>{result.workspace || t('group.ungrouped')}</span>
        {result.snippet !== undefined && (
          <span className={css.searchResultSnippet}>{result.snippet}</span>
        )}
      </span>
    </div>
  )
}

/**
 * One top-level 32px session row: leading 16px cell (status dot, or the
 * leading seat while the row's primary state is idle), title, relative time or
 * compact pending label, and the row actions menu. A row that owns a state dot
 * keeps that cell and renders no seat, so an ambient automation mark never
 * appears beside the row's own state dot. An archived row keeps the cell blank:
 * neither marker renders there, and its live status stays on the hover card.
 * @param props.node - derived session node.
 * @param props.currentId - selected session id (row highlight).
 * @param props.now - epoch ms for relative-time formatting.
 * @param props.onOpen - open a session by id.
 * @param props.onRenameRequest - open the rename dialog from a title double-click (id + current title).
 * @param props.renderSlot - child-seat renderer for the row's action lists
 * (`sidebar.workspaces.session.menu.item` / `sidebar.workspaces.session.row.action`),
 * its leading decoration, and its hover-card section.
 * @param props.onReveal - scroll this row into view after search navigation, then acknowledge it.
 * @param props.drag - optional row-drag target wiring; blank rows cannot start a drag.
 * @param props.t - the browser root's locale seat.
 * @returns the session row.
 */
export function SessionNodeItem({
  node, currentId, now, onOpen, onRenameRequest, renderSlot, onReveal, drag, t,
}: {
  node: SessionNode
  currentId: string | undefined
  now: number
  onOpen: (id: SessionNode['id']) => void
  /** Open the rename dialog from a title double-click (id + current title). */
  onRenameRequest: (id: SessionNode['id'], currentTitle: string) => void
  /** Scroll this row into view after search navigation, then acknowledge it. */
  onReveal?: (() => void) | undefined
  /** Present on reorderable-list rows so every row can remain a drop target. */
  drag?: RowDragProps | undefined
  t: RowTranslate
} & PropsRenderSlots<
  | 'sidebar.workspaces.session.menu.item'
  | 'sidebar.workspaces.session.row.action'
  | 'sidebar.session.row.leading'
  | 'sidebar.session.row.hover'
>) {
  const row = node
  const title = displayTitle(node, t)
  const selected = node.id === currentId
  const statuses = sessionStatuses(node, t)
  const primaryStatus = statuses[0]
  const showStatus = primaryStatus.state !== 'idle'
  // Archived rows hold their in-place grayed slot, so manual reorder cannot
  // move them. Pinned rows drag within the pinned block: the browser gates
  // their drop targets to fellow pinned rows.
  const draggable = drag !== undefined && !row.blank && !row.archived
  const [menuOpen, setMenuOpen] = useState(false)
  // The menu's open state, bound into the row entries' `useMenuOpenState` hook.
  const menuOpenState = useMemo((): MenuOpenState => [menuOpen, setMenuOpen], [menuOpen])
  const rowRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const marquee = useTitleMarquee(titleRef)
  useEffect(() => {
    if (onReveal === undefined) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
    onReveal()
  }, [onReveal])
  // Figma session cell: pad 8, status slot 16, then a 4px title gap.
  const ownRow = (
    <div
      ref={rowRef}
      data-row-key={`session:${node.id}`}
      className={clsx(
        css.sessionRow, selected && css.selected, menuOpen && css.menuOpen,
        row.archived && css.archived,
        drag?.marker === 'before' && css.dropBefore, drag?.marker === 'after' && css.dropAfter,
      )}
      role="treeitem"
      aria-selected={selected}
      aria-description={row.archived ? t('toast.archivedNotOpenable') : undefined}
      onClick={() => { onOpen(node.id) }}
      onPointerEnter={marquee.enter}
      onPointerLeave={marquee.leave}
      draggable={draggable}
      onDragStart={!draggable
        ? undefined
        : (e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', node.id)
          drag.start()
        }}
      onDragEnd={!draggable ? undefined : drag.end}
      onDragOver={drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          drag.hover(rowHalf(e))
        }}
      onDrop={drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          drag.drop(rowHalf(e))
        }}
    >
      {/* Pending interaction and own or descendant activity outrank the
          finished-but-unviewed reminder, which returns after activity stops
          and is cleared by opening the session. Archived rows keep the slot
          blank — the grayed row carries the archived look — and their live
          status stays on the hover card only. */}
      <span className={css.slot}>
        {!row.archived && !row.blank && (showStatus
          ? <SessionStatusDots statuses={statuses} />
          : renderSlot('sidebar.session.row.leading', { sessionId: node.id }))}
      </span>
      <span
        ref={titleRef}
        className={css.title}
        onDoubleClick={row.blank
          ? undefined
          : (e) => { e.stopPropagation(); onRenameRequest(node.id, row.title) }}
      >
        {title}
      </span>
      {/* A blank New Session row is a provisional placeholder: nothing has
          happened in it yet, so a "now" timestamp and the row verbs
          (rename/fork/archive) would all act on content that does not
          exist — both trailing cells stay off until the first prompt. */}
      {!row.blank && (
        <span
          className={css.time}
          aria-hidden={primaryStatus.trailingLabel === undefined ? undefined : true}
        >
          {primaryStatus.trailingLabel ?? timeLabel(row.updatedAt, now, t)}
        </span>
      )}
      {/* Trails the time so the marker occupies the same right-edge cell as
          the hover pin button that replaces it. */}
      {row.pinned && !row.archived && <PinnedIndicator t={t} />}
      {/* The strip's clicks stay in the strip: the trigger and every
          row.action entry act without also opening the row, so an entry's
          button needs no propagation handling of its own. */}
      {!row.blank && (
        <span className={css.rowActions} onClick={(e) => { e.stopPropagation() }}>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            portal
            closeOnPointerLeave
            anchor={(
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('actions.session.aria', { name: title })}
                onClick={() => { setMenuOpen(v => !v) }}
              >
                <IconEllipsisOutlineRegular />
              </button>
            )}
          >
            {renderSlot(
              'sidebar.workspaces.session.menu.item',
              { sessionId: node.id, displayTitle: row.title },
              { hookContext: menuOpenState },
            )}
          </Menu>
          {renderSlot('sidebar.workspaces.session.row.action', { sessionId: node.id, displayTitle: row.title })}
        </span>
      )}
    </div>
  )
  return (
    <HoverCard
      anchor={ownRow}
      content={<SessionHoverContent node={node} now={now} renderSlot={renderSlot} t={t} />}
      openDelayMs={800}
      disabled={menuOpen || drag?.active === true}
      copyText={row.blank || row.title === '' ? undefined : row.title}
      copyLabel={t('copy')}
      copiedLabel={t('hover.copied')}
    />
  )
}

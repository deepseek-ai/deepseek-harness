/**
 * Body of the changes tab: the local changes of the Session's checkout in a
 * chosen scope, or the changes of one of its change requests, as one list of
 * file sections under a toolbar that jumps between files and switches the
 * layout. The view reads the changes when it opens, on each navigation, on
 * refresh, and when the change request's head or the checkout's `branch`
 * scope summary changes; a read keeps the previous changes on screen until it settles.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutlineRegular, IconChevronsUpDownOutlineRegular, IconCompareSplitOutlineRegular, IconInfoOutlineRegular,
  IconListPenOutlineRegular, IconNowrapFillRegular, IconRightUpOutlineRegular, IconWorkspaceTreeOutlineRegular, IconWrapFillRegular,
  Menu, StateDot, Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type {
  ForgeChangeRequestDiff, ForgeDiffFile, ForgeLocalDiff, ForgeLocalScope, ForgePanelChangeRequest, ForgePanelState,
} from '../types.ts'
import type { ForgeReviewRequest, ForgeReviewResult } from '@deepseek-ai/dsh-experimental-forge/types'
import { sameReviewSource, type ReviewQueue } from './review-queue.ts'
import { ReviewThread, useFileReview } from './ReviewThread.tsx'
import type { ReviewActions } from './ReviewComposer.tsx'
import { SubmitReview } from './SubmitReview.tsx'
import type { ReviewSelection } from './review.ts'
import { parseChangesAddress, type ChangesSource } from './changes-address.ts'
import type { createChangesStore } from './changes-store.ts'
import { Counts, DiffFile, type DiffFileAction } from './DiffFile.tsx'
import { FileTreePane, type FileTreePosition } from './FileTreePane.tsx'
import { ChangedFilesMenu, type ChangedFilesProps, type ChangedFilesState } from './ChangedFiles.tsx'
import { drawnLines, matchesHunks, textLines } from './diff-rows.ts'
import { ChangeRequestGlyph } from './glyphs.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import { RefreshGlyph } from './RefreshGlyph.tsx'
import type { PanelSnapshot } from './source.ts'
import { numberOf, openChangeRequestOf, TONE_LABEL, toneOf } from './status.ts'
import css from './ChangesTab.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Kind of a local scope. */
type ScopeKind = ForgeLocalScope['kind']

/** Business face of the changes tab body. */
export interface ChangesTabInjected {
  /** Append a frozen comment to the main input without submitting it. */
  readonly addReviewToInput: (selection: ReviewSelection) => boolean
  /** Records retained across Session switches and cleared when this tab occurrence closes. */
  readonly reviewQueue: (tab: Pick<SidebarRightTabInfo['tab'], 'id' | 'signal'>) => ReviewQueue
  /** Publish one comment or a completed review; never retries mutations. */
  readonly submitReview: (url: string, request: ForgeReviewRequest) => Promise<RemoteResult<ForgeReviewResult>>
  /** Panel source while visible; the renderer releases the subscription for an inactive key. */
  readonly keyedHooks: { readonly panel: (visibility: string) => HostObservable<PanelSnapshot> | undefined }
  /** Open the panel stream again after it ended. */
  readonly reconnect: () => void
  /** Read the local changes of one scope; `signal` aborts the read. */
  readonly localDiff: (scope: ForgeLocalScope, signal: AbortSignal) => Promise<RemoteResult<ForgeLocalDiff>>
  /** Read the new side of one file in a local scope. */
  readonly localText: (scope: ForgeLocalScope, path: string) => Promise<RemoteResult<string>>
  /** Read the changes of a change request by its binding URL; `signal` aborts the read. */
  readonly changeRequestDiff: (url: string, signal: AbortSignal) => Promise<RemoteResult<ForgeChangeRequestDiff>>
  /** Read one file of a change request at a commit. */
  readonly changeRequestText: (url: string, commit: string, path: string) => Promise<RemoteResult<string>>
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Copy a path to the clipboard and report the outcome. */
  readonly copyPath: (path: string) => void
  /** Ask the Session's Agent to create a change request for its changes, reporting the outcome. */
  readonly createChangeRequest: () => void
  /** Show a failure notice. */
  readonly report: (key: ForgePanelKey, params?: Readonly<Record<string, string>>) => void
}

/** Full props of the changes tab body. */
export type ChangesTabProps =
  Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useTabInfo' | 'sessionId'>
  & PropsStore<ReturnType<typeof createChangesStore>>
  & InjectFace<ChangesTabInjected>
  & PropsLocale<typeof NS>

/** Changes of either source as the view draws them. */
type ChangesData =
  | {
    readonly kind: 'local'
    readonly files: readonly ForgeDiffFile[]
    /** Scope the files were read in. */
    readonly scope: ScopeKind
    /** Untracked files left out. */
    readonly omitted: number
  }
  | {
    readonly kind: 'change'
    readonly files: readonly ForgeDiffFile[]
    /** Binding URL of the change request. */
    readonly url: string
    /** Head commit the files describe, which supplies unchanged lines. */
    readonly headSha: string
    /** Commits the checkout's branch has beyond the head, or null. */
    readonly localAhead: number | null
    /** Web page of each file at the head. */
    readonly fileUrls: Readonly<Record<string, string>>
  }

/** Unchanged lines read for one loaded diff: each file's new side and its expanded gaps. */
interface Expansion {
  readonly data: ChangesData | null
  readonly texts: Readonly<Record<string, readonly string[] | 'loading'>>
  readonly open: Readonly<Record<string, ReadonlySet<number>>>
}

/** Files whose hunks draw more lines show the large-file notice until revealed. */
const LARGE_FILE_LINES = 1000

/** Lines the files above may change before a file starts collapsed. */
const OPEN_LINES = 5000

const NO_GAPS: ReadonlySet<number> = new Set()

const SCOPE_LABEL: Record<ScopeKind, ForgePanelKey> = {
  branch: 'diff.scope.branch',
  uncommitted: 'diff.scope.uncommitted',
  unstaged: 'diff.scope.unstaged',
  staged: 'diff.scope.staged',
}

const SCOPE_NOTE: Record<Exclude<ScopeKind, 'branch'>, ForgePanelKey> = {
  uncommitted: 'diff.scopeNote.uncommitted',
  unstaged: 'diff.scopeNote.unstaged',
  staged: 'diff.scopeNote.staged',
}

/** Failures with their own message; any other failure offers a retry. */
const FAILURE: Partial<Record<string, ForgePanelKey>> = {
  'forgePanel/not-a-checkout': 'checkout.none',
  'forgePanel/no-fork-point': 'diff.noForkPoint',
  'forgePanel/diff-too-large': 'diff.tooLarge',
  'forgePanel/filter-config-failed': 'diff.filterConfigFailed',
}

async function readChanges(
  source: ChangesSource,
  scope: ScopeKind,
  reads: Pick<ChangesTabInjected, 'localDiff' | 'changeRequestDiff'>,
  signal: AbortSignal,
): Promise<RemoteResult<ChangesData>> {
  if (source.kind === 'local') {
    const result = await reads.localDiff({ kind: scope }, signal)
    if (!result.ok) return result
    return { ok: true, value: { kind: 'local', files: result.value.files, scope, omitted: result.value.omitted } }
  }
  const result = await reads.changeRequestDiff(source.url, signal)
  if (!result.ok) return result
  const { files, headSha, localAhead, fileUrls } = result.value
  return { ok: true, value: { kind: 'change', files, url: source.url, headSha, localAhead, fileUrls } }
}

/** The files that start expanded: every file until those above it change more than {@link OPEN_LINES} lines. */
function initiallyOpen(files: readonly ForgeDiffFile[]): ReadonlySet<string> {
  const open = new Set<string>()
  let above = 0
  for (const file of files) {
    if (above > OPEN_LINES) break
    open.add(file.path)
    above += drawnLines(file)
  }
  return open
}

/** What a rename badge names: the old file name, or the old path when only the directory changed. */
function renamedFrom(previous: string, path: string): string {
  const name = pathPartsOf(previous).name
  return name === pathPartsOf(path).name ? previous : name
}

/** The hover text of a file's path: both paths of a renamed file, else the path. */
function pathTooltipOf(file: ForgeDiffFile, t: Translate): string {
  return file.status === 'renamed' && file.previousPath !== null ? t('diff.renamedPath', { from: file.previousPath, path: file.path }) : file.path
}

/** The badge after a path: how the file changed, and whether a branch view's file is untracked. */
function badgeOf(file: ForgeDiffFile, data: ChangesData, t: Translate): string {
  const parts: string[] = []
  if (file.status === 'added') parts.push(t('diff.newFile'))
  else if (file.status === 'deleted') parts.push(t('diff.deletedFile'))
  else if (file.status === 'renamed' && file.previousPath !== null) parts.push(t('diff.renamed', { from: renamedFrom(file.previousPath, file.path) }))
  if (file.untracked && data.kind === 'local' && data.scope === 'branch') parts.push(t('diff.badgeUncommitted'))
  return parts.join(' · ')
}

function ChangeHeader({ url, entry, openLink, reviewCount, reviewDisabled, onReview, t }: {
  readonly url: string
  readonly entry: ForgePanelChangeRequest | undefined
  readonly reviewCount: number
  readonly reviewDisabled: boolean
  readonly onReview: () => void
  readonly openLink: (url: string) => void
  readonly t: Translate
}): ReactNode {
  const snapshot = entry?.snapshot ?? null
  const number = numberOf(entry ?? { ref: null, url })
  const tone = toneOf(snapshot)
  const href = snapshot === null ? url : snapshot.url
  return (
    <div className={css.header}>
      <ChangeRequestGlyph tone={tone} label={t('change.stateAria', { state: t(TONE_LABEL[tone]) })} />
      <span className={css.headerTitle}>{snapshot === null ? url : snapshot.title}</span>
      {number !== null && <span className={css.headerNumber}>{t('change.number', { number })}</span>}
      <Button size="sm" variant="outline" className={clsx(css.headerEnd, css.reviewSubmit)} disabled={reviewDisabled} onClick={onReview}>
        {t('review.submit')}{reviewCount > 0 ? ` (${reviewCount})` : ''}
      </Button>
      <Tooltip label={t('change.view')} side="bottom">
        <button type="button" className={css.tool} aria-label={t('change.view')} onClick={() => { openLink(href) }}>
          <IconRightUpOutlineRegular size={14} />
        </button>
      </Tooltip>
    </div>
  )
}

function LocalHeader({ state, scope, createChangeRequest, t }: {
  readonly state: ForgePanelState | null
  readonly scope: ScopeKind
  readonly createChangeRequest: () => void
  readonly t: Translate
}): ReactNode {
  const base = state?.local?.base ?? null
  const note = scope !== 'branch' ? t(SCOPE_NOTE[scope]) : base === null ? '' : t('diff.scopeNote.branch', { base })
  const creatable = state !== null && state.repository !== null && openChangeRequestOf(state) === undefined
  return (
    <div className={css.header}>
      <span className={css.headerIcon}><IconListPenOutlineRegular size={15} /></span>
      <span className={css.headerNote}>{note}</span>
      {creatable && (
        <Button size="sm" variant="outline" className={css.headerEnd} onClick={createChangeRequest}>{t('changes.local.create')}</Button>
      )}
    </div>
  )
}

function ScopeMenu({ scope, choose, t }: {
  readonly scope: ScopeKind
  readonly choose: (scope: ScopeKind) => void
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const items: MenuEntry[] = [
    { id: 'uncommitted', label: t(SCOPE_LABEL.uncommitted) },
    { id: 'unstaged', label: t(SCOPE_LABEL.unstaged) },
    { id: 'staged', label: t(SCOPE_LABEL.staged) },
    { type: 'separator', id: 'separator' },
    { id: 'branch', label: t(SCOPE_LABEL.branch) },
  ]
  return (
    <Menu
      open={open}
      portal
      align="start"
      dense
      autoFocus
      selectedId={scope}
      items={items}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        choose(id as ScopeKind)
      }}
      anchor={(
        <button type="button" className={css.select} aria-haspopup="menu" aria-expanded={open} data-forge-scope={scope}
          onClick={() => { setOpen(value => !value) }}>
          {t(SCOPE_LABEL[scope])}
          <IconChevronDownOutlineRegular size={12} />
        </button>
      )}
    />
  )
}

function Notice({ children, action }: { readonly children: ReactNode; readonly action?: ReactNode }): ReactNode {
  return (
    <div className={css.notice} role="status">
      <IconInfoOutlineRegular size={14} />
      <span>{children}</span>
      {action}
    </div>
  )
}


function OrphanReviews({ path, actions, t }: PropsLocale<typeof NS> & {
  readonly path: string
  readonly actions: ReviewActions
}): ReactNode {
  const state = useFileReview(actions, path)
  return <section className={css.reviewFile} data-forge-review-file={path}>
    <h3>{path}</h3>
    {state.threads.map(thread => <ReviewThread key={thread.key} thread={thread}
      actions={actions} locked={state.locked} outdated split={false} t={t} />)}
  </section>
}

/**
 * Render the changes tab of one Session.
 * @param props - tab information, the tab's choices, the panel snapshot hook, reads and actions, and copy.
 * @returns the view body.
 */
export function ChangesTab({
  useTabInfo, sessionId, useStore, actions, usePanel, reconnect, localDiff, localText, changeRequestDiff, changeRequestText,
  openLink, copyPath, createChangeRequest, addReviewToInput, reviewQueue, submitReview, report, t,
}: ChangesTabProps): ReactNode {
  const { tab } = useTabInfo()
  const { navigation, signal } = tab
  const target = useMemo(() => parseChangesAddress(tab.contentId), [tab.contentId])
  if (target === undefined) throw new Error(`forge-panel: not a changes address "${tab.contentId}"`)
  const source = target.source
  const queue = reviewQueue(tab)
  useSyncExternalStore(queue.subscribe, queue.getStatus)
  const reviewState = queue.getSnapshot()
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  useEffect(() => { if (!tab.visible) setReviewOpen(false) }, [tab.visible])
  const reviewRunning = useRef(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const publishReview = async (
    url: string, request: ForgeReviewRequest, complete: (url: string) => boolean,
  ): Promise<string | undefined> => {
    if (reviewRunning.current || !queue.begin(request)) return t('review.saveFailed')
    reviewRunning.current = true
    setReviewBusy(true)
    setReviewError(null)
    try {
      const response = await submitReview(url, request)
      if (!response.ok || (!response.value.ok && response.value.code === 'unknown')) {
        setReviewError(t('review.unknown'))
        return t('review.unknown')
      }
      const result = response.value
      if (!result.ok) {
        queue.finish(false)
        const message = result.code === 'stale' ? t('review.stale') : result.code === 'unsupported'
          ? t('review.unsupported') : t('review.failed', { message: result.message })
        setReviewError(message)
        return message
      }
      if (!complete(result.url)) return t('review.unknown')
      report(request.kind === 'review' ? 'review.submitted' : 'review.published')
      if (request.kind === 'review') setReviewOpen(false)
      return undefined
    } catch (_error) {
      setReviewError(t('review.unknown'))
      return t('review.unknown')
    } finally {
      reviewRunning.current = false
      setReviewBusy(false)
    }
  }
  const choices = useStore(store => store.byTab[tab.id])
  const [wanted, setWanted] = useState<string | null>(null)
  const [treeState, setTreeState] = useState<ChangedFilesState>({ query: '', collapsed: {}, selected: null })
  const [treePosition, setTreePosition] = useState<FileTreePosition>('left')
  const treeId = useId()
  const [chosen, setChosen] = useState<Readonly<Record<string, boolean>>>({})
  // Each navigation applies once; its file, if it names one, opens and scrolls into view.
  useEffect(() => {
    if (choices?.navigated === navigation.revision) return
    actions.navigated(tab.id, navigation.revision)
    const path = navigation.params?.path
    if (path === undefined) return
    setTreeState(value => ({ ...value, selected: path }))
    setChosen(value => ({ ...value, [path]: true }))
    setWanted(path)
  }, [choices, navigation.revision, navigation.params, actions, tab.id])
  // The tab's choices end with its record.
  useEffect(() => {
    const unmounted = new AbortController()
    signal.addEventListener('abort', () => { actions.forget(tab.id) }, { once: true, signal: unmounted.signal })
    return () => { unmounted.abort() }
  }, [signal, actions, tab.id])
  const [attempt, setAttempt] = useState(0)
  useEffect(() => tab.actions.bindCommands({ refresh: () => { setAttempt(value => value + 1) } }), [tab.actions])
  const snapshot = usePanel(tab.visible ? 'visible' : 'inactive')
  const state = snapshot?.state ?? null
  const scope = choices?.scope ?? 'branch'
  const split = choices?.split ?? true
  const wrap = choices?.wrap ?? true
  const entry = source.kind === 'change' ? state?.changeRequests.find(item => item.url === source.url) : undefined
  // A read starts once the panel state arrives and again when what it describes moves. A change request's read
  // also waits for its first status, which names the head, unless no provider serves it or its first poll failed.
  const pending = entry !== undefined && entry.ref !== null && entry.update === null
  const head = entry?.snapshot?.headSha ?? (pending ? null : '')
  const version = state === null ? null : source.kind === 'local' ? `${scope}\n${JSON.stringify(state.local)}` : head
  const dataKey = source.kind === 'local' ? scope : 'change'
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly data: ChangesData } | null>(null)
  const [failure, setFailure] = useState<{ readonly key: string; readonly code: string } | null>(null)
  // Names the read the inputs ask for; it is in flight until `finished` matches it.
  const read = version === null ? null : `${dataKey}\n${navigation.revision}\n${attempt}\n${version}`
  const [finished, setFinished] = useState<string | null>(null)
  useEffect(() => {
    if (!tab.visible || read === null || read === finished) return
    const controller = new AbortController()
    void readChanges(source, scope, { localDiff, changeRequestDiff }, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setFinished(read)
      if (result.ok) {
        setLoaded({ key: dataKey, data: result.value })
        setFailure(null)
      } else {
        setFailure({ key: dataKey, code: result.error.code })
      }
    })
    return () => { controller.abort() }
  }, [tab.visible, read, source, scope, dataKey, localDiff, changeRequestDiff])
  const data = loaded !== null && loaded.key === dataKey ? loaded.data : null
  // The centered loader marks a first read; the toolbar's glyph turns only while shown changes are read again.
  const rereading = read !== null && finished !== read && data !== null
  const failed = failure !== null && failure.key === dataKey ? failure.code : null
  const [expansion, setExpansion] = useState<Expansion>({ data: null, texts: {}, open: {} })
  const current = expansion.data === data ? expansion : { data, texts: {}, open: {} }
  const latest = useRef(data)
  useEffect(() => { latest.current = data }, [data])
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set())
  const initial = useMemo(() => initiallyOpen(data === null ? [] : data.files), [data])
  const sections = useRef(new Map<string, HTMLElement>())
  const scrollport = useRef<HTMLDivElement>(null)
  // A short final file cannot align with the viewport top; retain its jump until the reader scrolls away.
  const jumpPosition = useRef<{ readonly data: ChangesData; readonly top: number } | null>(null)
  useLayoutEffect(() => {
    if (!tab.visible || wanted === null || data === null) return
    sections.current.get(wanted)?.scrollIntoView({ block: 'start' })
    if (scrollport.current !== null) jumpPosition.current = { data, top: scrollport.current.scrollTop }
    setWanted(null)
  }, [tab.visible, wanted, data])
  const refresh = (): void => { setAttempt(value => value + 1) }
  const root = state !== null && state.checkout.state === 'ready' ? state.checkout.checkout.root : null
  // Configuration reads may recover after the user fixes Git settings or raises the output limit.
  const message = failed === null ? undefined : FAILURE[failed]
  const changeUrl = source.kind === 'change' ? entry?.snapshot?.url ?? source.url : null
  const retry = message === undefined || failed === 'forgePanel/filter-config-failed'

  /** Apply a change to the unchanged lines of `owner`, unless newer changes replaced it. */
  const update = (owner: ChangesData, change: (value: Expansion) => Expansion): void => {
    setExpansion((previous) => {
      if (latest.current !== owner) return previous
      return change(previous.data === owner ? previous : { data: owner, texts: {}, open: {} })
    })
  }
  const expand = (owner: ChangesData, file: ForgeDiffFile, index: number): void => {
    const path = file.path
    update(owner, value => ({ ...value, open: { ...value.open, [path]: new Set([...value.open[path] ?? [], index]) } }))
    if (current.texts[path] !== undefined) return
    update(owner, value => ({ ...value, texts: { ...value.texts, [path]: 'loading' } }))
    const reading = owner.kind === 'local' ? localText({ kind: owner.scope }, path) : changeRequestText(owner.url, owner.headSha, path)
    void reading.then((result) => {
      const lines = result.ok ? textLines(result.value) : undefined
      if (lines !== undefined && matchesHunks(lines, file.hunks)) {
        update(owner, value => ({ ...value, texts: { ...value.texts, [path]: lines } }))
        return
      }
      if (result.ok) report('toast.expandStale')
      else report('toast.expandFailed', { message: result.error.message })
      update(owner, (value) => {
        const { [path]: _text, ...texts } = value.texts
        const { [path]: _open, ...open } = value.open
        return { ...value, texts, open }
      })
    })
  }
  const fileActions = (owner: ChangesData, file: ForgeDiffFile): DiffFileAction[] => {
    const list: DiffFileAction[] = [{ label: 'diff.copyPath', run: () => { copyPath(file.path) } }]
    if (file.status === 'deleted') return list
    if (owner.kind === 'local') {
      if (root !== null) {
        list.push({ label: 'diff.openFileInSidebar', run: () => { tab.actions.openResource(fileAddressFor(sessionId, undefined, `${root}/${file.path}`)) } })
      }
    } else {
      const url = owner.fileUrls[file.path]
      if (url !== undefined) list.push({ label: 'diff.openFileInBrowser', run: () => { openLink(url) } })
    }
    return list
  }

  const reviewForm = tab.visible && data !== null && reviewOpen && data.kind === 'change' && <SubmitReview queue={queue}
    url={data.url} headSha={data.headSha} busy={reviewBusy} error={reviewError} close={() => { setReviewOpen(false) }}
    check={() => { openLink(data.url) }} reconcile={() => { queue.finish(false); setReviewError(null) }}
    submit={() => {
      const latest = queue.getSnapshot()
      void publishReview(data.url, { kind: 'review', headSha: data.headSha, event: latest.event,
        body: latest.body, comments: latest.comments.map(item => item.comment) }, url => queue.finish(true, url))
    }} t={t} />

  const recordActions: ReviewActions = {
    source: source.kind === 'local' ? { kind: 'local', scope } : { kind: 'change', url: source.url, headSha: data?.kind === 'change' ? data.headSha : '' },
    records: queue, addToInput: addReviewToInput, openLink,
  }
  const absentPaths = [...new Set([...reviewState.comments, ...reviewState.records.map(item => item.selection)]
    .filter(item => sameReviewSource(item.source, recordActions.source)).map(item => item.comment.path))]
    .filter(path => !data?.files.some(file => file.path === path))
  const orphanRecords = absentPaths.map(path => <OrphanReviews key={path} path={path} actions={recordActions} t={t} />)

  const files = data === null ? [] : data.files
  const jump = (path: string): void => {
    setTreeState(value => ({ ...value, selected: path }))
    setChosen(value => ({ ...value, [path]: true }))
    setWanted(path)
  }
  const navigateFiles = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!tab.visible || event.defaultPrevented || event.nativeEvent.isComposing
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    const viewport = event.currentTarget
    const origin = event.target
    const selection = window.getSelection()
    if (!(origin instanceof HTMLElement) || !viewport.contains(origin)
      || origin.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-forge-comment]') !== null
      || (selection !== null && !selection.isCollapsed)) return
    const remembered = jumpPosition.current
    let index = remembered !== null && remembered.data === data && remembered.top === viewport.scrollTop
      ? files.findIndex(file => file.path === treeState.selected) : -1
    if (index < 0) {
      const top = viewport.getBoundingClientRect().top
      index = Math.max(0, files.findLastIndex((file) => {
        const section = sections.current.get(file.path)
        return section !== undefined && section.getBoundingClientRect().top <= top + 1
      }))
    }
    event.preventDefault()
    event.stopPropagation()
    const next = files[index + (event.key === 'ArrowRight' ? 1 : -1)]
    if (next === undefined) return
    viewport.focus({ preventScroll: true })
    jump(next.path)
  }

  let body: ReactNode
  if (data === null) {
    if (state === null && snapshot?.disconnected) {
      body = (
        <div className={css.centered}>
          <span>{t('stream.failed')}</span>
          <Button size="sm" variant="outline" onClick={reconnect}>{t('retry')}</Button>
        </div>
      )
    } else if (failed === null) {
      body = <div className={css.centered}><StateDot state="ongoing" /></div>
    } else {
      body = (
        <div className={css.centered} role="status">
          <span>{t(message ?? 'diff.error')}</span>
          {(retry || changeUrl !== null) && (
            <div className={css.actions}>
              {retry && <Button size="sm" variant="outline" onClick={refresh}>{t('retry')}</Button>}
              {changeUrl !== null && (
                <Button size="sm" variant="outline" onClick={() => { openLink(changeUrl) }}>{t('diff.viewInBrowser')}</Button>
              )}
            </div>
          )}
        </div>
      )
    }
  } else if (data.files.length === 0) {
    body = <div className={css.files}>{orphanRecords}<div className={css.centered}>{t('diff.empty')}</div></div>
  } else {
    body = (
      <div ref={scrollport} className={css.files} data-forge-changes-scroll="" role="region"
        aria-label={t('diff.allFiles', { count: files.length })} aria-keyshortcuts="ArrowLeft ArrowRight" tabIndex={0}
        onKeyDown={navigateFiles} onScroll={(event) => {
          if (jumpPosition.current?.top !== event.currentTarget.scrollTop) jumpPosition.current = null
        }}>
        {data.files.map((file) => {
          const path = file.path
          return (
            <DiffFile
              key={path}
              visible={tab.visible}
              file={file}
              review={{ source: data.kind === 'local' ? { kind: 'local', scope: data.scope } : { kind: 'change', url: data.url, headSha: data.headSha },
                addToInput: addReviewToInput,
                records: queue, openLink, reviewStarted: reviewState.comments.length > 0,
                onQuoted: (selection) => { if (!queue.recordAgent(selection)) report('review.saveFailed') },
                publishingBlocked: reviewState.uncertain !== null,
                ...data.kind === 'local' ? {} : {
                  queue: selection => queue.add(selection),
                  publish: selection => selection.source.kind === 'change'
                    ? publishReview(selection.source.url, { kind: 'comment', headSha: selection.source.headSha, comment: selection.comment },
                      url => queue.published(selection, url))
                    : Promise.resolve(t('review.stale')),
                },
              }}
              expanded={chosen[path] ?? initial.has(path)}
              onToggle={() => { setChosen(value => ({ ...value, [path]: !(value[path] ?? initial.has(path)) })) }}
              large={drawnLines(file) > LARGE_FILE_LINES}
              revealed={revealed.has(path)}
              onReveal={() => { setRevealed(value => new Set([...value, path])) }}
              text={current.texts[path]}
              open={current.open[path] ?? NO_GAPS}
              onExpand={(index) => { expand(data, file, index) }}
              split={split}
              wrap={wrap}
              badge={badgeOf(file, data, t)}
              tooltip={pathTooltipOf(file, t)}
              actions={fileActions(data, file)}
              sectionRef={(element) => {
                if (element === null) sections.current.delete(path)
                else sections.current.set(path, element)
              }}
              t={t}
            />
          )
        })}
        {orphanRecords}
      </div>
    )
  }
  const navigator: ChangedFilesProps = {
    files, state: treeState, t,
    filter: (query) => { setTreeState(value => ({ ...value, query })) },
    toggle: (path) => { setTreeState(value => ({ ...value, collapsed: { ...value.collapsed, [path]: value.collapsed[path] !== true } })) },
    jump,
  }
  // The toolbar collapses every file while any is expanded, as the files on screen show, and expands every file otherwise.
  const anyExpanded = files.some(file => chosen[file.path] ?? initial.has(file.path))
  const expansionLabel = t(anyExpanded ? 'diff.collapseAll' : 'diff.expandAll')
  const treeAction = t(treePosition === 'left' ? 'diff.moveFileTreeRight' : treePosition === 'right' ? 'diff.hideFileTree' : 'diff.showFileTreeLeft')
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  return (
    <div className={css.root} data-forge-changes={source.kind}>
      {source.kind === 'local'
        ? <LocalHeader state={state} scope={scope} createChangeRequest={createChangeRequest} t={t} />
        : <ChangeHeader url={source.url} entry={entry} openLink={openLink} reviewCount={reviewState.comments.length}
          reviewDisabled={data === null} onReview={() => { setReviewOpen(true) }} t={t} />}
      {!reviewOpen && reviewState.error !== null && <Notice>{t(reviewState.error === 'load' ? 'review.loadFailed' : 'review.saveFailed')}</Notice>}
      {!reviewOpen && reviewState.uncertain !== null && !reviewBusy && source.kind === 'change' && <div className={css.reviewNotice} role="alert">
        <span>{t('review.unknown')}</span>
        {reviewState.uncertain.kind === 'comment' && <blockquote>{reviewState.uncertain.comment.body}</blockquote>}
        <Button size="sm" variant="outline" onClick={() => { openLink(source.url) }}>{t('review.recheck')}</Button>
        <Button size="sm" variant="outline" onClick={() => { queue.finish(false); setReviewError(null) }}>{t('review.confirmRetry')}</Button>
      </div>}
      {!reviewOpen && reviewError !== null && reviewState.uncertain === null && <Notice>{reviewError}</Notice>}
      <div className={css.toolbar}>
        {tab.visible && source.kind === 'local' && <ScopeMenu scope={scope} choose={(next) => { actions.scoped(tab.id, next) }} t={t} />}
        {tab.visible && <ChangedFilesMenu {...navigator} visible />}
        {files.length > 0 && <span className={css.totals}><Counts file={{ additions, deletions, binary: false }} t={t} /></span>}
        <span className={css.tools}>
          <Tooltip label={t('diff.refresh')} side="bottom">
            <button type="button" className={css.tool} aria-label={t('diff.refresh')} onClick={refresh}>
              <RefreshGlyph busy={rereading} size={16} />
            </button>
          </Tooltip>
          <Tooltip label={expansionLabel} side="bottom">
            <button type="button" className={css.tool} data-expanded={anyExpanded ? '' : undefined} aria-label={expansionLabel}
              disabled={files.length === 0}
              onClick={() => { setChosen(Object.fromEntries(files.map(file => [file.path, !anyExpanded]))) }}>
              <IconChevronsUpDownOutlineRegular />
            </button>
          </Tooltip>
          <Tooltip label={t(split ? 'diff.unified' : 'diff.split')} side="bottom">
            <button type="button" className={css.tool} aria-pressed={split} aria-label={t('diff.splitAria')}
              onClick={() => { actions.toggledSplit(tab.id) }}>
              <IconCompareSplitOutlineRegular className={css.compareIcon} />
            </button>
          </Tooltip>
          <Tooltip label={t(wrap ? 'diff.nowrap' : 'diff.wrap')} side="bottom">
            <button type="button" className={css.tool} aria-pressed={wrap} aria-label={t('diff.wrapAria')}
              onClick={() => { actions.toggledWrap(tab.id) }}>
              {wrap ? <IconNowrapFillRegular /> : <IconWrapFillRegular />}
            </button>
          </Tooltip>
          <span className={css.treeToggle}>
            <Tooltip label={treeAction} side="bottom">
              <button type="button" className={css.tool} aria-label={treeAction} aria-expanded={treePosition !== 'hidden'}
                aria-controls={treeId} disabled={files.length === 0}
                onClick={() => { setTreePosition(value => value === 'left' ? 'right' : value === 'right' ? 'hidden' : 'left') }}>
                <IconWorkspaceTreeOutlineRegular />
              </button>
            </Tooltip>
          </span>
        </span>
      </div>
      {data !== null && failed !== null && (
        <Notice action={retry && <Button size="sm" variant="outline" className={css.noticeAction} onClick={refresh}>{t('retry')}</Button>}>
          {t(message ?? 'diff.error')}
        </Notice>
      )}
      {data?.kind === 'change' && data.localAhead !== null && data.localAhead > 0 && (
        <Notice>{t('diff.stale', { count: data.localAhead })}</Notice>
      )}
      {data?.kind === 'local' && data.omitted > 0 && <Notice>{t('diff.omitted', { count: data.omitted })}</Notice>}
      {reviewForm}
      <div className={css.body}>
        {body}
        {files.length > 0 && <FileTreePane {...navigator} id={treeId} position={treePosition} />}
      </div>
    </div>
  )
}

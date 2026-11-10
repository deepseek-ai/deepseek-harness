/**
 * Body of the changes tab: the local changes of the Session's checkout in a
 * chosen scope, or the changes of one of its change requests, as one list of
 * file sections under a toolbar that jumps between files and switches the
 * layout. The view reads the changes when it opens, on each navigation, on
 * refresh, and when the change request's head or the checkout's `branch`
 * scope summary changes; a read keeps the previous changes on screen until it settles.
 * File sections receive values that keep their identity across renders, so a
 * render of the view redraws only the sections whose own values changed, and
 * an expanded file draws its lines once its section comes near the scrollport.
 */

import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent,
  type ReactNode,
} from 'react'
import clsx from 'clsx'
import {
  Button, IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconChevronsUpDownOutlineRegular, IconCompareSplitOutlineRegular,
  IconInfoOutlineRegular, IconListPenOutlineRegular, IconNowrapFillRegular, IconRightUpOutlineRegular, IconWorkspaceTreeOutlineRegular,
  IconWrapFillRegular,
  Menu, StateDot, Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { fileAddressFor, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type {
  ForgeBaseBranch, ForgeBaseBranches, ForgeChangeRequestDiff, ForgeCommitRange, ForgeDiffFile, ForgeLocalCommits, ForgeLocalDiff,
  ForgeLocalScope, ForgePanelChangeRequest, ForgePanelState,
} from '../types.ts'
import type {
  ForgeCommitList, ForgeReviewData, ForgeReviewRequest, ForgeReviewResult, ForgeReviewThread, ForgeReviewWrite, ForgeReviewWriteResult,
  ForgeThreadId, ForgeViewedFiles, ForgeViewedRequest,
} from '@deepseek-ai/dsh-experimental-forge/types'
import { sameReviewSource, type ReviewQueue } from './review-queue.ts'
import { ReviewThread, useFileReview } from './ReviewThread.tsx'
import type { ReviewActions } from './ReviewComposer.tsx'
import { SubmitReview } from './SubmitReview.tsx'
import type { ReviewSelection, ReviewSource } from './review.ts'
import { BaseMenu } from './BaseMenu.tsx'
import { parseChangesAddress, type ChangesSource } from './changes-address.ts'
import type { ChangesLens, createChangesStore } from './changes-store.ts'
import { CommitMenu } from './CommitMenu.tsx'
import { HideTestsSwitch, LensControl, LensMenu, LENSES, ViewedProgress } from './ReviewControls.tsx'
import { viewedStateOf, type ViewedFiles, type ViewedMarks } from './viewed-files.ts'
import { hostViewedOf, useHostViewed, type HostViewed } from './host-viewed.ts'
import { Counts, DiffFile, type DiffFileAction, type DiffFileHandlers } from './DiffFile.tsx'
import { SectionReach } from './section-reach.ts'
import { FileTreePane, type FileTreePosition } from './FileTreePane.tsx'
import { changedFileTree, filesInTreeOrder } from './file-tree.ts'
import { ChangedFilesMenu, type ChangedFilesProps, type ChangedFilesState } from './ChangedFiles.tsx'
import { drawnLines, matchesHunks, textLines } from './diff-rows.ts'
import { ChangeRequestGlyph } from './glyphs.tsx'
import type { ForgePanelKey, NS } from './locales.ts'
import { RefreshGlyph } from './RefreshGlyph.tsx'
import { ViewOptionsMenu } from './ViewOptionsMenu.tsx'
import { observeToolbarFold } from './toolbar-fold.ts'
import type { FileThreads, ThreadActions, ThreadFocus, ThreadWrite } from './ReviewThreads.tsx'
import { inFileOrder, type ThreadFilter } from './review-threads.ts'
import { usePlacedThreads, useThreadRead, type PlacedThread } from './thread-state.ts'
import { ThreadList } from './ThreadList.tsx'
import type { PanelSnapshot } from './source.ts'
import { numberOf, openChangeRequestOf, TONE_LABEL, toneOf } from './status.ts'
import css from './ChangesTab.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Kind of a local scope. */
type ScopeKind = ForgeLocalScope['kind']

/** A file the view scrolls to once, and the thread card it centers there with whether that card takes the focus. */
interface Wanted {
  readonly path: string
  readonly center: { readonly id: ForgeThreadId; readonly focus: boolean } | null
}

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
  /** Read the branches the `branch` scope can compare with, whose names contain `query`; `signal` aborts the read. */
  readonly diffBases: (query: string, signal: AbortSignal) => Promise<RemoteResult<ForgeBaseBranches>>
  /** Read the new side of one file in a local scope. */
  readonly localText: (scope: ForgeLocalScope, path: string) => Promise<RemoteResult<string>>
  /** List the commits of the `branch` scope compared with `base`, or with the automatic fork point for null; `signal` aborts the read. */
  readonly localCommits: (base: string | null, signal: AbortSignal) => Promise<RemoteResult<ForgeLocalCommits>>
  /** Read the changes of a change request, or of consecutive commits of it, by its binding URL; `signal` aborts the read. */
  readonly changeRequestDiff: (
    url: string, commits: ForgeCommitRange | null, signal: AbortSignal,
  ) => Promise<RemoteResult<ForgeChangeRequestDiff>>
  /** List the commits of a change request, or null when its provider does not read commits; `signal` aborts the read. */
  readonly changeRequestCommits: (url: string, signal: AbortSignal) => Promise<RemoteResult<ForgeCommitList | null>>
  /** The Session's viewed marks, kept in the browser for local changes, chosen commits, and hosts that keep none. */
  readonly viewedFiles: ViewedFiles
  /**
   * Read the signed-in user's viewed marks on a change request's files at `headSha`, or null when its provider keeps
   * none; `signal` aborts the read.
   */
  readonly changeRequestViewed: (url: string, headSha: string, signal: AbortSignal) => Promise<RemoteResult<ForgeViewedFiles | null>>
  /** Set or clear the signed-in user's viewed mark on one file of a change request. */
  readonly setFileViewed: (url: string, request: ForgeViewedRequest) => Promise<RemoteResult<void>>
  /** Read one file of a change request at a commit. */
  readonly changeRequestText: (url: string, commit: string, path: string) => Promise<RemoteResult<string>>
  /** Read the review threads of a change request at the head of its latest status; `signal` aborts the read. */
  readonly changeRequestReview: (
    url: string, headSha: string, fresh: boolean, signal: AbortSignal,
  ) => Promise<RemoteResult<ForgeReviewData>>
  /** Write to the review threads or the pending review of a change request; never retries a write. */
  readonly changeRequestReviewWrite: (url: string, write: ForgeReviewWrite) => Promise<RemoteResult<ForgeReviewWriteResult>>
  /** Quote a whole review thread of the change request at `url` in the main input without submitting it. */
  readonly addThreadToInput: (thread: ForgeReviewThread, url: string, range: string | null) => boolean
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
    readonly scope: ForgeLocalScope
    /** Name of what the `branch` scope compared with; null for other scopes. */
    readonly base: string | null
    /** Untracked files left out. */
    readonly omitted: number
  }
  | {
    readonly kind: 'change'
    readonly files: readonly ForgeDiffFile[]
    /** Binding URL of the change request. */
    readonly url: string
    /** Commit the files end at, the head or the last chosen commit, which supplies unchanged lines. */
    readonly headSha: string
    /** Commits the files cover, or null for the whole change request. */
    readonly commits: ForgeCommitRange | null
    /** Commits the checkout's branch has beyond the head, or null. */
    readonly localAhead: number | null
    /** Web page of each file at the head. */
    readonly fileUrls: Readonly<Record<string, string>>
    /** The code host's viewed marks of the whole change request, or null when the browser keeps the marks. */
    readonly viewed: HostViewed | null
  }

/** Why the code host did not take a review write, and whether it may have applied it. */
interface WriteRefusal {
  readonly message: string
  readonly unknown: boolean
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
  'forgePanel/commits-missing': 'commits.missing',
  'forgePanel/commits-not-linear': 'commits.notLinear',
}

/** Failures of a chosen base branch, which offer the automatic fork point instead of a retry. */
const BASE_FAILURE: Partial<Record<string, ForgePanelKey>> = {
  'forgePanel/base-missing': 'diff.baseMissing',
  'forgePanel/no-fork-point': 'diff.baseUnrelated',
}

/**
 * Explain a failure of the `branch` scope that its chosen base branch caused.
 * @param failed - code of the failed read, or null.
 * @param base - branch the read compared with, or null for the automatic fork point and other scopes.
 * @param t - forge panel copy.
 * @returns the message naming the branch, or undefined for another failure or without a chosen branch.
 */
function baseFailureOf(failed: string | null, base: ForgeBaseBranch | null, t: Translate): string | undefined {
  const key = failed === null ? undefined : BASE_FAILURE[failed]
  return key === undefined || base === null ? undefined : t(key, { base: base.name })
}

/**
 * Read the changes a view shows. The whole change request also reads the host's viewed marks at the head of the latest
 * status, beside the diff; marks read at another head refuse the read as the diff refuses a moved head.
 * @param source - local changes or a change request.
 * @param scope - local scope to read.
 * @param commits - chosen commits of a change request, or null for all of it.
 * @param head - head commit of the change request's latest status, or null.
 * @param reads - the Remote reads.
 * @param signal - cancellation of the reads.
 * @returns the changes, or why they could not be read.
 */
async function readChanges(
  source: ChangesSource,
  scope: ForgeLocalScope,
  commits: ForgeCommitRange | null,
  head: string | null,
  reads: Pick<ChangesTabInjected, 'localDiff' | 'changeRequestDiff' | 'changeRequestViewed'>,
  signal: AbortSignal,
): Promise<RemoteResult<ChangesData>> {
  if (source.kind === 'local') {
    const result = await reads.localDiff(scope, signal)
    if (!result.ok) return result
    const { files, base, omitted } = result.value
    return { ok: true, value: { kind: 'local', files, scope, base, omitted } }
  }
  const [result, marks] = await Promise.all([
    reads.changeRequestDiff(source.url, commits, signal),
    commits === null && head !== null && head !== '' ? reads.changeRequestViewed(source.url, head, signal) : Promise.resolve(null),
  ])
  if (!result.ok) return result
  if (marks !== null && !marks.ok && marks.error.code === 'forgePanel/stale-head') return marks
  const { files, headSha, localAhead, fileUrls } = result.value
  const viewed = hostViewedOf(marks, headSha)
  return { ok: true, value: { kind: 'change', files, url: source.url, headSha, commits, localAhead, fileUrls, viewed } }
}

/** The ref that identifies a comparison: the chosen base branch, or null for the automatic fork point and other scopes. */
function baseRefOf(scope: ForgeLocalScope): string | null {
  return scope.kind === 'branch' ? scope.base : null
}

/** The commits a local scope shows, or null for all of them and for scopes other than `branch`. */
function commitsOf(scope: ForgeLocalScope): ForgeCommitRange | null {
  return scope.kind === 'branch' ? scope.commits : null
}

/** The source review comments on loaded changes record: the change request head, or the local scope with its base. */
function reviewSourceOf(data: ChangesData): ReviewSource {
  return data.kind === 'local'
    ? { kind: 'local', scope: data.scope.kind, base: data.base, baseRef: baseRefOf(data.scope), commits: commitsOf(data.scope) }
    : { kind: 'change', url: data.url, headSha: data.headSha, commits: data.commits }
}

/**
 * Identity of a diff source for viewed marks: the change request or local scope with its base ref and chosen commits.
 * A change request's marks stay across head commits, so a file whose change a new push altered reads as changed.
 */
function viewedSourceOf(source: ReviewSource): string {
  return JSON.stringify(source.kind === 'local'
    ? ['local', source.scope, source.baseRef, source.commits]
    : ['change', source.url, source.commits])
}

/**
 * The files that start expanded: every file not marked viewed until those above it change more than {@link OPEN_LINES} lines.
 * @param files - every file in display order.
 * @param marks - the viewed marks when the files loaded.
 * @returns the paths of the expanded files.
 */
function initiallyOpen(files: readonly ForgeDiffFile[], marks: ViewedMarks): ReadonlySet<string> {
  const open = new Set<string>()
  let above = 0
  for (const file of files) {
    if (above > OPEN_LINES) break
    if (viewedStateOf(marks, file.path, file.digest) === 'viewed') continue
    open.add(file.path)
    above += drawnLines(file)
  }
  return open
}

/** Whether a file shows under a lens while test files hide or not. */
function shownBy(file: ForgeDiffFile, lens: ChangesLens, hideTests: boolean): boolean {
  return !(hideTests && file.layer === 'test') && (lens === 'all' || file.layer === lens)
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
  if (file.untracked && data.kind === 'local' && data.scope.kind === 'branch') parts.push(t('diff.badgeUncommitted'))
  return parts.join(' · ')
}

function ChangeHeader({ url, entry, openLink, commitMenu, reviewCount, reviewDisabled, onReview, t }: {
  readonly url: string
  readonly entry: ForgePanelChangeRequest | undefined
  /** Commit picker left of the review button. */
  readonly commitMenu: ReactNode
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
      <span className={css.headerEnd}>
        {commitMenu}
        <Button size="sm" variant="outline" className={css.headerAction} disabled={reviewDisabled} onClick={onReview}>
          {t('review.submit')}{reviewCount > 0 ? ` (${reviewCount})` : ''}
        </Button>
      </span>
      <Tooltip label={t('change.view')} side="bottom">
        <button type="button" className={css.tool} aria-label={t('change.view')} onClick={() => { openLink(href) }}>
          <IconRightUpOutlineRegular size={14} />
        </button>
      </Tooltip>
    </div>
  )
}

/**
 * The local view's header: for the `branch` scope, the checked-out branch, the base branch picker, and a note
 * that uncommitted changes count; for another scope, what it compares.
 */
function LocalHeader({ state, scope, base, missing, visible, diffBases, choose, commitMenu, createChangeRequest, t }: {
  readonly state: ForgePanelState | null
  /** Commit picker of the `branch` scope, left of the create button. */
  readonly commitMenu: ReactNode
  readonly scope: ScopeKind
  readonly base: ForgeBaseBranch | null
  /** Whether the chosen base branch no longer exists. */
  readonly missing: boolean
  readonly visible: boolean
  readonly diffBases: ChangesTabInjected['diffBases']
  readonly choose: (base: ForgeBaseBranch | null) => void
  readonly createChangeRequest: () => void
  readonly t: Translate
}): ReactNode {
  const creatable = state !== null && state.repository !== null && openChangeRequestOf(state) === undefined
  const checkout = state?.checkout.state === 'ready' ? state.checkout.checkout : null
  const head = checkout?.branch ?? checkout?.commit ?? 'HEAD'
  return (
    <div className={css.header}>
      {scope === 'branch' ? <>
        <span className={css.headerIcon}><IconBranchOutlineRegular size={15} /></span>
        <Tooltip label={head} side="bottom">
          <span className={css.headerHead} tabIndex={0} data-forge-head="">{head}</span>
        </Tooltip>
        <span className={css.headerArrow} aria-hidden="true">→</span>
        <BaseMenu chosen={base} label={base?.name ?? state?.local?.base ?? t('diff.base.automatic')} missing={missing}
          visible={visible} list={diffBases} choose={choose} t={t} />
        <span className={clsx(css.headerNote, css.headerSuffix)}>{t('diff.base.uncommitted')}</span>
      </> : <>
        <span className={css.headerIcon}><IconListPenOutlineRegular size={15} /></span>
        <span className={css.headerNote}>{t(SCOPE_NOTE[scope])}</span>
      </>}
      {(scope === 'branch' || creatable) && <span className={css.headerEnd}>
        {scope === 'branch' && commitMenu}
        {creatable && <Button size="sm" variant="outline" className={css.headerAction} onClick={createChangeRequest}>{t('changes.local.create')}</Button>}
      </span>}
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
      actions={actions} locked={state.locked} outdated t={t} />)}
  </section>
}

/**
 * Render the changes tab of one Session.
 * @param props - tab information, the tab's choices, the panel snapshot hook, reads and actions, and copy.
 * @returns the view body.
 */
export function ChangesTab({
  useTabInfo, sessionId, useStore, actions, usePanel, reconnect, localDiff, diffBases, localText, localCommits, changeRequestDiff,
  changeRequestText, changeRequestCommits, changeRequestReview, changeRequestReviewWrite, viewedFiles, changeRequestViewed, setFileViewed,
  openLink, copyPath, createChangeRequest, addReviewToInput, addThreadToInput, reviewQueue, submitReview, report, t,
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
  // Every write that may have changed the threads reads them again; writes run one at a time, so a write that starts a
  // pending review settles before the next write looks for one.
  const [reviewRevision, setReviewRevision] = useState(0)
  const writing = useRef<Promise<unknown>>(Promise.resolve())
  /**
   * Send one write after the earlier ones.
   * @returns undefined once the host took it, else its message and whether its outcome is unknown.
   */
  const sendWrite = (url: string, write: ForgeReviewWrite): Promise<WriteRefusal | undefined> => {
    const run = async (): Promise<WriteRefusal | undefined> => {
      const response = await changeRequestReviewWrite(url, write)
      if (!response.ok) {
        if (response.error.code === 'forgePanel/not-bound') {
          return { message: t('thread.writeFailed', { message: response.error.message }), unknown: false }
        }
        setReviewRevision(value => value + 1)
        return { message: t('thread.writeUnknown'), unknown: true }
      }
      const result = response.value
      if (result.ok) {
        setReviewRevision(value => value + 1)
        return undefined
      }
      switch (result.code) {
        case 'unsupported': return { message: t('thread.writeUnsupported'), unknown: false }
        case 'failed':
          setReviewRevision(value => value + 1)
          return { message: t('thread.writeFailed', { message: result.message }), unknown: false }
        case 'stale': return { message: t('thread.writeStale'), unknown: false }
        case 'unknown':
          setReviewRevision(value => value + 1)
          return { message: t('thread.writeUnknown'), unknown: true }
        /* v8 ignore next -- closed ForgeReviewWriteResult code union exhaustiveness guard */
        default: return assertNever(result.code, 'ForgeReviewWriteResult.code')
      }
    }
    const next = writing.current.then(run, run)
    writing.current = next
    return next
  }
  const writeReview = async (url: string, write: ForgeReviewWrite): Promise<string | undefined> => (await sendWrite(url, write))?.message
  const choices = useStore(store => store.byTab[tab.id])
  const [wanted, setWanted] = useState<Wanted | null>(null)
  const [treeState, setTreeState] = useState<ChangedFilesState>({ query: '', collapsed: {}, selected: null })
  const [treePosition, setTreePosition] = useState<FileTreePosition>('left')
  const [treeWidth, setTreeWidth] = useState(0)
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
    setWanted({ path, center: null })
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
  const base = choices?.base ?? null
  const chosenCommits = choices?.commits ?? null
  const lens = choices?.lens ?? 'all'
  const hideTests = choices?.hideTests ?? false
  const localScope = useMemo((): ForgeLocalScope => scope === 'branch'
    ? { kind: 'branch', base: base?.ref ?? null, commits: chosenCommits } : { kind: scope }, [scope, base, chosenCommits])
  const changeCommits = source.kind === 'change' ? chosenCommits : null
  const changeUrlOf = source.kind === 'change' ? source.url : ''
  const listChangeCommits = useCallback(
    (signal: AbortSignal) => changeRequestCommits(changeUrlOf, signal), [changeRequestCommits, changeUrlOf],
  )
  const baseRef = base?.ref ?? null
  const listLocalCommits = useCallback((signal: AbortSignal) => localCommits(baseRef, signal), [localCommits, baseRef])
  const split = choices?.split ?? true
  const wrap = choices?.wrap ?? true
  const entry = source.kind === 'change' ? state?.changeRequests.find(item => item.url === source.url) : undefined
  // A read starts once the panel state arrives and again when what it describes moves. A change request's read
  // also waits for its first status, which names the head, unless no provider serves it or its first poll failed.
  const pending = entry !== undefined && entry.ref !== null && entry.update === null
  const head = entry?.snapshot?.headSha ?? (pending ? null : '')
  const version = state === null ? null : source.kind === 'local' ? `${scope}\n${JSON.stringify(state.local)}` : head
  const headCommit = state !== null && state.checkout.state === 'ready' ? state.checkout.checkout.commit : null
  // The commits change with the head of a change request, with the local HEAD, branch, or base, and on a refresh.
  const commitsVersion = `${attempt}\n${source.kind === 'local'
    ? `${baseRef ?? ''}\n${headCommit ?? ''}\n${JSON.stringify(state?.local ?? null)}` : head ?? ''}`
  const dataKey = source.kind === 'local' ? JSON.stringify(localScope) : `change\n${JSON.stringify(changeCommits)}`
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly data: ChangesData } | null>(null)
  const [failure, setFailure] = useState<{ readonly key: string; readonly code: string } | null>(null)
  // Names the read the inputs ask for; it is in flight until `finished` matches it.
  const read = version === null ? null : `${dataKey}\n${navigation.revision}\n${attempt}\n${version}`
  const [finished, setFinished] = useState<string | null>(null)
  // A change request read refused because the head moved past its status stays in flight until a status later than
  // the one the read started with arrives; one that arrived during the read starts the next read at once.
  const statusAt = entry?.update?.fetchedAt ?? null
  const latestStatusAt = useRef(statusAt)
  useEffect(() => { latestStatusAt.current = statusAt }, [statusAt])
  const [refused, setRefused] = useState<{ readonly read: string; readonly statusAt: number | null } | null>(null)
  const waiting = refused !== null && refused.read === read && refused.statusAt === statusAt
  useEffect(() => {
    if (!tab.visible || read === null || read === finished || waiting) return
    const controller = new AbortController()
    const readAt = latestStatusAt.current
    void readChanges(source, localScope, changeCommits, head, { localDiff, changeRequestDiff, changeRequestViewed }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        if (!result.ok && result.error.code === 'forgePanel/stale-head') {
          setRefused({ read, statusAt: readAt })
          setFailure(null)
          return
        }
        setFinished(read)
        if (result.ok) {
          setLoaded({ key: dataKey, data: result.value })
          setFailure(null)
        } else {
          setFailure({ key: dataKey, code: result.error.code })
        }
      })
    return () => { controller.abort() }
  }, [tab.visible, read, refused, waiting, source, localScope, changeCommits, head, dataKey, localDiff, changeRequestDiff,
    changeRequestViewed])
  const data = loaded !== null && loaded.key === dataKey ? loaded.data : null
  // Threads show only while they were read at the head of the latest status and, for the whole change request, at
  // the head the shown diff was read at, so their positions number the shown files.
  const prHead = entry?.snapshot?.headSha ?? null
  const prAuthor = entry?.snapshot?.author ?? null
  const threadRead = useThreadRead({ visible: tab.visible, url: source.kind === 'change' ? source.url : null, head: prHead,
    updatedAt: entry?.snapshot?.updatedAt ?? null, statusAt, attempt, revision: reviewRevision, read: changeRequestReview })
  const review = data?.kind === 'change' && threadRead.review !== null && threadRead.review.headSha === prHead
    && (data.commits !== null || data.headSha === prHead) ? threadRead.review : null
  const placed = usePlacedThreads(review, data?.kind === 'change' ? { head: prHead ?? '', end: data.headSha, commits: data.commits } : null)
  const [threadList, setThreadList] = useState<{
    readonly open: boolean
    readonly filter: ThreadFilter
    /** Whether the reader just opened the list and it has not taken the focus yet. */
    readonly claim: boolean
  }>({ open: false, filter: 'unresolved', claim: false })
  const threadsToggle = useRef<HTMLButtonElement>(null)
  const [focus, setFocus] = useState<ThreadFocus | null>(null)
  const allFiles = useMemo(() => filesInTreeOrder(changedFileTree(data?.files ?? [])), [data])
  const files = useMemo(() => allFiles.filter(file => shownBy(file, lens, hideTests)), [allFiles, lens, hideTests])
  const lensCounts = useMemo(() => Object.fromEntries(LENSES.map(item => [item,
    allFiles.filter(file => shownBy(file, item, hideTests)).length])) as Record<ChangesLens, number>, [allFiles, hideTests])
  const shownSource = useMemo(() => data === null ? null : reviewSourceOf(data), [data])
  const viewedKey = shownSource === null ? '' : viewedSourceOf(shownSource)
  const localMarks = useSyncExternalStore(viewedFiles.subscribe, () => viewedFiles.marksOf(viewedKey))
  const hostOwner = useMemo(() => data?.kind === 'change' && data.viewed !== null
    ? { url: data.url, headSha: data.headSha, files: data.files, viewed: data.viewed } : null, [data])
  const host = useHostViewed(hostOwner, setFileViewed, (failure) => {
    if (failure.kind === 'stale') report('viewed.syncStale')
    else if (failure.kind === 'unknown') report('viewed.syncUnknown', { message: failure.message })
    else report('viewed.syncFailed', { message: failure.message })
  })
  const marks = host?.marks ?? localMarks
  // The centered loader marks a first read; the toolbar's glyph turns only while shown changes are read again.
  const rereading = read !== null && finished !== read && data !== null
  const failed = failure !== null && failure.key === dataKey ? failure.code : null
  const [expansion, setExpansion] = useState<Expansion>({ data: null, texts: {}, open: {} })
  const current = expansion.data === data ? expansion : { data, texts: {}, open: {} }
  const latest = useRef(data)
  useEffect(() => { latest.current = data }, [data])
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set())
  // The line budget counts the files not marked viewed when the diff loads, so later marks leave it unchanged. A file stays
  // collapsed while it is marked viewed unless the reader expands it; a file whose change differs from its mark expands
  // like an unmarked one.
  const initial = useMemo(() => initiallyOpen(allFiles, marks), [allFiles])
  const expandedByDefault = (file: ForgeDiffFile): boolean => initial.has(file.path) && viewedStateOf(marks, file.path, file.digest) !== 'viewed'
  const isExpanded = (file: ForgeDiffFile): boolean => chosen[file.path] ?? expandedByDefault(file)
  const sections = useRef(new Map<string, HTMLElement>())
  const scrollport = useRef<HTMLDivElement | null>(null)
  const toolbarRow = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const row = toolbarRow.current
    /* v8 ignore next -- the toolbar row renders in every state of the view */
    if (row === null) return
    return observeToolbarFold(row)
  }, [])
  const reach = useMemo(() => new SectionReach(), [])
  const attachScrollport = useCallback((element: HTMLDivElement | null) => {
    scrollport.current = element
    reach.attach(element)
  }, [reach])
  // A short final file cannot align with the viewport top; retain its jump until the reader scrolls away.
  const jumpPosition = useRef<{ readonly data: ChangesData; readonly top: number } | null>(null)
  useLayoutEffect(() => {
    if (!tab.visible || wanted === null || data === null) return
    // A file the lens or the test switch hides is shown before the view scrolls to it.
    const hidden = allFiles.find(file => file.path === wanted.path && !shownBy(file, lens, hideTests))
    if (hidden !== undefined) {
      if (lens !== 'all') actions.lensed(tab.id, 'all')
      if (hideTests && hidden.layer === 'test') actions.toggledTests(tab.id)
      return
    }
    // The browser's scroll anchoring keeps the section in place while the sections above it draw their lines.
    const section = sections.current.get(wanted.path)
    section?.scrollIntoView({ block: 'start' })
    // A thread the reader opened from the thread list or a file's unresolved count centers inside its file, which the jump
    // expanded and revealed; the jump ends here, so a later jump to the file stops at its header.
    const { center } = wanted
    if (center !== null) {
      /* v8 ignore next 4 -- a centered thread's file is drawn and its card unfolded, so both are found. */
      const card = [...section?.querySelectorAll<HTMLElement>('[data-forge-thread]') ?? []]
        .find(element => element.dataset.forgeThread === center.id)
      card?.scrollIntoView({ block: 'center' })
      if (center.focus) card?.focus({ preventScroll: true })
    }
    if (scrollport.current !== null) jumpPosition.current = { data, top: scrollport.current.scrollTop }
    setWanted(null)
  }, [tab.visible, wanted, data, allFiles, lens, hideTests, actions, tab.id])
  const refresh = (): void => { setAttempt(value => value + 1) }
  const root = state !== null && state.checkout.state === 'ready' ? state.checkout.checkout.root : null
  // A chosen base branch that is gone or shares no history with HEAD offers the automatic fork point instead.
  const baseFailure = baseFailureOf(failed, source.kind === 'local' && scope === 'branch' ? base : null, t)
  // Configuration reads may recover after the user fixes Git settings or raises the output limit.
  const message = failed === null ? undefined : FAILURE[failed]
  const failureText = baseFailure ?? t(message ?? 'diff.error')
  const changeUrl = source.kind === 'change' ? entry?.snapshot?.url ?? source.url : null
  const retry = baseFailure === undefined && (message === undefined || failed === 'forgePanel/filter-config-failed')
  const automaticBase = baseFailure !== undefined ? (
    <Button size="sm" variant="outline" onClick={() => { actions.based(tab.id, null) }}>{t('diff.useAutomaticBase')}</Button>
  ) : (failed === 'forgePanel/commits-missing' || failed === 'forgePanel/commits-not-linear') && (
    <Button size="sm" variant="outline" onClick={() => { actions.committed(tab.id, null) }}>{t('commits.showAll')}</Button>
  )

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
    const reading = owner.kind === 'local' ? localText(owner.scope, path) : changeRequestText(owner.url, owner.headSha, path)
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

  // A review addresses the head commit, so it is submitted from the view of the whole change request. A pending review on
  // the code host is submitted or discarded there; without one, the summary and any comment drafts kept in the browser
  // are published as one review.
  const pendingReview = review?.pendingReview ?? null
  // Logins compare without case, as GitHub's do.
  const ownChangeRequest = review?.viewer != null && prAuthor !== null && review.viewer.toLowerCase() === prAuthor.toLowerCase()
  const finishWrite = async (send: () => Promise<string | undefined>, done: ForgePanelKey): Promise<void> => {
    if (reviewRunning.current) return
    reviewRunning.current = true
    setReviewBusy(true)
    setReviewError(null)
    try {
      const failure = await send()
      if (failure !== undefined) {
        setReviewError(failure)
        return
      }
      report(done)
      setReviewOpen(false)
    } finally {
      reviewRunning.current = false
      setReviewBusy(false)
    }
  }
  const reviewForm = tab.visible && data !== null && reviewOpen && data.kind === 'change' && data.commits === null && <SubmitReview queue={queue}
    url={data.url} headSha={data.headSha} pending={pendingReview} own={ownChangeRequest} busy={reviewBusy} error={reviewError}
    close={() => { setReviewOpen(false) }}
    check={() => { openLink(data.url) }} reconcile={() => { queue.finish(false); setReviewError(null) }}
    submit={() => {
      const latest = queue.getSnapshot()
      if (pendingReview === null) {
        void publishReview(data.url, { kind: 'review', headSha: data.headSha, event: latest.event,
          body: latest.body, comments: latest.comments.map(item => item.comment) }, url => queue.finish(true, url))
        return
      }
      // The submission is kept as the write to reconcile until the host answers, so an unknown outcome blocks another
      // submission, which would otherwise publish a second review once the pending review no longer reads.
      void finishWrite(async () => {
        if (!queue.begin({ kind: 'review', headSha: data.headSha, event: latest.event, body: latest.body, comments: [] })) {
          return t('review.saveFailed')
        }
        const refusal = await sendWrite(data.url, { kind: 'submit-pending', headSha: data.headSha, review: pendingReview.id,
          event: latest.event, body: latest.body })
        if (refusal === undefined) {
          if (!queue.finish(true)) report('review.saveFailed')
          return undefined
        }
        if (!refusal.unknown) queue.finish(false)
        return refusal.message
      }, 'review.submitted')
    }}
    discard={pendingReview === null ? undefined : () => {
      void finishWrite(() => writeReview(data.url, { kind: 'discard-pending', headSha: data.headSha, review: pendingReview.id }), 'review.discarded')
    }} t={t} />

  /** Add a comment to the pending review on the code host at the head the comment was selected on. */
  const addPending = (selection: ReviewSelection): Promise<string | undefined> => {
    if (selection.source.kind !== 'change') return Promise.resolve(t('review.stale'))
    const { path, side, startLine, endLine, body } = selection.comment
    return writeReview(selection.source.url, { kind: 'add-pending', headSha: selection.source.headSha, comment: { path, side, startLine, endLine, body } })
  }

  const recordActions: ReviewActions = {
    source: shownSource ?? (source.kind === 'local'
      ? { kind: 'local', scope, base: null, baseRef: baseRefOf(localScope), commits: commitsOf(localScope) }
      : { kind: 'change', url: source.url, headSha: '', commits: changeCommits }),
    records: queue, addToInput: addReviewToInput, openLink,
  }
  const absentPaths = [...new Set([...reviewState.comments, ...reviewState.records.map(item => item.selection)]
    .filter(item => sameReviewSource(item.source, recordActions.source)).map(item => item.comment.path))]
    .filter(path => !data?.files.some(file => file.path === path))
  const orphanRecords = absentPaths.map(path => <OrphanReviews key={path} path={path} actions={recordActions} t={t} />)

  // Thread groups keep their identity across renders that change neither the threads nor what their cards share, so
  // only the sections whose threads changed redraw.
  const url = data?.kind === 'change' ? data.url : null
  const threadActions = useMemo((): ThreadActions | null => review === null || url === null ? null : {
    author: prAuthor,
    addToInput: (thread, range) => addThreadToInput(thread, url, range),
    openLink,
    readText: (commit, path) => changeRequestText(url, commit, path),
    inputFailed: () => { live.current.report('thread.inputFailed') },
    focused: focus,
    writes: {
      write: (write: ThreadWrite) => live.current.writeReview(url, { ...write, headSha: review.headSha }),
      reviewStarted: review.pendingReview !== null,
      canReview: review.viewerCanReview,
    },
  }, [review, url, prAuthor, addThreadToInput, openLink, changeRequestText, focus])
  const fileThreads = useMemo(() => new Map<string, FileThreads>(threadActions === null ? []
    : [...placed.files].map(([path, group]) => [path, { ...group, actions: threadActions }])), [placed.files, threadActions])
  /** Show a file's next unresolved thread in display order after the one last shown, or its first. */
  const nextThread = (path: string): void => {
    const order = inFileOrder(placed.entries.filter(({ thread }) => thread.path === path && !thread.resolved),
      allFiles.find(file => file.path === path))
    const next = order[(order.findIndex(({ thread }) => thread.id === focus?.id) + 1) % order.length]
    /* v8 ignore next -- the count that calls this shows only while the file has an unresolved thread. */
    if (next !== undefined) openThread(next, false)
  }
  /** Close the thread list at the reader's request and return the focus to its toggle. */
  const closeThreadList = (): void => {
    setThreadList(value => ({ ...value, open: false }))
    threadsToggle.current?.focus()
  }
  /**
   * Show a thread: all commits for a thread the chosen ones do not hold, whose diff holds the file of every thread with a
   * position at the head, then its file, with the thread unfolded and centered; `focusCard` moves the focus to it. A
   * thread on a file the shown changes lack opens on the host.
   */
  const openThread = ({ thread, place }: PlacedThread, focusCard: boolean): void => {
    if (place.kind === 'elsewhere') actions.committed(tab.id, null)
    else if (!allFiles.some(file => file.path === thread.path)) {
      const url = thread.comments[0]?.url ?? null
      if (url !== null) openLink(url)
      return
    }
    setFocus(value => ({ id: thread.id, revision: (value?.revision ?? 0) + 1 }))
    setRevealed(value => new Set([...value, thread.path]))
    jump(thread.path, { id: thread.id, focus: focusCard })
  }
  const jump = (path: string, center: Wanted['center'] = null): void => {
    setTreeState(value => ({ ...value, selected: path }))
    setChosen(value => ({ ...value, [path]: true }))
    setWanted({ path, center })
  }
  /**
   * The file being read: the file last jumped to while the scroll stays there, else the first file whose section still
   * reaches below the viewport top, so the gap between two cards at the top belongs to the file after it; past the last
   * section, the last file.
   */
  const currentIndex = (viewport: HTMLElement): number => {
    const remembered = jumpPosition.current
    const index = remembered !== null && remembered.data === data && remembered.top === viewport.scrollTop
      ? files.findIndex(file => file.path === treeState.selected) : -1
    if (index >= 0) return index
    const top = viewport.getBoundingClientRect().top
    const reading = files.findIndex((file) => {
      const section = sections.current.get(file.path)
      return section !== undefined && section.getBoundingClientRect().bottom > top + 1
    })
    return reading >= 0 ? reading : Math.max(0, files.length - 1)
  }
  /** Whether a key press belongs to a field, a comment, a menu, or a text selection rather than to the file list. */
  const typing = (container: HTMLElement, origin: EventTarget): boolean => {
    const selection = window.getSelection()
    return !(origin instanceof HTMLElement) || !container.contains(origin)
      || origin.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-forge-comment], [role="menu"]') !== null
      || (selection !== null && !selection.isCollapsed)
  }
  const navigateFiles = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!tab.visible || event.defaultPrevented || event.nativeEvent.isComposing
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    const viewport = event.currentTarget
    if (typing(viewport, event.target)) return
    const index = currentIndex(viewport)
    event.preventDefault()
    event.stopPropagation()
    const next = files[index + (event.key === 'ArrowRight' ? 1 : -1)]
    if (next === undefined) return
    viewport.focus({ preventScroll: true })
    jump(next.path)
  }
  /** Mark a file viewed and collapse it, keeping its header in view, or clear its mark and expand it. */
  const markViewed = (owner: ChangesData, file: ForgeDiffFile, viewed: boolean): void => {
    if (host !== null) {
      if (!host.mark(file.path, viewed)) return
    } else if (!viewedFiles.mark(viewedKey, owner.files, file.path, viewed)) {
      report('viewed.saveFailed')
      return
    }
    const section = sections.current.get(file.path)
    const viewport = scrollport.current
    if (viewed && section !== undefined && viewport !== null
      && section.getBoundingClientRect().top < viewport.getBoundingClientRect().top) setWanted({ path: file.path, center: null })
    // A new mark collapses the file through its default; clearing a mark expands it.
    setChosen(({ [file.path]: _choice, ...value }) => viewed ? value : { ...value, [file.path]: true })
  }
  /** The shown file whose section holds an element or a text node, if any. */
  const fileAt = (target: EventTarget | null | undefined): ForgeDiffFile | undefined => {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    const path = element?.closest('[data-forge-diff-file]')?.getAttribute('data-forge-diff-file')
    return files.find(file => file.path === path)
  }
  // `V` marks or clears the file being read, from anywhere in the tab except fields, comments, and menus: the file
  // holding the focus, else the one holding the text cursor, as after clicking its code, else the file at the top.
  const toggleViewed = (event: KeyboardEvent<HTMLDivElement>): void => {
    const viewport = scrollport.current
    if (!tab.visible || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey
      || event.key.toLowerCase() !== 'v' || viewport === null || data === null || typing(event.currentTarget, event.target)) return
    const file = fileAt(event.target) ?? fileAt(window.getSelection()?.anchorNode) ?? files[currentIndex(viewport)]
    /* v8 ignore next -- the files region renders only while files show, so its position always names one */
    if (file === undefined) return
    event.preventDefault()
    markViewed(data, file, viewedStateOf(marks, file.path, file.digest) !== 'viewed')
  }

  // What the section handlers and comment actions read when they run, replaced on every render. The assignment happens
  // during render rather than in an effect because the file menus read their actions while this same render draws them;
  // an effect would hand them the previous diff's links. A render React discards leaves values derived from the same
  // props and state, which the retried render assigns again.
  const callbacks = {
    data, expandedByDefault, expand, markViewed, fileActions, publishReview, writeReview, addPending, report, nextThread, t,
  }
  const live = useRef(callbacks)
  live.current = callbacks
  const handlers = useMemo((): DiffFileHandlers => ({
    toggle: (file) => {
      const byDefault = live.current.expandedByDefault(file)
      setChosen(value => ({ ...value, [file.path]: !(value[file.path] ?? byDefault) }))
    },
    reveal: (path) => { setRevealed(value => new Set([...value, path])) },
    expand: (file, index) => {
      const { data: owner, expand: open } = live.current
      /* v8 ignore next -- sections render only while changes are loaded */
      if (owner !== null) open(owner, file, index)
    },
    view: (file, viewed) => {
      const { data: owner, markViewed: mark } = live.current
      /* v8 ignore next -- sections render only while changes are loaded */
      if (owner !== null) mark(owner, file, viewed)
    },
    actions: (file) => {
      const { data: owner, fileActions: list } = live.current
      /* v8 ignore next -- sections render only while changes are loaded */
      return owner === null ? [] : list(owner, file)
    },
    section: (path, element) => {
      if (element === null) sections.current.delete(path)
      else sections.current.set(path, element)
    },
    nextThread: (path) => { live.current.nextThread(path) },
    reach,
  }), [reach])
  const reviewStarted = pendingReview !== null
  const publishingBlocked = reviewState.uncertain !== null
  // Comments on a commit range or on local changes go to the input only; a whole change request also takes GitHub comments:
  // into its pending review once the threads say the user may review, and on their own while the user has no pending
  // review, since GitHub refuses a single comment beside one.
  const whole = data?.kind === 'change' && data.commits === null
  const queueable = whole && review?.viewerCanReview === true
  const single = whole && pendingReview === null
  const fileReview = useMemo((): ReviewActions | undefined => shownSource === null ? undefined : {
    source: shownSource,
    addToInput: addReviewToInput,
    records: queue, openLink, reviewStarted,
    onQuoted: (selection) => { if (!queue.recordAgent(selection)) live.current.report('review.saveFailed') },
    publishingBlocked,
    ...queueable ? { queue: (selection: ReviewSelection) => live.current.addPending(selection) } : {},
    ...single ? {
      publish: (selection: ReviewSelection) => selection.source.kind === 'change'
        ? live.current.publishReview(selection.source.url, { kind: 'comment', headSha: selection.source.headSha, comment: selection.comment },
          url => queue.published(selection, url))
        : Promise.resolve(live.current.t('review.stale')),
    } : {},
  }, [shownSource, addReviewToInput, queue, openLink, reviewStarted, publishingBlocked, queueable, single])

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
          <span>{failureText}</span>
          {(retry || changeUrl !== null || automaticBase !== false) && (
            <div className={css.actions}>
              {retry && <Button size="sm" variant="outline" onClick={refresh}>{t('retry')}</Button>}
              {automaticBase}
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
  } else if (files.length === 0) {
    body = <div className={css.files}>{orphanRecords}<div className={css.centered}>{t('lens.empty')}</div></div>
  } else {
    body = (
      <div ref={attachScrollport} className={css.files} data-forge-changes-scroll="" role="region"
        aria-label={t('diff.allFiles', { count: files.length })} aria-keyshortcuts="ArrowLeft ArrowRight V" tabIndex={0}
        onKeyDown={navigateFiles} onScroll={(event) => {
          if (jumpPosition.current?.top !== event.currentTarget.scrollTop) jumpPosition.current = null
        }}>
        {files.map((file) => {
          const path = file.path
          return (
            <DiffFile
              key={path}
              visible={tab.visible}
              file={file}
              review={fileReview}
              expanded={isExpanded(file)}
              large={drawnLines(file) > LARGE_FILE_LINES}
              revealed={revealed.has(path)}
              text={current.texts[path]}
              open={current.open[path] ?? NO_GAPS}
              split={split}
              wrap={wrap}
              badge={badgeOf(file, data, t)}
              tooltip={pathTooltipOf(file, t)}
              threads={fileThreads.get(path)}
              drawNow={wanted !== null && wanted.center !== null && wanted.path === path}
              viewed={viewedStateOf(marks, path, file.digest)}
              viewedNote={host === null ? t('viewed.hint') : host.unavailable ? t('viewed.unavailable')
                : host.saving(path) ? t('viewed.saving') : t('viewed.hintHost')}
              viewedDisabled={host !== null && (host.unavailable || host.saving(path))}
              handlers={handlers}
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
    ...review === null ? {} : { threadCounts: placed.unresolved },
  }
  // The toolbar collapses every file while any is expanded, as the files on screen show, and expands every file otherwise.
  const anyExpanded = files.some(isExpanded)
  const expansionLabel = t(anyExpanded ? 'diff.collapseAll' : 'diff.expandAll')
  const toggleExpansion = (): void => { setChosen(Object.fromEntries(files.map(file => [file.path, !anyExpanded]))) }
  const toggleSplit = (): void => { actions.toggledSplit(tab.id) }
  const toggleWrap = (): void => { actions.toggledWrap(tab.id) }
  const toggleTests = (): void => { actions.toggledTests(tab.id) }
  const treeAction = t(treePosition === 'left' ? 'diff.moveFileTreeRight' : treePosition === 'right' ? 'diff.hideFileTree' : 'diff.showFileTreeLeft')
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  const viewedCount = files.filter(file => viewedStateOf(marks, file.path, file.digest) === 'viewed').length
  const treeShown = allFiles.length > 0 && treePosition !== 'hidden'
  const lensProps = { lens, counts: lensCounts, hideTests, choose: (next: ChangesLens) => { actions.lensed(tab.id, next) }, t }
  const commitMenu = source.kind === 'local' && scope !== 'branch' ? null : <CommitMenu chosen={chosenCommits} visible={tab.visible}
    list={source.kind === 'local' ? listLocalCommits : listChangeCommits} kept={source.kind === 'local' ? 'newest' : 'oldest'}
    version={commitsVersion}
    choose={(next) => { actions.committed(tab.id, next) }} t={t} />
  const toolbarStyle: CSSProperties & { '--forge-tree-width': string } = { '--forge-tree-width': `${treeWidth}px` }
  return (
    <div className={css.root} data-forge-changes={source.kind} onKeyDown={toggleViewed}>
      {source.kind === 'local'
        ? <LocalHeader state={state} scope={scope} base={base} missing={failed === 'forgePanel/base-missing'} visible={tab.visible}
          diffBases={diffBases} choose={(next) => { actions.based(tab.id, next) }} commitMenu={commitMenu}
          createChangeRequest={createChangeRequest} t={t} />
        : <ChangeHeader url={source.url} entry={entry} openLink={openLink} commitMenu={commitMenu}
          reviewCount={(pendingReview?.comments ?? 0) + reviewState.comments.length}
          reviewDisabled={data === null || changeCommits !== null} onReview={() => { setReviewOpen(true) }} t={t} />}
      {!reviewOpen && reviewState.error !== null && <Notice>{t(reviewState.error === 'load' ? 'review.loadFailed' : 'review.saveFailed')}</Notice>}
      {!reviewOpen && reviewState.uncertain !== null && !reviewBusy && source.kind === 'change' && <div className={css.reviewNotice} role="alert">
        <span>{t('review.unknown')}</span>
        {reviewState.uncertain.kind === 'comment' && <blockquote>{reviewState.uncertain.comment.body}</blockquote>}
        <Button size="sm" variant="outline" onClick={() => { openLink(source.url) }}>{t('review.recheck')}</Button>
        <Button size="sm" variant="outline" onClick={() => { queue.finish(false); setReviewError(null) }}>{t('review.confirmRetry')}</Button>
      </div>}
      {!reviewOpen && reviewError !== null && reviewState.uncertain === null && <Notice>{reviewError}</Notice>}
      <div className={css.toolbar} data-tree={treeShown ? treePosition : 'hidden'} style={toolbarStyle}>
        {/* Above the file tree, the lens spans the tree's width; elsewhere a menu in the toolbar takes its place. */}
        {treeShown && <div className={css.lensCell}><LensControl {...lensProps} /></div>}
        <div ref={toolbarRow} className={css.toolbarMain}>
          {tab.visible && source.kind === 'local' && <ScopeMenu scope={scope} choose={(next) => { actions.scoped(tab.id, next) }} t={t} />}
          {tab.visible && <span className={css.filesSlot}><ChangedFilesMenu {...navigator} visible /></span>}
          {tab.visible && allFiles.length > 0 && (
            <span className={css.lensMenu}><LensMenu {...lensProps} visible /></span>
          )}
          {allFiles.length > 0 && <span className={css.foldTests}>
            <HideTestsSwitch hidden={hideTests} toggle={toggleTests} t={t} />
          </span>}
          <span className={css.spacer} data-fold-spacer="" />
          {/* A truncated read keeps the list, whose footer says so, even when it kept no thread. */}
          {review !== null && (review.threads.length > 0 || review.truncated) && (
            <button ref={threadsToggle} type="button" className={css.threadsToggle} aria-pressed={threadList.open} data-forge-threads-toggle=""
              aria-label={t('thread.listAria', { count: review.threads.length })}
              onClick={() => { setThreadList(value => ({ ...value, open: !value.open, claim: !value.open })) }}>
              {t('thread.list')}<span className={css.threadsTotal}>{review.threads.length}</span>
            </button>
          )}
          <span className={css.progressSlot}><ViewedProgress viewed={viewedCount} total={files.length} t={t} /></span>
          {files.length > 0 && (
            <span className={clsx(css.totals, css.foldViews)}><Counts file={{ additions, deletions, binary: false }} t={t} /></span>
          )}
          <span className={css.tools}>
            <Tooltip label={t('diff.refresh')} side="bottom">
              <button type="button" className={clsx(css.tool, css.foldRefresh)} aria-label={t('diff.refresh')} onClick={refresh}>
                <RefreshGlyph busy={rereading} size={16} />
              </button>
            </Tooltip>
            <Tooltip label={expansionLabel} side="bottom">
              <button type="button" className={clsx(css.tool, css.foldViews)} data-expanded={anyExpanded ? '' : undefined} aria-label={expansionLabel}
                disabled={files.length === 0} onClick={toggleExpansion}>
                <IconChevronsUpDownOutlineRegular />
              </button>
            </Tooltip>
            <Tooltip label={t(split ? 'diff.unified' : 'diff.split')} side="bottom">
              <button type="button" className={clsx(css.tool, css.foldViews)} aria-pressed={split} aria-label={t('diff.splitAria')}
                onClick={toggleSplit}>
                <IconCompareSplitOutlineRegular className={css.compareIcon} />
              </button>
            </Tooltip>
            <Tooltip label={t(wrap ? 'diff.nowrap' : 'diff.wrap')} side="bottom">
              <button type="button" className={clsx(css.tool, css.foldViews)} aria-pressed={wrap} aria-label={t('diff.wrapAria')}
                onClick={toggleWrap}>
                {wrap ? <IconNowrapFillRegular /> : <IconWrapFillRegular />}
              </button>
            </Tooltip>
            <span className={css.treeToggle}>
              <Tooltip label={treeAction} side="bottom">
                <button type="button" className={css.tool} aria-label={treeAction} aria-expanded={treePosition !== 'hidden'}
                  aria-controls={treeId} disabled={allFiles.length === 0}
                  onClick={() => { setTreePosition(value => value === 'left' ? 'right' : value === 'right' ? 'hidden' : 'left') }}>
                  <IconWorkspaceTreeOutlineRegular />
                </button>
              </Tooltip>
            </span>
            <ViewOptionsMenu visible={tab.visible} options={{
              anyExpanded, hasFiles: files.length > 0, toggleExpansion, split, toggleSplit, wrap, toggleWrap,
              hideTests: allFiles.length > 0 ? hideTests : undefined, toggleTests, refresh,
            }} t={t} />
          </span>
        </div>
      </div>
      {data !== null && failed !== null && (
        <Notice action={retry
          ? <Button size="sm" variant="outline" className={css.noticeAction} onClick={refresh}>{t('retry')}</Button>
          : automaticBase !== false && <span className={css.noticeAction}>{automaticBase}</span>}>
          {failureText}
        </Notice>
      )}
      {data?.kind === 'change' && data.localAhead !== null && data.localAhead > 0 && (
        <Notice>{t('diff.stale', { count: data.localAhead })}</Notice>
      )}
      {data?.kind === 'local' && data.omitted > 0 && <Notice>{t('diff.omitted', { count: data.omitted })}</Notice>}
      {data?.kind === 'change' && data.viewed?.kind === 'failed' && (
        <Notice action={<Button size="sm" variant="outline" className={css.noticeAction} onClick={refresh}>{t('retry')}</Button>}>
          {t('viewed.readFailed', { message: data.viewed.message })}
        </Notice>
      )}
      {data?.kind === 'change' && threadRead.failure !== null && (
        <Notice action={<Button size="sm" variant="outline" className={css.noticeAction} onClick={refresh}>{t('retry')}</Button>}>
          {t('thread.loadFailed', { message: threadRead.failure })}
        </Notice>
      )}
      {reviewForm}
      <div className={css.body}>
        {body}
        {allFiles.length > 0 && <FileTreePane {...navigator} id={treeId} position={treePosition} onWidth={setTreeWidth} />}
        {review !== null && data?.kind === 'change' && threadList.open && (
          <ThreadList entries={placed.entries} files={allFiles} truncated={review.truncated} url={data.url}
            filter={threadList.filter} choose={(filter) => { setThreadList(value => ({ ...value, filter })) }}
            claim={threadList.claim} claimed={() => { setThreadList(value => ({ ...value, claim: false })) }}
            open={(entry, covering) => {
              // A list that covers the files closes and hands the focus to the thread it opens, which it would cover.
              if (covering) setThreadList(value => ({ ...value, open: false }))
              openThread(entry, covering)
            }}
            openLink={openLink} close={closeThreadList} t={t} />
        )}
      </div>
    </div>
  )
}

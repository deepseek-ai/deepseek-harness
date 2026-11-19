// @vitest-environment jsdom
/**
 * Forge panel registration: the Remote mount, slot entries, per-Session stores,
 * actions and their notices, the changes view, and unload.
 */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { QuoteSummary } from '@deepseek-ai/dsh-client-ui-primitives'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChangeRequestDescription, ChangeRequestReviewer, ChangeRequestSnapshot, ForgeCommitList, ForgeRerunRequest, ForgeReviewData,
  ForgeReviewerCandidate, ForgeReviewRequest, ForgeReviewResult, ForgeReviewWrite, ForgeReviewWriteResult, ForgeThreadId, ForgeViewedFiles,
  ForgeViewedRequest,
} from '@deepseek-ai/dsh-experimental-forge/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionToast } from '../src/client/ActionToast.tsx'
import { AttentionIndicator, type AttentionIndicatorInjected } from '../src/client/AttentionIndicator.tsx'
import { CHANGES_ID, CHANGES_KIND, changesAddress } from '../src/client/changes-address.ts'
import {
  ChangeRequestsActions, ChangeRequestsSection, type ChangeRequestsActionsInjected, type ChangeRequestsSectionInjected,
} from '../src/client/ChangeRequestsSection.tsx'
import { ChangesTab, type ChangesTabInjected } from '../src/client/ChangesTab.tsx'
import { ChangesTabTitle } from '../src/client/ChangesTabTitle.tsx'
import {
  CheckoutRow, ConnectionRow, LocalChangesRow, type CheckoutRowInjected, type ConnectionRowInjected, type LocalChangesRowInjected,
} from '../src/client/EnvironmentRows.tsx'
import { en, NS, zh } from '../src/client/locales.ts'
import { inject, mountForgePanel, WORKTREE_NS, WORKTREE_ROW_KEY } from '../src/client/mount.ts'
import type { SessionListInjected } from '../src/client/session-list.ts'
import { SessionHoverForge } from '../src/client/SessionHoverForge.tsx'
import { SessionRowForge } from '../src/client/SessionRowForge.tsx'
import type { NoticeSource } from '../src/client/source.ts'
import type { ReviewSelection } from '../src/client/review.ts'
import { REVIEW_PANEL } from '../src/client/review-page/review-mount.ts'
import { ReviewConversation } from '../src/client/review-page/ReviewChat.tsx'
import { ReviewNavCount, ReviewNavIcon, type ReviewNavCountInjected } from '../src/client/review-page/ReviewNav.tsx'
import { ReviewPage, type ReviewPageInjected } from '../src/client/review-page/ReviewPage.tsx'
import { reviewThread } from './thread-fixtures.client.ts'
import { WorktreeProgress, type WorktreeProgressInjected } from '../src/client/WorktreeProgress.tsx'
import { WorktreeSettings } from '../src/client/WorktreeSettings.tsx'
import type { WorktreeSettingsInjected, WorktreeSettings as WorktreeSettingsFields } from '../src/client/worktree-settings-form.ts'
import { WorktreeToggle, type WorktreeToggleInjected } from '../src/client/WorktreeToggle.tsx'
import type { WorktreeCleanup } from '@deepseek-ai/dsh-experimental-worktree/types'
import type {
  ForgeBaseBranches, ForgeChangeRequestDiff, ForgeChangeRequestStatesFrame, ForgeExtensionState, ForgeLensFrame,
  ForgeLensRequest,
  ForgeCommitRange, ForgeLocalCommits, ForgeLocalDiff, ForgeLocalScope, ForgePanelState, ForgeReviewChangeRequest, ForgeReviewCountFrame,
  ForgeReviewFrame, ForgeWorktreeBases,
} from '../src/types.ts'
import { entry, listState, ready, snapshot, unserved } from './client-fixtures.client.ts'
import { description, reviewed } from './review-fixtures.client.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-client-ui-forge', descriptors: [] }
const S1 = brandString<SessionId>('s1')
const S2 = brandString<SessionId>('s2')
const BASES: ForgeWorktreeBases = { current: { ref: 'refs/heads/main', name: 'main' }, defaults: [], local: [], remotes: [] }
const LOCAL: ForgeLocalDiff = { base: 'origin/main', files: [], omitted: 0 }
const CHANGE: ForgeChangeRequestDiff = { headSha: 'a'.repeat(40), files: [], localAhead: null, fileUrls: {} }
const COMMITS: ForgeCommitList = { headSha: 'a'.repeat(40), commits: [], truncated: false }

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
})

/** A fake `follow` or `changeRequestStates` stream handle the test feeds by hand. */
function stream<F = ForgePanelState>(signal: AbortSignal) {
  const queue: F[] = []
  let wake: (() => void) | undefined
  let closed = false
  const handle = {
    signal,
    disposed: vi.fn(),
    push(frame: F) { queue.push(frame); wake?.() },
    dispose() { handle.disposed(); closed = true; wake?.() },
    async *[Symbol.asyncIterator](): AsyncIterator<F> {
      while (true) {
        const next = queue.shift()
        if (next !== undefined) { yield next; continue }
        if (closed) return
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    },
  }
  return handle
}

const OK: RemoteResult<void> = { ok: true, value: undefined }

/** What a Remote read resolves to. */
type Read<T> = Promise<RemoteResult<T>>

const REFUSED = {
  started: { ok: false, error: new RemoteError('forgePanel/session-started', 'started', {}) },
  unavailable: { ok: false, error: new RemoteError('forgePanel/worktrees-unavailable', 'unavailable', {}) },
  busy: { ok: false, error: new RemoteError('forgePanel/session-busy', 'busy', {}) },
  restore: { ok: false, error: new RemoteError('forgePanel/restore-failed', 'fatal: \'/work/repo-dsh\' already exists', {}) },
  failed: { ok: false, error: new RemoteError('gateway/bad-request', 'failed', {}) },
  exists: { ok: false, error: new RemoteError('forgePanel/branch-exists', 'taken', {}) },
  invalidName: { ok: false, error: new RemoteError('forgePanel/invalid-name', 'invalid', {}) },
  stale: { ok: false, error: new RemoteError('forgePanel/stale-head', 'Head branch was modified', {}) },
  refused: { ok: false, error: new RemoteError('forgePanel/action-failed', 'Pull Request is not mergeable', {}) },
  unknown: { ok: false, error: new RemoteError('forgePanel/action-unknown', 'Something went wrong', {}) },
} satisfies Record<string, RemoteResult<never>>

function isSectionFace(value: Record<string, unknown>): value is Record<string, unknown> & ChangeRequestsSectionInjected {
  return typeof value.merge === 'function' && typeof value.viewChanges === 'function'
}

function isActionsFace(value: Record<string, unknown>): value is Record<string, unknown> & ChangeRequestsActionsInjected {
  return Object.keys(value).length === 1 && typeof value.hooks === 'object'
}

function isCheckoutFace(value: Record<string, unknown>): value is Record<string, unknown> & CheckoutRowInjected {
  return typeof value.restore === 'function' && typeof value.hooks === 'object' && value.hooks !== null && 'host' in value.hooks
}

function isLocalFace(value: Record<string, unknown>): value is Record<string, unknown> & LocalChangesRowInjected {
  return typeof value.viewLocalChanges === 'function' && typeof value.createChangeRequest === 'function'
}

function isConnectionFace(value: Record<string, unknown>): value is Record<string, unknown> & ConnectionRowInjected {
  return Object.keys(value).length === 2 && typeof value.reconnect === 'function' && typeof value.hooks === 'object'
}

function isAttentionFace(value: Record<string, unknown>): value is Record<string, unknown> & AttentionIndicatorInjected {
  return typeof value.hooks === 'object' && value.hooks !== null && 'panel' in value.hooks
}

function isWorktreeFace(value: Record<string, unknown>): value is Record<string, unknown> & WorktreeToggleInjected {
  return typeof value.request === 'function' && typeof value.bases === 'function'
}

function isProgressFace(value: Record<string, unknown>): value is Record<string, unknown> & WorktreeProgressInjected {
  return typeof value.stop === 'function' && typeof value.retry === 'function' && typeof value.withdraw === 'function'
    && typeof value.restore === 'function' && typeof value.leave === 'function'
}

function isChangesFace(value: Record<string, unknown>): value is Record<string, unknown> & ChangesTabInjected {
  return typeof value.localDiff === 'function' && typeof value.createChangeRequest === 'function'
}

function isListFace(value: Record<string, unknown>): value is Record<string, unknown> & SessionListInjected {
  return typeof value.hooks === 'object' && value.hooks !== null && 'states' in value.hooks
}

function isNoticeFace(value: Record<string, unknown>): value is Record<string, unknown> & Omit<NoticeSource, 'report'> {
  return typeof value.dismiss === 'function' && typeof value.hooks === 'object'
}

function isReviewPageFace(value: Record<string, unknown>): value is Record<string, unknown> & ReviewPageInjected {
  return typeof value.openLists === 'function' && typeof value.actionsFor === 'function'
}

function isReviewCountFace(value: Record<string, unknown>): value is Record<string, unknown> & ReviewNavCountInjected {
  return typeof value.hooks === 'object' && value.hooks !== null && 'count' in value.hooks
}

/** Let the Remote results that the actions await settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** A Session binding whose history opening settled with `openState`. */
function opened(openState = 'open', openError: Error | null = null) {
  return { session: { getSnapshot: () => ({ openState, openError }) } }
}

async function base() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    $host: RemoteHostFacts = { home: '/home/octo', isLoopback: true }
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  const remote = new Remote()
  const streams: ReturnType<typeof stream>[] = []
  const stateStreams: ReturnType<typeof stream<ForgeChangeRequestStatesFrame>>[] = []
  const extensionStreams: ReturnType<typeof stream<ForgeExtensionState>>[] = []
  const countStreams: ReturnType<typeof stream<ForgeReviewCountFrame>>[] = []
  const forgePanel = {
    follow: vi.fn((_sessionId: SessionId, signal: AbortSignal) => {
      const handle = stream(signal)
      streams.push(handle)
      return handle
    }),
    changeRequestStates: vi.fn((signal: AbortSignal) => {
      const handle = stream<ForgeChangeRequestStatesFrame>(signal)
      stateStreams.push(handle)
      return handle
    }),
    extensions: vi.fn((signal: AbortSignal) => {
      const handle = stream<ForgeExtensionState>(signal)
      extensionStreams.push(handle)
      return handle
    }),
    changesLens: vi.fn((_sessionId: SessionId, _request: ForgeLensRequest, signal: AbortSignal) => stream<ForgeLensFrame>(signal)),
    worktreeCleanup: vi.fn(async (_sessionId: SessionId, _revision: number | null): Promise<RemoteResult<WorktreeCleanup | null>> =>
      ({ ok: true, value: null })),
    track: vi.fn(async (_sessionId: SessionId, _url: string): Promise<RemoteResult<void>> => OK),
    dismiss: vi.fn(async (_sessionId: SessionId, _url: string): Promise<RemoteResult<void>> => OK),
    markReady: vi.fn(async (_sessionId: SessionId, _url: string): Promise<RemoteResult<void>> => OK),
    merge: vi.fn(async (_sessionId: SessionId, _url: string, _method: string, _headSha: string): Promise<RemoteResult<void>> => OK),
    rerunChecks: vi.fn(async (_sessionId: SessionId, _url: string, _request: ForgeRerunRequest): Promise<RemoteResult<void>> => OK),
    requestReviews: vi.fn(async (
      _sessionId: SessionId, _url: string, _reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[],
    ): Promise<RemoteResult<void>> => OK),
    reviewerCandidates: vi.fn(async (
      _sessionId: SessionId, _url: string, _query: string, _signal: AbortSignal,
    ): Read<readonly ForgeReviewerCandidate[]> => ({ ok: true, value: [{ login: 'mona', name: null, avatarUrl: null, suggested: true }] })),
    updateBranch: vi.fn(async (_sessionId: SessionId, _url: string, _method: string, _headSha: string): Promise<RemoteResult<void>> => OK),
    changeRequestViewed: vi.fn(async (
      _sessionId: SessionId, _url: string, _headSha: string, _fresh: boolean, _signal: AbortSignal,
    ): Read<ForgeViewedFiles | null> => ({ ok: true, value: null })),
    setFileViewed: vi.fn(async (_sessionId: SessionId, _url: string, _request: ForgeViewedRequest): Promise<RemoteResult<void>> => OK),
    refresh: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    revisit: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    requestWorktree: vi.fn(async (_sessionId: SessionId, _from: string | null, _name: string | null): Promise<RemoteResult<void>> => OK),
    cancelWorktree: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    stopCreation: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    retryWorktree: vi.fn(async (_sessionId: SessionId, _fetch: boolean): Promise<RemoteResult<void>> => OK),
    restoreWorktree: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    continueInProject: vi.fn(async (_sessionId: SessionId): Promise<RemoteResult<void>> => OK),
    worktreeBases: vi.fn(async (_sessionId: SessionId, _query: string, _signal?: AbortSignal): Read<ForgeWorktreeBases> =>
      ({ ok: true, value: BASES })),
    localDiff: vi.fn(async (_sessionId: SessionId, _scope: ForgeLocalScope, _signal?: AbortSignal): Read<ForgeLocalDiff> =>
      ({ ok: true, value: LOCAL })),
    localText: vi.fn(async (_sessionId: SessionId, _scope: ForgeLocalScope, _path: string): Read<string> => ({ ok: true, value: 'a\n' })),
    diffBases: vi.fn(async (_sessionId: SessionId, _query: string, _signal?: AbortSignal): Read<ForgeBaseBranches> =>
      ({ ok: true, value: { automatic: null, remote: [], local: [] } })),
    changeRequestChecks: vi.fn(async (
      _sessionId: SessionId, _url: string, _headSha: string, _signal: AbortSignal,
    ): Read<ChangeRequestSnapshot> => ({ ok: true, value: snapshot(7) })),
    changeRequestDiff: vi.fn(async (
      _sessionId: SessionId, _url: string, _commits: ForgeCommitRange | null, _signal?: AbortSignal,
    ): Read<ForgeChangeRequestDiff> => ({ ok: true, value: CHANGE })),
    localCommits: vi.fn(async (_sessionId: SessionId, _base: string | null, _signal?: AbortSignal): Read<ForgeLocalCommits> =>
      ({ ok: true, value: COMMITS })),
    changeRequestCommits: vi.fn(async (_sessionId: SessionId, _url: string, _signal?: AbortSignal): Read<ForgeCommitList | null> =>
      ({ ok: true, value: COMMITS })),
    changeRequestText: vi.fn(async (_sessionId: SessionId, _url: string, _commit: string, _path: string): Read<string> => ({ ok: true, value: 'b\n' })),
    changeRequestReview: vi.fn(async (
      _sessionId: SessionId, _url: string, headSha: string, _fresh: boolean, _signal?: AbortSignal,
    ): Read<ForgeReviewData> => ({ ok: true, value: { headSha, viewer: 'octo', threads: [], truncated: false, pendingReview: null, viewerCanReview: true, reviewEvents: ['comment', 'approve', 'request-changes'] } })),
    changeRequestReviewWrite: vi.fn(async (_sessionId: SessionId, _url: string, _write: ForgeReviewWrite): Read<ForgeReviewWriteResult> =>
      ({ ok: true, value: { ok: true } })),
    submitReview: vi.fn(async (_sessionId: SessionId, _url: string, _request: ForgeReviewRequest): Read<ForgeReviewResult> => ({ ok: true, value: { ok: true, url: 'https://github.com/review' } })),
    reviewLists: vi.fn((_repository: { readonly owner: string; readonly name: string } | null, signal: AbortSignal) =>
      stream<ForgeReviewFrame>(signal)),
    reviewChangeRequest: vi.fn((_url: string, signal: AbortSignal) => stream<ForgeReviewChangeRequest>(signal)),
    reviewCount: vi.fn((signal: AbortSignal) => {
      const handle = stream<ForgeReviewCountFrame>(signal)
      countStreams.push(handle)
      return handle
    }),
    reviewRefresh: vi.fn(async (): Promise<RemoteResult<void>> => OK),
    reviewDescription: vi.fn(async (_url: string, _signal: AbortSignal): Read<ChangeRequestDescription> =>
      ({ ok: true, value: description('Body') })),
    reviewPoll: vi.fn(async (_url: string): Promise<RemoteResult<void>> => OK),
    reviewMarkReady: vi.fn(async (_url: string): Promise<RemoteResult<void>> => OK),
    reviewMerge: vi.fn(async (_url: string, _method: string, _headSha: string): Promise<RemoteResult<void>> => OK),
    reviewChecks: vi.fn(async (_url: string, _headSha: string, _signal: AbortSignal): Read<ChangeRequestSnapshot> =>
      ({ ok: true, value: snapshot(7) })),
    reviewRerunChecks: vi.fn(async (_url: string, _request: ForgeRerunRequest): Promise<RemoteResult<void>> => OK),
    reviewRequestReviews: vi.fn(async (
      _url: string, _reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[],
    ): Promise<RemoteResult<void>> => OK),
    reviewReviewerCandidates: vi.fn(async (_url: string, _query: string, _signal: AbortSignal): Read<readonly ForgeReviewerCandidate[]> =>
      ({ ok: true, value: [{ login: 'mona', name: null, avatarUrl: null, suggested: true }] })),
    reviewUpdateBranch: vi.fn(async (_url: string, _method: string, _headSha: string): Promise<RemoteResult<void>> => OK),
    reviewDiff: vi.fn(async (_url: string, _commits: ForgeCommitRange | null, _signal: AbortSignal): Read<ForgeChangeRequestDiff> =>
      ({ ok: true, value: CHANGE })),
    reviewCommits: vi.fn(async (_url: string, _signal: AbortSignal): Read<ForgeCommitList | null> => ({ ok: true, value: COMMITS })),
    reviewViewed: vi.fn(async (_url: string, _headSha: string, _fresh: boolean, _signal: AbortSignal): Read<ForgeViewedFiles | null> =>
      ({ ok: true, value: null })),
    reviewSetViewed: vi.fn(async (_url: string, _request: ForgeViewedRequest): Promise<RemoteResult<void>> => OK),
    reviewText: vi.fn(async (_url: string, _commit: string, _path: string): Read<string> => ({ ok: true, value: 'c\n' })),
    reviewThreads: vi.fn(async (_url: string, headSha: string, _fresh: boolean, _signal: AbortSignal): Read<ForgeReviewData> =>
      ({ ok: true, value: {
        headSha, viewer: 'lin', threads: [], truncated: false, pendingReview: null, viewerCanReview: true, reviewEvents: ['comment', 'approve'],
      } })),
    reviewThreadWrite: vi.fn(async (_url: string, _write: ForgeReviewWrite): Read<ForgeReviewWriteResult> =>
      ({ ok: true, value: { ok: true } })),
    reviewSubmit: vi.fn(async (_url: string, _request: ForgeReviewRequest): Read<ForgeReviewResult> =>
      ({ ok: true, value: { ok: true, url: 'https://github.com/review/2' } })),
    reviewStage: vi.fn(async (_sessionId: SessionId, _url: string | null): Promise<RemoteResult<void>> => OK),
  }
  ctx.provide('remote.forgePanel', forgePanel)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const unregisterTab = vi.fn()
  const sidebarRightTabs = { register: vi.fn((_type: SidebarRightTabDefinition) => unregisterTab) }
  ctx.provide('sidebarRightTabs', sidebarRightTabs)
  const sidebarRight = { openResourceIn: vi.fn(), openResource: vi.fn(),
    mounted: { getSnapshot: vi.fn((): SessionId | undefined => S1), subscribe: () => () => {} } }
  const scopes = new Map<SessionId, ReturnType<Context['plugin']>>()
  const sessions = {
    scope: vi.fn<(id: SessionId) => Context | undefined>((id) => {
      let fiber = scopes.get(id)
      if (fiber === undefined) { fiber = ctx.plugin(() => {}); scopes.set(id, fiber) }
      return fiber.ctx
    }),
    // A reference to a retained Session whose opening has settled; only its identity, readiness, open state, and release are supplied.
    retain: vi.fn((sessionId: SessionId, _options: { readonly source: string; readonly signal?: AbortSignal }) =>
      ({ sessionId, ready: Promise.resolve(opened()), release: vi.fn() })),
  }
  ctx.provide('sessions', sessions)
  const worktreeForm = stubConfigForm<WorktreeSettingsFields>()
  ctx.provide('configForms', { get: (name: string) => { expect(name).toBe(WORKTREE_NS); return worktreeForm.scope } } as never)
  ctx.provide('sidebarRight', sidebarRight)
  const remoteAccess = {
    whenAccess: vi.fn((_action: string, callback: () => Iterable<() => unknown>) => {
      const disposers = [...callback()]
      return () => { for (const dispose of disposers.reverse()) void dispose() }
    }),
  }
  ctx.provide('remoteAccess', remoteAccess as never)
  const workspaces = { list: { getSnapshot: vi.fn(() => ({ items: [] as { workspaceId: string; path: string; updatedAt: string }[] })) } }
  ctx.provide('workspaces', workspaces as never)
  const uiWorkspace = { connectWorkspace: vi.fn(async (id: string) => await Promise.resolve(`blank-${id}` as SessionId)), openSession: vi.fn() }
  ctx.provide('uiWorkspace', uiWorkspace as never)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.panel.section': { kind: 'list', scope: 'session' },
      'conversation.session.panel.section.actions': { kind: 'keyed', scope: 'session' },
      'conversation.session.panel.environment.row': { kind: 'list', scope: 'session' },
      'conversation.session.panel.indicator': { kind: 'list', scope: 'session', inline: true },
      'conversation.hero.options': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'sidebar.session.row.trailing': { kind: 'list', scope: 'root', inline: true },
      'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
      'plugins.row.config': { kind: 'keyed', scope: 'root' },
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'sidebar.panellist.trailing': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  return {
    ctx, remote, unmount, streams, stateStreams, extensionStreams, countStreams, forgePanel, sidebarRightTabs, unregisterTab, sidebarRight,
    sessions, scopes, worktreeForm, remoteAccess, workspaces, uiWorkspace,
  }
}

async function fixture() {
  const b = await base()
  let dispose: (() => Promise<void>) | undefined
  await b.ctx.plugin({ inject: [...inject], apply: async (plugin: Context) => { dispose = await mountForgePanel(plugin, REMOTE) } })
  assert(dispose !== undefined)
  const entry = (slot: Parameters<typeof b.ctx.slots.entries>[0], component: unknown) =>
    b.ctx.slots.entries(slot).find(candidate => candidate.component === component)
  const sectionInject = entry('conversation.session.panel.section', ChangeRequestsSection)?.inject
  const actionsInject = entry('conversation.session.panel.section.actions', ChangeRequestsActions)?.inject
  const checkoutInject = entry('conversation.session.panel.environment.row', CheckoutRow)?.inject
  const localInject = entry('conversation.session.panel.environment.row', LocalChangesRow)?.inject
  const connectionInject = entry('conversation.session.panel.environment.row', ConnectionRow)?.inject
  const attentionInject = entry('conversation.session.panel.indicator', AttentionIndicator)?.inject
  const changesInject = entry('sidebar.right.pane.tab', ChangesTab)?.inject
  const worktreeInject = entry('conversation.hero.options', WorktreeToggle)?.inject
  const progressInject = entry('conversation.input.dock', WorktreeProgress)?.inject
  const toastInject = entry('shell.overlay', ActionToast)?.inject
  const rowInject = entry('sidebar.session.row.trailing', SessionRowForge)?.inject
  const hoverInject = entry('sidebar.session.row.hover', SessionHoverForge)?.inject
  assert(sectionInject !== undefined && actionsInject !== undefined && checkoutInject !== undefined && localInject !== undefined)
  assert(connectionInject !== undefined)
  assert(attentionInject !== undefined)
  assert(worktreeInject !== undefined && toastInject !== undefined)
  assert(progressInject !== undefined && changesInject !== undefined && rowInject !== undefined && hoverInject !== undefined)
  const section = (sessionId: SessionId): ChangeRequestsSectionInjected => {
    const value = sectionInject(sessionId as never)
    assert(isSectionFace(value))
    return value
  }
  const actions = (sessionId: SessionId): ChangeRequestsActionsInjected => {
    const value = actionsInject(sessionId as never)
    assert(isActionsFace(value))
    return value
  }
  const checkout = (sessionId: SessionId): CheckoutRowInjected => {
    const value = checkoutInject(sessionId as never)
    assert(isCheckoutFace(value))
    return value
  }
  const connection = (sessionId: SessionId): ConnectionRowInjected => {
    const value = connectionInject(sessionId as never)
    assert(isConnectionFace(value))
    return value
  }
  const local = (sessionId: SessionId): LocalChangesRowInjected => {
    const value = localInject(sessionId as never)
    assert(isLocalFace(value))
    return value
  }
  const attention = (sessionId: SessionId): AttentionIndicatorInjected => {
    const value = attentionInject(sessionId as never)
    assert(isAttentionFace(value))
    return value
  }
  const changes = (sessionId: SessionId): ChangesTabInjected => {
    const value = changesInject(sessionId as never)
    assert(isChangesFace(value))
    return value
  }
  const worktree = (sessionId: SessionId): WorktreeToggleInjected => {
    const value = worktreeInject(sessionId as never)
    assert(isWorktreeFace(value))
    return value
  }
  const progress = (sessionId: SessionId): WorktreeProgressInjected => {
    const value = progressInject(sessionId as never)
    assert(isProgressFace(value))
    return value
  }
  const toast = (): Omit<NoticeSource, 'report'> => {
    const value = toastInject(undefined as never)
    assert(isNoticeFace(value))
    return value
  }
  const notice = () => toast().hooks.notice.getSnapshot()
  const list = (place: 'row' | 'hover'): SessionListInjected => {
    const value = (place === 'row' ? rowInject : hoverInject)(undefined as never)
    assert(isListFace(value))
    return value
  }
  return {
    ...b, dispose, entry, section, actions, checkout, local, connection, attention, changes, worktree, progress,
    toast, notice, list,
  }
}

describe('mountForgePanel registration', () => {
  it('routes complete check reads through the bound Session and propagates failures', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    const url = 'https://github.com/octo/demo/pull/7'
    expect(await f.section(S1).readChecks(url, 'a'.repeat(40), signal)).toEqual(snapshot(7))
    expect(f.forgePanel.changeRequestChecks).toHaveBeenCalledWith(S1, url, 'a'.repeat(40), signal)
    f.forgePanel.changeRequestChecks.mockResolvedValueOnce(REFUSED.failed)
    await expect(f.section(S1).readChecks(url, 'a'.repeat(40), signal)).rejects.toThrow()
  })

  it('declares the browser services it needs', () => {
    expect(inject).toEqual([
      'remote', 'slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'configForms', 'remoteAccess', 'workspaces', 'uiWorkspace',
    ])
  })

  it('registers the Session panel entries, the changes tab, the worktree option and card, and the toast', async () => {
    const f = await fixture()
    expect(f.sidebarRightTabs.register).toHaveBeenCalledOnce()
    expect(f.sidebarRightTabs.register.mock.calls[0]?.[0]).toMatchObject({ id: CHANGES_ID, kind: CHANGES_KIND })
    const section = f.entry('conversation.session.panel.section', ChangeRequestsSection)
    expect(section).toMatchObject({ options: { id: 'change-requests', order: 100 }, locale: NS })
    const label = section?.options.label
    expect([en['tab.title'], zh['tab.title']]).toContain(typeof label === 'function' ? label() : label)
    expect(f.entry('conversation.session.panel.section.actions', ChangeRequestsActions))
      .toMatchObject({ options: { key: 'change-requests' }, locale: NS })
    expect(f.ctx.slots.entries('conversation.session.panel.section.actions').map(registration => registration.options.key)).toEqual(['change-requests'])
    expect(f.entry('conversation.session.panel.environment.row', CheckoutRow)).toMatchObject({ options: { id: 'forge.checkout', order: 20 }, locale: NS })
    expect(f.entry('conversation.session.panel.environment.row', LocalChangesRow)).toMatchObject({ options: { id: 'forge.local', order: 30 }, locale: NS })
    expect(f.entry('conversation.session.panel.environment.row', ConnectionRow))
      .toMatchObject({ options: { id: 'forge.connection', order: 40 }, locale: NS })
    expect(f.entry('conversation.session.panel.indicator', AttentionIndicator)).toMatchObject({ options: { id: 'forge.attention' }, locale: NS })
    expect(f.entry('sidebar.right.pane.tab', ChangesTab)).toMatchObject({ options: { key: CHANGES_ID }, locale: NS })
    expect(f.entry('sidebar.right.pane.tab', ChangesTab)?.store).toBeDefined()
    expect(f.entry('sidebar.right.pane.tab.title', ChangesTabTitle)).toMatchObject({ options: { key: CHANGES_ID }, locale: NS })
    // The Session panel replaces the header button, and the branch is named in the panel and the Session list.
    expect(f.ctx.slots.entries('conversation.session.header.utilities')).toEqual([])
    expect(f.ctx.slots.entries('conversation.session.header.actions')).toEqual([])
    expect(f.entry('conversation.hero.options', WorktreeToggle)).toMatchObject({ options: { id: 'forge-panel.worktree' }, locale: NS })
    expect(f.entry('conversation.input.dock', WorktreeProgress)).toMatchObject({ options: { id: 'forge-panel.worktree', order: 5 }, locale: NS })
    expect(f.ctx.slots.entries('conversation.input.left')).toEqual([])
    expect(f.entry('shell.overlay', ActionToast)).toMatchObject({ options: { id: 'forge-panel.toast' }, locale: NS })
    expect(f.entry('sidebar.session.row.trailing', SessionRowForge)).toMatchObject({ options: { id: 'forge-panel.row', order: 10 }, locale: NS })
    expect(f.entry('sidebar.session.row.hover', SessionHoverForge)).toMatchObject({ options: { id: 'forge-panel.row', order: 20 }, locale: NS })
    expect(f.notice()).toBeNull()
    await f.dispose()
  })

  it('withdraws every entry, closes the streams, and unmounts the Remote on unload', async () => {
    const f = await fixture()
    f.section(S1).hooks.panel.subscribe(() => {})
    f.attention(S2)
    f.list('row').hooks.states.subscribe(() => {})
    await settle()
    expect(f.streams).toHaveLength(1)
    expect(f.stateStreams).toHaveLength(1)

    await f.dispose()

    expect(f.streams[0]?.disposed).toHaveBeenCalled()
    expect(f.streams[0]?.signal.aborted).toBe(true)
    expect(f.stateStreams[0]?.disposed).toHaveBeenCalled()
    expect(f.stateStreams[0]?.signal.aborted).toBe(true)
    expect(f.unregisterTab).toHaveBeenCalled()
    expect(f.unmount).toHaveBeenCalledOnce()
    for (const [slot, component] of [
      ['conversation.session.panel.section', ChangeRequestsSection],
      ['conversation.session.panel.section.actions', ChangeRequestsActions],
      ['conversation.session.panel.environment.row', CheckoutRow],
      ['conversation.session.panel.environment.row', LocalChangesRow],
      ['conversation.session.panel.environment.row', ConnectionRow],
      ['conversation.session.panel.indicator', AttentionIndicator],
      ['sidebar.right.pane.tab', ChangesTab],
      ['sidebar.right.pane.tab.title', ChangesTabTitle],
      ['conversation.hero.options', WorktreeToggle],
      ['conversation.input.dock', WorktreeProgress],
      ['shell.overlay', ActionToast],
      ['sidebar.session.row.trailing', SessionRowForge],
      ['sidebar.session.row.hover', SessionHoverForge],
    ] as const) expect(f.entry(slot, component)).toBeUndefined()
    f.ctx.emit('connection/reset')
    expect(f.forgePanel.follow).toHaveBeenCalledOnce()
    expect(f.forgePanel.changeRequestStates).toHaveBeenCalledOnce()
  })

  it('unmounts the Remote when the UI registration fails', async () => {
    const b = await base()
    const original = b.ctx.slots.inject.bind(b.ctx.slots)
    // Fail after the changes tab type is registered, so its registration must be withdrawn.
    vi.spyOn(b.ctx.slots, 'inject').mockImplementation((name, ...rest) => {
      if (name === 'shell.overlay') throw new Error('slot failed')
      return original(name, ...rest)
    })
    const fiber = b.ctx.plugin({ inject: [...inject], apply: (plugin: Context) => mountForgePanel(plugin, REMOTE) })
    await expect(fiber).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
    expect(b.unregisterTab).toHaveBeenCalled()
  })
})

describe('mountForgePanel extension API', () => {
  it('provides the changes view face, which opens a view in the shown Session and is withdrawn on unload', async () => {
    const f = await fixture()
    const forgeChanges = f.ctx.get('forgeChanges')
    assert(forgeChanges !== undefined)
    expect(forgeChanges.kinds).toEqual({ changes: CHANGES_KIND })
    const target = { sessionId: S1, source: { kind: 'local' } } as const
    forgeChanges.open(target, { path: 'src/a.ts' })
    expect(f.sidebarRight.openResource).toHaveBeenCalledWith(forgeChanges.address(target), { params: { path: 'src/a.ts' } })
    forgeChanges.open(target)
    expect(f.sidebarRight.openResource).toHaveBeenLastCalledWith(forgeChanges.address(target), undefined)
    await f.dispose()
    await settle()
    expect(f.ctx.get('forgeChanges')).toBeUndefined()
  })

  it('streams the Host lenses to the changes view while it reads them, opens lens requests, and keeps one annotation view per address', async () => {
    const f = await fixture()
    const face = f.changes(S1)
    const seen = vi.fn()
    const stop = face.hooks.extensions.subscribe(seen)
    expect(face.hooks.extensions.getSnapshot().state).toBeNull()
    f.extensionStreams[0]?.push({ lenses: [{ id: 'fixture/exports', version: '1' }], maxAnnotationsPerFile: 4 })
    await settle()
    expect(face.hooks.extensions.getSnapshot().state).toEqual({ lenses: [{ id: 'fixture/exports', version: '1' }], maxAnnotationsPerFile: 4 })
    const forgeChanges = f.ctx.get('forgeChanges')
    assert(forgeChanges !== undefined)
    const relay = vi.fn()
    const unrelay = forgeChanges.extensions.subscribe(relay)
    f.extensionStreams[0]?.push({ lenses: [], maxAnnotationsPerFile: 4 })
    await settle()
    expect(forgeChanges.extensions.getSnapshot()).toEqual({ lenses: [], maxAnnotationsPerFile: 4 })
    expect(relay).toHaveBeenCalled()
    unrelay()
    stop()
    expect(face.hooks.lenses).toBe(forgeChanges.lenses)

    const request: ForgeLensRequest = { source: { kind: 'local', scope: { kind: 'unstaged' } }, version: 'v', lens: 'fixture/exports' }
    face.changesLens(request, new AbortController().signal)
    expect(f.forgePanel.changesLens).toHaveBeenCalledWith(S1, request, expect.any(AbortSignal))

    const address = forgeChanges.address({ sessionId: S1, source: { kind: 'local' } })
    const view = face.keyedHooks.annotations(address)
    expect(face.keyedHooks.annotations(address)).toBe(view)
    expect(face.keyedHooks.annotations(forgeChanges.address({ sessionId: S1, source: { kind: 'change', url: 'https://github.com/octo/demo/pull/7' } })))
      .not.toBe(view)
    expect(() => face.keyedHooks.annotations('dsh-resource://forge-changes/s1/remote')).toThrow('forge-panel: not a changes address')

    await f.dispose()
    expect(f.extensionStreams[0]?.disposed).toHaveBeenCalled()
  })
})

describe('mountForgePanel Session list', () => {
  it('shares one change request state stream among every Session row and hover card while any of them reads it', async () => {
    const f = await fixture()
    const states = f.list('row').hooks.states
    expect(f.list('hover').hooks.states).toBe(states)
    expect(f.forgePanel.changeRequestStates).not.toHaveBeenCalled()

    const row = states.subscribe(() => {})
    const hover = states.subscribe(() => {})
    f.stateStreams[0]?.push({ type: 'baseline', states: [listState(1)] })
    await vi.waitFor(() => { expect([...states.getSnapshot().state.values()]).toEqual([listState(1)]) })
    row()
    expect(f.stateStreams[0]?.disposed).not.toHaveBeenCalled()
    hover()

    expect(f.forgePanel.changeRequestStates).toHaveBeenCalledOnce()
    expect(f.stateStreams[0]?.disposed).toHaveBeenCalled()
    expect(f.stateStreams[0]?.signal.aborted).toBe(true)
    await f.dispose()
  })
})

describe('mountForgePanel Session stores', () => {
  it('shares one panel stream per Session between the Session panel entries, the worktree option, and the worktree card', async () => {
    const f = await fixture()
    const tab = f.section(S1)
    const faces = [f.actions(S1), f.checkout(S1), f.local(S1), f.connection(S1), f.attention(S1), f.worktree(S1), f.progress(S1)]
    for (const face of faces) {
      expect(face.hooks.panel).toBe(tab.hooks.panel)
    }
    expect(f.section(S2).hooks.panel).not.toBe(tab.hooks.panel)
    expect(f.forgePanel.follow).not.toHaveBeenCalled()

    const seen: unknown[] = []
    const unsubscribe = tab.hooks.panel.subscribe(() => { seen.push(tab.hooks.panel.getSnapshot().state) })
    await vi.waitFor(() => { expect(f.forgePanel.follow).toHaveBeenCalledWith(S1, expect.any(AbortSignal)) })
    f.streams[0]?.push(ready())
    await vi.waitFor(() => { expect(seen).toEqual([ready()]) })

    f.connection(S1).reconnect()
    expect(f.forgePanel.follow).toHaveBeenCalledOnce()
    f.ctx.emit('connection/reset')
    expect(f.streams[0]?.disposed).toHaveBeenCalled()
    await vi.waitFor(() => { expect(f.forgePanel.follow).toHaveBeenCalledTimes(2) })
    unsubscribe()
    expect(f.streams[1]?.disposed).toHaveBeenCalled()
    await f.dispose()
  })

  it('follows a Session panel only after the Session opened, holding a reference until the stream ends', async () => {
    const f = await fixture()
    const opening = Promise.withResolvers<ReturnType<typeof opened>>()
    const release = vi.fn()
    f.sessions.retain.mockReturnValueOnce({ sessionId: S1, ready: opening.promise, release })
    const unsubscribe = f.section(S1).hooks.panel.subscribe(() => {})
    expect(f.sessions.retain.mock.calls.at(-1)?.[0]).toBe(S1)
    expect(f.sessions.retain.mock.calls.at(-1)?.[1]).toMatchObject({ source: 'forgePanel' })
    expect(f.sessions.retain.mock.calls.at(-1)?.[1].signal).toBeInstanceOf(AbortSignal)
    await settle()
    expect(f.forgePanel.follow).not.toHaveBeenCalled()

    opening.resolve(opened())
    await vi.waitFor(() => { expect(f.forgePanel.follow).toHaveBeenCalledOnce() })
    expect(release).not.toHaveBeenCalled()
    unsubscribe()
    await vi.waitFor(() => { expect(release).toHaveBeenCalledOnce() })
    expect(f.streams[0]?.disposed).toHaveBeenCalled()
    await f.dispose()
  })

  it('releases the reference without following when the panel closes before the Session opens', async () => {
    const f = await fixture()
    const release = vi.fn()
    f.sessions.retain.mockImplementationOnce((sessionId, options) => {
      const ready = new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => { reject(new Error('waiter aborted')) }, { once: true })
      })
      return { sessionId, ready, release }
    })
    const unsubscribe = f.section(S1).hooks.panel.subscribe(() => {})
    await settle()
    unsubscribe()
    await vi.waitFor(() => { expect(release).toHaveBeenCalledOnce() })
    expect(f.forgePanel.follow).not.toHaveBeenCalled()
    await f.dispose()
  })

  it.each([
    ['not open', opened('error', new Error('history failed'))],
    ['not open without a reported error', opened('error')],
  ])('shows the panel disconnected when the Session is %s, and follows after a reconnect', async (_name, binding) => {
    const f = await fixture()
    const release = vi.fn()
    f.sessions.retain.mockReturnValueOnce({ sessionId: S1, ready: Promise.resolve(binding), release })
    const panel = f.section(S1).hooks.panel
    const unsubscribe = panel.subscribe(() => {})
    await vi.waitFor(() => { expect(panel.getSnapshot().disconnected).toBe(true) })
    expect(release).toHaveBeenCalledOnce()
    expect(f.forgePanel.follow).not.toHaveBeenCalled()

    f.connection(S1).reconnect()
    await vi.waitFor(() => { expect(f.forgePanel.follow).toHaveBeenCalledOnce() })
    unsubscribe()
    await f.dispose()
  })

  it('shares the Host facts between Sessions and reads them again after each reconnect', async () => {
    const f = await fixture()
    const host = f.checkout(S1).hooks.host
    expect(f.checkout(S2).hooks.host).toBe(host)
    expect(host.getSnapshot()).toEqual({ home: '/home/octo', isLoopback: true })
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)

    f.remote.$host = { home: '/home/other', isLoopback: false }
    f.ctx.emit('connection/reset')
    expect(listener).toHaveBeenCalledOnce()
    expect(host.getSnapshot()).toEqual({ home: '/home/other', isLoopback: false })
    unsubscribe()
    f.ctx.emit('connection/reset')
    expect(listener).toHaveBeenCalledOnce()
    await f.dispose()
  })

  it('releases a closed Session and recreates its shared state on reopen', async () => {
    const f = await fixture()
    const first = f.section(S1)
    first.hooks.panel.subscribe(() => {})
    await settle()
    expect(f.attention(S1).hooks.panel).toBe(first.hooks.panel)
    f.streams[0]!.push(ready({ changeRequests: [entry(1, snapshot(1))] }))
    await settle()
    await f.scopes.get(S1)!.dispose()
    f.scopes.delete(S1)
    expect(f.streams[0]!.signal.aborted).toBe(true)
    const next = f.section(S1)
    expect(next.hooks.panel).not.toBe(first.hooks.panel)
    expect(next.hooks.panel.getSnapshot().state).toBeNull()
    expect(f.attention(S1).hooks.panel).toBe(next.hooks.panel)
    next.hooks.panel.subscribe(() => {})
    await vi.waitFor(() => { expect(f.streams).toHaveLength(2) })
    await f.dispose()
  })

  it('publishes the selected language and refuses state for a released Session', async () => {
    const f = await fixture()
    const locale = f.section(S1).hooks.locale
    const changed = vi.fn()
    const unsubscribe = locale.subscribe(changed)
    f.ctx.locale.addLanguage({ id: 'de', label: 'Deutsch', fallback: 'en' })
    f.ctx.locale.setLocale('de')
    expect(locale.getSnapshot()).toBe('de')
    expect(f.ctx.locale.bind(NS)('tab.title')).toBe('Änderungsanfragen')
    expect(f.ctx.locale.bind(NS)('change.mergeTitle', { name: '#7', base: 'main' })).toBe('#7 in main zusammenführen')
    expect(changed).toHaveBeenCalled()
    unsubscribe()
    f.sessions.scope.mockReturnValue(undefined)
    expect(() => f.section(S2)).toThrow('is not retained')
    await f.dispose()
  })
})

describe('mountForgePanel Session panel actions', () => {
  it('opens links outside the app', async () => {
    const f = await fixture()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    f.section(S1).openLink('https://github.com/octo/demo/pull/1')
    expect(open).toHaveBeenCalledWith('https://github.com/octo/demo/pull/1', '_blank', 'noopener,noreferrer')
    await f.dispose()
  })

  it.each([
    ['confirms a completed copy', async () => {}, { key: 'toast.copied', tone: 'success' }],
    ['reports a refused copy', async () => { throw new Error('denied') }, { key: 'toast.copyFailed', tone: 'failure' }],
  ])('copies text to the clipboard and %s', async (_label, write, outcome) => {
    const f = await fixture()
    const writeText = vi.fn(async (_text: string) => { await write() })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    f.section(S1).copyText('gh auth login --hostname github.com')
    await settle()

    expect(writeText).toHaveBeenCalledWith('gh auth login --hostname github.com')
    expect(f.notice()).toMatchObject({ ...outcome, params: {}, undo: undefined })
    await f.dispose()
  })

  it('opens the changes of a change request and of the branch in the right sidebar of the Session', async () => {
    const f = await fixture()
    const url = 'https://github.com/octo/demo/pull/7'
    f.section(S1).viewChanges(entry(7, snapshot(7)))
    expect(f.sidebarRight.openResourceIn).toHaveBeenCalledWith(S1, changesAddress({ sessionId: S1, source: { kind: 'change', url } }))
    f.local(S1).viewLocalChanges()
    expect(f.sidebarRight.openResourceIn).toHaveBeenLastCalledWith(S1, changesAddress({ sessionId: S1, source: { kind: 'local' } }))
    await f.dispose()
  })

  it('refreshes through the Remote for a card retry and reports only a failure', async () => {
    const f = await fixture()
    await f.section(S1).refresh()
    expect(f.forgePanel.refresh).toHaveBeenCalledWith(S1)
    expect(f.notice()).toBeNull()

    f.forgePanel.refresh.mockResolvedValueOnce(REFUSED.failed)
    await f.section(S1).refresh()
    expect(f.notice()).toMatchObject({ key: 'toast.refreshFailed', tone: 'failure' })
    await f.dispose()
  })

  it('revisits each Session automatically at most once every 10 seconds', async () => {
    const f = await fixture()
    for (const id of [S1, S2]) f.section(id).hooks.panel.subscribe(() => {})
    await vi.waitFor(() => { expect(f.streams).toHaveLength(2) })
    for (const handle of f.streams) handle.push(ready())
    await vi.waitFor(() => { expect(f.section(S2).hooks.panel.getSnapshot().state).not.toBeNull() })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const refreshIfStale = f.checkout(S1).refreshIfStale
    expect(f.checkout(S1).refreshIfStale).toBe(refreshIfStale)
    refreshIfStale()
    refreshIfStale()
    f.checkout(S2).refreshIfStale()
    expect(f.forgePanel.revisit.mock.calls).toEqual([[S1], [S2]])
    now.mockReturnValue(1_009_999)
    refreshIfStale()
    expect(f.forgePanel.revisit).toHaveBeenCalledTimes(2)
    now.mockReturnValue(1_010_000)
    refreshIfStale()
    expect(f.forgePanel.revisit.mock.calls).toEqual([[S1], [S2], [S1]])
    // The refresh a reader asks for is a separate, forced read.
    expect(f.forgePanel.refresh).not.toHaveBeenCalled()
    f.forgePanel.revisit.mockResolvedValueOnce(REFUSED.failed)
    now.mockReturnValue(1_020_000)
    refreshIfStale()
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.refreshFailed', tone: 'failure' })
    await f.dispose()
  })

  it('defers an automatic revisit asked for before the panel state arrives until the Host follows the panel', async () => {
    const f = await fixture()
    const unsubscribe = f.section(S1).hooks.panel.subscribe(() => {})
    f.checkout(S1).refreshIfStale()
    await vi.waitFor(() => { expect(f.forgePanel.follow).toHaveBeenCalledOnce() })
    expect(f.forgePanel.revisit).not.toHaveBeenCalled()
    f.streams[0]?.push(ready())
    await vi.waitFor(() => { expect(f.forgePanel.revisit).toHaveBeenCalledWith(S1) })
    f.streams[0]?.push(ready({ local: null }))
    await settle()
    expect(f.forgePanel.revisit).toHaveBeenCalledOnce()
    // A later stream revisits nothing on its own: only a revisit that was asked for waits for the first state.
    f.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(f.streams).toHaveLength(2) })
    f.streams[1]?.push(ready())
    await settle()
    expect(f.forgePanel.revisit).toHaveBeenCalledOnce()
    unsubscribe()
    await f.dispose()
  })

  it('closes the panel, Session list, and review count streams once the page was hidden for 30 seconds, and opens them when it shows', async () => {
    const f = await fixture()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const show = (state: DocumentVisibilityState): void => {
      visibility.mockReturnValue(state)
      document.dispatchEvent(new Event('visibilitychange'))
    }
    const panel = f.section(S1).hooks.panel.subscribe(() => {})
    const list = f.list('row').hooks.states.subscribe(() => {})
    const extensions = f.changes(S1).hooks.extensions.subscribe(() => {})
    const face = f.entry('sidebar.panellist.trailing', ReviewNavCount)?.inject?.()
    assert(face !== undefined && isReviewCountFace(face))
    const count = face.hooks.count.subscribe(() => {})
    await vi.waitFor(() => { expect(f.streams).toHaveLength(1) })
    vi.useFakeTimers()
    try {
      show('hidden')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(f.streams[0]?.disposed).toHaveBeenCalled()
      expect(f.stateStreams[0]?.disposed).toHaveBeenCalled()
      expect(f.countStreams[0]?.disposed).toHaveBeenCalled()
      // The extension stream reads nothing from a code host and stays open.
      expect(f.extensionStreams[0]?.disposed).not.toHaveBeenCalled()

      show('visible')
      await vi.waitFor(() => { expect(f.streams).toHaveLength(2) })
      expect(f.stateStreams).toHaveLength(2)
      expect(f.countStreams).toHaveLength(2)
      expect(f.extensionStreams).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      visibility.mockRestore()
    }
    panel()
    list()
    extensions()
    count()
    await f.dispose()
  })

  it('restores a removed worktree, confirming it or reporting why it failed until the notice is dismissed', async () => {
    const f = await fixture()
    f.checkout(S1).restore()
    await settle()
    expect(f.forgePanel.restoreWorktree).toHaveBeenCalledWith(S1)
    expect(f.notice()).toMatchObject({ key: 'toast.restored', tone: 'success', seq: 1 })

    f.forgePanel.restoreWorktree.mockResolvedValueOnce(REFUSED.restore)
    f.checkout(S1).restore()
    await settle()
    expect(f.notice()).toMatchObject({
      key: 'toast.restoreFailed', tone: 'failure', seq: 2, params: { message: 'fatal: \'/work/repo-dsh\' already exists' },
    })
    f.toast().dismiss()
    expect(f.notice()).toBeNull()
    await f.dispose()
  })
})

describe('mountForgePanel removal', () => {
  it('removes a change request and offers to restore it', async () => {
    const f = await fixture()
    const value = entry(7, snapshot(7))
    f.section(S1).remove(value)
    await settle()
    expect(f.forgePanel.dismiss).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7')
    const removed = f.notice()
    expect(removed).toMatchObject({ key: 'toast.removed', tone: 'success', params: { name: '#7' } })

    removed?.undo?.()
    await settle()
    expect(f.forgePanel.track).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7')
    expect(f.notice()).toBe(removed)

    f.forgePanel.track.mockResolvedValueOnce(REFUSED.failed)
    removed?.undo?.()
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.undoFailed', tone: 'failure' })
    await f.dispose()
  })

  it.each([
    ['its URL when it has neither a number nor a snapshot', unserved('https://example.test/review/latest'),
      'https://example.test/review/latest'],
    ['its title when it has no number', { ...unserved('https://example.test/review/latest'), snapshot: snapshot(3) }, 'Change 3'],
    ['the number in its URL', unserved('https://example.test/review/17'), '#17'],
  ])('names a removed unserved change request by %s, without undo', async (_label, value, name) => {
    const f = await fixture()
    f.section(S1).remove(value)
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.removed', tone: 'success', params: { name }, undo: undefined })
    await f.dispose()
  })

  it('reports a failed removal without offering undo', async () => {
    const f = await fixture()
    f.forgePanel.dismiss.mockResolvedValueOnce(REFUSED.failed)
    f.section(S1).remove(entry(7, snapshot(7)))
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.removeFailed', tone: 'failure', params: {}, undo: undefined })
    await f.dispose()
  })
})

describe('mountForgePanel change request actions', () => {
  it.each([
    ['confirms it', OK, { key: 'toast.markedReady', tone: 'success', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused, { key: 'toast.markReadyFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown, { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('marks a draft ready through the Remote and %s', async (_label, result, notice) => {
    const f = await fixture()
    f.forgePanel.markReady.mockResolvedValueOnce(result)
    await f.section(S1).markReady(entry(7, snapshot(7, { draft: true })))
    expect(f.forgePanel.markReady).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7')
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it.each([
    ['confirms it', OK, { key: 'toast.merged', tone: 'success', params: { name: '#7' } }],
    ['says a moved head needs another look', REFUSED.stale, { key: 'toast.mergeStale', tone: 'failure', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused, { key: 'toast.mergeFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown, { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('merges through the Remote with the confirmed head and %s', async (_label, result, notice) => {
    const f = await fixture()
    f.forgePanel.merge.mockResolvedValueOnce(result)
    await f.section(S1).merge(entry(7, snapshot(7)), { method: 'rebase', headSha: 'b'.repeat(40) })
    expect(f.forgePanel.merge).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7', 'rebase', 'b'.repeat(40))
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })
})

describe('mountForgePanel overview actions', () => {
  const url = 'https://github.com/octo/demo/pull/7'

  it.each([
    ['confirms it', OK, { key: 'toast.rerunRequested', tone: 'success', params: { name: '#7' } }],
    ['says a moved head needs another look', REFUSED.stale, { key: 'toast.rerunStale', tone: 'failure', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused, { key: 'toast.rerunFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown, { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('reruns failed checks through the Remote and %s', async (_label, result, notice) => {
    const f = await fixture()
    f.forgePanel.rerunChecks.mockResolvedValueOnce(result)
    await f.section(S1).rerunChecks(entry(7, snapshot(7)), { headSha: 'b'.repeat(40) })
    expect(f.forgePanel.rerunChecks).toHaveBeenCalledWith(S1, url, { headSha: 'b'.repeat(40) })
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it.each([
    ['confirms it', OK, { key: 'toast.reviewRequested', tone: 'success', params: { name: '#7', login: 'mona, lin' } }],
    ['reports why the host refused', REFUSED.refused, { key: 'toast.reviewRequestFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown, { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('requests reviews through the Remote and %s', async (_label, result, notice) => {
    const f = await fixture()
    f.forgePanel.requestReviews.mockResolvedValueOnce(result)
    const reviewers = [{ kind: 'user' as const, login: 'mona' }, { kind: 'user' as const, login: 'lin' }]
    await f.section(S1).requestReviews(entry(7, snapshot(7)), reviewers)
    expect(f.forgePanel.requestReviews).toHaveBeenCalledWith(S1, url, reviewers)
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it('lists reviewer candidates through the Remote and rejects with the host\'s reason', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    await expect(f.section(S1).reviewerCandidates(url, 'mo', signal)).resolves.toEqual([{ login: 'mona', name: null, avatarUrl: null, suggested: true }])
    expect(f.forgePanel.reviewerCandidates).toHaveBeenCalledWith(S1, url, 'mo', signal)
    f.forgePanel.reviewerCandidates.mockResolvedValueOnce({ ok: false, error: new RemoteError('forgePanel/reviewers-failed', 'down', {}) })
    await expect(f.section(S1).reviewerCandidates(url, '', signal)).rejects.toThrow('down')
    await f.dispose()
  })

  it.each([
    ['confirms it', OK, { key: 'toast.branchUpdated', tone: 'success', params: { name: '#7' } }],
    ['says a moved head needs another look', REFUSED.stale, { key: 'toast.branchUpdateStale', tone: 'failure', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused, { key: 'toast.branchUpdateFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown, { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('updates the branch through the Remote with the confirmed head and %s', async (_label, result, notice) => {
    const f = await fixture()
    f.forgePanel.updateBranch.mockResolvedValueOnce(result)
    await f.section(S1).updateBranch(entry(7, snapshot(7)), { method: 'rebase', headSha: 'b'.repeat(40) })
    expect(f.forgePanel.updateBranch).toHaveBeenCalledWith(S1, url, 'rebase', 'b'.repeat(40))
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it('reads and saves the host\'s viewed marks through the Remote', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    const view = f.changes(S1)
    expect(await view.changeRequestViewed(url, 'a'.repeat(40), true, signal)).toEqual({ ok: true, value: null })
    expect(f.forgePanel.changeRequestViewed).toHaveBeenCalledWith(S1, url, 'a'.repeat(40), true, signal)
    const request = { path: 'src/a.ts', viewed: true, headSha: 'a'.repeat(40) }
    expect(await view.setFileViewed(url, request)).toEqual(OK)
    expect(f.forgePanel.setFileViewed).toHaveBeenCalledWith(S1, url, request)
    await f.dispose()
  })
})

describe('mountForgePanel worktree actions', () => {
  it('requests and withdraws a worktree through the Remote', async () => {
    const f = await fixture()
    const option = f.worktree(S1)
    expect(await option.request('refs/heads/release', 'fix/x')).toBe('accepted')
    expect(await option.request(null, null)).toBe('accepted')
    expect(await option.cancel()).toBe(true)
    expect(f.forgePanel.requestWorktree.mock.calls).toEqual([[S1, 'refs/heads/release', 'fix/x'], [S1, null, null]])
    expect(f.forgePanel.cancelWorktree).toHaveBeenCalledWith(S1)
    expect(f.notice()).toBeNull()
    await f.dispose()
  })

  it.each([
    ['a started Session', REFUSED.started, 'toast.worktreeStarted'],
    ['a missing worktree service', REFUSED.unavailable, 'toast.worktreeFailed'],
    ['any other failure', REFUSED.failed, 'toast.worktreeFailed'],
  ])('reports a request or withdrawal refused for %s', async (_label, refusal, key) => {
    const f = await fixture()
    const option = f.worktree(S1)
    f.forgePanel.requestWorktree.mockResolvedValueOnce(refusal)
    expect(await option.request('refs/heads/main', null)).toBe('failed')
    expect(f.notice()).toMatchObject({ key, tone: 'failure', seq: 1 })
    f.forgePanel.cancelWorktree.mockResolvedValueOnce(refusal)
    expect(await option.cancel()).toBe(false)
    expect(f.notice()).toMatchObject({ key, tone: 'failure', seq: 2 })
    await f.dispose()
  })

  it.each([
    ['branch-exists', REFUSED.exists],
    ['invalid-name', REFUSED.invalidName],
  ] as const)('returns a branch name refused as %s to the naming dialog without a notice', async (result, refusal) => {
    const f = await fixture()
    f.forgePanel.requestWorktree.mockResolvedValueOnce(refusal)
    expect(await f.worktree(S1).request(null, 'taken')).toBe(result)
    f.forgePanel.requestWorktree.mockResolvedValueOnce(refusal)
    expect(await f.progress(S1).request(null, 'taken')).toBe(result)
    expect(f.notice()).toBeNull()
    await f.dispose()
  })

  it('lists the bases of a new worktree through the Remote', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    expect(await f.worktree(S1).bases('rel', signal)).toEqual({ ok: true, value: BASES })
    expect(f.forgePanel.worktreeBases).toHaveBeenCalledWith(S1, 'rel', signal)
    await f.dispose()
  })
})

describe('mountForgePanel worktree card actions', () => {
  it.each([
    ['stops the attempt a message waits for', 'stop' as const, 'stopCreation' as const, []],
    ['makes another attempt for the waiting message', 'retry' as const, 'retryWorktree' as const, [false]],
    ['withdraws the request so the waiting message goes on', 'withdraw' as const, 'cancelWorktree' as const, []],
  ])('%s through the Remote and reports only a failure', async (_label, action, method, args) => {
    const f = await fixture()
    f.progress(S1)[action](false)
    await settle()
    expect(f.forgePanel[method]).toHaveBeenCalledWith(S1, ...args)
    expect(f.notice()).toBeNull()

    f.forgePanel[method].mockResolvedValueOnce(REFUSED.busy)
    f.progress(S1)[action](false)
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.worktreeFailed', tone: 'failure' })
    await f.dispose()
  })

  it('restores a removed worktree through the Remote and confirms it', async () => {
    const f = await fixture()
    expect(await f.progress(S1).restore()).toBeUndefined()
    expect(f.forgePanel.restoreWorktree).toHaveBeenCalledWith(S1)
    expect(f.notice()).toMatchObject({ key: 'toast.restored', tone: 'success' })
    await f.dispose()
  })

  it('returns why a restore failed for the card to show, without a notice', async () => {
    const f = await fixture()
    f.forgePanel.restoreWorktree.mockResolvedValueOnce(REFUSED.restore)
    expect(await f.progress(S1).restore()).toBe('fatal: \'/work/repo-dsh\' already exists')
    expect(f.notice()).toBeNull()
    await f.dispose()
  })

  it('continues in the project through the Remote and reports only a failure', async () => {
    const f = await fixture()
    f.progress(S1).leave()
    await settle()
    expect(f.forgePanel.continueInProject).toHaveBeenCalledWith(S1)
    expect(f.notice()).toBeNull()

    f.forgePanel.continueInProject.mockResolvedValueOnce(REFUSED.busy)
    f.progress(S1).leave()
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.leaveFailed', tone: 'failure' })
    await f.dispose()
  })
})

describe('mountForgePanel changes view', () => {
  it('inserts numbered frozen quotes in the originating Session without sending a message', async () => {
    const f = await fixture()
    try {
      const selection: ReviewSelection = { source: { kind: 'local', scope: 'branch', base: 'origin/main', baseRef: null, commits: null }, comment: { path: 'a.ts', side: 'R', startLine: 1, endLine: 1, body: 'Check this', hunk: '@@ -1 +1 @@\n-old\n+new' } }
      const scope = f.sessions.scope(S1)!
      let draft = ''
      const focus = vi.fn(), send = vi.fn()
      const insertQuote = vi.fn((text: string, _summary?: QuoteSummary) => { draft += `\n> ${text}`; return true })
      const input = { state: { getSnapshot: () => ({ draft }) }, insertQuote, focus }
      const resolve = vi.fn(() => input)
      // Only the input methods used by this contribution are supplied by the Session fixture.
      vi.spyOn(scope, 'get').mockImplementation(name => name === 'conversation' ? { input: { for: resolve }, send } as never : undefined)
      const view = f.changes(S1)
      expect(view.addReviewToInput(selection)).toBe(true)
      expect(view.addReviewToInput(selection)).toBe(true)
      expect(insertQuote.mock.calls.map(([text]) => text.split('\n')[0])).toEqual(['## User Comment 1', '## User Comment 2'])
      expect(insertQuote.mock.calls[0]?.[1]).toEqual({ label: 'a.ts R1', title: 'a.ts', detail: 'R1', body: 'Check this' })
      expect(resolve).toHaveBeenCalledWith(scope)
      expect(focus).toHaveBeenCalledTimes(2)
      const thread = reviewThread({ path: 'src/a.ts' })
      expect(view.addThreadToInput(thread, 'https://github.com/octo/demo/pull/7', 'R3')).toBe(true)
      expect(view.addThreadToInput(thread, 'https://github.com/octo/demo/pull/7', 'R3')).toBe(true)
      expect(insertQuote.mock.calls.slice(2).map(([text, summary]) => [text.split('\n')[0], summary?.label]))
        .toEqual([['## Review Thread 1', 'a.ts R3'], ['## Review Thread 2', 'a.ts R3']])
      insertQuote.mockClear()
      focus.mockClear()
      insertQuote.mockReturnValueOnce(false)
      expect(view.addReviewToInput(selection)).toBe(false)
      expect(focus).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
      const request: ForgeReviewRequest = { kind: 'review', headSha: 'a', event: 'comment', body: 'Summary', comments: [] }
      expect(await view.submitReview('https://github.com/pr', request)).toMatchObject({ ok: true, value: { ok: true } })
      expect(f.forgePanel.submitReview).toHaveBeenCalledWith(S1, 'https://github.com/pr', request)
    } finally { await f.dispose() }
  })
  it.each(['no scope', 'no conversation'] as const)('refuses a quote with %s', async (missing) => {
    const f = await fixture()
    try {
      const view = f.changes(S1)
      if (missing === 'no scope') f.sessions.scope.mockReturnValue(undefined)
      expect(view.addReviewToInput({ source: { kind: 'local', scope: 'branch', base: 'origin/main', baseRef: null, commits: null }, comment: { path: 'a', side: 'L', startLine: 1, endLine: 1, body: 'Comment', hunk: '' } })).toBe(false)
    } finally { await f.dispose() }
  })
  it('immediately closes an already-aborted occurrence and reports failed removal', async () => {
    const f = await fixture()
    try {
      const lifetime = new AbortController()
      lifetime.abort()
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new Error('storage denied') })
      expect(f.changes(S1).reviewQueue({ id: 'closed', signal: lifetime.signal }).getSnapshot().comments).toEqual([])
      expect(f.notice()).toMatchObject({ key: 'review.saveFailed' })
    } finally { await f.dispose() }
  })
  it.each(['local', 'change'] as const)('retains %s records across Session switches and clears only the closed tab', async (kind) => {
    const f = await fixture()
    const lifetime = new AbortController()
    const tab = { id: 'review-tab' as TabId, signal: lifetime.signal }
    const selection: ReviewSelection = { source: kind === 'local' ? { kind, scope: 'branch', base: 'origin/main', baseRef: null, commits: null }
      : { kind, url: 'https://github.com/octo/demo/pull/7', headSha: 'a'.repeat(40), commits: null },
    comment: { path: 'a.ts', side: 'R', startLine: 1, endLine: 1, body: 'Check this', hunk: '@@ -1 +1 @@\n-old\n+new' } }
    const queue = f.changes(S1).reviewQueue(tab)
    queue.recordAgent(selection)
    queue.summarize('Summary', 'comment')
    const otherTab = { id: 'other-tab' as TabId, signal: new AbortController().signal }
    const other = f.changes(S1).reviewQueue(otherTab)
    other.recordAgent(selection)
    expect(f.changes(S2).reviewQueue({ id: tab.id, signal: new AbortController().signal }).getSnapshot().records).toEqual([])
    expect(f.changes(S1).reviewQueue(tab)).toBe(queue)
    expect(queue.getSnapshot().records).toHaveLength(1)
    lifetime.abort()
    expect(queue.getSnapshot()).toMatchObject({ comments: [], records: [], body: '', uncertain: null })
    expect(other.getSnapshot().records).toHaveLength(1)
    const reopened = f.changes(S1).reviewQueue({ id: tab.id, signal: new AbortController().signal })
    expect(reopened).not.toBe(queue)
    expect(reopened.getSnapshot()).toMatchObject({ comments: [], records: [], body: '' })
    expect(queue.recordAgent(selection)).toBe(false)
    await f.dispose()
  })
  it('reads the changes of the Session through the Remote and shares its panel stream', async () => {
    const f = await fixture()
    const view = f.changes(S1)
    expect(view.keyedHooks.panel('visible')).toBe(f.section(S1).hooks.panel)
    expect(view.keyedHooks.panel('inactive')).toBeUndefined()
    const signal = new AbortController().signal
    expect(await view.localDiff({ kind: 'staged' }, signal)).toEqual({ ok: true, value: LOCAL })
    expect(await view.localText({ kind: 'staged' }, 'src/a.ts')).toEqual({ ok: true, value: 'a\n' })
    expect(await view.diffBases('rel', signal)).toEqual({ ok: true, value: { automatic: null, remote: [], local: [] } })
    expect(f.forgePanel.diffBases).toHaveBeenCalledWith(S1, 'rel', signal)
    expect(await view.changeRequestDiff('https://github.com/octo/demo/pull/7', null, signal)).toEqual({ ok: true, value: CHANGE })
    expect(await view.changeRequestText('https://github.com/octo/demo/pull/7', 'a'.repeat(40), 'src/a.ts')).toEqual({ ok: true, value: 'b\n' })
    expect(f.forgePanel.localDiff).toHaveBeenCalledWith(S1, { kind: 'staged' }, signal)
    expect(f.forgePanel.localText).toHaveBeenCalledWith(S1, { kind: 'staged' }, 'src/a.ts')
    expect(f.forgePanel.changeRequestDiff).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7', null, signal)
    expect(f.forgePanel.changeRequestText).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7', 'a'.repeat(40), 'src/a.ts')
    expect(await view.localCommits('refs/heads/topic', signal)).toEqual({ ok: true, value: COMMITS })
    expect(f.forgePanel.localCommits).toHaveBeenCalledWith(S1, 'refs/heads/topic', signal)
    expect(await view.changeRequestCommits('https://github.com/octo/demo/pull/7', signal)).toEqual({ ok: true, value: COMMITS })
    expect(f.forgePanel.changeRequestCommits).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7', signal)
    expect(await view.changeRequestReview('https://github.com/octo/demo/pull/7', 'a'.repeat(40), true, signal))
      .toEqual({ ok: true, value: { headSha: 'a'.repeat(40), viewer: 'octo', threads: [], truncated: false, pendingReview: null, viewerCanReview: true, reviewEvents: ['comment', 'approve', 'request-changes'] } })
    expect(f.forgePanel.changeRequestReview).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7', 'a'.repeat(40), true, signal)
    const write = { kind: 'resolve', headSha: 'a'.repeat(40), thread: 'thread-1' as ForgeThreadId, resolved: true } as const
    expect(await view.changeRequestReviewWrite('https://github.com/octo/demo/pull/7', write)).toEqual({ ok: true, value: { ok: true } })
    expect(f.forgePanel.changeRequestReviewWrite).toHaveBeenCalledWith(S1, 'https://github.com/octo/demo/pull/7', write)
    expect(view.viewedFiles).toBe(f.changes(S1).viewedFiles)
    expect(view.viewedFiles).not.toBe(f.changes(S2).viewedFiles)
    view.reconnect()
    expect(f.forgePanel.follow).not.toHaveBeenCalled()
    await f.dispose()
  })

  it('opens links outside the app, reports what the view asks for, and copies paths', async () => {
    const f = await fixture()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    f.changes(S1).openLink('https://github.com/octo/demo/blob/main/a.ts')
    expect(open).toHaveBeenCalledWith('https://github.com/octo/demo/blob/main/a.ts', '_blank', 'noopener,noreferrer')
    f.changes(S1).report('toast.expandStale')
    expect(f.notice()).toMatchObject({ key: 'toast.expandStale', tone: 'failure', params: {} })
    f.changes(S1).report('toast.expandFailed', { params: { message: 'gone' } })
    expect(f.notice()).toMatchObject({ key: 'toast.expandFailed', tone: 'failure', params: { message: 'gone' }, undo: undefined })
    // The view names the tone and the undo action of each notice; the notice store shows them as given.
    const undo = vi.fn()
    f.changes(S1).report('review.recordRemoved', { tone: 'success', undo })
    expect(f.notice()).toMatchObject({ key: 'review.recordRemoved', tone: 'success', params: {}, undo })

    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    f.changes(S1).copyPath('src/a.ts')
    await settle()
    expect(writeText).toHaveBeenCalledWith('src/a.ts')
    expect(f.notice()).toMatchObject({ key: 'toast.pathCopied', tone: 'success' })
    await f.dispose()
  })

  it('sends the request for a change request to the Session as a message and confirms it', async () => {
    const f = await fixture()
    const send = vi.fn(async (_text: string) => {})
    const scope = f.sessions.scope(S1)!
    vi.spyOn(scope, 'get').mockImplementation(name => name === 'conversation' ? { send } as never : undefined)
    f.changes(S1).createChangeRequest()
    await settle()
    const text = send.mock.calls[0]?.[0]
    expect([en['changes.local.prompt'], zh['changes.local.prompt']]).toContain(text)
    expect(f.notice()).toMatchObject({ key: 'toast.prompted', tone: 'success', params: { text } })

    send.mockRejectedValueOnce(new Error('rejected'))
    f.local(S1).createChangeRequest()
    await settle()
    expect(send).toHaveBeenCalledTimes(2)
    expect(f.notice()).toMatchObject({ key: 'toast.promptFailed', tone: 'failure' })
    await f.dispose()
  })

  it.each(['no scope', 'no conversation'] as const)('reports a prompt failure with %s', async (missing) => {
    const f = await fixture()
    const view = f.changes(S1)
    if (missing === 'no scope') f.sessions.scope.mockReturnValue(undefined)
    else vi.spyOn(f.sessions.scope(S1)!, 'get').mockReturnValue(undefined)
    view.createChangeRequest()
    expect(f.notice()).toMatchObject({ key: 'toast.promptFailed', tone: 'failure' })
    await f.dispose()
  })
})


describe('worktree row settings', () => {
  it('registers the row page over the worktree namespace and stages the retain switch as a boolean write', async () => {
    const f = await fixture()
    try {
      const registration = f.ctx.slots.entries('plugins.row.config').find(candidate => candidate.component === WorktreeSettings)
      expect(registration?.options).toMatchObject({ key: WORKTREE_ROW_KEY })
      const face = registration!.inject!() as Partial<WorktreeSettingsInjected>
      if (face.hooks === undefined || face.edit === undefined || face.save === undefined) throw new Error('expected the worktree settings face')
      f.worktreeForm.publish({ status: 'ready', value: { retainOnArchive: false }, base: { retainOnArchive: false }, user: {}, writable: true })
      expect(face.hooks.worktreeForm.getSnapshot()).toMatchObject({ available: true, dirty: false, retainOnArchive: { text: 'false' } })
      face.edit('retainOnArchive', 'true')
      expect(face.hooks.worktreeForm.getSnapshot()).toMatchObject({ dirty: true, retainOnArchive: { text: 'true', overridden: true } })
      face.save()
      await vi.waitFor(() => { expect(f.worktreeForm.mutate).toHaveBeenCalledOnce() })
      expect(f.worktreeForm.mutate.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['retainOnArchive'], value: true }])
    } finally { await f.ctx.fiber.dispose() }
    expect(f.worktreeForm.listenerCount()).toBe(0)
  })
})

describe('archive notices', () => {
  it('uses the scheduled cleanup notice and reports a later failure', async () => {
    const f = await fixture()
    try {
      const failed = vi.fn()
      f.ctx.on('workspace/archive-followup-failed', failed)
      const settled = Promise.withResolvers<RemoteResult<WorktreeCleanup | null>>()
      f.forgePanel.worktreeCleanup.mockImplementation(async (_id, revision) => revision === null
        ? { ok: true, value: { revision: 1, status: 'scheduled' } }
        : await settled.promise)
      expect(await f.ctx.waterfall('workspace/archive-notice', S1, () => Promise.resolve({ text: 'fallback', tone: 'success' as const })))
        .toEqual({ text: en['toast.archiveCleanupScheduled'], tone: 'success' })
      expect(f.notice()).toBeNull()
      settled.resolve({ ok: true, value: { revision: 1, status: 'failed' } })
      await vi.waitFor(() => { expect(failed).toHaveBeenCalledWith(S1, en['toast.archiveCleanupFailed']) })
      expect(f.notice()).toBeNull()
    } finally { await f.ctx.fiber.dispose() }
  })

  it.each(['retained', 'removed'] as const)('leaves the ordinary archive notice for %s worktrees', async (status) => {
    const f = await fixture()
    try {
      f.forgePanel.worktreeCleanup.mockResolvedValue({ ok: true, value: { revision: 1, status } })
      expect(await f.ctx.waterfall('workspace/archive-notice', S1, () => Promise.resolve({ text: 'fallback', tone: 'success' as const }))).toEqual({ text: 'fallback', tone: 'success' })
      expect(f.notice()).toBeNull()
    } finally { await f.ctx.fiber.dispose() }
  })

  it('emits nothing when a scheduled cleanup ends removed', async () => {
    const f = await fixture()
    try {
      const settled = vi.fn()
      const failed = vi.fn()
      f.ctx.on('workspace/archive-followup-settled', settled)
      f.ctx.on('workspace/archive-followup-failed', failed)
      f.forgePanel.worktreeCleanup.mockImplementation(async (_id, revision) => ({ ok: true, value: { revision: 1, status: revision === null ? 'scheduled' : 'removed' } }))
      expect(await f.ctx.waterfall('workspace/archive-notice', S1, () => Promise.resolve({ text: 'fallback', tone: 'success' as const })))
        .toEqual({ text: en['toast.archiveCleanupScheduled'], tone: 'success' })
      await vi.waitFor(() => { expect(f.forgePanel.worktreeCleanup).toHaveBeenCalledTimes(2) })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).not.toHaveBeenCalled()
      expect(failed).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  })

  it('restores the ordinary notice when a scheduled cleanup ends retained', async () => {
    const f = await fixture()
    try {
      const settled = vi.fn()
      f.ctx.on('workspace/archive-followup-settled', settled)
      f.forgePanel.worktreeCleanup.mockImplementation(async (_id, revision) => ({ ok: true, value: { revision: 1, status: revision === null ? 'scheduled' : 'retained' } }))
      expect(await f.ctx.waterfall('workspace/archive-notice', S1, () => Promise.resolve({ text: 'fallback', tone: 'success' as const })))
        .toEqual({ text: en['toast.archiveCleanupScheduled'], tone: 'success' })
      await vi.waitFor(() => { expect(settled).toHaveBeenCalledWith(S1) })
    } finally { await f.ctx.fiber.dispose() }
  })

  it('uses a warning for an already failed cleanup and falls back when its result is unavailable', async () => {
    const f = await fixture()
    try {
      const fallback = () => Promise.resolve({ text: 'fallback', tone: 'success' as const })
      f.forgePanel.worktreeCleanup.mockResolvedValueOnce({ ok: true, value: { revision: 1, status: 'failed' } })
      expect(await f.ctx.waterfall('workspace/archive-notice', S1, fallback)).toEqual({ text: en['toast.archiveCleanupFailed'], tone: 'warning' })
      expect(await f.ctx.waterfall('workspace/archive-notice', S1, fallback)).toEqual(await fallback())
      f.forgePanel.worktreeCleanup.mockResolvedValueOnce(REFUSED.failed)
      expect(await f.ctx.waterfall('workspace/archive-notice', S1, fallback)).toEqual(await fallback())
    } finally { await f.ctx.fiber.dispose() }
  })

  it.each(['result', 'rejection'] as const)('contains a transport failure and ignores a late %s after unload', async (mode) => {
    const f = await fixture()
    try {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const failed = vi.fn()
      f.ctx.on('workspace/archive-followup-failed', failed)
      f.forgePanel.worktreeCleanup.mockResolvedValueOnce({ ok: true, value: { revision: 1, status: 'scheduled' } })
        .mockRejectedValueOnce(new Error('connection lost'))
      await f.ctx.waterfall('workspace/archive-notice', S1, () => Promise.resolve(undefined))
      await vi.waitFor(() => { expect(warning).toHaveBeenCalledTimes(1) })
      const completed = Promise.withResolvers<RemoteResult<WorktreeCleanup | null>>()
      f.forgePanel.worktreeCleanup.mockResolvedValueOnce({ ok: true, value: { revision: 2, status: 'scheduled' } })
        .mockImplementationOnce(async () => await completed.promise)
      await f.ctx.waterfall('workspace/archive-notice', S1, () => Promise.resolve(undefined))
      await f.dispose()
      if (mode === 'result') completed.resolve({ ok: true, value: { revision: 2, status: 'failed' } })
      else completed.reject(new Error('late connection loss'))
      await completed.promise.catch(() => {})
      expect(failed).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  })

})

describe('mountForgePanel review page', () => {
  const url = 'https://github.com/octo/demo/pull/7'

  /** The review page's business face. */
  function reviewPage(f: Awaited<ReturnType<typeof fixture>>): ReviewPageInjected {
    const value = f.entry('main', ReviewPage)?.inject?.()
    assert(value !== undefined && isReviewPageFace(value))
    return value
  }

  it('registers the page, its navigation row and count, and its conversation while the Peer may read the review lists', async () => {
    const f = await fixture()
    expect(f.remoteAccess.whenAccess).toHaveBeenCalledWith('forgePanel/reviewLists', expect.any(Function))
    expect(f.entry('main', ReviewPage)).toMatchObject({ options: { key: REVIEW_PANEL }, locale: NS })
    expect(f.entry('main', ReviewPage)?.store).toBeDefined()
    expect(f.entry('main', ReviewPage)?.children).toEqual({ 'forge.review.conversation': { kind: 'single', scope: 'session' } })
    const row = f.entry('sidebar.panellist', ReviewNavIcon)
    expect(row).toMatchObject({ options: { id: REVIEW_PANEL, order: 20 }, locale: NS })
    expect([en['reviewPage.panel'], zh['reviewPage.panel']]).toContain(resolveSlotLabel(row?.options.label))
    expect(f.entry('sidebar.panellist.trailing', ReviewNavCount)).toMatchObject({ options: { id: REVIEW_PANEL }, locale: NS })
    expect(f.entry('forge.review.conversation', ReviewConversation)).toMatchObject({ locale: NS })
    await f.dispose()
  })

  it('withdraws the page, its navigation row and count, and its conversation, and closes the count, with its fiber', async () => {
    const b = await base()
    const fiber = b.ctx.plugin({ inject: [...inject], apply: (plugin: Context) => mountForgePanel(plugin, REMOTE) })
    await fiber
    const registered = (): boolean[] => [
      b.ctx.slots.entries('main').some(item => item.component === ReviewPage),
      b.ctx.slots.entries('sidebar.panellist').some(item => item.component === ReviewNavIcon),
      b.ctx.slots.entries('sidebar.panellist.trailing').some(item => item.component === ReviewNavCount),
      b.ctx.slots.entries('forge.review.conversation').some(item => item.component === ReviewConversation),
    ]
    expect(registered()).toEqual([true, true, true, true])
    const count = b.ctx.slots.entries('sidebar.panellist.trailing').find(item => item.component === ReviewNavCount)?.inject?.()
    assert(count !== undefined && isReviewCountFace(count))
    count.hooks.count.subscribe(() => {})
    expect(b.countStreams).toHaveLength(1)

    await fiber.dispose()

    expect(registered()).toEqual([false, false, false, false])
    expect(b.countStreams[0]?.disposed).toHaveBeenCalled()
    expect(b.countStreams[0]?.signal.aborted).toBe(true)
  })

  it('streams the number of requests for the user\'s review while the row reads it, again after a reconnect', async () => {
    const f = await fixture()
    const count = f.entry('sidebar.panellist.trailing', ReviewNavCount)?.inject?.()
    assert(count !== undefined && isReviewCountFace(count))
    const { hooks } = count
    expect(hooks.count.getSnapshot().state).toBeNull()
    const stop = hooks.count.subscribe(() => {})
    f.countStreams[0]?.push({ reviewRequested: 3 })
    await settle()
    expect(hooks.count.getSnapshot()).toEqual({ state: 3, disconnected: false })
    f.ctx.emit('connection/reset')
    expect(f.countStreams).toHaveLength(2)
    expect(f.countStreams[0]?.disposed).toHaveBeenCalled()
    stop()
    expect(f.countStreams[1]?.disposed).toHaveBeenCalled()
    await f.dispose()
  })

  it('reads the lists of every repository or one, the change request, and its description through the Remote', async () => {
    const f = await fixture()
    const page = reviewPage(f)
    const signal = new AbortController().signal
    page.openLists('', signal)
    expect(f.forgePanel.reviewLists).toHaveBeenLastCalledWith(null, signal)
    page.openLists('octo/demo', signal)
    expect(f.forgePanel.reviewLists).toHaveBeenLastCalledWith({ owner: 'octo', name: 'demo' }, signal)
    page.openChangeRequest(url, signal)
    expect(f.forgePanel.reviewChangeRequest).toHaveBeenCalledWith(url, signal)
    expect(await page.readDescription(url, signal)).toEqual({ ok: true, value: description('Body') })
    expect(f.forgePanel.reviewDescription).toHaveBeenCalledWith(url, signal)
    expect(page.hooks.locale.getSnapshot()).toBe(f.ctx.locale.getLocale().active)
    const reset = vi.fn()
    const unsubscribe = page.subscribeReset(reset)
    f.ctx.emit('connection/reset')
    expect(reset).toHaveBeenCalledOnce()
    unsubscribe()
    f.ctx.emit('connection/reset')
    expect(reset).toHaveBeenCalledOnce()
    await f.dispose()
  })

  it('reads every list again and reports only a failure', async () => {
    const f = await fixture()
    await reviewPage(f).refresh()
    expect(f.forgePanel.reviewRefresh).toHaveBeenCalledOnce()
    expect(f.notice()).toBeNull()
    f.forgePanel.reviewRefresh.mockResolvedValueOnce(REFUSED.failed)
    await reviewPage(f).refresh()
    expect(f.notice()).toMatchObject({ key: 'toast.refreshFailed', tone: 'failure' })
    await f.dispose()
  })
})

describe('mountForgePanel review page card actions', () => {
  const url = 'https://github.com/octo/demo/pull/7'

  async function card() {
    const f = await fixture()
    const value = f.entry('main', ReviewPage)?.inject?.()
    assert(value !== undefined && isReviewPageFace(value))
    const showChanges = vi.fn()
    return { ...f, actions: value.actionsFor(url, showChanges), showChanges }
  }

  it('opens and copies links, polls the change request again, and opens its changes', async () => {
    const f = await card()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    f.actions.openLink(url)
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    f.actions.copyLink(url)
    await settle()
    expect(writeText).toHaveBeenCalledWith(url)
    expect(f.notice()).toMatchObject({ key: 'toast.copied', tone: 'success' })
    f.actions.viewChanges?.(entry(7, snapshot(7)))
    expect(f.showChanges).toHaveBeenCalledOnce()

    f.actions.retry()
    await settle()
    expect(f.forgePanel.reviewPoll).toHaveBeenCalledWith(url)
    f.forgePanel.reviewPoll.mockResolvedValueOnce(REFUSED.failed)
    f.actions.retry()
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.refreshFailed', tone: 'failure' })
    await f.dispose()
  })

  it.each([
    ['confirms it', OK, { key: 'toast.markedReady', tone: 'success', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused,
      { key: 'toast.markReadyFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown,
      { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('marks a draft ready by its URL and %s', async (_label, result, notice) => {
    const f = await card()
    f.forgePanel.reviewMarkReady.mockResolvedValueOnce(result)
    await f.actions.markReady?.(entry(7, snapshot(7, { draft: true })))
    expect(f.forgePanel.reviewMarkReady).toHaveBeenCalledWith(url)
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it.each([
    ['confirms it', OK, { key: 'toast.merged', tone: 'success', params: { name: '#7' } }],
    ['says a moved head needs another look', REFUSED.stale, { key: 'toast.mergeStale', tone: 'failure', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused,
      { key: 'toast.mergeFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown,
      { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('merges by its URL with the confirmed head and %s', async (_label, result, notice) => {
    const f = await card()
    f.forgePanel.reviewMerge.mockResolvedValueOnce(result)
    await f.actions.merge?.(entry(7, snapshot(7)), { method: 'squash', headSha: 'b'.repeat(40) })
    expect(f.forgePanel.reviewMerge).toHaveBeenCalledWith(url, 'squash', 'b'.repeat(40))
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it.each([
    ['confirms it', OK, { key: 'toast.rerunRequested', tone: 'success', params: { name: '#7' } }],
    ['says a moved head needs another look', REFUSED.stale, { key: 'toast.rerunStale', tone: 'failure', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused,
      { key: 'toast.rerunFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown,
      { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('reruns failed checks by its URL and %s', async (_label, result, notice) => {
    const f = await card()
    f.forgePanel.reviewRerunChecks.mockResolvedValueOnce(result)
    await f.actions.rerunChecks?.(entry(7, snapshot(7)), { headSha: 'b'.repeat(40) })
    expect(f.forgePanel.reviewRerunChecks).toHaveBeenCalledWith(url, { headSha: 'b'.repeat(40) })
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it.each([
    ['confirms it', OK, { key: 'toast.reviewRequested', tone: 'success', params: { name: '#7', login: 'mona, lin' } }],
    ['reports why the host refused', REFUSED.refused,
      { key: 'toast.reviewRequestFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown,
      { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('requests reviews by its URL and %s', async (_label, result, notice) => {
    const f = await card()
    f.forgePanel.reviewRequestReviews.mockResolvedValueOnce(result)
    const reviewers = [{ kind: 'user' as const, login: 'mona' }, { kind: 'user' as const, login: 'lin' }]
    await f.actions.requestReviews?.(entry(7, snapshot(7)), reviewers)
    expect(f.forgePanel.reviewRequestReviews).toHaveBeenCalledWith(url, reviewers)
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it.each([
    ['confirms it', OK, { key: 'toast.branchUpdated', tone: 'success', params: { name: '#7' } }],
    ['says a moved head needs another look', REFUSED.stale, { key: 'toast.branchUpdateStale', tone: 'failure', params: { name: '#7' } }],
    ['reports why the host refused', REFUSED.refused,
      { key: 'toast.branchUpdateFailed', tone: 'failure', params: { message: 'Pull Request is not mergeable' } }],
    ['tells the reader to check an outcome the host did not confirm', REFUSED.unknown,
      { key: 'toast.actionUnknown', tone: 'failure', params: { name: '#7' } }],
  ])('updates the branch by its URL with the confirmed head and %s', async (_label, result, notice) => {
    const f = await card()
    f.forgePanel.reviewUpdateBranch.mockResolvedValueOnce(result)
    await f.actions.updateBranch?.(entry(7, snapshot(7)), { method: 'merge', headSha: 'b'.repeat(40) })
    expect(f.forgePanel.reviewUpdateBranch).toHaveBeenCalledWith(url, 'merge', 'b'.repeat(40))
    expect(f.notice()).toMatchObject(notice)
    await f.dispose()
  })

  it('reads complete checks and reviewer candidates by the page\'s URL and rejects with the host\'s reason', async () => {
    const f = await card()
    const signal = new AbortController().signal
    await expect(f.actions.readChecks?.('https://example.test/other', 'b'.repeat(40), signal)).resolves.toEqual(snapshot(7))
    expect(f.forgePanel.reviewChecks).toHaveBeenCalledWith(url, 'b'.repeat(40), signal)
    f.forgePanel.reviewChecks.mockResolvedValueOnce({ ok: false, error: new RemoteError('forgePanel/checks-failed', 'checks down', {}) })
    await expect(f.actions.readChecks?.(url, 'b'.repeat(40), signal)).rejects.toThrow('checks down')
    await expect(f.actions.reviewerCandidates?.('https://example.test/other', 'mo', signal))
      .resolves.toEqual([{ login: 'mona', name: null, avatarUrl: null, suggested: true }])
    expect(f.forgePanel.reviewReviewerCandidates).toHaveBeenCalledWith(url, 'mo', signal)
    f.forgePanel.reviewReviewerCandidates.mockResolvedValueOnce({
      ok: false, error: new RemoteError('forgePanel/reviewers-failed', 'down', {}),
    })
    await expect(f.actions.reviewerCandidates?.(url, '', signal)).rejects.toThrow('down')
    await f.dispose()
  })
})

describe('mountForgePanel review page changes view', () => {
  const url = 'https://github.com/octo/demo/pull/7'
  const selection: ReviewSelection = {
    source: { kind: 'change', url, headSha: 'a'.repeat(40), commits: null },
    comment: { path: 'a.ts', side: 'R', startLine: 1, endLine: 1, body: 'Check this', hunk: '@@ -1 +1 @@\n-old\n+new' },
  }

  async function changesView() {
    const f = await fixture()
    const value = f.entry('main', ReviewPage)?.inject?.()
    assert(value !== undefined && isReviewPageFace(value))
    return { ...f, view: value.changes }
  }

  it('refuses the local reads, which the review page never shows', async () => {
    const f = await changesView()
    const signal = new AbortController().signal
    const refusal = 'forge-panel: the review page shows no local changes'
    await expect(f.view.localDiff({ kind: 'staged' }, signal)).rejects.toThrow(refusal)
    await expect(f.view.diffBases('', signal)).rejects.toThrow(refusal)
    await expect(f.view.localText({ kind: 'staged' }, 'a.ts')).rejects.toThrow(refusal)
    await expect(f.view.localCommits(null, signal)).rejects.toThrow(refusal)
    const lens: ForgeLensRequest = { source: { kind: 'change', url, commits: null }, version: 'v1', lens: 'exports' }
    expect(() => f.view.changesLens(lens, signal)).toThrow('forge-panel: the review page runs no lenses')
    f.view.createChangeRequest()
    expect(f.notice()).toBeNull()
    await f.dispose()
  })

  it('quotes comments and threads in the draft of the Session the page names, numbered after the quotes already there', async () => {
    const f = await fixture()
    try {
      const value = f.entry('main', ReviewPage)?.inject?.()
      assert(value !== undefined && isReviewPageFace(value))
      const scope = f.sessions.scope(S1)
      assert(scope !== undefined)
      let draft = ''
      const insertQuote = vi.fn((text: string, _summary?: QuoteSummary) => { draft += `\n> ${text}`; return true })
      const input = { state: { getSnapshot: () => ({ draft }) }, insertQuote, focus: vi.fn() }
      // Only the input methods the quotes use are supplied by the Session fixture.
      vi.spyOn(scope, 'get').mockImplementation(name => name === 'conversation' ? { input: { for: () => input } } as never : undefined)
      expect(value.quoteReview(S1, selection)).toBe(true)
      expect(value.quoteReview(S1, selection)).toBe(true)
      expect(value.quoteThread(S1, reviewThread({ path: 'a.ts' }), url, 'R1')).toBe(true)
      expect(insertQuote.mock.calls.map(([text]) => text.split('\n')[0]))
        .toEqual(['## User Comment 1', '## User Comment 2', '## Review Thread 1'])
      expect(f.sessions.scope).toHaveBeenCalledWith(S1)
      insertQuote.mockReturnValueOnce(false)
      expect(value.quoteReview(S1, selection)).toBe(false)
    } finally { await f.dispose() }
  })

  it('reads and writes the change request by its URL through the review Remote, keeping its viewed marks in the browser', async () => {
    const f = await changesView()
    const signal = new AbortController().signal
    const head = 'a'.repeat(40)
    expect(await f.view.changeRequestDiff(url, null, signal)).toEqual({ ok: true, value: CHANGE })
    expect(f.forgePanel.reviewDiff).toHaveBeenCalledWith(url, null, signal)
    expect(await f.view.changeRequestCommits(url, signal)).toEqual({ ok: true, value: COMMITS })
    expect(f.forgePanel.reviewCommits).toHaveBeenCalledWith(url, signal)
    expect(await f.view.changeRequestViewed(url, head, true, signal)).toEqual({ ok: true, value: null })
    expect(f.forgePanel.reviewViewed).toHaveBeenCalledWith(url, head, true, signal)
    const viewed: ForgeViewedRequest = { path: 'a.ts', viewed: true, headSha: head }
    expect(await f.view.setFileViewed(url, viewed)).toEqual(OK)
    expect(f.forgePanel.reviewSetViewed).toHaveBeenCalledWith(url, viewed)
    expect(await f.view.changeRequestText(url, head, 'a.ts')).toEqual({ ok: true, value: 'c\n' })
    expect(f.forgePanel.reviewText).toHaveBeenCalledWith(url, head, 'a.ts')
    expect(await f.view.changeRequestReview(url, head, true, signal)).toMatchObject({ ok: true, value: { headSha: head, viewer: 'lin' } })
    expect(f.forgePanel.reviewThreads).toHaveBeenCalledWith(url, head, true, signal)
    const write = { kind: 'resolve', headSha: head, thread: 'thread-1' as ForgeThreadId, resolved: true } as const
    expect(await f.view.changeRequestReviewWrite(url, write)).toEqual({ ok: true, value: { ok: true } })
    expect(f.forgePanel.reviewThreadWrite).toHaveBeenCalledWith(url, write)
    const request: ForgeReviewRequest = { kind: 'review', headSha: head, event: 'comment', body: 'Summary', comments: [] }
    expect(await f.view.submitReview(url, request)).toEqual({ ok: true, value: { ok: true, url: 'https://github.com/review/2' } })
    expect(f.forgePanel.reviewSubmit).toHaveBeenCalledWith(url, request)
    const again = f.entry('main', ReviewPage)?.inject?.()
    assert(again !== undefined && isReviewPageFace(again))
    expect(again.changes.viewedFiles).toBe(f.view.viewedFiles)
    await f.dispose()
  })

  it('keeps pending comments for the lifetime of one view and clears them once it ends', async () => {
    const f = await changesView()
    const lifetime = new AbortController()
    const queue = f.view.reviewQueue({ id: `review:${url}`, signal: lifetime.signal })
    expect(f.view.reviewQueue({ id: `review:${url}`, signal: lifetime.signal })).toBe(queue)
    queue.recordAgent(selection)
    expect(queue.getSnapshot().records).toHaveLength(1)
    lifetime.abort()
    expect(queue.getSnapshot()).toMatchObject({ comments: [], records: [] })
    expect(f.notice()).toBeNull()
    const next = f.view.reviewQueue({ id: `review:${url}`, signal: new AbortController().signal })
    expect(next).not.toBe(queue)
    expect(next.getSnapshot().records).toEqual([])
    await f.dispose()
  })

  it('reports pending comments it cannot clear for a view that already ended', async () => {
    const f = await changesView()
    const lifetime = new AbortController()
    lifetime.abort()
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new Error('storage denied') })
    expect(f.view.reviewQueue({ id: `review:${url}`, signal: lifetime.signal }).getSnapshot().records).toEqual([])
    expect(f.notice()).toMatchObject({ key: 'review.saveFailed', tone: 'failure' })
    await f.dispose()
  })

  it('reports pending comments it cannot clear once a view ends', async () => {
    const f = await changesView()
    const lifetime = new AbortController()
    f.view.reviewQueue({ id: `review:${url}`, signal: lifetime.signal })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new Error('storage denied') })
    expect(f.notice()).toBeNull()
    lifetime.abort()
    expect(f.notice()).toMatchObject({ key: 'review.saveFailed', tone: 'failure' })
    await f.dispose()
  })

  it('opens links and copies paths, and reports what the view asks for with its tone', async () => {
    const f = await changesView()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    f.view.openLink('https://github.com/octo/demo/blob/main/a.ts')
    expect(open).toHaveBeenCalledWith('https://github.com/octo/demo/blob/main/a.ts', '_blank', 'noopener,noreferrer')
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    f.view.copyPath('src/a.ts')
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.pathCopied', tone: 'success' })
    f.view.report('review.submitted', { tone: 'success' })
    expect(f.notice()).toMatchObject({ key: 'review.submitted', tone: 'success', params: {} })
    f.view.report('toast.expandFailed', { params: { message: 'gone' } })
    expect(f.notice()).toMatchObject({ key: 'toast.expandFailed', tone: 'failure', params: { message: 'gone' } })
    await f.dispose()
  })
})

describe('mountForgePanel review page chat', () => {
  const url = 'https://github.com/octo/demo/pull/7'
  const tEn = makeTranslate(en)

  async function chatFace() {
    const f = await fixture()
    const value = f.entry('main', ReviewPage)?.inject?.()
    assert(value !== undefined && isReviewPageFace(value))
    return { ...f, chat: value.chat }
  }

  /** A conversation input of `S1` holding `draft`, with each write recorded. */
  function conversationInput(f: Awaited<ReturnType<typeof chatFace>>, draft: string) {
    const input = {
      state: { getSnapshot: () => ({ draft }) },
      setDraft: vi.fn((_text: string) => {}),
      insertQuote: vi.fn((_text: string, _summary?: QuoteSummary) => true),
      focus: vi.fn(),
    }
    const scope = f.sessions.scope(S1)
    assert(scope !== undefined)
    // Only the input methods the review chat uses are supplied by the Session fixture.
    vi.spyOn(scope, 'get').mockImplementation(name => name === 'conversation' ? { input: { for: () => input } } as never : undefined)
    return input
  }

  it.each([
    ['the Workspace whose folder is named after the repository', [
      { workspaceId: 'w1', path: '/work/other', updatedAt: '2026-10-05T00:00:00Z' },
      { workspaceId: 'w2', path: 'C:\\work\\Demo\\', updatedAt: '2026-10-01T00:00:00Z' },
      { workspaceId: 'w3', path: '/', updatedAt: '2026-09-01T00:00:00Z' },
    ], 'w2'],
    ['the most recently updated Workspace otherwise', [
      { workspaceId: 'w1', path: '/work/other', updatedAt: '2026-10-01T00:00:00Z' },
      { workspaceId: 'w3', path: '/', updatedAt: '2026-10-05T00:00:00Z' },
    ], 'w3'],
  ])('starts a conversation in the blank Session of %s', async (_label, items, chosen) => {
    const f = await chatFace()
    f.workspaces.list.getSnapshot.mockReturnValue({ items })
    expect(await f.chat.connect(reviewed(7))).toBe(`blank-${chosen}`)
    expect(f.uiWorkspace.connectWorkspace).toHaveBeenCalledWith(chosen)
    await f.dispose()
  })

  it('starts no conversation without any Workspace', async () => {
    const f = await chatFace()
    expect(await f.chat.connect(reviewed(7))).toBeUndefined()
    expect(f.uiWorkspace.connectWorkspace).not.toHaveBeenCalled()
    await f.dispose()
  })

  it('retains the conversation as a review reference, opens it in the main view, and asks for its worktree', async () => {
    const f = await chatFace()
    expect(f.chat.retain(S1)).toMatchObject({ sessionId: S1 })
    expect(f.sessions.retain).toHaveBeenCalledWith(S1, { source: 'forgeReview' })
    f.chat.openInMain(S1)
    expect(f.uiWorkspace.openSession).toHaveBeenCalledWith(S1)
    f.chat.requestWorktree(S1)
    await settle()
    expect(f.forgePanel.requestWorktree).toHaveBeenCalledWith(S1, null, null)
    expect(f.notice()).toBeNull()
    f.forgePanel.requestWorktree.mockResolvedValueOnce(REFUSED.started)
    f.chat.requestWorktree(S1)
    await settle()
    expect(f.notice()).toMatchObject({ key: 'toast.worktreeFailed', tone: 'failure' })
    await f.dispose()
  })

  it('connects the Workspace the reader picks in the conversation and says why one could not be opened', async () => {
    const f = await chatFace()
    type Picked = Parameters<typeof f.chat.connectWorkspace>[0]
    const picked = brandString<Picked>('w-picked')
    expect(await f.chat.connectWorkspace(picked)).toBe('blank-w-picked')
    expect(f.uiWorkspace.connectWorkspace).toHaveBeenCalledWith(picked)
    f.chat.workspaceFailed(new Error('offline'))
    expect(f.notice()).toMatchObject({ key: 'reviewPage.chat.workspaceFailed', params: { message: 'offline' } })
    f.chat.workspaceFailed('refused')
    expect(f.notice()).toMatchObject({ key: 'reviewPage.chat.workspaceFailed', params: { message: 'refused' } })
    await f.dispose()
  })

  it('binds the change request to the conversation and reports a binding that failed', async () => {
    const f = await chatFace()
    f.chat.stage(S1, url)
    await settle()
    expect(f.forgePanel.reviewStage).toHaveBeenCalledWith(S1, url)
    expect(f.notice()).toBeNull()
    f.forgePanel.reviewStage.mockResolvedValueOnce(REFUSED.failed)
    f.chat.stage(S1, null)
    await settle()
    expect(f.forgePanel.reviewStage).toHaveBeenLastCalledWith(S1, null)
    expect(f.notice()).toMatchObject({ key: 'reviewPage.chat.stageFailed', tone: 'failure' })
    await f.dispose()
  })

  it('quotes the change request into an empty draft once the conversation opens, and leaves a written draft alone', async () => {
    const f = await chatFace()
    const reference = f.chat.retain(S1)
    const empty = conversationInput(f, '  ')
    await f.chat.fill(reference, { kind: 'reference', frame: reviewed(7) })
    expect(empty.setDraft).not.toHaveBeenCalled()
    expect(empty.insertQuote).toHaveBeenCalledWith(tEn('reviewPage.chat.reference', { name: '#7', title: 'Change 7', url }),
      { label: '#7', title: 'Change 7', detail: url, body: '' })
    expect(empty.focus).toHaveBeenCalledOnce()

    const written = conversationInput(f, 'Look at the parser')
    await f.chat.fill(reference, { kind: 'reference', frame: reviewed(7) })
    expect(written.insertQuote).not.toHaveBeenCalled()
    expect(written.focus).not.toHaveBeenCalled()
    await f.dispose()
  })

  it('replaces the draft with a suggested prompt and quotes the change request after it, named by its URL before a status', async () => {
    const f = await chatFace()
    const reference = f.chat.retain(S1)
    const input = conversationInput(f, 'Look at the parser')
    await f.chat.fill(reference, { kind: 'prompt', frame: reviewed(7, null), text: 'Review this change request' })
    expect(input.setDraft).toHaveBeenCalledWith('Review this change request')
    expect(input.insertQuote).toHaveBeenCalledWith(tEn('reviewPage.chat.reference', { name: '#7', title: url, url }),
      { label: '#7', title: url, detail: url, body: '' })
    expect(input.focus).toHaveBeenCalledOnce()
    await f.dispose()
  })

  it.each(['no Session scope', 'no conversation'] as const)('fills nothing with %s', async (missing) => {
    const f = await chatFace()
    const reference = f.chat.retain(S1)
    const scope = f.sessions.scope(S1)
    assert(scope !== undefined)
    const get = vi.spyOn(scope, 'get').mockReturnValue(undefined)
    if (missing === 'no Session scope') f.sessions.scope.mockReturnValue(undefined)
    await f.chat.fill(reference, { kind: 'reference', frame: reviewed(7) })
    expect(f.sessions.scope).toHaveBeenLastCalledWith(S1)
    expect(get.mock.calls.length > 0).toBe(missing === 'no conversation')
    await f.dispose()
  })

  it('warns when the conversation does not open', async () => {
    const f = await chatFace()
    const failure = new Error('closed')
    f.sessions.retain.mockReturnValueOnce({ sessionId: S1, ready: Promise.reject(failure), release: vi.fn() })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await f.chat.fill(f.chat.retain(S1), { kind: 'reference', frame: reviewed(7) })
    expect(warn).toHaveBeenCalledWith('forge-panel: the review conversation did not open:', failure)
    await f.dispose()
  })
})

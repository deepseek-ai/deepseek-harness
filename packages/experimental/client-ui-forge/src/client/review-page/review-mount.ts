/**
 * Registrations of the review page: its navigation row and count, its page, and the actions and reads its views call
 * through the forge panel Remote's review methods, which name a change request by URL and need no Session.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-experimental-client-ui-forge/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ChangeRequestActions } from '../ChangeRequestCard.tsx'
import type { ForgePanelKey } from '../locales.ts'
import { actionReporter } from '../action-notices.ts'
import { NS } from '../locales.ts'
import { ReviewQueue } from '../review-queue.ts'
import { createReviewStore } from './review-store.ts'
import { ReviewNavCount, ReviewNavIcon, type ReviewNavCountInjected } from './ReviewNav.tsx'
import { ReviewConversation, type ReviewChatFace } from './ReviewChat.tsx'
import { ReviewPage, type ReviewChangesFace, type ReviewPageInjected } from './ReviewPage.tsx'
import { createStreamSource, type NoticeSource } from '../source.ts'
import type { ChangeRequestEntry } from '../status.ts'
import { ViewedFiles } from '../viewed-files.ts'
import type { ForgeReviewCountFrame } from '../../types.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The review page's conversation about a change request. */
    forgeReview: unknown
  }
}

/** The last segment of a directory path, lowercase. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(part => part !== '')
  return (parts.at(-1) ?? '').toLowerCase()
}

/** Main panel and navigation row id of the review page. */
export const REVIEW_PANEL = 'forge-review' as MainPanelId

/** What the review page shares with the forge panel's other surfaces. */
export interface ReviewPageDeps {
  /** Action notices. */
  readonly notices: NoticeSource
  /** Report a failed Remote call with `failure`, or the key `codes` names for its code; returns whether it succeeded. */
  readonly settled: (result: RemoteResult<unknown>, failure: ForgePanelKey, codes?: Partial<Record<string, ForgePanelKey>>) => boolean
  /** How toasts name a change request. */
  readonly nameOf: (entry: ChangeRequestEntry) => string
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Copy text and report the outcome. */
  readonly copyText: (text: string) => void
  /** Copy a path and report the outcome. */
  readonly copyPath: (path: string) => void
  /** Quote a comment in a retained Session's draft, numbered after the comments already there. */
  readonly quoteReview: ReviewPageInjected['quoteReview']
  /** Quote a whole thread in a retained Session's draft, numbered after the threads already there. */
  readonly quoteThread: ReviewPageInjected['quoteThread']
  /** The UI language. */
  readonly locale: HostObservable<string>
}

/**
 * Register the review page while the current Peer may read the review lists.
 * @param ctx - client plugin lifetime with the forge panel Remote.
 * @param deps - what the page shares with the other surfaces.
 */
export function registerReviewPage(ctx: Context, deps: ReviewPageDeps): void {
  const t = ctx.locale.bind(NS)
  const { notices, settled, nameOf, openLink, copyText } = deps
  const remote = ctx.remote.forgePanel
  const subscribeReset = (listener: () => void): (() => void) => ctx.on('connection/reset', listener)
  const reportAction = actionReporter(notices, nameOf)
  const actionsFor = (url: string, showChanges: () => void): ChangeRequestActions => ({
    openLink,
    copyLink: copyText,
    retry: () => { void remote.reviewPoll(url).then(result => settled(result, 'toast.refreshFailed')) },
    markReady: async (entry) => {
      reportAction(entry, await remote.reviewMarkReady(url), { done: 'toast.markedReady', failed: 'toast.markReadyFailed' })
    },
    merge: async (entry, request) => {
      reportAction(entry, await remote.reviewMerge(url, request.method, request.headSha),
        { done: 'toast.merged', stale: 'toast.mergeStale', failed: 'toast.mergeFailed' })
    },
    readChecks: async (_url, headSha, signal) => {
      const result = await remote.reviewChecks(url, headSha, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    rerunChecks: async (entry, request) => {
      reportAction(entry, await remote.reviewRerunChecks(url, request),
        { done: 'toast.rerunRequested', stale: 'toast.rerunStale', failed: 'toast.rerunFailed' })
    },
    requestReviews: async (entry, reviewers) => {
      reportAction(entry, await remote.reviewRequestReviews(url, reviewers),
        { done: 'toast.reviewRequested', failed: 'toast.reviewRequestFailed' },
        { login: reviewers.map(reviewer => reviewer.login).join(', ') })
    },
    reviewerCandidates: async (_url, query, signal) => {
      const result = await remote.reviewReviewerCandidates(url, query, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    updateBranch: async (entry, request) => {
      reportAction(entry, await remote.reviewUpdateBranch(url, request.method, request.headSha),
        { done: 'toast.branchUpdated', stale: 'toast.branchUpdateStale', failed: 'toast.branchUpdateFailed' })
    },
    viewChanges: () => { showChanges() },
  })
  // Review comments not yet published stay in the browser while the page shows their change request.
  const queues = new WeakMap<AbortSignal, ReviewQueue>()
  const changes: ReviewChangesFace = {
    localDiff: async () => await Promise.reject(new Error('forge-panel: the review page shows no local changes')),
    diffBases: async () => await Promise.reject(new Error('forge-panel: the review page shows no local changes')),
    localText: async () => await Promise.reject(new Error('forge-panel: the review page shows no local changes')),
    localCommits: async () => await Promise.reject(new Error('forge-panel: the review page shows no local changes')),
    changeRequestDiff: (url, commits, signal) => remote.reviewDiff(url, commits, signal),
    changeRequestCommits: (url, signal) => remote.reviewCommits(url, signal),
    viewedFiles: new ViewedFiles('forge-review-page'),
    changeRequestViewed: (url, headSha, signal) => remote.reviewViewed(url, headSha, signal),
    setFileViewed: (url, request) => remote.reviewSetViewed(url, request),
    changeRequestText: (url, commit, path) => remote.reviewText(url, commit, path),
    changeRequestReview: (url, headSha, fresh, signal) => remote.reviewThreads(url, headSha, fresh, signal),
    changeRequestReviewWrite: (url, write) => remote.reviewThreadWrite(url, write),
    submitReview: (url, request) => remote.reviewSubmit(url, request),
    reviewQueue: ({ id, signal }) => {
      let queue = queues.get(signal)
      if (queue === undefined) {
        const records = new ReviewQueue(`dsh.forge-review.page.v1.${JSON.stringify(id)}`)
        queue = records
        queues.set(signal, records)
        const clear = (): void => { if (!records.close()) notices.report('review.saveFailed') }
        if (signal.aborted) clear()
        else signal.addEventListener('abort', clear, { once: true })
      }
      return queue
    },
    openLink,
    copyPath: deps.copyPath,
    createChangeRequest: () => {},
    changesLens: () => { throw new Error('forge-panel: the review page runs no lenses') },
    report: notices.report,
  }
  const chat: ReviewChatFace = {
    connect: async (frame) => {
      const workspaces = [...ctx.workspaces.list.getSnapshot().items]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      const name = frame.ref.repository.name.toLowerCase()
      const chosen = workspaces.find(item => folderName(item.path) === name) ?? workspaces[0]
      return chosen === undefined ? undefined : await ctx.uiWorkspace.connectWorkspace(chosen.workspaceId)
    },
    connectWorkspace: workspaceId => ctx.uiWorkspace.connectWorkspace(workspaceId),
    workspaceFailed: (error) => {
      notices.report('reviewPage.chat.workspaceFailed', { params: { message: error instanceof Error ? error.message : String(error) } })
    },
    retain: sessionId => ctx.sessions.retain(sessionId, { source: 'forgeReview' }),
    stage: (sessionId, url) => { void remote.reviewStage(sessionId, url).then(result => settled(result, 'reviewPage.chat.stageFailed')) },
    fill: async (reference, draft) => {
      await reference.ready.then(() => {
        const scope = ctx.sessions.scope(reference.sessionId)
        const conversation = scope?.get('conversation')
        if (scope === undefined || conversation === undefined) return
        const input = conversation.input.for(scope)
        if (draft.kind === 'reference' && input.state.getSnapshot().draft.trim() !== '') return
        if (draft.kind === 'prompt') input.setDraft(draft.text)
        const { frame } = draft
        const name = t('change.number', { number: frame.ref.number })
        const title = frame.snapshot?.title ?? frame.url
        input.insertQuote(t('reviewPage.chat.reference', { name, title, url: frame.url }), { label: name, title, detail: frame.url, body: '' })
        input.focus()
      }, (error: unknown) => { console.warn('forge-panel: the review conversation did not open:', error) })
    },
    openInMain: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
    requestWorktree: (sessionId) => {
      void remote.requestWorktree(sessionId, null, null).then(result => settled(result, 'toast.worktreeFailed'))
    },
  }
  const count = createStreamSource<ForgeReviewCountFrame, number | null>({
    open: signal => remote.reviewCount(signal),
    subscribeReset,
  }, null, (_previous, frame) => frame.reviewRequested)
  ctx.effect(() => () => { count.close() }, 'forge-panel: review count')
  ctx.effect(() => ctx.remoteAccess.whenAccess('forgePanel/reviewLists', function* () {
    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: REVIEW_PANEL,
      locale: NS,
      store: createReviewStore(),
      inject: (): ReviewPageInjected => ({
        hooks: { locale: deps.locale },
        openLists: (scope, signal) => {
          const slash = scope.indexOf('/')
          return remote.reviewLists(slash < 0 ? null : { owner: scope.slice(0, slash), name: scope.slice(slash + 1) }, signal)
        },
        openChangeRequest: (url, signal) => remote.reviewChangeRequest(url, signal),
        subscribeReset,
        refresh: async () => { settled(await remote.reviewRefresh(), 'toast.refreshFailed') },
        readDescription: (url, signal) => remote.reviewDescription(url, signal),
        actionsFor,
        changes,
        copyText,
        chat,
        quoteReview: deps.quoteReview,
        quoteThread: deps.quoteThread,
      }),
      children: { 'forge.review.conversation': { kind: 'single', scope: 'session' } },
    }, ReviewPage))
    yield ctx.slots.inject('forge.review.conversation', () => ctx.slots.register({
      name: 'forge.review.conversation', locale: NS,
    }, ReviewConversation))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: REVIEW_PANEL, order: 20, locale: NS, label: () => t('reviewPage.panel'),
    }, ReviewNavIcon))
    yield ctx.slots.inject('sidebar.panellist.trailing', () => ctx.slots.register({
      name: 'sidebar.panellist.trailing', id: REVIEW_PANEL, locale: NS,
      inject: (): ReviewNavCountInjected => ({ hooks: { count: count.observable } }),
    }, ReviewNavCount))
  }), 'forge-panel: review page')
}

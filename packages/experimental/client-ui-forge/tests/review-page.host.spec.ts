/** The review page's Remote methods of `forgePanel`, which name a change request by URL and need no Session binding. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  ChangeRequestDescription, ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeFailure, ForgeProvider,
  ForgeReadiness, ForgeRepository, ForgeReviewData, ForgeReviewWrite, ForgeReviewWriteResult, ForgeThreadId, ForgeViewerFilter,
  ForgeViewerList, ForgeViewerQuery,
} from '@deepseek-ai/dsh-experimental-forge'
import ForgePanelController from '../src/index.ts'
import type { Config, ForgeReviewChangeRequest, ForgeReviewCountFrame, ForgeReviewFrame } from '../src/index.ts'
import { bench, demo, pullUrl, scratch, sendPrompt, snapshot } from './harness.ts'
import type { Bench } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const signal = new AbortController().signal
const HEAD = 'a'.repeat(40)
const UNSERVED = 'https://unserved.test/a/b/pull/3'
/** Matches the epoch milliseconds of a read. */
const ANY_TIME: unknown = expect.any(Number)
const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

/** A panel Remote whose Session directory is no checkout; review page methods read nothing locally. */
async function page(config: Config = {}): Promise<Bench> {
  const { path, remove } = await scratch('dsh-forge-review-page-')
  cleanups.push(remove)
  const opened = await bench(path, config)
  cleanups.push(() => opened.ctx.fiber.dispose())
  return opened
}

/** The reference the fake provider parses from `pullUrl(number)`. */
function ref(number: number): ChangeRequestRef {
  return { repository: demo, number }
}

function review(headSha: string): ForgeReviewData {
  return {
    headSha, viewer: 'octo', truncated: false, pendingReview: null, viewerCanReview: true, reviewEvents: ['comment'],
    threads: [{
      id: brandString<ForgeThreadId>('thread-1'), path: 'src/a.ts', side: 'R', subject: 'line', resolved: false,
      diffHunk: '@@ -1 +1 @@\n-old\n+new', current: { commit: headSha, startLine: 1, endLine: 1 },
      original: { commit: headSha, startLine: 1, endLine: 1 }, comments: [], viewerCanReply: true, viewerCanResolve: true,
    }],
  }
}

/** A Remote stream reader that keeps every frame it has pulled. */
interface Streamed<T> {
  readonly frames: T[]
  /** Pull the next frame, or undefined once the stream ended. */
  pull: () => Promise<T | undefined>
  /** Return the latest pulled frame when it satisfies `predicate`, else pull frames until one does. */
  until: (predicate: (frame: T) => boolean) => Promise<T>
  /** Abort the stream and wait for it to end. */
  stop: () => Promise<void>
}

function streamed<T>(open: (signal: AbortSignal) => AsyncIterable<T>): Streamed<T> {
  const controller = new AbortController()
  const iterator = open(controller.signal)[Symbol.asyncIterator]()
  const frames: T[] = []
  const pull = async (): Promise<T | undefined> => {
    const next = await iterator.next()
    if (next.done === true) return undefined
    frames.push(next.value)
    return next.value
  }
  const stop = async (): Promise<void> => {
    controller.abort()
    await iterator.return?.(undefined)
  }
  cleanups.push(stop)
  return {
    frames,
    pull,
    async until(predicate) {
      const latest = frames.at(-1)
      if (latest !== undefined && predicate(latest)) return latest
      for (;;) {
        const frame = await pull()
        if (frame === undefined) throw new Error('the stream ended')
        if (predicate(frame)) return frame
      }
    },
    stop,
  }
}

function changeRequest(opened: Bench, url: string): Streamed<ForgeReviewChangeRequest> {
  return streamed(stop => opened.ctx.forgePanel.reviewChangeRequest(url, stop))
}

const polled = (frame: ForgeReviewChangeRequest): boolean => frame.snapshot !== null

const VIEWED: ForgeRepository = { forge: 'viewer', host: 'view.test', owner: 'octo', name: 'demo' }

/** How the bench's provider names itself and its change requests. */
const FAKE = { forge: 'fake', label: 'Fake', changeRequestNoun: 'pull-request' }

const UNREAD: ForgeFailure = { code: 'not-found', message: 'not read by this provider' }

/**
 * A second provider for its own fiber: it serves `https://view.test/octo/demo/pull/<n>` and lists the signed-in user's
 * change requests on `view.test`.
 */
class ViewerProvider implements ForgeProvider {
  readonly forge = 'viewer'
  readonly hosts = ['view.test']
  readonly label = 'Viewer'
  readonly changeRequestNoun = 'pull-request'
  readonly viewer = { hosts: this.hosts, filters: new Set<ForgeViewerFilter>(['review-requested', 'authored']), maxItems: 30 }
  /** List reads in call order. */
  readonly queries: ForgeViewerQuery[] = []
  /** Answers each list read. */
  list: (query: ForgeViewerQuery) => Promise<ForgeViewerList | ForgeFailure> = () => Promise.resolve({ viewer: 'mona', items: [], total: 2 })
  /** Answers each count read. */
  count: () => Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure> = () => Promise.resolve(new Map([['review-requested', 4]]))

  listForViewer(query: ForgeViewerQuery): Promise<ForgeViewerList | ForgeFailure> {
    this.queries.push(query)
    return this.list(query)
  }

  countForViewer(): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure> {
    return this.count()
  }

  repositoryFromRemote(): ForgeRepository | undefined {
    return undefined
  }

  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    const [, number = ''] = /^https:\/\/view\.test\/octo\/demo\/pull\/(\d+)$/.exec(url) ?? []
    return number === '' ? undefined : { repository: VIEWED, number: Number(number) }
  }

  changeRequestUrl(target: ChangeRequestRef): string {
    return `https://view.test/octo/demo/pull/${target.number}`
  }

  fetch(refs: readonly ChangeRequestRef[]): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    return Promise.resolve(new Map(refs.map(target => [changeRequestKey(target), snapshot(target)])))
  }

  findByHead(): Promise<readonly ChangeRequestRef[]> {
    return Promise.resolve([])
  }

  readiness(): Promise<ForgeReadiness> {
    return Promise.resolve({ state: 'ready', message: null, signIn: null })
  }

  markReady(): Promise<ForgeActionFailure | undefined> {
    return Promise.resolve(undefined)
  }

  merge(): Promise<ForgeActionFailure | undefined> {
    return Promise.resolve(undefined)
  }

  diff(): Promise<string | ForgeFailure> {
    return Promise.resolve(UNREAD)
  }

  fileText(): Promise<string | ForgeFailure> {
    return Promise.resolve(UNREAD)
  }

  fileUrl(): string {
    return 'https://view.test/'
  }
}

/** Register a {@link ViewerProvider} on a fiber of its own, which the caller may dispose to withdraw it. */
async function registerViewer(opened: Bench): Promise<{ provider: ViewerProvider; registration: ReturnType<Context['plugin']> }> {
  const provider = new ViewerProvider()
  const registration = opened.ctx.plugin({ inject: ['forge'], apply(child: Context) { child.forge.register(provider) } })
  await registration
  return { provider, registration }
}

describe('forgePanel.reviewChangeRequest', () => {
  it('streams a change request from its latest polling result, polls it while streamed, and stops polling once streams end', async () => {
    const opened = await page()
    const stream = changeRequest(opened, pullUrl(7))

    await expect(stream.pull()).resolves.toEqual({
      url: pullUrl(7), ref: ref(7), forge: FAKE, update: null, snapshot: null, reviewRevision: 0,
    })
    const first = await stream.until(polled)
    expect(first).toEqual({
      url: pullUrl(7), ref: ref(7), forge: FAKE, snapshot: snapshot(ref(7)), reviewRevision: 0,
      update: { key: changeRequestKey(ref(7)), fetchedAt: ANY_TIME, snapshot: snapshot(ref(7)) },
    })
    // A second stream of a polled change request starts from its latest result and shares its polling.
    const joined = changeRequest(opened, pullUrl(7))
    await expect(joined.pull()).resolves.toEqual(first)

    opened.provider.failures.set(7, { code: 'unavailable', message: 'down' })
    await opened.ctx.forgePanel.reviewPoll(pullUrl(7), signal)
    const failed = await stream.until(frame => frame.update !== null && 'failure' in frame.update)
    expect(failed.snapshot).toEqual(snapshot(ref(7)))
    expect(opened.provider.fetches).toEqual([[7], [7]])
    // A stream that starts after a failed poll has no snapshot until a poll succeeds.
    const late = changeRequest(opened, pullUrl(7))
    await expect(late.pull()).resolves.toEqual({ ...failed, snapshot: null })

    await Promise.all([stream.stop(), joined.stop(), late.stop()])
    await expect(stream.pull()).resolves.toBeUndefined()
    expect(opened.ctx.forge.latest(ref(7))).toBeUndefined()
  })

  it('reads a change request at once for a stream that starts once its latest status is older than statusMaxAgeMs', async () => {
    const opened = await page({ statusMaxAgeMs: 1 })
    const first = changeRequest(opened, pullUrl(7))
    await first.until(polled)
    await new Promise(resolve => setTimeout(resolve, 5))

    // The stream watches the change request once its first frame is pulled.
    const joined = changeRequest(opened, pullUrl(7))
    await joined.pull()

    await vi.waitFor(() => { expect(opened.provider.fetches).toEqual([[7], [7]]) })
    await Promise.all([first.stop(), joined.stop()])
  })

  it('names how the change request\'s provider calls itself, and nothing once that provider left', async () => {
    const opened = await page()
    const { registration } = await registerViewer(opened)
    const viewed: ChangeRequestRef = { repository: VIEWED, number: 5 }
    const stream = changeRequest(opened, 'https://view.test/octo/demo/pull/5')
    await expect(stream.pull()).resolves.toMatchObject({ forge: { forge: 'viewer', label: 'Viewer', changeRequestNoun: 'pull-request' } })

    await registration.dispose()
    await opened.ctx.parallel('forge/review-changed', viewed, { kind: 'submit', headSha: HEAD })
    await expect(stream.until(frame => frame.forge === null)).resolves.toMatchObject({ forge: null, reviewRevision: 1 })
    await stream.stop()
  })

  it('publishes a streamed change request again with the count of review changes announced for it', async () => {
    const opened = await page()
    Object.assign(opened.provider, { writeReview: (): Promise<ForgeReviewWriteResult> => Promise.resolve({ ok: true }) })
    const seven = changeRequest(opened, pullUrl(7))
    const eight = changeRequest(opened, pullUrl(8))
    await seven.until(polled)
    await eight.until(polled)
    const write: ForgeReviewWrite = { kind: 'resolve', headSha: HEAD, thread: brandString<ForgeThreadId>('thread-1'), resolved: true }

    await expect(opened.ctx.forgePanel.reviewThreadWrite(pullUrl(7), write, signal)).resolves.toEqual({ ok: true })
    await seven.until(frame => frame.reviewRevision === 1)
    // A write of another plugin through `ctx.forge` counts as well.
    await opened.ctx.forge.writeReview(ref(7), write, signal)
    await seven.until(frame => frame.reviewRevision === 2)

    await expect(changeRequest(opened, pullUrl(7)).pull()).resolves.toMatchObject({ reviewRevision: 2 })
    await expect(changeRequest(opened, pullUrl(8)).pull()).resolves.toMatchObject({ reviewRevision: 0 })
  })
})

describe('forgePanel review page reads', () => {
  it('reads the description, complete checks, commits, files, and viewed marks of a change request by URL', async () => {
    const opened = await page()
    const panel = opened.ctx.forgePanel
    const url = pullUrl(7)

    await expect(panel.reviewDescription(url, signal))
      .rejects.toMatchObject({ code: 'forgePanel/description-failed', message: 'This provider does not read descriptions' })
    const description: ChangeRequestDescription = {
      body: 'Fixes the parser', labels: [{ name: 'bug', color: 'd73a4a' }], labelsTruncated: false, images: {}, imagesExpireAt: null,
      createdAt: '2026-11-01T00:00:00Z',
    }
    Object.assign(opened.provider, { readDescription: () => Promise.resolve(description) })
    await expect(panel.reviewDescription(url, signal)).resolves.toEqual(description)

    await expect(panel.reviewChecks(url, HEAD, signal))
      .rejects.toMatchObject({ code: 'forgePanel/checks-failed', message: 'This provider does not support complete check reads' })
    Object.assign(opened.provider, { fetchChecks: () => Promise.resolve(snapshot(ref(7))) })
    await expect(panel.reviewChecks(url, HEAD, signal)).resolves.toEqual(snapshot(ref(7)))
    await expect(panel.reviewChecks(url, 'b'.repeat(40), signal)).rejects.toMatchObject({ code: 'forgePanel/stale-head' })

    const list = { headSha: HEAD, truncated: false, commits: [{ sha: HEAD, parent: null, title: 'c1', author: 'octo', authoredAt: '2026-11-01T00:00:00Z' }] }
    opened.provider.commitLists.set(7, list)
    await expect(panel.reviewCommits(url, signal)).resolves.toEqual(list)
    opened.provider.commitLists.set(7, { code: 'rate-limited', message: 'slow down' })
    await expect(panel.reviewCommits(url, signal)).rejects.toMatchObject({ code: 'forgePanel/diff-failed', message: 'slow down' })
    delete opened.provider.commits
    await expect(panel.reviewCommits(url, signal)).resolves.toBeNull()

    opened.provider.texts.set(`${HEAD}:src/a.ts`, 'new\n')
    opened.provider.texts.set(`${HEAD}:big.bin`, { code: 'too-large', message: 'big.bin is too large' })
    await expect(panel.reviewText(url, HEAD, 'src/a.ts', signal)).resolves.toBe('new\n')
    await expect(panel.reviewText(url, HEAD, 'big.bin', signal)).rejects.toMatchObject({ code: 'forgePanel/diff-too-large' })

    await expect(panel.reviewViewed(url, HEAD, false, signal)).resolves.toBeNull()
    const marks = { headSha: HEAD, files: { 'src/a.ts': 'dismissed' as const }, truncated: false }
    const viewedFiles = vi.fn<NonNullable<ForgeProvider['viewedFiles']>>(() => Promise.resolve(marks))
    Object.assign(opened.provider, { viewedFiles, setViewed: () => Promise.resolve(undefined) })
    await expect(panel.reviewViewed(url, HEAD, false, signal)).resolves.toEqual(marks)
    // The marks are kept for the next read that is not fresh.
    await expect(panel.reviewViewed(url, HEAD, false, signal)).resolves.toEqual(marks)
    expect(viewedFiles).toHaveBeenCalledOnce()
    viewedFiles.mockResolvedValueOnce({ code: 'stale', message: 'moved' }).mockResolvedValueOnce({ code: 'unavailable', message: 'down' })
    await expect(panel.reviewViewed(url, HEAD, true, signal)).rejects.toMatchObject({ code: 'forgePanel/stale-head', message: 'moved' })
    await expect(panel.reviewViewed(url, HEAD, true, signal)).rejects.toMatchObject({ code: 'forgePanel/viewed-failed', message: 'down' })
  })

  it('reads the files and review threads at the head of the streamed status, which a review page write refreshes', async () => {
    const opened = await page()
    const panel = opened.ctx.forgePanel
    const url = pullUrl(7)
    const readReview = vi.fn<NonNullable<ForgeProvider['readReview']>>((_ref, headSha) => Promise.resolve(review(headSha)))
    Object.assign(opened.provider, { readReview, writeReview: (): Promise<ForgeReviewWriteResult> => Promise.resolve({ ok: true }) })
    opened.provider.patches.set(7, PATCH)

    await expect(panel.reviewDiff(url, null, signal))
      .rejects.toMatchObject({ code: 'forgePanel/diff-failed', message: 'The change request status has not been read yet' })
    await expect(panel.reviewThreads(url, HEAD, false, signal))
      .rejects.toMatchObject({ code: 'forgePanel/review-failed', message: 'The change request status has not been read yet' })
    await changeRequest(opened, url).until(polled)

    await expect(panel.reviewDiff(url, null, signal)).resolves.toEqual({
      headSha: HEAD, localAhead: null, fileUrls: { 'src/a.ts': `${url}/files/${HEAD}/src/a.ts` },
      files: [expect.objectContaining({ path: 'src/a.ts', additions: 1, deletions: 1 })],
    })
    const sha = (n: number): string => String(n).repeat(40)
    const commit = (n: number, parent: string | null) => ({ sha: sha(n), parent, title: `c${n}`, author: 'octo', authoredAt: '2026-11-01T00:00:00Z' })
    opened.provider.commitLists.set(7, { headSha: sha(2), truncated: false, commits: [commit(1, null), commit(2, sha(1))] })
    opened.provider.comparisons.set(`${sha(1)}..${sha(2)}`, PATCH.replaceAll('src/a.ts', 'src/b.ts'))
    await expect(panel.reviewDiff(url, { from: sha(2), to: sha(2) }, signal))
      .resolves.toMatchObject({ headSha: sha(2), localAhead: null, files: [{ path: 'src/b.ts' }] })

    await expect(panel.reviewThreads(url, HEAD, false, signal)).resolves.toEqual(review(HEAD))
    await expect(panel.reviewThreads(url, HEAD, false, signal)).resolves.toEqual(review(HEAD))
    expect(readReview).toHaveBeenCalledTimes(1)
    await panel.reviewThreads(url, HEAD, true, signal)
    expect(readReview).toHaveBeenCalledTimes(2)
    await panel.reviewThreadWrite(url, { kind: 'resolve', headSha: HEAD, thread: brandString<ForgeThreadId>('thread-1'), resolved: true }, signal)
    await panel.reviewThreads(url, HEAD, false, signal)
    expect(readReview).toHaveBeenCalledTimes(3)
    await expect(panel.reviewThreads(url, 'b'.repeat(40), false, signal))
      .rejects.toMatchObject({ code: 'forgePanel/stale-head', message: `The change request head moved from ${'b'.repeat(40)} to ${HEAD}` })
  })
})

describe('forgePanel review page actions', () => {
  it('acts on a change request by URL through its provider, reporting what the host refused', async () => {
    const opened = await page()
    const panel = opened.ctx.forgePanel
    const url = pullUrl(7)
    const viewed = { path: 'src/a.ts', viewed: true, headSha: HEAD }

    await expect(panel.reviewSetViewed(url, viewed, signal))
      .rejects.toMatchObject({ code: 'forgePanel/action-failed', message: 'This provider keeps no viewed marks' })
    const setViewed = vi.fn<NonNullable<ForgeProvider['setViewed']>>(() => Promise.resolve(undefined))
    Object.assign(opened.provider, { viewedFiles: () => Promise.resolve({ headSha: HEAD, files: {}, truncated: false }), setViewed })
    await expect(panel.reviewSetViewed(url, viewed, signal)).resolves.toBeUndefined()
    await expect(panel.reviewSetViewed(url, { ...viewed, path: '' }, signal)).rejects.toThrow('Invalid viewed file')
    expect(setViewed).toHaveBeenCalledOnce()
    expect(setViewed).toHaveBeenCalledWith(ref(7), viewed, expect.any(AbortSignal))

    await panel.reviewMarkReady(url, signal)
    await panel.reviewMerge(url, 'squash', HEAD, signal)
    opened.provider.actionResult = { code: 'stale', message: 'Head branch was modified' }
    await expect(panel.reviewMerge(url, 'rebase', HEAD, signal))
      .rejects.toMatchObject({ code: 'forgePanel/stale-head', message: 'Head branch was modified' })
    opened.provider.actionResult = { code: 'failed', message: 'Not a draft' }
    await expect(panel.reviewMarkReady(url, signal)).rejects.toMatchObject({ code: 'forgePanel/action-failed', message: 'Not a draft' })
    expect(opened.provider.actions).toEqual(['ready 7', `merge 7 squash ${HEAD}`, `merge 7 rebase ${HEAD}`, 'ready 7'])

    await expect(panel.reviewRerunChecks(url, { headSha: HEAD }, signal))
      .rejects.toMatchObject({ code: 'forgePanel/action-failed', message: 'This provider reruns no checks' })
    await expect(panel.reviewReviewerCandidates(url, '', signal))
      .rejects.toMatchObject({ code: 'forgePanel/reviewers-failed', message: 'This provider requests no reviews' })
    const candidates = [{ login: 'mona', name: 'Mona', avatarUrl: null, suggested: true }]
    const reviewers = [{ kind: 'user' as const, login: 'mona' }]
    const requestReviews = vi.fn<NonNullable<ForgeProvider['requestReviews']>>(() => Promise.resolve(undefined))
    const updateBranch = vi.fn<NonNullable<ForgeProvider['updateBranch']>>(() => Promise.resolve(undefined))
    Object.assign(opened.provider, {
      rerunChecks: () => Promise.resolve(undefined), requestReviews, reviewerCandidates: () => Promise.resolve(candidates), updateBranch,
    })
    await expect(panel.reviewRerunChecks(url, { headSha: HEAD }, signal)).resolves.toBeUndefined()
    await expect(panel.reviewReviewerCandidates(url, 'mo', signal)).resolves.toEqual(candidates)
    await expect(panel.reviewRequestReviews(url, reviewers, signal)).resolves.toBeUndefined()
    for (const invalid of [[], [{ kind: 'user' as const, login: ' ' }]]) {
      await expect(panel.reviewRequestReviews(url, invalid, signal)).rejects.toThrow('Invalid reviewers')
    }
    requestReviews.mockResolvedValueOnce({ code: 'unknown', message: 'Something went wrong' })
    await expect(panel.reviewRequestReviews(url, reviewers, signal))
      .rejects.toMatchObject({ code: 'forgePanel/action-unknown', message: 'Something went wrong' })
    expect(requestReviews).toHaveBeenCalledWith(ref(7), { reviewers }, expect.any(AbortSignal))
    await expect(panel.reviewUpdateBranch(url, 'rebase', HEAD, signal)).resolves.toBeUndefined()
    updateBranch.mockResolvedValueOnce({ code: 'stale', message: 'moved' })
    await expect(panel.reviewUpdateBranch(url, 'merge', HEAD, signal)).rejects.toMatchObject({ code: 'forgePanel/stale-head', message: 'moved' })
    expect(updateBranch).toHaveBeenCalledWith(ref(7), { method: 'rebase', headSha: HEAD }, expect.any(AbortSignal))
  })

  it('publishes reviews and writes threads by URL, refusing invalid ones before calling the provider', async () => {
    const opened = await page()
    const panel = opened.ctx.forgePanel
    const url = pullUrl(7)
    const comment = { kind: 'comment' as const, headSha: HEAD, comment: { path: 'src/a.ts', side: 'R' as const, startLine: 1, endLine: 2, body: 'Nit' } }
    const write: ForgeReviewWrite = { kind: 'resolve', headSha: HEAD, thread: brandString<ForgeThreadId>('thread-1'), resolved: true }

    await expect(panel.reviewSubmit(url, comment, signal)).resolves.toMatchObject({ ok: false, code: 'unsupported' })
    await expect(panel.reviewThreadWrite(url, write, signal))
      .resolves.toEqual({ ok: false, code: 'unsupported', message: 'This provider does not support review writes' })
    const submitReview = vi.fn<NonNullable<ForgeProvider['submitReview']>>(() => Promise.resolve({ ok: true, url: `${url}#discussion_r1` }))
    const writeReview = vi.fn<NonNullable<ForgeProvider['writeReview']>>(() => Promise.resolve({ ok: true }))
    Object.assign(opened.provider, { submitReview, writeReview })
    await expect(panel.reviewSubmit(url, comment, signal)).resolves.toEqual({ ok: true, url: `${url}#discussion_r1` })
    await expect(panel.reviewThreadWrite(url, write, signal)).resolves.toEqual({ ok: true })

    await expect(panel.reviewSubmit(url, { ...comment, headSha: 'main' }, signal)).rejects.toThrow('Invalid review commit')
    await expect(panel.reviewSubmit(url, { ...comment, comment: { ...comment.comment, endLine: 0 } }, signal)).rejects.toThrow('Invalid review comment')
    await expect(panel.reviewThreadWrite(url, { ...write, headSha: 'main' }, signal)).rejects.toThrow('Invalid review commit')
    await expect(panel.reviewThreadWrite(url, { ...write, thread: brandString<ForgeThreadId>('') }, signal)).rejects.toThrow('Invalid review write')
    expect([submitReview.mock.calls.length, writeReview.mock.calls.length]).toEqual([1, 1])
  })

  it('refuses every review page read and action on a URL no provider serves without calling a provider', async () => {
    const opened = await page()
    const panel = opened.ctx.forgePanel
    const fetchChecks = vi.fn(() => Promise.resolve(snapshot(ref(7))))
    Object.assign(opened.provider, { fetchChecks })
    const write: ForgeReviewWrite = { kind: 'resolve', headSha: HEAD, thread: brandString<ForgeThreadId>('thread-1'), resolved: true }
    const comment = { kind: 'comment' as const, headSha: HEAD, comment: { path: 'src/a.ts', side: 'R' as const, startLine: 1, endLine: 1, body: 'Nit' } }
    const requests: (() => Promise<unknown>)[] = [
      () => panel.reviewPoll(UNSERVED, signal),
      () => changeRequest(opened, UNSERVED).pull(),
      () => panel.reviewDescription(UNSERVED, signal),
      () => panel.reviewChecks(UNSERVED, HEAD, signal),
      () => panel.reviewThreads(UNSERVED, HEAD, false, signal),
      () => panel.reviewThreadWrite(UNSERVED, write, signal),
      () => panel.reviewSubmit(UNSERVED, comment, signal),
      () => panel.reviewDiff(UNSERVED, null, signal),
      () => panel.reviewCommits(UNSERVED, signal),
      () => panel.reviewText(UNSERVED, HEAD, 'src/a.ts', signal),
      () => panel.reviewViewed(UNSERVED, HEAD, false, signal),
      () => panel.reviewSetViewed(UNSERVED, { path: 'src/a.ts', viewed: true, headSha: HEAD }, signal),
      () => panel.reviewMarkReady(UNSERVED, signal),
      () => panel.reviewMerge(UNSERVED, 'merge', HEAD, signal),
      () => panel.reviewRerunChecks(UNSERVED, { headSha: HEAD }, signal),
      () => panel.reviewRequestReviews(UNSERVED, [{ kind: 'user', login: 'mona' }], signal),
      () => panel.reviewReviewerCandidates(UNSERVED, '', signal),
      () => panel.reviewUpdateBranch(UNSERVED, 'merge', HEAD, signal),
      () => panel.reviewStage(opened.session.id, UNSERVED, signal),
    ]

    for (const request of requests) {
      await expect(request()).rejects.toMatchObject({ code: 'forgePanel/unrecognized-url', message: 'No provider serves this change request URL' })
    }
    expect([opened.provider.actions, opened.provider.fetches, fetchChecks.mock.calls]).toEqual([[], [], []])
  })

  it('refuses review page requests whose signal already aborted', async () => {
    const opened = await page()
    const panel = opened.ctx.forgePanel
    const aborted = AbortSignal.abort(new Error('closed'))
    const url = pullUrl(7)
    const first = async <T>(stream: AsyncIterable<T>): Promise<unknown> => await stream[Symbol.asyncIterator]().next()
    const requests: (() => Promise<unknown>)[] = [
      () => first(panel.reviewLists(null, aborted)),
      () => first(panel.reviewCount(aborted)),
      () => first(panel.reviewChangeRequest(url, aborted)),
      () => panel.reviewRefresh(aborted),
      () => panel.reviewPoll(url, aborted),
      () => panel.reviewDescription(url, aborted),
      () => panel.reviewChecks(url, HEAD, aborted),
      () => panel.reviewThreads(url, HEAD, false, aborted),
      () => panel.reviewDiff(url, null, aborted),
      () => panel.reviewCommits(url, aborted),
      () => panel.reviewText(url, HEAD, 'src/a.ts', aborted),
      () => panel.reviewViewed(url, HEAD, false, aborted),
      () => panel.reviewMarkReady(url, aborted),
      () => panel.reviewStage(opened.session.id, url, aborted),
    ]

    for (const request of requests) await expect(request()).rejects.toThrow('closed')
    expect(opened.provider.actions).toEqual([])
  })
})

describe('forgePanel.reviewStage', () => {
  it('binds the staged change request when the Session\'s next message enters its inbox, not before, and only once', async () => {
    const opened = await page()
    const bound = (): readonly unknown[] => opened.ctx.forgeSession.changeRequests(opened.session).map(entry => [entry.url, entry.origin])

    await opened.ctx.forgePanel.reviewStage(opened.session.id, pullUrl(7), signal)
    expect(bound()).toEqual([])
    sendPrompt(opened.agent, 'Review this change')
    expect(bound()).toEqual([[pullUrl(7), 'tracked']])

    await opened.ctx.forgePanel.dismiss(opened.session, pullUrl(7), signal)
    sendPrompt(opened.agent, 'And the next one')
    expect(bound()).toEqual([])
  })

  it('forgets a choice staged again as null, and leaves the message unbound once the staged URL\'s provider left', async () => {
    const opened = await page()
    const bound = (): readonly string[] => opened.ctx.forgeSession.changeRequests(opened.session).map(entry => entry.url)

    await opened.ctx.forgePanel.reviewStage(opened.session.id, pullUrl(7), signal)
    await opened.ctx.forgePanel.reviewStage(opened.session.id, null, signal)
    sendPrompt(opened.agent, 'Review this change')
    expect(bound()).toEqual([])

    const { registration } = await registerViewer(opened)
    await opened.ctx.forgePanel.reviewStage(opened.session.id, 'https://view.test/octo/demo/pull/3', signal)
    await registration.dispose()
    sendPrompt(opened.agent, 'Review that change')
    expect(bound()).toEqual([])
  })
  it('forgets a choice staged for a Session that leaves the store before its next message', async () => {
    const opened = await page()
    await opened.ctx.forgePanel.reviewStage(opened.session.id, pullUrl(7), signal)
    opened.ctx.emit('session/disposed', opened.session)
    sendPrompt(opened.agent, 'Review this change')
    expect(opened.ctx.forgeSession.changeRequests(opened.session)).toEqual([])
  })
})

describe('forgePanel review lists', () => {
  it('streams the lists of every provider that reads them, follows providers that come and go, and reads again on refresh', async () => {
    const opened = await page({ reviewPageSize: 10 })
    const lists = streamed<ForgeReviewFrame>(stop => opened.ctx.forgePanel.reviewLists(null, stop))

    await expect(lists.until(frame => !frame.reading)).resolves.toEqual({ hosts: [], reading: false })
    const { provider, registration } = await registerViewer(opened)
    const read = await lists.until(frame => !frame.reading && frame.hosts[0]?.viewer === 'mona')
    const listed = { items: [], total: 2, fetchedAt: ANY_TIME, failure: null }
    expect(read.hosts).toEqual([{ forge: 'viewer', host: 'view.test', viewer: 'mona', lists: { 'review-requested': listed, authored: listed } }])
    expect(provider.queries).toEqual([
      { host: 'view.test', filter: 'review-requested', repository: null, limit: 10 },
      { host: 'view.test', filter: 'authored', repository: null, limit: 10 },
    ])

    await opened.ctx.forgePanel.reviewRefresh(signal)
    await vi.waitFor(() => { expect(provider.queries).toHaveLength(4) })
    await registration.dispose()
    await expect(lists.until(frame => frame.hosts.length === 0)).resolves.toMatchObject({ hosts: [] })
  })

  it('reads the lists of one repository, keeping each list\'s failure and reporting a read that rejects', async () => {
    const opened = await page()
    const { provider } = await registerViewer(opened)
    provider.list = () => Promise.reject(new Error('gh crashed'))
    const warn = vi.spyOn(opened.ctx.logger, 'warn').mockImplementation(() => undefined)
    const lists = streamed<ForgeReviewFrame>(stop => opened.ctx.forgePanel.reviewLists({ owner: 'octo', name: 'demo' }, stop))

    const failed = await lists.until(frame => !frame.reading && (frame.hosts[0]?.lists.authored?.failure ?? null) !== null)
    expect(failed.hosts[0]?.lists['review-requested']?.failure).toEqual({ code: 'unavailable', message: 'gh crashed' })
    expect(provider.queries).toEqual([{ host: 'view.test', filter: 'review-requested', repository: { owner: 'octo', name: 'demo' }, limit: 30 }])
    expect(warn).toHaveBeenCalledWith('forge-panel: reading a review list failed: Error: gh crashed')
  })

  it('streams the review request count from count reads and from lists of every repository', async () => {
    const opened = await page()
    const { registration } = await registerViewer(opened)
    const count = streamed<ForgeReviewCountFrame>(stop => opened.ctx.forgePanel.reviewCount(stop))

    await expect(count.pull()).resolves.toEqual({ reviewRequested: null })
    await expect(count.until(frame => frame.reviewRequested !== null)).resolves.toEqual({ reviewRequested: 4 })
    const lists = streamed<ForgeReviewFrame>(stop => opened.ctx.forgePanel.reviewLists(null, stop))
    await lists.pull()
    await expect(count.until(frame => frame.reviewRequested === 2)).resolves.toEqual({ reviewRequested: 2 })
    await registration.dispose()
    await expect(count.until(frame => frame.reviewRequested === null)).resolves.toEqual({ reviewRequested: null })
  })

  it('ends the review list and count streams when the Remote stops', async () => {
    const opened = await page()
    const lists = streamed<ForgeReviewFrame>(stop => opened.ctx.forgePanel.reviewLists(null, stop))
    const count = streamed<ForgeReviewCountFrame>(stop => opened.ctx.forgePanel.reviewCount(stop))
    await lists.pull()
    await count.pull()

    await opened.panel.dispose()

    await expect(lists.pull()).resolves.toBeUndefined()
    await expect(count.pull()).resolves.toBeUndefined()
  })
})

describe('forgePanel review page configuration', () => {
  const backoff = 'forge-panel: reviewMaxBackoffMs must be at least reviewListIntervalMs and reviewCountIntervalMs'

  it.each([
    [{ reviewListIntervalMs: 0 }, 'forge-panel: reviewListIntervalMs must be a positive integer no greater than 2147483647'],
    [{ reviewCountIntervalMs: 1.5 }, 'forge-panel: reviewCountIntervalMs must be a positive integer no greater than 2147483647'],
    [{ reviewMaxBackoffMs: 2_147_483_648 }, 'forge-panel: reviewMaxBackoffMs must be a positive integer no greater than 2147483647'],
    [{ reviewPageSize: 0 }, 'forge-panel: reviewPageSize must be a positive integer'],
    [{ reviewMaxBackoffMs: 299_999 }, backoff],
    [{ reviewListIntervalMs: 20, reviewCountIntervalMs: 10, reviewMaxBackoffMs: 19 }, backoff],
  ])('rejects %j at load', async (config, message) => {
    const opened = await page()
    await opened.panel.dispose()

    await expect(opened.ctx.plugin(ForgePanelController, config)).rejects.toThrow(message)
  })

  it('accepts a largest backoff equal to the longer interval', async () => {
    const opened = await page({ reviewListIntervalMs: 20, reviewCountIntervalMs: 10, reviewMaxBackoffMs: 20 })

    expect(opened.ctx.get('forgePanel')).toBeDefined()
  })
})

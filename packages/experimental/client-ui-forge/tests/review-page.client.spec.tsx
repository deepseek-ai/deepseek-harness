// @vitest-environment jsdom
/**
 * The review page: its lists beside the shown change request, the reader's choices in the page store, the refresh,
 * the conversation it records for a change request, the changes view it embeds with its quotes into that conversation,
 * and that view without plugin slots.
 */
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './fonts-dom.client.ts'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionAreaProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangeRequestSnapshot, ForgeCommitList, ForgeReviewThread, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ChangeRequestActions } from '../src/client/ChangeRequestCard.tsx'
import type { ViewAnnotations } from '../src/client/annotations.ts'
import type { ForgeLensDescription } from '../src/client/changes-service.ts'
import { createChangesStore } from '../src/client/changes-store.ts'
import { ChangesView, type ChangesTabProps, type ChangesViewProps, type ChangesViewTab } from '../src/client/ChangesTab.tsx'
import { en } from '../src/client/locales.ts'
import type { ReviewChatFace } from '../src/client/review-page/ReviewChat.tsx'
import { ReviewPage, type ReviewChangesFace, type ReviewPageProps } from '../src/client/review-page/ReviewPage.tsx'
import { ReviewQueue } from '../src/client/review-queue.ts'
import { createReviewStore } from '../src/client/review-page/review-store.ts'
import type { ForgeReviewConversationProps } from '../src/client/slots.ts'
import type { StreamSnapshot } from '../src/client/source.ts'
import { ViewedFiles } from '../src/client/viewed-files.ts'
import css from '../src/client/review-page/ReviewPage.module.css'
import type {
  ForgeChangeRequestDiff, ForgeDiffFile, ForgeExtensionState, ForgeReviewChangeRequest, ForgeReviewFrame,
} from '../src/types.ts'
import { entry, ready, ref, snapshot } from './client-fixtures.client.ts'
import { description, fed, frame, host, list, prUrl, reviewed, summary, type Fed } from './review-fixtures.client.ts'
import { reviewThread } from './thread-fixtures.client.ts'

const t = makeTranslate(en)
const S1 = brandString<SessionId>('s1')
const URL7 = prUrl(7)
const HEAD = 'a'.repeat(40)

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** Let the streams and reads the page awaits settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

/** New side of `src/app.ts`, whose one hunk replaces its fourth line. */
const APP_TEXT = ['const a1 = 1', 'const a2 = 2', 'const a3 = 3', 'const y = 4', 'const a5 = 5'].join('\n') + '\n'
const APP: ForgeDiffFile = {
  path: 'src/app.ts', previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, layer: 'implementation',
  digest: 'digest', additions: 1, deletions: 1,
  hunks: [{
    oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, lines: [' const a3 = 3', '-const x = 4', '+const y = 4', ' const a5 = 5'],
  }],
}
const CHANGE: ForgeChangeRequestDiff = { headSha: HEAD, files: [APP], localAhead: null, fileUrls: {} }
const COMMITS: ForgeCommitList = { headSha: HEAD, commits: [], truncated: false }

/** A thread on the new side of line 4 of `src/app.ts`, written at the head. */
const THREAD: ForgeReviewThread = reviewThread({
  id: 't1' as ForgeThreadId, path: 'src/app.ts', current: { commit: HEAD, startLine: 4, endLine: 4 },
  original: { commit: HEAD, startLine: 4, endLine: 4 }, diffHunk: APP.hunks[0]?.lines.join('\n') ?? null,
})

/** The reads and writes of a changes view showing #7 with `threads`, each recorded. */
function changesFaces(threads: readonly ForgeReviewThread[] = []): ReviewChangesFace {
  const local = async (): Promise<never> => await Promise.reject(new Error('no local changes'))
  return {
    localDiff: vi.fn(local),
    diffBases: vi.fn(local),
    localText: vi.fn(local),
    localCommits: vi.fn(local),
    changeRequestDiff: vi.fn(async () => ok(CHANGE)),
    changeRequestCommits: vi.fn(async () => ok(COMMITS)),
    viewedFiles: new ViewedFiles('review-page-test'),
    changeRequestViewed: vi.fn(async () => ok(null)),
    setFileViewed: vi.fn(async () => ok(undefined)),
    changeRequestText: vi.fn(async () => ok(APP_TEXT)),
    changeRequestReview: vi.fn(async () => ok({
      headSha: HEAD, viewer: 'lin', threads, truncated: false, pendingReview: null, viewerCanReview: true,
      reviewEvents: ['comment', 'approve', 'request-changes'] as const,
    })),
    changeRequestReviewWrite: vi.fn(async () => ok({ ok: true as const })),
    submitReview: vi.fn(async () => ok({ ok: true as const, url: URL7 })),
    reviewQueue: vi.fn(() => new ReviewQueue('review-page-test')),
    openLink: vi.fn(),
    copyPath: vi.fn(),
    createChangeRequest: vi.fn(),
    report: vi.fn(),
    changesLens: vi.fn(() => { throw new Error('no lenses') }),
  }
}

/** Render the review page with hand-fed list and change request streams, review `threads`, and every face recorded. */
function renderPage(threads: readonly ForgeReviewThread[] = []) {
  const store = createReviewStore().create()
  const lists: Fed<ForgeReviewFrame>[] = []
  const details: Fed<ForgeReviewChangeRequest>[] = []
  const refreshes: ReturnType<typeof deferred<undefined>>[] = []
  const shown: (() => void)[] = []
  const changes = changesFaces(threads)
  const chat = {
    connect: vi.fn<ReviewChatFace['connect']>(async () => S1),
    connectWorkspace: vi.fn<ReviewChatFace['connectWorkspace']>(async () => S1),
    workspaceFailed: vi.fn<ReviewChatFace['workspaceFailed']>(),
    // Only the identity the chat tab hands back to the face is supplied.
    retain: vi.fn<ReviewChatFace['retain']>(sessionId =>
      ({ sessionId, release: () => {} }) as Pick<SessionReference, 'sessionId' | 'release'> as SessionReference),
    stage: vi.fn<ReviewChatFace['stage']>(),
    fill: vi.fn<ReviewChatFace['fill']>(async () => {}),
    openInMain: vi.fn<ReviewChatFace['openInMain']>(),
    requestWorktree: vi.fn<ReviewChatFace['requestWorktree']>(),
  }
  const conversations: ForgeReviewConversationProps[] = []
  const renderSlot = ((_key: string, owner: ForgeReviewConversationProps) => {
    conversations.push(owner)
    return <div data-review-conversation="" />
  }) as ReviewPageProps['renderSlot']
  function SessionProvider({ children }: SessionAreaProps): ReactNode {
    return <>{children}</>
  }
  const props: ReviewPageProps = {
    useLocale: bindSnapshotSelector(createSnapshotStore('en')),
    openLists: vi.fn((scope: string, signal: AbortSignal) => {
      const stream = fed<ForgeReviewFrame>(scope, signal)
      lists.push(stream)
      return stream
    }),
    openChangeRequest: vi.fn((url: string, signal: AbortSignal) => {
      const stream = fed<ForgeReviewChangeRequest>(url, signal)
      details.push(stream)
      return stream
    }),
    subscribeReset: () => () => {},
    refresh: vi.fn(() => {
      const refresh = deferred<undefined>()
      refreshes.push(refresh)
      return refresh.promise
    }),
    readDescription: vi.fn(async () => ok(description('Body'))),
    actionsFor: vi.fn((_url: string, showChanges: () => void): ChangeRequestActions => {
      shown.push(showChanges)
      return { openLink: vi.fn(), copyLink: vi.fn(), retry: vi.fn(), viewChanges: () => { showChanges() } }
    }),
    changes,
    copyText: vi.fn(),
    chat,
    quoteReview: vi.fn<ReviewPageProps['quoteReview']>(() => true),
    quoteThread: vi.fn<ReviewPageProps['quoteThread']>(() => true),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    renderSlot,
    SessionProvider,
    t,
  }
  const view = render(<ReviewPage {...props} />)
  const last = <F,>(streams: readonly Fed<F>[]): Fed<F> => {
    const stream = streams.at(-1)
    if (stream === undefined) throw new Error('no stream opened')
    return stream
  }
  const page = (): HTMLElement => {
    const element = view.container.querySelector(`.${css.page}`)
    if (!(element instanceof HTMLElement)) throw new Error('no page')
    return element
  }
  return {
    view, props, store, lists, details, refreshes, shown, changes, chat, conversations, page,
    list: () => last(lists), detail: () => last(details),
  }
}

/** Show #7 with its first status read. */
async function select(b: ReturnType<typeof renderPage>): Promise<void> {
  b.list().push(frame(host({ 'review-requested': list([summary(7), summary(8)]) })))
  await settle()
  fireEvent.click(b.view.container.querySelector(`[data-forge-review-item="${URL7}"]`) ?? document.body)
  b.detail().push(reviewed(7))
  await settle()
}

/** Show the changes tab of #7 and return its `src/app.ts` section once read. */
async function showChanges(b: ReturnType<typeof renderPage>): Promise<HTMLElement> {
  await select(b)
  fireEvent.click(b.view.getByRole('tab', { name: /^Changes/ }))
  await settle()
  const section = b.view.container.querySelector('[data-forge-diff-file="src/app.ts"]')
  if (!(section instanceof HTMLElement)) throw new Error('no section for src/app.ts')
  return section
}

/** Write `body` on line R4 of the section and add it to the chat. */
async function quoteComment(section: HTMLElement, body: string): Promise<void> {
  fireEvent.click(within(section).getByRole('button', { name: 'Select line R4' }))
  fireEvent.click(within(section).getByRole('button', { name: 'Add comment' }))
  const composer = section.querySelector('[data-forge-comment]')
  if (!(composer instanceof HTMLElement)) throw new Error('no comment form')
  fireEvent.change(within(composer).getByRole('textbox'), { target: { value: body } })
  fireEvent.click(within(composer).getByRole('button', { name: 'Add to chat' }))
  await settle()
}

describe('ReviewPage lists', () => {
  it('lists the change requests of every repository beside a placeholder until one is chosen', async () => {
    const b = renderPage()
    expect(b.props.openLists).toHaveBeenCalledWith('', b.list().signal)
    expect(b.props.openChangeRequest).not.toHaveBeenCalled()
    expect(b.view.getByText('Select a change request')).toBeTruthy()
    b.list().push(frame(host({ authored: list([summary(7)]) })))
    await settle()
    expect(b.view.container.querySelector(`[data-forge-review-item="${URL7}"]`)).not.toBeNull()
  })

  it('reads the chosen repository\'s lists and keeps the request filter, list view, search, and folds in the page store', async () => {
    const b = renderPage()
    b.list().push(frame(host({ 'review-requested': list([summary(7)]) })))
    await settle()
    fireEvent.click(b.view.getByRole('button', { name: 'Filter' }))
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /^Repository/ }))
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'octo/demo' }))
    expect(b.store.getSnapshot().repository).toEqual({ owner: 'octo', name: 'demo' })
    expect(b.lists[0]?.disposed).toHaveBeenCalledOnce()
    expect(b.list().key).toBe('octo/demo')
    fireEvent.click(b.view.getByRole('button', { name: 'Filter' }))
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Only requests made of me' }))
    expect(b.store.getSnapshot().directOnly).toBe(true)
    fireEvent.click(b.view.getByRole('button', { name: 'Filter' }))
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Compact' }))
    expect(b.store.getSnapshot().view).toBe('compact')
    b.list().push(frame(host({ 'review-requested': list([summary(7)]) })))
    await settle()
    expect(b.view.container.querySelector(`[data-forge-review-item="${URL7}"]`)?.matches(`.${css.compactItem}`)).toBe(true)

    fireEvent.change(b.view.getByRole('textbox'), { target: { value: 'parser' } })
    expect(b.store.getSnapshot().query).toBe('parser')
    b.list().push(frame(host({ 'review-requested': list([summary(7)]) })))
    await settle()
    fireEvent.click(b.view.getByRole('button', { name: /Review requested/ }))
    expect(b.store.getSnapshot().folded).toEqual({ 'review-requested': true })
  })

  it('keeps offering every repository after one is chosen, and refreshes the offer from the next complete read of all', async () => {
    const other = summary(8, { ref: { ...ref(8), repository: { ...ref(8).repository, owner: 'acme', name: 'widgets' } } })
    const offered = (): (string | null)[] => {
      fireEvent.click(b.view.getByRole('button', { name: 'Filter' }))
      const parent = within(document.body).getByRole('menuitem', { name: /^Repository/ })
      fireEvent.click(parent)
      const child = within(document.body).getAllByRole('menu').find(menu => !menu.contains(parent)) as HTMLElement
      return within(child).getAllByRole('menuitem').map(row => row.textContent)
    }
    const b = renderPage()
    // A read under way adds what it has read so far; the settled read is the record.
    b.list().push({ ...frame(host({ 'review-requested': list([summary(7)]), 'authored': list(null) })), reading: true })
    await settle()
    expect(b.store.getSnapshot().repositories).toEqual([{ owner: 'octo', name: 'demo' }])
    b.list().push(frame(host({ 'review-requested': list([summary(7)]), 'authored': list([other]) })))
    await settle()
    expect(offered()).toEqual(['All repositories', 'acme/widgets', 'octo/demo'])
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'acme/widgets' }))

    // The chosen repository's lists name only it, before and after its first frame.
    expect(b.list().key).toBe('acme/widgets')
    expect(offered()).toEqual(['All repositories', 'acme/widgets', 'octo/demo'])
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    b.list().push(frame(host({ authored: list([other]) })))
    await settle()
    expect(b.store.getSnapshot().repositories).toHaveLength(2)
    expect(offered()).toEqual(['All repositories', 'acme/widgets', 'octo/demo'])

    // Back in every repository, a complete read that no longer names one drops it.
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'All repositories' }))
    expect(b.store.getSnapshot().repositories).toHaveLength(2)
    b.list().push(frame(host({ 'review-requested': list([summary(7)]), 'authored': list([]) })))
    await settle()
    expect(b.store.getSnapshot().repositories).toEqual([{ owner: 'octo', name: 'demo' }])
  })

  it('reads every list again once at a time, showing the refresh until it settles', async () => {
    const b = renderPage()
    const button = b.view.getByRole('button', { name: 'Refresh status' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(b.props.refresh).toHaveBeenCalledOnce()
    expect(button.getAttribute('aria-disabled')).toBe('true')
    b.refreshes[0]?.settle(undefined)
    await settle()
    expect(button.getAttribute('aria-disabled')).toBe('false')
  })

  it('opens the list stream again after it stopped', async () => {
    const b = renderPage()
    b.list().end()
    await settle()
    fireEvent.click(b.view.getByRole('button', { name: 'Retry' }))
    expect(b.lists).toHaveLength(2)
  })

  it('refreshes relative times once a minute', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-09T00:05:00Z'), toFake: ['setInterval', 'clearInterval', 'Date'] })
    const b = renderPage()
    b.list().push(frame(host({ authored: list([summary(7)]) })))
    await settle()
    const meta = (): string | null | undefined => b.view.container.querySelector(`.${css.itemMeta}`)?.textContent
    expect(meta()).toBe('#7·octo·5 min ago')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(meta()).toBe('#7·octo·6 min ago')
  })
})

describe('ReviewPage detail', () => {
  it('shows the chosen change request with its card actions, and goes back to the list', async () => {
    const b = renderPage()
    await select(b)
    expect(b.store.getSnapshot().selected).toBe(URL7)
    expect(b.props.openChangeRequest).toHaveBeenCalledWith(URL7, b.detail().signal)
    expect(b.props.actionsFor).toHaveBeenCalledWith(URL7, expect.any(Function))
    expect(b.view.getByRole('heading', { level: 1 }).textContent).toBe('Change 7')
    expect(b.page().matches(`.${css.pageDetail}`)).toBe(true)
    expect(b.view.container.querySelector(`[data-forge-review-item="${URL7}"]`)?.getAttribute('aria-current')).toBe('true')

    fireEvent.click(b.view.getByRole('button', { name: 'Hide list' }))
    expect(b.page().matches(`.${css.pageListHidden}`)).toBe(true)
    fireEvent.click(b.view.getByRole('button', { name: 'Show list' }))
    expect(b.store.getSnapshot().listHidden).toBe(false)

    fireEvent.click(b.view.getByRole('button', { name: 'Back to list' }))
    expect(b.store.getSnapshot().selected).toBeNull()
    expect(b.detail().disposed).toHaveBeenCalledOnce()
    expect(b.view.getByText('Select a change request')).toBeTruthy()
  })

  it('embeds the changes view of the change request, opened from its card, and keeps its pending comments until it is left', async () => {
    const b = renderPage()
    await select(b)
    const pane = (): HTMLElement | null | undefined =>
      b.view.container.querySelector('[data-forge-diff-file="src/app.ts"]')?.closest('[hidden]')
    expect(b.changes.reviewQueue).toHaveBeenCalledWith(expect.objectContaining({ id: `review:${URL7}` }))
    const lifetime = vi.mocked(b.changes.reviewQueue).mock.calls[0]?.[0].signal
    act(() => { b.shown[0]?.() })
    expect(b.store.getSnapshot().tab).toBe('changes')
    await settle()
    expect(b.changes.changeRequestDiff).toHaveBeenCalledWith(URL7, null, expect.any(AbortSignal))
    expect(b.view.container.querySelector('[data-forge-diff-file="src/app.ts"]')).not.toBeNull()
    expect(pane()).toBeNull()
    fireEvent.click(b.view.getByRole('tab', { name: 'Summary' }))
    expect(pane()).not.toBeNull()
    expect(lifetime?.aborted).toBe(false)
    fireEvent.click(b.view.getByRole('button', { name: 'Back to list' }))
    expect(lifetime?.aborted).toBe(true)
  })

  it('starts the conversation in the chat tab, records it for the change request, and forgets it for a new one', async () => {
    const b = renderPage()
    await select(b)
    fireEvent.click(b.view.getByRole('tab', { name: 'Chat' }))
    expect(b.store.getSnapshot().tab).toBe('chat')
    expect(b.chat.connect).toHaveBeenCalledWith(reviewed(7))
    await settle()
    expect(b.store.getSnapshot().conversations).toEqual({ [URL7]: S1 })
    expect(b.chat.retain).toHaveBeenCalledWith(S1)
    expect(b.conversations.at(-1)?.headline).toBe('Review demo #7')
    expect(b.view.container.querySelector('[data-review-conversation]')).not.toBeNull()
    b.chat.connect.mockReturnValueOnce(new Promise<SessionId | undefined>(() => {}))
    fireEvent.click(b.view.getByRole('button', { name: 'New conversation' }))
    expect(b.store.getSnapshot().conversations).toEqual({})
    expect(b.chat.connect).toHaveBeenCalledTimes(2)
  })

  it('quotes a comment from the changes tab into the conversation it starts, counting it on the chat tab until shown', async () => {
    const b = renderPage()
    const section = await showChanges(b)
    expect(within(section).queryByRole('button', { name: 'Add to input' })).toBeNull()
    await quoteComment(section, 'Why y?')
    expect(b.chat.connect).toHaveBeenCalledWith(reviewed(7))
    expect(b.store.getSnapshot().conversations).toEqual({ [URL7]: S1 })
    expect(b.chat.retain).toHaveBeenCalledOnce()
    expect(b.chat.stage).toHaveBeenCalledWith(S1, URL7)
    expect(b.chat.fill).toHaveBeenCalledOnce()
    expect(b.chat.fill).toHaveBeenCalledWith(expect.objectContaining({ sessionId: S1 }), { kind: 'reference', frame: reviewed(7) })
    const [quotedIn, quoted] = vi.mocked(b.props.quoteReview).mock.calls[0] ?? []
    expect(quotedIn).toBe(S1)
    expect(quoted?.source).toMatchObject({ kind: 'change', url: URL7 })
    expect(quoted?.comment).toMatchObject({ path: 'src/app.ts', side: 'R', startLine: 4, endLine: 4, body: 'Why y?' })
    expect(within(section).queryByRole('textbox')).toBeNull()
    expect(within(section).getByText('Added to chat')).toBeTruthy()
    expect(b.store.getSnapshot().unseenQuotes).toEqual({ [URL7]: 1 })
    expect(b.view.getByRole('tab', { name: /^Chat/ }).textContent).toBe('Chat1')

    // A second quote goes into the same conversation.
    await quoteComment(section, 'And x?')
    expect(b.chat.connect).toHaveBeenCalledOnce()
    expect(b.props.quoteReview).toHaveBeenCalledTimes(2)
    expect(b.view.getByRole('tab', { name: /^Chat/ }).textContent).toBe('Chat2')
    fireEvent.click(b.view.getByRole('tab', { name: /^Chat/ }))
    expect(b.store.getSnapshot().unseenQuotes).toEqual({ [URL7]: 0 })
    expect(b.view.getByRole('tab', { name: 'Chat' }).textContent).toBe('Chat')
  })

  it('keeps the comment open with the refusal when the draft refuses the quote or no conversation could start', async () => {
    const b = renderPage()
    vi.mocked(b.props.quoteReview).mockReturnValue(false)
    const section = await showChanges(b)
    await quoteComment(section, 'Why y?')
    expect(within(section).getByRole('alert').textContent).toBe('Couldn\'t add to chat')
    expect(within(section).getByRole('textbox')).toBeTruthy()
    expect(b.store.getSnapshot().unseenQuotes).toEqual({})
    cleanup()

    const none = renderPage()
    none.chat.connect.mockResolvedValue(undefined)
    const empty = await showChanges(none)
    await quoteComment(empty, 'Why y?')
    expect(within(empty).getByRole('alert').textContent).toBe('Couldn\'t add to chat')
    expect(none.props.quoteReview).not.toHaveBeenCalled()
    fireEvent.click(none.view.getByRole('tab', { name: 'Chat' }))
    expect(none.view.getByRole('status').textContent).toBe('Conversation unavailable')
  })

  it('quotes a review thread from the changes tab into the conversation, and reports a refused one', async () => {
    const b = renderPage([THREAD])
    await showChanges(b)
    const card = (): HTMLElement => {
      const element = b.view.container.querySelector('[data-forge-thread="t1"]')
      if (!(element instanceof HTMLElement)) throw new Error('no thread card')
      return element
    }
    fireEvent.click(within(card()).getByRole('button', { name: 'Add to chat' }))
    await settle()
    expect(b.props.quoteThread).toHaveBeenCalledWith(S1, THREAD, URL7, 'R4')
    expect(b.store.getSnapshot().unseenQuotes).toEqual({ [URL7]: 1 })
    expect(b.changes.report).not.toHaveBeenCalled()
    vi.mocked(b.props.quoteThread).mockReturnValue(false)
    fireEvent.click(within(card()).getByRole('button', { name: 'Add to chat' }))
    await settle()
    expect(b.changes.report).toHaveBeenCalledWith('reviewPage.addToChatFailed')
    expect(b.store.getSnapshot().unseenQuotes).toEqual({ [URL7]: 1 })
  })
})

describe('ChangesView without a target', () => {
  it('draws no plugin slot for annotations, the file menu, the More menu, or the comment form, and offers no sidebar file', async () => {
    const faces = changesFaces()
    const store = createChangesStore().create()
    const tab: ChangesViewTab = {
      id: `review:${URL7}`, visible: true, navigation: { address: URL7, params: undefined, revision: 1 },
      signal: new AbortController().signal,
      actions: { bindCommands: () => () => {} },
    }
    const annotation = { key: 'n1', place: { side: 'R' as const, startLine: 4, endLine: 4 }, version: 1 }
    const annotations: ViewAnnotations = new Map([['src/app.ts', [{ source: 'notes', annotation }]]])
    const slots: string[] = []
    const renderSlot = ((key: string) => {
      slots.push(key)
      return null
    }) as ChangesTabProps['renderSlot']
    const head: ChangeRequestSnapshot = snapshot(7)
    const props: ChangesViewProps = {
      ...faces, addReviewToInput: vi.fn(() => false), addThreadToInput: vi.fn(() => false),
      tab, source: { kind: 'change', url: URL7 }, target: null, annotations, openFile: undefined,
      snapshot: { state: ready({ changeRequests: [entry(7, head)] }), disconnected: false },
      reconnect: vi.fn(),
      useLenses: bindSnapshotSelector(createSnapshotStore<readonly ForgeLensDescription[]>([])),
      useExtensions: bindSnapshotSelector(createSnapshotStore<StreamSnapshot<ForgeExtensionState | null>>({
        state: { lenses: [], maxAnnotationsPerFile: 100 }, disconnected: false,
      })),
      renderSlot, useStore: bindSnapshotSelector(store), actions: store.actions, t,
    }
    const view = render(<ChangesView {...props} />)
    await settle()
    const section = view.container.querySelector('[data-forge-diff-file="src/app.ts"]')
    if (!(section instanceof HTMLElement)) throw new Error('no section for src/app.ts')
    expect(section.querySelector('[data-forge-annotation="notes/n1"]')?.innerHTML).toBe('')

    fireEvent.click(within(section).getByRole('button', { name: 'More actions for app.ts' }))
    expect(within(document.body).getAllByRole('menuitem').map(row => row.textContent)).toEqual([en['diff.copyPath']])
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    fireEvent.click(view.getByRole('button', { name: 'More view options' }))
    expect(within(document.body).getAllByRole('menuitem').length).toBeGreaterThan(0)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    fireEvent.click(within(section).getByRole('button', { name: 'Select line R4' }))
    fireEvent.click(within(section).getByRole('button', { name: 'Add comment' }))
    expect(within(section).getByRole('textbox')).toBeTruthy()
    expect(slots).toEqual([])
  })
})

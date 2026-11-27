// @vitest-environment jsdom
/**
 * The review page's detail of one change request: its loading and failure states, the header with state, repository,
 * labels, times, and actions, the tabs, and the summary's description read with its signed images renewed.
 */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChangeRequestActivity, ChangeRequestDescription, ChangeRequestSnapshot } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ChangeRequestActions } from '../src/client/ChangeRequestCard.tsx'
import type { StreamRead } from '../src/client/review-page/host-stream.ts'
import { en } from '../src/client/locales.ts'
import { ReviewDetail, type ReviewDetailProps } from '../src/client/review-page/ReviewDetail.tsx'
import css from '../src/client/review-page/ReviewPage.module.css'
import type { ForgeReviewChangeRequest } from '../src/types.ts'
import { snapshot } from './client-fixtures.client.ts'
import { description, prUrl, reviewed } from './review-fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = makeTranslate(en)
const NOW = Date.parse('2026-10-09T02:00:00Z')
const URL7 = prUrl(7)
/** A site mark, as the link icon draws the marks of known hosts. */
const SITE_MARK = 'svg[viewBox="-2 -2 28 28"]'

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

/** Let the description read settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

/** Under fake timers, run the timers due within `ms`, then let the reads they started settle. */
async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

function stream(frame: ForgeReviewChangeRequest | undefined, stopped: StreamRead<ForgeReviewChangeRequest>['stopped'] = null) {
  return { frame, stopped, retry: vi.fn() }
}

/** Render the detail of #7 with every handler recorded, a description of `Body` read, and the summary tab shown. */
function renderDetail(overrides: Partial<ReviewDetailProps> = {}) {
  const actions = {
    openLink: vi.fn<ChangeRequestActions['openLink']>(),
    copyLink: vi.fn<ChangeRequestActions['copyLink']>(),
    retry: vi.fn<ChangeRequestActions['retry']>(),
    markReady: vi.fn(async () => {}),
  }
  const read = stream(reviewed(7))
  const props: ReviewDetailProps = {
    url: URL7, read, tab: 'summary', onTab: vi.fn(), onOpenCommit: vi.fn(), listHidden: false, onToggleList: vi.fn(), onBack: vi.fn(), now: NOW, locale: 'en',
    actions, readDescription: vi.fn(async () => ok(description('Body'))), readActivity: vi.fn(async () => ok(null)),
    addComment: vi.fn(async () => ok(undefined)), onAddHost: undefined,
    renderChanges: vi.fn(() => <p>changes body</p>), renderChat: vi.fn(() => <p>chat body</p>), unseenQuotes: 0, coarsePointer: false, t,
    ...overrides,
  }
  const view = render(<ReviewDetail {...props} />)
  const rerender = (next: Partial<ReviewDetailProps>): void => { view.rerender(<ReviewDetail {...props} {...next} />) }
  return { view, props, actions, read, rerender }
}

function changed(overrides: Partial<ChangeRequestSnapshot>): ForgeReviewChangeRequest {
  return reviewed(7, snapshot(7, overrides))
}

describe('ReviewDetail before a status', () => {
  it('draws the detail as a skeleton until the first status, with the list toggle and the link actions already working', () => {
    const b = renderDetail({ read: stream(undefined) })
    const detail = b.view.container.querySelector('[data-forge-review-detail]') as HTMLElement
    expect(detail.getAttribute('aria-busy')).toBe('true')
    expect(b.view.getByRole('status').textContent).toBe('Reading the change request')
    expect([...detail.querySelectorAll('[data-forge-review-skeleton]')].map(part => part.getAttribute('data-forge-review-skeleton')))
      .toEqual(['description', 'activity', 'status'])
    // The captions of the two sections are fixed text; the title, the tabs, and the status column are not read yet.
    expect(b.view.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual(['Description', 'Activity'])
    expect(b.view.queryByRole('heading', { level: 1 })).toBeNull()
    expect(b.view.queryAllByRole('tab')).toEqual([])
    expect(b.view.queryByRole('complementary')).toBeNull()
    // Opening, copying, and reading again need only the URL. No frame has named the provider yet.
    fireEvent.click(b.view.getByRole('button', { name: 'Open in browser' }))
    expect(b.actions.openLink).toHaveBeenCalledWith(URL7)
    fireEvent.click(b.view.getByRole('button', { name: 'Copy link' }))
    expect(b.actions.copyLink).toHaveBeenCalledWith(URL7)
    fireEvent.click(b.view.getByRole('button', { name: 'Refresh status' }))
    expect(b.actions.retry).toHaveBeenCalledOnce()
    fireEvent.click(b.view.getByRole('button', { name: 'Back to list' }))
    expect(b.props.onBack).toHaveBeenCalledOnce()
    const toggle = b.view.getByRole('button', { name: 'Hide list' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(b.props.onToggleList).toHaveBeenCalledOnce()
    b.rerender({ listHidden: true })
    expect(b.view.getByRole('button', { name: 'Show list' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps the skeleton while the latest poll has not returned a status yet, naming the code host once a frame did', () => {
    const b = renderDetail({ read: stream(reviewed(7, null)) })
    expect(b.view.getByRole('status').textContent).toBe('Reading the change request')
    expect(b.view.getByRole('button', { name: 'Open on GitHub' })).toBeTruthy()
    cleanup()
    const polled = renderDetail({ read: stream({ ...reviewed(7), snapshot: null }) })
    expect(polled.view.getByRole('status').textContent).toBe('Reading the change request')
    expect(polled.view.container.querySelector('[data-forge-review-skeleton="status"]')).not.toBeNull()
  })

  it('explains a link whose host no code host component serves', () => {
    const b = renderDetail({ read: stream(undefined, { code: 'forgePanel/unrecognized-url', message: 'no provider' }) })
    expect(b.view.getByRole('status').textContent).toBe('Unknown code hostThis link\'s host has not been added to a code host component.')
    expect(b.view.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(b.view.queryByRole('button', { name: 'Add host…' })).toBeNull()
  })

  it('offers the host lists for such a link while they can be opened', () => {
    const onAddHost = vi.fn()
    const b = renderDetail({ read: stream(undefined, { code: 'forgePanel/unrecognized-url', message: 'no provider' }), onAddHost })
    fireEvent.click(within(b.view.getByRole('status')).getByRole('button', { name: 'Add host…' }))
    expect(onAddHost).toHaveBeenCalledOnce()
  })

  it('offers to open the stream again or the browser once the stream stopped', () => {
    const b = renderDetail({ read: stream(undefined, { code: 'ended', message: '' }) })
    expect(within(b.view.getByRole('status')).getByText('Couldn\'t read the change request')).toBeTruthy()
    const status = b.view.getByRole('status')
    fireEvent.click(within(status).getByRole('button', { name: 'Retry' }))
    expect(b.props.read.retry).toHaveBeenCalledOnce()
    fireEvent.click(within(status).getByRole('button', { name: 'Open in browser' }))
    expect(b.actions.openLink).toHaveBeenCalledWith(URL7)
    // The header's refresh opens the stream again as well, since a poll cannot reach a stopped stream.
    fireEvent.click(b.view.getByRole('button', { name: 'Refresh status' }))
    expect(b.props.read.retry).toHaveBeenCalledTimes(2)
    expect(b.actions.retry).not.toHaveBeenCalled()
    expect(b.view.container.querySelector('[data-forge-review-skeleton]')).toBeNull()
  })

  it('names why the poll failed and polls again, or reopens the stream once it also stopped', () => {
    const b = renderDetail({ read: stream(reviewed(7, { code: 'not-found', message: 'Could not resolve to a PullRequest' })) })
    const status = b.view.getByRole('status')
    expect(within(status).getByText(en['reviewPage.notFound'])).toBeTruthy()
    expect(within(status).getByText('Could not resolve to a PullRequest')).toBeTruthy()
    fireEvent.click(within(status).getByRole('button', { name: 'Retry' }))
    expect(b.actions.retry).toHaveBeenCalledOnce()
    cleanup()

    const read = stream(reviewed(7, { code: 'rate-limited', message: '' }), { code: 'ended', message: '' })
    const stopped = renderDetail({ read })
    const notice = stopped.view.getByRole('status')
    expect(notice.querySelectorAll('p')).toHaveLength(1)
    expect(notice.textContent).toContain(en['change.failure.rateLimited'])
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }))
    expect(read.retry).toHaveBeenCalledOnce()
    expect(stopped.actions.retry).not.toHaveBeenCalled()
  })
})

describe('ReviewDetail header', () => {
  it('shows the state, the repository link, the labels, the title, the author, the times, and the branches', async () => {
    const b = renderDetail({
      read: stream(changed({ updatedAt: '2026-10-09T01:00:00Z' })),
      readDescription: vi.fn(async () => ok(description('Body', { labels: [{ name: 'bug', color: 'd73a4a' }], labelsTruncated: true }))),
    })
    const header = b.view.container.querySelector('header')
    if (header === null) throw new Error('no header')
    expect(header.querySelector(`.${css.stateChip}`)?.textContent).toBe('Open')
    expect(header.querySelector(`.${css.stateChip}`)?.getAttribute('data-tone')).toBe('open')
    expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('Change 7')
    expect(header.querySelector(`.${css.detailMeta}`)?.textContent).toBe('octo·Updated 1 h ago·feat → main')
    await settle()
    expect(header.querySelector(`.${css.detailMeta}`)?.textContent).toBe('octo·Created 8 d ago·Updated 1 h ago·feat → main')
    expect(within(header).getByRole('group', { name: 'All labels: bug' })).toBeTruthy()
    const link = within(header).getByRole('link', { name: 'octo/demo#7' })
    expect(link.getAttribute('href')).toBe(URL7)
    expect(fireEvent.click(link)).toBe(false)
    expect(b.actions.openLink).toHaveBeenCalledWith(URL7)
  })

  it('leaves out an author the host hides and an update time that does not parse', async () => {
    const b = renderDetail({ read: stream(changed({ author: null, updatedAt: 'unknown' })) })
    await settle()
    expect(b.view.container.querySelector(`.${css.detailMeta}`)?.textContent).toBe('·Created 8 d ago·feat → main')
  })

  it('offers no ready-for-review action on a surface that cannot mark a draft ready', () => {
    const { markReady: _markReady, ...actions } = renderDetail().actions
    cleanup()
    const b = renderDetail({ read: stream(changed({ draft: true })), actions })
    expect(b.view.queryByRole('button', { name: 'Ready for review' })).toBeNull()
    expect(b.view.getByRole('button', { name: 'More actions' })).toBeTruthy()
  })

  it('offers the primary action before the three link actions, which open GitHub, copy with a mark, and read the status again', async () => {
    vi.useFakeTimers()
    const b = renderDetail({ read: stream(changed({ draft: true })) })
    const primary = b.view.getByRole('button', { name: 'Ready for review' })
    expect(primary.closest(`.${css.primary}`)).not.toBeNull()
    fireEvent.click(primary)
    expect(b.actions.markReady).toHaveBeenCalledOnce()

    const links = b.view.container.querySelector('[data-forge-review-actions]') as HTMLElement
    expect(primary.compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(within(links).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Open on GitHub', 'Copy link', 'Refresh status'])
    const open = within(links).getByRole('button', { name: 'Open on GitHub' })
    expect(open.querySelector(SITE_MARK)).not.toBeNull()
    fireEvent.click(open)
    expect(b.actions.openLink).toHaveBeenCalledWith(URL7)

    // Copying shows a mark for a moment.
    const copy = within(links).getByRole('button', { name: 'Copy link' })
    fireEvent.click(copy)
    expect(b.actions.copyLink).toHaveBeenCalledWith(URL7)
    expect(copy.querySelector(`.${css.copied}`)).not.toBeNull()
    await tick(1500)
    expect(copy.querySelector(`.${css.copied}`)).toBeNull()

    // The refresh glyph turns until the read it started ends.
    const read = deferred<undefined>()
    b.actions.retry.mockReturnValueOnce(read.promise)
    const refresh = within(links).getByRole('button', { name: 'Refresh status' })
    fireEvent.click(refresh)
    expect(b.actions.retry).toHaveBeenCalledOnce()
    expect(refresh.querySelector('[data-turning]')).not.toBeNull()
    read.settle(undefined)
    await tick(0)
    expect(refresh.querySelector('[data-turning]')).toBeNull()
  })

  it('keeps the same three actions in the More menu, which a narrow header shows in their place', () => {
    const b = renderDetail()
    const more = b.view.getByRole('button', { name: 'More actions' })
    expect(more.closest(`.${css.moreAction}`)).not.toBeNull()
    for (const [row, check] of [
      ['Open on GitHub', () => { expect(b.actions.openLink).toHaveBeenCalledWith(URL7) }],
      ['Copy change request link', () => { expect(b.actions.copyLink).toHaveBeenCalledWith(URL7) }],
      ['Refresh status', () => { expect(b.actions.retry).toHaveBeenCalledOnce() }],
    ] as const) {
      fireEvent.click(more)
      expect(more.getAttribute('aria-expanded')).toBe('true')
      fireEvent.click(within(document.body).getByRole('menuitem', { name: row }))
      check()
      expect(more.getAttribute('aria-expanded')).toBe('false')
    }
    fireEvent.click(more)
    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
  })

  it('marks the opening action with the mark of the provider\'s family, whatever the host name, and with the arrow without one', () => {
    const gitlab = { forge: 'gitlab', label: 'GitLab', changeRequestNoun: 'merge-request' as const }
    const b = renderDetail({ read: stream({ ...reviewed(7), forge: gitlab }) })
    expect(b.view.getByRole('button', { name: 'Open on GitLab' }).querySelector(SITE_MARK)).not.toBeNull()
    b.rerender({ read: stream({ ...reviewed(7), forge: { ...gitlab, forge: 'gitea', label: 'Gitea' } }) })
    expect(b.view.getByRole('button', { name: 'Open on Gitea' }).querySelector(SITE_MARK)).toBeNull()
    b.rerender({ read: stream({ ...reviewed(7), forge: null }) })
    expect(b.view.getByRole('button', { name: 'Open in browser' }).querySelector(SITE_MARK)).toBeNull()
  })

  it('cuts a long repository name and keeps its number', () => {
    const b = renderDetail()
    const link = b.view.container.querySelector(`.${css.repository}`) as HTMLElement
    expect([...link.children].map(part => [part.className, part.textContent])).toEqual([[css.repositoryName, 'octo/demo'], [css.number, '#7']])
  })

  it('offers the automatic merge of a change request the host would not merge yet, and its cancellation once it is on', async () => {
    const autoMerge = vi.fn<NonNullable<ChangeRequestActions['autoMerge']>>(async () => {})
    const off = { enabled: false, method: null, enabledBy: null, canEnable: true, canDisable: false }
    const b = renderDetail({ read: stream(changed({ mergeReady: false, mergeMethods: ['merge', 'squash'], autoMerge: off })) })
    b.rerender({ actions: { ...b.actions, autoMerge } })
    fireEvent.click(b.view.getByRole('button', { name: 'Auto-merge' }))
    expect(within(document.body).getByText('Merge #7 into main once its requirements are met')).toBeTruthy()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /Squash and merge/ }))
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Enable auto-merge' }))
    expect(autoMerge).toHaveBeenLastCalledWith(expect.objectContaining({ url: URL7 }), { enabled: true, method: 'squash', headSha: 'a'.repeat(40) })
    await settle()

    const on = { enabled: true, method: 'squash' as const, enabledBy: 'mona', canEnable: false, canDisable: true }
    b.rerender({ actions: { ...b.actions, autoMerge }, read: stream(changed({ mergeReady: false, mergeMethods: ['merge', 'squash'], autoMerge: on })) })
    const status = b.view.getByRole('button', { name: 'Auto-merge enabled' })
    expect(b.view.queryByRole('button', { name: 'Auto-merge' })).toBeNull()
    fireEvent.click(status)
    expect(within(document.body).getByText('Merges into main once its requirements are met')).toBeTruthy()
    expect(within(document.body).getByText('Method: Squash and merge · Enabled by mona')).toBeTruthy()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Cancel auto-merge' }))
    expect(autoMerge).toHaveBeenLastCalledWith(expect.objectContaining({ url: URL7 }), { enabled: false })
    expect(status.getAttribute('aria-expanded')).toBe('false')
    await settle()

    // An automatic merge the host names neither the method nor the account of, and that the user may not cancel.
    const bare = { enabled: true, method: null, enabledBy: null, canEnable: false, canDisable: false }
    b.rerender({ actions: { ...b.actions, autoMerge }, read: stream(changed({ mergeReady: false, autoMerge: bare })) })
    fireEvent.click(b.view.getByRole('button', { name: 'Auto-merge enabled' }))
    expect(within(document.body).queryByText(/Method:|Enabled by/)).toBeNull()
    expect(within(document.body).queryByRole('menuitem', { name: 'Cancel auto-merge' })).toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  })

  it('shows the merge the host would refuse as unavailable and names why', async () => {
    vi.useFakeTimers()
    const blocked = changed({ mergeReady: false, mergeability: 'conflicting', reviewDecision: 'changes-requested', checksRollup: 'failure' })
    const b = renderDetail({ read: stream(blocked) })
    const merge = b.view.getByRole('button', { name: 'Merge' })
    expect(merge.getAttribute('aria-disabled')).toBe('true')
    expect(merge.getAttribute('aria-haspopup')).toBeNull()
    fireEvent.pointerEnter(merge)
    await tick(0)
    expect(within(document.body).getByRole('tooltip').textContent).toBe('Has merge conflicts, Changes were requested, Checks failed')
    fireEvent.pointerLeave(merge)
    // A surface that cannot turn the automatic merge on shows the same button for a change request that allows it.
    const allowed = { enabled: false, method: null, enabledBy: null, canEnable: true, canDisable: false }
    b.rerender({ read: stream(changed({ mergeReady: false, autoMerge: allowed })) })
    expect(b.view.getByRole('button', { name: 'Merge' }).getAttribute('aria-disabled')).toBe('true')
    expect(b.view.queryByRole('button', { name: 'Auto-merge' })).toBeNull()
    // A merged change request has no merge action.
    b.rerender({ read: stream(changed({ state: 'merged', mergeReady: false })) })
    expect(b.view.queryByRole('button', { name: 'Merge' })).toBeNull()
  })
})

describe('ReviewDetail tabs', () => {
  it('names each tab with the diff size, keeps the changes mounted but hidden, and draws the chat only in its tab', () => {
    const b = renderDetail({ read: stream(changed({ additions: 1234, deletions: 5 })) })
    const tabs = b.view.getAllByRole('tab')
    expect(tabs.map(tab => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([
      ['Summary', 'true'], ['Changes+1,234−5', 'false'], ['Chat', 'false'],
    ])
    const panel = b.view.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe('forge-review-tab-summary')
    expect(panel.matches(`.${css.panelFill}`)).toBe(false)
    expect(b.view.getByText('changes body').parentElement?.hidden).toBe(true)
    expect(b.view.queryByText('chat body')).toBeNull()
    expect(within(panel).getByRole('complementary', { name: 'Status' })).toBeTruthy()
    fireEvent.click(tabs[2]!)
    expect(b.props.onTab).toHaveBeenCalledWith('chat')

    b.rerender({ tab: 'changes' })
    expect(b.view.getByText('changes body').parentElement?.hidden).toBe(false)
    expect(b.view.getByRole('tabpanel').matches(`.${css.panelFill}`)).toBe(true)
    expect(b.view.queryByRole('complementary', { name: 'Status' })).toBeNull()
    b.rerender({ tab: 'chat' })
    expect(b.view.getByText('chat body')).toBeTruthy()
    expect(b.props.renderChat).toHaveBeenLastCalledWith(b.props.read.frame)
    expect(b.props.renderChanges).toHaveBeenLastCalledWith(b.props.read.frame)
  })

  it('counts on the chat tab the quotes added to the conversation while the tab was not shown', () => {
    const b = renderDetail()
    const chat = (): HTMLElement => b.view.getByRole('tab', { name: /^Chat/ })
    expect(chat().textContent).toBe('Chat')
    b.rerender({ unseenQuotes: 2 })
    expect(chat().textContent).toBe('Chat2')
    expect(within(chat()).getByLabelText('2 quotes to send').matches(`.${css.tabBadge}`)).toBe(true)
    b.rerender({ unseenQuotes: 0 })
    expect(chat().textContent).toBe('Chat')
  })
})

describe('ReviewDetail activity', () => {
  it('opens one commit of the activity through the detail, without showing the changes tab itself', async () => {
    const sha = 'a'.repeat(40)
    const readActivity = vi.fn<ReviewDetailProps['readActivity']>(async () => ok({
      items: [{ kind: 'commit', at: '2026-10-09T01:00:00Z', actor: null, sha, title: 'Fix the parser' }], truncated: false, viewerCanComment: false,
    }))
    const b = renderDetail({ readActivity })
    await settle()
    fireEvent.click(b.view.getByRole('button', { name: 'Fix the parser, View in Changes' }))
    expect(b.props.onOpenCommit).toHaveBeenCalledWith(sha)
    expect(b.props.onTab).not.toHaveBeenCalled()
  })

  it('shows the activity under the description, reads it again when the change request or its reviews change, and opens the changes tab', async () => {
    const activity: ChangeRequestActivity = {
      items: [{ kind: 'review', at: '2026-10-09T01:00:00Z', actor: { login: 'mona', avatarUrl: null, bot: false }, verdict: 'commented', body: '',
        comments: 1, url: null }],
      truncated: false, viewerCanComment: true,
    }
    const readActivity = vi.fn<ReviewDetailProps['readActivity']>(async () => ok(activity))
    const addComment = vi.fn<ReviewDetailProps['addComment']>(async () => ok(undefined))
    const b = renderDetail({ readActivity, addComment })
    await settle()
    const region = b.view.getByRole('region', { name: 'Activity' })
    expect(region.compareDocumentPosition(b.view.getByRole('region', { name: 'Description' })) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0)
    expect(readActivity).toHaveBeenCalledWith(URL7, expect.any(AbortSignal))
    fireEvent.click(within(region).getByRole('button', { name: 'mona reviewed · Inline comments: 1, View in Changes' }))
    expect(b.props.onTab).toHaveBeenCalledWith('changes')

    // A comment goes to the change request the detail shows, and the activity is read again after it.
    fireEvent.change(within(region).getByRole('textbox', { name: 'Leave a comment' }), { target: { value: 'Thanks' } })
    fireEvent.click(within(region).getByRole('button', { name: 'Comment' }))
    await settle()
    expect(addComment).toHaveBeenCalledWith(URL7, 'Thanks')
    expect(readActivity).toHaveBeenCalledTimes(2)

    b.rerender({ read: stream(changed({ updatedAt: '2026-10-09T01:30:00Z' })) })
    await settle()
    expect(readActivity).toHaveBeenCalledTimes(3)
    b.rerender({ read: stream({ ...changed({ updatedAt: '2026-10-09T01:30:00Z' }), reviewRevision: 4 }) })
    await settle()
    expect(readActivity).toHaveBeenCalledTimes(4)
    // The link in the activity opens through the detail's own link action.
    readActivity.mockResolvedValueOnce(ok({ ...activity, truncated: true }))
    b.rerender({ read: stream({ ...changed({ updatedAt: '2026-10-09T01:30:00Z' }), reviewRevision: 5 }) })
    await settle()
    fireEvent.click(within(region).getByRole('button', { name: 'Open on GitHub' }))
    expect(b.actions.openLink).toHaveBeenCalledWith(URL7)

    // Once the provider left, a comment whose outcome is unknown has no product name to point at.
    addComment.mockResolvedValueOnce({ ok: false, error: new RemoteError('forgePanel/action-unknown', 'no answer', {}) })
    b.rerender({ read: stream({ ...changed({ updatedAt: '2026-10-09T01:30:00Z' }), reviewRevision: 5, forge: null }) })
    fireEvent.change(within(region).getByRole('textbox', { name: 'Leave a comment' }), { target: { value: 'Again' } })
    fireEvent.click(within(region).getByRole('button', { name: 'Comment' }))
    await settle()
    expect(within(region).getByRole('alert').textContent).toBe('The comment was not posted: no answer')
  })
})

describe('ReviewDetail description', () => {
  it('waits for the description, renders its Markdown, and names an empty one', async () => {
    const read = deferred<RemoteResult<ChangeRequestDescription>>()
    const readDescription = vi.fn((_url: string, _signal: AbortSignal) => read.promise)
    const b = renderDetail({ readDescription })
    const region = b.view.getByRole('region', { name: 'Description' })
    expect(region.getAttribute('aria-busy')).toBeNull()
    expect(region.querySelector('[data-forge-review-skeleton="description"]')).not.toBeNull()
    expect(region.textContent).toBe('Description')
    read.settle(ok(description('Hello **world** <img alt="shot" src="https://example.test/a.png">')))
    await settle()
    expect(within(region).getByText('world').tagName).toBe('STRONG')
    expect(within(region).getByRole('img', { name: 'shot' }).getAttribute('src')).toBe('https://example.test/a.png')
    cleanup()

    const empty = renderDetail({ readDescription: vi.fn(async () => ok(description('  \n'))) })
    await settle()
    expect(empty.view.getByText('No description')).toBeTruthy()
  })

  it('reports a failed read with a retry, and keeps the description read earlier when a later read fails', async () => {
    const readDescription = vi.fn<ReviewDetailProps['readDescription']>()
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('forgePanel/description-failed', 'GitHub is down', {}) })
      .mockResolvedValueOnce(ok(description('First')))
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('forgePanel/description-failed', 'still down', {}) })
    const b = renderDetail({ readDescription })
    await settle()
    const notice = within(b.view.getByRole('region', { name: 'Description' })).getByRole('status')
    expect(notice.textContent).toContain('Couldn\'t read the description: GitHub is down')
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }))
    await settle()
    expect(b.view.getByText('First')).toBeTruthy()
    b.rerender({ read: stream(changed({ updatedAt: '2026-10-09T01:30:00Z' })) })
    await settle()
    expect(readDescription).toHaveBeenCalledTimes(3)
    expect(b.view.getByText('First')).toBeTruthy()
  })

  it('drops a read that settles after the change request moved on, and shows no description of another change request', async () => {
    const first = deferred<RemoteResult<ChangeRequestDescription>>()
    const second = deferred<RemoteResult<ChangeRequestDescription>>()
    const readDescription = vi.fn<ReviewDetailProps['readDescription']>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(ok(description('Eight')))
    const b = renderDetail({ readDescription })
    b.rerender({ read: stream(changed({ updatedAt: '2026-10-09T01:30:00Z' })) })
    expect(readDescription.mock.calls[0]?.[1].aborted).toBe(true)
    first.settle(ok(description('Stale')))
    second.settle(ok(description('Seven')))
    await settle()
    expect(b.view.queryByText('Stale')).toBeNull()
    expect(b.view.getByText('Seven')).toBeTruthy()
    b.rerender({ url: prUrl(8), read: stream(changed({ updatedAt: '2026-10-09T01:30:00Z' })) })
    expect(b.view.queryByText('Seven')).toBeNull()
    await settle()
    expect(readDescription).toHaveBeenLastCalledWith(prUrl(8), expect.any(AbortSignal))
    expect(b.view.getByText('Eight')).toBeTruthy()
  })

  it('reads the description again 30 seconds before its signed images expire, at once when they already expired', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const readDescription = vi.fn<ReviewDetailProps['readDescription']>()
      .mockResolvedValueOnce(ok(description('Signed', { imagesExpireAt: new Date(NOW + 90_000).toISOString() })))
      .mockResolvedValueOnce(ok(description('Expired', { imagesExpireAt: new Date(NOW - 1).toISOString() })))
      .mockResolvedValue(ok(description('Unsigned', { imagesExpireAt: 'never' })))
    const b = renderDetail({ readDescription })
    await tick(0)
    expect(b.view.getByText('Signed')).toBeTruthy()
    await tick(59_000)
    expect(readDescription).toHaveBeenCalledTimes(1)
    // The renewed read's images already expired, so it reads once more at once; the last read names no valid time.
    await tick(1_000)
    expect(readDescription).toHaveBeenCalledTimes(3)
    expect(b.view.getByText('Unsigned')).toBeTruthy()
    await tick(600_000)
    expect(readDescription).toHaveBeenCalledTimes(3)
    b.view.unmount()
  })

  it('stops waiting to renew the images once the detail closes', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const readDescription = vi.fn<ReviewDetailProps['readDescription']>()
      .mockResolvedValue(ok(description('Signed', { imagesExpireAt: new Date(NOW + 90_000).toISOString() })))
    const b = renderDetail({ readDescription })
    await tick(0)
    b.view.unmount()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(readDescription).toHaveBeenCalledTimes(1)
  })
})

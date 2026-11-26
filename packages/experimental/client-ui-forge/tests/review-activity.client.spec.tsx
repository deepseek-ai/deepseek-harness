// @vitest-environment jsdom
/**
 * The summary tab's activity: its rows with runs of commits as one, each kind of line and card, the reads that follow
 * the change request, and the field that adds a comment.
 */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChangeRequestActivity, ChangeRequestActivityItem, ForgeCommentAuthor } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { en } from '../src/client/locales.ts'
import { activityEntries, longBody } from '../src/client/review-page/review-activity.ts'
import { ReviewActivity, type ReviewActivityProps } from '../src/client/review-page/ReviewActivity.tsx'
import css from '../src/client/review-page/ReviewPage.module.css'
import { prUrl } from './review-fixtures.client.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(en)
const NOW = Date.parse('2026-10-09T02:00:00Z')
const URL7 = prUrl(7)
const MARKDOWN = { code: { copyLabel: 'Copy', copiedLabel: 'Copied', toolbarLabels: { codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' } }, footnotes: 'Footnotes' }

const mona: ForgeCommentAuthor = { login: 'mona', avatarUrl: null, bot: false }
const robot: ForgeCommentAuthor = { login: 'ci-bot', avatarUrl: null, bot: true }

/** An hour before {@link NOW}, plus `minutes`. */
function at(minutes = 0): string {
  return new Date(NOW - 3_600_000 + minutes * 60_000).toISOString()
}

function commit(sha: string, title: string, minutes = 0): ChangeRequestActivityItem {
  return { kind: 'commit', at: at(minutes), actor: mona, sha: sha.repeat(40), title }
}

function activity(items: readonly ChangeRequestActivityItem[], overrides: Partial<ChangeRequestActivity> = {}): ChangeRequestActivity {
  return { items, truncated: false, viewerCanComment: false, ...overrides }
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function failed(code: 'forgePanel/activity-failed' | 'forgePanel/action-failed' | 'forgePanel/action-unknown', message: string): RemoteResult<never> {
  return { ok: false, error: new RemoteError(code, message, {}) }
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

/** Let the reads in flight settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

/** Render the activity of #7 on GitHub with every handler recorded; the read answers `value`. */
async function renderActivity(value: ChangeRequestActivity | null, overrides: Partial<ReviewActivityProps> = {}) {
  const props: ReviewActivityProps = {
    url: URL7, revision: 'r1', forge: 'GitHub', read: vi.fn(async () => ok(value)), comment: vi.fn(async () => ok(undefined)),
    onOpenChanges: vi.fn(), onOpenCommit: vi.fn(), openLink: vi.fn(), now: NOW, markdown: MARKDOWN, t, ...overrides,
  }
  const view = render(<ReviewActivity {...props} />)
  await settle()
  const rerender = (next: Partial<ReviewActivityProps>): void => { view.rerender(<ReviewActivity {...props} {...next} />) }
  const lines = (): (string | null)[] => [...view.container.querySelectorAll('[data-forge-review-line]')].map(line => line.textContent)
  return { view, props, rerender, lines }
}

describe('activityEntries', () => {
  it('keeps the order and makes one row of every run of commits', () => {
    const comment: ChangeRequestActivityItem = { kind: 'comment', at: at(2), actor: mona, body: 'Thanks', url: null }
    const merged: ChangeRequestActivityItem = { kind: 'merged', at: at(5), actor: mona }
    const entries = activityEntries([commit('a', 'One'), commit('b', 'Two', 1), comment, commit('c', 'Three', 3), merged])
    expect(entries.map(entry => entry.kind === 'commits' ? entry.commits.map(item => item.title) : entry.item.kind))
      .toEqual([['One', 'Two'], 'comment', ['Three'], 'merged'])
    expect(activityEntries([])).toEqual([])
  })

  it('names every row apart, also two of one kind, time, and actor', () => {
    const requested = (reviewer: string): ChangeRequestActivityItem => ({ kind: 'review-requested', at: at(), actor: mona, reviewer })
    const closed: ChangeRequestActivityItem = { kind: 'closed', at: at(), actor: null }
    const keys = activityEntries([requested('lin'), requested('zhou'), requested('wang'), closed, commit('a', 'One'), closed])
      .map(entry => entry.key)
    expect(keys).toEqual([
      `review-requested:${at()}:mona`, `review-requested:${at()}:mona#1`, `review-requested:${at()}:mona#2`, `closed:${at()}:`,
      `commits:${'a'.repeat(40)}`, `closed:${at()}:#1`,
    ])
  })
})

describe('longBody', () => {
  it('cuts a comment over 400 characters or 6 lines short', () => {
    expect(longBody('x'.repeat(400))).toBe(false)
    expect(longBody('x'.repeat(401))).toBe(true)
    expect(longBody(Array.from({ length: 6 }, () => 'line').join('\n'))).toBe(false)
    expect(longBody(Array.from({ length: 7 }, () => 'line').join('\n'))).toBe(true)
  })
})

describe('ReviewActivity', () => {
  it('shows nothing for a provider that reads no activity', async () => {
    const b = await renderActivity(null)
    expect(b.view.container.innerHTML).toBe('')
    expect(b.props.read).toHaveBeenCalledWith(URL7, expect.any(AbortSignal))
  })

  it('waits for the first read, then says when there is no activity', async () => {
    const read = deferred<RemoteResult<ChangeRequestActivity | null>>()
    const b = await renderActivity(null, { read: vi.fn(() => read.promise) })
    const region = b.view.getByRole('region', { name: 'Activity' })
    expect(region.querySelector('[data-forge-review-skeleton="activity"]')).not.toBeNull()
    expect(region.textContent).toBe('Activity')
    read.settle(ok(activity([])))
    await settle()
    expect(region.querySelector('[data-forge-review-skeleton]')).toBeNull()
    expect(region.textContent).toBe('ActivityNo activity yet')
    expect(b.view.queryByRole('textbox')).toBeNull()
  })

  it('shows one commit as its title and several as one line that unfolds them', async () => {
    const b = await renderActivity(activity([
      commit('a', 'Fix the parser'), { kind: 'reopened', at: at(1), actor: mona }, commit('b', 'Add a test', 2), commit('c', 'Rename it', 3),
    ]))
    expect(b.lines()).toEqual(['Fix the parser1 h agoaaaaaaa', 'mona reopened this59 min ago', 'Commits: 257 min ago'])
    const fold = b.view.getByRole('button', { name: 'Commits: 2' })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(b.lines().slice(3)).toEqual(['Add a test58 min agobbbbbbb', 'Rename it57 min agoccccccc'])
    expect(b.view.container.querySelectorAll(`.${css.activityNested}`)).toHaveLength(2)
    fireEvent.click(fold)
    expect(b.lines()).toHaveLength(3)
  })

  it('opens the changes tab on one commit from its line, alone and in an unfolded run', async () => {
    const b = await renderActivity(activity([
      commit('a', 'Fix the parser'), { kind: 'reopened', at: at(1), actor: mona }, commit('b', 'Add a test', 2), commit('c', 'Rename it', 3),
    ]))
    fireEvent.click(b.view.getByRole('button', { name: 'Fix the parser, View in Changes' }))
    expect(b.props.onOpenCommit).toHaveBeenLastCalledWith('a'.repeat(40))
    // The line of a run only folds and unfolds it; each commit under it opens on its own.
    fireEvent.click(b.view.getByRole('button', { name: 'Commits: 2' }))
    expect(b.props.onOpenCommit).toHaveBeenCalledTimes(1)
    const nested = b.view.getByRole('button', { name: 'Rename it, View in Changes' })
    expect(nested.matches(`.${css.activityNested}`)).toBe(true)
    fireEvent.click(nested)
    expect(b.props.onOpenCommit).toHaveBeenLastCalledWith('c'.repeat(40))
    expect(b.props.onOpenChanges).not.toHaveBeenCalled()
  })

  it('shows each review decision, and opens the changes tab from a review that left inline comments', async () => {
    const review = (verdict: 'approved' | 'changes-requested' | 'commented' | 'dismissed', comments: number, body = ''): ChangeRequestActivityItem =>
      ({ kind: 'review', at: at(), actor: mona, verdict, body, comments, url: null })
    const b = await renderActivity(activity([
      review('approved', 0), review('changes-requested', 2), review('commented', 0, 'Please rename `x`'), review('dismissed', 0, '  \n'),
      { ...review('commented', 1), actor: null },
    ]))
    expect(b.lines()).toEqual([
      'mona approved these changes1 h ago', 'mona requested changes · Inline comments: 21 h agoView in Changes', 'mona reviewed1 h ago',
      'mona\'s review was dismissed1 h ago', 'Deleted account reviewed · Inline comments: 11 h agoView in Changes',
    ])
    const glyphs = [...b.view.container.querySelectorAll(`.${css.activityGlyph}`)].map(glyph => glyph.getAttribute('data-tone'))
    expect(glyphs).toEqual(['success', 'error', null, null, null])
    // Only the reviews with inline comments act.
    expect(b.view.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'mona requested changes · Inline comments: 2, View in Changes', 'Deleted account reviewed · Inline comments: 1, View in Changes',
    ])
    fireEvent.click(b.view.getByRole('button', { name: 'mona requested changes · Inline comments: 2, View in Changes' }))
    expect(b.props.onOpenChanges).toHaveBeenCalledTimes(1)
    // A review's own text shows as a card under its line; a blank one shows none.
    const cards = b.view.container.querySelectorAll('[data-forge-review-comment]')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.textContent).toBe('Mmona1 h agoPlease rename x')
  })

  it('shows a comment as a card with its author, and a long one cut short until it is expanded', async () => {
    const long = Array.from({ length: 14 }, (_value, index) => `Line ${index + 1}`).join('\n\n')
    const b = await renderActivity(activity([
      { kind: 'comment', at: at(), actor: robot, body: 'Coverage is **92%**', url: null },
      { kind: 'comment', at: at(1), actor: null, body: long, url: null },
    ]))
    const [short, cut] = [...b.view.container.querySelectorAll('[data-forge-review-comment]')] as [HTMLElement, HTMLElement]
    expect(short.textContent).toBe('Cci-botbot1 h agoCoverage is 92%')
    expect(short.querySelector('strong')?.textContent).toBe('92%')
    // The text sits in the element whose style gives compact Markdown the page's main ink, cut short or not.
    expect(short.querySelector(`.${css.activityBody} > [data-markdown-variant="compact"]`)).not.toBeNull()
    expect(within(short).queryByRole('button')).toBeNull()
    expect(cut.textContent?.startsWith('?Deleted account59 min agoLine 1')).toBe(true)
    expect(cut.querySelector(`.${css.activityBody}.${css.activityClamp} > [data-markdown-variant="compact"]`)).not.toBeNull()
    const more = within(cut).getByRole('button', { name: 'Expand' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(cut.querySelector(`.${css.activityClamp}`)).toBeNull()
    expect(cut.querySelector(`.${css.activityBody} > [data-markdown-variant="compact"]`)).not.toBeNull()
    fireEvent.click(within(cut).getByRole('button', { name: 'Collapse' }))
    expect(cut.querySelector(`.${css.activityClamp}`)).not.toBeNull()
  })

  it('words every change of state after the account it is by', async () => {
    const event = (kind: 'merged' | 'closed' | 'reopened' | 'ready-for-review' | 'converted-to-draft' | 'force-pushed' | 'auto-merge-enabled'
      | 'auto-merge-disabled'): ChangeRequestActivityItem => ({ kind, at: at(), actor: mona })
    const b = await renderActivity(activity([
      event('ready-for-review'), event('converted-to-draft'), event('force-pushed'), event('auto-merge-enabled'), event('auto-merge-disabled'),
      event('closed'), event('reopened'), event('merged'),
      { kind: 'review-requested', at: at(), actor: mona, reviewer: 'octo/core' },
      { kind: 'review-requested', at: at(), actor: mona, reviewer: null },
      { kind: 'renamed', at: at(), actor: mona, from: 'Old', to: 'New' },
      { kind: 'other', at: at(), actor: mona, text: 'changed the description' },
      { kind: 'merged', at: 'not a time', actor: null },
    ]))
    expect(b.lines()).toEqual([
      'mona marked this ready for review1 h ago', 'mona converted this to a draft1 h ago', 'mona force-pushed the branch1 h ago',
      'mona enabled auto-merge1 h ago', 'mona disabled auto-merge1 h ago', 'mona closed this1 h ago', 'mona reopened this1 h ago',
      'mona merged this1 h ago', 'mona requested a review from octo/core1 h ago', 'mona requested a review1 h ago',
      'mona changed the title from “Old” to “New”1 h ago', 'mona changed the description1 h ago', 'Deleted account merged this',
    ])
    expect(b.view.queryByRole('button')).toBeNull()
  })

  it('says when earlier activity is not listed and opens the change request for it', async () => {
    const b = await renderActivity(activity([commit('a', 'One')], { truncated: true }))
    expect(b.view.getByText('Earlier activity is not listed')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: 'Open on GitHub' }))
    expect(b.props.openLink).toHaveBeenCalledWith(URL7)
    // Once the provider left, the link names the browser.
    b.rerender({ forge: null })
    expect(b.view.getByRole('button', { name: 'Open in browser' })).toBeTruthy()
  })

  it('reports a read that failed, reads again on Retry, and keeps the rows of an earlier read', async () => {
    const read = vi.fn<ReviewActivityProps['read']>()
    read.mockResolvedValueOnce(failed('forgePanel/activity-failed', 'slow down'))
      .mockResolvedValueOnce(ok(activity([commit('a', 'One')])))
      .mockResolvedValueOnce(failed('forgePanel/activity-failed', 'down'))
    const b = await renderActivity(null, { read })
    const notice = b.view.getByRole('status')
    expect(notice.textContent).toBe('Couldn\'t read the activity: slow downRetry')
    expect(b.view.container.querySelector('[data-state="ongoing"]')).toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }))
    await settle()
    expect(b.view.queryByRole('status')).toBeNull()
    expect(b.lines()).toEqual(['One1 h agoaaaaaaa'])
    // A later read that fails keeps what the earlier one listed.
    b.rerender({ revision: 'r2' })
    await settle()
    expect(b.view.getByRole('status').textContent).toBe('Couldn\'t read the activity: downRetry')
    expect(b.lines()).toEqual(['One1 h agoaaaaaaa'])
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('reads again when the change request changed, and drops the answer of a read it no longer waits for', async () => {
    const first = deferred<RemoteResult<ChangeRequestActivity | null>>()
    const read = vi.fn<ReviewActivityProps['read']>()
    read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok(activity([commit('b', 'Two')])))
      .mockResolvedValueOnce(ok(activity([commit('c', 'Three')])))
    const b = await renderActivity(null, { read })
    b.rerender({ revision: 'r2' })
    await settle()
    expect(read.mock.calls[0]?.[1].aborted).toBe(true)
    first.settle(ok(activity([commit('a', 'One')])))
    await settle()
    expect(b.lines()).toEqual(['Two1 h agobbbbbbb'])
    // Another change request starts without the rows of this one.
    const next = deferred<RemoteResult<ChangeRequestActivity | null>>()
    read.mockReset()
    read.mockReturnValueOnce(next.promise)
    b.rerender({ url: prUrl(8), revision: 'r2' })
    await settle()
    expect(b.lines()).toEqual([])
    expect(read).toHaveBeenLastCalledWith(prUrl(8), expect.any(AbortSignal))
    next.settle(failed('forgePanel/activity-failed', 'down'))
    await settle()
    expect(b.lines()).toEqual([])
    expect(b.view.getByRole('status').textContent).toBe('Couldn\'t read the activity: downRetry')
  })

  it('adds a comment, clears the field, and reads the activity again', async () => {
    const sent = deferred<RemoteResult<void>>()
    const comment = vi.fn<ReviewActivityProps['comment']>(() => sent.promise)
    const read = vi.fn<ReviewActivityProps['read']>(async () => ok(activity([], { viewerCanComment: true })))
    const b = await renderActivity(null, { read, comment })
    const field = b.view.getByRole('textbox', { name: 'Leave a comment' }) as HTMLTextAreaElement
    const button = b.view.getByRole('button', { name: 'Comment' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(field, { target: { value: '  \n' } })
    expect(button.disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'Thanks for the fix' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(comment).toHaveBeenCalledWith(URL7, 'Thanks for the fix')
    // While the comment is sent, the field keeps its text read-only and neither the button nor the keys send another.
    expect([field.readOnly, button.disabled, button.textContent]).toEqual([true, true, 'Posting…'])
    expect(field.closest('[aria-busy="true"]')).not.toBeNull()
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    expect(comment).toHaveBeenCalledOnce()
    sent.settle(ok(undefined))
    await settle()
    expect(field.value).toBe('')
    expect([field.readOnly, button.textContent]).toEqual([false, 'Comment'])
    expect(read).toHaveBeenCalledTimes(2)
    expect(b.view.queryByRole('alert')).toBeNull()
  })

  it('says where the comment goes and which keys send it', async () => {
    const b = await renderActivity(activity([], { viewerCanComment: true }))
    const composer = b.view.getByRole('textbox', { name: 'Leave a comment' }).parentElement as HTMLElement
    expect(composer.textContent).toBe('Posts to GitHub · Markdown supportedCtrl+EnterComment')
    expect((b.view.getByRole('textbox', { name: 'Leave a comment' }) as HTMLTextAreaElement).rows).toBe(3)
    cleanup()
    // The desktop shell names an Apple platform on the document; without a provider the hint names no code host.
    document.documentElement.dataset['platform'] = 'darwin'
    try {
      const apple = await renderActivity(activity([], { viewerCanComment: true }), { forge: null })
      const field = apple.view.getByRole('textbox', { name: 'Leave a comment' })
      expect(field.parentElement?.textContent).toBe('Markdown supported⌘EnterComment')
    } finally {
      delete document.documentElement.dataset['platform']
    }
  })

  it('sends on Command or Control with Enter, and not on Enter alone, while composing, or for a blank text', async () => {
    const comment = vi.fn<ReviewActivityProps['comment']>(async () => ok(undefined))
    const b = await renderActivity(activity([], { viewerCanComment: true }), { comment })
    const field = b.view.getByRole('textbox', { name: 'Leave a comment' }) as HTMLTextAreaElement
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true })
    fireEvent.change(field, { target: { value: 'First' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true, isComposing: true })
    expect(comment).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    await settle()
    expect(comment).toHaveBeenCalledWith(URL7, 'First')
    fireEvent.change(field, { target: { value: 'Second' } })
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true })
    await settle()
    expect(comment).toHaveBeenLastCalledWith(URL7, 'Second')
  })

  it('keeps the text of a comment the host did not save and says why', async () => {
    const comment = vi.fn<ReviewActivityProps['comment']>()
    comment.mockResolvedValueOnce(failed('forgePanel/action-failed', 'refused'))
      .mockResolvedValueOnce(failed('forgePanel/action-unknown', 'no answer'))
    const read = vi.fn<ReviewActivityProps['read']>(async () => ok(activity([], { viewerCanComment: true })))
    const b = await renderActivity(null, { read, comment })
    const field = b.view.getByRole('textbox', { name: 'Leave a comment' }) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'Thanks' } })
    fireEvent.click(b.view.getByRole('button', { name: 'Comment' }))
    await settle()
    expect(b.view.getByRole('alert').textContent).toBe('The comment was not posted: refused')
    expect(field.value).toBe('Thanks')
    // An outcome the host did not confirm names where to check before another attempt.
    fireEvent.click(b.view.getByRole('button', { name: 'Comment' }))
    await settle()
    expect(b.view.getByRole('alert').textContent).toBe('The submission outcome is unknown. Check GitHub before publishing again.')
    expect(field.value).toBe('Thanks')
    expect(read).toHaveBeenCalledTimes(1)
    // Once the provider left, the page has no product name to point at.
    comment.mockResolvedValueOnce(failed('forgePanel/action-unknown', 'no answer'))
    b.rerender({ read, comment, forge: null })
    fireEvent.click(b.view.getByRole('button', { name: 'Comment' }))
    await settle()
    expect(b.view.getByRole('alert').textContent).toBe('The comment was not posted: no answer')
  })
})

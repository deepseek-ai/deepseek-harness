// @vitest-environment jsdom
/** Frozen line references, durable pending reviews, and plain-text destination actions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, within, type RenderResult } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ForgeReviewId } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeDiffFile } from '../src/types.ts'
import {
  formatReviewComment, reviewQuoteSummary, selectReviewLines, reviewMatches, settleQuote, type QuoteCopy, type ReviewSelection,
} from '../src/client/review.ts'
import { ReviewQueue } from '../src/client/review-queue.ts'
import { ReviewThread } from '../src/client/ReviewThread.tsx'
import { SubmitReview } from '../src/client/SubmitReview.tsx'
import { ReviewComposer, type ReviewActions } from '../src/client/ReviewComposer.tsx'
import { en } from '../src/client/locales.ts'
import { hostCopy } from './client-fixtures.client.ts'

const english = makeTranslate(en)
/** Copy of a view of a GitHub pull request, which names the code host and the noun. */
const t = (key: string, params?: Record<string, unknown>): string => english(key, { forge: 'GitHub', noun: 'PR', ...params })
const file: ForgeDiffFile = { path: 'a.ts', previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, layer: 'implementation', digest: 'digest', additions: 3, deletions: 2,
  hunks: [
    { oldStart: 2, oldLines: 2, newStart: 2, newLines: 3, lines: [' unchanged', '-old', '+new', '+another'] },
    { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: ['-last', '+final'] },
  ] }

const selection: ReviewSelection = { source: { kind: 'change', url: 'https://github.com/octo/demo/pull/7', headSha: 'a'.repeat(40), commits: null },
  comment: { ...selectReviewLines(file, 'R', 3, 4)!, body: '为什么新增这两行？' } }
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

/** Store comment drafts the way an earlier panel kept them in the browser, then open the queue over them. */
function drafted(...drafts: ReviewSelection[]): ReviewQueue {
  localStorage.setItem('review-test', JSON.stringify({ comments: drafts, records: [], body: '', event: 'comment', uncertain: null }))
  return new ReviewQueue('review-test')
}

const PENDING = { id: 'review-1' as ForgeReviewId, comments: 2 }

/** Open the menu of the saved comment on the fixture's lines and read the actions it offers. */
function openMenu(view: RenderResult): (string | null)[] {
  fireEvent.click(view.getByRole('button', { name: 'Actions for the comment on R3–4' }))
  return within(view.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)
}

/** Choose an action from the menu of the saved comment on the fixture's lines. */
function choose(view: RenderResult, action: string): void {
  openMenu(view)
  fireEvent.click(view.getByRole('menuitem', { name: action }))
}

describe('review references', () => {
  it('anchors added and deleted files and detects changed source or hunk content', () => {
    const added = { ...file, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }] }
    const deleted = { ...file, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-old'] }] }
    expect(selectReviewLines(added, 'R', 1, 1)?.hunk).toContain('@@ -0,0 +1,1 @@')
    expect(selectReviewLines(deleted, 'L', 1, 1)?.hunk).toContain('@@ -1,1 +0,0 @@')
    expect(reviewMatches(selection, { kind: 'local', scope: 'branch', base: 'origin/main', baseRef: null, commits: null }, file)).toBe(false)
    expect(reviewMatches(selection, { kind: 'change', url: 'x', headSha: 'b', commits: null }, file)).toBe(false)
    expect(reviewMatches(selection, selection.source, added)).toBe(false)
    expect(reviewMatches(selection, selection.source, file)).toBe(true)
  })
  it('keeps a refused comment editable and lets the user add it to the pending review without publishing', async () => {
    const queue = vi.fn<NonNullable<ReviewActions['queue']>>().mockResolvedValue('GitHub refused'), close = vi.fn(), onQuoted = vi.fn()
    const actions = { source: selection.source, addToInput: () => true, queue, reviewStarted: true, onQuoted }
    const view = render(<ReviewComposer selection={selection} actions={actions} close={close} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Add to review' }))
    expect(await view.findByRole('alert')).toHaveProperty('textContent', 'GitHub refused')
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Updated' } })
    expect(view.queryByRole('alert')).toBeNull()
    queue.mockResolvedValue(undefined)
    fireEvent.click(view.getByRole('button', { name: 'Add to review' }))
    await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce() })
    expect(queue).toHaveBeenLastCalledWith({ ...selection, comment: { ...selection.comment, body: 'Updated' } })
    fireEvent.click(view.getByRole('button', { name: 'Add to input' }))
    expect(onQuoted).toHaveBeenCalledWith({ ...selection, comment: { ...selection.comment, body: 'Updated' } })
  })
  it('contains unexpected publication failures and prevents a second write while one is pending', async () => {
    let reject: (error: Error) => void = () => {}
    const publish = vi.fn(() => new Promise<string | undefined>((_resolve, fail) => { reject = fail }))
    const view = render(<ReviewComposer selection={selection}
      actions={{ source: selection.source, addToInput: () => true, queue: async () => undefined, publish }} close={vi.fn()} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'GitHub comment options' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Publish single comment' }))
    expect(view.getByRole('button', { name: en['review.publishing'] })).toHaveProperty('disabled', true)
    expect(view.getByRole('textbox')).toHaveProperty('disabled', true)
    await act(async () => { reject(new Error('transport lost')) })
    expect(view.getByRole('alert')).toHaveProperty('textContent', hostCopy('review.unknown'))
    expect(publish).toHaveBeenCalledOnce()
  })
  it('dispatches at most once when two activations arrive in the same render batch', async () => {
    let finish: (value: undefined) => void = () => {}
    const publish = vi.fn(() => new Promise<undefined>((resolve) => { finish = resolve }))
    const view = render(<ReviewComposer selection={selection} actions={{ source: selection.source, addToInput: () => true, publish }}
      close={vi.fn()} t={t} />)
    const button = view.getByRole('button', { name: 'Publish single comment' })
    act(() => { button.click(); button.click() })
    expect(publish).toHaveBeenCalledOnce()
    await act(async () => { finish(undefined) })
  })
  it('keeps native draft edits through rerenders and updates React only when action availability changes', () => {
    const commits = vi.fn()
    const addToInput = vi.fn().mockReturnValue(true)
    const actions = { source: selection.source, addToInput }
    const empty = { ...selection, comment: { ...selection.comment, body: '' } }
    const close = vi.fn()
    const view = render(<Profiler id="comment" onRender={commits}>
      <ReviewComposer selection={empty} actions={actions} close={close} t={t} />
    </Profiler>)
    const input = view.getByRole('textbox')
    const send = view.getByRole('button', { name: 'Add to input' })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '先检查' } })
    expect(send).toHaveProperty('disabled', false)
    commits.mockClear()
    for (const value of ['先检查边界', '先检查边界\n再补测试', '先检查边界\n再补测试。']) fireEvent.change(input, { target: { value } })
    expect(commits).not.toHaveBeenCalled()
    view.rerender(<Profiler id="comment" onRender={commits}>
      <ReviewComposer selection={empty} actions={{ ...actions }} close={close} t={t} />
    </Profiler>)
    expect(input).toHaveProperty('value', '先检查边界\n再补测试。')
    fireEvent.change(input, { target: { value: ' \n' } })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '已修改的内容' } })
    fireEvent.click(send)
    expect(addToInput).toHaveBeenCalledWith({ ...selection, comment: { ...selection.comment, body: '已修改的内容' } })
  })
  it('keeps sides, reversed ranges, and the complete hunk while refusing gaps and cross-hunk selection', () => {
    expect(selectReviewLines(file, 'R', 4, 3)).toEqual({ ...selection.comment, body: '' })
    expect(selectReviewLines(file, 'L', 3, 3)?.hunk).toContain('-old\n+new')
    expect(selectReviewLines(file, 'L', 4, 4)).toBeUndefined()
    expect(selectReviewLines(file, 'R', 4, 11)).toBeUndefined()
    expect(formatReviewComment(selection, 1)).toBe(`## User Comment 1\nFile: a.ts\nSide: R\nLines: 3-4\nSource: https://github.com/octo/demo/pull/7\nCommit: ${'a'.repeat(40)}\nDiff hunk:\n\`\`\`diff\n@@ -2,2 +2,3 @@\n unchanged\n-old\n+new\n+another\n\`\`\`\nComment:\n为什么新增这两行？`)
    expect(formatReviewComment({ source: { kind: 'local', scope: 'staged', base: null, baseRef: null, commits: null }, comment: { ...selection.comment, startLine: 4, hunk: '```' } }, 2))
      .toContain('Lines: 4\nSource: Local (staged)\nDiff hunk:\n````diff\n```\n````')
    expect(formatReviewComment({ source: { kind: 'local', scope: 'branch', base: 'origin/release/2.4', baseRef: 'refs/remotes/origin/release/2.4', commits: null }, comment: selection.comment }, 3))
      .toContain('Lines: 3-4\nSource: Local (branch)\nBase: origin/release/2.4\nDiff hunk:\n')
    const one = { from: '1'.repeat(40), to: '1'.repeat(40) }
    const two = { from: '1'.repeat(40), to: '2'.repeat(40) }
    expect(formatReviewComment({ ...selection, source: { ...selection.source, commits: one } }, 4))
      .toContain(`Commit: ${'a'.repeat(40)}\nCommits: ${'1'.repeat(40)}\nDiff hunk:`)
    expect(formatReviewComment({ source: { kind: 'local', scope: 'branch', base: 'origin/main', baseRef: null, commits: two }, comment: selection.comment }, 5))
      .toContain(`Base: origin/main\nCommits: ${'1'.repeat(40)}^..${'2'.repeat(40)}\nDiff hunk:`)
  })
  it('summarizes a composer quote by file name, side and lines, and comment', () => {
    expect(reviewQuoteSummary({ ...selection.comment, path: 'src/client/a.ts' }))
      .toEqual({ label: 'a.ts R3–4', title: 'src/client/a.ts', detail: 'R3–4', body: '为什么新增这两行？' })
    expect(reviewQuoteSummary({ ...selection.comment, side: 'L', endLine: 3 })).toEqual({ label: 'a.ts L3', title: 'a.ts', detail: 'L3', body: '为什么新增这两行？' })
  })
  it('adds a quote without posting or closing when the input refuses it', () => {
    const addToInput = vi.fn<(selection: ReviewSelection) => boolean>().mockReturnValue(false)
    const close = vi.fn()
    const view = render(<ReviewComposer selection={selection} actions={{ source: selection.source, addToInput }} close={close} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Add to input' }))
    expect(addToInput).toHaveBeenCalledWith(selection)
    expect(close).not.toHaveBeenCalled()
    expect(view.getByRole('alert').textContent).toContain('cannot accept')
    expect(view.queryByRole('button', { name: 'Publish single comment' })).toBeNull()
    addToInput.mockReturnValue(true)
    fireEvent.click(view.getByRole('button', { name: 'Add to input' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('keeps the single-comment publish action inside the GitHub split menu', async () => {
    const publish = vi.fn().mockResolvedValue(undefined)
    const queue = vi.fn<NonNullable<ReviewActions['queue']>>().mockResolvedValue(undefined)
    const close = vi.fn()
    const view = render(<ReviewComposer selection={selection}
      actions={{ source: selection.source, addToInput: () => true, publish, queue }} close={close} t={t} />)
    expect(view.getByRole('button', { name: 'Start review' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Publish single comment' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'GitHub comment options' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('menu')).toBeNull()
    expect(publish).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'GitHub comment options' }))
    fireEvent.click(within(view.getByRole('menu')).getByRole('menuitem', { name: 'Publish single comment' }))
    await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce() })
    expect(publish).toHaveBeenCalledWith(selection)
    expect(queue).not.toHaveBeenCalled()
  })
  it('keeps the comment text when GitHub refuses publication', async () => {
    const close = vi.fn()
    const publish = vi.fn().mockResolvedValue('Permission denied')
    const view = render(<ReviewComposer selection={selection}
      actions={{ source: selection.source, addToInput: () => true, publish }} close={close} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Publish single comment' }))
    expect(await view.findByRole('alert')).toHaveProperty('textContent', 'Permission denied')
    expect(view.getByRole('textbox')).toHaveProperty('value', selection.comment.body)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('pending reviews', () => {
  it('edits only the chosen occurrence and refuses edits after publication or during dispatch', () => {
    const queue = drafted(selection, { ...selection, comment: { ...selection.comment, body: 'Second' } })
    const first = queue.fileComments('a.ts', selection.source).threads[0]!
    queue.editThread(first.key, null)
    expect(queue.getSnapshot().comments.map(item => item.comment.body)).toEqual(['Second'])
    expect(queue.editThread(first.key, 'Missing')).toBe(false)
    queue.begin({ kind: 'comment', headSha: 'a', comment: selection.comment })
    expect(queue.summarize('While pending', 'approve')).toBe(false)
    expect(queue.fileComments('a.ts', selection.source).locked).toBe(true)
    queue.finish(false)
    queue.published(selection, 'https://github.com/octo/demo/pull/7#comment-1')
    expect(queue.fileComments('a.ts', selection.source).threads[0]?.kind).toBe('published')
  })
  it('clears every record on close and rejects a publication receipt arriving afterwards', () => {
    const queue = drafted(selection)
    queue.recordAgent(selection)
    queue.summarize('Summary', 'request-changes')
    queue.begin({ kind: 'comment', headSha: 'a'.repeat(40), comment: selection.comment })
    expect(queue.close()).toBe(true)
    expect(localStorage.getItem('review-test')).toBeNull()
    expect(queue.published(selection, 'https://github.com/octo/demo/pull/7#comment-1')).toBe(false)
    expect(queue.finish(true)).toBe(false)
    expect(queue.recordAgent(selection)).toBe(false)
    expect(new ReviewQueue('review-test').getSnapshot()).toMatchObject({ comments: [], records: [], body: '', uncertain: null })
  })
  it('closes in memory and reports a storage removal failure', () => {
    const queue = drafted(selection)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new DOMException('Denied', 'SecurityError') })
    expect(queue.close()).toBe(false)
    expect(queue.getSnapshot().comments).toEqual([])
    expect(queue.recordAgent(selection)).toBe(false)
  })
  it('restores frozen comments and summary, persisting uncertainty before dispatch', () => {
    const queue = drafted(selection)
    const listener = vi.fn()
    const release = queue.subscribe(listener)
    queue.summarize('Check the logic', 'request-changes')
    const write = { kind: 'review' as const, headSha: 'a'.repeat(40), event: 'request-changes' as const, body: 'Check the logic', comments: [{ path: selection.comment.path, side: selection.comment.side, startLine: selection.comment.startLine, endLine: selection.comment.endLine, body: selection.comment.body }] }
    expect(queue.begin(write)).toBe(true)
    expect(new ReviewQueue('review-test').getSnapshot()).toMatchObject({ comments: [selection], uncertain: write })
    expect(queue.begin(write)).toBe(false)
    expect(queue.edit(0, 'different')).toBe(false)
    queue.finish(false)
    queue.edit(0, 'updated')
    expect(queue.getSnapshot().comments[0]?.comment.body).toBe('updated')
    queue.finish(true)
    expect(new ReviewQueue('review-test').getSnapshot().comments).toEqual([])
    release()
    expect(listener).toHaveBeenCalled()
  })
  it('restores old drafts and keeps inline identities through editing and publication', () => {
    localStorage.setItem('review-test', JSON.stringify({ comments: [selection], body: '', event: 'comment', uncertain: null }))
    const queue = new ReviewQueue('review-test')
    const first = queue.fileComments('a.ts', selection.source)
    expect(first.threads).toHaveLength(1)
    expect(queue.fileComments('unrelated.ts', selection.source).threads).toHaveLength(0)
    queue.summarize('Summary', 'comment')
    expect(queue.fileComments('a.ts', selection.source)).toBe(first)
    const key = first.threads[0]!.key
    expect(queue.editThread(key, 'Updated')).toBe(true)
    const edited = queue.fileComments('a.ts', selection.source)
    expect(edited.threads[0]).toMatchObject({ key, kind: 'pending', selection: { comment: { body: 'Updated' } } })
    queue.finish(true, 'https://github.com/octo/demo/pull/7#review-1')
    expect(queue.fileComments('a.ts', selection.source).threads[0]).toMatchObject({ key, kind: 'published' })
    expect(new ReviewQueue('review-test').fileComments('a.ts', selection.source).threads[0]).toMatchObject({ kind: 'published' })
    const local = { ...selection, source: { kind: 'local' as const, scope: 'staged', base: null, baseRef: null, commits: null } }
    expect(queue.recordAgent(local)).toBe(true)
    expect(queue.fileComments('a.ts', local.source).threads).toHaveLength(1)
    expect(queue.fileComments('a.ts', { kind: 'local', scope: 'branch', base: 'origin/main', baseRef: null, commits: null }).threads).toHaveLength(0)
    const based = { ...selection, source: { kind: 'local' as const, scope: 'branch', base: 'origin/release', baseRef: 'refs/remotes/origin/release', commits: null } }
    expect(queue.recordAgent(based)).toBe(true)
    expect(queue.fileComments('a.ts', based.source).threads).toHaveLength(1)
    expect(queue.fileComments('a.ts', { ...based.source, baseRef: null, commits: null }).threads).toHaveLength(0)
  })
  it('keeps records of chosen commits apart from the whole comparison', () => {
    const queue = new ReviewQueue('review-test')
    const commits = { from: '1'.repeat(40), to: '2'.repeat(40) }
    const chosen = { ...selection, source: { ...selection.source, commits } }
    expect(queue.recordAgent(chosen)).toBe(true)
    expect(queue.fileComments('a.ts', chosen.source).threads).toHaveLength(1)
    expect(queue.fileComments('a.ts', selection.source).threads).toHaveLength(0)
    expect(queue.fileComments('a.ts', { ...chosen.source, commits: { ...commits, to: '3'.repeat(40) } }).threads).toHaveLength(0)
    expect(queue.fileComments('a.ts', { ...chosen.source, commits: { ...commits, from: '0'.repeat(40) } }).threads).toHaveLength(0)
    expect(new ReviewQueue('review-test').fileComments('a.ts', chosen.source).threads).toHaveLength(1)
  })
  it('preserves malformed stored bytes and refuses to overwrite them', () => {
    localStorage.setItem('review-test', 'broken')
    const queue = new ReviewQueue('review-test')
    expect(queue.getSnapshot().error).toBe('load')
    expect(queue.recordAgent(selection)).toBe(false)
    expect(localStorage.getItem('review-test')).toBe('broken')
  })
  it.each([
    ['staged', null],
    ['branch', 'origin/main'],
  ])('shows a stored %s record that names no base in the comparison without a chosen branch', (scope, base) => {
    const local = { ...selection, source: { kind: 'local' as const, scope, base, baseRef: null, commits: null } }
    expect(new ReviewQueue('review-test').recordAgent(local)).toBe(true)
    const stored = JSON.parse(localStorage.getItem('review-test') ?? '') as { records: { selection: { source: Record<string, unknown> } }[] }
    for (const record of stored.records) {
      Reflect.deleteProperty(record.selection.source, 'base')
      Reflect.deleteProperty(record.selection.source, 'baseRef')
    }
    localStorage.setItem('review-test', JSON.stringify(stored))

    const reopened = new ReviewQueue('review-test')
    expect(reopened.fileComments('a.ts', local.source).threads).toHaveLength(1)
    expect(reopened.fileComments('a.ts', { ...local.source, base: 'topic', baseRef: 'refs/heads/topic', commits: null }).threads).toHaveLength(0)
  })
  it.each([
    ['the automatic start of a worktree and a local branch', { base: 'main', baseRef: null, commits: null }, { base: 'main', baseRef: 'refs/heads/main', commits: null }],
    ['a local and a remote-tracking branch', { base: 'origin/x', baseRef: 'refs/heads/origin/x', commits: null }, { base: 'origin/x', baseRef: 'refs/remotes/origin/x', commits: null }],
  ])('keeps comparisons with one name apart: %s', (_label, left, right) => {
    const source = { kind: 'local' as const, scope: 'branch' }
    const queue = new ReviewQueue('review-test')
    expect(queue.recordAgent({ ...selection, source: { ...source, ...left } })).toBe(true)

    expect(queue.fileComments('a.ts', { ...source, ...left }).threads).toHaveLength(1)
    expect(queue.fileComments('a.ts', { ...source, ...right }).threads).toHaveLength(0)
  })
  it('removes a reference or a receipt by its inline identity and puts it back where it was', () => {
    const queue = drafted(selection)
    const second = { ...selection, comment: { ...selection.comment, body: 'Second' } }
    queue.recordAgent(selection)
    queue.published(second, 'https://github.com/octo/demo/pull/7#comment-1')
    const [reference, receipt, draft] = queue.fileComments('a.ts', selection.source).threads
    const removed = queue.removeRecord(reference!.key)
    expect(removed).toEqual({ record: { kind: 'agent', selection }, index: 0 })
    expect(queue.fileComments('a.ts', selection.source).threads.map(item => item.kind)).toEqual(['published', 'pending'])
    expect(new ReviewQueue('review-test').getSnapshot().records.map(item => item.kind)).toEqual(['published'])
    expect(queue.removeRecord(reference!.key)).toBeNull()
    expect(queue.removeRecord(draft!.key)).toBeNull()
    expect(queue.getSnapshot().comments).toHaveLength(1)
    expect(queue.restoreRecord(removed!)).toBe(true)
    expect(queue.fileComments('a.ts', selection.source).threads.map(item => [item.kind, item.key]))
      .toEqual([['agent', reference!.key], ['published', receipt!.key], ['pending', draft!.key]])
    const last = queue.removeRecord(receipt!.key)
    expect(last?.index).toBe(1)
    queue.removeRecord(reference!.key)
    expect(queue.restoreRecord(last!)).toBe(true)
    expect(new ReviewQueue('review-test').getSnapshot().records.map(item => item.kind)).toEqual(['published'])
  })
  it('keeps a record whose removal the browser did not save and refuses a restoration after the tab closed', () => {
    const queue = new ReviewQueue('review-test')
    queue.recordAgent(selection)
    const key = queue.fileComments('a.ts', selection.source).threads[0]!.key
    const setter = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError') })
    expect(queue.removeRecord(key)).toBeNull()
    expect(queue.getSnapshot()).toMatchObject({ error: 'save', records: [{ kind: 'agent' }] })
    setter.mockRestore()
    const removed = queue.removeRecord(key)
    expect(removed).not.toBeNull()
    queue.close()
    expect(queue.restoreRecord(removed!)).toBe(false)
  })
  it('keeps the previous queue on quota failure and allows retry after recovery', () => {
    const queue = new ReviewQueue('review-test')
    const setter = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError') })
    expect(queue.recordAgent(selection)).toBe(false)
    expect(queue.getSnapshot()).toMatchObject({ error: 'save', records: [] })
    setter.mockRestore()
    expect(queue.recordAgent(selection)).toBe(true)
    expect(queue.getSnapshot().error).toBeNull()
  })
})

/** The quote copy of a destination other than the Session's input. */
const CHAT: QuoteCopy = { add: 'reviewPage.addToChat', added: 'reviewPage.addedToChat', failed: 'reviewPage.addToChatFailed' }

/** Let a quote that settles later settle. */
async function settled(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('settleQuote', () => {
  it('reports a quote taken or refused at once, once it settles, and a rejected one as refused', async () => {
    const done = vi.fn<(accepted: boolean) => void>()
    settleQuote(true, done)
    settleQuote(false, done)
    expect(done.mock.calls).toEqual([[true], [false]])
    settleQuote(Promise.resolve(true), done)
    settleQuote(Promise.reject(new Error('closed')), done)
    expect(done).toHaveBeenCalledTimes(2)
    await settled()
    expect(done.mock.calls.slice(2)).toEqual([[true], [false]])
  })
})

describe('quotes elsewhere than the input', () => {
  it('names the destination on the composer, closes it once the quote settles as taken, and keeps it open with the refusal', async () => {
    let answer: (accepted: boolean) => void = () => {}
    const addToInput = vi.fn((_selection: ReviewSelection) => new Promise<boolean>((resolve) => { answer = resolve }))
    const close = vi.fn(), onQuoted = vi.fn()
    const view = render(<ReviewComposer selection={selection} actions={{ source: selection.source, addToInput, quoteCopy: CHAT, onQuoted }}
      close={close} t={t} />)
    expect(view.queryByRole('button', { name: 'Add to input' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Add to chat' }))
    expect(addToInput).toHaveBeenCalledWith(selection)
    expect(close).not.toHaveBeenCalled()
    answer(false)
    await settled()
    expect(view.getByRole('alert').textContent).toBe('Couldn\'t add to chat')
    expect(close).not.toHaveBeenCalled()
    addToInput.mockRejectedValueOnce(new Error('closed'))
    fireEvent.click(view.getByRole('button', { name: 'Add to chat' }))
    await settled()
    expect(view.getByRole('alert').textContent).toBe('Couldn\'t add to chat')
    fireEvent.click(view.getByRole('button', { name: 'Add to chat' }))
    answer(true)
    await settled()
    expect(onQuoted).toHaveBeenCalledWith(selection)
    expect(close).toHaveBeenCalledOnce()
  })

  it('tags a quoted comment with its destination and reports a refused quote of it once the quote settles', async () => {
    const records = new ReviewQueue('review-test')
    expect(records.recordAgent(selection)).toBe(true)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const addToInput = vi.fn(async (_selection: ReviewSelection) => false)
    const view = render(<ReviewThread thread={thread} actions={{ records, source: selection.source, addToInput, quoteCopy: CHAT }}
      locked={false} outdated={false} t={t} />)
    expect(view.getByText('Added to chat')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Add to chat' }))
    expect(view.queryByRole('alert')).toBeNull()
    await settled()
    expect(view.getByRole('alert').textContent).toBe('Couldn\'t add to chat')
    cleanup()

    const input = render(<ReviewThread thread={thread} actions={{ records, source: selection.source, addToInput: () => true }}
      locked={false} outdated={false} t={t} />)
    expect(input.getByText(en['review.quoted'])).toBeTruthy()
  })
})

describe('inline records', () => {
  it('keeps pending edits at their code location and quotes the edited text', () => {
    const records = drafted(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const addToInput = vi.fn().mockReturnValue(false)
    const actions = { records, source: selection.source, addToInput }
    const view = render(<ReviewThread thread={thread} actions={actions} locked={false} outdated={false} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Add to input' }))
    expect(view.getByRole('alert')).toHaveProperty('textContent', en['review.inputFailed'])
    choose(view, 'Edit')
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Edited' } })
    expect(view.queryByRole('alert')).toBeNull()
    addToInput.mockReturnValue(true)
    fireEvent.click(view.getByRole('button', { name: 'Add to input' }))
    expect(addToInput).toHaveBeenLastCalledWith({ ...selection, comment: { ...selection.comment, body: 'Edited' } })
    fireEvent.click(view.getByRole('button', { name: 'Done' }))
    expect(view.queryByRole('textbox')).toBeNull()
  })
  it('asks before deleting a browser draft and keeps it when the reader cancels', () => {
    const records = drafted(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const view = render(<ReviewThread thread={thread} actions={{ source: selection.source, addToInput: () => true, records }}
      locked={false} outdated={false} t={t} />)
    expect(openMenu(view)).toEqual(['Edit', 'Delete'])
    fireEvent.click(view.getByRole('menuitem', { name: 'Delete' }))
    const question = within(view.getByRole('group', { name: en['thread.deleteConfirm'] }))
    expect(view.queryByRole('button', { name: 'Actions for the comment on R3–4' })).toBeNull()
    fireEvent.click(question.getByRole('button', { name: 'Cancel' }))
    expect(view.queryByRole('group')).toBeNull()
    expect(records.getSnapshot().comments).toHaveLength(1)
    choose(view, 'Delete')
    fireEvent.click(within(view.getByRole('group')).getByRole('button', { name: 'Delete' }))
    expect(records.getSnapshot().comments).toEqual([])
  })
  it('deletes a draft whose text the reader emptied while editing it, after the same confirmation', () => {
    const records = drafted(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const view = render(<ReviewThread thread={thread} actions={{ source: selection.source, addToInput: () => true, records }}
      locked={false} outdated={false} t={t} />)
    choose(view, 'Edit')
    fireEvent.change(view.getByRole('textbox'), { target: { value: '' } })
    expect(records.getSnapshot().comments[0]?.comment.body).toBe('')
    expect(view.getByRole('button', { name: 'Done' })).toHaveProperty('disabled', true)
    expect(openMenu(view)).toEqual(['Delete'])
    fireEvent.click(view.getByRole('menuitem', { name: 'Delete' }))
    expect(view.queryByRole('textbox')).toBeNull()
    fireEvent.click(within(view.getByRole('group', { name: en['thread.deleteConfirm'] })).getByRole('button', { name: 'Delete' }))
    expect(records.getSnapshot().comments).toEqual([])
  })
  it('preserves unsaved edits and reports failed editing, finishing, and deletion', () => {
    const records = drafted(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const actions = { source: selection.source, addToInput: () => true, records }
    const view = render(<ReviewThread thread={thread} actions={actions} locked={false} outdated t={t} />)
    choose(view, 'Edit')
    records.close()
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Not saved' } })
    expect(view.getByRole('alert')).toHaveProperty('textContent', en['review.saveFailed'])
    fireEvent.click(view.getByRole('button', { name: 'Done' }))
    expect(view.getByRole('textbox')).toHaveProperty('value', 'Not saved')
    view.unmount()
    const closed = render(<ReviewThread thread={thread} actions={actions} locked={false} outdated t={t} />)
    choose(closed, 'Delete')
    const question = within(closed.getByRole('group'))
    fireEvent.click(question.getByRole('button', { name: 'Delete' }))
    expect(question.getByRole('alert')).toHaveProperty('textContent', en['review.saveFailed'])
    fireEvent.click(question.getByRole('button', { name: 'Cancel' }))
    expect(closed.queryByRole('alert')).toBeNull()
  })
  it('keeps a browser draft as it is while a write is unsettled', () => {
    const records = drafted(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const queue = vi.fn<NonNullable<ReviewActions['queue']>>()
    const actions = { source: selection.source, addToInput: () => true, records, queue }
    const view = render(<ReviewThread thread={thread} actions={actions} locked={false} outdated={false} t={t} />)
    choose(view, 'Delete')
    view.rerender(<ReviewThread thread={thread} actions={actions} locked outdated={false} t={t} />)
    for (const button of within(view.getByRole('group')).getAllByRole('button')) expect(button).toHaveProperty('disabled', true)
    view.unmount()
    const locked = render(<ReviewThread thread={thread} actions={actions} locked outdated={false} t={t} />)
    const menu = locked.getByRole('button', { name: 'Actions for the comment on R3–4' })
    expect(menu).toHaveProperty('disabled', true)
    fireEvent.click(menu)
    expect(locked.queryByRole('menu')).toBeNull()
    expect(locked.getByRole('button', { name: 'Start review' })).toHaveProperty('disabled', true)
  })
  it('labels a browser draft and moves it into the pending review, deleting it from the browser only once the host took it', async () => {
    const records = drafted(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const queue = vi.fn<NonNullable<ReviewActions['queue']>>().mockResolvedValueOnce('GitHub refused')
    const view = render(<ReviewThread thread={thread} actions={{ source: selection.source, addToInput: () => true, records, queue }}
      locked={false} outdated={false} t={t} />)
    expect(view.getByText(en['review.browserDraft'])).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Start review' }))
    expect(view.getByRole('button', { name: en['review.publishing'] })).toHaveProperty('disabled', true)
    expect(view.getByRole('button', { name: 'Actions for the comment on R3–4' })).toHaveProperty('disabled', true)
    expect(await view.findByRole('alert')).toHaveProperty('textContent', 'GitHub refused')
    expect(records.getSnapshot().comments).toHaveLength(1)
    queue.mockRejectedValueOnce(new Error('transport lost'))
    fireEvent.click(view.getByRole('button', { name: 'Start review' }))
    await vi.waitFor(() => { expect(view.getByRole('alert').textContent).toBe(hostCopy('review.unknown')) })
    queue.mockResolvedValueOnce(undefined)
    vi.spyOn(records, 'editThread').mockReturnValueOnce(false)
    fireEvent.click(view.getByRole('button', { name: 'Start review' }))
    await vi.waitFor(() => { expect(view.getByRole('alert').textContent).toBe(en['review.saveFailed']) })
    queue.mockResolvedValueOnce(undefined)
    fireEvent.click(view.getByRole('button', { name: 'Start review' }))
    await vi.waitFor(() => { expect(records.getSnapshot().comments).toEqual([]) })
    expect(queue).toHaveBeenCalledWith(selection)
  })
  it('names the move after whether the user already has a pending review, as the comment form does', () => {
    const records = drafted(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const queue = vi.fn<NonNullable<ReviewActions['queue']>>()
    const actions = { source: selection.source, addToInput: () => true, records, queue, reviewStarted: true }
    const view = render(<ReviewThread thread={thread} actions={actions} locked={false} outdated={false} t={t} />)
    expect(view.getByRole('button', { name: 'Add to review' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Start review' })).toBeNull()
  })
  it('offers no move for an outdated browser draft, one being edited or deleted, or without a pending review destination', () => {
    const records = drafted(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const queue = vi.fn<NonNullable<ReviewActions['queue']>>()
    const outdated = render(<ReviewThread thread={thread} actions={{ source: selection.source, addToInput: () => true, records, queue }}
      locked={false} outdated t={t} />)
    expect(outdated.queryByRole('button', { name: 'Start review' })).toBeNull()
    expect(outdated.getByText(en['review.browserDraft'])).toBeTruthy()
    expect(outdated.getByText(en['review.outdated'])).toBeTruthy()
    outdated.unmount()
    const current = render(<ReviewThread thread={thread} actions={{ source: selection.source, addToInput: () => true, records, queue }}
      locked={false} outdated={false} t={t} />)
    choose(current, 'Edit')
    expect(current.queryByRole('button', { name: 'Start review' })).toBeNull()
    fireEvent.click(current.getByRole('button', { name: 'Done' }))
    choose(current, 'Delete')
    expect(current.queryByRole('button', { name: 'Start review' })).toBeNull()
    current.unmount()
    const without = render(<ReviewThread thread={thread} actions={{ source: selection.source, addToInput: () => true, records }}
      locked={false} outdated={false} t={t} />)
    expect(without.queryByRole('button', { name: 'Start review' })).toBeNull()
  })
  it('removes a reference from the view without asking and reports it so the removal can be undone', () => {
    const records = new ReviewQueue('review-test')
    records.recordAgent(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const onRemoved = vi.fn<NonNullable<ReviewActions['onRemoved']>>()
    const view = render(<ReviewThread thread={thread} actions={{ source: selection.source, addToInput: () => true, records, onRemoved }}
      locked outdated={false} t={t} />)
    expect(view.getByText(en['review.quoted'])).toBeTruthy()
    expect(view.queryByText(en['review.outdated'])).toBeNull()
    expect(view.getByRole('button', { name: 'Add to input' })).toBeTruthy()
    expect(openMenu(view)).toEqual(['Remove'])
    fireEvent.click(view.getByRole('menuitem', { name: 'Remove' }))
    expect(view.queryByRole('group')).toBeNull()
    expect(records.getSnapshot().records).toEqual([])
    expect(onRemoved).toHaveBeenCalledWith({ record: { kind: 'agent', selection }, index: 0 })
  })
  it('keeps a record and says so when its removal was not saved', () => {
    const records = new ReviewQueue('review-test')
    records.recordAgent(selection)
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const onRemoved = vi.fn<NonNullable<ReviewActions['onRemoved']>>()
    const view = render(<ReviewThread thread={thread} actions={{ source: selection.source, addToInput: () => true, records, onRemoved }}
      locked={false} outdated t={t} />)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError') })
    choose(view, 'Remove')
    expect(view.getByRole('alert')).toHaveProperty('textContent', en['review.saveFailed'])
    expect(onRemoved).not.toHaveBeenCalled()
    expect(records.getSnapshot().records).toHaveLength(1)
  })
  it('opens a published receipt, removes it from the view, and omits editing on immutable records', () => {
    const openLink = vi.fn()
    const records = new ReviewQueue('review-test')
    records.published(selection, 'https://github.com/review')
    const thread = records.fileComments('a.ts', selection.source).threads[0]!
    const view = render(<ReviewThread thread={thread} actions={{ source: selection.source, addToInput: () => true, openLink, records }}
      locked={false} outdated={false} t={t} />)
    fireEvent.click(view.getByRole('button', { name: hostCopy('review.recheck') }))
    expect(openLink).toHaveBeenCalledWith('https://github.com/review')
    expect(openMenu(view)).toEqual(['Remove'])
    fireEvent.click(view.getByRole('menuitem', { name: 'Remove' }))
    expect(records.getSnapshot().records).toEqual([])
    view.unmount()
    const unowned = render(<ReviewThread thread={{ key: 1, kind: 'published', selection, url: 'https://github.com/review' }}
      actions={{ source: selection.source, addToInput: () => true }} locked={false} outdated={false} t={t} />)
    expect(unowned.queryByRole('button', { name: hostCopy('review.recheck') })).toBeNull()
    choose(unowned, 'Remove')
    expect(unowned.getByRole('alert')).toHaveProperty('textContent', en['review.saveFailed'])
  })
  it('turns a draft published while its form is open into a receipt without the form', () => {
    const records = drafted(selection)
    const drafts = (): ReturnType<ReviewQueue['fileComments']>['threads'] => records.fileComments('a.ts', selection.source).threads
    const actions = { source: selection.source, addToInput: () => true, records }
    const view = render(<ReviewThread thread={drafts()[0]!} actions={actions} locked={false} outdated={false} t={t} />)
    choose(view, 'Edit')
    records.finish(true, 'https://github.com/octo/demo/pull/7#review-1')
    view.rerender(<ReviewThread thread={drafts()[0]!} actions={actions} locked={false} outdated={false} t={t} />)
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(openMenu(view)).toEqual(['Remove'])
  })
})

describe('submission availability', () => {
  it('explains why requesting changes needs a summary and enables submission when one is entered', () => {
    const queue = new ReviewQueue('review-test')
    const view = render(<SubmitReview queue={queue} url="https://github.com/octo/demo/pull/7" headSha={'a'.repeat(40)} pending={null} events={null} busy={false} error={null}
      submit={vi.fn()} discard={undefined} close={vi.fn()} check={vi.fn()} reconcile={vi.fn()} t={t} />)
    const button = view.getByRole('button', { name: 'Submit review' })
    const summary = view.getByRole('textbox')
    const announcement = view.getByRole('status')
    expect(announcement.textContent).toBe('')
    fireEvent.click(view.getByRole('radio', { name: 'Request changes' }))
    expect(button).toHaveProperty('disabled', true)
    expect(summary).toHaveProperty('required', true)
    expect(announcement.textContent).toBe(en['review.summaryRequired'])
    expect(view.getByText(en['review.summaryRequired']).id).toBe(summary.getAttribute('aria-describedby'))
    fireEvent.change(summary, { target: { value: '  ' } })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.change(summary, { target: { value: 'Please fix the missing check.' } })
    expect(button).toHaveProperty('disabled', false)
    fireEvent.change(summary, { target: { value: '' } })
    fireEvent.click(view.getByRole('radio', { name: 'Approve' }))
    expect(button).toHaveProperty('disabled', false)
    expect(summary).toHaveProperty('required', false)
    expect(announcement.textContent).toBe('')
    expect(view.getByRole('status')).toBe(announcement)
  })

  it.each([
    [['comment', 'approve'] as const],
    [['approve'] as const],
  ])('blocks a decision outside %j and explains no limit beyond comment-only', (events) => {
    const queue = new ReviewQueue('review-test')
    queue.summarize('Please fix the missing check.', 'request-changes')
    const view = render(<SubmitReview queue={queue} url="https://github.com/octo/demo/pull/7" headSha={'a'.repeat(40)} pending={null} events={events}
      busy={false} error={null} submit={vi.fn()} discard={undefined} close={vi.fn()} check={vi.fn()} reconcile={vi.fn()} t={t} />)
    const button = view.getByRole('button', { name: 'Submit review' })
    expect(view.getByRole('radio', { name: 'Request changes' })).toHaveProperty('disabled', true)
    expect(view.getByRole('radio', { name: 'Comment' })).toHaveProperty('disabled', !events.includes('comment' as never))
    expect(button).toHaveProperty('disabled', true)
    expect(view.container.textContent).not.toContain('lets you comment on this')
    fireEvent.click(view.getByRole('radio', { name: 'Approve' }))
    expect(button).toHaveProperty('disabled', false)
  })

  it.each(['local', 'different-pr', 'different-head', 'empty-comment', 'load', 'save'] as const)('blocks %s and retains the review in the modal', (kind) => {
    const source = kind === 'different-pr' ? { kind: 'change' as const, url: 'other', headSha: 'a'.repeat(40), commits: null }
      : kind === 'different-head' ? { kind: 'change' as const, url: 'https://github.com/octo/demo/pull/7', headSha: 'b', commits: null } : selection.source
    const queue = drafted({ ...selection, source, comment: { ...selection.comment, body: kind === 'empty-comment' ? '' : 'Text' } })
    if (kind === 'load') localStorage.setItem('review-test', 'invalid')
    const opened = kind === 'load' ? new ReviewQueue('review-test') : queue
    if (kind === 'save') {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
      queue.summarize('Summary', 'comment')
    }
    if (kind === 'local') vi.spyOn(queue, 'getSnapshot').mockReturnValue({ ...queue.getSnapshot(), comments: [{ ...selection, source: { kind: 'local', scope: 'branch', base: 'origin/main', baseRef: null, commits: null } }] })
    const view = render(<SubmitReview queue={opened} url="https://github.com/octo/demo/pull/7" headSha={'a'.repeat(40)} pending={null} events={null} busy={false} error={null}
      submit={vi.fn()} discard={undefined} close={vi.fn()} check={vi.fn()} reconcile={vi.fn()} t={t} />)
    expect(view.getByRole('button', { name: 'Submit review' })).toHaveProperty('disabled', true)
  })
})

describe('pending review submission', () => {
  function dialog(
    queue: ReviewQueue, props: { readonly busy?: boolean; readonly discard?: () => void; readonly submit?: () => void } = {},
  ) {
    return render(<SubmitReview queue={queue} url="https://github.com/octo/demo/pull/7" headSha={'a'.repeat(40)} pending={PENDING} events={null}
      busy={props.busy ?? false} error={null} submit={props.submit ?? vi.fn()} discard={props.discard ?? vi.fn()}
      close={vi.fn()} check={vi.fn()} reconcile={vi.fn()} t={t} />)
  }
  it('counts the comments of the pending review and submits it with only a summary-free comment decision', () => {
    const submit = vi.fn()
    const view = dialog(new ReviewQueue('review-test'), { submit })
    expect(view.getByText('Pending comments (2)')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Submit review' }))
    expect(submit).toHaveBeenCalledOnce()
  })
  it('refuses an empty comment review when the pending review holds no comments', () => {
    const view = render(<SubmitReview queue={new ReviewQueue('review-test')} url="https://github.com/octo/demo/pull/7" headSha={'a'.repeat(40)}
      pending={{ ...PENDING, comments: 0 }} events={null} busy={false} error={null} submit={vi.fn()} discard={vi.fn()}
      close={vi.fn()} check={vi.fn()}
      reconcile={vi.fn()} t={t} />)
    expect(view.getByRole('button', { name: 'Submit review' })).toHaveProperty('disabled', true)
    fireEvent.click(view.getByRole('radio', { name: 'Approve' }))
    expect(view.getByRole('button', { name: 'Submit review' })).toHaveProperty('disabled', false)
  })
  it('blocks submission while browser drafts exist beside the pending review, even drafts from another head', () => {
    const view = dialog(drafted({ ...selection, source: { kind: 'change', url: 'https://github.com/octo/demo/pull/7', headSha: 'b'.repeat(40), commits: null } }))
    expect(view.getByRole('alert').textContent).toBe(t('review.browserDrafts', { count: '1' }))
    expect(view.getByRole('button', { name: 'Submit review' })).toHaveProperty('disabled', true)
  })
  it('asks before discarding the pending review and lets the reader keep it', () => {
    const discard = vi.fn()
    const view = dialog(new ReviewQueue('review-test'), { discard })
    fireEvent.click(view.getByRole('button', { name: 'Discard review' }))
    const confirm = within(view.getByRole('group', { name: 'Discard review' }))
    expect(confirm.getByText(t('review.discardConfirm', { count: '2' }))).toBeTruthy()
    expect(view.getAllByRole('button', { name: 'Discard review' }).at(-1)).toHaveProperty('disabled', true)
    expect(view.getAllByRole('button', { name: 'Submit review' }).at(-1)).toHaveProperty('disabled', true)
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }))
    expect(view.queryByRole('group', { name: 'Discard review' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Discard review' }))
    fireEvent.click(within(view.getByRole('group', { name: 'Discard review' })).getByRole('button', { name: 'Discard review' }))
    expect(discard).toHaveBeenCalledOnce()
  })
  it('names a running discard and keeps its confirmation locked', () => {
    const view = dialog(new ReviewQueue('review-test'), { busy: true })
    expect(view.getByRole('button', { name: 'Submitting…' })).toHaveProperty('disabled', true)
    const discard = view.getByRole('button', { name: 'Discard review' })
    expect(discard).toHaveProperty('disabled', true)
    view.rerender(<SubmitReview queue={new ReviewQueue('review-test')} url="https://github.com/octo/demo/pull/7" headSha={'a'.repeat(40)}
      pending={PENDING} events={null} busy={false} error={null} submit={vi.fn()} discard={vi.fn()}
      close={vi.fn()} check={vi.fn()} reconcile={vi.fn()}
      t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Discard review' }))
    view.rerender(<SubmitReview queue={new ReviewQueue('review-test')} url="https://github.com/octo/demo/pull/7" headSha={'a'.repeat(40)}
      pending={PENDING} events={null} busy error={null} submit={vi.fn()} discard={vi.fn()}
      close={vi.fn()} check={vi.fn()} reconcile={vi.fn()} t={t} />)
    const confirm = within(view.getByRole('group', { name: 'Discard review' }))
    expect(confirm.getByRole('button', { name: 'Discarding…' })).toHaveProperty('disabled', true)
    expect(confirm.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true)
    expect(view.getByRole('button', { name: 'Submit review' })).toHaveProperty('disabled', true)
  })
  it('lets the reader only comment where the code host allows only comments, keeping a stored decision until Comment is chosen', () => {
    const queue = new ReviewQueue('review-test')
    queue.summarize('Looks done', 'approve')
    const view = render(<SubmitReview queue={queue} url="https://github.com/octo/demo/pull/7" headSha={'a'.repeat(40)}
      pending={PENDING} events={['comment']} busy={false} error={null} submit={vi.fn()} discard={vi.fn()} close={vi.fn()} check={vi.fn()}
      reconcile={vi.fn()} t={t} />)
    expect(view.getByText('GitHub lets you comment on this PR, but not approve it or request changes.')).toBeTruthy()
    expect(view.getByRole('radio', { name: 'Approve' })).toHaveProperty('disabled', true)
    expect(view.getByRole('radio', { name: 'Request changes' })).toHaveProperty('disabled', true)
    expect(view.getByRole('button', { name: 'Submit review' })).toHaveProperty('disabled', true)
    fireEvent.click(view.getByRole('radio', { name: 'Comment' }))
    expect(view.getByRole('button', { name: 'Submit review' })).toHaveProperty('disabled', false)
  })
})

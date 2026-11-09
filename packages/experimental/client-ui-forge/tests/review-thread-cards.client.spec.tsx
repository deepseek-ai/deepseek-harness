// @vitest-environment jsdom
/** Host review thread cards, the outdated section, and the thread list rendered on their own. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ForgeReviewThread, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { en } from '../src/client/locales.ts'
import { Avatar, OutdatedThreads, ThreadCard, type ThreadActions } from '../src/client/ReviewThreads.tsx'
import { ThreadList, type ThreadListProps } from '../src/client/ThreadList.tsx'
import { diffFile, reviewComment, reviewThread } from './thread-fixtures.client.ts'

const t = makeTranslate(en)
const OLD = 'b'.repeat(40)
const scrolled = vi.fn()

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrolled })
})

afterEach(() => {
  cleanup()
  scrolled.mockReset()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

function actions(overrides: Partial<ThreadActions> = {}): ThreadActions {
  return {
    author: 'octo', focused: null,
    addToInput: vi.fn(() => true), openLink: vi.fn(), readText: vi.fn(async (): Promise<RemoteResult<string>> => ({ ok: true, value: 'a\nb\nc' })),
    inputFailed: vi.fn(),
    ...overrides,
  }
}

const outdated = (overrides: Partial<ForgeReviewThread> = {}): ForgeReviewThread => reviewThread({
  id: 'old' as ForgeThreadId, current: null, original: { commit: OLD, startLine: 2, endLine: 3 }, diffHunk: '@@ -1 +1,3 @@\n a\n+b\n+c', ...overrides,
})

describe('Avatar', () => {
  it('shows the image, or the login\'s first letter when there is none or it fails, or a mark for a deleted account', () => {
    const view = render(<><Avatar author={{ login: 'octo', avatarUrl: 'https://avatars.example/u/1', bot: false }} />
      <Avatar author={{ login: 'lin', avatarUrl: null, bot: false }} /><Avatar author={null} size={24} /></>)
    const image = view.container.querySelector('img')!
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    fireEvent.error(image)
    expect([...view.container.querySelectorAll('span')].map(span => span.textContent)).toEqual(['O', 'L', '?'])
  })
})

describe('ThreadCard', () => {
  it('shows each comment with its author, time, role tags, and Markdown without raw HTML', () => {
    const thread = reviewThread({ comments: [
      reviewComment({ author: { login: 'octo', avatarUrl: null, bot: false }, body: '**bold** <b>raw</b><!-- hidden -->', createdAt: 'not a time' }),
      reviewComment({ author: { login: 'ci', avatarUrl: null, bot: true }, pending: true }),
      reviewComment({ author: null }),
    ] })
    const view = render(<ThreadCard thread={thread} place={{ kind: 'line', side: 'R', startLine: 3, endLine: 3 }} actions={actions()} split t={t} />)
    const card = view.container.querySelector('[data-forge-thread]')!
    expect(card.getAttribute('data-split')).toBe('')
    expect(card.querySelector('strong')?.textContent).toBe('bold')
    expect(card.textContent).not.toContain('<b>')
    expect(card.textContent).not.toContain('hidden')
    expect(within(card as HTMLElement).getByText('not a time')).toBeDefined()
    expect(card.querySelectorAll('[data-forge-thread-comment]')).toHaveLength(3)
    expect(within(card as HTMLElement).getAllByText(en['thread.author'])).toHaveLength(1)
    expect(within(card as HTMLElement).getByText(en['thread.bot'])).toBeDefined()
    expect(within(card as HTMLElement).getByText(en['review.pending'])).toBeDefined()
    expect(within(card as HTMLElement).getByText(en['thread.deletedAuthor'])).toBeDefined()
  })

  it('quotes the thread, reports a refused quote, and opens its page', () => {
    const shared = actions({ addToInput: vi.fn(() => false) })
    const thread = reviewThread()
    const view = render(<ThreadCard thread={thread} place={{ kind: 'line', side: 'R', startLine: 3, endLine: 3 }} actions={shared} t={t} />)
    fireEvent.click(view.getByRole('button', { name: en['review.addToInput'] }))
    expect(shared.addToInput).toHaveBeenCalledWith(thread, 'R3')
    expect(shared.inputFailed).toHaveBeenCalledOnce()
    fireEvent.click(view.getByRole('button', { name: en['thread.openOnHost'] }))
    expect(shared.openLink).toHaveBeenCalledWith(thread.comments[0]?.url)
  })

  it('names a file thread and offers no page without one', () => {
    const view = render(<ThreadCard thread={reviewThread({ subject: 'file', current: null, original: null, comments: [reviewComment({ url: null })] })}
      place={{ kind: 'file' }} actions={actions()} t={t} />)
    expect(view.getByRole('region', { name: en['thread.fileLevel'] }).textContent).toContain(en['thread.fileLevel'])
    expect(view.queryByRole('button', { name: en['thread.openOnHost'] })).toBeNull()
  })

  it('folds a resolved thread into one row until unfolded or jumped to, and folds it again after a jump', () => {
    const thread = reviewThread({ resolved: true, comments: [] })
    const place = { kind: 'line', side: 'R', startLine: 3, endLine: 3 } as const
    const view = render(<ThreadCard thread={thread} place={place} actions={actions()} t={t} />)
    expect(view.container.textContent).toContain('Resolved thread · Deleted account')
    fireEvent.click(view.getByRole('button', { name: en['thread.expand'] }))
    expect(view.getByRole('region', { name: 'R3' })).toBeDefined()
    fireEvent.click(view.getByRole('button', { name: en['thread.collapse'] }))
    expect(view.queryByRole('region')).toBeNull()
    view.rerender(<ThreadCard thread={thread} place={place} actions={actions({ focused: { id: thread.id, revision: 1 } })} t={t} />)
    expect(view.getByRole('region', { name: 'R3' })).toBeDefined()
    fireEvent.click(view.getByRole('button', { name: en['thread.collapse'] }))
    expect(view.queryByRole('region')).toBeNull()
    view.rerender(<ThreadCard thread={thread} place={place} actions={actions({ focused: { id: thread.id, revision: 2 } })} t={t} />)
    expect(view.getByRole('region', { name: 'R3' })).toBeDefined()
  })

  it('shows an outdated thread at its original lines with the end of its hunk and the file at that commit', async () => {
    let answer: (value: RemoteResult<string>) => void = () => {}
    const shared = actions({ readText: vi.fn(() => new Promise<RemoteResult<string>>((resolve) => { answer = resolve })) })
    const view = render(<ThreadCard thread={outdated()} place={{ kind: 'outdated' }} actions={shared} t={t} />)
    const card = view.getByRole('region', { name: 'Originally R2–3' })
    expect(card.textContent).toContain(`Originally R2–3 · on ${OLD.slice(0, 7)}`)
    expect([...card.querySelectorAll('[class*="excerptLine"]')].map(line => line.textContent)).toEqual(['@@ -1 +1,3 @@', ' a', '+b', '+c'])
    // The quote names the lines the thread was written on, as the card does.
    fireEvent.click(view.getByRole('button', { name: en['review.addToInput'] }))
    expect(shared.addToInput).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }), 'R2–3')
    fireEvent.click(view.getByRole('button', { name: en['thread.viewOriginal'] }))
    expect(shared.readText).toHaveBeenCalledWith(OLD, 'src/a.ts')
    expect(view.getByText(en['thread.originalLoading'])).toBeDefined()
    await act(async () => { answer({ ok: true, value: 'one\ntwo\nthree\nfour' }) })
    const file = view.getByRole('region', { name: en['thread.viewOriginal'] })
    expect([...file.querySelectorAll('[class*="marked"]')].map(line => line.textContent)).toEqual(['2two', '3three'])
    expect(scrolled.mock.contexts).toContain(file.querySelectorAll('[class*="marked"]')[0])
    fireEvent.click(view.getByRole('button', { name: en['thread.hideOriginal'] }))
    expect(view.queryByRole('region', { name: en['thread.viewOriginal'] })).toBeNull()
    const failing = { ...shared, readText: vi.fn(async (): Promise<RemoteResult<string>> => ({ ok: false, error: new RemoteError('forgePanel/diff-failed', 'gone', {}) })) }
    view.rerender(<ThreadCard thread={outdated()} place={{ kind: 'outdated' }} actions={failing} t={t} />)
    fireEvent.click(view.getByRole('button', { name: en['thread.viewOriginal'] }))
    await act(async () => { await Promise.resolve() })
    expect(view.getByRole('alert').textContent).toBe('Could not read the file at that commit: gone')
  })

  it('offers no file at that commit for an old-side thread and no excerpt without a recorded hunk', () => {
    const view = render(<ThreadCard thread={outdated({ side: 'L', diffHunk: null })} place={{ kind: 'outdated' }} actions={actions()} t={t} />)
    expect(view.queryByRole('button', { name: en['thread.viewOriginal'] })).toBeNull()
    expect(view.container.querySelector('[class*="excerpt"]')).toBeNull()
  })
})

describe('OutdatedThreads', () => {
  it('renders nothing without threads, folds on request, and opens again for a later jump to one of its threads', () => {
    const empty = render(<OutdatedThreads threads={[]} actions={actions()} t={t} />)
    expect(empty.container.textContent).toBe('')
    cleanup()
    const view = render(<OutdatedThreads threads={[outdated()]} actions={actions()} t={t} />)
    expect(view.container.textContent).toContain('1 outdated threads')
    fireEvent.click(view.getByRole('button', { name: en['thread.collapse'] }))
    expect(view.container.querySelector('[data-forge-thread]')).toBeNull()
    view.rerender(<OutdatedThreads threads={[outdated()]} actions={actions({ focused: { id: 'elsewhere' as ForgeThreadId, revision: 1 } })} t={t} />)
    expect(view.container.querySelector('[data-forge-thread]')).toBeNull()
    view.rerender(<OutdatedThreads threads={[outdated()]} actions={actions({ focused: { id: 'old' as ForgeThreadId, revision: 2 } })} t={t} />)
    expect(view.container.querySelector('[data-forge-thread]')).not.toBeNull()
    fireEvent.click(view.getByRole('button', { name: en['thread.collapse'] }))
    expect(view.container.querySelector('[data-forge-thread]')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: en['thread.expand'] }))
    expect(view.container.querySelector('[data-forge-thread]')).not.toBeNull()
  })
})

describe('ThreadList', () => {
  function list(overrides: Partial<ThreadListProps> = {}) {
    const props: ThreadListProps = {
      entries: [], files: [], truncated: false, url: 'https://github.com/octo/demo/pull/7', filter: 'all', claim: false,
      claimed: vi.fn(), choose: vi.fn(), open: vi.fn(), openLink: vi.fn(), close: vi.fn(), t, ...overrides,
    }
    return { props, view: render(<ThreadList {...props} />) }
  }

  it('says when there are no threads and when none pass the filter, with only the host link below them', () => {
    expect(list().view.getByText(en['thread.empty'])).toBeDefined()
    cleanup()
    const { view } = list({ entries: [{ thread: reviewThread(), place: { kind: 'line', side: 'R', startLine: 3, endLine: 3 } }], filter: 'resolved' })
    expect(view.getByText(en['thread.none'])).toBeDefined()
    expect(view.getByRole('button', { name: en['thread.openAll'] }).parentElement?.textContent).toBe(en['thread.openAll'])
  })

  it('orders each file\'s threads from file threads to lines to outdated ones and describes each', () => {
    const entries = [
      { thread: outdated({ id: 'gone' as ForgeThreadId, comments: [reviewComment(), reviewComment()] }), place: { kind: 'outdated' } as const },
      { thread: reviewThread({ id: 'late' as ForgeThreadId }), place: { kind: 'line', side: 'R', startLine: 9, endLine: 9 } as const },
      { thread: reviewThread({ id: 'away' as ForgeThreadId, current: null, original: null }), place: { kind: 'elsewhere' } as const },
      { thread: reviewThread({ id: 'whole' as ForgeThreadId, subject: 'file', current: null, original: null }), place: { kind: 'file' } as const },
      { thread: reviewThread({ id: 'early' as ForgeThreadId, comments: [reviewComment({
        body: '# Title\n> **Note** `code` [link](https://example.test) <sub>x</sub>', author: { login: 'ci', avatarUrl: null, bot: true } })] }),
      place: { kind: 'line', side: 'L', startLine: 2, endLine: 4 } as const },
    ]
    const { view, props } = list({ entries })
    const items = [...view.container.querySelectorAll('[data-forge-thread-item]')]
    expect(items.map(item => item.getAttribute('data-forge-thread-item'))).toEqual(['whole', 'early', 'late', 'gone', 'away'])
    expect(items.map(item => item.querySelector('[class*="meta"]')?.textContent)).toEqual([
      en['thread.fileLevel'], 'L2–4', 'R9', `Originally R2–3 · on ${OLD.slice(0, 7)} · 1 replies`, '',
    ])
    expect(items[1]?.querySelector('[class*="excerpt"]')?.textContent).toBe('Title Note code link x')
    expect(items[1]?.textContent).toContain(en['thread.bot'])
    expect(items[3]?.textContent).toContain(en['thread.outdatedTag'])
    expect(items[4]?.textContent).toContain(en['thread.elsewhereTag'])
    fireEvent.click(items[3]!)
    expect(props.open).toHaveBeenCalledWith(entries[0], false)
    fireEvent.click(view.getByRole('radio', { name: /^Unresolved/ }))
    expect(props.choose).toHaveBeenCalledWith('unresolved')
    fireEvent.click(view.getByRole('button', { name: en['thread.close'] }))
    expect(props.close).toHaveBeenCalledOnce()
  })

  it('groups threads by file in file order, orders them by row, and moves the filter with arrow keys', () => {
    const at = (id: string, path: string, side: 'L' | 'R', line: number) => ({ thread: reviewThread({ id: id as ForgeThreadId, path }),
      place: { kind: 'line', side, startLine: line, endLine: line } as const })
    const empty = { thread: reviewThread({ path: 'c.ts', comments: [] }), place: { kind: 'file' } as const }
    // In b.ts the added R2 row follows the deleted L2 row, and L9 sits in the unchanged lines after the hunk.
    const files = [diffFile('b.ts', [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+B'] }])]
    const { view, props } = list({ entries: [empty, at('late', 'b.ts', 'L', 9), at('added', 'b.ts', 'R', 2), at('other', 'a.ts', 'R', 3),
      at('deleted', 'b.ts', 'L', 2)], files, filter: 'unresolved' })
    expect([...view.container.querySelectorAll('[data-forge-thread-group]')].map(group => group.getAttribute('data-forge-thread-group')))
      .toEqual(['b.ts', 'a.ts', 'c.ts'])
    expect([...view.container.querySelectorAll('[data-forge-thread-group="b.ts"] [data-forge-thread-item]')].map(item => item.getAttribute('data-forge-thread-item')))
      .toEqual(['deleted', 'added', 'late'])
    expect(view.container.querySelector('[data-forge-thread-group="c.ts"] [class*="excerpt"]')?.textContent).toBe('')
    fireEvent.keyDown(view.getByRole('radio', { name: /^Unresolved/ }), { key: 'ArrowRight' })
    expect(props.choose).toHaveBeenCalledWith('resolved')
  })
})

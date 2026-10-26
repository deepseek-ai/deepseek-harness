// @vitest-environment jsdom
/** One change request card: state glyph, title link, collapsed summary, read notices, and expanded details and actions. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ForgeFailure, MergeRequest } from '@deepseek-ai/dsh-experimental-forge/types'
import { ChangeRequestCard, type ChangeRequestActions } from '../src/client/ChangeRequestCard.tsx'
import { en } from '../src/client/locales.ts'
import css from '../src/client/ForgeTab.module.css'
import type { ForgePanelChangeRequest } from '../src/types.ts'
import { check, entry, snapshot, unserved } from './client-fixtures.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const NOW = Date.parse('2026-10-09T12:00:00Z')
/** Minus sign (U+2212) the diff size puts before the deleted line count. */
const MINUS = '−'

/** Render one card inside its list, with every action recorded unless `actions` replaces it. */
function card(value: ForgePanelChangeRequest, options: { expanded?: boolean; actions?: Partial<ChangeRequestActions> } = {}) {
  const openLink = vi.fn<(url: string) => void>()
  const copyLink = vi.fn<(url: string) => void>()
  const retry = vi.fn<() => void>()
  const remove = vi.fn<(entry: ForgePanelChangeRequest) => void>()
  const onToggle = vi.fn<() => void>()
  const actions: ChangeRequestActions = { openLink, copyLink, retry, remove, ...options.actions }
  const view = render(
    <ul>
      <ChangeRequestCard locale="en" entry={value} expanded={options.expanded ?? false} onToggle={onToggle} now={NOW} actions={actions} t={t} />
    </ul>,
  )
  const item = view.container.querySelector('[data-forge-change]')
  const head = item?.querySelector(`.${css.changeHead}`)
  if (!(item instanceof HTMLElement) || !(head instanceof HTMLElement)) throw new Error('no change request card')
  /** The number and status line below the title, or null when it names neither. */
  const meta = (): HTMLElement | null => head.querySelector(`.${css.meta}`)
  return { view, item, head, meta, title: within(head).getByRole('link'), openLink, copyLink, retry, remove, onToggle }
}

/** The number and status line of a card that has one. */
function metaOf(b: ReturnType<typeof card>): HTMLElement {
  const meta = b.meta()
  if (meta === null) throw new Error('no number or status line')
  return meta
}

/** The value a details row shows next to its label. */
function rowValue(item: HTMLElement, label: string): HTMLElement {
  const value = within(item).getByText(label).nextElementSibling
  if (!(value instanceof HTMLElement)) throw new Error(`no value next to ${label}`)
  return value
}

/** Outcome, name, time, and whether it opens a link, of each check the open checks list shows, in display order. */
function checkRows(): string[] {
  return screen.queryAllByRole('menuitem').map((row) => {
    const [name, time] = row.querySelector(`.${css.checkItem}`)?.children ?? []
    const state = row.querySelector('[data-forge-check]')?.getAttribute('data-forge-check') ?? ''
    return [state, name?.textContent, time?.textContent, row.hasAttribute('disabled') ? 'no link' : 'link'].join('|')
  })
}

describe('ChangeRequestCard head', () => {
  it('names the state of each change request with a tinted glyph', () => {
    const cases = [
      [{ state: 'open', draft: false }, 'open', en['change.state.open']],
      [{ state: 'open', draft: false, checksRollup: 'failure' }, 'blocked', en['change.state.blocked']],
      [{ state: 'open', draft: true }, 'draft', en['change.state.draft']],
      [{ state: 'open', draft: true, checksRollup: 'failure' }, 'draft', en['change.state.draft']],
      [{ state: 'merged' }, 'merged', en['change.state.merged']],
      [{ state: 'closed' }, 'closed', en['change.state.closed']],
    ] as const
    for (const [overrides, tone, state] of cases) {
      const glyph = card(entry(7, snapshot(7, overrides))).head.querySelector('[data-forge-glyph]')
      expect(glyph?.getAttribute('data-tone')).toBe(tone)
      expect(glyph?.getAttribute('aria-label')).toBe(`Change request state: ${state}`)
      expect(glyph?.matches(`.${css.tinted}`)).toBe(true)
      cleanup()
    }
  })

  it('gives a change request without a snapshot the unknown state', () => {
    const glyph = card(unserved('https://gitlab.example/group/app/-/merge_requests/3')).head.querySelector('[data-forge-glyph]')
    expect(glyph?.getAttribute('data-tone')).toBe('unknown')
    expect(glyph?.getAttribute('aria-label')).toBe(`Change request state: ${en['change.state.unknown']}`)
  })

  it('opens the snapshot URL from the title instead of following the link in the page', () => {
    const b = card(entry(7, snapshot(7, { url: 'https://github.com/octo/demo/pull/7#web' })))
    expect(b.title.textContent).toBe('Change 7')
    expect(b.title.getAttribute('href')).toBe('https://github.com/octo/demo/pull/7#web')
    expect(fireEvent.click(b.title)).toBe(false)
    expect(b.openLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7#web')
    expect(b.onToggle).not.toHaveBeenCalled()
  })

  it('toggles from the chevron, while the number line stays plain text', () => {
    const b = card(entry(7, snapshot(7)))
    expect(b.item.hasAttribute('data-expanded')).toBe(false)
    expect(metaOf(b).closest('button')).toBeNull()
    const chevron = within(b.head).getByRole('button', { name: 'Expand #7' })
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chevron)
    expect(b.onToggle).toHaveBeenCalledOnce()
  })
})

describe('collapsed ChangeRequestCard', () => {
  it('summarizes an open change request by its number and checks beside its header actions, without its rows', () => {
    const b = card(entry(7, snapshot(7)))
    const meta = metaOf(b)
    expect(within(meta).getByText('#7')).toBeTruthy()
    expect(within(meta).getByText('·')).toBeTruthy()
    expect(within(meta).getByText(en['change.ci.passed']).querySelector('[data-forge-check]')?.getAttribute('data-forge-check')).toBe('success')
    expect(meta.querySelector('[data-flag]')).toBeNull()
    expect(within(b.item).queryByText(en['change.row.changes'])).toBeNull()
    expect(within(b.item).queryByText('+12')).toBeNull()
    fireEvent.click(within(b.head).getByRole('button', { name: en['change.view'] }))
    fireEvent.click(within(b.head).getByRole('button', { name: en['change.copy'] }))
    fireEvent.click(within(b.head).getByRole('button', { name: 'Remove #7 from this Session' }))
    expect(b.openLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7')
    expect(b.copyLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7')
    expect(b.remove).toHaveBeenCalledOnce()
  })

  it.each([
    ['no checks', { checksRollup: 'none' }, en['change.ci.none'], undefined, null],
    ['running checks', { checksRollup: 'pending' }, en['change.ci.running'], 'pending', null],
    ['listed failed checks', {
      checksRollup: 'failure',
      checks: [check('lint', { state: 'failure' }), check('test'), check('types', { state: 'failure' })],
    }, '2 checks failed', 'failure', 'error'],
    ['failed checks the host did not list', { checksRollup: 'failure', checksTruncated: true }, en['change.ci.failedUnlisted'], 'failure', 'error'],
  ] as const)('states %s', (_label, overrides, text, glyph, tone) => {
    const ci = within(metaOf(card(entry(1, snapshot(1, overrides))))).getByText(text)
    expect(ci.querySelector('[data-forge-check]')?.getAttribute('data-forge-check')).toBe(glyph)
    expect(ci.getAttribute('data-tone')).toBe(tone)
  })

  it.each([
    ['requested changes', { reviewDecision: 'changes-requested', mergeability: 'conflicting' }, 'changesRequested', en['change.flag.changesRequested']],
    ['merge conflicts', { mergeability: 'conflicting', draft: true }, 'conflicting', en['change.flag.conflicting']],
    ['draft state', { draft: true }, 'draft', en['change.flag.draft']],
  ] as const)('flags %s after the checks', (_label, overrides, flag, text) => {
    const meta = metaOf(card(entry(1, snapshot(1, overrides))))
    expect(meta.querySelector('[data-flag]')?.getAttribute('data-flag')).toBe(flag)
    expect(within(meta).getByText(text)).toBeTruthy()
  })

  it.each([
    ['merged three hours ago', { state: 'merged', closedAt: '2026-10-09T09:00:00Z' }, 'merged', 'Merged into main · 3 h ago'],
    ['closed without a close time', { state: 'closed' }, 'closed', en['change.state.closed']],
    ['closed at a time that does not parse', { state: 'closed', closedAt: 'last week' }, 'closed', en['change.state.closed']],
  ] as const)('states a change request %s instead of its checks', (_label, overrides, tone, text) => {
    const meta = metaOf(card(entry(1, snapshot(1, { ...overrides, checksRollup: 'failure', reviewDecision: 'changes-requested' }))))
    expect(within(meta).getByText(text).getAttribute('data-tone')).toBe(tone)
    expect(within(meta).queryByText(en['change.ci.failedUnlisted'])).toBeNull()
    expect(meta.querySelector('[data-flag]')).toBeNull()
  })

  it('names the URL and the number of a change request with a spinner before its first poll', () => {
    const b = card(entry(1, null))
    expect(b.title.textContent).toBe('github.com/octo/demo/pull/1')
    expect(b.title.getAttribute('href')).toBe('https://github.com/octo/demo/pull/1')
    const meta = metaOf(b)
    expect(within(meta).getByText('#1')).toBeTruthy()
    expect(within(meta).getByText('·')).toBeTruthy()
    expect(meta.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(b.item.querySelector(`.${css.notice}`)).toBeNull()
  })

  it.each([
    ['not-found', en['change.failure.notFound']],
    ['unauthenticated', en['change.failure.unauthenticated']],
    ['unavailable', en['change.failure.unavailable']],
  ] as const)('explains a %s read failure in place of the summary and retries it', (code, text) => {
    const failure: ForgeFailure = { code, message: 'detail' }
    const b = card(entry(1, failure))
    expect(metaOf(b).textContent).toBe('#1')
    const notice = b.item.querySelector(`.${css.notice}`)
    if (!(notice instanceof HTMLElement)) throw new Error('no failure notice')
    expect(within(notice).getByText(text)).toBeTruthy()

    fireEvent.click(within(notice).getByRole('button', { name: en.retry }))
    expect(b.retry).toHaveBeenCalledOnce()
    expect(b.openLink).not.toHaveBeenCalled()
  })

  it('keeps the title of the last snapshot after a failed read but not its stale summary', () => {
    const b = card(entry(4, { code: 'unavailable', message: 'down' }, { kept: snapshot(4, { checksRollup: 'failure' }) }))
    expect(b.title.textContent).toBe('Change 4')
    expect(metaOf(b).textContent).toBe('#4')
    expect(within(b.item).getByText(en['change.failure.unavailable'])).toBeTruthy()
  })

  it('opens a URL no provider serves instead of retrying it, without a number line when the URL names no number', () => {
    const b = card(unserved('http://example.test/review/latest'))
    expect(b.title.textContent).toBe('example.test/review/latest')
    expect(b.meta()).toBeNull()
    const notice = b.item.querySelector(`.${css.notice}`)
    if (!(notice instanceof HTMLElement)) throw new Error('no unserved notice')
    expect(within(notice).getByText(en['change.unserved'])).toBeTruthy()
    expect(within(notice).queryByRole('button', { name: en.retry })).toBeNull()

    fireEvent.click(within(notice).getByRole('button', { name: en['change.view'] }))
    expect(b.openLink).toHaveBeenCalledWith('http://example.test/review/latest')
    fireEvent.click(within(b.head).getByRole('button', { name: 'Expand http://example.test/review/latest' }))
    expect(b.onToggle).toHaveBeenCalledOnce()
  })

  it('reads the number of an unserved URL from its path', () => {
    expect(metaOf(card(unserved('https://example.test/review/17'))).textContent).toBe('#17')
  })
})

describe('expanded ChangeRequestCard', () => {
  it('shows the target, details, and diff size of an open change request and runs its actions on the snapshot URL', () => {
    const value = entry(7, snapshot(7, { url: 'https://github.com/octo/demo/pull/7#web', additions: 12345 }))
    const b = card(value, { expanded: true })
    expect(b.item.getAttribute('data-forge-change')).toBe('https://github.com/octo/demo/pull/7')
    expect(b.item.hasAttribute('data-expanded')).toBe(true)
    expect(metaOf(b).textContent).toBe('#7·feat → main')
    expect(within(b.head).getByRole('button', { name: 'Collapse #7' }).getAttribute('aria-expanded')).toBe('true')
    expect(rowValue(b.item, en['change.row.checks']).textContent).toBe(en['change.ci.none'])
    expect(within(b.item).getByText(en['change.row.checks']).closest('button')).toBeNull()
    expect(rowValue(b.item, en['change.row.review']).textContent).toBe(en['change.review.none'])
    expect(rowValue(b.item, en['change.row.merge']).textContent).toBe(en['change.merge.mergeable'])
    for (const label of [en['change.row.review'], en['change.row.merge']]) expect(rowValue(b.item, label).getAttribute('data-tone')).toBeNull()
    expect(within(b.item).getByText('+12,345')).toBeTruthy()
    expect(within(b.item).getByText(`${MINUS}3`)).toBeTruthy()

    fireEvent.click(within(b.head).getByRole('button', { name: en['change.view'] }))
    fireEvent.click(within(b.head).getByRole('button', { name: en['change.copy'] }))
    fireEvent.click(within(b.head).getByRole('button', { name: 'Remove #7 from this Session' }))
    expect(b.openLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7#web')
    expect(b.copyLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7#web')
    expect(b.remove).toHaveBeenCalledWith(value)
  })

  it('marks a draft before its branches', () => {
    const meta = metaOf(card(entry(7, snapshot(7, { draft: true })), { expanded: true }))
    expect(within(meta).getByText(en['change.state.draft'])).toBeTruthy()
    expect(meta.textContent).toBe('#7·Draftfeat → main')
  })

  it.each([
    ['merge conflicts', { mergeability: 'conflicting' }, 'Conflicts with main', 'error'],
    ['an unknown mergeability', { mergeability: 'unknown' }, en['change.merge.unknown'], null],
  ] as const)('states %s of an open change request', (_label, overrides, text, tone) => {
    const value = rowValue(card(entry(1, snapshot(1, overrides)), { expanded: true }).item, en['change.row.merge'])
    expect(value.textContent).toBe(text)
    expect(value.getAttribute('data-tone')).toBe(tone)
  })

  it.each([
    ['an approval', { reviewDecision: 'approved' }, en['change.review.approved'], 'success'],
    ['a required review', { reviewDecision: 'review-required' }, en['change.review.required'], null],
    ['requested changes', { reviewDecision: 'changes-requested' }, en['change.review.changesRequested'], 'error'],
    ['an approval with unresolved threads', { reviewDecision: 'approved', unresolvedThreads: 2 }, 'Approved · 2 unresolved', 'success'],
    ['requested changes with an unresolved thread', { reviewDecision: 'changes-requested', unresolvedThreads: 1 },
      'Changes requested · 1 unresolved', 'error'],
  ] as const)('states the review of %s', (_label, overrides, text, tone) => {
    const value = rowValue(card(entry(1, snapshot(1, overrides)), { expanded: true }).item, en['change.row.review'])
    expect(value.textContent).toBe(text)
    expect(value.getAttribute('data-tone')).toBe(tone)
  })

  it.each([
    ['merged', { state: 'merged', closedAt: '2026-10-09T09:00:00Z' }, 'Merged into main · 3 h ago'],
    ['closed', { state: 'closed' }, en['change.state.closed']],
  ] as const)('states a %s change request in one line instead of its checks, review, and merge rows', (tone, overrides, text) => {
    const b = card(entry(1, snapshot(1, { ...overrides, mergeability: 'conflicting', reviewDecision: 'changes-requested' })), { expanded: true })
    const line = within(b.item).getByText(text, { selector: `.${css.rowValue}` })
    expect(line.getAttribute('data-tone')).toBe(tone)
    for (const label of [en['change.row.checks'], en['change.row.review'], en['change.row.merge']]) expect(within(b.item).queryByText(label)).toBeNull()
    expect(within(b.item).getByText('+12')).toBeTruthy()
  })

  it('lists the checks failed first, then running, then the rest, with their times and links', () => {
    const checks = [
      check('build'),
      check('docs', { state: 'neutral' }),
      check('deploy', { state: 'pending', startedAt: null, completedAt: null }),
      check('lint', { state: 'failure', url: 'https://ci.example.test/lint', completedAt: '2026-10-09T11:00:00Z' }),
      check('e2e', { state: 'skipped', startedAt: null, completedAt: null }),
      check('test', { state: 'pending', completedAt: null }),
      check('package', { completedAt: null }),
      check('perf', { state: 'cancelled', startedAt: '2026-10-09T10:00:00Z', completedAt: '2026-10-09T11:30:20Z' }),
    ]
    const b = card(entry(1, snapshot(1, { checks, checksRollup: 'failure', checksTruncated: true })), { expanded: true })
    const toggle = within(b.item).getByText(en['change.row.checks']).closest('button')
    if (toggle === null) throw new Error('the checks row does not open a list')
    const summary = rowValue(b.item, en['change.row.checks'])
    expect(summary.textContent).toBe('1 failed · 2 running · 2 passed · 3 other')
    expect(summary.getAttribute('data-tone')).toBe('error')
    // The row leads with the combined outcome.
    expect(toggle.querySelector('[data-forge-check]')?.getAttribute('data-forge-check')).toBe('failure')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(checkRows()).toEqual([])

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(checkRows()).toEqual([
      'failure|lint|1h 0m|link',
      'pending|deploy|Queued|no link',
      'pending|test|Running|no link',
      'success|build|1m 5s|no link',
      'success|package||no link',
      'neutral|docs|1m 5s|no link',
      'skipped|e2e||no link',
      'cancelled|perf|1h 30m|no link',
    ])
    expect(screen.getByText('Only the first 8 are listed')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('menuitem')[0]!)
    expect(b.openLink).toHaveBeenCalledWith('https://ci.example.test/lint')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(checkRows()).toEqual([])
  })

  it('closes the checks list from its row and from an outside press', () => {
    const b = card(entry(1, snapshot(1, { checks: [check('build')] })), { expanded: true })
    const toggle = within(b.item).getByText(en['change.row.checks']).closest('button')
    if (toggle === null) throw new Error('the checks row does not open a list')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(checkRows()).toEqual([])
    fireEvent.click(toggle)
    expect(checkRows()).toEqual(['success|build|1m 5s|no link'])
    fireEvent.pointerDown(document.body)
    expect(checkRows()).toEqual([])
    expect(b.openLink).not.toHaveBeenCalled()
  })

  it.each([
    ['passed checks', [check('build'), check('test')], '2 passed', ['success|build|1m 5s|no link', 'success|test|1m 5s|no link']],
    ['running and skipped checks', [
      check('docs', { state: 'skipped', startedAt: null, completedAt: null }),
      check('test', { state: 'pending', completedAt: null }),
    ], '1 running · 1 other', ['pending|test|Running|no link', 'skipped|docs||no link']],
  ])('counts %s without an error tone or a truncation note', (_label, checks, text, rows) => {
    const b = card(entry(1, snapshot(1, { checks, checksRollup: 'pending' })), { expanded: true })
    const summary = rowValue(b.item, en['change.row.checks'])
    expect(summary.textContent).toBe(text)
    expect(summary.getAttribute('data-tone')).toBeNull()
    fireEvent.click(within(b.item).getByText(en['change.row.checks']))
    expect(checkRows()).toEqual(rows)
    expect(screen.queryByText(/^Only the first/)).toBeNull()
  })

  it('shows only the link actions before the first poll', () => {
    const b = card(entry(1, null), { expanded: true })
    expect(metaOf(b).textContent).toBe('#1')
    expect(within(b.item).queryByText(en['change.row.checks'])).toBeNull()
    expect(within(b.item).queryByText('+12')).toBeNull()
    fireEvent.click(within(b.head).getByRole('button', { name: en['change.copy'] }))
    expect(b.copyLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/1')
  })

  it('shows the branches and opens the snapshot URL of an unnumbered change request', () => {
    const b = card({ ...unserved('https://example.test/review/latest'), snapshot: snapshot(3, { url: 'https://example.test/review/latest#web' }) }, { expanded: true })
    expect(b.title.textContent).toBe('Change 3')
    expect(metaOf(b).textContent).toBe('feat → main')
    fireEvent.click(within(b.head).getByRole('button', { name: 'Remove Change 3 from this Session' }))
    expect(b.remove).toHaveBeenCalledOnce()
    fireEvent.click(within(b.head).getByRole('button', { name: en['change.view'] }))
    expect(b.openLink).toHaveBeenCalledWith('https://example.test/review/latest#web')
  })

  it('omits removal on a surface without a Session binding', () => {
    const b = card(entry(1, snapshot(1)), { expanded: true, actions: { remove: undefined } })
    expect(within(b.head).queryByRole('button', { name: 'Remove #1 from this Session' })).toBeNull()
    expect(within(b.head).getByRole('button', { name: en['change.view'] })).toBeTruthy()
  })
})

/** A promise that settles when the test says so. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Each row of the open merge menu, and whether it carries the selection check. */
function mergeRows(): string[] {
  return screen.getAllByRole('menuitem').map(row => `${row.textContent ?? ''}${row.querySelector('svg') === null ? '' : ' ✓'}`)
}

describe('ChangeRequestCard actions', () => {
  const head = 'b'.repeat(40)

  it('marks a draft ready for review, refusing a second request until the first settles', async () => {
    const pending = deferred()
    const markReady = vi.fn<(entry: ForgePanelChangeRequest) => Promise<void>>(() => pending.promise)
    const value = entry(7, snapshot(7, { draft: true, mergeReady: true }))
    const b = card(value, { expanded: true, actions: { markReady } })
    const button = within(b.item).getByRole('button', { name: en['change.markReady'] })
    expect(within(b.item).queryByRole('button', { name: en['change.merge'] })).toBeNull()

    fireEvent.click(button)
    fireEvent.click(button)
    expect(markReady).toHaveBeenCalledOnce()
    expect(markReady).toHaveBeenCalledWith(value)
    expect(button.hasAttribute('disabled')).toBe(true)

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('lists the methods the repository allows with the usual one chosen, and merges the confirmed head with the chosen one', async () => {
    const pending = deferred()
    const merge = vi.fn<(entry: ForgePanelChangeRequest, request: MergeRequest) => Promise<void>>(() => pending.promise)
    const value = entry(7, snapshot(7, { mergeReady: true, mergeMethods: ['merge', 'squash', 'rebase'], headSha: head }))
    const b = card(value, { expanded: true, actions: { merge } })
    const button = within(b.item).getByRole('button', { name: en['change.merge'] })
    expect(within(b.item).queryByRole('button', { name: en['change.markReady'] })).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(within(screen.getByRole('menu')).getByText('Merge #7 into main')).toBeTruthy()
    expect(mergeRows()).toEqual([
      'Create a merge commitKeep every commit and add a merge commit ✓',
      'Squash and mergeCombine every commit into one',
      'Rebase and mergeReplay each commit onto main',
      'Confirm merge',
    ])

    fireEvent.click(screen.getByRole('menuitem', { name: /^Rebase and merge/ }))
    expect(mergeRows().map(row => row.endsWith(' ✓'))).toEqual([false, false, true, false])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Confirm merge' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(merge).toHaveBeenCalledWith(value, { method: 'rebase', headSha: head })
    expect(button.hasAttribute('disabled')).toBe(true)

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(merge).toHaveBeenCalledOnce()
  })

  it('requires a new confirmation after the head changes while the menu is open', async () => {
    const merge = vi.fn<NonNullable<ChangeRequestActions['merge']>>(async () => {})
    const actions: ChangeRequestActions = { openLink: vi.fn(), copyLink: vi.fn(), retry: vi.fn(), merge }
    const view = (headSha: string) => <ChangeRequestCard locale="en" entry={entry(7, snapshot(7, { mergeReady: true, headSha }))}
      expanded onToggle={vi.fn()} now={NOW} actions={actions} t={t} />
    const rendered = render(view(head))
    const button = screen.getByRole('button', { name: en['change.merge'] })
    fireEvent.click(button)
    rendered.rerender(view('c'.repeat(40)))
    const changed = screen.getByRole('menuitem', { name: en['change.mergeChanged'] })
    expect(changed.hasAttribute('disabled')).toBe(true)
    fireEvent.click(changed)
    expect(merge).not.toHaveBeenCalled()
    fireEvent.click(button)
    fireEvent.click(button)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: en['change.mergeConfirm'] })) })
    expect(merge).toHaveBeenCalledWith(expect.anything(), { method: 'squash', headSha: 'c'.repeat(40) })
  })

  it('falls back to the usual method once the repository stops allowing the chosen one', async () => {
    const merge = vi.fn<(entry: ForgePanelChangeRequest, request: MergeRequest) => Promise<void>>(async () => {})
    const actions: ChangeRequestActions = { openLink: vi.fn(), copyLink: vi.fn(), retry: vi.fn(), merge }
    const view = (methods: MergeRequest['method'][]) => (
      <ul>
        <ChangeRequestCard locale="en"
          entry={entry(7, snapshot(7, { mergeReady: true, mergeMethods: methods, headSha: head }))}
          expanded
          onToggle={vi.fn()}
          now={NOW}
          actions={actions}
          t={t}
        />
      </ul>
    )
    const rendered = render(view(['squash', 'rebase']))
    fireEvent.click(within(rendered.container).getByRole('button', { name: en['change.merge'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Rebase and merge/ }))
    rendered.rerender(view(['squash']))

    expect(mergeRows()).toEqual(['Squash and mergeCombine every commit into one ✓', 'Confirm merge'])
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Confirm merge' }))
    })
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://github.com/octo/demo/pull/7' }), { method: 'squash', headSha: head })
  })

  it.each([
    ['the host would not merge it now', { mergeReady: false }],
    ['the repository allows no merge method', { mergeReady: true, mergeMethods: [] }],
    ['it is merged', { state: 'merged', mergeReady: true }],
    ['it is a closed draft', { state: 'closed', draft: true }],
  ] as const)('offers neither action when %s', (_label, overrides) => {
    const b = card(entry(7, snapshot(7, overrides)), { expanded: true })
    expect(within(b.item).queryByRole('button', { name: en['change.markReady'] })).toBeNull()
    expect(within(b.item).queryByRole('button', { name: en['change.merge'] })).toBeNull()
  })

  it('offers neither action on a surface without a Session binding', () => {
    const actions = { markReady: undefined, merge: undefined }
    for (const value of [entry(7, snapshot(7, { draft: true })), entry(8, snapshot(8, { mergeReady: true }))]) {
      const b = card(value, { expanded: true, actions })
      expect(within(b.item).queryAllByRole('button', { name: new RegExp(`^(${en['change.markReady']}|${en['change.merge']})$`) })).toEqual([])
      cleanup()
    }
  })
})

describe('ChangeRequestCard changes', () => {
  it('opens the changes of a served change request from its diff size', () => {
    const value = entry(7, snapshot(7, { additions: 12345 }))
    const viewChanges = vi.fn<(entry: ForgePanelChangeRequest) => void>()
    const b = card(value, { expanded: true, actions: { viewChanges } })
    const button = within(b.item).getByRole('button', { name: 'View the changes of #7: 12,345 lines added, 3 lines deleted' })
    expect(button.textContent).toBe(`${en['change.row.changes']}+12,345${MINUS}3`)
    fireEvent.click(button)
    expect(viewChanges).toHaveBeenCalledWith(value)
  })

  it('shows only the diff size of a change request no provider serves', () => {
    const viewChanges = vi.fn<(entry: ForgePanelChangeRequest) => void>()
    const b = card({ ...unserved('https://example.test/review/9'), snapshot: snapshot(9) }, { expanded: true, actions: { viewChanges } })
    expect(within(b.item).queryByRole('button', { name: /View the changes/ })).toBeNull()
    expect(within(b.item).getByText('+12')).toBeTruthy()
  })
})

describe('ChangeRequestCard layout', () => {
  it('shows the action row only for a change request with an action', () => {
    const waiting = card(entry(7, snapshot(7)), { expanded: true, actions: { merge: vi.fn(async () => {}) } })
    expect(waiting.item.querySelector(`.${css.footer}`)).toBeNull()
    cleanup()
    const draft = card(entry(8, snapshot(8, { draft: true })), { expanded: true, actions: { markReady: vi.fn(async () => {}) } })
    const footer = draft.item.querySelector(`.${css.footer}`)
    if (!(footer instanceof HTMLElement)) throw new Error('no action row')
    expect(within(footer).getByRole('button').textContent).toBe(en['change.markReady'])
  })

  it('shows the changed lines of a finished change request below its end', () => {
    const b = card(entry(9, snapshot(9, { state: 'closed', closedAt: null })), { expanded: true })
    const rows = b.item.querySelector(`.${css.rows}`)
    if (!(rows instanceof HTMLElement)) throw new Error('no rows')
    expect([...rows.children].map(row => row.textContent)).toEqual([en['change.state.closed'], `${en['change.row.changes']}+12${MINUS}3`])
  })

  it('shows a neutral check glyph without checks', () => {
    const b = card(entry(1, snapshot(1, { checksRollup: 'none' })), { expanded: true })
    expect(rowValue(b.item, en['change.row.checks']).textContent).toBe(en['change.ci.none'])
    expect(b.item.querySelector('[data-forge-check]')?.getAttribute('data-forge-check')).toBe('neutral')
  })
})


describe('change request number formatting', () => {
  it('formats visible and accessible line counts with the selected UI language', () => {
    const value = entry(7, snapshot(7, { additions: 1234, deletions: 5678 }))
    const actions: ChangeRequestActions = { openLink: vi.fn(), copyLink: vi.fn(), retry: vi.fn(), viewChanges: vi.fn() }
    const view = (locale: string) => <ChangeRequestCard locale={locale} entry={value} expanded onToggle={vi.fn()}
      now={NOW} actions={actions} t={t} />
    const rendered = render(view('de'))
    expect(screen.getByText('+1.234')).toBeTruthy()
    expect(screen.getByText('−5.678')).toBeTruthy()
    expect(screen.getByRole('button', { name: /1\.234.*5\.678/ })).toBeTruthy()
    rendered.rerender(view('en'))
    expect(screen.getByText('+1,234')).toBeTruthy()
    expect(screen.getByRole('button', { name: /1,234.*5,678/ })).toBeTruthy()
  })
})

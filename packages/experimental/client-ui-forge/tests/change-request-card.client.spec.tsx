// @vitest-environment jsdom
/**
 * One change request card: its line of state glyph, title, number, and checks outcome, the hover details, read notices,
 * and expanded details and actions.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ForgeFailure, MergeRequest } from '@deepseek-ai/dsh-experimental-forge/types'
import { ChangeRequestCard, type ChangeRequestActions } from '../src/client/ChangeRequestCard.tsx'
import { en } from '../src/client/locales.ts'
import css from '../src/client/Forge.module.css'
import overview from '../src/client/ChangeRequestOverview.module.css'
import type { ChangeRequestEntry } from '../src/client/status.ts'
import type { ForgePanelChangeRequest } from '../src/types.ts'
import { check, entry, snapshot, unserved } from './client-fixtures.client.ts'
import './fonts-dom.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)
/** The opening action of a change request whose provider names itself GitHub. */
const OPEN_ON_GITHUB = t('change.viewOn', { forge: 'GitHub' })
const NOW = Date.parse('2026-10-09T12:00:00Z')
/** Minus sign (U+2212) the diff size puts before the deleted line count. */
const MINUS = '−'

/** Render one card inside its list, with every action recorded unless `actions` replaces it. */
function card(value: ForgePanelChangeRequest, options: { expanded?: boolean; actions?: Partial<ChangeRequestActions>; t?: typeof t } = {}) {
  const openLink = vi.fn<(url: string) => void>()
  const copyLink = vi.fn<(url: string) => void>()
  const retry = vi.fn<() => void>()
  const remove = vi.fn<(entry: ChangeRequestEntry) => void>()
  const onToggle = vi.fn<() => void>()
  const actions: ChangeRequestActions = { openLink, copyLink, retry, remove, ...options.actions }
  const view = render(
    <ul>
      <ChangeRequestCard locale="en" entry={value} expanded={options.expanded ?? false} onToggle={onToggle} now={NOW} actions={actions}
        coarsePointer={false} t={options.t ?? t} />
    </ul>,
  )
  const item = view.container.querySelector('[data-forge-change]')
  const head = item?.querySelector(`.${css.changeHead}`)
  const line = head?.querySelector('[data-row-part="body"]')
  const status = head?.querySelector(`.${css.status}`)
  const drawn = item instanceof HTMLElement && head instanceof HTMLElement && line instanceof HTMLElement && status instanceof HTMLElement
  if (!drawn) throw new Error('no change request card')
  const menuButton = (): HTMLElement => within(head).getByRole('button', { name: /^Actions for / })
  /** Labels of the actions menu, closing it again. */
  const menuItems = (): string[] => {
    fireEvent.click(menuButton())
    const labels = screen.queryAllByRole('menuitem').map(row => row.textContent)
    fireEvent.click(menuButton())
    return labels
  }
  /** Open the actions menu and choose one item. */
  const choose = (label: string): void => {
    fireEvent.click(menuButton())
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
  }
  /** The title the line shows. */
  const title = (): string | null => line.querySelector('[data-row-part="content"]')?.textContent ?? null
  /** The status the line reads to assistive technology, or null when it reads none. */
  const spoken = (): string | null => status.querySelector(`.${css.visuallyHidden}`)?.textContent ?? null
  return {
    view, item, head, line, status, title, spoken, menuButton, menuItems, choose, openLink, copyLink, retry, remove, onToggle,
  }
}

/** The value a details row shows after its name, which only assistive technology reads. */
function rowValue(item: HTMLElement, label: string): HTMLElement {
  const value = within(item).getByText(label).nextElementSibling
  if (!(value instanceof HTMLElement)) throw new Error(`no value after ${label}`)
  return value
}

/** The tone of the row named `label`. */
function rowTone(item: HTMLElement, label: string): string | null {
  return within(item).getByText(label).closest(`.${css.rowValue}`)?.getAttribute('data-tone') ?? null
}

/**
 * Each row of the open checks menu in display order: a check as its outcome, name, time, and whether it opens a link;
 * any other row as its text.
 */
function checkRows(): string[] {
  return screen.queryAllByRole('menuitem').map((row) => {
    const item = row.querySelector('[data-forge-check-item]')
    if (item === null) return row.textContent ?? ''
    const [name, time] = item.children
    return [item.getAttribute('data-forge-check-item'), name?.textContent, time?.textContent, row.hasAttribute('disabled') ? 'no link' : 'link'].join('|')
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

  it('lays its line out by the panel row marks: the body, the status, the actions menu, and the toggle in the end column', () => {
    const b = card(entry(7, snapshot(7)))
    expect(b.head.hasAttribute('data-session-panel-row')).toBe(true)
    expect([...b.head.children].map(part => part.getAttribute('data-row-part'))).toEqual(['body', 'trailing', 'menu', 'trailing'])
    expect([...b.line.children].map(part => part.getAttribute('data-row-part'))).toEqual(['icon', 'content'])
    expect(b.line.tagName).toBe('BUTTON')
    expect(b.line.querySelector('[data-row-part="icon"] [data-forge-glyph]')).not.toBeNull()
    expect(b.title()).toBe('Change 7')
    expect(b.menuButton().closest('[data-row-part]')?.getAttribute('data-row-part')).toBe('menu')
    expect(within(b.head).getByRole('button', { name: 'Expand #7' }).closest(`.${css.end}`)).toBe(b.head.lastElementChild)
  })

  it('opens the changes of a served change request from its line, and its page with a modifier key or the middle button', () => {
    const viewChanges = vi.fn<(entry: ChangeRequestEntry) => void>()
    const value = entry(7, snapshot(7, { url: 'https://github.com/octo/demo/pull/7#web' }))
    const b = card(value, { actions: { viewChanges } })
    expect(b.line.getAttribute('data-forge-opens')).toBe('changes')

    fireEvent.click(b.line)
    expect(viewChanges.mock.calls).toEqual([[value]])
    expect(b.openLink).not.toHaveBeenCalled()

    fireEvent.click(b.line, { metaKey: true })
    fireEvent.click(b.line, { ctrlKey: true })
    fireEvent(b.line, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    fireEvent(b.line, new MouseEvent('auxclick', { bubbles: true, button: 2 }))
    expect(viewChanges).toHaveBeenCalledOnce()
    expect(b.openLink.mock.calls).toEqual(Array.from({ length: 3 }, () => ['https://github.com/octo/demo/pull/7#web']))
    expect(b.onToggle).not.toHaveBeenCalled()
  })

  it.each([
    ['no provider serves', unserved('https://example.test/review/17'), true, 'https://example.test/review/17'],
    ['is not read yet', entry(1, null), true, 'https://github.com/octo/demo/pull/1'],
    ['shows on a surface without a changes view', entry(1, snapshot(1)), false, 'https://github.com/octo/demo/pull/1'],
  ] as const)('opens the page of a change request that %s from its line', (_label, value, changes, url) => {
    const viewChanges = vi.fn<(entry: ChangeRequestEntry) => void>()
    const b = card(value, { actions: changes ? { viewChanges } : {} })
    expect(b.line.getAttribute('data-forge-opens')).toBe('link')
    fireEvent.click(b.line)
    expect(b.openLink.mock.calls).toEqual([[url]])
    expect(viewChanges).not.toHaveBeenCalled()
  })

  it('toggles from the chevron, which the line does not contain', () => {
    const b = card(entry(7, snapshot(7)))
    expect(b.item.hasAttribute('data-expanded')).toBe(false)
    const chevron = within(b.head).getByRole('button', { name: 'Expand #7' })
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    expect(b.line.contains(chevron)).toBe(false)
    fireEvent.click(chevron)
    expect(b.onToggle).toHaveBeenCalledOnce()
    expect(b.openLink).not.toHaveBeenCalled()
  })
})

describe('collapsed ChangeRequestCard', () => {
  it('shows the number and the checks outcome of an open change request after its title, without its rows', () => {
    const b = card(entry(7, snapshot(7)))
    expect(within(b.status).getByText('#7').className).toBe(css.number)
    expect(b.status.querySelector('[data-forge-check]')?.getAttribute('data-forge-check')).toBe('success')
    expect(b.spoken()).toBe(en['change.ci.passed'])
    expect(within(b.item).queryByText(en['change.row.changes'])).toBeNull()
    expect(within(b.item).queryByText('+12')).toBeNull()
    expect(b.menuButton().getAttribute('aria-label')).toBe('Actions for #7')
    b.choose(OPEN_ON_GITHUB)
    b.choose(en['change.copy'])
    b.choose(en['change.remove'])
    expect(b.openLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7')
    expect(b.copyLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7')
    expect(b.remove).toHaveBeenCalledOnce()
  })

  it.each([
    ['no checks', { checksRollup: 'none' }, en['change.ci.none'], undefined],
    ['running checks', { checksRollup: 'pending' }, en['change.ci.running'], 'pending'],
    ['listed failed checks', {
      checksRollup: 'failure',
      checks: [check('lint', { state: 'failure' }), check('test'), check('types', { state: 'failure' })],
    }, '2 checks failed', 'failure'],
    ['cancelled checks', { checksRollup: 'failure', checks: [check('build', { state: 'cancelled' })] }, '1 checks cancelled', 'cancelled'],
    ['failed checks the host did not list', { checksRollup: 'failure', checksTruncated: true }, en['change.ci.failedUnlisted'], 'failure'],
  ] as const)('marks %s with a glyph and reads them in words', (_label, overrides, text, glyph) => {
    const b = card(entry(1, snapshot(1, overrides)))
    expect(b.status.querySelector('[data-forge-check]')?.getAttribute('data-forge-check')).toBe(glyph)
    expect(b.spoken()).toBe(text)
  })

  it.each([
    ['requested changes', { reviewDecision: 'changes-requested', mergeability: 'conflicting' }, en['change.flag.changesRequested']],
    ['merge conflicts', { mergeability: 'conflicting', draft: true }, en['change.flag.conflicting']],
    ['draft state', { draft: true }, en['change.flag.draft']],
  ] as const)('reads %s after the checks', (_label, overrides, text) => {
    expect(card(entry(1, snapshot(1, overrides))).spoken()).toBe(`${en['change.ci.passed']} · ${text}`)
  })

  it.each([
    ['merged three hours ago', { state: 'merged', closedAt: '2026-10-09T09:00:00Z' }, 'Merged into main · 3 h ago'],
    ['closed without a close time', { state: 'closed' }, en['change.state.closed']],
    ['closed at a time that does not parse', { state: 'closed', closedAt: 'last week' }, en['change.state.closed']],
  ] as const)('reads a change request %s instead of its checks, without a checks glyph', (_label, overrides, text) => {
    const b = card(entry(1, snapshot(1, { ...overrides, checksRollup: 'failure', reviewDecision: 'changes-requested' })))
    expect(b.spoken()).toBe(text)
    expect(b.status.querySelector('[data-forge-check]')).toBeNull()
  })

  it('names the URL and the number of a change request with a spinner before its first poll', () => {
    const b = card(entry(1, null))
    expect(b.title()).toBe('github.com/octo/demo/pull/1')
    expect(within(b.status).getByText('#1')).toBeTruthy()
    expect(b.status.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(b.spoken()).toBeNull()
    expect(b.item.querySelector(`.${css.notice}`)).toBeNull()
  })

  it.each([
    ['not-found', en['change.failure.notFound']],
    ['unauthenticated', en['change.failure.unauthenticated']],
    ['rate-limited', en['change.failure.rateLimited']],
    ['unavailable', en['change.failure.unavailable']],
  ] as const)('explains a %s read failure below the line in place of the status and retries it', (code, text) => {
    const failure: ForgeFailure = { code, message: 'detail' }
    const b = card(entry(1, failure))
    expect(b.status.textContent).toBe('#1')
    const notice = b.item.querySelector(`.${css.notice}`)
    if (!(notice instanceof HTMLElement)) throw new Error('no failure notice')
    expect(within(notice).getByText(text)).toBeTruthy()

    fireEvent.click(within(notice).getByRole('button', { name: en.retry }))
    expect(b.retry).toHaveBeenCalledOnce()
    expect(b.openLink).not.toHaveBeenCalled()
  })

  it('keeps the title of the last snapshot after a failed read but not its stale status', () => {
    const b = card(entry(4, { code: 'unavailable', message: 'down' }, { kept: snapshot(4, { checksRollup: 'failure' }) }))
    expect(b.title()).toBe('Change 4')
    expect(b.status.textContent).toBe('#4')
    expect(within(b.item).getByText(en['change.failure.unavailable'])).toBeTruthy()
  })

  it('opens a URL no provider serves instead of retrying it, without a number when the URL names none', () => {
    const b = card(unserved('http://example.test/review/latest'))
    expect(b.title()).toBe('example.test/review/latest')
    expect(b.status.textContent).toBe('')
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
    expect(card(unserved('https://example.test/review/17')).status.textContent).toBe('#17')
  })
})

describe('ChangeRequestCard hover card', () => {
  /** Render a card on a surface that draws hover details, and return what the card asked it to draw. */
  function described(value: ForgePanelChangeRequest, expanded = false) {
    const renderDetails = vi.fn<NonNullable<ChangeRequestActions['renderDetails']>>(() => <span data-details="" />)
    const b = card(value, { expanded, actions: { renderDetails } })
    return { ...b, details: renderDetails.mock.lastCall?.[0] }
  }

  it('names the full title, the number with the branches, and the status in words', () => {
    expect(described(entry(7, snapshot(7))).details).toEqual({
      title: 'Change 7', lines: ['#7 · feat → main'], status: { state: 'done', label: en['change.ci.passed'] },
    })
  })

  it.each([
    ['a draft', snapshot(1, { draft: true, checksRollup: 'none' }), ['#1 · Draft · feat → main'], 'idle', `${en['change.ci.none']} · ${en['change.flag.draft']}`],
    ['running checks', snapshot(1, { checksRollup: 'pending' }), ['#1 · feat → main'], 'ongoing', en['change.ci.running']],
    ['what needs the author', snapshot(1, { mergeability: 'conflicting' }), ['#1 · feat → main'], 'error', `${en['change.ci.passed']} · ${en['change.flag.conflicting']}`],
    ['a merge', snapshot(1, { state: 'merged' }), ['#1 · feat → main'], 'done', 'Merged into main'],
    ['a close', snapshot(1, { state: 'closed' }), ['#1 · feat → main'], 'idle', en['change.state.closed']],
  ] as const)('gives %s its state dot', (_label, value, lines, state, label) => {
    expect(described(entry(1, value)).details).toEqual({ title: 'Change 1', lines, status: { state, label } })
  })

  it('names only the URL and the number before the first poll', () => {
    expect(described(entry(1, null)).details).toEqual({ title: 'github.com/octo/demo/pull/1', lines: ['#1'] })
  })

  it('states a failed read and an unserved URL as its status', () => {
    expect(described(entry(4, { code: 'unavailable', message: 'down' }, { kept: snapshot(4) })).details).toEqual({
      title: 'Change 4', lines: ['#4 · feat → main'], status: { state: 'warning', label: en['change.failure.unavailable'] },
    })
    cleanup()
    expect(described(unserved('http://example.test/review/latest')).details).toEqual({
      title: 'example.test/review/latest', lines: [], status: { state: 'warning', label: en['change.unserved'] },
    })
  })

  it('anchors the hover card to the line, expanded or not, and draws the line alone on a surface without details', () => {
    for (const expanded of [false, true]) {
      const b = described(entry(7, snapshot(7)), expanded)
      expect(b.head.parentElement).not.toBe(b.item)
      expect(b.item.contains(b.head)).toBe(true)
      cleanup()
    }
    const plain = card(entry(7, snapshot(7)))
    expect(plain.head.parentElement).toBe(plain.item)
  })
})

describe('expanded ChangeRequestCard', () => {
  it('shows the details and diff size of an open change request below its line and runs its actions on the snapshot URL', () => {
    const value = entry(7, snapshot(7, { url: 'https://github.com/octo/demo/pull/7#web', additions: 12345 }))
    const b = card(value, { expanded: true })
    expect(b.item.getAttribute('data-forge-change')).toBe('https://github.com/octo/demo/pull/7')
    expect(b.item.hasAttribute('data-expanded')).toBe(true)
    // The rows below state the status, so the line no longer reads it.
    expect(b.status.textContent).toBe('#7')
    expect(b.spoken()).toBeNull()
    expect(within(b.head).getByRole('button', { name: 'Collapse #7' }).getAttribute('aria-expanded')).toBe('true')
    expect(rowValue(b.item, en['change.row.checks']).textContent).toBe(en['change.ci.none'])
    expect(within(b.item).getByText(en['change.row.checks']).closest('button')).toBeNull()
    expect(rowValue(b.item, en['change.row.review']).textContent).toBe(en['change.review.none'])
    // Without reviewers or the right to request reviews, the review row opens nothing.
    expect(within(b.item).getByText(en['change.row.review']).closest('button')).toBeNull()
    expect(rowValue(b.item, en['change.row.merge']).textContent).toBe(en['change.merge.mergeable'])
    for (const label of [en['change.row.review'], en['change.row.merge']]) expect(rowTone(b.item, label)).toBeNull()
    expect(b.item.querySelector('[data-forge-threads]')).toBeNull()
    expect(b.item.querySelector('[data-forge-closing-issues]')).toBeNull()
    expect(within(b.item).getByText('+12,345')).toBeTruthy()
    expect(within(b.item).getByText(`${MINUS}3`)).toBeTruthy()

    b.choose(OPEN_ON_GITHUB)
    b.choose(en['change.copy'])
    b.choose(en['change.remove'])
    expect(b.openLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7#web')
    expect(b.copyLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7#web')
    expect(b.remove).toHaveBeenCalledWith(value)
  })

  it.each([
    ['merge conflicts', { mergeability: 'conflicting' }, 'Conflicts with main', 'error'],
    ['an unknown mergeability', { mergeability: 'unknown' }, en['change.merge.unknown'], null],
  ] as const)('states %s of an open change request', (_label, overrides, text, tone) => {
    const { item } = card(entry(1, snapshot(1, overrides)), { expanded: true })
    expect(rowValue(item, en['change.row.merge']).textContent).toBe(text)
    expect(rowTone(item, en['change.row.merge'])).toBe(tone)
  })

  it.each([
    ['an approval', { reviewDecision: 'approved' }, en['change.review.approved'], 'success'],
    ['a required review', { reviewDecision: 'review-required' }, en['change.review.required'], null],
    ['requested changes', { reviewDecision: 'changes-requested' }, en['change.review.changesRequested'], 'error'],
  ] as const)('states the review of %s', (_label, overrides, text, tone) => {
    const { item } = card(entry(1, snapshot(1, overrides)), { expanded: true })
    expect(rowValue(item, en['change.row.review']).textContent).toBe(text)
    expect(rowTone(item, en['change.row.review'])).toBe(tone)
  })

  it.each([
    ['unresolved threads', { unresolvedThreads: 2 }, '2'],
    ['more threads than the provider counted', { unresolvedThreads: 1200, threadsTruncated: true }, '1,200+'],
    ['uncounted threads after resolved ones', { unresolvedThreads: 0, threadsTruncated: true }, '0+'],
  ] as const)('counts %s at the end of the changes row', (_label, overrides, count) => {
    const { item } = card(entry(1, snapshot(1, overrides)), { expanded: true })
    const threads = item.querySelector('[data-forge-threads]')
    expect(threads?.getAttribute('data-forge-threads')).toBe(count)
    expect(threads?.textContent).toBe(count)
    expect(threads?.closest(`.${css.rowTrailing}`)?.parentElement?.textContent).toContain('+12')
  })

  it('names the unresolved threads of a row that opens the changes view in its description', () => {
    const { item } = card(entry(1, snapshot(1, { unresolvedThreads: 2 })), { expanded: true, actions: { viewChanges: vi.fn() } })
    const row = within(item).getByRole('button', { name: /^View the changes of #1/ })
    expect(row.getAttribute('aria-describedby')).not.toBeNull()
    expect(document.getElementById(row.getAttribute('aria-describedby') ?? '')?.textContent).toBe('2 unresolved threads')
    expect(item.querySelector('[data-forge-threads]')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('names the unresolved threads in a tooltip after 500ms of hover', () => {
    const { item } = card(entry(1, snapshot(1, { unresolvedThreads: 2 })), { expanded: true })
    const threads = item.querySelector('[data-forge-threads]')!
    vi.useFakeTimers()
    try {
      fireEvent.pointerEnter(threads)
      act(() => { vi.advanceTimersByTime(499) })
      expect(screen.queryByRole('tooltip')).toBeNull()
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.getByRole('tooltip').textContent).toBe('2 unresolved threads')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['merged', { state: 'merged', closedAt: '2026-10-09T09:00:00Z' }, 'Merged into main · 3 h ago'],
    ['closed', { state: 'closed' }, en['change.state.closed']],
  ] as const)('states a %s change request in one line instead of its checks, review, and merge rows', (tone, overrides, text) => {
    const b = card(entry(1, snapshot(1, { ...overrides, mergeability: 'conflicting', reviewDecision: 'changes-requested' })), { expanded: true })
    const line = within(b.item).getByText(text, { selector: `.${css.ellipsis}` })
    expect(line.closest(`.${css.rowValue}`)?.getAttribute('data-tone')).toBe(tone)
    for (const label of [en['change.row.checks'], en['change.row.review'], en['change.row.merge']]) expect(within(b.item).queryByText(label)).toBeNull()
    expect(within(b.item).getByText('+12')).toBeTruthy()
  })

  it.each([
    ['a partial preview', true, '8 checks loaded; more available', null],
    ['a complete list', false, '1 failed · 2 running · 1 cancelled', 'error'],
  ] as const)('lists %s by group, the ones needing attention first and the rest on request', (_label, checksTruncated, text, tone) => {
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
    const b = card(entry(1, snapshot(1, { checks, checksRollup: 'failure', checksTruncated })), { expanded: true })
    const toggle = within(b.item).getByText(en['change.row.checks']).closest('button')
    if (toggle === null) throw new Error('the checks row does not open a menu')
    expect(rowValue(b.item, en['change.row.checks']).textContent).toBe(text)
    expect(rowTone(b.item, en['change.row.checks'])).toBe(tone)
    // The row leads with the combined outcome.
    expect(toggle.querySelector('[data-forge-check]')?.getAttribute('data-forge-check')).toBe('failure')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(checkRows()).toEqual([])

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('group').map(group => group.getAttribute('aria-label'))).toEqual(['Failed', 'Running', 'Cancelled'])
    expect(checkRows()).toEqual([
      'failure|lint|1h 0m|link',
      'pending|deploy|Queued|no link',
      'pending|test|Running|no link',
      'cancelled|perf|1h 30m|no link',
      'Show 4 more (passed, skipped)',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show 4 more (passed, skipped)' }))
    expect(checkRows().slice(4)).toEqual([
      'success|build|1m 5s|no link',
      'success|package||no link',
      'neutral|docs|1m 5s|no link',
      'skipped|e2e||no link',
    ])

    fireEvent.click(screen.getAllByRole('menuitem')[0]!)
    expect(b.openLink).toHaveBeenCalledWith('https://ci.example.test/lint')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(checkRows()).toEqual([])
    // A reopened menu lists the rest on request again.
    fireEvent.click(toggle)
    expect(checkRows().at(-1)).toBe('Show 4 more (passed, skipped)')
  })

  it.each([
    [new Error('timeout'), 'timeout'],
    ['offline', 'offline'],
  ])('retains the preview after rejection %s and retries loading complete checks', async (failure, message) => {
    const partial = snapshot(1, { checks: [check('old lint', { state: 'failure' })], checksTruncated: true })
    const waiting = Promise.withResolvers<ReturnType<typeof snapshot>>()
    const readChecks = vi.fn<NonNullable<ChangeRequestActions['readChecks']>>()
      .mockReturnValueOnce(waiting.promise)
      .mockResolvedValueOnce(snapshot(1, { checks: [check('current lint')] }))
    const b = card(entry(1, partial), { expanded: true, actions: { readChecks } })
    expect(readChecks).not.toHaveBeenCalled()
    fireEvent.click(within(b.item).getByText(en['change.row.checks']))
    expect(readChecks).toHaveBeenCalledWith(partial.url, partial.headSha, expect.any(AbortSignal))
    expect(screen.getByText('old lint')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(en['change.checks.loading'])
    expect(readChecks).toHaveBeenCalledTimes(1)
    await act(async () => { waiting.reject(failure); await Promise.resolve() })
    expect(screen.getByText('old lint')).toBeTruthy()
    expect(screen.getByText(`Could not load more checks: ${message}`)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['change.checks.retry'] })) })
    expect(screen.queryByText('old lint')).toBeNull()
    expect(checkRows()).toEqual(['Show 1 more (passed, skipped)'])
    expect(rowValue(b.item, en['change.row.checks']).textContent).toBe('All 1 checks passed')
  })

  it('keeps a reopened menu loading when its cancelled read rejects late', async () => {
    const partial = snapshot(1, { checks: [check('preview', { state: 'failure' })], checksTruncated: true })
    const older = Promise.withResolvers<ReturnType<typeof snapshot>>()
    const newer = Promise.withResolvers<ReturnType<typeof snapshot>>()
    const readChecks = vi.fn<NonNullable<ChangeRequestActions['readChecks']>>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const b = card(entry(1, partial), { expanded: true, actions: { readChecks } })
    const toggle = within(b.item).getByText(en['change.row.checks'])
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(readChecks).toHaveBeenCalledTimes(2)
    expect(readChecks.mock.calls[0]![2].aborted).toBe(true)
    expect(readChecks.mock.calls[1]![2].aborted).toBe(false)

    await act(async () => { older.reject(new Error('cancelled request')); await Promise.resolve() })
    expect(screen.getByText(en['change.checks.loading'])).toBeTruthy()
    expect(screen.getByText('preview')).toBeTruthy()
    expect(screen.queryByText('Could not load more checks: cancelled request')).toBeNull()
    expect(screen.queryByRole('button', { name: en['change.checks.retry'] })).toBeNull()

    await act(async () => { newer.resolve(snapshot(1, { checks: [check('current result', { state: 'failure' })] })); await Promise.resolve() })
    expect(screen.getByText('current result')).toBeTruthy()
    expect(screen.queryByText('preview')).toBeNull()
  })

  it.each(['close', 'unmount', 'head'] as const)('cancels a check read on %s and ignores its late completion', async (change) => {
    const partial = snapshot(1, { checks: [check('preview')], checksTruncated: true })
    const pending = Promise.withResolvers<ReturnType<typeof snapshot>>()
    const readChecks = vi.fn<NonNullable<ChangeRequestActions['readChecks']>>(() => pending.promise)
    const b = card(entry(1, partial), { expanded: true, actions: { readChecks } })
    fireEvent.click(within(b.item).getByText(en['change.row.checks']))
    const signal = readChecks.mock.calls[0]![2]
    if (change === 'close') fireEvent.click(within(b.item).getByText(en['change.row.checks']))
    else if (change === 'unmount') b.view.unmount()
    else b.view.rerender(<ul><ChangeRequestCard entry={entry(1, { ...partial, headSha: 'b'.repeat(40) })} expanded onToggle={b.onToggle}
      now={NOW} locale="en" actions={{ openLink: b.openLink, copyLink: b.copyLink, retry: b.retry, readChecks }} coarsePointer={false}
      t={t} /></ul>)
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(snapshot(1, { checks: [check('late result', { state: 'failure' })] })); await Promise.resolve() })
    expect(screen.queryByText('late result')).toBeNull()
  })

  it('closes the checks menu from its row and from an outside press', () => {
    const b = card(entry(1, snapshot(1, { checks: [check('build', { state: 'failure' })] })), { expanded: true })
    const toggle = within(b.item).getByText(en['change.row.checks']).closest('button')
    if (toggle === null) throw new Error('the checks row does not open a menu')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(checkRows()).toEqual([])
    fireEvent.click(toggle)
    expect(checkRows()).toEqual(['failure|build|1m 5s|no link'])
    fireEvent.pointerDown(document.body)
    expect(checkRows()).toEqual([])
    expect(b.openLink).not.toHaveBeenCalled()
  })

  it.each([
    ['passed checks', [check('build'), check('test')], 'All 2 checks passed', ['Show 2 more (passed, skipped)']],
    ['running and skipped checks', [
      check('docs', { state: 'skipped', startedAt: null, completedAt: null }),
      check('test', { state: 'pending', completedAt: null }),
    ], '1 running', ['pending|test|Running|no link', 'Show 1 more (passed, skipped)']],
  ])('summarizes %s without an error tone', (_label, checks, text, rows) => {
    const b = card(entry(1, snapshot(1, { checks, checksRollup: 'pending' })), { expanded: true })
    expect(rowValue(b.item, en['change.row.checks']).textContent).toBe(text)
    expect(rowTone(b.item, en['change.row.checks'])).toBeNull()
    fireEvent.click(within(b.item).getByText(en['change.row.checks']))
    expect(checkRows()).toEqual(rows)
  })

  it('shows only the link actions before the first poll', () => {
    const b = card(entry(1, null), { expanded: true })
    expect(b.status.textContent).toBe('#1')
    expect(within(b.item).queryByText(en['change.row.checks'])).toBeNull()
    expect(within(b.item).queryByText('+12')).toBeNull()
    expect(b.menuItems()).toEqual([OPEN_ON_GITHUB, en['change.copy'], en['change.remove']])
    b.choose(en['change.copy'])
    expect(b.copyLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/1')
  })

  it('names an unnumbered change request by its title and opens its snapshot URL', () => {
    const b = card({ ...unserved('https://example.test/review/latest'), snapshot: snapshot(3, { url: 'https://example.test/review/latest#web' }) }, { expanded: true })
    expect(b.title()).toBe('Change 3')
    // No provider serves the URL, so the unserved notice stands in for the status.
    expect(b.status.textContent).toBe('')
    expect(b.menuButton().getAttribute('aria-label')).toBe('Actions for Change 3')
    b.choose(en['change.remove'])
    expect(b.remove).toHaveBeenCalledOnce()
    // Without a provider the action names the browser, and carries the leaving arrow.
    b.choose(en['change.view'])
    expect(b.openLink).toHaveBeenCalledWith('https://example.test/review/latest#web')
  })

  it('marks the opening action with the provider\'s mark, and with the arrow for a change request no provider serves', () => {
    const mark = 'svg[viewBox="-2 -2 28 28"]'
    const b = card(entry(1, snapshot(1)))
    fireEvent.click(b.menuButton())
    expect(screen.getByRole('menuitem', { name: OPEN_ON_GITHUB }).querySelector(mark)).not.toBeNull()
    cleanup()
    const other = card(unserved('https://example.test/review/latest'))
    fireEvent.click(other.menuButton())
    const open = screen.getByRole('menuitem', { name: en['change.view'] })
    expect([open.querySelector(mark), open.querySelector('svg') === null]).toEqual([null, false])
  })

  it('closes the actions menu on Escape', () => {
    const b = card(entry(1, snapshot(1)))
    fireEvent.click(b.menuButton())
    expect(b.menuButton().getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(b.menuButton().getAttribute('aria-expanded')).toBe('false')
  })

  it('omits removal on a surface without a Session binding', () => {
    const b = card(entry(1, snapshot(1)), { expanded: true, actions: { remove: undefined } })
    expect(b.menuItems()).toEqual([OPEN_ON_GITHUB, en['change.copy']])
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
    const markReady = vi.fn<(entry: ChangeRequestEntry) => Promise<void>>(() => pending.promise)
    const value = entry(7, snapshot(7, { draft: true, mergeReady: true }))
    const b = card(value, { expanded: true, actions: { markReady } })
    const item = (): HTMLElement => screen.getByRole('menuitem', { name: en['change.markReady'] })
    expect(within(b.item).queryByRole('button', { name: en['change.merge'] })).toBeNull()

    b.choose(en['change.markReady'])
    fireEvent.click(b.menuButton())
    expect(item().hasAttribute('disabled')).toBe(true)
    fireEvent.click(item())
    expect(markReady).toHaveBeenCalledOnce()
    expect(markReady).toHaveBeenCalledWith(value)

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(item().hasAttribute('disabled')).toBe(false)
  })

  it('lists the methods the repository allows with the usual one chosen, and merges the confirmed head with the chosen one', async () => {
    const pending = deferred()
    const merge = vi.fn<(entry: ChangeRequestEntry, request: MergeRequest) => Promise<void>>(() => pending.promise)
    const value = entry(7, snapshot(7, { mergeReady: true, mergeMethods: ['merge', 'squash', 'rebase'], headSha: head }))
    const b = card(value, { expanded: true, actions: { merge } })
    const button = within(b.item).getByRole('button', { name: en['change.merge'] })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.classList.contains(css.mergeAction ?? '')).toBe(true)
    const caret = (): Element | null => button.querySelector(`.${css.mergeCaret}`)
    expect(caret()?.classList.contains(css.mergeCaretOpen ?? '')).toBe(false)

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(caret()?.classList.contains(css.mergeCaretOpen ?? '')).toBe(true)
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
      expanded onToggle={vi.fn()} now={NOW} actions={actions} coarsePointer={false} t={t} />
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
    const merge = vi.fn<(entry: ChangeRequestEntry, request: MergeRequest) => Promise<void>>(async () => {})
    const actions: ChangeRequestActions = { openLink: vi.fn(), copyLink: vi.fn(), retry: vi.fn(), merge }
    const view = (methods: MergeRequest['method'][]) => (
      <ul>
        <ChangeRequestCard locale="en"
          entry={entry(7, snapshot(7, { mergeReady: true, mergeMethods: methods, headSha: head }))}
          expanded
          onToggle={vi.fn()}
          now={NOW}
          actions={actions}
          coarsePointer={false}
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
    const b = card(entry(7, snapshot(7, overrides)), { expanded: true, actions: { markReady: vi.fn(async () => {}) } })
    expect(b.menuItems()).not.toContain(en['change.markReady'])
    expect(within(b.item).queryByRole('button', { name: en['change.merge'] })).toBeNull()
  })

  it('offers the automatic merge of a change request the host would not merge yet, with the outlined button and the same menu', async () => {
    const pending = deferred()
    const autoMerge = vi.fn<NonNullable<ChangeRequestActions['autoMerge']>>(() => pending.promise)
    const off = { enabled: false, method: null, enabledBy: null, canEnable: true, canDisable: false }
    const value = entry(7, snapshot(7, { mergeReady: false, mergeMethods: ['squash', 'merge'], headSha: head, autoMerge: off }))
    const b = card(value, { expanded: true, actions: { autoMerge } })
    expect(within(b.item).queryByRole('button', { name: en['change.merge'] })).toBeNull()
    const button = within(b.item).getByRole('button', { name: en['change.autoMerge'] })
    expect([button.classList.contains(css.autoMergeAction ?? ''), button.classList.contains(css.mergeAction ?? '')]).toEqual([true, false])
    fireEvent.click(button)
    expect(within(screen.getByRole('menu')).getByText('Merge #7 into main once its requirements are met')).toBeTruthy()
    expect(mergeRows()).toEqual([
      'Squash and mergeCombine every commit into one ✓', 'Create a merge commitKeep every commit and add a merge commit', 'Enable auto-merge',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable auto-merge' }))
    expect(autoMerge).toHaveBeenCalledWith(value, { enabled: true, method: 'squash', headSha: head })
    expect(button.hasAttribute('disabled')).toBe(true)
    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('shows an automatic merge that is on, and cancels it where the user may', async () => {
    const autoMerge = vi.fn<NonNullable<ChangeRequestActions['autoMerge']>>(async () => {})
    const on = { enabled: true, method: 'merge' as const, enabledBy: 'mona', canEnable: false, canDisable: true }
    const value = entry(7, snapshot(7, { mergeReady: false, autoMerge: on }))
    const b = card(value, { expanded: true, actions: { autoMerge } })
    const button = within(b.item).getByRole('button', { name: en['change.autoMergeOn'] })
    expect(button.getAttribute('data-forge-auto-merge')).toBe('on')
    fireEvent.click(button)
    expect(within(screen.getByRole('menu')).getByText('Method: Create a merge commit · Enabled by mona')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel auto-merge' }))
    expect(autoMerge).toHaveBeenCalledWith(value, { enabled: false })
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => { await Promise.resolve() })
    cleanup()

    // A surface that cannot change it, and a user who may not, see the state without the cancellation.
    for (const [actions, state] of [[{}, on], [{ autoMerge }, { ...on, canDisable: false }]] as const) {
      const shown = card(entry(7, snapshot(7, { mergeReady: false, autoMerge: state })), { expanded: true, actions })
      fireEvent.click(within(shown.item).getByRole('button', { name: en['change.autoMergeOn'] }))
      expect(screen.queryByRole('menuitem', { name: 'Cancel auto-merge' })).toBeNull()
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      cleanup()
    }
  })

  it('merges now instead of showing the automatic merge once the host would merge', () => {
    const on = { enabled: true, method: 'merge' as const, enabledBy: null, canEnable: false, canDisable: true }
    const actions = { merge: vi.fn(async () => {}), autoMerge: vi.fn(async () => {}) }
    const b = card(entry(7, snapshot(7, { mergeReady: true, autoMerge: on })), { expanded: true, actions })
    expect(within(b.item).getByRole('button', { name: en['change.merge'] })).toBeTruthy()
    expect(within(b.item).queryByRole('button', { name: en['change.autoMergeOn'] })).toBeNull()
  })

  it.each([
    ['the surface cannot turn it on', {}, { mergeMethods: ['merge'] as const }],
    ['the repository allows no merge method', { autoMerge: vi.fn(async () => {}) }, { mergeMethods: [] as const }],
  ])('offers no automatic merge when %s, and no merge it cannot run', (_label, actions, overrides) => {
    const off = { enabled: false, method: null, enabledBy: null, canEnable: true, canDisable: false }
    const b = card(entry(7, snapshot(7, { mergeReady: false, autoMerge: off, ...overrides })), { expanded: true, actions })
    expect(within(b.item).queryByRole('button', { name: en['change.autoMerge'] })).toBeNull()
    // The card names no merge the host would refuse; the review page does.
    expect(within(b.item).queryByRole('button', { name: en['change.merge'] })).toBeNull()
  })

  it('offers neither action on a surface without a Session binding', () => {
    const actions = { markReady: undefined, merge: undefined }
    for (const value of [entry(7, snapshot(7, { draft: true })), entry(8, snapshot(8, { mergeReady: true }))]) {
      const b = card(value, { expanded: true, actions })
      expect(b.menuItems()).not.toContain(en['change.markReady'])
      expect(within(b.item).queryByRole('button', { name: en['change.merge'] })).toBeNull()
      cleanup()
    }
  })
})

describe('ChangeRequestCard changes', () => {
  it('opens the changes of a served change request from its diff size', () => {
    const value = entry(7, snapshot(7, { additions: 12345 }))
    const viewChanges = vi.fn<(entry: ChangeRequestEntry) => void>()
    const b = card(value, { expanded: true, actions: { viewChanges } })
    const button = within(b.item).getByRole('button', { name: 'View the changes of #7: 12,345 lines added, 3 lines deleted' })
    expect(button.textContent).toBe(`${en['change.row.changes']}+12,345${MINUS}3`)
    expect(button.querySelector(`.${css.rowChevron}`)).not.toBeNull()
    fireEvent.click(button)
    expect(viewChanges).toHaveBeenCalledWith(value)
  })

  it('shows only the diff size of a change request no provider serves', () => {
    const viewChanges = vi.fn<(entry: ChangeRequestEntry) => void>()
    const b = card({ ...unserved('https://example.test/review/9'), snapshot: snapshot(9) }, { expanded: true, actions: { viewChanges } })
    expect(within(b.item).queryByRole('button', { name: /View the changes/ })).toBeNull()
    expect(within(b.item).getByText('+12')).toBeTruthy()
  })
})

describe('ChangeRequestCard layout', () => {
  it('shows the action row only for a change request the host would merge', () => {
    const waiting = card(entry(7, snapshot(7)), { expanded: true, actions: { merge: vi.fn(async () => {}) } })
    expect(waiting.item.querySelector(`.${css.footer}`)).toBeNull()
    cleanup()
    const draft = card(entry(8, snapshot(8, { draft: true })), { expanded: true, actions: { markReady: vi.fn(async () => {}) } })
    expect(draft.item.querySelector(`.${css.footer}`)).toBeNull()
    cleanup()
    const mergeable = card(entry(9, snapshot(9, { mergeReady: true })), { expanded: true, actions: { merge: vi.fn(async () => {}) } })
    const footer = mergeable.item.querySelector(`.${css.footer}`)
    if (!(footer instanceof HTMLElement)) throw new Error('no action row')
    expect(within(footer).getByRole('button').textContent).toBe(en['change.merge'])
  })

  it('shows the changed lines of a finished change request below its end', () => {
    const b = card(entry(9, snapshot(9, { state: 'closed', closedAt: null })), { expanded: true })
    const rows = b.item.querySelector(`.${css.rows}`)
    if (!(rows instanceof HTMLElement)) throw new Error('no rows')
    expect([...rows.children].map(row => row.textContent)).toEqual([en['change.state.closed'], `${en['change.row.changes']}+12${MINUS}3`])
    expect(rows.querySelector(`.${overview.rowAnchor}`)).toBeNull()
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
      now={NOW} actions={actions} coarsePointer={false} t={t} />
    const rendered = render(view('de'))
    expect(screen.getByText('+1.234')).toBeTruthy()
    expect(screen.getByText('−5.678')).toBeTruthy()
    expect(screen.getByRole('button', { name: /1\.234.*5\.678/ })).toBeTruthy()
    rendered.rerender(view('en'))
    expect(screen.getByText('+1,234')).toBeTruthy()
    expect(screen.getByRole('button', { name: /1,234.*5,678/ })).toBeTruthy()
  })
})

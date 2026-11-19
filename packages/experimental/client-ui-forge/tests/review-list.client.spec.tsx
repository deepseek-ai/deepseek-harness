// @vitest-environment jsdom
/**
 * The review page's list column, its navigation row, and the label line: sections with their items, empty states, and
 * failures, the search box and pasted links, the filter menu, the navigation count, and labels folding into a chip.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangeRequestIssue, ChangeRequestLabel, ChangeRequestSummary } from '@deepseek-ai/dsh-experimental-forge/types'
import { en } from '../src/client/locales.ts'
import { fittingLabels, ReviewLabels } from '../src/client/review-page/ReviewLabels.tsx'
import { ReviewList, type ReviewListProps } from '../src/client/review-page/ReviewList.tsx'
import { ReviewNavCount, ReviewNavIcon, type ReviewNavCountProps } from '../src/client/review-page/ReviewNav.tsx'
import type { StreamSnapshot } from '../src/client/source.ts'
import css from '../src/client/review-page/ReviewPage.module.css'
import { ref } from './client-fixtures.client.ts'
import { failedList, frame, host, list, prUrl, summary } from './review-fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const t = makeTranslate(en)
const NOW = Date.parse('2026-10-09T00:05:00Z')

/** Render the list column with every handler recorded and no choice made, unless `overrides` makes one. */
function renderList(overrides: Partial<ReviewListProps> = {}) {
  const props: ReviewListProps = {
    frame: undefined, stopped: null, selected: null, query: '', repository: null, repositories: [], directOnly: false, folded: {}, refreshing: false,
    now: NOW, view: 'detailed',
    onSelect: vi.fn(), onSearch: vi.fn(), onScope: vi.fn(), onToggleDirect: vi.fn(), onView: vi.fn(), onFold: vi.fn(), onRefresh: vi.fn(),
    onRetry: vi.fn(), copyText: vi.fn(), t, ...overrides,
  }
  const view = render(<ReviewList {...props} />)
  /** The section of one list. */
  const section = (filter: string): HTMLElement => {
    const element = view.container.querySelector(`[data-forge-review-section="${filter}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no ${filter} section`)
    return element
  }
  /** The button of one listed change request. */
  const item = (url: string): HTMLElement => {
    const element = view.container.querySelector(`[data-forge-review-item="${url}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no item ${url}`)
    return element
  }
  return { view, props, section, item }
}

function issue(number: number): ChangeRequestIssue {
  const url = `https://github.com/octo/demo/issues/${number}`
  return { repository: ref(number).repository, number, title: `Issue ${number}`, state: 'open', url }
}

function inRepository(number: number, owner: string, name: string, overrides: Partial<ChangeRequestSummary> = {}): ChangeRequestSummary {
  return summary(number, { ref: { ...ref(number), repository: { ...ref(number).repository, owner, name } }, ...overrides })
}

describe('ReviewList states', () => {
  it('shows a skeleton until the first frame, and a retry once the list stream stopped without one', () => {
    const loading = renderList()
    const busy = loading.view.getByLabelText('Reading the lists')
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(loading.view.getByRole('heading', { name: 'Code review' })).toBeTruthy()
    // The skeleton is a heading bar above rows laid out as detailed items: a glyph, one or two title lines, and a meta line.
    expect(busy.textContent).toBe('')
    const rows = busy.querySelectorAll(`[data-forge-review-skeleton="detailed"] > .${css.skeletonItem}`)
    expect(rows).toHaveLength(6)
    expect([...rows].map(row => row.querySelectorAll(`.${css.skeletonBar}`).length)).toEqual([3, 2, 3, 2, 3, 3])
    expect(rows[0]?.querySelectorAll(`.${css.skeletonMeta}`)).toHaveLength(1)
    expect(busy.querySelector('[data-forge-review-skeleton]')?.getAttribute('aria-hidden')).toBe('true')
    expect(busy.querySelector(`.${css.skeletonHeading}`)).not.toBeNull()
    cleanup()

    // The compact view reads as one-line rows: a glyph, a title bar, and a time bar.
    const compact = renderList({ view: 'compact' })
    const lines = compact.view.getByLabelText('Reading the lists').querySelectorAll(`[data-forge-review-skeleton="compact"] > .${css.skeletonCompact}`)
    expect(lines).toHaveLength(6)
    expect(lines[0]?.querySelectorAll(`.${css.skeletonBar}`)).toHaveLength(1)
    expect(lines[0]?.querySelector(`.${css.skeletonTime}`)).not.toBeNull()
    cleanup()

    const stopped = renderList({ stopped: { code: 'ended', message: '' } })
    expect(stopped.view.getByRole('status').textContent).toContain('The list connection ended')
    fireEvent.click(stopped.view.getByRole('button', { name: 'Retry' }))
    expect(stopped.props.onRetry).toHaveBeenCalledOnce()
    cleanup()

    // A frame read before the stream stopped stays shown.
    const kept = renderList({ stopped: { code: 'ended', message: '' }, frame: frame(host({ authored: list([summary(1)]) })) })
    expect(kept.view.queryByText('The list connection ended')).toBeNull()
    expect(kept.item(prUrl(1))).toBeTruthy()
  })

  it('explains that no code host lists change requests', () => {
    const b = renderList({ frame: frame() })
    expect(b.view.getByText('No code host lists change requests')).toBeTruthy()
    expect(b.view.getByText(en['reviewPage.noHostsHint'])).toBeTruthy()
  })

  it('refreshes from the header, showing the glyph turning while a refresh or a read runs', () => {
    const idle = renderList({ frame: frame() })
    const button = idle.view.getByRole('button', { name: 'Refresh status' })
    expect(button.getAttribute('aria-disabled')).toBe('false')
    expect(button.querySelector('[data-turning]')).toBeNull()
    fireEvent.click(button)
    expect(idle.props.onRefresh).toHaveBeenCalledOnce()
    cleanup()
    const refreshing = renderList({ frame: frame(), refreshing: true })
    expect(refreshing.view.getByRole('button', { name: 'Refresh status' }).getAttribute('aria-disabled')).toBe('true')
    expect(refreshing.view.getByRole('button', { name: 'Refresh status' }).querySelector('[data-turning]')).not.toBeNull()
    cleanup()
    const reading = renderList({ frame: { ...frame(), reading: true } })
    expect(reading.view.getByRole('button', { name: 'Refresh status' }).querySelector('[data-turning]')).not.toBeNull()
  })
})

describe('ReviewList sections', () => {
  it('shows each list with its total, folds it, and marks the shown change request', () => {
    const b = renderList({
      frame: frame(host({
        'review-requested': list([summary(1), summary(2, { updatedAt: '2026-10-08T00:00:00Z' })], { total: 1200 }),
        'authored': list([summary(3)]),
        'involved': list([]),
      })),
      folded: { authored: true },
      selected: prUrl(1),
    })
    const requested = b.section('review-requested')
    const header = within(requested).getByRole('button', { name: /Review requested/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(header.textContent).toBe(`Review requested${(1200).toLocaleString()}`)
    expect(within(requested).getAllByRole('listitem')).toHaveLength(2)
    expect(b.item(prUrl(1)).getAttribute('aria-current')).toBe('true')
    expect(b.item(prUrl(2)).hasAttribute('aria-current')).toBe(false)
    expect(within(requested).getByText('1198 more not listed')).toBeTruthy()
    fireEvent.click(b.item(prUrl(2)))
    expect(b.props.onSelect).toHaveBeenCalledWith(prUrl(2))

    const authored = within(b.section('authored')).getByRole('button', { name: /Created by me/ })
    expect(authored.getAttribute('aria-expanded')).toBe('false')
    expect(authored.querySelector(`.${css.chevronClosed}`)).not.toBeNull()
    expect(within(b.section('authored')).queryByRole('listitem')).toBeNull()
    fireEvent.click(authored)
    expect(b.props.onFold).toHaveBeenCalledWith('authored')

    expect(within(b.section('involved')).getByText('No change requests')).toBeTruthy()
  })

  it('tells an empty search from an empty list and hides the cut-list note while searching', () => {
    const b = renderList({ frame: frame(host({ authored: list([summary(1)], { total: 4 }) })), query: 'zzz' })
    expect(within(b.section('authored')).getByText('No matching change requests')).toBeTruthy()
    expect(b.view.queryByText(/more not listed/)).toBeNull()
  })

  it('shows skeleton rows for a list no host has read yet, and only the failure once a read failed', () => {
    const b = renderList({ frame: frame(host({ authored: list(null), involved: failedList('unavailable', 'GitHub is down') })) })
    expect(b.section('authored').querySelectorAll(`[aria-busy="true"] .${css.skeletonItem}`)).toHaveLength(3)
    expect(within(b.section('authored')).queryByRole('button', { name: /\d/ })).toBeNull()
    const involved = b.section('involved')
    expect(involved.querySelector('[aria-busy="true"]')).toBeNull()
    expect(within(involved).getByRole('status').textContent).toBe('Couldn\'t read the list on github.com: GitHub is down')
  })

  it('asks the user to sign in to a GitHub host with a command to copy, and to other hosts without one', () => {
    const b = renderList({ frame: frame(
      host({ authored: failedList('unauthenticated') }, { host: 'ghe.example' }),
      host({ involved: failedList('unauthenticated') }, { forge: 'gitlab', host: 'gitlab.example' }),
      host({ 'review-requested': failedList('rate-limited') }),
    ) })
    const github = within(b.section('authored')).getByRole('status')
    expect(github.textContent).toContain('Sign in to ghe.example to list your change requests')
    expect(within(github).getByText('gh auth login --hostname ghe.example')).toBeTruthy()
    fireEvent.click(within(github).getByRole('button', { name: 'Copy sign-in command' }))
    expect(b.props.copyText).toHaveBeenCalledWith('gh auth login --hostname ghe.example')
    const gitlab = within(b.section('involved')).getByRole('status')
    expect(gitlab.textContent).toBe('Sign in to gitlab.example to list your change requests')
    expect(within(gitlab).queryByRole('button')).toBeNull()
    expect(within(b.section('review-requested')).getByRole('status').textContent).toBe(en['change.failure.rateLimited'])
  })
})

describe('ReviewList items', () => {
  it('names an item by its number, author, update time, closing issues, and the hint the user acts on', () => {
    const b = renderList({ frame: frame(host({
      'review-requested': list([
        summary(1, {
          viewerReview: { verdict: 'changes-requested', reviewedSha: null }, viewerRequest: { team: null }, closingIssues: [issue(5)],
        }),
        summary(2, { author: null, updatedAt: 'not a time', checksRollup: 'none', closingIssues: [issue(5), issue(6), issue(8)] }),
        summary(3, {
          viewerReview: { verdict: 'approved', reviewedSha: 'a'.repeat(40) }, closingIssues: [issue(5)], closingIssuesTruncated: true,
        }),
        summary(4, { viewerRequest: { team: 'octo/core' }, checksRollup: 'failure' }),
      ]),
    })) })
    const first = b.item(prUrl(1))
    expect(first.querySelector(`.${css.itemMeta}`)?.textContent).toBe('#1·octo·5 min ago·⊙#5·You requested changes · Requested again')
    expect(first.querySelector(`.${css.itemMeta} .${css.itemHint}`)?.textContent).toBe('You requested changes · Requested again')
    expect(first.querySelector(`.${css.itemHint}`)?.getAttribute('data-tone')).toBe('error')
    expect(first.querySelector('[data-forge-glyph]')?.getAttribute('data-tone')).toBe('open')
    expect(first.querySelector('[data-checks]')?.getAttribute('data-checks')).toBe('success')

    const second = b.item(prUrl(2))
    expect(second.querySelector(`.${css.itemMeta}`)?.textContent).toBe('#2·⊙#5and 2 more')
    expect(second.querySelector(`.${css.itemHint}`)).toBeNull()
    expect(second.querySelector('[data-checks]')).toBeNull()

    const third = b.item(prUrl(3))
    expect(third.querySelector(`.${css.itemIssues}`)?.textContent).toBe('⊙#5and 1+ more')
    expect(third.querySelector(`.${css.itemHint}`)?.getAttribute('data-tone')).toBe('success')

    const fourth = b.item(prUrl(4))
    expect(fourth.querySelector(`.${css.itemMeta}`)?.textContent).toBe('#4·octo·5 min ago·Team octo/core')
    expect(fourth.querySelector(`.${css.itemHint}`)?.textContent).toBe('Team octo/core')
    expect(fourth.querySelector(`.${css.itemHint}`)?.hasAttribute('data-tone')).toBe(false)
    expect(fourth.querySelector('[data-forge-glyph]')?.getAttribute('data-tone')).toBe('blocked')
  })

  it('names each item\'s repository once the lists span more than one', () => {
    const b = renderList({ frame: frame(host({ authored: list([summary(1), inRepository(2, 'acme', 'widgets')]) })) })
    expect(b.item(prUrl(1)).querySelector(`.${css.itemMeta}`)?.firstChild?.textContent).toBe('demo#1')
    expect(b.item(prUrl(2)).querySelector(`.${css.itemMeta}`)?.firstChild?.textContent).toBe('widgets#2')
  })
})

describe('ReviewList compact view', () => {
  it('shows each item on one line with its glyph, its title, and the short update time, and shows the chosen one', () => {
    const b = renderList({ view: 'compact', selected: prUrl(1), frame: frame(host({ authored: list([
      summary(1), summary(2, { updatedAt: 'not a time', checksRollup: 'none' }),
    ]) })) })
    expect(b.section('authored').querySelector('ul')?.getAttribute('data-view')).toBe('compact')
    const first = b.item(prUrl(1))
    expect(first.matches(`.${css.compactItem}`)).toBe(true)
    expect(first.textContent).toBe('Change 15min')
    expect(first.querySelector(`.${css.compactTime}`)?.textContent).toBe('5min')
    expect(first.getAttribute('aria-current')).toBe('true')
    expect(first.querySelector('[data-checks]')?.getAttribute('data-checks')).toBe('success')
    // The title is the shared marquee text: its inner span travels while the row is hovered.
    expect(first.querySelector(`.${css.compactTitle} > span`)?.textContent).toBe('Change 1')
    expect(first.querySelector(`.${css.itemMeta}`)).toBeNull()

    const second = b.item(prUrl(2))
    expect(second.textContent).toBe('Change 2')
    expect(second.hasAttribute('aria-current')).toBe(false)
    expect(second.querySelector('[data-checks]')).toBeNull()
    fireEvent.click(second)
    expect(b.props.onSelect).toHaveBeenCalledWith(prUrl(2))
  })

  it('names the full title and every fact of the detailed item in a hover card that copies the title', () => {
    vi.useFakeTimers()
    const b = renderList({ view: 'compact', frame: frame(host({ 'review-requested': list([
      summary(1, {
        viewerReview: { verdict: 'changes-requested', reviewedSha: null }, viewerRequest: { team: null }, closingIssues: [issue(5)],
      }),
      inRepository(2, 'acme', 'widgets', { author: null, updatedAt: 'not a time' }),
    ]) })) })
    fireEvent.pointerEnter(b.item(prUrl(1)))
    fireEvent.pointerEnter(b.item(prUrl(2)))
    act(() => { vi.advanceTimersByTime(799) })
    expect(screen.queryByRole('button', { name: /^Copy title/ })).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    const first = screen.getByRole('button', { name: 'Copy title: Change 1' })
    expect(first.querySelector(`.${css.compactCardTitle}`)?.textContent).toBe('Change 1')
    expect(first.querySelector(`.${css.itemMeta}`)?.textContent).toBe('octo/demo#1·octo·5 min ago·⊙#5')
    expect(first.querySelector(`.${css.itemHint}`)?.textContent).toBe('You requested changes · Requested again')
    expect(first.querySelector(`.${css.itemHint}`)?.getAttribute('data-tone')).toBe('error')
    const second = screen.getByRole('button', { name: 'Copy title: Change 2' })
    expect(second.querySelector(`.${css.itemMeta}`)?.textContent).toBe('acme/widgets#2')
    expect(second.querySelector(`.${css.itemHint}`)).toBeNull()
    cleanup()

    // Within one repository the card names the change request by its number alone.
    const single = renderList({ view: 'compact', frame: frame(host({ authored: list([summary(3)]) })) })
    fireEvent.pointerEnter(single.item(prUrl(3)))
    act(() => { vi.advanceTimersByTime(800) })
    const card = screen.getByRole('button', { name: 'Copy title: Change 3' })
    expect(card.querySelector(`.${css.itemMeta}`)?.textContent).toBe('#3·octo·5 min ago')
  })

  it('marquees a clipped title while the item is hovered and returns it on leave', () => {
    const b = renderList({ view: 'compact', frame: frame(host({ authored: list([summary(1)]) })) })
    const item = b.item(prUrl(1))
    const title = item.querySelector<HTMLElement>(`.${css.compactTitle}`)
    if (title === null) throw new Error('no title')
    // jsdom lays out nothing: the title's clipped geometry is stated outright.
    Object.defineProperty(title, 'scrollWidth', { value: 300, configurable: true })
    Object.defineProperty(title, 'clientWidth', { value: 100, configurable: true })
    fireEvent.pointerEnter(item)
    expect(title.dataset.marquee).toBe('')
    expect(title.style.getPropertyValue('--dsh-marquee-range')).toBe('200px')
    fireEvent.pointerLeave(item)
    expect(title.dataset.marquee).toBeUndefined()
  })
})

describe('ReviewList search', () => {
  it('reports typed text, clears it with Escape, and opens a pasted link from its row or with Enter', () => {
    const typed = renderList({ frame: frame() })
    const box = typed.view.getByRole('textbox', { name: 'Search, or paste a change request link' })
    fireEvent.change(box, { target: { value: 'parser' } })
    expect(typed.props.onSearch).toHaveBeenCalledWith('parser')
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(typed.props.onSearch).toHaveBeenCalledOnce()
    expect(typed.props.onSelect).not.toHaveBeenCalled()
    expect(typed.view.queryByRole('button', { name: /^Open / })).toBeNull()
    cleanup()

    const searching = renderList({ frame: frame(), query: 'parser' })
    fireEvent.keyDown(searching.view.getByRole('textbox'), { key: 'Escape' })
    expect(searching.props.onSearch).toHaveBeenCalledWith('')
    cleanup()

    const url = 'https://github.com/octo/demo/pull/9'
    const pasted = renderList({ frame: frame(), query: ` ${url} ` })
    fireEvent.click(pasted.view.getByRole('button', { name: `Open ${url}` }))
    fireEvent.keyDown(pasted.view.getByRole('textbox'), { key: 'Enter' })
    expect(pasted.props.onSelect).toHaveBeenCalledTimes(2)
    expect(pasted.props.onSelect).toHaveBeenNthCalledWith(1, url)
    expect(pasted.props.onSelect).toHaveBeenNthCalledWith(2, url)
  })
})

describe('ReviewList filter menu', () => {
  const lists = frame(host({ authored: list([summary(1), inRepository(2, 'acme', 'widgets')]) }))
  const CHECK = '[data-icon="dsw-icon-check-outline-regular"]'

  /** Open the menu from its button. */
  function open(b: ReturnType<typeof renderList>): HTMLElement {
    const button = b.view.getByRole('button', { name: 'Filter' })
    fireEvent.click(button)
    return button
  }

  /** The labels of the shown rows, each with whether it is marked as chosen. */
  function rows(): (readonly [string | null, boolean])[] {
    return within(document.body).getAllByRole('menuitem').map(row => [row.textContent, row.querySelector(CHECK) !== null] as const)
  }

  /** Open the repository submenu and return the labels of its rows. */
  function repositories(): (string | null)[] {
    const parent = within(document.body).getByRole('menuitem', { name: /^Repository/ })
    fireEvent.click(parent)
    expect(parent.getAttribute('aria-expanded')).toBe('true')
    const child = within(document.body).getAllByRole('menu').find(menu => !menu.contains(parent))
    if (child === undefined) throw new Error('no repository submenu')
    return within(child).getAllByRole('menuitem').map(row => row.textContent)
  }

  it('lays out the view, the repository, and the review requests, marking each choice, and closes after a choice', () => {
    const b = renderList({ frame: lists })
    const button = open(b)
    expect(button.matches(`.${css.iconButtonActive}`)).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const menu = within(document.body)
    for (const label of ['View', 'Review requests']) expect(menu.getByText(label)).toBeTruthy()
    expect(rows()).toEqual([
      ['Detailed', true], ['Compact', false], ['RepositoryAll repositories', false], ['Include team requests', true],
      ['Only requests made of me', false],
    ])
    fireEvent.click(menu.getByRole('menuitem', { name: 'Compact' }))
    expect(b.props.onView).toHaveBeenCalledWith('compact')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    cleanup()

    const compact = renderList({ frame: lists, view: 'compact' })
    open(compact)
    expect(rows().slice(0, 2)).toEqual([['Detailed', false], ['Compact', true]])
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Detailed' }))
    expect(compact.props.onView).toHaveBeenCalledWith('detailed')
  })

  it('reads the lists in one repository or in all of them from the repository submenu', () => {
    const b = renderList({ frame: lists })
    const button = open(b)
    expect(repositories()).toEqual(['All repositories', 'acme/widgets', 'octo/demo'])
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'acme/widgets' }))
    expect(b.props.onScope).toHaveBeenCalledWith({ owner: 'acme', name: 'widgets' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    open(b)
    repositories()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'All repositories' }))
    expect(b.props.onScope).toHaveBeenLastCalledWith(null)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps offering a chosen repository whose lists are empty, and names the chosen repository on its row', () => {
    const b = renderList({ frame: lists, repository: { owner: 'zeta', name: 'empty' } })
    const button = open(b)
    expect(button.matches(`.${css.iconButtonActive}`)).toBe(true)
    expect(within(document.body).getByRole('menuitem', { name: /^Repository/ }).textContent).toBe('Repositoryzeta/empty')
    expect(repositories()).toEqual(['All repositories', 'acme/widgets', 'octo/demo', 'zeta/empty'])
    cleanup()

    const listed = renderList({ frame: lists, repository: { owner: 'acme', name: 'widgets' } })
    open(listed)
    expect(within(document.body).getByRole('menuitem', { name: /^Repository/ }).textContent).toBe('Repositoryacme/widgets')
    expect(repositories()).toEqual(['All repositories', 'acme/widgets', 'octo/demo'])
  })

  it('keeps offering the repositories remembered from every repository while the lists are read in one, marking the chosen one', () => {
    const remembered = [{ owner: 'acme', name: 'widgets' }, { owner: 'octo', name: 'demo' }, { owner: 'zeta', name: 'tools' }]
    // Lists read in octo/demo name only that repository.
    const scoped = frame(host({ authored: list([summary(1)]) }))
    const b = renderList({ frame: scoped, repository: { owner: 'octo', name: 'demo' }, repositories: remembered })
    open(b)
    expect(repositories()).toEqual(['All repositories', 'acme/widgets', 'octo/demo', 'zeta/tools'])
    const child = within(document.body).getAllByRole('menu').at(-1) as HTMLElement
    expect(within(child).getAllByRole('menuitem').map(row => row.querySelector(CHECK) !== null)).toEqual([false, false, true, false])
    // Another repository is one choice away, without returning to every repository first.
    fireEvent.click(within(child).getByRole('menuitem', { name: 'zeta/tools' }))
    expect(b.props.onScope).toHaveBeenCalledWith({ owner: 'zeta', name: 'tools' })
    cleanup()

    // The offer also survives the wait for the chosen repository's first frame.
    const waiting = renderList({ repository: { owner: 'octo', name: 'demo' }, repositories: remembered })
    open(waiting)
    expect(repositories()).toEqual(['All repositories', 'acme/widgets', 'octo/demo', 'zeta/tools'])
    expect(within(document.body).queryByText('Reading the lists', { selector: '[role="menu"] *' })).toBeNull()
  })

  it('says that the lists are still read while no repository was remembered and a read is under way', () => {
    const reading = (): boolean => within(document.body).getAllByRole('menu').at(-1)?.textContent?.includes('Reading the lists') === true
    const first = renderList()
    open(first)
    expect(repositories()).toEqual(['All repositories'])
    expect(reading()).toBe(true)
    cleanup()

    const partial = renderList({ frame: { ...lists, reading: true } })
    open(partial)
    expect(repositories()).toEqual(['All repositories', 'acme/widgets', 'octo/demo'])
    expect(reading()).toBe(true)
    cleanup()

    const settled = renderList({ frame: lists })
    open(settled)
    repositories()
    expect(reading()).toBe(false)
  })

  it('toggles requests made only of the user\'s teams only when the reader picks the other choice', () => {
    const b = renderList({ frame: lists })
    open(b)
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Include team requests' }))
    expect(b.props.onToggleDirect).not.toHaveBeenCalled()
    open(b)
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Only requests made of me' }))
    expect(b.props.onToggleDirect).toHaveBeenCalledOnce()
    cleanup()

    const direct = renderList({ frame: lists, directOnly: true })
    const button = open(direct)
    expect(button.matches(`.${css.iconButtonActive}`)).toBe(true)
    expect(rows().slice(3)).toEqual([['Include team requests', false], ['Only requests made of me', true]])
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Only requests made of me' }))
    expect(direct.props.onToggleDirect).not.toHaveBeenCalled()
    open(direct)
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Include team requests' }))
    expect(direct.props.onToggleDirect).toHaveBeenCalledOnce()
  })
})

describe('ReviewNav', () => {
  it('draws the change request glyph at the size the sidebar asks for', () => {
    const owner = { size: 20, active: true }
    const view = render(<ReviewNavIcon {...owner as PropsRuntime<'sidebar.panellist'>} />)
    expect(view.container.querySelector('svg')?.getAttribute('width')).toBe('20')
    expect(view.container.querySelector('[data-forge-glyph]')?.getAttribute('data-tone')).toBe('open')
  })

  it('counts the requests that ask for the user\'s review, at most 99 spelled out, and nothing before a count or at zero', () => {
    const count = createSnapshotStore<StreamSnapshot<number | null>>({ state: null, disconnected: false })
    const props = { useCount: bindSnapshotSelector(count), wide: false, active: false, t }
    const view = render(<ReviewNavCount {...props as ReviewNavCountProps} />)
    expect(view.container.textContent).toBe('')
    act(() => { count.set({ state: 0, disconnected: false }) })
    expect(view.container.textContent).toBe('')
    act(() => { count.set({ state: 7, disconnected: false }) })
    expect(view.container.textContent).toBe('77 change requests await your review')
    expect(view.container.querySelector('[data-wide]')).toBeNull()
    act(() => { count.set({ state: 120, disconnected: false }) })
    view.rerender(<ReviewNavCount {...{ ...props, wide: true } as ReviewNavCountProps} />)
    expect(view.container.querySelector('[aria-hidden="true"]')?.textContent).toBe('99+')
    expect(view.container.querySelector('[data-wide]')).not.toBeNull()
    expect(screen.getByText('120 change requests await your review')).toBeTruthy()
  })
})

describe('fittingLabels', () => {
  it('shows every label that fits the line, or the labels that end before the chip', () => {
    expect(fittingLabels([40, 40], 80, 30)).toBe(2)
    expect(fittingLabels([40, 40, 40], 100, 30)).toBe(1)
    expect(fittingLabels([90, 40], 100, 30)).toBe(0)
    expect(fittingLabels([], 0, 30)).toBe(0)
  })
})

describe('ReviewLabels', () => {
  const labels: ChangeRequestLabel[] = [
    { name: 'bug', color: 'd73a4a' }, { name: 'docs', color: 'FFFFFF' }, { name: 'plain', color: null }, { name: 'odd', color: 'blue' },
  ]

  it('draws nothing without labels', () => {
    expect(render(<ReviewLabels labels={[]} truncated={false} t={t} />).container.innerHTML).toBe('')
  })

  it('draws each label in the host\'s color with readable text, and names every label for assistive technology', () => {
    const view = render(<ReviewLabels labels={labels} truncated={false} t={t} />)
    const group = view.getByRole('group', { name: 'All labels: bug, docs, plain, odd' })
    const chips = [...group.querySelectorAll<HTMLElement>('[data-forge-label]')]
    expect(chips.map(chip => [chip.textContent, chip.style.background, chip.style.color])).toEqual([
      ['bug', 'rgb(215, 58, 74)', 'rgb(255, 255, 255)'],
      ['docs', 'rgb(255, 255, 255)', 'rgb(31, 35, 40)'],
      ['plain', '', ''],
      ['odd', '', ''],
    ])
    expect(chips.some(chip => chip.hasAttribute('data-hidden'))).toBe(false)
    expect(group.querySelector('[data-forge-label-more]')).toBeNull()
  })

  it('offers a chip naming every label when the host has more than it listed', () => {
    const view = render(<ReviewLabels labels={labels.slice(0, 1)} truncated t={t} />)
    const chip = view.getByRole('button', { name: 'All labels: bug' })
    expect(chip.textContent).toBe('+0+')
  })

  it('folds the labels that do not fit into a +N chip and measures again when the line resizes', () => {
    const widths = new Map([['bug', 50], ['docs', 50], ['plain', 50], ['odd', 50]])
    let line = 120
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-forge-label-more')) return 30
      return widths.get(this.textContent ?? '') ?? 0
    })
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => line)
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = computed(element, pseudo)
      if (element.getAttribute('role') === 'group') style.columnGap = '4px'
      return style
    })
    let resized: () => void = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe = vi.fn()
      disconnect = disconnect
    })
    const view = render(<ReviewLabels labels={labels} truncated={false} t={t} />)
    const hidden = (): (string | null)[] => [...view.container.querySelectorAll('[data-hidden]')].map(chip => chip.textContent)
    // Each label takes 54px; before the chip is drawn it reserves 36px and the gap.
    expect(hidden()).toEqual(['docs', 'plain', 'odd'])
    expect(view.getByRole('button', { name: 'All labels: bug, docs, plain, odd' }).textContent).toBe('+3')
    line = 200
    act(() => { resized() })
    expect(hidden()).toEqual(['odd'])
    expect(view.getByRole('button', { name: /All labels/ }).textContent).toBe('+1')
    line = 216
    act(() => { resized() })
    expect(hidden()).toEqual([])
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})

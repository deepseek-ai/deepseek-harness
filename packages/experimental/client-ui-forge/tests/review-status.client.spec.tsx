// @vitest-environment jsdom
/**
 * The status column of the review page's summary: the merge block, the checks block with its fold, complete read, and
 * rerun, the reviewers block with its fold and review requests, the changes block, and a finished change request.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChangeRequestReviewer, ChangeRequestSnapshot, ForgeCheckId, ForgeReviewerCandidate } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ChangeRequestActions } from '../src/client/ChangeRequestCard.tsx'
import { en } from '../src/client/locales.ts'
import css from '../src/client/review-page/ReviewPage.module.css'
import { ReviewStatus } from '../src/client/review-page/ReviewStatus.tsx'
import { check, snapshot } from './client-fixtures.client.ts'
import { reviewed } from './review-fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = makeTranslate(en)
const HEAD = 'a'.repeat(40)
const NOW = Date.parse('2026-10-09T02:00:00Z')

function reviewer(login: string, overrides: Partial<ChangeRequestReviewer> = {}): ChangeRequestReviewer {
  return { kind: 'user', login, avatarUrl: null, requested: false, codeOwner: false, verdict: null, reviewedSha: null, ...overrides }
}

/**
 * Render the status column of #7 with the given snapshot, the actions a surface offers besides links, and whether the
 * primary pointer is coarse.
 */
function renderStatus(value: ChangeRequestSnapshot, actions: Partial<ChangeRequestActions> = {}, coarsePointer = false) {
  const openLink = vi.fn<(url: string) => void>()
  const full: ChangeRequestActions = { openLink, copyLink: vi.fn(), retry: vi.fn(), ...actions }
  const frame = reviewed(7, value)
  const column = (next: ChangeRequestSnapshot): React.ReactNode => (
    <ReviewStatus frame={reviewed(7, next)} snapshot={next} name="#7" now={NOW} actions={full} locale="en"
      coarsePointer={coarsePointer} t={t} />
  )
  const view = render(column(value))
  const block = (name: 'merge' | 'checks' | 'reviewers' | 'changes' | 'finished'): HTMLElement => {
    const found = view.container.querySelector(`[data-forge-review-${name}]`)
    if (!(found instanceof HTMLElement)) throw new Error(`no ${name} block`)
    return found
  }
  return { view, frame, openLink, block, rerender: (next: ChangeRequestSnapshot) => { view.rerender(column(next)) } }
}

/** Let pending promises and the timers of a reviewer search settle. */
async function wait(ms = 0): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

describe('ReviewStatus blocks', () => {
  it('shows the merge state, the checks, the reviewers, and the changes of an open change request, in that order', () => {
    const b = renderStatus(snapshot(7, { closingIssues: [{ repository: snapshot(7).ref.repository, number: 3, title: 'Bug', url: 'https://github.com/octo/demo/issues/3', state: 'open' }] }))
    expect([...b.view.container.children].map(child => Object.keys((child as HTMLElement).dataset)[0])).toEqual([
      'forgeReviewMerge', 'forgeReviewChecks', 'forgeReviewReviewers', 'forgeReviewChanges',
    ])
    expect(b.block('merge').textContent).toContain('No conflicts')
    expect(b.block('merge').hasAttribute('data-tone')).toBe(false)
    expect(b.block('changes').textContent).toContain('+12')
    expect(b.block('changes').querySelector('[data-forge-closing-issues]')?.textContent).toContain('#3')
  })

  it('tints the merge block when the change request conflicts with its base', () => {
    const b = renderStatus(snapshot(7, { mergeability: 'conflicting' }))
    expect(b.block('merge').getAttribute('data-tone')).toBe('error')
    expect(b.block('merge').textContent).toContain('Conflicts with main')
  })

  it('shows how a finished change request ended with its changes, and its reviewers without an outcome or a request', () => {
    const merged = snapshot(7, {
      state: 'merged', closedAt: '2026-10-09T01:00:00Z', canRequestReviews: true, reviewDecision: 'approved',
      reviewers: [reviewer('mona', { verdict: 'approved', reviewedSha: HEAD })],
    })
    const b = renderStatus(merged, { requestReviews: vi.fn(async () => {}), reviewerCandidates: vi.fn(async () => []) })
    expect(b.block('finished').textContent).toContain('Merged into main')
    expect(b.block('finished').textContent).toContain('+12')
    expect(b.view.container.querySelector('[data-forge-review-merge], [data-forge-review-checks]')).toBeNull()
    const reviewers = b.block('reviewers')
    expect(reviewers.querySelector('h3')?.textContent).toBe('Review')
    expect(reviewers.querySelector('[data-forge-reviewer="mona"]')?.textContent).toContain('Approved')
    expect(reviewers.querySelector('[data-forge-review-request]')).toBeNull()
    cleanup()

    const closed = renderStatus(snapshot(7, { state: 'closed' }))
    expect(closed.view.container.querySelector('[data-forge-review-reviewers]')).toBeNull()
  })
})

describe('ReviewStatus checks', () => {
  it('says that there are no checks', () => {
    const b = renderStatus(snapshot(7))
    expect(b.block('checks').querySelector('h3')?.textContent).toBe('ChecksNo checks')
    expect(b.block('checks').querySelector(`.${css.statusList}`)).toBeNull()
  })

  it('lists the checks that need attention, opens a check\'s page, and lists every check by group on request', () => {
    const checks = [
      check('lint', { state: 'failure', url: 'https://ci.example/lint' }), check('e2e', { state: 'pending' }),
      check('deploy', { state: 'cancelled', url: null }), check('unit'), check('docs', { state: 'skipped' }),
    ]
    const b = renderStatus(snapshot(7, { checks, checksRollup: 'failure' }))
    const block = b.block('checks')
    const summary = block.querySelector(`.${css.statusSummary}`)
    expect(summary?.textContent).toBe('1 failed · 1 running · 1 cancelled')
    expect(summary?.getAttribute('data-tone')).toBe('error')
    const items = (): string[] => [...block.querySelectorAll('[data-forge-check-item]')].map(item => item.getAttribute('data-forge-check-item') ?? '')
    expect(items()).toEqual(['failure', 'pending', 'cancelled'])
    expect(block.querySelector('[data-forge-check-group]')).toBeNull()
    fireEvent.click(within(block).getByRole('button', { name: /lint/ }))
    expect(b.openLink).toHaveBeenCalledWith('https://ci.example/lint')
    // A check without a page is no button.
    expect(within(block).queryByRole('button', { name: /deploy/ })).toBeNull()

    const fold = within(block).getByRole('button', { name: 'Show all 5' })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    // The chevron points down to list everything and up to fold again.
    expect(fold.querySelector('[data-forge-review-fold]')?.getAttribute('data-forge-review-fold')).toBe('more')
    fireEvent.click(fold)
    expect(within(block).getByRole('button', { name: 'Show less' }).querySelector('[data-forge-review-fold]')?.getAttribute('data-forge-review-fold'))
      .toBe('less')
    expect([...block.querySelectorAll('[data-forge-check-group]')].map(group => group.getAttribute('data-forge-check-group')))
      .toEqual(['failed', 'running', 'cancelled', 'passed', 'other'])
    expect(within(block).getByRole('group', { name: 'Passed' }).textContent).toContain('Passed · 1')
    expect(items()).toHaveLength(5)
    fireEvent.click(within(block).getByRole('button', { name: 'Show less' }))
    expect(items()).toHaveLength(3)
  })

  it('lists no check and no tone when every check passed, and offers no fold when the attention list is the whole list', () => {
    const passed = renderStatus(snapshot(7, { checks: [check('unit'), check('lint')] }))
    const block = passed.block('checks')
    expect(block.querySelector(`.${css.statusSummary}`)?.textContent).toBe('All 2 checks passed')
    expect(block.querySelector(`.${css.statusSummary}`)?.hasAttribute('data-tone')).toBe(false)
    expect(block.querySelector('[data-forge-check-item]')).toBeNull()
    expect(within(block).getByRole('button', { name: 'Show all 2' })).toBeTruthy()
    cleanup()

    const failed = renderStatus(snapshot(7, { checks: [check('lint', { state: 'failure' })], checksRollup: 'failure' }))
    expect(within(failed.block('checks')).queryByRole('button', { name: /Show all/ })).toBeNull()
  })

  it('folds the attention list after five checks', () => {
    const checks = Array.from({ length: 7 }, (_, index) => check(`job ${index}`, { state: 'failure' }))
    const b = renderStatus(snapshot(7, { checks, checksRollup: 'failure' }))
    expect(b.block('checks').querySelectorAll('[data-forge-check-item]')).toHaveLength(5)
    fireEvent.click(within(b.block('checks')).getByRole('button', { name: 'Show all 7' }))
    expect(b.block('checks').querySelectorAll('[data-forge-check-item]')).toHaveLength(7)
  })

  it('reruns the failed checks, one rerun at a time, and starts afresh for a new head', async () => {
    const done = Promise.withResolvers<undefined>()
    const rerunChecks = vi.fn<NonNullable<ChangeRequestActions['rerunChecks']>>(() => done.promise)
    const failed = check('lint', { state: 'failure', rerun: 'actions:7' as ForgeCheckId })
    const value = snapshot(7, { checks: [failed, check('unit')], checksRollup: 'failure', canRerunChecks: true })
    const b = renderStatus(value, { rerunChecks })
    const rerun = within(b.block('checks')).getByRole('button', { name: 'Rerun failed' })
    fireEvent.click(rerun)
    expect(rerunChecks).toHaveBeenCalledWith(b.frame, { headSha: HEAD })
    expect(rerun.hasAttribute('disabled')).toBe(true)
    await act(async () => { done.resolve(undefined); await Promise.resolve() })
    expect(rerun.hasAttribute('disabled')).toBe(false)

    fireEvent.click(within(b.block('checks')).getByRole('button', { name: 'Show all 2' }))
    expect(b.block('checks').querySelector('[data-forge-check-group]')).not.toBeNull()
    b.rerender({ ...value, headSha: 'b'.repeat(40) })
    expect(b.block('checks').querySelector('[data-forge-check-group]')).toBeNull()
    cleanup()

    const refused = renderStatus({ ...value, canRerunChecks: false }, { rerunChecks })
    expect(within(refused.block('checks')).queryByRole('button', { name: 'Rerun failed' })).toBeNull()
  })

  it('completes a check list the poll read in part while the block shows, and offers to read again after a failure', async () => {
    const partial = snapshot(7, { checks: [check('unit')], checksTruncated: true })
    const complete = { ...partial, checks: [check('unit'), check('lint', { state: 'failure' })], checksTruncated: false, checksRollup: 'failure' as const }
    const readChecks = vi.fn<NonNullable<ChangeRequestActions['readChecks']>>()
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(complete)
    const b = renderStatus(partial, { readChecks })
    const block = b.block('checks')
    expect(block.querySelector(`.${css.statusSummary}`)?.hasAttribute('data-tone')).toBe(false)
    expect(within(block).getByRole('status').textContent).toBe('Loading more checks')
    await wait()
    expect(readChecks).toHaveBeenCalledWith(partial.url, HEAD, expect.any(AbortSignal))
    expect(within(block).getByRole('status').textContent).toContain('Could not load more checks: offline')
    fireEvent.click(within(block).getByRole('button', { name: 'Retry loading checks' }))
    await wait()
    expect(within(block).queryByRole('status')).toBeNull()
    expect(block.querySelector(`.${css.statusSummary}`)?.textContent).toBe('1 failed')
    expect(block.querySelectorAll('[data-forge-check-item="failure"]')).toHaveLength(1)
  })
})

describe('ReviewStatus reviewers', () => {
  it('shows the outcome and each reviewer, folds after five, and opens the host for a list read in part', () => {
    const reviewers = [
      reviewer('mona', { verdict: 'approved', reviewedSha: HEAD }), reviewer('lin', { requested: true }),
      reviewer('core', { kind: 'team', requested: true }), reviewer('bot', { kind: 'bot', verdict: 'commented' }),
      reviewer('kai', { verdict: 'changes-requested' }), reviewer('zed', { codeOwner: true, requested: true }),
    ]
    const value = snapshot(7, { reviewers, reviewDecision: 'changes-requested', reviewersTruncated: true })
    const b = renderStatus(value)
    const block = b.block('reviewers')
    const summary = block.querySelector(`.${css.statusSummary}`)
    expect(summary?.textContent).toBe('Changes requested')
    expect(summary?.getAttribute('data-tone')).toBe('error')
    const listed = (): (string | null)[] => [...block.querySelectorAll('[data-forge-reviewer]')].map(line => line.getAttribute('data-forge-reviewer'))
    expect(listed()).toEqual(['mona', 'lin', 'core', 'bot', 'kai'])
    fireEvent.click(within(block).getByRole('button', { name: 'Show all 6' }))
    expect(listed()).toHaveLength(6)
    fireEvent.click(within(block).getByRole('button', { name: en['reviewers.truncated'] }))
    expect(b.openLink).toHaveBeenCalledWith(value.url)
    // Without the permission to request reviews, the block offers none.
    expect(block.querySelector('[data-forge-review-request]')).toBeNull()
  })

  it('shows only the outcome when there is no reviewer and no review can be requested', () => {
    const b = renderStatus(snapshot(7, { canRequestReviews: true }), { requestReviews: vi.fn(async () => {}) })
    expect(b.block('reviewers').querySelector('h3')?.textContent).toBe('ReviewNo review requested')
    expect(b.block('reviewers').querySelector(`.${css.statusList}`)).toBeNull()
  })

  it('asks a reviewer again or searches for someone else from the request menu, one request at a time', async () => {
    const done = Promise.withResolvers<undefined>()
    const requestReviews = vi.fn<NonNullable<ChangeRequestActions['requestReviews']>>(() => done.promise)
    const candidates: ForgeReviewerCandidate[] = [{ login: 'ada', name: 'Ada', avatarUrl: null, suggested: true }]
    const reviewerCandidates = vi.fn<NonNullable<ChangeRequestActions['reviewerCandidates']>>(async () => candidates)
    const value = snapshot(7, { canRequestReviews: true, reviewers: [reviewer('mona', { verdict: 'commented' })] })
    const b = renderStatus(value, { requestReviews, reviewerCandidates }, true)
    const request = b.block('reviewers').querySelector('[data-forge-review-request]') as HTMLElement
    expect(request.textContent).toBe('Request a review')

    fireEvent.click(request)
    expect(request.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(request)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(request)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Re-request a review from mona' }))
    expect(requestReviews).toHaveBeenCalledWith(b.frame, [value.reviewers[0]])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(request.hasAttribute('disabled')).toBe(true)
    await act(async () => { done.resolve(undefined); await Promise.resolve() })
    expect(request.hasAttribute('disabled')).toBe(false)

    fireEvent.click(request)
    fireEvent.click(screen.getByRole('menuitem', { name: en['reviewers.requestMore'] }))
    await wait()
    fireEvent.click(screen.getByRole('menuitem', { name: /ada/ }))
    expect(requestReviews).toHaveBeenLastCalledWith(b.frame, [{ kind: 'user', login: 'ada' }])
    expect(screen.queryByRole('menu')).toBeNull()
    // The menu opens on the reviewers again, not on the search it was left in.
    await act(async () => { await Promise.resolve() })
    fireEvent.click(request)
    expect(screen.getByRole('menuitem', { name: 'Re-request a review from mona' })).toBeTruthy()
  })

  it('opens the search at once when no reviewer can be asked again, leaving its field unfocused on a coarse pointer', async () => {
    const reviewerCandidates = vi.fn<NonNullable<ChangeRequestActions['reviewerCandidates']>>(async () => [])
    const b = renderStatus(snapshot(7, { canRequestReviews: true }), { requestReviews: vi.fn(async () => {}), reviewerCandidates }, true)
    fireEvent.click(b.block('reviewers').querySelector('[data-forge-review-request]') as HTMLElement)
    await wait()
    const field = screen.getByRole('textbox', { name: en['reviewers.search'] })
    expect(document.activeElement).not.toBe(field)
    expect(reviewerCandidates).toHaveBeenCalledWith(snapshot(7).url, '', expect.any(AbortSignal))
  })
})

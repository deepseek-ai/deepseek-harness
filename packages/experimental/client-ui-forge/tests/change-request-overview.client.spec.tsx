// @vitest-environment jsdom
/**
 * Overview rows of an expanded change request card: rerunning failed checks, the reviewers and review requests, the branch
 * update, and linked issues.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ChangeRequestReviewer, ChangeRequestSnapshot, ForgeCheckId, ForgeReviewerCandidate,
} from '@deepseek-ai/dsh-experimental-forge/types'
import { ChangeRequestCard, type ChangeRequestActions } from '../src/client/ChangeRequestCard.tsx'
import { en } from '../src/client/locales.ts'
import css from '../src/client/ForgeTab.module.css'
import overview from '../src/client/ChangeRequestOverview.module.css'
import { check, entry, snapshot } from './client-fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = makeTranslate(en)
const HEAD = 'a'.repeat(40)

function card(value: ChangeRequestSnapshot, actions: Partial<ChangeRequestActions> = {}) {
  const openLink = vi.fn<(url: string) => void>()
  const full: ChangeRequestActions = { openLink, copyLink: vi.fn(), retry: vi.fn(), ...actions }
  const subject = entry(value.ref.number, value)
  const view = render(
    <ul><ChangeRequestCard locale="en" entry={subject} expanded onToggle={vi.fn()} now={0} actions={full} t={t} /></ul>,
  )
  const item = view.container.querySelector('[data-forge-change]')
  if (!(item instanceof HTMLElement)) throw new Error('no card')
  const rerender = (next: ChangeRequestSnapshot): void => {
    view.rerender(<ul><ChangeRequestCard locale="en" entry={entry(next.ref.number, next)} expanded onToggle={vi.fn()} now={0} actions={full} t={t} /></ul>)
  }
  return { view, item, subject, openLink, rerender }
}

function reviewer(login: string, overrides: Partial<ChangeRequestReviewer> = {}): ChangeRequestReviewer {
  return { kind: 'user', login, avatarUrl: null, requested: false, codeOwner: false, verdict: null, reviewedSha: null, ...overrides }
}

/** Settle pending promises and timers of a search. */
async function wait(ms = 0): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

describe('rerunning failed checks', () => {
  const failed = check('lint', { state: 'failure', rerun: 'actions:7' as ForgeCheckId })

  it('offers to rerun the failed checks that name a rerun, and runs one rerun at a time', async () => {
    const done = Promise.withResolvers<undefined>()
    const rerunChecks = vi.fn<NonNullable<ChangeRequestActions['rerunChecks']>>(() => done.promise)
    // A check still running under another rerun leaves this one free.
    const running = check('e2e', { state: 'pending', rerun: 'actions:8' as ForgeCheckId })
    const b = card(snapshot(7, { checks: [failed, running], checksRollup: 'failure', canRerunChecks: true }), { rerunChecks })
    const row = b.item.querySelector('[data-forge-checks]') as HTMLElement
    fireEvent.click(row)
    fireEvent.click(screen.getByRole('menuitem', { name: en['checks.rerunFailed'] }))
    expect(rerunChecks).toHaveBeenCalledWith(b.subject, { headSha: HEAD })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(row)
    expect(screen.getByRole('menuitem', { name: en['checks.rerunFailed'] }).hasAttribute('disabled')).toBe(true)
    await act(async () => { done.resolve(undefined); await Promise.resolve() })
    expect(screen.getByRole('menuitem', { name: en['checks.rerunFailed'] }).hasAttribute('disabled')).toBe(false)
  })

  it.each([
    ['the viewer may not rerun checks', { canRerunChecks: false }, true],
    ['no failed check names a rerun', { checks: [check('lint', { state: 'failure' }), check('test', { rerun: 'actions:7' as ForgeCheckId })] }, true],
    ['every failed check waits for a check of its rerun still in progress',
      { checks: [failed, check('e2e', { state: 'pending', rerun: 'actions:7' as ForgeCheckId })] }, true],
    ['the surface cannot rerun checks', {}, false],
  ])('does not offer it when %s', (_label, overrides, withAction) => {
    const b = card(snapshot(7, { checks: [failed], checksRollup: 'failure', canRerunChecks: true, ...overrides }),
      withAction ? { rerunChecks: vi.fn() } : {})
    fireEvent.click(b.item.querySelector('[data-forge-checks]') as HTMLElement)
    expect(screen.queryByRole('menuitem', { name: en['checks.rerunFailed'] })).toBeNull()
  })

  it('opens a menu for a list the poll read only in part, though none of it was read yet', () => {
    const b = card(snapshot(7, { checks: [], checksTruncated: true, checksRollup: 'none' }))
    const row = b.item.querySelector('[data-forge-checks]') as HTMLElement
    expect(row.querySelector('[data-forge-check]')?.getAttribute('data-forge-check')).toBe('neutral')
    fireEvent.click(row)
    expect(screen.getByRole('menu')).toBeDefined()
  })

  it('lists only skipped checks on request with the skipped glyph', () => {
    const b = card(snapshot(7, { checks: [check('docs', { state: 'skipped' })], checksRollup: 'success' }))
    fireEvent.click(b.item.querySelector('[data-forge-checks]') as HTMLElement)
    const more = screen.getByRole('menuitem', { name: 'Show 1 more (passed, skipped)' })
    expect(more.querySelector('[data-forge-check]')?.getAttribute('data-forge-check')).toBe('skipped')
  })
})

describe('reviewers', () => {
  const list = [
    reviewer('lin', { requested: true, avatarUrl: 'https://avatars.example/lin' }),
    reviewer('octo/forge', { kind: 'team', requested: true, codeOwner: true }),
    reviewer('review-bot', { kind: 'bot', verdict: 'commented', reviewedSha: HEAD }),
    reviewer('zhou', { verdict: 'changes-requested', reviewedSha: 'b'.repeat(40) }),
    reviewer('qian', { verdict: 'approved', reviewedSha: HEAD }),
    reviewer('wang', { verdict: 'dismissed', reviewedSha: null }),
  ]
  const lines = (): string[] => [...document.querySelectorAll('[data-forge-reviewer]')].map(line => line.textContent ?? '')

  it('shows the first avatars and counts the rest, falling back to an initial when an image fails', () => {
    const b = card(snapshot(7, { reviewers: list, reviewDecision: 'review-required' }))
    const avatars = b.item.querySelector(`.${overview.avatars}`) as HTMLElement
    expect([...avatars.children].map(node => node.tagName === 'IMG' ? 'img' : node.textContent)).toEqual(['img', 'O', 'R', '+3'])
    fireEvent.error(avatars.querySelector('img') as HTMLImageElement)
    expect(avatars.firstElementChild?.textContent).toBe('L')
  })

  it('lists each reviewer with their kind, outcome, and an outcome on an older commit, read only without the right to request', () => {
    const b = card(snapshot(7, { reviewers: list }))
    fireEvent.click(b.item.querySelector('[data-forge-review]') as HTMLElement)
    // Without an avatar image, a line starts with the login's initial.
    expect(lines()).toEqual([
      'linAwaiting review', 'Oocto/forgeCode ownerAwaiting review', 'Rreview-botBotCommented', 'ZzhouChanges requestedBefore the latest commit',
      'QqianApproved', 'WwangDismissed',
    ])
    const tones = [...document.querySelectorAll(`.${overview.outcome} > span:first-child`)].map(node => node.getAttribute('data-tone'))
    expect(tones).toEqual(['pending', 'pending', null, 'error', 'success', null])
    expect(screen.queryAllByRole('menuitem')).toEqual([])
  })

  it('names a team that is not a code owner as a team', () => {
    const b = card(snapshot(7, { reviewers: [reviewer('octo/docs', { kind: 'team', verdict: 'approved', reviewedSha: HEAD })] }))
    fireEvent.click(b.item.querySelector('[data-forge-review]') as HTMLElement)
    expect(lines()).toEqual(['Oocto/docsTeamApproved'])
  })

  it('asks a reviewer again, leaving out bots and pending requests, and requests one review at a time', async () => {
    const done = Promise.withResolvers<undefined>()
    const requestReviews = vi.fn<NonNullable<ChangeRequestActions['requestReviews']>>(() => done.promise)
    const b = card(snapshot(7, { reviewers: list, canRequestReviews: true }), { requestReviews, reviewerCandidates: vi.fn() })
    const row = b.item.querySelector('[data-forge-review]') as HTMLButtonElement
    fireEvent.click(row)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Re-request a review from zhou', 'Re-request a review from qian', 'Re-request a review from wang', en['reviewers.requestMore'],
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Re-request a review from zhou' }))
    expect(requestReviews).toHaveBeenCalledWith(b.subject, [list[3]])
    expect(row.disabled).toBe(true)
    await act(async () => { done.resolve(undefined); await Promise.resolve() })
    expect(row.disabled).toBe(false)
  })

  it('opens the change request for reviewers it did not read, and states that there are none yet', () => {
    const b = card(snapshot(7, { reviewers: [], reviewersTruncated: true, canRequestReviews: true }), {
      requestReviews: vi.fn(), reviewerCandidates: vi.fn(),
    })
    fireEvent.click(b.item.querySelector('[data-forge-review]') as HTMLElement)
    expect(screen.getByText(en['reviewers.none'])).toBeDefined()
    fireEvent.click(screen.getByRole('menuitem', { name: en['reviewers.truncated'] }))
    expect(b.openLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7')
  })

  it.each([
    ['no reviewers and no right to request', { reviewers: [] }, {}],
    ['the right without the surface\'s actions', { reviewers: [], canRequestReviews: true }, { requestReviews: vi.fn() }],
  ])('opens nothing with %s', (_label, overrides, actions) => {
    const b = card(snapshot(7, overrides), actions)
    expect(b.item.querySelector('[data-forge-review]')).toBeNull()
    expect(within(b.item).getByText(en['change.row.review']).closest('button')).toBeNull()
  })

  it('searches accounts to request a review from, the suggestions first, and requests the chosen one', async () => {
    const requestReviews = vi.fn<NonNullable<ChangeRequestActions['requestReviews']>>(async () => {})
    const people: ForgeReviewerCandidate[] = [
      { login: 'lin', name: 'Lin', avatarUrl: null, suggested: true },
      { login: 'mona', name: 'mona', avatarUrl: null, suggested: false },
    ]
    const reviewerCandidates = vi.fn<NonNullable<ChangeRequestActions['reviewerCandidates']>>()
      .mockResolvedValueOnce(people)
      .mockResolvedValueOnce([people[1]!])
    const b = card(snapshot(7, { canRequestReviews: true }), { requestReviews, reviewerCandidates })
    fireEvent.click(b.item.querySelector('[data-forge-review]') as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: en['reviewers.requestMore'] }))
    expect(screen.getByRole('status').textContent).toBe(en['reviewers.loading'])
    await wait()
    expect(reviewerCandidates).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7', '', expect.any(AbortSignal))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['LlinLinSuggested', 'Mmona'])
    fireEvent.change(screen.getByRole('textbox', { name: en['reviewers.search'] }), { target: { value: 'mo' } })
    await wait(200)
    expect(reviewerCandidates).toHaveBeenLastCalledWith('https://github.com/octo/demo/pull/7', 'mo', expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('menuitem', { name: 'mona' }))
    expect(requestReviews).toHaveBeenCalledWith(b.subject, [{ kind: 'user', login: 'mona' }])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('picks the first account with Enter, keeps arrow and edge keys in the field, and leaves composition alone', async () => {
    const requestReviews = vi.fn<NonNullable<ChangeRequestActions['requestReviews']>>(async () => {})
    const reviewerCandidates = vi.fn<NonNullable<ChangeRequestActions['reviewerCandidates']>>(async () => [
      { login: 'lin', name: null, avatarUrl: null, suggested: false },
    ])
    const b = card(snapshot(7, { canRequestReviews: true }), { requestReviews, reviewerCandidates })
    fireEvent.click(b.item.querySelector('[data-forge-review]') as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: en['reviewers.requestMore'] }))
    const field = screen.getByRole('textbox', { name: en['reviewers.search'] })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(requestReviews).not.toHaveBeenCalled()
    await wait()
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight', 'a']) fireEvent.keyDown(field, { key })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(requestReviews).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(requestReviews).toHaveBeenCalledWith(b.subject, [{ kind: 'user', login: 'lin' }])
  })

  it('chooses nothing with Enter until the listing of the current query arrives', async () => {
    const requestReviews = vi.fn<NonNullable<ChangeRequestActions['requestReviews']>>(async () => {})
    const bob = Promise.withResolvers<readonly ForgeReviewerCandidate[]>()
    const reviewerCandidates = vi.fn<NonNullable<ChangeRequestActions['reviewerCandidates']>>()
      .mockResolvedValueOnce([{ login: 'alice', name: null, avatarUrl: null, suggested: true }])
      .mockReturnValueOnce(bob.promise)
    const b = card(snapshot(7, { canRequestReviews: true }), { requestReviews, reviewerCandidates })
    fireEvent.click(b.item.querySelector('[data-forge-review]') as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: en['reviewers.requestMore'] }))
    await wait()
    const field = screen.getByRole('textbox', { name: en['reviewers.search'] })
    fireEvent.change(field, { target: { value: 'bob' } })
    // The earlier listing is gone at once, before the search delay ends.
    expect(screen.getByRole('status').textContent).toBe(en['reviewers.loading'])
    expect(screen.queryByRole('menuitem', { name: /alice/ })).toBeNull()
    fireEvent.keyDown(field, { key: 'Enter' })
    await wait(200)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(requestReviews).not.toHaveBeenCalled()
    await act(async () => { bob.resolve([{ login: 'bob', name: null, avatarUrl: null, suggested: false }]); await Promise.resolve() })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(requestReviews).toHaveBeenCalledWith(b.subject, [{ kind: 'user', login: 'bob' }])
  })

  it('reports an empty or failed listing, retries, and ignores a listing that arrives after the menu closed', async () => {
    const late = Promise.withResolvers<readonly ForgeReviewerCandidate[]>()
    const reviewerCandidates = vi.fn<NonNullable<ChangeRequestActions['reviewerCandidates']>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(late.promise)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const b = card(snapshot(7, { canRequestReviews: true }), { requestReviews: vi.fn(), reviewerCandidates })
    const row = b.item.querySelector('[data-forge-review]') as HTMLElement
    fireEvent.click(row)
    fireEvent.click(screen.getByRole('menuitem', { name: en['reviewers.requestMore'] }))
    await wait()
    expect(screen.getByText(en['reviewers.loadFailed'])).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await wait()
    expect(screen.getByText(en['reviewers.empty'])).toBeDefined()
    // A touch screen keeps its keyboard closed, so the field is not focused.
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: en['reviewers.search'] }))
    fireEvent.change(screen.getByRole('textbox', { name: en['reviewers.search'] }), { target: { value: 'x' } })
    await wait(200)
    fireEvent.click(row)
    await act(async () => { late.resolve([{ login: 'late', name: null, avatarUrl: null, suggested: false }]); await Promise.resolve() })
    late.promise.catch(() => {})
    expect(screen.queryByText('late')).toBeNull()
  })

  it('ignores a failed listing that arrives after the menu closed', async () => {
    const late = Promise.withResolvers<readonly ForgeReviewerCandidate[]>()
    const b = card(snapshot(7, { canRequestReviews: true }), { requestReviews: vi.fn(), reviewerCandidates: vi.fn(() => late.promise) })
    const row = b.item.querySelector('[data-forge-review]') as HTMLElement
    fireEvent.click(row)
    fireEvent.click(screen.getByRole('menuitem', { name: en['reviewers.requestMore'] }))
    await wait()
    fireEvent.click(row)
    await act(async () => { late.reject(new Error('late')); await Promise.resolve() })
    expect(screen.queryByText(en['reviewers.loadFailed'])).toBeNull()
  })
})

describe('branch updates', () => {
  const behind = (overrides: Partial<ChangeRequestSnapshot> = {}) => snapshot(7, { branchUpdates: ['merge', 'rebase'], ...overrides })

  it('states that the head is behind and updates it with the chosen method at the confirmed head', async () => {
    const done = Promise.withResolvers<undefined>()
    const updateBranch = vi.fn<NonNullable<ChangeRequestActions['updateBranch']>>(() => done.promise)
    const b = card(behind(), { updateBranch })
    const row = b.item.querySelector('[data-forge-update-branch]') as HTMLButtonElement
    expect(row.textContent).toBe(`${en['change.row.merge']}No conflicts · Behind main${en['branch.update']}`)
    fireEvent.click(row)
    expect(screen.getByText('Update feat with new commits from main')).toBeDefined()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Update with rebase/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['branch.confirm'] }))
    expect(updateBranch).toHaveBeenCalledWith(b.subject, { method: 'rebase', headSha: HEAD })
    expect(row.disabled).toBe(true)
    await act(async () => { done.resolve(undefined); await Promise.resolve() })
    expect(row.disabled).toBe(false)
  })

  it('refuses the confirmation once the head moved after the menu opened, and falls back to the usual method', () => {
    const updateBranch = vi.fn<NonNullable<ChangeRequestActions['updateBranch']>>(async () => {})
    const b = card(behind(), { updateBranch })
    const row = (): HTMLElement => b.item.querySelector('[data-forge-update-branch]') as HTMLElement
    fireEvent.click(row())
    fireEvent.click(screen.getByRole('menuitem', { name: /^Update with rebase/ }))
    b.rerender(behind({ headSha: 'b'.repeat(40), branchUpdates: ['merge'] }))
    const confirm = screen.getByRole('menuitem', { name: en['branch.changed'] })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.click(row())
    fireEvent.click(row())
    fireEvent.click(screen.getByRole('menuitem', { name: en['branch.confirm'] }))
    expect(updateBranch).toHaveBeenCalledWith(expect.anything(), { method: 'merge', headSha: 'b'.repeat(40) })
  })

  it('closes the menu with Escape without updating', () => {
    const updateBranch = vi.fn<NonNullable<ChangeRequestActions['updateBranch']>>()
    const b = card(behind(), { updateBranch })
    fireEvent.click(b.item.querySelector('[data-forge-update-branch]') as HTMLElement)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(updateBranch).not.toHaveBeenCalled()
  })

  it.each([
    ['the head is up to date', snapshot(7), true],
    ['the surface cannot update branches', behind(), false],
  ])('offers no update when %s', (_label, value, withAction) => {
    const b = card(value, withAction ? { updateBranch: vi.fn() } : {})
    expect(b.item.querySelector('[data-forge-update-branch]')).toBeNull()
    expect(within(b.item).getByText(en['change.row.merge']).closest('button')).toBeNull()
  })
})

describe('linked issues', () => {
  const issue = (number: number, owner: string, name: string, state: 'open' | 'closed' = 'open') => ({
    repository: { forge: 'github', host: 'github.com', owner, name }, number, title: `Issue ${number}`, state,
    url: `https://github.com/${owner}/${name}/issues/${number}`,
  })

  it('links each issue by its number, naming its repository when it is another one, and notes more than were read', () => {
    const b = card(snapshot(7, { closingIssues: [issue(6, 'Octo', 'Demo'), issue(2, 'octo', 'tracker', 'closed')], closingIssuesTruncated: true }))
    const row = b.item.querySelector('[data-forge-closing-issues]') as HTMLElement
    expect(row.textContent).toBe('Linked issues #6, octo/tracker#2 and more')
    const links = within(row).getAllByRole('link')
    expect(links.map(link => [link.getAttribute('aria-label'), link.getAttribute('data-state')])).toEqual([
      ['Open issue #6: Issue 6', 'open'], ['Open issue octo/tracker#2: Issue 2', 'closed'],
    ])
    fireEvent.click(links[1]!)
    expect(b.openLink).toHaveBeenCalledWith('https://github.com/octo/tracker/issues/2')
    expect(links[0]?.className).toBe(overview.issue)
    expect(row.querySelector(`.${css.visuallyHidden}`)).toBeNull()
  })

  it('shows no row without linked issues', () => {
    expect(card(snapshot(7)).item.querySelector('[data-forge-closing-issues]')).toBeNull()
  })
})

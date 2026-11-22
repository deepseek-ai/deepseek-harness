/**
 * The review page's list helpers and store: list sections and their search, the repositories the lists name, item hints
 * and tones, pasted links, description Markdown, and the page's choices.
 */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ChangeRequestSummary } from '@deepseek-ai/dsh-experimental-forge/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TextSearchIndex } from '@deepseek-ai/dsh-util-text-search'
import {
  descriptionMarkdown, mergeRepositories, pastedUrl, REVIEW_FILTERS, reviewHint, reviewListsComplete, reviewRepositories, reviewSearchKeys,
  reviewSections, summaryTone,
} from '../src/client/review-page/review-lists.ts'
import { createReviewStore } from '../src/client/review-page/review-store.ts'
import { ref } from './client-fixtures.client.ts'
import { failedList, frame, host, list, summary } from './review-fixtures.client.ts'

/** A summary of pull request `number` in `owner/name`. */
function inRepository(number: number, owner: string, name: string, overrides: Partial<ChangeRequestSummary> = {}): ChangeRequestSummary {
  return summary(number, { ref: { ...ref(number), repository: { ...ref(number).repository, owner, name } }, ...overrides })
}

/** The URLs of each section's items, by list. */
function urls(sections: ReturnType<typeof reviewSections>): Record<string, readonly string[] | null> {
  return Object.fromEntries(sections.map(section => [section.filter, section.items?.map(item => item.summary.url) ?? null]))
}

describe('reviewSections', () => {
  it('shows no section before the first frame', () => {
    expect(reviewSections(undefined, false)).toEqual([])
  })

  it('shows one section per offered list in page order, newest first, summing totals over hosts and marking cut lists', () => {
    const older = summary(1, { updatedAt: '2026-10-01T00:00:00Z' })
    const newer = summary(2, { updatedAt: '2026-10-05T00:00:00Z' })
    const middle = summary(4, { updatedAt: '2026-10-03T00:00:00Z' })
    const requested = summary(3)
    const sections = reviewSections(frame(
      host({ 'authored': list([older, newer], { total: 5 }), 'review-requested': list([requested]) }),
      host({ authored: list([middle]) }, { forge: 'gitlab', host: 'gitlab.example' }),
    ), false)
    expect(REVIEW_FILTERS).toEqual(['review-requested', 'authored', 'involved'])
    expect(sections.map(section => section.filter)).toEqual(['review-requested', 'authored'])
    expect(sections[1]?.items?.map(item => [item.summary.ref.number, item.forge, item.host])).toEqual([
      [2, 'github', 'github.com'], [4, 'gitlab', 'gitlab.example'], [1, 'github', 'github.com'],
    ])
    expect(sections[1]).toMatchObject({ total: 6, truncated: true, failure: null })
    expect(sections[0]).toMatchObject({ total: 1, truncated: false, failure: null })
  })

  it('reports the first failure of any host, keeping the items a host read and null items before any host read the list', () => {
    const sections = reviewSections(frame(
      host({
        involved: list([summary(1)], { failure: { code: 'rate-limited', message: 'slow down' } }), authored: failedList('unauthenticated'),
      }),
      host({ involved: failedList('unavailable'), authored: failedList('unavailable') }, { host: 'ghe.example' }),
    ), false)
    expect(urls(sections)).toEqual({ authored: null, involved: ['https://github.com/octo/demo/pull/1'] })
    expect(sections.map(section => section.failure)).toEqual([
      { host: 'github.com', forge: 'github', failure: { code: 'unauthenticated', message: 'down' } },
      { host: 'github.com', forge: 'github', failure: { code: 'rate-limited', message: 'slow down' } },
    ])
    expect(sections[0]).toMatchObject({ total: 0, truncated: false })
  })

  it('leaves out review requests made only of one of the user\'s teams from the review-requested list when asked', () => {
    const team = summary(1, { viewerRequest: { team: 'octo/core' } })
    const direct = summary(2, { viewerRequest: { team: null }, updatedAt: '2026-10-08T00:00:00Z' })
    const none = summary(3, { updatedAt: '2026-10-07T00:00:00Z' })
    const lists = frame(host({ 'review-requested': list([team, direct, none]), 'authored': list([team]) }))
    expect(urls(reviewSections(lists, true))).toEqual({
      'review-requested': ['https://github.com/octo/demo/pull/2', 'https://github.com/octo/demo/pull/3'],
      'authored': ['https://github.com/octo/demo/pull/1'],
    })
    expect(reviewSections(lists, false)[0]?.items).toHaveLength(3)
  })

  it('offers the title, the number, the repository, and the author to the shared list search', () => {
    const parser = summary(11, { title: 'Fix the Parser' })
    const widgets = inRepository(22, 'Acme', 'Widgets', { title: 'Tidy up' })
    const mona = summary(33, { title: 'Docs', author: { login: 'Mona', avatarUrl: null, bot: true } })
    const hidden = summary(44, { title: 'Hidden author', author: null })
    const lists = frame(host({ involved: list([parser, widgets, mona, hidden]) }))
    const [section] = reviewSections(lists, false)
    const index = new TextSearchIndex(section?.items ?? [], reviewSearchKeys)
    const search = (query: string): number[] => index.search(query).map(item => item.summary.ref.number)
    expect(search(' PARSER ')).toEqual([11])
    expect(search('#22')).toEqual([22])
    expect(search('22')).toEqual([22])
    expect(search('acme/wid')).toEqual([22])
    expect(search('mon')).toEqual([33])
    // A fuzzy subsequence from a word start finds a title, as the client search rule lets it.
    expect(search('tdy')).toEqual([22])
    expect(search('fix docs')).toEqual([])
    expect(search('zzz')).toEqual([])
    expect(search('   ')).toEqual([11, 22, 33, 44])
    // The section keeps every item and the whole list's size; the search only narrows what shows.
    expect(section).toMatchObject({ total: 4 })
    expect(section?.items).toHaveLength(4)
  })
})

describe('reviewListsComplete', () => {
  it('holds once no read is in flight and no list is unread or failed', () => {
    expect(reviewListsComplete(undefined)).toBe(false)
    expect(reviewListsComplete(frame(host({ authored: list([summary(1)]), involved: list([]) })))).toBe(true)
    expect(reviewListsComplete({ ...frame(host({ authored: list([summary(1)]) })), reading: true })).toBe(false)
    expect(reviewListsComplete(frame(host({ authored: list([summary(1)]), involved: list(null) })))).toBe(false)
    expect(reviewListsComplete(frame(host({ authored: list([summary(1)], { failure: { code: 'unavailable', message: 'down' } }) })))).toBe(false)
  })
})

describe('mergeRepositories', () => {
  it('merges lists without duplicates, whatever their case, by owner then name', () => {
    expect(mergeRepositories()).toEqual([])
    expect(mergeRepositories(
      [{ owner: 'octo', name: 'demo' }, { owner: 'acme', name: 'widgets' }], [{ owner: 'Octo', name: 'Demo' }], [{ owner: 'acme', name: 'gears' }],
    )).toEqual([{ owner: 'acme', name: 'gears' }, { owner: 'acme', name: 'widgets' }, { owner: 'Octo', name: 'Demo' }])
  })
})

describe('reviewRepositories', () => {
  it('lists each repository the lists name once, by owner then name, skipping lists not read yet', () => {
    expect(reviewRepositories(undefined)).toEqual([])
    const repositories = reviewRepositories(frame(
      host({ authored: list([summary(1), inRepository(2, 'Octo', 'Demo')]), involved: failedList('unavailable') }),
      host({ 'review-requested': list([inRepository(3, 'acme', 'widgets')]) }, { host: 'ghe.example' }),
    ))
    expect(repositories).toEqual([{ owner: 'acme', name: 'widgets' }, { owner: 'Octo', name: 'Demo' }])
  })
})

describe('reviewHint', () => {
  const approved = { verdict: 'approved', reviewedSha: 'a'.repeat(40) } as const
  const changesRequested = { verdict: 'changes-requested', reviewedSha: null } as const
  it.each([
    ['a review asked again after the user requested changes', { viewerReview: changesRequested, viewerRequest: { team: null } },
      'involved', { key: 'reviewPage.hint.rerequested', params: {}, tone: 'error' }],
    ['a review asked of a team', { viewerReview: changesRequested, viewerRequest: { team: 'octo/core' } },
      'review-requested', { key: 'reviewPage.hint.rerequested', params: {}, tone: 'error' }],
    ['a review asked only of a team', { viewerRequest: { team: 'octo/core' } }, 'review-requested',
      { key: 'reviewPage.hint.team', params: { team: 'octo/core' }, tone: undefined }],
    ['the user\'s approval of the head', { viewerReview: approved, viewerRequest: { team: null } }, 'involved',
      { key: 'reviewPage.hint.approvedByYou', params: {}, tone: 'success' }],
    ['a draft the user approved at an older commit', { viewerReview: { ...approved, reviewedSha: 'b'.repeat(40) }, draft: true },
      'involved',
      { key: 'change.state.draft', params: {}, tone: undefined }],
    ['the user\'s own changes requested', { reviewDecision: 'changes-requested', viewerReview: changesRequested },
      'authored', { key: 'reviewPage.hint.changesRequested', params: {}, tone: 'error' }],
    ['the user\'s own approved change request', { reviewDecision: 'approved' }, 'authored',
      { key: 'reviewPage.hint.approved', params: {}, tone: 'success' }],
  ] as const)('names %s', (_label, overrides, filter, hint) => {
    expect(reviewHint(summary(7, overrides), filter)).toEqual(hint)
  })

  it('names nothing for a review decision outside the user\'s own lists, or without a decision', () => {
    expect(reviewHint(summary(7, { reviewDecision: 'approved' }), 'involved')).toBeUndefined()
    expect(reviewHint(summary(7, { reviewDecision: 'review-required' }), 'authored')).toBeUndefined()
  })
})

describe('summaryTone', () => {
  it('draws a listed change request as open, draft, or blocked', () => {
    expect(summaryTone(summary(7))).toBe('open')
    expect(summaryTone(summary(7, { draft: true }))).toBe('draft')
    expect(summaryTone(summary(7, { checksRollup: 'failure' }))).toBe('blocked')
    expect(summaryTone(summary(7, { reviewDecision: 'changes-requested' }))).toBe('blocked')
  })
})

describe('pastedUrl', () => {
  it('reads one absolute HTTP(S) URL as a link to open and other text as a search', () => {
    expect(pastedUrl('  https://github.com/octo/demo/pull/7 ')).toBe('https://github.com/octo/demo/pull/7')
    expect(pastedUrl('HTTP://GitHub.com/octo')).toBe('http://github.com/octo')
    expect(pastedUrl('github.com/octo/demo/pull/7')).toBeUndefined()
    expect(pastedUrl('https://github.com/a https://github.com/b')).toBeUndefined()
    expect(pastedUrl('http://[not-a-host')).toBeUndefined()
  })
})

describe('descriptionMarkdown', () => {
  it('turns HTML images into Markdown images with their alternative text and loads signed attachments from their signed URLs', () => {
    const body = [
      'Before <img width="200" alt="Screen [shot]" src="https://github.com/user-attachments/assets/1"> after',
      '<IMG src=\'https://example.test/b.png\' alt=\'Diagram\'/>',
      '<img src="https://example.test/c.png">',
      '![kept](https://github.com/user-attachments/assets/1)',
    ].join('\n')
    expect(descriptionMarkdown(body, { 'https://github.com/user-attachments/assets/1': 'https://signed.test/1?jwt=x' })).toBe([
      'Before ![Screen shot](https://signed.test/1?jwt=x) after',
      '![Diagram](https://example.test/b.png)',
      '![](https://example.test/c.png)',
      '![kept](https://signed.test/1?jwt=x)',
    ].join('\n'))
    expect(descriptionMarkdown('Plain <b>text</b>', {})).toBe('Plain <b>text</b>')
  })
})

describe('createReviewStore', () => {
  it('starts with nothing selected and records the reader\'s choices, its conversations, and the changes view\'s choices', () => {
    const store = createReviewStore().create()
    const { actions } = store
    expect(store.getSnapshot()).toEqual({
      selected: null, tab: 'summary', listHidden: false, folded: {}, repository: null, repositories: [], query: '', directOnly: false,
      conversations: {}, view: 'detailed', unseenQuotes: {}, byTab: {},
    })
    actions.tabbed('chat')
    actions.select('https://github.com/octo/demo/pull/7')
    expect(store.getSnapshot()).toMatchObject({ selected: 'https://github.com/octo/demo/pull/7', tab: 'summary' })
    actions.tabbed('changes')
    actions.toggledList()
    actions.folded('authored')
    actions.scopedTo({ owner: 'octo', name: 'demo' })
    actions.searched('parser')
    actions.toggledDirect()
    expect(store.getSnapshot()).toMatchObject({
      tab: 'changes', listHidden: true, folded: { authored: true }, repository: { owner: 'octo', name: 'demo' }, query: 'parser',
      directOnly: true,
    })
    actions.folded('authored')
    actions.toggledList()
    actions.toggledDirect()
    actions.scopedTo(null)
    expect(store.getSnapshot()).toMatchObject({ listHidden: false, folded: { authored: false }, repository: null, directOnly: false })

    const first = brandString<SessionId>('s1')
    const second = brandString<SessionId>('s2')
    actions.conversed('https://github.com/octo/demo/pull/7', first)
    actions.conversed('https://github.com/octo/demo/pull/8', second)
    actions.conversed('https://github.com/octo/demo/pull/7', null)
    expect(store.getSnapshot().conversations).toEqual({ 'https://github.com/octo/demo/pull/8': second })

    actions.navigated('review:https://github.com/octo/demo/pull/7', 1)
    actions.toggledSplit('review:https://github.com/octo/demo/pull/7')
    expect(store.getSnapshot().byTab['review:https://github.com/octo/demo/pull/7']).toMatchObject({ split: false, navigated: 1 })
  })

  it('records the repositories of every repository\'s lists: a read under way adds to the record, a complete read replaces it', () => {
    const store = createReviewStore().create()
    const { actions } = store
    const demo = { owner: 'octo', name: 'demo' }
    const widgets = { owner: 'acme', name: 'widgets' }
    actions.listed([demo], false)
    actions.listed([widgets], false)
    expect(store.getSnapshot().repositories).toEqual([widgets, demo])
    const recorded = store.getSnapshot().repositories
    // The same repositories again leave the record as it is.
    actions.listed([demo, widgets], true)
    expect(store.getSnapshot().repositories).toBe(recorded)
    actions.listed([demo], true)
    expect(store.getSnapshot().repositories).toEqual([demo])
    actions.listed([{ owner: 'octo', name: 'other' }], true)
    expect(store.getSnapshot().repositories).toEqual([{ owner: 'octo', name: 'other' }])
  })

  it('shows the list in the view the reader chose', () => {
    const store = createReviewStore().create()
    store.actions.viewed('compact')
    expect(store.getSnapshot().view).toBe('compact')
    store.actions.viewed('detailed')
    expect(store.getSnapshot().view).toBe('detailed')
  })

  it('counts the quotes added to each change request\'s conversation until its chat tab shows', () => {
    const store = createReviewStore().create()
    const { actions } = store
    const seven = 'https://github.com/octo/demo/pull/7'
    const eight = 'https://github.com/octo/demo/pull/8'
    actions.quoted(seven)
    actions.select(seven)
    actions.quoted(seven)
    actions.tabbed('changes')
    actions.quoted(eight)
    expect(store.getSnapshot().unseenQuotes).toEqual({ [seven]: 2, [eight]: 1 })

    actions.tabbed('chat')
    expect(store.getSnapshot().unseenQuotes).toEqual({ [seven]: 0, [eight]: 1 })
    // A quote into the conversation the reader is looking at is seen at once; another change request's still counts.
    actions.quoted(seven)
    actions.quoted(eight)
    expect(store.getSnapshot().unseenQuotes).toEqual({ [seven]: 0, [eight]: 2 })

    // With nothing selected the chat tab clears no count.
    actions.select(null)
    actions.tabbed('chat')
    expect(store.getSnapshot().unseenQuotes).toEqual({ [seven]: 0, [eight]: 2 })
  })
})

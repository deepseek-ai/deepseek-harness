/**
 * What the review page's list column shows from the Host's list frames: one section per list with the items that match
 * the search, the hint each item carries, the repositories the lists name, and the failure each section reports.
 */

import type { ChangeRequestSummary, ForgeFailure, ForgeViewerFilter } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeReviewFrame } from '../types.ts'
import type { ForgePanelKey } from './locales.ts'
import { toneOf, type ChangeRequestTone } from './status.ts'

/** The lists in the order the page shows them. */
export const REVIEW_FILTERS: readonly ForgeViewerFilter[] = ['review-requested', 'authored', 'involved']

/** One listed change request with the host it was listed on. */
export interface ReviewItem {
  /** The change request. */
  readonly summary: ChangeRequestSummary
  /** Forge family of the provider that listed it. */
  readonly forge: string
  /** Host it was listed on. */
  readonly host: string
}

/** One list section. */
export interface ReviewSection {
  /** The list. */
  readonly filter: ForgeViewerFilter
  /** Items matching the search, most recently updated first; null before any host read the list. */
  readonly items: readonly ReviewItem[] | null
  /** Size of the whole list summed over the hosts read. */
  readonly total: number
  /** Whether some host listed fewer change requests than its total. */
  readonly truncated: boolean
  /** The first failure of the latest read on any host, or null. */
  readonly failure: { readonly host: string; readonly forge: string; readonly failure: ForgeFailure } | null
}

/** A repository the lists name. */
export interface ReviewRepository {
  /** Owner or namespace. */
  readonly owner: string
  /** Repository name. */
  readonly name: string
}

/**
 * Build the list sections from one frame.
 * @param frame - the latest frame, or undefined before the first.
 * @param query - search text; matches the title, the number, the repository, and the author, ignoring case.
 * @param directOnly - whether the review-requested list leaves out requests made only of one of the user's teams.
 * @returns one section per list some host offers, in page order.
 */
export function reviewSections(frame: ForgeReviewFrame | undefined, query: string, directOnly: boolean): readonly ReviewSection[] {
  if (frame === undefined) return []
  const needle = query.trim().toLowerCase()
  const sections: ReviewSection[] = []
  for (const filter of REVIEW_FILTERS) {
    const hosts = frame.hosts.filter(host => host.lists[filter] !== undefined)
    if (hosts.length === 0) continue
    let items: ReviewItem[] | null = null
    let total = 0
    let truncated = false
    let failure: ReviewSection['failure'] = null
    for (const host of hosts) {
      const list = host.lists[filter]
      if (list === undefined) continue
      if (list.failure !== null && failure === null) failure = { host: host.host, forge: host.forge, failure: list.failure }
      if (list.items === null) continue
      total += list.total
      truncated ||= list.total > list.items.length
      items ??= []
      for (const summary of list.items) {
        if (filter === 'review-requested' && directOnly && summary.viewerRequest !== null && summary.viewerRequest.team !== null) continue
        if (needle === '' || matches(summary, needle)) items.push({ summary, forge: host.forge, host: host.host })
      }
    }
    items?.sort((left, right) => Date.parse(right.summary.updatedAt) - Date.parse(left.summary.updatedAt))
    sections.push({ filter, items, total, truncated, failure })
  }
  return sections
}

function matches(summary: ChangeRequestSummary, needle: string): boolean {
  const { repository, number } = summary.ref
  return summary.title.toLowerCase().includes(needle)
    || `#${number}`.includes(needle) || String(number) === needle
    || `${repository.owner}/${repository.name}`.toLowerCase().includes(needle)
    || (summary.author?.login.toLowerCase().includes(needle) ?? false)
}

/**
 * List the repositories the lists name, by owner then name.
 * @param frame - the latest frame, or undefined before the first.
 * @returns distinct repositories.
 */
export function reviewRepositories(frame: ForgeReviewFrame | undefined): readonly ReviewRepository[] {
  const seen = new Map<string, ReviewRepository>()
  for (const host of frame?.hosts ?? []) {
    for (const list of Object.values(host.lists)) {
      for (const { ref: { repository: { owner, name } } } of list.items ?? []) {
        seen.set(`${owner}/${name}`.toLowerCase(), { owner, name })
      }
    }
  }
  return [...seen.values()].sort((left, right) => `${left.owner}/${left.name}`.localeCompare(`${right.owner}/${right.name}`))
}

/** The hint an item carries: a dictionary key and its values. */
export interface ReviewHint {
  /** Dictionary key of the hint text. */
  readonly key: ForgePanelKey
  /** Values interpolated into the text. */
  readonly params: Readonly<Record<string, string>>
  /** `error` for a hint that asks for the user's action, `success` for an approval, otherwise none. */
  readonly tone: 'error' | 'success' | undefined
}

/**
 * Pick the one hint an item shows, most urgent first: the user requested changes and a review is asked again, a review
 * asked of one of the user's teams, the user approved the latest commit, a draft, and on the user's own change
 * requests the review decision.
 * @param summary - the item.
 * @param filter - the list the item shows in.
 * @returns the hint, or undefined without one.
 */
export function reviewHint(summary: ChangeRequestSummary, filter: ForgeViewerFilter): ReviewHint | undefined {
  const { viewerReview, viewerRequest } = summary
  if (viewerReview?.verdict === 'changes-requested' && viewerRequest !== null) {
    return { key: 'reviewPage.hint.rerequested', params: {}, tone: 'error' }
  }
  if (viewerRequest !== null && viewerRequest.team !== null) {
    return { key: 'reviewPage.hint.team', params: { team: viewerRequest.team }, tone: undefined }
  }
  if (viewerReview?.verdict === 'approved' && viewerReview.reviewedSha === summary.headSha) {
    return { key: 'reviewPage.hint.approvedByYou', params: {}, tone: 'success' }
  }
  if (summary.draft) return { key: 'change.state.draft', params: {}, tone: undefined }
  if (filter !== 'authored') return undefined
  if (summary.reviewDecision === 'changes-requested') return { key: 'reviewPage.hint.changesRequested', params: {}, tone: 'error' }
  if (summary.reviewDecision === 'approved') return { key: 'reviewPage.hint.approved', params: {}, tone: 'success' }
  return undefined
}

/**
 * The tone of a listed change request, which is open, as its glyph draws it.
 * @param summary - the item.
 * @returns the tone.
 */
export function summaryTone(summary: ChangeRequestSummary): ChangeRequestTone {
  return toneOf({ state: 'open', draft: summary.draft, checksRollup: summary.checksRollup, reviewDecision: summary.reviewDecision,
    mergeability: 'unknown' })
}

/**
 * Read the search text as a change request URL to open directly.
 * @param query - search text.
 * @returns the URL, or undefined when the text is not one absolute HTTP(S) URL.
 */
export function pastedUrl(query: string): string | undefined {
  const text = query.trim()
  if (!/^https?:\/\/\S+$/i.test(text)) return undefined
  try {
    return new URL(text).href
  } catch (error) {
    void error // Text that only looks like a URL is searched for instead.
    return undefined
  }
}

/** An HTML image tag with its source in double or single quotes. */
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi

/**
 * Prepare a change request description for Markdown rendering: an HTML image becomes a Markdown image, which the
 * renderer shows while it drops other HTML, and each attachment address the host signed is replaced by its signed URL.
 * @param body - the description as written.
 * @param images - signed URL of each attachment address.
 * @returns the Markdown to render.
 */
export function descriptionMarkdown(body: string, images: Readonly<Record<string, string>>): string {
  const markdown = body.replace(HTML_IMAGE, (tag: string, double?: string, single?: string) => {
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
    const text = (alt?.[1] ?? alt?.[2] ?? '').replace(/[[\]]/g, '')
    return `![${text}](${double ?? single ?? ''})`
  })
  let replaced = markdown
  for (const [address, signed] of Object.entries(images)) replaced = replaced.split(address).join(signed)
  return replaced
}

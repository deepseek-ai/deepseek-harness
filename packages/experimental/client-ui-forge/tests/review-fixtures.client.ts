/** Review page frame builders shared by the browser-side review page tests. */

import type {
  ChangeRequestDescription, ChangeRequestKey, ChangeRequestSnapshot, ChangeRequestSummary, ForgeDescription, ForgeFailure,
  ForgeViewerFilter,
} from '@deepseek-ai/dsh-experimental-forge/types'
import { vi } from 'vitest'
import type { HostStream } from '../src/client/source.ts'
import type { ForgeReviewChangeRequest, ForgeReviewFrame, ForgeReviewHost, ForgeReviewList } from '../src/types.ts'
import { ref, snapshot } from './client-fixtures.client.ts'

/** Web URL of pull request `number` in `octo/demo` on github.com. */
export function prUrl(number: number): string {
  return `https://github.com/octo/demo/pull/${number}`
}

/**
 * Open pull request `number` in `octo/demo` by `octo` with passed checks and no review, updated `2026-10-09T00:00:00Z`,
 * that asks nothing of the signed-in user.
 */
export function summary(number: number, overrides: Partial<ChangeRequestSummary> = {}): ChangeRequestSummary {
  return {
    ref: ref(number),
    url: prUrl(number),
    title: `Change ${number}`,
    draft: false,
    author: { login: 'octo', avatarUrl: null, bot: false },
    headSha: 'a'.repeat(40),
    checksRollup: 'success',
    reviewDecision: 'none',
    viewerReview: null,
    viewerRequest: null,
    updatedAt: '2026-10-09T00:00:00Z',
    ...overrides,
  }
}

/** A list read once that holds `items` and reports their count as its total. */
export function list(items: readonly ChangeRequestSummary[] | null, overrides: Partial<ForgeReviewList> = {}): ForgeReviewList {
  return { items, total: items?.length ?? 0, fetchedAt: items === null ? null : 1, failure: null, ...overrides }
}

/** A list whose reads have all failed with `code`. */
export function failedList(code: ForgeFailure['code'], message = 'down'): ForgeReviewList {
  return list(null, { failure: { code, message } })
}

/** The github.com host of the `github` forge offering `lists`. */
export function host(
  lists: Partial<Record<ForgeViewerFilter, ForgeReviewList>>, overrides: Partial<ForgeReviewHost> = {},
): ForgeReviewHost {
  return { forge: 'github', host: 'github.com', viewer: 'octo', signIn: null, lists, ...overrides }
}

/** A frame of `hosts` with no read in flight. */
export function frame(...hosts: readonly ForgeReviewHost[]): ForgeReviewFrame {
  return { hosts, reading: false }
}

/** The description of a change request created `2026-10-01T00:00:00Z` with `body`, no labels, and no signed images. */
export function description(body: string, overrides: Partial<ChangeRequestDescription> = {}): ChangeRequestDescription {
  return { body, labels: [], labelsTruncated: false, images: {}, imagesExpireAt: null, createdAt: '2026-10-01T00:00:00Z', ...overrides }
}

/** How the GitHub provider names itself and its change requests. */
export const GITHUB: ForgeDescription = { forge: 'github', label: 'GitHub', changeRequestNoun: 'pull-request' }

/** The review page's frame of pull request `number` whose latest poll returned `status`, or that has not been polled yet. */
export function reviewed(number: number, status: ChangeRequestSnapshot | ForgeFailure | null = snapshot(number)): ForgeReviewChangeRequest {
  const key = `github:github.com/octo/demo#${number}` as ChangeRequestKey
  const base = { url: prUrl(number), ref: ref(number), forge: GITHUB, reviewRevision: 0 }
  if (status === null) return { ...base, update: null, snapshot: null }
  if ('code' in status) return { ...base, update: { key, fetchedAt: 1, failure: status }, snapshot: null }
  return { ...base, update: { key, fetchedAt: 1, snapshot: status }, snapshot: status }
}

/** A Host stream the test feeds, ends, or fails by hand; it keeps delivering after `dispose` so late frames can be observed. */
export interface Fed<F> extends HostStream<F> {
  readonly key: string
  readonly signal: AbortSignal
  readonly disposed: ReturnType<typeof vi.fn>
  push(frame: F): void
  end(): void
  fail(error: unknown): void
}

/** A {@link Fed} stream opened for `key` under `signal`. */
export function fed<F>(key: string, signal: AbortSignal): Fed<F> {
  const queue: ({ kind: 'frame'; frame: F } | { kind: 'end' } | { kind: 'fail'; error: unknown })[] = []
  let wake: (() => void) | undefined
  const add = (item: (typeof queue)[number]): void => { queue.push(item); wake?.() }
  const disposed = vi.fn()
  return {
    key, signal, disposed,
    push: (frame) => { add({ kind: 'frame', frame }) },
    end: () => { add({ kind: 'end' }) },
    fail: (error) => { add({ kind: 'fail', error }) },
    dispose: () => { disposed() },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = queue.shift()
        if (next === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          wake = undefined
          continue
        }
        if (next.kind === 'end') return
        if (next.kind === 'fail') throw next.error
        yield next.frame
      }
    },
  }
}

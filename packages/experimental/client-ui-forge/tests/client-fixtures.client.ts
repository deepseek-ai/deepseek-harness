/** Panel state builders shared by the browser-side tests. */

import type {
  ChangeRequestCheck, ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ForgeFailure,
} from '@deepseek-ai/dsh-experimental-forge/types'
import type { BindingOrigin } from '@deepseek-ai/dsh-experimental-forge-session/types'
import type {
  ForgeChangeRequestListState, ForgeCheckout, ForgePanelChangeRequest, ForgePanelState, ForgePanelWorktree, ForgeSessionWorktree,
  ForgeWorktreeCreation, ForgeWorktreeFailure,
} from '../src/types.ts'

/** Pull request reference in `octo/demo` on github.com. */
export function ref(number: number): ChangeRequestRef {
  return { repository: { forge: 'github', host: 'github.com', owner: 'octo', name: 'demo' }, number }
}

/**
 * Open change request from `feat` into `main` without conflicts that adds 12
 * lines, deletes 3, lists no checks, and that the host would not merge yet.
 */
export function snapshot(number: number, overrides: Partial<ChangeRequestSnapshot> = {}): ChangeRequestSnapshot {
  return {
    ref: ref(number),
    url: `https://github.com/octo/demo/pull/${number}`,
    title: `Change ${number}`,
    state: 'open',
    draft: false,
    author: 'octo',
    headBranch: 'feat',
    headSha: 'a'.repeat(40),
    baseBranch: 'main',
    additions: 12,
    deletions: 3,
    mergeability: 'mergeable',
    mergeReady: false,
    mergeMethods: ['squash', 'merge', 'rebase'],
    reviewDecision: 'none',
    checks: [],
    checksRollup: 'success',
    checksTruncated: false,
    unresolvedThreads: 0,
    updatedAt: '2026-10-09T00:00:00Z',
    closedAt: null,
    ...overrides,
  }
}

/** The Session list's state of {@link snapshot}: open and mergeable, with passed checks and no review. */
export function listState(number: number, overrides: Partial<ForgeChangeRequestListState> = {}): ForgeChangeRequestListState {
  return {
    url: `https://github.com/octo/demo/pull/${number}`,
    number,
    title: `Change ${number}`,
    state: 'open',
    draft: false,
    checksRollup: 'success',
    reviewDecision: 'none',
    mergeability: 'mergeable',
    ...overrides,
  }
}

/** Check of the head commit that succeeded after running from 10:00:00 to 10:01:05. */
export function check(name: string, overrides: Partial<ChangeRequestCheck> = {}): ChangeRequestCheck {
  return {
    name,
    state: 'success',
    url: null,
    workflow: null,
    startedAt: '2026-10-09T10:00:00Z',
    completedAt: '2026-10-09T10:01:05Z',
    ...overrides,
  }
}

/** Optional parts of a binding built by {@link entry}. */
export interface EntryOptions {
  /** How the change request became bound; defaults to `created`. */
  readonly origin?: BindingOrigin
  /** Snapshot an earlier poll returned, kept by a binding whose latest poll failed. */
  readonly kept?: ChangeRequestSnapshot
}

/** Binding of pull request `number` whose latest poll returned `status`, or that has not been polled yet. */
export function entry(
  number: number,
  status: ChangeRequestSnapshot | ForgeFailure | null,
  options: EntryOptions = {},
): ForgePanelChangeRequest {
  const key = `github:github.com/octo/demo#${number}` as ChangeRequestKey
  const binding = { url: `https://github.com/octo/demo/pull/${number}`, origin: options.origin ?? 'created', ref: ref(number) }
  if (status === null) return { ...binding, update: null, snapshot: null }
  if ('code' in status) return { ...binding, update: { key, fetchedAt: 1, failure: status }, snapshot: options.kept ?? null }
  return { ...binding, update: { key, fetchedAt: 1, snapshot: status }, snapshot: status }
}

/** Binding of a URL that no provider serves. */
export function unserved(url: string): ForgePanelChangeRequest {
  return { url, origin: 'created', ref: null, update: null, snapshot: null }
}

/** Checkout of `/work/repo` on `main`. */
export function checkout(overrides: Partial<ForgeCheckout> = {}): ForgeCheckout {
  return { root: '/work/repo', branch: 'main', linked: false, commit: '0a1b2c3', ...overrides }
}

/** Worktree the panel created at `/work/repo-dsh` from the checkout `/work/repo`, on a new branch started from `main`. */
export function created(overrides: Partial<ForgeSessionWorktree> = {}): ForgeSessionWorktree {
  return { path: '/work/repo-dsh', branch: 'dsh/0a1b2c3d', from: 'main', baseCommit: 'c'.repeat(40), repositoryRoot: '/work/repo', ...overrides }
}

/** Running creation of the branch `dsh/0a1b2c3d` from `main`, in its preparation step, that a message waits for. */
export function creation(overrides: Partial<ForgeWorktreeCreation> = {}): ForgeWorktreeCreation {
  return { phase: 'prepare', branch: 'dsh/0a1b2c3d', from: 'main', held: true, ...overrides }
}

/** Failed attempt to create the branch `dsh/0a1b2c3d` from `main`, in its preparation step. */
export function failure(overrides: Partial<ForgeWorktreeFailure> = {}): ForgeWorktreeFailure {
  return { branch: 'dsh/0a1b2c3d', from: 'main', phase: 'prepare', message: 'fatal: invalid reference: main', ...overrides }
}

/**
 * Worktree facts of a Session that can no longer request a worktree, has no blocker, and has no creation, failure,
 * worktree, or waiting message.
 */
export function worktree(overrides: Partial<ForgePanelWorktree> = {}): ForgePanelWorktree {
  return {
    editable: false, blocker: null, request: null, created: null, creation: null, failure: null, missing: null, restoration: null,
    waiting: null, ...overrides,
  }
}

/** Ready panel state of `/work/repo` recognized as `octo/demo`, signed in, without change requests, a worktree, or local changes. */
export function ready(overrides: Partial<ForgePanelState> = {}, checkoutOverrides: Partial<ForgeCheckout> = {}): ForgePanelState {
  return {
    directory: '/work/repo',
    checkout: { state: 'ready', checkout: checkout(checkoutOverrides) },
    repository: { forge: 'github', host: 'github.com', owner: 'octo', name: 'demo' },
    readiness: { state: 'ready', message: null },
    changeRequests: [],
    worktree: worktree(),
    local: null,
    ...overrides,
  }
}

/** Ready panel state of a Session that waits to start in a worktree requested from `from`, with further worktree facts. */
export function requested(from: string | null = 'main', overrides: Partial<ForgePanelWorktree> = {}): ForgePanelState {
  return ready({ worktree: worktree({ editable: true, request: { from }, ...overrides }) })
}

/**
 * Panel state of a Session that works in the worktree it created at `/work/repo-dsh` after that directory was removed.
 * @param branchExists - whether the worktree's branch remains.
 * @param waiting - whether a message waits for the worktree to be restored or left.
 * @param overrides - further worktree facts, such as a running restoration.
 */
export function removed(
  branchExists: boolean | null = true, waiting = false, overrides: Partial<ForgePanelWorktree> = {},
): ForgePanelState {
  return ready({
    directory: '/work/repo-dsh',
    checkout: { state: 'failed', message: 'fatal: cannot change to \'/work/repo-dsh\': No such file or directory' },
    worktree: worktree({ created: created(), missing: { branchExists }, waiting: waiting ? 'restoration' : null, ...overrides }),
  })
}

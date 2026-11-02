import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForgeReadiness } from '@deepseek-ai/dsh-experimental-forge'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import WorktreeService from '@deepseek-ai/dsh-experimental-worktree'
import ForgePanelController from '../src/index.ts'
import type { Config, ForgePanelState, ForgeSessionWorktree, ForgeWorktreeState } from '../src/index.ts'
import { WORKTREE_RECORD } from '../src/worktree.ts'
import { missingWorktree } from '../src/panel.ts'
import {
  bench, branches, commitAt, demo, follow, git, hold, notice, prompt, proposeStep, pullUrl,
  rejectionOf, repository, scratch, sendPrompt, shellTurn, snapshot, startStep, startTurn,
} from './harness.ts'
import type { Bench, BenchOptions, Follower } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const signal = new AbortController().signal

async function project(): Promise<{ root: string; repo: string }> {
  const { path, remove } = await scratch('dsh-forge-panel-')
  cleanups.push(remove)
  const repo = await repository(path)
  await git(repo, 'remote', 'add', 'origin', 'https://fake.test/octo/demo.git')
  return { root: path, repo }
}

/** Point `origin/HEAD` at the current `main`, as a clone of the code host would, so the branch scope has a fork point. */
async function withDefaultBranch(repo: string): Promise<void> {
  await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
}

async function plain(): Promise<string> {
  const { path, remove } = await scratch('dsh-forge-plain-')
  cleanups.push(remove)
  return path
}

async function open(cwd: string, config: Config = {}, options: BenchOptions = {}): Promise<Bench> {
  const opened = await bench(cwd, config, options)
  cleanups.push(() => opened.ctx.fiber.dispose())
  return opened
}

function reader(opened: Bench): Follower {
  const follower = follow(opened.ctx, opened.session)
  cleanups.push(follower.stop)
  return follower
}

const ready = (state: ForgePanelState): boolean => state.checkout.state === 'ready' && state.readiness !== null

/** Worktree facts of a Session without a worktree service, request, or creation, whose checkout can host a worktree. */
const UNAVAILABLE = {
  editable: false, blocker: null, request: null, created: null, creation: null, failure: null, missing: null, restoration: null,
  waiting: null,
}

/** Matches a generated branch name with the default prefix. */
const GENERATED_BRANCH: unknown = expect.stringMatching(/^dsh-[0-9a-f]{8}$/)
/** Abbreviated commit object name Git prints for HEAD. */
const COMMIT: unknown = expect.stringMatching(/^[0-9a-f]{7,}$/)

/** Matches the failure of an attempt whose base branch does not exist. */
const MISSING_BASE: unknown = expect.stringMatching(/^worktree command failed \(128\): fatal: /)

/** Whether the change request at `url` holds a snapshot. */
function polled(state: ForgePanelState, url: string): boolean {
  return (state.changeRequests.find(entry => entry.url === url)?.snapshot ?? null) !== null
}

/** Whether the latest polling result of the change request at `url` is a failure. */
function failing(state: ForgePanelState, url: string): boolean {
  const update = state.changeRequests.find(entry => entry.url === url)?.update ?? null
  return update !== null && 'failure' in update
}

/** Settle after every queued microtask, so a pending stream read would have received any published state. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

/** Texts of the prompts queued for the Agent's next turn, in order. */
function queued(opened: Bench): string[] {
  return opened.agent.inbox.nextTurn.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

function worktreeState(opened: Bench, session: Session = opened.session): ForgeWorktreeState {
  return opened.worktreeStates.stateOf(session)
}

/**
 * Request a worktree and send the first message, which waits until the worktree exists, as the Web Session Remote does.
 * @param opened - composition with the worktree service.
 * @param from - base branch, or null for HEAD.
 * @returns the created worktree.
 */
async function startInWorktree(opened: Bench, from: string | null = null): Promise<ForgeSessionWorktree> {
  await opened.ctx.forgePanel.requestWorktree(opened.session, from, signal)
  sendPrompt(opened.agent, 'first')
  await opened.agent.whenIdle()
  const created = worktreeState(opened)?.created ?? null
  if (created === null) throw new Error('the requested worktree was not recorded')
  return created
}

/** Record a created worktree for a Session without creating it. */
function recordWorktree(session: Session, worktree: ForgeSessionWorktree): void {
  appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: null })
  appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree })
}

/**
 * Hold the Agent with other maintenance until the returned release settles it.
 * @param opened - composition whose Agent is held.
 * @returns the release, which waits for the held task to end.
 */
function occupy(opened: Bench): () => Promise<void> {
  const other: PromiseWithResolvers<void> = Promise.withResolvers()
  const running = opened.agent.runMaintenance(() => other.promise)
  return async () => {
    other.resolve()
    await running
  }
}

describe('forgePanel.follow', () => {
  it('streams a pending state, then the checkout, recognized repository, and sign-in state', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const follower = reader(opened)

    const settled = await follower.until(ready)

    expect(follower.states[0]).toEqual({
      directory: repo,
      checkout: { state: 'pending' },
      repository: null,
      readiness: null,
      changeRequests: [],
      worktree: UNAVAILABLE,
      local: null,
    })
    expect(settled).toEqual({
      directory: repo,
      checkout: { state: 'ready', checkout: { root: repo, branch: 'main', linked: false, commit: COMMIT } },
      repository: demo,
      readiness: { state: 'ready', message: null },
      changeRequests: [],
      worktree: UNAVAILABLE,
      // The remote was never fetched, so it names no default branch to fork from.
      local: null,
    })
    expect(opened.provider.probes).toEqual(['fake.test'])
  })

  it('reinspects after tool results and lists bound change requests with their polling results', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const follower = reader(opened)
    await follower.until(ready)

    await git(repo, 'checkout', '-b', 'feat')
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])

    const bound = await follower.until(state => state.checkout.state === 'ready' && state.checkout.checkout.branch === 'feat'
      && polled(state, pullUrl(7)))
    const ref = { repository: demo, number: 7 }
    expect(bound.changeRequests).toMatchObject([{ url: pullUrl(7), origin: 'created', ref, update: { snapshot: snapshot(ref) }, snapshot: snapshot(ref) }])
    expect(opened.provider.probes).toEqual(['fake.test'])
  })

  it('binds the open change requests of the upstream branch once per remote and branch, and looks again on refresh', async () => {
    const { repo } = await project()
    await git(repo, 'checkout', '-b', 'feat')
    await git(repo, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
    await git(repo, 'branch', '--set-upstream-to=origin/feat')
    const opened = await open(repo)
    opened.provider.heads.set('feat', [7])
    const follower = reader(opened)
    const on = (name: string) => (state: ForgePanelState): boolean => state.checkout.state === 'ready' && state.checkout.checkout.branch === name

    const bound = await follower.until(state => state.changeRequests.some(entry => entry.url === pullUrl(7)))
    expect(bound.changeRequests).toMatchObject([{ url: pullUrl(7), origin: 'discovered' }])
    expect(opened.provider.lookups).toEqual(['octo/demo feat'])

    // Leaving for a branch without an upstream and coming back looks up nothing more.
    await git(repo, 'checkout', '-b', 'other')
    shellTurn(opened.session, 1, [{ callId: 'leave', command: 'git checkout -b other', output: '' }])
    await follower.next(on('other'))
    await git(repo, 'checkout', 'feat')
    shellTurn(opened.session, 2, [{ callId: 'back', command: 'git checkout feat', output: '' }])
    await follower.next(on('feat'))
    expect(opened.provider.lookups).toEqual(['octo/demo feat'])

    await opened.ctx.forgePanel.refresh(opened.session, signal)
    await vi.waitFor(() => { expect(opened.provider.lookups).toEqual(['octo/demo feat', 'octo/demo feat']) })
  })

  it('looks up nothing for an upstream on a remote that no provider recognizes', async () => {
    const { repo } = await project()
    await git(repo, 'remote', 'add', 'mirror', 'https://example.invalid/octo/demo.git')
    await git(repo, 'update-ref', 'refs/remotes/mirror/main', 'HEAD')
    await git(repo, 'branch', '--set-upstream-to=mirror/main')
    const opened = await open(repo)
    opened.provider.heads.set('main', [7])

    await reader(opened).until(ready)
    expect(opened.provider.lookups).toEqual([])
  })

  it('keeps the latest snapshot of a change request while later polls fail', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    opened.provider.failures.set(8, { code: 'not-found', message: 'gone' })
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await opened.ctx.forgePanel.track(opened.session, pullUrl(8), signal)
    const follower = reader(opened)
    const seven = { repository: demo, number: 7 }

    const first = await follower.until(state => polled(state, pullUrl(7)) && failing(state, pullUrl(8)))
    opened.provider.failures.set(7, { code: 'unavailable', message: 'offline' })
    await opened.ctx.forgePanel.refresh(opened.session, signal)
    const later = await follower.until(state => failing(state, pullUrl(7)))

    expect(first.changeRequests).toMatchObject([
      { url: pullUrl(7), update: { snapshot: snapshot(seven) }, snapshot: snapshot(seven) },
      { url: pullUrl(8), update: { failure: { code: 'not-found', message: 'gone' } }, snapshot: null },
    ])
    expect(later.changeRequests).toMatchObject([
      { url: pullUrl(7), update: { failure: { code: 'unavailable', message: 'offline' } }, snapshot: snapshot(seven) },
      { url: pullUrl(8), update: { failure: { code: 'not-found', message: 'gone' } }, snapshot: null },
    ])
  })

  it('reports a directory outside a checkout without a repository or sign-in probe, where no worktree can start', async () => {
    const opened = await open(await plain())
    const follower = reader(opened)

    const state = await follower.until(next => next.checkout.state !== 'pending')

    expect(state).toMatchObject({ checkout: { state: 'none' }, repository: null, readiness: null, worktree: { blocker: 'not-git' } })
    expect(opened.provider.probes).toEqual([])
  })

  it.each([
    ['an Error', new Error('sandbox unavailable'), 'sandbox unavailable'],
    ['another value', 'denied', 'denied'],
  ])('reports a failed inspection from %s', async (_label, failure, message) => {
    const { repo } = await project()
    const opened = await open(repo)
    opened.sandbox.failure = failure
    const follower = reader(opened)

    await expect(follower.until(next => next.checkout.state !== 'pending')).resolves.toMatchObject({ checkout: { state: 'failed', message } })
  })

  it.each([
    ['an Error', () => Promise.reject(new Error('gh missing')), 'gh missing'],
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the probe must report a rejection that is not an Error
    ['another value', () => Promise.reject('offline'), 'offline'],
  ])('reports a failed sign-in probe from %s as unavailable', async (_label, impl: () => Promise<ForgeReadiness>, message) => {
    const { repo } = await project()
    const opened = await open(repo)
    opened.provider.readinessImpl = impl
    const follower = reader(opened)

    await expect(follower.until(ready)).resolves.toMatchObject({ readiness: { state: 'unavailable', message } })
  })

  it('times out a sign-in probe', async () => {
    const { repo } = await project()
    const opened = await open(repo, { readinessTimeoutMs: 50 })
    opened.provider.readinessImpl = (_host, abort) => new Promise((_resolve, reject) => {
      abort.addEventListener('abort', () => { reject(abort.reason as Error) })
    })
    const follower = reader(opened)

    await expect(follower.until(ready)).resolves.toMatchObject({
      readiness: { state: 'unavailable', message: 'FORGE_PANEL_READINESS_TIMEOUT after 50ms' },
    })
  })

  it('probes again when the recognized host changes and drops a probe for a host it left', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const held = Promise.withResolvers<ForgeReadiness>()
    opened.provider.readinessImpl = host => host === 'fake.test' ? held.promise : Promise.resolve({ state: 'unauthenticated', message: 'sign in' })
    const follower = reader(opened)
    await follower.until(state => state.repository?.host === 'fake.test')

    await git(repo, 'remote', 'set-url', 'origin', 'https://other.test/octo/demo.git')
    shellTurn(opened.session, 1, [{ callId: 'list', command: 'ls', output: '' }])
    const moved = await follower.until(state => state.repository?.host === 'other.test' && state.readiness !== null)
    held.resolve({ state: 'ready', message: null })
    await Promise.resolve()

    expect(moved.readiness).toEqual({ state: 'unauthenticated', message: 'sign in' })
    expect(opened.provider.probes).toEqual(['fake.test', 'other.test'])
    shellTurn(opened.session, 2, [{ callId: 'again', command: 'ls', output: '' }])
    await follower.next(state => state.checkout.state === 'ready')
    expect(follower.states.at(-1)?.readiness).toEqual({ state: 'unauthenticated', message: 'sign in' })
    expect(opened.provider.probes).toEqual(['fake.test', 'other.test'])
  })

  it('drops a probe result after the directory leaves every repository', async () => {
    const { root, repo } = await project()
    const outside = join(root, 'plain')
    await mkdir(outside)
    const opened = await open(repo)
    const held = Promise.withResolvers<ForgeReadiness>()
    opened.provider.readinessImpl = () => held.promise
    const follower = reader(opened)
    await follower.until(state => state.repository !== null)

    await opened.ctx.workingDirectory.set(opened.agent, outside)
    await follower.until(state => state.directory === outside && state.checkout.state === 'none')
    held.resolve({ state: 'ready', message: null })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(follower.states.at(-1)).toMatchObject({ directory: outside, repository: null, readiness: null })
  })

  it('drops an inspection for a directory the Session left and inspects the new one', async () => {
    const { repo } = await project()
    const linked = join(repo, '.agents', 'worktrees', 'feat')
    await git(repo, 'worktree', 'add', '-b', 'feat', linked)
    const opened = await open(repo)
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    opened.sandbox.gate = () => gate.promise
    const follower = reader(opened)
    await follower.until(state => state.checkout.state === 'pending')
    await vi.waitFor(() => { expect(opened.sandbox.calls).toHaveLength(1) })

    await opened.ctx.workingDirectory.set(opened.agent, linked)
    opened.sandbox.gate = undefined
    gate.resolve()
    const moved = await follower.until(state => state.checkout.state === 'ready')

    expect(moved.directory).toBe(linked)
    expect(moved.checkout).toEqual({ state: 'ready', checkout: { root: linked, branch: 'feat', linked: true, commit: COMMIT } })
    expect(follower.states.every(state => state.checkout.state !== 'ready' || state.directory === linked)).toBe(true)
  })

  it('shares one panel among followers and starts a fresh one after the last leaves', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    const first = reader(opened)
    const second = reader(opened)
    await first.until(state => polled(state, pullUrl(7)))
    await second.until(ready)
    const ref = { repository: demo, number: 7 }

    await first.stop()
    expect(opened.ctx.forge.latest(ref)).toBeDefined()
    await second.stop()
    expect(opened.ctx.forge.latest(ref)).toBeUndefined()

    const third = reader(opened)
    await expect(third.until(() => true)).resolves.toMatchObject({ checkout: { state: 'pending' } })
  })

  it('ends followers whose signal aborts while waiting and when the Remote stops', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const controller = new AbortController()
    const iterator = opened.ctx.forgePanel.follow(opened.session, controller.signal)[Symbol.asyncIterator]()
    let state = await iterator.next()
    while (state.done !== true && !ready(state.value)) state = await iterator.next()
    const waiting = iterator.next()
    controller.abort()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })

    const follower = reader(opened)
    await follower.until(ready)
    const ending = expect(follower.until(() => false)).rejects.toThrow('panel stream ended')
    await opened.panel.dispose()
    await ending
  })

  it('waits for an in-flight sign-in probe when the Remote stops, then drops its result', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const held = Promise.withResolvers<ForgeReadiness>()
    opened.provider.readinessImpl = () => held.promise
    const follower = reader(opened)
    await follower.until(state => state.repository !== null)
    const ending = expect(follower.next(() => true)).rejects.toThrow('panel stream ended')
    let stopped = false

    const stopping = opened.panel.dispose().then(() => { stopped = true })
    await settle()
    expect(stopped).toBe(false)
    held.resolve({ state: 'ready', message: null })
    await stopping

    await ending
    expect(follower.states.at(-1)).toMatchObject({ repository: demo, readiness: null })
  })

  it('ends at once for a signal aborted before reading', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const controller = new AbortController()
    controller.abort()

    const iterator = opened.ctx.forgePanel.follow(opened.session, controller.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('shows no repository when no provider serves the remotes', async () => {
    const { repo } = await project()
    await git(repo, 'remote', 'set-url', 'origin', 'https://unknown.example/octo/demo.git')
    const opened = await open(repo)
    const follower = reader(opened)

    await expect(follower.until(state => state.checkout.state === 'ready')).resolves.toMatchObject({ repository: null, readiness: null })
    expect(opened.provider.probes).toEqual([])
  })

  it('skips a queued inspection once the last follower has left', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    opened.sandbox.gate = () => gate.promise
    const follower = reader(opened)
    await follower.until(state => state.checkout.state === 'pending')
    await vi.waitFor(() => { expect(opened.sandbox.calls).toHaveLength(1) })
    shellTurn(opened.session, 1, [{ callId: 'list', command: 'ls', output: '' }])

    await follower.stop()
    opened.sandbox.gate = undefined
    gate.resolve()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(opened.sandbox.calls).toHaveLength(1)
  })
})

describe('forgePanel local changes', () => {
  it('reports filter configuration overflow separately and recovers after it is reduced', async () => {
    const { repo } = await project()
    await withDefaultBranch(repo)
    await writeFile(join(repo, 'tracked.txt'), 'changed\n')
    const key = `filter.${'long'.repeat(200)}.clean`
    await git(repo, 'config', key, 'cat')
    const opened = await open(repo, { maxDiffBytes: 512, maxOutputBytes: 512 })
    const follower = reader(opened)

    await expect(follower.until(ready)).resolves.toMatchObject({ checkout: { state: 'ready' }, local: null })
    await expect(opened.ctx.forgePanel.localDiff(opened.session, { kind: 'unstaged' }, signal))
      .rejects.toMatchObject({ code: 'forgePanel/filter-config-failed' })

    await git(repo, 'config', '--unset', key)
    await opened.ctx.forgePanel.refresh(opened.session, signal)
    await expect(follower.until(state => state.local !== null)).resolves.toMatchObject({ local: { files: [{ path: 'tracked.txt' }] } })
    await expect(opened.ctx.forgePanel.localDiff(opened.session, { kind: 'unstaged' }, signal))
      .resolves.toMatchObject({ files: [{ path: 'tracked.txt' }] })
  })

  it('measures the branch scope at each inspection', async () => {
    const { repo } = await project()
    await withDefaultBranch(repo)
    const opened = await open(repo)
    const follower = reader(opened)
    expect((await follower.until(ready)).local).toEqual({ base: 'origin/main', files: [] })

    await git(repo, 'checkout', '--quiet', '-b', 'feat')
    await writeFile(join(repo, 'notes.md'), 'hello\n')
    shellTurn(opened.session, 1, [{ callId: 'write', command: 'echo hello > notes.md', output: '' }])

    await expect(follower.until(state => state.local?.files.length === 1)).resolves.toMatchObject({
      local: { base: 'origin/main', files: [{ path: 'notes.md', additions: 1, deletions: 0, binary: false }] },
    })
  })

  it('leaves the size unknown when measuring it fails', async () => {
    const { repo } = await project()
    await withDefaultBranch(repo)
    await writeFile(join(repo, 'notes.md'), 'hello\n')
    const opened = await open(repo, { maxDiffBytes: 1 })

    await expect(reader(opened).until(ready)).resolves.toMatchObject({ checkout: { state: 'ready' }, local: null })
  })

  it('reads the changes of a scope and the new side of a file', async () => {
    const { repo } = await project()
    await withDefaultBranch(repo)
    await writeFile(join(repo, 'tracked.txt'), 'initial\nmore\n')
    await writeFile(join(repo, 'notes.md'), 'hello\n')
    const opened = await open(repo)

    const diff = await opened.ctx.forgePanel.localDiff(opened.session, { kind: 'branch' }, signal)
    expect(diff.base).toBe('origin/main')
    expect(diff.files.map(file => [file.path, file.status, file.untracked])).toEqual([['tracked.txt', 'modified', false], ['notes.md', 'added', true]])
    await expect(opened.ctx.forgePanel.localDiff(opened.session, { kind: 'staged' }, signal)).resolves.toEqual({ base: null, files: [], omitted: 0 })
    await expect(opened.ctx.forgePanel.localText(opened.session, { kind: 'unstaged' }, 'tracked.txt', signal)).resolves.toBe('initial\nmore\n')
  })

  it('reports a directory outside a checkout, a branch without a fork point, and a diff over the limit', async () => {
    const outside = await open(await plain())
    await expect(outside.ctx.forgePanel.localDiff(outside.session, { kind: 'unstaged' }, signal)).rejects.toMatchObject({ code: 'forgePanel/not-a-checkout' })
    await expect(outside.ctx.forgePanel.localText(outside.session, { kind: 'unstaged' }, 'a.txt', signal))
      .rejects.toMatchObject({ code: 'forgePanel/not-a-checkout' })

    const { repo } = await project()
    await writeFile(join(repo, 'tracked.txt'), 'x\n'.repeat(2000))
    const opened = await open(repo, { maxDiffBytes: 1024 })
    await expect(opened.ctx.forgePanel.localDiff(opened.session, { kind: 'branch' }, signal)).rejects.toMatchObject({ code: 'forgePanel/no-fork-point' })
    await expect(opened.ctx.forgePanel.localDiff(opened.session, { kind: 'unstaged' }, signal)).rejects.toMatchObject({ code: 'forgePanel/diff-too-large' })
    await expect(opened.ctx.forgePanel.localText(opened.session, { kind: 'unstaged' }, 'tracked.txt', signal))
      .rejects.toMatchObject({ code: 'forgePanel/diff-too-large' })
    await expect(opened.ctx.forgePanel.localText(opened.session, { kind: 'unstaged' }, '../outside.txt', signal))
      .rejects.toThrow('is not a path inside the checkout')
  })
})

describe('forgePanel complete checks', () => {
  it('reads only visible bindings and refuses a different head without changing polling state', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await reader(opened).until(state => ready(state) && polled(state, pullUrl(7)))
    const target = opened.provider.changeRequestFromUrl(pullUrl(7))!
    const original = snapshot(target)
    const complete = vi.fn(async () => original)
    Object.assign(opened.provider, { fetchChecks: complete })
    await expect(opened.ctx.forgePanel.changeRequestChecks(opened.session, pullUrl(7), original.headSha, signal)).resolves.toEqual(original)
    await expect(opened.ctx.forgePanel.changeRequestChecks(opened.session, pullUrl(8), original.headSha, signal))
      .rejects.toMatchObject({ code: 'forgePanel/not-bound' })
    expect(complete).toHaveBeenCalledTimes(1)
    await expect(opened.ctx.forgePanel.changeRequestChecks(opened.session, pullUrl(7), 'b'.repeat(40), signal))
      .rejects.toMatchObject({ code: 'forgePanel/stale-head' })
    Object.assign(opened.provider, { fetchChecks: async () => ({ code: 'too-large', message: 'Checks exceed limit' }) })
    await expect(opened.ctx.forgePanel.changeRequestChecks(opened.session, pullUrl(7), original.headSha, signal))
      .rejects.toMatchObject({ code: 'forgePanel/checks-failed', message: 'Checks exceed limit' })
  })
})

describe('forgePanel change request diffs', () => {
  const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

  it('reads the diff at the head of the latest status, with file pages and the commits the checkout has beyond it', async () => {
    const { repo } = await project()
    await git(repo, 'checkout', '--quiet', '-b', 'feat')
    const head = await git(repo, 'rev-parse', 'HEAD')
    await commitAt(repo, 'later.txt', '2026-03-01T00:00:00Z')
    const opened = await open(repo)
    opened.provider.overrides.set(7, { headSha: head, headBranch: 'feat' })
    opened.provider.patches.set(7, PATCH)
    opened.provider.texts.set(`${head}:src/a.ts`, 'new\n')
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await reader(opened).until(state => polled(state, pullUrl(7)))

    const diff = await opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(7), signal)
    expect(diff).toMatchObject({ headSha: head, localAhead: 1, fileUrls: { 'src/a.ts': `${pullUrl(7)}/files/${head}/src/a.ts` } })
    expect(diff.files.map(file => [file.path, file.additions, file.deletions])).toEqual([['src/a.ts', 1, 1]])
    await expect(opened.ctx.forgePanel.changeRequestText(opened.session, pullUrl(7), head, 'src/a.ts', signal)).resolves.toBe('new\n')
  })

  it('counts no commits beyond the head when Git cannot answer', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    opened.provider.patches.set(7, PATCH)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await reader(opened).until(state => polled(state, pullUrl(7)))
    opened.sandbox.failure = new Error('sandbox unavailable')

    await expect(opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(7), signal)).resolves.toMatchObject({ localAhead: null })
  })

  it('downloads a diff once per head commit and base branch for every Session, keeping no failed read', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    const follower = reader(opened)
    await follower.until(state => polled(state, pullUrl(7)))
    const paths = async (session: Session = opened.session): Promise<string[]> =>
      (await opened.ctx.forgePanel.changeRequestDiff(session, pullUrl(7), signal)).files.map(file => file.path)
    const moved = async (snapshot: { headSha: string; baseBranch: string }): Promise<void> => {
      opened.provider.overrides.set(7, snapshot)
      await opened.ctx.forgePanel.refresh(opened.session, signal)
      await follower.until(state => state.changeRequests[0]?.snapshot?.baseBranch === snapshot.baseBranch
        && state.changeRequests[0].snapshot.headSha === snapshot.headSha)
    }

    await expect(paths()).rejects.toMatchObject({ code: 'forgePanel/diff-failed', message: 'no diff of #7' })
    opened.provider.patches.set(7, PATCH)
    await expect(paths()).resolves.toEqual(['src/a.ts'])
    opened.provider.patches.set(7, PATCH.replaceAll('src/a.ts', 'src/b.ts'))
    await expect(paths()).resolves.toEqual(['src/a.ts'])
    const other = opened.ctx.sessions.create(SessionId('forge-panel-other'), { meta: { cwd: repo } })
    opened.ctx.forgeSession.track(other, pullUrl(7))
    await expect(paths(other)).resolves.toEqual(['src/a.ts'])
    expect(opened.provider.diffs).toEqual([7, 7])

    await moved({ headSha: 'b'.repeat(40), baseBranch: 'main' })
    await expect(paths()).resolves.toEqual(['src/b.ts'])
    await moved({ headSha: 'b'.repeat(40), baseBranch: 'release' })
    opened.provider.patches.set(7, PATCH)
    await expect(paths()).resolves.toEqual(['src/a.ts'])
    expect(opened.provider.diffs).toEqual([7, 7, 7, 7])
  })

  it('reports a diff or file over a size limit as too large', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const head = 'a'.repeat(40)
    opened.provider.patches.set(7, { code: 'too-large', message: 'the diff exceeded the maximum number of files (300)' })
    opened.provider.texts.set(`${head}:big.bin`, { code: 'too-large', message: 'big.bin is too large to fetch' })
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await reader(opened).until(state => polled(state, pullUrl(7)))

    await expect(opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(7), signal))
      .rejects.toMatchObject({ code: 'forgePanel/diff-too-large', message: 'the diff exceeded the maximum number of files (300)' })
    await expect(opened.ctx.forgePanel.changeRequestText(opened.session, pullUrl(7), head, 'big.bin', signal))
      .rejects.toMatchObject({ code: 'forgePanel/diff-too-large', message: 'big.bin is too large to fetch' })
  })

  it('reports an unbound change request, one not read yet, and a diff or file the host does not provide', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    opened.provider.failures.set(8, { code: 'unavailable', message: 'down' })
    shellTurn(opened.session, 1, [
      { callId: 'seven', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` },
      { callId: 'eight', command: 'gh pr create --fill', output: `${pullUrl(8)}\n` },
    ])
    await reader(opened).until(state => polled(state, pullUrl(7)) && failing(state, pullUrl(8)))

    await expect(opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(9), signal)).rejects.toMatchObject({ code: 'forgePanel/not-bound' })
    await expect(opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(8), signal))
      .rejects.toMatchObject({ code: 'forgePanel/diff-failed', message: 'The change request status has not been read yet' })
    await expect(opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(7), signal))
      .rejects.toMatchObject({ code: 'forgePanel/diff-failed', message: 'no diff of #7' })
    await expect(opened.ctx.forgePanel.changeRequestText(opened.session, pullUrl(7), 'a'.repeat(40), 'gone.ts', signal))
      .rejects.toMatchObject({ code: 'forgePanel/diff-failed', message: `no gone.ts at ${'a'.repeat(40)}` })
  })
})

describe('forgePanel worktree blockers', () => {
  it('recovers checkout inspection when the Session switches to full access on a host without a sandbox', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    opened.sandbox.failure = new Error('sandbox unavailable')
    const follower = reader(opened)
    await follower.until(state => state.checkout.state === 'failed')

    setSandboxMode(opened.session, 'danger-full-access')
    const full = await follower.next(ready)
    expect(full.checkout).toMatchObject({ state: 'ready', checkout: { root: repo, branch: 'main' } })

    setSandboxMode(opened.session, 'workspace-write')
    await expect(follower.next(state => state.checkout.state === 'failed')).resolves.toMatchObject({
      checkout: { state: 'failed', message: 'sandbox unavailable' },
    })
  })

  it('reinspects when the sandbox mode changes, and blocks a worktree while the Session is read-only', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const follower = reader(opened)
    await follower.until(ready)

    setSandboxMode(opened.session, 'read-only')
    const readOnly = await follower.next(state => state.worktree.blocker !== null)
    setSandboxMode(opened.session, 'workspace-write')
    const writable = await follower.next(state => state.worktree.blocker !== 'read-only')

    expect(readOnly.worktree).toEqual({ ...UNAVAILABLE, blocker: 'read-only' })
    expect(readOnly.checkout).toEqual({ state: 'ready', checkout: { root: repo, branch: 'main', linked: false, commit: COMMIT } })
    expect(writable.worktree).toEqual(UNAVAILABLE)
  })

  it.each([
    ['a linked worktree whose shared Git directory lies outside it', async (root: string, repo: string): Promise<string> => {
      const linked = join(root, 'linked')
      await git(repo, 'worktree', 'add', '-b', 'feat', linked)
      return linked
    }],
    ['a subdirectory of its checkout', async (_root: string, repo: string): Promise<string> => {
      const nested = join(repo, 'src')
      await mkdir(nested)
      return nested
    }],
  ])('blocks a worktree for a Session rooted in %s until the Session gets full access', async (_label, place) => {
    const { root, repo } = await project()
    const opened = await open(await place(root, repo))
    const follower = reader(opened)

    const blocked = await follower.until(ready)
    setSandboxMode(opened.session, 'danger-full-access')
    const unblocked = await follower.next(state => state.worktree.blocker !== 'outside-writable-root')

    expect(blocked.repository).toEqual(demo)
    expect(blocked.worktree.blocker).toBe('outside-writable-root')
    expect(unblocked.worktree.blocker).toBeNull()
  })

  it('shows no blocker after an inspection fails', async () => {
    const opened = await open(await plain())
    const follower = reader(opened)
    await follower.until(state => state.worktree.blocker === 'not-git')

    opened.sandbox.failure = new Error('sandbox unavailable')
    await opened.ctx.forgePanel.refresh(opened.session, signal)

    await expect(follower.next(state => state.checkout.state === 'failed')).resolves.toMatchObject({ worktree: { blocker: null } })
  })
})

describe('forgePanel worktree requests', () => {
  it('publishes worktree requests and withdrawals until the first turn starts', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)

    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    const requested = await follower.next(() => true)
    await opened.ctx.forgePanel.requestWorktree(opened.session, 'main', signal)
    const replaced = await follower.next(() => true)
    await opened.ctx.forgePanel.cancelWorktree(opened.session, signal)
    const withdrawn = await follower.next(() => true)
    startTurn(opened.session, 1)
    const started = await follower.next(() => true)

    const editable = { ...UNAVAILABLE, editable: true }
    expect(follower.states[0]?.worktree).toEqual(editable)
    expect(requested.worktree).toEqual({ ...editable, request: { from: null } })
    expect(replaced.worktree).toEqual({ ...editable, request: { from: 'main' } })
    expect(withdrawn.worktree).toEqual(editable)
    expect(started.worktree).toEqual(UNAVAILABLE)
    expect(opened.records).toEqual([{ action: 'request', from: null }, { action: 'request', from: 'main' }, { action: 'cancel' }])
  })

  it('withdraws only an open request', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })

    await opened.ctx.forgePanel.cancelWorktree(opened.session, signal)
    await opened.ctx.forgePanel.requestWorktree(opened.session, 'main', signal)
    await opened.ctx.forgePanel.cancelWorktree(opened.session, signal)
    await opened.ctx.forgePanel.cancelWorktree(opened.session, signal)

    expect(opened.records).toEqual([{ action: 'request', from: 'main' }, { action: 'cancel' }])
  })

  it('refuses worktree changes after the first turn starts', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    startTurn(opened.session, 1)

    await expect(opened.ctx.forgePanel.requestWorktree(opened.session, 'main', signal)).rejects.toMatchObject({ code: 'forgePanel/session-started' })
    await expect(opened.ctx.forgePanel.cancelWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/session-started' })
    expect(opened.records).toEqual([{ action: 'request', from: null }])
  })

  it('refuses worktree changes once the worktree exists, before any turn starts', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    await proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [prompt('go')], decision: { kind: 'reject' } })

    await expect(opened.ctx.forgePanel.requestWorktree(opened.session, 'main', signal)).rejects.toMatchObject({ code: 'forgePanel/session-started' })
    await expect(opened.ctx.forgePanel.cancelWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/session-started' })
    expect(worktreeState(opened)).toMatchObject({ request: { from: null }, locked: false, stepped: false, restoring: false })
    expect(opened.records).toHaveLength(2)
  })

  it('refuses worktree requests and restoration without a worktree service, and keeps a waiting message for the withdrawal', async () => {
    const { repo } = await project()
    const opened = await open(repo)

    await expect(opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)).rejects.toMatchObject({ code: 'forgePanel/worktrees-unavailable' })
    expect(opened.records).toEqual([])
    appendPluginRecord(opened.session, WORKTREE_RECORD, { action: 'request', from: null })
    const follower = reader(opened)
    sendPrompt(opened.agent, 'first')
    const failed = await follower.until(state => state.worktree.failure !== null)
    expect(failed.worktree.failure).toEqual({ branch: null, from: null, phase: 'prepare', message: 'No worktree service is mounted' })
    // Withdrawing needs no worktree service, so the waiting message can go on.
    await opened.ctx.forgePanel.cancelWorktree(opened.session, signal)
    await opened.agent.whenIdle()
    expect(opened.agent.wakes).toBe(1)

    const worktree: ForgeSessionWorktree = {
      path: join(repo, '.agents', 'worktrees', 'dsh', '0a1b2c3d'), branch: 'dsh/0a1b2c3d', from: null, baseCommit: 'c'.repeat(40), repositoryRoot: repo,
    }
    recordWorktree(opened.session, worktree)
    await expect(opened.ctx.forgePanel.restoreWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/worktrees-unavailable' })
    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an empty base branch', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })

    await expect(opened.ctx.forgePanel.requestWorktree(opened.session, '', signal)).rejects.toMatchObject({ code: 'forgePanel/invalid-branch' })
    expect(opened.records).toEqual([])
  })

  it('follows the Session into the worktree created at its first step', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)

    startTurn(opened.session, 1)
    await proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [prompt('Fix the bug')] })
    startStep(opened.session, 1)

    const created = worktreeState(opened)?.created ?? null
    expect(created).not.toBeNull()
    const moved = await follower.until(state => state.directory === created?.path && state.checkout.state === 'ready' && state.worktree.created !== null)
    expect(moved).toEqual({
      directory: created?.path,
      checkout: { state: 'ready', checkout: { root: created?.path, branch: created?.branch, linked: true, commit: COMMIT } },
      repository: demo,
      readiness: { state: 'ready', message: null },
      changeRequests: [],
      worktree: { ...UNAVAILABLE, request: { from: null }, created },
      local: { base: created?.baseCommit.slice(0, 7), files: [] },
    })
    expect(opened.provider.probes).toEqual(['fake.test'])
  })

  it('publishes worktree facts only when they change', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const follower = reader(opened)
    await follower.until(ready)
    appendPluginRecord(opened.session, WORKTREE_RECORD, { action: 'request', from: null })
    await follower.next(state => state.worktree.request !== null)
    const pending = follower.next(() => true)
    let published = false
    void pending.then(() => { published = true }, () => undefined)

    startTurn(opened.session, 1)
    appendPluginRecord(opened.session, WORKTREE_RECORD, { action: 'request', from: '' })
    appendPluginRecord(opened.session, WORKTREE_RECORD, { action: 'request', from: 'main' })
    await settle()
    expect(published).toBe(false)

    const worktree: ForgeSessionWorktree = { path: join(repo, 'elsewhere'), branch: 'dsh/0a1b2c3d', from: null, baseCommit: 'c'.repeat(40), repositoryRoot: repo }
    appendPluginRecord(opened.session, WORKTREE_RECORD, { action: 'created', worktree })
    await expect(pending).resolves.toMatchObject({ worktree: { ...UNAVAILABLE, request: { from: null }, created: worktree } })

    const later = follower.next(() => true)
    let republished = false
    void later.then(() => { republished = true }, () => undefined)
    startStep(opened.session, 1)
    appendPluginRecord(opened.session, WORKTREE_RECORD, { action: 'created', worktree: { ...worktree, branch: 'dsh/ffffffff' } })
    await settle()
    expect(republished).toBe(false)
  })
})

describe('forgePanel worktree creation while a message waits', () => {
  it('creates the requested worktree as Agent maintenance while the first message waits in the inbox, showing each step, then starts its turn', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    const preparing = hold(opened.sandbox, 'check-ref-format')
    const checkingOut = hold(opened.sandbox, 'reset')

    sendPrompt(opened.agent, 'first')
    const prepare = await follower.until(state => state.worktree.creation?.phase === 'prepare')
    expect(() => opened.agent.runMaintenance(() => Promise.resolve())).toThrow('already has active work')
    expect(queued(opened)).toEqual(['first'])
    expect(opened.agent.wakes).toBe(0)
    preparing.release()
    const checkout = await follower.until(state => state.worktree.creation?.phase === 'checkout')
    checkingOut.release()
    await opened.agent.whenIdle()
    const created = worktreeState(opened)?.created ?? null
    const moved = await follower.until(state => state.directory === created?.path && state.checkout.state === 'ready' && state.worktree.waiting === null)

    const branch = created?.branch ?? ''
    const running = { branch, from: null, held: true }
    const waiting = { ...UNAVAILABLE, editable: true, request: { from: null }, waiting: 'creation' }
    expect(prepare.worktree).toEqual({ ...waiting, creation: { ...running, phase: 'prepare' } })
    expect(checkout.worktree).toEqual({ ...waiting, creation: { ...running, phase: 'checkout' } })
    expect(moved.worktree).toEqual({ ...UNAVAILABLE, request: { from: null }, created })
    expect(moved.checkout).toEqual({ state: 'ready', checkout: { root: created?.path, branch, linked: true, commit: COMMIT } })
    expect(created).toEqual({
      path: join(repo, '.agents', 'worktrees', ...branch.split('/')),
      branch: GENERATED_BRANCH,
      from: null,
      baseCommit: await git(repo, 'rev-parse', 'HEAD'),
      repositoryRoot: repo,
    })
    expect(opened.agent.wakes).toBe(1)
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(created?.path)
    expect(opened.agent.inbox.nextStep).toEqual([notice(created?.path ?? '')])
    expect(queued(opened)).toEqual(['first'])
    expect(opened.records).toEqual([{ action: 'request', from: null }, { action: 'created', worktree: created }])
  })

  it('keeps the message waiting with the failure the panel shows, and tries again with a new branch when asked', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    await opened.ctx.forgePanel.requestWorktree(opened.session, 'later', signal)

    sendPrompt(opened.agent, 'first')
    const failed = await follower.until(state => state.worktree.failure !== null && state.worktree.creation === null)
    expect(opened.agent.wakes).toBe(0)
    await git(repo, 'branch', 'later')
    await opened.ctx.forgePanel.retryWorktree(opened.session, signal)
    const retrying = await follower.next(state => state.worktree.creation !== null)
    await opened.agent.whenIdle()

    expect(failed.worktree).toEqual({
      ...UNAVAILABLE, editable: true, request: { from: 'later' }, waiting: 'creation',
      failure: { branch: GENERATED_BRANCH, from: 'later', phase: 'prepare', message: MISSING_BASE },
    })
    expect(retrying.worktree.failure).toBeNull()
    const created = worktreeState(opened)?.created ?? null
    expect(created).toMatchObject({ from: 'later', baseCommit: await git(repo, 'rev-parse', 'later') })
    expect(created?.branch).not.toBe(failed.worktree.failure?.branch)
    expect(opened.agent.wakes).toBe(1)
    expect(queued(opened)).toEqual(['first'])
    expect(opened.records).toEqual([{ action: 'request', from: 'later' }, { action: 'created', worktree: created }])
  })

  it('keeps the message waiting when the request changes, and lets it go on in the current checkout once the request is withdrawn', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    await opened.ctx.forgePanel.requestWorktree(opened.session, 'later', signal)
    sendPrompt(opened.agent, 'first')
    await follower.until(state => state.worktree.failure !== null)

    await opened.ctx.forgePanel.requestWorktree(opened.session, 'gone', signal)
    const changed = await follower.next(state => state.worktree.request?.from === 'gone')
    await opened.ctx.forgePanel.retryWorktree(opened.session, signal)
    const failedAgain = await follower.next(state => state.worktree.failure !== null)
    const withdrawal = follower.next(state => state.worktree.request === null && state.worktree.waiting === null)
    await opened.ctx.forgePanel.cancelWorktree(opened.session, signal)
    await opened.agent.whenIdle()
    const withdrawn = await withdrawal

    expect(changed.worktree).toEqual({ ...UNAVAILABLE, editable: true, request: { from: 'gone' }, waiting: 'creation' })
    expect(failedAgain.worktree.failure).toMatchObject({ from: 'gone' })
    expect(withdrawn.worktree).toEqual({ ...UNAVAILABLE, editable: true })
    expect(opened.agent.wakes).toBe(1)
    expect(queued(opened)).toEqual(['first'])
    expect(opened.agent.inbox.nextStep).toEqual([])
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
    expect(opened.records).toEqual([{ action: 'request', from: 'later' }, { action: 'request', from: 'gone' }, { action: 'cancel' }])
  })

  it('stops the running attempt, and the message keeps waiting with the request open until another attempt', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    await opened.ctx.forgePanel.stopCreation(opened.session, signal)
    const held = hold(opened.sandbox, 'check-ref-format')

    sendPrompt(opened.agent, 'first')
    await held.reached
    const stopping = follower.next(state => state.worktree.waiting === 'creation' && state.worktree.creation === null)
    await opened.ctx.forgePanel.stopCreation(opened.session, signal)
    held.release()
    const stopped = await stopping
    const before = { wakes: opened.agent.wakes, records: [...opened.records], cwd: opened.ctx.workingDirectory.get(opened.session) }
    await opened.ctx.forgePanel.retryWorktree(opened.session, signal)
    await opened.agent.whenIdle()

    expect(stopped.worktree).toEqual({ ...UNAVAILABLE, editable: true, request: { from: null }, waiting: 'creation' })
    expect(before).toEqual({ wakes: 0, records: [{ action: 'request', from: null }], cwd: repo })
    expect(worktreeState(opened)?.created).toMatchObject({ from: null, repositoryRoot: repo })
    expect(opened.agent.wakes).toBe(1)
  })

  it('makes no attempt when the request is withdrawn right after another attempt was asked for', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    await opened.ctx.forgePanel.requestWorktree(opened.session, 'later', signal)
    sendPrompt(opened.agent, 'first')
    await follower.until(state => state.worktree.failure !== null)
    await git(repo, 'branch', 'later')

    // Both decisions arrive before the wait resumes, so the next attempt reads the withdrawn request.
    await Promise.all([
      opened.ctx.forgePanel.retryWorktree(opened.session, signal),
      opened.ctx.forgePanel.cancelWorktree(opened.session, signal),
    ])
    await opened.agent.whenIdle()

    expect(opened.agent.wakes).toBe(1)
    expect(opened.records).toEqual([{ action: 'request', from: 'later' }, { action: 'cancel' }])
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
  })

  it('refuses another attempt while no message waits or an attempt runs', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await expect(opened.ctx.forgePanel.retryWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/not-waiting' })
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    const held = hold(opened.sandbox, 'check-ref-format')

    sendPrompt(opened.agent, 'first')
    await held.reached
    await expect(opened.ctx.forgePanel.retryWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/not-waiting' })
    held.release()
    await opened.agent.whenIdle()

    expect(worktreeState(opened)?.created).not.toBeNull()
    expect(opened.agent.wakes).toBe(1)
  })

  it('ends the wait and drops the waiting messages when the Agent is cancelled', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    await opened.ctx.forgePanel.requestWorktree(opened.session, 'later', signal)
    sendPrompt(opened.agent, 'first')
    await follower.until(state => state.worktree.failure !== null)

    const ending = follower.next(state => state.worktree.waiting === null)
    opened.agent.cancel({ kind: 'user' })
    await opened.agent.whenIdle()
    const ended = await ending

    expect(ended.worktree).toEqual({ ...UNAVAILABLE, editable: true, request: { from: 'later' } })
    expect(opened.agent.wakes).toBe(0)
    expect(queued(opened)).toEqual([])
    expect(worktreeState(opened)).toMatchObject({ request: { from: 'later' }, created: null })
  })

  it('lets the waiting message go on when the panel stops', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await opened.ctx.forgePanel.requestWorktree(opened.session, 'later', signal)
    sendPrompt(opened.agent, 'first')
    await vi.waitFor(() => { expect(() => opened.agent.runMaintenance(() => Promise.resolve())).toThrow('already has active work') })

    await opened.panel.dispose()
    await opened.agent.whenIdle()

    expect(opened.agent.wakes).toBe(1)
    expect(queued(opened)).toEqual(['first'])
    expect(worktreeState(opened)).toMatchObject({ request: { from: 'later' }, created: null })
  })

  it('holds one wait for every message that arrives during it', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    const held = hold(opened.sandbox, 'check-ref-format')

    sendPrompt(opened.agent, 'first')
    await held.reached
    sendPrompt(opened.agent, 'second')
    held.release()
    await opened.agent.whenIdle()

    expect(opened.agent.wakes).toBe(1)
    expect(queued(opened)).toEqual(['first', 'second'])
    expect(opened.records).toHaveLength(2)
  })

  it('leaves a message that arrives while the Agent has other work to the first step', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    await follower.until(state => state.worktree.request !== null)
    const release = occupy(opened)

    sendPrompt(opened.agent, 'first')
    await settle()
    const busy = follower.states.at(-1)
    await release()

    expect(busy?.worktree).toEqual({ ...UNAVAILABLE, editable: true, request: { from: null } })
    expect(opened.agent.wakes).toBe(1)
    expect(worktreeState(opened)).toMatchObject({ request: { from: null }, created: null })
    expect(await branches(repo)).toEqual(['main'])
  })

  it('lets a message go on without a wait once the first turn started, leaving the worktree to the first step', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    startTurn(opened.session, 1)

    sendPrompt(opened.agent, 'steer')
    await opened.agent.whenIdle()

    expect(opened.agent.wakes).toBe(1)
    expect(queued(opened)).toEqual(['steer'])
    expect(worktreeState(opened)).toMatchObject({ request: { from: null }, created: null, locked: true })
    expect(await branches(repo)).toEqual(['main'])
  })
})

describe('forgePanel worktree requests during a creation', () => {
  it('refuses to change or withdraw the request while the worktree is being created, so the creation is recorded', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    const held = hold(opened.sandbox, 'check-ref-format')

    sendPrompt(opened.agent, 'first')
    await held.reached
    await expect(opened.ctx.forgePanel.cancelWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/session-busy' })
    await expect(opened.ctx.forgePanel.requestWorktree(opened.session, 'main', signal))
      .rejects.toMatchObject({ code: 'forgePanel/session-busy' })
    held.release()
    await opened.agent.whenIdle()

    const created = worktreeState(opened)?.created ?? null
    expect(created).toMatchObject({ from: null, repositoryRoot: repo })
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(created?.path)
    expect(opened.records).toEqual([{ action: 'request', from: null }, { action: 'created', worktree: created }])
  })
})

describe('forgePanel removed worktrees', () => {
  it('shows a removed worktree whose branch remains, and holds the next message until the branch is checked out again', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    const created = await startInWorktree(opened)
    const tip = await commitAt(created.path, 'later.txt', '2026-05-01T00:00:00Z')
    await follower.until(state => state.directory === created.path && state.checkout.state === 'ready')
    await rm(created.path, { recursive: true, force: true })

    sendPrompt(opened.agent, 'next')
    const missing = await follower.until(state => state.worktree.waiting === 'restoration')
    expect(opened.agent.wakes).toBe(1)
    const pruning = hold(opened.sandbox, 'list')
    const resetting = hold(opened.sandbox, 'reset')
    const restoring = opened.ctx.forgePanel.restoreWorktree(opened.session, signal)
    await pruning.reached
    expect(() => opened.agent.runMaintenance(() => Promise.resolve())).toThrow('already has active work')
    const preparing = await follower.until(state => state.worktree.restoration?.phase === 'prepare')
    pruning.release()
    await resetting.reached
    const checkingOut = await follower.until(state => state.worktree.restoration?.phase === 'checkout')
    const restoration = follower.next(state => state.worktree.missing === null && state.worktree.waiting === null && state.checkout.state === 'ready')
    resetting.release()
    await restoring
    await opened.agent.whenIdle()
    const restored = await restoration

    expect(missing.worktree).toEqual({ ...UNAVAILABLE, request: { from: null }, created, missing: { branchExists: true }, waiting: 'restoration' })
    expect(preparing.worktree).toMatchObject({ missing: { branchExists: true }, restoration: { phase: 'prepare' }, waiting: 'restoration' })
    expect(checkingOut.worktree.restoration).toEqual({ phase: 'checkout' })
    expect(restored).toMatchObject({ directory: created.path, checkout: { state: 'ready', checkout: { root: created.path, branch: created.branch } } })
    expect(restored.worktree).toEqual({ ...UNAVAILABLE, request: { from: null }, created })
    expect(await git(created.path, 'rev-parse', 'HEAD')).toBe(tip)
    expect(await readFile(join(created.path, 'later.txt'), 'utf8')).toBe('later.txt\n')
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(created.path)
    expect(opened.agent.wakes).toBe(2)
    expect(queued(opened)).toEqual(['first', 'next'])
  })

  it('shows a removed worktree whose branch is gone, and creates the branch again at its base commit', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    const created = await startInWorktree(opened)
    await commitAt(created.path, 'later.txt', '2026-05-01T00:00:00Z')
    await follower.until(state => state.directory === created.path && state.checkout.state === 'ready')
    await rm(created.path, { recursive: true, force: true })
    sendPrompt(opened.agent, 'next')
    await follower.until(state => state.worktree.missing?.branchExists === true)
    await git(repo, 'worktree', 'prune')
    await git(repo, 'branch', '-D', created.branch)

    await opened.ctx.forgePanel.refresh(opened.session, signal)
    const gone = await follower.until(state => state.worktree.missing?.branchExists === false)
    const restoration = follower.next(state => state.worktree.missing === null && state.checkout.state === 'ready')
    await opened.ctx.forgePanel.restoreWorktree(opened.session, signal)
    await opened.agent.whenIdle()
    const restored = await restoration

    expect(gone.worktree).toEqual({ ...UNAVAILABLE, request: { from: null }, created, missing: { branchExists: false }, waiting: 'restoration' })
    expect(await git(repo, 'rev-parse', created.branch)).toBe(created.baseCommit)
    expect(restored.checkout).toEqual({ state: 'ready', checkout: { root: created.path, branch: created.branch, linked: true, commit: COMMIT } })
    await expect(access(join(created.path, 'later.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(opened.agent.wakes).toBe(2)
  })

  it('checks once for all the messages that wait, publishing the answer once', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    const created = await startInWorktree(opened)
    await follower.until(state => state.directory === created.path && state.checkout.state === 'ready')
    await rm(created.path, { recursive: true, force: true })
    sendPrompt(opened.agent, 'next')
    await follower.until(state => state.worktree.waiting === 'restoration')
    const pending = follower.next(() => true)
    let published = false
    void pending.then(() => { published = true }, () => undefined)
    const calls = opened.sandbox.calls.length

    sendPrompt(opened.agent, 'again')
    await settle()

    expect(published).toBe(false)
    expect(opened.sandbox.calls).toHaveLength(calls)
    expect(queued(opened)).toEqual(['first', 'next', 'again'])
    expect(opened.agent.wakes).toBe(1)
  })

  it('finds a removed worktree on inspection, and lets messages go on without offering restoration while Git cannot answer', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    const created = await startInWorktree(opened)
    await follower.until(state => state.directory === created.path && state.checkout.state === 'ready')
    await rm(created.path, { recursive: true, force: true })

    await opened.ctx.forgePanel.refresh(opened.session, signal)
    const inspected = await follower.next(state => state.worktree.missing !== null)
    opened.sandbox.failure = new Error('sandbox unavailable')
    sendPrompt(opened.agent, 'next')
    await opened.agent.whenIdle()
    const answer = follower.next(state => state.worktree.missing === null)
    await opened.ctx.forgePanel.refresh(opened.session, signal)
    const unanswered = await answer

    expect(inspected).toMatchObject({ directory: created.path, checkout: { state: 'failed' }, worktree: { missing: { branchExists: true } } })
    expect(unanswered).toMatchObject({ directory: created.path, checkout: { state: 'failed', message: 'sandbox unavailable' }, worktree: { waiting: null } })
    expect(queued(opened)).toEqual(['first', 'next'])
    expect(opened.agent.wakes).toBe(2)
  })

  it('lets the message go on, without publishing the answer, when the Session moved out of the worktree during the check', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    const created = await startInWorktree(opened)
    await follower.until(state => state.directory === created.path && state.checkout.state === 'ready')
    await rm(created.path, { recursive: true, force: true })
    const branchCheck = hold(opened.sandbox, 'show-ref')
    const inspection = hold(opened.sandbox, '--show-toplevel')

    sendPrompt(opened.agent, 'next')
    await branchCheck.reached
    await opened.ctx.workingDirectory.set(opened.agent, repo)
    await inspection.reached
    branchCheck.release()
    await opened.agent.whenIdle()
    const moved = await follower.next(() => true)
    inspection.release()
    await follower.until(state => state.directory === repo && state.checkout.state === 'ready')

    expect(moved).toMatchObject({ directory: repo, checkout: { state: 'pending' }, worktree: { missing: null, waiting: null } })
    expect(opened.agent.wakes).toBe(2)
  })

  it('holds messages for a removed worktree of a Session that no panel follows, until it is left for the source checkout', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })

    sendPrompt(opened.agent, 'before')
    const created = await startInWorktree(opened)
    sendPrompt(opened.agent, 'inside')
    await opened.agent.whenIdle()
    await rm(created.path, { recursive: true, force: true })
    sendPrompt(opened.agent, 'removed')
    await vi.waitFor(() => { expect(() => opened.agent.runMaintenance(() => Promise.resolve())).toThrow('already has active work') })
    const waiting = opened.agent.wakes
    await vi.waitFor(async () => { await expect(opened.ctx.forgePanel.continueInProject(opened.session, signal)).resolves.toBeUndefined() })
    await opened.agent.whenIdle()
    sendPrompt(opened.agent, 'outside')

    expect(waiting).toBe(3)
    expect(opened.agent.wakes).toBe(5)
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
    expect(queued(opened)).toEqual(['before', 'first', 'inside', 'removed', 'outside'])
  })

  it('leaves a worktree whose directory exists unchanged', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const created = await startInWorktree(opened)
    const commands = opened.sandbox.calls.length

    await opened.ctx.forgePanel.restoreWorktree(opened.session, signal)

    expect(opened.sandbox.calls.slice(commands).every(call => !call.argv.includes('add'))).toBe(true)
    expect(await git(created.path, 'symbolic-ref', '--short', 'HEAD')).toBe(created.branch)
  })

  it.each([
    ['an Error', new Error('sandbox unavailable'), 'sandbox unavailable'],
    ['another value', 'denied', 'denied'],
  ])('reports a restoration that fails with %s', async (_label, failure, message) => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const created = await startInWorktree(opened)
    await rm(created.path, { recursive: true, force: true })
    opened.sandbox.failure = failure

    await expect(opened.ctx.forgePanel.restoreWorktree(opened.session, signal))
      .rejects.toMatchObject({ code: 'forgePanel/restore-failed', message, details: {}, cause: failure })
    await expect(access(created.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the message waiting when a restoration inside its wait fails or is aborted, and lets it go on once one succeeds', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    const created = await startInWorktree(opened)
    await follower.until(state => state.directory === created.path && state.checkout.state === 'ready')
    await rm(created.path, { recursive: true, force: true })
    sendPrompt(opened.agent, 'next')
    await follower.until(state => state.worktree.waiting === 'restoration')
    const pruning = hold(opened.sandbox, 'list')
    const caller = new AbortController()
    const reason = new Error('closed')

    const aborted = rejectionOf(opened.ctx.forgePanel.restoreWorktree(opened.session, caller.signal))
    await pruning.reached
    caller.abort(reason)
    pruning.release()
    expect(await aborted).toBe(reason)
    opened.sandbox.failure = new Error('sandbox unavailable')
    await expect(opened.ctx.forgePanel.restoreWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/restore-failed' })
    const still = follower.states.at(-1)
    opened.sandbox.failure = undefined
    await opened.ctx.forgePanel.restoreWorktree(opened.session, signal)
    await opened.agent.whenIdle()

    expect(still?.worktree.waiting).toBe('restoration')
    expect(opened.agent.wakes).toBe(2)
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(created.path)
  })

  it('stops a restoration when the caller aborts', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const created = await startInWorktree(opened)
    await rm(created.path, { recursive: true, force: true })
    const pruning = hold(opened.sandbox, 'list')
    const caller = new AbortController()
    const reason = new Error('closed')

    const restoring = rejectionOf(opened.ctx.forgePanel.restoreWorktree(opened.session, caller.signal))
    await pruning.reached
    caller.abort(reason)
    pruning.release()

    expect(await restoring).toBe(reason)
    await expect(access(created.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to restore without a created worktree or while the Agent has other work', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })

    await expect(opened.ctx.forgePanel.restoreWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/no-worktree' })
    const created = await startInWorktree(opened)
    await rm(created.path, { recursive: true, force: true })
    const release = occupy(opened)
    await expect(opened.ctx.forgePanel.restoreWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/session-busy' })
    await release()

    await expect(access(created.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('forgePanel leaving a worktree', () => {
  it('moves the Session from its removed worktree to the source checkout inside the wait of the message that waits for it', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const follower = reader(opened)
    await follower.until(ready)
    const created = await startInWorktree(opened)
    // The first step would have claimed the first message and the notice of entering the worktree.
    opened.agent.inbox.clear()
    await follower.until(state => state.directory === created.path && state.checkout.state === 'ready')
    await rm(created.path, { recursive: true, force: true })
    const maintenance = vi.spyOn(opened.agent, 'runMaintenance')
    sendPrompt(opened.agent, 'next')
    await follower.until(state => state.worktree.waiting === 'restoration')

    const leaving = follower.next(state => state.directory === repo && state.checkout.state === 'ready' && state.worktree.waiting === null)
    await opened.ctx.forgePanel.continueInProject(opened.session, signal)
    await opened.agent.whenIdle()
    const moved = await leaving

    expect(maintenance).toHaveBeenCalledOnce()
    expect(opened.agent.wakes).toBe(2)
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
    expect(opened.agent.inbox.nextStep).toEqual([notice(repo)])
    expect(queued(opened)).toEqual(['next'])
    expect(moved.checkout).toEqual({ state: 'ready', checkout: { root: repo, branch: 'main', linked: false, commit: COMMIT } })
    expect(moved.worktree).toEqual({ ...UNAVAILABLE, request: { from: null }, created })
    expect(await branches(repo)).toEqual([created.branch, 'main'])
  })

  it('moves the Session to the source checkout as Agent maintenance while no message waits', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await startInWorktree(opened)
    const maintenance = vi.spyOn(opened.agent, 'runMaintenance')

    await opened.ctx.forgePanel.continueInProject(opened.session, signal)

    expect(maintenance).toHaveBeenCalledOnce()
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
  })

  it('refuses to leave without a created worktree, while the Session is not loaded, or while its Agent has other work', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await expect(opened.ctx.forgePanel.continueInProject(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/no-worktree' })
    const created = await startInWorktree(opened)
    const unloaded = opened.ctx.sessions.create(SessionId('forge-panel-unloaded'), { meta: { cwd: created.path } })
    recordWorktree(unloaded, created)
    const release = occupy(opened)

    await expect(opened.ctx.forgePanel.continueInProject(unloaded, signal))
      .rejects.toMatchObject({ code: 'forgePanel/session-busy', message: 'The Session is not loaded' })
    await expect(opened.ctx.forgePanel.continueInProject(opened.session, signal))
      .rejects.toMatchObject({ code: 'forgePanel/session-busy', message: 'The Session is busy' })
    await release()

    expect(opened.ctx.workingDirectory.get(unloaded)).toBe(created.path)
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(created.path)
  })
})

describe('forgePanel worktree service changes', () => {
  it('republishes whether a worktree can be requested when the worktree service appears and leaves', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const follower = reader(opened)
    expect((await follower.until(ready)).worktree.editable).toBe(false)

    const service = opened.ctx.plugin(WorktreeService, {})
    await service
    await follower.until(state => state.worktree.editable)

    await service.dispose()
    await follower.until(state => !state.worktree.editable)
  })

  it('accepts a prefix that Git accepts', async () => {
    const opened = await open(await plain(), { worktreePrefix: 'team/dsh-' })
    expect(opened.ctx.forgePanel).toBeDefined()
  })
})

describe('forgePanel actions', () => {
  it('tracks recognized URLs, rejects others, and dismisses bindings', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const follower = reader(opened)
    await follower.until(ready)

    await expect(opened.ctx.forgePanel.track(opened.session, 'https://elsewhere.test/a/b/pull/1', signal))
      .rejects.toMatchObject({ code: 'forgePanel/unrecognized-url' })
    await opened.ctx.forgePanel.track(opened.session, pullUrl(9), signal)
    await follower.until(state => state.changeRequests.some(entry => entry.url === pullUrl(9) && entry.origin === 'tracked'))
    await opened.ctx.forgePanel.dismiss(opened.session, pullUrl(9), signal)

    await expect(follower.next(state => state.changeRequests.length === 0)).resolves.toBeDefined()
  })

  it('refreshes the checkout, sign-in state, and change requests of a followed Session only', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    await opened.ctx.forgePanel.refresh(opened.session, signal)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    const follower = reader(opened)
    await follower.until(state => ready(state) && polled(state, pullUrl(7)))
    const inspections = opened.sandbox.calls.length

    await opened.ctx.forgePanel.refresh(opened.session, signal)
    await follower.until(() => opened.provider.fetches.length === 2
      && opened.sandbox.calls.length > inspections && opened.provider.probes.length === 2)

    expect(opened.provider.fetches).toEqual([[7], [7]])
  })

  it('settles a refresh once both its inspection and its sign-in probe have ended', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    const follower = reader(opened)
    await follower.until(ready)
    let settled = false

    const inspection = hold(opened.sandbox, '--show-toplevel')
    const inspected = opened.ctx.forgePanel.refresh(opened.session, signal).then(() => { settled = true })
    await inspection.reached
    await settle()
    expect(settled).toBe(false)
    inspection.release()
    await inspected
    await follower.next(() => true)

    const probe = Promise.withResolvers<ForgeReadiness>()
    opened.provider.readinessImpl = () => probe.promise
    settled = false
    const probed = opened.ctx.forgePanel.refresh(opened.session, signal).then(() => { settled = true })
    await follower.next(() => true)
    await settle()
    expect(settled).toBe(false)
    probe.resolve({ state: 'ready', message: null })
    await probed
    expect(opened.provider.probes).toHaveLength(3)
  })

  it('refreshes a Session outside a checkout without polling change requests that no provider serves', async () => {
    const opened = await open(await plain())
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: 'https://unserved.test/a/b/pull/3\n' }])
    const follower = reader(opened)
    await follower.until(state => state.checkout.state === 'none')
    const inspections = opened.sandbox.calls.length

    await opened.ctx.forgePanel.refresh(opened.session, signal)

    const refreshed = await follower.next(state => state.checkout.state === 'none')
    expect(refreshed.changeRequests).toEqual([{ url: 'https://unserved.test/a/b/pull/3', origin: 'created', ref: null, update: null, snapshot: null }])
    expect(opened.sandbox.calls.length).toBeGreaterThan(inspections)
    expect(opened.provider.fetches).toEqual([])
    expect(opened.provider.probes).toEqual([])
  })

  it('marks a bound change request ready and merges it through its provider, reporting what the host refused', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    const follower = reader(opened)
    await follower.until(state => ready(state) && polled(state, pullUrl(7)))
    const head = 'a'.repeat(40)

    await opened.ctx.forgePanel.markReady(opened.session, pullUrl(7), signal)
    await opened.ctx.forgePanel.merge(opened.session, pullUrl(7), 'squash', head, signal)
    opened.provider.actionResult = { code: 'stale', message: 'Head branch was modified' }
    await expect(opened.ctx.forgePanel.merge(opened.session, pullUrl(7), 'rebase', head, signal))
      .rejects.toMatchObject({ code: 'forgePanel/stale-head', message: 'Head branch was modified' })
    opened.provider.actionResult = { code: 'unauthenticated', message: 'Bad credentials' }
    await expect(opened.ctx.forgePanel.markReady(opened.session, pullUrl(7), signal))
      .rejects.toMatchObject({ code: 'forgePanel/action-failed', message: 'Bad credentials' })
    opened.provider.actionResult = { code: 'failed', message: 'Pull Request is not mergeable' }
    await expect(opened.ctx.forgePanel.merge(opened.session, pullUrl(7), 'merge', head, signal))
      .rejects.toMatchObject({ code: 'forgePanel/action-failed', message: 'Pull Request is not mergeable' })

    expect(opened.provider.actions).toEqual(['ready 7', `merge 7 squash ${head}`, `merge 7 rebase ${head}`, 'ready 7', `merge 7 merge ${head}`])
  })

  it('publishes a review only for a visible binding and validates wire ranges before calling the provider', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    await reader(opened).until(state => ready(state) && polled(state, pullUrl(7)))
    const request = { kind: 'comment' as const, headSha: 'a'.repeat(40),
      comment: { path: 'src/app.ts', side: 'R' as const, startLine: 3, endLine: 5, body: 'Please check' } }
    expect(await opened.ctx.forgePanel.submitReview(opened.session, pullUrl(7), request, signal))
      .toMatchObject({ ok: false, code: 'unsupported' })
    const submit = vi.fn(async () => ({ ok: true as const, url: pullUrl(7) }))
    Object.assign(opened.provider, { submitReview: submit })
    expect(await opened.ctx.forgePanel.submitReview(opened.session, pullUrl(7), request, signal))
      .toEqual({ ok: true, url: pullUrl(7) })
    expect(submit).toHaveBeenCalledTimes(1)
    await expect(opened.ctx.forgePanel.submitReview(opened.session, pullUrl(8), request, signal))
      .rejects.toMatchObject({ code: 'forgePanel/not-bound' })
    await expect(opened.ctx.forgePanel.submitReview(opened.session, pullUrl(7), { ...request, headSha: 'invalid' }, signal)).rejects.toThrow('Invalid review commit')
    await expect(opened.ctx.forgePanel.submitReview(opened.session, pullUrl(7), { ...request,
      comment: { ...request.comment, startLine: 6 } }, signal)).rejects.toThrow('Invalid review comment')
    await expect(opened.ctx.forgePanel.submitReview(opened.session, pullUrl(7), {
      kind: 'review', headSha: request.headSha, event: 'comment', body: '', comments: [],
    }, signal)).rejects.toThrow('Empty review')
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('acts only on change requests visibly bound to the Session that a provider serves', async () => {
    const { repo } = await project()
    const opened = await open(repo)
    shellTurn(opened.session, 1, [
      { callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` },
      { callId: 'other', command: 'gh pr create --fill', output: 'https://unserved.test/a/b/pull/3\n' },
    ])
    const follower = reader(opened)
    await follower.until(state => ready(state) && polled(state, pullUrl(7)))
    await opened.ctx.forgePanel.dismiss(opened.session, pullUrl(7), signal)
    const head = 'a'.repeat(40)

    for (const url of [pullUrl(7), pullUrl(8), 'https://unserved.test/a/b/pull/3']) {
      await expect(opened.ctx.forgePanel.markReady(opened.session, url, signal)).rejects.toMatchObject({ code: 'forgePanel/not-bound' })
      await expect(opened.ctx.forgePanel.merge(opened.session, url, 'merge', head, signal)).rejects.toMatchObject({ code: 'forgePanel/not-bound' })
    }
    expect(opened.provider.actions).toEqual([])
  })

  it('lists the base branches of the Session\'s current checkout, at most maxBranches', async () => {
    const { repo } = await project()
    await commitAt(repo, 'main.txt', '2026-03-01T00:00:00Z')
    await git(repo, 'checkout', '-b', 'older')
    await commitAt(repo, 'older.txt', '2026-01-01T00:00:00Z')
    await git(repo, 'checkout', '-b', 'newer', 'main')
    await commitAt(repo, 'newer.txt', '2026-02-01T00:00:00Z')
    const opened = await open(repo, { maxBranches: 2 })

    await expect(opened.ctx.forgePanel.branches(opened.session, signal)).resolves.toEqual({ current: 'newer', branches: ['newer', 'main'] })
  })

  it('refuses to list branches outside a checkout', async () => {
    const opened = await open(await plain())

    await expect(opened.ctx.forgePanel.branches(opened.session, signal))
      .rejects.toThrow(/^git (symbolic-ref|for-each-ref) failed \(128\): fatal: not a git repository/)
  })

  it('checks the caller signal before every action', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const controller = new AbortController()
    controller.abort(new Error('closed'))

    await expect(opened.ctx.forgePanel.track(opened.session, pullUrl(1), controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.dismiss(opened.session, pullUrl(1), controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.refresh(opened.session, controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.localDiff(opened.session, { kind: 'unstaged' }, controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.localText(opened.session, { kind: 'unstaged' }, 'tracked.txt', controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(1), controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.changeRequestText(opened.session, pullUrl(1), 'a'.repeat(40), 'x', controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.markReady(opened.session, pullUrl(1), controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.merge(opened.session, pullUrl(1), 'merge', 'a'.repeat(40), controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.branches(opened.session, controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.requestWorktree(opened.session, null, controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.cancelWorktree(opened.session, controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.stopCreation(opened.session, controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.restoreWorktree(opened.session, controller.signal)).rejects.toThrow('closed')
    await expect(opened.ctx.forgePanel.continueInProject(opened.session, controller.signal)).rejects.toThrow('closed')
    expect(opened.records).toEqual([])
  })
})

describe('forgePanel lifecycle', () => {
  it('removes its Remote, worktree projection, and inbox and pre-step listeners when stopped, and folds the recorded request again after a restart', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    const proposed = prompt('go')

    await opened.panel.dispose()

    expect(opened.ctx.get('forgePanel')).toBeUndefined()
    expect(opened.ctx.sessionProjections.checkpoint(opened.session)).not.toHaveProperty('forgeWorktree')
    sendPrompt(opened.agent, 'go')
    await expect(proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [proposed] })).resolves.toEqual({ kind: 'enter', messages: [proposed] })
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
    expect(opened.agent.wakes).toBe(1)
    expect(queued(opened)).toEqual(['go'])

    await opened.ctx.plugin(ForgePanelController, {})

    expect(opened.ctx.sessionProjections.checkpoint(opened.session).forgeWorktree?.val)
      .toEqual({ request: { from: null }, created: null, locked: false, stepped: false, cwd: repo, restoring: false })
  })
})

describe('forgePanel configuration', () => {
  const prefix = 'forge-panel: worktreePrefix must start a valid Git branch name'

  it.each([
    [{ gitCommand: ' ' }, 'forge-panel: gitCommand must not be empty'],
    [{ gitTimeoutMs: 0 }, 'forge-panel: gitTimeoutMs must be a positive integer no greater than 2147483647'],
    [{ graceMs: 1.5 }, 'forge-panel: graceMs must be a positive integer no greater than 2147483647'],
    [{ maxOutputBytes: -1 }, 'forge-panel: maxOutputBytes must be a positive integer no greater than 2147483647'],
    [{ readinessTimeoutMs: 2_147_483_648 }, 'forge-panel: readinessTimeoutMs must be a positive integer no greater than 2147483647'],
    [{ maxBranches: 0 }, 'forge-panel: maxBranches must be a positive integer'],
    [{ maxBranches: 2.5 }, 'forge-panel: maxBranches must be a positive integer'],
    [{ maxCachedDiffBytes: 0 }, 'forge-panel: maxCachedDiffBytes must be a positive integer'],
    [{ worktreePrefix: '-dsh/' }, prefix],
    [{ worktreePrefix: 'dsh /' }, prefix],
    [{ worktreePrefix: 'dsh:' }, prefix],
    [{ worktreePrefix: 'dsh\\' }, prefix],
    [{ worktreePrefix: '/dsh/' }, prefix],
    [{ worktreePrefix: 'dsh//' }, prefix],
    [{ worktreePrefix: './' }, prefix],
    [{ worktreePrefix: 'dsh/../' }, prefix],
    [{ worktreePrefix: '.x/' }, prefix],
    [{ worktreePrefix: 'a..b/' }, prefix],
    [{ worktreePrefix: 'x.lock/' }, prefix],
    [{ worktreePrefix: 'x~' }, prefix],
    [{ worktreePrefix: 'x^' }, prefix],
    [{ worktreePrefix: 'x?' }, prefix],
    [{ worktreePrefix: 'x*' }, prefix],
    [{ worktreePrefix: 'x[' }, prefix],
    [{ worktreePrefix: 'x@{' }, prefix],
    [{ worktreePrefix: 'x\u007f' }, prefix],
    [{ worktreePrefix: 'x\t' }, prefix],
  ])('rejects %j at load', async (config, message) => {
    const opened = await open(await plain())
    await opened.panel.dispose()

    await expect(opened.ctx.plugin(ForgePanelController, config)).rejects.toThrow(message)
  })
})


describe('worktree recovery and unload', () => {
  it('keeps a failed restoration blocked after the panel reloads, despite its leftover directory', async () => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const created = await startInWorktree(opened)
    await rm(created.path, { recursive: true, force: true })
    const occupied = join(repo, '.agents/worktrees/occupied')
    await git(repo, 'worktree', 'add', '--force', occupied, created.branch)
    await expect(opened.ctx.forgePanel.restoreWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/restore-failed' })
    await expect(access(created.path)).resolves.toBeUndefined()
    expect(worktreeState(opened).restoring).toBe(true)
    await opened.panel.dispose()
    await opened.ctx.plugin(ForgePanelController, {})
    const follower = reader(opened)
    await follower.until(state => state.worktree.missing !== null)
    const wakes = opened.agent.wakes
    opened.sandbox.failure = new Error('Git temporarily unavailable')
    sendPrompt(opened.agent, 'after failure')
    await follower.until(state => state.worktree.waiting === 'restoration')
    expect(opened.agent.wakes).toBe(wakes)
    expect(follower.states.at(-1)?.worktree.missing).toEqual({ branchExists: null })
    opened.sandbox.failure = undefined
    await expect(opened.ctx.forgePanel.restoreWorktree(opened.session, signal)).rejects.toMatchObject({ code: 'forgePanel/restore-failed' })
    expect(opened.agent.wakes).toBe(wakes)
    await opened.ctx.forgePanel.continueInProject(opened.session, signal)
    await opened.agent.whenIdle()
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
  })

  it.each(['creation', 'restoration', 'validation'] as const)('waits for cancelled %s before completing panel unload', async (kind) => {
    const { repo } = await project()
    const opened = await open(repo, {}, { worktrees: true })
    const created = kind !== 'creation' ? await startInWorktree(opened) : undefined
    if (created !== undefined) await rm(created.path, { recursive: true, force: true })
    else await opened.ctx.forgePanel.requestWorktree(opened.session, null, signal)
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const released: PromiseWithResolvers<void> = Promise.withResolvers()
    let cancellation: AbortSignal | undefined
    const confine = opened.ctx.sandbox.confine.bind(opened.ctx.sandbox)
    const inspection = vi.spyOn(opened.ctx.sandbox, 'confine').mockImplementation(async (argv, policy, signal) => {
      if (kind === 'validation' && argv.includes('show-ref')) {
        cancellation = signal; entered.resolve(); await released.promise
      }
      return confine(argv, policy, signal)
    })
    const create = vi.spyOn(opened.ctx.worktrees, 'create').mockImplementation(async (_agent, _request, signal) => {
      cancellation = signal; entered.resolve(); await released.promise
      return { path: join(repo, '.agents/worktrees/pending'), branch: 'pending', repositoryRoot: repo, baseCommit: 'a'.repeat(40) }
    })
    const restore = vi.spyOn(opened.ctx.worktrees, 'restore').mockImplementation(async (_agent, request, signal) => {
      cancellation = signal; entered.resolve(); await released.promise
      return { path: request.path, branchRecreated: false }
    })
    const operation = rejectionOf(kind === 'creation'
      ? proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [prompt('go')] })
      : opened.ctx.forgePanel.restoreWorktree(opened.session, signal))
    let disposed = false
    let unloading: Promise<void> | undefined
    try {
      await entered.promise
      unloading = opened.panel.dispose().then(() => { disposed = true })
      await vi.waitFor(() => { expect(cancellation?.aborted).toBe(true) })
      expect(disposed).toBe(false)
      released.resolve()
      expect(await operation).toBeInstanceOf(Error)
      await unloading
      expect(opened.records.filter(record => typeof record === 'object' && record !== null && 'action' in record
        && record.action === (kind === 'creation' ? 'created' : 'restored'))).toEqual([])
    } finally {
      released.resolve()
      await Promise.allSettled([operation, ...unloading === undefined ? [] : [unloading]])
      create.mockRestore(); restore.mockRestore(); inspection.mockRestore()
    }
  })
})


it.each(['empty', 'foreign', 'non-git'] as const)('keeps a recorded worktree unavailable when its directory is %s', async (kind) => {
  const { repo } = await project()
  const opened = await open(repo, {}, { worktrees: true })
  const created = await startInWorktree(opened)
  await rm(created.path, { recursive: true, force: true })
  const path = kind === 'non-git' ? await plain() : created.path
  if (kind !== 'non-git') await mkdir(path)
  if (kind === 'foreign') await git(path, 'init', '-b', 'other')
  const state = { ...worktreeState(opened), created: { ...created, path } }
  expect(await missingWorktree(opened.ctx, { gitCommand: 'git', gitTimeoutMs: 10_000, graceMs: 500, maxOutputBytes: 1_048_576 },
    opened.session, state, path, signal)).toEqual({ branchExists: true })
})

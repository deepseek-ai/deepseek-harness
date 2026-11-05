import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentCancelCause } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-forge-session'
import SessionStore, { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ForgeSessionWorktree, ForgeWorktreeCreation, ForgeWorktreeState } from '../src/index.ts'
import { CreationFailure, forgeWorktreeProjection, WORKTREE_RECORD, WorktreeCreations } from '../src/worktree.ts'
import {
  branches, commitAt, git, hold, notice, plainSession, prompt, proposeStep, rejectionOf, repository, runtime, scratch, startStep, startTurn,
} from './harness.ts'
import type { Runtime } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const signal = new AbortController().signal

const WORKTREE: ForgeSessionWorktree = {
  path: '/work/repo/.agents/worktrees/dsh/0a1b2c3d', branch: 'dsh/0a1b2c3d', from: null, baseCommit: 'c'.repeat(40), repositoryRoot: '/work/repo',
}

/** The state before any worktree record, turn, step, or directory change of a Session without a recorded directory. */
const EMPTY: ForgeWorktreeState = { request: null, created: null, locked: false, stepped: false, cwd: null, restoring: false }

/** A live Session whose `forgeWorktree` state a registry folds without the panel Remote. */
async function folded(): Promise<{ ctx: Context; session: Session; state: () => ForgeWorktreeState }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const states = await ctx.sessionProjections.register(forgeWorktreeProjection)
  const session = ctx.sessions.create(SessionId('forge-worktree-projection'))
  return { ctx, session, state: () => states.stateOf(session) }
}

describe('forgeWorktree projection', () => {
  it('shows clients the created worktree in the Session summary while the Session works in it', async () => {
    const { ctx, session, state } = await folded()
    const published: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => { if (key === 'forgeWorktree') published.push(value) })

    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: 'main' })
    session.append('working-directory/change', { cwd: WORKTREE.path })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: WORKTREE })
    startTurn(session, 1)
    startStep(session, 1)
    session.append('working-directory/change', { cwd: join(WORKTREE.path, 'packages') })
    const inside = [...published]
    session.append('working-directory/change', { cwd: WORKTREE.repositoryRoot })
    // Shares the worktree's path as a string prefix without lying below it.
    session.append('working-directory/change', { cwd: `${WORKTREE.path}-sibling` })
    const outside = [...published]
    session.append('working-directory/change', { cwd: WORKTREE.path })
    const returned = state()
    session.append('working-directory/change', { cwd: WORKTREE.path })

    expect(state()).toBe(returned)
    expect(inside.at(-1)).toEqual(WORKTREE)
    expect(inside.filter(value => value !== null)).toEqual([WORKTREE])
    expect(outside.slice(inside.length)).toEqual([null])
    expect(published.slice(outside.length)).toEqual([WORKTREE])
    expect(ctx.sessionProjections.summaryKeys().has('forgeWorktree')).toBe(true)
  })

  it('starts from the directory the Session header records', () => {
    expect(forgeWorktreeProjection.init(plainSession('/work/repo').header)).toEqual({ ...EMPTY, cwd: '/work/repo' })
  })

  it('replays incomplete restoration until an explicit successful completion', async () => {
    const { session, state } = await folded()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'restoring' })
    expect(state().restoring).toBe(false)
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: null })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: WORKTREE })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'restoring' })
    expect(state().restoring).toBe(true)
    const checkpoint = state()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'restoring' })
    expect(state()).toBe(checkpoint)
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'restored' })
    expect(state().restoring).toBe(false)
    const restored = state()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'restored' })
    expect(state()).toBe(restored)
  })

  it('starts without a request, a created worktree, a started turn, or a started step', async () => {
    const { state } = await folded()

    expect(state()).toEqual(EMPTY)
  })

  it('opens, replaces, and withdraws the request until the first turn starts', async () => {
    const { session, state } = await folded()

    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: null })
    expect(state()?.request).toEqual({ from: null })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: 'main' })
    expect(state()?.request).toEqual({ from: 'main' })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'cancel' })
    const withdrawn = state()
    expect(withdrawn).toEqual(EMPTY)
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'cancel' })
    expect(state()).toBe(withdrawn)

    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: 'feat' })
    startTurn(session, 1)
    const locked = state()
    expect(locked).toEqual({ ...EMPTY, request: { from: 'feat' }, locked: true })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: 'main' })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'cancel' })
    expect(state()).toBe(locked)
  })

  it('applies the first created worktree of an open request, after which requests, withdrawals, and creations change nothing', async () => {
    const { session, state } = await folded()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: 'main' })

    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: { ...WORKTREE, from: 'main' } })
    const created = state()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: { ...WORKTREE, branch: 'dsh/ffffffff' } })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: null })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'cancel' })

    expect(created).toEqual({ ...EMPTY, request: { from: 'main' }, created: { ...WORKTREE, from: 'main' } })
    expect(state()).toBe(created)
  })

  it('applies a created worktree after the first turn starts, until the first step starts', async () => {
    const { session, state } = await folded()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: null })
    startTurn(session, 1)

    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: WORKTREE })
    const created = state()
    startStep(session, 1)

    expect(created).toEqual({ ...EMPTY, request: { from: null }, created: WORKTREE, locked: true })
    expect(state()).toEqual({ ...EMPTY, request: { from: null }, created: WORKTREE, locked: true, stepped: true })
  })

  it('ignores a created worktree without an open request or after the first step starts', async () => {
    const { session, state } = await folded()
    const initial = state()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: WORKTREE })
    expect(state()).toBe(initial)

    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: null })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'cancel' })
    const withdrawn = state()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: WORKTREE })
    expect(state()).toBe(withdrawn)

    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: null })
    startTurn(session, 1)
    startStep(session, 1)
    const stepped = state()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: WORKTREE })

    expect(stepped).toEqual({ ...EMPTY, request: { from: null }, locked: true, stepped: true })
    expect(state()).toBe(stepped)
  })

  it('counts only the first turn start and the first step start', async () => {
    const { session, state } = await folded()
    startTurn(session, 1)
    const locked = state()
    startTurn(session, 2)
    expect(state()).toBe(locked)

    startStep(session, 2)
    const stepped = state()
    startStep(session, 2, 2)
    startTurn(session, 3)

    expect(locked).toEqual({ ...EMPTY, locked: true })
    expect(stepped).toEqual({ ...EMPTY, locked: true, stepped: true, restoring: false })
    expect(state()).toBe(stepped)
  })

  it('ignores malformed worktree records, other plugin records, and other events', async () => {
    const { session, state } = await folded()
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: 'main' })
    const requested = state()
    const cancelWithReason = { action: 'cancel' as const, reason: 'stale' }

    appendPluginRecord(session, WORKTREE_RECORD, { action: 'request', from: '' })
    appendPluginRecord(session, WORKTREE_RECORD, cancelWithReason)
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: { ...WORKTREE, path: '' } })
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree: { ...WORKTREE, repositoryRoot: '' } })
    appendPluginRecord(session, 'plugin:forge-session/binding', { action: 'track', url: 'https://fake.test/octo/demo/pull/1' })
    session.append('step/end', { turn: 1, step: 1 })

    expect(state()).toBe(requested)
    expect(requested).toEqual({ ...EMPTY, request: { from: 'main' } })
  })
})

async function project(): Promise<string> {
  const { path, remove } = await scratch('dsh-forge-worktree-')
  cleanups.push(remove)
  return await repository(path)
}

/** A {@link Runtime} with the `forgeWorktree` unit and its own {@link WorktreeCreations} in place of the panel Remote. */
interface Creating extends Runtime {
  readonly creations: WorktreeCreations
  /** Reads the `forgeWorktree` projection the creations read. */
  readonly states: ProjectionHandle<ForgeWorktreeState>
  /** The Session's running creation at each `changed` call, in call order. */
  readonly changes: (ForgeWorktreeCreation | null)[]
  /** The Session's created worktree at each `changed` call, in call order. */
  readonly recorded: (ForgeSessionWorktree | null)[]
}

/**
 * Open a {@link runtime} whose worktree creations report every change.
 * @param cwd - Session project directory.
 * @param options - branch prefix, `dsh-` when omitted, and whether the worktree service is mounted, as it is when omitted.
 * @returns the composition.
 */
async function creating(cwd: string, options: { readonly prefix?: string; readonly worktrees?: boolean } = {}): Promise<Creating> {
  const base = await runtime(cwd, { worktrees: options.worktrees ?? true })
  cleanups.push(() => base.ctx.fiber.dispose())
  const states = await base.ctx.sessionProjections.register(forgeWorktreeProjection)
  const changes: (ForgeWorktreeCreation | null)[] = []
  const recorded: (ForgeSessionWorktree | null)[] = []
  const creations: WorktreeCreations = new WorktreeCreations(base.ctx, states, options.prefix ?? 'dsh-', (session) => {
    changes.push(creations.of(session))
    recorded.push(states.stateOf(session).created)
  })
  return { ...base, creations, states, changes, recorded }
}

/** Matches a generated branch name with the default prefix. */
const GENERATED_BRANCH: unknown = expect.stringMatching(/^dsh-[0-9a-f]{8}$/)

/** Matches the failure of an attempt whose base branch does not exist. */
const MISSING_BASE: unknown = expect.stringMatching(/^worktree command failed \(128\): fatal: /)

function request(opened: Runtime, from: string | null): void {
  appendPluginRecord(opened.session, WORKTREE_RECORD, { action: 'request', from })
}

function stateOf(opened: Creating): ForgeWorktreeState {
  return opened.states.stateOf(opened.session)
}

function worktreeOf(opened: Creating): ForgeSessionWorktree | null {
  return stateOf(opened).created
}

describe('creating a requested worktree', () => {
  it('creates a branch and checkout from HEAD with a new name, enters it, and records it with the source repository root', async () => {
    const repo = await project()
    const opened = await creating(repo)
    const head = await git(repo, 'rev-parse', 'HEAD')
    request(opened, null)

    const result = await opened.creations.create(opened.agent, null, signal, false)

    const branch = result.branch
    expect(branch).toMatch(/^dsh-[0-9a-f]{8}$/)
    const path = join(repo, '.agents', 'worktrees', ...branch.split('/'))
    const created = { path, branch, from: null, baseCommit: head, repositoryRoot: repo }
    expect(result).toEqual({ path, branch, baseCommit: head, repositoryRoot: repo })
    expect(worktreeOf(opened)).toEqual(created)
    expect(opened.records).toEqual([{ action: 'request', from: null }, { action: 'created', worktree: created }])
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(path)
    expect(opened.ctx.sessionProjections.snapshot(opened.session, ['forgeWorktree']).values).toEqual({ forgeWorktree: created })
    expect(await git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(branch)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(head)
    expect(opened.agent.inbox.nextStep).toEqual([notice(path)])
  })

  it('reports the attempt when it starts and before each step, and ends it only after recording the worktree', async () => {
    const repo = await project()
    const opened = await creating(repo)
    request(opened, null)

    const result = await opened.creations.create(opened.agent, null, signal, false)

    const running = { branch: result.branch, from: null, held: false }
    expect(opened.changes).toEqual([{ ...running, phase: 'prepare' }, { ...running, phase: 'prepare' }, { ...running, phase: 'checkout' }, null])
    expect(opened.recorded).toEqual([null, null, null, worktreeOf(opened)])
    expect(worktreeOf(opened)).not.toBeNull()
    expect(opened.creations.of(opened.session)).toBeNull()
  })

  it('starts the branch from the given base branch', async () => {
    const repo = await project()
    await git(repo, 'checkout', '-b', 'base')
    const base = await commitAt(repo, 'base.txt', '2026-01-01T00:00:00Z')
    await git(repo, 'checkout', 'main')
    const opened = await creating(repo)
    request(opened, 'base')

    await opened.creations.create(opened.agent, 'base', signal, false)

    const created = worktreeOf(opened)
    expect(created).toMatchObject({ from: 'base', baseCommit: base })
    expect(opened.changes[0]).toMatchObject({ from: 'base' })
    await expect(access(join(created?.path ?? repo, 'base.txt'))).resolves.toBeUndefined()
    expect(await git(repo, 'rev-parse', 'HEAD')).not.toBe(base)
  })

  it('names the branch and checkout with the given prefix', async () => {
    const repo = await project()
    const opened = await creating(repo, { prefix: 'agent/task-' })
    request(opened, null)

    const result = await opened.creations.create(opened.agent, null, signal, false)

    expect(result.branch).toMatch(/^agent\/task-[0-9a-f]{8}$/)
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(join(repo, '.agents', 'worktrees', ...result.branch.split('/')))
  })

  it('fails with the branch and step of a failed attempt, recording nothing and keeping the request open', async () => {
    const repo = await project()
    const opened = await creating(repo)
    request(opened, 'later')

    const attempt = opened.creations.create(opened.agent, 'later', signal, false)
    const branch = opened.changes[0]?.branch
    const cause: unknown = expect.objectContaining({ message: MISSING_BASE })

    await expect(attempt).rejects.toBeInstanceOf(CreationFailure)
    await expect(attempt).rejects.toMatchObject({
      name: 'CreationFailure',
      message: `The requested worktree ${branch} could not be created`,
      branch,
      phase: 'prepare',
      reason: MISSING_BASE,
      cause,
    })
    expect(branch).toEqual(GENERATED_BRANCH)
    const running = { phase: 'prepare', branch, from: 'later', held: false }
    expect(opened.changes).toEqual([running, running, null])
    expect(opened.records).toEqual([{ action: 'request', from: 'later' }])
    expect(stateOf(opened)).toEqual({ ...EMPTY, request: { from: 'later' }, cwd: repo })
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
  })

  it('names the checkout step when writing the files fails, retaining the new branch', async () => {
    const repo = await project()
    const opened = await creating(repo)
    request(opened, null)
    opened.sandbox.gate = argv => argv.includes('reset') ? Promise.reject(new Error('checkout refused')) : undefined

    const attempt = opened.creations.create(opened.agent, null, signal, false)
    const branch = opened.changes[0]?.branch ?? ''

    await expect(attempt).rejects.toMatchObject({
      branch,
      phase: 'checkout',
      reason: `Could not finish worktree ${branch} at ${join(repo, '.agents', 'worktrees', ...branch.split('/'))}. `
        + 'Any created checkout and branch are retained. checkout refused',
    })
    expect(opened.changes.map(change => change?.phase ?? null)).toEqual(['prepare', 'prepare', 'checkout', null])
    expect(opened.records).toEqual([{ action: 'request', from: null }])
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
    expect(await branches(repo)).toEqual([branch, 'main'])
  })

  it('reports a failure that is not an Error by its text', async () => {
    const repo = await project()
    const opened = await creating(repo)
    request(opened, null)
    opened.sandbox.failure = 'confinement denied'

    await expect(opened.creations.create(opened.agent, null, signal, false))
      .rejects.toMatchObject({ phase: 'prepare', reason: 'confinement denied', cause: 'confinement denied' })
    expect(opened.changes.at(-1)).toBeNull()
  })
})

describe('worktree creation at the first step proposal', () => {
  it('creates the requested worktree, enters it, and adds the directory notice to the proposed messages', async () => {
    const repo = await project()
    const opened = await creating(repo)
    const head = await git(repo, 'rev-parse', 'HEAD')
    const queued = prompt('queued steering')
    opened.agent.inbox.append('next-step', queued)
    request(opened, null)
    startTurn(opened.session, 1)
    const proposed = prompt('Fix the bug')

    const decision = await proposeStep(opened.ctx, opened.agent, {
      turn: 1, step: 1, messages: [proposed], decision: { kind: 'enter', messages: [proposed], startsRequestSeries: true },
    })

    const created = worktreeOf(opened)
    const branch = created?.branch ?? ''
    expect(branch).toMatch(/^dsh-[0-9a-f]{8}$/)
    const path = join(repo, '.agents', 'worktrees', ...branch.split('/'))
    expect(created).toEqual({ path, branch, from: null, baseCommit: head, repositoryRoot: repo })
    expect(opened.records).toEqual([{ action: 'request', from: null }, { action: 'created', worktree: created }])
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(path)
    expect(await git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(branch)
    expect(decision).toEqual({ kind: 'enter', messages: [proposed, notice(path)], startsRequestSeries: true })
    expect(opened.agent.inbox.nextStep).toEqual([queued])
    expect(opened.changes[0]).toMatchObject({ held: false })
    expect(opened.changes.at(-1)).toBeNull()
  })

  it('leaves the directory notice queued for a proposal without messages', async () => {
    const repo = await project()
    const opened = await creating(repo)
    request(opened, null)

    const decision = await proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1 })

    const path = opened.ctx.workingDirectory.get(opened.session)
    expect(path).toBe(worktreeOf(opened)?.path)
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(opened.agent.inbox.nextStep).toEqual([notice(path)])
  })

  it('leaves the directory notice queued when a later listener rejects the step, and creates no second worktree', async () => {
    const repo = await project()
    const opened = await creating(repo)
    request(opened, null)
    const proposed = prompt('go')

    const rejected = await proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [proposed], decision: { kind: 'reject' } })
    const path = opened.ctx.workingDirectory.get(opened.session)
    const entered = await proposeStep(opened.ctx, opened.agent, { turn: 2, step: 1, messages: [proposed] })

    expect(rejected).toEqual({ kind: 'reject' })
    expect(path).toBe(worktreeOf(opened)?.path)
    expect(entered).toEqual({ kind: 'enter', messages: [proposed] })
    expect(opened.agent.inbox.nextStep).toEqual([notice(path)])
    expect(opened.records).toHaveLength(2)
    expect(await branches(repo)).toEqual([worktreeOf(opened)?.branch, 'main'])
  })

  it('enters the worktree and keeps the proposal when the directory notice cannot be queued', async () => {
    const repo = await project()
    const opened = await creating(repo)
    vi.spyOn(opened.agent, 'inject').mockImplementation(() => { throw new Error('the inbox is closed') })
    request(opened, null)
    const proposed = prompt('go')

    const decision = await proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [proposed] })

    expect(decision).toEqual({ kind: 'enter', messages: [proposed] })
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(worktreeOf(opened)?.path)
    expect(opened.agent.inbox.nextStep).toEqual([])
  })

  it('passes a proposal through without a request, at a later step, and after a step started', async () => {
    const repo = await project()
    const opened = await creating(repo)
    const proposed = prompt('go')
    const entered = { kind: 'enter', messages: [proposed] }

    await expect(proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [proposed] })).resolves.toEqual(entered)
    request(opened, null)
    await expect(proposeStep(opened.ctx, opened.agent, { turn: 1, step: 2, messages: [proposed] })).resolves.toEqual(entered)
    startStep(opened.session, 1)
    await expect(proposeStep(opened.ctx, opened.agent, { turn: 2, step: 1, messages: [proposed] })).resolves.toEqual(entered)

    expect(worktreeOf(opened)).toBeNull()
    expect(opened.changes).toEqual([])
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
    expect(await branches(repo)).toEqual(['main'])
    expect(opened.agent.inbox.nextStep).toEqual([])
  })

  it('passes the first step proposal through once the requested worktree exists', async () => {
    const repo = await project()
    const opened = await creating(repo)
    request(opened, null)
    const created = await opened.creations.create(opened.agent, null, signal, false)
    const reports = opened.changes.length
    const proposed = prompt('go')

    const decision = await proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [proposed] })

    expect(decision).toEqual({ kind: 'enter', messages: [proposed] })
    expect(opened.changes).toHaveLength(reports)
    expect(opened.records).toHaveLength(2)
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(created.path)
    expect(await branches(repo)).toEqual([created.branch, 'main'])
  })

  it('ends the turn with the failure and keeps the request open for the next turn', async () => {
    const repo = await project()
    const opened = await creating(repo)
    request(opened, 'later')
    startTurn(opened.session, 1)

    await expect(proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [prompt('go')] }))
      .rejects.toMatchObject({ name: 'CreationFailure', branch: GENERATED_BRANCH, phase: 'prepare', reason: MISSING_BASE })
    const failed = opened.changes[0]?.branch
    expect(stateOf(opened)).toEqual({ ...EMPTY, request: { from: 'later' }, locked: true, cwd: repo })
    expect(opened.records).toEqual([{ action: 'request', from: 'later' }])
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)

    await git(repo, 'branch', 'later')
    startTurn(opened.session, 2)
    const proposed = prompt('again')
    const entered = await proposeStep(opened.ctx, opened.agent, { turn: 2, step: 1, messages: [proposed] })

    const created = worktreeOf(opened)
    expect(created).toMatchObject({ from: 'later', baseCommit: await git(repo, 'rev-parse', 'later') })
    expect(created?.branch).not.toBe(failed)
    expect(entered).toEqual({ kind: 'enter', messages: [proposed, notice(created?.path ?? '')] })
  })

  it('ends the turn with its cancellation reason when the turn is cancelled during the attempt', async () => {
    const repo = await project()
    const opened = await creating(repo)
    request(opened, null)
    const held = hold(opened.sandbox, 'check-ref-format')
    const controller = new AbortController()
    const cause: AgentCancelCause = { kind: 'user' }

    const settled = rejectionOf(proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [prompt('go')], signal: controller.signal }))
    await held.reached
    controller.abort(cause)
    held.release()

    expect(await settled).toBe(cause)
    expect(opened.changes.at(-1)).toBeNull()
    expect(opened.records).toEqual([{ action: 'request', from: null }])
    expect(stateOf(opened)).toEqual({ ...EMPTY, request: { from: null }, cwd: repo })
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
    expect(await branches(repo)).toEqual(['main'])
  })

  it('fails the proposal and keeps the request open without a worktree service', async () => {
    const repo = await project()
    const opened = await creating(repo, { worktrees: false })
    request(opened, null)

    await expect(proposeStep(opened.ctx, opened.agent, { turn: 1, step: 1, messages: [prompt('go')] }))
      .rejects.toThrow('No worktree service is mounted')
    expect(stateOf(opened)).toEqual({ ...EMPTY, request: { from: null }, cwd: repo })
    expect(opened.changes).toEqual([])
    expect(opened.ctx.workingDirectory.get(opened.session)).toBe(repo)
  })
})


it('does not admit a new message hold after worktree operations stop', async () => {
  const opened = await creating(await project())
  request(opened, null)
  await opened.creations.dispose()
  opened.creations.holdCreation(opened.agent)
  expect(opened.creations.waitingOf(opened.session)).toBeNull()
  expect(opened.changes).toEqual([])
})

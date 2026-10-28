/** The worktree a Session requests before it starts: its record, its projection, and its creation. */

import { isAbsolute, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { generatedWorktreeName } from '@deepseek-ai/dsh-experimental-worktree'
import type { CreatedWorktree, CreateWorktreePhase } from '@deepseek-ai/dsh-experimental-worktree'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-working-directory'
import { z } from 'zod'
import type {
  ForgeMissingWorktree, ForgeSessionWorktree, ForgeWorktreeCreation, ForgeWorktreeFailure, ForgeWorktreeRestoration, ForgeWorktreeState,
  ForgeWorktreeWaiting, WorktreeRecord,
} from './types.ts'

/** Plugin record type of worktree requests, withdrawals, and creations. */
export const WORKTREE_RECORD = 'plugin:client-ui-forge/worktree'

const EMPTY: Omit<ForgeWorktreeState, 'cwd'> = { request: null, created: null, locked: false, stepped: false, restoring: false }

const worktreeSchema: z.ZodType<ForgeSessionWorktree> = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  from: z.string().min(1).nullable(),
  baseCommit: z.string().min(1),
  repositoryRoot: z.string().min(1),
}).strict()

const recordSchema: z.ZodType<WorktreeRecord> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), from: z.string().min(1).nullable() }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('created'), worktree: worktreeSchema }).strict(),
  z.object({ action: z.literal('restoring') }).strict(),
  z.object({ action: z.literal('restored') }).strict(),
])

const stateSchema: z.ZodType<ForgeWorktreeState> = z.object({
  request: z.object({ from: z.string().min(1).nullable() }).strict().nullable(),
  created: worktreeSchema.nullable(),
  locked: z.boolean(),
  stepped: z.boolean(),
  restoring: z.boolean(),
  cwd: z.string().min(1).nullable(),
}).strict()

/**
 * The `forgeWorktree` unit. `request` and `cancel` records change the request
 * until the first `turn/start` or creation; the first `created` record of an
 * open request applies until the first `step/start`. Records outside those
 * periods leave the state unchanged. The unit also follows the Session's
 * working directory, so clients, including the Session summary, see the
 * created worktree only while that directory is the worktree or lies below it.
 * Restoration records retain incomplete checkout recovery across reloads.
 */
export const forgeWorktreeProjection = {
  key: 'forgeWorktree',
  stateVersion: 4,
  stateSchema,
  init: header => ({ ...EMPTY, cwd: header.cwd ?? null }),
  apply,
  wire: {
    viewSchema: worktreeSchema.nullable(),
    view: state => state.created !== null && state.cwd !== null && within(state.created.path, state.cwd) ? state.created : null,
  },
} satisfies ProjectionDefinition<'forgeWorktree', ForgeWorktreeState>

/**
 * Whether `path` is `root` or lies below it.
 * @param root - absolute directory.
 * @param path - absolute path.
 * @returns whether `root` contains `path`.
 */
export function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/**
 * The text of a failure: an Error's message, or else the thrown value as a string.
 * @param error - what was thrown.
 * @returns the text.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function apply(state: ForgeWorktreeState, event: SessionEvent): ForgeWorktreeState {
  switch (event.type) {
    case 'turn/start':
      return state.locked ? state : { ...state, locked: true }
    case 'step/start':
      return state.stepped ? state : { ...state, stepped: true }
    case 'working-directory/change':
      return state.cwd === event.data.cwd ? state : { ...state, cwd: event.data.cwd }
    // Every other event type, including plugin records, which sit outside SessionEventMap.
    default:
      return applyRecord(state, event)
  }
}

function applyRecord(state: ForgeWorktreeState, event: SessionEvent): ForgeWorktreeState {
  const record = pluginRecordOf(event)
  if (record?.type !== WORKTREE_RECORD) return state
  const parsed = recordSchema.safeParse(record.data)
  if (!parsed.success) return state
  const data = parsed.data
  const settled = state.created !== null
  switch (data.action) {
    case 'request':
      return state.locked || settled ? state : { ...state, request: { from: data.from } }
    case 'cancel':
      return state.locked || settled || state.request === null ? state : { ...state, request: null }
    case 'created':
      return settled || state.stepped || state.request === null ? state : { ...state, created: data.worktree }
    case 'restoring':
      return !settled || state.restoring ? state : { ...state, restoring: true }
    case 'restored':
      return !state.restoring ? state : { ...state, restoring: false }
    /* v8 ignore next -- closed WorktreeRecord action union exhaustiveness guard */
    default: return assertNever(data, 'WorktreeRecord.action')
  }
}

/** A failed attempt to create a requested worktree; `cause` holds the worktree service's error. */
export class CreationFailure extends Error {
  /**
   * @param branch - branch the attempt created.
   * @param phase - step that failed.
   * @param reason - the worktree service's failure text.
   * @param cause - the worktree service's error.
   */
  constructor(readonly branch: string, readonly phase: CreateWorktreePhase, readonly reason: string, cause: unknown) {
    super(`The requested worktree ${branch} could not be created`, { cause })
    this.name = 'CreationFailure'
  }
}

/**
 * The failure a waiting message shows for an attempt.
 * @param error - what the attempt threw.
 * @param from - base branch of the attempt, or null for HEAD.
 * @returns the failure.
 */
function failureOf(error: unknown, from: string | null): ForgeWorktreeFailure {
  return error instanceof CreationFailure
    ? { branch: error.branch, from, phase: error.phase, message: error.reason }
    : { branch: null, from, phase: 'prepare', message: messageOf(error) }
}

/** Work on a Session's checkout that runs as maintenance of its Agent. */
export type HeldWork = (agent: Agent, signal: AbortSignal) => Promise<void>

/** A message's wait for the creation of the requested worktree. */
interface CreationHold {
  readonly kind: 'creation'
  /** Stops the running attempt. */
  stop: AbortController | undefined
  /** The wait for the next decision: another attempt, or reading the request again. */
  next: PromiseWithResolvers<'retry' | 'recheck'> | undefined
}

/** A message's wait for the restoration or leaving of the removed worktree the Session works in. */
interface RestorationHold {
  readonly kind: 'restoration'
  /** Whether the check found the worktree gone. */
  waiting: boolean
  /** The wait for the work that restores or leaves the worktree, with its outcome. */
  next: PromiseWithResolvers<{ readonly work: HeldWork; readonly done: PromiseWithResolvers<void> }> | undefined
}

type Hold = CreationHold | RestorationHold

/**
 * Creates requested worktrees, one attempt with a new branch name per call,
 * and holds the turn of a message while the Session's worktree is not ready.
 * A hold is maintenance of the Session's Agent that starts while the message
 * enters the inbox, before the delivery wakes the Agent, so the Agent starts
 * the message's turn once the hold ends. A creation hold makes an attempt
 * and, after a failed or stopped one, waits for another attempt or for the
 * request to be withdrawn; a restoration hold checks the worktree the Session
 * works in and, when it is gone, waits until it is restored or left. The
 * Agent's cancellation and the panel's stop end a hold. The first step
 * proposal of a Session whose request is still open also creates the
 * worktree, which covers a message no hold took. The worktree service enters
 * the created checkout and queues its directory notice; at a step proposal
 * the notice joins the proposed messages so the first request already names
 * the new directory, a proposal without messages leaves it queued, and a
 * failure ends the turn with the request still open. A failed attempt may
 * leave its branch or checkout behind.
 */
export class WorktreeCreations {
  private readonly live = new Map<Session, ForgeWorktreeCreation>()
  private readonly restorations = new Map<Session, ForgeWorktreeRestoration>()
  private readonly failures = new Map<Session, ForgeWorktreeFailure>()
  private readonly holds = new Map<Session, Hold>()
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  /** Stop admission, cancel operations, and wait for their final callbacks. */
  readonly dispose: () => Promise<void>

  /**
   * @param ctx - context that optionally provides `worktrees`.
   * @param states - reads the `forgeWorktree` projection of a Session.
   * @param prefix - branch name prefix that `generatedWorktreeName` combines with the Session id and random digits.
   * @param changed - called after the creation or restoration of a Session starts, changes phase, or ends, after its
   * failure changes, and after a wait starts or ends.
   */
  constructor(
    private readonly ctx: Context,
    private readonly states: ProjectionHandle<ForgeWorktreeState>,
    private readonly prefix: string,
    private readonly changed: (session: Session) => void,
  ) {
    ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => await this.preStep(agent, step, signal, next))
    this.dispose = ctx.effect(() => async () => {
      this.lifetime.abort(new Error('The forge panel stopped'))
      await Promise.allSettled(this.pending)
    }, 'forge-panel: stop worktree operations')
  }

  /**
   * Read the running creation of a Session.
   * @param session - Session to read.
   * @returns the running creation, or null.
   */
  of(session: Session): ForgeWorktreeCreation | null {
    return this.live.get(session) ?? null
  }

  /**
   * Read the running restoration of a Session.
   * @param session - Session to read.
   * @returns the running restoration, or null.
   */
  restorationOf(session: Session): ForgeWorktreeRestoration | null {
    return this.restorations.get(session) ?? null
  }

  /**
   * Read the failed attempt that a waiting message saw last.
   * @param session - Session to read.
   * @returns the failure, or null.
   */
  failureOf(session: Session): ForgeWorktreeFailure | null {
    return this.failures.get(session) ?? null
  }

  /**
   * Read what a message of a Session waits for before its turn starts.
   * @param session - Session to read.
   * @returns the creation or restoration the message waits for, or null while none waits.
   */
  waitingOf(session: Session): ForgeWorktreeWaiting | null {
    const hold = this.holds.get(session)
    if (hold === undefined || (hold.kind === 'restoration' && !hold.waiting)) return null
    return hold.kind
  }

  /**
   * Forget the failure of a Session whose request changes or is withdrawn; the record of that change republishes the panel.
   * @param session - Session whose failure no longer applies.
   */
  forget(session: Session): void {
    this.failures.delete(session)
  }

  /**
   * Hold the turn of a message entering the inbox of a Session whose
   * requested worktree does not exist yet, and create the worktree. Call it
   * while the message enters, before the delivery wakes the Agent. A Session
   * already held, or an Agent with other work, gets no new hold.
   * @param agent - Agent of the Session.
   */
  holdCreation(agent: Agent): void {
    this.hold(agent, { kind: 'creation', stop: undefined, next: undefined }, (hold, signal) => this.runCreation(agent, hold, signal))
  }

  /**
   * Hold the turn of a message entering the inbox of a Session that works in
   * its created worktree while `check` decides whether that worktree is gone,
   * and until it is restored or left when it is. Call it while the message
   * enters, before the delivery wakes the Agent. A Session already held, or an
   * Agent with other work, gets no new hold.
   * @param agent - Agent of the Session.
   * @param check - answers whether the worktree is gone; a rejection lets the message go on.
   */
  holdRestoration(agent: Agent, check: (signal: AbortSignal) => Promise<ForgeMissingWorktree | null>): void {
    this.hold(agent, { kind: 'restoration', waiting: false, next: undefined }, (hold, signal) => this.runRestoration(agent, hold, check, signal))
  }

  /**
   * Make another attempt for the message that waits after a failed or stopped one.
   * @param session - Session whose message waits.
   * @returns whether a waiting message without a running attempt took the decision.
   */
  retry(session: Session): boolean {
    const hold = this.holds.get(session)
    if (hold?.kind !== 'creation' || hold.next === undefined) return false
    hold.next.resolve('retry')
    return true
  }

  /**
   * Read the request again after it changed; a withdrawn request lets the waiting message go on.
   * @param session - Session whose request changed.
   */
  recheck(session: Session): void {
    const hold = this.holds.get(session)
    if (hold?.kind === 'creation') hold.next?.resolve('recheck')
  }

  /**
   * Run work on the removed worktree a message waits for, inside the wait; its success lets the message go on.
   * @param session - Session whose message waits.
   * @param work - restores or leaves the worktree.
   * @returns the work's outcome, or undefined when no message waits for the removed worktree.
   */
  within(session: Session, work: HeldWork): Promise<void> | undefined {
    const hold = this.holds.get(session)
    if (hold?.kind !== 'restoration' || hold.next === undefined) return undefined
    const done = Promise.withResolvers<void>()
    hold.next.resolve({ work, done })
    return done.promise
  }

  /**
   * Stop the running attempt a message waits for; the message keeps waiting
   * with the request still open. Without such an attempt the Session is unchanged.
   * @param session - Session whose attempt stops.
   */
  stop(session: Session): void {
    const hold = this.holds.get(session)
    if (hold?.kind === 'creation') hold.stop?.abort(new Error('The worktree creation was stopped'))
  }

  /**
   * Check the removed worktree of a Session out again through the worktree
   * service; the running restoration is readable through
   * {@link WorktreeCreations.restorationOf} until it ends.
   * @param agent - Agent of the Session.
   * @param worktrees - the worktree service.
   * @param created - the worktree the Session created.
   * @param signal - cancellation of the restoration.
   * @param restored - runs once the checkout is back, before the restoration ends, so both changes publish together.
   * @param available - checks whether the recorded checkout is already usable, within this operation's lifetime.
   * @throws the worktree service's error when the restoration fails; the cancellation reason once `signal` aborts.
   */
  async restore(
    agent: Agent,
    worktrees: Context['worktrees'],
    created: ForgeSessionWorktree,
    signal: AbortSignal,
    restored: () => void,
    available: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<void> {
    await this.run(signal, async (operation) => {
      const usable = await available(operation)
      operation.throwIfAborted()
      if (!usable) await this.restoreCheckout(agent, worktrees, created, operation, restored)
    })
  }

  private async restoreCheckout(
    agent: Agent,
    worktrees: Context['worktrees'],
    created: ForgeSessionWorktree,
    signal: AbortSignal,
    restored: () => void,
  ): Promise<void> {
    const session = agent.session
    appendPluginRecord(session, WORKTREE_RECORD, { action: 'restoring' })
    try {
      await worktrees.restore(agent, created, signal, (phase) => {
        this.restorations.set(session, { phase })
        this.changed(session)
      })
      signal.throwIfAborted()
      appendPluginRecord(session, WORKTREE_RECORD, { action: 'restored' })
      restored()
    } finally {
      this.restorations.delete(session)
      this.changed(session)
    }
  }

  /**
   * Create a Session's requested worktree with a new branch name, enter it, and
   * record it on the Session. The running creation is readable through
   * {@link WorktreeCreations.of} until the record exists or the attempt fails.
   * @param agent - Agent of the Session.
   * @param from - base branch, or null for HEAD of the current checkout.
   * @param signal - cancellation of the attempt.
   * @param held - whether a message waits for the creation before its turn starts.
   * @returns the created worktree.
   * @throws {@link CreationFailure} when the attempt fails; the cancellation reason once `signal` aborts.
   */
  async create(agent: Agent, from: string | null, signal: AbortSignal, held: boolean): Promise<CreatedWorktree> {
    return await this.run(signal, operation => this.createCheckout(agent, from, operation, held))
  }

  private async createCheckout(agent: Agent, from: string | null, signal: AbortSignal, held: boolean): Promise<CreatedWorktree> {
    const worktrees = this.ctx.get('worktrees')
    if (worktrees === undefined) throw new Error('No worktree service is mounted')
    const session = agent.session
    let status: ForgeWorktreeCreation = { phase: 'prepare', branch: generatedWorktreeName(this.prefix, session.id), from, held }
    this.failures.delete(session)
    this.live.set(session, status)
    this.changed(session)
    try {
      let created: CreatedWorktree
      try {
        created = await worktrees.create(agent, { name: status.branch, ...from === null ? {} : { from } }, signal, (phase) => {
          status = { ...status, phase }
          this.live.set(session, status)
          this.changed(session)
        })
      } catch (error) {
        signal.throwIfAborted()
        throw new CreationFailure(status.branch, status.phase, messageOf(error), error)
      }
      signal.throwIfAborted()
      const worktree: ForgeSessionWorktree = {
        path: created.path, branch: created.branch, from, baseCommit: created.baseCommit, repositoryRoot: created.repositoryRoot,
      }
      appendPluginRecord(session, WORKTREE_RECORD, { action: 'created', worktree })
      return created
    } finally {
      // After the record, so a follower never sees the creation end without its result.
      this.live.delete(session)
      this.changed(session)
    }
  }

  /**
   * Run a hold as maintenance of the Agent, which latches the delivery's wake until the hold ends.
   * @param agent - Agent of the Session.
   * @param hold - the hold's state.
   * @param body - waits for the worktree; settles once the message may go on.
   */
  private hold<H extends Hold>(agent: Agent, hold: H, body: (hold: H, signal: AbortSignal) => Promise<void>): void {
    if (this.lifetime.signal.aborted) return
    const session = agent.session
    if (this.holds.has(session)) return
    let task: Promise<void>
    try {
      task = agent.runMaintenance(async (maintenance) => {
        // Leave the inbox mutation that announced the message before the hold touches the Session.
        await Promise.resolve()
        try {
          await body(hold, AbortSignal.any([maintenance, this.lifetime.signal]))
        } catch (error) {
          void error // Only the Agent's cancellation or disposal and the panel's stop reject a hold's waits; each ends it.
        } finally {
          this.holds.delete(session)
          this.failures.delete(session)
          this.changed(session)
        }
      })
    } catch (error) {
      void error // A running turn or other maintenance owns the Agent, so the message takes its usual path.
      return
    }
    this.holds.set(session, hold)
    void this.join(task)
  }

  private async run<T>(signal: AbortSignal, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const operation = AbortSignal.any([signal, this.lifetime.signal])
    operation.throwIfAborted()
    return await this.join(body(operation))
  }

  private async join<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task)
    try {
      return await task
    } finally {
      this.pending.delete(task)
    }
  }

  /**
   * Make attempts until one creates the worktree or the request no longer asks
   * for one, waiting for a decision after each failed or stopped attempt.
   */
  private async runCreation(agent: Agent, hold: CreationHold, signal: AbortSignal): Promise<void> {
    const session = agent.session
    for (;;) {
      const state = this.states.stateOf(session)
      if (state.request === null || state.created !== null || state.locked) return
      const stop = new AbortController()
      hold.stop = stop
      try {
        await this.create(agent, state.request.from, AbortSignal.any([signal, stop.signal]), true)
        return
      } catch (error) {
        signal.throwIfAborted()
        if (stop.signal.aborted) this.failures.delete(session)
        else this.failures.set(session, failureOf(error, state.request.from))
        this.changed(session)
      } finally {
        hold.stop = undefined
      }
      while (await this.wait(hold, signal) !== 'retry') {
        const current = this.states.stateOf(session)
        if (current.request === null || current.created !== null || current.locked) return
      }
    }
  }

  /** Check the worktree the Session works in and, when it is gone, run the work that restores or leaves it until one succeeds. */
  private async runRestoration(
    agent: Agent,
    hold: RestorationHold,
    check: (signal: AbortSignal) => Promise<ForgeMissingWorktree | null>,
    signal: AbortSignal,
  ): Promise<void> {
    let missing: ForgeMissingWorktree | null
    try {
      missing = await check(signal)
    } catch (error) {
      // Without an answer from the filesystem or Git the panel offers no restoration, so the message goes on.
      signal.throwIfAborted()
      void error
      return
    }
    if (missing === null) return
    hold.waiting = true
    this.changed(agent.session)
    for (;;) {
      const { work, done } = await this.wait(hold, signal)
      try {
        await work(agent, signal)
      } catch (error) {
        done.reject(error)
        signal.throwIfAborted()
        continue
      }
      done.resolve()
      return
    }
  }

  /** Wait for the next decision on a hold; rejects with the abort reason once `signal` aborts. */
  private async wait<T>(hold: { next: PromiseWithResolvers<T> | undefined }, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    const next = Promise.withResolvers<T>()
    hold.next = next
    const abort = (): void => { next.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await next.promise
    } finally {
      signal.removeEventListener('abort', abort)
      hold.next = undefined
    }
  }

  private async preStep(agent: Agent, step: number, signal: AbortSignal, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const state = this.states.stateOf(agent.session)
    if (step !== 1 || state.request === null || state.created !== null || state.stepped) return await next()
    await this.create(agent, state.request.from, signal, false)
    const decision = await next()
    if (decision.kind === 'reject' || decision.messages.length === 0) return decision
    const notices = agent.inbox.nextStep.filter(message => message.source.kind === 'working-directory')
    for (const notice of notices) agent.inbox.remove(notice.id)
    return notices.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...notices] }
  }
}

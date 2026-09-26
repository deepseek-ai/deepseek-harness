/**
 * Service Definition for the authorization capability seam (`ctx.authorization`):
 * obtaining a credential nobody can supply from configuration alone, because
 * getting it requires a conversation with the human — open this page, paste
 * that code, pick an account.
 *
 * The seam owns the conversation and the lifecycle; it never owns the protocol.
 * A plugin that knows how to obtain its own credential registers a flow keyed
 * by the `CredentialKey` that flow writes, and the flow talks to whatever
 * surface started it through one neutral vocabulary of notices and prompts. So
 * a second authorization protocol arrives as another flow rather than as
 * another seam, and a surface that renders one flow renders all of them.
 *
 * ```ts
 * const dispose = ctx.authorization.registerFlow({
 *   key: credentialKey('llm-pi-ai', 'openai-codex'),
 *   label: 'ChatGPT (Codex)',
 *   methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
 *   async run(session) {
 *     session.notify({ message: 'Continue in your browser', url })
 *     await commitThroughCredentials(await exchange(session.signal))
 *   },
 * })
 * ```
 *
 * @module @deepseek-ai/dsh-authorization
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-llm'

import type {
  AuthorizationEntry, AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
  AuthorizationSettlement,
} from './types.ts'

export type {
  AuthorizationEntry, AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
  AuthorizationPromptOption, AuthorizationSettlement, AuthorizationStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    authorization: AuthorizationService
  }

  interface Events {
    /**
     * One authorization attempt has finished and released its key. Fires for
     * every terminal outcome, failures included, so a surface watching a key it
     * did not start (a second browser tab) learns the attempt is over.
     * @mode emit
     * @param key - the credential record the finished attempt was authorizing.
     * @param settlement - how it ended, including the `failed` case its caller sees as a thrown error.
     */
    'authorization/settled'(key: CredentialKey, settlement: AuthorizationSettlement): void
  }
}

/** Stable error taxonomy for authorization failures. */
export class AuthorizationError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'AuthorizationError'
  }
}

/**
 * The rejection an {@link AuthorizationInteraction.prompt} uses to say the
 * human declined — dismissed the question, chose not to answer — rather than
 * that the surface broke. An attempt whose flow fails after a prompt was
 * declined settles as `cancelled`, the same outcome as a withdrawn signal,
 * because the human saying no is a refusal, not a breakage. Only a human's
 * "no" may reject with this class: a prompt withdrawn by its own `signal` (a
 * flow retiring the losing question of a race) must reject with something
 * else, or a later genuine failure would be misread as a decline.
 */
export class AuthorizationDeclinedError extends AuthorizationError {
  constructor(message = 'the authorization prompt was declined') {
    super(message, 'DECLINED')
    this.name = 'AuthorizationDeclinedError'
  }
}

/**
 * What a running flow is given to talk to the human. Every member is scoped to
 * one attempt: the flow neither knows nor chooses which surface is listening.
 */
export interface AuthorizationSession {
  /** The method id the caller picked, always one this flow declared. */
  readonly method: string
  /** Aborted when the caller withdraws or `cancel()` is called for this key. */
  readonly signal: AbortSignal
  /**
   * Commit a record while rejecting cancelled attempts. Once admitted, cancellation waits for completion.
   * @param record - credential owned by this flow.
   * @returns after the credential store commits the record.
   */
  commit(record: CredentialRecord): Promise<void>
  /**
   * Report progress, or tell the human what to do next. Fire-and-forget: a
   * surface that cannot render a notice must not stall the flow.
   * @param notice - the message, and any page or code it refers to.
   */
  notify(notice: AuthorizationNotice): void
  /**
   * Ask the human a question the flow cannot answer for itself.
   * @param prompt - what to ask, and how it should be presented.
   * @returns what the human typed, or the chosen option's id.
   * @throws when the human declines, or the prompt's own signal withdraws it.
   */
  prompt(prompt: AuthorizationPrompt): Promise<string>
}

/**
 * A plugin's knowledge of how to obtain one credential. The flow owns the
 * write: `run()` resolving means the record for `key` is committed through
 * `ctx.credentials` during that run, which the seam confirms — a commit
 * observed within the attempt, still present after it — before reporting
 * success. Committing inside the flow is what lets a library that persists
 * through its own store adapter (pi-ai's `Models.login()`) stay the single
 * writer instead of being copied back out and written twice.
 */
export interface AuthorizationFlow {
  /** The credential record this flow writes. Its scope names the owning plugin. */
  readonly key: CredentialKey
  /** User-facing name of what is being authorized. */
  readonly label: string
  /**
   * The methods offered, most preferred first; a caller naming none gets the
   * first. Typed non-empty because a flow with nothing to run is a flow that
   * cannot be begun, and the type says so at the one place flows are written.
   */
  readonly methods: readonly [AuthorizationMethod, ...AuthorizationMethod[]]
  /**
   * Run one attempt to obtain and commit the credential.
   * @param session - the chosen method, the cancellation signal, and the interaction callbacks.
   * @returns once the record is committed.
   * @throws when the attempt fails or the human declines.
   */
  run(session: AuthorizationSession): Promise<void>
}

/**
 * The surface half of one attempt. Supplied with the request rather than
 * registered, because the caller that starts an authorization is the one that
 * can talk to the human about it: prompts reach exactly the page that asked,
 * and a headless caller supplies an interaction that declines.
 */
export interface AuthorizationInteraction {
  /**
   * Render a notice from the running flow.
   * @param notice - the message, and any page or code it refers to.
   */
  notify(notice: AuthorizationNotice): void
  /**
   * Put a question to the human and wait.
   * @param prompt - what to ask, and how it should be presented.
   * @returns the typed text, or the chosen option's id.
   * @throws {AuthorizationDeclinedError} when the human declines; any other
   *   rejection reads as the surface failing, not as an answer.
   */
  prompt(prompt: AuthorizationPrompt): Promise<string>
}

/** One request to authorize a key. */
export interface AuthorizationRequest {
  /** The credential record to authorize; a flow must be registered for it. */
  key: CredentialKey
  /** Which of the flow's methods to run. Defaults to the flow's first. */
  method?: string
  /** The surface that will render this attempt's notices and prompts. */
  interaction: AuthorizationInteraction
  /** Withdraws the whole attempt. */
  signal?: AbortSignal
}

/** One attempt in flight, with the handle that withdraws it. */
interface InFlight {
  readonly controller: AbortController
  committing: boolean
}

/**
 * `ctx.authorization`: a registry of credential-obtaining flows, one attempt at
 * a time per key.
 */
export class AuthorizationService extends Service {
  /** The commit this seam confirms is a credential-record write, so the store is required, not optional. */
  static inject = ['credentials']

  private readonly flows = new Map<CredentialKey, AuthorizationFlow>()
  private readonly running = new Map<CredentialKey, InFlight>()

  constructor(ctx: Context) {
    super(ctx, 'authorization')
  }

  /**
   * Offer a way to obtain one credential. One flow per key: two plugins
   * claiming the same key would each write a record in their own format, and
   * whichever ran last would leave the other reading a payload it cannot parse.
   *
   * @param flow - the key it writes, its label, its methods, and its runner.
   * @returns Disposer that withdraws this flow.
   * @throws {AuthorizationError} code `DUPLICATE_FLOW` when the key is already claimed.
   */
  registerFlow(flow: AuthorizationFlow): () => void {
    const dispose = this.ctx.effect(function* (this: AuthorizationService) {
      if (this.flows.has(flow.key)) {
        throw new AuthorizationError(
          `an authorization flow for "${flow.key}" is already registered`, 'DUPLICATE_FLOW')
      }
      this.flows.set(flow.key, flow)
      yield () => {
        this.flows.delete(flow.key)
        // A flow leaving mid-attempt takes its attempt with it: the runner
        // belongs to a plugin that is going away, so letting it keep prompting
        // would outlive the fiber that can answer for it.
        this.cancel(flow.key)
      }
    }.bind(this), 'authorization.registerFlow()')
    return () => void dispose()
  }

  /**
   * Every registered flow, for a surface listing what can be authorized.
   * @returns one entry per flow, in registration order.
   */
  list(): readonly AuthorizationEntry[] {
    return [...this.flows.values()].map(flow => this.entry(flow))
  }

  /**
   * One registered flow.
   * @param key - the credential record to ask about.
   * @returns the entry, or undefined when no flow claims that key.
   */
  describe(key: CredentialKey): AuthorizationEntry | undefined {
    const flow = this.flows.get(key)
    return flow === undefined ? undefined : this.entry(flow)
  }

  /** The public view of one registered flow. */
  private entry(flow: AuthorizationFlow): AuthorizationEntry {
    return {
      key: flow.key,
      label: flow.label,
      methods: flow.methods,
      inFlight: this.running.has(flow.key),
    }
  }

  /**
   * Withdraw the attempt running for a key, if any. Separate from the
   * request's own signal because a request/response transport answers a Cancel
   * button on a second call, with no handle on the first one's signal.
   * @param key - the credential record whose attempt should stop.
   */
  cancel(key: CredentialKey): void {
    const running = this.running.get(key)
    if (running !== undefined && !running.committing) running.controller.abort()
  }

  /**
   * Run one attempt to authorize a key, and report how it ended.
   *
   * One attempt per key at a time. A second caller is refused rather than
   * joined: the two would be prompting different humans through the same flow,
   * and the second would answer questions the first was asked.
   *
   * @param request - the key, the method, the surface, and the cancel signal.
   * @returns `authorized` once the flow's record is committed during this
   *   attempt and observed, or `cancelled` when the human declined or the
   *   caller withdrew.
   * @throws {AuthorizationError} code `NO_FLOW` when nothing claims the key,
   *   `UNKNOWN_METHOD` when the named method is not one the flow offers,
   *   `ALREADY_IN_FLIGHT` when an attempt is already running for the key, or
   *   `NOT_COMMITTED` when the flow resolved without committing a record
   *   during the attempt.
   */
  async begin(request: AuthorizationRequest): Promise<AuthorizationOutcome> {
    const { key } = request
    const flow = this.flows.get(key)
    if (flow === undefined) {
      throw new AuthorizationError(`no authorization flow is registered for "${key}"`, 'NO_FLOW')
    }
    const method = request.method ?? flow.methods[0].id
    if (!flow.methods.some(candidate => candidate.id === method)) {
      throw new AuthorizationError(
        `authorization flow for "${key}" offers no method "${method}"`, 'UNKNOWN_METHOD')
    }
    if (this.running.has(key)) {
      throw new AuthorizationError(
        `an authorization attempt for "${key}" is already running`, 'ALREADY_IN_FLIGHT')
    }
    // Withdrawn before it began: never claim the slot and never run the flow.
    // Handing an aborted signal to `run()` would rely on every flow checking it
    // before its first await, and one that does not would hang holding the key.
    // Validation still runs first, so a caller naming a key or method that does
    // not exist hears about it whether or not it also gave up.
    if (request.signal?.aborted === true) return { status: 'cancelled' }
    const controller = new AbortController()
    const withdraw = (): void => {
      const running = this.running.get(key)
      if (running !== undefined && !running.committing) controller.abort(request.signal?.reason)
    }
    request.signal?.addEventListener('abort', withdraw, { once: true })
    this.running.set(key, { controller, committing: false })
    let settlement: AuthorizationSettlement = 'failed'
    try {
      const outcome = await this.attempt(flow, method, controller.signal, request.interaction)
      settlement = outcome.status
      return outcome
    } finally {
      request.signal?.removeEventListener('abort', withdraw)
      this.running.delete(key)
      // After the slot is released, so a listener that reacts by starting the
      // next attempt is not refused by the one that just finished.
      this.settle(key, settlement)
    }
  }

  /* jscpd:ignore-start -- deliberate symmetry with the credentials seam's
     commit fan-out (`CredentialProvider`): the contained-dispatch shape is the
     reviewed listener-lifecycle contract, and extracting it would couple the
     two seams' event semantics. */
  /**
   * Fan `authorization/settled` out with contained listener failures: every
   * listener runs, and a sync throw or async rejection is logged without
   * changing the finished attempt's own outcome — except `INVARIANT`-coded
   * failures, which rethrow after every listener ran. The attempt is already
   * over and its key released when this fires, so a broken watcher (that
   * second browser tab) can never turn the caller's settled result into a
   * failure of its own.
   */
  private settle(key: CredentialKey, settlement: AuthorizationSettlement): void {
    let invariantFailure: unknown
    const args = ['authorization/settled', key, settlement]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(key, settlement)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnSettledListenerFailure(key, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnSettledListenerFailure(key, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnSettledListenerFailure(key: CredentialKey, error: unknown): void {
    this.ctx.logger.warn('authorization: an authorization/settled listener for "%s" failed', key)
    this.ctx.logger.warn(error)
  }

  /** Run the flow, then hold it to its half of the commit contract. */
  private async attempt(
    flow: AuthorizationFlow,
    method: string,
    signal: AbortSignal,
    interaction: AuthorizationInteraction,
  ): Promise<AuthorizationOutcome> {
    // Withdrawal settles the attempt whether or not the flow reacts to it. A
    // flow is supposed to stop when its signal fires, but one that does not
    // would otherwise hold the key for the life of the process, and a wedged
    // key is indistinguishable from a busy one from the outside. The orphaned
    // run is left to finish on its own; nothing waits on it, and a record it
    // still manages to commit is a record the human did authorize.
    const withdrawn = new Promise<'withdrawn'>((resolve) => {
      // `begin()` returns before claiming the key when its caller has already
      // withdrawn, so this signal cannot already be aborted here.
      signal.addEventListener('abort', () => { resolve('withdrawn') }, { once: true })
    })
    // What the seam itself witnessed during the run, held as properties
    // because closure writes do not narrow locals across awaits: the prompt
    // wrapper sees a decline first-hand (a flow that rewraps the rejection on
    // its way out cannot hide it), and confirming the commit means confirming
    // it happened *now* — on a re-auth the record already exists, so presence
    // alone would let a flow that wrote nothing report the stale credential
    // as freshly authorized.
    const observed = { declined: false, committed: false }
    const unwatch = this.ctx.on('credentials/record-updated', (key: CredentialKey) => {
      if (key === flow.key) observed.committed = true
    })
    try {
      const running = flow.run({
        method,
        signal,
        commit: async (record) => {
          signal.throwIfAborted()
          const attempt = this.running.get(flow.key)
          if (attempt === undefined || attempt.controller.signal !== signal) {
            throw new AuthorizationError('authorization attempt is no longer active', 'CANCELLED')
          }
          attempt.committing = true
          await this.ctx.credentials.modifyRecord(flow.key, () => Promise.resolve(record))
        },
        notify: (notice) => {
          try {
            interaction.notify(notice)
          } catch (error) {
            // Fire-and-forget is held at the seam: a surface that cannot
            // render a notice (a page whose connection just closed) loses the
            // notice, never the attempt.
            this.ctx.logger.warn('authorization: the interaction surface failed to render a notice')
            this.ctx.logger.warn(error)
          }
        },
        prompt: prompt => interaction.prompt(prompt).catch((error: unknown) => {
          if (error instanceof AuthorizationDeclinedError) observed.declined = true
          throw error
        }),
      })
      try {
        if (await Promise.race([running.then(() => 'ran' as const), withdrawn]) === 'withdrawn') {
          // Nothing awaits the orphan any more, so its eventual failure has to be
          // marked handled or it would take down the process.
          void running.catch(() => { this.ctx.logger.debug('authorization: withdrawn flow failed after the fact') })
          return { status: 'cancelled' }
        }
      } catch (error) {
        // A withdrawn attempt and a declined prompt are outcomes, not
        // failures: the human said no, or closed the page. Anything else is
        // the flow failing and belongs to the caller, cause chain intact.
        if (signal.aborted || observed.declined) return { status: 'cancelled' }
        throw error
      }
    } finally {
      unwatch()
    }
    if (!observed.committed) {
      throw new AuthorizationError(
        `authorization flow for "${flow.key}" resolved without committing a credential record in this attempt`,
        'NOT_COMMITTED')
    }
    const stored = await this.ctx.credentials.describeRecord(flow.key)
    if (!stored.configured) {
      throw new AuthorizationError(
        `authorization flow for "${flow.key}" deleted its credential record instead of committing one`,
        'NOT_COMMITTED')
    }
    return { status: 'authorized' }
  }
}

export default AuthorizationService

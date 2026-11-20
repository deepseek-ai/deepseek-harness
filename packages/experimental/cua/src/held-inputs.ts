/** Native-owned held input, program-end reminders, and failure/cancellation cleanup. */
import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RUN_CODE_NAME, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { NativeError, type NativeClient } from './native-client.ts'

const target = { appHandle: z.string(), mode: z.enum(['application', 'window', 'system']) }
const heldInputs = z.array(z.discriminatedUnion('kind', [
  z.object({ ...target, kind: z.literal('key'), key: z.string(), windowId: z.string().optional() }),
  z.object({ ...target, kind: z.literal('mouse'), button: z.enum(['left', 'right', 'middle']), windowId: z.string() }),
]))

function renderInputs(inputs: z.infer<typeof heldInputs>, state: 'held' | 'released'): string {
  const rows = inputs.map(input => input.kind === 'key'
    ? `- Key ${JSON.stringify(input.key)}, appHandle ${JSON.stringify(input.appHandle)}${input.windowId === undefined ? '' : `, windowId ${JSON.stringify(input.windowId)}`} (${input.mode} input).`
    : `- Mouse ${input.button}, appHandle ${JSON.stringify(input.appHandle)}, windowId ${JSON.stringify(input.windowId)} (${input.mode} input).`)
  const title = state === 'held' ? 'CUA inputs are still held:' : 'CUA inputs were released during cleanup:'
  return ['<system-reminder>', title, ...rows,
    state === 'held'
      ? "They remain pressed across programs and turns. To release them, call sendKeyEvent or toggleMouse on the same target with direction 'up' and the same input options as the down."
      : 'These inputs are no longer held.',
    '</system-reminder>'].join('\n')
}

class InputOwner {
  readonly controller = new AbortController()
  private client: NativeClient | undefined
  private removeCleanup: (() => void) | undefined
  private notifySessionOnRelease = false
  closing: Promise<z.infer<typeof heldInputs>> | undefined

  constructor(private readonly failed: (error: unknown) => void,
    private readonly released: (inputs: z.infer<typeof heldInputs>) => void) {}

  track(client: NativeClient, inTurn: boolean): void {
    this.controller.signal.throwIfAborted()
    this.notifySessionOnRelease ||= inTurn
    if (this.client) return
    this.removeCleanup = client.registerCleanup(async (canRequest) => { await this.close(canRequest) })
    this.client = client
  }

  async reminder(inTurn: boolean): Promise<string | undefined> {
    if (this.closing || !this.client) return
    const inputs = heldInputs.parse(await this.client.request('getHeldInputs', {}, this.controller.signal))
    if (inputs.length === 0) {
      this.removeCleanup?.()
      this.removeCleanup = undefined
      this.client = undefined
      return
    }
    this.notifySessionOnRelease ||= inTurn
    return renderInputs(inputs, 'held')
  }

  close(canRequest = true): Promise<z.infer<typeof heldInputs>> {
    this.controller.abort()
    return this.closing ??= Promise.resolve().then(async () => {
      try {
        if (!this.client) return []
        if (!canRequest) throw new NativeError('INPUT_CLEANUP_UNCONFIRMED', 'Native connection closed before held-input cleanup was confirmed. Inspect the desktop manually before starting a new task')
        const released = heldInputs.parse(await this.client.requestCleanup('releaseHeldInputs', {}))
        if (this.notifySessionOnRelease) this.released(released)
        return released
      } catch (error) {
        this.failed(error)
        throw error
      } finally {
        this.removeCleanup?.()
        this.removeCleanup = undefined
      }
    })
  }

  async settled(): Promise<void> {
    try { await this.closing }
    catch (_cleanupFailed) { /* close reports the failure and disables this task's CUA operations. */ }
  }
}

/** One provider's held input owners; the helper remains the authority for which inputs are pressed. */
export class CuaHeldInputs {
  private readonly owners = new WeakMap<Agent, InputOwner>()
  // Post-execute policy may fail after a newer owner has acquired input for the same Agent.
  private readonly programOwners = new WeakMap<ToolExecution, InputOwner>()
  private readonly failures = new WeakMap<Agent, unknown>()
  private readonly turnSignals = new Map<Agent, { signal: AbortSignal; remove: () => void }>()

  /** @param ctx - Provider scope owning input observers and program middleware. */
  constructor(private readonly ctx: Context) {}

  /**
   * Wait for cleanup and obtain an owner for a new operation.
   * @param agent - Agent issuing a CUA operation.
   * @returns Ownership and cancellation shared by its held inputs.
   */
  async ready(agent: Agent): Promise<InputOwner> {
    const previous = this.owners.get(agent)
    if (previous?.closing) await previous.settled()
    if (this.failures.has(agent)) throw new NativeError('INPUT_CLEANUP_UNCONFIRMED',
      'CUA cleanup was not confirmed. All CUA operations are disabled for this task; inspect the desktop manually before starting a new task', { cause: this.failures.get(agent) })
    const current = this.owners.get(agent)
    if (current && !current.closing) return current
    const owner = new InputOwner((error) => {
      this.failures.set(agent, error)
      this.ctx.logger.error('CUA cleanup was not confirmed; all CUA operations are disabled for task %s: %s', agent.id, error)
      emitAgentEvent(this.ctx, agent, 'agent/error', { turn: this.ctx.agents.turnBoundaryOf(agent.session).lastTurn, step: 0, error })
    }, (inputs) => {
      try {
        for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
          if (message.source.kind === 'cua-held-inputs') agent.inbox.remove(message.id)
        }
        if (inputs.length === 0) return
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: renderInputs(inputs, 'released') }],
          source: { kind: 'cua-inputs-released', form: 'notice', summary: 'CUA inputs released' },
        }))
      } catch (error) {
        this.ctx.logger.error('CUA inputs were released but their notice could not be recorded for task %s: %s', agent.id, error)
        emitAgentEvent(this.ctx, agent, 'agent/error', { turn: this.ctx.agents.turnBoundaryOf(agent.session).lastTurn, step: 0,
          error: new NativeError('INPUT_NOTICE_FAILED', 'CUA inputs were released, but their notice could not be recorded', { cause: error }) })
      }
    })
    this.owners.set(agent, owner)
    return owner
  }

  /**
   * Stop owned dispatch and release held input with an independent bounded native request.
   * @param agent - Agent whose input must be released.
   * @returns Completion after native acknowledgement, or rejection if cleanup is unconfirmed.
   */
  async release(agent: Agent): Promise<void> { await this.owners.get(agent)?.close() }

  private stop(owner: InputOwner | undefined): void {
    if (!owner) return
    void owner.close().catch(() => undefined) // close records and reports the failure; waiters join the same promise.
  }

  /**
   * Observe program outcomes and cancellation while retaining native cleanup dependencies.
   * @returns Exact disposers retained until programs and native connections have drained.
   */
  *install(): Generator<() => void> {
    const ctx = this.ctx
    yield ctx.on('tools/execute', async (execution, next) => {
      if (!execution.agent || (execution.name !== RUN_CODE_NAME && execution.name !== 'cua_run_code')) return next()
      const agent = execution.agent
      const signal = execution.signal
      const abort = (): void => { this.stop(this.owners.get(agent)) }
      signal.addEventListener('abort', abort, { once: true })
      const releaseAfter = async (message: string): Promise<void> => {
        signal.removeEventListener('abort', abort)
        try { await this.release(agent) }
        catch (error) { throw new NativeError('INPUT_CLEANUP_UNCONFIRMED',
          `${message}. Held-input cleanup failed: ${String(error)}`, { cause: error }) }
      }
      try {
        let result: Awaited<ReturnType<typeof next>>
        try { result = await next() }
        catch (error) {
          await releaseAfter(`Program failed: ${String(error)}`)
          throw error
        }
        if (result.isError || signal.aborted) {
          await releaseAfter(result.isError ? result.error.message : 'Program cancelled')
        } else {
          const owner = this.owners.get(agent)
          let text: string | undefined
          if (execution.parent === undefined) {
            const inTurn = ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq !== null
            text = await owner?.reminder(inTurn).catch(async (error: unknown) => {
              await releaseAfter(signal.aborted ? 'Program cancelled' : `Held-input query failed: ${String(error)}`)
              throw error
            })
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cancellation can arrive while the native state query awaits.
            if (signal.aborted) { await releaseAfter('Program cancelled'); return result }
          }
          if (owner) this.programOwners.set(execution, owner)
          if (text && !owner?.closing) return { ...result, additionalContexts: [...result.additionalContexts ?? [],
            createUserMessage({ content: [{ type: 'text', text }],
              source: { kind: 'cua-held-inputs', form: 'notice', summary: 'CUA inputs remain held' } }),
          ] }
        }
        return result
      } finally {
        signal.removeEventListener('abort', abort)
        await this.owners.get(agent)?.settled()
      }
    })
    yield ctx.on('tools/result', (execution, result) => {
      const owner = this.programOwners.get(execution)
      this.programOwners.delete(execution)
      if (result.isError) this.stop(owner)
    })
    yield ctx.on('agent/pre-step', (event, next) => {
      const previous = this.turnSignals.get(event.agent)
      if (previous?.signal !== event.signal) {
        previous?.remove()
        const abort = (): void => { this.stop(this.owners.get(event.agent)) }
        event.signal.addEventListener('abort', abort, { once: true })
        this.turnSignals.set(event.agent, { signal: event.signal, remove: () => { event.signal.removeEventListener('abort', abort) } })
      }
      return next()
    })
    yield ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      // This live notification runs after append publication, so removal can safely write its own event.
      if (message.source.kind === 'cua-held-inputs' && this.owners.get(agent)?.closing) agent.inbox.remove(message.id)
    }, { prepend: true })
    yield ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = ctx.agents.get(session.id)
      if (agent?.session !== session) return
      this.turnSignals.get(agent)?.remove()
      this.turnSignals.delete(agent)
      if (event.data.reason.kind === 'aborted' || event.data.reason.kind === 'error') this.stop(this.owners.get(agent))
    })
    yield () => { for (const value of this.turnSignals.values()) value.remove(); this.turnSignals.clear() }
  }
}

/** Application consent checked before native observations and input. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError, type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { z } from 'zod'
import { applicationAccessDisplay } from './locales.ts'
import { NativeError, type NativeClient } from './native-client.ts'
import type { CuaAppHandle } from './types.ts'
import type { CuaApplicationGrant, CuaApplicationId } from './application-types.ts'
import type { CuaApplicationState } from './access-types.ts'

/** Native identity admission occurs before any application observation or input. */
export const ApplicationAuthorizationResult = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as CuaApplicationId),
  name: z.string(), executablePath: z.string().min(1), persistable: z.boolean(),
})
/** Current saved grants and their optional profile writer. */
export interface AccessOptions {
  grants: () => readonly CuaApplicationGrant[]
  save?: ((grants: readonly CuaApplicationGrant[]) => Promise<void>) | undefined
}
interface Selection {
  identity: CuaApplicationGrant
  scope: 'session' | 'persistent'
  lifetime: AbortController
}
interface ClientSelections {
  agent: Agent
  handles: Map<CuaAppHandle, Selection>
}
interface ActiveOperation {
  agent: Agent
  client: NativeClient
  identity: CuaApplicationGrant
  controller: AbortController
  done: PromiseWithResolvers<void>
}

/** Owns application consent and cancels operations when saved access is removed. */
export class ApplicationAccess {
  private readonly clients = new Map<NativeClient, ClientSelections>()
  private readonly decisions = new Map<Agent['id'], Map<CuaApplicationId, { identity: CuaApplicationGrant; allowed: boolean }>>()
  private readonly active = new Set<ActiveOperation>()
  private readonly selections = new Map<Agent['id'], Map<CuaApplicationId, Promise<void>>>()
  private readonly lifetime = new AbortController()
  private mutationTail: Promise<unknown> = Promise.resolve()
  private disposal: Promise<void> | undefined

  /** @param ctx Host context owning this provider. @param options Live saved grants and profile persistence. */
  constructor(private readonly ctx: Context, private readonly options: AccessOptions) {
    ctx.on('loader/volatile-update', () => { this.reconcile() })
    ctx.effect(() => () => this.dispose(), 'cua-application-access.dispose')
  }

  /**
   * Cancel consent waits and join owned operations.
   * @returns Completion after consent waits and active operations settle.
   */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.lifetime.abort()
      await Promise.allSettled([this.mutationTail, ...[...this.active].map(operation => operation.done.promise)])
      this.clients.clear()
      this.decisions.clear()
    })()
  }

  /**
   * Project application decisions without requesting native permissions.
   * @returns Current saved grants and refused applications for the permission page.
   */
  status(): Omit<CuaApplicationState, 'settingsNamespace'> {
    const allowedApps = [...this.options.grants()]
    const blockedApps = new Map<CuaApplicationId, CuaApplicationGrant>()
    for (const decisions of this.decisions.values()) for (const [id, decision] of decisions) {
      if (decision.allowed || allowedApps.some(grant => grant.id === id)) continue
      blockedApps.set(id, decision.identity)
    }
    return { allowedApps,
      blockedApps: [...blockedApps.values()], persistentAvailable: this.options.save !== undefined }
  }

  /**
   * Remove saved and session consent and cancel affected native operations.
   * @param id Application identity shown in the permission page.
   * @returns Completion after persistence and affected operations settle; already dispatched input cannot be undone.
   */
  async revoke(id: CuaApplicationId): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    let clients: readonly NativeClient[] = []
    await this.mutate(async () => {
      const grants = this.options.grants()
      if (grants.some(grant => grant.id === id)) {
        const save = this.options.save
        if (!save) throw new Error('Application permissions cannot be saved in this composition')
        await save(grants.filter(grant => grant.id !== id))
      }
      clients = this.invalidate(id)
    })
    const results = await Promise.allSettled([
      ...clients.map(client => client.dispose()),
      ...[...this.active].filter(operation => operation.identity.id === id).map(operation => operation.done.promise),
    ])
    const errors: unknown[] = []
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length) throw new AggregateError(errors, 'Application access was revoked, but helper cleanup failed')
  }

  /**
   * Clear explicit refusal; the next getApp still requires a new user decision.
   * @param id Application identity selected by the human.
   */
  retryApproval(id: CuaApplicationId): void {
    this.lifetime.signal.throwIfAborted()
    for (const decisions of this.decisions.values()) if (decisions.get(id)?.allowed === false) decisions.delete(id)
    for (const state of this.clients.values()) for (const [handle, selected] of state.handles) {
      if (selected.identity.id === id && selected.lifetime.signal.aborted) state.handles.delete(handle)
    }
  }

  /**
   * Obtain consent for a freshly selected native handle. Free text never grants access.
   * @param agent Live agent whose session owns the decision.
   * @param client Helper that issued the handle.
   * @param handle Helper handle for a running instance or an approved pending launch.
   * @param identity Native executable/signing identity.
   * @param signal Calling tool lifetime.
   * @param icon Native application icon for the permission card; never saved as an identity.
   * @returns Completion after consent; refusals reject before launch, AX, screenshots, or input.
   */
  async select(agent: Agent, client: NativeClient, handle: CuaAppHandle,
    identity: CuaApplicationGrant & { persistable: boolean }, signal: AbortSignal, icon?: string): Promise<void> {
    await this.withOperation(agent, client, identity, signal, signal => this.selectInOrder(agent, identity.id, async () => {
      signal.throwIfAborted()
      const existing = this.clients.get(client)?.handles.get(handle)
      if (!client.disposed && existing && this.permitted(existing)) return
      const saved = identity.persistable && this.options.grants().some(grant => grant.id === identity.id)
      const decision = this.decisions.get(agent.id)?.get(identity.id)
      let scope: Selection['scope'] = saved ? 'persistent' : 'session'
      if (!saved && decision?.allowed === false) throw this.denied(identity)
      if (client.disposed) throw new NativeError('NATIVE_CLOSED', 'Helper is closed; acquire fresh application handles')
      if (!saved && !decision?.allowed) {
        const questions = this.ctx.get('userQuestions')
        if (!questions) throw new NativeError('APP_APPROVAL_UNAVAILABLE', 'No human answerer is available for application access')
        const options = [{ label: 'Allow for this session' }, { label: 'Deny' }]
        if (identity.persistable && this.options.save) options.push({ label: 'Always allow' })
        let result: AskUserQuestionAnswer
        try {
          result = await questions.ask({ agent, signal, questions: [{ id: 'cua-app-access',
            question: `Allow computer use to launch if needed, read, capture, and control ${identity.name}?`,
            detail: 'Session access lasts until DSH restarts or computer use is disabled.',
            options, intent: {
              kind: 'approval', approve: 'Allow for this session', reject: 'Deny',
              ...(identity.persistable && this.options.save ? { always: 'Always allow' } : {}),
              subject: { name: identity.name, ...(icon === undefined ? {} : { icon }) },
              display: applicationAccessDisplay,
            } }] })
        } catch (error) {
          if (error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') {
            this.invalidate(identity.id, agent)
            throw this.denied(identity)
          }
          if (error instanceof UserQuestionError && error.code === 'DELEGATED_CALLER') {
            throw new NativeError('APP_APPROVAL_UNAVAILABLE', 'Application approval is unavailable in delegated tasks; ask the main task to perform this operation')
          }
          throw error
        }
        signal.throwIfAborted()
        const answer = result.answers.find(answer => answer.id === 'cua-app-access')
        const chosen = answer && !answer.custom?.trim() && answer.selected.length === 1 ? answer.selected[0] : undefined
        if (chosen === 'Allow for this session') scope = 'session'
        else if (chosen === 'Always allow' && identity.persistable && this.options.save) {
          scope = 'persistent'
          const { persistable: _persistable, ...grant } = identity
          await this.persist((grants) => {
            signal.throwIfAborted()
            return [...grants.filter(item => item.id !== identity.id), grant]
          })
        } else {
          this.invalidate(identity.id, agent)
          throw this.denied(identity)
        }
      }
      signal.throwIfAborted()
      // The awaited user decision can outlive the helper, so re-read its live getter.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (client.disposed) throw new NativeError('NATIVE_CLOSED', 'Helper is closed; acquire fresh application handles')
      const state = this.clients.get(client) ?? { agent, handles: new Map<CuaAppHandle, Selection>() }
      const { persistable: _persistable, ...grant } = identity
      for (const [previous, previousState] of this.clients) if (previousState.agent === agent && previous !== client) {
        for (const selected of previousState.handles.values()) selected.lifetime.abort()
        this.clients.delete(previous)
      }
      state.handles.set(handle, { identity: grant, scope, lifetime: new AbortController() })
      this.clients.set(client, state)
      if (scope === 'session') this.decide(agent.id, grant, true)
      else this.decisions.get(agent.id)?.delete(identity.id)
    }))
  }

  /**
   * Enforce live consent at the operation that dispatches native work.
   * @param client Helper owning the application handle.
   * @param handle Selected application.
   * @param signal Calling tool lifetime.
   * @param dispatch One native operation, with revocation cancellation.
   * @returns The native result, with no implicit retry after consent or cancellation.
   */
  async run<T>(client: NativeClient, handle: CuaAppHandle, signal: AbortSignal,
    dispatch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const state = this.clients.get(client)
    const selected = state?.handles.get(handle)
    if (!state || !selected) throw new NativeError('APP_ACCESS_REQUIRED', 'Select the application with getApp and obtain user consent before reading or controlling it')
    if (!this.permitted(selected)) {
      if (!selected.lifetime.signal.aborted) this.invalidate(selected.identity.id, state.agent)
      throw new NativeError('APP_ACCESS_REVOKED', 'Application access was revoked; stop using this application')
    }
    if (client.disposed) throw new NativeError('NATIVE_CLOSED', 'Helper is closed; acquire fresh application handles')
    return this.withOperation(state.agent, client, selected.identity, AbortSignal.any([signal, selected.lifetime.signal]), dispatch)
  }

  private async selectInOrder(agent: Agent, id: CuaApplicationId, select: () => Promise<void>): Promise<void> {
    const selections = this.selections.get(agent.id) ?? new Map<CuaApplicationId, Promise<void>>()
    this.selections.set(agent.id, selections)
    const operation = (selections.get(id) ?? Promise.resolve()).then(select, select)
    selections.set(id, operation)
    try { await operation } finally {
      if (selections.get(id) === operation) selections.delete(id)
      if (selections.size === 0) this.selections.delete(agent.id)
    }
  }

  private async withOperation<T>(agent: Agent, client: NativeClient, identity: CuaApplicationGrant, signal: AbortSignal,
    dispatch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const operation = { agent, client, identity, controller: new AbortController(), done: Promise.withResolvers<void>() }
    this.active.add(operation)
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, operation.controller.signal])
    try {
      lifetime.throwIfAborted()
      const result = await dispatch(lifetime)
      lifetime.throwIfAborted()
      return result
    } catch (error) {
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason
      throw error
    } finally {
      this.active.delete(operation)
      operation.done.resolve()
    }
  }

  /**
   * Release the disposed agent's handles while retaining its session decisions.
   * @param agent Disposed agent whose selected handles are released.
   */
  forget(agent: Agent): void {
    for (const [client, state] of this.clients) if (state.agent === agent) this.clients.delete(client)
  }

  private permitted(selection: Selection): boolean {
    return !selection.lifetime.signal.aborted
      && (selection.scope === 'session' || this.options.grants().some(grant => grant.id === selection.identity.id))
  }
  private denied(identity: CuaApplicationGrant): NativeError {
    return new NativeError('APP_ACCESS_DENIED', `The user denied access to ${identity.name}. Do not retry or use another tool to bypass this decision.`)
  }
  private decide(sessionId: Agent['id'], identity: CuaApplicationGrant, allowed: boolean): void {
    const decisions = this.decisions.get(sessionId) ?? new Map<CuaApplicationId, { identity: CuaApplicationGrant; allowed: boolean }>()
    decisions.set(identity.id, { identity: { id: identity.id, name: identity.name, executablePath: identity.executablePath }, allowed })
    this.decisions.set(sessionId, decisions)
  }
  private invalidate(id: CuaApplicationId, agent?: Agent): NativeClient[] {
    const clients = new Set<NativeClient>()
    for (const [sessionId, decisions] of this.decisions) {
      const decision = decisions.get(id)
      if (decision && (agent === undefined || sessionId === agent.id)) this.decide(sessionId, decision.identity, false)
    }
    for (const [client, state] of this.clients) for (const selection of state.handles.values()) if (selection.identity.id === id
      && (agent === undefined || state.agent.id === agent.id)) {
      selection.lifetime.abort(new NativeError('APP_ACCESS_REVOKED', 'Application access was revoked; stop using this application'))
      this.decide(state.agent.id, selection.identity, false)
      clients.add(client)
    }
    for (const operation of this.active) if (operation.identity.id === id && (agent === undefined || operation.agent.id === agent.id)) {
      this.decide(operation.agent.id, operation.identity, false)
      operation.controller.abort(this.denied(operation.identity))
      clients.add(operation.client)
    }
    for (const client of clients) client.invalidate()
    return [...clients]
  }
  private reconcile(): void {
    for (const state of this.clients.values()) for (const selection of state.handles.values()) {
      if (!selection.lifetime.signal.aborted && !this.permitted(selection)) this.invalidate(selection.identity.id)
    }
  }
  private persist(update: (grants: readonly CuaApplicationGrant[]) => readonly CuaApplicationGrant[]): Promise<void> {
    return this.mutate(async () => {
      const save = this.options.save
      if (!save) throw new Error('Application permissions cannot be saved in this composition')
      await save(update(this.options.grants()))
    })
  }
  private mutate(mutate: () => Promise<void>): Promise<void> {
    const perform = async () => { this.lifetime.signal.throwIfAborted(); await mutate() }
    const operation = this.mutationTail.then(perform, perform)
    this.mutationTail = operation
    return operation
  }
}

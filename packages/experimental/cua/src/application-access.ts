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
import { CuaPermissionStore, type ApplicationPermission, type PermissionTransaction } from './permission-store.ts'

/** Native identity admission occurs before any application observation or input. */
export const ApplicationAuthorizationResult = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as CuaApplicationId),
  name: z.string(), executablePath: z.string().min(1).optional(), persistable: z.boolean(),
})
/** Application consent uses one profile store, including conversation-scoped decisions. */
export interface AccessOptions { store: CuaPermissionStore }
interface Selection {
  identity: CuaApplicationGrant
  scope: 'session' | 'persistent'
  sessionId: Agent['id']
  revoked: number
  revision: number
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
  private readonly active = new Set<ActiveOperation>()
  private readonly selections = new Map<Agent['id'], Map<CuaApplicationId, Promise<void>>>()
  private readonly lifetime = new AbortController()
  private disposal: Promise<void> | undefined

  /** @param ctx Host context owning this provider. @param options Live saved grants and profile persistence. */
  constructor(private readonly ctx: Context, private readonly options: AccessOptions) {
    ctx.effect(() => () => this.dispose(), 'cua-application-access.dispose')
  }

  /**
   * Cancel consent waits and join owned operations.
   * @returns Completion after consent waits and active operations settle.
   */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.lifetime.abort()
      await Promise.allSettled([this.options.store.drain(), ...[...this.active].map(operation => operation.done.promise)])
      this.clients.clear()
    })()
  }

  /**
   * Project application decisions without requesting native permissions.
   * @returns Current saved grants and refused applications for the permission page.
   */
  async status(): Promise<CuaApplicationState> {
    return this.options.store.withState(this.lifetime.signal, ({ state }) => {
      const allowedApps: CuaApplicationGrant[] = [], blockedApps: CuaApplicationGrant[] = []
      for (const app of Object.values(state.applications)) {
        if (app.always) allowedApps.push(app.always)
        else {
          const denied = Object.values(app.sessions).find(session => session.decision === 'deny')
          if (denied) blockedApps.push(denied.identity)
        }
      }
      return { allowedApps, blockedApps, persistentAvailable: this.options.store.persistent }
    })
  }

  /**
   * Remove saved and session consent and join affected native operations.
   * @param id Application identity shown in the permission page.
   * @returns Completion after persistence and cancellation, including other processes' admitted operations.
   */
  async revoke(id: CuaApplicationId): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    id = ApplicationAuthorizationResult.shape.id.parse(id)
    const clients = this.invalidate(id)
    await this.options.store.withApplication(id, this.lifetime.signal, () =>
      this.options.store.withState(this.lifetime.signal, async (transaction) => {
        const app = transaction.state.applications[id] ?? this.empty()
        if (app.always && !this.options.store.persistent) throw new Error('Application permissions cannot be saved in this composition')
        await this.save(transaction, id, { revoked: app.revoked + 1, sessions: Object.fromEntries(
          Object.entries(app.sessions).map(([sessionId, session]) => [sessionId, { ...session, decision: 'deny' as const, revision: session.revision + 1 }]),
        ) })
      }),
    )
    const results = await Promise.allSettled([
      ...clients.map(client => client.dispose()),
      ...[...this.active].filter(operation => operation.identity.id === id).map(operation => operation.done.promise),
    ])
    const errors: unknown[] = []
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length) throw new AggregateError(errors, 'Application access was revoked, but helper cleanup failed')
  }

  /** Clear refusals without granting access or restoring old handles.
   * @param id Application selected by the human.
   * @returns Completion after the new asking policy is durable.
   */
  async retryApproval(id: CuaApplicationId): Promise<void> {
    id = ApplicationAuthorizationResult.shape.id.parse(id)
    await this.options.store.withState(this.lifetime.signal, async (transaction) => {
      const app = transaction.state.applications[id]
      if (!app || !Object.values(app.sessions).some(session => session.decision === 'deny')) return
      await this.save(transaction, id, { ...app, sessions: Object.fromEntries(Object.entries(app.sessions).map(([sessionId, session]) => [
        sessionId, session.decision === 'deny' ? { ...session, decision: 'ask' as const, revision: session.revision + 1 } : session,
      ])) })
    })
  }

  /**
   * Obtain consent for a freshly selected native handle. Free text never grants access.
   * @param agent Live agent whose session owns the decision.
   * @param client Helper that issued the handle.
   * @param handle Helper handle for a running instance or an approved pending launch.
   * @param identity Platform-provided application or process-instance identity.
   * @param signal Calling tool lifetime.
   * @param icon Native application icon for the permission card; never saved as an identity.
   * @returns Completion after consent; refusals reject before launch, AX, screenshots, or input.
   */
  async select(agent: Agent, client: NativeClient, handle: CuaAppHandle,
    identity: CuaApplicationGrant & { persistable: boolean }, signal: AbortSignal, icon?: string): Promise<void> {
    await this.withOperation(agent, client, identity, signal, signal => this.selectInOrder(agent, identity.id, async () => {
      signal.throwIfAborted()
      const observed = await this.read(identity.id, signal)
      const existing = this.clients.get(client)?.handles.get(handle)
      if (!client.disposed && existing) {
        if (this.permitted(existing, observed)) return
        this.invalidate(identity.id, agent)
        throw new NativeError('APP_ACCESS_REVOKED', 'Application access changed; acquire a fresh application handle after consent')
      }
      const saved = identity.persistable && observed.always !== undefined
      const decision = observed.sessions[agent.id]
      let scope: Selection['scope'] = saved ? 'persistent' : 'session'
      if (!saved && decision?.decision === 'deny') throw this.denied(identity)
      if (client.disposed) throw new NativeError('NATIVE_CLOSED', 'Helper is closed; acquire fresh application handles')
      if (!saved && decision?.decision !== 'allow') {
        const questions = this.ctx.get('userQuestions')
        if (!questions) throw new NativeError('APP_APPROVAL_UNAVAILABLE', 'No human answerer is available for application access')
        const options = [{ label: 'Allow for this session' }, { label: 'Deny' }]
        if (identity.persistable && this.options.store.persistent) options.push({ label: 'Always allow' })
        let result: AskUserQuestionAnswer
        try {
          result = await questions.ask({ agent, signal, questions: [{ id: 'cua-app-access',
            question: `Allow computer use to launch if needed, read, capture, and control ${identity.name}?`,
            detail: applicationAccessDisplay.detail.en,
            options, intent: {
              kind: 'approval', approve: 'Allow for this session', reject: 'Deny',
              ...(identity.persistable && this.options.store.persistent ? { always: 'Always allow' } : {}),
              subject: { name: identity.name, ...(icon === undefined ? {} : { icon }) },
              display: applicationAccessDisplay,
            } }] })
        } catch (error) {
          if (error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') {
            this.invalidate(identity.id, agent)
            if (!this.lifetime.signal.aborted) await this.decide(agent.id, identity, 'deny')
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
        else if (chosen === 'Always allow' && identity.persistable && this.options.store.persistent) scope = 'persistent'
        else {
          await this.decide(agent.id, identity, 'deny')
          this.invalidate(identity.id, agent)
          throw this.denied(identity)
        }
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Awaiting approval can close the native client.
      if (client.disposed) throw new NativeError('NATIVE_CLOSED', 'Helper is closed; acquire fresh application handles')
      const authorized = await this.options.store.withState(signal, async (transaction) => {
        signal.throwIfAborted()
        const app = transaction.state.applications[identity.id] ?? this.empty()
        if (app.revoked !== observed.revoked
          || app.sessions[agent.id]?.revision !== observed.sessions[agent.id]?.revision) {
          throw new NativeError('APP_ACCESS_REVOKED', 'Application consent changed while awaiting approval; select the application again')
        }
        if (scope === 'persistent' && !saved && !this.options.store.persistent) throw this.denied(identity)
        const { persistable: _persistable, ...grant } = identity
        const previous = app.sessions[agent.id]
        if (previous?.decision === 'allow' && (scope === 'session' || app.always)) {
          return { revoked: app.revoked, revision: previous.revision }
        }
        const revision = (previous?.revision ?? 0) + 1
        const next = { ...app,
          ...(scope === 'persistent' ? { always: grant } : {}),
          sessions: { ...app.sessions, [agent.id]: { identity: grant, decision: 'allow' as const,
            revision } },
        }
        await this.save(transaction, identity.id, next)
        return { revoked: next.revoked, revision }
      })
      signal.throwIfAborted()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Persisting consent can close the native client.
      if (client.disposed) throw new NativeError('NATIVE_CLOSED', 'Helper is closed; acquire fresh application handles')
      const state = this.clients.get(client) ?? { agent, handles: new Map<CuaAppHandle, Selection>() }
      const { persistable: _persistable, ...grant } = identity
      for (const [previous, previousState] of this.clients) if (previousState.agent === agent && previous !== client) {
        for (const selected of previousState.handles.values()) selected.lifetime.abort()
        this.clients.delete(previous)
      }
      state.handles.set(handle, { identity: grant, scope, sessionId: agent.id, revoked: authorized.revoked,
        revision: authorized.revision, lifetime: new AbortController() })
      this.clients.set(client, state)
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
    if (selected.lifetime.signal.aborted) throw new NativeError('APP_ACCESS_REVOKED', 'Application access was revoked; stop using this application')
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, selected.lifetime.signal])
    return this.options.store.withApplication(selected.identity.id, lifetime, async () => {
      const permitted = await this.options.store.withState(lifetime, ({ state: permissions }) =>
        this.permitted(selected, permissions.applications[selected.identity.id] ?? this.empty()))
      if (!permitted) {
        this.invalidate(selected.identity.id, state.agent)
        throw new NativeError('APP_ACCESS_REVOKED', 'Application access was revoked; stop using this application')
      }
      if (client.disposed) throw new NativeError('NATIVE_CLOSED', 'Helper is closed; acquire fresh application handles')
      return this.withOperation(state.agent, client, selected.identity, lifetime, dispatch)
    })
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

  private permitted(selection: Selection, app: ApplicationPermission): boolean {
    const session = app.sessions[selection.sessionId]
    return !selection.lifetime.signal.aborted && app.revoked === selection.revoked
      && (selection.scope === 'persistent' ? app.always !== undefined
        : session?.decision === 'allow' && session.revision === selection.revision)
  }
  private denied(identity: CuaApplicationGrant): NativeError {
    return new NativeError('APP_ACCESS_DENIED', `The user denied access to ${identity.name}. Do not retry or use another tool to bypass this decision.`)
  }
  private async decide(sessionId: Agent['id'], identity: CuaApplicationGrant, decision: 'allow' | 'deny'): Promise<void> {
    await this.options.store.withState(this.lifetime.signal, async (transaction) => {
      const app = transaction.state.applications[identity.id] ?? this.empty()
      await this.save(transaction, identity.id, { ...app, sessions: { ...app.sessions,
        [sessionId]: { identity: { id: identity.id, name: identity.name, executablePath: identity.executablePath }, decision,
          revision: (app.sessions[sessionId]?.revision ?? 0) + 1 },
      } })
    })
  }
  private invalidate(id: CuaApplicationId, agent?: Agent): NativeClient[] {
    const clients = new Set<NativeClient>()
    for (const [client, state] of this.clients) for (const selection of state.handles.values()) if (selection.identity.id === id
      && (agent === undefined || state.agent.id === agent.id)) {
      selection.lifetime.abort(new NativeError('APP_ACCESS_REVOKED', 'Application access was revoked; stop using this application'))
      clients.add(client)
    }
    for (const operation of this.active) if (operation.identity.id === id && (agent === undefined || operation.agent.id === agent.id)) {
      operation.controller.abort(this.denied(operation.identity))
      clients.add(operation.client)
    }
    for (const client of clients) client.invalidate()
    return [...clients]
  }
  private empty(): ApplicationPermission { return { revoked: 0, sessions: {} } }
  private read(id: CuaApplicationId, signal = this.lifetime.signal): Promise<ApplicationPermission> {
    return this.options.store.withState(signal, ({ state }) => state.applications[id] ?? this.empty())
  }
  private save(transaction: PermissionTransaction, id: CuaApplicationId, app: ApplicationPermission): Promise<void> {
    return transaction.save({ ...transaction.state, applications: { ...transaction.state.applications, [id]: app } })
  }
}

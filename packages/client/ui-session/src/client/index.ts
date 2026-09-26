/** Session Controller adapter for React selector hooks and Slot scope data. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ISessions,
  SessionBinding,
  SessionListState,
  SessionReference,
  SessionRetainInfo,
  SessionSnapshot,
  SessionSummary,
  UseProjection,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
import { standardHookPropName } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  HostObservable,
  KeyedStandardSource,
  MaybeSnapshotSelectorHook,
  RootStandardSourceContribution,
  ScopedStandardSourceBinding,
  SlotScopeAdapter,
  SnapshotSelectorHook,
  StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only service merge for ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { renderSessionArea } from './session-provider.tsx'

/** Selector hook over the Session Controller list and current selection. */
export type UseSessions = SnapshotSelectorHook<SessionListState>
/** Selector hook over one Session's lifecycle and control state. */
export type SessionSnapshotSelector = SnapshotSelectorHook<SessionSnapshot>
/** Public name for the Session lifecycle selector hook. */
export type UseSession = SessionSnapshotSelector

/** Common identity carried by every Session-scoped pending interaction. */
export interface SessionPendingInteractionBase {
  /** Opaque request identity; a replacement request must use a new key. */
  readonly key: string
  /** Domain-owned presentation discriminator. */
  readonly kind: string
  /** Session whose UI can answer this interaction. */
  readonly sessionId: SessionId
}

/** Declaration-merged map of domain keys to their pending-interaction values. */
export interface SessionPendingInteractionMap {}

/** Union of every pending-interaction value contributed by the assembled Client. */
export type SessionPendingInteraction =
  [keyof SessionPendingInteractionMap] extends [never]
    ? SessionPendingInteractionBase
    : SessionPendingInteractionMap[keyof SessionPendingInteractionMap]

/** Independent UI status facts for one Session identity. */
export interface SessionStatus {
  /** Latest known running state; absent until a baseline or event establishes it. */
  readonly running: boolean | undefined
  /** Highest-precedence domain request currently awaiting user interaction. */
  readonly pendingInteraction: SessionPendingInteraction | undefined
  /** Whether an observed stop outside the main view still needs acknowledgement. */
  readonly completionUnread: boolean
}

/** Current UI status indexed by Session identity. */
export type SessionStatusSnapshot = ReadonlyMap<SessionId, SessionStatus>
/** Selector hook over the unified Session UI status snapshot. */
export type UseSessionStatus = SnapshotSelectorHook<SessionStatusSnapshot>

/** Selector hook for explicit or surrounding-Provider Session reference counts. */
export interface UseSessionRetainInfo {
  /**
   * Read the complete retain information for an explicit Session identity.
   * @param sessionId - Session identity to inspect without retaining it.
   * @returns current local reference counts, or absence while the source is unavailable.
   */
  (sessionId: SessionId): SessionRetainInfo | undefined
  /**
   * Select from the retain information for an explicit Session identity.
   * @param sessionId - Session identity to inspect without retaining it.
   * @param selector - projection over the current value.
   * @param equal - optional selected-value equality.
   * @returns selected value.
   */
  <Selected>(
    sessionId: SessionId,
    selector: (value: SessionRetainInfo | undefined) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ): Selected
  /**
   * Select from the surrounding Provider's Session retain information.
   * @param selector - projection receiving absence outside a Session binding.
   * @param equal - optional selected-value equality.
   * @returns selected value.
   */
  <Selected>(
    selector: (value: SessionRetainInfo | undefined) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ): Selected
}

/** Publish one pending interaction and define how plugin teardown delegates it. */
export type PendingInteractionPublisher<T extends SessionPendingInteractionBase> = (
  interaction: T,
  delegate: () => Promise<void>,
) => () => void

interface PendingInteractionEntry<T> {
  readonly interaction: T
  readonly delegate: () => Promise<void>
}

class PendingInteractionDomain<T extends SessionPendingInteractionBase> {
  private readonly values = new Map<string, PendingInteractionEntry<T>>()

  constructor(
    readonly precedence: (interaction: T) => number,
    private readonly changed: () => void,
  ) {}

  valuesSnapshot(): readonly T[] {
    return [...this.values.values()].map(entry => entry.interaction)
  }

  publish(interaction: T, delegate: () => Promise<void>): () => void {
    if (this.values.has(interaction.key)) {
      throw new Error(`ui-session: duplicate pending interaction key '${interaction.key}'`)
    }
    this.values.set(interaction.key, { interaction, delegate })
    this.changed()
    let active = true
    return () => {
      if (!active) return
      active = false
      if (!this.values.delete(interaction.key)) return
      this.changed()
    }
  }

  /** Remove every pending value and return the operations that settle their owners. */
  release(): readonly (() => Promise<void>)[] {
    const delegates = [...this.values.values()].map(entry => entry.delegate)
    this.values.clear()
    return delegates
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotScopeTargetMap {
    session: SessionReference
  }

  interface GlobalStandardProps {
    /** Session list and current selection. */
    useSessions: UseSessions
    useSessionStatus: UseSessionStatus
    useSessionRetainInfo: UseSessionRetainInfo
  }

  interface SessionStandardProps {
    /** Current Session lifecycle and control state. */
    useSession: SessionSnapshotSelector
    /** Current Session identity. */
    sessionId: SessionId
    /** Host-computed projection values addressed by projection key. */
    useProjection: UseProjection
  }

  interface SessionMaybeStandardProps {
    /** Current Session state, absent while no Session is selected. */
    useSession: MaybeSnapshotSelectorHook<SessionSnapshot>
    /** Current Session identity, absent while no Session is selected. */
    sessionId: SessionId | undefined
    /** Host-computed projection values; every key is absent without a Session. */
    useProjection: UseProjection
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    mainView: unknown
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session Controller adapter and session-scoped source registry. */
    uiSession: UiSession
  }
}

type SessionSourceRoster = readonly string[] | undefined
type StandardMemberKind = 'hook' | 'keyed hook' | 'prop'

type SessionSourceRecord<Roster extends SessionSourceRoster, Value> =
  Roster extends readonly string[] ? Readonly<Record<Roster[number], Value>> : never

/** Bare values produced by one Session-scoped source contribution. */
export interface SessionSourceContribution<
  Hooks extends SessionSourceRoster = SessionSourceRoster,
  KeyedHooks extends SessionSourceRoster = SessionSourceRoster,
  Props extends SessionSourceRoster = SessionSourceRoster,
> {
  readonly hooks?: SessionSourceRecord<Hooks, HostObservable<unknown>>
  readonly keyedHooks?: SessionSourceRecord<KeyedHooks, KeyedStandardSource>
  readonly props?: SessionSourceRecord<Props, unknown>
}

/** Static roster and per-Session resolver for one standard-props contribution. */
export interface SessionSourceDescriptor<
  Hooks extends SessionSourceRoster = SessionSourceRoster,
  KeyedHooks extends SessionSourceRoster = SessionSourceRoster,
  Props extends SessionSourceRoster = SessionSourceRoster,
> {
  readonly hooks?: Hooks
  readonly keyedHooks?: KeyedHooks
  readonly props?: Props
  /**
   * Resolve every declared member for one Session binding.
   * @param binding - Controller-owned Session binding.
   * @returns all declared bare sources and stable props.
   */
  resolve(binding: SessionBinding): SessionSourceContribution<
    NoInfer<Hooks>,
    NoInfer<KeyedHooks>,
    NoInfer<Props>
  >
}

interface RuntimeSessionSourceContribution {
  readonly hooks?: Readonly<Record<string, HostObservable<unknown>>>
  readonly keyedHooks?: Readonly<Record<string, KeyedStandardSource>>
  readonly props?: Readonly<Record<string, unknown>>
}

interface RuntimeSessionSourceDescriptor {
  readonly hooks?: readonly string[]
  readonly keyedHooks?: readonly string[]
  readonly props?: readonly string[]
  resolve(binding: SessionBinding): RuntimeSessionSourceContribution
}

type RuntimePendingDomain = PendingInteractionDomain<SessionPendingInteractionBase>

interface MaterializedBinding {
  readonly owner: SessionBinding
  readonly source: BindingSource
  readonly release: () => void
}

interface BindingSource extends HostObservable<StandardSourceBinding> {
  value: StandardSourceBinding
  readonly listeners: Set<() => void>
}

const BUILTIN_SOURCE = {
  hooks: ['session'],
  keyedHooks: ['projection'],
  props: ['sessionId'],
  resolve: binding => ({
    hooks: { session: binding.session },
    keyedHooks: { projection: key => binding.session.projections.faceOf(key) },
    props: { sessionId: binding.sessionId },
  }),
} satisfies SessionSourceDescriptor<
  readonly ['session'],
  readonly ['projection'],
  readonly ['sessionId']
>

/** Session-scoped source roster and renderer adapter. */
export class UiSession extends Service {
  private readonly descriptors: RuntimeSessionSourceDescriptor[] = [
    BUILTIN_SOURCE,
  ]
  private readonly bindings = new WeakMapWithValues<SessionBinding, MaterializedBinding>()
  private readonly absent: BindingSource
  private readonly current: BindingSource
  private readonly pendingDomains: RuntimePendingDomain[] = []
  private pendingSnapshot: ReadonlyMap<SessionId, SessionPendingInteractionBase> = new Map()
  private readonly running = new Map<SessionId, boolean>()
  private readonly completionUnread = new Set<SessionId>()
  private statusSnapshot: SessionStatusSnapshot = new Map()
  private readonly statusListeners = new Set<() => void>()
  private mainRetainId: SessionId | undefined
  private disposeMainRetain = (): void => {}
  private active = true
  /** Root source combining running, pending-interaction, and completion-reminder facts. */
  readonly sessionStatus: HostObservable<SessionStatusSnapshot> = {
    getSnapshot: () => this.statusSnapshot,
    subscribe: (listener) => {
      this.statusListeners.add(listener)
      return () => { this.statusListeners.delete(listener) }
    },
  }
  /** Renderer-facing adapter for `session` and `session-maybe` scopes. */
  readonly adapter: SlotScopeAdapter

  /**
   * @param ctx - Client root context.
   * @param sessions - Controller-owned Session object layer.
   */
  constructor(
    ctx: Context,
    private readonly sessions: ISessions,
  ) {
    super(ctx, 'uiSession')
    this.absent = createBindingSource(this.materializeAbsent())
    this.current = createBindingSource(this.absent.value)
    this.adapter = {
      current: this.current,
      bindingSource: target => this.bindingSource(target),
      renderArea: renderSessionArea,
    }

    ctx.effect(() => {
      const disposeList = sessions.list.subscribe(() => { this.publishMain() })
      const disposeStatus = sessions.list.subscribe(() => { this.reconcileStatus() })
      const disposeRemoteStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
        this.observeRunning(sessionId, running)
      })
      this.publishMain()
      this.reconcileStatus()
      return () => {
        this.active = false
        disposeList()
        disposeStatus()
        disposeRemoteStatus()
        this.disposeMainRetain()
        const records = [...this.bindings.values]
        this.bindings.clear()
        for (const record of records) record.release()
      }
    }, 'ui-session: Session binding projection')
  }

  /**
   * Resolve a stable renderer source for an owned Session reference or explicit absence.
   * @param reference - active reference supplied by the Provider owner, or absence.
   * @returns the binding source, which falls back to the absent projection when its generation ends.
   * @throws when the reference does not belong to the active Controller generation.
   */
  bindingSource(reference: SessionReference | undefined): HostObservable<StandardSourceBinding> {
    if (!this.active) return this.absent
    if (reference === undefined) return this.absent
    const owner = reference.binding
    if (this.sessions.binding(reference.sessionId) !== owner) {
      throw new Error('ui-session: Session reference is not active in this Controller')
    }
    return this.sourceFor(owner)
  }

  /**
   * Register one Session-scoped standard-source contribution.
   * @param descriptor - static member roster and per-binding resolver.
   * @returns disposer owned by the caller's Cordis fiber.
   */
  provide<
    const Hooks extends SessionSourceRoster = undefined,
    const KeyedHooks extends SessionSourceRoster = undefined,
    const Props extends SessionSourceRoster = undefined,
  >(descriptor: SessionSourceDescriptor<Hooks, KeyedHooks, Props>): () => void {
    const runtimeDescriptor = descriptor as unknown as RuntimeSessionSourceDescriptor
    const dispose = this.ctx.effect(() => {
      this.descriptors.push(runtimeDescriptor)
      try {
        this.rebuildBindings()
      } catch (error) {
        this.descriptors.pop()
        throw error
      }
      return () => {
        const index = this.descriptors.indexOf(runtimeDescriptor)
        this.descriptors.splice(index, 1)
        this.rebuildBindings()
      }
    }, 'uiSession.provide()')
    return () => { void dispose() }
  }

  /**
   * Register one pending-interaction domain and return its publication function.
   * Domain teardown first removes its visible values, then delegates and awaits
   * every still-active owner request.
   * @param precedence - deterministic cross-domain precedence; larger values win.
   * @returns a function that publishes one interaction and its teardown delegation.
   */
  registerPendingInteraction<T extends SessionPendingInteractionBase>(
    precedence: (interaction: T) => number,
  ): PendingInteractionPublisher<T> {
    const domain = new PendingInteractionDomain(precedence, () => {
      this.publishPendingInteractions()
    })
    const runtimeDomain = domain as unknown as RuntimePendingDomain
    this.ctx.effect(() => {
      this.pendingDomains.push(runtimeDomain)
      this.publishPendingInteractions()
      return async () => {
        const delegates = domain.release()
        const index = this.pendingDomains.indexOf(runtimeDomain)
        this.pendingDomains.splice(index, 1)
        this.publishPendingInteractions()
        await Promise.allSettled(delegates.map(delegate => Promise.resolve().then(delegate)))
      }
    }, 'uiSession.registerPendingInteraction()')
    return (interaction, delegate) => domain.publish(interaction, delegate)
  }

  private rebuildBindings(): void {
    const absent = this.materializeAbsent()
    const updates = [...this.bindings.values].map(record => ({
      source: record.source,
      value: this.materialize(record.owner),
    }))
    this.absent.value = absent
    for (const { source, value } of updates) source.value = value
    notifySubscribers(this.absent.listeners, '[ui-session] absent binding')
    for (const { source } of updates) {
      notifySubscribers(source.listeners, '[ui-session] Session binding')
    }
    this.publishMain()
  }

  private sourceFor(owner: SessionBinding): BindingSource {
    const cached = this.bindings.get(owner)
    if (cached !== undefined) return cached.source
    const record = this.createMaterializedBinding(owner)
    this.bindings.set(owner, record)
    return record.source
  }

  private publishMain(): void {
    if (!this.active) return
    const byId = this.sessions.list.getSnapshot().byId
    const currentId = this.current.value.key as SessionId | undefined
    const currentIsMain = currentId !== undefined
      && (this.sessions.retainInfo(currentId).getSnapshot().retainedBy.mainView ?? 0) > 0
    const nextId = currentIsMain
      ? currentId
      : Object.values(byId).find(candidate => (candidate.retainedBy.mainView ?? 0) > 0)?.id
    this.watchMainRetention(nextId)
    const owner = nextId === undefined ? undefined : this.sessions.binding(nextId)
    const value = owner === undefined ? this.absent.value : this.sourceFor(owner).value
    if (this.current.value === value) return
    this.current.value = value
    notifySubscribers(this.current.listeners, '[ui-session] main binding')
  }

  private watchMainRetention(sessionId: SessionId | undefined): void {
    if (sessionId === this.mainRetainId) return
    this.disposeMainRetain()
    this.mainRetainId = sessionId
    this.disposeMainRetain = sessionId === undefined
      ? () => {}
      : this.sessions.retainInfo(sessionId).subscribe(() => { this.publishMain() })
  }

  private publishPendingInteractions(): void {
    const next = new Map<SessionId, {
      interaction: SessionPendingInteractionBase
      precedence: number
    }>()
    for (const domain of this.pendingDomains) {
      for (const interaction of domain.valuesSnapshot()) {
        const precedence = domain.precedence(interaction)
        const previous = next.get(interaction.sessionId)
        if (previous === undefined || precedence >= previous.precedence) {
          next.set(interaction.sessionId, { interaction, precedence })
        }
      }
    }
    const projected = new Map(
      [...next].map(([sessionId, value]) => [sessionId, value.interaction] as const),
    )
    if (samePendingInteractions(this.pendingSnapshot, projected)) return
    this.pendingSnapshot = projected
    this.publishStatus()
  }

  private observeRunning(sessionId: SessionId, running: boolean): void {
    const previous = this.running.get(sessionId)
    const beforeBaseline = this.sessions.list.getSnapshot().phase === 'pending'
    this.running.set(sessionId, running)
    if (running) this.completionUnread.delete(sessionId)
    else if ((previous === true || (previous === undefined && beforeBaseline))
      && !this.isMain(sessionId)) this.completionUnread.add(sessionId)
    this.publishStatus()
  }

  private reconcileStatus(): void {
    const list = this.sessions.list.getSnapshot()
    const present = new Set(Object.keys(list.byId) as SessionId[])
    // Subagent catalog rows and retained subagent fallback rows do not establish Host running state.
    for (const id of list.ids) {
      const row = list.byId[id] as SessionSummary
      const previous = this.running.get(id)
      if (previous === undefined) this.running.set(id, row.running)
      else if (previous !== row.running) this.observeRunning(id, row.running)
    }
    for (const id of present) {
      if (this.isMain(id)) this.completionUnread.delete(id)
    }
    if (list.phase === 'ready') {
      for (const id of this.running.keys()) {
        if (present.has(id)) continue
        this.running.delete(id)
        this.completionUnread.delete(id)
      }
    }
    this.publishStatus()
  }

  private isMain(sessionId: SessionId): boolean {
    return (this.sessions.list.getSnapshot().byId[sessionId]?.retainedBy.mainView ?? 0) > 0
  }

  private publishStatus(): void {
    const ids = new Set<SessionId>([
      ...(Object.keys(this.sessions.list.getSnapshot().byId) as SessionId[]),
      ...this.running.keys(),
      ...this.pendingSnapshot.keys(),
      ...this.completionUnread,
    ])
    const next = new Map<SessionId, SessionStatus>()
    for (const id of ids) {
      next.set(id, {
        running: this.running.get(id),
        pendingInteraction: this.pendingSnapshot.get(id),
        completionUnread: this.completionUnread.has(id),
      })
    }
    if (sameSessionStatus(this.statusSnapshot, next)) return
    this.statusSnapshot = next
    notifySubscribers(this.statusListeners, '[ui-session] Session status')
  }

  private createMaterializedBinding(owner: SessionBinding): MaterializedBinding {
    const value = this.materialize(owner)
    this.ctx.slots.bindStoreScope(value)
    const source = createBindingSource(value)
    const releaseEffect = owner.ctx.effect(() => () => {
      if (this.bindings.get(owner) === record) this.bindings.delete(owner)
      source.value = this.absent.value
      notifySubscribers(source.listeners, '[ui-session] Session binding')
      this.publishMain()
    }, `ui-session: binding ${owner.sessionId}`)
    const record: MaterializedBinding = {
      owner,
      source,
      release: () => { void releaseEffect() },
    }
    return record
  }

  private materialize(binding: SessionBinding): ScopedStandardSourceBinding {
    const hooks: Record<string, HostObservable<unknown>> = {}
    const keyedHooks: Record<string, KeyedStandardSource> = {}
    const props: Record<string, unknown> = {}
    const finalProps = new Set<string>()
    for (const descriptor of this.descriptors) {
      const contribution = descriptor.resolve(binding)
      validateContribution(descriptor, contribution)
      copyDeclared('hook', hooks, descriptor.hooks, contribution.hooks, finalProps)
      copyDeclared('keyed hook', keyedHooks, descriptor.keyedHooks, contribution.keyedHooks, finalProps)
      copyDeclared('prop', props, descriptor.props, contribution.props, finalProps)
    }
    const value: ScopedStandardSourceBinding = {
      key: binding.sessionId,
      ctx: binding.ctx,
      hooks,
      keyedHooks,
      props,
    }
    return value
  }

  private materializeAbsent(): StandardSourceBinding {
    const hooks: Record<string, undefined> = {}
    const keyedHooks: Record<string, undefined> = {}
    const props: Record<string, undefined> = {}
    const finalProps = new Set<string>()
    for (const descriptor of this.descriptors) {
      declareAbsent('hook', hooks, descriptor.hooks, finalProps)
      declareAbsent('keyed hook', keyedHooks, descriptor.keyedHooks, finalProps)
      declareAbsent('prop', props, descriptor.props, finalProps)
    }
    return { key: undefined, hooks, keyedHooks, props }
  }
}

function createBindingSource(value: StandardSourceBinding): BindingSource {
  const source: BindingSource = {
    value,
    listeners: new Set(),
    getSnapshot: () => source.value,
    subscribe: (listener) => {
      source.listeners.add(listener)
      return () => { source.listeners.delete(listener) }
    },
  }
  return source
}

function validateContribution(
  descriptor: RuntimeSessionSourceDescriptor,
  contribution: RuntimeSessionSourceContribution,
): void {
  rejectUndeclared('hook', descriptor.hooks, contribution.hooks)
  rejectUndeclared('keyed hook', descriptor.keyedHooks, contribution.keyedHooks)
  rejectUndeclared('prop', descriptor.props, contribution.props)
}

function rejectUndeclared(
  kind: string,
  declared: readonly string[] | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): void {
  for (const name of Object.keys(values ?? {})) {
    if (!(declared ?? []).includes(name)) {
      throw new Error(`uiSession.provide: undeclared ${kind} '${name}'`)
    }
  }
}

function copyDeclared<T>(
  kind: StandardMemberKind,
  target: Record<string, T>,
  declared: readonly string[] | undefined,
  values: Readonly<Record<string, T>> | undefined,
  finalProps: Set<string>,
): void {
  for (const name of declared ?? []) {
    claimStandardProp(kind, name, finalProps)
    const value = values?.[name]
    if (value === undefined) throw new Error(`uiSession.provide: missing ${kind} '${name}'`)
    target[name] = value
  }
}

function declareAbsent(
  kind: StandardMemberKind,
  target: Record<string, undefined>,
  declared: readonly string[] | undefined,
  finalProps: Set<string>,
): void {
  for (const name of declared ?? []) {
    claimStandardProp(kind, name, finalProps)
    target[name] = undefined
  }
}

function claimStandardProp(kind: StandardMemberKind, name: string, finalProps: Set<string>): void {
  const propName = kind === 'prop' ? name : standardHookPropName(name)
  if (finalProps.has(propName)) {
    throw new Error(`uiSession.provide: duplicate ${kind} '${name}' at prop '${propName}'`)
  }
  finalProps.add(propName)
}

/** Required Controller and renderer services. */
export const inject = ['sessions', 'slots', 'remote']

/**
 * Install the Session root source and scoped adapter.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  const service = new UiSession(ctx, ctx.sessions)
  ctx.slots.provideRoot({
    hooks: {
      sessions: ctx.sessions.list,
      sessionStatus: service.sessionStatus,
    },
    keyedHooks: {
      sessionRetainInfo: key => ctx.sessions.retainInfo(key as SessionId),
    },
  } satisfies RootStandardSourceContribution)
  ctx.slots.installScope('session', service.adapter)
}

function sameSessionStatus(left: SessionStatusSnapshot, right: SessionStatusSnapshot): boolean {
  if (left.size !== right.size) return false
  for (const [id, status] of left) {
    const candidate = right.get(id)
    if (candidate === undefined
      || candidate.running !== status.running
      || candidate.pendingInteraction !== status.pendingInteraction
      || candidate.completionUnread !== status.completionUnread) return false
  }
  return true
}

function samePendingInteractions(
  left: ReadonlyMap<SessionId, SessionPendingInteractionBase>,
  right: ReadonlyMap<SessionId, SessionPendingInteractionBase>,
): boolean {
  if (left.size !== right.size) return false
  for (const [sessionId, interaction] of left) {
    if (right.get(sessionId) !== interaction) return false
  }
  return true
}

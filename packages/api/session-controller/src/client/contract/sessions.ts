/**
 * The outward sessions-service face — what `ctx.sessions` exposes to feature
 * packages. Transport entry points and implementation internals stay on
 * the concrete class. Widening this interface is the
 * explicit act of widening what features may do to the sessions domain.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentContext } from '../scope.ts'
import type { SessionSearchResultItem } from '../sessions/manager.ts'
import type { SessionBinding, SessionListState } from '../sessions/service.ts'
import type { SessionFace } from './session.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionReferenceSource } from '../index.ts'

export type { AgentContext } from '../scope.ts'

/** Known Session identity or durable direct-parent subagent address; an address owns no lifetime. */
export type SessionTarget = SessionId | SubagentAddress

/** One independent use of an exact Client generation, without Host Agent ownership. */
export interface SessionReference extends Disposable {
  readonly sessionId: SessionId
  /** Shared binding; access fails after reference release or generation disposal. */
  readonly binding: SessionBinding
  /** This reference's cancellable wait for the shared initial `Session.open()` attempt to settle. */
  readonly ready: Promise<SessionBinding>
  /** Release once; the final reference starts local scope and history teardown. */
  release(): void
}

/** Consumer identity and optional cancellation of one acquisition waiter. */
export interface SessionRetainOptions {
  readonly source: SessionReferenceSource
  readonly signal?: AbortSignal | undefined
}

/** Local ownership counts, independent of catalog membership and never persisted. */
export interface SessionRetainInfo {
  readonly referenceCount: number
  /** Positive source counts only; a source without references is absent. */
  readonly retainedBy: Readonly<Partial<Record<SessionReferenceSource, number>>>
}

/** The sessions-service face injected as `ctx.sessions`. */
export interface ISessions {
  /** Host catalog and local reference-source counts; navigation belongs to view owners. */
  readonly list: ObservableSnapshot<SessionListState>
  /**
   * Retain an exact Client generation and start its shared initial history opening.
   * @param target - known identity or durable direct-parent address.
   * @param options - required consumer source and optional independent waiter cancellation.
   * @returns an owned reference immediately; await `reference.ready` when the initial open attempt must settle first.
   */
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference
  /**
   * Hold one reference through callback settlement, including synchronous and asynchronous failures.
   * @param target - Session to acquire.
   * @param options - source and acquisition cancellation.
   * @param operation - callback using the reference only until its returned value or Promise settles.
   * @returns the callback result after release; acquisition and callback failures propagate unchanged.
   */
  using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T>
  /**
   * Observe local reference counts without retaining, creating a scope, or opening history.
   * The returned source keeps stable identity across same-id generations and remains allocated
   * until the Client root is disposed, even after its final subscriber leaves.
   * @param id - explicit Session identity; Host existence is not implied.
   * @returns a stable read-only source across same-id generations, with zero counts when none is live.
   */
  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo>
  /**
   * The `session.search` result bound the wire schema fixes, exposed to
   * presentation as injected data. Not per-connection state: every transport
   * (fixture included) reports the same number.
   */
  readonly searchResultLimit: number
  /**
   * Create or adopt a Session on the Host.
   * @param opts - target workspace, directory, and optional preallocated identity.
   * @returns the catalogued identity; retain it before borrowing its binding.
   */
  create(opts?: {
    workspaceId?: WorkspaceId
    cwd?: string
    sessionId?: SessionId
  }): Promise<SessionId>
  /**
   * Resolve an already discovered direct-parent address without opening it.
   * @param id - possible addressed child id.
   * @returns a retained or loaded-catalog address, without retaining a new selection or scope.
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined

  /**
   * Load all Session projections once per connection; retry an unsuccessful initial read.
   * @param sessionId - Session to inspect without opening its conversation.
   * @returns completion of the current or newly started refresh.
   */
  refreshProjections(sessionId: SessionId): Promise<void>

  /**
   * Refresh the Host-authoritative Session list.
   * @returns completion of the current or newly started Session-list refresh.
   */
  refresh(): Promise<void>
  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results, or a business/transport error.
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  /**
   * Fork a session from an exact inclusive prefix of the source; on
   * resolution the child is catalogued and can be explicitly retained.
   * @param opts - source session id, the optional exact inclusive boundary
   *   seq (a real event seq the caller already knows; a cut inside an open
   *   turn is balanced Host-side with synthetic closers, and omission selects
   *   the latest completed-turn prefix), and whether to increment an
   *   inherited durable title before resolving.
   * @returns the child session id.
   * @throws when the fork fails, or when a requested child-title rename fails after creation.
   */
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>
  /**
   * Borrow an already-retained Agent-scoped Context without extending its lifetime.
   * @param id - session id.
   * @returns the live scoped Context, or undefined without a retained generation.
   */
  scope(id: SessionId): AgentContext | undefined
  /**
   * Read the Agent scope tag off a context (service-method boundary: fetch
   * bundles must reach scope resolution through ctx.sessions).
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined
  /**
   * Resolve the session face behind an Agent-scoped context.
   * @param ctx - an Agent-scoped context.
   * @returns the matching live Session, or undefined for an untagged, foreign, or ended generation.
   */
  sessionOf(ctx: Context): SessionFace | undefined
  /**
   * Borrow an already-retained Session binding without extending its lifetime.
   * @param id - session id.
   * @returns the live binding, or undefined without a retained generation.
   */
  binding(id: SessionId): SessionBinding | undefined
}

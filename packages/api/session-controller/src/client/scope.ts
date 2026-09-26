/** Client scope generations route local events independently of Host Agent residency. */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol'

/** Client Cordis Context carrying one Agent identity and its scoped Remote namespaces. */
export type AgentContext = Omit<Context, 'remote'> & {
  readonly remote: ClientRemote & TypertRemoteScopeApi<'agent'>
}

/** Context tag written by {@link createScope}. */
const kScope = Symbol('dsh.client.scope')

interface ScopeIdentity {
  readonly sessionId: SessionId
}

/** A minted Agent scope and its disposal boundary. */
export interface AgentScopeHandle {
  /**
   * Tagged context: scope-owned registrations and scoped dispatch both go
   * through it (passing it as the dispatch subject routes to this generation's
   * tagged listeners plus every untagged one).
   */
  ctx: AgentContext
  /** Backing fiber (dispose tears down every scope-owned registration). */
  fiber: Fiber
}

/** Shared no-op plugin backing each Agent scope fiber. */
function agentScope(): void {}

/**
 * Mint an Agent scope under `ctx`: a no-op plugin fiber whose context
 * carries the agent tag and the dispatch filter — untagged listeners are
 * admitted globally, tagged listeners only for the same Client generation.
 * Registrations through the returned ctx dispose with the fiber.
 * @param ctx - client root context the scope fiber mounts under.
 * @param key - durable Session identity carried by this generation.
 * @returns the tagged context and its backing fiber.
 */
export function createScope(ctx: Context, key: SessionId): AgentScopeHandle {
  const fiber = ctx.plugin(agentScope)
  const identity: ScopeIdentity = { sessionId: key }
  const scoped = fiber.ctx.extend({
    [kScope]: identity,
    [CordisContext.filter](listenerCtx: Context): boolean {
      const tag = scopeIdentityOf(listenerCtx)
      return tag === undefined || tag === identity
    },
  }) as AgentContext
  return {
    fiber,
    ctx: scoped,
  }
}

/**
 * Read the nearest agent tag inherited by a context.
 * @param ctx - any client context.
 * @returns its agent identity (the session id), or undefined for root contexts.
 */
export function scopeOf(ctx: Context): SessionId | undefined {
  return scopeIdentityOf(ctx)?.sessionId
}

/**
 * Read the exact generation identity inherited by a Client Context.
 * @param ctx - scoped or root Client Context.
 * @returns the generation identity, or undefined for an unscoped Context.
 */
export function scopeIdentityOf(ctx: Context): ScopeIdentity | undefined {
  return (ctx as Context & { [kScope]?: ScopeIdentity })[kScope]
}

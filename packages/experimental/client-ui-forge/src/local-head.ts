/**
 * The checkouts of Sessions delegated from a reading Session, which a local scope can read in place of the reading
 * Session's own. Each is found through the related Session's records, without resuming it, and inspected with the
 * reading Session's permissions.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { inspectCheckout } from './git.ts'
import type { GitConfig, Inspection } from './git.ts'
import { HeadMissing } from './local-diff.ts'
import type { ForgeRelatedCheckout, ForgeSessionWorktree } from './types.ts'

/** A related Session's checkout and the worktree record that fixes its automatic fork point. */
export interface RelatedCheckout {
  /** The checkout of the related Session's current directory. */
  readonly inspection: Inspection
  /** The worktree that Session created at the checkout, or null when it works in a checkout it did not create. */
  readonly created: ForgeSessionWorktree | null
}

/**
 * Find the checkout a Session delegated from the reading Session works in.
 * @param ctx - context that provides `fs`, `subprocess`, `sandbox`, `sandboxPolicy`, and an optional `sessionQuery`.
 * @param config - executable and process limits.
 * @param session - reading Session, whose sandbox policy and execution world Git uses.
 * @param sessionId - Session a `session` head names.
 * @param signal - cancellation of every read and command.
 * @returns the checkout and the worktree record of the related Session.
 * @throws HeadMissing without the Session query service, when the named Session is unknown or was not delegated from
 * the reading Session at any depth, or when its directory is gone or outside a checkout; an Error when Git fails.
 */
export async function relatedCheckout(
  ctx: Context, config: GitConfig, session: Session, sessionId: SessionId, signal: AbortSignal,
): Promise<RelatedCheckout> {
  const seen = new Set<SessionId>()
  for (let current = sessionId; current !== session.id;) {
    // A header chain that returns to a Session it left names no ancestor.
    if (seen.has(current)) throw new HeadMissing(`Session ${sessionId} was not delegated from this Session`)
    seen.add(current)
    current = await delegatingSession(ctx, current, sessionId, signal)
  }
  return await checkoutOf(ctx, config, session, sessionId, signal)
}

/**
 * List the checkouts that Sessions delegated from the reading Session work in, leaving out the reading Session's own.
 * Sessions that share a checkout make one entry. A Session whose directory is gone or outside a checkout is left out;
 * one whose checkout Git cannot inspect is left out with a warning.
 * @param ctx - context that provides `fs`, `subprocess`, `sandbox`, `sandboxPolicy`, and optional `subagents` and `sessionQuery`.
 * @param config - executable and process limits.
 * @param session - reading Session, whose sandbox policy and execution world Git uses.
 * @param own - the reading Session's checkout.
 * @param allowed - whether the caller may read a Session.
 * @param signal - cancellation of every read and command.
 * @returns the checkouts in catalog order of their first Session, or none without the subagent or Session query service.
 * @throws when the subagent catalogs cannot be read or `signal` aborts.
 */
export async function relatedCheckouts(
  ctx: Context, config: GitConfig, session: Session, own: Inspection, allowed: (sessionId: SessionId) => boolean, signal: AbortSignal,
): Promise<ForgeRelatedCheckout[]> {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || ctx.get('sessionQuery') === undefined) return []
  const byRoot = new Map<string, ForgeRelatedCheckout & { readonly labels: string[] }>()
  for (const row of await subagents.listDescendants(session.id, signal)) {
    // An external execution keeps no local Session whose directory could be read.
    if (row.kind !== 'child' || row.mode === 'external' || !allowed(row.id)) continue
    let inspection: Inspection
    try {
      ({ inspection } = await checkoutOf(ctx, config, session, row.id, signal))
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof HeadMissing)) ctx.logger.warn(`forge-panel: inspecting the checkout of Session ${row.id} failed: ${String(error)}`)
      continue
    }
    const { root, branch, commit } = inspection.checkout
    if (root === own.checkout.root) continue
    const label = row.label ?? row.path ?? row.id
    const entry = byRoot.get(root)
    if (entry === undefined) byRoot.set(root, { sessionId: row.id, root, branch, commit, labels: [label] })
    else entry.labels.push(label)
  }
  return [...byRoot.values()]
}

/** The Session that delegated to `current`, read from its header. */
async function delegatingSession(ctx: Context, current: SessionId, named: SessionId, signal: AbortSignal): Promise<SessionId> {
  using observed = await observe(ctx, current, named, signal)
  const { origin, parentSession } = observed.header
  if (origin !== 'subagent' || parentSession === undefined) throw new HeadMissing(`Session ${named} was not delegated from this Session`)
  return parentSession
}

/** Inspect the checkout of a Session's recorded directory and pick the worktree it created there. */
async function checkoutOf(
  ctx: Context, config: GitConfig, session: Session, sessionId: SessionId, signal: AbortSignal,
): Promise<RelatedCheckout> {
  let directory: string | undefined
  let worktrees: readonly ForgeSessionWorktree[]
  {
    using observed = await observe(ctx, sessionId, sessionId, signal)
    const values = observed.projections?.values
    directory = values?.workingDirectory ?? observed.header.cwd
    worktrees = (values?.worktree ?? []).map(({ worktree }) => ({ ...worktree, from: null }))
  }
  if (directory === undefined || await ctx.fs.lstat(directory, undefined, signal) === undefined) {
    throw new HeadMissing(`The directory of Session ${sessionId} is gone`)
  }
  const inspection = await inspectCheckout(ctx, config, session, directory, signal)
  if (inspection === undefined) throw new HeadMissing(`The directory of Session ${sessionId} is not inside a Git checkout`)
  return { inspection, created: worktrees.find(worktree => worktree.path === inspection.checkout.root) ?? null }
}

/** Observe a Session's records without attaching it; an unknown Session and a missing query service are a missing head. */
async function observe(ctx: Context, sessionId: SessionId, named: SessionId, signal: AbortSignal) {
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw new HeadMissing('Reading another Session\'s checkout needs the sessionQuery service')
  try {
    return await query.observeSession(sessionId, { signal })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new HeadMissing(`Session ${named} has no records`, { cause: error })
    }
    throw error
  }
}

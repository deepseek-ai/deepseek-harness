/**
 * The confined access layer one share's source Session carries, and the turn control around it.
 *
 * The layer is registered into the Session's own scope and confines the turns a share viewer starts while
 * any share over the Session is active; the owner's own turns keep the deployment's tools. It belongs to
 * the Session rather than to one share, so several shares over it share one installation, and the host
 * releases it once no share is left. Stopping a share stops whatever turn the Session is running, with
 * the owner's own cancellation, without asking which turn or which requester it was.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/source-access
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import {
  installSourceSessionAccess,
  type ForkEnforcementFs,
  type ForkToolPaths,
  type ForkToolRegistry,
  type SourceSessionAccessInstallation,
} from './fork-enforcement.ts'
import type { ForkToolExecution } from './fork-tool-guard.ts'
import { isExpired, type ViewerSessionMode } from './fork-policy.ts'
import { describeSharedTool, sharedToolProfile } from './shared-tools.ts'
import type { ForkRegistry } from './fork-registry.ts'
import type { RelayAuthority } from './relay-authority.ts'

/** Owner share shape this module reads; the host owns the full record. */
import type { OwnerShare } from './owner-types.ts'

/** Where one source-access attempt came from; named in its diagnostic line. */
export type WriteAccessTrigger = 'publish' | 'restore' | 'mode' | 'reader' | 'prompt'

/** Why one source-access installation did not happen: the guard that refused, as a stable code. */
type WriteAccessRefusal =
  | 'no-live-session'
  | 'no-live-context'
  | 'no-session-scope'
  | 'no-filesystem'
  | 'no-tool-registry'
  | 'no-sandbox-policy'
  | 'no-workspace-root'
  | 'no-session-cwd'
  | 'workspace-unresolved'
  | 'share-gone'
  | 'share-reassigned'
  | 'share-mode-changed'
  | 'share-inactive'

/** What one source-access attempt did. */
export type WriteAccessOutcome =
  /** This attempt installed the layer. */
  | { readonly kind: 'installed'; readonly installation: SourceSessionAccessInstallation }
  /** A usable layer was already recorded, by this attempt's caller or another share's. */
  | { readonly kind: 'kept'; readonly installation: SourceSessionAccessInstallation }
  /** A guard refused, and named itself in the diagnostic. */
  | { readonly kind: 'refused'; readonly reason: WriteAccessRefusal }

/** Installs the access layer one share's source Session needs. */
export type SourceAccessApplier = (
  share: OwnerShare,
  ready: { readonly context: Context; readonly session: Session } | undefined,
  trigger: WriteAccessTrigger,
) => Promise<WriteAccessOutcome>

/** The live agent fields this host reads when a share's capability ends with a turn still running. */
interface LiveAgent {
  readonly status?: string
  cancel?: (cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }) => void
}

/** The `agent` lookup provider, as much of it as this host reads. */
interface AgentLookupProvider {
  /** @param sessionId - Session identity the composition resolves to its live Agent. */
  resolve(sessionId: string): unknown
}

/**
 * Bring one Session's Agent up through the composition's own activation path and wait for it.
 *
 * The Session is resolved or resumed exactly as an ordinary Host request resolves it — preset
 * composition, model-selection installation, then publication — so every plugin that installs itself
 * from the `agent/created` announcement has run by the time this settles. That is what makes this host
 * safe to call before it drives a Session whose Agent may have been activated in an earlier process.
 *
 * The capability is the merge-declared `agent` lookup: its resolver belongs to the composition, and the
 * API Session controller points it at the same activation path its own endpoints use. Reading it here
 * keeps this bundle free of any dependency on those endpoints, and a deployment that installs no such
 * lookup is refused loudly rather than silently treated as activated.
 * @param ctx - Host context carrying the Typert lookup registry.
 * @param sessionId - Session to resolve or resume.
 * @throws when this deployment installs no agent lookup, or the lookup activates no Agent.
 */
export async function activateSession(ctx: Context, sessionId: string): Promise<void> {
  const typert = ctx.get('typert') as
    | { readonly lookups?: { get?: (key: string) => AgentLookupProvider | undefined } }
    | undefined
  const provider = typert?.lookups?.get?.('agent')
  if (provider === undefined) {
    throw new Error(`this host cannot activate session ${sessionId}: no agent lookup is registered`)
  }
  const agent = await provider.resolve(sessionId)
  if (agent === undefined) {
    throw new Error(`activating session ${sessionId} failed: the agent lookup answered with nothing`)
  }
}

/**
 * The paths one tool call names, as every enforcement installation in this host reads them.
 *
 * Each tool's own argument names are read from the shared surface, so a path-based search, an image
 * read, and a delivery list establish their targets here; a name the surface does not admit, or
 * arguments it cannot read, establish no path and the guard refuses the call.
 * @param execution - The call being judged.
 * @returns The paths it names, or nothing when they cannot be established.
 */
function forkToolPaths(execution: ForkToolExecution): ForkToolPaths {
  return describeSharedTool(execution.name, execution.arguments)
}

/** Host state the source Session's access layer reads. */
export interface SourceAccessDeps {
  /** Host context carrying the optional Agent, filesystem, tool, and sandbox services. */
  readonly ctx: Context
  /** Shares this host publishes. */
  readonly ownerShares: Map<string, OwnerShare>
  /** Children this host created, whose turns a narrowed grant ends. */
  readonly forks: ForkRegistry
  /** Reads of the Relay's authority over one share. */
  readonly relay: RelayAuthority
  /** Whether this host has been disposed. */
  readonly disposed: () => boolean
  /** Tell remote access that reader answers may have changed. */
  readonly accessChanged: () => void
  /**
   * Whether one tool execution belongs to a turn a share viewer started.
   *
   * The source layer confines those turns and leaves an owner-started one on the deployment's tools, so
   * this is the per-execution authority both the guard and the replacements read.
   */
  readonly confinedExecution: (execution: ForkToolExecution) => boolean
}

/** The confined access layer and turn control one host's source Sessions carry. */
export interface SourceAccess {
  /**
   * Install the access layer one share's source Session needs.
   * @param share - Share the layer is being installed for.
   * @param ready - The announced agent's own scope and session, when the caller has them.
   * @param trigger - Where this attempt came from, named in the diagnostic a refusal logs.
   * @returns What this attempt did.
   */
  apply(
    share: OwnerShare,
    ready?: { readonly context: Context; readonly session: Session },
    trigger?: WriteAccessTrigger,
  ): Promise<WriteAccessOutcome>
  /**
   * Whether one share's source Session carries a usable confined access layer right now.
   * @param shareId - Share the request arrived through.
   * @returns True only while the layer is installed and confined.
   */
  confined(shareId: string): boolean
  /**
   * Why one share's source Session is not confined for driving, or undefined while it is.
   * @param shareId - Share the question is asked about.
   * @returns The refusal code, or undefined while the source Session is confined for this share.
   */
  confinementRefusal(shareId: string): string | undefined
  /**
   * The recorded installation's own refusal code for one share's Session.
   * @param shareId - Share whose source Session is asked about.
   * @returns The refusal, or undefined when none was recorded.
   */
  refusalOf(shareId: string): string | undefined
  /**
   * Stop child work whose grant is being narrowed or removed.
   * @param shareId - Share whose children are stopped.
   * @param viewer - Only this viewer's children, when one grant ended.
   */
  cancelChildTurns(shareId: string, viewer?: ShareRpcActor): void
  /**
   * The recorded child may use only tools its share currently permits.
   * @param childSessionId - Child whose tool is being judged.
   * @param tool - Tool name the call names.
   * @returns True while the child may run that tool.
   */
  childToolAuthorized(childSessionId: string, tool: string): boolean
  /**
   * Stop whatever turn one share's Session is running, when the share stops driving it.
   *
   * The host records only whether a turn was viewer-started, not which viewer admitted it, so it cannot
   * tell a revoked viewer's turn from the owner's: a share that ends its grant stops the running turn
   * itself.
   * @param shareId - Share whose capability just ended.
   */
  cancelShareTurn(shareId: string): void
  /**
   * Make the Session's layer match its shares after one of them stopped, expired, or changed tier.
   *
   * A Session whose shares are all inactive loses its layer, which restores the Session's own tools; a
   * Session whose shares no longer need the bounded write is re-installed read-only.
   * @param sessionId - Session whose published shares changed.
   */
  reconcileSessionAccess(sessionId: string): void
  /**
   * Prepare one share's source Session for driving, waiting only for the activation it needs.
   * @param sessionId - Session one published share names.
   * @param trigger - Where this preparation came from.
   */
  prepareSourceSession(sessionId: string, trigger: WriteAccessTrigger): Promise<void>
  /**
   * Start preparing one share's source Session, at most once at a time, without waiting for it.
   * @param shareId - Share one reader just asked about.
   */
  prepareSourceForReader(shareId: string): void
  /**
   * The paths one tool call names, as every enforcement installation in this host reads them.
   * @param execution - The call being judged.
   * @returns The paths it names, or nothing when they cannot be established.
   */
  forkToolPaths(execution: ForkToolExecution): ForkToolPaths
}

/**
 * Build the confined access layer for this host's source Sessions.
 * @param deps - Shares and the Relay authority the layer reads.
 * @returns The access layer and turn control.
 */
export function createSourceAccess(deps: SourceAccessDeps): SourceAccess {
  const ownerShares = deps.ownerShares
  const forks = deps.forks
  const relay = deps.relay

  /**
   * The shares over one Session that may still drive it.
   *
   * A stored record stays published after its deadline passes, so the deadline is part of activity: an
   * expired share serves no viewer and must not keep the Session sandboxed.
   * @param sessionId - Session the shares name.
   * @returns The published, unexpired shares over it, in insertion order.
   */
  const activeSharesOf = (sessionId: string): OwnerShare[] =>
    [...ownerShares.values()].filter(share => share.sessionId === sessionId && !isExpired(share.expiresAt, Date.now()))

  /**
   * Access layers this host installed, keyed by the SESSION they sandbox.
   *
   * One Session may be shared by several shares at either tier, and its layer belongs to the Session
   * rather than to any one share: installing a second one would collide on the tool names, and removing
   * a share must not take away the constraint another share still needs. The layer is write-capable when
   * any share over that Session is, and the shares' current grants decide each operation.
   */
  const sourceAccess = new Map<string, SourceSessionAccessInstallation>()

  /**
   * Report one write-access attempt that installed nothing, with the guard that refused it.
   *
   * Every guard on this path returns without a trace by design — a share that cannot be confined must not
   * become writable — but a silent return hid why a host served a write share with no layer at all. The
   * line states the trigger and the guard, and nothing else: no path, no credential, no reader identity.
   * @param share - Share the attempt was for.
   * @param trigger - Where the attempt came from: a publish announcement, host startup, a reader's page, or
   *   the prompt path that prepares the source.
   * @param reason - Stable code naming the guard that refused.
   * @returns The refusal outcome, so a caller returns it directly.
   */
  const refusedSourceAccess = (
    share: OwnerShare,
    trigger: WriteAccessTrigger,
    reason: WriteAccessRefusal,
  ): WriteAccessOutcome => {
    if (process.env.LIVESHARE_VIEWER_DEBUG === '1') {
      console.warn(
        `[liveshare] source access not installed trigger=${trigger} share=${share.shareId}`
        + ` session=${share.sessionId} reason=${reason}`,
      )
    }
    return { kind: 'refused', reason }
  }

  /**
   * Whether any active share over one Session may write it.
   *
   * The layer is per Session while the tier is per share, so the Session's layer carries the bounded write
   * when any share over it may write.
   * @param sessionId - Session the shares name.
   * @returns True when at least one active share over it is at the write tier.
   */
  function sessionNeedsWrite(sessionId: string): boolean {
    return activeSharesOf(sessionId).some(share => share.sessionMode === 'write')
  }

  /**
   * Whether one of the Session's active shares still drives it at the write tier.
   *
   * The stored tier is the owner's answer and the Relay's statement caps it, so both are read: a share the
   * Relay narrowed no longer writes even though the record still names the write tier.
   * @param sessionId - Session the shares name.
   * @returns True while some active share is at the write tier in both answers.
   */
  function sessionWritable(sessionId: string): boolean {
    return sessionNeedsWrite(sessionId)
      && activeSharesOf(sessionId).some(share => relay.drivableModeOf(share.shareId) === 'write')
  }

  /**
   * Whether one Session's recorded layer already matches the tier its shares need.
   *
   * A Session shared only at the view tier needs the confined read and no write replacement, so a layer
   * installed for a wider tier is replaced rather than kept; one any share may write needs the write
   * replacement too. A layer that confines nothing is never usable, so a Session whose installation failed
   * once can be installed again.
   * @param sessionId - Session whose recorded layer is asked about.
   * @param mode - Tier the caller needs the layer for.
   * @returns True when the recorded installation already states exactly that tier.
   */
  function sourceAccessUsable(sessionId: string, mode: ViewerSessionMode): boolean {
    const installed = sourceAccess.get(sessionId)
    if (installed?.readConfined !== true) return false
    return mode === 'write' ? installed.writeConfined : !installed.writeConfined
  }

  /**
   * Install the access layer one share's source Session needs.
   *
   * The Session must be live and scoped: the layer is registered into its own scope and confines every
   * turn of that Session. Anything the host cannot resolve — no live agent, no scope, no granted workspace
   * — installs nothing, and a share with no layer drives nothing.
   * @param share - Share the layer is being installed for.
   * @param ready - The announced agent's own scope and session, supplied by the `agent/created` listener
   *   so the layer is installed against exactly the agent whose announcement is running.
   * @param trigger - Where this attempt came from, named in the diagnostic a refusal logs.
   */
  const applySourceAccess = async (
    share: OwnerShare,
    ready?: { readonly context: Context; readonly session: Session },
    trigger: WriteAccessTrigger = 'prompt',
  ): Promise<WriteAccessOutcome> => {
    // A layer that already meets the widest tier this Session needs is kept: several shares over one
    // Session share the one installation. An installation that could not confine anything is replaced
    // rather than kept, so a Session whose layer failed once — because it was not live yet, for instance
    // — can still get one.
    const wanted = sessionNeedsWrite(share.sessionId) ? 'write' : 'view'
    const active = activeSharesOf(share.sessionId)
    const recorded = sourceAccess.get(share.sessionId)
    if (active.length > 0 && sourceAccessUsable(share.sessionId, wanted) && recorded !== undefined) {
      return { kind: 'kept', installation: recorded }
    }
    recorded?.dispose()
    sourceAccess.delete(share.sessionId)
    // Every service is read through the context lookup: this bundle declares only `connection`, so a
    // property access for another service is a Cordis injection error at runtime, casts or not.
    const agents = deps.ctx.get('agents') as
      | { get?: (id: string) => { readonly ctx?: unknown; readonly session?: unknown } | undefined }
      | undefined
    const live = ready === undefined ? agents?.get?.(share.sessionId) : undefined
    const session = (ready?.session ?? live?.session) as Session | undefined
    const liveContext = (ready?.context ?? live?.ctx) as Context | undefined
    const fs = deps.ctx.get('fs') as ForkEnforcementFs | undefined
    const tools = deps.ctx.get('tools') as ForkToolRegistry | undefined
    const sandboxPolicy = deps.ctx.get('sandboxPolicy') as
      | { resolve: (request: { session: Session }) => SandboxExecutionPolicy }
      | undefined
    const resolved = session === undefined ? undefined : sandboxPolicy?.resolve({ session })
    const root = resolved?.workspaceRoot
    const cwd = session?.header.cwd
    // The layer is registered into the Session's own SCOPE, which is a scope key rather than the Session:
    // tool lookup walks scope layers, so a Session-object stand-in would resolve the wrong definitions.
    const scopeKey = liveContext === undefined ? undefined : scopeOf(liveContext)
    if (session === undefined) return refusedSourceAccess(share, trigger, 'no-live-session')
    if (liveContext === undefined) return refusedSourceAccess(share, trigger, 'no-live-context')
    if (scopeKey === undefined) return refusedSourceAccess(share, trigger, 'no-session-scope')
    if (fs === undefined) return refusedSourceAccess(share, trigger, 'no-filesystem')
    if (tools === undefined) return refusedSourceAccess(share, trigger, 'no-tool-registry')
    if (sandboxPolicy === undefined) return refusedSourceAccess(share, trigger, 'no-sandbox-policy')
    if (typeof root !== 'string') return refusedSourceAccess(share, trigger, 'no-workspace-root')
    if (cwd === undefined) return refusedSourceAccess(share, trigger, 'no-session-cwd')
    const granted = await fs.resolve(root).catch(() => undefined)
    if (granted === undefined) return refusedSourceAccess(share, trigger, 'workspace-unresolved')
    // Awaited, and confirmed against the share it was requested for: a share re-published with another
    // Session, or one whose mode narrowed, must not leave an installation behind. The check reads those
    // two invariants rather than the share's revision counter: a title reconcile and a Relay authority
    // refresh bump that counter without changing what this layer confines, so abandoning an installation
    // for one of them left a write share with no layer at all, which no later path retried.
    const current = ownerShares.get(share.shareId)
    if (current === undefined) return refusedSourceAccess(share, trigger, 'share-gone')
    if (current.sessionId !== share.sessionId) return refusedSourceAccess(share, trigger, 'share-reassigned')
    // The Session still has to be shared at some tier, and the tier the caller asked for has to still be
    // one this Session needs: a share removed while the workspace resolved installs nothing.
    const needsWrite = sessionNeedsWrite(share.sessionId)
    if (needsWrite !== (wanted === 'write')) return refusedSourceAccess(share, trigger, 'share-mode-changed')
    // Every share over the Session stopped or expired while the workspace resolved: nothing remains that
    // could drive it, so no layer is installed.
    if (activeSharesOf(share.sessionId).length === 0) return refusedSourceAccess(share, trigger, 'share-inactive')
    // Another installation can finish while the workspace resolves. Publication below is synchronous.
    const concurrent = sourceAccess.get(share.sessionId)
    if (sourceAccessUsable(share.sessionId, wanted) && concurrent !== undefined) {
      return { kind: 'kept', installation: concurrent }
    }
    concurrent?.dispose()
    sourceAccess.delete(share.sessionId)
    const installation = installSourceSessionAccess({
      sessionId: share.sessionId,
      context: liveContext,
      scope: scopeKey,
      grantedRoot: granted,
      cwd,
      fs,
      tools,
      describe: forkToolPaths,
      confinedExecution: deps.confinedExecution,
      resolvePolicy: () => sandboxPolicy.resolve({ session }),
      // The write replacement is registered once for the Session, whenever any share over it may write.
      // Whether writing is still allowed is read from the Session's shares when a write runs, so a share
      // that narrows to view stops writing on the layer that is already mounted.
      ...(needsWrite ? { write: { mayWrite: () => sessionWritable(share.sessionId) } } : {}),
      // Every operation re-reads the grants of the shares that keep this Session drivable, so an input
      // queued past the grant that admitted it cannot act on the stale admission.
      refreshAuthorization: async () => {
        for (const current of activeSharesOf(share.sessionId)) await relay.refreshRelayAccess(current.shareId)
      },
    })
    // Recorded whether or not it is usable: the guard it installed still has to be released, and the
    // reader asks this record whether the source Session is confined before it drives any prompt.
    sourceAccess.set(share.sessionId, installation)
    deps.accessChanged()
    liveContext.effect(() => () => {
      installation.dispose()
      if (sourceAccess.get(share.sessionId) === installation) sourceAccess.delete(share.sessionId)
      deps.accessChanged()
    }, 'liveshare: source enforcement lifetime')
    const registrationFailure = installation.registrationFailure
    if (!installation.readConfined) {
      console.warn(
        `[liveshare] source session not confined share=${share.shareId}`
        // A read that confined nothing always records why; the record keeps that refusal.
        + ` refusal=${installation.refusal}`
        + (registrationFailure === undefined ? '' : ` error=${errorMessage(registrationFailure.error)}`),
      )
    } else if (registrationFailure !== undefined) {
      // The read is confined but another replacement is not, so that tool stays refused. A failed write
      // replacement also leaves a write-tier share refused by `layer-write-unconfined`; this states why
      // the scope would not take it.
      console.warn(
        `[liveshare] source session ${registrationFailure.tool} not confined share=${share.shareId}`
        + ` error=${errorMessage(registrationFailure.error)}`,
      )
    } else if (process.env.LIVESHARE_VIEWER_DEBUG === '1') {
      console.warn(
        `[liveshare] source access installed trigger=${trigger} share=${share.shareId}`
        + ` session=${share.sessionId} tier=${wanted}`,
      )
    }
    return { kind: 'installed', installation }
  }

  /**
   * Whether one share's source Session carries a usable confined access layer right now.
   *
   * A prompt that drives that Session is refused unless this holds, so a share whose layer could not be
   * installed — or whose Session is not live yet — is never driven against the owner's own tools.
   * @param shareId Share the request arrived through.
   * @returns True only while the layer is installed and confined.
   */
  function sourceConfined(shareId: string): boolean {
    return sourceConfinementRefusal(shareId) === undefined
  }

  /**
   * Why one share's source Session is not confined for driving, or undefined while it is.
   *
   * The answer is the first guard that refuses, as a stable code, so a host can state why a share
   * carried no layer instead of only that it did not. Both tiers drive the Session, so both need the
   * confined read; only the write tier needs the confined write beside it.
   * @param shareId - Share the question is asked about.
   * @returns The refusal code, or undefined while the source Session is confined for this share.
   */
  function sourceConfinementRefusal(shareId: string): string | undefined {
    const share = ownerShares.get(shareId)
    if (share === undefined) return 'share-unknown'
    // The share's own answer is part of it: a share whose deadline passed is not confined for driving,
    // whatever layer its Session still carries. Until the Relay states a tier, this host cannot tell
    // which one the share carries and drives nothing.
    const mode = relay.drivableModeOf(shareId)
    if (mode === undefined) return 'share-mode-unknown'
    const access = sourceAccess.get(share.sessionId)
    if (access === undefined) return 'layer-absent'
    if (!access.readConfined) return 'layer-read-unconfined'
    if (mode === 'write' && !access.writeConfined) return 'layer-write-unconfined'
    return undefined
  }

  /** The recorded installation's own refusal code for one share's Session. */
  function refusalOf(shareId: string): string | undefined {
    const share = ownerShares.get(shareId)
    if (share === undefined) return undefined
    return sourceAccess.get(share.sessionId)?.refusal
  }

  /** Stop child work whose grant is being narrowed or removed. */
  function cancelChildTurns(shareId: string, viewer?: ShareRpcActor): void {
    const agents = deps.ctx.get('agents')
    for (const child of forks.listForShare(shareId)) {
      if (viewer !== undefined && identityKeyOf(child.creator) !== identityKeyOf(viewer)) continue
      agents?.get(child.childSessionId as SessionId)?.cancel({ kind: 'user' })
    }
  }

  /** The recorded child may use only tools its share currently permits. */
  function childToolAuthorized(childSessionId: string, tool: string): boolean {
    const child = forks.find(childSessionId)
    if (deps.disposed() || child === undefined || child.revokedAt !== undefined) return false
    const share = ownerShares.get(child.shareId)
    const mode = relay.drivableModeOf(child.shareId)
    if (share === undefined || isExpired(share.expiresAt, Date.now())
      || !relay.viewerAdmitted(child.shareId, child.creator) || mode === undefined) return false
    // A child runs under its own view ceiling; the write tier is what lets its turn reach the bounded
    // write and edit this host installs for it. A name the shared surface does not admit is never one
    // this host installed a replacement for, so the answer is no whatever the tier says.
    const profile = sharedToolProfile(tool)
    return profile !== undefined && (profile.tier === 'view' || mode === 'write')
  }

  /**
   * Stop whatever turn one share's Session is running.
   *
   * Revoking a share's capability unestablishes the work it admitted, but the host does not attribute a
   * turn to the requester that admitted it: the running turn is stopped with the same cancellation the
   * owner's own Stop command uses. Nothing already written is undone; a turn that has not started yet is
   * refused by the sandbox instead.
   * @param shareId - Share whose capability just ended.
   */
  const cancelShareTurn = (shareId: string): void => {
    const share = ownerShares.get(shareId)
    if (share === undefined) return
    const agents = deps.ctx.get('agents') as
      | { get?: (id: string) => LiveAgent | undefined }
      | undefined
    const live = agents?.get?.(share.sessionId)
    if (live === undefined || live.status !== 'running') return
    console.warn(`[liveshare] cancelling source turn share=${shareId}`)
    live.cancel?.({ kind: 'user' }, { keepInbox: true })
  }

  /**
   * Make one Session's layer match the shares it still has.
   *
   * The layer belongs to the Session, so it ends only when the Session has no active share left: a Session
   * whose shares all stopped or expired gets its own tools back. A Session whose remaining shares no longer
   * need the bounded write is re-installed read-only, so a downgraded share leaves no write name behind.
   * @param sessionId - Session whose published shares changed.
   */
  function reconcileSessionAccess(sessionId: string): void {
    const shares = activeSharesOf(sessionId)
    const [target] = shares
    // No active share left: the Session keeps no sandbox, so its own tools come back.
    if (target === undefined) {
      const installed = sourceAccess.get(sessionId)
      if (installed === undefined) return
      installed.dispose()
      sourceAccess.delete(sessionId)
      deps.accessChanged()
      return
    }
    const wanted = shares.some(share => share.sessionMode === 'write') ? 'write' : 'view'
    if (sourceAccessUsable(sessionId, wanted)) return
    // Any share over the Session installs what the whole Session needs: the installation reads the tier
    // from the shares, not from the record it was asked with.
    void applySourceAccess(target, undefined, 'mode')
  }

  /**
   * Prepare one share's source Session for driving, waiting only for the activation it needs.
   *
   * Preparing the source Session is the same owner-side activation a child gets: resolving or resuming it
   * announces the agent, whose `agent/created` listener installs a share's layer. A Session whose agent
   * was already live when this host mounted ran that listener once — possibly before this host could
   * install anything, which is how a first attempt fails and a later one stays refused — so the layer is
   * installed here as well, under the authorization in force at this moment: the share must still be
   * published, still name this Session, and still name a tier.
   * @param sessionId - Session one published share names.
   * @param trigger - Where this preparation came from, named in the diagnostic a refusal logs.
   * @returns after an installation is recorded, or after the share stopped qualifying for one.
   */
  const prepareSourceSession = async (sessionId: string, trigger: WriteAccessTrigger): Promise<void> => {
    await activateSession(deps.ctx, sessionId)
    // The share's own record says whether a layer is needed; the Relay's narrowing tier only says whether
    // one may already be driven. Requiring the narrowing answer here would refuse to prepare exactly the
    // share whose Relay answer has not arrived yet, which is the one a reader is waiting on.
    const share = [...ownerShares.values()].find(candidate => candidate.sessionId === sessionId)
    if (share === undefined) return
    if (sourceAccessUsable(sessionId, share.sessionMode)) return
    await applySourceAccess(share, undefined, trigger)
  }

  /** One preparation in flight per Session, so repeated reader requests wait on the same activation. */
  const preparingSources = new Map<string, Promise<void>>()

  /**
   * Start preparing one share's source Session, at most once at a time, without waiting for it.
   *
   * A host that restarted with a restored share installed no layer during startup, because that
   * Session's agent was not live yet, and the reader's snapshot then carried no driving action: the
   * composer stayed inert, so the prompt path that prepares the source was never reached. The reader's
   * own snapshot entries start the preparation instead. A recorded installation re-pushes every open
   * snapshot, so a page already following its access stream gains the actions without a reload, and no
   * reader request waits on it: a preparation that fails, or one that never settles, leaves the share
   * exactly as refused as it already was.
   * @param shareId - Share one reader just asked about.
   */
  function prepareSourceForReader(shareId: string): void {
    if (deps.disposed()) return
    const share = ownerShares.get(shareId)
    if (share === undefined) return
    // Nothing to prepare while the layer is usable. Otherwise the share's own record says whether one is
    // needed, because the Relay's narrowing tier may not have arrived yet: a Reader request must not be
    // the one that waits for it, and every reason this host declines to prepare is worth naming.
    const confinement = sourceConfinementRefusal(shareId)
    if (confinement === undefined) return
    if (confinement !== 'layer-absent' && confinement !== 'layer-read-unconfined' && confinement !== 'layer-write-unconfined') {
      // A tier the Relay has not stated is still a layer this host has to be ready with, because the
      // share's own record names one and the reader is waiting on that answer to arrive.
      /* v8 ignore next 7 -- share-unknown is ruled out by the lookup above, so only an unstated tier remains. */
      if (confinement !== 'share-mode-unknown') {
        if (process.env.LIVESHARE_VIEWER_DEBUG === '1') {
          console.warn(
            `[liveshare] source not prepared trigger=reader share=${shareId}`
            + ` session=${share.sessionId} reason=${confinement}`,
          )
        }
        return
      }
    }
    if (preparingSources.has(share.sessionId)) return
    const started = prepareSourceSession(share.sessionId, 'reader')
      .catch((error: unknown) => {
        // A failed preparation changes nothing: the share stays refused and the reader keeps reading.
        console.warn(
          `[liveshare] preparing the source failed share=${shareId}: ${errorMessage(error)}`,
        )
      })
      .finally(() => { preparingSources.delete(share.sessionId) })
    preparingSources.set(share.sessionId, started)
  }

  return {
    apply: applySourceAccess,
    confined: sourceConfined,
    confinementRefusal: sourceConfinementRefusal,
    refusalOf,
    cancelChildTurns,
    childToolAuthorized,
    cancelShareTurn,
    reconcileSessionAccess,
    prepareSourceSession,
    prepareSourceForReader,
    forkToolPaths,
  }
}

/**
 * Read one caught value's message for a diagnostic this host logs.
 * @param error - Value a dependency threw.
 * @returns The error's message, or the value's own string form.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Web-only host plugin: owner sign-in routes, the share-management Remote, and gateway lifetime. */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  loadOwnerState,
  writeOwnerState,
} from './owner-persistence.ts'
import { normalizeRelayUrl } from './relay-url.ts'
import { createRelayAuthority } from './relay-authority.ts'
import { createOwnerShareOperations } from './owner-share-operations.ts'
import { registerOwnerHttpRoutes } from './owner-http-routes.ts'
import { createTunnelSupervision } from './tunnel-supervision.ts'
import { activateSession, createSourceAccess, type SourceAccess } from './source-access.ts'
import { LiveshareShares } from './share-remote.ts'
import type { OwnerRelayState } from '../share-api-types.ts'
import type { OwnerShare } from './owner-types.ts'
import {
  createViewerReadService,
  type ViewerReadGateway,
  type ViewerReadService,
} from './viewer-read.ts'
import { createViewerAccessPolicy, readerWriteRefusal, type ViewerAccessFacts } from './viewer-access-policy.ts'
import { ViewerDeclarations, viewerDeclarationsOf, type ViewerDeclarationsSurface } from './viewer-declarations.ts'
import { shareViewerOf } from './viewer-principal.ts'
import { loadOwnerCredential } from './owner-credential-file.ts'
import { ForkRegistry } from './fork-registry.ts'
import { OwnerAuthorizations } from './owner-authorization.ts'
import {
  installHostForkEnforcement,
  type ForkEnforcementFailure,
  type ForkEnforcementHost,
  preflightForkChild,
} from './fork-enforcement.ts'
import { readViewerAsset } from './viewer-assets.ts'
import type { ForkShareState } from './fork-policy.ts'
import type { ForkToolExecution } from './fork-tool-guard.ts'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import {
  identityKeyOf,
  type IdentityActor,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'

export const name = 'liveshare-share-host'
export const inject = ['connection']

export { requesterStillAdmitted } from './relay-authority.ts'
export { gatewayWorkerCommand, refreshedShareTitle } from './tunnel-supervision.ts'
export { activateSession } from './source-access.ts'
export type { SourceAccessApplier } from './source-access.ts'

/** Default credential file name, stored beside the owner state file. */
const OWNER_CREDENTIAL_FILENAME = 'owner-credential.json'

/** Default fork registry file name, beside the owner state file. */
const FORK_REGISTRY_FILENAME = 'forks.json'

export type { OwnerShare } from './owner-types.ts'

/**
 * Host plugin configuration: the owner identity shares are created under and the owner-local files that
 * retain shares and the credential across restarts.
 *
 * The public Relay address is not configuration. The owner saves it in the Share dialog, where it
 * persists in the owner state file, so a profile that switches this bundle on without an address still
 * loads: its sharing surfaces report that no address is set until the owner saves one.
 */
export interface Config {
  /** Provider subject ids allowed to view every share created by this host. */
  readonly allowedSubjectIds?: readonly string[]
  /** Authenticated owner identity used to scope people-directory searches. */
  readonly ownerIdentity?: IdentityActor
  /** Owner identity provider used when `ownerIdentity` is assembled from fields. */
  readonly ownerIdentityProvider?: string
  /** Owner identity tenant used when `ownerIdentity` is assembled from fields. */
  readonly ownerIdentityTenant?: string
  /** Owner identity subject used when `ownerIdentity` is assembled from fields. */
  readonly ownerIdentitySubject?: string
  /** Owner identity display name used when `ownerIdentity` is assembled from fields. */
  readonly ownerIdentityDisplayName?: string
  /** Owner-local JSON file retaining share metadata and gateway tokens across host restarts. */
  readonly ownerStateFile?: string
  /**
   * Owner credential file. Defaults beside the owner state file; it holds the Relay-issued
   * credential, which is why it is written with owner-only permissions and never reported.
   */
  readonly ownerCredentialFile?: string
}


/**
 * The share state one viewer request is decided against, read from this host's published share.
 *
 * The Relay admits viewers before a request arrives, so admission is a fact here and the published
 * share supplies the rest. The owner's mode is part of it: the reader routes a prompt naming the share's
 * own Session to the source-session path only when this says `write`, and installs a child with this
 * host's bounded write only for a write share — absent, both answer as reading only.
 * @param share - the share this host published to the Relay.
 * @returns the state the viewer reader decides a fork, a child prompt, or a source prompt against.
 */
export function publishedShareState(share: OwnerShare): ForkShareState {
  return {
    shareId: share.shareId,
    sessionId: share.sessionId,
    allowsFork: share.allowsFork,
    viewerAdmitted: true,
    stopped: false,
    sessionMode: share.sessionMode,
    ...(share.viewerCapabilities === undefined ? {} : { viewerCapabilities: share.viewerCapabilities }),
    ...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
  }
}

/**
 * Register the owner sign-in routes and the share-management Remote, and enforce current grants on
 * external Session input.
 * @param ctx - Host context carrying Connection and optional execution services.
 * @param config - Relay and owner-state configuration.
 * @returns Async disposer that stops the tunnel worker and releases share access.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const connection = ctx.connection
  // Optional service: read through ctx.get so profiles without the api gateway still load. The
  // base gateway's own stream contract is the narrow view the reader opens viewer streams through.
  const gateway: ViewerReadGateway | undefined = ctx.get('typertGateway')
  const ownerIdentity = config.ownerIdentity ?? ownerIdentityFromConfig(config)
  const ownerContext = ownerIdentity === undefined
    ? {}
    : { ownerProviderId: ownerIdentity.providerId, ownerTenantId: ownerIdentity.tenantId }
  const allowedSubjectIds = [...(config.allowedSubjectIds ?? [])]
  if (allowedSubjectIds.some(subject => subject === '')) {
    throw new Error('liveshare-share-host: allowedSubjectIds must not contain an empty subject')
  }
  const ownerStateFile = config.ownerStateFile
    ?? nonEmpty(process.env.LIVESHARE_OWNER_STATE_FILE)
    ?? defaultOwnerStateFile()
  if (ownerStateFile === '') {
    throw new Error('liveshare-share-host: ownerStateFile must not be empty')
  }
  const ownerState = loadOwnerState(ownerStateFile)
  const ownerCredentialFile = config.ownerCredentialFile
    ?? nonEmpty(process.env.LIVESHARE_OWNER_CREDENTIAL_FILE)
    ?? join(dirname(ownerStateFile), OWNER_CREDENTIAL_FILENAME)
  // Children of this host's shares, kept beside the owner state so a restart still knows whose they
  // are and whether their share has stopped allowing forking.
  const forks = new ForkRegistry(join(dirname(ownerStateFile), FORK_REGISTRY_FILENAME))
  let storedCredential = loadOwnerCredential(ownerCredentialFile)
  // The owner's saved address is the only address in force: this host has no deployment-configured
  // fallback, so clearing it returns the host to "no address" rather than to another default.
  let relayOverride = ownerState.relayUrl
  let effectiveRelay: string | undefined = relayOverride
  /** An address change invalidates authorizations awaiting a network response, even A → B → A. */
  let relayRevision = 0
  /** The normalized address in force, absent until the owner saves one. */
  const currentRelay = (): string | undefined =>
    effectiveRelay === undefined ? undefined : normalizeRelayUrl(effectiveRelay)
  const captureOwnerOperation = () => ({
    relay: currentRelay(),
    relayRevision,
    instanceKey: ownerState.instanceId,
  })
  type OwnerOperation = ReturnType<typeof captureOwnerOperation>
  const ownerOperationCurrent = (operation: OwnerOperation): boolean =>
    !disposed && operation.relayRevision === relayRevision
      && operation.relay === currentRelay() && operation.instanceKey === ownerState.instanceId
  const ownerShares = ownerState.shares
  const pendingRemovals = ownerState.pendingRemovals
  let disposed = false
  const relay = createRelayAuthority({
    ownerShares,
    disposed: () => disposed,
    forks,
    ownerIdentity,
    allowedSubjectIds,
    viewerRead: () => viewerRead,
    accessChanged,
    cancelShareTurn: (shareId) => { sourceAccess.cancelShareTurn(shareId) },
    cancelChildTurns: (shareId, viewer) => { sourceAccess.cancelChildTurns(shareId, viewer) },
    scheduleShareExpiry: (share) => { tunnel.scheduleShareExpiry(share) },
    reconcileSourceAccess: (sessionId) => { sourceAccess.reconcileSessionAccess(sessionId) },
  })
  const tunnel = createTunnelSupervision({
    ctx,
    ownerShares,
    pendingRemovals,
    instanceId: ownerState.instanceId,
    allowedSubjectIds,
    ownerContext,
    ownerIdentity,
    relay,
    viewerRead: () => viewerRead,
    accessChanged,
    cancelShareTurn: (shareId) => { sourceAccess.cancelShareTurn(shareId) },
    cancelChildTurns: (shareId, viewer) => { sourceAccess.cancelChildTurns(shareId, viewer) },
    reconcileSourceAccess: (sessionId) => { sourceAccess.reconcileSessionAccess(sessionId) },
    disposed: () => disposed,
    ownerCredentialFile,
    storedCredential: () => storedCredential,
    setStoredCredential: (credential) => { storedCredential = credential },
    persistOwnerState: () => persistOwnerState(),
  })
  /**
   * Tell the remote-access service that reader answers may have changed.
   *
   * Every open reader access snapshot is recomputed from the `share-viewer` policy, which reads the state
   * the caller just changed.
   */
  function accessChanged(): void {
    ctx.get('remoteAccess')?.invalidate()
  }
  /**
   * Share state the `share-viewer` policy and the reader's pre-dispatch write checks read.
   *
   * The declaration surface is the one the bundle provided before this host started, which plugins may
   * already have offered endpoints through; mounting this module on its own provides one here instead.
   * Either way this host is its only consumer, so it subscribes to recompute open access snapshots.
   */
  // A live bundle activation can start this host before the declaration entry's service is visible.
  // Give that entry one task turn before providing a host-owned fallback, so the two never register
  // the same service and the entry remains the surface declaration plugins already resolved.
  const viewerDeclarations = viewerDeclarationsOf(ctx) ?? await new Promise<ViewerDeclarationsSurface>((resolve) => {
    setTimeout(() => { resolve(viewerDeclarationsOf(ctx) ?? new ViewerDeclarations(ctx)) }, 0)
  })
  ctx.effect(() => viewerDeclarations.onChanged(accessChanged), 'liveshare.viewerDeclarations.changed')
  /**
   * The share facts the access snapshot and the fork decision both read.
   *
   * An absent tier is not `view`: the policy refuses every driving decision for a share this host
   * cannot place, rather than offering a reach nobody established. Forking follows the share's own
   * switch, so a share whose tier this host cannot place still answers for the switch: a fork is a
   * read-only child whatever the tier turns out to be.
   */
  const shareFactsOf = (shareId: string): ForkShareState | undefined => {
    const share = ownerShares.get(shareId)
    if (share === undefined) return undefined
    const sessionMode = relay.drivableModeOf(shareId)
    return {
      ...publishedShareState(share),
      ...(sessionMode === undefined ? {} : { sessionMode }),
      allowsFork: share.allowsFork,
    }
  }

  /** @see SourceAccess.confined */
  function sourceConfined(shareId: string): boolean {
    return sourceAccess.confined(shareId)
  }

  const accessFacts: ViewerAccessFacts = {
    share: shareFactsOf,
    viewerAdmitted: (shareId, actor) => ownerShares.has(shareId) && relay.viewerAdmitted(shareId, actor),
    sourceConfined,
    forks,
    workspaces: () => ctx.get('workspaceRegistry')?.list() ?? [],
    declaredCapabilities: () => viewerDeclarations.declaredCapabilities(),
  }
  ctx.inject(['remoteAccess'], (scope) => {
    scope.remoteAccess.registerPolicy('share-viewer', createViewerAccessPolicy(accessFacts))
  })
  /**
   * The turn each Session is running and whether a share viewer started it.
   *
   * A viewer's turn runs the Session's confined layer; the owner's own turn keeps the deployment's native
   * tools. The answer is decided from the admitted step's entering principals and kept for that turn's
   * later steps. It lives in memory only — never in the Session log — so a restarted host recomputes it
   * from the next step it admits, and a workspace with no share never consults it.
   */
  const viewerTurns = new Map<string, { readonly turn: number; confined: boolean }>()

  /**
   * Whether one tool execution belongs to a turn a share viewer started.
   * @param execution - The execution being judged.
   * @returns True when the running turn was started by viewer input, and for an execution this host cannot
   *   attribute to an Agent; an unattributable call must not escape the sandbox.
   */
  const confinedExecution = (execution: ForkToolExecution): boolean => {
    const id = (execution.agent as { readonly id?: unknown } | undefined)?.id
    if (typeof id !== 'string') return true
    return viewerTurns.get(id)?.confined === true
  }

  /**
   * Record whether the turn one admitted step belongs to was started by a share viewer.
   *
   * The first admitted step of a turn decides; a later step of the same turn keeps that answer, so the
   * owner's steering input inside a viewer's turn stays confined. A viewer message that reaches a later
   * step narrows an already-running turn instead of waiting for the next one, so neither side can widen a
   * turn by interjecting.
   * @param sessionId - Session whose turn is running.
   * @param turn - Turn the admitted step belongs to.
   * @param viewerStarted - Whether this step's entering input names a share viewer.
   */
  function noteViewerTurn(sessionId: string, turn: number, viewerStarted: boolean): void {
    const current = viewerTurns.get(sessionId)
    if (current?.turn !== turn) {
      viewerTurns.set(sessionId, { turn, confined: viewerStarted })
      return
    }
    if (!current.confined && viewerStarted) current.confined = true
  }

  const sourceAccess: SourceAccess = createSourceAccess({
    ctx,
    ownerShares,
    forks,
    relay,
    disposed: () => disposed,
    accessChanged,
    confinedExecution,
  })

  /**
   * The host-side enforcement record for one child: keep its registry entry, follow the share's current
   * ceiling, and re-read both the tool grant and the Relay authority before each execution.
   * @param childSessionId - Recorded fork child to enforce.
   * @param write - Whether the share this child serves may write.
   * @returns The record installed on the child's scope.
   */
  const forkEnforcementHost = (childSessionId: string, write: boolean): ForkEnforcementHost => ({
    forks,
    ...(write ? { write: true } : {}),
    describe: execution => sourceAccess.forkToolPaths(execution),
    authorized: tool => sourceAccess.childToolAuthorized(childSessionId, tool),
    refreshAuthorized: async () => {
      const child = forks.find(childSessionId)
      /* v8 ignore next 2 -- the limit is installed only while this registry holds the child. */
      if (child === undefined) throw new Error('fork-unknown-child')
      await relay.refreshRelayAccess(child.shareId)
    },
  })

  const viewerRead: ViewerReadService = createViewerReadService({
    connection,
    ...(gateway === undefined ? {} : { gateway }),
    sharedSessionId: shareId => ownerShares.get(shareId)?.sessionId,
    forks,
    // The Relay admitted this viewer before the request reached this host, so admission is a fact
    // here; the share's own switch, session, and expiry are what the fork decision reads.
    forkStateOf: shareFactsOf,
    // A grant ends between two requests, so admission is re-read here rather than carried from the
    // request that opened a stream: the same rule the queued-turn re-check applies, read from the same
    // record. A viewer the owner revoked stops reading, and the streams it already opened are closed by
    // the revoke path below.
    viewerStillAdmitted: (shareId, viewer) => {
      const share = ownerShares.get(shareId)
      return share !== undefined && relay.viewerAdmitted(shareId, viewer)
    },
    sourceConfined,
    refreshAdmission: (shareId, signal) => relay.refreshRelayAccess(shareId, signal),
    readAsset: (path, peer) => readViewerAsset(ctx, path, peer),
    writeRefusal: (viewer, action, sessionId, concrete) => readerWriteRefusal(accessFacts, viewer, action, sessionId, concrete),
    accessChanged,
    // The same record the confinement answer reads, so a refusal can say why the layer is missing.
    sourceRefusal: (shareId) => {
      const share = ownerShares.get(shareId)
      /* v8 ignore next -- the refusal is only read for a share this host still publishes. */
      if (share === undefined) return undefined
      return sourceAccess.refusalOf(shareId)
    },
    prepareSource: sessionId => sourceAccess.prepareSourceSession(sessionId, 'prompt'),
    prepareSourceForReader: (shareId) => { sourceAccess.prepareSourceForReader(shareId) },
    // Real child enforcement: it looks up the child's own scoped context, the workspace that child was
    // granted, and the host's filesystem, and refuses to install anything while one is missing — the
    // record it writes is what opens the child's prompt gate.
    // A write-tier share's child gets this host's bounded write; a host that cannot install it refuses
    // the child rather than exposing the deployment's path-based tool under a wider ceiling.
    enforceChild: async (childSessionId, options) =>
      installHostForkEnforcement(ctx, childSessionId, forkEnforcementHost(childSessionId, options?.write === true)),
    debug: process.env.LIVESHARE_VIEWER_DEBUG === '1',
    // Activate a recorded child before its prompt is admitted: resolving it resumes the Session, whose
    // `agent/created` listener installs the child's limit before the activation resolves. An activation
    // that does not lead to an installed limit leaves the gate refusing the child.
    prepareChild: async (childSessionId) => {
      // Refuse a resume this host cannot confine before the agent is announced: an announced child whose
      // limit never lands would be a published Session without the guard it was promised.
      await preflightForkChild(ctx, childSessionId)
      await activateSession(ctx, childSessionId)
      /* v8 ignore next -- the prompt gate reaches this only while the limit is not yet installed. */
      if (forks.enforcementInstalled(childSessionId)) return
      const record = forks.find(childSessionId)
      // A scope that refuses a registration is a fail-closed refusal, not a throw; this carries the error
      // it raised into the refusal the viewer reads.
      const failure: ForkEnforcementFailure = {}
      const dispose = await installHostForkEnforcement(ctx, childSessionId,
        forkEnforcementHost(childSessionId, record !== undefined && relay.drivableModeOf(record.shareId) === 'write'),
        failure)
      if (dispose === undefined) {
        const registration = failure.registration
        throw registration === undefined
          ? new Error('fork execution limits are unavailable')
          : new Error(`fork execution limits are unavailable: ${describeError(registration.error)}`,
            { cause: registration.error })
      }
      ctx.get('agents')?.get(childSessionId as SessionId)?.ctx.effect(() => dispose)
    },
  })

  // A child created in an earlier process is not enforced by anything yet: its guard died with that
  // process. Every entered agent is announced on `agent/created` before creation resolves, and a child
  // this host recorded gets its limit installed there — refusing the announcement when that cannot be
  // done, so a resumed fork is never published without the limit it was promised. A session this host
  // never recorded as a fork returns here untouched, and a revoked child refuses rather than being
  // revived. AgentLoop holds the agent's queued input until every listener settles and a throw fails
  // creation, so a refused limit still prevents the agent from ever being prompted.
  ctx.on('agent/created', async ({ agent }) => {
    const childSessionId = String(agent.id)
    // A shared Session is the other case this listener covers: it must carry the layer that confines an
    // externally driven turn before it is published, and a resumed one reaches this listener with its own
    // scope. A Session no published share names installs nothing here.
    const published = [...ownerShares.values()].find(candidate => candidate.sessionId === childSessionId)
    const arriving = agent.session
    if (published !== undefined) {
      await sourceAccess.apply(published, { context: agent.ctx, session: arriving }, 'publish')
    }
    const record = forks.find(childSessionId)
    if (record === undefined) return
    if (record.revokedAt !== undefined) {
      throw new Error(`fork ${childSessionId} came from a share that is no longer active`)
    }
    // The ceiling follows the share the child came from, read from what this host publishes now: a share
    // this host no longer publishes, or one whose mode it cannot read, installs nothing wider than
    // reading, so a resumed child never comes back with more than its share still allows.
    const share = ownerShares.get(record.shareId)
    const dispose = await installHostForkEnforcement(ctx, childSessionId,
      forkEnforcementHost(childSessionId, share !== undefined && relay.drivableModeOf(share.shareId) === 'write'))
    if (dispose === undefined) {
      throw new Error(`fork ${childSessionId} could not be given read-only limits`)
    }
    // The limit lives exactly as long as the agent that carries it.
    agent.ctx.effect(() => dispose)
  })

  /** Admission belongs to this share's source or this actor's recorded fork, never another Session. */
  const externalTargetAllowed = (sessionId: string, origin: { shareId: string; actor: ShareRpcActor }): boolean => {
    const share = ownerShares.get(origin.shareId)
    if (share === undefined || !relay.viewerAdmitted(origin.shareId, origin.actor)) return false
    // Both tiers drive the shared Session; what the tier permits is decided per tool by the confined
    // layer, which refuses the write name for a view-tier turn.
    if (sessionId === share.sessionId) return relay.drivableModeOf(origin.shareId) !== undefined
    const child = forks.find(sessionId)
    return child !== undefined && child.shareId === origin.shareId
      && identityKeyOf(child.creator) === identityKeyOf(origin.actor)
      && sourceAccess.childToolAuthorized(sessionId, 'read')
  }

  // A reader's input is re-checked here rather than before it entered the queue: the step about to run
  // reads the viewer from each entering message's own source, so input admitted under a grant that ended
  // since is refused before it reaches the model. A shared Session's own turns are not attributed, so the
  // sandbox on the Session — not this admission check — is what confines them.
  ctx.on('agent/pre-step', async ({ agent, signal, turn }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const child = forks.find(agent.session.id)
    const requests = decision.messages.flatMap((message) => {
      if (message.source.kind !== 'user' || !('principal' in message.source)) return []
      const viewer = shareViewerOf(message.source.principal)
      return viewer === undefined ? [] : [viewer]
    })
    const shareIds = new Set(requests.map(origin => origin.shareId))
    if (child !== undefined) shareIds.add(child.shareId)
    try {
      for (const shareId of shareIds) await relay.refreshRelayAccess(shareId, signal)
    } catch (_error) {
      // Missing authoritative admission refuses queued input without entering a model step.
      return { kind: 'reject' }
    }
    if (child !== undefined && !sourceAccess.childToolAuthorized(child.childSessionId, 'read')) return { kind: 'reject' }
    if (requests.some(origin => !externalTargetAllowed(agent.session.id, origin))) return { kind: 'reject' }
    noteViewerTurn(String(agent.session.id), turn, requests.length > 0)
    return decision
  })

  /**
   * Access layers this host installed, keyed by the SESSION they constrain.
   *
   * One Session may be shared by several shares at either tier, and its layer belongs to the Session
   * rather than to any one share: installing a second one would collide on the tool names, and removing
   * a share must not take away the constraint another share still needs. The layer is write-capable when
   * any share over that Session is, and each execution is judged against the tier of its own share.
   */
  /** Owner authorizations this host began and is waiting to redeem. */
  const ownerAuthorizations = new OwnerAuthorizations()
  const persistOwnerState = (): Promise<void> =>
    writeOwnerState(ownerStateFile, relayOverride, ownerState.instanceId, ownerShares, pendingRemovals)

  // A restored share keeps its own deadline, so the cancel that stops its running turn when the deadline
  // passes is armed again from the record rather than remembered anywhere else.
  for (const share of ownerShares.values()) tunnel.scheduleShareExpiry(share)
  // A host that starts with write-mode shares installs their access layers before serving any request for
  // them, so a restored share is never briefly writable without the layer that judges its turns.
  void Promise.all([...ownerShares.values()].map(share => sourceAccess.apply(share, undefined, 'restore')))
  // Reconnecting a share, refreshing its title, and probing or claiming at the Relay all need an address
  // the owner saved. A host that has none still serves the sharing surfaces and stops its shares' turns
  // on their deadlines, but contacts no Relay: there is no address to ask, and the dialog states that.
  if (effectiveRelay !== undefined) {
    for (const share of ownerShares.values()) tunnel.send({ type: 'add-share', share: tunnel.shareSpec(share, storedCredential) })
    // The shares this profile reconnected with keep their recorded titles until the title folds answer,
    // so the refresh runs beside mounting rather than holding it up.
    void tunnel.reconcileShareTitles()
    // A host that starts with a stored credential re-binds its surviving shares to that identity, so
    // an owner does not have to re-create links that predate identity binding. It presents the stored
    // token even when its signed expiry has passed, because the Relay judges it against the login it
    // renews and answers with the horizon that applies.
    const startupRelay = normalizeRelayUrl(effectiveRelay)
    const startupCredential = storedCredential
    void tunnel.claimOwnedShares(startupRelay, tunnel.claimableCredentialForRelay(startupRelay))
      .then((outcome) => {
        // A pass whose credential was replaced, or whose token the Relay made this host re-adopt with a
        // new horizon, still describes the credential in hand; a different token does not.
        /* v8 ignore start -- only a concurrent owner action replaces the credential; a stale claim answers nothing. */
        if (!disposed && storedCredential?.credential === startupCredential?.credential) {
          tunnel.factsFor(startupRelay).claim = outcome
        }
        /* v8 ignore stop */
      })
      /* v8 ignore start -- a claim pass that cannot run leaves shares unclaimed; a later pass retries. */
      .catch(() => { /* a claim pass that cannot run leaves shares unclaimed; a later pass retries */ })
      /* v8 ignore stop */
    void tunnel.probeRelayCredentialSupport(startupRelay)
  }

  /**
   * Read the address the owner saved and the address new shares publish to, which are the same value.
   * @returns Relay state shared by the owner UI; both fields are absent while no address is saved.
   */
  const relayState = (): OwnerRelayState =>
    relayOverride === undefined ? {} : { override: relayOverride, effective: relayOverride }

  const selectRelayAddress = (override: string | undefined): void => {
    relayOverride = override
    effectiveRelay = override
  }
  const operations = createOwnerShareOperations({
    ownerShares,
    pendingRemovals,
    allowedSubjectIds,
    forks,
    viewerRead,
    viewerDeclarations,
    relay,
    tunnel,
    effectiveRelay: () => effectiveRelay,
    relayState,
    selectRelayAddress,
    bumpRelayRevision: () => { relayRevision += 1 },
    storedCredential: () => storedCredential,
    persistOwnerState,
    applySourceAccess: (share, ready, trigger) => sourceAccess.apply(share, ready, trigger),
    sourceConfined,
    accessChanged,
    cancelShareTurn: (shareId) => { sourceAccess.cancelShareTurn(shareId) },
    cancelChildTurns: (shareId, viewer) => { sourceAccess.cancelChildTurns(shareId, viewer) },
    reconcileSourceAccess: (sessionId) => { sourceAccess.reconcileSessionAccess(sessionId) },
  })
  new LiveshareShares(ctx, operations)
  registerOwnerHttpRoutes({
    connection,
    tunnel,
    captureOwnerOperation,
    ownerOperationCurrent,
    ownerAuthorizations,
    ownerCredentialFile,
    storedCredential: () => storedCredential,
    setStoredCredential: (credential) => { storedCredential = credential },
    disposed: () => disposed,
  })

  // One attempt at startup: a host that restarted with rows still owed delivers them as soon as it can.
  void tunnel.flushPendingRemovals()

  return async () => {
    for (const shareId of ownerShares.keys()) {
      sourceAccess.cancelShareTurn(shareId)
      sourceAccess.cancelChildTurns(shareId)
    }
    disposed = true
    await tunnel.dispose(() => { viewerRead.close() })
  }
}

function defaultOwnerStateFile(): string {
  const dshHome = nonEmpty(process.env.DSH_HOME) ?? join(homedir(), '.dsh')
  return join(dshHome, 'liveshare', 'owner-shares.json')
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * Read one caught value's message for the refusal this host throws.
 * @param error - Value a dependency threw.
 * @returns The error's message, or the value's own string form.
 */
function describeError(error: unknown): string {
  /* v8 ignore next -- tool registries reject with Error instances; the string form is defensive. */
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the owner identity this host registers with, from the config fields.
 * @param config - Host config that may name a provider, tenant, subject, and display name.
 * @returns The identity, or undefined when no field names one.
 */
function ownerIdentityFromConfig(config: Config): IdentityActor | undefined {
  const providerId = nonEmpty(config.ownerIdentityProvider)
  const tenantId = nonEmpty(config.ownerIdentityTenant)
  const subjectId = nonEmpty(config.ownerIdentitySubject)
  if (providerId === undefined && tenantId === undefined && subjectId === undefined) return undefined
  if (providerId === undefined || tenantId === undefined || subjectId === undefined) {
    throw new Error('liveshare-share-host: ownerIdentity fields require provider, tenant, and subject')
  }
  return {
    providerId,
    tenantId,
    subjectId,
    displayName: nonEmpty(config.ownerIdentityDisplayName) ?? subjectId,
  }
}

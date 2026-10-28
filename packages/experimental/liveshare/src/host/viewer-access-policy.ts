/**
 * Remote access policy deciding what one share reader may call on this owner Host.
 *
 * The Gateway decides every call that speaks for a `share-viewer` Peer, and every Session notification it
 * forwards to one, from the bindings this policy lists; the Session and Workspace controllers filter list
 * results through the same bindings, and every reader page opens with the snapshot computed from them. A
 * served reader holds the global read role, read roles on the shared Session and on the forks it created
 * through the same share, and the Workspace role on each Workspace holding one of those Sessions; it holds
 * nothing while the share does not serve it. Attachment upload rides the read role, so every Session the
 * reader can see is a Session it may attach files to. Conditions on the fork and write roles, and the
 * policy's `explain`, give the refusal codes the reader page already classifies.
 *
 * Every rule reads in-memory share state synchronously. Work that needs an await (Relay refresh,
 * activating a cold Session, fork identity and replay) stays in the viewer reader before dispatch, which
 * reads the same write rules through {@link readerWriteRefusal}.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-access-policy
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  RemoteAccessAction,
  RemoteAccessBinding,
  RemoteAccessCondition,
  RemoteAccessDecision,
  RemoteAccessEndpoint,
  RemoteAccessPolicy,
  RemoteAccessRequest,
  RemoteAccessResourceKind,
  RemoteAccessRole,
} from '@deepseek-ai/dsh-api-remote-access/types'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import {
  VIEWER_ENDPOINT_CLASSES,
  VIEWER_FORWARDED_EVENTS,
  assertSameViewerActions,
  readerPolicyEndpoints,
} from '../endpoint-classification.ts'
import { VIEWER_READ_ONLY_CODE } from '../viewer-channel.ts'
import type { ForkRecord, ForkRegistry } from './fork-registry.ts'
import { isExpired, type ForkShareState, type ViewerSessionMode } from './fork-policy.ts'
import type { ViewerCapabilityGroup } from './viewer-declarations.ts'
import type { ShareViewerPrincipal } from './viewer-principal.ts'

/** The two write actions a reader may take on a Session. */
export type ReaderWriteAction = 'session/prompt' | 'session/cancel'

/** Share state this policy reads, all synchronous and held in memory by the share host. */
export interface ViewerAccessFacts {
  /**
   * Share state as the owner host holds it.
   * @param shareId - Share the reader's calls arrive through.
   * @returns The state, with `sessionMode` already narrowed to what may still be driven; undefined when
   *   this host publishes no such share.
   */
  readonly share: (shareId: string) => ForkShareState | undefined
  /**
   * Whether the Relay authority this host holds still admits one reader.
   * @param shareId - Share the reader belongs to.
   * @param actor - Reader identity.
   * @returns True while admitted.
   */
  readonly viewerAdmitted: (shareId: string, actor: ShareRpcActor) => boolean
  /**
   * Whether the share's source Session carries a usable confined access layer.
   * @param shareId - Share whose source Session is asked about.
   * @returns True only while the layer is installed and confined.
   */
  readonly sourceConfined: (shareId: string) => boolean
  /** Forks this host created, and the per-child prompt decision. */
  readonly forks: Pick<ForkRegistry, 'find' | 'listForShare' | 'allowsPrompt'>
  /**
   * Workspaces this host holds, when the composition mounts the Workspace registry.
   * @returns Workspaces in registry order.
   */
  readonly workspaces: () => readonly Pick<Workspace, 'id' | 'sessionIds'>[]
  /**
   * The endpoints plugins currently offer for share viewers, grouped by declaring plugin.
   *
   * Read on every binding computation and never captured, so a declaration and its disposal decide the
   * reader's next call. This is an offer, not a grant: the share's own selection decides what it exposes.
   * @returns The declared endpoints, empty when no plugin declares any.
   */
  readonly declaredCapabilities: () => readonly ViewerCapabilityGroup[]
}

/** What a condition on a Session binding receives. */
type SessionConditionRequest = Parameters<RemoteAccessCondition<'session'>>[0]

/** Why a share no longer serves one reader; the codes the reader page already classifies. */
type ViewerShareRefusal = 'share-not-found' | 'share-stopped' | 'share-expired' | 'viewer-not-authorized'

/** Global reads every served reader may call. */
const VIEWER_GLOBAL_ROLE: RemoteAccessRole<'global'> = {
  name: 'liveshare:viewer-global',
  resource: 'global',
  actions: [
    'commands/list',
    'llm/listConfigurableProviders',
    'llm/listProviders',
    'session/canOpenWorkspacePath',
    'session/control',
    'session/list',
    'session/modelCatalog',
    'workspace/follow',
  ],
}

/**
 * Reads of one Session the reader can see, the Session notifications forwarded about it, and attachment
 * upload.
 *
 * The role binds every Session this share serves the reader — the shared source and each of its own
 * forks — so attachment upload follows visibility alone: neither the tier nor the fork switch decides it.
 */
const VIEWER_SESSION_READ_ROLE: RemoteAccessRole<'session'> = {
  name: 'liveshare:viewer-session-read',
  resource: 'session',
  actions: [
    'commands/list',
    'fileUploads/upload',
    'goals/get',
    'session/attachment',
    'session/control',
    'session/events',
    'session/follow',
    'session/list',
    'session/observeEvent',
    'session/observeProjections',
    'session/observeState',
    'session/page',
    'session/projections',
    'session/state',
    'session/wait',
    'skills/list',
    'toolResults/watch',
    'workspace/follow',
    'event:api-session/activity',
    'event:api-session/added',
    'event:api-session/error',
    'event:api-session/removed',
    'event:api-session/status',
  ],
}

/**
 * Forking the shared Session and every fork the reader can see.
 *
 * One role carries the whole fork decision: the owner's `allowsFork` switch decides it, and the source
 * Session and each visible child get the same binding, so a child a reader may see is a child it may
 * fork again on the same terms.
 */
const VIEWER_FORK_ROLE: RemoteAccessRole<'session'> = {
  name: 'liveshare:viewer-fork',
  resource: 'session',
  actions: ['session/fork'],
}

/** Prompting and stopping the shared Session. */
const VIEWER_SOURCE_WRITE_ROLE: RemoteAccessRole<'session'> = {
  name: 'liveshare:viewer-source-write',
  resource: 'session',
  actions: ['session/prompt', 'session/cancel'],
}

/**
 * Prompting, stopping, and renaming one of the reader's own visible forks.
 *
 * This role binds only a forked child, never the source Session: only a child can be renamed, so the
 * shared Session keeps `session/fork` as its one Session verb and a reader cannot rename the owner's
 * Session through the policy. The role carries no share switch of its own; a revoked fork stays readable
 * through the read role and carries no action of this one.
 */
const VIEWER_CHILD_ROLE: RemoteAccessRole<'session'> = {
  name: 'liveshare:viewer-child',
  resource: 'session',
  actions: ['session/prompt', 'session/cancel', 'session/rename'],
}

/** Following one Workspace that holds a Session the reader can see. */
const VIEWER_WORKSPACE_ROLE: RemoteAccessRole<'workspace'> = {
  name: 'liveshare:viewer-workspace',
  resource: 'workspace',
  actions: ['workspace/follow'],
}

/** Every role this policy binds; the derived action set must name exactly their union. */
const VIEWER_ROLES = [
  VIEWER_GLOBAL_ROLE,
  VIEWER_SESSION_READ_ROLE,
  VIEWER_FORK_ROLE,
  VIEWER_SOURCE_WRITE_ROLE,
  VIEWER_CHILD_ROLE,
  VIEWER_WORKSPACE_ROLE,
] as const

/**
 * Every action this policy's own roles decide, derived from the endpoint classification table.
 *
 * A plugin capability adds only endpoints the share policy does not decide itself: the read, fork, and
 * write roles keep their conditions and their modes for the actions they list, so offering and selecting
 * `session/prompt`, `session/cancel`, `session/fork`, or `fileUploads/upload` cannot replace the decision
 * the policy's own roles make. This is not a whitelist: an endpoint no role lists stays refused until a
 * plugin offers it and the owner selects it.
 *
 * The table is the single source: `reader-*` entries plus the forwarded events reproduce exactly the
 * actions the roles list. The load-time assertion below fails loudly if either side drifts, so a
 * classification edit can never silently change what a reader may call.
 */
export const POLICY_DECIDED_ACTIONS: ReadonlySet<RemoteAccessAction> = new Set<RemoteAccessAction>([
  ...readerPolicyEndpoints(VIEWER_ENDPOINT_CLASSES),
  ...VIEWER_FORWARDED_EVENTS,
])
assertSameViewerActions(
  POLICY_DECIDED_ACTIONS,
  VIEWER_ROLES.flatMap(role => [...role.actions]),
  'POLICY_DECIDED_ACTIONS',
)

/**
 * The endpoints one share may expose: offered by a plugin, selected by its owner, and not already decided
 * by this policy.
 *
 * The share's own selection is the grant and the plugin offer is the capability: an endpoint reaches the
 * reader only when both name it for the same plugin, so withdrawing either one withdraws access on the
 * next decision. Selecting an endpoint a plugin no longer offers therefore grants nothing.
 * @param offered - Endpoints plugins currently offer, grouped by declaring plugin.
 * @param selected - Endpoints this share's owner selected, grouped the same way.
 * @param kind - Endpoint kind to expose.
 * @returns The actions this share may expose, in a stable order.
 */
function exposedCapabilities(
  offered: readonly ViewerCapabilityGroup[],
  selected: readonly ViewerCapabilityGroup[],
  kind: 'readable' | 'writable',
): RemoteAccessEndpoint[] {
  const chosen = new Map(selected.map(group => [group.plugin, new Set<string>(group[kind])]))
  const exposed = new Set<RemoteAccessEndpoint>()
  for (const group of offered) {
    const chosenByOwner = chosen.get(group.plugin)
    if (chosenByOwner === undefined) continue
    for (const action of group[kind]) {
      if (chosenByOwner.has(action) && !POLICY_DECIDED_ACTIONS.has(action)) exposed.add(action)
    }
  }
  return [...exposed].sort()
}

/**
 * The role one declaration kind binds over one resource kind.
 * @param name - Role name, for diagnostics.
 * @param resource - Resource kind the role binds over.
 * @param actions - Exposed endpoints the policy does not decide.
 * @returns The role to bind on the resources the reader can see or write.
 */
function declarationRole<K extends RemoteAccessResourceKind>(
  name: string,
  resource: K,
  actions: readonly RemoteAccessAction[],
): RemoteAccessRole<K> {
  return { name, resource, actions }
}

const ALLOW: RemoteAccessDecision = Object.freeze({ kind: 'allow' })

function answer(reason: string | undefined): RemoteAccessDecision {
  return reason === undefined ? ALLOW : { kind: 'deny', reason }
}

/**
 * The share one reader's call is decided against, or why it no longer serves that reader.
 * @param facts - Share state the policy reads.
 * @param shareId - Share the reader's calls arrive through.
 * @param actor - Reader identity.
 * @returns The serving share state, or the refusal, checked in the order the reader page reports them.
 */
function servingShare(
  facts: Pick<ViewerAccessFacts, 'share' | 'viewerAdmitted'>,
  shareId: string,
  actor: ShareRpcActor,
): { readonly share: ForkShareState } | { readonly refusal: ViewerShareRefusal } {
  const share = facts.share(shareId)
  if (share === undefined) return { refusal: 'share-not-found' }
  if (share.stopped) return { refusal: 'share-stopped' }
  if (isExpired(share.expiresAt, Date.now())) return { refusal: 'share-expired' }
  return facts.viewerAdmitted(shareId, actor) ? { share } : { refusal: 'viewer-not-authorized' }
}

/**
 * Why a reader may not write to the share at all, whatever action names the write.
 *
 * This is the whole share-level write decision: the tier the owner set, and the confined access layer a
 * write needs. The policy's writable declarations share it, so a declaration can neither add a tier nor
 * change a refusal code.
 * @param mode - The share's drivable tier, absent while this host cannot establish one.
 * @param confined - Whether the source Session carries a usable confined access layer.
 * @returns The refusal code, or undefined when the share permits writes.
 */
function shareWriteRefusal(mode: ViewerSessionMode | undefined, confined: boolean): string | undefined {
  if (mode !== 'write') return 'share-not-writable'
  return confined ? undefined : 'source-write-unavailable'
}

/**
 * Why a reader may not prompt or stop the shared Session.
 *
 * Both tiers drive the shared Session, so the tier decides nothing beyond whether this host established
 * one at all: what a reader needs is the confined access layer that keeps its turn inside the granted
 * workspace, and a share whose tier this host cannot establish is not driven. Prompt and cancel share the
 * rule because both are dispatched to the owner's own Session controller, whose cancel stops whatever turn
 * the Session is running.
 * @param mode - The share's drivable tier, absent while this host cannot establish one.
 * @param confined - Whether the source Session carries a usable confined access layer.
 * @returns The refusal code, or undefined when allowed.
 */
function sourceWriteRefusal(
  mode: ViewerSessionMode | undefined,
  confined: boolean,
): string | undefined {
  return mode === undefined || !confined ? 'source-write-unavailable' : undefined
}

/**
 * Why a reader may not prompt or stop one of its own forks.
 *
 * Only a concrete prompt needs the child's installed ceiling: a cold child gets it when the reader's first
 * prompt prepares it, so the snapshot keeps that child's composer available. The share's tier decides
 * nothing here: a child runs under its own read-only ceiling and a write-tier child under this host's
 * bounded write, so a view-tier viewer still drives the child it was allowed to create.
 * @param child - The reader's fork record.
 * @param action - A write action of the child write role.
 * @param concrete - True for a concrete call, false for the snapshot answer.
 * @param allowsPrompt - The fork registry's prompt decision for that child and reader.
 * @returns The refusal code, or undefined when allowed.
 */
function childWriteRefusal(
  child: ForkRecord,
  action: RemoteAccessAction,
  concrete: boolean,
  allowsPrompt: () => ReturnType<ForkRegistry['allowsPrompt']>,
): string | undefined {
  if (child.revokedAt !== undefined) return 'fork-source-revoked'
  if (action !== 'session/prompt' || !concrete) return undefined
  const decision = allowsPrompt()
  return decision.ok ? undefined : decision.code
}

/**
 * The tier a share may be driven with, absent while this host cannot establish one.
 *
 * An absent tier is not `view`: a share this host cannot place is not driven at all, so every driving
 * decision refuses it rather than offering a reach nobody established.
 * @param share - The serving share state.
 * @returns The drivable tier, or undefined.
 */
function drivableMode(share: ForkShareState): ViewerSessionMode | undefined {
  return share.sessionMode
}

/**
 * The reader's own fork of this share one Session is, revoked or not.
 * @param facts - Share state the policy reads.
 * @param viewer - The reader.
 * @param sessionId - Session to look up.
 * @returns The fork record, or undefined when the Session is not a fork this reader created through this share.
 */
function ownFork(
  facts: Pick<ViewerAccessFacts, 'forks'>,
  viewer: ShareViewerPrincipal,
  sessionId: string,
): ForkRecord | undefined {
  const child = facts.forks.find(sessionId)
  return child?.shareId === viewer.shareId && identityKeyOf(child.creator) === identityKeyOf(viewer.actor)
    ? child
    : undefined
}

/**
 * Why a write names a Session that is neither the shared one nor one of the reader's own forks.
 * @param facts - Share state the policy reads.
 * @param viewer - The reader.
 * @param sessionId - Session the write names.
 * @returns `fork-viewer-mismatch` for another reader's fork of this share, otherwise `fork-unknown-child`.
 */
function foreignWriteRefusal(
  facts: Pick<ViewerAccessFacts, 'forks'>,
  viewer: ShareViewerPrincipal,
  sessionId: string,
): 'fork-unknown-child' | 'fork-viewer-mismatch' {
  return facts.forks.find(sessionId)?.shareId === viewer.shareId ? 'fork-viewer-mismatch' : 'fork-unknown-child'
}

/**
 * The refusal code of one reader prompt or cancel, by the rules the policy's write bindings apply.
 *
 * The viewer reader reads this before it prepares or dispatches a write, so that a refusal keeps the
 * page's code and a refused write prepares nothing. The Gateway decides every dispatched call again from
 * the policy.
 * @param facts - Share state the policy reads.
 * @param viewer - The reader.
 * @param action - The write action.
 * @param sessionId - Session the write names.
 * @param concrete - True for a concrete call, false for the snapshot answer.
 * @returns The refusal code, or undefined when the policy allows the write.
 */
export function readerWriteRefusal(
  facts: ViewerAccessFacts,
  viewer: ShareViewerPrincipal,
  action: ReaderWriteAction,
  sessionId: string,
  concrete: boolean,
): string | undefined {
  const serving = servingShare(facts, viewer.shareId, viewer.actor)
  if ('refusal' in serving) return serving.refusal
  const mode = drivableMode(serving.share)
  if (sessionId === serving.share.sessionId) {
    return sourceWriteRefusal(mode, facts.sourceConfined(viewer.shareId))
  }
  const child = ownFork(facts, viewer, sessionId)
  if (child === undefined) return foreignWriteRefusal(facts, viewer, sessionId)
  return childWriteRefusal(child, action, concrete, () => facts.forks.allowsPrompt(sessionId, viewer.actor))
}

/**
 * Why no binding allows one reader request: the share's refusal, the fork or write target's refusal,
 * or read-only.
 *
 * The shared Session and every own fork carry bindings whose conditions name their own refusals, so a
 * fork or write refused here names some other Session.
 * @param facts - Share state the policy reads.
 * @param request - The refused request.
 * @returns The refusal code the reader page classifies.
 */
function explainReaderRefusal(facts: ViewerAccessFacts, request: RemoteAccessRequest<ShareViewerPrincipal>): string {
  const viewer = request.principal
  const serving = servingShare(facts, viewer.shareId, viewer.actor)
  if ('refusal' in serving) return serving.refusal
  for (const resource of request.resources) {
    if (resource.kind !== 'session' || resource.id === serving.share.sessionId) continue
    if (request.action === 'session/fork') return 'source-session-mismatch'
    if (request.action === 'session/prompt' || request.action === 'session/cancel') {
      return foreignWriteRefusal(facts, viewer, resource.id)
    }
  }
  return VIEWER_READ_ONLY_CODE
}

/**
 * Build the `share-viewer` policy for this host's shares.
 * @param facts - Share state the rules read.
 * @returns The policy the share host registers for the `share-viewer` principal kind.
 */
export function createViewerAccessPolicy(facts: ViewerAccessFacts): RemoteAccessPolicy<ShareViewerPrincipal> {
  return {
    bindings(viewer): readonly RemoteAccessBinding[] {
      const serving = servingShare(facts, viewer.shareId, viewer.actor)
      if ('refusal' in serving) return []
      const { share } = serving
      const mode = drivableMode(share)
      const source = SessionId(share.sessionId)
      // Revoked forks stay bound for reading, so the reader's snapshot states them as read-only.
      const children = facts.forks.listForShare(viewer.shareId)
        .filter(child => identityKeyOf(child.creator) === identityKeyOf(viewer.actor))
      const visible = new Set<string>([share.sessionId, ...children.map(child => child.childSessionId)])
      /** Workspaces holding a Session the reader can see; only those may carry a declaration. */
      const memberWorkspaces: Workspace['id'][] = []
      const bindings: RemoteAccessBinding[] = [
        { role: VIEWER_GLOBAL_ROLE, resource: { kind: 'global' } },
        { role: VIEWER_SESSION_READ_ROLE, resource: { kind: 'session', id: source } },
        {
          role: VIEWER_FORK_ROLE,
          resource: { kind: 'session', id: source },
          condition: () => answer(share.allowsFork ? undefined : 'fork-not-permitted'),
        },
        {
          role: VIEWER_SOURCE_WRITE_ROLE,
          resource: { kind: 'session', id: source },
          condition: () => answer(sourceWriteRefusal(mode, facts.sourceConfined(viewer.shareId))),
        },
      ]
      for (const child of children) {
        const id = SessionId(child.childSessionId)
        bindings.push(
          { role: VIEWER_SESSION_READ_ROLE, resource: { kind: 'session', id } },
          {
            role: VIEWER_FORK_ROLE,
            resource: { kind: 'session', id },
            // A revoked fork stays readable and nothing else, and a child's fork verb follows the same
            // owner switch the shared Session's fork does.
            condition: () => answer(
              child.revokedAt !== undefined
                ? 'fork-source-revoked'
                : share.allowsFork ? undefined : 'fork-not-permitted',
            ),
          },
          {
            role: VIEWER_CHILD_ROLE,
            resource: { kind: 'session', id },
            condition: ({ action, args }: SessionConditionRequest) => answer(childWriteRefusal(
              child, action, args !== undefined, () => facts.forks.allowsPrompt(child.childSessionId, viewer.actor),
            )),
          },
        )
      }
      for (const workspace of facts.workspaces()) {
        if (workspace.sessionIds.some(id => visible.has(id))) {
          memberWorkspaces.push(workspace.id)
          bindings.push({ role: VIEWER_WORKSPACE_ROLE, resource: { kind: 'workspace', id: workspace.id } })
        }
      }
      // Exposed capabilities ride the resources the reader can already see, and they are appended after
      // every binding above, so a share that exposes none keeps its previous binding order byte for byte.
      // Both sides are read here, on every computation: the plugins' offer and this share's own selection,
      // so either withdrawing its name decides the reader's next call while an open snapshot recomputes.
      const offered = facts.declaredCapabilities()
      const selected = share.viewerCapabilities ?? []
      const readable = exposedCapabilities(offered, selected, 'readable')
      if (readable.length > 0) {
        bindings.push(
          { role: declarationRole('liveshare:viewer-readable-global', 'global', readable), resource: { kind: 'global' } },
        )
        for (const id of [source, ...children.map(child => SessionId(child.childSessionId))]) {
          bindings.push({ role: declarationRole('liveshare:viewer-readable-session', 'session', readable),
            resource: { kind: 'session', id } })
        }
        for (const id of memberWorkspaces) {
          bindings.push({ role: declarationRole('liveshare:viewer-readable-workspace', 'workspace', readable),
            resource: { kind: 'workspace', id } })
        }
      }
      // A writable capability is the one that changes the owner's machine, and the owner states consent
      // for writes only through the share's session mode. Every binding therefore carries the same
      // decision the source write role applies, so no offer and no selection can turn a read-only share
      // into a writable one; a revoked fork stays read-only and carries none.
      const writable = exposedCapabilities(offered, selected, 'writable')
      if (writable.length > 0) {
        const condition = (): RemoteAccessDecision =>
          answer(shareWriteRefusal(mode, facts.sourceConfined(viewer.shareId)))
        bindings.push(
          { role: declarationRole('liveshare:viewer-writable-global', 'global', writable),
            resource: { kind: 'global' }, condition },
          { role: declarationRole('liveshare:viewer-writable-session', 'session', writable),
            resource: { kind: 'session', id: source }, condition },
        )
        for (const child of children) {
          if (child.revokedAt === undefined) {
            bindings.push({ role: declarationRole('liveshare:viewer-writable-session', 'session', writable),
              resource: { kind: 'session', id: SessionId(child.childSessionId) }, condition })
          }
        }
        for (const id of memberWorkspaces) {
          bindings.push({ role: declarationRole('liveshare:viewer-writable-workspace', 'workspace', writable),
            resource: { kind: 'workspace', id }, condition })
        }
      }
      return bindings
    },
    explain: request => explainReaderRefusal(facts, request),
  }
}

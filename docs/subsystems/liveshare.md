# LiveShare

English | [中文](liveshare.zh.md)

The opt-in LiveShare bundle (`@deepseek-ai/dsh-experimental-liveshare`) lets one owner share a single Session with an external viewer through the separate Liveshare server. A viewer never receives the owner's tools: the owner host reads each viewer request itself, dispatches it as that viewer's own Peer, whose `share-viewer` principal the Gateway decides through the [remote access](../../packages/api/remote-access/README.md) policy this package registers, and constrains everything a shared Session runs on the viewer's behalf to the workspace the share granted. The [package README](../../packages/experimental/liveshare/README.md) owns configuration, the client faces, and the limitations; the [Owner note](../../.agents/notes/implemented/feature/2026-09-13-liveshare-protocol-and-owner-surfaces.md) owns the security posture behind them.

Source: [`packages/experimental/liveshare/src/host/fork-enforcement.ts`](../../packages/experimental/liveshare/src/host/fork-enforcement.ts)

<a id="enabling-and-visibility"></a>

## Enabling and visibility

The package ships with dsh but stays out of the plugin manager's lists until a profile enables it. A profile either inserts the two rows the bundle declares into its own `cordis.patch.yml`, which keeps the bundle unselected while its plugins run, or selects the bundle in `dsh.profile.bundles`. The [package README](../../packages/experimental/liveshare/README.md#default-visibility-and-enabling) owns the exact entries and the placeholders a deployment replaces.

The plugin manager lists the card under **Experimental plugins** only while at least one row the bundle declares runs, and removing the rows, disabling them, or deselecting the bundle takes it out of both that list and **More** again. Both routes apply on the profile's next recomposition rather than mid-task: with HMR enabled the profile is re-read, and without it the change waits for the next start.

## Share modes

`ViewerSessionMode` has two tiers, and both name a sandbox: `view` reads the shared Session and drives its loop inside a read-only sandbox in the granted workspace, so it never writes a file; it may use the read and search surface (`read`, `read_image`, `glob`, `grep`, `present`) and the tools with no local file effect (`todo_write`, `skill`, `web_search`, `web_fetch`), with every declared path checked against the grant. `write` runs in a bounded writable sandbox that also modifies files inside that workspace by adding bounded `edit` and `write`, under the Host's write ceiling. Forking is not a tier: the share carries its own `allowsFork` switch, independent of the tier. Attachment upload is not a tier either: every Session a share serves the reader accepts files, whatever the tier and the fork switch. The withdrawn `fork-readonly` name is not read back as `view`: a persisted owner record that names it is rejected when the owner state loads. Nothing infers `write`, and a share whose mode the host cannot establish stays readable but is never driven.

## Forks and their ceiling

A fork creates a new Session the viewer owns and leaves the source untouched. Fork authorization checks the share, its fork switch, expiry, viewer admission, source identity, and the requested boundary. `READ_ONLY_FORK_CEILING` permits the view surface — `read`, `read_image`, `glob`, `grep`, `present`, `todo_write`, `skill`, `web_search`, `web_fetch` — and `WRITE_FORK_CEILING` adds the Host’s bounded `edit` and `write`. Each path-bearing tool gets a confined replacement that resolves every declared path against the granted root and delegates with its canonical form; `bash`, `pwsh`, `cua`, `plugin_manager`, the `schedule_*` tools, and every name the surface does not list are refused.

Each child is recorded with the share that authorized it, the trusted viewer the Liveshare server asserted, and the boundary it started from, so a viewer's list shows only its own children and a removed share stops them. A child is driven only after its ceiling is installed on its own scope: `ForkRegistry` refuses every prompt for a child whose guard is not installed (`fork-ceiling-uninstalled`), and installation is verified per child rather than per host. A child whose scope refuses the confined replacement or the limit is refused instead of being published with the deployment's own tools.

Cold source and child activation uses the Host’s ordinary Agent lookup, not a Remote `session/prepare` endpoint. Serial `agent/created` listeners install scoped enforcement before queued work is released; an already live Agent needs its own installation check. `forkLineage` is a LiveShare-owned, per-viewer UI projection, not a Session-summary field, durable log event, or permission grant.

## Retries, recovery, and revocation

One logical fork request may be sent more than once. Its identity binds the trusted viewer, the share, the source, and the caller's operation id; the boundary is compared against that identity rather than folded into it, so a retry repeats the child it already produced, an identity naming another boundary conflicts instead of silently receiving the earlier child, and the reservation is durable before any child exists. The host records the child the owner's fork answer returned, and a retry of a recorded operation replays that answer. The owner's `SessionForkRequest` mints the child id, so a host that dies between creating the child and recording it cannot name that child on retry and creates a second one; closing that window needs a Session Controller request that accepts a caller-supplied child identity.

Child tool guards recheck the share’s current mode, expiry, viewer admission, and revocation record. Viewer withdrawal cancels affected child work and pending calls. A `write` to `view` downgrade denies later writes through the write guard without granting any new tool, and does not promise immediate cancellation of a running turn. Removing a share revokes recorded children and stops the Session's running turn; the source enforcement layer is released once no share over the Session is left, and with Agent disposal. Revoked children retain their logs, and the source’s owner-visible history is never rewritten.

## Constraining a shared Session

Every share lets its viewer drive the *source* Session through the normal prompt path, and any share at either tier installs the bounded sandbox while it is active. `installSourceSessionAccess` registers a confined replacement for every view-surface tool the deployment ships in that Session's own scope, and bounded `edit` and `write` replacements whenever any share over the Session allows writing. The layer is mounted on the Session, but it confines only the turns a share viewer starts: `agent/pre-step` records, in Host memory, whether a turn's admitted input names a share viewer, and the guard and the replacements read that answer for every execution of that turn. A viewer-started turn runs those replacements and nothing else; a turn the owner starts keeps the Session's own tools, including `bash` and its unrestricted filesystem tools. The answer is decided when the turn is admitted and never written to the Session log; a restart recomputes it from the next admitted step. An owner's steering input inside a viewer's turn stays confined with it. Stopping every share over the Session disposes the layer, which restores the Session's own tools; narrowing the last write share to `view` re-installs the read-only layer.

The installation reports whether the source Session is actually confined. A deployment without the `read` tool, or a scope that refuses that replacement's registration, leaves the guard in place and reports the refusal; a tool whose own replacement failed stays refused while the rest of the surface runs, and the reader refuses the prompt with `source-write-unavailable`: no viewer-started turn of a shared Session is driven against the owner's own tools because a limit could not be installed.

Each operation re-reads the Relay grants of the shares that keep the Session drivable, and each reading is synchronous with the tool call it authorizes, so input queued past the grant that admitted it cannot act on that stale admission. The layer is per Session: several shares over one Session share the one installation, and a share that narrows or ends changes what the layer permits — its bounded write is refused once no active share may write, and the layer is released once no share is left. The Host does not attribute a running turn to the viewer that admitted it, so ending one share's grant stops the Session's running turn rather than singling out that viewer's work; the in-memory viewer-start marker only decides which tool surface that turn runs.

Confined file tools resolve every path their own arguments declare, check that the granted root contains each result, and delegate with the target’s canonical path. A pathless `glob` or `grep` searches the Session’s working directory, which the replacement supplies and checks like a named path; a `present` call checks every file it lists; the tools with no local file effect are delegated unchanged. Bounded edits run the same containment check, use `fs/edit-intent`, and publish the version `editText` returns; bounded writes use `fs/write-intent` and publish the version `writeText` returns. After the asynchronous intent wait, the Host resolves the current Session sandbox policy and rechecks share authority. It passes that policy as the fifth `editText` or `writeText` argument, after `signal`, so the sandboxing backend fences the mutation by it. Containment is checked by path, so a directory inside the grant that a local process replaces with a symlink between the check and the open can redirect the operation; anchoring operations to a directory handle is deferred to a separate change.

A viewer's source prompt and source stop both travel the standard Gateway dispatch under the `share-viewer` policy's source-write role: the policy admits them while the share's tier is established and its Session is confined, and the owner's own Session controller then stops whatever turn the Session is running. Cancellation performs no per-viewer comparison, so a reader's stop of the shared Session also ends a turn the owner started. The [Session Controller](../../packages/api/session-controller/README.md) reads `remoteAccess.allows()` again inside `prompt` immediately before delivery and in the same synchronous step as a `cancel`, so a viewer whose access ends after the Gateway admitted its call delivers or cancels nothing. Queued external source input refreshes Liveshare server authority in `agent/pre-step`; missing authority rejects the step before a model request.

<a id="viewer-states"></a>

## Viewer states

A viewer read that ends in a refusal names its own condition rather than one failure for every cause: the Liveshare server answers a missing link, a share the owner stopped, an expired share, an owner whose machine holds no route, an expired sign-in, a reader who has not asked, a request still waiting, a request the owner refused, and a notification the owner never received each with their own status and code, and a page that cannot reach the Liveshare server states that itself. `VIEWER_STATE_ANSWERS` in `@deepseek-ai/dsh-experimental-liveshare-protocol` is the whole vocabulary, and the [shared protocol](../../packages/experimental/liveshare-protocol/README.md) owns the answer each condition carries. No answer widens what a viewer may read: an offline owner, a stopped share, and a refused request all deny.

The workspace feed a viewer's page renders is filtered through the same policy as its session list: a workspace is delivered while it holds the shared Session or a branch that viewer made from it, and its membership and its manual order keep only those. A workspace that loses them leaves the feed when that workspace or the workspace order next changes, and the stream then replaces the reader's baseline; an access change alone sends no frame. A reader therefore sees the owner's workspace names and grouping around the one Session it was granted, never the rest of the owner's workspaces.

Viewer streams bind the opening actor across polling, replacement, and cancellation. Session notifications, control baselines, and workspace membership expose only the source and that actor’s children: the Gateway forwards a reader only the `api-session/*` notifications the policy allows on those Sessions, and the Session and Workspace controllers filter their lists and streams through the same policy; interactive approvals and questions stay on the Host. Refused reads open no upstream subscription. Expiry and revocation cancel affected pending calls and streams; unpolled streams are reclaimed after 120 seconds. Worker IPC responses and cancellations must match the request’s token, share id, Liveshare server id, and original socket or worker generation; late answers cannot settle a replacement request.

The Liveshare server’s optional `share-access-state` capability publishes a complete, versioned authority snapshot on connection and committed mutations, including mutations on another Liveshare server instance. Authenticated `GET /__liveshare/requests` returns the same fields. The Host clears cached authority on connection loss, rejects stale revisions within a generation, and fences asynchronous refreshes against generation changes. Missing complete authority refuses admission; this does not establish immediate distributed stop semantics.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxliveshareshares--liveshareshares"></a>

### `ctx.liveshareShares` — `LiveshareShares`

Owner-only Remote surface over the share-management operations.

The Gateway decides each call through remote access, so a `share-viewer` Peer is refused before a method runs; the owner Peer reaches the one implementation that owns each share-management side effect. `create` takes its Session as the `sessionId` of its single request object, so the Session resource kind's default resolver names that Session for the call without a reader declared here.

```ts cordis-catalog
/**
 * Publish one Session and store the share.
 * @param request - Session, title, access, lifetime, and both switches the owner chose.
 * @returns The created share's link and stored values.
 */
@Remote('create') create(request: CreateShareRequest): Promise<CreatedShare>

/**
 * Refresh titles and Liveshare server authority, then list this host's shares.
 * @returns Every share this host publishes.
 */
@Remote('list') list(): Promise<OwnerShareList>

/**
 * Stop one share locally, revoke its forks, and delete its row on the Liveshare server when reachable.
 * @param request - Share to stop.
 * @returns Whether the row on the Liveshare server still needs a retry.
 */
@Remote('stop') stop(request: StopShareRequest): Promise<StopShareResult>

/**
 * Change one share's tier, fork switch, or both.
 * @param request - Share and the switches to change.
 * @returns The permissions the share now carries.
 */
@Remote('updatePermissions') updatePermissions(request: UpdateSharePermissionsRequest): Promise<SharePermissions>

/**
 * Replace one share's exposed plugin endpoints.
 * @param request - Share and the selection to store.
 * @returns The capability selection the share now carries.
 */
@Remote('setCapabilities') setCapabilities(request: SetShareCapabilitiesRequest): Promise<ShareCapabilities>

/**
 * Read the endpoints plugins currently offer.
 * @returns The live offer list.
 */
@Remote('capabilities') capabilities(): ShareCapabilityOffers

/**
 * Read the Liveshare server address the owner saved.
 * @returns The current Liveshare server state, with both address fields absent while none is saved.
 */
@Remote('relay') relay(): OwnerRelayState

/**
 * Choose the Liveshare server address later shares publish to.
 * @param request - Normalized address or null to clear the saved one.
 * @returns The Liveshare server state after the change.
 */
@Remote('setRelay') setRelay(request: SetRelayRequest): Promise<OwnerRelayState>

/**
 * Report this host's owner identity for one Liveshare server address.
 * @param request - Address to report, or the effective one when absent.
 * @returns The owner identity status, without the credential.
 */
@Remote('identity') identity(request: OwnerIdentityRequest): Promise<OwnerIdentityStatus>

/**
 * Read the Liveshare server's durable audit trail for one share.
 * @param request - Share whose audit is read.
 * @returns The audit events, or a structured failure when the Liveshare server cannot answer.
 */
@Remote('audit') audit(request: ShareAuditRequest): Promise<ShareAudit>

/**
 * Check that the effective Liveshare server answers at all.
 * @returns The anonymous connectivity result.
 */
@Remote('testRelay') testRelay(): Promise<RelayConnectivityView>

/**
 * Register one throwaway share to check whether this host may publish.
 * @param request - Session the throwaway registration names.
 * @returns The Liveshare server's decision about this host's credential.
 */
@Remote('testPublish') testPublish(request: TestPublishRequest): Promise<RelayPublishView>
```

Source: [`packages/experimental/liveshare/src/host/share-remote.ts`](../../packages/experimental/liveshare/src/host/share-remote.ts)
<!-- END GENERATED cordis-surface -->

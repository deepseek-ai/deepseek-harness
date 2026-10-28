---
description: "Share DSH Sessions through a separate Liveshare server, with verified owner sign-in, viewer controls, and bounded execution."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-liveshare

English | [中文](README.zh.md)

## Summary

Share a Session with colleagues through the normal DSH browser interface. The owner chooses viewing or bounded writing, and independently allows forking; the owner host enforces those choices. Attachment upload follows sharing itself: a Session the viewer can see accepts files. This opt-in bundle adds owner sign-in, sharing controls, the outgoing gateway, and the viewer surfaces of the owner's own Web page. The default Web profile excludes it. The separately deployed Liveshare server authenticates viewers and transports their requests; its OAuth, database, routing, and deployment implementation are not part of this package.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Profile and build requirements

The manifest declares an installable `dsh.bundle` layer and a browser face. The bundle stays hidden until a profile enables it, as described in [Default visibility and enabling](#default-visibility-and-enabling); supported applications still start through `dsh --profile`.

Owner, viewer, and the Liveshare server must use matching protocol versions. The build includes the Owner's gateway process; the viewer page has no separate build. Package version, exports, and publication contents are declared in [package.json](package.json).

<a id="default-visibility-and-enabling"></a>

### Default visibility and enabling

A dsh installation ships this package as a runtime dependency, but no shipped profile selects its bundle, so none of its plugins run and the plugin manager lists it in neither **Built-in plugin settings** nor **Experimental plugins**, including the **More** page. The bundle ID stays addressable, so a page that opens a bundle by ID still reaches this bundle's details.

Enable it by inserting its two entries into the active profile's patch file, `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. That file is one YAML sequence of Loader patches; these are the entries the bundle's own [patch](cordis.patch.yml) inserts, and `!!js` expressions are allowed there:

```yaml
- insert:
    - id: liveshare-viewer-declarations
      name: '@deepseek-ai/dsh-experimental-liveshare/viewer-declarations'
    - id: liveshare-share-host
      name: '@deepseek-ai/dsh-experimental-liveshare'
      config:
        ownerIdentityProvider: <provider-id>
        ownerIdentityTenant: <tenant-id>
        ownerIdentitySubject: <subject-id>
        allowedSubjectIds: []
        ownerStateFile: /path/to/owner-shares.json
```

Replace every `<...>` placeholder with the deployment's own value: the identity provider, tenant, and subject are the ones its Liveshare server deployment was configured with, and the example holdings are placeholders rather than real identities. The environment layer works too: set `LIVESHARE_*` in `$DSH_HOME/.env` and keep the bundle's own `!!js process.env.…` expressions. The Liveshare server address is not part of this configuration: the owner enters it in the Share dialog on first use, as Owner configuration below describes.

The profile can select the bundle instead of patching it: add `"@deepseek-ai/dsh-experimental-liveshare"` to `dsh.profile.bundles` in `$DSH_HOME/profiles/<profile>/package.json`, which is the write the card's switch performs once the card is listed.

Either route takes effect only on a recomposition. With the profile's HMR row enabled, the change applies when the profile is re-read; without it, the next `dsh` start applies it. Once at least one row the bundle declares runs, its card appears under **Experimental plugins** and on the **More** page. Removing the entries, disabling them, or removing the bundle from `dsh.profile.bundles` stops those rows and the card leaves both lists again.

### Owner configuration

| Variable | Default | Meaning |
|---|---|---|
| `LIVESHARE_OWNER_PROVIDER_ID` / `LIVESHARE_OWNER_TENANT_ID` / `LIVESHARE_OWNER_SUBJECT_ID` | unset | Owner identity used for legacy subject matching; it does not replace a server-issued credential |
| `LIVESHARE_OWNER_DISPLAY_NAME` | unset | Display label for the configured identity |
| `LIVESHARE_ALLOWED_SUBJECTS` | empty | Deployment-wide subject allowlist in addition to the share's access rules |
| `LIVESHARE_OWNER_STATE_FILE` | `$DSH_HOME/liveshare/owner-shares.json` | Stored share metadata, the saved Liveshare server address, instance identity, and management tokens |
| `LIVESHARE_OWNER_CREDENTIAL_FILE` | `owner-credential.json` beside the state file | Stored credential bound to the Liveshare server that issued it |

The Liveshare server address is set on first use: enter it in the Share dialog's address field and save it. The saved address persists in the owner state file, and later shares publish to it; a publication already waiting for registration keeps its starting server address in its registration, stored record, and returned link, and existing shares retain their recorded Liveshare server address. Clearing the saved address through the share-management Remote leaves this host without one — creating a share then reports that an address has to be saved — rather than falling back to a deployment value. The name a reader sees beside a share comes from the display name on the Relay-verified credential, and local configuration cannot override it; a credential that carries only a subject shows that subject's label. Provider application secrets belong to the Liveshare server, not this configuration.

### Sign in and manage shares

The Share dialog starts a short-lived authorization transaction on the Owner. A popup returns a single-use code only to the expected window, origin, and transaction. The Owner redeems it with its private verifier and saves the credential bound to that Liveshare server; the normal browser login flow never stores that credential in browser storage or a URL. Expired, cancelled, replayed, or mismatched transactions fail closed. Changing the Liveshare server during code redemption, including a change away and back, refuses login before credential storage. After storage commits, probes and share claims retain that operation’s Liveshare server and credential identity. Publishing without verified identity is refused, including when the Liveshare server does not support identity binding.

Share management is the `liveshareShares` Typert Remote: the share list, creation, stopping, tier and fork changes, endpoint selection, the Liveshare server state, the owner identity, the audit trail the Liveshare server holds, and both Liveshare server checks are methods on the mounted namespace. The sign-in round trip and credential storage are the only same-origin HTTP routes the owner page still calls.

The owner admits viewers by organization link; the deployment's `LIVESHARE_ALLOWED_SUBJECTS` gates every share and narrows an organization-link share to the subjects it lists. Stored `selected` or `approval` shares keep their original ACL and access summary, and the dialog no longer creates them; `liveshareShares.create` keeps `accessMode` and `allowedSubjectIds` for those records and direct Remote callers. Manage Shares lists stored links, tiers, availability, and the Liveshare server's audit responses, and it can change a share's tier, turn its fork switch on or off, and stop a share. Failed operations remain visible as errors; the UI re-reads the Owner's response rather than treating a click as success. The Share dialog edits an existing share too: its tier, fork switch, and plugin endpoints are picked there and submitted by one save that sits outside the scrolling fields and re-reads the Owner's record; unsaved picks are stated, and closing first warns that they would be discarded.

### Session tiers

| Tier | Viewer actions | Execution limit |
|---|---|---|
| `view` | Prompt the source Session and stop its running turn | Read-only sandbox mounted on the Session, applied to every turn a share viewer starts: that turn may use the read and search surface (`read`, `read_image`, `glob`, `grep`, `present`), the tools with no local file effect (`todo_write`, `skill`, `web_search`, `web_fetch`); every path a call declares is checked against the granted workspace |
| `write` | Also modify files inside that workspace | Writable sandbox with limits: the view surface plus bounded `edit` and `write` inside the granted workspace, for every viewer-started turn of the Session |

Both tiers drive the shared Session; what separates them is writing. The sandbox is mounted on the Session for as long as any share over it is active, but it confines only the turns a share viewer starts: a turn the owner starts keeps the Session's own tools, including `bash` and its unrestricted filesystem tools, and an owner's steering input inside a viewer's turn stays confined with it. The decision is kept in Host memory per turn and never written to the Session log; stopping every share or letting them all expire releases the layer and restores the Session's own tools. Forking is not a tier: the share carries its own switch, independent of the tier, and a viewer it admits forks a completed source prefix into a child that runs under the read-only ceiling, or under the bounded-write ceiling when the share is at the `write` tier.

Attachment uploads are neither a tier nor part of the fork switch: they follow visibility. An admitted viewer may attach uploaded files to the shared Session and to the forks it created through this share, whichever tier the share carries and whether or not it allows forking. The owner has no separate attachment switch.

No tier grants Session configuration, renaming, archival, Workspace management, or the owner's global settings and credentials; attachment uploads follow visibility and are not a tier grant. The Owner Gateway refuses a viewer's `settings/describe`, `credentials/describe`, `agentPresets/list`, `agentPresets/read`, and every other endpoint the share does not grant with the Remote failure `remote-access/denied` (reason `liveshare/read-only`); configuration values, credential-reference metadata, and preset plugin configuration are not viewer data. The viewer keeps its local presentation defaults. Those management decisions stay independent from permission to prompt a Session. **Temporary:** a plugin that owns an endpoint this page needs offers it through [`viewerDeclarationsOf(ctx)`](src/host/viewer-declarations.ts) — `registerViewerReadable(actions)` for endpoints that change nothing, `registerViewerWritable(actions)` for endpoints that write — until endpoint-level access declarations in Typert metadata replace this surface. **An offer grants nothing by itself**: the owner exposes a plugin's endpoints one share at a time, and a share exposes an endpoint only where that plugin's live offer and that share's own selection name it, on the resources the reader can see. A writable selection rides the share's own write rule, so **it takes effect only in a share whose Session already allows writes and whose source execution is confined, and no offer and no selection turns a read-only share into a writable one**; either kind leaves the actions this policy already decides — `session/prompt`, `session/cancel`, `session/fork`, and the rest of its roles — to the mode's own answer. The owner's own page opens with the owner access baseline, so its interface is unchanged.

The Owner Gateway decides each call on the Session and Workspace it names and refuses a call whose target is missing or invalid. The viewer's Session list and workspace membership are trimmed to the source and the children that viewer owns. The page reads each Session's own answer from the reader's access snapshot, so a selection change never carries the previous Session's permission across. Unknown or unreadable modes fail closed. The Owner rechecks admission for source and child calls; revocation cancels the affected calls and streams, and a share whose admission narrows stops the shared Session's running turn. The page distinguishes authentication, access, expiry, stopped shares, offline owners, and transport failures, and retries only the failures classified as repeatable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The viewer page is the Owner's own Web shell. The Liveshare server fetches the Owner's rendered index document through an `asset` read and places the carrier script from [viewer-carrier.ts](../liveshare-protocol/src/viewer-carrier.ts) first in it. Shell assets, client plugin bundles, and the three exact top-level files the index references against the document base — `manifest.webmanifest`, `favicon.svg`, and `favicon-dark.svg` — arrive through the same read, from the Owner's frontend reader and client module registry, so the page runs every Owner plugin at the Owner's version. Source maps are refused on every asset path, and that check is the authoritative one: an `asset` read forwarded through the Liveshare server arrives here unread, so the Liveshare server's own same-named rule covers its page-resource route only. The served document also drops its manifest link, which a browser would otherwise fetch without credentials. The carrier converts Connection calls and Gateway streams into `POST {base}/__share/rpc` requests, and forwards the read-only page-origin owner routes the Liveshare server cannot answer — `/open-in-app/apps` and `/api/present.host` — through that channel instead of leaving them to the Liveshare server's tail. The Liveshare server supplies the authenticated actor outside the opaque body. The Owner's read handler dispatches each reader's calls and streams into its own Connection and Gateway as one Peer per share and reader, whose `share-viewer` principal carries the share and the server-asserted identity. The Gateway decides that Peer's calls, and the Session notifications it forwards to it, through [`dsh-api-remote-access`](../../api/remote-access/README.md) from the `share-viewer` policy this package registers: a served reader holds read roles on the shared Session, its own forks, and the Workspaces holding them, fork and write roles whose conditions apply the share's tier and its own fork switch, and nothing else; attachment upload rides the read roles. The read handler keeps the share-lifecycle refusals, Liveshare server authority refresh, cold Session preparation, and fork orchestration, reads the policy's write rules before it prepares or dispatches a prompt or stop, and disposes a reader's Peer when its grant ends, the share stops or expires, or a re-check refuses it. Preparing a share's source Session also starts when a reader asks for its page or opens a stream, so a host that restarted before that Session's agent was live still gains the actions it drives with; a share whose Session cannot be confined states that instead of the read-only fact. This package's browser face mounts the viewer surfaces when the carrier's `__DSH_LIVESHARE_VIEWER__` global is present and the Share action otherwise. The served index assigns the reader's own access snapshot to the global that every index sets to the owner baseline, and the page then follows the reader's `remoteAccess/follow` snapshot; CSS hiding is not authorization.

Fork requests bind the actor, share, source, operation identity, and completed prefix. A durable reservation and the recorded child let a retry of a recorded operation replay the same child; the owner's `SessionForkRequest` mints the child id, so a request interrupted after the child was created but before it was recorded forks again. Registry mutations are asynchronous and resolve only after locked read-modify-write and atomic publication; callers must await reservation, recording, and revocation. Cold activation uses the Host’s ordinary Agent lookup, with serial `agent/created` enforcement before queued input can run, not a Remote `session/prepare` endpoint. The child scope retains one fail-closed guard; reconnection replaces its enforcement installation, and releasing an old installation cannot remove its successor.

A reader's prompt reaches the Session as a `user-rpc` message whose `source.principal` names that reader, and the pre-step re-checks every entering message's viewer against the Relay's admission before it reaches the model. Execution is confined per turn: while any share over the Session is active, a turn whose admitted input names a share viewer runs the Host's confined replacements for the read and search surface (`read`, `read_image`, `glob`, `grep`, `present`), for the tools with no local file effect (`todo_write`, `skill`, `web_search`, `web_fetch`), and, when some share may write, its bounded `edit` and `write`. Every other tool is refused to that turn, and every path a permitted call declares is resolved and checked against the granted root. An owner-started turn keeps the Session's native tools until the last share stops or expires. The turn decision is Host memory only, recomputed for each turn and never appended to the Session log. Each operation re-reads the shares' current Relay grants and checks the resolved target against the granted root. A reader's stop is dispatched through the Gateway like a prompt: the `share-viewer` policy admits it while the share's tier is established and the Session is confined, and the owner's own Session controller stops whatever turn the Session is running, including one the owner started. Reads and writes preserve the normal write-observation policy. See the [LiveShare subsystem](../../../docs/subsystems/liveshare.md) for the execution rules.

| Owner | Source |
|---|---|
| Login, credential storage, and gateway lifetime | [share-host.ts](src/host/share-host.ts) |
| Share-management operations and their `liveshareShares` Remote | [share-operations.ts](src/host/share-operations.ts), [share-remote.ts](src/host/share-remote.ts) |
| Viewer request dispatch, reader Peers, and the access policy | [viewer-read.ts](src/host/viewer-read.ts), [viewer-principal.ts](src/host/viewer-principal.ts), [viewer-access-policy.ts](src/host/viewer-access-policy.ts), [viewer-declarations.ts](src/host/viewer-declarations.ts), [source-access.ts](src/host/source-access.ts) |
| Fork records and runtime enforcement | [fork-registry.ts](src/host/fork-registry.ts), [fork-enforcement.ts](src/host/fork-enforcement.ts), [shared-tools.ts](src/host/shared-tools.ts) |
| Page carrier, viewer surfaces, and served-page reads | [viewer-carrier.ts](../liveshare-protocol/src/viewer-carrier.ts), [client/index.ts](src/client/index.ts), [viewer-session-plugin.ts](src/client/viewer-session-plugin.ts), [viewer-assets.ts](src/host/viewer-assets.ts) |
| Shared identity and frame definitions | [protocol package](../liveshare-protocol/README.md) |
| Registration and socket-scoped request correlation | [registration-url.ts](src/owner-gateway/registration-url.ts), [pending-rpc.ts](src/owner-gateway/pending-rpc.ts) |

Registration declares the wire version and optional capabilities. A declared mismatch receives HTTP 426; there is no version translation. IPC requests use unique tokens bound to their original socket and worker generation; responses and cancellation match token, share id, and Liveshare server id. Unsupported requests receive a scoped refusal when they can be correlated.

The optional `share-access-state` frame and authenticated request-list response supply complete, versioned Liveshare server authority. The Host retains the Owner's selected mode separately and uses the narrower mode for execution. All complete request-list reads, including management reads, apply the same version and generation checks; missing authority invalidates admission. A request that first discovers revocation receives `403 viewer-not-authorized`, while other revoked work is cancelled. The `share-viewer` policy and `agent/pre-step` bind the receiving Session to the share's source or that actor's recorded child. Queued external input refreshes authority even after restart; a deleted share cannot authorize recovered Inbox input. See the [shared protocol reference](../liveshare-protocol/README.md) for snapshot fields.

Viewer streams belong to their opening actor. Notifications and control projections expose only the source and that actor’s children; interactive approvals and questions remain on the Host. `forkLineage` is a LiveShare-owned UI projection, not a grant. The per-Session grants of the reader's access snapshot decide whether the page offers prompt and stop, independently of display lineage.

The external Liveshare server's service, stores, OAuth provider, and deployment remain separately owned. Owner-only tests live here; tests that start both complete products remain with the upper Liveshare server integration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LiveShare subsystem](../../../docs/subsystems/liveshare.md)
- [Owner decision record](../../../.agents/notes/implemented/feature/2026-09-13-liveshare-protocol-and-owner-surfaces.md)
- [Web bundle](../../bundle/web-app/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the host driving viewer prompts into the shared Session, so a model request follows the viewer input that host forwards as that Session's ordinary user input.

#### KV Cache effect

Viewer prompts enter the shared Session as ordinary user input, so they extend the same cached prompt prefix the owner's own input extends; the bundle adds no request field, tool, or system-prompt text of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Owner, viewer, and the Liveshare server require matching versions; cross-version compatibility is not established.
- The owner cannot refuse attachment uploads for an admitted viewer: a viewer that may read a Session may also attach files to it, independent of the tier and of the fork switch. This is an accepted risk.
- Viewer file operations are confined by a path check against the granted root, so a local process that swaps a directory inside the grant for a symlink between the check and the open can redirect them; directory-handle anchoring is deferred to a separate change. Viewer tools are limited to the confined read and search surface (`read`, `read_image`, `glob`, `grep`, `present`), the tools with no local file effect (`todo_write`, `skill`, `web_search`, `web_fetch`), and, at the write tier, bounded `edit` and `write`; `bash`, `pwsh`, `cua`, `plugin_manager`, the `schedule_*` tools, and every tool that surface does not name are not granted.
- The viewer has no separate workspace-file editing interface and no management authority.
- Endpoint capabilities are temporary and trusted without review: the registry checks only that a name is a `<namespace>/<method>` Remote endpoint, so a selected endpoint becomes callable by every authenticated share viewer on the resources the policy binds, and the endpoint's own confinement is the only limit on what a viewer reaches through it. A selected writable endpoint is destructive inside a share that already allows writes. Capabilities cover the `global`, `session`, and `workspace` resource kinds only, and an `event:` name is rejected.
- The owner picks one exposure tier per share in the share panel — unavailable, read-only, or writable — which starts unavailable and applies to every plugin that declares endpoints; the manager lists what each share already exposes. The tier expands at save time into the endpoints the plugins declare then, so the stored record stays an explicit endpoint list and an endpoint a plugin adds later stays closed until the owner saves again. A tier the live offer cannot fill is not selectable: with no writable endpoint declared anywhere, writable is stated as unavailable instead of degrading to read-only. One save writes the share's tier, fork switch, and endpoints in that order; a refusal of the endpoint write leaves the permission write stored, states the failure, and keeps the owner's picks for a retry. The selection is share-wide: every admitted viewer of that share may call a selected endpoint on the resources the policy binds, and per-viewer endpoint levels are not established. A selection the offering plugin no longer declares exposes nothing, but stays in the stored record until the owner saves again; a record that is no whole tier reads as unavailable and says that saving replaces it.
- A Workspace that stops holding a Session the reader can see leaves the reader's Workspace feed only at that Workspace's or the Workspace order's next change ([remote access limitation](../../api/remote-access/README.md#known-limitations-and-deferred-work)).
- Registry file locking prevents concurrent file writes from dropping durable entries, but each registry reads its own in-memory snapshot. Owner share-state updates and gateway ownership are not coordinated across Hosts; use one active Owner Host per home. This is not a multi-host authorization service.
- No runtime invariant companion is published: authorization is checked in the operations themselves, and this package has no separate invariant observer.
- A worker restart re-registers retained shares but does not replay viewer streams; viewers recover through their transport. Registration refusals 401, 403, 410, and 426 stop that share’s reconnect loop until something registers it again: republishing or changing its tier does, and so does storing a credential for that Liveshare server, which registers the shares that address left offline. A restore presents the credential this host holds for the share’s Liveshare server whatever this host’s own expiry read says, because the Liveshare server renews the login behind it and only the Liveshare server decides whether that credential still authorizes; a new share is still refused on that same local read.
- The access mode grants `view` admission, while effective fork/write authority comes from the share mode. Per-viewer execution levels and immediate cross-instance stop/cancellation completion are not established; cancellation cannot undo committed writes. A write-to-readonly snapshot denies later writes but does not promise immediate cancellation of a running child turn.
- Final assembled snapshot verification remains required before the feature is ready for release.
- On the viewer page, client reads that bypass the Connection carrier (deliverable reads, open-in-app, PDF assets, HMR events) reach the Liveshare server rather than the Owner; the index document's root-absolute manifest and icon links do not resolve under a Liveshare server prefix.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

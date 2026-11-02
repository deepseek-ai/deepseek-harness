# Agent Note: Liveshare — sharing a DSH session with a colleague

Status: implemented

English | [中文](2026-09-13-liveshare-protocol-and-owner-surfaces.zh.md)

## Problem

A DSH session runs on your own computer. A colleague sometimes needs to watch one while you work — to follow a debugging session, or to see how a long task is going. Today there is no way to do that. Sending the session log is not the same thing: the colleague would need your plugins, configuration, and sandbox to render it, and the session only makes sense while it is running on your machine.

So a share needs three things at once. A **page the colleague opens in a browser** that shows the session running on your machine, without connecting them to it. A **limit on what that page can do**, starting with "read without writing" — anything the page offers beyond what you agreed is a security hole, not a convenience. And an **answer to "who shared this?"**, because a page that cannot say who its owner is cannot be trusted by whoever opens it.

This note covers the half that runs inside the owner's DSH — the share dialog, the owner-side service behind it, the package's browser face, and the page a reader opens — plus the protocol package both sides speak. The Liveshare server, the shared service in the middle, is its own package (`@deepseek-ai/dsh-experimental-liveshare-relay`) and is reviewed and deployed separately.

## Decision

### What a share is

An owner creates a share for one session from DSH itself. The share is published to the Liveshare server, a service both sides can reach, and DSH returns a link. Opening that link shows the session rendered by the owner's own DSH with its own plugins, so the reader never needs the owner's configuration. The reader's list contains the source Session and any children that reader created through the share. Workspace names, membership, and ordering are trimmed to those Sessions; unrelated Sessions and workspaces stay hidden.

A share created from the DSH Share dialog is an **organization link** share: it carries `accessMode: 'open'`, so anyone in the organization who has the link is admitted. The deployment's `LIVESHARE_ALLOWED_SUBJECTS` is unioned into every share's ACL: it narrows an `open` share to the subjects it lists, and on a stored `selected` record it adds those subjects beside the record's own selection.

**Specific colleagues (`selected`) and the older `approval` spelling are legacy stored records.** The Host still reads them with their recorded ACL and shows their access summary, and the Liveshare server still admits their viewers by that ACL, but the shipped Share dialog offers no way to create one. `liveshareShares.create` keeps its `accessMode` and `allowedSubjectIds` fields for those records and for callers that invoke the Remote directly; the shipped dialog sends neither.

### What a reader can do

The reader's page is the normal DSH client, not a cut-down copy. The sidebar, the session list, expanding, collapsing, and selecting are all there, because browsing is part of reading. What is missing is every action the reader is not allowed to perform: creating an unrelated session, renaming, archiving, deleting, and managing a workspace. Branching follows the share's own fork switch, prompting is available in both tiers and runs inside that tier's sandbox, and attachment upload follows the Sessions the reader can see; management permissions remain independent of the tier and the fork switch.

These actions are not hidden with CSS. One access snapshot decides what the page may do: the remote-access client follows the reader's own `remoteAccess/follow`, and each button and menu entry reads its endpoint's answer on the global resource, a Session, or a Workspace through `useRemoteAccess`, `useAccess` or `useSessionAccess`, or `useWorkspaceAccess`, rendering again whenever the answer changes. The owner's DSH computes the snapshot from this share's `share-viewer` policy, so an ability the owner withdraws closes without reloading the page — and the server refuses those actions anyway; the page only avoids offering what would be refused. The served index carries the reader's opening snapshot, so no entry appears before the page knows it is allowed, and after the snapshot stream fails every answer is refused. The owner's own page opens with the owner baseline and behaves exactly like an ordinary DSH. Per-Session refusal reasons are not part of the snapshot: the page states the page-level reason (share mode, stop, expiry, lost access) and generic read-only copy. A page that cannot read the Session at all — offline owner, stopped or expired share, lapsed sign-in — states that condition at the top and gives the reader an action, instead of leaving an empty shell or a bare code.

### Two driving tiers

Every share carries a `ViewerSessionMode` with two values, and both drive the shared Session:

- **view** — the reader drives the shared Session's loop through the normal prompt path, inside a read-only sandbox in the granted workspace, so the Session's tools never write a file. The read and search surface (`read`, `read_image`, `glob`, `grep`, `present`), the tools with no local file effect (`todo_write`, `skill`, `web_search`, `web_fetch`). Every declared path is checked before the tool runs, and a tool whose call cannot be checked is refused.
- **write** — the reader drives the same loop in a bounded writable sandbox that also modifies files inside the granted workspace, under the Host's write ceiling.

The sandbox is installed on the Session, but it confines only the turns a share viewer starts: `agent/pre-step` records whether an admitted turn's entering input names a share viewer, and the guard and the replacements read that answer for each execution. A turn the owner starts keeps the Session's tools; an owner's steering input inside a viewer's turn stays confined with it. The marker lives in Host memory, is recomputed for each turn, and never enters the Session log. Stopping every share, or letting them all expire, disposes the layer and gives the Session its own tools back.

The earlier vocabulary had three tiers — `view` watched, `fork-readonly` branched, and `write` could write. `view` and `fork-readonly` differed only in whether the reader could branch and drive a child, which the share's own `allowsFork` switch already decides; a third mode duplicated that switch and let the two answers disagree, so the two driving tiers replaced it.

Forking is not a tier. The share carries its own `allowsFork` switch, independent of the tier: a `view` share may allow it and a `write` share may refuse it. A fork creates a child the viewer owns with its own read-only or writable ceiling and leaves the source untouched.

Attachment upload is not a tier or a switch. `fileUploads/upload` rides the read role, so every Session a share serves the reader accepts files; visibility alone decides it, and the owner has no separate attachment switch.

A mode this version does not recognize, and a persisted record whose mode the host cannot establish, are not driven: the share stays readable, and the page reports what it could not establish. The withdrawn `fork-readonly` name is not read back as `view`; a persisted owner record that names it is rejected when the owner state loads.

The sandbox is a property of the Session, but it applies per turn: the Host records, in memory, whether the admitted input of the running turn names a share viewer, and confines that turn while leaving an owner-started turn on the Session's native tools. The earlier shipped design confined every turn, including the owner's; it needed no turn read, but a share changed how the owner's own work ran. Persisting a turn's requester was rejected: a committed-message projection had to be folded, re-read for every execution, and kept in step with the share that admitted it, and it still had to fail closed on mixed or unestablished requesters. The in-memory marker keeps the guard and the replacements reading one answer per execution without adding a Session event; a restart recomputes it from the next admitted step, and a rejected or never-admitted step leaves no marker.

### Default visibility

The package ships as a runtime dependency of every dsh installation, but a default installation must show it nowhere in the plugin manager: neither under **Built-in plugin settings**, nor under **Experimental plugins**, nor on the **More** page. A person enables it deliberately — by inserting the bundle's rows in the active profile's `cordis.patch.yml`, or by selecting the bundle in `dsh.profile.bundles`; the [package README](../../../../packages/experimental/liveshare/README.md) owns both routes. The package must still ship with the release and stay installable, and users who enabled it before this rule keep seeing it.

The Host's bundle `enabled` flag states whether the profile selected the bundle, which is not the same as whether the bundle's plugins run: inserting the bundle's rows through `cordis.patch.yml` starts its plugins while leaving the bundle unselected, so a visibility rule built on `enabled` would hide a bundle the person had just enabled and would strand the documented enable path.

The package declares the hiding intent in its own bundle manifest as `dsh.bundle.listedByDefault: false`; the manager keeps one generic visibility rule rather than a client-side name set. A bundle whose manifest does not declare `listedByDefault: false` is listed; one that declares it is listed only when the profile enables it, the installation carries it selected, or one of the rows its bundle patch declares is running (`pkg.rows.some(row => row.enabled)`). The filter applies before both lists are derived, so the name is absent from the main Experimental plugins group, the More page, Built-in plugin settings, and the Installed plugins group until one of those holds. The Host's `listBundles` contract, the profile format, and the installed package set are unchanged. `BundleInfo.rows` already joins each declared row with the Loader entry currently carrying it, and the client's `PackageView` carries whether that entry runs, so row state is the effective answer for both enable routes: removing the rows, disabling them, or deselecting the bundle stops them and the card leaves both lists again.

A default-hidden bundle is not addressable by ID while its card is hidden: `openPkg` resolves only the listed inventory, so `pluginNavigation.openBundle('@deepseek-ai/dsh-experimental-liveshare')` renders no details until the same enablement conditions list it.

### How shared work stays inside its grant

The Owner, not the viewer page or the Liveshare server, authorizes each Session operation. A child receives its real scoped tool restrictions before it can accept a prompt, including after a cold resume: the host installs the limit from the base `agent/created` event. That listener runs after the agent entered the registry, but creation has not resolved, AgentLoop holds the agent's queued input, and a throw fails creation, so a refused limit still prevents any prompt. A missing host service or failed installation refuses the child; a configuration flag, a tool name, or a promise to install later is not enforcement.

A shared source Session can still serve its owner's own work. Every reader call is dispatched through the owner's own Connection and Gateway as that share-and-reader pair's own Peer, whose `share-viewer` principal (the share id and the server-asserted identity triple) is fixed by in-process owner code when the Peer is created; no wire field can change it. The Gateway decides the Peer's calls, and the Session notifications it forwards to the Peer, through remote access: this package registers the `share-viewer` policy, which binds a served reader to read roles on the shared Session, its own forks, and the Workspaces holding them, and to fork and write roles whose conditions apply the share mode; it binds nothing else, so every other endpoint and notification is refused, and it binds nothing once the share stops serving the reader. The owner invalidates the reader's access on every grant, revocation, mode change, and expiry, and disposes the reader's Peer when the grant ends or the share stops or expires. A reader's prompt enters the Session as a `user-rpc` message whose `source.principal` names that reader; owner messages carry no principal. While any share over that Session is active, the owner host mounts its own confined replacements for the read and search surface and the no-effect tools — plus bounded `edit` and `write` when some share may write — in the Session's own scope, and a viewer-started turn may run nothing else. An owner-started turn keeps the Session's native tools, so a share never narrows the owner's own work. The pre-step records which kind of turn is running, in memory only. Each operation re-reads the shares' current Relay grants and checks the resolved target against the granted root; the pre-step re-checks every entering message's viewer against the Relay's admission before a model step, so reader input queued before a revocation never drives the model. A reader's stop of the shared Session is dispatched through the Gateway like a prompt: the policy admits it while the share's tier is established and the Session is confined, and the owner's own Session controller stops whatever turn that Session is running, the owner's included. The general Peer, principal, and remote-access design is in [Peer principals and remote access](../../implemented/architecture/2026-10-12-peer-principal-and-remote-access.md).

A confined file tool resolves every path its own arguments declare, checks that the granted root contains each result, and hands the deployment's tool that canonical path; a pathless search uses the Session's working directory, which the replacement checks like a named path. A bounded edit or write performs the same containment check and then edits or writes through the filesystem backend with the Session's current sandbox policy and the normal observation policy.

### Keeping one branch across retries

One fork request binds its viewer, share, source, operation identity, and completed prefix. The Owner reserves that operation durably before creating a child, and records the child the owner's fork answer returned; a retry of a recorded operation replays that answer instead of forking again. A different prefix under the same identity is refused. The owner's `SessionForkRequest` mints the child id, so the Host sends no child identity: a host that dies after the child was created but before the operation was recorded cannot name that child on retry and creates a new one. Closing that window needs a Session Controller request that accepts a caller-supplied child identity. The inherited prefix stops before unrelated queued input; only immediately following request metadata is retained. Revoked children keep their logs but cannot resume with broader access, and removing a share does not expose the source Session's unrestricted tools.

### Who the owner is

A share can only be created by a verified owner. The dialog shows the identity the owner's DSH read back — name, expiry, when it will renew — and uses a label derived from the identity when there is no display name. The code that creates the share refuses an unverified owner as well, so the question is not settled by whether a button was clickable.

Signing in happens once, in a window the page opens while the owner clicks. The DSH creates a short-lived transaction tied to the Liveshare server address, to the Liveshare server instance, and to the page allowed to finish it; the page opens the sign-in page the DSH names, accepts one one-time code only from that exact origin, window, and transaction, and hands it back to its own DSH.

The Owner redeems the code with the verifier it retained, stores the credential with owner-only permissions, and sends it only to the Liveshare server address that issued it. New registration requires that verified credential; existing-share reconnect uses the share's management token, and explicit identity claim preserves the share's ACL, mode, expiry, and token. A share's named colleagues are the owner's stored selection plus the deployment's own allowlist; nothing is derived from a display identity.

### What the reader sees at the top

The served page reuses the sidebar's existing brand row instead of adding a bar on top of the app: the usual Harness mark, plus a LiveShare entry that names who shared the session and which DSH version they run, with the Liveshare server's own release labeled separately. Clicking it returns to the page listing the shares you can open.

### When the connection breaks

A reader's feed can fail: a stream disappears, the Liveshare server cancels a request, a read times out. The page retries only the failures that are defined as repeatable, and stops for good on authentication, permission, and missing-share errors, showing the reason instead of reconnecting forever.

### How the served page is exercised

The page a viewer opens is the owner's own Web page. The Liveshare server asks the owner for its rendered index document, places a short carrier script at its top, and passes the page's shell assets and plugin bundles through from the owner, so the page runs every owner plugin at the owner's version. The carrier only turns the page's calls and streams into reads over the Liveshare server's channel; the Liveshare plugin itself recognizes a viewer page and mounts the viewer surfaces instead of the Share action. The owner renders that index with the reader's own access snapshot in place of the owner baseline, and the page then follows the reader's `remoteAccess/follow` snapshot; no other read carries a reader's grants.

The viewer page is tested in-process: the test assembles the page from the carrier, the shell, and the client plugins including Liveshare's, stands in for the Liveshare server's read channel, and answers the page's reads from a scripted owner, so the assertions see the real shell, carrier, and presentation plugins.

### What the package exposes

The package ships one Host program and one browser face. Its public entries are the Host export (`lib/index.js`), `./client` (`lib/client.js`, a closure-factory bundle), `./viewer-declarations`, the share-management Remote's `./typert` and `./remote` faces, `./types`, the bundle patch `./cordis.patch.yml`, and the locale JSON files. The manifest declares the browser face as `dsh.client` with `platform: web` and the client services it needs; that face reads `__DSH_LIVESHARE_VIEWER__`, mounts the viewer session plugin and its brand, model, permission, session-row, and share-path surfaces on a served viewer page, and otherwise mounts the owner's generated Remote before the Session-header Share action.

Share management is one `liveshareShares` Typert Remote with twelve methods — `create`, `list`, `stop`, `updatePermissions`, `setCapabilities`, `capabilities`, `relay`, `setRelay`, `identity`, `audit`, `testRelay`, and `testPublish` — over the operations the owner host runs. The only same-origin HTTP routes left are the four owner sign-in and credential routes: `/api/liveshare.ownerLoginStart`, `/api/liveshare.ownerLoginRedeem`, `/api/liveshare.ownerLoginCancel`, and `/api/liveshare.ownerCredential`.

The outgoing gateway is a supervised child process whose source entry is `src/owner-gateway/cli.ts` and whose published entry is `lib/owner-gateway/cli.js`; the directory name keeps it distinct from the DSH API gateway.

## Alternatives considered

- **Build a separate read-only page instead of serving the normal client.** Rejected: reading needs browsing, grouping, and selecting, so a second page would have to rebuild all of it and would quietly lose the navigation the product keeps.
- **Decide each button's availability where the button is.** Rejected: every entry reads one access snapshot the owner computes, so a screen added later cannot quietly reintroduce an action the reader may not perform.
- **Let the reader's page decide its own access.** Rejected: only the owner and the service decide what a share grants; the page states what it was told.
- **Treat an older share with no mode as writable.** Rejected: that would hand a reader access the owner never configured, so a share without a mode is read-only.
- **Put the sign-in code in the page address, or read the credential from the popup's cookies.** Rejected: addresses leak through history, referrers, and logs, and a page should not hold credentials.
- **Show the service's own error text when the page cannot explain a refusal.** Rejected: that text may contain a file path, a credential, or another reader's session, so the page shows the stable reason it can vouch for.
- **Put execution restrictions only in editable configuration or a sandbox mode.** Rejected: a child can change configuration, and per-call execution choices can outrank a mode. The real operation needs a monotonic guard and a verified implementation.
- **Check a model-supplied path only before dispatch, or globally constrain every filesystem read.** Rejected: a pre-dispatch check is separated from the tool call by other listeners, while a global read rule would also constrain unrelated Owner work. The containment check runs inside the authorized Session's own read and write.
- **Reuse the deployment's default root or copy the entire source tail into a child.** Rejected: both can include files or pending input the viewer was never granted.
- **Use a deployment-wide secret or self-reported display fields as owner identity.** Rejected: neither identifies the logged-in person who approved this publication.
- **Keep three tiers.** Rejected: `view` and `fork-readonly` differ only in whether the reader can branch and drive a child, which is already the independent fork switch. A third mode duplicates that switch and lets the two answers disagree.
- **Keep a per-share attachment-upload switch.** Rejected: an attachment is part of a prompt on a Session the reader can already see. The separate switch duplicated visibility and could only subtract from it, while the upload role already rides the read role.
- **Attribute every turn to a requester and exempt the owner's own turns.** Rejected after it shipped, then narrowed: persisting a turn's requester needed a Host-only projection over message sources, a turn-boundary read per execution, and a re-check of the share that admitted each turn, and it still had to fail closed on mixed or unestablished requesters. The shipped design keeps only an in-memory marker for the running turn — `agent/pre-step` reads the entering principals and the guard reads that answer — so an owner-started turn keeps the Session's native tools without adding a Session event. The accepted cost is that an owner's steering input inside a viewer's turn stays confined; a viewer message that reaches a later step narrows that turn.
- **Let each tool name its own tier or sandbox.** Rejected: the tier belongs to the share. A per-call choice would let one execution outrank the grant that admitted it.
- **Test the bundle's `enabled` flag directly.** Rejected: it would keep the code smallest, but the patch route starts the bundle's plugins while leaving the bundle unselected, so the card would stay hidden exactly when its plugins started, contradicting the product rule.
- **Derive effective enablement in the Host.** Rejected: `listBundles` could report a new or redefined effective state, but that would change a cross-package contract for one client-only presentation rule and invite every bundle consumer to reinterpret `enabled`, which must keep meaning "selected in the profile".
- **Ship LiveShare outside the installation's optional bundles.** Rejected: that would make it visible nowhere by construction, but the package must still ship as an npm package with the release and be installable, and it would also remove the bundle from the Host's list entirely, taking the details entry with it.
- **Keep the colleague picker, or replace it with a directory-backed selector.** Deferred: naming a colleague needs an identity directory the Liveshare server does not provide, so the dialog cannot offer a choice it can verify. Stored `selected` and `approval` records keep working through their ACL, and the creation entry point stays retired until a directory contract exists; `liveshareShares.create` keeps its fields for those records and direct Remote callers, so this defers the API rather than deleting it.

## Verification

- A reader's page keeps the normal navigation, and no action the reader may not perform appears on the shared session or on any branch.
- A DSH without the Liveshare bundle, and the owner's own page, behave exactly as before.
- A share uses one of two tiers and that tier's sandbox; unknown modes, unreadable answers, and shares without a mode stay readable but are never driven.
- A share cannot be created without a verified owner identity.
- A share created from the dialog carries `open`; a stored `selected` or `approval` record keeps its recorded ACL and access summary, and `create` still stores a requested `selected` mode with its subjects.
- Sign-in accepts one one-time code from the transaction's origin, window, and state, and nothing else; a failed or abandoned attempt discards the transaction, and no credential, cookie, or code reaches a URL, storage, or a log.
- Real Controller, ToolRuntime, filesystem, and profile tests cover fork identity, cold enforcement, bounded execution, revocation, and normal cancellation. The built viewer must use its real POST carrier and Owner authorization handler; deterministic display fixtures do not replace execution or persistence tests.
- Generated API documentation and both SDK projections remain aligned with the `user-rpc` source principal, which only the `agent/pre-step` admission check consumes.
- `ViewerSessionMode` has two members, and a persisted `fork-readonly` record is rejected when the owner state loads.
- A `view` share drives the source Session, refuses file writes and out-of-grant reads, and can fork when `allowsFork` is set.
- `fileUploads/upload` is allowed on every Session the reader can see, for every tier and fork combination.
- Source tool decisions read only the Session's mounted layer: the guard permits this installation's confined replacements for the read and search surface and the no-effect tools, plus bounded `edit` and `write` on a writable Session, and refuses every other name, with no turn, requester, or origin consulted.
- Unit and real-runtime tests cover the tier policy, confined reads and writes, fork ceilings, the layer's installation and release, and the pre-step admission check over the durable message source.
- The plugin-manager component tests hold the bundle out of both lists while its declared rows are off, list it once a declared row runs, and still open it by bundle ID while it is hidden; the recorded goldens and the refresh card count move with that rule.

## Consequences

The reader's page can only be as accurate as what the service tells it. Capability answers, the owner's identity status, the session mode, the owner's DSH version, and the sign-in endpoints all come from the owner's DSH and the Liveshare server; until those are deployed together with this layer, the page stays at its most conservative setting — read-only, with a sign-in that cannot complete — rather than guessing.

The page is not a security boundary. The owner's DSH and the Liveshare server refuse a reader's writes no matter what the page does; the access snapshot exists so the page does not offer actions that would only be refused.

Existing ACLs are retained. A record without a mode is readable but not driven, and contradictory mode fields are refused. Unattributed shares are shown as unverified history.

Owner reconnect state is atomically replaced and queued within one process, but multiple processes sharing one file can still lose updates or compete for a gateway. Cross-process execution ownership is unresolved; atomic replacement alone is not a transaction or a route claim. Containment is checked by path: a local process that replaces a directory inside the grant with a symlink between the check and the open can redirect a viewer's read, or a write elsewhere within the sandbox's writable roots. Operations anchored to a directory handle would close this window and are left to a separate change. Final viewer-artifact and SDK snapshot evidence remains required before release.

A `view` share is not watch-only: it runs the reader's prompts and tool calls inside the read-only sandbox. A deployment that wants a passive reader has no separate mode and must rely on the reader not sending prompts rather than on a tier name. Fork reach is the only independently switchable action; attachment upload cannot be disabled separately.

The sandbox reaches the owner's own turns too. While any share over a Session is active the owner can only read inside the granted workspace, and can write only when some share allows writing; a share that is merely published — even one nobody is using — therefore changes the owner's own tool surface until it is stopped or expires. Cancellation has no attribution either: a reader's stop ends whatever turn the shared Session is running.

The default cards list, the More page, and their recorded goldens lose one card, and the manager's refresh card count drops by one. A person who only knows the plugin page cannot discover LiveShare or switch it on from that page; the package README owns the two enable routes instead. A bundle enabled through the patch route shows its card with the switch off while its rows run, because the switch reflects the profile's bundle selection and writes that selection; the documentation states the two routes and this difference. The rule covers one explicitly named bundle rather than a manifest flag, so adding another hidden-until-running bundle, or retiring this one, is a one-line set edit with a test and docs update.

Shipped creation produces organization-link shares only: the Share dialog sends neither `accessMode` nor `allowedSubjectIds`, so every new share is `open`, and the deployment's `LIVESHARE_ALLOWED_SUBJECTS` is the only subject-level narrowing a new share can carry. Stored `selected` and `approval` records keep working and keep their access summaries, and the create fields stay on the Remote for those records and direct callers while no UI exposes them.

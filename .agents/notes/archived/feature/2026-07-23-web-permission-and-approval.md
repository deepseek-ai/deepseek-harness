# Agent Note: Web UI permission presets and approval answering

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-23-web-permission-and-approval.zh.md)

## Problem

The web host booted an unconfined agent: `bootHost` composed `dsh-bash-local` and `dsh-fs-local`, so every web session ran with full file access, no approval channel, and no permission control — while the ACP composition had shipped the complete sandboxed product path (sandbox provider + policy home + confined shell/fs + approval + presets) for months. The web wire contract had already reserved the seats — `approval/requested`/`approval/resolved` mux frames, `POST /api/respond` with `ApprovalResponsePayload`, client-side `pendingBuffers` — but the host `respond` was a stub, no answerer bridged `ctx.approval` to the stream, no RPC exposed the permission select, and the PendingCard rendered approvals as visible-but-unanswerable.

## Decision

The web host composes the same sandboxed product path as the acp-agent composition: `dsh-sandbox-local`, `dsh-sandbox-policy`, `dsh-bash-sandbox`, `dsh-fs-sandbox`, `dsh-user-approval`, and `dsh-permission-presets`, with `BootHostOptions.sandbox` supplying the deployment defaults (`mode`, default `workspace-write`; `approvalPolicy`, default `ask`).

`createApiProxy` owns the approval pending registry. Its `approval/request` waterfall answerer reads the approval id from the session's just-appended `approval/asked` audit event (an ask with no audit event is a foreign channel and delegates), mints one stable rpcId per question, broadcasts the answerable `approval/requested` frame to every open mux stream, and replays still-pending frames verbatim on each mux open — the refresh-recovery baseline the contract already promised. `respond` routes by the echoed rpcId, validates `ApprovalResponsePayload` with the existing zod schema, cross-checks the payload's audit correlation against the routed entry, resolves the answerer, and broadcasts `approval/resolved`; the ask's abort signal withdraws the question as `cancelled`.

The permission select rides two new unary RPCs, `session.permissions` and `session.setPermission`, projecting `ctx.permissionPresets` into a protocol-owned `PermissionOption` DTO (the ACP bridge precedent: each protocol owns its presentation shape). A permission-less composition serves an empty select and clients hide the control. Idle switches are held last-write-wins in a proxy-side pending map and flushed on `agent/pre-step`, because knob events must stay turn-enclosed for durable replay; the shared `hasOpenTurn` fold moved to `dsh-session` and replaced the private copies in `dsh-user-approval`, the ACP bridge, and the proxy.

Client-side, `Session` gained `permissions` and `setPermission`, and approval answering rides the runtime's `PendingWait` carrier. Per the designer draft, a pending approval takes over the composer: `ApprovalPanel` registers as a selector-routed entry of the conversation-declared `conversation.composer` chain (the ui-user-questions pattern), replacing the InputBar with the justification headline, the paired command, and one-shot refuse/allow buttons; the `PendingApproval` domain face in ui-conversation's contract owns the `ApprovalResponsePayload` wire encoding over the carrier, and the broadcast resolved frame settles the wait and restores the composer. Pending questions take over through ui-user-questions, including the `plan-review` decision shape. The sidebar mirrors every blocked interaction with an amber warning dot that outranks the running ring, including during search: the manager tracks per-session approval and question request identities rather than reading Session instances, classifies only requests satisfying the plan-review composer's binary rendering constraints as plan reviews, and presents the first pending question ahead of concurrent approvals to match composer routing. Pre-instantiation buffering retains each live request identity, replaces replay duplicates, and removes resolved requests so sidebar status never outlives the answerable `PendingWait`; tracking clears per connection generation so reopen replay is authoritative. Sessions never instantiated still light their dot. The composer's bottom-row chip hosts the `PermissionSelect` control fed through the conversation inject face. The connection fixture mirrors the host: its resident approval is answerable once, and its permission select persists per session.

## Alternatives considered

**Reuse the ACP `session/set_config_option` shape on the web wire.** Rejected: the web contract's unary method registry (`RpcMethodMap` + per-method zod schemas) is its own dialect; a generic config-option surface would bypass the compiler-locked schema table for one select. A dedicated method pair keeps both sides derivable from the signature.

**A session event for pending interactions instead of the live registries.** Rejected: answerable requests are transient interaction state, not durable session data — approval's `approval/asked`/`decided` audit pair already logs its durable half. Persisting requested frames would re-ask dead questions on replay.

**Registering the answerer only when a mux subscriber exists.** Rejected: the pending entry must survive client disconnects (refresh recovery is the point), so the registry outlives any one stream; a subscriber-gated answerer would fail asks closed during a reload window.

**Optimistic card removal on click.** Rejected: the broadcast resolved frame is the truth; removing on click would hide a question that a rejected receipt or transport failure left standing. The panel disables its buttons locally and re-arms them on failure instead.

## Consequences

Web sessions start confined (`workspace-write` + `ask` by default), and a sandbox-denial escalation reaches the browser through the approval channel. The deployment can widen or narrow the default through `BootHostOptions.sandbox` without touching the assembly. Question answering uses the same registry pattern (ui-user-questions over the question pending table), and Session navigation identifies approval, plan-review, and ordinary question waits before the user opens them. The permission select reads once per mount; live refresh from another client's switch is deferred. Coverage includes proxy registry and permission RPC suites, session-object and fixture suites, and the keyless Web smoke for approval answering and preset switching.

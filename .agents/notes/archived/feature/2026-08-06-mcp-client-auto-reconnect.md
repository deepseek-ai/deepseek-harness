# Agent Note: MCP client auto-reconnect with bounded backoff

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-mcp-client-auto-reconnect.zh.md)

## Problem

The [MCP client](2026-07-07-mcp-client-plugin.md) connected once at plugin load. When a stdio server crashed or was killed, its registered tools stayed visible but every call failed with `Not connected` until a human edited the config (HMR) or restarted the Host — the connect-once decision explicitly deferred reconnection. Long-running hosts (ACP automation, web) cannot be bounced because a child process died, and for stdio the harness composition is the only party that can respawn it. External feedback escalated this as a real operational gap (issue #1746).

## Decision

`packages/mcp/mcp-client/src/connection.ts` owns a per-instance connection supervisor; `apply()` shrinks to config resolution plus two effects (the `serverName` reservation and the supervisor's lifecycle). The supervisor owns the client/transport generations, the live tool registrations, and the reconnect loop.

**Trigger.** The supervisor arms `client.onclose` per generation. The SDK fires it when the stdio child exits, so a crash is observed without polling. `StreamableHTTPClientTransport` fires `onclose` only for deliberate closes — it owns its internal SSE-stream recovery and surfaces request failures per call — so HTTP servers are effectively outside supervisor restarts; the package README records that limitation.

**Generations without interleaving.** Each attempt builds a fresh transport and `Client` (the SDK binds a Protocol to one transport for life). One per-supervisor queue serializes every `syncTools` call — initial syncs and `list_changed` re-syncs across all generations — and an `isCurrent` fence makes stale generations inert, so no two syncs can interleave the dispose-previous/register-next swap (which would double-dispose one generation and leak another). The queue also closes a pre-existing race where two rapid `list_changed` notifications re-synced concurrently. The activation attempt, rather than the first queue entrant, explicitly owns strict startup registration: an early `list_changed` notification uses contained re-sync semantics and cannot consume `failOnStartupError`. Failure signals are idempotent per generation: a connect rejection racing its own transport close schedules exactly one retry. A failed attempt cannot enter backoff until both `Client.close()` settles and the transport reports `onclose`, which for stdio proves the child exited; a missing close signal stops reconnection after the SDK's bounded termination window instead of allowing two server processes to overlap. Disposal uses the same bounded close-signal barrier and reports an incomplete shutdown without ever restarting.

**Bounded backoff with an outage budget.** Delays double from `initialDelayMs` up to `maxDelayMs`. One outage shares `maxAttempts` consecutive failed attempts; exhaustion unregisters the server's tools, logs at error level, and stops until disposal or reload. A connection that survives past the stability window — `maxDelayMs`, derived rather than a fifth tunable, as the longest configured backoff spacing — resets the budget, so an occasionally-crashing server recovers indefinitely while a crash loop whose connects briefly succeed cannot launder its budget into a restart storm.

**Config and resolution.** Both transports accept `reconnect { enabled, initialDelayMs, maxDelayMs, maxAttempts }` with schemastery defaults (on, 500ms, 30s, 10). `resolveReconnectPolicy()` is the explicit resolve step: it re-judges every bound and cross-field constraint because programmatic construction may bypass Schemastery, and misconfiguration fails the plugin instance at load.

**Observable states.** An initial or retry-attempt failure says `connection failed`; an established generation ending says `connection lost`. Retrying logs at warn with attempt count and delay, recovery at info, final failure and disabled recovery at error. During an outage the last good generation stays registered and calls against it fail — deterministic public names mean a recovered unchanged tool list reproduces identical definitions, keeping the model-visible schema prefix stable instead of flapping. With `reconnect.enabled: false` a lost connection keeps the connect-once manual-recovery behavior.

**Disposal.** Dispose flips the fence, cancels any pending timer, closes the current client, then awaits the in-flight attempt and the sync queue before unregistering — quiescence, not just a request to stop. The reconnect timer is unref'd so a waiting backoff never holds a finishing process open.

## Alternatives considered

**Consecutive-failure counter that resets on every successful connect.** Rejected: a crash-looping server whose connects briefly succeed would reset the budget each cycle and restart forever — exactly the restart storm the failure cap exists to prevent. The uptime-gated reset distinguishes a recovered server from a looping one without new configuration.

**Reuse one SDK `Client` across reconnects.** The Protocol clears its transport on close and can technically connect again, but the SDK's own guidance is one connection per Protocol instance, and reuse carries notification handlers and negotiated capability state across server incarnations. A fresh `Client` per generation plus the `isCurrent` fence is unambiguous.

**Unregister tools immediately on disconnect, re-register on recovery.** Rejected: a transient outage would flap the model-visible tool list (two schema-prefix invalidations per crash) for no information gain; failing calls already signal the outage, and the swap on recovery is atomic per generation. Tools are unregistered at final failure so a permanently dead server does not leak permanently broken tools.

**Route Streamable HTTP request failures into the supervisor.** Rejected: the HTTP transport already reconnects its SSE stream with its own backoff, per-request errors do not imply a dead server, and there is no child process the harness could respawn. Transport close stays the single trigger.

**Restart through Loader/HMR machinery instead of an in-plugin supervisor.** Rejected: the Loader owns config-driven recomposition, not runtime health. A plugin restarting itself through the Loader would conflate config generations with connection generations and lose the per-outage budget.

## Testing

Unit (`tests/reconnect.spec.ts`, mocked SDK): recovery swaps generations without duplication or leaks and serves post-recovery calls, diagnostics distinguish initial or retry failure from established connection loss, strict startup registration survives a pre-connect `list_changed` notification, failed initialization waits for the old generation's close signal and fails closed when that signal never arrives, disposal waits for the same signal with a bounded incomplete-shutdown path, the failure cap unregisters tools and stops, dispose cancels a pending backoff and quiesces an in-flight sync, a close after dispose schedules nothing, disabled mode keeps manual recovery, the stability window resets the budget while a crash loop exhausts it, double failure signals schedule one retry, stale generations and handlers are inert, and `resolveReconnectPolicy` rejects each invalid bound. E2E (`tests/mcp-client.e2e.ts`, keyless): the fixture server gained a `crash` tool that replies then exits; real-process tests prove a stdio crash recovers end to end and that unloading the plugin mid-outage stops reconnection promptly. Snapshot: deliberately none, per the original note's rationale — reconnection adds no new presentation shape, and a snapshot composition spawning a crashing server would make replays timing-dependent.

## Consequences

- A crashed stdio MCP server recovers without human intervention: bounded backoff, re-discovery, atomic generation swap. Default policy retries an outage for roughly 2.5 minutes before giving up.
- Connection state is genuinely more intricate than connect-once. The design accepts a partial-availability window with registered tools failing during an outage, concentrated in one module with the invariants named.
- `reconnect` is new config surface on both transports, and the stability window is deliberately derived from `maxDelayMs`; making it independently tunable is a compatible future change.
- After final failure or with reconnect disabled, the plugin stays loaded with no (or failing) tools until reload — deliberate and logged, so a chronically broken server cannot restart forever.

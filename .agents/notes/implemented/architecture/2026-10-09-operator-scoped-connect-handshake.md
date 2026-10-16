# Agent Note: Peer-scoped connect handshake

Status: implemented

English | [中文](2026-10-09-operator-scoped-connect-handshake.zh.md)

## Problem

Automatically subscribing automation clients to forwarded events lets method-only callers receive and answer human interactions. CLI and MCP callers need independent participation and cleanup without changing browser authentication or assigning per-browser identities.

## Decision

Browsers retain their existing signed Cookie, root launch-token exchange, shared `connection.browserPeer` with owner principal and `interactions: 'answer'`, and recovery behavior. Only API callers create independent Peers through `GET /connect?token=<launch-token>&interactions=answer|none`. The endpoint is API-only, defaults to `none`, rejects invalid or repeated declarations with 400, and retains Host/Origin checks and token authentication. It returns 302 with the Remote Mux destination and an API Cookie.

### Admission and ownership

- Connect publishes the API Peer before returning. Its signed API Cookie carries the authority, Peer id, and issue/expiry interval; interaction participation belongs to the live Peer, not another credential field. Browser v1 Cookies remain valid and always select the shared Peer. API v2 Cookies select only an existing independent Peer.
- HTTP validates the Cookie and finds its Peer without waiting for a WebSocket. Connect, HTTP, and WebSocket require no cross-transport readiness ordering.
- One API lifecycle WebSocket owns the Peer. Duplicate attachment is refused; closure removes the Peer before asynchronous disposal completes. Later HTTP and reconnect attempts using that API Cookie are refused. A fresh connect is caller-owned.
- Already-admitted unary requests retain their request-level cancellation semantics. Closing the lifecycle socket does not cancel independent HTTP requests or accepted Session work.
- Browser sockets never own the shared Peer. Refresh, concurrent tabs, repeated launch-URL visits, and Host restart require no per-browser Peer restoration or credential reuse machinery.

### Accepted retention

An API caller may exit after connect without establishing its WebSocket. If it has performed no other work, its Peer retains only lightweight identity, scope, and registry state, not a socket, subscription, or background job. It may remain until Host shutdown. No initial-connect deadline, idle sweep, or in-memory expiry timer exists; Cookie expiration is checked on admission independently of record retention. Repeated abandoned connects accumulate lightweight records, an accepted cost for authenticated local callers. Actual operations still own cleanup of resources they acquire.

### Events and Client scope

The Client creates forwarded-event machinery only for `answer`. The Host checks `peer.signal.aborted` first, then `peer.interactions` at both `$events` and `$events/result`: `none` refuses both regardless of principal. An answering owner receives forwarded waterfalls and may reply only through the same Peer as the stream; an answering non-owner receives only RBAC-authorized broadcasts and cannot reply to waterfalls. Only active owner answering streams count as live answering clients. Browsers remain one shared answering party; distinguishing browser credentials from each other is deliberately unsupported.

Non-page Clients supply HTTP and WebSocket transports using the same API Cookie and Host base URL. Passive clients open their lifecycle socket independently of unary calls and may call generated raw stream methods. They do not use `$stream()`, the browser-generation recovery helper: it rejects immediately in `none` mode. Raw stream failure is terminal; the caller owns any new connect and retry. Existing answering-client generation behavior and Host fact delivery remain unchanged; there is no additional API recovery subsystem.

## Alternatives considered

**Independent Peers for browsers too.** This adds credential identities, restart reconstruction, and repeated-login reuse to preserve tabs. Browser callers can remain one party, so the original browser model stays intact.

**Publish only after upgrade or require Mux readiness before unary.** Both reject or delay valid HTTP that arrives first. Connect is the publication point.

**Deadlines and pending/bound activation states.** They reclaim lightweight idle records at the cost of timers and transition races. Unused Peers may remain until shutdown.

**Adapt browser stream recovery to passive callers.** This spreads interaction mode into generation-aware stream consumers and their tests. Raw streams already support CLI/MCP calls; passive callers manage failure themselves.

**Client-only events switch or Host-global configuration.** Neither enforces independent participation. The authenticated Peer supplies the mode checked by the Host.

## Verification

Connection tests cover API publication, Cookie verification, idle retention, socket ownership, and unchanged browser admission. The [Loader tests](../../../../packages/api/gateway/tests/operator-connect.host.spec.ts) cover HTTP before WebSocket, duplicate attachment, prompt removal during slow cleanup, unary cancellation independence, and event refusal/ownership. [Node Client tests](../../../../packages/api/gateway/tests/authenticated-node.client.spec.ts) cover authenticated transports, delayed socket establishment, and raw streams without passive recovery.

The [recorded approval scenario](../../../../apps/web/tests/approval-composer.e2e.ts) adds a passive caller alongside the answering browser. Full replay requires a usable command sandbox for its file-writing operation; local environments without one cannot validate that final step. No Session format or model-visible input changes.

## Consequences

Unconnected API records need not be promptly reclaimed; resource-heavy additions to idle Peers require revisiting that choice. API Cookies cannot restore a Peer after its socket closes or the Host restarts. Browser Cookie format and authentication behavior remain unchanged, with no reauthentication migration. API and browser Cookies use the same authority-specific name, so API callers keep their own Cookie storage rather than exchanging credentials in a shared browser jar. Any launch-token holder may request `answer`; this is interaction participation, not user isolation.

The [duplex-stream decision](2026-09-19-remote-duplex-stream.md) retains Peer scopes and stream framing. The [browser authentication decision](2026-08-24-browser-token-authentication.md) retains browser token, signature, authority, and lifetime semantics; only independent API admission is added here. Both records remain active.

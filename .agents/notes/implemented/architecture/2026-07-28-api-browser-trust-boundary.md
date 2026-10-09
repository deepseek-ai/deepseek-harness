# Agent Note: One carrier-level browser-trust boundary for all `/api` routes

Status: implemented

English | [中文](2026-07-28-api-browser-trust-boundary.zh.md)

## Problem

The web GUI host serves `/api` over plain loopback HTTP (default `127.0.0.1:3080`; the CLI rejects `--host 0.0.0.0`), and the surface includes remote-code-execution-grade methods — `session.prompt` drives an agent that runs bash. A browser turns the operator into a confused deputy against such a local API in two classic ways: a malicious page fires a "simple" cross-site POST (`text/plain` — sent without a CORS preflight) whose side effects execute even though the response stays unreadable, and a DNS-rebound origin talks to the socket as if same-origin, making CORS inapplicable entirely, with only the `Host` header betraying the attacker's domain. Before this decision the system's only browser-trust check (`isTrustedNativeDialogRequest`: loopback socket + same-origin + loopback Host) guarded exactly one cosmetic route — `host.pickDirectory`, whose native dialog pops on the host's screen — while every consequential method was unguarded. Guarding per-RPC also could not survive the in-app directory browser, whose whole point is serving legitimately remote clients that a loopback rule would refuse.

## Decision

Enforce browser trust once, at the carrier, for the entire `/api` prefix — two halves:

- **Media-type fence (dsh-client-connection)**: every `/api` POST must declare `application/json`, else 415 before parsing. Cross-site "simple" requests thereby stop existing: any cross-site attempt is forced into a CORS preflight this server never answers.
- **Authority fence (dsh-client-connection, `src/api-request-trust.ts`)**: every request must present a `Host` that is loopback or matches a `trustedHosts` entry (exact on `host:port`, any port on port-less entries, WHATWG-normalized; rebinding defense). Deliberately no shortcut for unmarked requests: over plain HTTP a browser attaches neither `Origin` nor Fetch-Metadata to reads (EventSource, images, navigations — those headers go only to trustworthy destinations), so an unmarked request may be a rebound browser read whose response the page can read, and Host is the one header rebinding cannot forge; non-browser clients pass via loopback, a declared authority, or the listener's own bind literal that [Bind one concrete Web address](2026-09-19-concrete-web-bind-address.md) admits. An attached `Origin` must equal the Host authority; `sec-fetch-site: cross-site` is refused outright. A `trustedHosts` entry that is not a bare, canonical authority fails the plugin load — WHATWG parsing would otherwise quietly authorize the hostname inside a typo or broaden an exact-port grant. `host.pickDirectory` loses its bespoke guard and rides the same fence.

Reachability is the webserver binding's policy (`host`; [Bind one concrete Web address](2026-09-19-concrete-web-bind-address.md) owns which literals it accepts), and this fence is a confused-deputy defense rather than identity. Connection applies the separate [browser token authentication](2026-08-24-browser-token-authentication.md) after the fence. The fence does not inspect peer socket addresses: binding expresses reachability, `trustedHosts` names accepted authorities, and the socket address adds nothing the Host/Origin checks need.

`HostConnectionHandle.allowsRemoteAuthorities` projects whether any validated `trustedHosts` entry names a non-loopback hostname: a loopback listener behind a proxy can still serve remote browsers, so the directory picker requires a policy without remote authorities before it picks the native chooser.

## Alternatives considered

- **Per-RPC guards (status quo extended).** Rejected: the guard list trails the method list forever, the highest-value methods were already unguarded, and a loopback rule on browse RPCs would break the remote deployments they exist for.
- **CORS headers + credential omission.** Rejected: we never want cross-origin reads at all, so answering preflights only widens the surface; refusing them is strictly stronger and simpler.
- **Authentication tokens.** Rejected for this change: token minting, storage, and rotation are separate product decisions. The later [browser token authentication](2026-08-24-browser-token-authentication.md) owns them without changing this fence.

## Consequences

- Any future `/api` method is covered by construction; there is no per-route trust decision left to forget.
- A non-loopback listener accepts its own bind IP directly ([Bind one concrete Web address](2026-09-19-concrete-web-bind-address.md)); other remote authorities require configured trust. Every accepted authority still requires browser authentication. `--trusted-host` extends only the Host/Origin fence and grants no identity.
- Clients must label POST bodies `application/json` (ours always did; raw-fetch tests gained the header).
- Host and Origin remain request-routing evidence only. The process token and signed cookie establish the browser identity used by every Host method.

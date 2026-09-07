# Agent Note: Explicit web bind address

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-22-web-bind-address.zh.md)

## Problem

The Web application can run commands with the Host user's authority. Same-machine use needs only loopback reachability, while an all-interface CLI mode would imply a supported network deployment without TLS or a defined proxy contract.

The HTTP carrier also hides the bind address inside `startWebServer()`, so alternate shells cannot state their own network policy at the package boundary.

## Decision

`dsh web` binds `127.0.0.1` and rejects `--host 0.0.0.0`; the CLI exposes no network mode. The process-token and browser-cookie authentication does not broaden that deployment contract ([decision](../architecture/2026-08-24-browser-token-authentication.md)).

`WebServer` still requires `host: '127.0.0.1' | '0.0.0.0'` and passes it to `node:http` without a fallback. The generic carrier leaves custom composition policy visible at its package interface; the product CLI owns the stricter loopback choice.

## Alternatives considered

**Keep `0.0.0.0` as the default.** Rejected because ordinary same-machine use does not need network-wide reachability and should not acquire it implicitly.

**Use a boolean exposure flag.** Rejected because `--host 0.0.0.0` names the resulting socket behavior directly and matches the underlying server option without introducing a second term.

**Keep an explicit `--host 0.0.0.0` mode.** Rejected because authentication alone does not supply TLS, forwarding semantics, or a supported remote-deployment contract for the tool-capable Host.

**Default inside `startWebServer()`.** Rejected because the carrier has multiple possible shells and no basis for choosing their deployment policy. Requiring `host` makes the choice visible at every assembly call.

## Consequences

Local `dsh web` starts remain reachable at `http://127.0.0.1:3080`. The CLI exposes no custom interface, all-interface, or IPv6 mode; custom WebServer compositions retain the carrier's two-address choice and own every consequence. Server tests pin both carrier values into Node listen, while CLI tests pin rejection of the all-interface flag.

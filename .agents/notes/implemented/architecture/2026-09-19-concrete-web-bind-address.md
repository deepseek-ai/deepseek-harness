# Agent Note: Bind one concrete Web address

Status: implemented

English | [中文](2026-09-19-concrete-web-bind-address.zh.md)

## Problem

The Web listener accepted `127.0.0.1` or `0.0.0.0`. A wildcard bind exposed every interface of the machine, so the bundle sampled the LAN IPv4 addresses at bind time into a `webRuntime` service and appended them to `trustedHosts`, granting authorities for interfaces the operator never named and mixing inferred reachability into configured trust. A container or workstation that should expose exactly one address had no way to say so, IPv6 addresses were not accepted at all, and a browser dialing the exposed address sent it as `Host` only to be refused unless the sampled list happened to contain it.

## Decision

`webserver.config.host` accepts one concrete IPv4 or IPv6 address literal, loopback by default; the unspecified address in every spelling (`0.0.0.0`, `::`, `::ffff:0.0.0.0`, and their expansions) is rejected when the config loads, and the shipped `dsh web` command refuses the same spellings for `--host` before any consumer activates. An IPv6 `%zone` is kept for `listen`; classification through the exported `isWildcardHost` and `isLoopbackHost` reads the address alone.

The browser Host/Origin fence accepts the listener's own bind IP literal as `Host` on any port, independently of `trustedHosts` and ignoring the zone. A browser dialing that literal presents it as `Host`, the literal is no rebinding target, and the Origin and cross-site checks still apply. DNS names resolving to the address, other interfaces, and proxy authorities still require `--trusted-host`. Connection reads the invocation authorities directly from the `webStartup` provider; the `webRuntime` service and LAN sampling no longer exist.

The advertised URL uses IPv4 for mapped loopback binds, brackets other IPv6 binds, drops a loopback zone, and requires `--public-url` for a zoned non-loopback bind because a zone cannot appear in a URL. A non-loopback bind serves plain HTTP and warns at startup even when an HTTPS `--public-url` fronts it. `web-runtime` is a required startup entry, so a bind failure fails startup instead of leaving a silent listener-less process. Desktop pins `--host 127.0.0.1`, the address Electron dials.

## Alternatives considered

**Keep sampling LAN addresses into `trustedHosts`.** Rejected: the listener already owns the concrete bind address. Sampling grants authorities for other interfaces and mixes inferred reachability with configured trust; direct bind-IP acceptance preserves that distinction without another runtime service.

**Accept the bind IP only on the bound port.** Rejected: a port-less `trustedHosts` entry already matches any port, a proxy on the same address may listen elsewhere, and the port adds nothing to the rebinding defense the Host check provides.

**Keep `0.0.0.0` with a warning.** Rejected: binding every interface exposes remote code execution to every network the machine joins, and the operator can name each address that should be exposed.

## Consequences

An operator exposes exactly the interfaces named by `--host` and reaches the listener through that literal without further configuration; every other remote authority is a `--trusted-host` decision. Compositions that bound `0.0.0.0` fail at load with a message naming the rejected spelling. IPv6-only hosts are supported end to end, including the printed and opened URL.

The [native HTTPS listener decision](2026-09-23-native-https-web-listener.md) supersedes this note's HTTP-only transport assumption. The non-loopback warning applies only without TLS; bind-address validation and authority admission remain unchanged.

## Testing

`packages/host/webserver/tests/webserver.spec.ts` classifies wildcard and loopback spellings and rejects wildcard config; `packages/bundle/web-app/tests/startup.spec.ts` refuses wildcard `--host` before consumers activate; `packages/client/connection/tests/api-request-trust.host.spec.ts` and `node-half.host.spec.ts` admit the bind literal on any port without admitting other authorities; `packages/bundle/web-app/tests/web-app.spec.ts` covers the bracketed IPv6 URL and the plain-HTTP warning; `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts` boots the built profile on a non-loopback and a zoned loopback address; `web-failure-matrix.expected.e2e.ts` and `packages/boot/app-boot/tests/app-boot.spec.ts` report the required `web-runtime` entry.

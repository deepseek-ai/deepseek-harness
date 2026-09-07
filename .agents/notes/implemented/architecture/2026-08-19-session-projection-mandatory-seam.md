# Agent Note: Session projections as a required reader seam

Status: implemented

English | [中文](2026-08-19-session-projection-mandatory-seam.zh.md)

## Problem

An optional projection registry lets a plugin whose host behavior reads projected state activate without that state. Unless the reader rejects the missing registry or key, the host behavior or subagent catalog fields can silently disappear. Batch-only reads also materialize every client view when a consumer needs one host value. Some contributor sites intentionally retain optional `ctx.inject` registration, so their readers need an explicit missing-state rule.

## Decision

This decision builds on the split between host projection state and client views in [Session projection state and client views](../../archived/architecture/2026-08-19-session-projection-state-and-client-views.md).

Every host reader treats the projection registry and its required key as mandatory state. A plugin either declares `sessionProjections` as a required injection or resolves the registry and key explicitly and throws on the first dependent access. Official compositions mount the registry before those plugins. `ApiProxyService` follows the required-injection form; the lower-level `createApiProxy` factory remains tolerant for isolated tests and diagnostics.

A domain contributor may register its unit through `ctx.inject(['sessionProjections'], ...)`. Optional registration controls the child lifecycle only; it does not authorize a reader to substitute a default when the registry or key is absent.

The registry provides `stateOf(session, key)` for one typed host state and keeps `snapshot()` for batch carriers. Client views contain only consumed fields; host readers use `stateOf` for richer state.

`onChanged` publishes client-visible value changes only. Unit registration and removal remain effect-scoped registry lifecycle; `register()` returns the exact Cordis disposer so a composite domain owner can finish cleanup against projected state before removing its unit. Registration changes do not create a second Host event stream or client tombstone protocol. A later authoritative history or list baseline reflects the active key set.

## Alternatives considered

- **Default missing projected state.** This preserves more partial compositions but makes missing host state indistinguishable from a valid empty value. Rejected because official profiles mount the registry and configuration errors must fail explicitly.
- **Require every contributor at activation.** This makes the key set uniform but unnecessarily couples contribution lifecycle to service activation. Explicit first-access failure preserves the optional registration form without allowing silent degradation.
- **Use `snapshot()` for every read.** This keeps one method but computes unrelated wire views and encourages consumers to depend on batch transport data for host logic. Rejected in favor of typed single-key state reads.
- **Send full host values to clients.** This avoids separate view types but exposes provenance and policy knobs that no client consumes. Rejected in favor of explicit cropped views.
- **Broadcast registry additions and removals across Host and mux streams.** The streams have no shared ordering, so clients need tombstones, buffered frames, and baseline retries to reconcile them. Rejected because plugin-key churn does not justify a second synchronization protocol.

## Consequences

- Missing projection composition fails either during activation or at the first dependent host access; it never degrades to a default value.
- Host consumers avoid repeated whole-registry snapshots and log scans.
- Wire payloads exclude host-only fields and per-key watermark wrappers; ordinary baselines communicate the active key set.

# Agent Note: Session projections as a required reader seam

Status: implemented

English | [中文](2026-08-19-session-projection-mandatory-seam.zh.md)

## Problem

An optional projection registry lets a plugin whose host behavior reads projected state activate without that state. Unless the reader rejects the missing registry or key, the host behavior or subagent catalog fields can silently disappear. Batch-only reads also materialize every client view when a consumer needs one host value.

## Decision

This decision builds on the split between host projection state and client views in [Session projection state and client views](../../archived/architecture/2026-08-19-session-projection-state-and-client-views.md).

Every host state owner treats the projection registry and its required key as mandatory state. Owners declare `sessionProjections` as a required injection and await acquisition before exposing service methods; other consumers depend on those services. Official compositions mount the registry before those plugins. `ApiProxyService` follows the required-injection form; the lower-level `createApiProxy` factory remains tolerant for isolated tests and diagnostics.

Owners acquire state through [awaited registration and retained handles](2026-10-12-session-projection-registration-handles.md). That decision supersedes optional first-access acquisition and returning a bare disposer. It preserves the required-state rule here: a missing registry cannot silently produce default host state. Client views still contain only consumed fields; business service methods expose the host data each consumer needs.

`onChanged` publishes client-visible value changes only. Registration changes do not create a second Host event stream or client tombstone protocol. A later authoritative history or list baseline reflects the active key set.

## Alternatives considered

- **Default missing projected state.** This preserves more partial compositions but makes missing host state indistinguishable from a valid empty value. Rejected because official profiles mount the registry and configuration errors must fail explicitly.
- **Require every contributor at activation.** This makes the key set uniform but unnecessarily couples contribution lifecycle to service activation. Explicit first-access failure preserves the optional registration form without allowing silent degradation.
- **Use `snapshot()` for every read.** This keeps one method but computes unrelated wire views and encourages consumers to depend on batch transport data for host logic. Rejected in favor of typed single-key state reads.
- **Send full host values to clients.** This avoids separate view types but exposes producer identities and policy knobs that no client consumes. Rejected in favor of explicit cropped views.
- **Broadcast registry additions and removals across Host and mux streams.** The streams have no shared ordering, so clients need tombstones, buffered frames, and baseline retries to reconcile them. Rejected because plugin-key churn does not justify a second synchronization protocol.

## Consequences

- Missing projection composition fails during activation; it never degrades to a default value.
- Host consumers avoid repeated whole-registry snapshots and log scans.
- Wire payloads exclude host-only fields and per-key watermark wrappers; ordinary baselines communicate the active key set.

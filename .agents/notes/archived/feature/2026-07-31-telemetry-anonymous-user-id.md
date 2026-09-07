# Agent Note: SessionTelemetryBackend anonymous user id ($DSH_HOME/.anonymous-user-id) and the OTel Resource user.id

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-telemetry-anonymous-user-id.zh.md)

## Problem

Session telemetry is mounted by default ([default-mount Note](2026-07-31-web-telemetry-default-mount.md)), but the OTel Resource carried only `service.name`/`service.version` — no user-level identity at all, so the collector could neither aggregate per user nor count active users. The only prior ruling on point was an unimplemented one to derive a user id by hashing the hostname/local IP. The OTel feed needed an anonymous user identity with clean semantics.

## Decision

`getOrCreateAnonymousUserId()` returns the bare UUID line in `$DSH_HOME/.anonymous-user-id` (resolved by `resolveDshHome`, `$DSH_HOME` > `~/.dsh`), minting and persisting a random UUID v4 on first use; the backend constructor carries it as the Resource's `user.id` (the OTel semconv user attribute), once per export batch. The original implementation lived inside `session-telemetry-otel` because no second real consumer existed. `/feedback` later became that consumer, so [the shared-id decision](../architecture/2026-08-07-shared-feedback-telemetry-user-id.md) moves ownership to `@deepseek-ai/dsh-anonymous-user-id` without changing the storage, anonymity, concurrency, or loss semantics recorded here. [Direct DeepSeek request identity](2026-08-11-deepseek-request-user-id-header.md) is a third consumer of the same id.

| Ruling | Value | Rationale |
|---|---|---|
| Id source | Random UUID v4, never derived from the hostname, network address, or git remote | A derived id is reversible, making "anonymous" a fiction |
| Storage form | `.anonymous-user-id`, a bare UUID line plus newline, no JSON wrapper | Identity is a standalone fact, not something filed under one telemetry feed's file name/format |
| IO form | Synchronous IO + a process-lifetime memo keyed by resolved file path | `OpenTelemetrySessionBackend`'s constructor is synchronous (async would reshape plugin loading); one disk touch per process, and mid-run file deletion never affects the running process |
| Concurrent first launch | Settled by an exclusive-create (`wx`) write; the loser rereads the winner's id | Covers common concurrency (a reread landing in the winner's microsecond create-to-write window can still yield one id per process for that run, converging on the persisted value next launch — a telemetry-grade consequence, accepted) |
| Loss semantics | File deleted → next launch mints a fresh id; loss is accepted | An anonymous identity has no recovery value; recoverability demands derivation material, which conflicts with anonymity |
| Write failure | Best-effort: return the in-memory id | SessionTelemetryBackend is never blocked by a read-only home |
| Report position | Resource attribute, not per-record attributes | Once per batch suffices for Resource-dimension aggregation; per-record injection would touch the seam contract and grow the wire |
| semconv dependency | `@opentelemetry/semantic-conventions` is not imported | One string constant does not justify a dependency |
| Home | `@deepseek-ai/dsh-anonymous-user-id`, shared by the OTel backend, `/feedback`, and direct DeepSeek requests | Consumers share one storage contract without depending on an exporter backend |
| Separate switch | None | Any consumer can create the identity; `DSH_TELEMETRY_DISABLED` stops telemetry reporting but does not disable feedback acknowledgement or the DeepSeek request header |

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Hostname/IP-hash-derived id (the prior ruling) | Reversible means not anonymous; the random UUID is semantically clean — the user ruled to supersede |
| user.id on every record's attributes (Claude Code's shape) | Touches the session-telemetry seam contract or injects per record, growing the wire; once per batch on the Resource already aggregates |
| A shared package before `/feedback` needed the id (the first cut) | At that time the only real consumer was the OTel backend; extraction became justified only when direct feedback needed the same correlation id |
| AppCLIEntry reading the id and injecting via config patch | Every surface entry needs wiring; a runtime fact inside deployment config conflates the two |
| Housing it in `@deepseek-ai/dsh-home-paths` | paths is pure path computation with zero IO; a persisting identity capability would pollute the package boundary |

## Consequences

- One `$DSH_HOME` is one stable user in the OTel feed; separate homes are separate users by construction, with no cross-home linking mechanism.
- The OTel feed, `/feedback`, and direct DeepSeek requests share `.anonymous-user-id`.
- Deleting `.anonymous-user-id` resets the identity (effective next launch); on an unwritable home each process holds its own in-memory id until the home becomes writable.
- The [default-mount Note](2026-07-31-web-telemetry-default-mount.md)'s identity follow-up is closed for the anonymous-user-id part by this decision; hostname/surface dimensions, the redaction rule, and the usage-metrics track remain open.

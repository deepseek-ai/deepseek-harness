# Agent Note: Session snapshot envelope projection

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-18-session-snapshot-envelope-projection.zh.md)

## Problem

Committed session snapshots copied the persistence envelope on every body row. The monotonic `seq` and wall-clock `time` fields, or `seq0` and `time0` on packed rows, made a local event insertion renumber or retime a large suffix even when its payloads were unchanged. These fields are required by the durable runtime log, but their repetition made reviewed snapshot diffs describe storage mechanics instead of changed behavior.

## Decision

A committed session snapshot is a projection of the persisted JSONL. The envelope projection leaves its first `session` header unchanged, including `version` and `createdAt`; other fixture normalization may still replace volatile header values such as `createdAt`, `id`, and `cwd`. Every body record retains its discriminant, payload, and other top-level fields, while the projection omits `seq`, `time`, `seq0`, and `time0` when present. Nested fields with the same names are payload and remain unchanged.

Snapshot serialization omits those keys from the parsed body object before writing the line. Snapshot comparison composes ordinary value normalization with that projection, while generic log and stream normalization retains sequence envelopes. Runtime persistence is unchanged.

Replay's existing `parseSessionLog` entry point accepts the projected fixture and assigns missing sequence fields in memory while decoding. Synthetic event times start at zero; packed `data.dt` values retain the relative gaps already stored in the fixture. Projection stays private to each snapshot writer, and replay synthesis stays inside the replay parser. The repository fixture-layout check uses that parser and retains canonical packed rows.

## Alternatives considered

**Change runtime persistence to omit the fields.** Rejected because durable session validation, ordering, and event relationships rely on complete sequence and time envelopes. The instability belongs to the reviewed test representation, not the runtime format.

**Keep the fields and normalize them to zero or positional numbers.** Rejected because every body row would still carry non-behavioral noise, and positional values would still churn after insertions.

**Replace numeric payload references with semantic snapshot identifiers.** Rejected for this change because it would alter event payloads and require event-type-specific projection rules. Payload references remain exactly as recorded; the ordinary contiguous runtime sequence lets replay reconstruct the omitted envelope.

**Introduce a second replay file.** Rejected because the projected session snapshot already retains every payload needed to derive model streams and compare re-persisted behavior. A second fixture would duplicate the transcript and create synchronization work.

**Publish a shared session-snapshot codec package.** Rejected because this change needs no new product or support-tier capability. Writers only delete four top-level fields while serializing, and replay only needs its existing session-log parser to accept the projected representation. A new package and record-level API would enlarge the change and create an ownership commitment without removing meaningful implementation.

## Consequences

Adding, removing, or moving an event no longer rewrites the envelope of every later snapshot row. Snapshot diffs continue to show header changes and all payload changes, including numeric sequence references inside `data`.

The checked-in file is no longer byte-for-byte valid persistence JSONL. Replay consumers must use `parseSessionLog` instead of passing body rows directly to the storage decoder; snapshot writers apply the projection only at their own file boundary. The synthetic time anchor is not historical wall-clock data; only retained packed gaps carry relative timing. Repository migration and write-back paths enforce the projection so a later recording cannot reintroduce the omitted fields.

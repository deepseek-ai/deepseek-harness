# Agent Note: Session-log OTLP strings and bounded requests

Status: implemented

English | [中文](2026-09-25-session-log-otel-byte-limits.zh.md)

## Problem

Session logs contain nested JSON and large tool results. The product collector accepts named records with string content and limits request size; count-only SDK batching cannot bound bytes after UTF-8 encoding and JSON escaping.

## Decision

The shared `otel` Cordis plugin owns ordinary-event and Session-log transport implementations. Business adapters inject it and create independent caller-owned channels; their existing UI/RPC entry points retain authorization, redaction, identity, configuration, and bounded shutdown. Mounting the shared service creates no unused queues. Each canonical event becomes `eventName: "session-log"`, with `sessionId` and JSON-stringified event values in `content`; serialization does not preserve JSONL key ordering. Redaction runs before serialization and the copied envelope excludes the payload.

Session logs use a separate provider and byte/count queue. Each record is measured once with the SDK serializer including a full envelope; the sum conservatively bounds a combined request. Greedy packing avoids full-candidate serialization and recursive re-encoding. Single oversized records receive one diagnostic and do not block later events. One HTTP request owns the transport slot until settlement, even after its watchdog fires; shutdown expiry stops the remaining queue. Scope name/version and explicit transport options remain owned by the backend.

The [telemetry revival](../../../../packages/session/session-telemetry/README.md) remains authoritative for redaction, capture, and best-effort handoff. This decision replaces the earlier SDK-only queue/batching rule: SDK batch deadlines cannot own an operation split into multiple HTTP requests. The shared Session-log channel schedules complete requests; the SDK still owns transport/retry. Feedback authorization and the separate DeepSeek model-request contribution remain unchanged.

## Alternatives considered

**One string for the entire Session.** Rejected because one large Session would exceed the request ceiling even when each event fits. One event per record preserves event identity and permits batching.

**Truncate oversized records or add client-only fragments.** Rejected because truncation loses content and fragments require a collector reassembly protocol. Explicit rejection retains the one-event-per-record meaning.

**Count compressed bytes or characters.** Rejected because collector limits can apply after decompression, and characters omit UTF-8 and escaping overhead. Measuring full uncompressed requests gives a conservative bound.

## Consequences

Product and Session records never share a request or queue, and neither package imports the other. Conservative per-record envelope accounting can produce smaller batches than exact combined accounting. Queue overflow, oversize rejection, exit, and transport failure can lose data; no durable outbox or acknowledgement is added. Tests cover byte limits, linear measurement, slow-request serialization, metadata, redaction-copy isolation, and feedback-authorized replay.

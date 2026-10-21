# Agent Note: Shared native CUA process with Agent-scoped state

Status: implemented

English | [中文](2026-10-09-cua-shared-native-helper.zh.md)

## Problem

On macOS 26.6.2, replayd derives capture-client identity from the executable path. Two live helpers at the same path repeatedly replace each other's connections even when their screenshot requests are sequential. Byte-identical executables at distinct real paths complete sequential and concurrent captures; two symlinks to one executable reproduce the failure. A per-request lock cannot isolate retained system connections.

## Decision

One user shares a native service per executable content digest across Agents and Hosts. A version lock elects the service; an additional canonical-executable-path lock prevents different builds published at one path from running together. Locks remain held until process exit. The managed startup command hands service lifetime to its client connections, and the last connection's completed cleanup ends the service. The diagnostic stdin/stdout entry proxies to this same service.

Each Agent connection owns its application handles, AX snapshots, limits and cancellation state. An app handle grants no exclusive use of the application. A FIFO orders complete desktop operations, including clipboard transactions, while response writes are independent. Agent disposal retires only its connection. The [object API decision](2026-09-17-experimental-cua-object-api.md) retains evaluator independence and coordinate semantics; the [consent decision](2026-09-26-cua-application-consent.md) retains application authorization.

Cancellation and timeout first stop one request and wait for acknowledgement. A timed-out screenshot retains the single system-RPC slot until the real callback completes; new screenshots fail with `CAPTURE_BUSY` instead of accumulating requests. Late pixels are discarded, while other AX and input operations remain available. Ending an await or creating a wrapper does not prove that the system connection has recovered. An operation or cleanup that cannot stop can invalidate the process, making every old handle unusable. Uncertain input is never replayed automatically.

## Alternatives considered

Separate executable copies per Agent avoid the observed identity collision but multiply system capture clients. One shared service preserves a single capture client while retaining Agent state isolation. An in-process Swift binding changes crash containment without removing the system RPC. The [continuous-hover decision](2026-10-13-cua-continuous-hover.md) keeps individual operations serialized without cross-call application ownership.

## Consequences

Two Hosts can race to start the service and receive the same instance. A may retain its app object while B screenshots and changes the same application; A reads fresh AX afterward. An Agent closing cannot retire another Agent's handles. Recovery must distinguish request, snapshot, handle, capture-backend and process failure. A lost system callback occupies a bounded capture slot; reliable in-process backend reset requires separate platform evidence. The historical DeepSeek failures have matching RPC errors, but their competing-client identity was not recovered from retained logs.

# Agent Note: Continuous Client connection recovery

Status: implemented

English | [中文](2026-09-05-continuous-client-recovery.zh.md)

## Problem

A generation source can remain pending without reporting readiness or carrier failure. A warning alone leaves the Client waiting indefinitely. Finite automatic retries also leave a page disconnected after the Host recovers from a longer outage, even though the browser's network status never changes.

## Decision

[`ConnectionController`](../../../../packages/client/connection/src/client/connection.ts) owns both the readiness deadline and the continuous retry schedule. A handshake reports a slow Host after three seconds and aborts after fifteen seconds by default. The warning gives early feedback without discarding a Host that needs several seconds to become ready; the deadline bounds each attempt and logs the timeout when it cancels the generation. Warning and cancellation times are independent, so a shorter hard deadline does not require changing both fields; a warning scheduled after settlement is cancelled. Cancellation reaches the generation source, which must release its resources and settle before another source starts. A cancelled source's late ready callback cannot establish a generation.

Retry caps grow from 500ms through 1s, 2s, 4s, and 8s to 10s, with the existing 50–100% jitter. Failures at the maximum cap continue retrying. Separating a maximum delay from a retry-count limit follows the distinction in [Socket.IO's Client options](https://socket.io/docs/v4/client-options/#reconnectionattempts), while DSH retains its existing Remote stream protocol and single scheduler. Gateway replaces the physical socket once for each Controller-requested attempt. Both a pending WebSocket candidate and an open socket without an opening ready frame can recover this way.

The Host Connection plugin validates `recovery` in its configuration and injects the resolved, non-secret timing into each page through `webserver/index-inject`. The Client validates that bootstrap input before providing Connection; direct loop options may override it. Timer values must be positive integers within the browser timer range, and the backoff factor must be finite and at least one. The shared resolver explicitly rejects `NaN`, which range comparisons alone cannot exclude. A factor of one selects continuous fixed-cap retries. Changes to Host timing apply to subsequently loaded pages.

The Settings indicator labels active recovery **Reconnecting** and keeps **Reconnect now** available. This decision supersedes the terminal retry policy in [Web connection recovery control](../../archived/feature/2026-08-28-web-connection-recovery-control.md). That note still owns manual recovery, browser offline suspension, the single-scheduler rule, and indicator presentation. A fresh `$events` ready frame alone establishes connectivity; domain streams retain their own baseline and cursor recovery.

## Alternatives considered

**Only reject the readiness wait.** The Controller still waits for source settlement before retrying. The deadline must cancel the source as well, otherwise the same pending work blocks recovery.

**Cancel every handshake after three seconds.** This conflates slow-Host feedback with failure and repeatedly discards legitimate slower handshakes. Separate configurable warning and cancellation times preserve a bounded opportunity to finish.

**Stop after a finite retry sequence.** A page cannot discover later Host recovery without another user or browser event. Capping the interval limits traffic while preserving automatic recovery.

**Start another source without awaiting cancellation cleanup.** Overlapping generations can retain listeners and deliver obsolete events. The source's cancellation contract requires settlement; abandoning it does not establish cleanup.

## Consequences

Long outages retain one retry schedule and produce bounded-rate connection traffic until recovery, explicit stop, or browser offline suspension. A permanently invalid credential still requires user action; connection retries do not refresh credentials or replay unary mutations. Immediate readiness continues to reset backoff, and browser offline remains authoritative for suspension; stable-connection reset windows and local-transport exceptions are separate policy changes.

## Testing

Controller tests cover recovery beyond the former final tier, fixed-cap retries, slow readiness, deadline cancellation, delayed cleanup, late ready callbacks, and manual reconnect or stop during a handshake. Host and Client tests cover timing propagation, invalid input, and injection disposal. Gateway tests use the real Controller and event pump with scripted WebSockets to verify both stalled opening phases, physical replacement, and one recovery reset. The recorded-session Web lifecycle scenario covers automatic recovery past the former stop point, manual replacement of a stalled handshake, and localized recovery presentation.
